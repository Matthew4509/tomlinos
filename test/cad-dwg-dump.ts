// Test helper (not a test): lists what a DWG holds in the same words and order as the ACadSharp dumps recorded in
// test/fixtures/dwg/*.acadsharp.txt, so CAD Draft's own reading can be compared with an independent reader's.
import { decoderFor, V } from '../src/apps/cad/dwg/bits.ts';
import { readParts } from '../src/apps/cad/dwg/container.ts';
import { readHeader } from '../src/apps/cad/dwg/header.ts';
import { entryName, readBlockHeader, readClasses, readLayer, readObject, readObjectMap, readShape, type DwgObject } from '../src/apps/cad/dwg/objects.ts';
import { P, type Pt } from '../src/apps/cad/geom.ts';
import { newDrawing, rectangle, type Drawing, type Shape } from '../src/apps/cad/model.ts';

const N = (v: number) => {
  const r = Math.round(v * 1e6) / 1e6;
  return (Object.is(r, -0) ? 0 : r).toString();
};
const P2 = (p: ArrayLike<number>) => `(${N(p[0])},${N(p[1])})`;
const byName = (a: string, b: string) => (a.toUpperCase() < b.toUpperCase() ? -1 : a.toUpperCase() > b.toUpperCase() ? 1 : 0);

export function dumpDwg(bytes: Uint8Array): string[] {
  const p = readParts(bytes);
  const text = decoderFor(p.codePage);
  const header = readHeader(p.header, p.ver, p.maint, text);
  const classes = readClasses(p.classes, p.ver, p.maint, text);
  const objs = new Map<number, DwgObject>();
  for (const [h, off] of readObjectMap(p.handles)) objs.set(h, readObject(p.objects, off, p.ver, text, classes));
  const out = [`VERSION ${p.name}`, `INSUNITS ${header.get('INSUNITS')}`];
  const ltypes = new Map<number, string>();
  const ltRows: Array<[string, string]> = [];
  const rows = (kind: string) => [...objs.values()].filter(o => o.name === kind);
  for (const o of rows('LTYPE')) {
    const name = entryName(o);
    ltypes.set(o.handle, name);
    o.r.TV();
    const length = o.r.BD();
    o.r.RC();
    const n = o.r.RC();
    ltRows.push([name, `LTYPE ${name} segments=${n} length=${N(length)}`]);
  }
  out.push(...ltRows.sort((a, b) => byName(a[0], b[0])).map(r => r[1]));
  const layers = new Map<number, string>();
  const layRows: Array<[string, string]> = [];
  for (const o of rows('LAYER')) {
    const l = readLayer(o);
    layers.set(o.handle, l.name);
    layRows.push([l.name, `LAYER ${l.name} colour=${l.colour} on=${l.off ? 'False' : 'True'} locked=${l.locked ? 'True' : 'False'} ltype=${ltypes.get(l.ltype)}`]);
  }
  out.push(...layRows.sort((a, b) => byName(a[0], b[0])).map(r => r[1]));
  for (const kind of ['STYLE', 'DIMSTYLE', 'APPID']) for (const o of rows(kind)) out.push(`${kind} ${entryName(o)}`);
  for (const o of rows('VPORT')) {
    const name = entryName(o);
    const height = o.r.BD();
    o.r.BD();
    out.push(`VPORT ${name} centre=${P2(o.r.RD2())} height=${N(height)}`);
  }
  const model = rows('BLOCK_HEADER').map(o => ({ o, b: readBlockHeader(o) })).find(x => x.b.name.toUpperCase() === '*MODEL_SPACE')!;
  const ents = p.ver >= V.R2004 ? model.b.owned : [...objs.values()].filter(o => o.entity && o.entmode === 2 && !['BLOCK', 'ENDBLK'].includes(o.name)).map(o => o.handle);
  out.push(`ENTITIES ${ents.length}`);
  for (const h of ents) {
    const o = objs.get(h)!;
    const s = readShape(o);
    const dxf = o.name === 'POLYLINE_2D' ? 'POLYLINE' : o.name;
    let line = `${dxf} layer=${layers.get(o.layer)}${o.colour !== 256 ? ` colour=${o.colour}` : ''}`;
    if (s) {
      switch (s.k) {
        case 'LINE':
          line += ` ${P2(s.a)}-${P2(s.b)}`;
          break;
        case 'ARC':
          line += ` c=${P2(s.c)} r=${N(s.r)} a0=${N(s.a0)} a1=${N(s.a1)}`;
          break;
        case 'CIRCLE':
          line += ` c=${P2(s.c)} r=${N(s.r)}`;
          break;
        case 'ELLIPSE':
          line += ` c=${P2(s.c)} m=${P2(s.m)} ratio=${N(s.ratio)} t0=${N(s.t0)} t1=${N(s.t1)}`;
          break;
        case 'LWPOLYLINE':
          line += ` closed=${s.closed ? 'True' : 'False'} n=${s.pts.length}` + s.pts.map((q, i) => ` ${P2(q)}b${N(s.bulges[i])}`).join('');
          break;
        case 'SPLINE':
          line += ` deg=${s.degree} closed=${s.closed ? 'True' : 'False'} ctrl=${s.ctrl.length} fit=${s.fit.length} knots=${s.knots.length}` + s.ctrl.map(q => ` ${P2(q)}`).join('');
          if (s.fit.length) line += ' fit:' + s.fit.map(q => ` ${P2(q)}`).join('');
          break;
        case 'POINT':
          line += ` ${P2(s.p)}`;
          break;
        case 'TEXT':
          line += ` at=${P2(s.p)} h=${N(s.h)} rot=${N(s.rot)} h72=${s.hAlign} align=${P2(s.align ?? [0, 0])} "${s.text}"`;
          break;
        case 'MTEXT':
          line += ` at=${P2(s.p)} h=${N(s.h)} attach=${s.attach} "${s.text}"`;
          break;
      }
    }
    out.push(line);
  }
  return out;
}

