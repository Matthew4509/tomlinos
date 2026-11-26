// Round-2 audit of CAD Draft (app id "cad"): its rules tried on the drawing model, the .tcad file, the measurements and
// the DXF, DWG and SVG readers and writers. A failing test names a fault still open.
// Run: node --test test/audit2-cad.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { P } from '../src/apps/cad/geom.ts';
import { newDrawing, readTcad, writeTcad, type Ent, type Shape } from '../src/apps/cad/model.ts';
import { areaOf, whyNoArea } from '../src/apps/cad/modify.ts';
import { asBox, dragGrip, presetWarp } from '../src/apps/cad/textbox.ts';
import { mirrorShape, scaleShape, toUnits } from '../src/apps/cad/edit.ts';
import type { TextShape } from '../src/apps/cad/notes.ts';
import { DXF_VERSION_LIST, countOf, readDxf, writeDxf } from '../src/apps/cad/dxf.ts';
import { decimalComma, parseNumber } from '../src/apps/cad/input.ts';
import { dimLabel } from '../src/apps/cad/notes.ts';
import { writeDwg } from '../src/apps/cad/dwg/write.ts';
import { readDwg } from '../src/apps/cad/dwg/read.ts';
import { writeSvg } from '../src/apps/cad/svg.ts';

const enc = (lines: string[]) => new TextEncoder().encode(lines.join('\r\n') + '\r\n');
const withoutIds = (ents: Ent[]) => ents.map(({ id: _id, ...rest }) => rest);
const plain = (t: Partial<TextShape> = {}): TextShape => ({ type: 'text', p: P(0, 0), text: 'Sign', h: 5, angle: 0, align: 'left', ...t });

// ---- Rule 1: saved and reopened is the same drawing ----------------------------------------------------------------

test('rule 1: every kind of item, text boxes stretched, warped and bent by hand included, comes back from a .tcad exactly', () => {
  const d = newDrawing('mm');
  const box = asBox(plain({ p: P(5, 5), text: 'Hello\nthere', angle: 0.2 }));
  const warped: TextShape = { ...box, box: { ...box.box!, warp: presetWarp('arch', 40) } };
  const bent = dragGrip(warped, { kind: 'bend', edge: 'top', i: 1 }, P(0, 0), P(10, 30), false);
  const stretched = dragGrip(box, { kind: 'size', sx: 1, sy: 0 }, P(0, 0), P(80, 5), false);
  const shapes: Array<[Shape, string]> = [
    [{ type: 'line', a: P(0.1, 0.2), b: P(123.456789012345, -98.7654321) }, 'Geometry'],
    [{ type: 'arc', c: P(10, 10), r: 5.5, a0: 0.3, a1: 2.9 }, 'Geometry'],
    [{ type: 'circle', c: P(-10, 5), r: 3.25 }, 'Geometry'],
    [{ type: 'ellipse', c: P(50, 50), m: P(20, 5), ratio: 0.4, t0: 0.5, t1: 4 }, 'Geometry'],
    [{ type: 'poly', pts: [P(0, 0), P(10, 0), P(10, 10), P(0, 10)], bulges: [0, 0.5, 0, -0.3], closed: true }, 'Geometry'],
    [{ type: 'spline', fit: [P(0, 0), P(10, 5), P(20, -3), P(5, -8)], closed: true }, 'Geometry'],
    [{ type: 'point', p: P(3, 4) }, 'Geometry'],
    [{ type: 'xline', p: P(0, 0), d: P(0.6, 0.8) }, 'Construction'],
    [plain({ arc: { c: P(0, -20), r: 20, cw: true }, align: 'centre' }), 'Text'],
    [box, 'Text'], [warped, 'Text'], [bent, 'Text'], [stretched, 'Text'],
    [{ type: 'dim', kind: 'angle', pts: [P(0, 0), P(10, 0), P(0, 10), P(5, 5)], dir: 0, h: 3.5, arrow: 2.5, dp: 3, text: '<> approx' }, 'Dimensions'],
  ];
  d.ents = shapes.map(([s, layer], i) => ({ ...s, id: i + 1, layer }) as Ent);
  const back = readTcad(writeTcad(d));
  assert.equal(back.damaged + back.skipped, 0);
  assert.deepEqual(withoutIds(back.drawing.ents), withoutIds(d.ents));
});

