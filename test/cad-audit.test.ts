// CAD Draft session 10: each fault the read-only audit of sessions 1-9 found, kept found. One test per area; each
// check names the fault it guards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { P, TAU, dist, type Pt } from '../src/apps/cad/geom.ts';
import { parseNumber, parsePoint } from '../src/apps/cad/input.ts';
import { CadProblem, describe, newDrawing, piecesOf, readTcad, writeTcad, type Ent, type Shape } from '../src/apps/cad/model.ts';
import { breakAt, chamfer, closeShape, cornerBetween, extend, fillet, offset, polyCorners } from '../src/apps/cad/modify.ts';
import { dxfNum, readDxf, writeDxf } from '../src/apps/cad/dxf.ts';
import { readPhoto } from '../src/apps/cad/photo.ts';
import { DEFAULT_SETUP, planPrint } from '../src/apps/cad/print.ts';

const near = (a: Pt, b: Pt, what: string, tol = 1e-6) => assert.ok(dist(a, b) <= tol, `${what}: expected ${b.x},${b.y}, got ${a.x},${a.y}`);
const enc = (lines: string[]) => new TextEncoder().encode(lines.join('\r\n') + '\r\n');
const entities = (items: string[], header: string[] = [], blocks: string[] = []) => enc([
  '0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1015', ...header, '0', 'ENDSEC',
  ...(blocks.length ? ['0', 'SECTION', '2', 'BLOCKS', ...blocks, '0', 'ENDSEC'] : []),
  '0', 'SECTION', '2', 'ENTITIES', ...items, '0', 'ENDSEC', '0', 'EOF',
]);
const line = (a: Pt, b: Pt): Shape => ({ type: 'line', a, b });

test('fillet and chamfer: too big is refused, an arc keeps the part picked, a line of no length is named', () => {
  // Was: the lines were moved past their own far ends.
  const A = line(P(2, 0), P(10, 0));
  const B = line(P(0, 2), P(0, 10));
  assert.match(String(fillet(A, P(6, 0), B, P(0, 6), 20)), /longer than one of the lines/);
  assert.match(String(chamfer(A, P(6, 0), B, P(0, 6), 20, 20)), /longer than one of the lines/);
  const ok = fillet(A, P(6, 0), B, P(0, 6), 1);
  assert.ok(typeof ok !== 'string' && ok.first?.type === 'line', 'a radius that fits still works');
  // Was: the arc kept the side away from the round (a 180° cusp at the joint).
  const arc: Shape = { type: 'arc', c: P(0, 20), r: 15, a0: Math.PI, a1: TAU };
  const pick = P(15 * Math.cos(1.2 * Math.PI), 20 + 15 * Math.sin(1.2 * Math.PI));
  const r = fillet(line(P(-30, 0), P(30, 0)), P(-20, 0), arc, pick, 3);
  assert.ok(typeof r !== 'string' && r.second?.type === 'arc', String(r));
  const kept = (r as { second: Extract<Shape, { type: 'arc' }> }).second;
  assert.ok(Math.abs(kept.a0 - Math.PI) < 1e-9, `the picked side (from π) is kept: ${kept.a0} to ${kept.a1}`);
  assert.match(String(fillet(line(P(5, 5), P(5, 5)), P(5, 5), B, P(0, 6), 1)), /no length/);
});

test('closed polyline that repeats its start: every corner rounds, and its start corner can be picked', () => {
  // Was: 3 done, 2 skipped; the corner at the start stayed sharp.
  const sq: Extract<Shape, { type: 'poly' }> = { type: 'poly', pts: [P(0, 0), P(10, 0), P(10, 10), P(0, 10), P(0, 0)], bulges: [0, 0, 0, 0, 0], closed: true };
  const all = polyCorners(sq, { round: 2 });
  assert.deepEqual([all.done, all.skipped], [4, 0]);
  assert.equal(cornerBetween(sq, P(5, 0), P(0, 5)), 0, 'the two sides at the start meet');
});

test('typing: "600 400" is not 600400; @600<90 is exactly upright', () => {
  assert.equal(parseNumber('600 400'), null);
  assert.equal(parseNumber('1 000'), null);
  assert.equal(parseNumber(' 600 '), 600);
  assert.equal(parseNumber('600 / 2 + 15'), 315, 'spaces round signs are fine');
  const up = parsePoint('@600<90', P(0, 0));
  assert.ok(up && 'p' in up && up.p.x === 0 && up.p.y === 600, JSON.stringify(up));
  const back = parsePoint('600<-180', null);
  assert.ok(back && 'p' in back && back.p.y === 0 && back.p.x === -600, JSON.stringify(back));
});

