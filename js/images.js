// Image discovery (pdf.js operator lists), extraction, and true in-PDF replacement (pdf-lib).
import { pdfjsLib, PDFLib } from './lib.js';
import { state } from './state.js';
import { mul, apply, loadImage, canvasToBlob, readAsDataURL } from './util.js';

const OPS = pdfjsLib.OPS;

// ---------- pdf-lib document cache (read-only queries) ----------
let libCache = { bytes: null, promise: null };
export function getLibDoc() {
  const bytes = state.doc?.bytes;
  if (!bytes) return Promise.reject(new Error('No document'));
  if (libCache.bytes !== bytes) {
    libCache = {
      bytes,
      promise: PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false }),
    };
  }
  return libCache.promise;
}

// ---------- pdf.js side: where are the images and what do they look like ----------
export function getImageModel(page) {
  if (page.imageModel) return Promise.resolve(page.imageModel);
  if (!page.imageModelPromise) {
    page.imageModelPromise = scanPageImages(page)
      .catch((err) => {
        console.warn('image scan failed', err);
        return [];
      })
      .then((list) => {
        page.imageModel = list;
        page.imageModelPromise = null;
        return list;
      });
  }
  return page.imageModelPromise;
}

async function scanPageImages(page) {
  const { fnArray, argsArray } = await page.proxy.getOperatorList();
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const hits = [];
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    switch (fn) {
      case OPS.save:
        stack.push(ctm);
        break;
      case OPS.restore:
        ctm = stack.pop() || ctm;
        break;
      case OPS.transform:
        ctm = mul(ctm, args);
        break;
      case OPS.paintFormXObjectBegin:
        stack.push(ctm);
        if (args?.[0] && args[0].length === 6) ctm = mul(ctm, Array.from(args[0]));
        break;
      case OPS.paintFormXObjectEnd:
        ctm = stack.pop() || ctm;
        break;
      case OPS.paintImageXObject:
        hits.push({ objId: args[0], ctm });
        break;
      case OPS.paintInlineImageXObject:
        hits.push({ inline: args[0], ctm });
        break;
      case OPS.paintImageXObjectRepeat: {
        const [objId, sx, sy, positions] = args;
        for (let j = 0; j < positions.length; j += 2) {
          hits.push({ objId, ctm: mul(ctm, [sx, 0, 0, sy, positions[j], positions[j + 1]]) });
        }
        break;
      }
      default:
        break;
    }
  }

  const vt = page.vp1.transform;
  const out = [];
  let k = 0;
  for (const hit of hits) {
    const full = mul(vt, hit.ctm);
    const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => apply(full, x, y));
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const rect = { x: Math.min(...xs), y: Math.min(...ys) };
    rect.w = Math.max(...xs) - rect.x;
    rect.h = Math.max(...ys) - rect.y;
    if (rect.w < 2 || rect.h < 2) continue;
    if (rect.x > page.width || rect.y > page.height || rect.x + rect.w < 0 || rect.y + rect.h < 0) continue;
    const uPts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => apply(hit.ctm, x, y));
    const ux = uPts.map((p) => p[0]);
    const uy = uPts.map((p) => p[1]);
    const img = hit.inline || (await getPdfObj(page, hit.objId));
    out.push({
      id: `${page.index}-${k++}`,
      page: page.index,
      objId: hit.objId || null,
      inline: !!hit.inline,
      rect,
      userBox: [Math.min(...ux), Math.min(...uy), Math.max(...ux), Math.max(...uy)],
      dispW: Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]),
      dispH: Math.hypot(pts[2][0] - pts[0][0], pts[2][1] - pts[0][1]),
      pixelW: img?.width || 0,
      pixelH: img?.height || 0,
      img,
    });
  }
  return out;
}

