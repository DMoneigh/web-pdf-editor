// Overlay objects: rendering, selection, and all pointer-driven tools.
import { state, emit, pushHistory, snapshot, getObject, FONT_FAMILIES, LINE_HEIGHT } from './state.js';
import { h, svg, uid, toast, pickFile, readAsDataURL, loadImage, round } from './util.js';
import { shapeParts, isVector, geomBounds, translateObj, scaleObj, simplify } from './shapes.js';
import { getTextModel, detectFont, sampleColors, baselineRatio } from './textmodel.js';
import { getImageModel, prepareReplacement, replaceImageInPdf } from './images.js';
import { reloadBytes, toPagePoint, pageFromEvent, setBusy } from './viewer.js';

const pages = () => state.doc?.pages || [];
const objNode = (id) => document.querySelector(`.obj[data-id="${CSS.escape(id)}"]`);
export const textNode = (id) => objNode(id)?.querySelector('.obj-text');

// ---------- rendering ----------
export function applyTextStyle(node, o) {
  Object.assign(node.style, {
    left: `${o.x}px`,
    top: `${o.y}px`,
    fontFamily: FONT_FAMILIES[o.fontFamily]?.css || FONT_FAMILIES.Helvetica.css,
    fontSize: `${o.fontSize}px`,
    fontWeight: o.bold ? '700' : '400',
    fontStyle: o.italic ? 'italic' : 'normal',
    color: o.color,
    lineHeight: String(LINE_HEIGHT),
    background: o.bg || 'transparent',
  });
}

function buildNode(o) {
  const wrap = h('div', { class: 'obj', dataset: { id: o.id, type: o.type } });
  const cover = o.cover;
  if (cover) {
    wrap.append(
      h('div', {
        class: 'obj-cover',
        style: { left: `${cover.x}px`, top: `${cover.y}px`, width: `${cover.w}px`, height: `${cover.h}px`, background: cover.color },
      }),
    );
  }
  if (isVector(o)) {
    const p = pages()[o.page];
    const s = svg('svg', { class: 'obj-svg', width: p.width, height: p.height, viewBox: `0 0 ${p.width} ${p.height}` });
    s.style.opacity = o.opacity ?? 1;
    for (const part of shapeParts(o)) {
      s.append(
        svg('path', {
          class: 'vis',
          d: part.d,
          fill: part.fill || 'none',
          stroke: part.stroke || 'none',
          'stroke-width': part.stroke ? part.width : 0,
          'stroke-linecap': part.cap || 'round',
          'stroke-linejoin': part.join || 'round',
        }),
        svg('path', { class: 'hit', d: part.d, fill: 'none', stroke: 'transparent', 'stroke-width': Math.max((part.width || 0) + 10, 12) }),
      );
    }
    wrap.append(s);
  } else if (o.type === 'text') {
    const t = h('div', { class: 'obj-text', spellcheck: 'false' });
    applyTextStyle(t, o);
    t.textContent = o.text;
    wrap.append(t);
  } else if (o.type === 'image') {
    const asset = state.assets.get(o.assetId);
    wrap.append(
      h('img', {
        class: 'obj-image',
        src: asset?.dataUrl || '',
        alt: '',
        draggable: 'false',
        style: { left: `${o.x}px`, top: `${o.y}px`, width: `${o.w}px`, height: `${o.h}px`, opacity: o.opacity ?? 1 },
      }),
    );
  }
  return wrap;
}

export function renderObject(o) {
  const p = pages()[o.page];
  if (!p) return;
  const fresh = buildNode(o);
  const old = objNode(o.id);
  if (old) old.replaceWith(fresh);
  else p.annotLayer.append(fresh);
}

export function renderAll() {
  for (const p of pages()) {
    p.annotLayer.replaceChildren(...state.objects.filter((o) => o.page === p.index).map(buildNode));
    syncTextLayer(p);
  }
  if (state.selectedId && !getObject(state.selectedId)) state.selectedId = null;
  updateSelection();
}

