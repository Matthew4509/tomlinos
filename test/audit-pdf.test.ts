// Audit of the PDF viewer's reader and renderer, without a browser: a recording stand-in for the canvas shows where
// and how each page would be drawn. Each test marked FAULT failed when it was written.
// Run: node --test test/audit-pdf.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { PdfDocument } from '../src/apps/pdf/objects.ts';
import { renderPage } from '../src/apps/pdf/render.ts';

type M = [number, number, number, number, number, number];
const mul = (a: M, b: M): M => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];

/** A 2D context that keeps the transform and the save stack as a canvas does, and records what is painted. */
class MockCtx {
  m: M = [1, 0, 0, 1, 0, 0];
  lw = 1;
  stack: Array<{ m: M; lw: number }> = [];
  fills: M[] = [];
  strokes: Array<{ m: M; lineWidth: number }> = [];
  texts: string[] = [];
  images: ImageDataLike[] = [];
  fillStyle = '#000';
  strokeStyle = '#000';
  globalAlpha = 1;
  font = '';
  lineCap = 'butt';
  lineJoin = 'miter';
  miterLimit = 10;
  lineDashOffset = 0;
  get lineWidth() { return this.lw; }
  set lineWidth(v: number) { this.lw = v; }
  reset() { this.m = [1, 0, 0, 1, 0, 0]; this.stack = []; this.lw = 1; }
  save() { this.stack.push({ m: this.m, lw: this.lw }); }
  restore() { const s = this.stack.pop(); if (s) { this.m = s.m; this.lw = s.lw; } }
  transform(a: number, b: number, c: number, d: number, e: number, f: number) { this.m = mul([a, b, c, d, e, f], this.m); }
  scale(x: number, y: number) { this.transform(x, 0, 0, y, 0, 0); }
  fill() { this.fills.push(this.m); }
  stroke() { this.strokes.push({ m: this.m, lineWidth: this.lw }); }
  getTransform() { const [a, b, c, d, e, f] = this.m; return { a, b, c, d, e, f }; }
  fillText(t: string) { this.texts.push(t); }
  strokeText(t: string) { this.texts.push(t); }
  measureText(t: string) { return { width: 55 * t.length }; }
  putImageData(d: ImageDataLike) { this.images.push(d); }
  drawImage(src: unknown) { const c = src as { ctx?: MockCtx }; if (c.ctx) this.images.push(...c.ctx.images); }
  fillRect() {}
  rect() {}
  clip() {}
  beginPath() {}
  closePath() {}
  moveTo() {}
  lineTo() {}
  bezierCurveTo() {}
  setLineDash() {}
}
interface ImageDataLike { width: number; height: number; data: Uint8ClampedArray }
class MockCanvas {
  ctx = new MockCtx();
  private w = 300;
  private hh = 150;
  get width() { return this.w; }
  set width(v: number) { this.w = v; this.ctx.reset(); }
  get height() { return this.hh; }
  set height(v: number) { this.hh = v; this.ctx.reset(); }
  getContext() { return this.ctx; }
}
const g = globalThis as Record<string, unknown>;
g.document = { createElement: () => new MockCanvas() };
g.ImageData = class { width: number; height: number; data: Uint8ClampedArray; constructor(w: number, h: number) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); } };

const enc = (s: string) => new TextEncoder().encode(s);
function join(...parts: Array<string | Uint8Array>): Uint8Array {
  const bytes = parts.map(p => (typeof p === 'string' ? enc(p) : p));
  const out = new Uint8Array(bytes.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of bytes) { out.set(b, at); at += b.length; }
  return out;
}
/** A PDF from numbered object bodies (1 must be the catalog). A body may be [dict, stream bytes]. */
function pdf(objects: Record<number, string | [string, Uint8Array]>): Uint8Array {
  const parts: Array<string | Uint8Array> = ['%PDF-1.4\n'];
  for (const [id, body] of Object.entries(objects)) {
    if (typeof body === 'string') parts.push(`${id} 0 obj\n${body}\nendobj\n`);
    else parts.push(`${id} 0 obj\n${body[0].replace('LEN', String(body[1].length))}\nstream\n`, body[1], '\nendstream\nendobj\n');
  }
  parts.push('trailer\n<< /Root 1 0 R >>\n%%EOF\n');
  return join(...parts);
}
const onePage = (content: string, extraPage = '', extra: Record<number, string | [string, Uint8Array]> = {}) => pdf({
  1: '<< /Type /Catalog /Pages 2 0 R >>',
  2: '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 100 100] >>',
  3: `<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /Im1 6 0 R >> >> ${extraPage} >>`,
  4: ['<< /Length LEN >>', enc(content)],
  5: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ...extra,
});
const tick = () => new Promise(r => setImmediate(r));

