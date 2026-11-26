// Photo Editor's text outline and Meme, without a browser: the outline width, words wrapped and fitted to a box, the
// bars' sizes and places, the boxes' squares, and both kept in an .ora's stack.xml (old files without them still read).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoOutline, fitSize, layoutText, outlineWidth, sizedText, wrapWords } from '../src/apps/photoedit/text.ts';
import { readStack, writeStack, type OraStack, type TextSpec } from '../src/apps/photoedit/ora.ts';
import { barHeights, barRects, boxHandleAt, dockRect, dragBoxRect, newBox, placeBox, readBars } from '../src/apps/photoedit/meme.ts';

/** Every letter 10 px wide at size 100 (so 1 px each at size 10). */
const m100 = (s: string) => s.length * 10;
const base: TextSpec = { text: 'HI', family: 'Arial Black', size: 120, colour: '#ffffff', bold: true, italic: false, align: 'left', x: 10, y: 20 };

test('outline width: a twelfth of the size when left to itself (1 to 20), or as chosen', () => {
  assert.equal(outlineWidth(base), 0);
  assert.equal(autoOutline(120), 10);
  assert.equal(autoOutline(6), 1);
  assert.equal(autoOutline(1000), 20);
  assert.equal(outlineWidth({ ...base, outline: { colour: '#000000', width: 0 } }), 10);
  assert.equal(outlineWidth({ ...base, outline: { colour: '#000000', width: 6 } }), 6);
  assert.equal(outlineWidth({ ...base, outline: { colour: '#000000', width: 99 } }), 20);
});

test('words wrap at the room given; a line broken by hand stays broken; a long word keeps a line of its own', () => {
  const m = (s: string) => s.length;
  assert.deepEqual(wrapWords('one two three four', 9, m), ['one two', 'three', 'four']);
  assert.deepEqual(wrapWords('a\nb c', 10, m), ['a', 'b c']);
  assert.deepEqual(wrapWords('tremendously big', 5, m), ['tremendously', 'big']);
  assert.deepEqual(wrapWords('', 5, m), ['']);
});

test('a box fits its words: the largest size whose wrapped lines fit its width and height', () => {
  // Each letter is a tenth of the size wide: ten letters in a box 50 wide fit size 50 (one line 63 high fits).
  const box: TextSpec = { ...base, text: 'ABCDEFGHIJ', box: { w: 50, h: 100, fit: true } };
  assert.equal(fitSize(box, m100), 50);
  // Limited by the height: one line of round(1.25 s) <= 30 gives 24.
  const short = { ...box, text: 'AB', box: { w: 400, h: 30, fit: true } };
  assert.equal(fitSize(short, m100), 24);
  // Two words go onto two lines when that lets them be bigger (one line: 54; two lines: 80).
  const two = { ...box, text: 'ABCDE ABCDE', box: { w: 60, h: 200, fit: true } };
  assert.equal(fitSize(two, m100), 80);
  // The outline takes room too (10 each side leaves 30 across).
  const outlined = { ...box, outline: { colour: '#000000', width: 10 } };
  assert.equal(fitSize(outlined, m100), 30);
  // Empty: as big as the box allows (nothing is drawn).
  assert.equal(fitSize({ ...box, text: '' }, m100), 80);
  // Not fitting: the size chosen stays.
  assert.equal(sizedText({ ...box, box: { w: 200, h: 100, fit: false } }, m100).size, 120);
});

test('text in a box is centred across and down the box; plain text is unchanged', () => {
  const t: TextSpec = { ...base, text: 'AB CD', size: 20, align: 'center', x: 100, y: 50, box: { w: 30, h: 100, fit: false } };
  const r = layoutText(t, s => s.length * 10);
  assert.deepEqual(r.lines.map(l => l.text), ['AB', 'CD']);
  assert.deepEqual(r.lines.map(l => l.x), [105, 105]);
  // Two lines of 25 in a 100 high box: they start 25 down.
  assert.deepEqual(r.lines.map(l => l.y), [75, 100]);
  assert.deepEqual(r.bounds, { x: 100, y: 50, w: 30, h: 100 });
  const plain = layoutText({ ...base, text: 'ab', size: 20 }, s => s.length * 10);
  assert.deepEqual(plain.lines.map(l => [l.x, l.y]), [[10, 20]]);
});

