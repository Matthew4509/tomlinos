// KerfLine's geometry, typed input, snaps, edits, tools and .tcad file, checked against answers worked out by hand.
// Sizes must come out right to far better than a thousandth of a millimetre.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  P, TAU, arcThrough, at, bulgeArc, circleTTR, circleTTT, curveThrough, dist, intersect, nearestOn, perpFeet, pieceBox, tangentLines, tangentPoints,
  type Piece, type Pt,
} from '../src/apps/cad/geom.ts';
import { parseNumber, parsePoint, parseSize } from '../src/apps/cad/input.ts';
import { CadProblem, ellipse, newDrawing, piecesOf, polygon, readTcad, rectangle, slot, snapPoints, writeTcad, type Ent, type Shape } from '../src/apps/cad/model.ts';
import { chainFrom, distToShape, inWindow, mirrorShape, rotateShape, scaleShape, touchesBox } from '../src/apps/cad/edit.ts';
import { findSnaps } from '../src/apps/cad/snap.ts';
import { TOOLS, type PolarAnswer, type ToolCtx } from '../src/apps/cad/tools.ts';
import { defaultStyle, dimLabel, type DimShape, type TextShape } from '../src/apps/cad/notes.ts';
import type { Photo } from '../src/apps/cad/photo.ts';

const TOL = 1e-6;
const near = (a: Pt, b: Pt, what: string, tol = TOL) => assert.ok(dist(a, b) <= tol, `${what}: expected ${b.x},${b.y}, got ${a.x},${a.y}`);
const close = (a: number, b: number, what: string, tol = TOL) => assert.ok(Math.abs(a - b) <= tol, `${what}: expected ${b}, got ${a}`);
const seg = (a: Pt, b: Pt): Piece => ({ k: 'seg', a, b });
const circ = (c: Pt, r: number): Piece => ({ k: 'arc', c, r, a0: 0, a1: TAU });
const ell = (c: Pt, a: number, b: number, turn = 0): Piece => ({ k: 'ell', c, m: P(a * Math.cos(turn), a * Math.sin(turn)), ratio: b / a, t0: 0, t1: TAU });
const sorted = (pts: Pt[]) => [...pts].sort((a, b) => a.x - b.x || a.y - b.y);

test('typed numbers, points and sizes', () => {
  assert.equal(parseNumber('600/2+15'), 315);
  assert.equal(parseNumber('(35+5)*2'), 80);
  assert.equal(parseNumber('-12.5'), -12.5);
  assert.equal(parseNumber('2e3'), 2000);
  assert.equal(parseNumber('3+'), null);
  assert.equal(parseNumber('alert(1)'), null);
  assert.equal(parseNumber(''), null);
  near((parsePoint('600,400', null) as { p: Pt }).p, P(600, 400), 'absolute');
  near((parsePoint('@10,-5', P(1, 1)) as { p: Pt }).p, P(11, -4), 'relative');
  near((parsePoint('@100<90', P(5, 5)) as { p: Pt }).p, P(5, 105), 'polar relative');
  near((parsePoint('50<180', null) as { p: Pt }).p, P(-50, 0), 'polar absolute');
  near((parsePoint('@', P(3, 4)) as { p: Pt }).p, P(3, 4), 'the last point');
  near((parsePoint('(10+2)*2,600/3', null) as { p: Pt }).p, P(24, 200), 'sums inside a point');
  assert.ok('problem' in (parsePoint('@5,5', null) as object), 'no last point for @');
  assert.ok('problem' in (parsePoint('5,x', null) as object), 'not a number');
  assert.equal(parsePoint('35', null), null, 'a lone number is not a point');
  assert.deepEqual(parseSize('600,400'), { w: 600, h: 400 });
  assert.equal(parseSize('@600,400'), null);
});

test('lines, circles and arcs cross where worked out by hand', () => {
  near(intersect(seg(P(0, 0), P(10, 10)), seg(P(0, 10), P(10, 0)))[0], P(5, 5), 'two lines');
  assert.equal(intersect(seg(P(0, 0), P(1, 1)), seg(P(2, 0), P(3, 1))).length, 0, 'parallel lines');
  assert.equal(intersect(seg(P(0, 0), P(4, 4)), seg(P(0, 10), P(10, 0))).length, 0, 'short of the crossing');
  assert.deepEqual(sorted(intersect(seg(P(-20, 0), P(20, 0)), circ(P(0, 0), 10))).map(p => [Math.round(p.x * 1e9) / 1e9, p.y]), [[-10, 0], [10, 0]]);
  near(intersect(seg(P(-20, 10), P(20, 10)), circ(P(0, 0), 10))[0], P(0, 10), 'a line touching a circle');
  const cc = sorted(intersect(circ(P(0, 0), 5), circ(P(8, 0), 5)));
  near(cc[0], P(4, -3), 'two circles, lower');
  near(cc[1], P(4, 3), 'two circles, upper');
  // An arc only over the top half: the lower crossing is not on it.
  const top: Piece = { k: 'arc', c: P(0, 0), r: 5, a0: 0, a1: Math.PI };
  assert.equal(intersect(top, circ(P(8, 0), 5)).length, 1, 'only on the drawn part of an arc');
});

