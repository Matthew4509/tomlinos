// The named toolbars' layout (shell/toolbars.ts): the usual places, a saved layout checked (broken ones give the usual),
// moves by dragging and by the arrow keys, and the side toolbars that go up to the top in a narrow window.
// Run: node --test test/toolbars.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultLayout, fallbackIds, keyMove, MIN_WORK_WIDTH, moveBar, readLayout, type ToolbarPlace, type ToolbarSpec } from '../src/shell/toolbars.ts';

const specs: ToolbarSpec[] = [
  { id: 'standard', name: 'Standard', tools: [] },
  { id: 'draw', name: 'Draw', tools: [] },
  { id: 'modify', name: 'Modify', tools: [] },
  { id: 'view', name: 'View', side: 'left', tools: [] },
  { id: 'snaps', name: 'Snaps', side: 'right', tools: [] },
  { id: 'extra', name: 'Extra', hidden: true, tools: [] },
];
const where = (l: ToolbarPlace[]) => l.map(p => `${p.id}:${p.side}${p.shown ? '' : '(hidden)'}`).join(' ');

test('the usual layout follows the toolbars as described', () => {
  assert.equal(where(defaultLayout(specs)), 'standard:top draw:top modify:top view:left snaps:right extra:top(hidden)');
});

test('a saved layout is kept; anything broken gives the usual layout, without an error', () => {
  const saved = { v: 1, bars: [{ id: 'snaps', side: 'top', shown: true }, { id: 'standard', side: 'left', shown: false }, { id: 'draw', side: 'right', shown: true }, { id: 'modify', side: 'top', shown: true }, { id: 'view', side: 'top', shown: true }, { id: 'extra', side: 'top', shown: false }] };
  assert.equal(where(readLayout(saved, specs)), 'snaps:top standard:left(hidden) draw:right modify:top view:top extra:top(hidden)');
  const usual = where(defaultLayout(specs));
  for (const bad of [null, undefined, 'nonsense', 42, [], {}, { bars: 'x' }, { bars: [] }, { bars: [null, 7, 'a'] }, { bars: [{ id: 'nope', side: 'top', shown: true }] }, { bars: [{ id: 'draw', side: 'upside-down', shown: true }] }, { bars: [{ id: 'draw', side: 'left', shown: 'yes' }] }]) {
    assert.equal(where(readLayout(bad, specs)), usual, JSON.stringify(bad));
  }
});

test('a saved layout missing a toolbar (or naming one twice) still has each toolbar once, the missing ones in their usual place', () => {
  const saved = { bars: [{ id: 'draw', side: 'left', shown: true }, { id: 'draw', side: 'right', shown: true }, { id: 'standard', side: 'top', shown: true }] };
  const l = readLayout(saved, specs);
  assert.deepEqual(l.map(p => p.id).sort(), specs.map(s => s.id).sort());
  assert.equal(l.find(p => p.id === 'draw')!.side, 'left');
  assert.equal(l.find(p => p.id === 'snaps')!.side, 'right');
  assert.equal(l.find(p => p.id === 'extra')!.shown, false);
});

test('dragging: before another toolbar, or after the last one on that side', () => {
  const l = defaultLayout(specs);
  assert.equal(where(moveBar(l, 'modify', 'top', 'standard')), 'modify:top standard:top draw:top view:left snaps:right extra:top(hidden)');
  assert.equal(where(moveBar(l, 'draw', 'left', null)), 'standard:top modify:top view:left draw:left snaps:right extra:top(hidden)');
  assert.equal(where(moveBar(l, 'draw', 'right', 'snaps')), 'standard:top modify:top view:left draw:right snaps:right extra:top(hidden)');
  assert.equal(where(moveBar(l, 'view', 'top', null)), 'standard:top draw:top modify:top snaps:right extra:top(hidden) view:top');
  assert.equal(moveBar(l, 'nope', 'top', null), l, 'an unknown toolbar changes nothing');
});

test('arrow keys on the grip: Up and Down between rows, Left and Right dock it, Up from a side to the top', () => {
  const l = defaultLayout(specs);
  assert.equal(keyMove(l, 'standard', 'ArrowUp'), null, 'the first row cannot go up');
  assert.equal(where(keyMove(l, 'draw', 'ArrowUp')!), 'draw:top standard:top modify:top view:left snaps:right extra:top(hidden)');
  assert.equal(where(keyMove(l, 'standard', 'ArrowDown')!), 'draw:top standard:top modify:top view:left snaps:right extra:top(hidden)');
  assert.equal(keyMove(l, 'modify', 'ArrowDown'), null, 'the last shown row cannot go down');
  // Left: next to the work area (after View); Right: next to the work area (before Snaps).
  assert.equal(where(keyMove(l, 'draw', 'ArrowLeft')!), 'standard:top modify:top view:left draw:left snaps:right extra:top(hidden)');
  assert.equal(where(keyMove(l, 'draw', 'ArrowRight')!), 'standard:top modify:top view:left draw:right snaps:right extra:top(hidden)');
  // Left again: one column further out.
  const twoLeft = keyMove(l, 'draw', 'ArrowLeft')!;
  assert.equal(where(keyMove(twoLeft, 'draw', 'ArrowLeft')!), 'standard:top modify:top draw:left view:left snaps:right extra:top(hidden)');
  assert.equal(keyMove(keyMove(twoLeft, 'draw', 'ArrowLeft')!, 'draw', 'ArrowLeft'), null, 'the outermost column stays');
  assert.equal(where(keyMove(l, 'view', 'ArrowUp')!), 'standard:top draw:top modify:top snaps:right extra:top(hidden) view:top');
  assert.equal(keyMove(l, 'view', 'ArrowDown'), null);
  assert.equal(where(keyMove(l, 'snaps', 'ArrowLeft')!), 'standard:top draw:top modify:top view:left snaps:left extra:top(hidden)');
});

test('a narrow window: side toolbars go up to the top, the last placed first, until the work area is wide enough', () => {
  const l = moveBar(defaultLayout(specs), 'draw', 'left', null);
  const w = () => 34;
  assert.deepEqual([...fallbackIds(l, w, 1100)], []);
  assert.deepEqual([...fallbackIds(l, w, MIN_WORK_WIDTH + 3 * 34)], []);
  assert.deepEqual([...fallbackIds(l, w, MIN_WORK_WIDTH + 3 * 34 - 1)], ['snaps']);
  assert.deepEqual([...fallbackIds(l, w, MIN_WORK_WIDTH + 34)].sort(), ['draw', 'snaps']);
  assert.deepEqual([...fallbackIds(l, w, 300)].sort(), ['draw', 'snaps', 'view']);
  // A hidden side toolbar takes no room.
  const hidden = l.map(p => (p.id === 'snaps' ? { ...p, shown: false } : p));
  assert.deepEqual([...fallbackIds(hidden, w, MIN_WORK_WIDTH + 2 * 34)], []);
});
