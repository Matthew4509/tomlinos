// KerfLine says what a DXF holds that a drawing does not keep, so nothing is lost quietly when the drawing is output
// again: items at a height (Z) off 0, items with a thickness, items with a line type or a true colour of their own.
// A DXF KerfLine wrote itself says none of them. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { P } from '../src/apps/cad/geom.ts';
import { newDrawing } from '../src/apps/cad/model.ts';
import { readDxf, writeDxf } from '../src/apps/cad/dxf.ts';

const enc = (lines: string[]) => new TextEncoder().encode(lines.join('\r\n') + '\r\n');
const entities = (items: string[]) => enc([
  '0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1015', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC',
  '0', 'SECTION', '2', 'ENTITIES', ...items, '0', 'ENDSEC', '0', 'EOF',
]);
const lineAt = (z: string, extra: string[] = []) => ['0', 'LINE', '8', 'A', ...extra, '10', '0', '20', '0', '30', z, '11', '100', '21', '0', '31', z];

test('items at a height are drawn flat, counted and said, with what a DXF output does to them', () => {
  const read = readDxf(entities([...lineAt('-18'), ...lineAt('0'), '0', 'LWPOLYLINE', '8', 'A', '90', '2', '70', '0', '38', '-6', '10', '0', '20', '0', '10', '5', '20', '5']));
  assert.equal(read.drawing.ents.length, 3, 'all three are drawn');
  assert.equal(read.changed, 2);
  assert.match(read.report.join('\n'), /2 items sit at a height \(Z\) other than 0: drawn flat, and a DXF output from here puts them at 0/);
});

test('a thickness, a line type of the item’s own and a true colour are each said; BYLAYER is not', () => {
  const read = readDxf(entities([
    ...lineAt('0', ['39', '25']),
    ...lineAt('0', ['6', 'DASHED']),
    ...lineAt('0', ['6', 'BYLAYER']),
    ...lineAt('0', ['420', '16711680']),
  ]));
  const text = read.report.join('\n');
  assert.match(text, /1 item has a thickness/);
  assert.match(text, /1 item has a line type of its own/);
  assert.match(text, /1 item has a colour of its own/);
  assert.equal(read.changed, 3);
  assert.equal(read.leftOut, 0, 'nothing was left out: all four lines are drawn');
});

test('a plain DXF, and one KerfLine wrote itself, say none of them', () => {
  const plain = readDxf(entities(lineAt('0')));
  assert.equal(plain.changed, 0);
  const d = newDrawing();
  d.ents.push({ id: 1, layer: d.current, type: 'line', a: P(0, 0), b: P(50, 20) });
  d.ents.push({ id: 2, layer: d.current, type: 'circle', c: P(10, 10), r: 4 });
  const again = readDxf(writeDxf(d, { textAsLines: false, construction: false, hidden: false }).bytes);
  assert.equal(again.drawing.ents.length, 2);
  assert.equal(again.changed, 0);
  assert.equal(again.leftOut, 0);
});
