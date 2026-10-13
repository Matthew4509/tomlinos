// Merged cells, frozen panes, hidden rows and columns, the filter (▾ buttons), and find and replace, as rules of the
// workbook: what each keeps and throws away, how inserting and deleting rows moves them, undo, and saving.
// No browser needed. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPattern, Workbook } from '../src/apps/sheet/workbook.ts';
import { parseCellRef } from '../src/apps/sheet/refs.ts';

function book(cells: Record<string, string>): Workbook {
  const wb = new Workbook();
  wb.dateOrder = 'dmy';
  for (const [addr, text] of Object.entries(cells)) {
    const r = parseCellRef(addr)!;
    wb.setInput(0, r.col, r.row, text);
  }
  return wb;
}
const at = (wb: Workbook, addr: string, s = 0): string => {
  const r = parseCellRef(addr)!;
  return wb.display(s, r.col, r.row);
};
const R = (a: string): { c0: number; r0: number; c1: number; r1: number } => {
  const [x, y] = a.split(':').map(t => parseCellRef(t)!);
  const z = y ?? x;
  return { c0: x.col, r0: x.row, c1: z.col, r1: z.row };
};
const reopen = (wb: Workbook): Workbook => {
  const back = new Workbook();
  back.load(JSON.parse(wb.serialize()));
  return back;
};

const TABLE = {
  A1: 'Name', B1: 'Status', C1: 'Amount',
  A2: 'Ann', B2: 'Paid', C2: '120',
  A3: 'Bob', B3: 'Due', C3: '80',
  A4: 'cara', B4: 'paid', C4: '45',
  A5: 'Dan', C5: '300',
};

test('merge: keeps the top-left value, centres it, grows to touching merges, undoes, and blocks lists and sorting', () => {
  const wb = book({ A1: 'Title', B1: 'gone', A3: '=SEQUENCE(1,6)' });
  assert.equal(wb.mergeWouldLose(0, R('A1:C1')), true);
  assert.equal(wb.mergeWouldLose(0, R('A2:C2')), false);
  wb.merge(0, R('A1:C1'), 'center');
  assert.deepEqual(wb.sheets[0].merges, [R('A1:C1')]);
  assert.equal(at(wb, 'A1'), 'Title');
  assert.equal(at(wb, 'B1'), '', 'only the top-left value is kept, as in Excel');
  assert.equal(wb.styleOf(wb.sheets[0].cells.get(0))?.al, 'c');
  assert.deepEqual(wb.mergeAt(0, 2, 0), R('A1:C1'));
  assert.deepEqual(wb.growToMerges(0, R('B1:B2')), R('A1:C2'));
  // Merging again over part of a block takes the whole block in.
  wb.merge(0, R('C1:D1'), 'all');
  assert.deepEqual(wb.sheets[0].merges, [R('A1:D1')]);
  wb.undo();
  assert.deepEqual(wb.sheets[0].merges, [R('A1:C1')]);
  wb.undo();
  assert.deepEqual(wb.sheets[0].merges, []);
  assert.equal(at(wb, 'B1'), 'gone', 'Undo brings the thrown-away value back');
  // Merge across: one block per row.
  wb.merge(0, R('E1:F3'), 'across');
  assert.deepEqual(wb.sheets[0].merges, [R('E1:F1'), R('E2:F2'), R('E3:F3')]);
  wb.unmerge(0, R('F2'));
  assert.deepEqual(wb.sheets[0].merges, [R('E1:F1'), R('E3:F3')]);
  // A list cannot fill merged cells (#SPILL!), as in Excel; unmerging lets it fill.
  assert.equal(at(wb, 'A3'), '#SPILL!');
  wb.unmerge(0, R('E3'));
  assert.equal(at(wb, 'F3'), '6');
  // Sorting across merged cells is refused in words.
  wb.merge(0, R('A5:B5'), 'all');
  assert.throws(() => wb.sortRange(0, R('A4:B6'), 0, true), /merged/);
});