test('CD-1: a text box bent by hand with a handle dragged far out still opens again after Save (it is not dropped as damaged)', () => {
  // A small box (1 letter, 1 mm high) and a bend handle dragged a couple of metres away: allowed while drawing.
  const small = asBox(plain({ text: 'x', h: 1 }));
  const far = dragGrip(small, { kind: 'bend', edge: 'top', i: 1 }, P(0, 0), P(2000, 2000), false);
  const d = newDrawing('mm');
  d.ents = [{ ...far, id: 1, layer: 'Text' } as Ent];
  const back = readTcad(writeTcad(d));
  assert.equal(back.damaged, 0, `the bent text was refused on reopening: ${back.why}`);
  assert.equal(back.drawing.ents.length, 1);
});

// ---- Rule 5: undo and the edits it restores are exact ------------------------------------------------------------

test('rule 5: mirroring twice and scaling back give the same text box, warp and bend included', () => {
  const box = asBox(plain({ p: P(5, 5), angle: 0.2 }));
  const bent = dragGrip({ ...box, box: { ...box.box!, warp: presetWarp('flag', 40) } }, { kind: 'bend', edge: 'top', i: 2 }, P(0, 0), P(20, 18), false);
  const round = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'number' ? Math.round(x * 1e6) / 1e6 : x));
  for (const s of [box, bent] as Shape[]) {
    assert.equal(round(mirrorShape(mirrorShape(s, P(3, 1), P(7, 9)), P(3, 1), P(7, 9))), round(s));
    assert.equal(round(scaleShape(scaleShape(s, P(3, 4), 2.5), P(3, 4), 1 / 2.5)), round(s));
  }
});

// ---- Rule 7: measurements --------------------------------------------------------------------------------------------

test('rule 7: a square with one side bulged out by a half circle has area 4 + pi/2', () => {
  const s: Shape = { type: 'poly', pts: [P(0, 0), P(2, 0), P(2, 2), P(0, 2)], bulges: [0, 1, 0, 0], closed: true };
  assert.ok(Math.abs(areaOf(s)! - (4 + Math.PI / 2)) < 1e-9);
});

test('CD-2: a closed polyline that crosses itself (a bow tie of two 1 x 2 triangles) is not given an area of 0', () => {
  const bow: Shape = { type: 'poly', pts: [P(0, 0), P(2, 2), P(2, 0), P(0, 2)], bulges: [0, 0, 0, 0], closed: true };
  const a = areaOf(bow);
  // The two triangles enclose 2 square units between them; 0 is the two lobes cancelling.
  assert.ok(a === null || Math.abs(a - 2) < 1e-9, `area given: ${a}`);
});

test('CD-3: a closed curve through points has an area (Area said it is not closed)', () => {
  const s: Shape = { type: 'spline', fit: [P(0, 0), P(10, 0), P(10, 10), P(0, 10)], closed: true };
  assert.notEqual(areaOf(s), null);
});

// ---- Rule 2: precision and units through DXF, DWG and SVG --------------------------------------------------------------

test('rule 2: lines, arcs, ellipses and curves keep their numbers and units through every DXF release and DWG (mm and inch)', () => {
  for (const units of ['mm', 'inch'] as const) {
    const d = newDrawing(units);
    d.ents = [
      { type: 'line', a: P(0.001, 0.002), b: P(12.3456789, -1), id: 1, layer: 'Geometry' },
      { type: 'arc', c: P(10, 10), r: 5.5, a0: 0.3, a1: 2.9, id: 2, layer: 'Geometry' },
      { type: 'spline', fit: [P(0, 0), P(10, 5), P(20, -3), P(5, -8)], closed: true, id: 3, layer: 'Geometry' },
    ] as Ent[];
    const opts = { textAsLines: false, construction: true, hidden: true };
    const reads = [...DXF_VERSION_LIST.map(v => readDxf(writeDxf(d, { ...opts, version: v }).bytes)), readDwg(writeDwg(d, opts).bytes)];
    for (const r of reads) {
      assert.equal(r.drawing.units, units);
      const line = r.drawing.ents.find(e => e.type === 'line')!;
      assert.deepEqual([line.type === 'line' && line.a, line.type === 'line' && line.b], [P(0.001, 0.002), P(12.3456789, -1)]);
      const arc = r.drawing.ents.find(e => e.type === 'arc')!;
      assert.ok(arc.type === 'arc' && Math.abs(arc.r - 5.5) < 1e-9 && Math.abs(arc.a0 - 0.3) < 1e-9 && Math.abs(arc.a1 - 2.9) < 1e-9);
    }
  }
});