test('FAULT: a page whose drawing was cut short (page turned, window resized) does not spoil the next page drawn on the same canvas', async () => {
  // Two busy pages: 6000 small squares each, so each drawing pauses (every 4000 steps) and checks it is still wanted.
  const busy = Array.from({ length: 6000 }, () => '0 0 1 1 re f').join('\n');
  const file = pdf({
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /MediaBox [0 0 100 100] >>',
    3: '<< /Type /Page /Parent 2 0 R /Contents 5 0 R >>',
    4: '<< /Type /Page /Parent 2 0 R /Contents 5 0 R >>',
    5: ['<< /Length LEN >>', enc(busy)],
  });
  const doc = await PdfDocument.open(file);
  // Drawn alone, every square of page 2 is painted with the page's own flip: [1,0,0,-1,0,100].
  const canvas = new MockCanvas();
  let generation = 1;
  const first = renderPage(doc, doc.pages[0], canvas as unknown as HTMLCanvasElement, 1, () => generation === 1);
  for (let i = 0; i < 50 && canvas.ctx.fills.length < 3000; i++) await tick();
  assert.ok(canvas.ctx.fills.length >= 1000, 'page 1 started drawing');
  // The person turns the page while page 1 is paused.
  generation = 2;
  canvas.ctx.fills = [];
  await Promise.all([first, renderPage(doc, doc.pages[1], canvas as unknown as HTMLCanvasElement, 1, () => generation === 2)]);
  const wrong = canvas.ctx.fills.filter(m => m.join() !== '1,0,0,-1,0,100').length;
  assert.equal(canvas.ctx.fills.length, 6000, 'all of page 2 drawn');
  assert.equal(wrong, 0, `squares of page 2 drawn with the wrong placement (page 1's leftover restore() popped page 2's set-up)`);
});

test('FAULT: a colour-table picture whose table is stored as a stream shows its colours, not a black box', async () => {
  // 2x1 picture, palette: 0 = red, 1 = green. The table as a stream is how many PDF makers write it.
  const file = onePage('q 100 0 0 100 0 0 cm /Im1 Do Q', '', {
    6: ['<< /Type /XObject /Subtype /Image /Width 2 /Height 1 /BitsPerComponent 8 /ColorSpace [/Indexed /DeviceRGB 1 7 0 R] /Length LEN >>', Uint8Array.of(0, 1)],
    7: ['<< /Length LEN >>', Uint8Array.of(255, 0, 0, 0, 255, 0)],
  });
  const doc = await PdfDocument.open(file);
  const canvas = new MockCanvas();
  await renderPage(doc, doc.pages[0], canvas as unknown as HTMLCanvasElement, 1, () => true);
  assert.equal(canvas.ctx.images.length, 1, 'the picture was drawn');
  const px = [...canvas.ctx.images[0].data];
  assert.deepEqual(px, [255, 0, 0, 255, 0, 255, 0, 255], 'red then green');
});

test('FAULT: a filled-in form field (its value is in the field\'s appearance) shows on the page', async () => {
  // An empty page carrying one text field whose appearance stream writes "Jane Smith", as every form filler saves it.
  const ap = 'BT /F1 10 Tf 2 5 Td (Jane Smith) Tj ET';
  const file = onePage('', '/Annots [8 0 R]', {
    8: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /V (Jane Smith) /Rect [10 10 90 30] /AP << /N 9 0 R >> >>',
    9: ['<< /Type /XObject /Subtype /Form /BBox [0 0 80 20] /Resources << /Font << /F1 5 0 R >> >> /Length LEN >>', enc(ap)],
  });
  const doc = await PdfDocument.open(file);
  const canvas = new MockCanvas();
  const result = await renderPage(doc, doc.pages[0], canvas as unknown as HTMLCanvasElement, 1, () => true);
  assert.match(result.text, /Jane Smith/, 'the field value is on the page');
});

test('FAULT: a zero-width line (PDF\'s "thinnest line the device can show", common in drawings) is drawn at least one pixel wide', async () => {
  const file = onePage('0 w 10 10 m 90 90 l S');
  const doc = await PdfDocument.open(file);
  const canvas = new MockCanvas();
  await renderPage(doc, doc.pages[0], canvas as unknown as HTMLCanvasElement, 1.5, () => true);
  assert.equal(canvas.ctx.strokes.length, 1);
  const s = canvas.ctx.strokes[0];
  const devicePx = s.lineWidth * Math.hypot(s.m[0], s.m[1]);
  assert.ok(devicePx >= 0.9, `line is ${devicePx.toFixed(3)} device pixels wide`);
});

