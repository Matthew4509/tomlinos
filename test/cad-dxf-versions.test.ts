// CAD Draft writes DXF R12 and 2000 to 2018 from one writer. Each release is written, read back and compared with the
// drawing (geometry within 1e-9, layers, colours, line types, text), and every 2000+ file is checked against the DXF
// reference's rules: unique handles, $HANDSEED above them all, owners that are real records, the classes and
// objects AutoCAD looks for, and group codes in their order. R12 stays as it was, byte for byte. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { distToShape } from '../src/apps/cad/edit.ts';
import { P, TAU, normAngle, rotatePt, type Pt } from '../src/apps/cad/geom.ts';
import { newDrawing, outlineOf, piecesOf, type Drawing, type Ent, type Shape } from '../src/apps/cad/model.ts';
import { dimParts } from '../src/apps/cad/notes.ts';
import { DXF_VERSIONS, DXF_VERSION_LIST, arcTolerance, decodeMtext, readDxf, writeDxf, type DxfVersion } from '../src/apps/cad/dxf.ts';
import { sampleDrawing } from './cad-sample-drawing.ts';

const MODERN = DXF_VERSION_LIST.filter(v => v !== 'R12');
const ALL = { textAsLines: false, construction: true, hidden: true };

// ---- A structural check of a 2000+ DXF --------------------------------------------------------------------------------

type Tag = [number, string];
interface Rec { type: string; tags: Tag[]; section: string }

function tagsOf(text: string): Tag[] {
  const lines = text.split('\r\n');
  assert.equal(lines.pop(), '', 'the file ends in a line end');
  assert.equal(lines.length % 2, 0, 'codes and values come in pairs');
  const out: Tag[] = [];
  for (let i = 0; i < lines.length; i += 2) {
    assert.match(lines[i], /^-?\d+$/, `line ${i + 1} is a group code`);
    out.push([Number(lines[i]), lines[i + 1]]);
  }
  return out;
}

function recordsOf(tags: Tag[]): Rec[] {
  const out: Rec[] = [];
  let section = '';
  for (let i = 0; i < tags.length; i++) {
    const [c, v] = tags[i];
    if (c === 0) {
      if (v === 'SECTION') section = tags[i + 1][1];
      out.push({ type: v, tags: [], section });
      if (v === 'ENDSEC') section = '';
    } else out.at(-1)!.tags.push(tags[i]);
  }
  return out;
}

const val = (r: Rec, code: number) => r.tags.find(t => t[0] === code)?.[1];
const POINTER = new Set([330, 340, 350, 360, 390]);

