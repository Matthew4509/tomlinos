// KerfLine: straightening a photo taken at a slant. Four corners of a rectangle lying flat in the photo and its real
// width and height redraw the picture square and to scale. The photos here are made up: a known perspective takes a
// real rectangle into the picture, so where every point must land afterwards is known exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { P, dist, type Pt } from '../src/apps/cad/geom.ts';
import { m3apply, pixelToDrawing, planStraighten, readPhoto, scalePhoto, turnPhoto, warpPixels, type M3, type Photo, type StraightenPlan } from '../src/apps/cad/photo.ts';

const near = (a: Pt, b: Pt, what: string, tol = 1e-6) => assert.ok(dist(a, b) <= tol, `${what}: expected ${b.x},${b.y}, got ${a.x},${a.y}`);
const photo = (o: Partial<Photo> = {}): Photo => ({ jpeg: 'AAAA', px: 400, py: 300, at: P(0, 0), u: P(400, 0), opacity: 0.5, on: true, name: 'bench.jpg', ...o });

/** A camera's view: a point on the flat surface (mm) to the picture's pixels (j down). Made up, but a true perspective. */
const camera: M3 = [1.1, 0.25, 60, 0.08, -0.9, 260, 0.0004, 0.0011, 1];
const shot = (p: Pt) => m3apply(camera, p)!;
/** The picture's pixel to the drawing, for the photo as placed by photo(): 1 mm a pixel, y up. */
const onDrawing = (ph: Photo, px: Pt) => m3apply(pixelToDrawing(ph), px)!;

/** The 200 x 100 benchtop's corners as clicked on the drawing (in order round it, starting at its 0,0 corner). */
const W = 200;
const H = 100;
const bench = [P(0, 0), P(W, 0), P(W, H), P(0, H)];

function planOf(ph: Photo, corners: Pt[], w = W, h = H): StraightenPlan {
  const p = planStraighten(ph, corners, w, h);
  if (typeof p === 'string') throw new Error(p);
  return p;
}
/** Where a drawing point is in the new picture's pixels. */
function newPixel(plan: StraightenPlan, d: Pt): Pt {
  const r = plan.px / Math.hypot(plan.u.x, plan.u.y);
  return P((d.x - plan.at.x) * r, (plan.at.y + plan.py / r - d.y) * r);
}

test('straighten: the four corners land on a true W x H rectangle, and so does every point between them', () => {
  const ph = photo();
  const clicks = bench.map(p => onDrawing(ph, shot(p)));
  const plan = planOf(ph, clicks);
  const c0 = clicks[0];
  // The rectangle starts at the first corner; its first side was clicked left to right, so it runs straight across.
  const expect = (p: Pt) => P(c0.x + p.x, c0.y + p.y);
  for (const p of [...bench, P(W / 2, H / 2), P(37, 81), P(180, 5)]) {
    // That point of the benchtop is where the new picture shows the old picture's pixel of it.
    near(m3apply(plan.back, newPixel(plan, expect(p)))!, shot(p), `benchtop point ${p.x},${p.y}`, 1e-6);
  }
  // Square to the drawing: the new picture is not turned.
  assert.equal(plan.u.y, 0);
  assert.ok(plan.px <= 3000 && plan.py <= 3000);
});

test('straighten: clicked the other way round or starting at another corner, the picture is turned, never turned over', () => {
  const ph = photo();
  const cases = [
    { order: [0, 3, 2, 1], w: H, h: W },
    { order: [2, 3, 0, 1], w: W, h: H },
    { order: [1, 2, 3, 0], w: H, h: W },
  ];
  for (const c of cases) {
    const clicks = c.order.map(i => onDrawing(ph, shot(bench[i])));
    const plan = planOf(ph, clicks, c.w, c.h);
    // Old pixel -> new pixel -> drawing keeps the picture's handedness (an unflipped photo has y up, pixels down).
    const toNew = (q: Pt) => {
      const inv = invert(plan.back);
      return m3apply(pixelToDrawing({ ...ph, ...plan, jpeg: 'AAAA' }), m3apply(inv, q)!)!;
    };
    const o = shot(P(W / 2, H / 2));
    const a = toNew(o);
    const b = toNew(P(o.x + 1, o.y));
    const d = toNew(P(o.x, o.y + 1));
    const det = (b.x - a.x) * (d.y - a.y) - (b.y - a.y) * (d.x - a.x);
    assert.ok(det < 0, `order ${c.order}: not turned over (det ${det})`);
    // The first side runs straight across or straight up, as long as the width typed.
    const s0 = toNew(shot(bench[c.order[0]]));
    const s1 = toNew(shot(bench[c.order[1]]));
    assert.ok(Math.abs(s0.x - s1.x) < 1e-6 || Math.abs(s0.y - s1.y) < 1e-6, `order ${c.order}: first side square to the drawing`);
    assert.ok(Math.abs(dist(s0, s1) - c.w) < 1e-6, `order ${c.order}: first side ${dist(s0, s1)} long`);
  }
});

