// Tool rail definitions and the context-sensitive options bar.
import { state, getObject, FONT_FAMILIES } from './state.js';
import { $, h } from './util.js';
import { icon } from './icons.js';
import { setObjectProp, deleteSelected, duplicateSelected, reorderSelected, chooseImageForTool } from './editor.js';

export const TOOLS = [
  { id: 'select', label: 'Select & move', key: 'V' },
  { id: 'edittext', label: 'Edit PDF text', key: 'T' },
  { id: 'addtext', label: 'Add text', key: 'A' },
  null,
  { id: 'pen', label: 'Draw', key: 'P' },
  { id: 'highlighter', label: 'Highlight', key: 'H' },
  { id: 'line', label: 'Line', key: 'L' },
  { id: 'arrow', label: 'Arrow', key: 'K' },
  { id: 'rect', label: 'Rectangle', key: 'R' },
  { id: 'ellipse', label: 'Ellipse', key: 'O' },
  { id: 'whiteout', label: 'Whiteout', key: 'W' },
  null,
  { id: 'image', label: 'Insert image', key: 'I' },
  { id: 'replaceimg', label: 'Replace PDF image', key: 'M' },
  null,
  { id: 'eraser', label: 'Eraser', key: 'E' },
];

const HINTS = {
  select: 'Click an edit to select · drag to move · drag corners to resize · double-click text to edit',
  edittext: 'Click any text in the PDF to edit it in place · Esc to finish',
  addtext: 'Click anywhere on a page to add a text box · Esc to finish',
  pen: 'Drag to draw freehand',
  highlighter: 'Drag across text to highlight it',
  line: 'Drag to draw · hold Shift to snap to 45°',
  arrow: 'Drag to draw an arrow · hold Shift to snap to 45°',
  rect: 'Drag to draw · hold Shift for a square',
  ellipse: 'Drag to draw · hold Shift for a circle',
  whiteout: 'Drag over anything on the page to cover it up',
  image: 'Choose an image, then click (or drag to size) on a page · you can also drop or paste images',
  replaceimg: 'Click a highlighted image — or drop an image file onto it — to swap it inside the PDF',
  eraser: 'Click or drag across your edits to remove them',
};

const LABELS = {
  color: 'Color',
  stroke: 'Stroke',
  fill: 'Fill',
  width: 'Width',
  opacity: 'Opacity',
  fontFamily: 'Font',
  fontSize: 'Size',
  bold: 'Bold',
  italic: 'Italic',
  bg: 'Highlight',
  auto: 'Match page color',
};

const LINEISH = ['color', 'width', 'opacity'];
const SHAPE = ['stroke', 'fill', 'width', 'opacity'];
const TEXT = ['fontFamily', 'fontSize', 'bold', 'italic', 'color', 'bg'];

const TOOL_FIELDS = {
  pen: LINEISH,
  highlighter: LINEISH,
  line: LINEISH,
  arrow: LINEISH,
  rect: SHAPE,
  ellipse: SHAPE,
  whiteout: ['fill', 'auto'],
  addtext: TEXT,
};
const TOOL_STYLE = { addtext: 'text' };

const TYPE_LABEL = { path: 'Drawing', line: 'Line', arrow: 'Arrow', rect: 'Rectangle', ellipse: 'Ellipse', text: 'Text', image: 'Image' };

function fieldsFor(o) {
  if (o.type === 'text') return TEXT;
  if (o.type === 'image') return ['opacity'];
  if (o.type === 'rect' && o.whiteout) return ['fill'];
  if (o.type === 'rect' || o.type === 'ellipse') return SHAPE;
  return LINEISH;
}

const noFocusSteal = (e) => e.preventDefault();

