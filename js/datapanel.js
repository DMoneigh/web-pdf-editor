// Right-hand "Data" panel: document info/metadata, text, tables, images, links/fields/bookmarks, JSON export.
import { state, on, markDirty } from './state.js';
import { h, $, $$, escapeHtml, formatBytes, downloadText, downloadBlob, copyText, toast, pickFile, debounce } from './util.js';
import { pdfjsLib, PDFLib } from './lib.js';
import { getTextModel, rowsToText, rowsToTable, toCSV } from './textmodel.js';
import { getImageModel, thumbnailOf, exportImageEntry, getLibDoc } from './images.js';
import { scrollToPage, flashRect } from './viewer.js';
import { replaceImage } from './editor.js';

let tab = 'info';
let gen = 0;
const TABS = [
  ['info', 'Info'],
  ['text', 'Text'],
  ['tables', 'Tables'],
  ['images', 'Images'],
  ['structure', 'Links & Fields'],
];

export function initDataPanel() {
  const tabs = $('#dpTabs');
  for (const [id, label] of TABS) {
    tabs.append(h('button', { class: 'dp-tab', role: 'tab', dataset: { tab: id }, onclick: () => showTab(id) }, label));
  }
  $('#btnExportJson').addEventListener('click', exportJson);
  on('doc-opened', refresh);
  on('doc-changed', refresh);
  on('objects-changed', debounce(() => tab === 'text' && state.doc && showTab('text', true), 500));
  showTab('info');
}

function refresh() {
  showTab(tab);
}

export function showTab(id, keepScroll = false) {
  tab = id;
  const myGen = ++gen;
  for (const b of $$('.dp-tab')) b.classList.toggle('active', b.dataset.tab === id);
  const body = $('#dpBody');
  const scroll = body.scrollTop;
  const search = $('#dpSearch')?.value || '';
  body.replaceChildren();
  if (!state.doc) {
    body.append(h('div', { class: 'dp-empty' }, 'Open a PDF to inspect its metadata, text, tables, images, links and form fields.'));
    return;
  }
  const alive = () => myGen === gen && state.doc;
  const run = { info: renderInfo, text: renderText, tables: renderTables, images: renderImages, structure: renderStructure }[id];
  Promise.resolve(run(body, alive, search))
    .then(() => {
      if (keepScroll && alive()) body.scrollTop = scroll;
    })
    .catch((err) => {
      console.error(err);
      if (alive()) body.append(h('div', { class: 'dp-error' }, `Couldn't read this section: ${err.message}`));
    });
}

const section = (title, ...children) => h('section', { class: 'dp-section' }, h('h4', {}, title), ...children);
const kv = (rows) =>
  h(
    'dl',
    { class: 'kv' },
    rows.filter(([, v]) => v !== undefined && v !== null && v !== '').flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]),
  );
const progress = (text) => h('div', { class: 'dp-progress' }, h('span', { class: 'spinner sm' }), text);

function pdfDate(s) {
  if (!s) return '';
  try {
    const d = pdfjsLib.PDFDateString?.toDateObject(s);
    if (d && !isNaN(d)) return d.toLocaleString();
  } catch {}
  return s;
}

const PAPER = [
  ['Letter', 612, 792],
  ['Legal', 612, 1008],
  ['Tabloid', 792, 1224],
  ['A3', 842, 1191],
  ['A4', 595, 842],
  ['A5', 420, 595],
];
function paperName(w, hh) {
  const [a, b] = [Math.min(w, hh), Math.max(w, hh)];
  const hit = PAPER.find(([, pw, ph]) => Math.abs(pw - a) < 3 && Math.abs(ph - b) < 3);
  return hit ? `${hit[0]}${w > hh ? ' landscape' : ''}` : '';
}

