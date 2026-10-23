// Document loading, page layout, lazy canvas rendering, zoom, navigation and thumbnails.
import { pdfjsLib, PDFJS_OPTIONS } from './lib.js';
import { state, emit } from './state.js';
import { $, h, clamp, modal, toast } from './util.js';

const viewer = () => $('#viewer');
let pageIO = null;
let thumbIO = null;
const queue = new Set();
let active = 0;
const MAX_ACTIVE = 2;
const MAX_LIVE_CANVASES = 18;
const liveCanvases = [];

export function setBusy(text) {
  const el = $('#busy');
  if (!text) {
    el.classList.remove('open');
    return;
  }
  $('#busyText').textContent = text;
  el.classList.add('open');
}

async function loadPdfjs(bytes, password) {
  const task = pdfjsLib.getDocument({ ...PDFJS_OPTIONS, data: bytes.slice(), password });
  let usedPassword = password;
  task.onPassword = async (update, reason) => {
    setBusy(null);
    const wrong = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD;
    const pw = await modal({
      title: wrong ? 'Incorrect password' : 'Password required',
      body: 'This PDF is protected. Enter its password to open it.',
      input: '',
      inputType: 'password',
      okText: 'Unlock',
    });
    if (pw === null) task.destroy();
    else {
      usedPassword = pw;
      update(pw);
    }
  };
  const pdf = await task.promise;
  return { pdf, password: usedPassword };
}

export async function openDocument(bytes, name) {
  setBusy('Opening PDF…');
  let loaded;
  try {
    loaded = await loadPdfjs(bytes);
  } catch (err) {
    setBusy(null);
    if (err?.name !== 'PasswordException' && !/destroyed|Worker was terminated/i.test(err?.message || '')) {
      toast(`Couldn't open this file: ${err?.message || err}`, 'error', 6000);
    }
    return false;
  }
  closeDocument();
  const { pdf, password } = loaded;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const proxy = await pdf.getPage(i);
    const vp1 = proxy.getViewport({ scale: 1 });
    pages.push({ index: i - 1, proxy, vp1, width: vp1.width, height: vp1.height, rotation: proxy.rotate });
  }
  let info = {};
  try {
    info = await pdf.getMetadata();
  } catch {}
  state.doc = {
    name,
    size: bytes.length,
    bytes,
    originalBytes: bytes,
    password,
    pdfjs: pdf,
    pages,
    gen: 1,
    info,
    encrypted: !!(password || info?.info?.EncryptFilterName),
  };
  state.objects = [];
  state.assets.clear();
  state.selectedId = null;
  state.editingId = null;
  state.meta = {};
  document.body.classList.add('has-doc');
  buildPages();
  buildThumbs();
  fitWidth(true);
  setBusy(null);
  emit('doc-opened');
  return true;
}

export function closeDocument() {
  if (!state.doc) return;
  for (const p of state.doc.pages) p.renderTask?.cancel();
  try {
    state.doc.pdfjs.destroy();
  } catch {}
  pageIO?.disconnect();
  thumbIO?.disconnect();
  queue.clear();
  liveCanvases.length = 0;
  viewer().querySelector('.pages')?.remove();
  $('#thumbList').replaceChildren();
  state.doc = null;
}

// Swap in new PDF bytes (after an in-PDF edit such as image replacement or undo) keeping layout.
export async function reloadBytes(bytes) {
  const doc = state.doc;
  const { pdf } = await loadPdfjs(bytes, doc.password);
  const old = doc.pdfjs;
  doc.gen++;
  doc.bytes = bytes;
  doc.size = bytes.length;
  doc.pdfjs = pdf;
  for (const p of doc.pages) {
    p.renderTask?.cancel();
    p.proxy = await pdf.getPage(p.index + 1);
    p.vp1 = p.proxy.getViewport({ scale: 1 });
    p.renderedZoom = 0;
    p.textModel = p.textModelPromise = null;
    p.imageModel = p.imageModelPromise = null;
    p.textLayerFor = p.imgLayerFor = null;
    p.textLayer.replaceChildren();
    p.imgLayer.replaceChildren();
    p.thumbDone = false;
  }
  try {
    doc.info = await pdf.getMetadata();
  } catch {}
  setTimeout(() => {
    try {
      old.destroy();
    } catch {}
  }, 1500);
  for (const p of doc.pages) if (p.visible) schedule(p);
  for (const p of doc.pages) if (p.thumbVisible) renderThumb(p);
  emit('doc-changed');
}