test('ellipses cross lines, circles and each other exactly', () => {
  // x^2/100 + y^2/25 = 1 met by y = 3: x = +-8.
  const e = ell(P(0, 0), 10, 5);
  const xs = sorted(intersect(seg(P(-20, 3), P(20, 3)), e));
  near(xs[0], P(-8, 3), 'line and ellipse, left');
  near(xs[1], P(8, 3), 'line and ellipse, right');
  // The same ellipse turned a quarter, moved to (100, 50): a vertical line x = 103 meets it at y = 50 +- 8.
  const turned = ell(P(100, 50), 10, 5, Math.PI / 2);
  const ys = sorted(intersect(seg(P(103, 0), P(103, 100)), turned));
  near(ys[0], P(103, 42), 'turned ellipse, lower');
  near(ys[1], P(103, 58), 'turned ellipse, upper');
  // With a circle of radius 5 round the centre: x^2/100 + (25 - x^2)/25 = 1 gives x = 0, y = +-5 (touching).
  const touch = intersect(e, circ(P(0, 0), 5));
  assert.equal(touch.length, 2, 'touches the circle twice');
  for (const p of touch) close(Math.abs(p.y), 5, 'touch point');
  // A circle of radius 8 round the centre: x^2/100 + (64 - x^2)/25 = 1 -> x^2 = 52.
  const four = intersect(circ(P(0, 0), 8), e);
  assert.equal(four.length, 4, 'four crossings with the larger circle');
  for (const p of four) {
    close(Math.abs(p.x), Math.sqrt(52), 'x of the crossing', 1e-9);
    close(Math.abs(p.y), Math.sqrt(12), 'y of the crossing', 1e-9);
  }
  // Two ellipses, one turned a quarter: by symmetry they cross on the diagonals, where x^2 (1/100 + 1/25) = 1.
  const both = intersect(e, ell(P(0, 0), 10, 5, Math.PI / 2));
  assert.equal(both.length, 4, 'two ellipses cross four times');
  for (const p of both) close(Math.abs(p.x), Math.sqrt(20), 'ellipse and ellipse', 1e-9);
});

test('curves through points pass through them, and cross lines', () => {
  const fit = [P(0, 0), P(10, 8), P(20, 0), P(30, 6)];
  const pieces = curveThrough(fit, false);
  assert.equal(pieces.length, 3);
  near(at(pieces[0], 0), fit[0], 'starts at the first point');
  near(at(pieces[1], 0), fit[1], 'goes through the second');
  near(at(pieces[2], 1), fit[3], 'ends at the last');
  const xs = pieces.flatMap(p => intersect(p, seg(P(-5, 4), P(40, 4))));
  assert.ok(xs.length >= 3, 'the line y = 4 crosses it at least three times');
  for (const q of xs) close(q.y, 4, 'on the line', 1e-9);
  // Closed: the last span comes back to the first point.
  const loop = curveThrough([P(0, 0), P(10, 0), P(10, 10), P(0, 10)], true);
  assert.equal(loop.length, 4);
  near(at(loop[3], 1), P(0, 0), 'closed back to the start');
});

test('nearest points, perpendicular feet and tangent points', () => {
  near(nearestOn(seg(P(0, 0), P(10, 0)), P(4, 7)), P(4, 0), 'nearest on a line');
  near(nearestOn(seg(P(0, 0), P(10, 0)), P(14, 7)), P(10, 0), 'nearest past the end');
  near(nearestOn(circ(P(0, 0), 10), P(0, 20)), P(0, 10), 'nearest on a circle');
  near(nearestOn(ell(P(0, 0), 10, 5), P(0, 9)), P(0, 5), 'nearest on an ellipse', 1e-7);
  near(perpFeet(seg(P(0, 0), P(10, 0)), P(3, 9))[0], P(3, 0), 'perpendicular foot');
  // From (20, 0) to a circle of radius 10 at the origin: touching at (5, +-8.660...).
  const t = sorted(tangentPoints(circ(P(0, 0), 10), P(20, 0)));
  near(t[0], P(5, -Math.sqrt(75)), 'tangent point, lower');
  near(t[1], P(5, Math.sqrt(75)), 'tangent point, upper');
  // From (0, 20) to the ellipse x^2/100 + y^2/25 = 1: the touching points have y = 25/20 = 1.25.
  const te = tangentPoints(ell(P(0, 0), 10, 5), P(0, 20));
  assert.equal(te.length, 2);
  for (const q of te) close(q.y, 1.25, 'tangent to the ellipse', 1e-9);
});

