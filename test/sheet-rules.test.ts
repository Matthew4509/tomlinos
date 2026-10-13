// Conditional formatting and data validation, as rules (no browser needed): which cells each rule colours, the order
// rules win in, formulas that move with each cell, data bars and colour scales; what a validation rule lets in; how
// both follow inserted and deleted rows, undo, and saving.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cfLook, subtractRange, type CfEntry } from '../src/apps/sheet/condfmt.ts';
import { parseCellRef } from '../src/apps/sheet/refs.ts';
import { itemsFormula, listItems, literalItems, newValidation, passes, validationAt, type Validation } from '../src/apps/sheet/validate.ts';
import { Workbook } from '../src/apps/sheet/workbook.ts';

function book(cells: Record<string, string>): Workbook {
  const wb = new Workbook();
  wb.dateOrder = 'dmy';
  for (const [addr, text] of Object.entries(cells)) {
    const r = parseCellRef(addr)!;
    wb.setInput(0, r.col, r.row, text);
  }
  return wb;
}
const R = (a: string) => {
  const [x, y] = a.split(':').map(t => parseCellRef(t)!);
  const z = y ?? x;
  return { c0: x.col, r0: x.row, c1: z.col, r1: z.row };
};
const look = (wb: Workbook, addr: string) => {
  const r = parseCellRef(addr)!;
  return cfLook(wb, 0, r.col, r.row);
};
const reopen = (wb: Workbook): Workbook => {
  const back = new Workbook();
  back.load(JSON.parse(wb.serialize()));
  return back;
};
const RED = { fill: '#ffc7ce', color: '#9c0006' };
const GREEN = { fill: '#c6efce', color: '#006100' };

const NUMS = { A1: '5', A2: '50', A3: '120', A4: '7', A5: 'text', A6: '', A7: '120' };

test('highlight rules: greater than, between, equal to text, against a cell; empty and text cells as Excel', () => {
  const wb = book({ ...NUMS, C1: '100' });
  wb.addCf(0, { ranges: [R('A1:A7')], rule: { t: 'cell', op: 'gt', f1: '$C$1', fmt: RED } });
  assert.deepEqual(look(wb, 'A3'), RED);
  assert.equal(look(wb, 'A2'), null);
  assert.equal(look(wb, 'B3'), null, 'outside the range');
  // Text is "greater than" any number, as Excel compares them.
  assert.deepEqual(look(wb, 'A5'), RED);
  assert.equal(look(wb, 'A6'), null, 'an empty cell counts as 0');
  // The rule follows the cell it reads.
  wb.setInput(0, 2, 0, '10');
  assert.deepEqual(look(wb, 'A2'), RED);
  wb.setCf(0, [{ ranges: [R('A1:A7')], rule: { t: 'cell', op: 'between', f1: '100', f2: '6', fmt: GREEN } }]);
  assert.deepEqual([look(wb, 'A1'), look(wb, 'A4'), look(wb, 'A2'), look(wb, 'A3')], [null, GREEN, GREEN, null], 'between works either way round');
  const words = book({ A1: 'Paid', A2: 'paid', A3: 'Due' });
  words.addCf(0, { ranges: [R('A1:A3')], rule: { t: 'cell', op: 'eq', f1: '"PAID"', fmt: GREEN } });
  assert.deepEqual([look(words, 'A1'), look(words, 'A2'), look(words, 'A3')], [GREEN, GREEN, null], 'text without minding case');
  words.addCf(0, { ranges: [R('A1:A3')], rule: { t: 'text', op: 'contains', text: 'ue', fmt: { b: true } } });
  assert.deepEqual(look(words, 'A3'), { b: true });
});

