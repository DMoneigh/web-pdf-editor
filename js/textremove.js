// Removes the original glyphs underneath edited text blocks and whiteout areas when exporting,
// so the saved PDF doesn't keep stale (hidden but still selectable/searchable) text.
import { PDFLib } from './lib.js';
import { mul, apply } from './util.js';

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);
const ID = [1, 0, 0, 1, 0, 0];

function readLiteral(bytes, i) {
  const out = [];
  let depth = 1;
  i++;
  const n = bytes.length;
  while (i < n) {
    const c = bytes[i];
    if (c === 92) {
      const d = bytes[i + 1];
      i += 2;
      if (d === 110) out.push(10);
      else if (d === 114) out.push(13);
      else if (d === 116) out.push(9);
      else if (d === 98) out.push(8);
      else if (d === 102) out.push(12);
      else if (d === 13) {
        if (bytes[i] === 10) i++;
      } else if (d === 10) {
        // line continuation
      } else if (d >= 48 && d <= 55) {
        let v = d - 48;
        for (let k = 0; k < 2 && bytes[i] >= 48 && bytes[i] <= 55; k++, i++) v = v * 8 + bytes[i] - 48;
        out.push(v & 255);
      } else if (d !== undefined) out.push(d);
      continue;
    }
    if (c === 40) depth++;
    else if (c === 41 && --depth === 0) {
      i++;
      break;
    }
    out.push(c);
    i++;
  }
  return { value: Uint8Array.from(out), end: i };
}

function readHex(bytes, i) {
  i++;
  const digits = [];
  while (i < bytes.length && bytes[i] !== 62) {
    const c = bytes[i++];
    const v = c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;
    if (v >= 0) digits.push(v);
  }
  if (digits.length % 2) digits.push(0);
  const out = new Uint8Array(digits.length / 2);
  for (let k = 0; k < out.length; k++) out[k] = digits[2 * k] * 16 + digits[2 * k + 1];
  return { value: out, end: i + 1 };
}

// Content-stream tokenizer that reports each operator with its operands and byte span.
function tokenize(bytes, onOp) {
  const n = bytes.length;
  let i = 0;
  let stack = [[]];
  let opStart = -1;
  const top = () => stack[stack.length - 1];
  const latin1 = (a, b) => {
    let s = '';
    for (let k = a; k < b; k++) s += String.fromCharCode(bytes[k]);
    return s;
  };
  while (i < n) {
    const c = bytes[i];
    if (WS.has(c)) {
      i++;
      continue;
    }
    if (c === 37) {
      while (i < n && bytes[i] !== 10 && bytes[i] !== 13) i++;
      continue;
    }
    const start = i;
    if (stack.length === 1 && opStart < 0) opStart = start;
    if (c === 40) {
      const r = readLiteral(bytes, i);
      top().push({ t: 'str', v: r.value });
      i = r.end;
      continue;
    }
    if (c === 60) {
      if (bytes[i + 1] === 60) {
        stack.push([]);
        i += 2;
      } else {
        const r = readHex(bytes, i);
        top().push({ t: 'str', v: r.value });
        i = r.end;
      }
      continue;
    }
    if (c === 62 || c === 93) {
      i += c === 62 && bytes[i + 1] === 62 ? 2 : 1;
      if (stack.length > 1) {
        const v = stack.pop();
        top().push({ t: c === 93 ? 'arr' : 'dict', v });
      }
      continue;
    }
    if (c === 91) {
      stack.push([]);
      i++;
      continue;
    }
    if (c === 123 || c === 125 || c === 41) {
      i++;
      continue;
    }
    if (c === 47) {
      let j = i + 1;
      while (j < n && !WS.has(bytes[j]) && !DELIM.has(bytes[j])) j++;
      top().push({ t: 'name', v: latin1(i + 1, j) });
      i = j;
      continue;
    }
    let j = i;
    while (j < n && !WS.has(bytes[j]) && !DELIM.has(bytes[j])) j++;
    if (j === i) {
      i++;
      continue;
    }
    const tok = latin1(i, j);
    i = j;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) {
      top().push({ t: 'num', v: parseFloat(tok) });
      continue;
    }
    if (tok === 'true' || tok === 'false' || tok === 'null') {
      top().push({ t: 'kw' });
      continue;
    }
    if (tok === 'BI') {
      let k = i;
      while (k < n - 1 && !(bytes[k] === 73 && bytes[k + 1] === 68 && WS.has(bytes[k - 1]) && (k + 2 >= n || WS.has(bytes[k + 2])))) k++;
      k += 3;
      while (k < n - 1 && !(bytes[k] === 69 && bytes[k + 1] === 73 && WS.has(bytes[k - 1]) && (k + 2 >= n || WS.has(bytes[k + 2]) || DELIM.has(bytes[k + 2])))) k++;
      i = k + 2;
      stack = [[]];
      opStart = -1;
      continue;
    }
    const operands = stack[0];
    onOp(tok, operands, opStart < 0 ? start : opStart, j);
    stack = [[]];
    opStart = -1;
  }
}