test('lines touching two circles, and circles touching two or three items', () => {
  const lines = tangentLines(P(0, 0), 10, P(50, 0), 10);
  assert.equal(lines.length, 4, 'two outside and two crossing between');
  for (const [a, b] of lines) {
    // Each line touches both: its distance from each centre is the radius.
    const d = (c: Pt) => Math.abs((b.x - a.x) * (a.y - c.y) - (a.x - c.x) * (b.y - a.y)) / dist(a, b);
    close(d(P(0, 0)), 10, 'touches the first');
    close(d(P(50, 0)), 10, 'touches the second');
  }
  // A radius 10 circle in the corner of two lines meeting at the origin.
  const corner = circleTTR(seg(P(0, 0), P(100, 0)), seg(P(0, 0), P(0, 100)), 10, P(20, 0), P(0, 20));
  assert.ok(corner && corner !== 'shape');
  near(corner.c, P(10, 10), 'corner circle centre');
  near(corner.touch[0], P(10, 0), 'touches the bottom line');
  near(corner.touch[1], P(0, 10), 'touches the side line');
  assert.equal(circleTTR(ell(P(0, 0), 10, 5), seg(P(0, 0), P(1, 0)), 1, P(0, 0), P(0, 0)), 'shape', 'ellipses are refused');
  // The circle inside the 3-4-5 triangle: radius 1, centre (1, 1).
  const inner = circleTTT([seg(P(0, 0), P(4, 0)), seg(P(0, 0), P(0, 3)), seg(P(4, 0), P(0, 3))], [P(1, 0), P(0, 1), P(1.6, 1.8)]);
  assert.ok(inner && inner !== 'shape');
  near(inner.c, P(1, 1), 'inscribed centre', 1e-9);
  close(inner.r, 1, 'inscribed radius', 1e-9);
});

test('arcs from three points and polyline bulges run the right way', () => {
  const a = arcThrough(P(10, 0), P(0, 10), P(-10, 0))!;
  near(a.c, P(0, 0), 'centre');
  close(a.r, 10, 'radius');
  close(a.a0, 0, 'starts at 0');
  close(a.a1, Math.PI, 'ends at half a turn');
  // Through the bottom instead: the arc runs anticlockwise from the left end to the right end.
  const b = arcThrough(P(10, 0), P(0, -10), P(-10, 0))!;
  close(b.a0, Math.PI, 'bottom arc starts at the left');
  close(b.a1, 2 * Math.PI, 'and ends at the right');
  // Bulge 1 is a half circle to the left of the chord when it turns anticlockwise.
  const half = bulgeArc(P(0, 0), P(10, 0), 1);
  near(half.c, P(5, 0), 'half circle centre');
  close(half.r, 5, 'half circle radius');
  near(at(half, (half.a0 + half.a1) / 2), P(5, -5), 'bulges below a chord running right (anticlockwise turn)');
});

test('rectangles, rounded rectangles, polygons, slots and ellipses', () => {
  const r = rectangle(P(0, 0), P(600, 400))!;
  assert.equal(r.type, 'poly');
  const boxes = piecesOf(r).map(p => pieceBox(p)!);
  const box = { x0: Math.min(...boxes.map(b => b.x0)), y0: Math.min(...boxes.map(b => b.y0)), x1: Math.max(...boxes.map(b => b.x1)), y1: Math.max(...boxes.map(b => b.y1)) };
  assert.deepEqual(box, { x0: 0, y0: 0, x1: 600, y1: 400 });
  const rr = rectangle(P(0, 0), P(600, 400), 10)!;
  const arcs = piecesOf(rr).filter(p => p.k === 'arc') as Array<Extract<Piece, { k: 'arc' }>>;
  assert.equal(arcs.length, 4, 'four rounded corners');
  for (const a of arcs) close(a.r, 10, 'corner radius');
  near(arcs[0].c, P(590, 10), 'first corner centre');
  const hex = polygon(P(0, 0), 6, 50, P(50, 0), true)!;
  assert.equal(hex.type === 'poly' && hex.pts.length, 6);
  if (hex.type === 'poly') for (const p of hex.pts) close(dist(p, P(0, 0)), 50, 'corners on the circle');
  const flats = polygon(P(0, 0), 4, 10, P(10, 0), false)!;
  if (flats.type === 'poly') for (const p of piecesOf(flats)) close(dist(nearestOn(p, P(0, 0)), P(0, 0)), 10, 'flats touch the circle');
  const s = slot(P(0, 0), P(40, 0), 10)!;
  const sp = piecesOf(s);
  assert.equal(sp.filter(p => p.k === 'arc').length, 2, 'two round ends');
  for (const p of sp) if (p.k === 'arc') close(p.r, 5, 'end radius');
  const e = ellipse(P(0, 0), P(0, 20), 50)!;
  assert.equal(e.type, 'ellipse');
  if (e.type === 'ellipse') {
    close(Math.hypot(e.m.x, e.m.y), 50, 'the longer half-axis is the main one');
    close(e.ratio, 0.4, 'ratio');
  }
});

