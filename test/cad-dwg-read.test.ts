// CAD Draft opens DWG files of AutoCAD 2000 to 2018 with its own code. Checked here against drawings ACadSharp (an
// independent DWG library, run offline) wrote in every version it writes: what CAD Draft finds in them is what ACadSharp
// found; they open as the same drawing in every version; DWGs ACadSharp made from CAD Draft's own DXFs open as those
// DXFs do; CAD Draft's own DWGs come back as drawn; and damaged or hostile files end in a clear message, quickly.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BitWriter, DwgProblem, crc32, decoderFor, magicBytes, pageChecksum } from '../src/apps/cad/dwg/bits.ts';
import { readParts, unmaskHeader18 } from '../src/apps/cad/dwg/container.ts';
import { compress18, decompress18, decompress21 } from '../src/apps/cad/dwg/lz77.ts';
import { readObject, readObjectMap, readShape } from '../src/apps/cad/dwg/objects.ts';
import { readDwg } from '../src/apps/cad/dwg/read.ts';
import { assemble, writeDwg } from '../src/apps/cad/dwg/write.ts';
import { readDxf } from '../src/apps/cad/dxf.ts';
import { P } from '../src/apps/cad/geom.ts';
import { CadProblem, newDrawing, rectangle, type Drawing, type Ent, type Shape } from '../src/apps/cad/model.ts';
import { FIXED, comparable, dumpDwg, sampleDrawing } from './cad-dwg-dump.ts';

const FIX = new URL('./fixtures/dwg/', import.meta.url);
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(name, FIX)));
const VERSIONS = ['AC1015', 'AC1018', 'AC1024', 'AC1027', 'AC1032'];
const LABEL: Record<string, string> = { AC1015: 'AutoCAD 2000', AC1018: 'AutoCAD 2004', AC1024: 'AutoCAD 2010', AC1027: 'AutoCAD 2013', AC1032: 'AutoCAD 2018' };

/** Items with their numbers rounded, for comparing drawings read two ways. */
const rounded = (ents: Ent[]) => JSON.parse(JSON.stringify(ents.map(({ id: _id, ...e }) => e), (_k, v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 + 0 : v)));

for (const v of VERSIONS) {
  test(`${LABEL[v]} (${v}): CAD Draft finds in ACadSharp's file what ACadSharp found`, () => {
    const recorded = comparable(readFileSync(new URL(`acadsharp-full-${v}.acadsharp.txt`, FIX), 'utf8').split(/\r?\n/));
    assert.deepEqual(dumpDwg(fixture(`acadsharp-full-${v}.dwg`)), recorded);
  });
}