function changed() {
  emit('objects-changed');
}

// ---------- selection ----------
export function measure(o) {
  if (o.type === 'text') {
    const n = textNode(o.id);
    if (n) return { x: o.x, y: o.y, w: Math.max(n.offsetWidth, 4), h: Math.max(n.offsetHeight, 4) };
  }
  return geomBounds(o);
}

export function select(id) {
  state.selectedId = id && getObject(id) ? id : null;
  updateSelection();
  emit('selection');
}

export function updateSelection() {
  for (const p of pages()) p.uiLayer.replaceChildren();
  const o = getObject(state.selectedId);
  if (!o) return;
  const p = pages()[o.page];
  const b = measure(o);
  const pad = isVector(o) ? (o.width || 0) / 2 + 3 : 2;
  const box = h('div', {
    class: state.editingId === o.id ? 'sel-box editing' : 'sel-box',
    style: { left: `${b.x - pad}px`, top: `${b.y - pad}px`, width: `${b.w + pad * 2}px`, height: `${b.h + pad * 2}px` },
  });
  if (state.editingId !== o.id) for (const c of ['nw', 'ne', 'sw', 'se']) box.append(h('div', { class: `handle h-${c}`, dataset: { handle: c } }));
  p.uiLayer.append(box);
}

export function deleteSelected() {
  const idx = state.objects.findIndex((o) => o.id === state.selectedId);
  if (idx < 0) return;
  pushHistory();
  const [o] = state.objects.splice(idx, 1);
  objNode(o.id)?.remove();
  syncTextLayer(pages()[o.page]);
  select(null);
  changed();
}

export function duplicateSelected() {
  const o = getObject(state.selectedId);
  if (!o) return;
  pushHistory();
  const copy = JSON.parse(JSON.stringify(o));
  copy.id = uid();
  delete copy.cover;
  delete copy.source;
  delete copy.origText;
  translateObj(copy, 12, 12);
  state.objects.push(copy);
  renderObject(copy);
  select(copy.id);
  changed();
}

export function nudgeSelected(dx, dy) {
  const o = getObject(state.selectedId);
  if (!o) return;
  pushHistory();
  translateObj(o, dx, dy);
  renderObject(o);
  updateSelection();
  changed();
}

export function reorderSelected(toFront) {
  const idx = state.objects.findIndex((o) => o.id === state.selectedId);
  if (idx < 0) return;
  pushHistory();
  const [o] = state.objects.splice(idx, 1);
  if (toFront) state.objects.push(o);
  else state.objects.unshift(o);
  renderAll();
  changed();
}