test('mirroring, rotating and scaling keep every point where it should be', () => {
  const shapes: Shape[] = [
    { type: 'arc', c: P(10, 5), r: 4, a0: 0.3, a1: 2.1 },
    { type: 'ellipse', c: P(-3, 7), m: P(6, 2), ratio: 0.5, t0: 0.4, t1: 3.9 },
    { type: 'poly', pts: [P(0, 0), P(10, 0), P(10, 5)], bulges: [0.4, -0.7, 0], closed: false },
    { type: 'spline', fit: [P(0, 0), P(5, 5), P(9, 1)], closed: false },
  ];
  const a = P(1, 2);
  const b = P(4, 9);
  const reflect = (p: Pt) => {
    const d = { x: (b.x - a.x) / dist(a, b), y: (b.y - a.y) / dist(a, b) };
    const v = { x: p.x - a.x, y: p.y - a.y };
    const k = v.x * d.x + v.y * d.y;
    return P(a.x + 2 * k * d.x - v.x, a.y + 2 * k * d.y - v.y);
  };
  const along = (s: Shape) => piecesOf(s).flatMap(p => [0, 0.25, 0.5, 0.75, 1].map(f => {
    const [lo, hi] = p.k === 'arc' ? [p.a0, p.a1] : p.k === 'ell' ? [p.t0, p.t1] : [0, 1];
    return at(p, lo + (hi - lo) * f);
  }));
  for (const s of shapes) {
    const m = mirrorShape(s, a, b);
    // Every point of the mirrored shape is the mirror of a point on the first, and the other way round.
    for (const q of along(m)) assert.ok(distToShape(s, reflect(q)) < 1e-9, `${s.type} mirrored`);
    for (const q of along(s)) assert.ok(distToShape(m, reflect(q)) < 1e-9, `${s.type} mirrored back`);
    const r = rotateShape(s, P(2, 3), 1.1);
    const turn = (p: Pt) => P(2 + (p.x - 2) * Math.cos(1.1) - (p.y - 3) * Math.sin(1.1), 3 + (p.x - 2) * Math.sin(1.1) + (p.y - 3) * Math.cos(1.1));
    for (const q of along(s)) assert.ok(distToShape(r, turn(q)) < 1e-9, `${s.type} rotated`);
    const k = scaleShape(s, P(1, 1), 2.5);
    for (const q of along(s)) assert.ok(distToShape(k, P(1 + (q.x - 1) * 2.5, 1 + (q.y - 1) * 2.5)) < 1e-9, `${s.type} scaled`);
  }
});

test('snaps: the middle of a side, a crossing, a tangent from the last point', () => {
  const ents: Ent[] = [
    { id: 1, layer: 'Geometry', ...rectangle(P(0, 0), P(600, 400))! } as Ent,
    { id: 2, layer: 'Geometry', type: 'circle', c: P(300, 200), r: 17.5 },
    { id: 3, layer: 'Geometry', type: 'line', a: P(0, 0), b: P(600, 400) },
  ];
  const all = new Set(['end', 'mid', 'centre', 'intersection', 'quadrant', 'tangent', 'perpendicular'] as const);
  const mid = findSnaps(ents, { at: P(301, 2), reach: 5, modes: all, from: null, grid: 0 });
  assert.equal(mid[0].kind, 'mid');
  near(mid[0].p, P(300, 0), 'middle of the bottom side');
  const cross = findSnaps(ents, { at: P(600 - 1, 400 - 2), reach: 5, modes: new Set(['intersection']), from: null, grid: 0 });
  near(cross[0].p, P(600, 400), 'the diagonal meets the corner');
  const centre = findSnaps(ents, { at: P(302, 201), reach: 5, modes: all, from: null, grid: 0 });
  assert.ok(centre.some(s => s.kind === 'centre' && dist(s.p, P(300, 200)) < 1e-9));
  const tan = findSnaps(ents, { at: P(300, 217.5), reach: 3, modes: new Set(['tangent']), from: P(300 - 100, 217.5), grid: 0 });
  assert.equal(tan[0].kind, 'tangent');
  close(dist(tan[0].p, P(300, 200)), 17.5, 'tangent point on the circle');
  assert.ok(snapPoints(ents[1]).filter(s => s.kind === 'quadrant').length === 4);
});

