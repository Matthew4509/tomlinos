// CAD Draft text boxes: the words fill the box, the envelope maths of the warps, the handles, and the box kept
// through .tcad, move, rotate, mirror and scale. Answers worked out by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { P, dist, type Pt } from '../src/apps/cad/geom.ts';
import { mirrorShape, moveShape, rotateShape, scaleShape, distToShape } from '../src/apps/cad/edit.ts';
import { newDrawing, readTcad, shapeBox, writeTcad, type Ent } from '../src/apps/cad/model.ts';
import { textShapeStrokes, type TextShape } from '../src/apps/cad/notes.ts';
import {
  WARP_PRESETS, asBox, boxAsText, dragGrip, envelopeAt, fitHeight, flipWarpUp, isFlat, presetWarp, recognise,
} from '../src/apps/cad/textbox.ts';

const near = (a: number, b: number, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} is not ${b}`);
const nearPt = (a: Pt, b: Pt, tol = 1e-9) => assert.ok(dist(a, b) <= tol, `${a.x},${a.y} is not ${b.x},${b.y}`);

const boxText = (w = 100, h = 20): TextShape => ({ type: 'text', p: P(10, 5), text: 'HELLO', h: fitHeight('HELLO', 'left', h), angle: 0, align: 'left', box: { w, h } });

test('the words of a flat box fill it from corner to corner', () => {
  const t = boxText();
  const b = shapeBox(t)!;
  near(b.x0, 10, 1e-6);
  near(b.x1, 110, 1e-6);
  assert.ok(b.y0 >= 5 - 1e-9 && b.y1 <= 25 + 1e-9);
});

test('every preset at strength 0 is flat, and each preset at 100 is not', () => {
  for (const p of WARP_PRESETS) {
    assert.ok(isFlat(presetWarp(p, 0)), p);
    if (p !== 'none') assert.ok(!isFlat(presetWarp(p, 100)), p);
  }
});

test('the envelope keeps the corners of an arch and lifts its middle', () => {
  const w = presetWarp('arch', 100);
  nearPt(envelopeAt(w, 0, 0), P(0, 0));
  nearPt(envelopeAt(w, 1, 1), P(1, 1));
  // The top curve's inner points rise 0.8, so its middle rises 3/4 of that.
  nearPt(envelopeAt(w, 0.5, 1), P(0.5, 1.6));
  nearPt(envelopeAt(w, 0.5, 0), P(0.5, 0));
});

test('a preset is known again after a flip, or named as shaped by hand', () => {
  assert.equal(recognise(presetWarp('arcUp', 40)).preset, 'arcUp');
  assert.equal(flipWarpUp(presetWarp('arcUp', 40)).preset, 'arcDown');
  const w = presetWarp('bulge', 30);
  assert.equal(recognise({ ...w, top: [w.top[0], P(0.4, 1.7), w.top[2], w.top[3]] }).preset, 'custom');
});

test('a bent box keeps its letters as many short strokes, and a plain one stays text', () => {
  const t = asBox({ type: 'text', p: P(0, 0), text: 'HELLO', h: 5, angle: 0, align: 'left' });
  const same = boxAsText(t)!;
  nearPt(same.p, P(0, 0), 1e-9);
  near(same.h, 5, 1e-9);
  const bent: TextShape = { ...t, box: { ...t.box!, warp: presetWarp('wave', 60) } };
  assert.equal(boxAsText(bent), null);
  const stretched: TextShape = { ...t, box: { w: t.box!.w * 2, h: t.box!.h } };
  assert.equal(boxAsText(stretched), null);
  const plain = textShapeStrokes(t).reduce((n, s) => n + s.length, 0);
  const curved = textShapeStrokes(bent).reduce((n, s) => n + s.length, 0);
  assert.ok(curved > plain);
});

test('the corner handle stretches, Shift keeps the proportions, and the inside moves', () => {
  const t = boxText();
  const big = dragGrip(t, { kind: 'size', sx: 1, sy: 1 }, P(110, 25), P(160, 45), false);
  near(big.box!.w, 150);
  near(big.box!.h, 40);
  nearPt(big.p, P(10, 5));
  const kept = dragGrip(t, { kind: 'size', sx: 1, sy: 1 }, P(110, 25), P(310, 30), true);
  near(kept.box!.w / kept.box!.h, 5);
  const left = dragGrip(t, { kind: 'size', sx: -1, sy: 0 }, P(10, 15), P(0, 15), false);
  nearPt(left.p, P(0, 5));
  near(left.box!.w, 110);
  const moved = dragGrip(t, { kind: 'move' }, P(50, 10), P(60, 30), false);
  nearPt(moved.p, P(20, 25));
});

test('a plain text becomes a box with its letters where they were', () => {
  const t: TextShape = { type: 'text', p: P(0, 0), text: 'AB', h: 5, angle: 0.3, align: 'centre' };
  const b = asBox(t);
  const a = textShapeStrokes(t).flat();
  const c = textShapeStrokes(b).flat();
  assert.equal(a.length, c.length);
  a.forEach((q, i) => nearPt(q, c[i], 1e-9));
});

test('the box and its bend survive a .tcad, and move, rotate, mirror and scale keep it a box', () => {
  const d = newDrawing('mm');
  const t: TextShape = { ...boxText(), box: { w: 100, h: 20, warp: presetWarp('flag', -35) } };
  d.ents = [{ ...t, id: 1, layer: d.layers[0].name } as Ent];
  const back = readTcad(writeTcad(d)).drawing.ents[0] as Ent & TextShape;
  assert.deepEqual(back.box, t.box);
  const oldStyle = readTcad(writeTcad({ ...d, ents: [{ type: 'text', p: P(0, 0), text: 'A', h: 5, angle: 0, align: 'left', id: 1, layer: d.layers[0].name } as Ent] })).drawing.ents[0] as TextShape;
  assert.equal(oldStyle.box, undefined);
  nearPt(moveShape(t, P(1, 2)).p, P(11, 7));
  near(rotateShape(t, P(0, 0), 1).angle, 1);
  const sc = scaleShape(t, P(0, 0), 2);
  near(sc.box!.w, 200);
  const m = mirrorShape(t, P(0, 0), P(0, 1));
  assert.ok(m.box);
  assert.equal(m.box!.warp!.preset, 'flag');
  near(m.box!.warp!.strength, 35);
  // The mirrored box sits round the mirrored middle.
  const box = shapeBox(m)!;
  near((box.x0 + box.x1) / 2, -60, 1);
  assert.equal(distToShape(t, P(60, 15)), 0);
});