/** The lines of a recorded ACadSharp dump that dumpDwg also writes. */
export function comparable(lines: string[]): string[] {
  return lines.filter(l => /^(VERSION|INSUNITS|LTYPE|LAYER|STYLE|DIMSTYLE|APPID|VPORT|ENTITIES|LINE|ARC|CIRCLE|ELLIPSE|LWPOLYLINE|SPLINE|POINT|TEXT|MTEXT|XLINE) /.test(l));
}

/** The drawing the writer tests and the recorded ACadSharp dump use: one of each kind, on layers of each kind. */
export function sampleDrawing(): Drawing {
  const d = newDrawing('mm');
  d.layers.push({ name: 'Cut lines', colour: '#ff4040', on: true, locked: true, lineType: 'centre' });
  d.layers.push({ name: 'Off one', colour: '#4080ff', on: false, locked: false, lineType: 'hidden' });
  let id = 1;
  const add = (s: Shape, layer = 'Geometry') => d.ents.push({ ...s, id: id++, layer });
  const pt = (x: number, y: number): Pt => P(x, y);
  add({ type: 'line', a: pt(0, 0), b: pt(100, 50) });
  add({ type: 'circle', c: pt(20, 30), r: 7.5 }, 'Cut lines');
  add({ type: 'arc', c: pt(50, 50), r: 10, a0: 0, a1: Math.PI / 2 });
  add({ type: 'ellipse', c: pt(10, -20), m: pt(30, 0), ratio: 0.5, t0: 0, t1: Math.PI });
  add({ type: 'ellipse', c: pt(80, -20), m: pt(0, 15), ratio: 0.4, t0: 0, t1: Math.PI * 2 });
  add(rectangle(pt(0, 0), pt(40, 20), 3)!);
  add({ type: 'poly', pts: [pt(60, 0), pt(80, 0), pt(80, 20)], bulges: [0, 1, 0], closed: false }, 'Construction');
  add({ type: 'spline', fit: [pt(0, 100), pt(10, 120), pt(30, 90), pt(50, 110)], closed: false });
  add({ type: 'spline', fit: [pt(100, 100), pt(120, 120), pt(140, 100)], closed: true }, 'Off one');
  add({ type: 'point', p: pt(5, 5) });
  add({ type: 'xline', p: pt(0, 0), d: pt(Math.SQRT1_2, Math.SQRT1_2) }, 'Construction');
  add({ type: 'text', p: pt(0, 60), text: 'Hello DWG ° Ø ± €', h: 5, angle: 0, align: 'left' }, 'Text');
  add({ type: 'text', p: pt(0, 70), text: 'Two\nlines 中', h: 3, angle: Math.PI / 6, align: 'centre' }, 'Text');
  add({ type: 'dim', kind: 'linear', pts: [pt(0, 0), pt(40, 0), pt(20, -10)], dir: 0, h: 2.5, arrow: 2.5, dp: 1, text: '' }, 'Dimensions');
  return d;
}

/** Fixed time and GUIDs, so the sample comes out the same byte for byte. */
export const FIXED = { now: Date.UTC(2026, 0, 2, 3, 4, 5), guids: ['{11111111-2222-3333-4444-555555555555}', '{66666666-7777-8888-9999-000000000000}'] as [string, string] };