test('choosing: window, crossing box and chains', () => {
  const lines: Ent[] = [
    { id: 1, layer: 'G', type: 'line', a: P(0, 0), b: P(10, 0) },
    { id: 2, layer: 'G', type: 'line', a: P(10, 0), b: P(10, 10) },
    { id: 3, layer: 'G', type: 'arc', c: P(5, 10), r: 5, a0: 0, a1: Math.PI },
    { id: 4, layer: 'G', type: 'line', a: P(0, 10), b: P(0, 0) },
    { id: 5, layer: 'G', type: 'line', a: P(50, 50), b: P(60, 50) },
  ];
  assert.deepEqual(chainFrom(lines, lines[0]).map(e => e.id), [1, 2, 3, 4]);
  assert.deepEqual(chainFrom(lines, lines[4]).map(e => e.id), [5]);
  const box = { x0: -1, y0: -1, x1: 11, y1: 11 };
  assert.ok(lines.slice(0, 2).every(e => inWindow(e, box)));
  assert.ok(!inWindow(lines[2], box), 'the arc pokes out of the top');
  assert.ok(touchesBox(lines[2], box), 'but touches the box');
  assert.ok(!touchesBox(lines[4], box));
  assert.ok(!inWindow({ type: 'xline', p: P(0, 0), d: P(1, 0) }, box), 'a construction line is never wholly inside');
});

test('a .tcad file reads back exactly, and a bad one is refused with a reason', () => {
  const d = newDrawing();
  d.ents = [
    { id: 1, layer: 'Geometry', type: 'line', a: P(0, 0), b: P(600, 0) },
    { id: 2, layer: 'Geometry', type: 'circle', c: P(300, 200), r: 17.5 },
    { id: 3, layer: 'Construction', type: 'xline', p: P(0, 0), d: P(0, 1) },
    { id: 4, layer: 'Geometry', type: 'ellipse', c: P(1 / 3, 2 / 7), m: P(10, 0), ratio: 0.5, t0: 0, t1: TAU },
  ];
  const back = readTcad(writeTcad(d));
  assert.equal(back.skipped, 0);
  assert.deepEqual(back.drawing.ents, d.ents, 'numbers kept to the last digit');
  assert.deepEqual(back.drawing.layers, d.layers);
  assert.throws(() => readTcad('not json'), CadProblem);
  assert.throws(() => readTcad(JSON.stringify({ tomlinCad: 2, layers: [], items: [] })), CadProblem);
  // A damaged item is left out and counted, with the reason; the rest still opens.
  const hurt = readTcad(JSON.stringify({ tomlinCad: 1, layers: [], items: [{ type: 'line', a: { x: 0, y: 'x' }, b: { x: 1, y: 1 } }, { type: 'circle', c: { x: 0, y: 0 }, r: -1 }, { type: 'point', p: { x: 1, y: 2 } }] }));
  assert.equal(hurt.damaged, 2);
  assert.match(String(hurt.why), /not a number/);
  assert.equal(hurt.drawing.ents.length, 1, 'the point still opens');
  // Too many points in all still refuses the whole file.
  assert.throws(() => readTcad(JSON.stringify({ tomlinCad: 1, layers: [], items: Array.from({ length: 30 }, () => ({ type: 'poly', pts: Array.from({ length: 100000 }, () => ({ x: 0, y: 0 })), bulges: [], closed: false })) })), /more points/);
  const odd = readTcad(JSON.stringify({ tomlinCad: 1, layers: [{ name: 'A', colour: 'red' }], items: [{ type: 'hatch' }, { type: 'point', p: { x: 1, y: 2 }, layer: 'nope' }] }));
  assert.equal(odd.skipped, 1, 'an unknown kind is left out and counted');
  assert.equal(odd.drawing.ents[0].layer, 'A', 'an unknown layer falls back to the first');
  assert.equal(odd.drawing.layers[0].colour, '#ffffff', 'a colour that is not #rrggbb is not used');
});