test('ACadSharp\'s drawing opens the same in all five versions, with its layers, units, blocks and what was left out', () => {
  const reads = VERSIONS.map(v => readDwg(fixture(`acadsharp-full-${v}.dwg`)));
  const first = reads[1];
  for (const [i, r] of reads.entries()) {
    assert.deepEqual(rounded(r.drawing.ents), rounded(first.drawing.ents), `${VERSIONS[i]} opens as the 2004 file does`);
    assert.deepEqual(r.drawing.layers, first.drawing.layers);
    assert.equal(r.report[0], `Read from an ${LABEL[VERSIONS[i]]} DWG (${VERSIONS[i]}).`);
  }
  const d = first.drawing;
  assert.equal(d.units, 'mm');
  const layer = (n: string) => d.layers.find(l => l.name === n)!;
  assert.deepEqual(layer('Walls'), { name: 'Walls', colour: '#ff4040', on: true, locked: false, lineType: 'dashed' });
  assert.deepEqual(layer('Holes'), { name: 'Holes', colour: '#4080ff', on: true, locked: true, lineType: 'continuous' });
  assert.equal(layer('Hidden stuff').on, false);
  const has = (pred: (e: Ent) => boolean, what: string) => assert.ok(d.ents.some(pred), what);
  has(e => e.type === 'line' && e.layer === 'Walls' && e.a.x === 0 && e.b.x === 100 && e.b.y === 50, 'the line');
  has(e => e.type === 'circle' && e.layer === 'Holes' && e.c.x === 20 && e.c.y === 30 && e.r === 7.5, 'the circle');
  has(e => e.type === 'arc' && e.c.x === 50 && e.r === 10 && Math.abs(e.a1 - e.a0 - Math.PI / 2) < 1e-12, 'the arc');
  has(e => e.type === 'ellipse' && e.m.x === 30 && e.ratio === 0.5 && Math.abs(e.t1 - Math.PI) < 1e-12, 'the half ellipse');
  has(e => e.type === 'poly' && e.closed && e.pts.length === 4 && e.bulges[1] === 0.5, 'the closed light polyline with its arc');
  has(e => e.type === 'poly' && !e.closed && e.pts.length === 3 && e.pts[0].x === 60 && e.bulges[1] === 1, 'the old-style 2D polyline with its half circle');
  has(e => e.type === 'point' && e.p.x === 5 && e.p.y === 5, 'the point');
  has(e => e.type === 'text' && e.text === 'Hello DWG' && e.h === 5 && e.layer === 'Hidden stuff', 'the text');
  has(e => e.type === 'text' && e.text === 'Two\nlines here', 'the paragraph text, plain, on two lines');
  has(e => e.type === 'xline', 'the ray, as a construction line');
  // The block PEG (a circle of 2 and a line across it) placed twice: turned 90 degrees at twice the size, and as it is.
  has(e => e.type === 'circle' && Math.abs(e.c.x - 100) < 1e-9 && Math.abs(e.c.y - 100) < 1e-9 && Math.abs(e.r - 4) < 1e-9 && e.layer === 'Holes', 'the first PEG\'s circle');
  has(e => e.type === 'line' && Math.abs(e.a.x - 100) < 1e-9 && Math.abs(Math.abs(e.a.y - 100) - 6) < 1e-9 && e.layer === 'Holes', 'the first PEG\'s line, turned');
  has(e => e.type === 'circle' && e.c.x === 120 && e.r === 2, 'the second PEG');
  const text = first.report.join('\n');
  assert.match(text, /Units: millimetres/);
  assert.match(text, /2 blocks and dimensions taken apart/);
  assert.match(text, /Left out \(CAD Draft does not draw these\): 2 filled triangles or squares \(SOLID\)/);
  assert.equal(first.leftOut, 2);
});

test('a DWG ACadSharp made from CAD Draft\'s own DXF opens as that DXF does', () => {
  const fromDwg = readDwg(fixture('acadsharp-from-cad-dxf-AC1018.dwg'));
  const fromDxf = readDxf(fixture('cad-sample-r12.dxf'));
  // ACadSharp read the R12 DXF's euro sign as a question mark when it made the DWG (its loss, not CAD Draft's).
  const expected = rounded(fromDxf.drawing.ents).map((e: { text?: string }) => (e.text ? { ...e, text: e.text.replace('€', '?') } : e));
  assert.deepEqual(rounded(fromDwg.drawing.ents), expected);
  assert.deepEqual(fromDwg.drawing.layers.map(l => l.name).sort(), fromDxf.drawing.layers.map(l => l.name).sort());
  assert.equal(fromDwg.leftOut, 0);
  assert.deepEqual(comparable(dumpDwg(fixture('acadsharp-from-cad-dxf-AC1018.dwg'))), comparable(readFileSync(new URL('acadsharp-from-cad-dxf-AC1018.acadsharp.txt', FIX), 'utf8').split(/\r?\n/)));
});

test('heights, a thickness and a colour of an item\'s own in a 2018 DWG are said, as for the DXF it was made from', () => {
  const r = readDwg(fixture('acadsharp-from-losses-dxf-AC1032.dwg'));
  const t = r.report.join('\n');
  assert.match(t, /2 items sit at a height \(Z\) other than 0/);
  assert.match(t, /1 item has a thickness/);
  assert.match(t, /1 item has a colour of its own/);
  assert.equal(r.drawing.ents.length, 5);
  assert.deepEqual(rounded(r.drawing.ents), rounded(readDxf(fixture('losses-2000.dxf')).drawing.ents));
});