test('offset, tiny bulges, lines of no length, closing two points, an ellipse part in true angles', () => {
  // Was: the corner of a fold became a midpoint, so the sides were not the distance away.
  assert.match(String(offset({ type: 'poly', pts: [P(0, 0), P(10, 0), P(0, 0)], bulges: [0, 0, 0], closed: false }, 1, P(5, 1))), /turns straight back/);
  // Was: a radius of 2.5e13 and ends 4.6 µm off.
  const pieces = piecesOf({ type: 'poly', pts: [P(1000, 1000), P(2000, 1000)], bulges: [1e-11, 0], closed: false });
  assert.equal(pieces[0].k, 'seg');
  const dot = line(P(5, 5), P(5, 5));
  assert.match(String(breakAt(dot, P(5, 5))), /no length/);
  assert.match(String(extend(dot, P(5, 5), [line(P(20, -5), P(20, 20))])), /no length/);
  assert.equal(typeof closeShape({ type: 'poly', pts: [P(1, 1), P(1, 1)], bulges: [0, 0], closed: false }), 'string');
  // An ellipse 2:1, part from t = 0 to t = 90°: its end is straight up from the centre (90°), as the parameter is here;
  // from t = 45°, the true direction is atan(0.5) = 26.565°.
  const e = { type: 'ellipse', c: P(0, 0), m: P(10, 0), ratio: 0.5, t0: Math.PI / 4, t1: Math.PI / 2, id: 1, layer: 'G' } as Ent;
  assert.ok(describe(e, 'mm').some(l => l.startsWith('Part from 26.565°')), describe(e, 'mm').join(' | '));
});

test('DXF in: blocks from below, repeated blocks counted, big curves quick, sizes beyond numbers left out, units', () => {
  const block = ['0', 'BLOCK', '8', '0', '2', 'B', '70', '0', '10', '0', '20', '0', '30', '0',
    '0', 'LINE', '8', '0', '10', '0', '20', '0', '30', '0', '11', '10', '21', '0', '31', '0', '0', 'ENDBLK', '8', '0'];
  const insert = (extra: string[]) => ['0', 'INSERT', '8', 'A', '2', 'B', '10', '0', '20', '0', '30', '0', ...extra];
  // Was: mirrored through the point (10,0 came back) instead of left to right (-10,0).
  const flat = readDxf(entities(insert(['210', '0', '220', '0', '230', '-1']), [], block)).drawing.ents[0] as Extract<Ent, { type: 'line' }>;
  near(flat.b, P(-10, 0), 'seen from below');
  const turned = readDxf(entities(insert(['50', '30', '210', '0', '220', '0', '230', '-1']), [], block)).drawing.ents[0] as Extract<Ent, { type: 'line' }>;
  near(turned.b, P(-10 * Math.cos(Math.PI / 6), 5), 'seen from below, turned 30°');
  // Was: 1,000,000 items read from a file of a few hundred bytes.
  const t0 = Date.now();
  assert.throws(() => readDxf(entities(insert(['70', '1000', '71', '1000', '44', '1', '45', '1']), [], block)), /more than 200,000 items/);
  assert.ok(Date.now() - t0 < 1000, 'refused before any copy is made');
  // Was: 24.7 s for a curve of 20,000 fit points, 28 s for a leader of 20,000 points.
  const fit: string[] = ['0', 'SPLINE', '8', 'A', '70', '0', '71', '3', '74', '20000'];
  const lead: string[] = ['0', 'LEADER', '8', 'A'];
  for (let i = 0; i < 20000; i++) {
    fit.push('11', String(i), '21', String(Math.sin(i / 50)), '31', '0');
    lead.push('10', String(i), '20', String(i % 7), '30', '0');
  }
  const t1 = Date.now();
  readDxf(entities([...fit, ...lead]));
  assert.ok(Date.now() - t1 < 3000, `big curve and leader read in ${Date.now() - t1} ms`);
  // Was: Infinity in the drawing, then a .tcad that could never be opened.
  const far = readDxf(entities(['0', 'LINE', '8', 'A', '10', '0', '20', '0', '30', '0', '11', '1e306', '21', '0', '31', '0', '0', 'LINE', '8', 'A', '10', '0', '20', '0', '30', '0', '11', '1', '21', '0', '31', '0'], ['9', '$INSUNITS', '70', '6']));
  assert.equal(far.drawing.ents.length, 1, 'the line beyond any number is left out');
  assert.equal(far.leftOut, 1, 'and counted');
  assert.equal(readTcad(writeTcad(far.drawing)).drawing.ents.length, 1, 'and the drawing saves and opens again');
  // Decimetres, and a unit number nobody knows.
  const dm = readDxf(entities(['0', 'LINE', '8', 'A', '10', '0', '20', '0', '30', '0', '11', '6', '21', '0', '31', '0'], ['9', '$INSUNITS', '70', '14'])).drawing.ents[0] as Extract<Ent, { type: 'line' }>;
  assert.equal(dm.b.x, 600, '6 dm is 600 mm');
  assert.match(readDxf(entities(['0', 'POINT', '8', 'A', '10', '0', '20', '0', '30', '0'], ['9', '$INSUNITS', '70', '99'])).report.join(' '), /unit number 99/);
});

