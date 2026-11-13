// Faults found by the 14 Nov CAD walk (earlier audits O03/O14/O15, U02, U07, O12, O13, R3-S1/S2), each with its test.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { P, circumcircle, dist } from '../src/apps/cad/geom.ts';
import { newDrawing, readTcad, rectangle, writeTcad, type Shape } from '../src/apps/cad/model.ts';
import { moveShape } from '../src/apps/cad/edit.ts';
import { areaOf } from '../src/apps/cad/modify.ts';
import { readDxf, writeDxf } from '../src/apps/cad/dxf.ts';
import { TOOLS, type ToolCtx } from '../src/apps/cad/tools.ts';
import { defaultStyle, type DimShape } from '../src/apps/cad/notes.ts';

const enc = (lines: string[]) => new TextEncoder().encode(lines.join('\r\n') + '\r\n');

test('O14: leaving a leader part-way keeps the path drawn so far (one point is nothing yet)', () => {
  const added: Shape[] = [];
  const ctx = {
    add: (s: Shape[]) => { added.push(...s); return [1]; },
    say: () => {}, problem: () => {}, finished: () => {}, style: () => defaultStyle(false), noteLayer: () => 'Dimensions',
    askText: () => new Promise(() => {}),
  } as unknown as ToolCtx;
  const one = TOOLS.leader.make(ctx);
  one.point!(P(0, 0));
  one.keep!();
  assert.equal(added.length, 0, 'a single point is not a leader');
  const two = TOOLS.leader.make(ctx);
  two.point!(P(0, 0));
  two.point!(P(20, 20));
  two.keep!();
  assert.equal(added.length, 1);
  assert.equal((added[0] as DimShape).kind, 'leader');
  assert.equal((added[0] as DimShape).pts.length, 2);
});

test('U07: a layer line type that is only an inherited word (constructor, toString) opens as continuous', () => {
  for (const word of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const d = newDrawing('mm');
    (d.layers[0] as unknown as { lineType: string }).lineType = word;
    const back = readTcad(writeTcad(d)).drawing;
    assert.equal(back.layers[0].lineType, 'continuous', word);
  }
});

test('U02: two DXF layer names that differ only after 64 letters are said to have been joined', () => {
  const base = 'L'.repeat(64);
  const read = readDxf(enc([
    '0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER',
    '0', 'LAYER', '2', base + 'A', '70', '0', '62', '7', '6', 'CONTINUOUS',
    '0', 'LAYER', '2', base + 'B', '70', '1', '62', '7', '6', 'CONTINUOUS',
    '0', 'ENDTAB', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES', '0', 'LINE', '8', base + 'B', '10', '0', '20', '0', '11', '5', '21', '5', '0', 'ENDSEC', '0', 'EOF',
  ]));
  assert.match(read.report.join('\n'), /layer names? .*(64|joined|shortened)/i);
  assert.ok(read.changed >= 1);
});

test('O12: letters a DXF output cannot hold are counted and said, not turned into ? quietly', () => {
  const d = newDrawing('mm');
  d.ents.push({ id: 1, layer: 'Text', type: 'text', p: P(0, 0), text: 'Ωmega ж', h: 3.5, angle: 0, align: 'left' } as never);
  const w = writeDxf(d, { hidden: false, construction: false, textAsLines: false } as never);
  assert.match(w.notes.join('\n'), /letters? .*(could not|cannot|replaced)/i);
  const plain = newDrawing('mm');
  plain.ents.push({ id: 1, layer: 'Text', type: 'text', p: P(0, 0), text: 'Café ± 5°', h: 3.5, angle: 0, align: 'left' } as never);
  assert.doesNotMatch(writeDxf(plain, { hidden: false, construction: false, textAsLines: false } as never).notes.join('\n'), /could not|cannot|replaced/i);
});

test('O13: a leader read from a DXF in centimetres or feet gets the normal arrow and text size, not that size times the unit', () => {
  const dxf = (units: string) => enc([
    '0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', units, '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES', '0', 'LEADER', '8', '0', '10', '0', '20', '0', '10', '1', '20', '1', '0', 'ENDSEC', '0', 'EOF',
  ]);
  const cm = readDxf(dxf('5')).drawing.ents[0] as DimShape;
  assert.ok(Math.abs(cm.h - defaultStyle(false).dimH) < 1e-9, `cm: ${cm.h}`);
  assert.ok(Math.abs(cm.arrow - defaultStyle(false).arrow) < 1e-9);
  const ft = readDxf(dxf('2')).drawing.ents[0] as DimShape;
  assert.ok(Math.abs(ft.h - defaultStyle(true).dimH) < 1e-9, `ft: ${ft.h}`);
});

test('R3-S1: moving a closed shape far from the origin does not change its area', () => {
  const s = rectangle(P(0, 0), P(10, 10))!;
  assert.equal(areaOf(moveShape(s, P(1e9, 1e9))), areaOf(s));
});

test('R3-S2: a circle through three points far from the origin is still the circle through them', () => {
  const pts = [P(1e9, 1e9), P(1e9 + 10, 1e9), P(1e9, 1e9 + 10)];
  const cc = circumcircle(pts[0], pts[1], pts[2])!;
  assert.ok(pts.every(p => Math.abs(dist(p, cc.c) - cc.r) < 1e-5));
});