// ---------- Info ----------
async function renderInfo(body, alive) {
  const d = state.doc;
  const info = d.info?.info || {};
  const sizes = new Map();
  for (const p of d.pages) {
    const key = `${Math.round(p.width)} × ${Math.round(p.height)} pt`;
    sizes.set(key, (sizes.get(key) || 0) + 1);
  }
  const sizeText = [...sizes.entries()]
    .map(([k, n]) => {
      const [w, hh] = k.match(/\d+/g).map(Number);
      const name = paperName(w, hh);
      return `${k} (${(w / 72).toFixed(2)}" × ${(hh / 72).toFixed(2)}")${name ? ` · ${name}` : ''}${sizes.size > 1 ? ` — ${n} page${n > 1 ? 's' : ''}` : ''}`;
    })
    .join('\n');

  body.append(
    section(
      'Document',
      kv([
        ['File', d.name],
        ['Size', formatBytes(d.size)],
        ['PDF version', info.PDFFormatVersion],
        ['Pages', String(d.pages.length)],
        ['Page size', sizeText],
        ['Encrypted', d.encrypted ? 'Yes' : 'No'],
        ['Linearized', info.IsLinearized ? 'Yes (fast web view)' : 'No'],
        ['Form', info.IsAcroFormPresent ? 'AcroForm present' : info.IsXFAPresent ? 'XFA form' : 'None'],
        ['Created', pdfDate(info.CreationDate)],
        ['Modified', pdfDate(info.ModDate)],
      ]),
    ),
  );

  const fields = [
    ['title', 'Title', info.Title],
    ['author', 'Author', info.Author],
    ['subject', 'Subject', info.Subject],
    ['keywords', 'Keywords', info.Keywords],
    ['creator', 'Creator app', info.Creator],
    ['producer', 'Producer', info.Producer],
  ];
  const form = h('div', { class: 'meta-form' });
  for (const [key, label, orig] of fields) {
    const input = h('input', { type: 'text', value: key in state.meta ? state.meta[key] : orig || '', placeholder: '—', 'aria-label': label });
    input.addEventListener('input', () => {
      state.meta[key] = input.value;
      markDirty();
    });
    form.append(h('label', {}, h('span', {}, label), input));
  }
  body.append(section('Metadata (editable — saved on download)', form));

  const fontsHost = h('div', {}, progress('Scanning fonts…'));
  body.append(section('Fonts', fontsHost));
  if (d.info?.metadata) {
    let raw = '';
    try {
      raw = d.info.metadata.getRaw?.() || '';
    } catch {}
    if (raw) body.append(section('XMP metadata', h('details', {}, h('summary', {}, 'Show raw XML'), h('pre', { class: 'code' }, raw))));
  }
  if (info.Custom && Object.keys(info.Custom).length) {
    body.append(section('Custom properties', kv(Object.entries(info.Custom).map(([k, v]) => [k, String(v)]))));
  }

  try {
    const fonts = await listFonts();
    if (!alive()) return;
    fontsHost.replaceChildren(
      fonts.length
        ? h(
            'table',
            { class: 'grid-table' },
            h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Type'), h('th', {}, 'Embedded'), h('th', {}, 'Pages'))),
            h(
              'tbody',
              {},
              fonts.map((f) => h('tr', {}, h('td', {}, f.name), h('td', {}, f.type), h('td', {}, f.embedded ? 'Yes' : 'No'), h('td', {}, f.pages))),
            ),
          )
        : h('div', { class: 'muted' }, 'No fonts found (the document may be image-only/scanned).'),
    );
  } catch (err) {
    fontsHost.replaceChildren(h('div', { class: 'muted' }, `Font scan unavailable: ${err.message}`));
  }
}

