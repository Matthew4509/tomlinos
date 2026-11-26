// Faults found in the spreadsheet walk: Cut keeps formulas working, SUMIF shows an error it adds up, AND/OR over blanks,
// whole-row message, sizes past the sheet's edge. No browser needed. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Workbook } from '../src/apps/sheet/workbook.ts';
import { MAX_ROWS, SyntaxProblem } from '../src/apps/sheet/refs.ts';

test('Cut and paste moves a formula as it is, and formulas that read it follow it', () => {
  const wb = new Workbook();
  wb.setInput(0, 0, 0, '10'); // A1
  wb.setInput(0, 1, 0, '=A1*2'); // B1
  wb.setInput(0, 3, 0, '=B1'); // D1
  wb.setInput(0, 4, 0, '=SUM(A1:B1)'); // E1: a range only partly cut stays
  wb.copyBlock(0, { c0: 1, r0: 0, c1: 1, r1: 0 }, { col: 2, row: 0 }, { cut: true });
  assert.equal(wb.editText(0, 2, 0), '=A1*2');
  assert.equal(wb.value(0, 2, 0), 20);
  assert.equal(wb.editText(0, 3, 0), '=C1');
  assert.equal(wb.value(0, 3, 0), 20);
  assert.equal(wb.editText(0, 4, 0), '=SUM(A1:B1)');
  wb.undo();
  assert.equal(wb.editText(0, 1, 0), '=A1*2');
  assert.equal(wb.editText(0, 3, 0), '=B1');
  assert.equal(wb.editText(0, 2, 0), '');
});

test('Cutting a block moves a range that lies wholly inside it, and formulas inside it that read each other', () => {
  const wb = new Workbook();
  wb.setInput(0, 0, 0, '1');
  wb.setInput(0, 0, 1, '2');
  wb.setInput(0, 0, 2, '=SUM(A1:A2)');
  wb.setInput(0, 2, 0, '=SUM(A1:A2)+A3');
  wb.copyBlock(0, { c0: 0, r0: 0, c1: 0, r1: 2 }, { col: 5, row: 0 }, { cut: true });
  assert.equal(wb.editText(0, 5, 2), '=SUM(F1:F2)');
  assert.equal(wb.editText(0, 2, 0), '=SUM(F1:F2)+F3');
  assert.equal(wb.value(0, 2, 0), 6);
});

test('Copy still shifts relative references', () => {
  const wb = new Workbook();
  wb.setInput(0, 0, 0, '10');
  wb.setInput(0, 1, 0, '=A1*2');
  wb.copyBlock(0, { c0: 1, r0: 0, c1: 1, r1: 0 }, { col: 2, row: 0 });
  assert.equal(wb.editText(0, 2, 0), '=B1*2');
});

test('SUMIF and AVERAGEIF give the error of a cell they would add up', () => {
  const wb = new Workbook();
  wb.setInput(0, 0, 0, '1');
  wb.setInput(0, 0, 1, '2');
  wb.setInput(0, 1, 0, '=1/0');
  wb.setInput(0, 1, 1, '5');
  assert.deepEqual((wb.evalFormula(0, 'SUMIF(A1:A2,">0",B1:B2)') as { code: string }).code, '#DIV/0!');
  assert.deepEqual((wb.evalFormula(0, 'AVERAGEIF(A1:A2,">0",B1:B2)') as { code: string }).code, '#DIV/0!');
  assert.equal(wb.evalFormula(0, 'SUMIF(A1:A2,">1",B1:B2)'), 5, 'an error in a row that does not match is left alone');
});

test('AND and OR over only blank cells are #VALUE!', () => {
  const wb = new Workbook();
  assert.equal((wb.evalFormula(0, 'AND(F1:F3)') as { code: string }).code, '#VALUE!');
  assert.equal((wb.evalFormula(0, 'OR(F1:F3)') as { code: string }).code, '#VALUE!');
  wb.setInput(0, 5, 0, 'TRUE');
  assert.equal(wb.evalFormula(0, 'AND(F1:F3)'), true);
});

test('=SUM(2:2) adds up the whole of row 2 (whole rows, as in Excel)', () => {
  const wb = new Workbook();
  wb.setInput(0, 1, 1, '4');
  wb.setInput(0, 7, 1, '5');
  wb.setInput(0, 0, 0, '=SUM(2:2)');
  assert.equal(wb.value(0, 0, 0), 9);
  assert.throws(() => wb.setInput(0, 0, 0, '=SUM(1:)'), (e: Error) => e instanceof SyntaxProblem);
});

test('a row height past the last row is ignored, so a file keeps what it was given', () => {
  const wb = new Workbook();
  wb.setSize(0, 'row', MAX_ROWS, 40);
  assert.equal(wb.sheets[0].rowH.size, 0);
});
