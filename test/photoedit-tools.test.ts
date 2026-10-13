// Photo Editor's selections, colour tools, retouching brushes, transform handles and text layout, without a browser.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pixels } from '../src/apps/photoedit/pixels.ts';
import {
  combine, cropMask, ellipseMask, feather, invertMask, maskBounds, maskEdges, maskMix, polygonMask, rectMask, shiftMask, wandMask,
} from '../src/apps/photoedit/selection.ts';
import {
  applyTable, autoLevels, colourBalance, curveTable, desaturate, histogram, hueSaturation, levelsTable, LEVELS_NONE, posterise, threshold,
} from '../src/apps/photoedit/colour.ts';
import { blurSharpenDab, cloneDab, DabPath, dodgeBurnDab, falloff, healDab, makeCarry, smudgeDab } from '../src/apps/photoedit/retouch.ts';
import { boxBounds, dragBox, hitHandle, type Box } from '../src/apps/photoedit/transform.ts';
import { fontOf, layoutText } from '../src/apps/photoedit/text.ts';

function solid(w: number, h: number, rgba: number[]): Pixels {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(rgba, i * 4);
  return { width: w, height: h, data };
}
const px = (p: Pixels, x: number, y: number) => [...p.data.subarray((y * p.width + x) * 4, (y * p.width + x) * 4 + 4)];
const count = (m: Uint8Array | null) => (m ? m.reduce((n, v) => n + (v >= 128 ? 1 : 0), 0) : 0);

// ---- Selections ----

test('rectangle, ellipse and outline selections cover the right pixels', () => {
  const r = rectMask(10, 10, { x: 2, y: 3, w: 4, h: 2 });
  assert.equal(count(r), 8);
  assert.deepEqual(maskBounds(r, 10, 10), { x: 2, y: 3, w: 4, h: 2 });
  // Dragged from bottom right to top left works the same.
  assert.equal(count(rectMask(10, 10, { x: 6, y: 5, w: -4, h: -2 })), 8);
  const e = ellipseMask(100, 100, { x: 0, y: 0, w: 100, h: 100 });
  const area = count(e);
  assert.ok(Math.abs(area - Math.PI * 2500) < 60, `circle area ${area}`);
  assert.equal(e[50 * 100 + 50], 255);
  assert.equal(e[0], 0);
  const tri = polygonMask(10, 10, [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }]);
  assert.ok(count(tri) >= 45 && count(tri) <= 55, `triangle ${count(tri)}`);
  assert.equal(tri[0], 255);
  assert.equal(tri[99], 0);
});

test('magic wand: joined area only, or every matching pixel; tolerance counts', () => {
  const p = solid(5, 1, [255, 0, 0, 255]);
  p.data.set([0, 0, 255, 255], 2 * 4); // a blue pixel in the middle splits the red
  assert.equal(count(wandMask(p, 0, 0, 10, true)), 2);
  assert.equal(count(wandMask(p, 0, 0, 10, false)), 4);
  p.data.set([250, 0, 0, 255], 4); // near red joins at tolerance 10, not at 2
  assert.equal(count(wandMask(p, 0, 0, 2, true)), 1);
  assert.equal(count(wandMask(p, 9, 0, 10, true)), 0, 'outside the picture selects nothing');
});

test('add, subtract, intersect, invert; an emptied selection is none', () => {
  const a = rectMask(10, 1, { x: 0, y: 0, w: 6, h: 1 });
  const b = rectMask(10, 1, { x: 4, y: 0, w: 6, h: 1 });
  assert.equal(count(combine(a, b, 'add')), 10);
  assert.equal(count(combine(a, b, 'subtract')), 4);
  assert.equal(count(combine(a, b, 'intersect')), 2);
  assert.equal(combine(a, a, 'subtract'), null);
  assert.equal(count(combine(null, b, 'add')), 6, 'adding to nothing is the shape');
  assert.equal(combine(null, b, 'intersect'), null);
  assert.equal(count(combine(a, b, 'replace')), 6);
  assert.equal(count(invertMask(a, 10)), 4);
  assert.equal(count(invertMask(null, 10)), 10, 'invert of nothing is everything');
  assert.equal(invertMask(rectMask(2, 1, { x: 0, y: 0, w: 2, h: 1 }), 2), null);
});