test('CD-9: a coordinate with more than ten decimals keeps them through a DXF (123.456789012345 does not come back as 123.4567890123)', () => {
  const d = newDrawing('mm');
  d.ents = [{ type: 'line', a: P(0, 0), b: P(123.456789012345, 0), id: 1, layer: 'Geometry' } as Ent];
  const r = readDxf(writeDxf(d, { version: '2018', textAsLines: false, construction: false, hidden: false }).bytes);
  const l = r.drawing.ents[0];
  assert.ok(l.type === 'line' && l.b.x === 123.456789012345);
});

test('CD-10: text of two lines comes back from a DWG as one text of two lines (as from a 2000+ DXF), not two texts', { todo: 'P2: held, the DWG writer has no MTEXT yet (said in the output notes instead)' }, () => {
  const d = newDrawing('mm');
  d.ents = [{ ...plain({ text: 'two\nlines' }), id: 1, layer: 'Text' } as Ent];
  const r = readDwg(writeDwg(d, { textAsLines: false, construction: false, hidden: false }).bytes);
  assert.deepEqual(r.drawing.ents.filter(e => e.type === 'text').map(e => (e as TextShape).text), ['two\nlines']);
});

test('CD-11: words ending in spaces keep them through a DXF (right-aligned text does not move)', () => {
  const d = newDrawing('mm');
  d.ents = [{ ...plain({ text: 'total  ', align: 'right' }), id: 1, layer: 'Text' } as Ent];
  const r = readDxf(writeDxf(d, { version: '2018', textAsLines: false, construction: false, hidden: false }).bytes);
  assert.equal((r.drawing.ents[0] as TextShape).text, 'total  ');
});

test('rule 2: an SVG is at true size: width and height in the drawing units, arcs anticlockwise (sweep 0), no script', () => {
  const d = newDrawing('inch');
  d.ents = [{ type: 'arc', c: P(0, 0), r: 1, a0: 0, a1: Math.PI / 2, id: 1, layer: 'Geometry' } as Ent];
  const svg = writeSvg(d, { white: false, textAsLines: false, construction: false, title: '<script>x</script>' }).text;
  assert.match(svg, /width="[\d.]+in" height="[\d.]+in"/);
  assert.match(svg, /M 1 0 A 1 1 0 0 0 0 -1/);
  assert.ok(!/<script/i.test(svg));
});

// ---- Rule 4: crafted files are refused in words, never hang --------------------------------------------------------

const dxfOf = (blocks: string[], ents: string[], tables: string[] = []) => enc([
  '0', 'SECTION', '2', 'TABLES', ...tables, '0', 'ENDSEC',
  '0', 'SECTION', '2', 'BLOCKS', ...blocks, '0', 'ENDSEC',
  '0', 'SECTION', '2', 'ENTITIES', ...ents, '0', 'ENDSEC', '0', 'EOF',
]);
const lineAt = (x: string) => ['0', 'LINE', '8', 'A', '10', x, '20', '0', '11', '1', '21', '1'];

test('rule 4: a block that inserts itself, and a 1000 x 1000 repeated insert, are refused in words at once', () => {
  const self = ['0', 'BLOCK', '2', 'A', '10', '0', '20', '0', ...lineAt('0'), '0', 'INSERT', '2', 'A', '10', '1', '20', '0', '0', 'INSERT', '2', 'A', '10', '2', '20', '0', '0', 'INSERT', '2', 'A', '10', '3', '20', '0', '0', 'ENDBLK'];
  const t = Date.now();
  assert.throws(() => readDxf(dxfOf(self, ['0', 'INSERT', '2', 'A', '10', '0', '20', '0'])), /cannot be opened: it holds more than 200,000 items/);
  assert.throws(() => readDxf(dxfOf(['0', 'BLOCK', '2', 'B', '10', '0', '20', '0', ...lineAt('0'), '0', 'ENDBLK'], ['0', 'INSERT', '2', 'B', '70', '1000', '71', '1000', '44', '1', '45', '1'])), /more than 200,000 items/);
  assert.ok(Date.now() - t < 3000);
});

test('CD-8: a DXF listing 60,000 layers (1.6 MB) opens or is refused within 3 seconds (the page is not frozen)', () => {
  const tables = ['0', 'TABLE', '2', 'LAYER'];
  for (let i = 0; i < 60_000; i++) tables.push('0', 'LAYER', '2', `L${i}`, '62', '7');
  tables.push('0', 'ENDTAB');
  const bytes = dxfOf([], ['0', 'POINT', '8', 'L1', '10', '0', '20', '0'], tables);
  const t = Date.now();
  try {
    readDxf(bytes);
  } catch {
    // Refused in words is a pass too.
  }
  const ms = Date.now() - t;
  assert.ok(ms < 3000, `reading took ${ms} ms`);
});

