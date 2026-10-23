// Generates a realistic demo PDF in the browser (text, table, images, link, form, bookmarks).
import { PDFLib } from './lib.js';
import { canvasToBlob } from './util.js';

async function canvasBytes(canvas, type, quality) {
  const blob = await canvasToBlob(canvas, type, quality);
  return new Uint8Array(await blob.arrayBuffer());
}

function chartCanvas() {
  const c = document.createElement('canvas');
  c.width = 640;
  c.height = 380;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#0f172a';
  g.font = 'bold 26px Arial, sans-serif';
  g.fillText('Revenue by quarter ($k)', 28, 44);
  g.strokeStyle = '#e2e8f0';
  g.lineWidth = 2;
  for (let i = 0; i <= 4; i++) {
    const y = 330 - i * 60;
    g.beginPath();
    g.moveTo(60, y);
    g.lineTo(612, y);
    g.stroke();
    g.fillStyle = '#64748b';
    g.font = '16px Arial, sans-serif';
    g.fillText(String(i * 100), 18, y + 5);
  }
  const data = [182, 214, 301];
  const colors = ['#6366f1', '#8b5cf6', '#ec4899'];
  data.forEach((v, i) => {
    const x = 120 + i * 170;
    const hgt = (v / 400) * 240;
    g.fillStyle = colors[i];
    g.fillRect(x, 330 - hgt, 80, hgt);
    g.fillStyle = '#0f172a';
    g.font = 'bold 18px Arial, sans-serif';
    g.fillText(String(v), x + 20, 320 - hgt);
    g.fillStyle = '#475569';
    g.font = '18px Arial, sans-serif';
    g.fillText(`Q${i + 1}`, x + 26, 358);
  });
  return c;
}

function photoCanvas() {
  const c = document.createElement('canvas');
  c.width = 900;
  c.height = 520;
  const g = c.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, 520);
  sky.addColorStop(0, '#0ea5e9');
  sky.addColorStop(0.55, '#fde68a');
  sky.addColorStop(1, '#fb923c');
  g.fillStyle = sky;
  g.fillRect(0, 0, 900, 520);
  g.fillStyle = '#fff7ed';
  g.beginPath();
  g.arc(640, 250, 70, 0, Math.PI * 2);
  g.fill();
  const ridge = (color, base, amp, seed) => {
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(0, 520);
    for (let x = 0; x <= 900; x += 10) g.lineTo(x, base - Math.abs(Math.sin(x / 90 + seed) * amp) - Math.sin(x / 23 + seed) * 8);
    g.lineTo(900, 520);
    g.fill();
  };
  ridge('#7c3aed', 360, 120, 1);
  ridge('#4c1d95', 420, 90, 3);
  ridge('#1e1b4b', 480, 50, 5);
  return c;
}

