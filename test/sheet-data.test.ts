// Session 9: the Data tab's tools. Sorting by several columns, Number and Text filters (conditions, top 10, average)
// also in Excel files, Remove duplicates, and Text to columns. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readZip } from '../src/apps/archive/read.ts';
import { parseCellRef } from '../src/apps/sheet/refs.ts';
import { keyOf, Workbook } from '../src/apps/sheet/workbook.ts';
import { openXlsx, saveXlsx } from '../src/apps/sheet/xlsx.ts';

const R = (a: string) => {
  const [x, y] = a.split(':').map(t => parseCellRef(t)!);
  const z = y ?? x;
  return { c0: x.col, r0: x.row, c1: z.col, r1: z.row };
};
const put = (wb: Workbook, cells: Record<string, string>) => {
  for (const [a, v] of Object.entries(cells)) {
    const r = parseCellRef(a)!;
    wb.setInput(0, r.col, r.row, v);
  }
};
const col = (wb: Workbook, c: string, from: number, to: number) => {
  const out: unknown[] = [];
  for (let r = from; r <= to; r++) out.push(wb.value(0, parseCellRef(`${c}1`)!.col, r - 1));
  return out;
};
const shownRows = (wb: Workbook, from: number, to: number) => {
  const out: number[] = [];
  for (let r = from; r <= to; r++) if (!wb.sheets[0].hiddenRows.has(r - 1)) out.push(r);
  return out;
};
const partText = async (bytes: Uint8Array, name: string) => new TextDecoder().decode(await readZip(bytes).find(e => e.parts.join('/') === name)!.read());

function people(): Workbook {
  const wb = new Workbook();
  put(wb, {
    A1: 'Name', B1: 'Team', C1: 'Score',
    A2: 'Ann', B2: 'Red', C2: '30',
    A3: 'Bob', B3: 'Blue', C3: '50',
    A4: 'Cy', B4: 'Red', C4: '50',
    A5: 'Di', B5: 'Blue', C5: '10',
    A6: 'Ed', B6: 'Red', C6: '',
    A7: 'Fay', B7: 'Green', C7: '40',
  });
  return wb;
}

test('sorting by several columns: team A to Z, then score largest first; empty cells last; one Undo', () => {
  const wb = people();
  wb.sortBy(0, R('A2:C7'), [{ col: 1, ascending: true }, { col: 2, ascending: false }]);
  assert.deepEqual(col(wb, 'A', 2, 7), ['Bob', 'Di', 'Fay', 'Cy', 'Ann', 'Ed']);
  wb.undo();
  assert.deepEqual(col(wb, 'A', 2, 7), ['Ann', 'Bob', 'Cy', 'Di', 'Ed', 'Fay']);
});

test('Number and Text filters: conditions, between, or, top N and N%, above average; SUBTOTAL follows', () => {
  const wb = people();
  put(wb, { E1: '=SUBTOTAL(9,C2:C7)' });
  wb.setFilter(0, R('A1:C7'));
  wb.filterRule(0, 2, { kind: 'custom', and: true, a: { op: 'greaterThan', val: '25' } });
  assert.deepEqual(shownRows(wb, 2, 7), [2, 3, 4, 7]);
  assert.equal(wb.value(0, 4, 0), 170);
  wb.filterRule(0, 2, { kind: 'custom', and: true, a: { op: 'greaterThanOrEqual', val: '30' }, b: { op: 'lessThanOrEqual', val: '40' } });
  assert.deepEqual(shownRows(wb, 2, 7), [2, 7]);
  wb.filterRule(0, 2, { kind: 'custom', and: false, a: { op: 'equal', val: '10' }, b: { op: 'equal', val: '40' } });
  assert.deepEqual(shownRows(wb, 2, 7), [5, 7]);
  wb.filterRule(0, 2, { kind: 'top', top: true, n: 2, percent: false });
  assert.deepEqual(shownRows(wb, 2, 7), [3, 4], 'the two largest (a tie at 50)');
  wb.filterRule(0, 2, { kind: 'top', top: false, n: 40, percent: true });
  assert.deepEqual(shownRows(wb, 2, 7), [2, 5], 'the bottom 40% of five numbers: two');
  wb.filterRule(0, 2, { kind: 'average', above: true });
  assert.deepEqual(shownRows(wb, 2, 7), [3, 4, 7], 'average 36');
  // Text: contains (stored as *e*), begins with, does not contain; a column's rule and another's list together.
  wb.filterRule(0, 2, null);
  wb.filterRule(0, 1, { kind: 'custom', and: true, a: { op: 'equal', val: '*e*' } });
  assert.deepEqual(shownRows(wb, 2, 7), [2, 3, 4, 5, 6, 7].filter(r => ['Red', 'Blue', 'Red', 'Blue', 'Red', 'Green'][r - 2].includes('e')));
  wb.filterRule(0, 1, { kind: 'custom', and: true, a: { op: 'notEqual', val: 'R*' } });
  wb.filterBy(0, 0, ['Bob', 'Fay', 'Ann']);
  assert.deepEqual(shownRows(wb, 2, 7), [3, 7]);
  wb.clearFilters(0);
  assert.deepEqual(shownRows(wb, 2, 7), [2, 3, 4, 5, 6, 7]);
});