function invert(m: M3): M3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A / det, (c * h - b * i) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, (c * d - a * f) / det, C / det, (b * g - a * h) / det, (a * e - b * d) / det];
}

test('straighten: corners that do not go round a rectangle, or no size, are refused in words', () => {
  const ph = photo();
  const c = bench.map(p => onDrawing(ph, shot(p)));
  assert.match(planStraighten(ph, [c[0], c[2], c[1], c[3]], W, H) as string, /in order round its edge/);
  assert.match(planStraighten(ph, [c[0], c[1], P((c[1].x + c[0].x) / 2, (c[1].y + c[0].y) / 2), c[3]], W, H) as string, /do not make a rectangle/);
  assert.match(planStraighten(ph, [c[0], c[0], c[0], c[0]], W, H) as string, /do not make a rectangle/);
  assert.match(planStraighten(ph, c, 0, H) as string, /above 0/);
  assert.match(planStraighten(ph, c, W, Number.NaN) as string, /above 0/);
  assert.match(planStraighten(ph, c.slice(0, 3), W, H) as string, /four corners/);
});

test('straighten: a photo scaled and turned on the drawing first gives the same rectangle', () => {
  const plain = photo();
  const moved = turnPhoto(scalePhoto(plain, P(0, 0), 2.5), P(30, 40), 0.3);
  const a = planOf(plain, bench.map(p => onDrawing(plain, shot(p))));
  const b = planOf(moved, bench.map(p => onDrawing(moved, shot(p))));
  // The same old pixels end up at the same place on the rectangle (relative to its first corner).
  const c0a = onDrawing(plain, shot(bench[0]));
  const c0b = onDrawing(moved, shot(bench[0]));
  for (const p of [P(W / 2, H / 2), P(10, 90)]) {
    near(m3apply(a.back, newPixel(a, P(c0a.x + p.x, c0a.y + p.y)))!, shot(p), 'plain');
    near(m3apply(b.back, newPixel(b, P(c0b.x + p.x, c0b.y + p.y)))!, shot(p), 'scaled and turned');
  }
});

test('straighten: the outline of what the photo filled is kept, and the blank rest is left out on screen', () => {
  const ph = photo();
  const plan = planOf(ph, bench.map(p => onDrawing(ph, shot(p))));
  assert.ok(plan.clip && plan.clip.length >= 3, 'a slanted photo does not fill a rectangle: it has an outline');
  // Every outline corner is inside the new picture.
  for (const p of plan.clip!) assert.ok(p.x >= -0.01 && p.y >= -0.01 && p.x <= plan.px + 0.01 && p.y <= plan.py + 0.01);
  // The outline is kept in the file, and moves with the photo (it is in the picture's own pixels).
  const kept = readPhoto(JSON.parse(JSON.stringify({ ...ph, ...plan, jpeg: 'AAAA' })))!;
  assert.deepEqual(kept.clip, plan.clip);
  assert.deepEqual(turnPhoto(kept, P(0, 0), 1).clip, plan.clip);
  // A damaged outline is left out, not the photo.
  const damaged = readPhoto({ ...ph, clip: [P(0, 0), { x: 'x', y: 1 }, P(5, 5)] })!;
  assert.ok(damaged && !damaged.clip);
  // A photo already square on fills its rectangle: no outline.
  const square = planOf(ph, [P(100, 100), P(300, 100), P(300, 200), P(100, 200)]);
  assert.equal(square.clip, undefined);
});