async function listFonts() {
  const doc = await getLibDoc();
  const { PDFName, PDFDict, PDFArray } = PDFLib;
  const found = new Map();
  const nameOf = (v) => (v instanceof PDFLib.PDFName ? v.decodeText() : '');
  const embedded = (fontDict) => {
    let fd = fontDict.lookup(PDFName.of('FontDescriptor'));
    const desc = fontDict.lookup(PDFName.of('DescendantFonts'));
    if (!fd && desc instanceof PDFArray) {
      const d0 = desc.lookup(0);
      if (d0 instanceof PDFDict) fd = d0.lookup(PDFName.of('FontDescriptor'));
    }
    if (!(fd instanceof PDFDict)) return nameOf(fontDict.lookup(PDFName.of('Subtype'))) === 'Type3';
    return ['FontFile', 'FontFile2', 'FontFile3'].some((k) => fd.has(PDFName.of(k)));
  };
  const visit = (res, pageNo, depth) => {
    if (!(res instanceof PDFDict) || depth > 4) return;
    const fonts = res.lookup(PDFName.of('Font'));
    if (fonts instanceof PDFDict) {
      for (const [, ref] of fonts.entries()) {
        const f = doc.context.lookup(ref);
        if (!(f instanceof PDFDict)) continue;
        const name = (nameOf(f.lookup(PDFName.of('BaseFont'))) || '(unnamed)').replace(/^[A-Z]{6}\+/, '');
        const type = nameOf(f.lookup(PDFName.of('Subtype')));
        const key = `${name}|${type}`;
        if (!found.has(key)) found.set(key, { name, type, embedded: embedded(f), pages: new Set() });
        found.get(key).pages.add(pageNo);
      }
    }
    const xo = res.lookup(PDFName.of('XObject'));
    if (xo instanceof PDFDict) {
      for (const [, ref] of xo.entries()) {
        const x = doc.context.lookup(ref);
        if (x?.dict && x.dict.lookup(PDFName.of('Subtype')) === PDFName.of('Form')) visit(x.dict.lookup(PDFName.of('Resources')), pageNo, depth + 1);
      }
    }
  };
  doc.getPages().forEach((page, i) => visit(page.node.Resources(), i + 1, 0));
  return [...found.values()].map((f) => ({ ...f, pages: compactRanges([...f.pages]) }));
}

function compactRanges(nums) {
  nums.sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < nums.length; i++) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out.push(i === j ? `${nums[i]}` : `${nums[i]}–${nums[j]}`);
    i = j;
  }
  return out.join(', ');
}

// ---------- Text ----------
function editsFor(pageIndex) {
  const map = new Map();
  for (const o of state.objects) if (o.page === pageIndex && o.source) map.set(o.source, o.text);
  return map;
}

export async function collectPageTexts(alive = () => true, onProgress) {
  const out = [];
  for (const p of state.doc.pages) {
    if (!alive()) return null;
    onProgress?.(p.index);
    const model = await getTextModel(p);
    let text = rowsToText(model, editsFor(p.index));
    const added = state.objects.filter((o) => o.page === p.index && o.type === 'text' && !o.source && o.text.trim());
    if (added.length) text += `${text ? '\n' : ''}${added.map((o) => o.text).join('\n')}`;
    out.push({ page: p.index, text, model });
  }
  return out;
}