function getPdfObj(page, objId) {
  return new Promise((resolve) => {
    const objs = objId.startsWith('g_') ? page.proxy.commonObjs : page.proxy.objs;
    const timer = setTimeout(() => resolve(null), 8000);
    try {
      objs.get(objId, (data) => {
        clearTimeout(timer);
        resolve(data);
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

export function imageObjToCanvas(img) {
  const canvas = document.createElement('canvas');
  if (!img) return canvas;
  const w = img.width;
  const hgt = img.height;
  canvas.width = w;
  canvas.height = hgt;
  const ctx = canvas.getContext('2d');
  if (typeof ImageData !== 'undefined' && img instanceof ImageData) {
    ctx.putImageData(img, 0, 0);
  } else if (img.bitmap) {
    ctx.drawImage(img.bitmap, 0, 0);
  } else if (!img.data) {
    try {
      ctx.drawImage(img, 0, 0);
    } catch {}
  } else {
    const out = ctx.createImageData(w, hgt);
    const d = out.data;
    const src = img.data;
    const n = w * hgt;
    if (img.kind === 3) {
      d.set(src.subarray(0, d.length));
    } else if (img.kind === 2) {
      for (let i = 0, j = 0, o = 0; i < n; i++, j += 3, o += 4) {
        d[o] = src[j];
        d[o + 1] = src[j + 1];
        d[o + 2] = src[j + 2];
        d[o + 3] = 255;
      }
    } else {
      const stride = (w + 7) >> 3;
      for (let y = 0; y < hgt; y++) {
        for (let x = 0; x < w; x++) {
          const v = src[y * stride + (x >> 3)] & (128 >> (x & 7)) ? 255 : 0;
          const o = (y * w + x) * 4;
          d[o] = d[o + 1] = d[o + 2] = v;
          d[o + 3] = 255;
        }
      }
    }
    ctx.putImageData(out, 0, 0);
  }
  return canvas;
}

export function thumbnailOf(entry, max = 180) {
  const full = imageObjToCanvas(entry.img);
  const k = Math.min(1, max / Math.max(full.width || 1, full.height || 1));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(full.width * k));
  c.height = Math.max(1, Math.round(full.height * k));
  c.getContext('2d').drawImage(full, 0, 0, c.width, c.height);
  return c;
}

// Returns the best-quality export: the original JPEG stream when possible, else a lossless PNG.
export async function exportImageEntry(entry) {
  try {
    const doc = await getLibDoc();
    const match = matchLibImage(entry, scanLibPageImages(doc, entry.page));
    if (match) {
      const { PDFName, PDFRawStream } = PDFLib;
      const dict = match.stream.dict;
      const filter = dict.lookup(PDFName.of('Filter'));
      const cs = dict.lookup(PDFName.of('ColorSpace'));
      const plainCS = cs === PDFName.of('DeviceRGB') || cs === PDFName.of('DeviceGray');
      if (
        match.stream instanceof PDFRawStream &&
        filter === PDFName.of('DCTDecode') &&
        plainCS &&
        !dict.has(PDFName.of('SMask')) &&
        !dict.has(PDFName.of('Decode'))
      ) {
        return { blob: new Blob([match.stream.contents], { type: 'image/jpeg' }), ext: 'jpg' };
      }
    }
  } catch (err) {
    console.warn('original image lookup failed', err);
  }
  const blob = await canvasToBlob(imageObjToCanvas(entry.img), 'image/png');
  return { blob, ext: 'png' };
}

// ---------- pdf-lib side: content-stream walk to map images to XObject resources ----------
const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);

function tokenizeContent(bytes, onOp) {
  const n = bytes.length;
  let i = 0;
  let operands = [];
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
    if (c === 40) {
      let depth = 1;
      i++;
      while (i < n && depth > 0) {
        const ch = bytes[i];
        if (ch === 92) {
          i += 2;
          continue;
        }
        if (ch === 40) depth++;
        else if (ch === 41) depth--;
        i++;
      }
      operands.push({ t: 'str' });
      continue;
    }
    if (c === 60) {
      if (bytes[i + 1] === 60) {
        operands.push({ t: '<<' });
        i += 2;
      } else {
        while (i < n && bytes[i] !== 62) i++;
        i++;
        operands.push({ t: 'hex' });
      }
      continue;
    }
    if (c === 62) {
      i += bytes[i + 1] === 62 ? 2 : 1;
      operands.push({ t: '>>' });
      continue;
    }
    if (c === 91 || c === 93 || c === 123 || c === 125 || c === 41) {
      i++;
      operands.push({ t: String.fromCharCode(c) });
      continue;
    }
    if (c === 47) {
      let j = i + 1;
      while (j < n && !WS.has(bytes[j]) && !DELIM.has(bytes[j])) j++;
      operands.push({ t: 'name', v: latin1(i + 1, j) });
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
      operands.push({ t: 'num', v: parseFloat(tok) });
      continue;
    }
    if (tok === 'true' || tok === 'false' || tok === 'null') {
      operands.push({ t: 'kw' });
      continue;
    }
    if (tok === 'BI') {
      let k = i;
      while (k < n - 1 && !(bytes[k] === 73 && bytes[k + 1] === 68 && WS.has(bytes[k - 1]) && (k + 2 >= n || WS.has(bytes[k + 2])))) k++;
      k += 3;
      while (
        k < n - 1 &&
        !(bytes[k] === 69 && bytes[k + 1] === 73 && WS.has(bytes[k - 1]) && (k + 2 >= n || WS.has(bytes[k + 2]) || DELIM.has(bytes[k + 2])))
      )
        k++;
      i = k + 2;
      operands = [];
      continue;
    }
    onOp(tok, operands);
    operands = [];
  }
}

function streamBytes(stream) {
  const { PDFRawStream, decodePDFRawStream } = PDFLib;
  try {
    if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
    if (typeof stream.getUnencodedContents === 'function') return stream.getUnencodedContents();
  } catch (err) {
    console.warn('could not decode content stream', err);
  }
  return new Uint8Array();
}

export function scanLibPageImages(doc, pageIndex) {
  const { PDFArray, PDFStream } = PDFLib;
  const node = doc.getPage(pageIndex).node;
  const contents = node.Contents();
  const parts = [];
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) {
      const s = contents.lookup(i);
      if (s instanceof PDFStream) parts.push(streamBytes(s));
    }
  } else if (contents instanceof PDFStream) {
    parts.push(streamBytes(contents));
  }
  const total = parts.reduce((a, p) => a + p.length + 1, 0);
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    bytes.set(p, off);
    off += p.length;
    bytes[off++] = 10;
  }
  const out = [];
  walkContent(doc, bytes, node.Resources(), [1, 0, 0, 1, 0, 0], out, 0, new Set());
  return out;
}

