// Inline stroke icons (24×24 viewBox).
const P = {
  select: '<path d="M5 3.5l13 7.2-5.6 1.6-2.6 5.4z"/><path d="M12.6 12.4l4.6 6.1"/>',
  edittext: '<path d="M4 7V5h11v2"/><path d="M9.5 5v13"/><path d="M7 18h5"/><path d="M18 9v11"/><path d="M16 9h4"/><path d="M16 20h4"/>',
  addtext: '<rect x="3" y="3" width="18" height="18" rx="2.5"/><path d="M8 8h8"/><path d="M12 8v9"/>',
  pen: '<path d="M16.5 3.5l4 4L8 20H4v-4z"/><path d="M14 6l4 4"/>',
  highlighter: '<path d="M14.5 4.5l5 5-7 7-5-5z"/><path d="M7.5 11.5L5 17l2 2 5.5-2.5"/><path d="M3 21h8"/>',
  line: '<path d="M5 19L19 5"/>',
  arrow: '<path d="M5 19L19 5"/><path d="M10 5h9v9"/>',
  rect: '<rect x="4" y="6" width="16" height="12" rx="1.5"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="9" ry="6.5"/>',
  whiteout: '<rect x="3" y="6" width="18" height="12" rx="1.5"/><path d="M6.5 9.5h11M6.5 14.5h7" stroke-dasharray="2 2"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="M21 16l-5-5-8.5 8.5"/>',
  replaceimg: '<rect x="2.5" y="3" width="13" height="11" rx="1.5"/><path d="M2.5 11l3.5-3.5 4.5 4.5"/><path d="M21 12v3.5a3.5 3.5 0 0 1-3.5 3.5H11"/><path d="M13.5 16.5L11 19l2.5 2.5"/>',
  eraser: '<path d="M19.5 20H9l-5-5a2 2 0 0 1 0-2.8l8.2-8.2a2 2 0 0 1 2.8 0l5 5a2 2 0 0 1 0 2.8L13.2 19.6"/><path d="M8.5 8.7l7 7"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  open: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>',
  download: '<path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  thumbs: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4.5h6V7"/><path d="M6.5 7l1 13h9l1-13"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>',
  front: '<rect x="8" y="8" width="12" height="12" rx="1.5" fill="currentColor" fill-opacity=".25"/><path d="M4 15V5a1 1 0 0 1 1-1h10"/>',
  back: '<rect x="4" y="4" width="12" height="12" rx="1.5" fill="currentColor" fill-opacity=".25"/><path d="M20 9v10a1 1 0 0 1-1 1H9"/>',
  data: '<ellipse cx="12" cy="5.5" rx="7.5" ry="2.5"/><path d="M4.5 5.5v13c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-13"/><path d="M4.5 12c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/>',
  revert: '<path d="M4 4v6h6"/><path d="M4.5 13.5A8 8 0 1 0 6 6.3L4 10"/>',
};

export function icon(name, size = 20) {
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
}