async function renderText(body, alive, search) {
  const input = h('input', { id: 'dpSearch', type: 'search', placeholder: 'Search text…', value: search, 'aria-label': 'Search text' });
  const count = h('span', { class: 'muted small' });
  const copyBtn = h('button', { class: 'btn sm' }, 'Copy all');
  const dlBtn = h('button', { class: 'btn sm' }, 'Download .txt');
  body.append(h('div', { class: 'dp-toolbar' }, input, copyBtn, dlBtn), count);
  const results = h('div', { class: 'search-results' });
  const list = h('div', { class: 'text-pages' }, progress('Extracting text…'));
  body.append(results, list);

  const texts = await collectPageTexts(alive, (i) => {
    list.firstChild && (list.firstChild.lastChild.textContent = `Extracting text… page ${i + 1} of ${state.doc.pages.length}`);
  });
  if (!texts || !alive()) return;
  const hasEdits = state.objects.some((o) => o.type === 'text');
  list.replaceChildren();
  if (hasEdits) list.append(h('div', { class: 'note' }, 'Includes your text edits and added text boxes.'));
  const shown = texts.map((t) => t.text || '(no extractable text on this page — it may be a scanned image)');
  const pres = texts.map(({ page }, i) => {
    const pre = h('pre', { class: 'page-text' });
    pre.textContent = shown[i];
    list.append(h('div', { class: 'page-text-head' }, h('button', { class: 'link', onclick: () => scrollToPage(page) }, `Page ${page + 1}`)), pre);
    return pre;
  });
  const all = () => texts.map((t) => `--- Page ${t.page + 1} ---\n${t.text}`).join('\n\n');
  copyBtn.onclick = async () => toast((await copyText(all())) ? 'Text copied to clipboard' : 'Copy failed', 'success');
  dlBtn.onclick = () => downloadText(all(), (state.doc.name || 'document').replace(/\.pdf$/i, '') + '.txt');

  const doSearch = () => {
    const q = input.value.trim();
    results.replaceChildren();
    if (!q) {
      texts.forEach((t, i) => (pres[i].textContent = shown[i]));
      count.textContent = '';
      return;
    }
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    let total = 0;
    texts.forEach((t, i) => {
      const matches = t.text.match(re)?.length || 0;
      total += matches;
      pres[i].innerHTML = escapeHtml(t.text).replace(
        new RegExp(escapeHtml(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
        (m) => `<mark>${m}</mark>`,
      );
      for (const b of t.model.blocks) {
        if (!b.text.toLowerCase().includes(q.toLowerCase()) || results.childElementCount >= 100) continue;
        results.append(
          h(
            'button',
            { class: 'result', onclick: () => flashRect(t.page, { x: b.x, y: b.top, w: b.w, h: b.bottom - b.top }) },
            h('b', {}, `p.${t.page + 1}`),
            ' ',
            b.text.length > 70 ? b.text.slice(0, 70) + '…' : b.text,
          ),
        );
      }
    });
    count.textContent = `${total} match${total === 1 ? '' : 'es'}`;
  };
  input.addEventListener('input', debounce(doSearch, 200));
  if (search) doSearch();
}

// ---------- Tables ----------
async function renderTables(body, alive) {
  const pick = h('select', { 'aria-label': 'Page' }, state.doc.pages.map((p) => h('option', { value: p.index }, `Page ${p.index + 1}`)));
  const csvBtn = h('button', { class: 'btn sm' }, 'Download CSV');
  const tsvBtn = h('button', { class: 'btn sm' }, 'Copy for Excel');
  const allBtn = h('button', { class: 'btn sm' }, 'All pages CSV');
  body.append(
    h('div', { class: 'dp-toolbar' }, pick, csvBtn, tsvBtn, allBtn),
    h('p', { class: 'muted small' }, 'Text is grouped into rows and columns by position — great for invoices, statements and reports.'),
  );
  const host = h('div', { class: 'table-host' });
  body.append(host);
  let grid = [];
  const show = async () => {
    host.replaceChildren(progress('Analyzing layout…'));
    const model = await getTextModel(state.doc.pages[+pick.value]);
    if (!alive()) return;
    grid = rowsToTable(model).grid;
    host.replaceChildren(
      grid.length
        ? h(
            'div',
            { class: 'table-scroll' },
            h(
              'table',
              { class: 'grid-table data' },
              h('tbody', {}, grid.map((r, i) => h('tr', { class: i === 0 ? 'head' : '' }, r.map((c) => h('td', {}, c))))),
            ),
          )
        : h('div', { class: 'muted' }, 'No text found on this page.'),
    );
  };
  pick.addEventListener('change', show);
  const base = () => (state.doc.name || 'document').replace(/\.pdf$/i, '');
  csvBtn.onclick = () => downloadText(toCSV(grid), `${base()}-page${+pick.value + 1}.csv`, 'text/csv');
  tsvBtn.onclick = async () =>
    toast((await copyText(grid.map((r) => r.join('\t')).join('\n'))) ? 'Table copied — paste into a spreadsheet' : 'Copy failed', 'success');
  allBtn.onclick = async () => {
    const rows = [];
    for (const p of state.doc.pages) {
      const g = rowsToTable(await getTextModel(p)).grid;
      for (const r of g) rows.push([String(p.index + 1), ...r]);
    }
    const width = Math.max(1, ...rows.map((r) => r.length));
    const header = ['Page', ...Array.from({ length: width - 1 }, (_, i) => `Column ${i + 1}`)];
    downloadText(toCSV([header, ...rows]), `${base()}-all-pages.csv`, 'text/csv');
  };
  await show();
}

// ---------- Images ----------
async function renderImages(body, alive) {
  const fit = h(
    'select',
    { 'aria-label': 'Replacement fit' },
    [
      ['cover', 'Fill frame (crop)'],
      ['contain', 'Fit inside frame'],
      ['stretch', 'Stretch to frame'],
    ].map(([v, l]) => h('option', { value: v, selected: state.imageFit === v }, l)),
  );
  fit.addEventListener('change', () => (state.imageFit = fit.value));
  body.append(h('div', { class: 'dp-toolbar' }, h('span', { class: 'muted small' }, 'Replacement fit'), fit));
  const status = progress('Scanning pages for images…');
  const grid = h('div', { class: 'image-grid' });
  body.append(status, grid);
  let total = 0;
  for (const p of state.doc.pages) {
    if (!alive()) return;
    status.lastChild.textContent = `Scanning page ${p.index + 1} of ${state.doc.pages.length}…`;
    const list = await getImageModel(p);
    if (!alive()) return;
    for (const entry of list) {
      total++;
      const thumb = entry.img ? thumbnailOf(entry, 220) : h('div', { class: 'thumb-missing' }, 'preview unavailable');
      grid.append(
        h(
          'div',
          { class: 'image-card' },
          h('div', { class: 'image-thumb' }, thumb),
          h(
            'div',
            { class: 'image-meta' },
            h('b', {}, `Page ${p.index + 1}`),
            h('span', {}, `${entry.pixelW}×${entry.pixelH}px`),
            h('span', {}, `${Math.round(entry.rect.w)}×${Math.round(entry.rect.h)}pt${entry.inline ? ' · inline' : ''}`),
          ),
          h(
            'div',
            { class: 'image-actions' },
            h('button', { class: 'btn xs', onclick: () => flashRect(p.index, entry.rect) }, 'Locate'),
            h(
              'button',
              {
                class: 'btn xs',
                onclick: async () => {
                  const { blob, ext } = await exportImageEntry(entry);
                  downloadBlob(blob, `page${p.index + 1}-image-${entry.id.split('-')[1]}.${ext}`);
                },
              },
              'Download',
            ),
            h(
              'button',
              {
                class: 'btn xs primary',
                onclick: async () => {
                  const file = await pickFile('image/*');
                  if (file) await replaceImage(entry, file);
                },
              },
              'Replace',
            ),
          ),
        ),
      );
    }
  }
  status.replaceWith(
    h('div', { class: 'muted small' }, total ? `${total} image${total === 1 ? '' : 's'} found.` : 'No images found in this document.'),
  );
}

// ---------- Links, fields, bookmarks, attachments ----------
async function gatherStructure() {
  const pdf = state.doc.pdfjs;
  const links = [];
  for (const p of state.doc.pages) {
    const annots = await p.proxy.getAnnotations();
    for (const a of annots) {
      if (a.subtype !== 'Link') continue;
      const [x1, y1, x2, y2] = a.rect;
      const vp = p.vp1;
      const [ax, ay] = vp.convertToViewportPoint(x1, y1);
      const [bx, by] = vp.convertToViewportPoint(x2, y2);
      links.push({
        page: p.index,
        url: a.url || a.unsafeUrl || null,
        dest: a.dest || null,
        rect: { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) },
      });
    }
  }
  let fields = [];
  try {
    const fo = (await pdf.getFieldObjects()) || {};
    fields = Object.entries(fo).flatMap(([name, arr]) =>
      arr
        .filter((f) => f.type || f.value !== undefined)
        .slice(0, 1)
        .map((f) => ({ name, type: f.type || '', value: Array.isArray(f.value) ? f.value.join(', ') : String(f.value ?? ''), page: (f.page ?? -1) + 1 })),
    );
  } catch {}
  const outline = (await pdf.getOutline().catch(() => null)) || [];
  const attachments = (await pdf.getAttachments().catch(() => null)) || {};
  return { links, fields, outline, attachments };
}

async function goToDest(dest) {
  const pdf = state.doc.pdfjs;
  try {
    const explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
    if (!explicit) return;
    const ref = explicit[0];
    const index = typeof ref === 'number' ? ref : await pdf.getPageIndex(ref);
    scrollToPage(index);
  } catch (err) {
    toast(`Couldn't follow that destination: ${err.message}`, 'error');
  }
}

async function renderStructure(body, alive) {
  body.append(progress('Reading links, fields and bookmarks…'));
  const s = await gatherStructure();
  if (!alive()) return;
  body.replaceChildren();

  const outlineList = (items) =>
    h(
      'ul',
      { class: 'outline' },
      items.map((it) =>
        h('li', {}, h('button', { class: 'link', onclick: () => it.dest && goToDest(it.dest) }, it.title || '(untitled)'), it.items?.length ? outlineList(it.items) : null),
      ),
    );
  body.append(section(`Bookmarks (${s.outline.length})`, s.outline.length ? outlineList(s.outline) : h('div', { class: 'muted' }, 'No bookmarks.')));

  body.append(
    section(
      `Links (${s.links.length})`,
      s.links.length
        ? h(
            'ul',
            { class: 'link-list' },
            s.links.map((l) =>
              h(
                'li',
                {},
                h('button', { class: 'link', onclick: () => flashRect(l.page, l.rect) }, `p.${l.page + 1}`),
                ' ',
                l.url ? h('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer' }, l.url) : h('span', { class: 'muted' }, 'Internal link'),
              ),
            ),
          )
        : h('div', { class: 'muted' }, 'No links.'),
    ),
  );

  body.append(
    section(
      `Form fields (${s.fields.length})`,
      s.fields.length
        ? h(
            'table',
            { class: 'grid-table' },
            h('thead', {}, h('tr', {}, ['Name', 'Type', 'Value', 'Page'].map((t) => h('th', {}, t)))),
            h('tbody', {}, s.fields.map((f) => h('tr', {}, h('td', {}, f.name), h('td', {}, f.type), h('td', {}, f.value), h('td', {}, f.page > 0 ? String(f.page) : '')))),
          )
        : h('div', { class: 'muted' }, 'No form fields.'),
      s.fields.length
        ? h('button', { class: 'btn sm', onclick: () => downloadText(toCSV([['Name', 'Type', 'Value', 'Page'], ...s.fields.map((f) => [f.name, f.type, f.value, String(f.page)])]), 'form-fields.csv', 'text/csv') }, 'Download fields CSV')
        : null,
    ),
  );

  const att = Object.values(s.attachments);
  body.append(
    section(
      `Attachments (${att.length})`,
      att.length
        ? h(
            'ul',
            { class: 'link-list' },
            att.map((a) =>
              h('li', {}, h('button', { class: 'link', onclick: () => downloadBlob(new Blob([a.content]), a.filename) }, a.filename), ` · ${formatBytes(a.content?.length)}`),
            ),
          )
        : h('div', { class: 'muted' }, 'No embedded files.'),
    ),
  );
}

