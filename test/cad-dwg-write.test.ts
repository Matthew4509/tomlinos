// CAD Draft writes AutoCAD 2004 DWG files of its own (no outside library). Checked here: the file's check sums and
// structure, the compression, and that CAD Draft's reading of what it wrote matches what ACadSharp (an independent
// DWG library, run offline when the fixtures were made) read from the same file. Run: npm test
// To remake the fixture after a deliberate change to the writer: DWG_FIXTURES=write node --test test/cad-dwg-write.test.ts,
// then open it with ACadSharp and record its dump in tomlin-sample-2004.acadsharp.txt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { BitReader, crc16, crc32, pageChecksum } from '../src/apps/cad/dwg/bits.ts';
import { readParts, unmaskHeader18 } from '../src/apps/cad/dwg/container.ts';
import { compress18, decompress18 } from '../src/apps/cad/dwg/lz77.ts';
import { readObjectMap } from '../src/apps/cad/dwg/objects.ts';
import { readHeader } from '../src/apps/cad/dwg/header.ts';
import { decoderFor } from '../src/apps/cad/dwg/bits.ts';
import { dwgName, writeDwg } from '../src/apps/cad/dwg/write.ts';
import { P } from '../src/apps/cad/geom.ts';
import { newDrawing } from '../src/apps/cad/model.ts';
import { FIXED, comparable, dumpDwg, sampleDrawing } from './cad-dwg-dump.ts';

const FIX = new URL('./fixtures/dwg/', import.meta.url);
const opts = { textAsLines: false, construction: true, hidden: true, ...FIXED };

test('the sample drawing reads back, in CAD Draft, exactly as ACadSharp read the same file', () => {
  const w = writeDwg(sampleDrawing(), opts);
  if (process.env.DWG_FIXTURES === 'write') writeFileSync(new URL('tomlin-sample-2004.dwg', FIX), w.bytes);
  const recorded = comparable(readFileSync(new URL('tomlin-sample-2004.acadsharp.txt', FIX), 'utf8').split(/\r?\n/));
  assert.ok(recorded.length > 30, 'the recorded ACadSharp dump is there');
  assert.deepEqual(dumpDwg(w.bytes), recorded);
  // The file ACadSharp was shown is the one in the fixtures; it still reads the same.
  assert.deepEqual(dumpDwg(new Uint8Array(readFileSync(new URL('tomlin-sample-2004.dwg', FIX)))), recorded);
});

test('ACadSharp found both layouts and the paper space block in the file it was shown', () => {
  const all = readFileSync(new URL('tomlin-sample-2004.acadsharp.txt', FIX), 'utf8');
  assert.match(all, /^LAYOUT Model block=\*Model_Space$/m);
  assert.match(all, /^LAYOUT Layout1 block=\*Paper_Space$/m);
  assert.doesNotMatch(all, /NOTE|FAILED/, 'ACadSharp read it with no warnings, with its fail-safe off');
});

test('the same drawing and time give the same bytes', () => {
  const a = writeDwg(sampleDrawing(), opts).bytes;
  const b = writeDwg(sampleDrawing(), opts).bytes;
  assert.deepEqual(a, b);
});

test('every check sum in a written file is right: file header, pages, sections, object map and each object', () => {
  const bytes = writeDwg(sampleDrawing(), opts).bytes;
  assert.equal(String.fromCharCode(...bytes.subarray(0, 6)), 'AC1018');
  const head = unmaskHeader18(bytes);
  const stored = new DataView(head.buffer).getUint32(0x68, true);
  const copy = head.slice();
  new DataView(copy.buffer).setUint32(0x68, 0, true);
  assert.equal(crc32(copy), stored, 'file header CRC32');
  // The masked header is repeated at the end of the file.
  assert.deepEqual(bytes.subarray(bytes.length - 0x6c), bytes.subarray(0x80, 0x80 + 0x6c));
  // Each data page: its data checksum and its header checksum (seeded with the data's).
  const v = new DataView(bytes.buffer, bytes.byteOffset);
  let pages = 0;
  for (let at = 0x100; at + 32 < bytes.length; ) {
    const mask = (0x4164536b ^ at) >>> 0;
    if ((v.getUint32(at, true) ^ mask) >>> 0 !== 0x4163043b) break;
    const h = [0, 1, 2, 3, 4, 5, 6, 7].map(i => (v.getUint32(at + i * 4, true) ^ mask) >>> 0);
    const data = bytes.subarray(at + 32, at + 32 + h[2]);
    assert.equal(pageChecksum(0, data), h[7], `page at ${at.toString(16)}: data checksum`);
    const plain = new Uint8Array(32);
    h.forEach((x, i) => new DataView(plain.buffer).setUint32(i * 4, i === 6 ? 0 : x, true));
    assert.equal(pageChecksum(h[7], plain), h[6], `page at ${at.toString(16)}: header checksum`);
    at += h[3];
    pages++;
  }
  assert.ok(pages >= 10, `${pages} data pages`);
  const parts = readParts(bytes);
  assert.deepEqual(parts.checks, []);
  for (const [name, d] of [['header', parts.header], ['classes', parts.classes]] as const) {
    const size = new DataView(d.buffer, d.byteOffset).getUint32(16, true);
    assert.equal(crc16(d, 0xc0c1, 16, 20 + size), d[20 + size] | (d[21 + size] << 8), `${name} CRC`);
  }
  const map = readObjectMap(parts.handles);
  assert.ok(map.length > 40);
  for (const [h, off] of map) {
    const r = new BitReader(parts.objects, off * 8);
    const size = r.MS();
    const end = (r.pos >> 3) + size;
    assert.equal(crc16(parts.objects, 0xc0c1, off, end), parts.objects[end] | (parts.objects[end + 1] << 8), `object ${h.toString(16)} CRC`);
  }
});