function control(key, get, set) {
  const label = LABELS[key] || key;
  const value = get();
  switch (key) {
    case 'color': {
      const input = h('input', { type: 'color', value: value || '#000000', title: label });
      input.addEventListener('input', () => set(input.value));
      return h('label', { class: 'opt' }, h('span', {}, label), input);
    }
    case 'stroke':
    case 'fill':
    case 'bg': {
      const fallback = key === 'bg' ? '#fef08a' : key === 'fill' ? '#ffffff' : '#111827';
      const cb = h('input', { type: 'checkbox', checked: !!value, title: `Use ${label.toLowerCase()}` });
      const col = h('input', { type: 'color', value: value || fallback, title: label });
      cb.addEventListener('change', () => set(cb.checked ? col.value : null));
      col.addEventListener('input', () => {
        cb.checked = true;
        set(col.value);
      });
      return h('label', { class: 'opt opt-color' }, cb, h('span', {}, label), col);
    }
    case 'width':
    case 'opacity': {
      const isOp = key === 'opacity';
      const input = h('input', {
        type: 'range',
        min: isOp ? 0.05 : 0.5,
        max: isOp ? 1 : 40,
        step: isOp ? 0.05 : 0.5,
        value: value ?? (isOp ? 1 : 2),
      });
      const out = h('output', {}, isOp ? `${Math.round((value ?? 1) * 100)}%` : `${value ?? 2}`);
      input.addEventListener('input', () => {
        const v = +input.value;
        out.textContent = isOp ? `${Math.round(v * 100)}%` : `${v}`;
        set(v);
      });
      return h('label', { class: 'opt opt-range' }, h('span', {}, label), input, out);
    }
    case 'fontFamily': {
      const sel = h(
        'select',
        { title: label },
        Object.entries(FONT_FAMILIES).map(([k, f]) => h('option', { value: k, selected: k === value }, f.label)),
      );
      sel.addEventListener('change', () => set(sel.value));
      return h('label', { class: 'opt' }, h('span', {}, label), sel);
    }
    case 'fontSize': {
      const input = h('input', { type: 'number', min: 4, max: 300, step: 0.5, value: value ?? 16, class: 'num' });
      input.addEventListener('input', () => {
        const v = +input.value;
        if (v >= 4 && v <= 300) set(v);
      });
      return h('label', { class: 'opt' }, h('span', {}, label), input);
    }
    case 'bold':
    case 'italic': {
      const btn = h(
        'button',
        {
          class: `opt-toggle ${key}`,
          type: 'button',
          title: label,
          'aria-pressed': String(!!value),
          onmousedown: noFocusSteal,
        },
        key === 'bold' ? 'B' : 'I',
      );
      btn.addEventListener('click', () => {
        const v = btn.getAttribute('aria-pressed') !== 'true';
        btn.setAttribute('aria-pressed', String(v));
        set(v);
      });
      return btn;
    }
    case 'auto': {
      const cb = h('input', { type: 'checkbox', checked: !!value });
      cb.addEventListener('change', () => set(cb.checked));
      return h('label', { class: 'opt opt-check', title: 'Sample the page color under the area you cover' }, cb, h('span', {}, label));
    }
    default:
      return null;
  }
}

const actionBtn = (name, label, onclick, extra = '') =>
  h('button', { class: `btn sm ${extra}`, type: 'button', title: label, onmousedown: noFocusSteal, onclick, html: `${icon(name, 16)}<span>${label}</span>` });

export function renderOptions() {
  const bar = $('#toolOptions');
  if (!bar) return;
  bar.replaceChildren();
  const tool = state.tool;
  const o = getObject(state.selectedId);
  const group = h('div', { class: 'opt-group' });

  if (o && ['select', 'edittext', 'addtext', 'eraser'].includes(tool)) {
    const title = o.source ? 'Edited PDF text' : o.type === 'rect' && o.whiteout ? 'Whiteout' : TYPE_LABEL[o.type];
    bar.append(h('span', { class: 'opt-title' }, title));
    for (const key of fieldsFor(o)) {
      const c = control(
        key,
        () => o[key],
        (v) => {
          setObjectProp(o, key, v);
          if (o.type === 'text' && !o.source && tool === 'addtext') state.toolStyles.text[key] = v;
        },
      );
      if (c) group.append(c);
    }
    bar.append(group);
    const actions = h('div', { class: 'opt-actions' });
    if (!o.source) actions.append(actionBtn('copy', 'Duplicate', duplicateSelected));
    actions.append(actionBtn('front', 'Front', () => reorderSelected(true)), actionBtn('back', 'Back', () => reorderSelected(false)));
    actions.append(o.source ? actionBtn('revert', 'Revert to original', deleteSelected, 'danger') : actionBtn('trash', 'Delete', deleteSelected, 'danger'));
    bar.append(actions);
    return;
  }

  const t = TOOLS.find((x) => x && x.id === tool);
  bar.append(h('span', { class: 'opt-title' }, t?.label || ''));
  const styleKey = TOOL_STYLE[tool] || tool;
  const fields = TOOL_FIELDS[tool] || [];
  const target = state.toolStyles[styleKey];
  for (const key of fields) {
    const c = control(
      key,
      () => target[key],
      (v) => (target[key] = v),
    );
    if (c) group.append(c);
  }
  if (tool === 'image') {
    if (state.pendingAsset) {
      const asset = state.assets.get(state.pendingAsset);
      group.append(
        h('img', { class: 'opt-preview', src: asset?.dataUrl || '', alt: '' }),
        h('span', { class: 'opt-note' }, 'Ready — click a page to place it'),
        actionBtn('image', 'Choose another…', chooseImageForTool),
      );
    } else {
      group.append(actionBtn('image', 'Choose image…', chooseImageForTool, 'primary'));
    }
  }
  if (tool === 'replaceimg') {
    const sel = h(
      'select',
      {},
      [
        ['cover', 'Fill & crop'],
        ['contain', 'Fit inside'],
        ['stretch', 'Stretch'],
      ].map(([v, l]) => h('option', { value: v, selected: state.imageFit === v }, l)),
    );
    sel.addEventListener('change', () => (state.imageFit = sel.value));
    group.append(h('label', { class: 'opt', title: 'How the new image fits the old image box' }, h('span', {}, 'Fit'), sel));
  }
  if (tool === 'edittext') group.append(h('span', { class: 'opt-note' }, 'Font, size and color are matched automatically — tweak them after clicking'));
  if (group.childNodes.length) bar.append(group);
  bar.append(h('span', { class: 'opt-hint' }, HINTS[tool] || ''));
}
