// Photo Editor: faults found in an audit, each checked so it cannot come back. No browser.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeAttr, parseXml, tag } from '../src/core/xml.ts';
import { zipStore } from '../src/core/zip.ts';
import { readZip } from '../src/apps/archive/read.ts';
import { openOra, readStack, writeStack } from '../src/apps/photoedit/ora.ts';
import { convolve3, BLUR, floodFill, mixPixel, type Pixels } from '../src/apps/photoedit/pixels.ts';
import { boxWidths, ellipseMask, feather, flipMaskIn, rectMask, selectedOnly } from '../src/apps/photoedit/selection.ts';
import { blurSharpenDab, cloneDab, dodgeBurnDab, healDab, makeStroke, smudgeDab, makeCarry } from '../src/apps/photoedit/retouch.ts';
import { History } from '../src/apps/photoedit/history.ts';

function solid(w: number, h: number, rgba: number[]): Pixels {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(rgba, i * 4);
  return { width: w, height: h, data };
}
const px = (p: Pixels, x: number, y: number) => [...p.data.subarray((y * p.width + x) * 4, (y * p.width + x) * 4 + 4)];
const enc = new TextEncoder();

// ---- Files ----

test('a long hostile tag is read in a straight line, not in minutes (an .ora or .xlsx could freeze the tab)', () => {
  const time = (n: number) => {
    const s = '<a><c r="A1" ' + 'a'.repeat(n) + '/></a>';
    const t = performance.now();
    parseXml(s);
    return performance.now() - t;
  };
  time(1000);
  // The old pattern took about 600 ms at 20,000 characters and 30 s at 80,000 (four times per doubling).
  assert.ok(time(200_000) < 250, 'a 200,000-character tag reads fast');
  // Attributes still read as before: quotes of both kinds, prefixes, odd spacing, junk words, values without quotes.
  const el = parseXml(`<x a="1" b = '2' r:id="r3" junk c=4 d="5"e="6" f="a&amp;b"/>`);
  assert.deepEqual(el.attrs, { a: '1', b: '2', 'r:id': 'r3', id: 'r3', d: '5', e: '6', f: 'a&b' });
});

test('tabs and line breaks in an attribute are written as numbers, so other programs read them back', () => {
  assert.equal(escapeAttr('a\tb\nc\r"&<'), 'a&#9;b&#10;c&#13;&quot;&amp;&lt;');
  assert.equal(tag('x', { n: 'two\nlines' }), '<x n="two&#10;lines"/>');
  const back = readStack(writeStack({ width: 4, height: 4, layers: [{ name: 'Line 1\nLine 2', src: 'data/a.png', x: 0, y: 0, opacity: 1, visible: true, locked: false, mode: 'normal' }] }));
  assert.equal(back.stack.layers[0].name, 'Line 1\nLine 2');
});

test('a stored zip entry whose listed size is false is refused (size caps cannot be dodged)', async () => {
  const zip = zipStore([{ name: 'big.xml', data: enc.encode('x'.repeat(3000)), modified: 0 }]);
  // Make the central directory claim 100 bytes.
  const v = new DataView(zip.buffer);
  for (let i = zip.length - 22; i >= 0; i--) {
    if (v.getUint32(i, true) === 0x02014b50) {
      v.setUint32(i + 24, 100, true);
      break;
    }
  }
  const [e] = readZip(zip);
  assert.equal(e.size, 100);
  await assert.rejects(e.read(), /not the size the \.zip says/);
});

test('an .ora from another program: layer names written "./data/a.png" or with : ? are found', async () => {
  const png = new Uint8Array(33);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(png.buffer).setUint32(16, 4);
  new DataView(png.buffer).setUint32(20, 4);
  const zip = zipStore([
    { name: 'mimetype', data: enc.encode('image/openraster'), modified: 0 },
    { name: 'stack.xml', data: enc.encode('<image w="4" h="4"><stack><layer src="./data/a.png"/><layer src="data/sky?.png"/></stack></image>'), modified: 0 },
    { name: 'data/a.png', data: png, modified: 0 },
    { name: 'data/sky?.png', data: png, modified: 0 },
  ]);
  const ora = await openOra(zip);
  for (const l of ora.stack.layers) assert.equal((await ora.layerPng(l)).length, 33);
  // A very long side is refused even under the pixel cap (some browsers cannot draw it).
  const long = zipStore([
    { name: 'mimetype', data: enc.encode('image/openraster'), modified: 0 },
    { name: 'stack.xml', data: enc.encode('<image w="40000" h="1000"><stack><layer src="a.png"/></stack></image>'), modified: 0 },
  ]);
  await assert.rejects(openOra(long), /20,000 on a side/);
});

