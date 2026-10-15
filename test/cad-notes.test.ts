// TOMLIN CAD sessions 7-8: text (its own single-line letters), dimensions, and DXF out and in, checked against
// answers worked out by hand and against DXF written out by hand the way AutoCAD R12 and AutoCAD 2000 write it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { P, TAU, dist, nearestOn, type Pt } from '../src/apps/cad/geom.ts';
import { boxOfShapes, distToShape, mirrorShape, moveShape, rotateShape, scaleShape } from '../src/apps/cad/edit.ts';
import { lineWidth, textStrokes } from '../src/apps/cad/font.ts';
import { newDrawing, outlineOf, piecesOf, readTcad, rectangle, writeTcad, type Ent, type Shape } from '../src/apps/cad/model.ts';
import { areaOf } from '../src/apps/cad/modify.ts';
import { angleArms, dimLabel, dimNumber, dimParts, dimValue, type DimShape, type TextShape } from '../src/apps/cad/notes.ts';
import { curveToBulges, decodeMtext, decodeText, r12Name, r12Text, readDxf, writeDxf } from '../src/apps/cad/dxf.ts';

const near = (a: Pt, b: Pt, what: string, tol = 1e-6) => assert.ok(dist(a, b) <= tol, `${what}: expected ${b.x},${b.y}, got ${a.x},${a.y}`);
const close = (a: number, b: number, what: string, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${what}: expected ${b}, got ${a}`);
const text = (o: Partial<TextShape> = {}): TextShape => ({ type: 'text', p: P(0, 0), text: 'H', h: 6, angle: 0, align: 'left', ...o });
const dim = (o: Partial<DimShape>): DimShape => ({ type: 'dim', kind: 'linear', pts: [], dir: 0, h: 3.5, arrow: 2.5, dp: 2, text: '', ...o });
const hasSeg = (s: Shape, a: Pt, b: Pt) => outlineOf(s).some(p => p.k === 'seg' && ((dist(p.a, a) < 1e-6 && dist(p.b, b) < 1e-6) || (dist(p.a, b) < 1e-6 && dist(p.b, a) < 1e-6)));
const ents = (shapes: Array<[Shape, string]>): Ent[] => shapes.map(([s, layer], i) => ({ ...s, id: i + 1, layer }) as Ent);
const enc = (lines: string[]) => new TextEncoder().encode(lines.join('\r\n') + '\r\n');

// ---- Text ------------------------------------------------------------------------------------------------------------

test('text: capitals are the height asked for; widths, lining up and turning', () => {
  // H is 4 wide on a grid where capitals are 6 high; each letter is followed by a 1.4 gap (not after the last).
  close(lineWidth('H', 6), 4, 'one H');
  close(lineWidth('HI', 6), 5.4, 'H then I (a single stroke)');
  close(lineWidth('HH', 12), 2 * (4 + 1.4 + 4), 'twice the height, twice the width');
  const b = boxOfShapes([text({ p: P(10, 20) })])!;
  close(b.x0, 10, 'left');
  close(b.x1, 14, 'right');
  close(b.y0, 20, 'foot');
  close(b.y1, 26, 'top of the capital: the height');
  const c = boxOfShapes([text({ align: 'centre' })])!;
  close(c.x0, -2, 'centred: half each side');
  close(c.x1, 2, 'centred');
  const r = boxOfShapes([text({ align: 'right', p: P(100, 0) })])!;
  close(r.x1, 100, 'lined up on its right end');
  const turned = boxOfShapes([text({ angle: Math.PI / 2 })])!;
  close(turned.x0, -6, 'turned a quarter: up becomes left');
  close(turned.y1, 4, 'and along becomes up');
  // Two lines: the second 1.6 heights below the first.
  const two = boxOfShapes([text({ text: 'H\nH' })])!;
  close(two.y0, -9.6, 'second line foot');
  // Every letter the font has is drawn; one it has not is a box (never dropped).
  assert.ok(textStrokes('Ω', P(0, 0), 6, 0, 'left').length > 0, 'a letter the font lacks is still drawn');
});

test('text: picked anywhere over its letters, not only on a stroke', () => {
  const t = text({ text: 'HH', p: P(0, 0) });
  assert.equal(distToShape(t, P(4.7, 3)), 0, 'between the two letters is still on the text');
  close(distToShape(t, P(2, 8)), 2, 'two above the top');
});

test('text: moved, turned, mirrored (never reads backwards) and scaled', () => {
  const t = text({ text: 'AB', p: P(10, 0) });
  near((moveShape(t, P(5, 5)) as TextShape).p, P(15, 5), 'moved');
  close((rotateShape(t, P(0, 0), Math.PI / 2) as TextShape).angle, Math.PI / 2, 'turned');
  const m = mirrorShape(t, P(0, -1), P(0, 1)) as TextShape;
  near(m.p, P(-10, 0), 'mirrored across the Y axis');
  close(m.angle, 0, 'still reads left to right');
  assert.equal(m.align, 'right', 'and is lined up from its other end, so it sits where the mirror puts it');
  const s = scaleShape(t, P(0, 0), 2) as TextShape;
  close(s.h, 12, 'twice the height');
  near(s.p, P(20, 0), 'twice as far out');
});

test('text round an arc: letters stand on the circle, reading clockwise along the outside', () => {
  const t = text({ text: 'HHH', h: 6, align: 'centre', p: P(0, 100), arc: { c: P(0, 0), r: 100, cw: true } });
  for (const p of outlineOf(t)) {
    if (p.k !== 'seg') continue;
    for (const q of [p.a, p.b]) assert.ok(dist(q, P(0, 0)) >= 100 - 1e-6 && dist(q, P(0, 0)) <= Math.hypot(106, 4) + 1e-6, `every stroke between the circle and its height (a flat letter 4 wide reaches √(106² + 4²) at its far top corner): ${dist(q, P(0, 0))}`);
  }
  const b = boxOfShapes([t])!;
  close((b.x0 + b.x1) / 2, 0, 'centred on the top of the circle', 0.05);
});

// ---- Dimensions -------------------------------------------------------------------------------------------------------

test('dimensions measure what they say', () => {
  const a = P(0, 0);
  const b = P(600, 400);
  assert.equal(dimLabel(dim({ pts: [a, b, P(300, -50)] })), '600', 'horizontal: the distance across');
  assert.equal(dimLabel(dim({ pts: [a, b, P(-50, 200)], dir: Math.PI / 2 })), '400', 'vertical: the distance up');
  assert.equal(dimLabel(dim({ kind: 'aligned', pts: [a, b, P(0, 100)], dir: Math.atan2(400, 600) })), '721.11', 'aligned: the true length (√520000 = 721.110...)');
  assert.equal(dimLabel(dim({ kind: 'radius', pts: [P(0, 0), P(50, 0), P(100, 0)] })), 'R50', 'radius');
  assert.equal(dimLabel(dim({ kind: 'diameter', pts: [P(0, 0), P(0, 50), P(100, 0)] })), 'Ø100', 'diameter');
  assert.equal(dimLabel(dim({ kind: 'diameter', pts: [P(0, 0), P(0, 50), P(100, 0)], text: '<> THRU' })), 'Ø100 THRU', 'own words with <> for the size');
  assert.equal(dimLabel(dim({ kind: 'angle', pts: [P(0, 0), P(10, 0), P(0, 10), P(5, 5)] })), '90°', 'a right angle');
  close(dimValue(dim({ kind: 'angle', pts: [P(0, 0), P(10, 0), P(-10, 10), P(5, 5)] })), 135, 'an obtuse angle');
  assert.equal(dimNumber(12.5, 2), '12.5');
  assert.equal(dimNumber(600, 2), '600');
  assert.equal(dimNumber(0.004, 2), '0', 'no minus nothing');
  assert.equal(dimNumber(2 / 3, 3), '0.667');
});

test('a horizontal dimension: extension lines from the part, the dimension line where it was put, arrows inside', () => {
  const d = dim({ pts: [P(0, 0), P(600, 0), P(300, -50)] });
  assert.ok(hasSeg(d, P(0, -50), P(600, -50)), 'the dimension line at y = -50');
  // A gap of 0.4 arrow (1) from the part, and 0.6 arrow (1.5) past the dimension line.
  assert.ok(hasSeg(d, P(0, -1), P(0, -51.5)), 'the left extension line');
  assert.ok(hasSeg(d, P(600, -1), P(600, -51.5)), 'the right extension line');
  const { texts } = dimParts(d);
  near(texts[0].p, P(300, -50 + 1.75), 'the number centred above the line');
  // Too short for arrows inside: they point in from outside.
  const short = dimParts(dim({ pts: [P(0, 0), P(3, 0), P(1.5, -10)] }));
  assert.ok(short.pieces.some(p => p.k === 'seg' && Math.min(p.a.x, p.b.x) < -4), 'the line runs out past the left end');
});

test('the angle between two lines is the side the arc is put on', () => {
  const [s, e] = angleArms(P(0, 0), P(1, 0), P(0, 1), P(-5, 5));
  near(s, P(0, 1), 'starts on the upward arm');
  near(e, P(-1, 0), 'ends on the leftward one');
  const [s2, e2] = angleArms(P(0, 0), P(1, 0), P(0, 1), P(5, -5));
  near(s2, P(0, -1), 'below and right: from the downward arm');
  near(e2, P(1, 0), 'to the rightward one');
  // Mirrored, an angle keeps its size (its arms swap so it still runs anticlockwise).
  const a = dim({ kind: 'angle', pts: [P(0, 0), P(10, 0), P(10, 10), P(8, 3)] });
  close(dimValue(mirrorShape(a, P(0, 0), P(0, 1)) as DimShape), 45, 'mirrored angle');
  close(dimValue(rotateShape(a, P(3, 3), 1) as DimShape), 45, 'turned angle');
  assert.equal(dimLabel(scaleShape(dim({ pts: [P(0, 0), P(10, 0), P(5, -5)] }), P(0, 0), 2) as DimShape), '20', 'a scaled dimension measures again');
});

test('.tcad keeps text, text round an arc, dimensions and the sizes for new ones', () => {
  const d = newDrawing();
  d.style = { textH: 7, dimH: 4, arrow: 3, dp: 1 };
  d.ents = ents([
    [text({ text: 'Front\nleft', angle: 0.5, align: 'centre' }), 'Text'],
    [text({ text: 'ROUND', arc: { c: P(5, 5), r: 40, cw: false } }), 'Text'],
    [dim({ kind: 'angle', pts: [P(0, 0), P(10, 0), P(0, 10), P(5, 5)], text: 'about <>' }), 'Dimensions'],
  ]);
  const back = readTcad(writeTcad(d)).drawing;
  assert.deepEqual(back.ents, d.ents, 'every item back as it was');
  assert.deepEqual(back.style, d.style, 'the sizes kept');
  const bad = readTcad(JSON.stringify({ tomlinCad: 1, layers: [{ name: 'A' }], items: [{ type: 'text', p: { x: 0, y: 0 }, text: 'x', h: -1, angle: 0 }] }));
  assert.equal(bad.damaged, 1, 'text with no height is left out');
  assert.match(String(bad.why), /no height/);
});

// ---- DXF out --------------------------------------------------------------------------------------------------------

test('DXF out: R12, layers in capitals with their colours, every kind of item, text codes', () => {
  const d = newDrawing();
  d.ents = ents([
    [{ type: 'line', a: P(0, 0), b: P(600, 0) }, 'Geometry'],
    [{ type: 'circle', c: P(300, 200), r: 50 }, 'Geometry'],
    [{ type: 'arc', c: P(0, 0), r: 20, a0: 0, a1: Math.PI / 2 }, 'Geometry'],
    [rectangle(P(0, 0), P(600, 400), 10)!, 'Geometry'],
    [{ type: 'ellipse', c: P(0, 0), m: P(100, 0), ratio: 0.5, t0: 0, t1: TAU }, 'Geometry'],
    [text({ text: 'Ø50 ±0.1 90°', h: 5, align: 'centre', p: P(300, 450) }), 'Text'],
    [dim({ pts: [P(0, 0), P(600, 0), P(300, -50)] }), 'Dimensions'],
    [{ type: 'xline', p: P(0, 0), d: P(1, 0) }, 'Construction'],
  ]);
  const out = writeDxf(d, { textAsLines: false, construction: false, hidden: false });
  assert.match(out.text, /\r\n\$ACADVER\r\n1\r\nAC1009\r\n/, 'an R12 file');
  for (const kind of ['LINE', 'CIRCLE', 'ARC', 'POLYLINE', 'VERTEX', 'SEQEND', 'TEXT', 'EOF']) assert.ok(out.text.includes(`\r\n0\r\n${kind}\r\n`), `has ${kind}`);
  assert.ok(!out.text.includes('ELLIPSE'), 'no ELLIPSE (R12 has none): it is a polyline of arcs');
  assert.ok(out.text.includes('\r\n2\r\nGEOMETRY\r\n70\r\n0\r\n62\r\n7\r\n'), 'Geometry is white (colour 7)');
  assert.ok(out.text.includes('\r\n2\r\nCONSTRUCTION\r\n70\r\n0\r\n62\r\n6\r\n6\r\nDASHED'), 'Construction is magenta and dashed');
  assert.ok(out.text.includes('%%c50 %%p0.1 90%%d'), 'diameter, plus-minus and degree as R12 codes');
  assert.ok(!/\r\n8\r\nCONSTRUCTION\r\n/.test(out.text), 'construction lines left out unless asked for');
  assert.ok(out.notes.some(n => n.includes('construction line')), 'and the notes say so');
  // %%% is one % sign in R12, so a %% in the words is written as two of them, and reads back as itself.
  assert.equal(r12Text('50%%'), '50%%%%%%', 'a literal %% is kept as itself');
  assert.equal(decodeText(r12Text('50%% A%%dB 100%%c')), '50%% A%%dB 100%%c');
  assert.equal(r12Name('Layer 5 (top)'), 'LAYER_5__TOP_');
  const withX = writeDxf(d, { textAsLines: true, construction: true, hidden: false });
  assert.ok(/\r\n8\r\nCONSTRUCTION\r\n/.test(withX.text), 'construction lines in when asked');
  assert.ok(!withX.text.includes('\r\n0\r\nTEXT\r\n'), 'text as lines: no TEXT items at all');
  // An é is one byte (Windows Western letters), as an R12 reader expects.
  const fr = newDrawing();
  fr.ents = ents([[text({ text: 'é' }), 'Text']]);
  const bytes = writeDxf(fr, { textAsLines: false, construction: false, hidden: false }).bytes;
  assert.ok(bytes.includes(0xe9), 'é as the byte E9');
});

test('DXF round trip: what is written is read back the same (curves within 0.005 mm)', () => {
  const d = newDrawing();
  const rr = rectangle(P(0, 0), P(600, 400), 10)!;
  d.ents = ents([
    [{ type: 'line', a: P(0, 0), b: P(600, 0) }, 'Geometry'],
    [{ type: 'circle', c: P(300, 200), r: 50 }, 'Geometry'],
    [{ type: 'arc', c: P(10, 10), r: 20, a0: 0.5, a1: 2 }, 'Geometry'],
    [rr, 'Geometry'],
    [{ type: 'ellipse', c: P(0, 0), m: P(100, 0), ratio: 0.5, t0: 0, t1: TAU }, 'Geometry'],
    [{ type: 'spline', fit: [P(0, 0), P(50, 40), P(100, 0), P(150, 30)], closed: false }, 'Geometry'],
    [text({ text: 'Hello', h: 5, align: 'right', p: P(300, 450), angle: 0.3 }), 'Text'],
  ]);
  const back = readDxf(writeDxf(d, { textAsLines: false, construction: false, hidden: false }).bytes).drawing;
  const kinds = back.ents.map(e => e.type);
  assert.deepEqual(kinds, ['line', 'circle', 'arc', 'poly', 'poly', 'poly', 'text']);
  const [l, c, a, r, el, sp, t] = back.ents;
  assert.ok(l.type === 'line' && dist(l.b, P(600, 0)) < 1e-9, 'line end');
  assert.ok(c.type === 'circle' && Math.abs(c.r - 50) < 1e-9, 'circle radius');
  assert.ok(a.type === 'arc' && Math.abs(a.a0 - 0.5) < 1e-9 && Math.abs(a.a1 - 2) < 1e-9, 'arc angles');
  close(areaOf(r)!, areaOf(rr)!, 'rounded rectangle area (bulges kept)', 1e-6);
  assert.equal(back.layers.find(x => x.name === 'Geometry')?.colour, '#ffffff', 'layer back, white');
  // Our own layers, written in capitals, open under our spelling: one Construction layer, not two.
  assert.deepEqual(back.layers.map(x => x.name).filter(n => n.toUpperCase() !== '0').sort(), ['Construction', 'Dimensions', 'Geometry', 'Text']);
  assert.ok(back.ents.every(e => back.layers.some(x => x.name === e.layer)), 'every item on a layer that is there');
  assert.equal(t.layer, 'Text', 'the text on Text');
  // Every point of the ellipse's polyline is within 0.005 mm of the true ellipse.
  let worst = 0;
  for (const p of piecesOf(el)) {
    for (let i = 0; i <= 20; i++) {
      const q = p.k === 'arc' ? P(p.c.x + p.r * Math.cos(p.a0 + ((p.a1 - p.a0) * i) / 20), p.c.y + p.r * Math.sin(p.a0 + ((p.a1 - p.a0) * i) / 20)) : P(0, 0);
      const truth = nearestOn({ k: 'ell', c: P(0, 0), m: P(100, 0), ratio: 0.5, t0: 0, t1: TAU }, q);
      worst = Math.max(worst, dist(q, truth));
    }
  }
  assert.ok(worst <= 0.0051, `ellipse within 0.005 mm (worst ${worst})`);
  close(areaOf(el)!, Math.PI * 100 * 50, 'ellipse area', 2.5);
  // The curve's polyline passes through its fit points.
  for (const f of [P(50, 40), P(100, 0)]) assert.ok(Math.min(...piecesOf(sp).map(p => dist(nearestOn(p, f), f))) < 0.006, 'through the fit points');
  assert.ok(t.type === 'text' && t.text === 'Hello' && Math.abs(t.h - 5) < 1e-9 && t.align === 'right' && Math.abs(t.angle - 0.3) < 1e-9, 'text back with its height, end and turn');
  near((t as TextShape).p, P(300, 450), 'text foot');
});

test('curveToBulges: a circle traced from its formula comes back as arcs of that circle', () => {
  const pl = curveToBulges(t => P(10 * Math.cos(t), 10 * Math.sin(t)), 0, TAU, 0.001, 4);
  const poly: Shape = { type: 'poly', pts: pl.pts.slice(0, -1), bulges: pl.bulges, closed: true };
  close(areaOf(poly)!, Math.PI * 100, 'exactly a circle: four quarter arcs', 1e-6);
  assert.equal(pl.bulges.length, 4, 'four spans, no more needed');
});

// ---- DXF in ---------------------------------------------------------------------------------------------------------

const R12 = [
  '0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009', '0', 'ENDSEC',
  '0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER', '70', '2',
  '0', 'LAYER', '2', 'CUT', '70', '0', '62', '1', '6', 'CONTINUOUS',
  '0', 'LAYER', '2', 'HOLES', '70', '4', '62', '-3', '6', 'HIDDEN',
  '0', 'ENDTAB', '0', 'ENDSEC',
  '0', 'SECTION', '2', 'ENTITIES',
  '0', 'LINE', '8', 'CUT', '10', '0.0', '20', '0.0', '30', '0.0', '11', '600.0', '21', '0.0', '31', '0.0',
  '0', 'ARC', '8', 'CUT', '10', '0.0', '20', '0.0', '30', '0.0', '40', '25.0', '50', '0.0', '51', '90.0',
  '0', 'ARC', '8', 'CUT', '10', '10.0', '20', '0.0', '30', '0.0', '40', '5.0', '50', '0.0', '51', '90.0', '210', '0.0', '220', '0.0', '230', '-1.0',
  '0', 'CIRCLE', '8', 'HOLES', '62', '5', '10', '300.0', '20', '200.0', '30', '0.0', '40', '6.5',
  '0', 'POLYLINE', '8', 'CUT', '66', '1', '10', '0.0', '20', '0.0', '30', '0.0', '70', '1',
  '0', 'VERTEX', '8', 'CUT', '10', '0.0', '20', '0.0', '30', '0.0',
  '0', 'VERTEX', '8', 'CUT', '10', '100.0', '20', '0.0', '30', '0.0', '42', '1.0',
  '0', 'VERTEX', '8', 'CUT', '10', '100.0', '20', '100.0', '30', '0.0',
  '0', 'VERTEX', '8', 'CUT', '10', '0.0', '20', '100.0', '30', '0.0',
  '0', 'SEQEND', '8', 'CUT',
  '0', 'TEXT', '8', 'CUT', '10', '40.0', '20', '50.0', '30', '0.0', '40', '5.0', '1', '%%c12 THRU', '72', '1', '11', '50.0', '21', '50.0', '31', '0.0',
  '0', 'SOLID', '8', 'CUT', '10', '0', '20', '0', '11', '1', '21', '0', '12', '0', '22', '1', '13', '1', '23', '1',
  '0', 'ENDSEC', '0', 'EOF',
];

test('DXF in (R12, as older CAM programs and AutoCAD write it): layers, items, mirrored arcs, text codes, left out listed', () => {
  const { drawing, report, leftOut } = readDxf(enc(R12));
  const cut = drawing.layers.find(l => l.name === 'CUT')!;
  const holes = drawing.layers.find(l => l.name === 'HOLES')!;
  assert.equal(cut.colour, '#ff4040', 'colour 1 is red');
  assert.equal(holes.colour, '#60ff60', 'colour 3 is green');
  assert.equal(holes.on, false, 'a minus colour is a layer turned off');
  assert.equal(holes.locked, true, 'flag 4 is locked');
  assert.equal(holes.lineType, 'hidden', 'its line type');
  assert.equal(drawing.units, 'mm', 'no units in the file: millimetres');
  const [line, arc, flipped, circle, poly, words] = drawing.ents;
  assert.ok(line.type === 'line' && dist(line.b, P(600, 0)) < 1e-12);
  assert.ok(arc.type === 'arc' && Math.abs(arc.a1 - Math.PI / 2) < 1e-12);
  // Seen from below (extrusion 0,0,-1), the arc centred at 10,0 from 0 to 90 degrees is at -10,0 from 90 to 180.
  assert.ok(flipped.type === 'arc', 'the mirrored arc');
  near((flipped as { c: Pt }).c, P(-10, 0), 'its centre, seen from above');
  close((flipped as { a0: number }).a0, Math.PI / 2, 'from 90 degrees');
  close((flipped as { a1: number }).a1, Math.PI, 'to 180');
  assert.ok(circle.type === 'circle' && circle.r === 6.5 && circle.layer === 'HOLES');
  // The square with one side bulged out by a half circle (bulge 1): 100 x 100 plus half a circle of radius 50.
  close(areaOf(poly)!, 10000 + (Math.PI * 2500) / 2, 'polyline with a bulge');
  assert.ok(words.type === 'text' && words.text === 'Ø12 THRU' && words.align === 'centre', 'text: %%c is a diameter sign, centred');
  near((words as TextShape).p, P(50, 50), 'centred text sits on its second point');
  assert.equal(leftOut, 1, 'the SOLID is left out');
  assert.ok(report.some(l => /Left out.*SOLID/.test(l)), 'and listed');
  assert.ok(report.some(l => /colour of its own/.test(l)), 'own colours said');
});

const R2000 = [
  '0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1015', '9', '$INSUNITS', '70', '1', '0', 'ENDSEC',
  '0', 'SECTION', '2', 'BLOCKS',
  '0', 'BLOCK', '8', '0', '2', 'BOLT', '70', '0', '10', '0.0', '20', '0.0', '30', '0.0',
  '0', 'CIRCLE', '8', '0', '10', '0.0', '20', '0.0', '30', '0.0', '40', '5.0',
  '0', 'LINE', '8', 'MARK', '10', '0.0', '20', '0.0', '30', '0.0', '11', '10.0', '21', '0.0', '31', '0.0',
  '0', 'ENDBLK', '8', '0',
  '0', 'BLOCK', '8', '0', '2', '*D1', '70', '1', '10', '0.0', '20', '0.0', '30', '0.0',
  '0', 'LINE', '8', '0', '10', '0.0', '20', '-10.0', '30', '0.0', '11', '50.0', '21', '-10.0', '31', '0.0',
  '0', 'MTEXT', '8', '0', '10', '25.0', '20', '-8.0', '30', '0.0', '40', '2.5', '71', '8', '1', '50',
  '0', 'POINT', '8', 'DEFPOINTS', '10', '0.0', '20', '0.0', '30', '0.0',
  '0', 'ENDBLK', '8', '0',
  '0', 'ENDSEC',
  '0', 'SECTION', '2', 'ENTITIES',
  '0', 'LWPOLYLINE', '8', 'PART', '90', '4', '70', '1', '10', '0', '20', '0', '42', '0', '10', '100', '20', '0', '42', '1', '10', '100', '20', '100', '10', '0', '20', '100',
  '0', 'ELLIPSE', '8', 'PART', '10', '0', '20', '0', '30', '0', '11', '10', '21', '0', '31', '0', '40', '0.5', '41', '0', '42', '3.14159265358979',
  '0', 'SPLINE', '8', 'PART', '70', '8', '71', '2', '72', '6', '73', '3', '74', '0', '40', '0', '40', '0', '40', '0', '40', '1', '40', '1', '40', '1',
  '10', '0', '20', '0', '30', '0', '10', '50', '20', '100', '30', '0', '10', '100', '20', '0', '30', '0',
  '0', 'MTEXT', '8', 'NOTES', '10', '0', '20', '10', '30', '0', '40', '2', '71', '1', '1', '{\\fArial|b1|i0|c0|p34;Hello}\\PWorld \\S1/2;',
  '0', 'INSERT', '8', 'PARTS', '2', 'BOLT', '10', '100', '20', '100', '30', '0', '41', '2', '42', '2', '50', '90',
  '0', 'INSERT', '8', 'PARTS', '2', 'BOLT', '10', '0', '20', '0', '30', '0', '41', '2', '42', '1',
  '0', 'DIMENSION', '8', 'DIMS', '2', '*D1', '10', '0', '20', '0', '30', '0',
  '0', 'HATCH', '8', 'PART',
  '0', 'ENDSEC', '0', 'EOF',
];

test('DXF in (AutoCAD 2000 kind): inches, light polylines, ellipse arcs, splines as arcs, paragraph text, blocks and dimensions taken apart', () => {
  const { drawing, report } = readDxf(enc(R2000));
  assert.equal(drawing.units, 'inch', '$INSUNITS 1 is inches');
  const part = drawing.ents.filter(e => e.layer === 'PART');
  const [lw, el, sp] = part;
  close(areaOf(lw)!, 10000 + (Math.PI * 2500) / 2, 'light polyline with its bulge');
  assert.ok(el.type === 'ellipse' && Math.abs(el.t1 - Math.PI) < 1e-9 && el.ratio === 0.5, 'half an ellipse');
  // The quadratic curve through control points 0,0 50,100 100,0 passes through 50,50 at its middle.
  assert.ok(sp.type === 'poly', 'the spline as a polyline of arcs');
  assert.ok(Math.min(...piecesOf(sp).map(p => dist(nearestOn(p, P(50, 50)), P(50, 50)))) < 0.00021, 'and within 0.0002 in of the true curve');
  const notes = drawing.ents.find(e => e.layer === 'NOTES') as TextShape;
  assert.equal(notes.text, 'Hello\nWorld 1/2', 'paragraph text without its formatting codes');
  near(notes.p, P(0, 8), 'hung from its top-left corner: the first line\'s foot one height down');
  // The block: its circle (on layer 0) takes the insert's layer; its line keeps MARK.
  const big = drawing.ents.find(e => e.type === 'circle' && e.layer === 'PARTS');
  assert.ok(big && big.type === 'circle' && Math.abs(big.r - 10) < 1e-9 && dist(big.c, P(100, 100)) < 1e-9, 'block circle scaled 2 at 100,100');
  const mark = drawing.ents.find(e => e.type === 'line' && e.layer === 'MARK' && dist((e as { a: Pt }).a, P(100, 100)) < 1e-9);
  assert.ok(mark && mark.type === 'line' && dist(mark.b, P(100, 120)) < 1e-9, 'block line turned 90 degrees');
  // Stretched twice as wide as high: the circle becomes an ellipse 20 x 10 (as arcs).
  const squashed = drawing.ents.find(e => e.type === 'poly' && e.layer === 'PARTS')!;
  close(areaOf(squashed)!, Math.PI * 10 * 5, 'stretched circle', 0.05);
  // The dimension: its line and number on DIMS, its definition point dropped.
  const dims = drawing.ents.filter(e => e.layer === 'DIMS');
  assert.deepEqual(dims.map(e => e.type).sort(), ['line', 'text'], 'dimension taken apart');
  assert.ok(!drawing.ents.some(e => e.type === 'point'), 'no definition points');
  assert.ok(report.some(l => /Left out.*hatch/.test(l)), 'the hatch is listed as left out');
  assert.ok(report.some(l => /taken apart/.test(l)), 'blocks taken apart said');
});

test('DXF in: refuses DWG and binary DXF with what to do instead; decodes AutoCAD text codes', () => {
  assert.throws(() => readDxf(new TextEncoder().encode('AC1027 rest of a dwg')), /DWG drawing.*Save it as DXF/);
  assert.throws(() => readDxf(new TextEncoder().encode('AutoCAD Binary DXF\r\n')), /binary DXF/);
  assert.throws(() => readDxf(new TextEncoder().encode('hello\nworld\n')), /not a DXF/);
  assert.equal(decodeText('45%%d %%p0.1 %%c8 100%%%'), '45° ±0.1 Ø8 100%');
  assert.equal(decodeText('\\U+00B0'), '°');
  assert.equal(decodeMtext('A\\Pb\\~c\\\\d\\{e\\}'), 'A\nb c\\d{e}');
  // A file from Windows' Western letters (not UTF-8) still reads.
  const lines = R12.map(l => (l === '%%c12 THRU' ? 'café' : l));
  const raw = lines.join('\r\n');
  const bytes = new Uint8Array([...raw].map(ch => ch.charCodeAt(0)));
  const t = readDxf(bytes).drawing.ents.find(e => e.type === 'text') as TextShape;
  assert.equal(t.text, 'café');
});
