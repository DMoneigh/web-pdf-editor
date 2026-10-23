// App bootstrap: wires the toolbar, file handling, drag & drop, keyboard shortcuts and panels together.
import { state, on, emit, undo, redo, canUndo, canRedo, resetHistory } from './state.js';
import { $, $$, h, toast, modal, downloadBlob, isPdfFile, isImageFile, isTypingTarget, formatBytes } from './util.js';
import { icon } from './icons.js';
import {
  openDocument,
  reloadBytes,
  setZoom,
  fitWidth,
  fitPage,
  currentPageIndex,
  scrollToPage,
  highlightThumb,
  pageAtClient,
  toPagePoint,
  setBusy,
} from './viewer.js';
import {
  onPointerDown,
  onDoubleClick,
  renderAll,
  select,
  commitEditing,
  ensureTextLayer,
  ensureImageLayer,
  deleteSelected,
  duplicateSelected,
  nudgeSelected,
  insertImageFile,
  replaceFromRegion,
  updateSelection,
  chooseImageForTool,
} from './editor.js';
import { TOOLS, renderOptions } from './toolbar.js';
import { initDataPanel } from './datapanel.js';
import { buildPdf, exportName } from './exporter.js';
import { createSamplePdf } from './sample.js';

const viewerEl = $('#viewer');
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

// ---------- icons in static markup ----------
for (const el of $$('[data-icon]')) el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon, +el.dataset.size || 18));

// ---------- tools ----------
function buildToolRail() {
  const rail = $('#toolRail');
  for (const t of TOOLS) {
    if (!t) {
      rail.append(h('div', { class: 'rail-sep' }));
      continue;
    }
    rail.append(
      h(
        'button',
        {
          class: 'tool',
          type: 'button',
          dataset: { tool: t.id, tip: `${t.label} (${t.key})` },
          'aria-label': `${t.label} (${t.key})`,
          onmousedown: (e) => e.preventDefault(),
          onclick: () => setTool(t.id),
        },
        h('span', { html: icon(t.id, 20) }),
      ),
    );
  }
}

function visiblePages() {
  return (state.doc?.pages || []).filter((p) => p.visible || p.renderedZoom);
}

export function setTool(tool) {
  if (!TOOLS.some((t) => t && t.id === tool)) return;
  if (state.tool !== tool) commitEditing();
  if (tool !== 'image') state.pendingAsset = null;
  state.tool = tool;
  document.body.className = document.body.className.replace(/\btool-\S+/g, '').trim();
  document.body.classList.add(`tool-${tool}`);
  for (const b of $$('#toolRail .tool')) b.classList.toggle('active', b.dataset.tool === tool);
  if (tool === 'edittext') visiblePages().forEach(ensureTextLayer);
  if (tool === 'replaceimg') visiblePages().forEach(ensureImageLayer);
  const o = state.objects.find((x) => x.id === state.selectedId);
  if (o && ['pen', 'highlighter', 'line', 'arrow', 'rect', 'ellipse', 'whiteout', 'image', 'replaceimg'].includes(tool)) select(null);
  else updateSelection();
  renderOptions();
  if (tool === 'image' && state.doc && !state.pendingAsset) {
    // Defer so the click that picked the tool doesn't also count as a page click.
    setTimeout(() => state.tool === 'image' && !state.pendingAsset && chooseImageForTool(), 0);
  }
}

// ---------- history ----------
async function restore(snap) {
  if (!snap) return;
  state.objects = snap.objects;
  state.meta = snap.meta;
  if (snap.bytes && state.doc && snap.bytes !== state.doc.bytes) {
    setBusy('Updating…');
    try {
      await reloadBytes(snap.bytes);
    } finally {
      setBusy(null);
    }
  }
  renderAll();
  renderOptions();
  emit('objects-changed');
}

async function doUndo() {
  commitEditing();
  await restore(undo());
}
async function doRedo() {
  commitEditing();
  await restore(redo());
}

