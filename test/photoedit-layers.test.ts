// Photo Editor's layers, undo tiles and OpenRaster files, without a browser.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clipRect, group, History, PixelPatch, TILE, type Surface } from '../src/apps/photoedit/history.ts';
import { BLEND_MODES, blendFromOra, copyName, layerLimit, LAYER_BUDGET, moveItem, nextName, noRoomForLayer } from '../src/apps/photoedit/layers.ts';
import { buildOra, openOra, OraProblem, readStack, thumbSize, writeStack, type OraStack } from '../src/apps/photoedit/ora.ts';
import { zipStore } from '../src/core/zip.ts';

/** A plain RGBA picture that undo can read and write, as a canvas would. */
function surface(w: number, h: number): Surface & { data: Uint8ClampedArray; reads: number } {
  const data = new Uint8ClampedArray(w * h * 4);
  const s = {
    width: w, height: h, data, reads: 0,
    read(x: number, y: number, rw: number, rh: number) {
      s.reads++;
      const out = new Uint8ClampedArray(rw * rh * 4);
      for (let r = 0; r < rh; r++) out.set(data.subarray(((y + r) * w + x) * 4, ((y + r) * w + x + rw) * 4), r * rw * 4);
      return out;
    },
    write(x: number, y: number, rw: number, rh: number, src: Uint8ClampedArray) {
      for (let r = 0; r < rh; r++) data.set(src.subarray(r * rw * 4, (r + 1) * rw * 4), ((y + r) * w + x) * 4);
    },
  };
  return s;
}
const paint = (s: ReturnType<typeof surface>, x: number, y: number, v: number) => s.data.fill(v, (y * s.width + x) * 4, (y * s.width + x) * 4 + 4);

test('a patch keeps only the tiles touched, and swapping twice goes back and forth', () => {
  const s = surface(300, 200);
  paint(s, 5, 5, 9);
  const patch = new PixelPatch(s);
  patch.touch({ x: 0, y: 0, w: 10, h: 10 });
  patch.touch({ x: 2, y: 2, w: 3, h: 3 }); // same tile: not read again
  assert.equal(s.reads, 1);
  assert.equal(patch.tiles.size, 1);
  assert.equal(patch.bytes, TILE * TILE * 4);
  paint(s, 5, 5, 200);
  patch.swap();
  assert.equal(s.data[(5 * 300 + 5) * 4], 9, 'undo put the old pixel back');
  patch.swap();
  assert.equal(s.data[(5 * 300 + 5) * 4], 200, 'redo put the new one back');
  // Edge tiles are cut to the picture: 300 = 4 tiles of 64 and one of 44; 200 = 3 of 64 and one of 8.
  const edge = new PixelPatch(s);
  edge.touch({ x: 290, y: 190, w: 50, h: 50 });
  assert.equal(edge.tiles.size, 2);
  assert.equal(edge.bytes, 44 * (64 + 8) * 4);
  assert.deepEqual(edge.bounds(), { x: 256, y: 128, w: 44, h: 72 });
});

test('50 brush strokes on a 6000 × 4000 picture stay far under the history cap', () => {
  const s = surface(6000, 4000);
  const cap = 256 * 1024 * 1024;
  const history = new History(cap);
  for (let i = 0; i < 50; i++) {
    const patch = new PixelPatch(s);
    // A diagonal stroke 30 pixels wide right across the picture, dab by dab.
    for (let t = 0; t <= 1; t += 0.01) patch.touch({ x: 6000 * t - 15, y: 4000 * t - 15 + i * 10, w: 30, h: 30 });
    history.push({ label: 'Brush', bytes: patch.bytes, undo: () => patch.swap(), redo: () => patch.swap() });
  }
  assert.equal(history.undoList.length, 50, 'every stroke kept');
  // A whole copy each time would be 50 × 96 MB = 4.8 GB; tiles along each stroke are about 2.5 MB.
  assert.ok(history.bytes < cap * 0.6, `history holds ${Math.round(history.bytes / 1e6)} MB`);
  assert.ok(history.bytes < 50 * 6000 * 4000 * 4 * 0.03, 'under 3% of whole copies');
});

