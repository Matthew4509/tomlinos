// Photo Editor's filters with settings (photoedit/filters.ts), without a browser.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pixels } from '../src/apps/photoedit/pixels.ts';
import {
  addNoise, blurReach, emboss, findEdges, gaussianBlur, highPass, median, motionBlur, pixelate, randomFrom, unsharpMask, vignette,
} from '../src/apps/photoedit/filters.ts';

function solid(w: number, h: number, rgba: number[]): Pixels {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(rgba, i * 4);
  return { width: w, height: h, data };
}
const px = (p: Pixels, x: number, y: number) => [...p.data.subarray((y * p.width + x) * 4, (y * p.width + x) * 4 + 4)];
const set = (p: Pixels, x: number, y: number, rgba: number[]) => p.data.set(rgba, (y * p.width + x) * 4);
/** Black on the left half, white on the right. */
function edge(w: number, h: number): Pixels {
  const p = solid(w, h, [0, 0, 0, 255]);
  for (let y = 0; y < h; y++) for (let x = w / 2; x < w; x++) set(p, x, y, [255, 255, 255, 255]);
  return p;
}
const near = (a: number, b: number, by: number) => Math.abs(a - b) <= by;

test('Gaussian blur leaves a flat colour alone, softens an edge more as the radius grows, and keeps the total', () => {
  const flat = solid(20, 20, [40, 120, 200, 255]);
  gaussianBlur(flat, 5);
  assert.deepEqual(px(flat, 10, 10), [40, 120, 200, 255]);
  assert.deepEqual(px(flat, 0, 0), [40, 120, 200, 255], 'the edge of the picture stays the same colour too');
  const widths = [1, 3, 8].map(r => {
    const p = edge(80, 4);
    gaussianBlur(p, r);
    // How many pixels along the row are neither black nor white.
    let n = 0;
    for (let x = 0; x < 80; x++) if (px(p, x, 2)[0] > 10 && px(p, x, 2)[0] < 245) n++;
    // Half way across stays half way.
    assert.ok(near(px(p, 39, 2)[0] + px(p, 40, 2)[0], 255, 6), `radius ${r}: the middle stays balanced`);
    return n;
  });
  assert.ok(widths[0] < widths[1] && widths[1] < widths[2], `wider with radius: ${widths}`);
  assert.ok(widths[0] >= 2, 'radius 1 does something');
  // A small and a large radius both run through each path (true gaussian below 2, boxes above).
  const big = edge(400, 2);
  gaussianBlur(big, 60);
  assert.ok(px(big, 200, 1)[0] > 100 && px(big, 200, 1)[0] < 155);
});

test('Gaussian blur does not darken a colour next to see-through pixels, and blurs the see-through amount', () => {
  const p = solid(20, 1, [0, 0, 0, 0]);
  for (let x = 10; x < 20; x++) set(p, x, 0, [255, 0, 0, 255]);
  gaussianBlur(p, 2);
  const [r, g, b, a] = px(p, 9, 0);
  assert.ok(a > 0 && a < 255, 'the edge fades');
  assert.ok(r >= 250 && g === 0 && b === 0, `still pure red, not dark: ${[r, g, b]}`);
  assert.equal(px(p, 0, 0)[3], 0, 'far off stays see-through');
});

test('blur reach covers three spreads', () => {
  assert.equal(blurReach(0), 1);
  assert.equal(blurReach(10), 31);
});

test('unsharp mask makes an edge stronger, leaves flat parts alone, and its threshold spares small changes', () => {
  const p = edge(40, 3);
  for (let y = 0; y < 3; y++) for (let x = 0; x < 40; x++) {
    const v = x < 20 ? 60 : 180;
    set(p, x, y, [v, v, v, 255]);
  }
  unsharpMask(p, 2, 1);
  assert.ok(px(p, 19, 1)[0] < 60, `dark side gets darker at the edge: ${px(p, 19, 1)}`);
  assert.ok(px(p, 20, 1)[0] > 180, `light side gets lighter: ${px(p, 20, 1)}`);
  assert.equal(px(p, 2, 1)[0], 60, 'far from the edge: unchanged');
  assert.equal(px(p, 20, 1)[3], 255, 'solidness unchanged');
  // A soft step of 6 levels is below a threshold of 20, so nothing moves.
  const soft = solid(40, 3, [100, 100, 100, 255]);
  for (let y = 0; y < 3; y++) for (let x = 20; x < 40; x++) set(soft, x, y, [106, 106, 106, 255]);
  const before = soft.data.slice();
  unsharpMask(soft, 2, 2, 20);
  assert.deepEqual(soft.data, before);
  // No amount or no radius: nothing.
  const q = edge(10, 1), q0 = q.data.slice();
  unsharpMask(q, 2, 0);
  unsharpMask(q, 0, 1);
  assert.deepEqual(q.data, q0);
});