test('rule order: the first rule wins where two set the same thing; stop if true ends the list', () => {
  const wb = book(NUMS);
  wb.addCf(0, { ranges: [R('A1:A7')], rule: { t: 'cell', op: 'gt', f1: '10', fmt: { fill: '#ffeb9c', b: true } } });
  // Added later, so it is first in the list and wins on fill; bold still comes from the older rule.
  wb.addCf(0, { ranges: [R('A1:A7')], rule: { t: 'cell', op: 'gt', f1: '100', fmt: RED } });
  assert.deepEqual(look(wb, 'A3'), { ...RED, b: true });
  wb.setCf(0, [{ ...wb.sheets[0].cf[0], stop: true }, wb.sheets[0].cf[1]]);
  assert.deepEqual(look(wb, 'A3'), RED);
  assert.deepEqual(look(wb, 'A2'), { fill: '#ffeb9c', b: true });
});

test('top 10, above average, duplicates, blanks and a formula that moves with each cell', () => {
  const wb = book({ A1: '1', A2: '9', A3: '4', A4: '9', A5: '2', A6: '6', B1: 'x', B2: 'y', B3: 'X', B4: '', C1: '3', C2: '30', C3: '7' });
  const top2: CfEntry = { ranges: [R('A1:A6')], rule: { t: 'top', n: 2, fmt: GREEN } };
  wb.setCf(0, [top2]);
  assert.deepEqual(['A2', 'A4', 'A6'].map(a => look(wb, a)), [GREEN, GREEN, null], 'the two highest (both 9s)');
  wb.setCf(0, [{ ranges: [R('A1:A6')], rule: { t: 'top', n: 50, percent: true, bottom: true, fmt: RED } }]);
  assert.deepEqual(['A1', 'A5', 'A3', 'A6'].map(a => look(wb, a)), [RED, RED, RED, null], 'the bottom half');
  wb.setCf(0, [{ ranges: [R('A1:A6')], rule: { t: 'avg', fmt: GREEN } }]);
  assert.deepEqual(['A2', 'A6', 'A3'].map(a => look(wb, a)), [GREEN, GREEN, null], 'above the average of 5.17');
  wb.setCf(0, [{ ranges: [R('B1:B4')], rule: { t: 'dup', fmt: RED } }]);
  assert.deepEqual(['B1', 'B3', 'B2', 'B4'].map(a => look(wb, a)), [RED, RED, null, null], 'x and X are the same, as in Excel');
  wb.setCf(0, [{ ranges: [R('B1:B4')], rule: { t: 'blank', fmt: RED } }]);
  assert.deepEqual(look(wb, 'B4'), RED);
  // =A1>C1 written for the top-left cell: in A2 it reads A2>C2.
  wb.setCf(0, [{ ranges: [R('A1:A3')], rule: { t: 'expr', f: 'A1>C1', fmt: RED } }]);
  assert.deepEqual(['A1', 'A2', 'A3'].map(a => look(wb, a)), [null, null, null]);
  wb.setInput(0, 2, 0, '0');
  assert.deepEqual(look(wb, 'A1'), RED);
  // Absolute: every cell against $C$1.
  wb.setCf(0, [{ ranges: [R('A1:A3')], rule: { t: 'expr', f: 'A1>$C$3', fmt: RED } }]);
  assert.deepEqual(['A1', 'A2', 'A3'].map(a => look(wb, a)), [null, RED, null]);
});

test('data bars and colour scales', () => {
  const wb = book({ A1: '0', A2: '50', A3: '100', A4: 'x' });
  wb.setCf(0, [{ ranges: [R('A1:A4')], rule: { t: 'bar', colour: '#638ec6' } }]);
  assert.deepEqual(['A1', 'A2', 'A3'].map(a => look(wb, a)?.bar?.len), [0, 0.5, 1]);
  assert.equal(look(wb, 'A4')?.bar, undefined, 'no bar for text');
  wb.setCf(0, [{ ranges: [R('A1:A3')], rule: { t: 'scale', colours: ['#f8696b', '#ffeb84', '#63be7b'] } }]);
  assert.deepEqual(['A1', 'A2', 'A3'].map(a => look(wb, a)?.fill), ['#f8696b', '#ffeb84', '#63be7b']);
  wb.setCf(0, [{ ranges: [R('A1:A3')], rule: { t: 'scale', colours: ['#ffffff', '#000000'] } }]);
  assert.equal(look(wb, 'A2')?.fill, '#808080');
});