test('history drops the oldest steps over the cap but always keeps the newest', () => {
  const h = new History(100);
  const log: string[] = [];
  const step = (n: string, bytes: number) => ({ label: n, bytes, undo: () => log.push('undo ' + n), redo: () => log.push('redo ' + n) });
  h.push(step('a', 40));
  h.push(step('b', 40));
  h.push(step('c', 40));
  assert.deepEqual(h.undoList.map(s => s.label), ['b', 'c']);
  h.push(step('huge', 500));
  assert.deepEqual(h.undoList.map(s => s.label), ['huge']);
  h.undo();
  h.redo();
  assert.deepEqual(log, ['undo huge', 'redo huge']);
  h.undo();
  h.push(step('d', 1));
  assert.equal(h.redoList.length, 0, 'a new step clears redo');
  const g = group('both', [step('x', 1), step('y', 1)]);
  log.length = 0;
  g.undo();
  g.redo();
  assert.deepEqual(log, ['undo y', 'undo x', 'redo x', 'redo y']);
  assert.deepEqual(clipRect({ x: -5, y: 2.5, w: 10, h: 3 }, 4, 4), { x: 0, y: 2, w: 4, h: 2 });
  assert.equal(clipRect({ x: 9, y: 0, w: 2, h: 2 }, 4, 4), null);
});

test('layer room: the budget refuses one layer too many with a plain reason', () => {
  assert.equal(noRoomForLayer(1000, 1000, 1), null);
  const most = layerLimit(4000, 3000);
  assert.equal(most, Math.floor(LAYER_BUDGET / 12e6));
  assert.equal(noRoomForLayer(4000, 3000, most - 1), null);
  const why = noRoomForLayer(4000, 3000, most);
  assert.match(String(why), new RegExp(`has ${most} layers at 4,000 × 3,000.*Merge or delete a layer`));
  assert.match(String(noRoomForLayer(10, 10, 100)), /100 layers, the most/);
});

