// KerfLine's CAD menu (trim, extend, break, fillet, chamfer, offset, join, close, start point, reverse, explode) and
// areas, checked against answers worked out by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { P, TAU, dist, type Pt } from '../src/apps/cad/geom.ts';
import { pieceLength, piecesOf, rectangle, type Ent, type Shape } from '../src/apps/cad/model.ts';
import { distToShape } from '../src/apps/cad/edit.ts';
import {
  areaOf, breakAt, breakBetween, chamfer, closeShape, cornerBetween, explode, extend, fillet, join, offset, polyCorners, reverse, setStart, trim, turnOf,
} from '../src/apps/cad/modify.ts';

const TOL = 1e-6;
const near = (a: Pt, b: Pt, what: string, tol = TOL) => assert.ok(dist(a, b) <= tol, `${what}: expected ${b.x},${b.y}, got ${a.x},${a.y}`);
const close = (a: number, b: number, what: string, tol = TOL) => assert.ok(Math.abs(a - b) <= tol, `${what}: expected ${b}, got ${a}`);
const line = (a: Pt, b: Pt): Shape => ({ type: 'line', a, b });
const shapes = (r: Shape[] | string): Shape[] => {
  if (typeof r === 'string') throw new Error(r);
  return r;
};
const one = (r: Shape | string): Shape => {
  if (typeof r === 'string') throw new Error(r);
  return r;
};
const lengthOf = (s: Shape) => piecesOf(s).reduce((t, p) => t + pieceLength(p), 0);

test('trim: a line cut back to the lines crossing it, either side of the click', () => {
  const l = line(P(0, 0), P(100, 0));
  const cutters = [line(P(30, -10), P(30, 10)), line(P(70, -10), P(70, 10))];
  const middle = shapes(trim(l, P(50, 0), cutters));
  assert.equal(middle.length, 2, 'the middle taken out leaves two pieces');
  near((middle[0] as { b: Pt }).b, P(30, 0), 'first piece ends at the first cutter');
  near((middle[1] as { a: Pt }).a, P(70, 0), 'second starts at the second');
  const end = shapes(trim(l, P(90, 0), cutters));
  assert.equal(end.length, 1);
  near((end[0] as { b: Pt }).b, P(70, 0), 'the end beyond the last cutter is cut off');
  assert.equal(typeof trim(l, P(50, 0), []), 'string', 'nothing crossing: refused with a reason');
});

test('trim: a circle between two crossings, an arc and a closed polyline', () => {
  const c: Shape = { type: 'circle', c: P(0, 0), r: 10 };
  const across = [line(P(-20, 0), P(20, 0))];
  const top = shapes(trim(c, P(0, 10), across));
  assert.equal(top.length, 1);
  assert.equal(top[0].type, 'arc');
  if (top[0].type === 'arc') {
    close(top[0].a0, Math.PI, 'the bottom half is kept: from the left');
    close(top[0].a1, TAU, 'to the right');
  }
  // A 600 x 400 rectangle with a line across at x = 300: clicking the right side keeps a U from (300,400) round the left.
  const rect = rectangle(P(0, 0), P(600, 400))!;
  const u = shapes(trim(rect, P(600, 200), [line(P(300, -10), P(300, 410))]));
  assert.equal(u.length, 1);
  close(lengthOf(u[0]), 300 + 400 + 300, 'the left half of the outline is left', 1e-6);
  assert.ok(distToShape(u[0], P(0, 200)) < 1e-9 && distToShape(u[0], P(600, 200)) > 1);
});

test('break at a point and between two points', () => {
  const two = shapes(breakAt(line(P(0, 0), P(10, 0)), P(4, 0)));
  assert.equal(two.length, 2);
  near((two[0] as { b: Pt }).b, P(4, 0), 'split at 4');
  assert.equal(typeof breakAt({ type: 'circle', c: P(0, 0), r: 5 }, P(5, 0)), 'string', 'a circle needs two points');
  const gap = shapes(breakBetween(line(P(0, 0), P(10, 0)), P(7, 0), P(3, 0)));
  near((gap[0] as { b: Pt }).b, P(3, 0), 'kept up to 3');
  near((gap[1] as { a: Pt }).a, P(7, 0), 'and from 7');
  // A circle broken anticlockwise from the top to the left: the quarter between them goes.
  const arc = shapes(breakBetween({ type: 'circle', c: P(0, 0), r: 10 }, P(0, 10), P(-10, 0)));
  assert.equal(arc[0].type, 'arc');
  if (arc[0].type === 'arc') close(arc[0].a1 - arc[0].a0, 1.5 * Math.PI, 'three quarters kept');
});