/** Every rule broken, as words (an empty list for a good file). */
function audit(w: { text: string; bytes: Uint8Array }, version: DxfVersion): string[] {
  const bad: string[] = [];
  const tags = tagsOf(w.text);
  const recs = recordsOf(tags);
  const sections = recs.filter(r => r.type === 'SECTION').map(r => val(r, 2));
  if (sections.join() !== 'HEADER,CLASSES,TABLES,BLOCKS,ENTITIES,OBJECTS') bad.push(`sections in order: ${sections.join()}`);
  if (tags.at(-1)![1] !== 'EOF') bad.push('the file ends with EOF');
  const header = recs[0].tags;
  const hv = (name: string) => header[header.findIndex(t => t[0] === 9 && t[1] === name) + 1];
  if (hv('$ACADVER')?.[1] !== DXF_VERSIONS[version].acad) bad.push('$ACADVER');
  if (hv('$DWGCODEPAGE')?.[1] !== 'ANSI_1252') bad.push('$DWGCODEPAGE');

  // Handles: one per record, unique, below $HANDSEED.
  const handles = new Map<string, Rec>();
  const noHandle = new Set(['SECTION', 'ENDSEC', 'EOF', 'CLASS', 'ENDTAB']);
  for (const r of recs) {
    if (noHandle.has(r.type) || r.section === 'HEADER') continue;
    // A table's handle comes after its name; every other record starts with its handle.
    const first = r.tags[r.type === 'TABLE' ? 1 : 0];
    const code = r.type === 'DIMSTYLE' ? 105 : 5;
    if (!first || first[0] !== code) {
      bad.push(`${r.type} in ${r.section} starts with its handle (${code})`);
      continue;
    }
    if (!/^[0-9A-F]+$/.test(first[1])) bad.push(`${r.type} handle ${first[1]} is hexadecimal`);
    if (handles.has(first[1])) bad.push(`handle ${first[1]} given twice`);
    handles.set(first[1], r);
  }
  const seed = parseInt(hv('$HANDSEED')?.[1] ?? '0', 16);
  const top = Math.max(...[...handles.keys()].map(h => parseInt(h, 16)));
  if (!(seed > top)) bad.push(`$HANDSEED ${seed.toString(16)} above the highest handle ${top.toString(16)}`);
  // Every pointer points at a real record.
  for (const r of recs) for (const [c, v] of r.tags) if (POINTER.has(c) && v !== '0' && !handles.has(v)) bad.push(`${r.type} points (${c}) at ${v}, which is no record`);

  // Tables: their owners, counts and the records AutoCAD needs.
  const tables = new Map<string, { handle: string; count: number; recs: Rec[] }>();
  let current: { handle: string; count: number; recs: Rec[] } | null = null;
  for (const r of recs.filter(x => x.section === 'TABLES')) {
    if (r.type === 'TABLE') {
      current = { handle: r.tags[1]?.[1], count: Number(val(r, 70)), recs: [] };
      if (r.tags[0][0] !== 2 || r.tags[1][0] !== 5 || r.tags[2].join() !== '330,0' || r.tags[3].join() !== '100,AcDbSymbolTable' || r.tags[4][0] !== 70) bad.push(`TABLE ${val(r, 2)} codes in order 2 5 330 100 70`);
      tables.set(val(r, 2)!, current);
    } else if (r.type === 'ENDTAB') current = null;
    else if (r.type !== 'SECTION' && r.type !== 'ENDSEC' && current) {
      current.recs.push(r);
      if (r.tags[1]?.[0] !== 330 || r.tags[1][1] !== current.handle) bad.push(`${r.type} ${val(r, 2)} is owned by its table`);
      if (r.tags[2]?.join() !== '100,AcDbSymbolTableRecord' || r.tags[3]?.[0] !== 100 || r.tags[4]?.[0] !== 2) bad.push(`${r.type} ${val(r, 2)} codes in order: handle, owner, 100, 100, name`);
    }
  }
  const order = ['VPORT', 'LTYPE', 'LAYER', 'STYLE', 'VIEW', 'UCS', 'APPID', 'DIMSTYLE', 'BLOCK_RECORD'];
  if ([...tables.keys()].join() !== order.join()) bad.push(`tables in order: ${[...tables.keys()].join()}`);
  for (const [name, t] of tables) if (t.count !== t.recs.length) bad.push(`TABLE ${name} says ${t.count} records and holds ${t.recs.length}`);
  const namesIn = (table: string) => new Set((tables.get(table)?.recs ?? []).map(r => val(r, 2)!.toUpperCase()));
  const need: Record<string, string[]> = {
    VPORT: ['*ACTIVE'], LTYPE: ['BYBLOCK', 'BYLAYER', 'CONTINUOUS', 'DASHED', 'CENTER', 'HIDDEN', 'DOT'], LAYER: ['0'], STYLE: ['STANDARD'], APPID: ['ACAD'], DIMSTYLE: ['STANDARD'], BLOCK_RECORD: ['*MODEL_SPACE', '*PAPER_SPACE'],
  };
  for (const [table, list] of Object.entries(need)) for (const n of list) if (!namesIn(table).has(n)) bad.push(`${table} ${n} is there`);
  for (const [table, t] of tables) {
    const seen = new Set<string>();
    for (const r of t.recs) {
      const n = val(r, 2)!.toUpperCase();
      if (seen.has(n)) bad.push(`${table} ${n} twice`);
      seen.add(n);
    }
  }
  const layers = namesIn('LAYER');
  const ltypes = namesIn('LTYPE');
  for (const r of tables.get('LAYER')!.recs) if (!ltypes.has(val(r, 6)!.toUpperCase())) bad.push(`layer ${val(r, 2)} has a line type that is in LTYPE`);
  const br = new Map(tables.get('BLOCK_RECORD')!.recs.map(r => [val(r, 2)!, r.tags[0][1]]));
  const model = br.get('*Model_Space')!;

  // Blocks: *Model_Space and *Paper_Space, each owned by its block record.
  const blocks = recs.filter(r => r.section === 'BLOCKS' && (r.type === 'BLOCK' || r.type === 'ENDBLK'));
  if (blocks.map(b => b.type).join() !== 'BLOCK,ENDBLK,BLOCK,ENDBLK') bad.push('two blocks, each BLOCK then ENDBLK');
  for (const b of blocks.filter(x => x.type === 'BLOCK')) if (br.get(val(b, 2)!) !== val(b, 330)) bad.push(`BLOCK ${val(b, 2)} owned by its block record`);

  // Items: owned by model space, on a layer of the table, with their classes in order.
  const classes: Record<string, string[]> = {
    LINE: ['AcDbLine'], CIRCLE: ['AcDbCircle'], ARC: ['AcDbCircle', 'AcDbArc'], LWPOLYLINE: ['AcDbPolyline'], ELLIPSE: ['AcDbEllipse'], SPLINE: ['AcDbSpline'],
    TEXT: ['AcDbText', 'AcDbText'], MTEXT: ['AcDbMText'], POINT: ['AcDbPoint'], XLINE: ['AcDbXline'],
  };
  for (const e of recs.filter(r => r.section === 'ENTITIES' && r.type !== 'SECTION' && r.type !== 'ENDSEC')) {
    if (!classes[e.type]) bad.push(`${e.type} is an item this writer means to write`);
    if (e.tags[1]?.join() !== `330,${model}` || e.tags[2]?.join() !== '100,AcDbEntity' || e.tags[3]?.[0] !== 8) bad.push(`${e.type} ${e.tags[0][1]}: handle, owner (model space), 100 AcDbEntity, layer`);
    if (!layers.has(e.tags[3][1].toUpperCase())) bad.push(`${e.type} on layer ${e.tags[3][1]}, which is in LAYER`);
    const got = e.tags.filter(t => t[0] === 100).slice(1).map(t => t[1]);
    if (got.join() !== (classes[e.type] ?? []).join()) bad.push(`${e.type} classes ${got.join()}`);
    if (e.type === 'LWPOLYLINE' && Number(val(e, 90)) !== e.tags.filter(t => t[0] === 10).length) bad.push('LWPOLYLINE 90 is its number of points');
    if (e.type === 'SPLINE') {
      if (Number(val(e, 72)) !== e.tags.filter(t => t[0] === 40).length) bad.push('SPLINE 72 is its number of knots');
      if (Number(val(e, 73)) !== e.tags.filter(t => t[0] === 10).length) bad.push('SPLINE 73 is its number of control points');
      if (Number(val(e, 72)) !== Number(val(e, 73)) + Number(val(e, 71)) + 1) bad.push('SPLINE knots = control points + degree + 1');
    }
    // Each x is followed by its y (and z where it has one).
    for (let i = 0; i < e.tags.length; i++) {
      const c = e.tags[i][0];
      if (c >= 10 && c <= 18 && e.tags[i + 1]?.[0] !== c + 10) bad.push(`${e.type}: code ${c} is followed by ${c + 10}`);
    }
  }

  // Objects: the root dictionary first, owned by nothing, holding the dictionaries AutoCAD looks for.
  const objects = recs.filter(r => r.section === 'OBJECTS' && r.type !== 'SECTION' && r.type !== 'ENDSEC');
  const root = objects[0];
  if (root?.type !== 'DICTIONARY' || val(root, 330) !== '0') bad.push('OBJECTS starts with the root dictionary, owned by nothing');
  const entries = (r: Rec) => {
    const m = new Map<string, string>();
    r.tags.forEach((t, i) => {
      if (t[0] === 3 && r.tags[i + 1]?.[0] === 350) m.set(t[1], r.tags[i + 1][1]);
    });
    return m;
  };
  const rootEntries = entries(root);
  for (const n of ['ACAD_GROUP', 'ACAD_LAYOUT', 'ACAD_MLINESTYLE', 'ACAD_PLOTSTYLENAME']) if (!rootEntries.has(n)) bad.push(`root dictionary holds ${n}`);
  for (const [, h] of rootEntries) {
    const owned = handles.get(h)!;
    if (val(owned, 330) !== root.tags[0][1]) bad.push(`${owned.type} ${h} is owned by the root dictionary`);
  }
  const layoutDict = handles.get(rootEntries.get('ACAD_LAYOUT')!)!;
  const layouts = entries(layoutDict);
  for (const [name, space] of [['Model', '*Model_Space'], ['Layout1', '*Paper_Space']]) {
    const lay = handles.get(layouts.get(name) ?? '');
    if (lay?.type !== 'LAYOUT') {
      bad.push(`ACAD_LAYOUT holds the ${name} LAYOUT`);
      continue;
    }
    const ptrs = lay.tags.filter(t => t[0] === 330).map(t => t[1]);
    if (ptrs.at(-1) !== br.get(space)) bad.push(`LAYOUT ${name} points at ${space}`);
    const rec = tables.get('BLOCK_RECORD')!.recs.find(r => val(r, 2) === space)!;
    if (val(rec, 340) !== lay.tags[0][1]) bad.push(`${space} points at its LAYOUT`);
  }
  if (!objects.some(r => r.type === 'MLINESTYLE' && val(r, 2) === 'Standard')) bad.push('the Standard MLINESTYLE is there');
  // Classes named for the objects that need them.
  const classNames = recs.filter(r => r.type === 'CLASS').map(r => val(r, 1));
  for (const t of new Set(objects.map(o => o.type))) if (!['DICTIONARY', 'MLINESTYLE'].includes(t) && !classNames.includes(t)) bad.push(`CLASSES names ${t}`);

  // Letters: UTF-8 from 2007; before, only Windows' Western letters (anything else as \U+ codes).
  const acad = DXF_VERSIONS[version].acad;
  if (acad >= 'AC1021') {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(w.bytes);
    } catch {
      bad.push('a 2007+ file is good UTF-8');
    }
  } else if (new TextDecoder('windows-1252').decode(w.bytes) !== w.text) bad.push('a 2000/2004 file holds only Windows Western letters');
  return bad;
}