// ---------- pointer plumbing ----------
function track(e, onMove, onUp) {
  const move = (ev) => {
    if (ev.pointerId !== e.pointerId) return;
    onMove(ev);
  };
  const up = (ev) => {
    if (ev.pointerId !== e.pointerId) return;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    onUp?.(ev);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

export function onPointerDown(e) {
  if (e.button !== 0 || !state.doc) return;
  if (state.editingId) {
    const ed = textNode(state.editingId);
    if (ed && ed.contains(e.target)) return;
    ed?.blur();
  }
  const p = pageFromEvent(e);
  if (!p) {
    if (!e.target.closest('.sel-box')) select(null);
    return;
  }
  const pt = toPagePoint(p, e);
  const objEl = e.target.closest('.obj');
  const obj = objEl ? getObject(objEl.dataset.id) : null;
  const tool = state.tool;

  if (tool === 'select') {
    const handle = e.target.closest('.handle');
    if (handle) return startResize(e, p, handle.dataset.handle);
    if (obj) {
      select(obj.id);
      return startMove(e, p, obj, pt);
    }
    if (e.target.closest('.sel-box')) return startMove(e, p, getObject(state.selectedId), pt);
    return select(null);
  }
  if (tool === 'edittext' || tool === 'addtext') {
    e.preventDefault();
    if (obj?.type === 'text') {
      select(obj.id);
      return beginEdit(obj.id, e);
    }
    const blockEl = e.target.closest('.tl-block');
    if (blockEl && tool === 'edittext') return editBlock(p, blockEl.dataset.block, e);
    if (tool === 'addtext') return createTextAt(p, pt);
    select(null);
    return;
  }
  if (tool === 'pen' || tool === 'highlighter') return startPath(e, p, pt);
  if (['line', 'arrow', 'rect', 'ellipse', 'whiteout'].includes(tool)) return startShape(e, p, pt);
  if (tool === 'image') {
    if (state.pendingAsset) return startPlaceImage(e, p, pt);
    return chooseImageForTool();
  }
  if (tool === 'eraser') return startErase(e);
  if (tool === 'replaceimg') {
    const region = e.target.closest('.img-region');
    if (region) replaceFromRegion(p, region.dataset.img);
  }
}

export function onDoubleClick(e) {
  if (state.tool !== 'select') return;
  const objEl = e.target.closest('.obj');
  const o = objEl ? getObject(objEl.dataset.id) : e.target.closest('.sel-box') ? getObject(state.selectedId) : null;
  if (o?.type === 'text') {
    select(o.id);
    beginEdit(o.id, e);
  }
}

function startMove(e, p, o, start) {
  if (!o) return;
  e.preventDefault();
  const orig = JSON.parse(JSON.stringify(o));
  const snap = snapshot();
  let moved = false;
  track(
    e,
    (ev) => {
      const q = toPagePoint(p, ev);
      const dx = q.x - start.x;
      const dy = q.y - start.y;
      if (!moved && Math.hypot(dx, dy) * state.zoom < 3) return;
      if (!moved) {
        pushHistory(snap);
        moved = true;
      }
      Object.assign(o, JSON.parse(JSON.stringify(orig)));
      translateObj(o, dx, dy);
      renderObject(o);
      updateSelection();
    },
    () => moved && changed(),
  );
}

function startResize(e, p, corner) {
  const o = getObject(state.selectedId);
  if (!o) return;
  e.preventDefault();
  e.stopPropagation();
  const orig = JSON.parse(JSON.stringify(o));
  const from = measure(o);
  const snap = snapshot();
  let moved = false;
  const fx = corner.includes('w') ? from.x + from.w : from.x;
  const fy = corner.includes('n') ? from.y + from.h : from.y;
  const lockAspect = o.type === 'image' || o.type === 'text';
  track(
    e,
    (ev) => {
      const q = toPagePoint(p, ev);
      let w = Math.max(4, Math.abs(q.x - fx));
      let hh = Math.max(4, Math.abs(q.y - fy));
      if (lockAspect !== ev.shiftKey && from.w > 0.5 && from.h > 0.5) {
        const aspect = from.w / from.h;
        if (w / hh > aspect) hh = w / aspect;
        else w = hh * aspect;
      }
      if (from.h <= 0.5) hh = 0;
      if (from.w <= 0.5) w = 0;
      const to = { x: q.x < fx ? fx - w : fx, y: q.y < fy ? fy - hh : fy, w, h: hh };
      if (!moved) {
        pushHistory(snap);
        moved = true;
      }
      Object.assign(o, JSON.parse(JSON.stringify(orig)));
      scaleObj(o, from, to);
      renderObject(o);
      updateSelection();
    },
    () => {
      if (moved) {
        changed();
        emit('selection');
      }
    },
  );
}

function startPath(e, p, pt) {
  e.preventDefault();
  const st = state.toolStyles[state.tool];
  const o = {
    id: uid(),
    type: 'path',
    page: p.index,
    points: [[round(pt.x), round(pt.y)]],
    color: st.color,
    width: st.width,
    opacity: st.opacity,
  };
  const snap = snapshot();
  state.objects.push(o);
  renderObject(o);
  track(
    e,
    (ev) => {
      const events = ev.getCoalescedEvents?.() || [ev];
      for (const ce of events.length ? events : [ev]) {
        const q = toPagePoint(p, ce);
        const last = o.points[o.points.length - 1];
        if (Math.hypot(q.x - last[0], q.y - last[1]) >= 0.6 / state.zoom) o.points.push([round(q.x), round(q.y)]);
      }
      renderObject(o);
    },
    () => {
      o.points = simplify(o.points, 0.3);
      pushHistory(snap);
      renderObject(o);
      changed();
    },
  );
}

function startShape(e, p, pt) {
  e.preventDefault();
  const tool = state.tool;
  const st = state.toolStyles[tool];
  let o;
  if (tool === 'line' || tool === 'arrow') {
    o = { type: tool, x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y, color: st.color, width: st.width, opacity: st.opacity };
  } else if (tool === 'whiteout') {
    o = { type: 'rect', x: pt.x, y: pt.y, w: 0, h: 0, stroke: null, fill: st.fill, width: 0, opacity: 1, whiteout: true };
  } else {
    o = { type: tool, x: pt.x, y: pt.y, w: 0, h: 0, stroke: st.stroke, fill: st.fill, width: st.width, opacity: st.opacity };
  }
  o.id = uid();
  o.page = p.index;
  const snap = snapshot();
  state.objects.push(o);
  renderObject(o);
  track(
    e,
    (ev) => {
      const q = toPagePoint(p, ev);
      if (o.type === 'line' || o.type === 'arrow') {
        let { x, y } = q;
        if (ev.shiftKey) {
          const ang = Math.round(Math.atan2(y - pt.y, x - pt.x) / (Math.PI / 4)) * (Math.PI / 4);
          const len = Math.hypot(x - pt.x, y - pt.y);
          x = pt.x + Math.cos(ang) * len;
          y = pt.y + Math.sin(ang) * len;
        }
        o.x2 = x;
        o.y2 = y;
      } else {
        let w = Math.abs(q.x - pt.x);
        let hh = Math.abs(q.y - pt.y);
        if (ev.shiftKey) w = hh = Math.max(w, hh);
        o.x = q.x < pt.x ? pt.x - w : pt.x;
        o.y = q.y < pt.y ? pt.y - hh : pt.y;
        o.w = w;
        o.h = hh;
      }
      renderObject(o);
    },
    () => {
      const tiny = o.type === 'line' || o.type === 'arrow' ? Math.hypot(o.x2 - o.x1, o.y2 - o.y1) < 3 : o.w < 3 || o.h < 3;
      if (tiny) {
        state.objects.splice(state.objects.indexOf(o), 1);
        objNode(o.id)?.remove();
        return;
      }
      if (o.whiteout && st.auto) {
        o.fill = sampleColors(p, { x: o.x, y: o.y, w: o.w, h: o.h }).bg;
        renderObject(o);
      }
      pushHistory(snap);
      changed();
    },
  );
}

function startErase(e) {
  e.preventDefault();
  const snap = snapshot();
  let pushed = false;
  const hit = (ev) => {
    for (const el of document.elementsFromPoint(ev.clientX, ev.clientY)) {
      const oe = el.closest?.('.obj');
      if (!oe) continue;
      const idx = state.objects.findIndex((o) => o.id === oe.dataset.id);
      if (idx < 0) continue;
      if (!pushed) {
        pushHistory(snap);
        pushed = true;
      }
      const [o] = state.objects.splice(idx, 1);
      oe.remove();
      if (state.selectedId === o.id) select(null);
      syncTextLayer(pages()[o.page]);
      changed();
      break;
    }
  };
  hit(e);
  track(e, hit);
}

// ---------- text ----------
function createTextAt(p, pt) {
  const st = state.toolStyles.text;
  const o = {
    id: uid(),
    type: 'text',
    page: p.index,
    x: round(pt.x),
    y: round(pt.y - (st.fontSize * LINE_HEIGHT) / 2),
    text: '',
    fontFamily: st.fontFamily,
    fontSize: st.fontSize,
    bold: st.bold,
    italic: st.italic,
    color: st.color,
    bg: st.bg,
  };
  const snap = snapshot();
  state.objects.push(o);
  renderObject(o);
  select(o.id);
  beginEdit(o.id, null, { isNew: true, snap });
}

async function editBlock(p, blockId, ev) {
  const model = await getTextModel(p);
  const b = model.blocks.find((x) => x.id === blockId);
  if (!b) return;
  const font = detectFont(p, b);
  const fs = Math.round(b.fs * 10) / 10;
  const coverRect = { x: b.x - 1, y: b.top - 1, w: b.w + 2, h: b.bottom - b.top + 2 };
  const colors = sampleColors(p, coverRect);
  const ratio = baselineRatio(font.family, font.bold, font.italic);
  const o = {
    id: uid(),
    type: 'text',
    page: p.index,
    x: round(b.x),
    y: round(b.y - ratio * fs),
    text: b.text,
    origText: b.text,
    source: b.id,
    fontFamily: font.family,
    fontSize: fs,
    bold: font.bold,
    italic: font.italic,
    color: colors.fg,
    bg: null,
    cover: { ...coverRect, color: colors.bg },
    sourceFont: font.sourceName,
  };
  const snap = snapshot();
  state.objects.push(o);
  renderObject(o);
  syncTextLayer(p);
  select(o.id);
  beginEdit(o.id, ev, { isNew: true, snap, fromBlock: true });
}

function placeCaret(node, ev) {
  const sel = window.getSelection();
  let range = null;
  if (ev && ev.clientX !== undefined) {
    if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(ev.clientX, ev.clientY);
    else if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(ev.clientX, ev.clientY);
      if (pos) {
        range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
      }
    }
    if (range && !node.contains(range.startContainer)) range = null;
  }
  if (!range) {
    range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(false);
  }
  sel.removeAllRanges();
  sel.addRange(range);
}

export function beginEdit(id, ev, opts = {}) {
  const o = getObject(id);
  const node = textNode(id);
  if (!o || !node) return;
  if (state.editingId === id) return;
  const before = opts.snap || snapshot();
  const beforeText = o.text;
  const initial = JSON.stringify(o);
  state.editingId = id;
  node.contentEditable = 'plaintext-only';
  if (node.contentEditable !== 'plaintext-only') node.contentEditable = 'true';
  node.classList.add('editing');
  updateSelection();
  node.focus({ preventScroll: true });
  placeCaret(node, ev);

  const onInput = () => updateSelection();
  const onKey = (k) => {
    k.stopPropagation();
    if (k.key === 'Escape' || (k.key === 'Enter' && (k.ctrlKey || k.metaKey))) {
      k.preventDefault();
      node.blur();
    }
  };
  const onPaste = (pe) => {
    pe.preventDefault();
    const t = pe.clipboardData?.getData('text/plain') || '';
    document.execCommand('insertText', false, t);
  };
  node.addEventListener('input', onInput);
  node.addEventListener('keydown', onKey);
  node.addEventListener('paste', onPaste);
  node.addEventListener(
    'blur',
    (be) => {
      node.removeEventListener('input', onInput);
      node.removeEventListener('keydown', onKey);
      node.removeEventListener('paste', onPaste);
      node.contentEditable = 'false';
      node.classList.remove('editing');
      if (state.editingId === id) state.editingId = null;
      const obj = getObject(id);
      if (!obj) return;
      const text = node.innerText.replace(/\r/g, '').replace(/\u00a0/g, ' ').replace(/\n+$/, '');
      const toOptions = !!be.relatedTarget?.closest?.('#toolOptions');
      const styleChanged = JSON.stringify(obj) !== initial;
      if (opts.isNew && !obj.cover && !text.trim() && !toOptions) {
        state.objects.splice(state.objects.indexOf(obj), 1);
        objNode(id)?.remove();
        select(null);
        return;
      }
      if (opts.fromBlock && text === obj.origText && !toOptions && !styleChanged) {
        state.objects.splice(state.objects.indexOf(obj), 1);
        objNode(id)?.remove();
        syncTextLayer(pages()[obj.page]);
        select(null);
        return;
      }
      obj.text = text;
      if (opts.isNew || text !== beforeText || styleChanged) pushHistory(before);
      renderObject(obj);
      updateSelection();
      changed();
    },
    { once: true },
  );
}

export function commitEditing() {
  if (state.editingId) textNode(state.editingId)?.blur();
}

// ---------- text layer (Edit Text tool) ----------
export async function ensureTextLayer(p) {
  if (state.tool !== 'edittext' || !p?.proxy) return;
  if (p.textLayerFor === p.proxy) return syncTextLayer(p);
  const proxy = p.proxy;
  p.textLayerFor = proxy;
  const model = await getTextModel(p);
  if (p.proxy !== proxy) return;
  p.textLayer.replaceChildren(
    ...model.blocks.map((b) =>
      h('div', {
        class: 'tl-block',
        title: 'Click to edit',
        dataset: { block: b.id },
        style: { left: `${b.x - 1}px`, top: `${b.top - 1}px`, width: `${b.w + 2}px`, height: `${b.bottom - b.top + 2}px` },
      }),
    ),
  );
  syncTextLayer(p);
}

export function syncTextLayer(p) {
  if (!p) return;
  const edited = new Set(state.objects.filter((o) => o.page === p.index && o.source).map((o) => o.source));
  for (const el of p.textLayer.children) el.classList.toggle('edited', edited.has(el.dataset.block));
}

// ---------- images ----------
export async function addAssetFromFile(file) {
  let dataUrl = await readAsDataURL(file);
  let mime = (file.type || '').replace('image/jpg', 'image/jpeg');
  const img = await loadImage(dataUrl);
  let w = img.naturalWidth || 300;
  let hh = img.naturalHeight || 150;
  if (!/^image\/(png|jpeg)$/.test(mime) || Math.max(w, hh) > 3000) {
    const k = Math.min(1, 3000 / Math.max(w, hh));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k));
    c.height = Math.max(1, Math.round(hh * k));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    mime = mime === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    dataUrl = c.toDataURL(mime, 0.92);
    w = c.width;
    hh = c.height;
  }
  const id = uid();
  state.assets.set(id, { dataUrl, mime, width: w, height: hh });
  return id;
}