// ---- Pixels ----

test('blur does not darken the edge of a shape on a see-through layer, and the edge fades', () => {
  const p = solid(5, 1, [0, 0, 0, 0]);
  p.data.set([255, 0, 0, 255], 0);
  p.data.set([255, 0, 0, 255], 4);
  convolve3(p, BLUR);
  const edge = px(p, 1, 0);
  assert.equal(edge[0], 255, `still pure red, not dark (${edge})`);
  assert.ok(edge[3] < 255 && edge[3] > 0, 'the edge is softened');
  assert.equal(px(p, 2, 0)[0], 255, 'the fade outside is red too');
});

test('mixing onto see-through keeps the colour; fill finds near matches even on its own colour', () => {
  const d = new Uint8ClampedArray([0, 0, 0, 0]);
  mixPixel(d, 0, 255, 0, 0, 255, 0.5);
  assert.deepEqual([...d], [255, 0, 0, 128]);
  // A red patch with a slightly different red edge: filling red still reaches the edge.
  const p = solid(3, 1, [255, 0, 0, 255]);
  p.data.set([250, 5, 5, 255], 8);
  assert.equal(floodFill(p, 0, 0, [255, 0, 0, 255], 32), 1);
  assert.deepEqual(px(p, 2, 0), [255, 0, 0, 255]);
});

// ---- Selections ----

test('soft edge sizes 1, 2, 3 and 4 all differ; a long thin ellipse has a one-pixel rim at its ends', () => {
  const m = rectMask(40, 40, { x: 10, y: 10, w: 20, h: 20 });
  const sums = [1, 2, 3, 4].map(r => feather(m, 40, 40, r).reduce((n, v, i) => n + Math.abs(v - m[i]), 0));
  assert.equal(new Set(sums).size, 4, `different results: ${sums}`);
  assert.deepEqual(boxWidths(2.4), [5, 5, 5], 'radius 6 is as before');
  const e = ellipseMask(200, 4, { x: 0, y: 0, w: 200, h: 4 });
  let part = 0;
  for (let x = 0; x < 200; x++) if (e[2 * 200 + x] > 0 && e[2 * 200 + x] < 255) part++;
  // Was 58 of 200 (a fade about 30 pixels long at each end); the true edge crosses the middle row at a shallow angle
  // near the tips, so a few pixels there are honestly part-covered.
  assert.ok(part <= 24, `only the ends are part-selected on the middle row (${part})`);
});

test('flip within a selection mirrors only the selected box; histograms count only the selected pixels', () => {
  const m = new Uint8Array(4 * 1);
  m.set([255, 128, 0, 0]);
  assert.deepEqual([...flipMaskIn(m, 4, { x: 0, y: 0, w: 2, h: 1 }, true)], [128, 255, 0, 0]);
  const p = solid(3, 1, [10, 10, 10, 255]);
  p.data.set([200, 200, 200, 255], 4);
  const sel = new Uint8Array([0, 255, 0]);
  const only = selectedOnly(p, sel, { x: 0, y: 0, w: 3, h: 1 }, 3);
  assert.equal(only.width, 1);
  assert.equal(only.data[0], 200);
});

// ---- Retouching ----

test('heal takes its colour from around the spot, not from the spot it covers', () => {
  // Skin of 200 with a dark spot of 20 (8 × 8, all under the brush); the source is clean skin of 200.
  const dst = solid(40, 20, [200, 200, 200, 255]);
  for (let y = 6; y < 14; y++) for (let x = 16; x < 24; x++) dst.data.set([20, 20, 20, 255], (y * 40 + x) * 4);
  const src = { ...solid(40, 20, [200, 200, 200, 255]) };
  healDab(dst, src, 0, 0, { x: 20, y: 10, radius: 6, hardness: 1, strength: 1 }, null);
  assert.ok(Math.abs(px(dst, 20, 10)[0] - 200) <= 3, `healed to the skin (${px(dst, 20, 10)[0]})`);
});

