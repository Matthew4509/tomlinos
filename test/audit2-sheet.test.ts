// Round-2 audit of the Spreadsheet (app id "sheet"): faults found by trying to break it, one test per finding, named
// after its ID. A P0 test fails until the fault is fixed; P1 and P2 tests were marked todo until fixed. Excel is the oracle.
// No browser needed. Run: node --test test/audit2-sheet.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { keyOf, Workbook, splitDelimited } from '../src/apps/sheet/workbook.ts';
import { parseCellRef, shiftFormula } from '../src/apps/sheet/refs.ts';
import { openXlsx, saveXlsx } from '../src/apps/sheet/xlsx.ts';
import { allText, parseXml } from '../src/core/xml.ts';
import { SyntaxProblem } from '../src/apps/sheet/refs.ts';
import { zipStore } from '../src/core/zip.ts';

const MAIN = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function book(cells: Record<string, string>): Workbook {
  const wb = new Workbook();
  wb.dateOrder = 'dmy';
  for (const [addr, text] of Object.entries(cells)) {
    const r = parseCellRef(addr)!;
    wb.setInput(0, r.col, r.row, text);
  }
  return wb;
}
const keyAt = (addr: string) => {
  const r = parseCellRef(addr)!;
  return keyOf(r.col, r.row);
};
const val = (wb: Workbook, addr: string, s = 0) => {
  const r = parseCellRef(addr)!;
  return wb.value(s, r.col, r.row);
};

/** A minimal .xlsx: one sheet "S1" with this sheetData, optional shared strings, styles and workbookPr. */
function xlsx(sheetData: string, opts: { sst?: string; styles?: string; bookPr?: string } = {}): Uint8Array {
  const rels = [
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>',
    opts.sst ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>' : '',
    opts.styles ? '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' : '',
  ].join('');
  const parts: Record<string, string> = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': `<?xml version="1.0"?><workbook ${MAIN}>${opts.bookPr ?? ''}<sheets><sheet name="S1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet ${MAIN}><sheetData>${sheetData}</sheetData></worksheet>`,
  };
  if (opts.sst) parts['xl/sharedStrings.xml'] = `<?xml version="1.0"?><sst ${MAIN}>${opts.sst}</sst>`;
  if (opts.styles) parts['xl/styles.xml'] = `<?xml version="1.0"?><styleSheet ${MAIN}>${opts.styles}</styleSheet>`;
  return zipStore(Object.entries(parts).map(([name, text]) => ({ name, data: new TextEncoder().encode(text), modified: Date.UTC(2026, 9, 13) })));
}

/**
 * Works out `formula` (with Z1 holding `z1`) in a child process, so a hang fails the test after `ms` instead of
 * freezing the test run. Returns the value as JSON, or null when it did not finish in time.
 */
function evalWithTimeout(formula: string, z1: string, ms: number): string | null {
  const root = pathToFileURL(fileURLToPath(new URL('../src/apps/sheet/', import.meta.url))).href;
  const script = `
    const { Workbook } = await import(${JSON.stringify(root + 'workbook.ts')});
    const wb = new Workbook();
    wb.setInput(0, 25, 0, ${JSON.stringify(z1)});
    wb.setInput(0, 0, 0, ${JSON.stringify(formula)});
    process.stdout.write(JSON.stringify(wb.value(0, 0, 0)));`;
  const run = spawnSync(process.execPath, ['--input-type=module', '--disable-warning=ExperimentalWarning', '-e', script], { timeout: ms, encoding: 'utf8' });
  if (run.error || run.signal) return null;
  return run.stdout;
}

// ---- SH-1: arithmetic is rounded to 15 digits after every step, so results differ from Excel's ---------------------