function pageContentBytes(node) {
  const { PDFArray, PDFStream, PDFRawStream, decodePDFRawStream } = PDFLib;
  const decode = (s) => (s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getUnencodedContents());
  const contents = node.Contents();
  const parts = [];
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) {
      const s = contents.lookup(i);
      if (s instanceof PDFStream) parts.push(decode(s));
    }
  } else if (contents instanceof PDFStream) parts.push(decode(contents));
  const total = parts.reduce((a, p) => a + p.length + 1, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
    out[off++] = 10;
  }
  return out;
}

let metricsDoc = null;
async function standardWidths(baseFont) {
  const { PDFDocument, StandardFonts } = PDFLib;
  const name = baseFont.replace(/^[A-Z]{6}\+/, '').replace(/[-,]?(PS|MT)\b/g, '');
  const bold = /bold|black|heavy|semibold/i.test(name);
  const italic = /italic|oblique/i.test(name);
  let fam;
  if (/courier|mono/i.test(name)) fam = 'Courier';
  else if (/times|serif|roman|georgia|garamond|book/i.test(name)) fam = 'Times';
  else if (/symbol|dingbat/i.test(name)) return null;
  else fam = 'Helvetica';
  const key =
    fam === 'Times'
      ? ['TimesRoman', 'TimesRomanBold', 'TimesRomanItalic', 'TimesRomanBoldItalic'][(bold ? 1 : 0) + (italic ? 2 : 0)]
      : `${fam}${['', 'Bold', 'Oblique', 'BoldOblique'][(bold ? 1 : 0) + (italic ? 2 : 0)]}`;
  metricsDoc ||= await PDFDocument.create();
  const font = await metricsDoc.embedFont(StandardFonts[key]);
  const dec = new TextDecoder('windows-1252');
  const cache = new Map();
  return (code) => {
    if (!cache.has(code)) {
      let w = fam === 'Courier' ? 600 : 500;
      try {
        w = font.widthOfTextAtSize(dec.decode(Uint8Array.of(code)), 1000);
      } catch {}
      cache.set(code, w);
    }
    return cache.get(code);
  };
}

