// Photo Editor's pixel sums, on small made-up pictures.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLUR, brightnessContrast, convolve3, crop, flip, floodFill, greyscale, hexToRgba, invert, keepShape, rgbToHex, rotate90, saturation, sepia, type Pixels } from '../src/apps/photoedit/pixels.ts';

/** A picture from rows of [r,g,b,a] pixels. */
function pic(rows: number[][][]): Pixels {
  const h = rows.length, w = rows[0].length;
  return { width: w, height: h, data: new Uint8ClampedArray(rows.flat(2)) };
}
const px = (p: Pixels, x: number, y: number) => [...p.data.subarray((y * p.width + x) * 4, (y * p.width + x) * 4 + 4)];
const R = [255, 0, 0, 255], G = [0, 255, 0, 255], B = [0, 0, 255, 255], W = [255, 255, 255, 255], K = [0, 0, 0, 255];

test('brightness and contrast at 0 change nothing; brightness lifts', () => {
  const p = pic([[[10, 100, 200, 255]]]);
  brightnessContrast(p, 0, 0);
  assert.deepEqual(px(p, 0, 0), [10, 100, 200, 255]);
  brightnessContrast(p, 20, 0);
  assert.deepEqual(px(p, 0, 0), [61, 151, 251, 255]);
});

test('greyscale, sepia, invert, saturation keep transparency', () => {
  const p = pic([[[255, 0, 0, 128]]]);
  greyscale(p);
  assert.equal(p.data[0], p.data[1]);
  assert.equal(p.data[3], 128);
  const q = pic([[[100, 150, 200, 255]]]);
  invert(q);
  assert.deepEqual(px(q, 0, 0), [155, 105, 55, 255]);
  const s = pic([[[100, 100, 100, 255]]]);
  sepia(s);
  assert.ok(s.data[0] > s.data[2], 'warm');
  const t = pic([[[200, 100, 100, 255]]]);
  saturation(t, 100);
  assert.ok(t.data[0] > 200 && t.data[1] < 100);
});

test('rotate a quarter turn both ways, and flips', () => {
  const p = pic([[R, G, B]]); // 3 wide, 1 high
  const cw = rotate90(p, 1);
  assert.deepEqual([cw.width, cw.height], [1, 3]);
  assert.deepEqual([px(cw, 0, 0), px(cw, 0, 2)], [R, B]);
  const ccw = rotate90(p, -1);
  assert.deepEqual([px(ccw, 0, 0), px(ccw, 0, 2)], [B, R]);
  const f = pic([[R, G, B], [W, K, W]]);
  flip(f, true);
  assert.deepEqual([px(f, 0, 0), px(f, 2, 0)], [B, R]);
  flip(f, false);
  assert.deepEqual(px(f, 0, 0), W);
});

test('crop clips to the picture', () => {
  const p = pic([[R, G], [B, W]]);
  const c = crop(p, 1, 1, 10, 10);
  assert.deepEqual([c.width, c.height, px(c, 0, 0)], [1, 1, W]);
});

test('flood fill fills only the joined area and stops at a wall', () => {
  const p = pic([
    [W, W, K, W],
    [W, W, K, W],
    [K, K, K, W],
  ]);
  const n = floodFill(p, 0, 0, [255, 0, 0, 255], 10);
  assert.equal(n, 4);
  assert.deepEqual(px(p, 1, 1), R);
  assert.deepEqual(px(p, 3, 0), W, 'beyond the wall untouched');
  assert.equal(floodFill(p, 0, 0, [255, 0, 0, 255]), 0, 'filling with the same colour does nothing');
});

test('blur averages neighbours; colours and sizes convert', () => {
  const p = pic([[K, K, K], [K, W, K], [K, K, K]]);
  convolve3(p, BLUR);
  assert.equal(px(p, 1, 1)[0], 64);
  assert.deepEqual(hexToRgba('#ff8000'), [255, 128, 0, 255]);
  assert.equal(rgbToHex(255, 128, 0), '#ff8000');
  assert.deepEqual(keepShape(400, 300, 200, null), [200, 150]);
  assert.deepEqual(keepShape(400, 300, null, 30), [40, 30]);
});
