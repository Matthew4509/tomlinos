// CAD Draft audit (26 Nov): faults found by trying to break the shape code. Each test fails while its fault is there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { P, type Pt } from '../src/apps/cad/geom.ts';
import { type Shape } from '../src/apps/cad/model.ts';
import { areaOf } from '../src/apps/cad/modify.ts';
import { scaleShape } from '../src/apps/cad/edit.ts';
import { dimLabel, type DimShape } from '../src/apps/cad/notes.ts';

test('CAD-P1-3: a closed curve through points has an area (Area says it is not closed)', { todo: 'P1, waiting on direction' }, () => {
  const s: Shape = { type: 'spline', fit: [P(0, 0), P(10, 0), P(10, 10), P(0, 10)], closed: true };
  const a = areaOf(s);
  assert.notEqual(a, null, 'a closed curve is closed: Area should measure it, not say "That shape is not closed"');
  assert.ok(a! > 80 && a! < 160, `about the square it runs round (100), got ${a}`);
});

test('CAD-P1-4: a polyline that crosses itself is not given an area of 0', { todo: 'P1, waiting on direction' }, () => {
  const bow: Pt[] = [P(0, 0), P(10, 10), P(10, 0), P(0, 10)];
  const a = areaOf({ type: 'poly', pts: bow, bulges: [0, 0, 0, 0], closed: true });
  // Two triangles of 25 each; refusing (null, with a reason) would also be right. 0 is a wrong measurement.
  assert.ok(a === null || Math.abs(a - 50) < 1e-9, `a bow tie of two 25 triangles: got ${a}`);
});

test('CAD-P1-5: Units mm to inches keeps the precision a dimension showed (600 mm is 23.622 in, not 23.62)', { todo: 'P1, waiting on direction' }, () => {
  const d: DimShape = { type: 'dim', kind: 'linear', pts: [P(0, 0), P(600, 0), P(300, 20)], dir: 0, h: 3.5, arrow: 2.5, dp: 2, text: '' };
  assert.equal(dimLabel(d), '600');
  // What Utils > Units > Inches with "Change the sizes too" does to each item (src/apps/cad.ts unitsDialog).
  const inch = scaleShape(d, P(0, 0), 1 / 25.4);
  assert.equal(dimLabel(inch), '23.622', 'the inch default is 3 places; keeping 2 rounds away a hundredth of a millimetre-level size');
});