test('extend: a line to the next line, an arc round to a line, a polyline end', () => {
  const l = one(extend(line(P(0, 0), P(10, 0)), P(9, 0), [line(P(50, -5), P(50, 5)), line(P(80, -5), P(80, 5))]));
  near((l as { b: Pt }).b, P(50, 0), 'stops at the first in the way');
  const back = one(extend(line(P(0, 0), P(10, 0)), P(1, 0), [line(P(-20, -5), P(-20, 5))]));
  near((back as { a: Pt }).a, P(-20, 0), 'the other end, backwards');
  assert.equal(typeof extend(line(P(0, 0), P(10, 0)), P(9, 0), []), 'string');
  // A quarter arc from 0 to 90 degrees, radius 10, extended anticlockwise to the line x = -5.
  const a = one(extend({ type: 'arc', c: P(0, 0), r: 10, a0: 0, a1: Math.PI / 2 }, P(0, 10), [line(P(-5, -20), P(-5, 20))]));
  if (a.type === 'arc') close(a.a1, (2 * Math.PI) / 3, 'reaches x = -5 at 120 degrees');
  const pl: Shape = { type: 'poly', pts: [P(0, 0), P(10, 0), P(10, 10)], bulges: [0, 0, 0], closed: false };
  const grown = one(extend(pl, P(10, 9), [line(P(-5, 30), P(20, 30))]));
  if (grown.type === 'poly') near(grown.pts[2], P(10, 30), 'the last side grows to y = 30');
});

test('fillet: two lines with a radius, a sharp corner, and the corners of a rectangle', () => {
  const r = fillet(line(P(0, 0), P(100, 0)), P(50, 0), line(P(0, 0), P(0, 100)), P(0, 50), 10);
  assert.ok(typeof r !== 'string');
  if (typeof r === 'string') return;
  near((r.first as { a: Pt }).a, P(10, 0), 'the bottom line starts where the round touches');
  near((r.second as { a: Pt }).a, P(0, 10), 'the side line too');
  assert.equal(r.added?.type, 'arc');
  if (r.added?.type === 'arc') {
    near(r.added.c, P(10, 10), 'round centre');
    close(r.added.a1 - r.added.a0, Math.PI / 2, 'a quarter round');
  }
  // Two lines that do not reach each other meet at a sharp corner with radius 0.
  const sharp = fillet(line(P(0, 0), P(8, 0)), P(2, 0), line(P(10, 2), P(10, 20)), P(10, 15), 0);
  if (typeof sharp === 'string') throw new Error(sharp);
  near((sharp.first as { a: Pt }).a, P(10, 0), 'the first stretched to the corner');
  near((sharp.second as { a: Pt }).a, P(10, 0), 'the second stretched to the corner');
  // A 600 x 400 rectangle with every corner rounded to R10: area 240000 - 4 x 100 x (1 - pi/4).
  const rect = rectangle(P(0, 0), P(600, 400))! as Extract<Shape, { type: 'poly' }>;
  const round = polyCorners(rect, { round: 10 });
  assert.equal(round.done, 4);
  close(areaOf(round.shape)!, 240000 - 400 * (1 - Math.PI / 4), 'area with rounded corners', 1e-6);
  close(lengthOf(round.shape), 2 * (580 + 380) + 2 * Math.PI * 10, 'outline length', 1e-9);
  // One corner only, picked by the two sides beside it.
  const corner = cornerBetween(rect, P(300, 0), P(600, 200));
  assert.equal(corner, 1, 'the bottom right corner');
  const just = polyCorners(rect, { round: 10 }, corner!);
  assert.equal(just.done, 1);
  // Too big a radius for the sides is left alone and counted.
  assert.equal(polyCorners(rect, { round: 1000 }).done, 0);
});

test('chamfer: two lines and the corners of a rectangle', () => {
  const r = chamfer(line(P(0, 0), P(100, 0)), P(50, 0), line(P(0, 0), P(0, 100)), P(0, 50), 5, 8);
  if (typeof r === 'string') throw new Error(r);
  near((r.added as { a: Pt }).a, P(5, 0), 'cut 5 along the first');
  near((r.added as { b: Pt }).b, P(0, 8), 'and 8 along the second');
  const rect = rectangle(P(0, 0), P(600, 400))! as Extract<Shape, { type: 'poly' }>;
  const cut = polyCorners(rect, { cut: [10, 10] });
  close(areaOf(cut.shape)!, 240000 - 4 * 50, 'four 10 x 10 triangles cut off');
});

