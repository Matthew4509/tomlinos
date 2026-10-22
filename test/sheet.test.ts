// The spreadsheet engine: formulas, copying, inserting, sorting, undo, CSV and the saved file. No browser needed.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Workbook, parseDelimited } from '../src/apps/sheet/workbook.ts';
import { shiftFormula, SyntaxProblem, parseCellRef } from '../src/apps/sheet/refs.ts';

/** A workbook with the given cells typed in ("A1": "5"). */
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

test('arithmetic follows the usual order, and floating noise is hidden', () => {
  const wb = book({ A1: '=1+2*3', A2: '=(1+2)*3', A3: '=-2^2', A4: '=0.1+0.2', A5: '=10/4', A6: '=2^3^2', A7: '=50%*10', A8: '="a"&"b"&1' });
  assert.deepEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8'].map(a => at(wb, a)), ['7', '9', '4', '0.3', '2.5', '64', '5', 'ab1']);
});

test('SUM, AVERAGE, MIN, MAX, COUNT over ranges skip text and blanks', () => {
  const wb = book({ A1: '10', A2: '20', A3: 'hello', A5: '30', B1: '=SUM(A1:A5)', B2: '=AVERAGE(A1:A5)', B3: '=MIN(A1:A5)', B4: '=MAX(A1:A5)', B5: '=COUNT(A1:A5)', B6: '=COUNTA(A1:A5)', B7: '=SUM(A1:A2,100)' });
  assert.deepEqual(['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7'].map(a => at(wb, a)), ['60', '20', '10', '30', '3', '4', '130']);
});

test('errors: divide by zero, unknown function, text in arithmetic, and they spread', () => {
  const wb = book({ A1: '=1/0', A2: '=NOPE(1)', A3: '="x"+1', A4: '=A1+1', A5: '=IFERROR(A1,"fine")', A6: '=SUM(A1,2)' });
  assert.deepEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'A6'].map(a => at(wb, a)), ['#DIV/0!', '#NAME?', '#VALUE!', '#DIV/0!', 'fine', '#DIV/0!']);
});

test('a formula that refers to itself, directly or in a loop, says so instead of hanging', () => {
  const wb = book({ A1: '=B1+1', B1: '=A1+1', C1: '=C1' });
  assert.equal(at(wb, 'A1'), '#CIRC!');
  assert.equal(at(wb, 'C1'), '#CIRC!');
});

test('IF, AND, OR, comparisons, text compare ignores case', () => {
  const wb = book({ A1: '5', B1: '=IF(A1>3,"big","small")', B2: '=IF(AND(A1>1,A1<10),1,0)', B3: '=OR(A1=1,A1=5)', B4: '="Apple"="apple"', B5: '=IF(A1<1,"x")' });
  assert.deepEqual(['B1', 'B2', 'B3', 'B4', 'B5'].map(a => at(wb, a)), ['big', '1', 'TRUE', 'TRUE', 'FALSE']);
});

test('ROUND rounds half away from zero; text functions; SUMIF and COUNTIF with conditions', () => {
  const wb = book({
    A1: '=ROUND(2.5,0)', A2: '=ROUND(-2.5,0)', A3: '=ROUND(1.005,2)', A4: '=ROUNDDOWN(9.99,1)', A5: '=UPPER("ab")&LEFT("hello",2)&LEN("xyz")',
    B1: 'a', B2: 'b', B3: 'a', C1: '1', C2: '2', C3: '3',
    D1: '=SUMIF(B1:B3,"a",C1:C3)', D2: '=COUNTIF(C1:C3,">1")', D3: '=SUMIF(C1:C3,">=2")', D4: '=COUNTIF(B1:B3,"a*")',
  });
  assert.deepEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'D1', 'D2', 'D3', 'D4'].map(a => at(wb, a)), ['3', '-3', '1.01', '9.9', 'ABhe3', '4', '2', '5', '2']);
});

test('VLOOKUP and INDEX/MATCH find values, exact and approximate', () => {
  const wb = book({ A1: '1', B1: 'one', A2: '5', B2: 'five', A3: '10', B3: 'ten', D1: '=VLOOKUP(5,A1:B3,2,FALSE)', D2: '=VLOOKUP(7,A1:B3,2)', D3: '=VLOOKUP(6,A1:B3,2,FALSE)', D4: '=INDEX(B1:B3,MATCH(10,A1:A3,0))' });
  assert.deepEqual(['D1', 'D2', 'D3', 'D4'].map(a => at(wb, a)), ['five', 'five', '#N/A', 'ten']);
});

test('typing: numbers, percent, currency, text kept as text, a leading apostrophe', () => {
  const wb = book({ A1: '1,234.5', A2: '12%', A3: '$5', A4: "'007", A5: 'TRUE', A6: '007' });
  assert.deepEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'A6'].map(a => at(wb, a)), ['1234.5', '12%', '$5.00', '007', 'TRUE', '7']);
  assert.equal(wb.editText(0, 0, 1), '12%');
  assert.equal(wb.editText(0, 0, 3), "'007");
});

