// Builds an editable/extractable text model (rows -> blocks) from pdf.js text content.
import { apply, rgbToHex } from './util.js';
import { FONT_FAMILIES, LINE_HEIGHT } from './state.js';

export async function getTextModel(page) {
  if (page.textModel) return page.textModel;
  if (page.textModelPromise) return page.textModelPromise;
  page.textModelPromise = buildTextModel(page).then((m) => {
    page.textModel = m;
    page.textModelPromise = null;
    return m;
  });
  return page.textModelPromise;
}

async function buildTextModel(page) {
  const tc = await page.proxy.getTextContent();
  const vt = page.vp1.transform;
  const scale = Math.hypot(vt[0], vt[1]) || 1;
  const items = [];
  const others = [];

  for (const it of tc.items) {
    if (typeof it.str !== 'string') continue;
    const [a, b, c, d, e, f] = it.transform;
    const dx = vt[0] * a + vt[2] * b;
    const dy = vt[1] * a + vt[3] * b;
    const [x, y] = apply(vt, e, f);
    const fs = (Math.hypot(c, d) || it.height || Math.hypot(a, b)) * scale;
    const style = tc.styles[it.fontName] || {};
    const horizontal = dx > 0 && Math.abs(dy) <= Math.abs(dx) * 0.035 && !style.vertical;
    const entry = { str: it.str, x, y, w: (it.width || 0) * scale, fs, fontName: it.fontName, style, eol: it.hasEOL };
    if (fs < 0.5) continue;
    (horizontal ? items : others).push(entry);
  }

  items.sort((p, q) => p.y - q.y || p.x - q.x);
  const rows = [];
  for (const it of items) {
    let row = rows[rows.length - 1];
    if (!row || Math.abs(it.y - row.y) > 0.45 * Math.min(it.fs, row.fs)) {
      row = { y: it.y, fs: it.fs, items: [] };
      rows.push(row);
    }
    row.items.push(it);
  }

  let n = 0;
  for (const row of rows) {
    row.items.sort((p, q) => p.x - q.x);
    row.blocks = [];
    let block = null;
    for (const it of row.items) {
      const blank = !it.str.trim();
      if (blank) {
        if (block && it.str.length) block.pendingSpace = true;
        continue;
      }
      const gap = block ? it.x - block.right : 0;
      const sameFont = block && block.fontName === it.fontName && Math.abs(block.fs - it.fs) <= 0.15 * it.fs;
      if (!block || !sameFont || gap > Math.max(1.1 * it.fs, 6) || gap < -0.6 * it.fs) {
        block = {
          id: `${page.index}:${n++}`,
          page: page.index,
          text: it.str,
          x: it.x,
          right: it.x + it.w,
          y: it.y,
          fs: it.fs,
          fontName: it.fontName,
          style: it.style,
        };
        row.blocks.push(block);
      } else {
        const needsSpace = block.pendingSpace || gap > 0.18 * it.fs;
        if (needsSpace && !/\s$/.test(block.text) && !/^\s/.test(it.str)) block.text += ' ';
        block.text += it.str;
        block.right = Math.max(block.right, it.x + it.w);
      }
      block.pendingSpace = false;
    }
    for (const b of row.blocks) {
      const asc = clampNum(b.style.ascent, 0.6, 1.1, 0.85);
      const desc = clampNum(b.style.descent, -0.45, 0, -0.22);
      b.text = b.text.replace(/\s+$/, '');
      b.w = b.right - b.x;
      b.top = b.y - asc * b.fs;
      b.bottom = b.y - desc * b.fs;
      delete b.pendingSpace;
    }
  }

  const blocks = rows.flatMap((r) => r.blocks);
  return { rows, blocks, otherText: others.map((o) => o.str).join(' ').trim() };
}

function clampNum(v, lo, hi, dflt) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return dflt;
  return Math.min(hi, Math.max(lo, v));
}

// Visual-order plain text of a page; edited blocks are swapped for their replacement text.
export function rowsToText(model, edits = new Map()) {
  const lines = [];
  for (const row of model.rows) {
    let line = '';
    let prev = null;
    for (const b of row.blocks) {
      const text = edits.has(b.id) ? edits.get(b.id) : b.text;
      if (prev) line += b.x - prev.right > 3 * b.fs ? '\t' : ' ';
      line += text;
      prev = b;
    }
    if (line.trim()) lines.push(line);
  }
  if (model.otherText) lines.push(model.otherText);
  return lines.join('\n');
}

// Heuristic table reconstruction: cluster block x-positions into columns.
export function rowsToTable(model) {
  const rows = model.rows.filter((r) => r.blocks.length);
  if (!rows.length) return { columns: 0, grid: [] };
  const starts = rows
    .filter((r) => r.blocks.length > 1)
    .flatMap((r) => r.blocks.map((b) => b.x))
    .sort((a, b) => a - b);
  const anchors = [];
  for (const x of starts) {
    const last = anchors[anchors.length - 1];
    if (last !== undefined && x - last.max < 14) last.max = x;
    else anchors.push({ min: x, max: x });
  }
  if (!anchors.length) anchors.push({ min: 0, max: 0 });
  const grid = rows.map((r) => {
    const cells = new Array(anchors.length).fill('');
    for (const b of r.blocks) {
      let col = 0;
      for (let i = 0; i < anchors.length; i++) if (anchors[i].min <= b.x + 8) col = i;
      cells[col] = cells[col] ? `${cells[col]} ${b.text}` : b.text;
    }
    return cells;
  });
  // Drop columns that are empty in every row.
  const keep = anchors.map((_, i) => grid.some((r) => r[i]));
  return { columns: keep.filter(Boolean).length, grid: grid.map((r) => r.filter((_, i) => keep[i])) };
}