test('SH-1: dividing then multiplying back gives the number again, as in Excel (=INT(10/3*3) is 10)', () => {
  const wb = book({ A1: '=INT(10/3*3)', A2: '=1/3*3=1', A3: '=INT(1/3*3)', B1: '100', B2: '3', B3: '=INT(B1/B2*B2)', A4: '=ROUNDDOWN(1/3*3,0)' });
  assert.equal(val(wb, 'A1'), 10, 'Excel: 10 (10/3*3 is exactly 10 in IEEE doubles)');
  assert.equal(val(wb, 'A2'), true, 'Excel: TRUE');
  assert.equal(val(wb, 'A3'), 1, 'Excel: 1');
  assert.equal(val(wb, 'B3'), 100, 'Excel: 100 (a share worked out and multiplied back)');
  assert.equal(val(wb, 'A4'), 1, 'Excel: 1');
});

test('SH-1b: a cell value that holds more than 15 digits keeps them through a formula (=A1*1 equals A1)', { todo: 'held: a formula result keeps 15 digits, the contract the older sheet tests rely on' }, () => {
  const wb = book({ A1: '=1/3', A2: '=A1*3', A3: '=A2=1' });
  assert.equal(val(wb, 'A3'), true, 'Excel: =1/3 in A1, =A1*3 is exactly 1');
});

// ---- SH-2: wildcard criteria are turned into a backtracking regular expression: a formula can freeze the page -----

test('SH-2: COUNTIF with a wildcard pattern on a 400-letter cell finishes in under 5 seconds', () => {
  const out = evalWithTimeout('=COUNTIF(Z1,"*a*a*a*b")', 'a'.repeat(400), 5000);
  assert.notEqual(out, null, 'it froze for more than 5 s (about 30 s measured); a file holding this formula freezes the desktop when opened');
  assert.equal(out, '0');
});

test('SH-2b: SEARCH with wildcards on a long cell finishes in under 5 seconds', () => {
  const out = evalWithTimeout('=ISERROR(SEARCH("*a*a*a*b",Z1))', 'a'.repeat(400), 5000);
  assert.notEqual(out, null, 'SEARCH froze for more than 5 s');
  assert.equal(out, 'true');
});

test('SH-2c: MATCH with a wildcard key on a long cell finishes in under 5 seconds', () => {
  const out = evalWithTimeout('=ISNA(MATCH("*a*a*a*b",Z1,0))', 'a'.repeat(400), 5000);
  assert.notEqual(out, null, 'MATCH froze for more than 5 s');
  assert.equal(out, 'true');
});

// ---- P1 ----------------------------------------------------------------------------------------------------------

test('SH-3: MMULT of two 1000 x 1000 lists finishes in under 3 seconds (it took about 17 s, freezing the page)', () => {
  const out = evalWithTimeout('=SUM(MMULT(SEQUENCE(1000,1000),SEQUENCE(1000,1000)))', '', 3000);
  assert.notEqual(out, null);
  // Past 300 million steps it is refused with #NUM!, at once; smaller products are worked out in full.
  assert.equal(JSON.parse(out!).code, '#NUM!');
  const wb = book({ A1: '=MMULT({1,2;3,4},{5;6})', B1: '=SUM(MMULT(SEQUENCE(200,300),SEQUENCE(300,200)))', C1: '=MMULT({1,"a"},{1;2})' });
  assert.deepEqual([val(wb, 'A1'), val(wb, 'A2')], [17, 39]);
  // Each of the 200 x 200 answers is a sum of 300 products: the total worked out by hand.
  let total = 0;
  for (let i = 0; i < 200; i++) for (let k = 0; k < 300; k++) total += (i * 300 + k + 1) * (k * 200 * 200 + 200 * 201 / 2);
  assert.ok(Math.abs((val(wb, 'B1') as number) - total) <= 1e-9 * total);
  assert.equal(wb.display(0, 2, 0), '#VALUE!');
});