test('layer names, copies and order', () => {
  assert.equal(nextName(['Background']), 'Layer 2');
  assert.equal(nextName(['Background', 'Layer 2']), 'Layer 3');
  assert.equal(nextName(['Layer 3', 'Background']), 'Layer 4');
  assert.equal(copyName(['Sky'], 'Sky'), 'Sky copy');
  assert.equal(copyName(['Sky', 'Sky copy'], 'Sky'), 'Sky copy 2');
  assert.deepEqual(moveItem(['a', 'b', 'c', 'd'], 0, 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b']);
  assert.deepEqual(moveItem(['a', 'b'], 1, 9), ['a', 'b']);
});

test('every blend mode has a canvas name and an OpenRaster name, and reads back', () => {
  assert.equal(BLEND_MODES.length, 16);
  for (const b of BLEND_MODES) {
    assert.match(b.ora, /^svg:/);
    assert.equal(blendFromOra(b.ora), b.id);
  }
  assert.equal(blendFromOra(undefined), 'normal');
  assert.equal(blendFromOra('svg:plus'), null);
});

const STACK: OraStack = {
  width: 640, height: 480,
  layers: [
    { name: 'Words & <stuff>', src: 'data/layer2.png', x: 0, y: 0, opacity: 0.5, visible: true, locked: false, mode: 'multiply',
      text: { text: 'Hello\nthere "you"', family: 'Serif', size: 40, colour: '#112233', bold: true, italic: false, align: 'center', x: 100, y: 50 } },
    { name: 'Hidden', src: 'data/layer1.png', x: 0, y: 0, opacity: 1, visible: false, locked: true, mode: 'screen' },
    { name: 'Background', src: 'data/layer0.png', x: 0, y: 0, opacity: 1, visible: true, locked: false, mode: 'normal' },
  ],
};

test('stack.xml written and read back keeps names, order, opacity, visibility, modes, locks and text', () => {
  const xml = writeStack(STACK);
  assert.match(xml, /^<\?xml/);
  assert.match(xml, /<image version="0\.0\.5" w="640" h="480"/);
  assert.match(xml, /composite-op="svg:multiply"/);
  assert.match(xml, /name="Words &amp; &lt;stuff&gt;"/);
  const back = readStack(xml);
  assert.deepEqual(back.notes, []);
  assert.deepEqual(back.stack, STACK);
});

test('stack.xml from elsewhere: groups opened out with offsets, unknown modes read as Normal and said, damage refused', () => {
  const xml = `<?xml version="1.0"?><image w="100" h="50"><stack>
    <stack name="Group" x="10" y="5" visibility="hidden"><layer src="data/a.png" x="1" y="2" composite-op="svg:plus"/></stack>
    <layer src="data/b.png" name="B" opacity="2"/></stack></image>`;
  const r = readStack(xml);
  assert.equal(r.stack.layers.length, 2);
  assert.deepEqual([r.stack.layers[0].x, r.stack.layers[0].y, r.stack.layers[0].visible, r.stack.layers[0].mode], [11, 7, false, 'normal']);
  assert.equal(r.stack.layers[1].opacity, 1, 'opacity is capped at 1');
  assert.equal(r.notes.length, 2);
  assert.throws(() => readStack('<image w="0" h="5"><stack/></image>'), OraProblem);
  assert.throws(() => readStack('<image w="5" h="5"><stack></stack></image>'), /no layers/);
  assert.throws(() => readStack('<!DOCTYPE x [<!ENTITY a "b">]><image/>'), OraProblem);
  const many = `<image w="5" h="5"><stack>${'<layer src="x.png"/>'.repeat(101)}</stack></image>`;
  assert.throws(() => readStack(many), /more than 100 layers/);
});

/** A tiny real PNG header claiming w × h (enough for the size check; never decoded here). */
function pngHead(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}

test('an .ora file: mimetype first and unpacked at byte 30, then opened back with every layer', async () => {
  const pngs = STACK.layers.map(() => pngHead(640, 480));
  const ora = buildOra({ stack: STACK, layerPngs: pngs, merged: pngHead(640, 480), thumbnail: pngHead(256, 192) });
  const head = new TextDecoder().decode(ora.subarray(30, 38 + 16));
  assert.equal(head, 'mimetypeimage/openraster', 'readers find the type at a fixed place');
  assert.equal(new DataView(ora.buffer).getUint16(8, true), 0, 'stored, not packed');
  const opened = await openOra(ora);
  assert.deepEqual(opened.stack, STACK);
  for (const l of opened.stack.layers) assert.equal((await opened.layerPng(l)).length, 33);
  assert.deepEqual(thumbSize(640, 480), [256, 192]);
  assert.deepEqual(thumbSize(100, 50), [100, 50]);
});

test('an .ora from outside is checked before decoding: missing parts, huge layers, too many pixels, wrong type', async () => {
  const enc = new TextEncoder();
  const make = (stack: string, files: Record<string, Uint8Array> = {}, mime = 'image/openraster') => zipStore([
    { name: 'mimetype', data: enc.encode(mime), modified: 0 },
    { name: 'stack.xml', data: enc.encode(stack), modified: 0 },
    ...Object.entries(files).map(([name, data]) => ({ name, data, modified: 0 })),
  ]);
  const one = '<image w="100" h="100"><stack><layer src="data/a.png"/></stack></image>';
  const missing = await openOra(make(one));
  await assert.rejects(missing.layerPng(missing.stack.layers[0]), /missing/);
  const bomb = await openOra(make(one, { 'data/a.png': pngHead(60000, 60000) }));
  await assert.rejects(bomb.layerPng(bomb.stack.layers[0]), /far more than the picture/);
  // 8000 × 8000 is within the "far bigger than the picture" margin but over the 50 million pixel cap.
  const big = await openOra(make('<image w="4000" h="4000"><stack><layer src="data/a.png"/></stack></image>', { 'data/a.png': pngHead(8000, 8000) }));
  await assert.rejects(big.layerPng(big.stack.layers[0]), /8,000 × 8,000/);
  const notPng = await openOra(make(one, { 'data/a.png': enc.encode('hello') }));
  await assert.rejects(notPng.layerPng(notPng.stack.layers[0]), /not a PNG/);
  await assert.rejects(openOra(make('<image w="20000" h="20000"><stack><layer src="a.png"/></stack></image>')), /more than Photo Editor opens \(50 million pixels/);
  const heavy = `<image w="5000" h="5000"><stack>${'<layer src="a.png"/>'.repeat(7)}</stack></image>`;
  await assert.rejects(openOra(make(heavy)), /more than this browser can hold safely/);
  await assert.rejects(openOra(make(one, {}, 'image/png')), /not an OpenRaster/);
  await assert.rejects(openOra(enc.encode('not a zip at all')), OraProblem);
});
