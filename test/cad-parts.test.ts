// TOMLIN CAD's parts library: the starter parts' sizes, a part saved with its base point and read back, placed at a
// point and a turn (and from millimetres into an inch drawing), the layers placed items go on, part names, the list,
// and the two tools. Answers worked out by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { P, dist, type Pt } from '../src/apps/cad/geom.ts';
import { newDrawing, type Ent, type Shape } from '../src/apps/cad/model.ts';
import { STARTER_PARTS, layerFor, partList, partNameProblem, placePart, readPart, unitFactor, writePart, type Part } from '../src/apps/cad/parts.ts';
import { partPlaceTool, TOOLS, type ToolCtx } from '../src/apps/cad/tools.ts';

const near = (a: Pt, b: Pt, what: string, tol = 1e-9) => assert.ok(dist(a, b) <= tol, `${what}: expected ${b.x},${b.y}, got ${a.x},${a.y}`);
const circles = (shapes: Shape[]) => shapes.map(s => (s.type === 'circle' ? s : assert.fail('a circle')));
const starter = (start: string) => STARTER_PARTS.find(p => p.name.startsWith(start))!;

test('starter parts: the hinge cup, the 32 mm row and handle holes have their usual sizes, base point at 0,0', () => {
  const hinge = circles(starter('Hinge cup').items.map(i => i.shape));
  assert.equal(hinge[0].r * 2, 35);
  near(hinge[0].c, P(0, 0), 'cup at the base point');
  assert.deepEqual(hinge.slice(1).map(c => [c.c.x, c.c.y, c.r * 2]), [[-22.5, 9.5, 8], [22.5, 9.5, 8]]);
  assert.equal(dist(hinge[1].c, hinge[2].c), 45);
  const row = circles(starter('Shelf-pin').items.map(i => i.shape));
  assert.equal(row.length, 10);
  row.forEach((c, i) => {
    near(c.c, P(32 * i, 0), `hole ${i + 1}`);
    assert.equal(c.r * 2, 5);
  });
  for (const c of [96, 128, 160]) {
    const h = circles(starter(`Handle holes ${c}`).items.map(i => i.shape));
    assert.equal(dist(h[0].c, h[1].c), c);
    near(P((h[0].c.x + h[1].c.x) / 2, (h[0].c.y + h[1].c.y) / 2), P(0, 0), 'base point halfway');
  }
  const sink = starter('Sink cut-out').items[0].shape;
  assert.ok(sink.type === 'poly' && sink.closed);
  const xs = sink.pts.map(p => p.x);
  const ys = sink.pts.map(p => p.y);
  assert.equal(Math.max(...xs) - Math.min(...xs), 760);
  assert.equal(Math.max(...ys) - Math.min(...ys), 440);
  for (const p of STARTER_PARTS) assert.ok(p.note && p.units === 'mm' && p.items.length, p.name);
});

test('a part saved with its base point and read back: moved so the base is 0,0, layers kept', () => {
  const d = newDrawing('mm');
  const ents: Ent[] = [
    { type: 'circle', c: P(110, 220), r: 17.5, id: 7, layer: 'Geometry' },
    { type: 'line', a: P(100, 200), b: P(150, 200), id: 9, layer: 'Construction' },
  ];
  const text = writePart(d, ents, P(110, 220));
  const part = readPart('Cup', text);
  assert.equal(part.name, 'Cup');
  assert.equal(part.units, 'mm');
  assert.deepEqual(part.items.map(i => i.layer), ['Geometry', 'Construction']);
  const [c, l] = part.items.map(i => i.shape);
  assert.ok(c.type === 'circle' && l.type === 'line');
  near(c.c, P(0, 0), 'the circle at the base');
  near(l.a, P(-10, -20), 'the line moved with it');
  assert.equal(JSON.parse(text).layers.length, 2, 'only the layers it uses');
});

test('placing a part: at a point, turned, and sized into an inch drawing', () => {
  const hinge = starter('Hinge cup');
  const at = placePart(hinge, 'mm', P(500, 100), Math.PI / 2);
  const c = circles(at);
  near(c[0].c, P(500, 100), 'cup at the point');
  // Turned a quarter anticlockwise: (22.5, 9.5) goes to (-9.5, 22.5).
  near(c[2].c, P(500 - 9.5, 100 + 22.5), 'a screw hole turned with it', 1e-9);
  const inch = circles(placePart(hinge, 'inch', P(1, 1), 0));
  assert.ok(Math.abs(inch[0].r * 2 - 35 / 25.4) < 1e-12, 'the cup in inches');
  near(inch[1].c, P(1 - 22.5 / 25.4, 1 + 9.5 / 25.4), 'a hole in inches', 1e-12);
  assert.equal(unitFactor('inch', 'mm'), 25.4);
  assert.equal(unitFactor('mm', 'mm'), 1);
});