async function fontInfo(doc, fd) {
  const { PDFName, PDFDict, PDFArray, PDFNumber } = PDFLib;
  if (!(fd instanceof PDFDict)) return null;
  const num = (v) => (v instanceof PDFNumber ? v.asNumber() : 0);
  const subtype = fd.lookup(PDFName.of('Subtype'));
  if (subtype === PDFName.of('Type0')) {
    const enc = fd.lookup(PDFName.of('Encoding'));
    if (enc !== PDFName.of('Identity-H')) return null;
    const descs = fd.lookup(PDFName.of('DescendantFonts'));
    const desc = descs instanceof PDFArray ? descs.lookup(0) : null;
    if (!(desc instanceof PDFDict)) return null;
    const dw = desc.has(PDFName.of('DW')) ? num(desc.lookup(PDFName.of('DW'))) : 1000;
    const widths = new Map();
    const W = desc.lookup(PDFName.of('W'));
    if (W instanceof PDFArray) {
      for (let i = 0; i < W.size(); ) {
        const first = num(W.lookup(i));
        const next = W.lookup(i + 1);
        if (next instanceof PDFArray) {
          for (let k = 0; k < next.size(); k++) widths.set(first + k, num(next.lookup(k)));
          i += 2;
        } else {
          const last = num(next);
          const w = num(W.lookup(i + 2));
          for (let c = first; c <= last && c - first < 65536; c++) widths.set(c, w);
          i += 3;
        }
      }
    }
    return {
      split: (bytes) => {
        const out = [];
        for (let k = 0; k + 1 < bytes.length; k += 2) out.push({ code: (bytes[k] << 8) | bytes[k + 1], bytes: [bytes[k], bytes[k + 1]] });
        return out;
      },
      width: (code) => widths.get(code) ?? dw,
      single: false,
    };
  }
  if (subtype !== PDFName.of('Type1') && subtype !== PDFName.of('TrueType') && subtype !== PDFName.of('MMType1')) return null;
  const split = (bytes) => Array.from(bytes, (b) => ({ code: b, bytes: [b] }));
  const W = fd.lookup(PDFName.of('Widths'));
  if (W instanceof PDFArray) {
    const first = num(fd.lookup(PDFName.of('FirstChar')));
    const desc = fd.lookup(PDFName.of('FontDescriptor'));
    const missing = desc instanceof PDFDict ? num(desc.lookup(PDFName.of('MissingWidth'))) : 0;
    const arr = Array.from({ length: W.size() }, (_, i) => num(W.lookup(i)));
    return { split, width: (code) => arr[code - first] ?? missing, single: true };
  }
  const base = fd.lookup(PDFName.of('BaseFont'));
  const width = base ? await standardWidths(base.decodeText()) : null;
  return width ? { split, width, single: true } : null;
}

const fmt = (n) => {
  const s = n.toFixed(3).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
};
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Removes glyphs whose centers fall inside any of `rects` (PDF user space, {x0,y0,x1,y1}) from the
 * page's own content stream. Removed glyphs are replaced by equivalent TJ spacing so remaining
 * text keeps its position. Returns the number of glyphs removed.
 */