function refreshHistoryUi() {
  $('#btnUndo').disabled = !canUndo();
  $('#btnRedo').disabled = !canRedo();
  document.body.classList.toggle('is-dirty', !!state.dirty);
}

// ---------- open / save ----------
async function confirmDiscard() {
  if (!state.doc || !state.dirty) return true;
  const ok = await modal({
    title: 'Discard your edits?',
    body: 'You have changes that haven’t been downloaded yet. Opening another PDF will discard them.',
    okText: 'Discard & open',
  });
  return !!ok;
}

async function openFile(file) {
  if (!file) return;
  if (!isPdfFile(file)) {
    toast('That doesn’t look like a PDF file.', 'error');
    return;
  }
  if (!(await confirmDiscard())) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  await openDocument(bytes, file.name);
}

async function openSample() {
  if (!(await confirmDiscard())) return;
  setBusy('Generating a sample PDF…');
  try {
    const bytes = await createSamplePdf();
    await openDocument(bytes, 'sample-report.pdf');
  } catch (err) {
    console.error(err);
    setBusy(null);
    toast(`Couldn't create the sample: ${err.message}`, 'error');
  }
}

async function downloadPdf() {
  if (!state.doc) return;
  commitEditing();
  if (state.doc.encrypted) {
    const ok = await modal({
      title: 'Encrypted PDF',
      body: 'This PDF is password-protected. The editor will try to save it, but some viewers may not open the result correctly.',
      okText: 'Save anyway',
    });
    if (!ok) return;
  }
  setBusy('Building your PDF…');
  try {
    const bytes = await buildPdf();
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), exportName());
    state.dirty = false;
    refreshHistoryUi();
    toast(`Saved ${exportName()} (${formatBytes(bytes.length)})`, 'success');
  } catch (err) {
    console.error(err);
    toast(`Export failed: ${err.message}`, 'error', 7000);
  } finally {
    setBusy(null);
  }
}

// ---------- drag & drop ----------
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

function clearDropTargets() {
  for (const el of $$('.img-region.drop-target')) el.classList.remove('drop-target');
}

function regionAt(x, y) {
  return document.elementsFromPoint(x, y).find((el) => el.classList?.contains('img-region')) || null;
}

function setDragUi(on) {
  document.body.classList.toggle('dragging', on);
  if (!on) clearDropTargets();
}

window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  setDragUi(true);
});
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  if (state.tool === 'replaceimg') {
    const r = regionAt(e.clientX, e.clientY);
    for (const el of $$('.img-region.drop-target')) if (el !== r) el.classList.remove('drop-target');
    r?.classList.add('drop-target');
  }
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) setDragUi(false);
});
window.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  const region = state.tool === 'replaceimg' ? regionAt(e.clientX, e.clientY) : null;
  setDragUi(false);
  const file = e.dataTransfer.files?.[0];
  if (!file) return;
  if (isPdfFile(file)) return openFile(file);
  if (!isImageFile(file)) {
    toast('Drop a PDF to open it, or an image to place it on a page.', 'error');
    return;
  }
  if (!state.doc) {
    toast('Open a PDF first — then drop images onto its pages.', 'info');
    return;
  }
  commitEditing();
  const hit = pageAtClient(e.clientX, e.clientY);
  if (region && hit) return replaceFromRegion(hit, region.dataset.img, file);
  const p = hit || state.doc.pages[currentPageIndex()];
  const pt = hit ? toPagePoint(p, e) : { x: p.width / 2, y: p.height / 2 };
  insertImageFile(p, pt, file);
});

window.addEventListener('paste', (e) => {
  if (!state.doc || isTypingTarget(e.target)) return;
  const file = [...(e.clipboardData?.files || [])].find(isImageFile);
  if (!file) return;
  e.preventDefault();
  const p = state.doc.pages[currentPageIndex()];
  insertImageFile(p, { x: p.width / 2, y: p.height / 2 }, file);
});

// ---------- zoom & navigation ----------
function zoomStep(dir) {
  const z = state.zoom;
  const next = dir > 0 ? ZOOM_STEPS.find((s) => s > z + 0.001) : [...ZOOM_STEPS].reverse().find((s) => s < z - 0.001);
  if (next) setZoom(next);
}