function defaultImageSize(p, asset) {
  let w = asset.width * 0.75;
  let hh = asset.height * 0.75;
  const k = Math.min(1, (p.width * 0.5) / w, (p.height * 0.5) / hh);
  return { w: w * k, h: hh * k };
}

export async function chooseImageForTool() {
  const file = await pickFile('image/*');
  if (!file) return;
  try {
    state.pendingAsset = await addAssetFromFile(file);
    emit('tool');
    toast('Click on a page to place the image, or drag to size it.');
  } catch (err) {
    toast(`Couldn't read that image: ${err.message}`, 'error');
  }
}

function startPlaceImage(e, p, pt) {
  e.preventDefault();
  const asset = state.assets.get(state.pendingAsset);
  if (!asset) return;
  const aspect = asset.width / asset.height;
  const o = { id: uid(), type: 'image', page: p.index, assetId: state.pendingAsset, x: pt.x, y: pt.y, w: 1, h: 1 / aspect, opacity: 1 };
  const snap = snapshot();
  let dragging = false;
  state.objects.push(o);
  track(
    e,
    (ev) => {
      const q = toPagePoint(p, ev);
      const w = Math.abs(q.x - pt.x);
      if (w < 6 && !dragging) return;
      dragging = true;
      o.w = w;
      o.h = w / aspect;
      o.x = q.x < pt.x ? pt.x - o.w : pt.x;
      o.y = q.y < pt.y ? pt.y - o.h : pt.y;
      renderObject(o);
    },
    () => {
      if (!dragging) {
        const d = defaultImageSize(p, asset);
        Object.assign(o, { w: d.w, h: d.h, x: pt.x - d.w / 2, y: pt.y - d.h / 2 });
      }
      renderObject(o);
      pushHistory(snap);
      state.pendingAsset = null;
      emit('request-tool', 'select');
      select(o.id);
      changed();
    },
  );
}

