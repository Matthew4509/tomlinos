// Lists that fill the cells around their formula ("spill", as in Excel 365): =A1:A3*2, FILTER, SORT, SORTBY, UNIQUE,
// SEQUENCE, TRANSPOSE; the A1# reference; #SPILL! when something is in the way; operators and one-value functions
// working on every value of a list (B2:B9>5, LEN(A1:A5)); INDEX/MATCH on two conditions; SUMPRODUCT.
// No browser needed. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Workbook } from '../src/apps/sheet/workbook.ts';
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
const at = (wb: Workbook, addr: string): string => {
  const r = parseCellRef(addr)!;
  return wb.display(0, r.col, r.row);
};
const col = (wb: Workbook, from: string, n: number): string[] => {
  const r = parseCellRef(from)!;
  return Array.from({ length: n }, (_, i) => wb.display(0, r.col, r.row + i));
};
const row = (wb: Workbook, from: string, n: number): string[] => {
  const r = parseCellRef(from)!;
  return Array.from({ length: n }, (_, i) => wb.display(0, r.col + i, r.row));
};

/** A small table: name, status, amount. */
const ORDERS = {
  A1: 'Name', B1: 'Status', C1: 'Amount',
  A2: 'Ann', B2: 'Paid', C2: '120',
  A3: 'Bob', B3: 'Due', C3: '80',
  A4: 'cara', B4: 'Paid', C4: '45',
  A5: 'Dan', B5: 'Paid', C5: '300',
  A6: 'ann', B6: 'Due', C6: '120',
};

test('a range times a number fills the cells below; other formulas read those cells', () => {
  const wb = book({ A1: '1', A2: '2', A3: '3', C1: '=A1:A3*2', E1: '=SUM(C1:C3)', E2: '=C3+1' });
  assert.deepEqual(col(wb, 'C1', 4), ['2', '4', '6', '']);
  assert.equal(at(wb, 'E1'), '12');
  assert.equal(at(wb, 'E2'), '7');
  // Nothing is stored in the filled cells: only the formula is saved.
  assert.equal(wb.sheets[0].cells.size, 6);
  assert.equal(wb.isSpilled(0, 2, 1), true);
  assert.equal(wb.isSpilled(0, 2, 0), false);
  assert.equal(wb.spillFormula(0, 2, 2), '=A1:A3*2');
  assert.deepEqual(wb.spillArea(0, 2, 1), { c0: 2, r0: 0, c1: 2, r1: 2, col: 2, row: 0 });
  // A row and a column side by side make a table (each value of one with each of the other).
  const t = book({ A1: '=SEQUENCE(3)*{10,100}' });
  assert.deepEqual(row(t, 'A3', 2), ['30', '300']);
});

test('FILTER keeps the rows that match, on one condition or two, with a message when none do', () => {
  const wb = book({ ...ORDERS, E2: '=FILTER(A2:C6,B2:B6="Paid")' });
  assert.deepEqual(col(wb, 'E2', 4), ['Ann', 'cara', 'Dan', '']);
  assert.deepEqual(row(wb, 'E4', 3), ['Dan', 'Paid', '300']);
  const two = book({ ...ORDERS, E2: '=FILTER(A2:A6,(B2:B6="Paid")*(C2:C6>100))' });
  assert.deepEqual(col(two, 'E2', 3), ['Ann', 'Dan', '']);
  const either = book({ ...ORDERS, E2: '=FILTER(A2:A6,(C2:C6<50)+(C2:C6>200))' });
  assert.deepEqual(col(either, 'E2', 3), ['cara', 'Dan', '']);
  assert.equal(at(book({ ...ORDERS, E2: '=FILTER(A2:A6,B2:B6="Lost","none")' }), 'E2'), 'none');
  assert.equal(at(book({ ...ORDERS, E2: '=FILTER(A2:A6,B2:B6="Lost")' }), 'E2'), '#CALC!');
  // The condition must be as tall as the list.
  assert.equal(at(book({ ...ORDERS, E2: '=FILTER(A2:A6,B2:B5="Paid")' }), 'E2'), '#VALUE!');
  // Columns can be filtered too, with a condition across a row.
  const across = book({ A1: 'a', B1: 'b', C1: 'c', A2: '1', B2: '0', C2: '1', A4: '=FILTER(A1:C1,A2:C2)' });
  assert.deepEqual(row(across, 'A4', 3), ['a', 'c', '']);
});