test('stack.xml keeps the outline and the box; old text without them reads as before; odd values are dropped', () => {
  const text: TextSpec = { ...base, outline: { colour: '#000000', width: 0 }, box: { w: 300, h: 80, fit: true, dock: 'top', auto: true } };
  const stack: OraStack = { width: 400, height: 300, layers: [{ name: 'Top text', src: 'data/layer1.png', x: 0, y: 0, opacity: 1, visible: true, locked: false, mode: 'normal', text }] };
  assert.deepEqual(readStack(writeStack(stack)).stack, stack);
  const old = writeStack({ ...stack, layers: [{ ...stack.layers[0], text: { ...base } }] });
  assert.deepEqual(readStack(old).stack.layers[0].text, base);
  const odd = writeStack({ ...stack, layers: [{ ...stack.layers[0], text: { ...base, outline: { colour: 'red', width: 3 }, box: { w: -1, h: 5, fit: true } } as TextSpec }] });
  assert.deepEqual(readStack(odd).stack.layers[0].text, base);
});

test('bars: a share of the picture height, at the top, the bottom or both; settings kept are checked', () => {
  assert.deepEqual(barHeights(300, { where: 'both', colour: '#ffffff', percent: 18, extend: true }), { top: 54, bottom: 54 });
  assert.deepEqual(barHeights(300, { where: 'top', colour: '#ffffff', percent: 18, extend: true }), { top: 54, bottom: 0 });
  assert.deepEqual(barHeights(300, { where: 'none', colour: '#ffffff', percent: 18, extend: true }), { top: 0, bottom: 0 });
  assert.deepEqual(barRects(400, 408, { top: 54, bottom: 54 }), [{ x: 0, y: 0, w: 400, h: 54 }, { x: 0, y: 354, w: 400, h: 54 }]);
  assert.deepEqual(readBars({ where: 'sideways', colour: 'blue', percent: 500, extend: 'yes' }), { where: 'none', colour: '#ffffff', percent: 100, extend: true });
  assert.deepEqual(readBars(null), { where: 'none', colour: '#ffffff', percent: 18, extend: true });
});

test('boxes kept at an edge go inside its bar, or across that edge of the picture; colours follow while automatic', () => {
  const inBar = dockRect('top', 400, 408, { top: 54, bottom: 54 });
  assert.ok(inBar.y >= 0 && inBar.y + inBar.h <= 54 && inBar.w < 400, JSON.stringify(inBar));
  const low = dockRect('bottom', 400, 408, { top: 54, bottom: 54 });
  assert.ok(low.y >= 354 && low.y + low.h <= 408, JSON.stringify(low));
  const onPic = dockRect('bottom', 400, 300, { top: 0, bottom: 0 });
  assert.ok(onPic.y > 200 && onPic.y + onPic.h < 300, JSON.stringify(onPic));
  const b = newBox(inBar, 'top', true);
  assert.equal(b.colour, '#000000');
  assert.equal(b.outline, undefined);
  const moved = placeBox(b, onPic, true, false);
  assert.equal(moved.colour, '#ffffff');
  assert.deepEqual(moved.outline, { colour: '#000000', width: 0 });
  assert.equal(moved.box?.dock, 'top');
  // Chosen by hand: the colours stay; dragged: no longer kept at the edge.
  const own = placeBox({ ...b, colour: '#ff0000', box: { ...b.box!, auto: false } }, onPic, false, false);
  assert.equal(own.colour, '#ff0000');
  assert.equal(own.box?.dock, undefined);
});

test('a box\'s squares: corners and edges stretch it, inside moves it, never smaller than the least size', () => {
  const r = { x: 100, y: 100, w: 200, h: 80 };
  assert.equal(boxHandleAt(r, { x: 101, y: 99 }, 5), 'nw');
  assert.equal(boxHandleAt(r, { x: 300, y: 180 }, 5), 'se');
  assert.equal(boxHandleAt(r, { x: 200, y: 100 }, 5), 'n');
  assert.equal(boxHandleAt(r, { x: 150, y: 150 }, 5), 'move');
  assert.equal(boxHandleAt(r, { x: 50, y: 50 }, 5), null);
  assert.deepEqual(dragBoxRect(r, 'move', 10, -5), { x: 110, y: 95, w: 200, h: 80 });
  assert.deepEqual(dragBoxRect(r, 'se', 30, 20), { x: 100, y: 100, w: 230, h: 100 });
  assert.deepEqual(dragBoxRect(r, 'nw', 30, 20), { x: 130, y: 120, w: 170, h: 60 });
  assert.deepEqual(dragBoxRect(r, 'w', 500, 0), { x: 284, y: 100, w: 16, h: 80 });
});
