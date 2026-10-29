// The spreadsheet at its edges: the sheet's own edge, long chains of formulas, blanks, big ranges, filling upward, and
// actions that change many cells being one step for Undo. No browser needed.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Workbook } from '../src/apps/sheet/workbook.ts';
import { MAX_COLS, MAX_ROWS, parseCellRef, SyntaxProblem } from '../src/apps/sheet/refs.ts';

function book(cells: Record<string, string>): Workbook {
  const wb = new Workbook();
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

test('a cell past the sheet\'s edge is refused, never written over another cell', () => {
  const wb = book({ A4: 'important' });
  assert.throws(() => wb.setInput(0, MAX_COLS, 2, '=SUM(A3:IV3)'), SyntaxProblem);
  assert.throws(() => wb.setInput(0, 0, MAX_ROWS, '1'), SyntaxProblem);
  assert.throws(() => wb.setInput(0, -1, 0, '1'), SyntaxProblem);
  assert.equal(at(wb, 'A4'), 'important');
  // The file still opens.
  const again = new Workbook();
  again.load(JSON.parse(wb.serialize()));
  assert.equal(again.display(0, 0, 3), 'important');
});

test('a running total 3,000 rows long works out every row, even when the bottom is looked at first', () => {
  const wb = new Workbook();
  wb.setInput(0, 0, 0, '1');
  wb.batch(() => {
    for (let r = 1; r < 3000; r++) wb.setInput(0, 0, r, `=A${r}+1`);
  });
  assert.equal(wb.display(0, 0, 2999), '3000');
  assert.equal(wb.display(0, 0, 1500), '1501');
  wb.setInput(0, 0, 0, '10');
  assert.equal(wb.display(0, 0, 2999), '3009', 'after an edit, the bottom first again');
  // A chain of nested calls is not mistaken for a formula that does not read.
  const nest = new Workbook();
  nest.setInput(0, 1, 0, '1');
  nest.batch(() => {
    for (let r = 1; r < 1500; r++) nest.setInput(0, 1, r, `=IF(B${r}>0,SUM(B${r},1),0)`);
  });
  assert.equal(nest.display(0, 1, 1499), '1500');
  for (let r = 0; r < 1500; r += 100) assert.notEqual(nest.display(0, 1, r), '#NAME?');
});

test('a blank cell equals "" and 0 and FALSE; COUNTIF "<>" counts the filled cells, "=" the empty ones', () => {
  const wb = book({ A4: 'x', A6: '5', B1: '=A1=""', B2: '=IF(A1="","empty","full")', B3: '=A1=0', B4: '=A1=FALSE', B5: '=COUNTIF(A4:A8,"<>")', B6: '=COUNTIF(A4:A8,"=")', B7: '=COUNTIF(A4:A8,"<>x")' });
  assert.deepEqual(['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7'].map(a => at(wb, a)), ['TRUE', 'empty', 'TRUE', 'TRUE', '2', '3', '4']);
});

test('a number joined into text keeps every digit', () => {
  const wb = book({ A1: '123456789012', B1: '=A1&""', B2: '=LEN(A1)', B3: '=LEFT(A1,3)', B4: '="Total: "&0.1+0.2' });
  assert.deepEqual(['B1', 'B2', 'B3', 'B4'].map(a => at(wb, a)), ['123456789012', '12', '123', 'Total: 0.3']);
});

test('MIN and MAX over a very big range', () => {
  // 30 columns of 5,000 rows: 150,000 numbers, more than a browser can spread into one call.
  const wb = new Workbook();
  const rows = (from: number) => Array.from({ length: 2500 }, (_, i) => Array.from({ length: 30 }, (_, c) => String((from + i) * 30 + c + 1)).join('\t')).join('\n');
  wb.importText(0, 0, 0, rows(0));
  wb.importText(0, 0, 2500, rows(2500));
  wb.setInput(0, 31, 0, '=MIN(A1:AD5000)');
  wb.setInput(0, 31, 1, '=MAX(A1:AD5000)');
  assert.equal(wb.display(0, 31, 0), '1');
  assert.equal(wb.display(0, 31, 1), '150000');
});

test('an argument left empty is a blank, not #NAME?', () => {
  // Shown empty, as a formula pointing at an empty cell is here, and 0 in arithmetic.
  const wb = book({ A1: '=IF(1>2,"y",)', A2: '=SUM(1,,2)', A3: '=CONCATENATE("a",,"b")', A4: '=IF(1>2,"y",)+5' });
  assert.deepEqual(['A1', 'A2', 'A3', 'A4'].map(a => at(wb, a)), ['', '3', 'ab', '5']);
});

test('filling upward runs the series back from its first number', () => {
  const wb = book({ A5: '1', A6: '2', C1: '1', D1: '2' });
  wb.fill(0, { c0: 0, r0: 4, c1: 0, r1: 5 }, { c0: 0, r0: 2, c1: 0, r1: 5 });
  assert.deepEqual(['A3', 'A4', 'A5', 'A6'].map(a => at(wb, a)), ['-1', '0', '1', '2']);
  wb.fill(0, { c0: 2, r0: 0, c1: 3, r1: 0 }, { c0: 0, r0: 0, c1: 3, r1: 0 });
  assert.deepEqual(['A1', 'B1', 'C1', 'D1'].map(a => at(wb, a)), ['-1', '0', '1', '2']);
  wb.fill(0, { c0: 0, r0: 4, c1: 0, r1: 5 }, { c0: 0, r0: 4, c1: 0, r1: 7 });
  assert.deepEqual(['A7', 'A8'].map(a => at(wb, a)), ['3', '4']);
});

test('several changes in one batch are one Undo', () => {
  const wb = book({ A1: '1', B1: '2' });
  wb.batch(() => {
    wb.setInput(0, 0, 1, '=SUM(A1)');
    wb.setInput(0, 1, 1, '=SUM(B1)');
    wb.copyBlock(0, { c0: 0, r0: 0, c1: 1, r1: 0 }, { col: 0, row: 4 });
  });
  assert.deepEqual(['A2', 'B2', 'A5', 'B5'].map(a => at(wb, a)), ['1', '2', '1', '2']);
  wb.undo();
  assert.deepEqual(['A2', 'B2', 'A5', 'B5', 'A1'].map(a => at(wb, a)), ['', '', '', '', '1']);
  wb.redo();
  assert.deepEqual(['A2', 'B5'].map(a => at(wb, a)), ['1', '2']);
});

test('a sheet rename that would make a formula too long is refused, and a file holding such a formula still opens', () => {
  const wb = new Workbook();
  wb.addSheet();
  assert.equal(wb.sheets[1].name, 'Sheet2');
  // About 4,000 letters, each part naming Sheet2: renaming Sheet2 to a long name with spaces more than doubles it.
  const sum = (ref: string) => `SUM(${Array(130).fill(ref).join(',')})`;
  const long = `=${[0, 1, 2].map(() => sum('Sheet2!A1')).join('+')}`;
  assert.ok(long.length > 3800 && long.length <= 4000);
  wb.setInput(0, 0, 0, long);
  wb.setInput(1, 0, 0, '1');
  assert.equal(at(wb, 'A1'), '390');
  assert.throws(() => wb.renameSheet(1, 'Quarterly results 2026'), SyntaxProblem);
  assert.equal(wb.sheets[1].name, 'Sheet2', 'the sheet keeps its name');
  assert.equal(wb.editText(0, 0, 0), long, 'the formula is as it was');
  assert.equal(at(wb, 'A1'), '390');
  // A short new name still goes through.
  wb.renameSheet(1, 'Totals');
  assert.ok(wb.editText(0, 0, 0).startsWith('=SUM(Totals!A1,'));
  // A file saved before this was refused (a formula past the limit) opens, with that formula kept.
  const raw = JSON.parse(wb.serialize());
  const tooLong = `=${[0, 1, 2].map(() => sum("'Quarterly results 2026'!A1")).join('+')}`;
  raw.sheets[0].cells.find((c: unknown[]) => c[0] === 0 && c[1] === 0)[3] = tooLong.slice(1);
  const again = new Workbook();
  again.load(raw);
  assert.equal(again.editText(0, 0, 0), tooLong);
});