test('CAD Draft\'s own DWG comes back as drawn: every kind, layers, colours, line types, curves still curves', () => {
  const d = newDrawing('mm');
  d.layers.push({ name: 'Cut lines', colour: '#ff4040', on: true, locked: true, lineType: 'centre' }, { name: 'Off one', colour: '#4080ff', on: false, locked: false, lineType: 'dotted' });
  let id = 1;
  const add = (s: Shape, layer = 'Geometry') => d.ents.push({ ...s, id: id++, layer });
  add({ type: 'line', a: P(0, 0), b: P(100.125, 50) });
  add({ type: 'circle', c: P(20, 30), r: 7.5 }, 'Cut lines');
  add({ type: 'arc', c: P(50, 50), r: 10, a0: 0.25, a1: 2 });
  add({ type: 'ellipse', c: P(10, -20), m: P(30, 4), ratio: 0.5, t0: 0.5, t1: 3 });
  add({ type: 'ellipse', c: P(80, -20), m: P(0, 15), ratio: 0.4, t0: 0, t1: 2 * Math.PI });
  add(rectangle(P(0, 0), P(40, 20), 3)!);
  add({ type: 'poly', pts: [P(60, 0), P(80, 0), P(80, 20)], bulges: [0, -0.7, 0], closed: false }, 'Off one');
  add({ type: 'spline', fit: [P(0, 100), P(10, 120), P(30, 90), P(50, 110)], closed: false });
  add({ type: 'spline', fit: [P(100, 100), P(120, 120), P(140, 100)], closed: true });
  add({ type: 'point', p: P(5, 5) });
  add({ type: 'xline', p: P(1, 2), d: P(0.6, 0.8) }, 'Construction');
  add({ type: 'text', p: P(0, 60), text: 'Hello ° Ø ± € Ω 100%%', h: 5, angle: 0, align: 'left' }, 'Text');
  add({ type: 'text', p: P(3, 70), text: 'centred', h: 3, angle: Math.PI / 6, align: 'centre' }, 'Text');
  add({ type: 'text', p: P(9, 80), text: 'right', h: 2, angle: 0, align: 'right' }, 'Text');
  d.current = 'Cut lines';
  const back = readDwg(writeDwg(d, { textAsLines: false, construction: true, hidden: true, ...FIXED }).bytes);
  assert.deepEqual(rounded(back.drawing.ents), rounded(d.ents));
  for (const l of d.layers) assert.deepEqual(back.drawing.layers.find(x => x.name === l.name), l, `layer ${l.name}`);
  assert.equal(back.drawing.units, 'mm');
  assert.equal(back.leftOut, 0);
  assert.equal(back.changed, 0, 'nothing changed: curves come back as curves, not "may differ"');
  assert.doesNotMatch(back.report.join('\n'), /may differ/);
  const inch = newDrawing('inch');
  inch.ents.push({ type: 'circle', c: P(1, 1), r: 0.25, id: 1, layer: 'Geometry' });
  const ib = readDwg(writeDwg(inch, { textAsLines: false, construction: false, hidden: false }).bytes);
  assert.equal(ib.drawing.units, 'inch');
  assert.deepEqual(rounded(ib.drawing.ents), rounded(inch.ents));
});

test('the sample drawing\'s dimensions and two-line text come back as the lines and texts the writer made', () => {
  const back = readDwg(writeDwg(sampleDrawing(), { textAsLines: false, construction: true, hidden: true, ...FIXED }).bytes);
  assert.equal(back.drawing.ents.filter(e => e.type === 'text' && e.layer === 'Dimensions').length, 1);
  assert.ok(back.drawing.ents.some(e => e.type === 'text' && e.text === 'lines 中'), 'a letter beyond Windows\' Western set comes back as itself');
});

// ---- Damaged and hostile files ---------------------------------------------------------------------------------------

/** Runs f, which must end in a CadProblem (or read) within `ms`; returns the message. */
function clean(f: () => unknown, ms = 2000): string {
  const t0 = performance.now();
  let message = '';
  try {
    f();
  } catch (error) {
    assert.ok(error instanceof CadProblem, `a clear message, not ${(error as Error)?.stack}`);
    message = error.message;
  }
  assert.ok(performance.now() - t0 < ms, `ended in ${Math.round(performance.now() - t0)} ms`);
  return message;
}

