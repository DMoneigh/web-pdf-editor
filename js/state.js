// Central app state, a tiny event bus, and snapshot-based undo/redo.

export const FONT_FAMILIES = {
  Helvetica: { css: "Helvetica, Arial, 'Liberation Sans', 'Nimbus Sans', sans-serif", label: 'Sans (Helvetica)' },
  Times: { css: "'Times New Roman', Times, 'Liberation Serif', 'Nimbus Roman', serif", label: 'Serif (Times)' },
  Courier: { css: "'Courier New', Courier, 'Liberation Mono', 'Nimbus Mono PS', monospace", label: 'Mono (Courier)' },
};
export const LINE_HEIGHT = 1.2;

export const state = {
  doc: null, // { name, size, bytes, pdfjs, pages[], info, encrypted }
  objects: [], // overlay edits (drawings, text, images) in page space (pt, top-left origin)
  assets: new Map(), // assetId -> { dataUrl, mime, width, height }
  meta: {}, // edited document metadata
  zoom: 1,
  tool: 'select',
  selectedId: null,
  editingId: null,
  pendingAsset: null, // image chosen with the Image tool, waiting to be placed
  dirty: false,
  imageFit: 'cover',
  toolStyles: {
    pen: { color: '#e11d48', width: 3, opacity: 1 },
    highlighter: { color: '#facc15', width: 16, opacity: 0.4 },
    line: { color: '#2563eb', width: 3, opacity: 1 },
    arrow: { color: '#2563eb', width: 3, opacity: 1 },
    rect: { stroke: '#16a34a', fill: null, width: 3, opacity: 1 },
    ellipse: { stroke: '#9333ea', fill: null, width: 3, opacity: 1 },
    whiteout: { fill: '#ffffff', auto: true },
    text: { fontFamily: 'Helvetica', fontSize: 16, bold: false, italic: false, color: '#111827', bg: null },
  },
};

const listeners = new Map();
export function on(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(fn);
}
export function emit(evt, data) {
  for (const fn of listeners.get(evt) || []) {
    try {
      fn(data);
    } catch (err) {
      console.error(`listener for ${evt} failed`, err);
    }
  }
}

const undoStack = [];
const redoStack = [];
const LIMIT = 80;

export function snapshot() {
  return {
    objects: JSON.parse(JSON.stringify(state.objects)),
    bytes: state.doc?.bytes || null,
    meta: { ...state.meta },
  };
}

export function pushHistory(snap = snapshot()) {
  undoStack.push(snap);
  if (undoStack.length > LIMIT) undoStack.shift();
  redoStack.length = 0;
  markDirty();
}

// Drops the most recent undo entry (used when an action turns out to be a no-op).
export function discardLastHistory() {
  undoStack.pop();
  emit('history');
}

export function markDirty() {
  state.dirty = true;
  emit('history');
}

export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;

export function undo() {
  if (!undoStack.length) return null;
  redoStack.push(snapshot());
  const snap = undoStack.pop();
  state.dirty = true;
  emit('history');
  return snap;
}

export function redo() {
  if (!redoStack.length) return null;
  undoStack.push(snapshot());
  const snap = redoStack.pop();
  state.dirty = true;
  emit('history');
  return snap;
}

export function resetHistory() {
  undoStack.length = 0;
  redoStack.length = 0;
  state.dirty = false;
  emit('history');
}

export const getObject = (id) => state.objects.find((o) => o.id === id);
