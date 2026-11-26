// Audit of the Spreadsheet engine: faults found by trying to break it (26 Nov). Each test that fails names a fault
// still open; it passes once the fault is fixed. The faults that live in the grid (filtered rows) are in
// test/browser-audit-sheet.mjs. No browser needed. Run: node --test test/audit-sheet.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Workbook } from '../src/apps/sheet/workbook.ts';
import { parseCellRef } from '../src/apps/sheet/refs.ts';

function book(cells: Record<string, string>, wb = new Workbook(), s = 0): Workbook {
  for (const [addr, text] of Object.entries(cells)) {
    const r = parseCellRef(addr)!;
    wb.setInput(s, r.col, r.row, text);
  }
  return wb;
}
const at = (wb: Workbook, addr: string, s = 0): string => {
  const r = parseCellRef(addr)!;
  return wb.display(s, r.col, r.row);
};
const R = (a: string) => {
  const [x, y] = a.split(':');
  const p = parseCellRef(x)!;
  const q = parseCellRef(y ?? x)!;
  return { c0: p.col, r0: p.row, c1: q.col, r1: q.row };
};

test('S-P0-4: a cut from Sheet1 pasted on Sheet2 keeps its formula reading Sheet1, and formulas that read the cut cell follow it', () => {
  const wb = book({ A1: '=B1', B1: '7', C1: '=A1', D1: '9', E1: '=D1*2' });
  wb.addSheet();
  // As the grid does: Ctrl+X on Sheet1!A1, Ctrl+V on Sheet2!A1.
  wb.copyBlock(1, R('A1'), { col: 0, row: 0 }, { cut: true, fromSheet: 0 });
  assert.equal(at(wb, 'A1', 1), '7', 'the moved formula (Excel rewrites it to =Sheet1!B1)');
  assert.equal(at(wb, 'C1', 0), '7', 'Sheet1!C1 read the cut cell (Excel rewrites it to =Sheet2!A1)');
  // A plain value cut to another sheet: the formula that summed it must not drop to 0.
  wb.copyBlock(1, R('D1'), { col: 3, row: 3 }, { cut: true, fromSheet: 0 });
  assert.equal(at(wb, 'E1', 0), '18', 'Sheet1!E1 =D1*2 after D1 was moved to Sheet2!D4');
});

test('S-P0-5: a formula that points at an empty cell is 0, as in Excel, so sums, counts and averages over it are right', () => {
  const wb = book({ B1: '10', B3: '20', C1: '=B1', C2: '=B2', C3: '=B3', D1: '=AVERAGE(C1:C3)', D2: '=COUNT(C1:C3)', D3: '=ISBLANK(C2)', D4: '=COUNTBLANK(C1:C3)', D5: '=MIN(C1:C3)' });
  assert.equal(at(wb, 'C2'), '0', '=B2 with B2 empty shows 0');
  assert.deepEqual(['D1', 'D2', 'D3', 'D4', 'D5'].map(a => at(wb, a)), ['10', '3', 'FALSE', '0', '0'], 'AVERAGE, COUNT, ISBLANK, COUNTBLANK, MIN over =B1:=B3');
});

test('S-P0-8: Save as CSV keeps every digit of a number (a 12-digit phone or account number is not written as 4.47701E+11)', () => {
  const wb = book({ A1: '447700900123', A2: '12345678901234', A3: '=1/3', A4: '3.14159265358979' });
  const csv = wb.exportText(0, wb.usedRange(0), ',');
  const back = new Workbook();
  back.importText(0, 0, 0, csv);
  for (const a of ['A1', 'A2', 'A3', 'A4']) {
    const r = parseCellRef(a)!;
    assert.equal(back.value(0, r.col, r.row), wb.value(0, r.col, r.row), `${a} after Save as CSV and open again (CSV line: ${csv.split('\r\n')[r.row]})`);
  }
});

test('S-P0-9: filling down two dates a month apart goes on a month at a time (1 Jan, 1 Feb gives 1 Mar, 1 Apr)', () => {
  const wb = new Workbook();
  wb.dateOrder = 'dmy';
  book({ A1: '01/01/2024', A2: '01/02/2024' }, wb);
  wb.fill(0, R('A1:A2'), R('A1:A4'));
  assert.deepEqual([at(wb, 'A3'), at(wb, 'A4')], ['01/03/2024', '01/04/2024'], 'monthly series');
});