// ---- What a drawing should come back as -----------------------------------------------------------------------------

/** The drawing's items as a DXF of 2000+ holds them: dimensions as their lines, arcs and text; angles as read. */
function expected(d: Drawing): Shape[] {
  const out: Shape[] = [];
  for (const e of d.ents) {
    const { id: _id, layer: _layer, ...s } = e;
    if (s.type === 'dim') {
      const parts = dimParts(s);
      for (const p of parts.pieces) {
        if (p.k === 'seg') out.push({ type: 'line', a: p.a, b: p.b });
        else if (p.k === 'arc') out.push(p.a1 - p.a0 >= TAU - 1e-12 ? { type: 'circle', c: p.c, r: p.r } : { type: 'arc', c: p.c, r: p.r, a0: normAngle(p.a0), a1: normAngle(p.a0) + (p.a1 - p.a0) });
      }
      for (const t of parts.texts) out.push({ type: 'text', ...t, angle: normAngle(t.angle) });
    } else if (s.type === 'text') out.push({ ...s, angle: normAngle(s.angle) });
    else out.push(s as Shape);
  }
  return out;
}

function close(a: unknown, b: unknown, where: string, tol = 1e-9): void {
  if (typeof a === 'number' && typeof b === 'number') {
    assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${where}: ${a} is ${b}`);
  } else if (Array.isArray(a) && Array.isArray(b)) {
    assert.equal(a.length, b.length, `${where}: as many`);
    a.forEach((v, i) => close(v, b[i], `${where}[${i}]`, tol));
  } else if (a && b && typeof a === 'object' && typeof b === 'object') {
    assert.deepEqual(Object.keys(a).filter(k => (a as Record<string, unknown>)[k] !== undefined).sort(), Object.keys(b).filter(k => (b as Record<string, unknown>)[k] !== undefined).sort(), `${where}: same fields`);
    for (const k of Object.keys(b)) close((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${where}.${k}`, tol);
  } else assert.equal(a, b, where);
}