export async function createSamplePdf() {
  const { PDFDocument, StandardFonts, rgb, PDFName, PDFString, PDFHexString } = PDFLib;
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvB = await doc.embedFont(StandardFonts.HelveticaBold);
  const times = await doc.embedFont(StandardFonts.TimesRoman);
  const timesI = await doc.embedFont(StandardFonts.TimesRomanItalic);
  const ink = rgb(0.06, 0.09, 0.16);
  const muted = rgb(0.39, 0.45, 0.55);
  const accent = rgb(0.31, 0.27, 0.9);

  // ---- Page 1 ----
  const p1 = doc.addPage([612, 792]);
  p1.drawRectangle({ x: 0, y: 742, width: 612, height: 50, color: rgb(0.12, 0.11, 0.29) });
  p1.drawText('NORTHWIND OUTDOOR CO.', { x: 48, y: 762, size: 12, font: helvB, color: rgb(1, 1, 1) });
  p1.drawText('Confidential', { x: 490, y: 762, size: 10, font: helv, color: rgb(0.8, 0.82, 1) });
  p1.drawText('Quarterly Business Review', { x: 48, y: 690, size: 28, font: helvB, color: ink });
  p1.drawText('Q3 2026 - Prepared for the leadership team by Avery Chen', { x: 48, y: 666, size: 12, font: helv, color: muted });

  const para = [
    'Northwind closed the third quarter with record revenue of $301k, up 41% over Q2.',
    'Growth was led by the West region, where the new trail-running line sold out twice.',
    'Gross margin held steady at 41% despite higher freight costs in August.',
    'We recommend expanding the retail partner program before the holiday season.',
  ];
  para.forEach((line, i) => p1.drawText(line, { x: 48, y: 630 - i * 16, size: 12, font: times, color: ink }));

  const chart = await doc.embedPng(await canvasBytes(chartCanvas(), 'image/png'));
  p1.drawImage(chart, { x: 48, y: 330, width: 320, height: 190 });
  p1.drawText('Figure 1. Revenue by quarter', { x: 48, y: 314, size: 10, font: timesI, color: muted });

  p1.drawText('Highlights', { x: 392, y: 504, size: 14, font: helvB, color: accent });
  ['Record quarter: $301k', 'New customers: 1,284', 'Repeat rate: 38%', 'NPS: 64 (+6)'].forEach((t, i) =>
    p1.drawText(`- ${t}`, { x: 392, y: 480 - i * 20, size: 11, font: helv, color: ink }),
  );

  p1.drawText('Regional performance', { x: 48, y: 270, size: 14, font: helvB, color: ink });
  const cols = [48, 200, 290, 380, 470];
  const rows = [
    ['Region', 'Q1', 'Q2', 'Q3', 'Growth'],
    ['West', '$62k', '$74k', '$96k', '+30%'],
    ['Central', '$48k', '$55k', '$63k', '+15%'],
    ['East', '$51k', '$58k', '$61k', '+5%'],
    ['South', '$21k', '$27k', '$81k', '+200%'],
  ];
  rows.forEach((r, ri) => {
    const y = 246 - ri * 20;
    if (ri === 0) p1.drawRectangle({ x: 44, y: y - 6, width: 520, height: 20, color: rgb(0.93, 0.94, 0.98) });
    r.forEach((cell, ci) => p1.drawText(cell, { x: cols[ci], y, size: 11, font: ri === 0 ? helvB : helv, color: ink }));
  });
  p1.drawLine({ start: { x: 44, y: 140 }, end: { x: 564, y: 140 }, thickness: 0.8, color: rgb(0.8, 0.82, 0.88) });

  const linkText = 'Read the full report at northwind.example/q3';
  p1.drawText(linkText, { x: 48, y: 112, size: 11, font: helv, color: accent });
  const linkW = helv.widthOfTextAtSize(linkText, 11);
  const link = doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [48, 108, 48 + linkW, 124],
      Border: [0, 0, 0],
      A: { Type: 'Action', S: 'URI', URI: PDFString.of('https://northwind.example/q3') },
    }),
  );
  p1.node.addAnnot(link);
  p1.drawText('Page 1', { x: 540, y: 40, size: 9, font: helv, color: muted });

  // ---- Page 2 ----
  const p2 = doc.addPage([612, 792]);
  p2.drawText('Field Team Spotlight', { x: 48, y: 720, size: 24, font: helvB, color: ink });
  p2.drawText('Our Sierra crew tested the new Summit jacket at 11,000 feet.', { x: 48, y: 694, size: 12, font: times, color: ink });
  const photo = await doc.embedJpg(await canvasBytes(photoCanvas(), 'image/jpeg', 0.9));
  p2.drawImage(photo, { x: 48, y: 380, width: 516, height: 298 });
  p2.drawText('Photo: Sunrise over the Sierra Nevada, September 2026.', { x: 48, y: 362, size: 10, font: timesI, color: muted });

  p2.drawText('Review sign-off', { x: 48, y: 310, size: 14, font: helvB, color: ink });
  p2.drawText('Reviewer name', { x: 48, y: 282, size: 10, font: helv, color: muted });
  p2.drawText('Region', { x: 300, y: 282, size: 10, font: helv, color: muted });
  p2.drawText('Approved', { x: 76, y: 222, size: 11, font: helv, color: ink });
  const form = doc.getForm();
  const name = form.createTextField('reviewer.name');
  name.setText('Jordan Lee');
  name.addToPage(p2, { x: 48, y: 248, width: 220, height: 26, font: helv });
  const region = form.createDropdown('reviewer.region');
  region.addOptions(['West', 'Central', 'East', 'South']);
  region.select('West');
  region.addToPage(p2, { x: 300, y: 248, width: 150, height: 26, font: helv });
  const approved = form.createCheckBox('reviewer.approved');
  approved.addToPage(p2, { x: 48, y: 218, width: 18, height: 18 });
  approved.check();
  form.updateFieldAppearances(helv);
  p2.drawText('Page 2', { x: 540, y: 40, size: 9, font: helv, color: muted });

  // ---- Bookmarks ----
  const ctx = doc.context;
  const outlines = ctx.nextRef();
  const b1 = ctx.nextRef();
  const b2 = ctx.nextRef();
  ctx.assign(b1, ctx.obj({ Title: PDFHexString.fromText('Quarterly overview'), Parent: outlines, Next: b2, Dest: [p1.ref, 'XYZ', null, null, null] }));
  ctx.assign(b2, ctx.obj({ Title: PDFHexString.fromText('Field team spotlight'), Parent: outlines, Prev: b1, Dest: [p2.ref, 'XYZ', null, null, null] }));
  ctx.assign(outlines, ctx.obj({ Type: 'Outlines', First: b1, Last: b2, Count: 2 }));
  doc.catalog.set(PDFName.of('Outlines'), outlines);

  doc.setTitle('Quarterly Business Review - Q3 2026');
  doc.setAuthor('Avery Chen');
  doc.setSubject('Sample document for trying out the editor');
  doc.setKeywords(['quarterly', 'report', 'sample']);
  doc.setCreator('PDF Studio sample generator');
  doc.setProducer('pdf-lib');
  return doc.save();
}