test('a formula written wrongly is refused with a reason and changes nothing', () => {
  const wb = book({ A1: '5' });
  assert.throws(() => wb.setInput(0, 0, 0, '=SUM(1,'), SyntaxProblem);
  assert.throws(() => wb.setInput(0, 0, 0, '=1+'), SyntaxProblem);
  assert.throws(() => wb.setInput(0, 0, 0, '=1 $ 2'), SyntaxProblem);
  assert.equal(at(wb, 'A1'), '5');
});

test('copying a formula shifts relative references and keeps $ ones', () => {
  assert.equal(shiftFormula('A1+$B$2+C$3+$D4', 1, 2), 'B3+$B$2+D$3+$D6');
  assert.equal(shiftFormula('SUM(A1:B2)', 0, 1), 'SUM(A2:B3)');
  assert.equal(shiftFormula('A1', -1, 0), '#REF!');
  const wb = book({ A1: '1', A2: '2', B1: '=A1*10' });
  wb.copyBlock(0, { c0: 1, r0: 0, c1: 1, r1: 0 }, { col: 1, row: 1 });
  assert.equal(at(wb, 'B2'), '20');
});

test('fill down copies, continues a number series, and adjusts formulas', () => {
  const wb = book({ A1: '1', A2: '2', B1: '=A1*2', C1: 'x' });
  wb.fill(0, { c0: 0, r0: 0, c1: 2, r1: 0 }, { c0: 0, r0: 0, c1: 2, r1: 3 });
  assert.equal(at(wb, 'A4'), '1');
  assert.equal(at(wb, 'B3'), '2');
  assert.equal(at(wb, 'C3'), 'x');
  const s = book({ A1: '1', A2: '2' });
  s.fill(0, { c0: 0, r0: 0, c1: 0, r1: 1 }, { c0: 0, r0: 0, c1: 0, r1: 4 });
  assert.deepEqual(['A3', 'A4', 'A5'].map(a => at(s, a)), ['3', '4', '5']);
});

test('inserting a row moves cells and stretches SUM ranges; deleting one shrinks them or gives #REF!', () => {
  const wb = book({ A1: '1', A2: '2', A3: '3', A4: '=SUM(A1:A3)', B1: '=A2' });
  wb.shiftAxis(0, 'row', 1, 1);
  assert.equal(at(wb, 'A5'), '6');
  assert.equal(wb.editText(0, 0, 4), '=SUM(A1:A4)');
  assert.equal(wb.editText(0, 1, 0), '=A3');
  wb.shiftAxis(0, 'row', 1, -1);
  assert.equal(at(wb, 'A4'), '6');
  const gone = book({ A1: '1', A2: '2', B1: '=A2' });
  gone.shiftAxis(0, 'row', 1, -1);
  assert.equal(at(gone, 'B1'), '#REF!');
});

test('inserting and deleting columns move the columns and their formulas', () => {
  const wb = book({ A1: '4', B1: '=A1*2' });
  wb.shiftAxis(0, 'col', 0, 1);
  assert.equal(wb.editText(0, 2, 0), '=B1*2');
  assert.equal(at(wb, 'C1'), '8');
});

test('sorting rows by a column, ascending and descending, formulas follow their rows', () => {
  const wb = book({ A1: 'pear', B1: '3', A2: 'apple', B2: '1', A3: 'fig', B3: '2', C1: '=B1*2' });
  wb.sortRange(0, { c0: 0, r0: 0, c1: 2, r1: 2 }, 1, true);
  assert.deepEqual(['A1', 'A2', 'A3'].map(a => at(wb, a)), ['apple', 'fig', 'pear']);
  assert.equal(at(wb, 'C3'), '6');
  wb.sortRange(0, { c0: 0, r0: 0, c1: 1, r1: 2 }, 0, false);
  assert.deepEqual(['A1', 'A2', 'A3'].map(a => at(wb, a)), ['pear', 'fig', 'apple']);
});

test('undo and redo walk back through edits, including row inserts', () => {
  const wb = book({ A1: '1' });
  wb.setInput(0, 0, 0, '2');
  wb.setInput(0, 0, 1, '=A1+1');
  assert.equal(at(wb, 'A2'), '3');
  wb.undo();
  assert.equal(at(wb, 'A2'), '');
  wb.undo();
  assert.equal(at(wb, 'A1'), '1');
  wb.redo();
  wb.redo();
  assert.equal(at(wb, 'A2'), '3');
  wb.shiftAxis(0, 'row', 0, 1);
  assert.equal(at(wb, 'A3'), '3');
  wb.undo();
  assert.equal(at(wb, 'A2'), '3');
});

test('styles: bold and number formats apply to a range and survive typing', () => {
  const wb = book({ A1: '1234.5' });
  wb.setStyle(0, { c0: 0, r0: 0, c1: 0, r1: 0 }, s => ({ ...s, fmt: 'currency', b: true }));
  assert.equal(at(wb, 'A1'), '$1,234.50');
  wb.setInput(0, 0, 0, '99');
  assert.equal(at(wb, 'A1'), '$99.00');
  assert.equal(wb.styleOf(wb.sheets[0].cells.get(0))?.b, true);
});

