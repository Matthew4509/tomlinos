// Excel workbooks (.xlsx): opening one laid out as Excel writes it (shared strings, shared formulas, prefixed newer
// functions, a dynamic array formula with its saved list, theme colours, a frozen pane, a filter, merged cells), what
// is reported as left out, and saving then opening again with nothing lost. Also whole-column references (A:A).
// No browser needed. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipStore } from '../src/core/zip.ts';
import { readZip } from '../src/apps/archive/read.ts';
import { Workbook } from '../src/apps/sheet/workbook.ts';
import { parseCellRef } from '../src/apps/sheet/refs.ts';
import { fromExcelFormula, openXlsx, saveXlsx, toExcelFormula } from '../src/apps/sheet/xlsx.ts';
import { parseXml, XmlProblem } from '../src/apps/sheet/xml.ts';

const MAIN = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const at = (wb: Workbook, addr: string, s = 0): string => {
  const r = parseCellRef(addr)!;
  return wb.display(s, r.col, r.row);
};
const cellOf = (wb: Workbook, addr: string, s = 0) => {
  const r = parseCellRef(addr)!;
  return wb.sheets[s].cells.get(r.row * 256 + r.col);
};

function zip(parts: Record<string, string>): Uint8Array {
  return zipStore(Object.entries(parts).map(([name, text]) => ({ name, data: new TextEncoder().encode(text), modified: Date.UTC(2026, 9, 13) })));
}

