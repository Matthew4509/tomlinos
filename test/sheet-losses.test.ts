// Nothing left out without a word: a CSV, import or paste bigger than a sheet says how many rows and columns did not
// fit; text files from Excel on Windows (Windows-1252) and UTF-16 read right; and the parts of an Excel file this
// spreadsheet does not keep (grouping, tab colours, turned text, shrink to fit, whole-row and whole-column formats) are
// in the report, so saving over the file asks first. No browser needed. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipStore } from '../src/core/zip.ts';
import { cutInWords, decodeText, splitDelimited, Workbook } from '../src/apps/sheet/workbook.ts';
import { MAX_COLS, MAX_ROWS } from '../src/apps/sheet/refs.ts';
import { openXlsx, saveXlsx } from '../src/apps/sheet/xlsx.ts';

const MAIN = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function zip(parts: Record<string, string>): Uint8Array {
  return zipStore(Object.entries(parts).map(([name, text]) => ({ name, data: new TextEncoder().encode(text), modified: Date.UTC(2026, 9, 21) })));
}

/** A one-sheet workbook; `sheetPr`, `cols`, `rows` and `xfs` go into it as given. */
function book(o: { sheetPr?: string; cols?: string; rows: string; xfs?: string }): Uint8Array {
  return zip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': `<?xml version="1.0"?><workbook ${MAIN}><sheets><sheet name="Jobs" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': `<?xml version="1.0"?><styleSheet ${MAIN}><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border/></borders><cellXfs><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>${o.xfs ?? ''}</cellXfs></styleSheet>`,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet ${MAIN}>${o.sheetPr ?? ''}${o.cols ? `<cols>${o.cols}</cols>` : ''}<sheetData>${o.rows}</sheetData></worksheet>`,
  });
}

const lines = (n: number, width = 1) => Array.from({ length: n }, (_, i) => Array.from({ length: width }, (_, c) => `${i}-${c}`).join(',')).join('\r\n');

test('a CSV longer than a sheet: the rows past the edge are counted and said, not dropped quietly', () => {
  const wb = new Workbook();
  wb.importText(0, 0, 0, lines(MAX_ROWS + 37));
  assert.deepEqual(wb.lastCut, { rows: 37, cols: 0 });
  assert.match(cutInWords(wb.lastCut), /^37 rows did not fit and were left out: a sheet here holds 5,000 rows/);
  assert.equal(wb.display(0, 0, MAX_ROWS - 1), `${MAX_ROWS - 1}-0`);
});

test('an import started part-way down counts the rows that run off the bottom from there', () => {
  const wb = new Workbook();
  wb.importText(0, 0, MAX_ROWS - 10, lines(25));
  assert.deepEqual(wb.lastCut, { rows: 15, cols: 0 });
});

test('fields past the last column are counted too, from the widest row', () => {
  const wb = new Workbook();
  wb.importText(0, 2, 0, `${lines(1, MAX_COLS + 3)}\r\nshort`);
  assert.deepEqual(wb.lastCut, { rows: 0, cols: 5 });
  assert.match(cutInWords(wb.lastCut), /^5 columns did not fit and were left out/);
  assert.match(cutInWords({ rows: 1, cols: 0 }), /^1 row did not fit and was left out/);
});

test('a file that fits leaves nothing to say, and the next import does not repeat an old cut', () => {
  const wb = new Workbook();
  wb.importText(0, 0, 0, lines(MAX_ROWS + 1));
  wb.importText(0, 0, 0, 'a,b\n1,2');
  assert.deepEqual(wb.lastCut, { rows: 0, cols: 0 });
  assert.equal(cutInWords(wb.lastCut), '');
});

test('a pasted block (tabs) past the edge is counted the same way', () => {
  const wb = new Workbook();
  wb.importText(0, 0, MAX_ROWS - 1, 'a\tb\nc\td\ne\tf', '\t');
  assert.deepEqual(wb.lastCut, { rows: 2, cols: 0 });
});

test('splitDelimited keeps a sheet of rows but counts them all, with line breaks inside quotes', () => {
  const split = splitDelimited(`"one\nstill one",x\n${lines(MAX_ROWS + 4)}`);
  assert.equal(split.rows.length, MAX_ROWS);
  assert.equal(split.rowCount, MAX_ROWS + 5);
  assert.equal(split.rows[0][0], 'one\nstill one');
});

test('text files: UTF-8 with or without its mark, Windows-1252 from Excel, and UTF-16 all read right', () => {
  const utf8 = new TextEncoder().encode('Price,£5,café');
  assert.equal(decodeText(utf8), 'Price,£5,café');
  assert.equal(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8])), 'Price,£5,café');
  // "£5,café" as Excel's "CSV (Comma delimited)" writes it on Windows: one byte each for £ and é.
  assert.equal(decodeText(new Uint8Array([0xa3, 0x35, 0x2c, 0x63, 0x61, 0x66, 0xe9])), '£5,café');
  // "€" is 0x80 in Windows-1252 (not a Latin-1 control character).
  assert.equal(decodeText(new Uint8Array([0x80, 0x31])), '€1');
  const le = new Uint8Array([0xff, 0xfe, 0xa3, 0x00, 0x35, 0x00]);
  assert.equal(decodeText(le), '£5');
  const be = new Uint8Array([0xfe, 0xff, 0x00, 0xa3, 0x00, 0x35]);
  assert.equal(decodeText(be), '£5');
});

test('Excel parts not kept here are reported: grouping, tab colour, turned text, shrink to fit, row and column formats', async () => {
  const wb = new Workbook();
  const report = await openXlsx(wb, book({
    sheetPr: '<sheetPr><tabColor rgb="FFFF0000"/></sheetPr>',
    cols: '<col min="2" max="4" width="12" customWidth="1" outlineLevel="1"/><col min="6" max="6" width="9.140625" style="1"/>',
    xfs: '<xf numFmtId="0" fontId="0" fillId="0" borderId="0"><alignment textRotation="90"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0"><alignment shrinkToFit="1"/></xf>',
    rows: '<row r="1"><c r="A1" s="1"><v>1</v></c><c r="B1" s="2"><v>2</v></c><c r="C1" s="2"><v>3</v></c></row>'
      + '<row r="2" outlineLevel="1"><c r="A2"><v>4</v></c></row><row r="3" s="1" customFormat="1"><c r="A3"><v>5</v></c></row>',
  }));
  const said = report.dropped.join('\n');
  assert.match(said, /grouped rows or columns/);
  assert.match(said, /the colour of 1 sheet tab/);
  assert.match(said, /1 cell with text set at an angle/);
  assert.match(said, /2 cells set to shrink text to fit/);
  assert.match(said, /formatting set on whole rows or columns/);
  assert.equal(wb.display(0, 0, 2), '5');
});

test('a plain file says none of them, and neither does a file this spreadsheet saved itself', async () => {
  const plain = new Workbook();
  const first = await openXlsx(plain, book({ cols: '<col min="1" max="1" width="20" customWidth="1"/>', rows: '<row r="1" ht="30" customHeight="1"><c r="A1"><v>1</v></c></row>' }));
  assert.deepEqual(first.dropped, []);
  const own = new Workbook();
  own.setInput(0, 0, 0, '12');
  own.setStyle(0, { c0: 0, r0: 0, c1: 0, r1: 0 }, old => ({ ...old, b: true, al: 'c', wrap: true }));
  const again = await openXlsx(new Workbook(), await saveXlsx(own));
  assert.deepEqual(again.dropped, []);
});