const written = () => writeDwg(sampleDrawing(), { textAsLines: false, construction: true, hidden: true, ...FIXED }).bytes;

/** The sections of a written file, to put back together changed. */
function sectionsOf(bytes: Uint8Array) {
  const p = readParts(bytes);
  return { p, rebuild: (objects = p.objects, handles = p.handles) => assemble([
    { name: 'AcDb:Header', id: 1, data: p.header, compress: true },
    { name: 'AcDb:Classes', id: 3, data: p.classes, compress: true },
    { name: 'AcDb:Handles', id: 4, data: handles, compress: true },
    { name: 'AcDb:AcDbObjects', id: 7, data: objects, compress: true },
  ]) };
}

/**
 * A written file with its section map changed (the section map and page map are the last pages: they are written
 * again at the end, and the masked file header pointed at them).
 */
function withSectionMap(bytes: Uint8Array, change: (sm: DataView, raw: Uint8Array) => Uint8Array | void): Uint8Array {
  const v = new DataView(bytes.buffer, bytes.byteOffset);
  const head = unmaskHeader18(bytes);
  const hv = new DataView(head.buffer);
  const pmAt = Number(hv.getBigUint64(0x54, true)) + 0x100;
  const sys = (at: number) => decompress18(bytes.subarray(at + 20, at + 20 + v.getUint32(at + 8, true)), v.getUint32(at + 4, true));
  const pm = sys(pmAt);
  const pmv = new DataView(pm.buffer);
  const pages: Array<[number, number]> = [];
  let at = 0x100;
  let smAt = 0;
  for (let i = 0; i + 8 <= pm.length; i += 8) {
    const n = pmv.getInt32(i, true);
    if (n === hv.getUint32(0x5c, true)) smAt = at;
    pages.push([n, pmv.getUint32(i + 4, true)]);
    at += pmv.getUint32(i + 4, true);
  }
  const sm = sys(smAt).slice();
  const changed = change(new DataView(sm.buffer), sm) ?? sm;
  const page = (type: number, data: Uint8Array) => {
    const comp = compress18(data);
    const out = new Uint8Array(Math.ceil((20 + comp.length) / 32) * 32);
    const ov = new DataView(out.buffer);
    [type, data.length, comp.length, 2, 0].forEach((x, i) => ov.setUint32(i * 4, x, true));
    ov.setUint32(16, pageChecksum(pageChecksum(0, out.subarray(0, 20)), comp), true);
    out.set(comp, 20);
    return out;
  };
  const newSm = page(0x4163003b, changed);
  const keep = bytes.subarray(0, smAt);
  const list = pages.filter(([n]) => n !== hv.getUint32(0x5c, true) && n !== hv.getUint32(0x50, true));
  const smNum = 900;
  const pmNum = 901;
  list.push([smNum, newSm.length]);
  const pmList = new Uint8Array((list.length + 1) * 8);
  const plv = new DataView(pmList.buffer);
  [...list, [pmNum, 0x400] as [number, number]].forEach(([n, s], i) => {
    plv.setInt32(i * 8, n, true);
    plv.setUint32(i * 8 + 4, s, true);
  });
  const newPm = page(0x41630e3b, pmList);
  const pmAddr = smAt + newSm.length;
  hv.setUint32(0x50, pmNum, true);
  hv.setBigUint64(0x54, BigInt(pmAddr - 0x100), true);
  hv.setUint32(0x5c, smNum, true);
  hv.setUint32(0x68, 0, true);
  hv.setUint32(0x68, crc32(head), true);
  const out = new Uint8Array(keep.length + newSm.length + newPm.length);
  out.set(keep);
  out.set(newSm, keep.length);
  out.set(newPm, keep.length + newSm.length);
  const magic = magicBytes(0x6c);
  for (let i = 0; i < 0x6c; i++) out[0x80 + i] = head[i] ^ magic[i];
  return out;
}