export async function insertImageFile(p, pt, file) {
  try {
    const assetId = await addAssetFromFile(file);
    const asset = state.assets.get(assetId);
    const d = defaultImageSize(p, asset);
    const o = { id: uid(), type: 'image', page: p.index, assetId, x: pt.x - d.w / 2, y: pt.y - d.h / 2, w: d.w, h: d.h, opacity: 1 };
    pushHistory();
    state.objects.push(o);
    renderObject(o);
    emit('request-tool', 'select');
    select(o.id);
    changed();
  } catch (err) {
    toast(`Couldn't add image: ${err.message}`, 'error');
  }
}

export async function ensureImageLayer(p) {
  if (state.tool !== 'replaceimg' || !p?.proxy) return;
  if (p.imgLayerFor === p.proxy) return;
  const proxy = p.proxy;
  p.imgLayerFor = proxy;
  const list = await getImageModel(p);
  if (p.proxy !== proxy) return;
  p.imgLayer.replaceChildren(
    ...list.map((en) =>
      h(
        'div',
        {
          class: 'img-region',
          dataset: { img: en.id },
          title: 'Click to replace this image (or drop an image file here)',
          style: { left: `${en.rect.x}px`, top: `${en.rect.y}px`, width: `${en.rect.w}px`, height: `${en.rect.h}px` },
        },
        h('span', { class: 'img-region-label' }, 'Replace'),
      ),
    ),
  );
}