test('filter rules go into Excel files as Excel writes them, and come back', async () => {
  const wb = people();
  wb.setFilter(0, R('A1:C7'));
  wb.filterRule(0, 2, { kind: 'custom', and: true, a: { op: 'greaterThanOrEqual', val: '30' }, b: { op: 'lessThan', val: '50' } });
  wb.filterRule(0, 1, { kind: 'custom', and: false, a: { op: 'equal', val: 'R*' } });
  const bytes = await saveXlsx(wb);
  const sheetXml = await partText(bytes, 'xl/worksheets/sheet1.xml');
  assert.match(sheetXml, /<filterColumn colId="1"><customFilters><customFilter val="R\*"\/><\/customFilters><\/filterColumn><filterColumn colId="2"><customFilters and="1"><customFilter operator="greaterThanOrEqual" val="30"\/><customFilter operator="lessThan" val="50"\/><\/customFilters><\/filterColumn>/);
  const back = new Workbook();
  const report = await openXlsx(back, bytes);
  assert.deepEqual(back.sheets[0].filter?.rules?.get(2), { kind: 'custom', and: true, a: { op: 'greaterThanOrEqual', val: '30' }, b: { op: 'lessThan', val: '50' } });
  assert.ok(!report.dropped.join(' ').includes('filter rule'), report.dropped.join(' | '));
  // Top 10 and above average.
  const wb2 = people();
  wb2.setFilter(0, R('A1:C7'));
  wb2.filterRule(0, 2, { kind: 'top', top: false, n: 3, percent: true });
  const x2 = await partText(await saveXlsx(wb2), 'xl/worksheets/sheet1.xml');
  assert.match(x2, /<top10 top="0" percent="1" val="3"\/>/);
  wb2.filterRule(0, 2, { kind: 'average', above: false });
  const b2 = await saveXlsx(wb2);
  assert.match(await partText(b2, 'xl/worksheets/sheet1.xml'), /<dynamicFilter type="belowAverage"\/>/);
  const back2 = new Workbook();
  await openXlsx(back2, b2);
  assert.deepEqual(back2.sheets[0].filter?.rules?.get(2), { kind: 'average', above: false });
});

test('Remove duplicates: rows repeating an earlier one in the ticked columns go, the rest move up; one Undo', () => {
  const wb = new Workbook();
  put(wb, { A1: 'Name', B1: 'City', C1: 'Note', A2: 'Ann', B2: 'Leeds', C2: 'x', A3: 'ann', B3: 'leeds', C3: 'y', A4: 'Bob', B4: 'York', C4: 'z', A5: 'Ann', B5: 'York', C5: '=A5&"!"', E1: 'outside' });
  const got = wb.removeDuplicates(0, R('A1:C5'), [0, 1], true);
  assert.deepEqual(got, { removed: 1, kept: 3 });
  assert.deepEqual(col(wb, 'A', 2, 5), ['Ann', 'Bob', 'Ann', null]);
  assert.equal(wb.sheets[0].cells.get(keyOf(2, 3))?.f, 'A4&"!"', 'a formula moved up follows its row');
  assert.equal(wb.value(0, 2, 3), 'Ann!');
  assert.equal(wb.value(0, 4, 0), 'outside');
  wb.undo();
  assert.deepEqual(col(wb, 'A', 2, 5), ['Ann', 'ann', 'Bob', 'Ann']);
  assert.deepEqual(wb.removeDuplicates(0, R('A1:C5'), [0], true), { removed: 2, kept: 2 }, 'by name only');
});

test('Text to columns: split at the chosen delimiters, quotes keep text whole, numbers and dates read as typed', () => {
  const wb = new Workbook();
  wb.dateOrder = 'dmy';
  put(wb, { A1: 'Ann,Lee,42', A2: 'Bob,"Smith, Jr",7', A3: 'Cy  Dee', A4: '13/10/2026;x' });
  const widest = wb.splitText(0, 0, 0, 1, { delims: [','], consecutive: false, quote: '"' });
  assert.equal(widest, 3);
  assert.deepEqual([col(wb, 'A', 1, 2), col(wb, 'B', 1, 2), col(wb, 'C', 1, 2)], [['Ann', 'Bob'], ['Lee', 'Smith, Jr'], [42, 7]]);
  wb.splitText(0, 0, 2, 2, { delims: [' '], consecutive: true, quote: null });
  assert.deepEqual([wb.value(0, 0, 2), wb.value(0, 1, 2), wb.value(0, 2, 2)], ['Cy', 'Dee', null]);
  wb.splitText(0, 0, 3, 3, { delims: [';'], consecutive: false, quote: null }, { col: 4, row: 3 });
  assert.equal(wb.value(0, 4, 3), 46308, 'a date');
  assert.equal(wb.value(0, 0, 3), '13/10/2026;x', 'the source stays when the pieces go elsewhere');
  assert.throws(() => wb.splitText(0, 0, 0, 0, { delims: [], consecutive: false, quote: null }), /delimiter/);
});

test('Top N% takes the whole number below (50% of five numbers is two), at least one', () => {
  const wb = people();
  wb.setFilter(0, R('A1:C7'));
  wb.filterRule(0, 2, { kind: 'top', top: true, n: 50, percent: true });
  assert.deepEqual(shownRows(wb, 2, 7), [3, 4], 'the two largest (both 50), not three (40 too)');
  wb.filterRule(0, 2, { kind: 'top', top: false, n: 1, percent: true });
  assert.deepEqual(shownRows(wb, 2, 7), [5], 'still one');
});
