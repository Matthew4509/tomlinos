// Audit of what the Pictures viewer relies on before it shows a picture (src/core/imagesize.ts), without a browser.
// The P0 test failed when it was written; tests marked todo are P1 findings.
// Run: node --test test/audit-photos.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { imageSize, pictureTooBig } from '../src/core/imagesize.ts';

/** A 24-bit BMP with the old 12-byte OS/2 header (BITMAPCOREHEADER): 16-bit width and height at bytes 18 and 20. */
function bmpCore(w: number, h: number): Uint8Array {
  const stride = Math.ceil((w * 3) / 4) * 4;
  const b = Buffer.alloc(26 + stride * h);
  b.write('BM', 0, 'latin1');
  b.writeUInt32LE(b.length, 2);
  b.writeUInt32LE(26, 10);
  b.writeUInt32LE(12, 14);
  b.writeUInt16LE(w, 18);
  b.writeUInt16LE(h, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt16LE(24, 24);
  return new Uint8Array(b);
}

/** A PNG header that declares w × h (the pixel data is not needed for the size check). */
function pngHeader(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b[24] = 8;
  b[25] = 6;
  return Buffer.concat([b, deflateSync(Buffer.alloc(0))]);
}

// PH-P0-1: imagesize.ts:48-49 reads width and height as 32-bit numbers at 18 and 22 for every BMP, so a 100 × 100
// OS/2 BMP is read as 6,553,700 × 1,572,865 and the viewer refuses it as "enormous". The browser draws it fine.
test('PH-P0-1 an OS/2 (12-byte header) BMP is read at its real size and not refused', () => {
  const b = bmpCore(100, 100);
  assert.deepEqual(imageSize(b), { width: 100, height: 100 });
  assert.equal(pictureTooBig(b), null);
});

// PH-P1-5: an ICO that wraps a PNG declaring 60,000 × 60,000 is not checked (imageSize knows no ICO), so it goes
// straight to the browser's decoder; the same PNG on its own is refused.
test('PH-P1-5 an ICO wrapping an enormous PNG is refused like the PNG itself', { todo: 'P1' }, () => {
  const p = pngHeader(60000, 60000);
  assert.ok(pictureTooBig(new Uint8Array(p)), 'the bare PNG is refused');
  const head = Buffer.alloc(22);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(1, 4);
  head.writeUInt16LE(1, 10);
  head.writeUInt16LE(32, 12);
  head.writeUInt32LE(p.length, 14);
  head.writeUInt32LE(22, 18);
  assert.ok(pictureTooBig(new Uint8Array(Buffer.concat([head, p]))), 'the same PNG inside an ICO is refused too');
});
