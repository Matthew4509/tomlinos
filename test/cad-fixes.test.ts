// CAD Draft fixes from the 22 Oct audit: a block mirrored in X, layer names with spaces at the end, text too long
// for a drawing, a drawing too big to open again. No browser needed. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDrawing, readTcad, tooBigToSave, writeTcad, type Drawing, type Ent } from '../src/apps/cad/model.ts';
import { readDxf } from '../src/apps/cad/dxf.ts';

const drawingWith = (...ents: Ent[]): Drawing => ({ ...newDrawing(), ents });

const enc = (lines: string[]) => new TextEncoder().encode(lines.join('\r\n') + '\r\n');

test('CAD Draft: a block mirrored in X with no Y scale given opens mirrored, not turned round', () => {
  const file = enc([
    '0', 'SECTION', '2', 'BLOCKS', '0', 'BLOCK', '2', 'HOLE', '10', '0', '20', '0', '0', 'CIRCLE', '8', '0', '10', '10', '20', '5', '40', '2', '0', 'ENDBLK', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES', '0', 'INSERT', '8', 'A', '2', 'HOLE', '10', '100', '20', '100', '41', '-1', '0', 'ENDSEC', '0', 'EOF',
  ]);
  const c = readDxf(file).drawing.ents.find(e => e.type === 'circle') as Extract<Ent, { type: 'circle' }>;
  assert.deepEqual([c.c.x, c.c.y], [90, 105], 'x mirrored (100 - 10), y as it was (100 + 5)');
});

test('CAD Draft: layer names with spaces at the end, and text too long for a drawing, survive a save and reopen', () => {
  const long = 'x'.repeat(12000);
  const file = enc(['0', 'SECTION', '2', 'TABLES', '0', 'LAYER', '2', 'Cut ', '62', '1', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LINE', '8', 'Cut ', '10', '0', '20', '0', '11', '5', '21', '0', '0', 'TEXT', '8', 'Cut ', '10', '0', '20', '0', '40', '2', '1', long, '0', 'ENDSEC', '0', 'EOF']);
  const read = readDxf(file);
  assert.match(read.report.join(' '), /longer than 10,000 letters: cut to that length/);
  const again = readTcad(writeTcad(read.drawing)).drawing;
  assert.equal(again.ents.length, 2, 'the text opens again');
  assert.ok(again.ents.every(e => e.layer === 'Cut'), 'both stay on their layer');
});

test('CAD Draft: a drawing too big to open again is refused at Save with the reason', () => {
  const d = drawingWith();
  assert.equal(tooBigToSave(d), null);
  d.ents = [{ id: 1, layer: 'Geometry', type: 'poly', pts: Array.from({ length: 2_000_001 }, (_, i) => ({ x: i, y: 0 })), bulges: [], closed: false }];
  assert.match(String(tooBigToSave(d)), /opens again with up to 2,000,000/);
});

test('CAD Draft: every drawing Save lets through opens again with nothing damaged (layers, long words)', () => {
  const layer = (name: string) => ({ name, colour: '#ffffff', on: true, locked: false, lineType: 'continuous' as const });
  // 1,001 layers (an architect's DXF can have that many): Save says why, rather than writing a file that never opens.
  const many = drawingWith();
  many.layers = Array.from({ length: 1001 }, (_, i) => layer(`L${i}`));
  assert.match(String(tooBigToSave(many)), /1,001 layers/);
  // A leader's words and a text over 10,000 letters: also said at Save.
  const leader: Ent = { id: 1, layer: 'Geometry', type: 'dim', kind: 'leader', pts: [{ x: 0, y: 0 }, { x: 5, y: 5 }], dir: 0, h: 3.5, arrow: 2.5, dp: 2, text: 'x'.repeat(10_001) };
  assert.match(String(tooBigToSave(drawingWith(leader))), /10,000 letters/);
  // Just inside every limit: saved, and it opens again whole.
  const edge = drawingWith({ ...leader, text: 'x'.repeat(10_000) });
  edge.layers = Array.from({ length: 1000 }, (_, i) => layer(`L${i}`));
  edge.ents[0].layer = 'L0';
  assert.equal(tooBigToSave(edge), null);
  const back = readTcad(writeTcad(edge));
  assert.deepEqual([back.damaged, back.skipped, back.drawing.layers.length, back.drawing.ents.length], [0, 0, 1000, 1]);
});