function buildPages() {
  const v = viewer();
  const host = h('div', { class: 'pages' });
  pageIO = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const p = state.doc?.pages[+e.target.dataset.page];
        if (!p) continue;
        p.visible = e.isIntersecting;
        if (p.visible) schedule(p);
      }
    },
    { root: v, rootMargin: '600px 200px' },
  );
  for (const p of state.doc.pages) {
    const canvas = h('canvas', { class: 'page-canvas' });
    const annotLayer = h('div', { class: 'annot-layer' });
    const textLayer = h('div', { class: 'text-layer' });
    const imgLayer = h('div', { class: 'img-layer' });
    const uiLayer = h('div', { class: 'ui-layer' });
    const layers = h('div', { class: 'page-layers' }, annotLayer, textLayer, imgLayer, uiLayer);
    const wrap = h('div', { class: 'page', dataset: { page: p.index }, 'aria-label': `Page ${p.index + 1}` }, canvas, layers);
    const label = h('div', { class: 'page-label' }, `Page ${p.index + 1} of ${state.doc.pages.length}`);
    const outer = h('div', { class: 'page-outer' }, wrap, label);
    Object.assign(p, { wrap, outer, canvas, layers, annotLayer, textLayer, imgLayer, uiLayer, renderedZoom: 0 });
    host.append(outer);
    pageIO.observe(wrap);
  }
  v.append(host);
  applyZoomStyles();
}

function applyZoomStyles() {
  const z = state.zoom;
  const v = viewer();
  v.style.setProperty('--zoom', z);
  v.style.setProperty('--inv', 1 / z);
  for (const p of state.doc?.pages || []) {
    p.wrap.style.width = `${p.width * z}px`;
    p.wrap.style.height = `${p.height * z}px`;
    p.layers.style.width = `${p.width}px`;
    p.layers.style.height = `${p.height}px`;
    p.layers.style.transform = `scale(${z})`;
  }
}

function schedule(p) {
  if (!state.doc || p.renderedZoom === state.zoom) return;
  queue.add(p);
  pump();
}

function pump() {
  while (active < MAX_ACTIVE && queue.size) {
    const p = queue.values().next().value;
    queue.delete(p);
    if (!p.visible || p.renderedZoom === state.zoom) continue;
    active++;
    renderPage(p).finally(() => {
      active--;
      pump();
    });
  }
}

async function renderPage(p) {
  const doc = state.doc;
  const gen = doc.gen;
  const zoom = state.zoom;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let scale = zoom * dpr;
  const maxPixels = 16e6;
  if (p.width * p.height * scale * scale > maxPixels) scale = Math.sqrt(maxPixels / (p.width * p.height));
  const vp = p.proxy.getViewport({ scale });
  const canvas = h('canvas', { class: 'page-canvas' });
  canvas.width = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  p.renderTask?.cancel();
  const task = p.proxy.render({
    canvasContext: canvas.getContext('2d'),
    viewport: vp,
    annotationMode: pdfjsLib.AnnotationMode.ENABLE,
  });
  p.renderTask = task;
  try {
    await task.promise;
  } catch (err) {
    if (err?.name !== 'RenderingCancelledException') console.error('render failed', err);
    return;
  } finally {
    if (p.renderTask === task) p.renderTask = null;
  }
  if (state.doc !== doc || doc.gen !== gen) return;
  p.canvas.replaceWith(canvas);
  p.canvas = canvas;
  p.renderScale = canvas.width / p.width;
  p.renderedZoom = zoom;
  trackCanvas(p);
  emit('page-rendered', p);
  if (state.zoom !== zoom && p.visible) schedule(p);
}

// Free memory held by far-away page canvases in long documents.
function trackCanvas(p) {
  const i = liveCanvases.indexOf(p);
  if (i >= 0) liveCanvases.splice(i, 1);
  liveCanvases.push(p);
  while (liveCanvases.length > MAX_LIVE_CANVASES) {
    const idx = liveCanvases.findIndex((q) => !q.visible);
    if (idx < 0) break;
    const [q] = liveCanvases.splice(idx, 1);
    const blank = h('canvas', { class: 'page-canvas' });
    q.canvas.replaceWith(blank);
    q.canvas = blank;
    q.renderedZoom = 0;
    q.renderScale = 0;
  }
}

let rerenderTimer = null;
export function setZoom(z, anchor) {
  if (!state.doc) return;
  z = clamp(Math.round(z * 1000) / 1000, 0.25, 5);
  if (Math.abs(z - state.zoom) < 1e-4) return;
  const v = viewer();
  const old = state.zoom;
  const ax = anchor?.x ?? v.clientWidth / 2;
  const ay = anchor?.y ?? v.clientHeight / 2;
  const cx = v.scrollLeft + ax;
  const cy = v.scrollTop + ay;
  state.zoom = z;
  applyZoomStyles();
  v.scrollLeft = (cx * z) / old - ax;
  v.scrollTop = (cy * z) / old - ay;
  emit('zoom', z);
  clearTimeout(rerenderTimer);
  rerenderTimer = setTimeout(() => {
    for (const p of state.doc?.pages || []) if (p.visible) schedule(p);
  }, 120);
}

