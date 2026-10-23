// Bakes overlay objects and metadata into a new PDF with pdf-lib.
import { PDFLib } from './lib.js';
import { state, LINE_HEIGHT } from './state.js';
import { shapeParts, isVector } from './shapes.js';
import { mul, invert, apply, hexToRgb, dataUrlToBytes } from './util.js';
import { baselineRatio } from './textmodel.js';
import { removeTextUnder } from './textremove.js';

const STD_FONTS = {
  Helvetica: ['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'],
  Times: ['TimesRoman', 'TimesRomanBold', 'TimesRomanItalic', 'TimesRomanBoldItalic'],
  Courier: ['Courier', 'CourierBold', 'CourierOblique', 'CourierBoldOblique'],
};

const encodable = new WeakMap();
// Standard PDF fonts only cover WinAnsi; swap anything else for a close ASCII fallback.
export function safeText(font, text) {
  let cache = encodable.get(font);
  if (!cache) encodable.set(font, (cache = new Map()));
  const ok = (ch) => {
    if (!cache.has(ch)) {
      try {
        font.encodeText(ch);
        cache.set(ch, true);
      } catch {
        cache.set(ch, false);
      }
    }
    return cache.get(ch);
  };
  let out = '';
  for (const ch of text.replace(/\t/g, '    ')) {
    if (ok(ch)) out += ch;
    else {
      const base = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      out += base && base !== ch && [...base].every(ok) ? base : '?';
    }
  }
  return out;
}

export async function buildPdf() {
  const {
    PDFDocument,
    StandardFonts,
    rgb,
    pushGraphicsState,
    popGraphicsState,
    concatTransformationMatrix,
    setLineJoin,
    LineJoinStyle,
    LineCapStyle,
  } = PDFLib;
  const doc = await PDFDocument.load(state.doc.bytes, { ignoreEncryption: true, updateMetadata: false });
  const color = (hex) => {
    const c = hexToRgb(hex);
    return rgb(c.r, c.g, c.b);
  };

  const fonts = new Map();
  const getFont = async (family, bold, italic) => {
    const key = (STD_FONTS[family] || STD_FONTS.Helvetica)[(bold ? 1 : 0) + (italic ? 2 : 0)];
    if (!fonts.has(key)) fonts.set(key, await doc.embedFont(StandardFonts[key]));
    return fonts.get(key);
  };
  const images = new Map();
  const getImage = async (assetId) => {
    if (!images.has(assetId)) {
      const asset = state.assets.get(assetId);
      if (!asset) return null;
      const bytes = dataUrlToBytes(asset.dataUrl);
      images.set(assetId, asset.mime === 'image/jpeg' ? await doc.embedJpg(bytes) : await doc.embedPng(bytes));
    }
    return images.get(assetId);
  };

  for (const p of state.doc.pages) {
    const objs = state.objects.filter((o) => o.page === p.index);
    if (!objs.length) continue;
    const page = doc.getPage(p.index);
    const H = p.height;
    // Drop the original glyphs under edited text and whiteout boxes so no stale text survives.
    if (!state.doc.encrypted) {
      const toUser = invert(p.vp1.transform);
      const rects = objs
        .filter((o) => (o.type === 'text' && o.source && o.cover) || (o.type === 'rect' && o.whiteout))
        .map((o) => {
          const r = o.type === 'text' ? o.cover : o;
          const pts = [
            [r.x, r.y],
            [r.x + r.w, r.y],
            [r.x, r.y + r.h],
            [r.x + r.w, r.y + r.h],
          ].map(([x, y]) => apply(toUser, x, y));
          const xs = pts.map((q) => q[0]);
          const ys = pts.map((q) => q[1]);
          return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
        });
      if (rects.length) {
        try {
          await removeTextUnder(doc, p.index, rects);
        } catch (err) {
          console.warn(`Couldn't strip original text on page ${p.index + 1}`, err);
        }
      }
    }
    // Map our top-left page space (as displayed, incl. rotation/crop) back into PDF user space.
    const M = invert(mul([1, 0, 0, -1, 0, H], p.vp1.transform));
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...M));
    const fillRect = (x, y, w, hh, fill) =>
      page.drawRectangle({ x, y: H - y - hh, width: w, height: hh, color: color(fill), borderWidth: 0 });

    for (const o of objs) {
      if (o.cover) fillRect(o.cover.x, o.cover.y, o.cover.w, o.cover.h, o.cover.color);
      if (isVector(o)) {
        const opacity = o.opacity ?? 1;
        for (const part of shapeParts(o)) {
          const opts = { x: 0, y: H };
          if (opacity < 1) {
            opts.opacity = opacity;
            opts.borderOpacity = opacity;
          }
          if (part.fill) opts.color = color(part.fill);
          if (part.stroke && part.width > 0) {
            opts.borderColor = color(part.stroke);
            opts.borderWidth = part.width;
            opts.borderLineCap = part.cap === 'butt' ? LineCapStyle.Butt : LineCapStyle.Round;
          }
          if (!opts.color && !opts.borderColor) continue;
          page.pushOperators(setLineJoin(part.join === 'miter' ? LineJoinStyle.Miter : LineJoinStyle.Round));
          page.drawSvgPath(part.d, opts);
        }
      } else if (o.type === 'text') {
        const font = await getFont(o.fontFamily, o.bold, o.italic);
        const lines = String(o.text || '').split('\n').map((l) => safeText(font, l));
        const lh = o.fontSize * LINE_HEIGHT;
        if (o.bg && lines.some((l) => l.length)) {
          const w = Math.max(...lines.map((l) => font.widthOfTextAtSize(l, o.fontSize)));
          fillRect(o.x, o.y, w, lines.length * lh, o.bg);
        }
        const ratio = baselineRatio(o.fontFamily, o.bold, o.italic);
        lines.forEach((line, i) => {
          if (!line) return;
          page.drawText(line, {
            x: o.x,
            y: H - (o.y + i * lh + ratio * o.fontSize),
            size: o.fontSize,
            font,
            color: color(o.color),
          });
        });
      } else if (o.type === 'image') {
        const img = await getImage(o.assetId);
        if (img) page.drawImage(img, { x: o.x, y: H - o.y - o.h, width: o.w, height: o.h, opacity: o.opacity ?? 1 });
      }
    }
    page.pushOperators(popGraphicsState());
  }

  const m = state.meta;
  if ('title' in m) doc.setTitle(m.title);
  if ('author' in m) doc.setAuthor(m.author);
  if ('subject' in m) doc.setSubject(m.subject);
  if ('keywords' in m) doc.setKeywords(m.keywords.split(/[,;]/).map((k) => k.trim()).filter(Boolean));
  if ('creator' in m) doc.setCreator(m.creator);
  if ('producer' in m) doc.setProducer(m.producer);
  doc.setModificationDate(new Date());
  return doc.save();
}

export function exportName() {
  const base = (state.doc?.name || 'document.pdf').replace(/\.pdf$/i, '');
  return `${base}-edited.pdf`;
}