test('offset: lines, circles, and a rounded rectangle in and out', () => {
  const l = one(offset(line(P(0, 0), P(100, 0)), 5, P(50, 20)));
  near((l as { a: Pt }).a, P(0, 5), 'moved up towards the click');
  const c = one(offset({ type: 'circle', c: P(0, 0), r: 20 }, 5, P(0, 0)));
  close((c as { r: number }).r, 15, 'inside a circle');
  assert.equal(typeof offset({ type: 'circle', c: P(0, 0), r: 4 }, 5, P(0, 0)), 'string', 'too far inside');
  assert.equal(typeof offset({ type: 'ellipse', c: P(0, 0), m: P(10, 0), ratio: 0.5, t0: 0, t1: TAU }, 1, P(0, 0)), 'string', 'ellipses refused with a reason');
  const rounded = polyCorners(rectangle(P(0, 0), P(600, 400))! as Extract<Shape, { type: 'poly' }>, { round: 10 }).shape;
  // 5 mm in: a 590 x 390 rectangle with R5 corners.
  const inner = one(offset(rounded, 5, P(300, 200)));
  close(areaOf(inner)!, 590 * 390 - 4 * 25 * (1 - Math.PI / 4), 'area 5 in', 1e-6);
  for (const q of [P(5, 200), P(300, 5), P(595, 200), P(300, 395)]) assert.ok(distToShape(inner, q) < 1e-9, `on the inner outline at ${q.x},${q.y}`);
  // 5 mm out: 610 x 410 with R15 corners.
  const outer = one(offset(rounded, 5, P(-50, -50)));
  close(areaOf(outer)!, 610 * 410 - 4 * 225 * (1 - Math.PI / 4), 'area 5 out', 1e-6);
  // A square 10 x 10 offset 6 inwards folds over itself: refused.
  assert.equal(typeof offset(rectangle(P(0, 0), P(10, 10))!, 6, P(5, 5)), 'string', 'folds over itself');
  // An open L offset outwards: the corner stays sharp, the sides keep their length plus the offset.
  const L = one(offset({ type: 'poly', pts: [P(0, 0), P(10, 0), P(10, 10)], bulges: [0, 0, 0], closed: false }, 1, P(5, -5)));
  if (L.type === 'poly') near(L.pts[1], P(11, -1), 'the outside corner');
});

test('join lines and arcs end to end into a closed geometry, then explode it back', () => {
  // A slot drawn as two lines and two half arcs, out of order and with one line backwards.
  const ents: Ent[] = [
    { id: 1, layer: 'G', type: 'arc', c: P(40, 0), r: 5, a0: -Math.PI / 2, a1: Math.PI / 2 },
    { id: 2, layer: 'G', type: 'line', a: P(0, -5), b: P(40, -5) },
    { id: 3, layer: 'G', type: 'arc', c: P(0, 0), r: 5, a0: Math.PI / 2, a1: (3 * Math.PI) / 2 },
    { id: 4, layer: 'G', type: 'line', a: P(0, 5), b: P(40, 5) },
    { id: 5, layer: 'G', type: 'ellipse', c: P(100, 100), m: P(5, 0), ratio: 0.5, t0: 0, t1: TAU },
  ];
  const { made, leftOut } = join(ents);
  assert.equal(leftOut, 1, 'the ellipse is not joined');
  assert.equal(made.length, 1);
  const g = made[0].shape;
  assert.ok(g.type === 'poly' && g.closed, 'one closed geometry');
  close(areaOf(g)!, 40 * 10 + Math.PI * 25, 'the slot area', 1e-6);
  close(lengthOf(g), 80 + 2 * Math.PI * 5, 'its length', 1e-9);
  const parts = shapes(explode(g));
  assert.equal(parts.length, 4);
  assert.equal(parts.filter(p => p.type === 'arc').length, 2);
});

test('close, set the start point, reverse, and which way a shape runs', () => {
  const open: Shape = { type: 'poly', pts: [P(0, 0), P(10, 0), P(10, 10)], bulges: [0, 0, 0], closed: false };
  const shut = one(closeShape(open));
  assert.ok(shut.type === 'poly' && shut.closed);
  close(areaOf(shut)!, 50, 'a right triangle');
  const rect = rectangle(P(0, 0), P(600, 400))! as Extract<Shape, { type: 'poly' }>;
  assert.equal(turnOf(rect), 1, 'drawn anticlockwise');
  const back = one(reverse(rect)) as Extract<Shape, { type: 'poly' }>;
  assert.equal(turnOf(back), -1, 'reversed: clockwise');
  near(back.pts[0], rect.pts[0], 'the same start');
  const rounded = polyCorners(rect, { round: 10 }).shape as Extract<Shape, { type: 'poly' }>;
  const rb = one(reverse(rounded)) as Extract<Shape, { type: 'poly' }>;
  close(areaOf(rb)!, areaOf(rounded)!, 'reversing keeps the area', 1e-9);
  assert.equal(turnOf(rb), -1);
  // Start at the middle of the top side: a new corner there, the same shape.
  const started = one(setStart(rect, P(300, 400))) as Extract<Shape, { type: 'poly' }>;
  near(started.pts[0], P(300, 400), 'starts at the middle of the top');
  close(areaOf(started)!, 240000, 'same area');
  assert.equal(started.pts.length, 5);
  const atCorner = one(setStart(rect, P(600, 400))) as Extract<Shape, { type: 'poly' }>;
  near(atCorner.pts[0], P(600, 400), 'a corner becomes the start');
  assert.equal(atCorner.pts.length, 4);
});

test('every piece of a filleted, offset, trimmed shape is a real line or arc', () => {
  const rounded = polyCorners(rectangle(P(0, 0), P(600, 400))! as Extract<Shape, { type: 'poly' }>, { round: 10 }).shape;
  const inner = one(offset(rounded, 5, P(300, 200)));
  for (const p of piecesOf(inner)) {
    if (p.k === 'arc') close(p.r, 5, 'inner corners are R5', 1e-9);
  }
});