test('CD-4: a DXF coordinate that is not a number (NaN, 1e400) is refused or counted, not silently read as 0', () => {
  const r = readDxf(dxfOf([], [...lineAt('NaN'), ...lineAt('1e400')]));
  const quiet = r.drawing.ents.length === 2 && r.leftOut === 0 && !r.report.some(l => /not a number|damaged|left out/i.test(l));
  assert.ok(!quiet, `both lines were drawn from x = 0 and nothing was said: ${r.report.join(' / ')}`);
});

test('rule 4: a damaged DWG (bytes changed at random, 400 tries) is always refused in words or opened, quickly', () => {
  const d = newDrawing('mm');
  d.ents = Array.from({ length: 12 }, (_, i) => ({ type: 'line', a: P(i, 0), b: P(i, 10), id: i + 1, layer: 'Geometry' }) as Ent);
  d.ents.push({ ...plain({ text: 'Hello\nthere' }), id: 99, layer: 'Text' } as Ent);
  const base = writeDwg(d, { textAsLines: false, construction: true, hidden: true }).bytes;
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  const t = Date.now();
  for (let it = 0; it < 400; it++) {
    const b = base.slice();
    for (let k = 0; k < 1 + Math.floor(rnd() * 6); k++) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
    try {
      readDwg(b);
    } catch (error) {
      assert.ok(error instanceof Error && /^This /.test(error.message), `refused with a raw error: ${String(error)}`);
    }
  }
  assert.ok(Date.now() - t < 20000);
});

test('CD-7: a DXF with more layers than a drawing keeps (1,200) can still be saved: the empty ones can be cleared at once', () => {
  // Reading it gives 1,200 layers; Save then refuses ("Delete the ones not needed") and there is no way to clear empty
  // layers other than one at a time. Here: the read keeps no more than a drawing can save, or says how to.
  const tables = ['0', 'TABLE', '2', 'LAYER'];
  for (let i = 0; i < 1200; i++) tables.push('0', 'LAYER', '2', `L${i}`, '62', '7');
  tables.push('0', 'ENDTAB');
  const r = readDxf(dxfOf([], ['0', 'POINT', '8', 'L1', '10', '0', '20', '0'], tables));
  assert.ok(r.drawing.layers.length <= 1000 || r.report.some(l => /layer/i.test(l) && /1,000|empty/i.test(l)));
  assert.ok(r.report.some(l => /Delete empty layers/.test(l)), 'the open report does not say how to clear the empty layers');
});

// ---- Round-2 P1/P2 fixes ---------------------------------------------------------------------------------------------

test('CD-3: a closed curve through points gets its true area (a curve through a circle\'s points is near the circle)', () => {
  const n = 24;
  const fit = Array.from({ length: n }, (_, i) => P(10 * Math.cos((i / n) * 2 * Math.PI), 10 * Math.sin((i / n) * 2 * Math.PI)));
  const a = areaOf({ type: 'spline', fit, closed: true });
  assert.ok(a !== null && Math.abs(a - Math.PI * 100) < 0.5, `area ${a}`);
  assert.equal(areaOf({ type: 'spline', fit, closed: false }), null);
});

test('Area: a closed polyline that crosses itself is said to cross itself, not to be open', () => {
  const bow: Shape = { type: 'poly', pts: [P(0, 0), P(2, 2), P(2, 0), P(0, 2)], bulges: [0, 0, 0, 0], closed: true };
  assert.equal(areaOf(bow), null);
  assert.equal(whyNoArea(bow), 'crosses');
  assert.equal(whyNoArea({ type: 'line', a: P(0, 0), b: P(1, 0) }), 'open');
});

test('CD-4: NaN and 1e400 coordinates leave their items out, counted in the open report', () => {
  const r = readDxf(dxfOf([], [...lineAt('NaN'), ...lineAt('1e400'), ...lineAt('5')]));
  assert.equal(r.drawing.ents.length, 1);
  assert.equal(r.leftOut, 2);
  assert.ok(r.report.some(l => /2 items with a number that is not a number/.test(l)), r.report.join(' / '));
});