test('DXF in: paragraph text turned in degrees, damaged curves and drops counted, a hair-over-1 ellipse kept', () => {
  const m = readDxf(entities(['0', 'MTEXT', '8', 'A', '10', '0', '20', '0', '30', '0', '40', '5', '50', '90', '1', 'UP'])).drawing.ents[0] as Extract<Ent, { type: 'text' }>;
  assert.ok(Math.abs(m.angle - Math.PI / 2) < 1e-9, `MTEXT 50=90 reads at 90°: ${(m.angle * 180) / Math.PI}`);
  // Was: a raw TypeError ("could not be read" and an error report).
  const crafted = readDxf(entities(['0', 'SPLINE', '8', 'A', '70', '0', '71', '3', '72', '6', '73', '2', '40', '0', '40', '0', '40', '1', '40', '0', '40', '0', '40', '0', '10', '0', '20', '0', '30', '0', '10', '1', '20', '1', '30', '0']));
  assert.equal(crafted.drawing.ents.length, 0);
  assert.equal(crafted.leftOut, 1);
  const drops = readDxf(entities([
    '0', 'ELLIPSE', '8', 'A', '10', '0', '20', '0', '30', '0', '11', '10', '21', '0', '31', '0', '40', '1.0000000001', '41', '0', '42', String(TAU),
    '0', 'LWPOLYLINE', '8', 'A', '90', '1', '70', '0', '10', '1', '20', '1',
    '0', 'CIRCLE', '8', 'A', '10', '0', '20', '0', '30', '0', '40', '0',
  ]));
  assert.equal(drops.drawing.ents[0]?.type, 'ellipse', 'a ratio a hair over 1 is a circle-like ellipse');
  assert.equal(drops.leftOut, 2, 'the one-point polyline and the circle of no size are counted');
});

test('DXF out: our layer 0 is the DXF layer 0; a size too big for a DXF is refused in words', () => {
  const d = newDrawing();
  d.layers.push({ name: '0', colour: '#ffffff', on: true, locked: false, lineType: 'continuous' });
  d.ents = [{ ...line(P(0, 0), P(10, 0)), id: 1, layer: '0' } as Ent];
  const text = new TextDecoder('latin1').decode(writeDxf(d, { textAsLines: false, construction: false, hidden: false }).bytes);
  assert.ok(!text.includes('0_2'), 'no 0_2 layer');
  assert.equal(readDxf(new TextEncoder().encode(text)).drawing.ents[0].layer, '0');
  assert.throws(() => dxfNum(1e21), CadProblem);
});

test('DXF units: an inch drawing comes back in inches; a millimetre DXF is unchanged (no units line)', () => {
  const opts = { textAsLines: false, construction: false, hidden: false };
  const inch = newDrawing('inch');
  inch.ents = [{ ...line(P(0, 0), P(24, 0)), id: 1, layer: 'Geometry' } as Ent];
  const back = readDxf(writeDxf(inch, opts).bytes);
  assert.equal(back.drawing.units, 'inch');
  assert.equal((back.drawing.ents[0] as Extract<Ent, { type: 'line' }>).b.x, 24, '24 inches stays 24');
  assert.match(back.report.join(' '), /inches \(as the file says\)/);
  const mm = newDrawing();
  mm.ents = [{ ...line(P(0, 0), P(600, 0)), id: 1, layer: 'Geometry' } as Ent];
  const text = new TextDecoder('latin1').decode(writeDxf(mm, opts).bytes);
  assert.ok(!text.includes('$INSUNITS'), 'a millimetre file has no units line');
  assert.equal(readDxf(new TextEncoder().encode(text)).drawing.units, 'mm');
});

test('a damaged photo in a file is left out; Fit and construction lines print sensibly', () => {
  assert.equal(readPhoto({ jpeg: '/9j/' + 'A'.repeat(100) + '#bad', px: 10, py: 10, at: P(0, 0), u: P(10, 0) }), null);
  assert.ok(readPhoto({ jpeg: '/9j/' + 'A'.repeat(100), px: 10, py: 10, at: P(0, 0), u: P(10, 0) }), 'a good one still reads');
  const dot = newDrawing();
  dot.ents = [{ type: 'point', p: P(5, 5), id: 1, layer: 'Geometry' } as Ent];
  const fit = planPrint(dot, { ...DEFAULT_SETUP, scale: 'fit' }, null);
  assert.ok(typeof fit !== 'string' && fit.n >= 0.01, 'Fit enlarges 100 times at most');
  const xl = newDrawing();
  xl.ents = [{ type: 'xline', p: P(0, 0), d: P(1, 0), id: 1, layer: 'Construction' } as Ent];
  assert.match(String(planPrint(xl, { ...DEFAULT_SETUP, construction: true }, null)), /go on for ever/);
});