/** A stand-in for the window: keeps the items, the choice, and what was said. */
function fakeCtx(): ToolCtx & { items: Ent[]; said: string[]; problems: string[] } {
  let next = 1;
  const items: Ent[] = [];
  const chosen = new Set<number>();
  const said: string[] = [];
  const problems: string[] = [];
  const undo: Ent[][] = [];
  let photo: Photo | null = null;
  const ctx = {
    items, said, problems,
    units: () => 'mm' as const,
    ents: () => items,
    visible: () => items,
    selection: () => items.filter(e => chosen.has(e.id)),
    select(ids: number[]) {
      chosen.clear();
      ids.forEach(i => chosen.add(i));
    },
    add(shapes: Shape[], layer = 'Geometry') {
      undo.push([...items]);
      const ids: number[] = [];
      for (const s of shapes) {
        ids.push(next);
        items.push({ ...s, id: next++, layer } as Ent);
      }
      return ids;
    },
    change(changed: Array<{ id: number; shape: Shape }>, added: Array<{ shape: Shape; layer: string }>, removed: number[] = []) {
      undo.push([...items]);
      for (const id of removed) items.splice(items.findIndex(e => e.id === id), 1);
      for (const c of changed) {
        const i = items.findIndex(e => e.id === c.id);
        items[i] = { ...c.shape, id: c.id, layer: items[i].layer } as Ent;
      }
      for (const a of added) items.push({ ...a.shape, id: next++, layer: a.layer } as Ent);
    },
    say: (t: string) => void said.push(t),
    problem: (t: string) => void problems.push(t),
    fmt: (v: number) => String(Math.round(v * 1000) / 1000),
    list: () => {},
    zoomTo: () => {},
    askPolar: async (): Promise<PolarAnswer | null> => ({ count: 8, angle: 360, rotate: true }),
    askText: async () => ({ text: 'HELLO', h: 5, angle: 0, align: 'left' as const, cw: true }),
    askDim: async () => ({ text: 'about <>', h: 4, dp: 1 }),
    style: () => defaultStyle(false),
    noteLayer: (k: 'text' | 'dim') => (k === 'text' ? 'Text' : 'Dimensions'),
    finished: () => {},
    photo: () => photo,
    setPhoto(ph: Photo, t: string) {
      photo = ph;
      said.push(t);
    },
    straightenPhoto: () => {},
    placePart: () => {},
    savePart: () => {},
  };
  return ctx;
}

test('the line tool: a closed 600 x 400 outline from typed points', () => {
  const ctx = fakeCtx();
  const t = TOOLS.line.make(ctx);
  t.point!(P(0, 0));
  t.point!(P(600, 0));
  t.point!(P(600, 400));
  t.point!(P(0, 400));
  t.word!('c');
  assert.ok(t.done);
  assert.equal(ctx.items.length, 4);
  const total = ctx.items.reduce((s, e) => s + (e.type === 'line' ? dist(e.a, e.b) : 0), 0);
  close(total, 2000, 'perimeter');
  // U takes back the last line.
  const u = TOOLS.line.make(ctx);
  u.point!(P(0, 0));
  u.point!(P(10, 0));
  u.word!('u');
  assert.equal(ctx.items.length, 4);
});

test('tools that ask in steps: circle by diameter, rectangle round a centre, polygon, ellipse', () => {
  const ctx = fakeCtx();
  const c = TOOLS['circle-cd'].make(ctx);
  c.point!(P(300, 200));
  c.number!(35, P(0, 0));
  assert.equal(ctx.items[0].type === 'circle' && ctx.items[0].r, 17.5);
  assert.ok(!c.done, 'it carries on for the next circle');
  const r = TOOLS['rect-centre'].make(ctx);
  r.point!(P(300, 200));
  r.size!(600, 400);
  const rb = piecesOf(ctx.items[1]).map(pieceBox);
  assert.deepEqual([Math.min(...rb.map(b => b!.x0)), Math.max(...rb.map(b => b!.x1))], [0, 600]);
  const p = TOOLS['polygon-in'].make(ctx);
  p.point!(P(0, 0));
  p.number!(6, P(0, 0));
  p.number!(50, P(0, 0));
  assert.equal(ctx.items[2].type === 'poly' && ctx.items[2].pts.length, 6);
  const bad = TOOLS['polygon-in'].make(ctx);
  bad.point!(P(0, 0));
  bad.number!(2.5, P(0, 0));
  bad.number!(50, P(0, 0));
  assert.ok(ctx.problems.some(m => /whole number of sides/.test(m)));
  const e = TOOLS.ellipse.make(ctx);
  e.point!(P(0, 0));
  e.point!(P(80, 0));
  e.number!(40, P(0, 0));
  const made = ctx.items[ctx.items.length - 1];
  assert.equal(made.type, 'ellipse');
});

test('edit tools: move, mirror keeping the original, polar copies', async () => {
  const ctx = fakeCtx();
  ctx.add([{ type: 'circle', c: P(50, 0), r: 5 }]);
  ctx.select([1]);
  const m = TOOLS.move.make(ctx);
  m.point!(P(0, 0));
  m.point!(P(10, 20));
  assert.ok(m.done);
  near((ctx.items[0] as Extract<Ent, { type: 'circle' }>).c, P(60, 20), 'moved');
  const mi = TOOLS.mirror.make(ctx);
  mi.point!(P(0, 0));
  mi.point!(P(0, 10));
  assert.equal(ctx.items.length, 2, 'the original is kept');
  near((ctx.items[1] as Extract<Ent, { type: 'circle' }>).c, P(-60, 20), 'mirrored copy');
  ctx.select([1]);
  const pol = TOOLS['array-polar'].make(ctx);
  pol.point!(P(0, 20));
  await new Promise(r => setTimeout(r, 0));
  assert.ok(pol.done);
  assert.equal(ctx.items.length, 2 + 7, 'seven copies round the centre');
  for (const e of ctx.items.slice(2)) close(dist((e as Extract<Ent, { type: 'circle' }>).c, P(0, 20)), 60, 'on the same circle round the centre');
});

