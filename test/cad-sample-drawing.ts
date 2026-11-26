// A drawing with every kind of item on two layers (and a hidden third), shared by the DXF and SVG export tests.
import { P } from '../src/apps/cad/geom.ts';
import { newDrawing, type Drawing, type Ent, type Shape } from '../src/apps/cad/model.ts';

export function sampleDrawing(units: 'mm' | 'inch' = 'mm'): Drawing {
  const d = newDrawing(units);
  d.layers.push({ name: 'Cut outs', colour: '#ff4040', on: true, locked: true, lineType: 'centre' });
  d.layers.push({ name: 'Hidden notes', colour: '#40e0ff', on: false, locked: false, lineType: 'hidden' });
  d.layers[0].lineType = 'continuous';
  d.layers[1].lineType = 'dashed';
  const shapes: Array<[string, Shape]> = [
    ['Geometry', { type: 'line', a: P(0, 0), b: P(600, 0) }],
    ['Geometry', { type: 'arc', c: P(300, 200), r: 50, a0: 0.25, a1: 2.5 }],
    ['Geometry', { type: 'circle', c: P(100, 100), r: 35 }],
    ['Cut outs', { type: 'ellipse', c: P(400, 300), m: P(80, 30), ratio: 0.5, t0: 0, t1: Math.PI * 2 }],
    ['Cut outs', { type: 'ellipse', c: P(450, 100), m: P(0, 40), ratio: 0.25, t0: 0.5, t1: 3 }],
    ['Geometry', { type: 'poly', pts: [P(0, 400), P(200, 400), P(200, 500), P(0, 500)], bulges: [0, 0.5, 0, -0.25], closed: true }],
    ['Geometry', { type: 'poly', pts: [P(250, 400), P(350, 450), P(450, 400)], bulges: [0.3, 0, 0], closed: false }],
    ['Cut outs', { type: 'spline', fit: [P(0, 600), P(100, 650), P(200, 580), P(300, 640)], closed: false }],
    ['Cut outs', { type: 'spline', fit: [P(400, 600), P(500, 650), P(550, 560), P(450, 520)], closed: true }],
    ['Geometry', { type: 'point', p: P(10, 10) }],
    ['Construction', { type: 'xline', p: P(0, 0), d: P(Math.SQRT1_2, Math.SQRT1_2) }],
    ['Text', { type: 'text', p: P(20, 700), text: 'Worktop 600 ±0.5 Ø35 at 20°, 50% & <A> "B"', h: 10, angle: 0, align: 'left' }],
    ['Text', { type: 'text', p: P(300, 720), text: 'Two lines\nsecond {row} \\ here', h: 8, angle: 0.3, align: 'centre' }],
    ['Text', { type: 'text', p: P(600, 740), text: 'Ελληνικά € ⌀ 日本', h: 6, angle: 0, align: 'right' }],
    ['Dimensions', { type: 'dim', kind: 'linear', pts: [P(0, 0), P(600, 0), P(300, -40)], dir: 0, h: 3.5, arrow: 3, dp: 0, text: '' }],
    ['Hidden notes', { type: 'line', a: P(0, 800), b: P(100, 800) }],
  ];
  let id = 1;
  d.ents = shapes.map(([layer, s]) => ({ ...s, id: id++, layer }) as Ent);
  return d;
}