test('a filled cell that is typed in stops the list (#SPILL!); clearing it, or Undo, lets it fill again', () => {
  const wb = book({ ...ORDERS, E2: '=FILTER(A2:A6,B2:B6="Paid")' });
  wb.setInput(0, 4, 3, 'in the way');
  assert.equal(at(wb, 'E2'), '#SPILL!');
  assert.equal(at(wb, 'E3'), '');
  assert.equal(at(wb, 'E4'), 'in the way');
  wb.undo();
  assert.deepEqual(col(wb, 'E2', 3), ['Ann', 'cara', 'Dan']);
  wb.setInput(0, 4, 3, 'again');
  wb.setInput(0, 4, 3, '');
  assert.deepEqual(col(wb, 'E2', 3), ['Ann', 'cara', 'Dan']);
  // A cell with only formatting does not stop it.
  wb.setStyle(0, { c0: 4, r0: 3, c1: 4, r1: 3 }, s => ({ ...s, b: true }));
  assert.equal(at(wb, 'E4'), 'Dan');
  // Off the bottom of the sheet.
  assert.equal(at(book({ A4999: '=SEQUENCE(5)' }), 'A4999'), '#SPILL!');
  // A list that would run into another list's cells: the lower one waits.
  const two = book({ A1: '=SEQUENCE(3)', A2: 'x' });
  assert.equal(at(two, 'A1'), '#SPILL!');
  // A formula inside another list's cells stops that list (it holds something), and fills its own.
  const inside = book({ A1: '=SEQUENCE(3,2)', B2: '=SEQUENCE(2)' });
  assert.equal(at(inside, 'A1'), '#SPILL!');
  assert.deepEqual(col(inside, 'B2', 2), ['1', '2']);
  // Two lists that would both fill B2: the one higher up (then further left) fills, the other shows #SPILL!.
  const overlap = book({ B1: '=SEQUENCE(2)', A2: '=SEQUENCE(1,2,5)' });
  assert.deepEqual(col(overlap, 'B1', 2), ['1', '2']);
  assert.equal(at(overlap, 'A2'), '#SPILL!');
});

test('A1# is the whole list a formula fills', () => {
  const wb = book({ ...ORDERS, E2: '=FILTER(C2:C6,B2:B6="Paid")', G1: '=SUM(E2#)', G2: '=ROWS(E2#)', G3: '=SORT(E2#,,-1)', G7: '=SUM(A2#)', G8: '=COUNTA(Sheet1!E2#)' });
  assert.equal(at(wb, 'G1'), '465');
  assert.equal(at(wb, 'G2'), '3');
  assert.deepEqual(col(wb, 'G3', 3), ['300', '120', '45']);
  // A cell that holds no list formula: #REF!.
  assert.equal(at(wb, 'G7'), '#REF!');
  assert.equal(at(wb, 'G8'), '3');
  // It grows and shrinks with the list.
  wb.setInput(0, 1, 2, 'Paid');
  assert.equal(at(wb, 'G2'), '4');
  // Moving rows keeps the # on the formula's cell.
  wb.shiftAxis(0, 'row', 0, 1);
  assert.equal(wb.editText(0, 6, 1), '=SUM(E3#)');
  assert.equal(at(wb, 'G2'), '545');
});