export function toCSV(grid) {
  return grid
    .map((r) => r.map((c) => (/[",\n\t]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(','))
    .join('\r\n');
}

// Guess a standard PDF font family + weight/style for a text block.
export function detectFont(page, block) {
  let name = '';
  let bold = false;
  let italic = false;
  try {
    const objs = page.proxy.commonObjs;
    if (objs.has(block.fontName)) {
      const f = objs.get(block.fontName);
      name = f?.name || '';
      bold = !!(f?.bold || f?.black);
      italic = !!f?.italic;
    }
  } catch {}
  const fallback = (block.style?.fontFamily || '').toLowerCase();
  const n = name.toLowerCase();
  if (/bold|black|heavy|semibold|demi/.test(n)) bold = true;
  if (/italic|oblique|-it$|,it/.test(n)) italic = true;
  let family = 'Helvetica';
  if (/courier|mono|consol|menlo|typewriter/.test(n) || fallback === 'monospace') family = 'Courier';
  else if (/times|serif|roman|georgia|garamond|cambria|minion|palatino|baskerville|bookman|century/.test(n.replace('sans', ''))) family = 'Times';
  else if (!n && fallback === 'serif') family = 'Times';
  if (/sans/.test(n)) family = 'Helvetica';
  return { family, bold, italic, sourceName: name.replace(/^[A-Z]{6}\+/, '') };
}

// Samples the rendered canvas to estimate the background and ink color of a region.
export function sampleColors(page, rect) {
  const result = { bg: '#ffffff', fg: '#000000' };
  const canvas = page.canvas;
  if (!canvas || !page.renderScale) return result;
  const s = page.renderScale;
  const x0 = Math.max(0, Math.floor((rect.x - 2) * s));
  const y0 = Math.max(0, Math.floor((rect.y - 2) * s));
  const x1 = Math.min(canvas.width, Math.ceil((rect.x + rect.w + 2) * s));
  const y1 = Math.min(canvas.height, Math.ceil((rect.y + rect.h + 2) * s));
  const w = x1 - x0;
  const hgt = y1 - y0;
  if (w <= 2 || hgt <= 2) return result;
  let data;
  try {
    // Copy into a scratch canvas so repeated sampling doesn't force the page canvas off the GPU.
    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = hgt;
    const tctx = tmp.getContext('2d', { willReadFrequently: true });
    tctx.drawImage(canvas, x0, y0, w, hgt, 0, 0, w, hgt);
    data = tctx.getImageData(0, 0, w, hgt).data;
  } catch {
    return result;
  }
  const buckets = new Map();
  const ring = Math.max(1, Math.round(1.5 * s));
  for (let y = 0; y < hgt; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= ring && x < w - ring && y >= ring && y < hgt - ring) continue;
      const i = (y * w + x) * 4;
      const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
      const b = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
      b.n++;
      b.r += data[i];
      b.g += data[i + 1];
      b.b += data[i + 2];
      buckets.set(key, b);
    }
  }
  let best = null;
  for (const b of buckets.values()) if (!best || b.n > best.n) best = b;
  if (!best) return result;
  const bg = [best.r / best.n, best.g / best.n, best.b / best.n];
  result.bg = rgbToHex(...bg);

  let maxD = 0;
  const dist = new Float32Array(w * hgt);
  for (let p = 0, i = 0; p < w * hgt; p++, i += 4) {
    const d = Math.hypot(data[i] - bg[0], data[i + 1] - bg[1], data[i + 2] - bg[2]);
    dist[p] = d;
    if (d > maxD) maxD = d;
  }
  if (maxD < 40) return result;
  let r = 0, g = 0, bb = 0, n = 0;
  for (let p = 0, i = 0; p < w * hgt; p++, i += 4) {
    if (dist[p] >= maxD * 0.75) {
      r += data[i];
      g += data[i + 1];
      bb += data[i + 2];
      n++;
    }
  }
  if (n) result.fg = rgbToHex(r / n, g / n, bb / n);
  return result;
}

// Distance from the top of a CSS line box to the text baseline, as a fraction of font size.
const baselineCache = new Map();
export function baselineRatio(family, bold, italic) {
  const key = `${family}|${bold}|${italic}`;
  if (baselineCache.has(key)) return baselineCache.get(key);
  const probe = document.createElement('div');
  Object.assign(probe.style, {
    position: 'absolute',
    left: '-9999px',
    top: '0',
    visibility: 'hidden',
    whiteSpace: 'pre',
    fontFamily: FONT_FAMILIES[family]?.css || FONT_FAMILIES.Helvetica.css,
    fontSize: '100px',
    lineHeight: String(LINE_HEIGHT),
    fontWeight: bold ? '700' : '400',
    fontStyle: italic ? 'italic' : 'normal',
  });
  probe.innerHTML = 'Hg<span style="display:inline-block;width:1px;height:0;vertical-align:baseline"></span>';
  document.body.append(probe);
  const ratio = probe.querySelector('span').offsetTop / 100;
  probe.remove();
  const value = ratio > 0.5 && ratio < 1.3 ? ratio : 0.95;
  baselineCache.set(key, value);
  return value;
}