test('merge, freeze, hidden rows and filter move with inserted and deleted rows and columns', () => {
  const wb = book(TABLE);
  wb.merge(0, R('E2:F4'), 'all');
  wb.setFreeze(0, 2, 1);
  wb.setHidden(0, 'row', 6, 7, true);
  wb.setFilter(0, R('A1:C5'));
  wb.shiftAxis(0, 'row', 0, 1);
  const sh = wb.sheets[0];
  assert.deepEqual(sh.merges, [R('E3:F5')]);
  assert.deepEqual(sh.freeze, { rows: 3, cols: 1 }, 'a row inserted above the split is frozen too');
  assert.deepEqual([...sh.hiddenRows].sort(), [7, 8]);
  assert.deepEqual(sh.filter?.range, R('A2:C6'));
  wb.shiftAxis(0, 'row', 3, -2);
  assert.deepEqual(wb.sheets[0].merges, [R('E3:F3')], 'cut through: the block shrinks');
  assert.deepEqual(wb.sheets[0].freeze, { rows: 3, cols: 1 }, 'rows deleted below the split leave it');
  wb.shiftAxis(0, 'row', 0, -2);
  assert.deepEqual(wb.sheets[0].freeze, { rows: 1, cols: 1 }, 'two of the frozen rows deleted');
  assert.equal(wb.sheets[0].filter, null, 'deleting the header row takes the filter off');
  wb.shiftAxis(0, 'col', 4, -1);
  assert.deepEqual(wb.sheets[0].merges, [], 'cut to one cell: no longer merged');
});

test('filter: keeps the rows whose value is ticked, shows values in order, takes in new rows, sorts, clears', () => {
  const wb = book(TABLE);
  wb.setFilter(0, wb.currentRegion(0, 1, 1));
  assert.deepEqual(wb.sheets[0].filter?.range, R('A1:C5'));
  assert.deepEqual(wb.filterValues(0, 1), ['Due', 'Paid', ''], 'case is ignored (paid = Paid), empty last');
  assert.deepEqual(wb.filterValues(0, 2), ['45', '80', '120', '300'], 'numbers in order of size');
  wb.filterBy(0, 1, ['Paid']);
  assert.deepEqual([...wb.sheets[0].hiddenRows].sort(), [2, 4], 'Bob (Due) and Dan (blank) hidden; cara (paid) kept');
  wb.filterBy(0, 2, ['120', '300']);
  assert.deepEqual([...wb.sheets[0].hiddenRows].sort(), [2, 3, 4]);
  wb.filterBy(0, 1, null);
  assert.deepEqual([...wb.sheets[0].hiddenRows].sort(), [2, 3]);
  // A row typed under the table is taken in when the filter is applied again.
  wb.setInput(0, 0, 5, 'Eve');
  wb.setInput(0, 2, 5, '300');
  wb.filterBy(0, 2, ['300']);
  assert.deepEqual(wb.sheets[0].filter?.range, R('A1:C6'));
  assert.deepEqual([...wb.sheets[0].hiddenRows].sort(), [1, 2, 3]);
  // Sorting from the filter sorts every data row, then filters again.
  wb.sortFilter(0, 2, false);
  assert.deepEqual(['A2', 'A3', 'A4', 'A5', 'A6'].map(a => at(wb, a)), ['Dan', 'Eve', 'Ann', 'Bob', 'cara']);
  assert.deepEqual([...wb.sheets[0].hiddenRows].sort(), [3, 4, 5]);
  wb.undo();
  assert.equal(at(wb, 'A2'), 'Ann', 'one Undo takes the sort back');
  // Saved and opened again.
  const back = reopen(wb);
  assert.deepEqual([...back.sheets[0].filter!.cols], [[2, ['300']]]);
  assert.deepEqual([...back.sheets[0].hiddenRows].sort(), [...wb.sheets[0].hiddenRows].sort());
  wb.setFilter(0, null);
  assert.equal(wb.sheets[0].filter, null);
  assert.equal(wb.sheets[0].hiddenRows.size, 0, 'taking the filter off shows every row');
  assert.throws(() => wb.setFilter(0, R('A1:C1')), /header row and at least one row/);
});

test('hidden rows and columns: hide, show, undo, saved; never every one', () => {
  const wb = book(TABLE);
  wb.setHidden(0, 'col', 1, 2, true);
  assert.deepEqual([...wb.sheets[0].hiddenCols], [1, 2]);
  wb.setHidden(0, 'col', 2, 2, false);
  assert.deepEqual([...wb.sheets[0].hiddenCols], [1]);
  wb.undo();
  assert.deepEqual([...wb.sheets[0].hiddenCols], [1, 2]);
  assert.deepEqual([...reopen(wb).sheets[0].hiddenCols], [1, 2]);
  assert.throws(() => wb.setHidden(0, 'col', 0, 255, true), /at least one has to stay/);
  // A hidden cell still counts in formulas (as in Excel's SUM).
  wb.setInput(0, 4, 0, '=SUM(C2:C5)');
  assert.equal(at(wb, 'E1'), '545');
});

