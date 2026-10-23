// Third-party libraries, vendored locally so the app works offline.
import * as pdfjsLib from '../vendor/pdfjs/pdf.min.js';
import * as PDFLib from '../vendor/pdf-lib/pdf-lib.esm.min.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.js', import.meta.url).href;

export const PDFJS_OPTIONS = {
  cMapUrl: new URL('../vendor/pdfjs/cmaps/', import.meta.url).href,
  cMapPacked: true,
  standardFontDataUrl: new URL('../vendor/pdfjs/standard_fonts/', import.meta.url).href,
  isEvalSupported: false,
  enableXfa: false,
};

export { pdfjsLib, PDFLib };