test('a stroke never goes past its strength however many dabs overlap; dodge leaves black, burn leaves white', () => {
  const p = solid(10, 1, [0, 0, 0, 255]);
  const source = solid(10, 1, [255, 255, 255, 255]);
  const stroke = makeStroke(p);
  for (let k = 0; k < 20; k++) cloneDab(p, source, 0, 0, { x: 5, y: 0.5, radius: 3, hardness: 1, strength: 0.2 }, null, stroke);
  assert.ok(Math.abs(px(p, 5, 0)[0] - 51) <= 1, `20% of white, not more (${px(p, 5, 0)[0]})`);
  const d = solid(3, 1, [0, 0, 0, 255]);
  d.data.set([255, 255, 255, 255], 8);
  d.data.set([100, 100, 100, 255], 4);
  const ds = makeStroke(d);
  for (let k = 0; k < 10; k++) dodgeBurnDab(d, { x: 1.5, y: 0.5, radius: 5, hardness: 1, strength: 0.5 }, 'dodge', null, ds);
  assert.equal(px(d, 0, 0)[0], 0, 'black stays black');
  const once = Math.round(255 * Math.pow(100 / 255, 1 / 1.5));
  assert.ok(Math.abs(px(d, 1, 0)[0] - once) <= 1, `ten dabs = one dab (${px(d, 1, 0)[0]} vs ${once})`);
  const b = solid(1, 1, [255, 255, 255, 255]);
  dodgeBurnDab(b, { x: 0.5, y: 0.5, radius: 2, hardness: 1, strength: 1 }, 'burn', null);
  assert.equal(px(b, 0, 0)[0], 255, 'white stays white');
});

test('clone copies from the source pixel under the middle of each pixel; smudge onto see-through keeps colour', () => {
  const p = solid(30, 1, [0, 0, 0, 255]);
  const src = solid(30, 1, [0, 0, 0, 255]);
  src.data.set([255, 255, 255, 255], 11 * 4);
  // Source at 10.9, press at 20.1: pixel 20 (middle 20.5) copies from 10.5 + 0.8 = 11.3, which is pixel 11.
  cloneDab(p, src, 10.9 - 20.1, 0, { x: 20.5, y: 0.5, radius: 0.6, hardness: 1, strength: 1 }, null);
  assert.equal(px(p, 20, 0)[0], 255);
  const s = solid(6, 1, [0, 0, 0, 0]);
  s.data.set([255, 0, 0, 255], 0);
  const carry = makeCarry(s, 0, 0, 1);
  smudgeDab(s, carry, { x: 1.5, y: 0.5, radius: 1, hardness: 1, strength: 0.5 }, null);
  assert.equal(px(s, 1, 0)[0], 255, `smudged red stays red (${px(s, 1, 0)})`);
  const blurred = solid(3, 1, [0, 0, 0, 0]);
  blurred.data.set([0, 0, 255, 255], 4);
  blurSharpenDab(blurred, { x: 0.5, y: 0.5, radius: 1, hardness: 1, strength: 1 }, 'blur', null);
  assert.equal(px(blurred, 0, 0)[2], 255, 'blurred blue into see-through is blue, not dark');
});

// ---- Undo ----

test('several steps can be joined into one (a paste, a colour window that turned text into pixels)', () => {
  const h = new History(1e9);
  const log: string[] = [];
  const step = (n: string) => ({ label: n, bytes: 1, undo: () => log.push('-' + n), redo: () => log.push('+' + n) });
  h.push(step('before'));
  const mark = h.pushes;
  h.push(step('a'));
  h.push(step('b'));
  h.squash(mark, 'Paste');
  assert.equal(h.undoList.length, 2);
  assert.equal(h.undoList[1].label, 'Paste');
  h.undo();
  assert.deepEqual(log, ['-b', '-a']);
  h.squash(h.pushes, 'nothing');
  assert.equal(h.undoList.length, 1);
});