function walkContent(doc, bytes, resources, ctm0, out, depth, visiting) {
  const { PDFName, PDFDict, PDFRef, PDFStream, PDFArray, PDFNumber } = PDFLib;
  let ctm = ctm0;
  const stack = [];
  tokenizeContent(bytes, (op, args) => {
    if (op === 'q') stack.push(ctm);
    else if (op === 'Q') ctm = stack.pop() || ctm;
    else if (op === 'cm') {
      const nums = args.filter((a) => a.t === 'num').map((a) => a.v);
      if (nums.length >= 6) ctm = mul(ctm, nums.slice(-6));
    } else if (op === 'Do') {
      const nameTok = [...args].reverse().find((a) => a.t === 'name');
      if (!nameTok || !(resources instanceof PDFDict)) return;
      const xo = resources.lookup(PDFName.of('XObject'));
      if (!(xo instanceof PDFDict)) return;
      const raw = xo.get(PDFName.of(nameTok.v));
      const obj = raw instanceof PDFRef ? doc.context.lookup(raw) : raw;
      if (!(obj instanceof PDFStream)) return;
      const subtype = obj.dict.lookup(PDFName.of('Subtype'));
      if (subtype === PDFName.of('Image')) {
        const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => apply(ctm, x, y));
        const xs = pts.map((p) => p[0]);
        const ys = pts.map((p) => p[1]);
        out.push({
          name: nameTok.v,
          xoDict: xo,
          stream: obj,
          depth,
          userBox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
        });
      } else if (subtype === PDFName.of('Form') && depth < 10) {
        const key = raw instanceof PDFRef ? raw.toString() : null;
        if (key && visiting.has(key)) return;
        let m = [1, 0, 0, 1, 0, 0];
        const mArr = obj.dict.lookup(PDFName.of('Matrix'));
        if (mArr instanceof PDFArray && mArr.size() === 6) {
          m = Array.from({ length: 6 }, (_, i) => {
            const v = mArr.lookup(i);
            return v instanceof PDFNumber ? v.asNumber() : 0;
          });
        }
        const formRes = obj.dict.lookup(PDFName.of('Resources'));
        if (key) visiting.add(key);
        walkContent(doc, streamBytes(obj), formRes instanceof PDFDict ? formRes : resources, mul(ctm, m), out, depth + 1, visiting);
        if (key) visiting.delete(key);
      }
    }
  });
}

