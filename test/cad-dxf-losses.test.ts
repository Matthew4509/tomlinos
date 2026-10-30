// CAD Draft says what a DXF holds that a drawing does not keep, so nothing is lost quietly when the drawing is output
// again: items at a height (Z) off 0, items with a thickness, items with a line type or a true colour of their own.
// A DXF CAD Draft wrote itself says none of them. Run: npm test
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

test('a plain DXF, and one CAD Draft wrote itself, say none of them', () => {
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

test('3D polyline Z, blocks and splines make the read lossy (so writing over that DXF asks first)', () => {
  const vertex = (x: string, z: string) => ['0', 'VERTEX', '8', 'A', '10', x, '20', '0', '30', z, '70', '32'];
  const poly3d = (z: string) => ['0', 'POLYLINE', '8', 'A', '66', '1', '70', '8', ...vertex('0', z), ...vertex('50', z), '0', 'SEQEND'];
  const flat = readDxf(entities(poly3d('0')));
  assert.equal(flat.changed, 0, 'a 3D polyline with every height at 0 loses nothing');
  const deep = readDxf(entities(poly3d('-6')));
  assert.equal(deep.drawing.ents.length, 1);
  assert.equal(deep.changed, 1, 'heights on a 3D polyline’s points');
  assert.match(deep.report.join('\n'), /1 item sits at a height \(Z\)/);

  const withBlock = (items: string[]) => enc([
    '0', 'SECTION', '2', 'BLOCKS', '0', 'BLOCK', '8', '0', '2', 'B1', '70', '0', '10', '0', '20', '0', ...lineAt('0'), '0', 'ENDBLK', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES', ...items, '0', 'ENDSEC', '0', 'EOF',
  ]);
  const insert = readDxf(withBlock(['0', 'INSERT', '8', 'A', '2', 'B1', '10', '0', '20', '0']));
  assert.equal(insert.drawing.ents.length, 1);
  assert.equal(insert.changed, 1, 'a block taken apart is not a block in the DXF written');
  const dimension = readDxf(withBlock(['0', 'DIMENSION', '8', 'A', '2', 'B1', '70', '0']));
  assert.equal(dimension.changed, 1, 'a true dimension comes back as plain lines and text');

  const controls = ['0', 'SPLINE', '8', 'A', '70', '8', '71', '3', '72', '8', '73', '4', ...['0', '0', '0', '0', '1', '1', '1', '1'].flatMap(k => ['40', k]), ...[[0, 0], [10, 20], [30, 20], [40, 0]].flatMap(([x, y]) => ['10', String(x), '20', String(y), '30', '0'])];
  const spline = readDxf(entities(controls));
  assert.equal(spline.drawing.ents.length, 1);
  assert.equal(spline.changed, 1, 'a spline becomes a polyline of arcs');
  const fit = readDxf(entities(['0', 'SPLINE', '8', 'A', '70', '8', '71', '3', '74', '3', '11', '0', '21', '0', '11', '10', '21', '10', '11', '20', '21', '0']));
  assert.equal(fit.drawing.ents.length, 1);
  assert.equal(fit.changed, 1, 'a spline with only fit points may differ slightly');
});