/** A workbook as Excel 365 writes one (trimmed to what is tested). */
function excelLike(): Uint8Array {
  return zip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook ${MAIN}><workbookPr defaultThemeVersion="166925"/><bookViews><workbookView xWindow="0" activeTab="1"/></bookViews>
<sheets><sheet name="Orders" sheetId="1" r:id="rId1"/><sheet name="Chart1" sheetId="3" r:id="rId9"/><sheet name="Notes &amp; more" sheetId="2" state="hidden" r:id="rId2"/></sheets>
<definedNames><definedName name="Rate">Orders!$B$2</definedName><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">Orders!$A$1:$C$5</definedName></definedNames>
<calcPr calcId="191029"/></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet2.xml"/>
<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartsheet" Target="chartsheets/sheet1.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`,
    'xl/sharedStrings.xml': `<?xml version="1.0"?><sst ${MAIN} count="9" uniqueCount="9">
<si><t>Name</t></si><si><t>Due</t></si><si><t>Amount</t></si>
<si><r><rPr><b/></rPr><t>Ann</t></r><r><t xml:space="preserve"> Lee</t></r><rPh sb="0" eb="1"><t>ignored</t></rPh></si>
<si><t>Bob</t></si><si><t>cara</t></si><si><t>Line one_x000D_
Line two</t></si><si><t>a &lt; b &amp; c</t></si><si><t>Merged</t></si></sst>`,
    'xl/styles.xml': `<?xml version="1.0"?><styleSheet ${MAIN}>
<numFmts count="2"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/><numFmt numFmtId="165" formatCode="&quot;$&quot;#,##0.00"/></numFmts>
<fonts count="3"><font><sz val="11"/><color theme="1"/><name val="Calibri"/></font><font><b/><sz val="11"/><color theme="4" tint="-0.249977111117893"/><name val="Calibri"/></font><font><sz val="16"/><name val="Arial"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="medium"><color indexed="10"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="7"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1"><alignment horizontal="center"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"><alignment wrapText="1"/></xf>
<xf numFmtId="4" fontId="2" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet ${MAIN}><dimension ref="A1:J12"/>
<sheetViews><sheetView tabSelected="1" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/><cols><col min="1" max="1" width="20.7109375" customWidth="1"/><col min="4" max="4" width="9.140625" hidden="1"/></cols>
<sheetData>
<row r="1" ht="30" customHeight="1"><c r="A1" s="1" t="s"><v>0</v></c><c r="B1" s="1" t="s"><v>1</v></c><c r="C1" s="1" t="s"><v>2</v></c>
<c r="E1" cm="1"><f t="array" ref="E1:E4">_xlfn._xlws.SORT(C2:C5,1,-1)</f><v>300</v></c><c r="F1"><f>SUM(_xlfn.ANCHORARRAY(E1))</f><v>545</v></c>
<c r="G1"><f>_xlfn.LET(_xlpm.x,2,_xlpm.x*3)</f><v>6</v></c><c r="H1"><f>SUM(C:C)</f><v>1779.5</v></c><c r="I1"><f>Rate*2</f><v>92612</v></c><c r="J1"><f>C2+1</f><v>999</v></c></row>
<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" s="2"><v>46306</v></c><c r="C2" s="3"><v>120</v></c><c r="D2"><f t="shared" ref="D2:D5" si="0">C2*2</f><v>240</v></c><c r="E2"><v>120</v></c></row>
<row r="3"><c r="A3" t="s"><v>4</v></c><c r="B3" s="6"><v>46307.5</v></c><c r="C3" s="3"><v>80</v></c><c r="D3"><f t="shared" si="0"/><v>160</v></c><c r="E3"><v>80</v></c></row>
<row r="4" hidden="1"><c r="A4" t="s"><v>5</v></c><c r="B4" t="b"><v>1</v></c><c r="C4" s="3"><v>45</v></c><c r="D4"><f t="shared" si="0"/><v>90</v></c><c r="E4"><v>45</v></c></row>
<row r="5"><c r="A5" t="inlineStr"><is><t>Dan</t></is></c><c r="B5" t="e"><v>#N/A</v></c><c r="C5" s="3"><v>300</v></c><c r="D5"><f t="shared" si="0"/><v>600</v></c></row>
<row r="7"><c r="A7" s="4" t="s"><v>6</v></c><c r="B7" t="s"><v>7</v></c><c r="C7" s="5"><v>1234.5</v></c></row>
<row r="10"><c r="A10" t="s"><v>8</v></c></row>
<row r="6000"><c r="A6000"><v>1</v></c></row>
</sheetData>
<autoFilter ref="A1:C5"><filterColumn colId="0"><filters><filter val="Ann Lee"/><filter val="Bob"/><filter val="Dan"/></filters></filterColumn></autoFilter>
<mergeCells count="1"><mergeCell ref="A10:B11"/></mergeCells>
<conditionalFormatting sqref="C2:C5"><cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan"><formula>100</formula></cfRule></conditionalFormatting>
<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`,
    'xl/worksheets/sheet2.xml': `<?xml version="1.0"?><worksheet ${MAIN}><sheetData><row r="1"><c r="A1"><v>5</v></c><c r="B1"><f>Orders!C2+A1</f><v>125</v></c></row></sheetData></worksheet>`,
    'xl/chartsheets/sheet1.xml': '<?xml version="1.0"?><chartsheet/>',
    'xl/charts/chart1.xml': '<?xml version="1.0"?><chartSpace/>',
    'xl/comments1.xml': '<?xml version="1.0"?><comments/>',
  });
}

test('xlsx: an Excel-made workbook opens with values, formulas, formats, layout and an honest report', async () => {
  const wb = new Workbook();
  wb.dateOrder = 'dmy';
  const report = await openXlsx(wb, excelLike());
  // Sheets: the chart sheet is skipped; the hidden sheet is shown; the active tab moves to match.
  assert.deepEqual(wb.sheets.map(s => s.name), ['Orders', 'Notes & more']);
  assert.equal(wb.active, 1, 'activeTab 1 counted the chart sheet; the second sheet of cells is the active one');
  // Strings: shared, rich text runs joined (pronunciation left out), inline, _x000D_ and entities.
  assert.equal(at(wb, 'A2'), 'Ann Lee');
  assert.equal(at(wb, 'A5'), 'Dan');
  assert.equal(cellOf(wb, 'A7')?.v, 'Line one\r\nLine two');
  assert.equal(at(wb, 'B7'), 'a < b & c');
  assert.equal(at(wb, 'B4'), 'TRUE');
  assert.equal(at(wb, 'B5'), '#N/A');
  // Number formats: a custom date code, built-in 14 as this computer's short date, "$"#,##0.00 as Currency, 4 as Comma.
  assert.equal(at(wb, 'B2'), '11/10/2026');
  assert.equal(at(wb, 'B3'), '12/10/2026');
  assert.equal(at(wb, 'C2'), '$120.00');
  assert.equal(at(wb, 'C7'), '1,234.50');
  // Styles: bold, a theme colour darkened by its tint, a solid fill, a medium coloured bottom border, centred; wrap.
  const head = wb.styleOf(cellOf(wb, 'A1'))!;
  assert.equal(head.b, true);
  assert.equal(head.color, '#2f5597', 'accent 1 (4472C4) darkened by 25%');
  assert.equal(head.fill, '#ffff00');
  assert.equal(head.bb, 'medium');
  assert.equal(head.bc, '#ff0000');
  assert.equal(head.al, 'c');
  assert.equal(wb.styleOf(cellOf(wb, 'A7'))?.wrap, true);
  // Shared formulas are moved to each cell; values worked out here.
  assert.equal(cellOf(wb, 'D3')?.f, 'C3*2');
  assert.equal(cellOf(wb, 'D5')?.f, 'C5*2');
  assert.equal(at(wb, 'D5'), '600');
  // A dynamic array formula: prefixes off, Excel's saved list left out so the formula fills it here.
  assert.equal(cellOf(wb, 'E1')?.f, 'SORT(C2:C5,1,-1)');
  assert.equal(cellOf(wb, 'E2'), undefined);
  assert.deepEqual(['E1', 'E2', 'E3', 'E4'].map(a => at(wb, a)), ['300', '120', '80', '45']);
  assert.equal(cellOf(wb, 'F1')?.f, 'SUM(E1#)');
  assert.equal(at(wb, 'F1'), '545');
  // Whole columns.
  assert.equal(cellOf(wb, 'H1')?.f, 'SUM(C:C)');
  assert.equal(at(wb, 'H1'), '1779.5', 'C2:C5 and C7');
  // LET (session 7) and a named range: worked out here, the same as Excel's answers.
  assert.equal(cellOf(wb, 'G1')?.f, 'LET(x,2,x*3)');
  assert.equal(at(wb, 'G1'), '6');
  assert.equal(cellOf(wb, 'I1')?.f, 'Rate*2');
  assert.equal(at(wb, 'I1'), '92612');
  assert.deepEqual(wb.names, [{ name: 'Rate', ref: 'Orders!$B$2' }]);
  assert.equal(report.asValues.count, 0);
  // A formula whose answer here differs from Excel's saved one is listed (J1 was saved as 999; it is 121).
  assert.equal(report.differ.count, 1);
  assert.deepEqual(report.differ.examples, ['Orders!J1']);
  // Layout: widths, heights, frozen header row, hidden column and row, merge, filter with its kept values.
  const sh = wb.sheets[0];
  assert.equal(sh.colW.get(0), 145, 'Excel width 20.71 is 20 characters of 7 pixels plus 5');
  assert.equal(sh.colW.has(3), false, 'a standard width is not stored');
  assert.equal(sh.rowH.get(0), 40);
  assert.deepEqual(sh.freeze, { rows: 1, cols: 0 });
  assert.deepEqual([...sh.hiddenCols], [3]);
  assert.deepEqual([...sh.hiddenRows], [3]);
  assert.deepEqual(sh.merges, [{ c0: 0, r0: 9, c1: 1, r1: 10 }]);
  assert.deepEqual(sh.filter?.range, { c0: 0, r0: 0, c1: 2, r1: 4 });
  assert.deepEqual(sh.filter?.cols.get(0), ['Ann Lee', 'Bob', 'Dan']);
  // The other sheet's formula reads this one.
  assert.equal(at(wb, 'B1', 1), '125');
  // The report names what was left out.
  const said = report.dropped.join(' | ');
  for (const word of ['1 sheet that is not a sheet of cells', '1 hidden sheet', '1 cell past row 5,000']) {
    assert.ok(said.includes(word), `report says "${word}": ${said}`);
  }
  // Conditional formatting is kept now (session 6), so it is not in the report; the chart sheet still is.
  assert.ok(!said.includes('conditional formatting'), said);
  assert.deepEqual(sh.cf.map(e => [e.ranges, e.rule.t, (e.rule as { f1?: string }).f1]), [[[{ c0: 2, r0: 1, c1: 2, r1: 4 }], 'cell', '100']]);
  // Opened clean: nothing to undo.
  assert.equal(wb.canUndo, false);
});

test('xlsx: files that are not workbooks are refused in words', async () => {
  const wb = new Workbook();
  await assert.rejects(openXlsx(wb, new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 4])), /older Excel file \(\.xls\)/);
  await assert.rejects(openXlsx(wb, new TextEncoder().encode('just text')), /not an Excel workbook/);
  await assert.rejects(openXlsx(wb, zip({ 'word/document.xml': '<w/>' })), /not an Excel workbook/);
  // A DOCTYPE (where entity bombs live) is refused, not expanded.
  const bomb = zip({ 'xl/workbook.xml': '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><workbook/>' });
  await assert.rejects(openXlsx(wb, bomb), /document type definition/);
  assert.throws(() => parseXml('<a><b></a>'), XmlProblem);
  assert.throws(() => parseXml('<a>'), /not closed/);
});

test('xlsx: formulas move between Excel\'s spelling and ours', () => {
  assert.equal(toExcelFormula('XLOOKUP(A1,B:B,C:C)'), '_xlfn.XLOOKUP(A1,B:B,C:C)');
  assert.equal(toExcelFormula('SUM(FILTER(A1:A9,B1:B9>2))+SORT(E1#)'), 'SUM(_xlfn._xlws.FILTER(A1:A9,B1:B9>2))+_xlfn._xlws.SORT(_xlfn.ANCHORARRAY(E1))');
  assert.equal(toExcelFormula("COUNT('My data'!E1#)"), "COUNT(_xlfn.ANCHORARRAY('My data'!E1))");
  assert.equal(toExcelFormula('"XLOOKUP(" & A1'), '"XLOOKUP(" & A1', 'text is never changed');
  assert.equal(fromExcelFormula("_xlfn.ANCHORARRAY('My data'!E1)"), "'My data'!E1#");
  assert.equal(fromExcelFormula('_xlfn._xlws.FILTER(A:A,B:B="x")'), 'FILTER(A:A,B:B="x")');
  assert.equal(fromExcelFormula('SUM(Table1[Amount])'), 'SUM(Table1[Amount])', 'table references are kept as written');
  assert.equal(fromExcelFormula('_xlfn.LET(_xlpm.x,2,_xlpm.x*3)'), 'LET(x,2,x*3)');
  assert.equal(fromExcelFormula('SUM(1:1)'), null, 'whole rows cannot be read yet');
  for (const f of ['TEXTJOIN(",",TRUE,UNIQUE(A2:A9))', 'IFNA(XMATCH(A1,B:B),0)', 'SUM(Sheet2!E1#)']) assert.equal(fromExcelFormula(toExcelFormula(f)), f);
});

test('whole-column references: worked out, copied, and moved by inserted and deleted columns', () => {
  const wb = new Workbook();
  for (const [a, v] of [['A1', '5'], ['A2', '7'], ['B1', '1'], ['C1', '=SUM(A:A)'], ['C2', '=VLOOKUP(7,A:B,1,FALSE)'], ['C3', "=SUM(Sheet1!$A:A)"]]) {
    const r = parseCellRef(a)!;
    wb.setInput(0, r.col, r.row, v);
  }
  assert.equal(at(wb, 'C1'), '12');
  assert.equal(at(wb, 'C2'), '7');
  assert.equal(at(wb, 'C3'), '12');
  wb.copyBlock(0, { c0: 2, r0: 0, c1: 2, r1: 0 }, { col: 3, row: 4 });
  assert.equal(cellOf(wb, 'D5')?.f, 'SUM(B:B)', 'relative column moves, rows stay whole');
  wb.shiftAxis(0, 'col', 0, 1);
  assert.equal(cellOf(wb, 'D1')?.f, 'SUM(B:B)');
  assert.equal(cellOf(wb, 'D3')?.f, 'SUM(Sheet1!$B:B)');
  wb.shiftAxis(0, 'row', 0, 2);
  assert.equal(cellOf(wb, 'D3')?.f, 'SUM(B:B)', 'inserting rows leaves a whole column whole');
  wb.shiftAxis(0, 'col', 1, -1);
  assert.equal(cellOf(wb, 'C3')?.f, 'SUM(#REF!)');
});

test('xlsx: saving and opening again keeps values, formulas, styles and layout', async () => {
  const wb = new Workbook();
  wb.dateOrder = 'dmy';
  const put = (a: string, v: string, s = 0) => {
    const r = parseCellRef(a)!;
    wb.setInput(s, r.col, r.row, v);
  };
  put('A1', 'Name'); put('B1', 'Status'); put('C1', 'Amount'); put('D1', 'Date');
  put('A2', 'Ann'); put('B2', 'Paid'); put('C2', '120'); put('D2', '13/10/2026');
  put('A3', 'Bob'); put('B3', 'Due'); put('C3', '80'); put('D3', '14/10/2026 14:30');
  put('A4', '  spaced _x0041_ text\nline 2'); put('B4', 'Paid'); put('C4', '-45.5'); put('D4', 'TRUE');
  put('F1', '=SORT(FILTER(A2:C4,B2:B4="Paid"),3,-1)');
  put('J1', '=SUM(F1#)'); put('J2', '=XLOOKUP("Bob",A:A,C:C)'); put('J3', '=1/0'); put('J4', '=SUM(IF(C2:C4>50,1,0))');
  put('J5', '="x"&A2'); put('J6', '12%');
  wb.setStyle(0, { c0: 0, r0: 0, c1: 3, r1: 0 }, s => ({ ...s, b: true, fill: '#ffd400', bb: 'double', bc: '#2f6fd0', al: 'c' }));
  wb.setStyle(0, { c0: 2, r0: 1, c1: 2, r1: 3 }, s => ({ ...s, fmt: 'custom', code: '#,##0.00;[Red]-#,##0.00' }));
  wb.setStyle(0, { c0: 0, r0: 3, c1: 0, r1: 3 }, s => ({ ...s, wrap: true, i: true, u: true, color: '#d13438', bl: true, br: 'thick' }));
  wb.setSize(0, 'col', 0, 140);
  wb.setSize(0, 'row', 3, 44);
  wb.merge(0, { c0: 0, r0: 6, c1: 2, r1: 7 }, 'center');
  wb.setFreeze(0, 1, 1);
  wb.setHidden(0, 'col', 4, 4, true);
  wb.setFilter(0, { c0: 0, r0: 0, c1: 3, r1: 3 });
  wb.filterBy(0, 1, ['Paid']);
  wb.addSheet();
  wb.renameSheet(1, "Ann's notes");
  put('A1', "=Sheet1!C2*2", 1);
  wb.active = 1;

  const bytes = await saveXlsx(wb);
  // A real zip with the parts Excel needs, packed.
  const names = readZip(bytes).map(e => e.parts.join('/')).sort();
  for (const n of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/sharedStrings.xml', 'xl/metadata.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']) assert.ok(names.includes(n), n);
  const sheetXml = new TextDecoder().decode(await readZip(bytes).find(e => e.parts.join('/') === 'xl/worksheets/sheet1.xml')!.read());
  assert.match(sheetXml, /<c r="F1"[^>]*cm="1"><f t="array" ref="F1:H2">_xlfn\._xlws\.SORT\(_xlfn\._xlws\.FILTER\(A2:C4,B2:B4=&quot;Paid&quot;\),3,-1\)<\/f>/);
  assert.match(sheetXml, /<c r="J2"[^>]*><f[^>]*>_xlfn\.XLOOKUP\(&quot;Bob&quot;,A:A,C:C\)<\/f><v>80<\/v>/);
  assert.match(sheetXml, /<c r="J4"[^>]*cm="1"><f t="array" ref="J4">SUM\(IF\(C2:C4&gt;50,1,0\)\)<\/f>/);
  assert.match(sheetXml, /<c r="G1" t="str"><v>Paid<\/v><\/c><c r="H1"><v>120<\/v><\/c>/, 'the list a formula fills is saved as values too');
  assert.match(sheetXml, /<pane xSplit="1" ySplit="1" topLeftCell="B2" activePane="bottomRight" state="frozen"\/>/);
  assert.match(sheetXml, /<autoFilter ref="A1:D4"><filterColumn colId="1"><filters><filter val="Paid"\/><\/filters><\/filterColumn><\/autoFilter>/);
  assert.match(sheetXml, /<row r="3"[^>]*hidden="1"/);

  const back = new Workbook();
  back.dateOrder = 'dmy';
  const report = await openXlsx(back, bytes);
  assert.deepEqual(report, { dropped: [], asValues: { count: 0, examples: [], names: [] }, differ: { count: 0, examples: [] } });
  assert.deepEqual(back.sheets.map(s => s.name), ['Sheet1', "Ann's notes"]);
  assert.equal(back.active, 1);
  for (const a of ['A1', 'A2', 'A4', 'C2', 'C4', 'D2', 'D3', 'D4', 'F1', 'G1', 'H1', 'F2', 'H2', 'J1', 'J2', 'J3', 'J4', 'J5', 'J6']) {
    assert.equal(at(back, a), at(wb, a), `${a} shows the same`);
  }
  assert.equal(at(back, 'C4'), '-45.50');
  assert.equal(at(back, 'D2'), '13/10/2026');
  assert.equal(at(back, 'H1'), '120');
  assert.equal(cellOf(back, 'A4')?.v, '  spaced _x0041_ text\nline 2', 'spaces, line breaks and a literal _x0041_ survive');
  assert.equal(cellOf(back, 'F1')?.f, 'SORT(FILTER(A2:C4,B2:B4="Paid"),3,-1)');
  assert.equal(cellOf(back, 'J1')?.f, 'SUM(F1#)');
  assert.equal(at(back, 'A1', 1), '240');
  for (const a of ['A1', 'C2', 'A4', 'J6', 'A7']) assert.deepEqual(back.styleOf(cellOf(back, a)), wb.styleOf(cellOf(wb, a)), `${a} keeps its look`);
  const s0 = back.sheets[0];
  assert.equal(s0.colW.get(0), 140);
  assert.equal(s0.rowH.get(3), 44);
  assert.deepEqual(s0.merges, [{ c0: 0, r0: 6, c1: 2, r1: 7 }]);
  assert.deepEqual(s0.freeze, { rows: 1, cols: 1 });
  assert.deepEqual([...s0.hiddenCols], [4]);
  assert.deepEqual([...s0.hiddenRows], [2]);
  assert.deepEqual(s0.filter?.range, { c0: 0, r0: 0, c1: 3, r1: 3 });
  assert.deepEqual([...s0.filter!.cols], [[1, ['Paid']]]);
});