function matchLibImage(entry, libImages) {
  let best = null;
  let bestD = Infinity;
  for (const li of libImages) {
    const d = Math.max(...li.userBox.map((v, i) => Math.abs(v - entry.userBox[i])));
    if (d < bestD) {
      bestD = d;
      best = li;
    }
  }
  return bestD <= 2 ? best : null;
}

// ---------- replacement ----------
export async function prepareReplacement(file, aspect, fit) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    const isJpeg = /jpe?g/i.test(file.type);
    const isPng = /png/i.test(file.type);
    if (fit === 'stretch' && (isJpeg || isPng) && Math.max(iw, ih) <= 4000) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      return { bytes, mime: isJpeg ? 'image/jpeg' : 'image/png', width: iw, height: ih, dataUrl: await readAsDataURL(file) };
    }
    const imgAspect = iw / ih;
    let sx = 0, sy = 0, sw = iw, sh = ih, cw = iw, ch = ih, dx = 0, dy = 0, dw = iw, dh = ih;
    if (fit === 'contain') {
      if (imgAspect > aspect) ch = iw / aspect;
      else cw = ih * aspect;
      dx = (cw - iw) / 2;
      dy = (ch - ih) / 2;
    } else if (fit === 'cover') {
      if (imgAspect > aspect) {
        sw = ih * aspect;
        sx = (iw - sw) / 2;
      } else {
        sh = iw / aspect;
        sy = (ih - sh) / 2;
      }
      cw = dw = sw;
      ch = dh = sh;
    }
    const k = Math.min(1, 3000 / Math.max(cw, ch));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(cw * k));
    canvas.height = Math.max(1, Math.round(ch * k));
    canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, dx * k, dy * k, dw * k, dh * k);
    const useJpeg = isJpeg && fit !== 'contain';
    const mime = useJpeg ? 'image/jpeg' : 'image/png';
    const blob = await canvasToBlob(canvas, mime, 0.92);
    return {
      bytes: new Uint8Array(await blob.arrayBuffer()),
      mime,
      width: canvas.width,
      height: canvas.height,
      dataUrl: await readAsDataURL(blob),
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Swaps the image XObject referenced by the page content. Returns new PDF bytes, or
// { overlay } when the image cannot be swapped in place (e.g. inline images).
export async function replaceImageInPdf(entry, prepared) {
  const { PDFDocument, PDFName, PDFDict } = PDFLib;
  const doc = await PDFDocument.load(state.doc.bytes, { ignoreEncryption: true, updateMetadata: false });
  const match = entry.inline ? null : matchLibImage(entry, scanLibPageImages(doc, entry.page));
  if (!match) return { overlay: true };
  const embedded = prepared.mime === 'image/jpeg' ? await doc.embedJpg(prepared.bytes) : await doc.embedPng(prepared.bytes);
  let target = match.xoDict;
  if (match.depth === 0) {
    // Give this page private Resources/XObject dicts so other pages sharing them stay untouched.
    const node = doc.getPage(entry.page).node;
    const res = node.Resources();
    const xo = res?.lookup(PDFName.of('XObject'));
    if (res instanceof PDFDict && xo instanceof PDFDict && xo === match.xoDict) {
      const resClone = res.clone(doc.context);
      const xoClone = xo.clone(doc.context);
      resClone.set(PDFName.of('XObject'), xoClone);
      node.set(PDFName.of('Resources'), resClone);
      target = xoClone;
    }
  }
  target.set(PDFName.of(match.name), embedded.ref);
  return { bytes: await doc.save() };
}