test('rules follow inserted and deleted rows, clear from a block, undo, and are saved', () => {
  const wb = book(NUMS);
  wb.addCf(0, { ranges: [R('A1:A7')], rule: { t: 'expr', f: 'A1>$A$3', fmt: RED } });
  wb.shiftAxis(0, 'row', 0, 2);
  assert.deepEqual(wb.sheets[0].cf[0].ranges, [R('A3:A9')]);
  assert.equal((wb.sheets[0].cf[0].rule as { f: string }).f, 'A3>$A$5');
  assert.deepEqual(look(wb, 'A9'), null);
  wb.setInput(0, 0, 8, '500');
  assert.deepEqual(look(wb, 'A9'), RED);
  wb.clearCf(0, R('A5:A6'));
  assert.deepEqual(wb.sheets[0].cf[0].ranges, [R('A3:A4'), R('A7:A9')]);
  const back = reopen(wb);
  assert.deepEqual(back.sheets[0].cf, wb.sheets[0].cf);
  wb.undo();
  assert.deepEqual(wb.sheets[0].cf[0].ranges, [R('A3:A9')]);
  wb.clearCf(0, null);
  assert.equal(wb.sheets[0].cf.length, 0);
  // Rows deleted under the whole rule take it away.
  const small = book({ A1: '1' });
  small.addCf(0, { ranges: [R('A2:A3')], rule: { t: 'blank', fmt: RED } });
  small.shiftAxis(0, 'row', 1, -2);
  assert.equal(small.sheets[0].cf.length, 0);
  assert.deepEqual(subtractRange(R('A1:C3'), R('B2')), [R('A1:C1'), R('A3:C3'), R('A2'), R('C2')]);
  // A damaged rule in a file is left out.
  const raw = JSON.parse(back.serialize());
  raw.sheets[0].cf.push({ ranges: [[0, 0, 0, 0]], rule: { t: 'icons' } }, { ranges: [], rule: { t: 'blank', fmt: {} } });
  const again = new Workbook();
  again.load(raw);
  assert.equal(again.sheets[0].cf.length, 1);
});

const rule = (over: Partial<Validation>, where = 'A1:A10'): Validation => ({ ...newValidation([R(where)]), ...over });

test('validation: whole numbers, decimals, dates, text length, lists, a formula; blanks', () => {
  const wb = book({ D1: 'Red', D2: 'Green', D3: '', D4: 'Blue', E1: '10' });
  const ok = (v: Validation, input: string) => wb.withInput(0, 0, 0, input, () => passes(wb, 0, v, wb.value(0, 0, 0), 0, 0));
  const whole = rule({ type: 'whole', op: 'between', f1: '1', f2: '$E$1' });
  assert.deepEqual(['5', '10', '11', '2.5', 'abc', '=3*3'].map(x => ok(whole, x)), [true, true, false, false, false, true]);
  assert.equal(ok({ ...whole, blank: true }, ''), true);
  assert.equal(passes(wb, 0, { ...whole, blank: false }, null, 0, 0), false);
  const dec = rule({ type: 'decimal', op: 'gt', f1: '0.5' });
  assert.deepEqual(['0.75', '0.5', '-1'].map(x => ok(dec, x)), [true, false, false]);
  const date = rule({ type: 'date', op: 'ge', f1: 'DATE(2026,1,1)' });
  assert.deepEqual(['13/10/2026', '31/12/2025', 'soon'].map(x => ok(date, x)), [true, false, false]);
  const len = rule({ type: 'length', op: 'le', f1: '3' });
  assert.deepEqual(['abc', 'abcd', '123'].map(x => ok(len, x)), [true, false, true]);
  const typed = rule({ type: 'list', f1: itemsFormula('Yes, No , Maybe') });
  assert.equal(typed.f1, '"Yes,No,Maybe"');
  assert.deepEqual(literalItems(typed.f1), ['Yes', 'No', 'Maybe']);
  assert.deepEqual(['yes', 'Maybe', 'Perhaps'].map(x => ok(typed, x)), [true, true, false]);
  const fromCells = rule({ type: 'list', f1: '$D$1:$D$4' });
  assert.deepEqual(listItems(wb, 0, fromCells, 0, 0), ['Red', 'Green', 'Blue'], 'blank cells are not offered');
  assert.deepEqual(['Blue', 'Pink'].map(x => ok(fromCells, x)), [true, false]);
  const custom = rule({ type: 'custom', f1: 'ISNUMBER(A1)' });
  assert.deepEqual(['12', 'twelve'].map(x => ok(custom, x)), [true, false], 'the formula reads the value being typed');
  // Trying a value leaves the cell and the workbook as they were.
  const before = wb.version;
  assert.equal(wb.value(0, 0, 0), null);
  assert.equal(wb.version, before);
  assert.equal(wb.entryValue(0, '=2+3'), 5);
});