/** The section map's entries: [offset of the description, name]. */
function descriptions(sm: DataView, raw: Uint8Array): Array<{ at: number; name: string; pages: number }> {
  const out = [];
  let p = 20;
  for (let i = 0; i < sm.getUint32(0, true); i++) {
    let name = '';
    for (let k = 0; k < 64 && raw[p + 32 + k]; k++) name += String.fromCharCode(raw[p + 32 + k]);
    const pages = sm.getUint32(p + 8, true);
    out.push({ at: p, name, pages });
    p += 96 + pages * 16;
  }
  return out;
}

test('the section map can be rebuilt by the tests and still reads (so the hostile cases below test what they say)', () => {
  const same = withSectionMap(written(), () => {});
  assert.equal(readDwg(same).drawing.ents.length, readDwg(written()).drawing.ents.length);
});

test('a file cut short at any point gives a clear message naming the version, quickly', () => {
  const bytes = written();
  const t0 = performance.now();
  let messages = 0;
  for (let n = 0; n < bytes.length; n += 37) {
    const m = clean(() => readDwg(bytes.subarray(0, n)));
    if (m) {
      messages++;
      if (n >= 6) assert.match(m, /AutoCAD 2004 DWG|DWG drawing|too short/, m);
    }
  }
  assert.ok(messages > 100);
  assert.ok(performance.now() - t0 < 10000);
});

test('an object whose check sum is wrong is left out and said; a file mostly damaged is refused', () => {
  const { p, rebuild } = sectionsOf(written());
  const map = readObjectMap(p.handles);
  const objects = p.objects.slice();
  // The last object in the map is the paper space ENDBLK... any entity will do: flip a byte in the middle of the
  // largest object (the model space block record lists every item; its loss is said, and the items still read in order).
  const sizes = map.map(([h, off], i) => ({ h, off, size: (map[i + 1]?.[1] ?? objects.length) - off }));
  const line = sizes.find(s => s.size > 30 && s.size < 60)!;
  objects[line.off + 10] ^= 0x55;
  const r = readDwg(rebuild(objects));
  assert.match(r.report.join('\n'), /1 damaged object \(its check sum is wrong\) left out/);
  const ruined = p.objects.slice();
  for (const s of sizes) ruined[s.off + 6] ^= 0xff;
  const m = clean(() => readDwg(rebuild(ruined)));
  assert.match(m, /AutoCAD 2004 DWG \(AC1018\) cannot be opened: \d+ of its \d+ objects are damaged/);
});