test('freeze: kept in the file, clamped to the sheet, not an undo step', () => {
  const wb = book(TABLE);
  wb.setFreeze(0, 1, 2);
  assert.equal(wb.canUndo, true, 'the typing before it can still be undone');
  const before = wb.version;
  wb.setFreeze(0, 1, 2);
  assert.equal(wb.version, before, 'no change, no new version');
  assert.deepEqual(reopen(wb).sheets[0].freeze, { rows: 1, cols: 2 });
  wb.setFreeze(0, 99999, -3);
  assert.deepEqual(wb.sheets[0].freeze, { rows: 4999, cols: 0 });
});

test('find: wildcards, case, whole cell, values or formulas, every sheet, spilled cells', () => {
  const wb = book({ ...TABLE, E1: '=UPPER(A2)', E3: '=SORT(A2:A3)' });
  wb.addSheet();
  wb.setInput(1, 0, 0, 'Paid in full');
  const where = (list: Array<{ s: number; col: number; row: number }>) => list.map(f => `${f.s}:${String.fromCharCode(65 + f.col)}${f.row + 1}`);
  assert.deepEqual(where(wb.findAll(0, { text: 'paid' })), ['0:B2', '0:B4']);
  assert.deepEqual(where(wb.findAll(0, { text: 'paid', matchCase: true })), ['0:B4']);
  assert.deepEqual(where(wb.findAll(0, { text: 'paid', allSheets: true })), ['0:B2', '0:B4', '1:A1']);
  assert.deepEqual(where(wb.findAll(1, { text: 'paid', allSheets: true })), ['1:A1', '0:B2', '0:B4'], 'starts on the sheet in view');
  assert.deepEqual(where(wb.findAll(0, { text: 'Pa*', wholeCell: true })), ['0:B2', '0:B4']);
  assert.deepEqual(where(wb.findAll(0, { text: 'B?b' })), ['0:A3', '0:E4'], 'Bob, and the copy the SORT list shows');
  assert.deepEqual(where(wb.findAll(0, { text: 'ANN' })), ['0:E1', '0:A2', '0:E3'], 'values: what cells show, row by row');
  assert.deepEqual(where(wb.findAll(0, { text: 'upper', lookIn: 'formulas' })), ['0:E1'], 'formulas: what is typed');
  assert.deepEqual(where(wb.findAll(0, { text: '1~*', lookIn: 'formulas' })), []);
  assert.equal(findPattern('a~*b').test('xa*bx'), true);
  assert.equal(findPattern('a~*b').test('axxb'), false);
  assert.equal(findPattern('(1+2)').test('=(1+2)'), true, 'regular-expression characters are plain');
});

test('replace: on what is typed, one undo step, broken formulas skipped, numbers stay numbers', () => {
  const wb = book({ A1: 'Paid', A2: 'paid in full', A3: '120', A4: '=SUM(A3,1)', A5: '=A3*2', B1: 'PAID' });
  const r = wb.replaceAll(0, { text: 'paid' }, 'Settled');
  assert.deepEqual(r, { changed: 3, skipped: 0 });
  assert.deepEqual(['A1', 'A2', 'B1'].map(a => at(wb, a)), ['Settled', 'Settled in full', 'Settled']);
  wb.undo();
  assert.deepEqual(['A1', 'A2', 'B1'].map(a => at(wb, a)), ['Paid', 'paid in full', 'PAID'], 'one Undo takes every replacement back');
  assert.deepEqual(wb.replaceAll(0, { text: '120', wholeCell: true }, '150'), { changed: 1, skipped: 0 });
  assert.equal(at(wb, 'A5'), '300', 'the replaced number is a number');
  assert.deepEqual(wb.replaceAll(0, { text: 'SUM' }, 'SUM('), { changed: 0, skipped: 1 }, 'a replacement that breaks a formula is skipped');
  assert.equal(wb.sheets[0].cells.get(3 * 256)?.f, 'SUM(A3,1)');
  assert.equal(wb.replaceOne(0, 0, 0, { text: '*' }, 'x'), true);
  assert.equal(at(wb, 'A1'), 'x', 'a star that matches everything replaces it once');
});