test('SORT, SORTBY: by any column, either way; numbers before text, empty cells last', () => {
  const wb = book({ ...ORDERS, E2: '=SORT(A2:C6,3,-1)' });
  assert.deepEqual(col(wb, 'G2', 5), ['300', '120', '120', '80', '45']);
  // Equal amounts keep their order (Ann before ann).
  assert.deepEqual(col(wb, 'E3', 2), ['Ann', 'ann']);
  assert.deepEqual(col(book({ ...ORDERS, E2: '=SORT(A2:A6)' }), 'E2', 5), ['Ann', 'ann', 'Bob', 'cara', 'Dan']);
  assert.deepEqual(col(book({ ...ORDERS, E2: '=SORTBY(A2:A6,C2:C6,1)' }), 'E2', 5), ['cara', 'Bob', 'Ann', 'ann', 'Dan']);
  assert.deepEqual(col(book({ ...ORDERS, E2: '=SORTBY(A2:A6,B2:B6,1,C2:C6,-1)' }), 'E2', 5), ['ann', 'Bob', 'Dan', 'Ann', 'cara']);
  const mixed = book({ A1: 'pear', A2: '5', A3: 'TRUE', A5: '1', A6: 'apple', C1: '=SORT(A1:A6)' });
  // The empty A4 goes last, and shows as 0 there (as Excel shows an empty cell in a list).
  assert.deepEqual(col(mixed, 'C1', 6), ['1', '5', 'apple', 'pear', 'TRUE', '0']);
  assert.deepEqual(col(book({ A1: '2', A3: '9', C1: '=SORT(A1:A3,,-1)' }), 'C1', 3), ['9', '2', '0']);
  // Several keys at once, given as lists.
  const keys = book({ A1: 'b', B1: '2', A2: 'a', B2: '2', A3: 'c', B3: '1', D1: '=SORT(A1:B3,{2,1},{1,1})' });
  assert.deepEqual(col(keys, 'D1', 3), ['c', 'a', 'b']);
  assert.equal(at(book({ A1: '1', C1: '=SORT(A1:A3,5)' }), 'C1'), '#VALUE!');
});

test('UNIQUE: each value once (case does not matter), or only the ones that appear once', () => {
  assert.deepEqual(col(book({ ...ORDERS, E2: '=UNIQUE(A2:A6)' }), 'E2', 5), ['Ann', 'Bob', 'cara', 'Dan', '']);
  assert.deepEqual(col(book({ ...ORDERS, E2: '=UNIQUE(B2:B6)' }), 'E2', 3), ['Paid', 'Due', '']);
  assert.deepEqual(col(book({ ...ORDERS, E2: '=UNIQUE(A2:A6,,TRUE)' }), 'E2', 4), ['Bob', 'cara', 'Dan', '']);
  // Whole rows are compared.
  assert.equal(at(book({ A1: 'a', B1: '1', A2: 'A', B2: '1', A3: 'a', B3: '2', D1: '=ROWS(UNIQUE(A1:B3))' }), 'D1'), '2');
  // A common job: how many of each, with COUNTIF given the list of names.
  const counts = book({ ...ORDERS, E2: '=UNIQUE(B2:B6)', F2: '=COUNTIF(B2:B6,E2#)' });
  assert.deepEqual(col(counts, 'F2', 2), ['3', '2']);
});

test('SEQUENCE and TRANSPOSE', () => {
  const wb = book({ A1: '=SEQUENCE(3,2,10,5)' });
  assert.deepEqual(row(wb, 'A1', 2), ['10', '15']);
  assert.deepEqual(row(wb, 'A3', 2), ['30', '35']);
  const t = book({ A1: '1', A2: '2', A3: '3', C1: '=TRANSPOSE(A1:A3)' });
  assert.deepEqual(row(t, 'C1', 3), ['1', '2', '3']);
  assert.equal(at(book({ A1: '=SEQUENCE(0)' }), 'A1'), '#CALC!');
});