test('FAULT (P1): the page is cut to its CropBox, as every viewer shows it', async () => {
  const file = onePage('', '/CropBox [10 10 60 80]');
  const doc = await PdfDocument.open(file);
  assert.deepEqual(doc.pages[0].box, [10, 10, 60, 80]);
});

test('FAULT (P1): a document of more than 5000 pages lists every page', async () => {
  const kids = Array.from({ length: 5200 }, (_, i) => `${10 + i} 0 R`).join(' ');
  const objects: Record<number, string> = {
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: `<< /Type /Pages /Kids [${kids}] /Count 5200 /MediaBox [0 0 100 100] >>`,
  };
  for (let i = 0; i < 5200; i++) objects[10 + i] = '<< /Type /Page /Parent 2 0 R >>';
  const doc = await PdfDocument.open(pdf(objects));
  assert.equal(doc.pages.length, 5200);
});

test('FAULT (P1): an inline picture (BI ... ID ... EI) is drawn', async () => {
  const file = onePage('q 100 0 0 100 0 0 cm BI /W 2 /H 1 /CS /RGB /BPC 8 ID \xff\x00\x00\x00\xff\x00 EI Q');
  const doc = await PdfDocument.open(file);
  const canvas = new MockCanvas();
  await renderPage(doc, doc.pages[0], canvas as unknown as HTMLCanvasElement, 1, () => true);
  assert.equal(canvas.ctx.images.length, 1, 'inline picture drawn');
});

test('FAULT (P1): a PDF encrypted with an empty open password (permissions only) opens, as in every other viewer', async () => {
  // Only the refusal is checked: the reader sees /Encrypt and stops, whatever the password.
  const file = join(
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\n',
    '9 0 obj\n<< /Filter /Standard /V 1 /R 2 /O <00> /U <00> /P -44 >>\nendobj\n',
    'trailer\n<< /Root 1 0 R /Encrypt 9 0 R /ID [<00><00>] >>\n%%EOF\n',
  );
  await assert.doesNotReject(PdfDocument.open(file));
});

test('own round trip: a PDF written by the Spreadsheet/Write PDF writer opens and reads back its text', async () => {
  const { PdfDocument: Writer } = await import('../src/apps/sheet/pdf.ts');
  const w = new Writer();
  const p1 = w.addPage(595, 842);
  p1.text(50, 50, 'Café total €12', { size: 12, kind: 'sans' } as never);
  p1.line([10, 10, 200, 10], '#000000', 0.5);
  const p2 = w.addPage(842, 595);
  p2.text(50, 50, 'Second page', { size: 12, kind: 'serif', bold: true } as never);
  const doc = await PdfDocument.open(await w.bytes());
  assert.equal(doc.pages.length, 2);
  const canvas = new MockCanvas();
  const r1 = await renderPage(doc, doc.pages[0], canvas as unknown as HTMLCanvasElement, 1, () => true);
  assert.equal(r1.text, 'Café total €12');
  const r2 = await renderPage(doc, doc.pages[1], canvas as unknown as HTMLCanvasElement, 1, () => true);
  assert.equal(r2.text, 'Second page');
});

test('FAULT (P1): text in an embedded two-byte font with no ToUnicode map is not silently blank (letters drawn, or a note says why)', async () => {
  const file = onePage('BT /F2 12 Tf 10 50 Td <00240025> Tj ET', '/Resources << /Font << /F2 10 0 R >> >>', {
    10: '<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+Calibri /Encoding /Identity-H /DescendantFonts [11 0 R] >>',
    11: '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ABCDEF+Calibri /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 500 >>',
  });
  const doc = await PdfDocument.open(file);
  const canvas = new MockCanvas();
  const r = await renderPage(doc, doc.pages[0], canvas as unknown as HTMLCanvasElement, 1, () => true);
  assert.ok(canvas.ctx.texts.length > 0 || r.note, 'two letters vanished with no word to the person');
});

test('FAULT (P1): text in clip-only mode (7 Tr) is not painted', async () => {
  const file = onePage('BT /F1 12 Tf 7 Tr 10 50 Td (Hidden) Tj ET');
  const doc = await PdfDocument.open(file);
  const canvas = new MockCanvas();
  await renderPage(doc, doc.pages[0], canvas as unknown as HTMLCanvasElement, 1, () => true);
  assert.deepEqual(canvas.ctx.texts, []);
});
