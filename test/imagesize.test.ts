// Picture sizes read from the first bytes (src/core/imagesize.ts), for real pictures made by Python's standard
// library and by hand, and the refusal for a small file that declares a huge picture.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { imageSize, pictureTooBig } from '../src/core/imagesize.ts';

function png(w: number, h: number): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.alloc(1))), chunk('IEND', Buffer.alloc(0))]));
}

test('PNG, GIF, BMP, WebP (all three kinds) and JPEG sizes', () => {
  assert.deepEqual(imageSize(png(300, 200)), { width: 300, height: 200 });
  const gif = Buffer.from('GIF89a\x40\x01\xc8\x00', 'latin1');
  assert.deepEqual(imageSize(new Uint8Array(gif)), { width: 320, height: 200 });
  const bmp = Buffer.alloc(30);
  bmp.write('BM', 0, 'latin1');
  bmp.writeInt32LE(640, 18);
  bmp.writeInt32LE(-480, 22);
  assert.deepEqual(imageSize(new Uint8Array(bmp)), { width: 640, height: 480 });
  const webpX = Buffer.alloc(30);
  webpX.write('RIFF', 0, 'latin1');
  webpX.write('WEBPVP8X', 8, 'latin1');
  webpX.writeUIntLE(1023, 24, 3);
  webpX.writeUIntLE(767, 27, 3);
  assert.deepEqual(imageSize(new Uint8Array(webpX)), { width: 1024, height: 768 });
  const webpL = Buffer.alloc(30);
  webpL.write('RIFF', 0, 'latin1');
  webpL.write('WEBPVP8L', 8, 'latin1');
  webpL.writeUInt32LE((99) | (49 << 14), 21);
  assert.deepEqual(imageSize(new Uint8Array(webpL)), { width: 100, height: 50 });
  const webp = Buffer.alloc(30);
  webp.write('RIFF', 0, 'latin1');
  webp.write('WEBPVP8 ', 8, 'latin1');
  webp.writeUInt16LE(400, 26);
  webp.writeUInt16LE(300, 28);
  assert.deepEqual(imageSize(new Uint8Array(webp)), { width: 400, height: 300 });
  // JPEG: SOI, an APP0 segment, then SOF0 with height 1080, width 1920.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x04, 0x38, 0x07, 0x80, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(imageSize(new Uint8Array(jpeg)), { width: 1920, height: 1080 });
  assert.equal(imageSize(new TextEncoder().encode('not a picture')), null);
});

test('a small file declaring a huge picture is refused before decoding, a normal one is not', () => {
  const bomb = png(60000, 60000);
  assert.ok(bomb.length < 200);
  assert.match(pictureTooBig(bomb)!, /60,000 × 60,000 pixels/);
  assert.equal(pictureTooBig(png(4000, 3000)), null);
  assert.equal(pictureTooBig(new TextEncoder().encode('x')), null, 'unknown kinds are left to the browser');
});