const strip = (e: Ent): Shape => {
  const { id: _id, layer: _layer, ...s } = e;
  return s as Shape;
};

// ---- Tests ----------------------------------------------------------------------------------------------------------

test('R12 is written exactly as before (byte for byte)', () => {
  // Remade when numbers were first written with every digit they need to read back the same (they had been cut to
  // ten decimal places); checked then that nothing else in the three files had changed.
  const hash = (d: Drawing, o: typeof ALL) => createHash('sha256').update(writeDxf(d, o).bytes).digest('hex');
  assert.equal(hash(sampleDrawing(), { textAsLines: false, construction: false, hidden: false }), '05b71bf94259b0e285af383a0cd4a15695737cc1317d8f4270a5197454da40a5');
  assert.equal(hash(sampleDrawing(), ALL), '11fd9e984899ad1f5b92898371c842cf9abba69fefa4534afd13e1d9ea67a4cd');
  assert.equal(hash(sampleDrawing('inch'), { textAsLines: true, construction: true, hidden: true }), '3e6670271cb5c0390f8daa5671a9653927855dd21500c8dbe1ef9aa948e87d01');
  // Not giving a release is R12.
  assert.equal(writeDxf(sampleDrawing(), { ...ALL, version: 'R12' }).text, writeDxf(sampleDrawing(), ALL).text);
});