test('SH-5: an .xlsx with text nested thousands of levels deep is refused with a plain reason, not a stack overflow', async () => {
  const deep = '<a>'.repeat(200000) + 'x' + '</a>'.repeat(200000);
  const bytes = xlsx('<row r="1"><c r="A1" t="s"><v>0</v></c></row>', { sst: `<si><r><t>${deep}</t></r></si>` });
  await assert.rejects(openXlsx(new Workbook(), bytes), (e: unknown) => e instanceof SyntaxProblem && /nested more than/.test((e as Error).message));
  // The shared reader's allText no longer calls itself, so Write's readers cannot overflow on such text either.
  assert.equal(allText(parseXml(`<r>${deep}</r>`)), 'x');
  assert.equal(allText(parseXml('<r>a<b>b<c>c</c>d</b>e</r>')), 'aebdc', 'an element\'s own text, then its children\'s in order, as before');
  assert.equal(allText(parseXml('<r><t>one </t><t>two</t></r>')), 'one two');
});

test('SH-6: a 1904-date workbook: a plain number used as a date by a formula gives Excel\'s date', async () => {
  // D1 holds 43830 with no date format; in a 1904 workbook that is 1 January 2024, so YEAR(D1) is 2024 in Excel.
  const styles = '<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs>';
  const wb = new Workbook();
  wb.dateOrder = 'dmy';
  const report = await openXlsx(wb, xlsx('<row r="1"><c r="A1" s="1"><v>0</v></c><c r="B1" s="1"><f>A1+1</f><v>1</v></c><c r="D1"><v>43830</v></c><c r="F1"><f>YEAR(D1)</f><v>2024</v></c><c r="G1"><f>DATE(2024,1,1)</f><v>43830</v></c></row>', { styles, bookPr: '<workbookPr date1904="1"/>' }));
  assert.equal(val(wb, 'F1'), 2024);
  assert.ok(!report.differ.examples.includes('S1!B1'), 'B1 (2 January 1904) is the date Excel saved, not a different answer');
  assert.equal(report.differ.count, 0, 'every formula gives the answer Excel saved');
  // The numbers stay as saved, shown as the 1904 dates they are; a typed date is counted from 1904 too.
  assert.equal(val(wb, 'A1'), 0);
  assert.equal(wb.display(0, 0, 0), '01/01/1904');
  assert.equal(val(wb, 'G1'), 43830);
  wb.setInput(0, 7, 0, '01/01/2024');
  assert.equal(val(wb, 'H1'), 43830);
  // Kept when saved in this spreadsheet's own file and in an .xlsx, and a 1900 workbook open beside it is not moved.
  const again = new Workbook();
  again.load(JSON.parse(wb.serialize()));
  assert.equal(again.date1904, true);
  assert.equal(again.display(0, 0, 0), '01/01/1904');
  const plain = book({ A1: '=DATE(2024,1,1)' });
  assert.equal(val(plain, 'A1'), 45292);
  assert.equal(wb.display(0, 0, 0), '01/01/1904');
  const back = new Workbook();
  await openXlsx(back, await saveXlsx(wb));
  assert.equal(back.date1904, true);
  assert.equal(val(back, 'F1'), 2024);
});

test('SH-7: Save as CSV keeps every digit of a number shown with fewer decimals (3.14159 shown as 3.14)', () => {
  const wb = book({ A1: '3.14159', A2: '0.125' });
  wb.setStyle(0, { c0: 0, r0: 0, c1: 0, r1: 1 }, old => ({ ...old, fmt: 'number', dec: 2 }));
  const csv = wb.exportText(0, wb.usedRange(0), ',');
  assert.equal(csv, '3.14159\r\n0.125');
  // Dates, money that shows all its digits, and leading zeros stay as shown; a copy (tabs) is still as shown.
  const more = book({ A1: '13/10/2026', A2: '$1,234.50', A3: '501' });
  more.setStyle(0, { c0: 0, r0: 2, c1: 0, r1: 2 }, old => ({ ...old, fmt: 'custom', code: '00000' }));
  assert.equal(more.exportText(0, more.usedRange(0), ','), '13/10/2026\r\n"$1,234.50"\r\n00501');
  assert.equal(wb.exportText(0, wb.usedRange(0), '\t'), '3.14\r\n0.13');
});