test('feather softens the edge but keeps the middle, and shifting / cropping a mask', () => {
  const m = rectMask(40, 40, { x: 10, y: 10, w: 20, h: 20 });
  const f = feather(m, 40, 40, 6);
  assert.equal(f[20 * 40 + 20], 255, 'middle stays selected');
  const edge = f[20 * 40 + 10];
  assert.ok(edge > 60 && edge < 200, `edge is soft (${edge})`);
  assert.ok(f[20 * 40 + 6] > 0 && f[20 * 40 + 6] < 128, 'a little spills outside');
  assert.equal(f[0], 0);
  assert.equal(feather(m, 40, 40, 0), m, 'no feather, no change');
  const s = shiftMask(m, 40, 40, 5, -5)!;
  assert.deepEqual(maskBounds(s, 40, 40), { x: 15, y: 5, w: 20, h: 20 });
  assert.equal(shiftMask(m, 40, 40, 100, 0), null);
  const c = cropMask(m, 40, { x: 10, y: 10, w: 20, h: 20 }, 20, 20)!;
  assert.equal(count(c), 400);
});

test('marching ants: a square selection has four joined edges', () => {
  const m = rectMask(10, 10, { x: 2, y: 2, w: 3, h: 3 });
  const e = maskEdges(m, 10, 10);
  assert.equal(e.length, 16);
  assert.deepEqual(e.slice(0, 8), [2, 2, 5, 2, 2, 5, 5, 5]);
  assert.deepEqual(maskEdges(new Uint8Array(4), 2, 2), []);
});

test('maskMix keeps a change only inside the selection, partly at a soft edge', () => {
  const before = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]);
  const after = new Uint8ClampedArray([200, 200, 200, 255, 200, 200, 200, 255, 200, 200, 200, 255]);
  const mask = new Uint8Array([0, 0, 255, 128, 0]); // 5 wide; the rect starts at x = 1
  maskMix(before, after, mask, { x: 1, y: 0, w: 3, h: 1 }, 5);
  assert.deepEqual([after[0], after[4], after[8]], [0, 200, 100]);
});

// ---- Colour ----

test('levels: none changes nothing; inputs stretch, gamma lifts the middle, outputs squeeze', () => {
  const t0 = levelsTable(LEVELS_NONE);
  for (let x = 0; x < 256; x++) assert.equal(t0[x], x);
  const t = levelsTable({ inLow: 50, inHigh: 200, gamma: 1, outLow: 0, outHigh: 255 });
  assert.deepEqual([t[0], t[50], t[125], t[200], t[255]], [0, 0, 128, 255, 255]);
  assert.ok(levelsTable({ ...LEVELS_NONE, gamma: 2 })[128] > 170);
  const o = levelsTable({ ...LEVELS_NONE, outLow: 100, outHigh: 150 });
  assert.deepEqual([o[0], o[255]], [100, 150]);
  const hist = new Uint32Array(256);
  hist[40] = 100;
  hist[200] = 100;
  assert.deepEqual([autoLevels(hist, 200).inLow, autoLevels(hist, 200).inHigh], [40, 200]);
});

test('curves: through the points, smooth, never dipping on a rising curve; tables apply per channel', () => {
  const id = curveTable([[0, 0], [255, 255]]);
  assert.equal(id[100], 100);
  const s = curveTable([[0, 0], [64, 40], [192, 220], [255, 255]]);
  assert.equal(s[64], 40);
  assert.equal(s[192], 220);
  for (let x = 1; x < 256; x++) assert.ok(s[x] >= s[x - 1], `rising at ${x}`);
  // A steep step between gentle parts: without shortened tangents the curve would bulge past 250 and come back down.
  const steep = curveTable([[0, 0], [100, 100], [105, 250], [255, 255]]);
  for (let x = 1; x < 256; x++) assert.ok(steep[x] >= steep[x - 1], `no overshoot at ${x}`);
  const p = solid(1, 1, [10, 20, 30, 77]);
  applyTable(p, curveTable([[0, 255], [255, 0]]), 'g');
  assert.deepEqual(px(p, 0, 0), [10, 235, 30, 77]);
});