for (const version of MODERN) {
  test(`DXF ${version} (${DXF_VERSIONS[version].acad}) passes the structural audit`, () => {
    for (const units of ['mm', 'inch'] as const) {
      for (const o of [ALL, { textAsLines: true, construction: false, hidden: false }]) {
        const w = writeDxf(sampleDrawing(units), { ...o, version });
        assert.deepEqual(audit(w, version), [], `${units} ${JSON.stringify(o)}`);
      }
    }
    // An empty drawing too.
    assert.deepEqual(audit(writeDxf(newDrawing(), { ...ALL, version }), version), []);
  });

  test(`DXF ${version} round trip: same geometry within 1e-9, layers, colours, line types and text`, () => {
    for (const units of ['mm', 'inch'] as const) {
      const d = sampleDrawing(units);
      const w = writeDxf(d, { ...ALL, version });
      const r = readDxf(w.bytes);
      assert.equal(r.drawing.units, units);
      assert.equal(r.leftOut, 0);
      assert.equal(r.changed, 0, `nothing is changed on the way back: ${r.report.join(' | ')}`);
      assert.deepEqual(r.drawing.layers.filter(l => l.name !== '0'), d.layers, 'the same layers, colours, line types, off and locked');
      const want = expected(d);
      assert.equal(r.drawing.ents.length, want.length);
      r.drawing.ents.forEach((e, i) => close(strip(e), want[i], `${version} ${units} item ${i} (${want[i].type})`));
      const wantLayers = d.ents.flatMap(e => (e.type === 'dim' ? Array(dimParts(e).pieces.length + dimParts(e).texts.length).fill(e.layer) : [e.layer]));
      assert.deepEqual(r.drawing.ents.map(e => e.layer), wantLayers, 'each item on its layer');
    }
  });
}

test('R12 round trip: the same, but ellipses and curves come back as polylines of arcs within the arc tolerance', () => {
  const d = sampleDrawing();
  const r = readDxf(writeDxf(d, ALL).bytes);
  const tol = arcTolerance('mm');
  const byName = new Map([['GEOMETRY', 'Geometry'], ['CONSTRUCTION', 'Construction'], ['DIMENSIONS', 'Dimensions'], ['TEXT', 'Text'], ['CUT_OUTS', 'Cut outs'], ['HIDDEN_NOTES', 'Hidden notes']]);
  for (const l of d.layers) {
    const got = r.drawing.layers.find(x => byName.get(x.name) === l.name || x.name === l.name)!;
    assert.deepEqual({ ...got, name: l.name }, l, `layer ${l.name}`);
  }
  let i = 0;
  for (const e of d.ents) {
    if (e.type === 'ellipse' || e.type === 'spline') {
      const got = r.drawing.ents[i++];
      assert.equal(got.type, 'poly');
      for (const p of outlineOf(got)) for (let k = 0; k <= 16; k++) {
        const t = k / 16;
        const q: Pt = p.k === 'seg' ? P(p.a.x + (p.b.x - p.a.x) * t, p.a.y + (p.b.y - p.a.y) * t) : p.k === 'arc' ? P(p.c.x + p.r * Math.cos(p.a0 + (p.a1 - p.a0) * t), p.c.y + p.r * Math.sin(p.a0 + (p.a1 - p.a0) * t)) : P(0, 0);
        assert.ok(distToShape(e, q) <= tol + 1e-9, `${e.type} within ${tol}`);
      }
    } else if (e.type === 'xline') {
      const got = r.drawing.ents[i++];
      assert.equal(got.type, 'line');
    } else if (e.type === 'text') {
      for (const [row, words] of e.text.split('\n').entries()) {
        const got = r.drawing.ents[i++];
        assert.equal(got.type, 'text');
        if (got.type !== 'text') continue;
        // R12 holds Windows' Western letters only: the rest become ?.
        assert.equal(got.text, words.replace(/⌀/g, 'Ø').replace(/[^\u0000-\u00ff€]/g, '?'));
        close(got.p, rotatePt(P(e.p.x, e.p.y - row * 1.6 * e.h), e.p, e.angle), 'text foot');
      }
    } else if (e.type === 'dim') {
      i += dimParts(e).pieces.length + dimParts(e).texts.length;
    } else {
      close(strip(r.drawing.ents[i++]), strip(e), e.type);
    }
  }
  assert.equal(i, r.drawing.ents.length);
});