function updateZoomUi() {
  const sel = $('#zoomSelect');
  sel.options[0].textContent = `${Math.round(state.zoom * 100)}%`;
  sel.value = 'current';
}

let scrollRaf = 0;
function updatePageUi() {
  scrollRaf = 0;
  if (!state.doc) return;
  const i = currentPageIndex();
  const input = $('#pageInput');
  if (document.activeElement !== input) input.value = i + 1;
  highlightThumb(i);
}

viewerEl.addEventListener('scroll', () => {
  if (!scrollRaf) scrollRaf = requestAnimationFrame(updatePageUi);
});

viewerEl.addEventListener(
  'wheel',
  (e) => {
    if (!state.doc || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const r = viewerEl.getBoundingClientRect();
    const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0022));
    setZoom(state.zoom * factor, { x: e.clientX - r.left, y: e.clientY - r.top });
  },
  { passive: false },
);

viewerEl.addEventListener('pointerdown', onPointerDown);
viewerEl.addEventListener('dblclick', onDoubleClick);

// ---------- keyboard ----------
const TOOL_KEYS = Object.fromEntries(TOOLS.filter(Boolean).map((t) => [t.key.toLowerCase(), t.id]));

window.addEventListener('keydown', (e) => {
  if ($('#modal').classList.contains('open')) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === 's') {
    e.preventDefault();
    downloadPdf();
    return;
  }
  if (mod && k === 'o') {
    e.preventDefault();
    $('#fileInput').click();
    return;
  }
  if (isTypingTarget(e.target)) return;
  if (mod && k === 'z') {
    e.preventDefault();
    e.shiftKey ? doRedo() : doUndo();
    return;
  }
  if (mod && k === 'y') {
    e.preventDefault();
    doRedo();
    return;
  }
  if (mod && k === 'd') {
    e.preventDefault();
    duplicateSelected();
    return;
  }
  if (mod && (k === '=' || k === '+')) {
    e.preventDefault();
    zoomStep(1);
    return;
  }
  if (mod && k === '-') {
    e.preventDefault();
    zoomStep(-1);
    return;
  }
  if (mod && k === '0') {
    e.preventDefault();
    fitWidth();
    return;
  }
  if (mod || e.altKey) return;
  if (k === 'delete' || k === 'backspace') {
    if (state.selectedId) {
      e.preventDefault();
      deleteSelected();
    }
    return;
  }
  if (k === 'escape') {
    if (state.pendingAsset) {
      state.pendingAsset = null;
      renderOptions();
    }
    select(null);
    if (state.tool !== 'select') setTool('select');
    return;
  }
  if (k.startsWith('arrow') && state.selectedId) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const d = { arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, -step], arrowdown: [0, step] }[k];
    nudgeSelected(...d);
    return;
  }
  if ((k === 'pagedown' || k === 'pageup') && state.doc && e.target === document.body) {
    e.preventDefault();
    scrollToPage(currentPageIndex() + (k === 'pagedown' ? 1 : -1));
    return;
  }
  if (TOOL_KEYS[k] && state.doc) setTool(TOOL_KEYS[k]);
});

// ---------- panels ----------
function togglePanel(cls, btn) {
  const on = !document.body.classList.contains(cls);
  document.body.classList.toggle(cls, on);
  $(btn).setAttribute('aria-pressed', String(cls === 'hide-thumbs' ? !on : on));
}

// Tool-rail tooltips live in one fixed element so the scrollable rail never clips them.
const tip = h('div', { class: 'tip', role: 'tooltip' });
document.body.append(tip);
$('#toolRail').addEventListener('pointerover', (e) => {
  const b = e.target.closest('[data-tip]');
  if (!b) return;
  const r = b.getBoundingClientRect();
  tip.textContent = b.dataset.tip;
  tip.style.left = `${r.right + 10}px`;
  tip.style.top = `${r.top + r.height / 2 - 14}px`;
  tip.classList.add('show');
});
$('#toolRail').addEventListener('pointerout', (e) => {
  if (!e.relatedTarget?.closest?.('[data-tip]')) tip.classList.remove('show');
});
$('#toolRail').addEventListener('click', () => tip.classList.remove('show'));