test('hue / saturation / lightness, colour balance, threshold, posterise, desaturate', () => {
  const red = solid(1, 1, [255, 0, 0, 255]);
  hueSaturation(red, 120, 0, 0);
  assert.deepEqual(px(red, 0, 0), [0, 255, 0, 255], 'red turned a third of the way round is green');
  const grey = solid(1, 1, [100, 100, 100, 9]);
  hueSaturation(grey, 0, 0, 100);
  assert.deepEqual(px(grey, 0, 0), [255, 255, 255, 9]);
  const g2 = solid(1, 1, [200, 100, 50, 255]);
  hueSaturation(g2, 0, -100, 0);
  assert.equal(g2.data[0], g2.data[2]);
  const mid = solid(1, 1, [128, 128, 128, 255]);
  colourBalance(mid, { shadows: [0, 0, 0], midtones: [100, 0, -100], highlights: [0, 0, 0] });
  assert.ok(mid.data[0] > 150 && mid.data[2] < 100 && mid.data[1] === 128);
  const dark = solid(1, 1, [20, 20, 20, 255]);
  colourBalance(dark, { shadows: [0, 0, 0], midtones: [0, 0, 0], highlights: [100, 100, 100] });
  assert.ok(dark.data[0] < 25, 'highlights barely touch dark pixels');
  const th = solid(2, 1, [100, 100, 100, 255]);
  th.data.set([200, 200, 200, 255], 4);
  threshold(th, 128);
  assert.deepEqual([th.data[0], th.data[4]], [0, 255]);
  const po = solid(1, 1, [100, 140, 250, 255]);
  posterise(po, 2);
  assert.deepEqual(px(po, 0, 0), [0, 255, 255, 255]);
  const d = solid(1, 1, [255, 0, 0, 255]);
  desaturate(d, 'lightness');
  assert.equal(d.data[0], 128);
  const a = solid(1, 1, [255, 0, 0, 255]);
  desaturate(a, 'average');
  assert.equal(a.data[0], 85);
  const l = solid(1, 1, [255, 0, 0, 255]);
  desaturate(l, 'luminance');
  assert.equal(l.data[0], 54);
  const h = histogram(solid(3, 1, [10, 20, 30, 255]));
  assert.deepEqual([h.r[10], h.g[20], h.b[30], h.count], [3, 3, 3, 3]);
  assert.equal(histogram(solid(2, 1, [1, 2, 3, 0])).count, 0, 'see-through pixels are not counted');
});

// ---- Retouching ----

test('brush edge: hard inside, fading to nothing at the rim', () => {
  assert.equal(falloff(0, 10, 0.5), 1);
  assert.equal(falloff(5, 10, 0.5), 1);
  assert.ok(falloff(7.5, 10, 0.5) > 0.4 && falloff(7.5, 10, 0.5) < 0.6);
  assert.equal(falloff(10, 10, 0.5), 0);
  assert.equal(falloff(9.9, 10, 1), 1);
});

test('clone copies from the offset source; heal matches the brightness around it', () => {
  const p = solid(20, 10, [50, 50, 50, 255]);
  const src = solid(20, 10, [50, 50, 50, 255]);
  for (let y = 0; y < 10; y++) for (let x = 0; x < 5; x++) src.data.set([250, 0, 0, 255], (y * 20 + x) * 4);
  cloneDab(p, src, -12, 0, { x: 14.5, y: 5.5, radius: 2, hardness: 1, strength: 1 }, null);
  assert.deepEqual(px(p, 14, 5), [250, 0, 0, 255], 'copied from 12 to the left');
  assert.deepEqual(px(p, 18, 5), [50, 50, 50, 255], 'outside the dab untouched');
  // Heal: the copied pattern keeps its shape but takes on the destination's level.
  const dst = solid(20, 10, [200, 200, 200, 255]);
  const tex = solid(20, 10, [40, 40, 40, 255]);
  tex.data.set([60, 60, 60, 255], (5 * 20 + 3) * 4);
  healDab(dst, tex, -12, 0, { x: 15.5, y: 5.5, radius: 3, hardness: 1, strength: 1 }, null);
  const middle = px(dst, 15, 5)[0];
  const side = px(dst, 14, 5)[0];
  assert.ok(Math.abs(side - 200) <= 3, `healed level ${side}`);
  assert.ok(middle - side >= 18, 'the source pattern still shows');
  // A selection keeps the stamp out.
  const q = solid(20, 10, [50, 50, 50, 255]);
  cloneDab(q, src, -12, 0, { x: 14.5, y: 5.5, radius: 2, hardness: 1, strength: 1 }, new Uint8Array(200));
  assert.deepEqual(px(q, 14, 5), [50, 50, 50, 255]);
});