test('one-value functions and operators work on every value of a list', () => {
  const wb = book({ A1: 'ab', A2: 'abcd', A3: '', A4: '0', C1: '=LEN(A1:A3)', D1: '=IF(LEN(A1:A3)>2,"long","short")', E1: '=IFERROR(1/A3:A4,"none")', F1: '=UPPER(A1:A2)&"!"' });
  assert.deepEqual(col(wb, 'C1', 3), ['2', '4', '0']);
  assert.deepEqual(col(wb, 'D1', 3), ['short', 'long', 'short']);
  assert.deepEqual(col(wb, 'E1', 2), ['none', 'none']);
  assert.deepEqual(col(wb, 'F1', 2), ['AB!', 'ABCD!']);
  // Inside SUM, a list worked out on the way (no Ctrl+Shift+Enter needed).
  const sums = book({ A1: '2', A2: '3', B1: '10', B2: '20', C1: '=SUM(A1:A2*B1:B2)', C2: '=SUM(--(A1:A2>2))', C3: '=SUM(IF(A1:A2>2,B1:B2))' });
  assert.deepEqual(col(sums, 'C1', 3), ['80', '1', '20']);
  // Lists of different sizes: the missing places are #N/A, as in Excel.
  assert.deepEqual(col(book({ A1: '={1;2;3}+{10;20}' }), 'A1', 3), ['11', '22', '#N/A']);
});

test('INDEX and MATCH on two conditions, VLOOKUP and XLOOKUP for a list of keys, SUMPRODUCT', () => {
  const t = { ...ORDERS, E1: '=INDEX(C2:C6,MATCH(1,(A2:A6="ann")*(B2:B6="Due"),0))' };
  assert.equal(at(book(t), 'E1'), '120');
  const wb = book({ ...ORDERS, E1: 'Dan', E2: 'Bob', F1: '=VLOOKUP(E1:E2,A2:C6,3,FALSE)', G1: '=XLOOKUP(E1:E2,A2:A6,B2:B6)' });
  assert.deepEqual(col(wb, 'F1', 2), ['300', '80']);
  assert.deepEqual(col(wb, 'G1', 2), ['Paid', 'Due']);
  assert.equal(at(book({ ...ORDERS, E1: '=SUMPRODUCT((B2:B6="Paid")*C2:C6)' }), 'E1'), '465');
  assert.equal(at(book({ A1: '1', A2: '2', B1: '3', B2: 'x', C1: '=SUMPRODUCT(A1:A2,B1:B2)' }), 'C1'), '3');
  assert.equal(at(book({ A1: '1', B1: '3', C1: '=SUMPRODUCT(A1:A2,B1)' }), 'C1'), '#VALUE!');
});

test('the filled cells copy as values, count in the used area, and are not saved', () => {
  const wb = book({ A1: '=SEQUENCE(2,2)' });
  assert.equal(wb.exportText(0, { c0: 0, r0: 0, c1: 1, r1: 1 }, '\t'), '1\t2\r\n3\t4');
  assert.deepEqual(wb.usedBounds(0), { cols: 2, rows: 2 });
  const again = new Workbook();
  again.load(JSON.parse(wb.serialize()));
  assert.equal(again.sheets[0].cells.size, 1);
  assert.deepEqual(row(again, 'A2', 2), ['3', '4']);
  // An empty cell inside a spilled range shows 0.
  assert.deepEqual(col(book({ A1: 'x', A3: 'y', C1: '=A1:A3' }), 'C1', 3), ['x', '0', 'y']);
});

test('a list formula that reads its own cells does not hang', () => {
  const wb = book({ A1: '1', A2: '2', B1: '=SORT(B1:B3)', C1: '=SEQUENCE(A1+C2)' });
  assert.ok(typeof at(wb, 'B1') === 'string');
  assert.ok(typeof at(wb, 'C1') === 'string');
  assert.ok(typeof at(wb, 'C2') === 'string');
});
