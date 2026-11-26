// Round-2 audit of the Spreadsheet (app id "sheet"): faults found by trying to break it, one test per finding, named
// after its ID. A P0 test fails until the fault is fixed; P1 and P2 tests are marked todo. Excel is the oracle.
// No browser needed. Run: node --test test/audit2-sheet.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Workbook, splitDelimited } from '../src/apps/sheet/workbook.ts';
import { parseCellRef } from '../src/apps/sheet/refs.ts';
import { openXlsx } from '../src/apps/sheet/xlsx.ts';
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

test('SH-3: MMULT of two 1000 x 1000 lists finishes in under 3 seconds (it took about 17 s, freezing the page)', { todo: 'P1' }, () => {
  const out = evalWithTimeout('=SUM(MMULT(SEQUENCE(1000,1000),SEQUENCE(1000,1000)))', '', 3000);
  assert.notEqual(out, null);
});

test('SH-5: an .xlsx with text nested thousands of levels deep is refused with a plain reason, not a stack overflow', { todo: 'P1' }, async () => {
  const deep = '<a>'.repeat(200000) + 'x' + '</a>'.repeat(200000);
  const bytes = xlsx('<row r="1"><c r="A1" t="s"><v>0</v></c></row>', { sst: `<si><r><t>${deep}</t></r></si>` });
  await assert.rejects(openXlsx(new Workbook(), bytes), (e: unknown) => e instanceof SyntaxProblem);
});

test('SH-6: a 1904-date workbook: a plain number used as a date by a formula gives Excel\'s date', { todo: 'P1' }, async () => {
  // D1 holds 43830 with no date format; in a 1904 workbook that is 1 January 2024, so YEAR(D1) is 2024 in Excel.
  const styles = '<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs>';
  const wb = new Workbook();
  wb.dateOrder = 'dmy';
  const report = await openXlsx(wb, xlsx('<row r="1"><c r="A1" s="1"><v>0</v></c><c r="B1" s="1"><f>A1+1</f><v>1</v></c><c r="D1"><v>43830</v></c><c r="F1"><f>YEAR(D1)</f><v>2024</v></c></row>', { styles, bookPr: '<workbookPr date1904="1"/>' }));
  assert.equal(val(wb, 'F1'), 2024);
  assert.ok(!report.differ.examples.includes('S1!B1'), 'B1 (2 January 1904) is the date Excel saved, not a different answer');
});

test('SH-7: Save as CSV keeps every digit of a number shown with fewer decimals (3.14159 shown as 3.14)', { todo: 'P1' }, () => {
  const wb = book({ A1: '3.14159', A2: '0.125' });
  wb.setStyle(0, { c0: 0, r0: 0, c1: 0, r1: 1 }, old => ({ ...old, fmt: 'number', dec: 2 }));
  const csv = wb.exportText(0, wb.usedRange(0), ',');
  assert.equal(csv, '3.14159\r\n0.125');
});

// ---- P2 ----------------------------------------------------------------------------------------------------------

test('SH-8: an .xlsx number written as hex text (0x10) is not read as 16; a t="d" date before 1900 or an error constant (#SPILL!) is said, not silently emptied', { todo: 'P2' }, async () => {
  const wb = new Workbook();
  const report = await openXlsx(wb, xlsx('<row r="1"><c r="A1"><v>0x10</v></c><c r="B1" t="d"><v>1899-12-31</v></c><c r="C1" t="e"><v>#SPILL!</v></c></row>'));
  assert.notEqual(val(wb, 'A1'), 16);
  assert.ok(report.dropped.length > 0 || val(wb, 'C1') !== null, 'the #SPILL! cell vanished without a word');
});

test('SH-9: joining text past 32,767 characters gives #VALUE!, as in Excel', { todo: 'P2' }, () => {
  const wb = book({ A1: '=LEN(REPT("ab",16000)&REPT("ab",16000))' });
  assert.equal(String(val(wb, 'A1')), '#VALUE!');
});

test('SH-11: typed (100), 1 1/2 and 5. are numbers, as Excel reads them', { todo: 'P2' }, () => {
  const wb = book({ A1: '(100)', A2: '1 1/2', A3: '5.' });
  assert.deepEqual([val(wb, 'A1'), val(wb, 'A2'), val(wb, 'A3')], [-100, 1.5, 5]);
});

test('SH-14: a semicolon CSV whose first heading holds a quoted comma is still split at semicolons', { todo: 'P2' }, () => {
  const split = splitDelimited('"Name, first";Amount\r\nAnn;5');
  assert.equal(split.delimiter, ';');
});

test('SH-15: filling down one cell of "Item 9" gives Item 10, Item 11 (Excel)', { todo: 'P2' }, () => {
  const wb = book({ A1: 'Item 9' });
  wb.fill(0, { c0: 0, r0: 0, c1: 0, r1: 0 }, { c0: 0, r0: 0, c1: 0, r1: 2 });
  assert.deepEqual([val(wb, 'A2'), val(wb, 'A3')], ['Item 10', 'Item 11']);
});

// ---- Earlier findings still open ---------------------------------------------------------------------------------

test('SH-16 (was S-P1-2): Z to A puts TRUE, then text, then numbers, errors last (Excel)', { todo: 'P1' }, () => {
  const wb = book({ A1: 'b', A2: '2', A3: 'TRUE', A4: '=1/0', A5: 'a', A6: '1' });
  wb.sortRange(0, { c0: 0, r0: 0, c1: 0, r1: 5 }, 0, false);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(r => wb.display(0, 0, r)), ['TRUE', 'b', 'a', '2', '1', '#DIV/0!']);
});

test('SH-17 (was S-P1-8): sorting a block that holds a list formula is refused (Excel), not turned into #SPILL!', { todo: 'P1' }, () => {
  const wb = book({ A1: '3', A2: '=SEQUENCE(2)', A4: '1' });
  let refused = false;
  try {
    wb.sortRange(0, { c0: 0, r0: 0, c1: 0, r1: 3 }, 0, true);
  } catch {
    refused = true;
  }
  assert.ok(refused || ![0, 1, 2, 3].some(r => wb.display(0, 0, r) === '#SPILL!'));
});