test('high pass turns flat parts middle grey and keeps the detail', () => {
  const flat = solid(10, 10, [200, 30, 90, 255]);
  highPass(flat, 3);
  assert.deepEqual(px(flat, 5, 5), [128, 128, 128, 255]);
  const p = edge(40, 3);
  highPass(p, 3);
  assert.ok(px(p, 19, 1)[0] < 128 && px(p, 20, 1)[0] > 128, 'the edge shows as dark then light');
});

test('motion blur smears across at 0 degrees and up and down at 90, never the other way', () => {
  const dot = () => {
    const p = solid(21, 21, [0, 0, 0, 255]);
    set(p, 10, 10, [255, 255, 255, 255]);
    return p;
  };
  const a = dot();
  motionBlur(a, 9, 0);
  assert.ok(px(a, 14, 10)[0] > 0 && px(a, 6, 10)[0] > 0, 'spread left and right');
  assert.equal(px(a, 10, 14)[0], 0, 'not up or down');
  assert.ok(px(a, 10, 10)[0] < 255, 'the dot itself is spread out');
  const b = dot();
  motionBlur(b, 9, 90);
  assert.ok(px(b, 10, 14)[0] > 0 && px(b, 10, 6)[0] > 0, 'spread up and down');
  assert.equal(px(b, 14, 10)[0], 0, 'not across');
  const flat = solid(10, 10, [10, 20, 30, 255]);
  motionBlur(flat, 30, 37);
  assert.deepEqual(px(flat, 5, 5), [10, 20, 30, 255]);
});

test('noise reduction takes out a lone speck and keeps a hard edge where it is', () => {
  const p = solid(15, 15, [50, 50, 50, 255]);
  set(p, 7, 7, [255, 0, 255, 255]);
  median(p, 1);
  assert.deepEqual(px(p, 7, 7), [50, 50, 50, 255]);
  const e = edge(30, 9);
  median(e, 3);
  assert.equal(px(e, 14, 4)[0], 0, 'dark side of the edge stays dark');
  assert.equal(px(e, 15, 4)[0], 255, 'light side stays light');
  // Matches a plain sort on a noisy patch (the sliding count must not drift).
  const rnd = randomFrom(7);
  const q = solid(12, 9, [0, 0, 0, 255]);
  for (let i = 0; i < q.data.length; i++) if (i % 4 !== 3) q.data[i] = Math.floor(rnd() * 256);
  const src = q.data.slice();
  median(q, 2);
  for (const [x, y] of [[0, 0], [5, 4], [11, 8], [6, 0]]) {
    const vals: number[] = [];
    for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) {
      const sx = Math.min(11, Math.max(0, x + i)), sy = Math.min(8, Math.max(0, y + j));
      vals.push(src[(sy * 12 + sx) * 4 + 1]);
    }
    vals.sort((m, n) => m - n);
    assert.equal(px(q, x, y)[1], vals[12], `median at ${x}, ${y}`);
  }
});

test('add noise is the same each time for the same seed, grey when mono, and leaves see-through pixels alone', () => {
  const a = solid(30, 30, [128, 128, 128, 255]), b = solid(30, 30, [128, 128, 128, 255]);
  addNoise(a, 40, false, 5);
  addNoise(b, 40, false, 5);
  assert.deepEqual(a.data, b.data);
  let changed = 0, coloured = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (a.data[i] !== 128) changed++;
    if (a.data[i] !== a.data[i + 1]) coloured++;
  }
  assert.ok(changed > 600, 'most pixels change');
  assert.ok(coloured > 300, 'colour noise differs per channel');
  const m = solid(30, 30, [128, 128, 128, 255]);
  addNoise(m, 40, true, 5);
  for (let i = 0; i < m.data.length; i += 4) assert.ok(m.data[i] === m.data[i + 1] && m.data[i] === m.data[i + 2]);
  const clear = solid(5, 5, [0, 0, 0, 0]);
  addNoise(clear, 100, false, 1);
  assert.ok(clear.data.every(v => v === 0));
});

test('pixelate makes squares of the average colour, smaller ones at the far edges', () => {
  const p = solid(5, 1, [0, 0, 0, 255]);
  set(p, 0, 0, [100, 0, 0, 255]);
  set(p, 1, 0, [200, 0, 0, 255]);
  set(p, 4, 0, [50, 0, 0, 255]);
  pixelate(p, 2);
  assert.deepEqual(px(p, 0, 0), [150, 0, 0, 255]);
  assert.deepEqual(px(p, 1, 0), [150, 0, 0, 255]);
  assert.deepEqual(px(p, 4, 0), [50, 0, 0, 255], 'the last square is one pixel');
  // A see-through pixel does not pull the colour towards black.
  const q = solid(2, 1, [0, 0, 0, 0]);
  set(q, 1, 0, [0, 200, 0, 255]);
  pixelate(q, 2);
  assert.deepEqual(px(q, 0, 0), [0, 200, 0, 128]);
});