export async function replaceFromRegion(p, imgId, file) {
  const list = await getImageModel(p);
  const entry = list.find((x) => x.id === imgId);
  if (!entry) return;
  file = file || (await pickFile('image/*'));
  if (file) await replaceImage(entry, file);
}

export async function replaceImage(entry, file) {
  setBusy('Replacing image…');
  try {
    const prepared = await prepareReplacement(file, entry.dispW / entry.dispH || 1, state.imageFit);
    const res = await replaceImageInPdf(entry, prepared);
    if (res.bytes) {
      pushHistory();
      await reloadBytes(res.bytes);
      toast('Image replaced inside the PDF.', 'success');
    } else {
      const assetId = uid();
      state.assets.set(assetId, { dataUrl: prepared.dataUrl, mime: prepared.mime, width: prepared.width, height: prepared.height });
      const r = entry.rect;
      const o = {
        id: uid(),
        type: 'image',
        page: entry.page,
        assetId,
        x: r.x,
        y: r.y,
        w: r.w,
        h: r.h,
        opacity: 1,
        cover: { x: r.x, y: r.y, w: r.w, h: r.h, color: '#ffffff' },
      };
      pushHistory();
      state.objects.push(o);
      renderObject(o);
      changed();
      toast('That image is stored inline, so the new image was placed over it.', 'info', 5000);
    }
  } catch (err) {
    console.error(err);
    toast(`Couldn't replace the image: ${err.message}`, 'error', 6000);
  } finally {
    setBusy(null);
  }
}

// ---------- style edits from the options bar ----------
let burstTimer = null;
let inBurst = false;
export function setObjectProp(o, key, value) {
  const editing = o.type === 'text' && state.editingId === o.id;
  // While a text box is being edited, its blur handler records one history entry for all changes.
  if (!inBurst && !editing) {
    pushHistory();
    inBurst = true;
  }
  clearTimeout(burstTimer);
  burstTimer = setTimeout(() => (inBurst = false), 800);
  o[key] = value;
  if (editing) {
    applyTextStyle(textNode(o.id), o);
  } else {
    renderObject(o);
  }
  updateSelection();
  changed();
}