test('a wrong file header check sum is said; damaged compressed data gives a clear message', () => {
  const bytes = written();
  const bad = bytes.slice();
  bad[0x80 + 0x68] ^= 1;
  assert.match(readDwg(bad).report.join('\n'), /The file's own check: the file header check sum does not match/);
  const garbled = bytes.slice();
  for (let i = 0x120; i < 0x800; i += 3) garbled[i] ^= 0x5a;
  const m = clean(() => readDwg(garbled));
  assert.match(m, /AutoCAD 2004 DWG \(AC1018\)/);
});

test('a section map that uses one page twice (a loop) is refused, quickly', () => {
  const looped = withSectionMap(written(), (sm, raw) => {
    const d = descriptions(sm, raw);
    const objects = d.find(x => x.name === 'AcDb:AcDbObjects')!;
    const header = d.find(x => x.name === 'AcDb:Header')!;
    // The objects' first page is the header's page.
    sm.setUint32(objects.at + 96, sm.getUint32(header.at + 96, true), true);
  });
  assert.match(clean(() => readDwg(looped)), /uses one page in two places/);
});

test('a section that says it is huge, or has millions of pages, is refused without trying to hold it', () => {
  const huge = withSectionMap(written(), (sm, raw) => {
    const d = descriptions(sm, raw).find(x => x.name === 'AcDb:AcDbObjects')!;
    sm.setBigUint64(d.at, 1n << 40n, true);
  });
  assert.match(clean(() => readDwg(huge)), /more than CAD Draft opens/);
  const many = withSectionMap(written(), (sm, raw) => {
    const d = descriptions(sm, raw).find(x => x.name === 'AcDb:Handles')!;
    sm.setUint32(d.at + 8, 50_000_000, true);
  });
  assert.match(clean(() => readDwg(many)), /more pages than it holds/);
});

test('an object map with a huge count, and objects that point at one place, are refused', () => {
  const { p, rebuild } = sectionsOf(written());
  // The object map pointing every handle at the first object.
  const map = readObjectMap(p.handles);
  const rows: number[] = [];
  for (let i = 0; i < map.length; i++) rows.push(1, i === 0 ? 4 : 0);
  const body = new Uint8Array([0, rows.length + 2, ...rows]);
  const handles = new Uint8Array([...body, 0, 0, 0, 2, 0, 0]);
  assert.match(clean(() => readDwg(rebuild(p.objects, handles))), /points two objects at one place/);
  // 2,041,000 objects listed (each a handle step of 1 at offset 0): refused before any is read.
  const big: number[] = [];
  for (let s = 0; s < 2041; s++) {
    const n = 1000;
    big.push((n * 2 + 2) >> 8, (n * 2 + 2) & 0xff, ...new Array(n).fill([1, 0]).flat(), 0, 0);
  }
  big.push(0, 2, 0, 0);
  assert.match(clean(() => readObjectMap(new Uint8Array(big)), 5000), /more than 2,000,000 objects/);
});

test('a polyline that says it has two billion points, or a spline a million knots, cannot ask for the memory', () => {
  const entity = (type: number, fields: (d: BitWriter) => void) => {
    const d = new BitWriter();
    d.H(0, 0x50);
    d.BS(0);
    d.B(0);
    d.BB(2);
    d.BL(0);
    d.B(1);
    d.BS(256);
    d.BD(1);
    d.BB(0);
    d.BB(0);
    d.BS(0);
    d.RC(29);
    fields(d);
    const h = new BitWriter();
    h.H(5, 0x10);
    const all = new BitWriter();
    all.BS(type);
    all.RL(all.pos + 32 + d.pos);
    all.append(d);
    all.append(h);
    const data = all.done();
    const ms = new BitWriter();
    ms.MS(data.length);
    return new Uint8Array([...ms.done(), ...data, 0, 0]);
  };
  const lw = entity(0x4d, d => {
    d.BS(0);
    d.BL(0x7fffffff);
  });
  assert.throws(() => readShape(readObject(lw, 0, 18, decoderFor(30), new Map())), /says it holds more than it can/);
  const spline = entity(0x24, d => {
    d.BL(1);
    d.BL(3);
    d.B(0);
    d.B(0);
    d.B(0);
    d.BD(0);
    d.BD(0);
    d.BL(1_000_000);
    d.BL(4);
  });
  assert.throws(() => readShape(readObject(spline, 0, 18, decoderFor(30), new Map())), /says it holds more than it can/);
  // And in a whole file: every object's data overwritten with all-ones (huge counts everywhere).
  const { p, rebuild } = sectionsOf(written());
  const objects = p.objects.slice();
  for (const [, off] of readObjectMap(p.handles)) for (let i = 6; i < 40 && off + i < objects.length; i++) objects[off + i] = 0xff;
  clean(() => readDwg(rebuild(objects)));
});

test('random damage anywhere in the file ends in a clear message or a drawing, never a hang or a crash', () => {
  const bytes = written();
  let seed = 12345;
  const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
  const t0 = performance.now();
  for (let k = 0; k < 300; k++) {
    const b = bytes.slice();
    const flips = 1 + Math.floor(rnd() * 8);
    for (let i = 0; i < flips; i++) b[Math.floor(rnd() * b.length)] ^= 1 << Math.floor(rnd() * 8);
    clean(() => readDwg(b));
  }
  assert.ok(performance.now() - t0 < 20000, `${Math.round(performance.now() - t0)} ms for 300 damaged files`);
});

test('the decompressors cannot be made to write past their end or loop', () => {
  assert.throws(() => decompress18(new Uint8Array([0x00, 0x00, 0x00, 0x00, 0xff]), 100), DwgProblem);
  assert.throws(() => decompress18(new Uint8Array([0x0f, ...new Array(18).fill(1), 0x41, 0xff, 0x11]), 40), DwgProblem);
  assert.throws(() => decompress18(new Uint8Array(new Array(5000).fill(0)), 1_000_000), DwgProblem);
  assert.throws(() => decompress21(new Uint8Array([0x0f, 0xff, 0xff, 0xff]), 100), DwgProblem);
  const t0 = performance.now();
  let seed = 99;
  for (let k = 0; k < 2000; k++) {
    const junk = Uint8Array.from({ length: 64 }, () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 24));
    try {
      decompress18(junk, 4096);
    } catch (e) {
      assert.ok(e instanceof DwgProblem);
    }
    try {
      decompress21(junk, 4096);
    } catch (e) {
      assert.ok(e instanceof DwgProblem);
    }
  }
  assert.ok(performance.now() - t0 < 3000);
});

