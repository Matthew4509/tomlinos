// What a PNG, JPEG or WebP holds that Photo Editor does not keep (src/apps/photoedit/fileinfo.ts), read from hand-made
// file starts: frames, camera details, print size, colour profile, 16-bit and CMYK colour; plain files say nothing,
// and damaged or crafted ones only stop the walk. No browser needed. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { factsOf, lostBySaving } from '../src/apps/photoedit/fileinfo.ts';

const enc = (t: string) => [...t].map(c => c.charCodeAt(0));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];

function pngFile(chunks: Array<[string, number[]]>, depth = 8): Uint8Array {
  const out = [0x89, ...enc('PNG\r\n\x1a\n')];
  const chunk = (type: string, data: number[]) => out.push(...be32(data.length), ...enc(type), ...data, 0, 0, 0, 0);
  chunk('IHDR', [...be32(16), ...be32(16), depth, 6, 0, 0, 0]);
  for (const [t, d] of chunks) chunk(t, d);
  chunk('IDAT', [1, 2, 3]);
  chunk('IEND', []);
  return Uint8Array.from(out);
}

function jpegFile(segments: Array<[number, number[]]>): Uint8Array {
  const out = [0xff, 0xd8];
  for (const [m, d] of segments) out.push(0xff, m, ((d.length + 2) >> 8) & 255, (d.length + 2) & 255, ...d);
  out.push(0xff, 0xda, 0, 2, 9, 9, 9, 0xff, 0xd9);
  return Uint8Array.from(out);
}
const sof = (precision: number, components: number) => [precision, 0, 16, 0, 16, components, ...Array(components * 3).fill(1)];

function webpFile(chunks: Array<[string, number[]]>): Uint8Array {
  const body: number[] = [...enc('WEBP')];
  for (const [t, d] of chunks) body.push(...enc(t), ...le32(d.length), ...d, ...(d.length & 1 ? [0] : []));
  return Uint8Array.from([...enc('RIFF'), ...le32(body.length), ...body]);
}

test('a plain PNG, JPEG and WebP hold nothing that is lost', () => {
  for (const f of [pngFile([]), jpegFile([[0xc0, sof(8, 3)]]), webpFile([['VP8 ', [1, 2, 3, 4]]])]) {
    assert.deepEqual(lostBySaving(factsOf(f)), []);
    assert.equal(factsOf(f).animated, false);
  }
  assert.deepEqual(lostBySaving(factsOf(new Uint8Array([1, 2, 3]))), [], 'not a picture: nothing said');
});

test('a PNG: moving (APNG), camera details, print size, colour profile and 16-bit colour', () => {
  const f = factsOf(pngFile([['acTL', [0, 0, 0, 2, 0, 0, 0, 0]], ['eXIf', [1, 2]], ['pHYs', [...be32(2835), ...be32(2835), 1]], ['iCCP', [...enc('sRGB'), 0, 0, 1]]], 16));
  assert.deepEqual(f, { animated: true, details: true, printSize: true, profile: true, deep: true, cmyk: false });
  assert.equal(lostBySaving(f).length, 4);
  assert.equal(factsOf(pngFile([['pHYs', [...be32(1), ...be32(1), 0]]])).printSize, false, 'unit 0 is only a shape');
  assert.equal(factsOf(pngFile([['iTXt', [...enc('XML:com.adobe.xmp'), 0, 0, 0, 0, 0]]])).details, true, 'XMP counts as details');
});

test('a JPEG: EXIF, XMP, a JFIF print size, an ICC profile, CMYK and 12-bit', () => {
  const f = factsOf(jpegFile([
    [0xe0, [...enc('JFIF\0'), 1, 2, 1, 0, 72, 0, 72, 0, 0]],
    [0xe1, [...enc('Exif\0\0'), 0x4d, 0x4d]],
    [0xe2, [...enc('ICC_PROFILE\0'), 1, 1]],
    [0xc0, sof(12, 4)],
  ]));
  assert.deepEqual(f, { animated: false, details: true, printSize: true, profile: true, deep: true, cmyk: true });
  assert.match(lostBySaving(f).join('; '), /date, the camera, and sometimes the place.*print size.*colour profile.*16-bit.*CMYK/);
  assert.equal(factsOf(jpegFile([[0xe1, [...enc('http://ns.adobe.com/xap/1.0/'), 0]]])).details, true);
  assert.equal(factsOf(jpegFile([[0xe0, [...enc('JFIF\0'), 1, 2, 0, 0, 1, 0, 1, 0, 0]]])).printSize, false, 'units 0: no print size');
});

test('a WebP: moving, details and a profile from its VP8X flags, or from its own chunks', () => {
  assert.deepEqual(factsOf(webpFile([['VP8X', [0x02 | 0x08 | 0x20, 0, 0, 0, 0, 0, 0, 0, 0, 0]]])), { animated: true, details: true, printSize: false, profile: true, deep: false, cmyk: false });
  const f = factsOf(webpFile([['VP8X', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]], ['ANIM', [0, 0, 0, 0, 0, 0]], ['EXIF', [1]], ['ICCP', [1, 2]]]));
  assert.equal(f.animated && f.details && f.profile, true);
});

test('a damaged or crafted file only stops the walk: a length past the end, a JPEG without markers', () => {
  const broken = pngFile([]);
  broken.set(be32(0x7fffffff), 33);
  assert.doesNotThrow(() => factsOf(broken));
  assert.doesNotThrow(() => factsOf(Uint8Array.from([0xff, 0xd8, 0, 0, 0, 0])));
  assert.doesNotThrow(() => factsOf(Uint8Array.from([...enc('RIFF'), 0, 0, 0, 0, ...enc('WEBP'), ...enc('VP8X'), 255, 255, 255, 255])));
});