// ---------- event wiring ----------
on('history', refreshHistoryUi);
on('zoom', updateZoomUi);
on('selection', renderOptions);
on('tool', renderOptions);
on('request-tool', (t) => setTool(t));
on('page-rendered', (p) => {
  ensureTextLayer(p);
  ensureImageLayer(p);
});
on('doc-opened', () => {
  resetHistory();
  document.body.classList.add('has-doc');
  const d = state.doc;
  $('#fileName').textContent = d.name;
  $('#fileName').title = d.name;
  $('#frameTitle').textContent = d.name;
  $('#frameMeta').textContent = `${d.pages.length} page${d.pages.length === 1 ? '' : 's'} · ${formatBytes(d.size)}${d.encrypted ? ' · encrypted' : ''}`;
  $('#pageCount').textContent = `/ ${d.pages.length}`;
  $('#pageInput').max = d.pages.length;
  $('#pageInput').value = 1;
  renderAll();
  setTool(state.tool === 'image' ? 'select' : state.tool);
  updatePageUi();
  toast(`Opened ${d.name}`, 'success', 2200);
});
on('doc-changed', () => {
  $('#frameMeta').textContent = `${state.doc.pages.length} page${state.doc.pages.length === 1 ? '' : 's'} · ${formatBytes(state.doc.bytes.length)}`;
});

// ---------- buttons ----------
$('#fileInput').addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  e.target.value = '';
  openFile(f);
});
for (const id of ['#btnOpen', '#btnBrowse']) $(id).addEventListener('click', () => $('#fileInput').click());
$('#btnSample').addEventListener('click', openSample);
$('#btnUndo').addEventListener('click', doUndo);
$('#btnRedo').addEventListener('click', doRedo);
$('#btnZoomIn').addEventListener('click', () => zoomStep(1));
$('#btnZoomOut').addEventListener('click', () => zoomStep(-1));
$('#zoomSelect').addEventListener('change', (e) => {
  const v = e.target.value;
  if (v === 'width') fitWidth();
  else if (v === 'page') fitPage();
  else if (v !== 'current') setZoom(+v);
  updateZoomUi();
});
$('#pageInput').addEventListener('change', (e) => {
  const n = Math.round(+e.target.value);
  if (state.doc && n >= 1 && n <= state.doc.pages.length) scrollToPage(n - 1);
  else updatePageUi();
});
$('#btnPrev').addEventListener('click', () => scrollToPage(Math.max(0, currentPageIndex() - 1)));
$('#btnNext').addEventListener('click', () => scrollToPage(Math.min((state.doc?.pages.length || 1) - 1, currentPageIndex() + 1)));
$('#btnDownload').addEventListener('click', downloadPdf);
$('#btnThumbs').addEventListener('click', () => togglePanel('hide-thumbs', '#btnThumbs'));
$('#btnData').addEventListener('click', () => togglePanel('show-data', '#btnData'));
$('#btnCloseData').addEventListener('click', () => togglePanel('show-data', '#btnData'));

const dropFrame = $('#dropFrame');
dropFrame.addEventListener('click', (e) => {
  if (!e.target.closest('button')) $('#fileInput').click();
});
dropFrame.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target === dropFrame) {
    e.preventDefault();
    $('#fileInput').click();
  }
});

window.addEventListener('beforeunload', (e) => {
  if (state.doc && state.dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(updatePageUi, 150);
});

// ---------- boot ----------
buildToolRail();
initDataPanel();
setTool('select');
refreshHistoryUi();
// Wide screens show the data panel by default; narrow ones keep the canvas roomy.
if (window.innerWidth >= 1280) togglePanel('show-data', '#btnData');
if (window.innerWidth < 760) togglePanel('hide-thumbs', '#btnThumbs');
window.__pdfStudio = { state, setTool, openSample };
