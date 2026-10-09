// The PDF reader (no browser needed): finds pages, unpacks streams, refuses what it cannot handle.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { Dict, Lexer, Name, PStr, PdfDocument, PdfError, Ref, Stream } from '../src/apps/pdf/objects.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const join = (...parts: Array<string | Uint8Array>) => {
  const bytes = parts.map(p => (typeof p === 'string' ? enc(p) : p));
  const out = new Uint8Array(bytes.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of bytes) {
    out.set(b, at);
    at += b.length;
  }
  return out;
};

function simplePdf(extraTrailer = ''): Uint8Array {
  const content = deflateSync(Buffer.from('BT /F1 12 Tf 10 10 Td (Hi) Tj ET'));
  return join(
    '%PDF-1.4\n',
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 200 100] >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Rotate 90 >>\nendobj\n',
    `4 0 obj\n<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`,
    content,
    '\nendstream\nendobj\n',
    `trailer\n<< /Root 1 0 R ${extraTrailer}>>\n%%EOF\n`,
  );
}

test('the lexer reads names, strings, lists, dictionaries and references', () => {
  const lx = new Lexer(enc('<< /A 12 /B (a\\(b\\)\\n) /C [1 2.5 /X] /D 5 0 R /E <48656c6c6f> >>'), 0);
  const d = lx.read(true) as Dict;
  assert.ok(d instanceof Dict);
  assert.equal(d.map.get('A'), 12);
  assert.equal(new TextDecoder().decode((d.map.get('B') as PStr).bytes), 'a(b)\n');
  assert.deepEqual((d.map.get('C') as unknown[]).slice(0, 2), [1, 2.5]);
  assert.ok(((d.map.get('C') as unknown[])[2]) instanceof Name);
  const r = d.map.get('D') as Ref;
  assert.equal(r.num, 5);
  assert.equal(new TextDecoder().decode((d.map.get('E') as PStr).bytes), 'Hello');
});

test('a simple PDF: pages found, the media box and rotation kept, the compressed content unpacked', async () => {
  const doc = await PdfDocument.open(simplePdf());
  assert.equal(doc.pages.length, 1);
  assert.deepEqual(doc.pages[0].box, [0, 0, 200, 100]);
  assert.equal(doc.pages[0].rotate, 90);
  const contents = doc.resolve(doc.pages[0].dict.map.get('Contents'));
  assert.ok(contents instanceof Stream);
  assert.equal(new TextDecoder().decode(await doc.streamData(contents as Stream)), 'BT /F1 12 Tf 10 10 Td (Hi) Tj ET');
});

test('an encrypted PDF is refused with a plain reason', async () => {
  await assert.rejects(PdfDocument.open(simplePdf('/Encrypt 9 0 R ')), (e: unknown) => e instanceof PdfError && /password|encrypted/i.test(e.message));
});

test('something that is not a PDF is refused, and a PDF with no pages says so', async () => {
  await assert.rejects(PdfDocument.open(enc('hello world, not a pdf')), (e: unknown) => e instanceof PdfError && /does not look like a PDF/.test(e.message));
  await assert.rejects(PdfDocument.open(enc('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n')), PdfError);
});

test('a page tree that points back at itself does not loop forever', async () => {
  const looped = enc('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [2 0 R 3 0 R] >>\nendobj\n3 0 obj\n<< /Type /Page >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n');
  const doc = await PdfDocument.open(looped);
  assert.equal(doc.pages.length, 1);
});

test('a bomb: a stream that unpacks to far more than the limit is refused, not swallowed', async () => {
  const big = deflateSync(Buffer.alloc(200 * 1024 * 1024, 0));
  const pdf = join(
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Contents 4 0 R >>\nendobj\n',
    `4 0 obj\n<< /Length ${big.length} /Filter /FlateDecode >>\nstream\n`,
    big,
    '\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n',
  );
  const doc = await PdfDocument.open(pdf);
  const s = doc.resolve(doc.pages[0].dict.map.get('Contents')) as Stream;
  await assert.rejects(doc.streamData(s), (e: unknown) => e instanceof PdfError && /more than/.test(e.message));
});
