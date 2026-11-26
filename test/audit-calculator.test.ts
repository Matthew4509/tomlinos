// Audit of the Calculator's sums (calculator/model.ts): faults found by trying to break it. Each test that fails names
// a fault still open. Run: node --test test/audit-calculator.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Calculator, emptySheet, evaluate, parseSheet, type Op } from '../src/apps/calculator/model.ts';

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

test('C-P0-1: a result of 1e15 or more keeps its digits when it is carried on into the next sum', () => {
  // 123456789012345 × 10 is shown as 1.23456789e+15 and that rounded text is what the next sum uses.
  assert.equal(press('123456789012345 × 10 = ÷ 10 =').display, '123456789012345');
});

test('C-P0-2: a result too big to hold is an error (± and digits do not treat "Too big" as a number)', () => {
  const big = '999999999999999 × 999999999999999 = × = × = × = × =';
  const c = press(big);
  assert.equal(c.display, 'Too big');
  assert.ok(c.error, 'overflow sets the error state, as ÷ 0 does');
  assert.equal(press(big + ' ±').display, 'Too big', '± must not make "-Too big"');
  assert.ok(Number.isFinite(press(big).value) || press(big).error, 'value is not NaN without an error');
});

test('C-P0-3: changing the operator shows the running result for the new operator', () => {
  // 2 + 3 then × then + : the display must read 5 (2 + 3), not the 3 of the product being built.
  assert.equal(press('2 + 3 × +').display, '5');
  // 2 + 3 then + then × : × works on the 3 alone (2 + 3 × 4 = 14), so showing 5 invites "5 × 4 = 20".
  assert.equal(press('2 + 3 + ×').display, '3');
});

test('C-P0-4: a sheet number cell with a decimal comma ("1,5") is not read as 15', () => {
  const d = emptySheet();
  d.values.A1 = '1,5';
  d.sums.R1 = { refs: ['A1'], ops: [] };
  const v = evaluate(d).get('R1');
  assert.ok(v === 1.5 || typeof v === 'string', `A1 "1,5" was read as ${v}`);
});

test('C-P0-5: hex and binary text in a number cell ("0x10", "0b11") is refused, not read as 16 and 3', () => {
  const d = emptySheet();
  d.values.A1 = '0x10';
  d.values.A2 = '0b11';
  d.sums.R1 = { refs: ['A1'], ops: [] };
  d.sums.R2 = { refs: ['A2'], ops: [] };
  const out = evaluate(d);
  assert.equal(typeof out.get('R1'), 'string', `0x10 read as ${out.get('R1')}`);
  assert.equal(typeof out.get('R2'), 'string', `0b11 read as ${out.get('R2')}`);
});

test('C-P0-6: a saved sheet cannot hide numbers in cells that are never shown (A0, A007, a typed value in an = cell)', () => {
  const data = parseSheet(JSON.stringify({
    version: 1, rows: 10,
    values: { A0: '99', A007: '5', R3: '7' },
    sums: { R1: { refs: ['A0', 'A007', 'R3'], ops: ['+', '+'] } },
  }));
  const v = evaluate(data).get('R1');
  // Every cell the sum uses must be one the window draws; the visible cells are all empty, so 0 or a refusal.
  assert.ok(v === 0 || v === undefined || typeof v === 'string', `R1 adds up hidden values: ${v}`);
});