test('straighten: the far side near the horizon is cut off within reach of the rectangle', () => {
  // A steep camera: the top of the picture runs off to the horizon.
  const steep: M3 = [1, 0.4, 150, 0, -0.2, 280, 0, 0.0045, 1];
  const ph = photo();
  const clicks = [P(0, 0), P(60, 0), P(60, 40), P(0, 40)].map(p => onDrawing(ph, m3apply(steep, p)!));
  const plan = planOf(ph, clicks, 60, 40);
  const width = Math.hypot(plan.u.x, plan.u.y);
  const height = (width * plan.py) / plan.px;
  // At most 8 times the rectangle's longer side past it on every side: (1 + 2 x 8) x 60.
  assert.ok(width <= 17 * 60 + 1e-6 && height <= 17 * 60 + 1e-6, `${width} x ${height}`);
  assert.ok(Number.isFinite(width) && Number.isFinite(height));
});

test('warpPixels: the same picture through no change, and white where the photo does not reach', () => {
  // 2 x 2: red, green / blue, white.
  const src = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
  const same = warpPixels(src, 2, 2, [1, 0, 0, 0, 1, 0, 0, 0, 1], 2, 2);
  assert.deepEqual([...same], [...src]);
  // Moved 3 pixels left: nothing of it is in the new picture.
  const off = warpPixels(src, 2, 2, [1, 0, 3, 0, 1, 0, 0, 0, 1], 2, 2);
  assert.ok([...off].every(v => v === 255));
});

test('straighten end to end: a dark benchtop in a slanted photo comes out a dark rectangle of the right size', () => {
  // The photo: white, with the benchtop shot through the camera filled dark.
  const sw = 400;
  const sh = 300;
  const src = new Uint8ClampedArray(sw * sh * 4).fill(255);
  const toBench = invert(camera);
  for (let j = 0; j < sh; j++) {
    for (let i = 0; i < sw; i++) {
      const p = m3apply(toBench, P(i + 0.5, j + 0.5))!;
      if (p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H) src.fill(20, (j * sw + i) * 4, (j * sw + i) * 4 + 3);
    }
  }
  const ph = photo();
  const clicks = bench.map(p => onDrawing(ph, shot(p)));
  const plan = planOf(ph, clicks);
  const out = warpPixels(src, sw, sh, plan.back, plan.px, plan.py);
  const c0 = clicks[0];
  const shade = (p: Pt) => {
    const q = newPixel(plan, P(c0.x + p.x, c0.y + p.y));
    return out[(Math.floor(q.y) * plan.px + Math.floor(q.x)) * 4];
  };
  // Just inside each corner and the middle: dark. Just outside each side: white.
  for (const p of [P(6, 6), P(W - 6, 6), P(W - 6, H - 6), P(6, H - 6), P(W / 2, H / 2)]) assert.ok(shade(p) < 60, `inside at ${p.x},${p.y}: ${shade(p)}`);
  for (const p of [P(-6, H / 2), P(W + 6, H / 2), P(W / 2, -6), P(W / 2, H + 6)]) assert.ok(shade(p) > 200, `outside at ${p.x},${p.y}: ${shade(p)}`);
});

test('the straighten tool: four corners and a size; corners across the shape start it again', async () => {
  const { TOOLS } = await import('../src/apps/cad/tools.ts');
  const ph = photo();
  const problems: string[] = [];
  const asked: Array<{ corners: Pt[]; w: number; h: number }> = [];
  const ctx = {
    units: () => 'mm' as const, ents: () => [], visible: () => [], selection: () => [], select() {}, add() {}, change() {},
    say() {}, problem: (t: string) => void problems.push(t), fmt: (v: number) => String(v),
    list() {}, zoomTo() {}, askPolar: async () => null, askText: async () => null, askDim: async () => null,
    style: () => ({ textH: 5, dimH: 3.5, arrow: 3, dp: 1 }), noteLayer: () => 'Text', finished() {},
    photo: () => ph, setPhoto() {}, straightenPhoto: (corners: Pt[], w: number, h: number) => void asked.push({ corners, w, h }), placePart() {}, savePart() {},
  };
  const c = bench.map(p => onDrawing(ph, shot(p)));
  const t = TOOLS['photo-square'].make(ctx);
  assert.match(t.prompt(), /1st corner/);
  for (const p of [c[0], c[2], c[1], c[3]]) t.point!(p);
  assert.ok(t.want().size, 'then the width and height');
  t.size!(W, H);
  assert.match(problems.at(-1)!, /Start again from the 1st corner/);
  assert.match(t.prompt(), /1st corner/);
  assert.equal(asked.length, 0);
  for (const p of c) t.point!(p);
  t.size!(W, H);
  assert.ok(t.done);
  assert.deepEqual(asked, [{ corners: c, w: W, h: H }]);
});