test('versions: older and newer files, and things that are not DWGs, are each told apart and named', () => {
  const head = (s: string) => {
    const b = new Uint8Array(0x200);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return b;
  };
  assert.match(clean(() => readDwg(head('AC1014'))), /AutoCAD R14 format \(AC1014\), older than CAD Draft reads/);
  assert.match(clean(() => readDwg(head('AC1009'))), /\(AC1009\), older than CAD Draft reads \(AutoCAD 2000 and later\)/);
  assert.match(clean(() => readDwg(head('AC1040'))), /an unknown version \(AC1040\), which CAD Draft does not read/);
  assert.match(clean(() => readDwg(head('PK\u0003\u0004'))), /not a DWG drawing/);
  assert.match(clean(() => readDwg(head('AC1021'))), /AutoCAD 2007 DWG \(AC1021\) cannot be opened/);
  assert.match(clean(() => readDwg(head('AC1018'))), /AutoCAD 2004 DWG \(AC1018\)/);
  assert.match(clean(() => readDwg(new Uint8Array(10))), /not a DWG drawing|too short/);
});

// ---- The 2007 format ---------------------------------------------------------------------------------------------
// No 2007 DWG from another program was at hand (ACadSharp does not write 2007), so this builds one from the published
// description of the format and checks the reader finds its sections again. It shows the 2007 page layout, the
// interleaved error-correcting blocks and the section map are read as described; it cannot show the description was
// understood right, and it uses only the literal form of the 2007 compression.

/** A 2007-format literal run: decompress21 unpacks it to `data`. */
function literal21(data: Uint8Array): Uint8Array {
  const L = data.length;
  const head: number[] = [];
  if (L < 0x17) head.push(L - 8);
  else {
    head.push(0x0f);
    let n = L - 0x17;
    if (n < 0xff) head.push(n);
    else {
      head.push(0xff);
      n -= 0xff;
      while (n >= 0xffff) {
        head.push(0xff, 0xff);
        n -= 0xffff;
      }
      head.push(n & 0xff, n >> 8);
    }
  }
  // Which byte of the run lands where (the format scrambles short runs and each 32): found by unpacking a probe.
  const probe = (shift: number) => decompress21(new Uint8Array([...head, ...Array.from({ length: L }, (_, i) => (i >> shift) & 0xff)]), L);
  const lo = probe(0);
  const hi = probe(8);
  const out = new Uint8Array(head.length + L);
  out.set(head);
  for (let k = 0; k < L; k++) out[head.length + (lo[k] | (hi[k] << 8))] = data[k];
  return out;
}

/** Spreads data over Reed-Solomon blocks of 255 (`k` data bytes each, parity left 0), interleaved `factor` ways. */
function interleave(data: Uint8Array, factor: number, k: number): Uint8Array {
  const out = new Uint8Array(factor * 255);
  for (let i = 0; i < factor; i++) for (let j = 0; j < k && i * k + j < data.length; j++) out[i + j * factor] = data[i * k + j];
  return out;
}