export async function removeTextUnder(doc, pageIndex, rects) {
  const { PDFName, PDFDict, PDFRef } = PDFLib;
  if (!rects.length) return 0;
  const node = doc.getPage(pageIndex).node;
  const bytes = pageContentBytes(node);
  const resources = node.Resources();
  const fonts = new Map();
  const fontDict = resources instanceof PDFDict ? resources.lookup(PDFName.of('Font')) : null;
  if (fontDict instanceof PDFDict) {
    for (const [key, val] of fontDict.entries()) {
      try {
        fonts.set(key, await fontInfo(doc, val instanceof PDFRef ? doc.context.lookup(val) : val));
      } catch (err) {
        console.warn('font metrics unavailable', key.toString(), err);
      }
    }
  }

  const inside = (x, y) => rects.some((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1);
  const edits = [];
  let removed = 0;
  let gs = { ctm: ID, font: null, fs: 0, tc: 0, tw: 0, th: 1, tl: 0, rise: 0 };
  const saved = [];
  let tm = ID;
  let tlm = ID;
  const nextLine = (tx, ty) => {
    tlm = mul(tlm, [1, 0, 0, 1, tx, ty]);
    tm = tlm;
  };

  const show = (elements, start, end, prefix) => {
    const f = gs.font;
    if (!f || !gs.fs || !gs.th) return;
    const trm = mul(gs.ctm, tm);
    let x = 0;
    let changed = false;
    const out = [];
    let cur = [];
    const flush = () => {
      if (cur.length) out.push({ s: cur });
      cur = [];
    };
    const pushNum = (n) => {
      flush();
      const last = out[out.length - 1];
      if (last && !('s' in last)) last.n += n;
      else out.push({ n });
    };
    for (const el of elements) {
      if (el.t === 'num') {
        pushNum(el.v);
        x -= (el.v / 1000) * gs.fs * gs.th;
        continue;
      }
      if (el.t !== 'str') continue;
      for (const g of f.split(el.v)) {
        const w0 = f.width(g.code) / 1000;
        const adv = (w0 * gs.fs + gs.tc + (f.single && g.code === 32 ? gs.tw : 0)) * gs.th;
        const [ux, uy] = apply(trm, x + (w0 * gs.fs * gs.th) / 2, gs.rise + gs.fs * 0.3);
        if (inside(ux, uy)) {
          pushNum((-adv * 1000) / (gs.fs * gs.th));
          changed = true;
          removed++;
        } else cur.push(...g.bytes);
        x += adv;
      }
    }
    flush();
    tm = mul(tm, [1, 0, 0, 1, x, 0]);
    if (changed) {
      const body = out.map((e) => ('s' in e ? `<${hex(e.s)}>` : fmt(e.n))).join(' ');
      edits.push({ start, end, text: `${prefix}[${body}] TJ` });
    }
  };

  tokenize(bytes, (op, args, start, end) => {
    const nums = args.filter((a) => a.t === 'num').map((a) => a.v);
    const lastNum = nums[nums.length - 1];
    switch (op) {
      case 'q':
        saved.push({ ...gs });
        break;
      case 'Q':
        gs = saved.pop() || gs;
        break;
      case 'cm':
        if (nums.length >= 6) gs.ctm = mul(gs.ctm, nums.slice(-6));
        break;
      case 'BT':
        tm = tlm = ID;
        break;
      case 'Tf': {
        const nm = args.find((a) => a.t === 'name');
        gs.font = nm ? fonts.get(PDFName.of(nm.v)) || null : null;
        if (lastNum !== undefined) gs.fs = lastNum;
        break;
      }
      case 'Tc':
        if (lastNum !== undefined) gs.tc = lastNum;
        break;
      case 'Tw':
        if (lastNum !== undefined) gs.tw = lastNum;
        break;
      case 'Tz':
        if (lastNum !== undefined) gs.th = lastNum / 100;
        break;
      case 'TL':
        if (lastNum !== undefined) gs.tl = lastNum;
        break;
      case 'Ts':
        if (lastNum !== undefined) gs.rise = lastNum;
        break;
      case 'Td':
        if (nums.length >= 2) nextLine(nums[nums.length - 2], lastNum);
        break;
      case 'TD':
        if (nums.length >= 2) {
          gs.tl = -lastNum;
          nextLine(nums[nums.length - 2], lastNum);
        }
        break;
      case 'Tm':
        if (nums.length >= 6) tm = tlm = nums.slice(-6);
        break;
      case 'T*':
        nextLine(0, -gs.tl);
        break;
      case 'Tj': {
        const s = args.find((a) => a.t === 'str');
        if (s) show([s], start, end, '');
        break;
      }
      case "'": {
        nextLine(0, -gs.tl);
        const s = args.find((a) => a.t === 'str');
        if (s) show([s], start, end, 'T* ');
        break;
      }
      case '"': {
        if (nums.length >= 2) {
          gs.tw = nums[0];
          gs.tc = nums[1];
        }
        nextLine(0, -gs.tl);
        const s = args.find((a) => a.t === 'str');
        if (s) show([s], start, end, `${fmt(gs.tw)} Tw ${fmt(gs.tc)} Tc T* `);
        break;
      }
      case 'TJ': {
        const arr = args.find((a) => a.t === 'arr');
        if (arr) show(arr.v, start, end, '');
        break;
      }
    }
  });

  if (!edits.length) return 0;
  const enc = new TextEncoder();
  const chunks = [];
  let pos = 0;
  for (const e of edits) {
    chunks.push(bytes.subarray(pos, e.start), enc.encode(e.text));
    pos = e.end;
  }
  chunks.push(bytes.subarray(pos));
  const size = chunks.reduce((a, c) => a + c.length, 0);
  const merged = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.length;
  }
  const stream = doc.context.flateStream(merged);
  node.set(PDFName.of('Contents'), doc.context.register(stream));
  return removed;
}