// ---------- JSON export ----------
async function exportJson() {
  if (!state.doc) return toast('Open a PDF first.', 'error');
  toast('Collecting document data…');
  const d = state.doc;
  const texts = await collectPageTexts();
  const s = await gatherStructure();
  const images = [];
  for (const p of d.pages) {
    for (const e of await getImageModel(p)) {
      images.push({ page: p.index + 1, x: +e.rect.x.toFixed(1), y: +e.rect.y.toFixed(1), width: +e.rect.w.toFixed(1), height: +e.rect.h.toFixed(1), pixelWidth: e.pixelW, pixelHeight: e.pixelH, inline: e.inline });
    }
  }
  let fonts = [];
  try {
    fonts = await listFonts();
  } catch {}
  const flatOutline = (items, depth = 0) => items.flatMap((i) => [{ title: i.title, depth }, ...flatOutline(i.items || [], depth + 1)]);
  const out = {
    file: { name: d.name, size: d.size },
    info: d.info?.info || {},
    metadataEdits: state.meta,
    pageCount: d.pages.length,
    pages: d.pages.map((p, i) => ({
      number: i + 1,
      width: +p.width.toFixed(2),
      height: +p.height.toFixed(2),
      rotation: p.rotation,
      text: texts[i].text,
      table: rowsToTable(texts[i].model).grid,
    })),
    images,
    fonts,
    links: s.links.map((l) => ({ page: l.page + 1, url: l.url, internal: !l.url })),
    formFields: s.fields,
    bookmarks: flatOutline(s.outline),
    attachments: Object.values(s.attachments).map((a) => ({ filename: a.filename, size: a.content?.length })),
  };
  downloadText(JSON.stringify(out, null, 2), (d.name || 'document').replace(/\.pdf$/i, '') + '-data.json', 'application/json');
}