function make2007(sections: Array<[string, Uint8Array]>): Uint8Array {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const pageMap: Array<[number, number]> = [];
  const sm: number[] = [];
  const u64 = (v: number) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(v), true);
    return [...b];
  };
  let id = 0;
  for (const [name, data] of sections) {
    const pid = ++id;
    const factor = Math.max(1, Math.ceil(((data.length + 7) & ~7) / 251));
    const page = interleave(data, factor, 251);
    chunks.push(page);
    pageMap.push([page.length, pid]);
    const utf16 = [...name, '\u0000'].flatMap(c => [c.charCodeAt(0) & 0xff, c.charCodeAt(0) >> 8]);
    sm.push(...u64(data.length), ...u64(Math.max(1, data.length)), ...u64(0), ...u64(0), ...u64(utf16.length), ...u64(0), ...u64(4), ...u64(1), ...utf16);
    sm.push(...u64(0), ...u64(page.length), ...u64(pid), ...u64(data.length), ...u64(data.length), ...u64(0), ...u64(0));
    offset += page.length;
  }
  const system = (data: Uint8Array) => {
    const comp = literal21(data);
    const total = (comp.length + 7) & ~7;
    const factor = Math.ceil(total / 239);
    const padded = new Uint8Array(total);
    padded.set(comp);
    return { page: interleave(padded, factor, 239), comp: comp.length };
  };
  const smData = new Uint8Array(sm);
  const smPage = system(smData);
  const smId = ++id;
  const smOffset = offset;
  chunks.push(smPage.page);
  pageMap.push([smPage.page.length, smId]);
  offset += smPage.page.length;
  const pmData = new Uint8Array(pageMap.flatMap(([size, pid]) => [...u64(size), ...u64(pid)]));
  const pmPage = system(pmData);
  const pmOffset = offset;
  chunks.push(pmPage.page);
  void smOffset;
  const fh = new Uint8Array(0x110);
  const fv = new DataView(fh.buffer);
  const F = (i: number, v: number) => fv.setBigUint64(i * 8, BigInt(v), true);
  F(0, 0x70);
  F(3, 1);
  F(7, pmOffset);
  F(10, pmPage.comp);
  F(11, pmData.length);
  F(22, smPage.comp);
  F(24, smId);
  F(25, smData.length);
  F(27, 1);
  const decoded = new Uint8Array(3 * 239);
  new DataView(decoded.buffer).setInt32(24, -0x110, true);
  decoded.set(fh, 32);
  const file = new Uint8Array(0x480 + chunks.reduce((t, c) => t + c.length, 0));
  file.set([0x41, 0x43, 0x31, 0x30, 0x32, 0x31]);
  new DataView(file.buffer).setUint16(0x13, 30, true);
  file.set(interleave(decoded, 3, 239).subarray(0, 0x400), 0x80);
  let at = 0x480;
  for (const c of chunks) {
    file.set(c, at);
    at += c.length;
  }
  return file;
}

test('the 2007 layout: a file built from its published description gives back each of its sections', () => {
  const source = readParts(fixture('acadsharp-full-AC1024.dwg'));
  const file = make2007([['AcDb:Header', source.header], ['AcDb:Classes', source.classes], ['AcDb:Handles', source.handles], ['AcDb:AcDbObjects', source.objects]]);
  const back = readParts(file);
  assert.equal(back.name, 'AC1021');
  assert.deepEqual(back.header, source.header);
  assert.deepEqual(back.classes, source.classes);
  assert.deepEqual(back.handles, source.handles);
  assert.deepEqual(back.objects, source.objects);
  // Its objects are in the 2010 form, not 2007's, so reading on must end in a clear message or a drawing: never a crash.
  clean(() => readDwg(file));
  // Cut short, or a section missing: a clear message naming 2007.
  assert.match(clean(() => readDwg(file.subarray(0, file.length - 300))), /AutoCAD 2007 DWG \(AC1021\) cannot be opened/);
  assert.match(clean(() => readDwg(make2007([['AcDb:Header', source.header]]))), /AutoCAD 2007 DWG \(AC1021\) cannot be opened: it has no Classes section/);
});

test('a drawing over the item limit is refused with the limit named', () => {
  const d: Drawing = newDrawing('mm');
  for (let i = 0; i < 200_001; i++) d.ents.push({ type: 'point', p: P(i, 0), id: i + 1, layer: 'Geometry' });
  const bytes = writeDwg(d, { textAsLines: false, construction: false, hidden: false }).bytes;
  assert.match(clean(() => readDwg(bytes), 20000), /holds more than 200,000 items/);
});