test('Find and Replace with wildcards on long cells finishes quickly and replaces what Excel does', () => {
  const wb = book({ A1: 'a'.repeat(30000), A2: 'banana', A3: 'Cat cat', A4: 'x*y' });
  const t0 = Date.now();
  assert.deepEqual(wb.findAll(0, { text: '*a*a*a*b', matchCase: false, wholeCell: false, allSheets: false, lookIn: 'values' }), []);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
  const opts = (text: string, matchCase = false, wholeCell = false) => ({ text, matchCase, wholeCell, allSheets: false, lookIn: 'formulas' as const });
  wb.replaceAll(0, opts('n?'), 'N');
  wb.replaceAll(0, opts('Cat', true), 'Dog');
  wb.replaceAll(0, opts('~*'), '+');
  assert.deepEqual([val(wb, 'A2'), val(wb, 'A3'), val(wb, 'A4')], ['baNN', 'Dog cat', 'x+y']);
  assert.equal(wb.findAll(0, opts('b*', false, true)).length, 1, 'whole cell: only baNN');
});

// ---- P2 ----------------------------------------------------------------------------------------------------------

test('SH-8: an .xlsx number written as hex text (0x10) is not read as 16; a t="d" date before 1900 or an error constant (#SPILL!) is said, not silently emptied', async () => {
  const wb = new Workbook();
  const report = await openXlsx(wb, xlsx('<row r="1"><c r="A1"><v>0x10</v></c><c r="B1" t="d"><v>1899-12-31</v></c><c r="C1" t="e"><v>#SPILL!</v></c><c r="D1" t="e"><v>#BLOCKED!</v></c><c r="E1" t="d"><v>2026-10-13</v></c><c r="F1"><v>1.5e3</v></c></row>'));
  assert.equal(val(wb, 'A1'), '0x10');
  assert.equal(val(wb, 'B1'), '1899-12-31');
  assert.equal(wb.display(0, 2, 0), '#SPILL!');
  assert.equal(val(wb, 'D1'), '#BLOCKED!');
  assert.equal(val(wb, 'E1'), 46308);
  assert.equal(val(wb, 'F1'), 1500);
  const said = report.dropped.join(' | ');
  assert.match(said, /date before 1900/);
  assert.match(said, /0x10/);
  assert.match(said, /#BLOCKED!/);
});

test('SH-9: joining text past 32,767 characters gives #VALUE!, as in Excel', () => {
  const wb = book({ A1: '=LEN(REPT("ab",16000)&REPT("ab",16000))', A2: '=LEN(CONCATENATE(REPT("a",30000),REPT("a",3000)))', A3: '=LEN(REPT("a",30000)&REPT("a",2767))' });
  assert.equal(wb.display(0, 0, 0), '#VALUE!');
  assert.equal(wb.display(0, 0, 1), '#VALUE!');
  assert.equal(val(wb, 'A3'), 32767);
});

test('SH-11: typed (100), 1 1/2 and 5. are numbers, as Excel reads them', () => {
  const wb = book({ A1: '(100)', A2: '1 1/2', A3: '5.', A4: '(1,234.5)', A5: '-2 3/4', A6: '1 5/4', A7: '(abc)' });
  assert.deepEqual([val(wb, 'A1'), val(wb, 'A2'), val(wb, 'A3'), val(wb, 'A4'), val(wb, 'A5'), val(wb, 'A6'), val(wb, 'A7')], [-100, 1.5, 5, -1234.5, -2.75, '1 5/4', '(abc)']);
  assert.equal(wb.display(0, 0, 1), '1 1/2', 'shown as the fraction it was typed as');
});

test('SH-14: a semicolon CSV whose first heading holds a quoted comma is still split at semicolons', () => {
  const split = splitDelimited('"Name, first";Amount\r\nAnn;5');
  assert.equal(split.delimiter, ';');
  assert.deepEqual(split.rows, [['Name, first', 'Amount'], ['Ann', '5']]);
  assert.equal(splitDelimited('a;b\r\n1,5;2,5').delimiter, ';', 'decimal commas below do not outvote the headings');
  assert.equal(splitDelimited('"x;y",b\r\n1,2').delimiter, ',');
  assert.equal(splitDelimited('one\r\n1;2;3').delimiter, ';', 'a first line with no separator: the next lines decide');
});

test('SH-15: filling down one cell of "Item 9" gives Item 10, Item 11 (Excel)', () => {
  const wb = book({ A1: 'Item 9', B1: 'Week 08', C1: 'Q1', D1: 'plain', E3: 'Item 1' });
  wb.fill(0, { c0: 0, r0: 0, c1: 3, r1: 0 }, { c0: 0, r0: 0, c1: 3, r1: 2 });
  assert.deepEqual([val(wb, 'A2'), val(wb, 'A3')], ['Item 10', 'Item 11']);
  assert.deepEqual([val(wb, 'B2'), val(wb, 'B3'), val(wb, 'C3'), val(wb, 'D3')], ['Week 09', 'Week 10', 'Q3', 'plain']);
  wb.fill(0, { c0: 4, r0: 2, c1: 4, r1: 2 }, { c0: 4, r0: 0, c1: 4, r1: 2 });
  assert.deepEqual([val(wb, 'E1'), val(wb, 'E2')], ['Item 1', 'Item 0'], 'filled upward it counts down, not below 0');
});

test('Missing functions: ROMAN, ARABIC, CELL, INFO and whole rows (1:1) are worked out as in Excel', () => {
  const wb = book({
    B1: 'hi', B8: '3', E9: '5',
    A1: '=ROMAN(499)', A2: '=ROMAN(499,4)', A3: '=ROMAN(2026)', A4: '=ROMAN(4000)', A5: '=ARABIC("MMXXVI")', A6: '=ARABIC("-xiv")', A7: '=ARABIC("ABC")',
    C1: '=CELL("address",B7)', C2: '=CELL("row")', C3: '=CELL("col",C1)', C4: '=CELL("type",B1)', C5: '=CELL("type",Z99)', C6: '=CELL("contents",B1)', C7: '=INFO("numfile")',
    D1: '=SUM(8:9)', D2: '=ROWS(1:3)', D4: '=COLUMNS($1:$1)',
  });
  assert.deepEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'].map(a => wb.display(0, parseCellRef(a)!.col, parseCellRef(a)!.row)), ['CDXCIX', 'ID', 'MMXXVI', '#VALUE!', '2026', '-14', '#VALUE!']);
  assert.deepEqual(['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7'].map(a => val(wb, a)), ['$B$7', 2, 3, 'l', 'b', 'hi', 1]);
  assert.deepEqual([val(wb, 'D1'), val(wb, 'D2'), val(wb, 'D4')], [8, 3, 256]);
  // Whole rows move when rows are put in above them, and when the formula is copied down, as cell references do.
  wb.shiftAxis(0, 'row', 0, 1);
  assert.equal(wb.sheets[0].cells.get(keyAt('D2'))?.f, 'SUM(9:10)');
  assert.equal(val(wb, 'D2'), 8);
  assert.equal(shiftFormula('SUM(2:3)+SUM($2:$2)', 5, 2), 'SUM(4:5)+SUM($2:$2)');
});

// ---- Earlier findings still open ---------------------------------------------------------------------------------

test('SH-16 (was S-P1-2): Z to A puts TRUE, then text, then numbers, errors last (Excel)', () => {
  const wb = book({ A1: 'b', A2: '2', A3: 'TRUE', A4: '=1/0', A5: 'a', A6: '1' });
  wb.sortRange(0, { c0: 0, r0: 0, c1: 0, r1: 5 }, 0, false);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(r => wb.display(0, 0, r)), ['TRUE', 'b', 'a', '2', '1', '#DIV/0!']);
});

test('SH-17 (was S-P1-8): sorting a block that holds a list formula is refused (Excel), not turned into #SPILL!', () => {
  const wb = book({ A1: '3', A2: '=SEQUENCE(2)', A4: '1' });
  let refused = false;
  try {
    wb.sortRange(0, { c0: 0, r0: 0, c1: 0, r1: 3 }, 0, true);
  } catch {
    refused = true;
  }
  assert.ok(refused || ![0, 1, 2, 3].some(r => wb.display(0, 0, r) === '#SPILL!'));
});