test('another sheet can be referred to by name, and a renamed or deleted sheet is followed', () => {
  const wb = book({ A1: '7' });
  wb.addSheet();
  wb.setInput(1, 0, 0, '=Sheet1!A1*2');
  assert.equal(wb.display(1, 0, 0), '14');
  wb.renameSheet(0, 'Sales 2026');
  assert.equal(wb.editText(1, 0, 0), "='Sales 2026'!A1*2");
  assert.equal(wb.display(1, 0, 0), '14');
  wb.deleteSheet(0);
  assert.equal(wb.display(0, 0, 0), '#REF!');
});

test('CSV: quotes, commas, line breaks, semicolons; export defuses text that would run as a formula elsewhere', () => {
  assert.deepEqual(parseDelimited('a,"b,c","d ""q"""\r\n1,2,3'), [['a', 'b,c', 'd "q"'], ['1', '2', '3']]);
  assert.deepEqual(parseDelimited('a;b\n1;2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseDelimited('"x\ny",z'), [['x\ny', 'z']]);
  const wb = new Workbook();
  wb.importText(0, 0, 0, 'name,total\n=cmd|evil,5\n"a,b",2');
  assert.equal(at(wb, 'A3'), 'a,b');
  const csv = wb.exportText(0, wb.usedRange(0), ',');
  assert.ok(csv.includes('"a,b"'));
  wb.setInput(0, 0, 4, "'=HYPERLINK(1)");
  assert.ok(wb.exportText(0, { c0: 0, r0: 4, c1: 0, r1: 4 }, ',').startsWith("'="), 'a text cell beginning with = is defused');
});

test('CSV export: only text that would run as a formula is defused; a phone number or a lone dash is left as it is', () => {
  const wb = new Workbook();
  const texts = ['+64 21 555 0100', '-', '+SUM(A1)', '-1+2', '@cmd', '- item'];
  texts.forEach((t, row) => wb.setInput(0, 0, row, `'${t}`));
  const out = wb.exportText(0, { c0: 0, r0: 0, c1: 0, r1: texts.length - 1 }, ',').split('\r\n');
  assert.deepEqual(out, ['+64 21 555 0100', '-', "'+SUM(A1)", "'-1+2", "'@cmd", "'- item"]);
});

test('CSV split at semicolons: a decimal comma reads as a number, and 1,500 is one and a half', () => {
  const wb = new Workbook();
  wb.importText(0, 0, 0, 'item;price;weight\nbolt;1,5;1,500\nnut;1.234,5;12,5%');
  assert.equal(wb.value(0, 1, 1), 1.5);
  assert.equal(wb.value(0, 2, 1), 1.5);
  assert.equal(wb.value(0, 1, 2), 1234.5);
  assert.equal(wb.value(0, 2, 2), 0.125);
  const comma = new Workbook();
  comma.importText(0, 0, 0, 'a\tb\n"1,500"\t2', '\t');
  assert.equal(comma.value(0, 0, 1), 1500, 'outside a semicolon CSV, 1,500 keeps its thousands comma');
});

test('save and load round-trip; a hostile or damaged file is refused with a reason', () => {
  const wb = book({ A1: '5', A2: '=A1*2', A3: 'text' });
  wb.setStyle(0, { c0: 0, r0: 0, c1: 0, r1: 0 }, s => ({ ...s, b: true, fill: '#ffff00' }));
  const saved = wb.serialize();
  const again = new Workbook();
  again.load(JSON.parse(saved));
  assert.equal(at(again, 'A2'), '10');
  assert.equal(again.styleOf(again.sheets[0].cells.get(0))?.fill, '#ffff00');
  for (const bad of [null, 5, { format: 'nope' }, { format: 'tomlinos-sheet', sheets: [] }, { format: 'tomlinos-sheet', sheets: [{ name: 'x', cells: [[99999, 0, 1, null, 0]] }] },
    { format: 'tomlinos-sheet', sheets: [{ name: 'x', cells: [] }, { name: 'X', cells: [] }] }]) {
    assert.throws(() => new Workbook().load(bad), SyntaxProblem);
  }
  const old = new Workbook();
  old.load({ format: 'myiaos-sheet', sheets: [{ name: 'x', cells: [[0, 0, 7, null, 0]] }] });
  assert.equal(JSON.parse(old.serialize()).format, 'tomlinos-sheet', 'a file saved before the rename opens and is saved with the new tag');
  const wild = new Workbook();
  wild.load({ format: 'tomlinos-sheet', styles: [{}, { fill: 'url(javascript:alert(1))', color: '#zzz', b: 'yes' }], sheets: [{ name: 'x', cells: [[0, 0, 1, null, 1]] }] });
  assert.deepEqual(wild.styleOf(wild.sheets[0].cells.get(0)), {}, 'a style with unsafe or invalid values is reduced to nothing');
});

test('a long chain of dependent cells is worked out in order without overflowing', () => {
  const wb = new Workbook();
  wb.setInput(0, 0, 0, '1');
  for (let r = 1; r < 1000; r++) wb.setInput(0, 0, r, `=A${r}+1`);
  assert.equal(wb.display(0, 0, 999), '1000');
});