test('the 2004 compression packs and unpacks every kind of data the same', () => {
  let seed = 7;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 16) & 0xff;
  const cases: Uint8Array[] = [new Uint8Array(0), new Uint8Array([1, 2, 3, 4]), new Uint8Array(5000), Uint8Array.from({ length: 30000 }, rnd)];
  cases.push(Uint8Array.from({ length: 0x7400 }, (_, i) => (i % 97 < 50 ? i % 13 : rnd())));
  cases.push(Uint8Array.from({ length: 20000 }, (_, i) => [1, 2, 3, 1, 2, 3, 9][i % 7]));
  for (const c of cases) {
    const packed = compress18(c);
    assert.deepEqual(decompress18(packed, c.length), c, `${c.length} bytes`);
  }
  assert.ok(compress18(new Uint8Array(5000)).length < 200, 'zeros pack small');
});

test('an inch drawing says inches, and a layer name AutoCAD refuses is changed and said', () => {
  const d = newDrawing('inch');
  d.layers.push({ name: 'a<b>c:d', colour: '#ff4040', on: true, locked: false, lineType: 'continuous' });
  d.ents.push({ type: 'line', a: P(0, 0), b: P(1, 1), id: 1, layer: 'a<b>c:d' });
  const w = writeDwg(d, { textAsLines: false, construction: false, hidden: false });
  const parts = readParts(w.bytes);
  assert.equal(readHeader(parts.header, parts.ver, parts.maint, decoderFor(30)).get('INSUNITS'), 1);
  assert.match(w.notes.join('\n'), /a<b>c:d → a_b_c_d/);
  assert.match(dumpDwg(w.bytes).join('\n'), /^LAYER a_b_c_d colour=1 on=True/m);
  assert.equal(dwgName('  '), 'Layer');
});

test('hidden layers and construction lines are left out unless asked for, and said', () => {
  const d = sampleDrawing();
  const w = writeDwg(d, { textAsLines: false, construction: false, hidden: false, ...FIXED });
  assert.match(w.notes.join('\n'), /1 item on hidden layers left out/);
  assert.match(w.notes.join('\n'), /1 construction line left out/);
  assert.doesNotMatch(dumpDwg(w.bytes).join('\n'), /^XLINE /m);
});

test('a big drawing spans many pages and object map sections, and every item comes back', () => {
  const d = newDrawing('mm');
  for (let i = 0; i < 20000; i++) d.ents.push({ type: 'line', a: P(i, 0), b: P(i, 100 + (i % 7)), id: i + 1, layer: 'Geometry' });
  const w = writeDwg(d, { textAsLines: false, construction: false, hidden: false });
  const lines = dumpDwg(w.bytes);
  assert.equal(lines.filter(l => l.startsWith('LINE ')).length, 20000);
  assert.equal(lines.find(l => l.startsWith('LINE ') && l.includes('(19999,0)')), 'LINE layer=Geometry (19999,0)-(19999,100)');
  const parts = readParts(w.bytes);
  assert.ok(parts.objects.length > 0x7400 * 3, 'the objects section spans several pages');
});

test('text as lines writes no TEXT items, and letters beyond Windows\' Western set are kept as \\U+ codes', () => {
  const d = newDrawing('mm');
  d.ents.push({ type: 'text', p: P(0, 0), text: 'AB', h: 5, angle: 0, align: 'left', id: 1, layer: 'Text' });
  const asLines = dumpDwg(writeDwg(d, { textAsLines: true, construction: false, hidden: false }).bytes);
  assert.ok(!asLines.some(l => l.startsWith('TEXT ')) && asLines.some(l => l.startsWith('LINE ') || l.startsWith('LWPOLYLINE ')));
  d.ents[0] = { ...d.ents[0], text: 'Ωmega' } as typeof d.ents[0];
  assert.match(dumpDwg(writeDwg(d, { textAsLines: false, construction: false, hidden: false }).bytes).join('\n'), /"\\U\+03A9mega"/);
});