test('what differs between the releases: version, code page, UTF-8 from 2007, class counts from 2004', () => {
  const words = 'Ελλάδα ⌀ 50°';
  const d = newDrawing();
  d.ents = [{ id: 1, layer: 'Geometry', type: 'text', p: P(0, 0), text: words, h: 5, angle: 0, align: 'left' }];
  for (const version of MODERN) {
    const w = writeDxf(d, { ...ALL, version });
    assert.match(w.text, new RegExp(`\\$ACADVER\r\n1\r\n${DXF_VERSIONS[version].acad}\r\n`));
    const utf8 = DXF_VERSIONS[version].acad >= 'AC1021';
    if (utf8) assert.ok(w.text.includes(words), `${version} writes the letters as they are`);
    else assert.ok(w.text.includes('\\U+0395\\U+03BB\\U+03BB\\U+03AC\\U+03B4\\U+03B1 \\U+2300 50°'), `${version} writes \\U+ codes beyond cp1252`);
    assert.equal(/\r\n91\r\n/.test(w.text.slice(0, w.text.indexOf('TABLES'))), DXF_VERSIONS[version].acad >= 'AC1018', `${version} class instance counts`);
    const back = readDxf(w.bytes).drawing.ents[0];
    assert.equal(back.type === 'text' && back.text, words, `${version} reads the words back`);
  }
});

test('units: $INSUNITS and $MEASUREMENT from the drawing', () => {
  for (const [units, ins, meas] of [['mm', '4', '1'], ['inch', '1', '0']] as const) {
    const t = writeDxf(newDrawing(units), { ...ALL, version: '2013' }).text;
    assert.match(t, new RegExp(`\\$INSUNITS\r\n70\r\n${ins}\r\n`));
    assert.match(t, new RegExp(`\\$MEASUREMENT\r\n70\r\n${meas}\r\n`));
  }
});

test('2000+: layer names keep their small letters; names a DXF cannot hold are changed and said', () => {
  const d = newDrawing();
  d.layers.push({ name: 'a/b', colour: '#ff4040', on: true, locked: false, lineType: 'dotted' }, { name: 'A_B', colour: '#ff4040', on: true, locked: false, lineType: 'dotted' }, { name: 'Ü layer ❖', colour: '#4080ff', on: true, locked: false, lineType: 'continuous' });
  d.ents = [{ id: 1, layer: 'a/b', type: 'line', a: P(0, 0), b: P(1, 1) }, { id: 2, layer: 'Ü layer ❖', type: 'line', a: P(0, 0), b: P(2, 1) }];
  for (const version of ['2000', '2018'] as const) {
    const w = writeDxf(d, { ...ALL, version });
    assert.deepEqual(audit(w, version), []);
    assert.match(w.notes.join('\n'), /Layer names a DXF cannot hold were changed: a\/b → a_b, A_B → A_B_2\./);
    const r = readDxf(w.bytes);
    assert.deepEqual(r.drawing.layers.map(l => l.name).filter(n => n !== '0'), ['Geometry', 'Construction', 'Dimensions', 'Text', 'a_b', 'A_B_2', 'Ü layer ❖']);
    assert.deepEqual(r.drawing.ents.map(e => e.layer), ['a_b', 'Ü layer ❖']);
  }
});

