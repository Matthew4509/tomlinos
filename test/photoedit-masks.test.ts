// Photo Editor's layer masks, the parts that need no browser: how a mask's grey becomes how much the layer shows,
// the .ora stack naming a masked layer's two extra parts (read back only when both are named), the parts written
// into a real .ora and read back with the same size checks as layers, and the memory limits counting masks.
// The painting itself is walked in Chrome (test/browser-photoedit.mjs). No browser needed. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskToAlpha } from '../src/apps/photoedit/doc.ts';
import { buildOra, openOra, readStack, writeStack, type OraStack } from '../src/apps/photoedit/ora.ts';
import { LAYER_BUDGET, noRoomForLayer } from '../src/apps/photoedit/layers.ts';

function pngHead(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}

test('a mask shows its layer by the grey’s brightness: white all, black none, mid-grey half; a rubbed-out part hides', () => {
  const px = new Uint8ClampedArray([
    255, 255, 255, 255,
    0, 0, 0, 255,
    128, 128, 128, 255,
    255, 255, 255, 0,
    255, 255, 255, 128,
    255, 0, 0, 255,
  ]);
  maskToAlpha(px);
  const alpha = [3, 7, 11, 15, 19, 23].map(i => px[i]);
  assert.equal(alpha[0], 255, 'white shows all');
  assert.equal(alpha[1], 0, 'black hides');
  assert.ok(Math.abs(alpha[2] - 128) <= 1, `mid-grey about half: ${alpha[2]}`);
  assert.equal(alpha[3], 0, 'rubbed out (see-through) hides');
  assert.ok(Math.abs(alpha[4] - 128) <= 1, `white at half alpha is half: ${alpha[4]}`);
  assert.ok(Math.abs(alpha[5] - 76) <= 1, `red counts by its brightness: ${alpha[5]}`);
});

const STACK: OraStack = {
  width: 64, height: 48,
  layers: [
    { name: 'Sky', src: 'data/layer1.png', x: 0, y: 0, opacity: 1, visible: true, locked: false, mode: 'normal', mask: { mask: 'data/layer1-mask.png', unmasked: 'data/layer1-unmasked.png' } },
    { name: 'Background', src: 'data/layer0.png', x: 0, y: 0, opacity: 1, visible: true, locked: false, mode: 'normal' },
  ],
};

test('the stack names a masked layer’s mask and unmasked pixels, and reads them back; one name alone is not a mask', () => {
  const xml = writeStack(STACK);
  assert.match(xml, /tomlinos:mask="data\/layer1-mask\.png"/);
  assert.match(xml, /tomlinos:unmasked="data\/layer1-unmasked\.png"/);
  assert.deepEqual(readStack(xml).stack, STACK);
  const half = readStack('<image w="10" h="10" xmlns:tomlinos="urn:tomlinos:openraster:1"><stack><layer src="a.png" tomlinos:mask="m.png"/></stack></image>');
  assert.equal(half.stack.layers[0].mask, undefined);
});

test('a real .ora carries the mask parts; they are read back with the same size checks as a layer', async () => {
  const ora = buildOra({
    stack: STACK,
    layerPngs: [pngHead(64, 48), pngHead(64, 48)],
    merged: pngHead(64, 48),
    thumbnail: pngHead(64, 48),
    extra: [{ name: 'data/layer1-unmasked.png', data: pngHead(64, 48) }, { name: 'data/layer1-mask.png', data: pngHead(64, 48) }],
  });
  const opened = await openOra(ora);
  const sky = opened.stack.layers[0];
  assert.deepEqual(sky.mask, STACK.layers[0].mask);
  assert.equal((await opened.partPng(sky.mask!.mask, sky)).length, 33);
  assert.equal((await opened.partPng(sky.mask!.unmasked, sky)).length, 33);
  await assert.rejects(opened.partPng('data/nothing.png', sky), /is missing from the file/);
  const huge = buildOra({ stack: STACK, layerPngs: [pngHead(64, 48), pngHead(64, 48)], merged: pngHead(64, 48), thumbnail: pngHead(64, 48), extra: [{ name: 'data/layer1-mask.png', data: pngHead(90000, 90000) }] });
  await assert.rejects((await openOra(huge)).partPng('data/layer1-mask.png', sky), /far more than the picture/);
});

test('masks count against memory like layers, and the message says how many of each', () => {
  assert.match(String(noRoomForLayer(10, 10, 100, 3)), /^This picture has 97 layers and 3 masks, the most Photo Editor holds\. Merge or delete a layer, or apply or delete a mask/);
  const most = Math.floor(LAYER_BUDGET / (4000 * 3000));
  assert.equal(noRoomForLayer(4000, 3000, most - 1, 1), null);
  assert.match(String(noRoomForLayer(4000, 3000, most, 1)), new RegExp(`has ${most - 1} layers and 1 mask at 4,000 × 3,000`));
  assert.match(String(noRoomForLayer(10, 10, 100)), /100 layers, the most/, 'without masks it reads as before');
});

test('an .ora whose masks would not fit in memory is refused before any picture is decoded', async () => {
  const side = 4000;
  const most = Math.floor(LAYER_BUDGET / (side * side));
  const layers = Array.from({ length: Math.ceil(most / 2) + 1 }, (_, i) => ({ name: `L${i}`, src: `data/l${i}.png`, x: 0, y: 0, opacity: 1, visible: true, locked: false, mode: 'normal' as const, mask: { mask: `data/m${i}.png`, unmasked: `data/u${i}.png` } }));
  const stack: OraStack = { width: side, height: side, layers };
  const ora = buildOra({ stack, layerPngs: layers.map(() => pngHead(1, 1)), merged: pngHead(1, 1), thumbnail: pngHead(1, 1) });
  await assert.rejects(openOra(ora), /more than this browser can hold safely/);
});