test('CD-12: the open report counts curves through points in plain English (not "curve through pointss")', () => {
  assert.equal(countOf(2, 'curve through points'), '2 curves through points');
  assert.equal(countOf(1, 'curve through points'), '1 curve through points');
  assert.equal(countOf(3, 'line of no length'), '3 lines of no length');
  assert.equal(countOf(2, '3D body'), '2 3D bodies');
  assert.equal(countOf(2, 'filled triangle or square (SOLID)'), '2 filled triangles or squares (SOLID)');
  const d = newDrawing('mm');
  d.ents = [0, 1].map(i => ({ type: 'spline', fit: [P(i, 0), P(i + 5, 5), P(i + 10, 0)], closed: false, id: i + 1, layer: 'Geometry' }) as Ent);
  const r = readDxf(writeDxf(d, { version: '2018', textAsLines: false, construction: false, hidden: false }).bytes);
  assert.ok(!r.report.join(' ').includes('pointss'), r.report.join(' / '));
});

test('CD-14: a polyline bulge over 1e6 (an arc a hair short of a full circle) is kept through a .tcad, not straightened', () => {
  const d = newDrawing('mm');
  d.ents = [{ type: 'poly', pts: [P(0, 0), P(1, 0)], bulges: [5e6, 0], closed: false, id: 1, layer: 'Geometry' } as Ent];
  const back = readTcad(writeTcad(d));
  const p = back.drawing.ents[0];
  assert.ok(p.type === 'poly' && p.bulges[0] === 5e6);
});

test('CD-15: a literal \\U+0041 typed in text comes back as typed from an R12 DXF and a DWG (not as A)', () => {
  const d = newDrawing('mm');
  d.ents = [{ ...plain({ text: 'code \\U+0041 here' }), id: 1, layer: 'Text' } as Ent];
  const opts = { textAsLines: false, construction: false, hidden: false };
  for (const r of [readDxf(writeDxf(d, { ...opts, version: 'R12' }).bytes), readDwg(writeDwg(d, opts).bytes)]) {
    assert.deepEqual(r.drawing.ents.filter(e => e.type === 'text').map(e => (e as TextShape).text), ['code \\U+0041 here']);
  }
});

test('CD-10: a DWG output of text of two lines says, in its notes, that it opens again as separate texts', () => {
  const d = newDrawing('mm');
  d.ents = [{ ...plain({ text: 'two\nlines' }), id: 1, layer: 'Text' } as Ent, { ...plain({ text: 'one line' }), id: 2, layer: 'Text' } as Ent];
  const w = writeDwg(d, { textAsLines: false, construction: false, hidden: false });
  assert.ok(w.notes.some(n => /^1 text of more than one line is written as one text a line/.test(n)), w.notes.join(' / '));
  d.ents = [d.ents[1]];
  assert.ok(!writeDwg(d, { textAsLines: false, construction: false, hidden: false }).notes.some(n => /more than one line/.test(n)));
});

test('CAD-P1-1: 12,5 typed for a size reads as twelve and a half; 12,5.0 and 12, 5 do not', () => {
  assert.equal(decimalComma('12,5'), 12.5);
  assert.equal(decimalComma('-0,75'), -0.75);
  assert.equal(decimalComma('12,5.0'), null);
  assert.equal(decimalComma('12, 5'), null);
  assert.equal(decimalComma('12'), null);
  assert.equal(parseNumber('12,5'), null);
});

test('CAD-P1-5: mm to inch gives a dimension one more decimal place (600 mm shows 23.622, not 23.62), and back again', () => {
  const dim: Shape = { type: 'dim', kind: 'aligned', pts: [P(0, 0), P(600, 0), P(300, 20)], dir: 0, h: 3.5, arrow: 2.5, dp: 2, text: '' };
  const inch = toUnits(dim, 1 / 25.4);
  assert.ok(inch.type === 'dim' && inch.dp === 3 && dimLabel(inch) === '23.622', JSON.stringify(inch));
  const back = toUnits(inch, 25.4);
  assert.ok(back.type === 'dim' && back.dp === 2 && dimLabel(back) === '600');
  const angle: Shape = { type: 'dim', kind: 'angle', pts: [P(0, 0), P(10, 0), P(0, 10), P(5, 5)], dir: 0, h: 3.5, arrow: 2.5, dp: 1, text: '' };
  const a = toUnits(angle, 1 / 25.4);
  assert.ok(a.type === 'dim' && a.dp === 1, 'an angle keeps its places');
});