test('2000/2004: words that would also read as UTF-8 are written all in \\U+ codes, so no reader takes them wrongly', () => {
  const d = newDrawing();
  d.ents = [{ id: 1, layer: 'Geometry', type: 'text', p: P(0, 0), text: 'CafÃ©', h: 5, angle: 0, align: 'left' }];
  const w = writeDxf(d, { ...ALL, version: '2004' });
  assert.ok(w.bytes.every(b => b < 0x80));
  const back = readDxf(w.bytes).drawing.ents[0];
  assert.equal(back.type === 'text' && back.text, 'CafÃ©');
});

test('2000+: long, many-line and coded text comes back letter for letter', () => {
  const long = `${'word '.repeat(80)}end`;
  const tricky = ['50%% off %%d and %', 'a\\P b {c} \\U+0041 d', '  lead', 'tab\there', '😀 x'.repeat(100)];
  const d = newDrawing();
  d.ents = [long, ...tricky, tricky.join('\n')].map((text, i) => ({ id: i + 1, layer: 'Text', type: 'text', p: P(i * 10, 5), text, h: 3, angle: 1, align: 'right' }) as Ent);
  for (const version of ['2000', '2007'] as const) {
    const w = writeDxf(d, { ...ALL, version });
    assert.deepEqual(audit(w, version), []);
    const r = readDxf(w.bytes);
    assert.deepEqual(r.drawing.ents.map(e => e.type === 'text' && e.text), d.ents.map(e => e.type === 'text' && e.text), version);
    r.drawing.ents.forEach((e, i) => close(strip(e), { ...strip(d.ents[i]) }, `${version} text ${i}`));
  }
});

test('MTEXT codes are read left to right: an escaped backslash never starts a code', () => {
  assert.equal(decodeMtext('a\\\\P b'), 'a\\P b');
  assert.equal(decodeMtext('a\\\\U+0041'), 'a\\U+0041');
  assert.equal(decodeMtext('{\\fArial|b0;Big} \\H2.5x;x\\Pnext'), 'Big x\nnext');
  assert.equal(decodeMtext('\\S1/2;" and \\S3^4;'), '1/2" and 3/4');
  assert.equal(decodeMtext('\\U+00B0 and %%c'), '° and Ø');
  assert.equal(decodeMtext('\\Lunder\\l \\{x\\}'), 'under {x}');
});

test('a 2000+ SPLINE that is not one of ours is still read as a polyline of arcs', () => {
  const d = newDrawing();
  d.ents = [{ id: 1, layer: 'Geometry', type: 'spline', fit: [P(0, 0), P(10, 5), P(20, 0)], closed: false }];
  const w = writeDxf(d, { ...ALL, version: '2000' });
  // Move one pull point: no longer the curve CAD Draft draws through those points.
  const moved = w.text.replace(/(AcDbSpline[\s\S]*?\r\n10\r\n[^\r]*\r\n20\r\n[^\r]*\r\n30\r\n[^\r]*\r\n10\r\n)([^\r]*)/, (_, a: string, x: string) => `${a}${Number(x) + 0.5}`);
  assert.notEqual(moved, w.text);
  const r = readDxf(new TextEncoder().encode(moved));
  assert.equal(r.drawing.ents[0].type, 'poly');
  assert.match(r.report.join('\n'), /1 curve \(splines\) drawn as polylines of arcs/);
  // And ours comes back as the curve, its pieces where they were.
  const ours = readDxf(w.bytes).drawing.ents[0];
  assert.equal(ours.type, 'spline');
  close(piecesOf(ours), piecesOf(d.ents[0]), 'pieces');
});

test('the audit itself catches a broken file (a handle twice, a low $HANDSEED, an owner that is no record)', () => {
  const w = writeDxf(sampleDrawing(), { ...ALL, version: '2010' });
  const bad = (text: string) => audit({ text, bytes: new TextEncoder().encode(text) }, '2010');
  assert.ok(bad(w.text.replace(/(LINE\r\n5\r\n)[0-9A-F]+/, '$11')).some(b => /given twice/.test(b)));
  assert.ok(bad(w.text.replace(/(\$HANDSEED\r\n5\r\n)[0-9A-F]+/, '$12')).some(b => /HANDSEED/.test(b)));
  assert.ok(bad(w.text.replace(/(ARC\r\n5\r\n[0-9A-F]+\r\n330\r\n)[0-9A-F]+/, '$1FFFF')).some(b => /no record/.test(b)));
});