test('tangent tools and the touching-circle tool through the step machine', () => {
  const ctx = fakeCtx();
  ctx.add([{ type: 'circle', c: P(0, 0), r: 10 }, { type: 'circle', c: P(50, 0), r: 10 }]);
  const t = TOOLS['tan-two'].make(ctx);
  t.pick!(ctx.items[0], P(0, 10));
  t.pick!(ctx.items[1], P(50, 10));
  const l = ctx.items[2];
  assert.equal(l.type, 'line');
  if (l.type === 'line') {
    near(l.a, P(0, 10), 'touches the top of the first');
    near(l.b, P(50, 10), 'and of the second');
  }
  ctx.add([{ type: 'line', a: P(100, 0), b: P(200, 0) }, { type: 'line', a: P(100, 0), b: P(100, 100) }]);
  const ttr = TOOLS['circle-ttr'].make(ctx);
  ttr.pick!(ctx.items[3], P(120, 0));
  ttr.pick!(ctx.items[4], P(100, 20));
  ttr.number!(10, P(0, 0));
  const c = ctx.items[5];
  assert.ok(c.type === 'circle');
  if (c.type === 'circle') near(c.c, P(110, 10), 'in the corner');
});

test('CAD tools through their steps: trim, fillet with the last radius on Enter, fillet a rectangle corner, offset, area', () => {
  const ctx = fakeCtx();
  ctx.add([{ type: 'line', a: P(0, 0), b: P(100, 0) }, { type: 'line', a: P(50, -10), b: P(50, 10) }]);
  const tr = TOOLS.trim.make(ctx);
  tr.pick!(ctx.items[0], P(80, 0));
  const cut = ctx.items.find(e => e.id === 1)!;
  assert.ok(cut.type === 'line' && Math.abs(cut.b.x - 50) < 1e-9, 'cut back to x = 50');
  tr.enter();
  ctx.add([{ type: 'line', a: P(200, 0), b: P(300, 0) }, { type: 'line', a: P(200, 0), b: P(200, 100) }]);
  const f = TOOLS.fillet.make(ctx);
  assert.ok(f.enter(), 'Enter takes the last radius and carries on');
  const [bottom, side] = ctx.items.slice(-2);
  f.pick!(bottom, P(250, 0));
  f.pick!(side, P(200, 50));
  const round = ctx.items[ctx.items.length - 1];
  assert.equal(round.type, 'arc', 'a round between them');
  if (round.type === 'arc') close(round.r, 10, 'radius 10 (the last one used)');
  ctx.add([rectangle(P(0, 100), P(600, 500))!]);
  const rect = ctx.items[ctx.items.length - 1];
  const f2 = TOOLS.fillet.make(ctx);
  f2.number!(25, P(0, 0));
  f2.pick!(rect, P(300, 100));
  f2.pick!(rect, P(600, 300));
  const after = ctx.items.find(e => e.id === rect.id)!;
  assert.ok(after.type === 'poly' && after.pts.length === 5, 'one corner rounded: five points');
  const o = TOOLS.offset.make(ctx);
  o.number!(5, P(0, 0));
  o.pick!(after, P(300, 100));
  o.point!(P(300, 300));
  const inner = ctx.items[ctx.items.length - 1];
  assert.equal(inner.type, 'poly');
  const ar = TOOLS.area.make(ctx);
  ar.pick!(inner, P(0, 0));
  assert.ok(/^Area /.test(ctx.said[ctx.said.length - 1]), ctx.said[ctx.said.length - 1]);
  const bad = TOOLS.area.make(ctx);
  bad.pick!(ctx.items[0], P(0, 0));
  assert.ok(ctx.problems.some(p => /not closed/.test(p)));
});