test('smudge drags colour along; dodge lightens, burn darkens; blur and sharpen', () => {
  const p = solid(20, 5, [0, 0, 0, 255]);
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) p.data.set([255, 255, 255, 255], (y * 20 + x) * 4);
  const carry = makeCarry(p, 3, 2, 3);
  for (let x = 3; x <= 9; x++) smudgeDab(p, carry, { x: x + 0.5, y: 2.5, radius: 3, hardness: 0.5, strength: 0.8 }, null);
  assert.ok(px(p, 7, 2)[0] > 40, `white dragged into black (${px(p, 7, 2)[0]})`);
  assert.equal(px(p, 18, 2)[0], 0);
  const d = solid(5, 5, [100, 100, 100, 255]);
  dodgeBurnDab(d, { x: 2.5, y: 2.5, radius: 2, hardness: 1, strength: 1 }, 'dodge', null);
  assert.ok(px(d, 2, 2)[0] > 150);
  dodgeBurnDab(d, { x: 2.5, y: 2.5, radius: 2, hardness: 1, strength: 1 }, 'burn', null);
  dodgeBurnDab(d, { x: 2.5, y: 2.5, radius: 2, hardness: 1, strength: 1 }, 'burn', null);
  assert.ok(px(d, 2, 2)[0] < 100);
  const b = solid(5, 5, [0, 0, 0, 255]);
  b.data.set([255, 255, 255, 255], (2 * 5 + 2) * 4);
  const s = { width: 5, height: 5, data: b.data.slice() };
  blurSharpenDab(b, { x: 2.5, y: 2.5, radius: 3, hardness: 1, strength: 1 }, 'blur', null);
  assert.ok(px(b, 2, 2)[0] < 255 && px(b, 1, 2)[0] > 0, 'spread out');
  const grey = solid(5, 5, [100, 100, 100, 255]);
  grey.data.set([140, 140, 140, 255], (2 * 5 + 2) * 4);
  blurSharpenDab(grey, { x: 2.5, y: 2.5, radius: 3, hardness: 1, strength: 1 }, 'sharpen', null);
  assert.ok(px(grey, 2, 2)[0] > 140 && px(grey, 1, 2)[0] < 100, 'edges pushed apart');
  void s;
});

test('dabs fall evenly along a stroke however the pointer moves', () => {
  const path = new DabPath(5);
  const first = path.to(0, 0);
  assert.deepEqual(first, [{ x: 0, y: 0 }]);
  const all = [...path.to(3, 0), ...path.to(7, 0), ...path.to(21, 0)];
  assert.deepEqual(all.map(p => p.x), [5, 10, 15, 20]);
  assert.deepEqual(path.to(21, 0), []);
});

// ---- Transform and text ----

test('transform handles: move, stretch from the opposite side, Shift keeps the shape, turn', () => {
  const b: Box = { cx: 50, cy: 50, w: 100, h: 50, angle: 0 };
  assert.equal(hitHandle(b, { x: 100, y: 75 }, 6), 'se');
  assert.equal(hitHandle(b, { x: 60, y: 55 }, 6), 'move');
  assert.equal(hitHandle(b, { x: 200, y: 200 }, 6), 'rotate');
  const moved = dragBox(b, 'move', { x: 0, y: 0 }, { x: 10, y: -5 }, false);
  assert.deepEqual([moved.cx, moved.cy], [60, 45]);
  const se = dragBox(b, 'se', { x: 100, y: 75 }, { x: 150, y: 75 }, false);
  assert.deepEqual([se.w, se.h, se.cx, se.cy], [150, 50, 75, 50], 'the top-left corner stays put');
  const keep = dragBox(b, 'se', { x: 100, y: 75 }, { x: 200, y: 80 }, true);
  assert.equal(keep.w / keep.h, 2, 'shape kept');
  const e = dragBox(b, 'e', { x: 100, y: 50 }, { x: 60, y: 90 }, false);
  assert.deepEqual([e.w, e.h], [60, 50]);
  const turned = dragBox(b, 'rotate', { x: 150, y: 50 }, { x: 50, y: 150 }, false);
  assert.ok(Math.abs(turned.angle - Math.PI / 2) < 1e-9);
  const snapped = dragBox(b, 'rotate', { x: 150, y: 50 }, { x: 150, y: 58 }, true);
  assert.equal(snapped.angle, 0, 'Shift turns in 15 degree steps');
  const bounds = boxBounds({ ...b, angle: Math.PI / 2 });
  assert.deepEqual([bounds.w, bounds.h], [50, 100]);
});

test('text lines: left, centre and right around x; bold italic font', () => {
  const t = { text: 'ab\nabcd', family: 'Serif', size: 20, colour: '#000000', bold: true, italic: true, align: 'center' as const, x: 100, y: 10 };
  const r = layoutText(t, s => s.length * 10);
  assert.deepEqual(r.lines.map(l => [l.x, l.y]), [[90, 10], [80, 35]]);
  assert.deepEqual(r.bounds, { x: 80, y: 10, w: 40, h: 50 });
  assert.deepEqual(layoutText({ ...t, align: 'right' }, s => s.length * 10).lines.map(l => l.x), [80, 60]);
  assert.match(fontOf(t), /^italic bold 20px Georgia/);
});