test('validation rules sit on blocks: replaced, cleared, moved with rows, undone and saved', () => {
  const wb = book({});
  wb.setValidation(0, R('A1:A10'), rule({ type: 'whole', op: 'ge', f1: '0' }));
  wb.setValidation(0, R('A5:B5'), rule({ type: 'list', f1: '"a,b"' }));
  assert.equal(validationAt(wb, 0, 0, 0)?.type, 'whole');
  assert.equal(validationAt(wb, 0, 0, 4)?.type, 'list', 'the newer rule replaces the old one where they meet');
  assert.equal(validationAt(wb, 0, 1, 4)?.type, 'list');
  assert.deepEqual(wb.sheets[0].dv[0].ranges, [R('A1:A4'), R('A6:A10')]);
  wb.shiftAxis(0, 'row', 0, 1);
  assert.equal(validationAt(wb, 0, 0, 5)?.type, 'list');
  assert.equal(validationAt(wb, 0, 0, 0), null);
  wb.setValidation(0, R('A1:B20'), null);
  assert.equal(wb.sheets[0].dv.length, 0);
  wb.undo();
  wb.undo();
  wb.setValidation(0, R('C1'), { ...rule({ type: 'decimal', op: 'lt', f1: '9' }), prompt: { show: true, title: 'Amount', text: 'Under 9' }, error: { show: true, style: 'warning', title: 'Big', text: 'That is a lot' } });
  const back = reopen(wb);
  assert.deepEqual(back.sheets[0].dv, wb.sheets[0].dv);
  assert.equal(validationAt(back, 0, 2, 0)?.error.style, 'warning');
});

test('page setup is saved, moves with rows, and is undone', () => {
  const wb = book({ A1: '1' });
  wb.setPage(0, { paper: 'letter', orient: 'landscape', margins: { t: 1, b: 1, l: 0.5, r: 0.5, header: 0.3, footer: 0.3 }, scale: 80, fit: { w: 1, h: 0 }, gridlines: true, headings: true, centerH: true, centerV: false, area: R('A1:D20'), titleRows: [0, 1], titleCols: null, header: '&C&A', footer: '&CPage &P of &N', order: 'over' });
  const back = reopen(wb);
  assert.deepEqual(back.sheets[0].page, wb.sheets[0].page);
  wb.shiftAxis(0, 'row', 0, 1);
  assert.deepEqual(wb.sheets[0].page?.area, R('A2:D21'));
  assert.deepEqual(wb.sheets[0].page?.titleRows, [1, 2]);
  wb.undo();
  wb.undo();
  assert.equal(wb.sheets[0].page, null);
});