test('emboss is middle grey on flat parts and lights the side facing the light', () => {
  const flat = solid(6, 6, [200, 10, 10, 255]);
  emboss(flat, 0, 3);
  assert.deepEqual(px(flat, 3, 3), [128, 128, 128, 255]);
  const p = edge(20, 5);
  emboss(p, 0, 2);
  assert.ok(px(p, 10, 2)[0] > 200, 'a step up to the right, lit from the right, is bright');
  const q = edge(20, 5);
  emboss(q, 180, 2);
  assert.ok(q.data[(2 * 20 + 10) * 4] < 60, 'lit from the left it is dark');
  const keep = solid(6, 6, [200, 10, 10, 255]);
  emboss(keep, 0, 3, true);
  assert.deepEqual(px(keep, 3, 3), [200, 10, 10, 255], 'keep colours: flat parts unchanged');
});

test('find edges draws the edge bright on black, or dark on white when inverted', () => {
  const p = edge(20, 5);
  findEdges(p, 1);
  assert.equal(px(p, 2, 2)[0], 0);
  assert.equal(px(p, 10, 2)[0], 255);
  assert.equal(px(p, 10, 2)[3], 255);
  const q = edge(20, 5);
  findEdges(q, 1, true);
  assert.equal(px(q, 2, 2)[0], 255);
  assert.equal(px(q, 10, 2)[0], 0);
});

test('vignette darkens the corners, leaves the middle, and lightens with a negative amount', () => {
  const p = solid(41, 41, [200, 200, 200, 255]);
  vignette(p, 100, 50, 40);
  assert.deepEqual(px(p, 20, 20), [200, 200, 200, 255]);
  assert.ok(px(p, 0, 0)[0] < 20, `corner dark: ${px(p, 0, 0)}`);
  assert.equal(px(p, 0, 0)[3], 255);
  const q = solid(41, 41, [100, 100, 100, 255]);
  vignette(q, -50, 50, 40);
  assert.ok(px(q, 0, 0)[0] > 160 && px(q, 0, 0)[0] < 190, `corner half way to white: ${px(q, 0, 0)}`);
  const none = solid(9, 9, [1, 2, 3, 255]);
  vignette(none, 0);
  assert.deepEqual(px(none, 0, 0), [1, 2, 3, 255]);
});

// ---- The filter windows' sums (photoedit/filter-ui.ts) ----
import { changesInside, defaultValues, filterRect, FILTER_TITLES, type FilterKind } from '../src/apps/photoedit/filter-ui.ts';

test('a filter reads a margin round the selection, cut to the picture', () => {
  assert.deepEqual(filterRect(null, 100, 50, 10), { x: 0, y: 0, w: 100, h: 50 });
  assert.deepEqual(filterRect({ x: 20, y: 20, w: 10, h: 10 }, 100, 50, 5), { x: 15, y: 15, w: 20, h: 20 });
  assert.deepEqual(filterRect({ x: 2, y: 40, w: 10, h: 10 }, 100, 50, 5), { x: 0, y: 35, w: 17, h: 15 });
  assert.deepEqual(filterRect({ x: 20, y: 20, w: 10, h: 10 }, 100, 50, 0), { x: 20, y: 20, w: 10, h: 10 });
});

test('only a change at a selected pixel counts as a change', () => {
  const before = new Uint8ClampedArray(2 * 2 * 4), after = before.slice();
  assert.equal(changesInside(before, after, null, { x: 0, y: 0, w: 2, h: 2 }, 2), false);
  after[5] = 9; // pixel (1, 0)
  assert.equal(changesInside(before, after, null, { x: 0, y: 0, w: 2, h: 2 }, 2), true);
  // A 4-wide picture with only (3, 1) selected; the part is its right half, from (2, 0).
  const sel = new Uint8Array(4 * 2);
  sel[1 * 4 + 3] = 255;
  assert.equal(changesInside(before, after, sel, { x: 2, y: 0, w: 2, h: 2 }, 4), false, '(1, 0) of the part is (3, 0): not selected');
  const after2 = before.slice();
  after2[(1 * 2 + 1) * 4 + 2] = 1; // (1, 1) of the part is (3, 1)
  assert.equal(changesInside(before, after2, sel, { x: 2, y: 0, w: 2, h: 2 }, 4), true);
});

test('every filter window starts at settings that change a picture, and has a title', () => {
  for (const kind of Object.keys(FILTER_TITLES) as FilterKind[]) {
    const v = defaultValues(kind);
    assert.ok(Object.keys(v).length >= 1, kind);
    assert.ok(Object.values(v).every(Number.isFinite), kind);
  }
  assert.deepEqual(defaultValues('noise'), { amount: 15, mono: 1 });
});