test('placed items go on the current layer, except construction, text and dimensions where the drawing has those', () => {
  const layers = ['Geometry', 'Construction', 'Dimensions', 'Text', 'Hinges'];
  assert.equal(layerFor('Geometry', layers, 'Hinges'), 'Hinges');
  assert.equal(layerFor('Doors', layers, 'Hinges'), 'Hinges');
  assert.equal(layerFor('Construction', layers, 'Hinges'), 'Construction');
  assert.equal(layerFor('Text', layers, 'Hinges'), 'Text');
  assert.equal(layerFor('Text', ['Geometry'], 'Geometry'), 'Geometry');
});

test('part names: a file name, refused in words otherwise; own parts first, a same-named one hides the starter', () => {
  assert.equal(partNameProblem('Sink 1 1/2 bowl'), 'A part’s name cannot have any of  \\ / : * ? " < > |  in it (it becomes a file name).');
  assert.equal(partNameProblem('Sink, one and a half bowl'), null);
  assert.match(partNameProblem('  ')!, /Type a name/);
  assert.match(partNameProblem('x'.repeat(61))!, /60 letters/);
  assert.match(partNameProblem('..')!, /letter or number/);
  const own: Part[] = [
    { name: 'zed', units: 'mm', items: [] },
    { name: 'Handle holes 96 mm', units: 'mm', items: [] },
    { name: 'Apron', units: 'mm', items: [] },
  ];
  const list = partList(own);
  assert.deepEqual(list.slice(0, 3).map(p => p.name), ['Apron', 'Handle holes 96 mm', 'zed']);
  assert.ok(list.slice(0, 3).every(p => !p.starter));
  assert.equal(list.filter(p => p.name === 'Handle holes 96 mm').length, 1, 'the own one hides the starter');
  assert.equal(list.length, 3 + STARTER_PARTS.length - 1);
});

function stand(selection: Ent[] = []) {
  const placed: Array<{ part: string; at: Pt; angle: number }> = [];
  const saved: Pt[] = [];
  const problems: string[] = [];
  const ctx = {
    units: () => 'mm' as const, ents: () => [], visible: () => [], selection: () => selection, select() {}, add() {}, change() {},
    say() {}, problem: (t: string) => void problems.push(t), fmt: (v: number) => String(v),
    list() {}, zoomTo() {}, askPolar: async () => null, askText: async () => null, askDim: async () => null,
    style: () => ({ textH: 5, dimH: 3.5, arrow: 3, dp: 1 }), noteLayer: () => 'Text', finished() {},
    photo: () => null, setPhoto() {}, straightenPhoto() {},
    placePart: (part: Part, at: Pt, angle: number) => void placed.push({ part: part.name, at, angle }),
    savePart: (base: Pt) => void saved.push(base),
  } satisfies ToolCtx;
  return { ctx, placed, saved, problems };
}

test('the place tool: a point and a turn (typed, clicked, or Enter for none), again until Done; it shows where it goes', () => {
  const { ctx, placed } = stand();
  const t = partPlaceTool(ctx, starter('Hinge cup'));
  assert.equal(t.preview(P(10, 10)).length, 3, 'the part follows the pointer before the first click');
  t.point!(P(100, 0));
  assert.ok(t.enter(), 'Enter: no turn');
  t.point!(P(200, 0));
  t.number!(90, P(0, 0));
  t.point!(P(300, 0));
  t.point!(P(300, -50));
  assert.deepEqual(placed.map(p => [p.at.x, p.at.y, Math.round((p.angle * 180) / Math.PI)]), [[100, 0, 0], [200, 0, 90], [300, 0, -90]]);
  assert.ok(!t.done, 'it carries on for the next one');
  assert.equal(t.enter(), false, 'Enter with nothing started ends it');
});

test('the save tool: needs chosen items, then a base point', () => {
  const none = stand();
  const t = TOOLS['part-save'].make(none.ctx);
  t.point!(P(5, 5));
  assert.match(none.problems.at(-1)!, /Choose the items/);
  assert.deepEqual(none.saved, []);
  const some = stand([{ type: 'point', p: P(0, 0), id: 1, layer: 'Geometry' }]);
  const s = TOOLS['part-save'].make(some.ctx);
  s.point!(P(5, 6));
  assert.ok(s.done);
  assert.deepEqual(some.saved, [P(5, 6)]);
});