test('magnetic snaps: on a side anywhere near its middle, the middle is taken; off the side, only close points catch', () => {
  // Two squares, 0,0-100,100 and 100,100-200,200; a third rectangle from the middle of one side to another.
  const ents: Ent[] = [
    { id: 1, layer: 'G', ...rectangle(P(0, 0), P(100, 100))! } as Ent,
    { id: 2, layer: 'G', ...rectangle(P(100, 100), P(200, 200))! } as Ent,
  ];
  const modes = new Set(['end', 'mid', 'centre', 'intersection', 'quadrant'] as const);
  const q = (x: number, y: number) => findSnaps(ents, { at: P(x, y), reach: 5, modes, from: null, grid: 0, magnet: 20, onItem: 3 })[0];
  // On the right side of the upper square, 12 below its middle: still the middle.
  const right = q(200.5, 138);
  assert.equal(right.kind, 'mid');
  near(right.p, P(200, 150), 'middle of the right side');
  // On the left side of the lower square, 15 above its middle.
  const left = q(-0.4, 65);
  assert.equal(left.kind, 'mid');
  near(left.p, P(0, 50), 'middle of the left side');
  // Near a corner, the corner wins over the middle.
  const corner = q(199.6, 195);
  assert.equal(corner.kind, 'end');
  near(corner.p, P(200, 200), 'the corner');
  // 10 off the side (not on it): the middle 10 away is beyond the ordinary reach, so nothing.
  assert.equal(q(210, 150), undefined);
});

test('text and dimension tools through their steps (session 7)', async () => {
  const ctx = fakeCtx();
  const tick = () => new Promise(r => setTimeout(r, 0));
  // Text: a click, then the words from the box, on the Text layer.
  const t = TOOLS.text.make(ctx);
  t.point!(P(10, 20));
  await tick();
  const words = ctx.items.at(-1)! as TextShape & Ent;
  assert.equal(words.text, 'HELLO');
  assert.equal(words.layer, 'Text');
  assert.ok(t.done);
  // A linear dimension put below two points measures across; put to their side, it measures up.
  const lin = TOOLS['dim-linear'].make(ctx);
  lin.point!(P(0, 0));
  lin.point!(P(600, 400));
  lin.point!(P(300, -50));
  assert.equal(dimLabel(ctx.items.at(-1) as DimShape), '600');
  assert.equal(ctx.items.at(-1)!.layer, 'Dimensions');
  lin.point!(P(0, 0));
  lin.point!(P(600, 400));
  lin.point!(P(700, 200));
  assert.equal(dimLabel(ctx.items.at(-1) as DimShape), '400');
  // Radius of a picked circle, number outside.
  ctx.items.push({ type: 'circle', c: P(0, 0), r: 25, id: 900, layer: 'Geometry' } as Ent);
  const rad = TOOLS['dim-diameter'].make(ctx);
  rad.pick!(ctx.items.at(-1)!, P(25, 0));
  rad.point!(P(60, 10));
  assert.equal(dimLabel(ctx.items.at(-1) as DimShape), 'Ø50');
  // The angle between two picked lines, on the side the arc is put.
  ctx.items.push({ type: 'line', a: P(0, 0), b: P(100, 0), id: 901, layer: 'Geometry' } as Ent, { type: 'line', a: P(0, 0), b: P(100, 100), id: 902, layer: 'Geometry' } as Ent);
  const ang = TOOLS['dim-angle'].make(ctx);
  ang.pick!(ctx.items.find(e => e.id === 901)!, P(80, 0));
  ang.pick!(ctx.items.find(e => e.id === 902)!, P(70, 70));
  ang.point!(P(50, 15));
  assert.equal(dimLabel(ctx.items.at(-1) as DimShape), '45°');
  ang.pick!(ctx.items.find(e => e.id === 901)!, P(80, 0));
  ang.pick!(ctx.items.find(e => e.id === 902)!, P(70, 70));
  ang.point!(P(-10, 30));
  assert.equal(dimLabel(ctx.items.at(-1) as DimShape), '135°', 'the other side of the second line');
  // Leader: two points, Done, then the words.
  const le = TOOLS.leader.make(ctx);
  le.point!(P(0, 0));
  le.point!(P(20, 20));
  assert.equal(le.enter(), true, 'waits for the words');
  await tick();
  const note = ctx.items.at(-1) as DimShape;
  assert.equal(note.kind, 'leader');
  assert.equal(note.text, 'HELLO');
  // Change a dimension's words: <> keeps the measured size in them.
  const ed = TOOLS['text-edit'].make(ctx);
  assert.equal(ed.pickFilter!(ctx.items.find(e => e.id === 901)!), false, 'only text and dimensions can be changed');
  const target = ctx.items.find(e => e.type === 'dim' && e.kind === 'linear')!;
  ed.pick!(target, P(0, 0));
  await tick();
  assert.equal(dimLabel(ctx.items.find(e => e.id === target.id) as DimShape), 'about 600');
  // Trim and extend cannot pick text or dimensions.
  assert.equal(TOOLS.trim.make(ctx).pickFilter!(words), false);
  assert.equal(TOOLS.extend.make(ctx).pickFilter!(target), false);
});