export function fitWidth(initial = false) {
  if (!state.doc) return;
  const v = viewer();
  const maxW = Math.max(...state.doc.pages.map((p) => p.width));
  let z = (v.clientWidth - 72) / maxW;
  if (initial) z = Math.min(z, 1.5);
  if (initial) {
    state.zoom = clamp(z, 0.25, 5);
    applyZoomStyles();
    emit('zoom', state.zoom);
    for (const p of state.doc.pages) if (p.visible) schedule(p);
  } else setZoom(z);
}

export function fitPage() {
  if (!state.doc) return;
  const v = viewer();
  const p = state.doc.pages[currentPageIndex()] || state.doc.pages[0];
  setZoom(Math.min((v.clientWidth - 72) / p.width, (v.clientHeight - 64) / p.height));
  scrollToPage(p.index);
}

export function currentPageIndex() {
  if (!state.doc) return 0;
  const v = viewer();
  const mid = v.getBoundingClientRect().top + v.clientHeight / 2;
  let best = 0;
  for (const p of state.doc.pages) {
    const r = p.wrap.getBoundingClientRect();
    if (r.top <= mid) best = p.index;
    else break;
  }
  return best;
}

export function scrollToPage(index, rect) {
  const p = state.doc?.pages[index];
  if (!p) return;
  const v = viewer();
  const top = p.outer.offsetTop - 16 + (rect ? rect.y * state.zoom - v.clientHeight / 3 : 0);
  v.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

export function flashRect(index, rect) {
  const p = state.doc?.pages[index];
  if (!p) return;
  scrollToPage(index, rect);
  const pad = 4;
  const el = h('div', {
    class: 'flash',
    style: { left: `${rect.x - pad}px`, top: `${rect.y - pad}px`, width: `${rect.w + pad * 2}px`, height: `${rect.h + pad * 2}px` },
  });
  p.layers.append(el);
  setTimeout(() => el.remove(), 2200);
}

// ---------- thumbnails ----------
function buildThumbs() {
  const list = $('#thumbList');
  list.replaceChildren();
  thumbIO = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const p = state.doc?.pages[+e.target.dataset.page];
        if (!p) continue;
        p.thumbVisible = e.isIntersecting;
        if (e.isIntersecting && !p.thumbDone) renderThumb(p);
      }
    },
    { root: list, rootMargin: '300px 0px' },
  );
  for (const p of state.doc.pages) {
    const tw = 112;
    const th = Math.round((tw * p.height) / p.width);
    const canvas = h('canvas', { width: tw * 2, height: th * 2, style: { width: `${tw}px`, height: `${th}px` } });
    const btn = h(
      'button',
      { class: 'thumb', dataset: { page: p.index }, title: `Go to page ${p.index + 1}`, onclick: () => scrollToPage(p.index) },
      canvas,
      h('span', {}, String(p.index + 1)),
    );
    p.thumbCanvas = canvas;
    p.thumbEl = btn;
    list.append(btn);
    thumbIO.observe(btn);
  }
}

async function renderThumb(p) {
  if (p.thumbRendering) {
    p.thumbAgain = true;
    return;
  }
  p.thumbRendering = true;
  try {
    const proxy = p.proxy;
    const scale = p.thumbCanvas.width / p.width;
    const vp = proxy.getViewport({ scale });
    const off = document.createElement('canvas');
    off.width = p.thumbCanvas.width;
    off.height = p.thumbCanvas.height;
    await proxy.render({ canvasContext: off.getContext('2d'), viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
    const ctx = p.thumbCanvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, off.width, off.height);
    ctx.drawImage(off, 0, 0);
    p.thumbDone = proxy === p.proxy;
  } catch (err) {
    if (err?.name !== 'RenderingCancelledException') console.warn('thumb failed', err);
  } finally {
    p.thumbRendering = false;
    if (p.thumbAgain) {
      p.thumbAgain = false;
      renderThumb(p);
    }
  }
}

export function highlightThumb(index) {
  for (const p of state.doc?.pages || []) p.thumbEl?.classList.toggle('active', p.index === index);
  const t = state.doc?.pages[index]?.thumbEl;
  if (t) {
    const list = $('#thumbList');
    const r = t.getBoundingClientRect();
    const lr = list.getBoundingClientRect();
    if (r.top < lr.top || r.bottom > lr.bottom) t.scrollIntoView({ block: 'nearest' });
  }
}

export function pageFromEvent(e) {
  const el = e.target?.closest?.('.page');
  if (!el || !state.doc) return null;
  return state.doc.pages[+el.dataset.page] || null;
}

export function toPagePoint(p, e) {
  const r = p.wrap.getBoundingClientRect();
  return { x: (e.clientX - r.left) / state.zoom, y: (e.clientY - r.top) / state.zoom };
}

// Find the page under a client point (used for drops that land between layers).
export function pageAtClient(x, y) {
  for (const p of state.doc?.pages || []) {
    const r = p.wrap.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return p;
  }
  return null;
}
