// The Calculator: key presses left to right, the sheet's live sums, loops refused, ÷0 named, saved files read safely.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Calculator, DIV_ZERO, emptySheet, evaluate, describe, parseSheet, show, sumProblem, type Op } from '../src/apps/calculator/model.ts';

function press(keys: string): Calculator {
  const c = new Calculator();
  for (const k of keys.split(' ')) {
    if (/^[\d.]+$/.test(k)) for (const d of k) c.digit(d);
    else if (k === '=') c.equals();
    else if (k === 'C') c.clear();
    else if (k === 'CE') c.clearEntry();
    else if (k === '<') c.back();
    else if (k === '±') c.negate();
    else c.operator(k as Op);
  }
  return c;
}

test('× and ÷ come before + and −', () => {
  assert.equal(press('2 + 3 × 4 =').display, '14');
  assert.equal(press('10 − 6 ÷ 2 + 1 =').display, '8');
  assert.equal(press('2 × 3 + 4 × 5 =').display, '26');
  assert.equal(press('10 ÷ 4 =').display, '2.5');
  assert.equal(press('0.1 + 0.2 =').display, '0.3');
  assert.equal(press('5 − 8 =').display, '-3');
  assert.equal(press('7 ± × 2 =').display, '-14');
  assert.equal(press('123 < < 9 =').display, '19');
});

test('pressing a second operator swaps it; the running total shows as you go', () => {
  const c = press('6 + × 3');
  assert.equal(c.history, '6 ×');
  c.equals();
  assert.equal(c.display, '18');
  assert.equal(press('1 + 2 +').display, '3');
  assert.equal(press('1 + 2 × 3 ×').display, '6', 'the product being built');
  assert.equal(press('1 + 2 × 3 +').display, '7', 'the whole so far');
});

test('÷0 says so, and the next key starts again', () => {
  const c = press('5 ÷ 0 =');
  assert.equal(c.display, DIV_ZERO);
  c.digit('7');
  assert.equal(c.display, '7');
});

test('numbers are shown tidily', () => {
  assert.equal(show(1 / 3), '0.333333333333');
  assert.equal(show(-0), '0');
  assert.equal(show(1e20), '1e+20');
});

test('sheet sums are live, × before +; empty cells count as 0', () => {
  const s = emptySheet(10);
  s.values = { A1: '2', B1: '3', A2: '4' };
  s.sums = { R1: { refs: ['A1', 'B1', 'A2'], ops: ['+', '×'] }, R2: { refs: ['R1', 'A9'], ops: ['+'] }, Af1: { refs: ['A1', 'A2'], ops: ['+'] } };
  let v = evaluate(s);
  assert.equal(v.get('R1'), 14);
  assert.equal(v.get('R2'), 14);
  assert.equal(v.get('Af1'), 6);
  s.values.A1 = '10';
  v = evaluate(s);
  assert.equal(v.get('R1'), 22);
  assert.equal(describe(s.sums.R1, 10), 'A1 + B1 × A2');
  assert.equal(describe(s.sums.Af1, 10), 'A1 + A2');
  assert.equal(describe({ refs: ['R2'], ops: [] }, 10), '=2');
  assert.equal(describe({ refs: ['Rf2'], ops: [] }, 10), '=12');
});

test('÷0 in the sheet names the cell; cells that use it say so', () => {
  const s = emptySheet(5);
  s.values = { A1: '1' };
  s.sums = { R1: { refs: ['A1', 'B1'], ops: ['÷'] }, R2: { refs: ['R1'], ops: [] } };
  const v = evaluate(s);
  assert.equal(v.get('R1'), DIV_ZERO);
  assert.equal(v.get('R2'), 'Uses =1, which has a problem');
});

test('loops are refused before saving, with the reason', () => {
  const s = emptySheet(5);
  s.sums = { R1: { refs: ['R2'], ops: [] } };
  assert.match(sumProblem(s, 'R1', { refs: ['R1'], ops: [] })!, /cannot use itself/);
  assert.match(sumProblem(s, 'R2', { refs: ['A1', 'R1'], ops: ['+'] })!, /=1 already uses =2/);
  assert.equal(sumProblem(s, 'R3', { refs: ['R1'], ops: [] }), null);
  assert.match(sumProblem(s, 'R3', { refs: [], ops: [] })!, /at least one cell/);
});

test('a saved file is read safely: junk ids, labels in sums and bad ops are dropped', () => {
  const s = parseSheet(JSON.stringify({
    rows: 9999,
    values: { A1: '5', '__proto__': 'x', Z1: '1', L1: 'Rent' },
    sums: { R1: { refs: ['A1', 'L1'], ops: ['+'] }, A1: { refs: ['B1'], ops: [] }, R2: { refs: ['A1', 'B1'], ops: ['^'] }, R3: { refs: ['A1', 'B1'], ops: ['−'] } },
  }));
  assert.equal(s.rows, 200);
  assert.deepEqual(s.values, { A1: '5', L1: 'Rent' });
  assert.deepEqual(Object.keys(s.sums), ['R3']);
});
