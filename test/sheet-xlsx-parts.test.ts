// Excel files with charts, conditional formatting, data validation and page setup: saved here and opened again with
// nothing lost; and parts laid out as Excel writes them (theme colours, rich-text titles, Excel 2010's list rules,
// print titles) read in, with what cannot be kept reported. No browser needed. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipStore } from '../src/core/zip.ts';
import { readZip } from '../src/apps/archive/read.ts';
import { chartFromRange, type Chart } from '../src/apps/sheet/chart.ts';
import { cfLook } from '../src/apps/sheet/condfmt.ts';
import { defaultPage } from '../src/apps/sheet/print.ts';
import { parseCellRef } from '../src/apps/sheet/refs.ts';
import { newValidation, validationAt } from '../src/apps/sheet/validate.ts';
import { Workbook } from '../src/apps/sheet/workbook.ts';
import { openXlsx, saveXlsx } from '../src/apps/sheet/xlsx.ts';

const MAIN = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const R = (a: string) => {
  const [x, y] = a.split(':').map(t => parseCellRef(t)!);
  const z = y ?? x;
  return { c0: x.col, r0: x.row, c1: z.col, r1: z.row };
};
const put = (wb: Workbook, cells: Record<string, string>, s = 0) => {
  for (const [a, v] of Object.entries(cells)) {
    const r = parseCellRef(a)!;
    wb.setInput(s, r.col, r.row, v);
  }
};
const partText = async (bytes: Uint8Array, name: string) => new TextDecoder().decode(await readZip(bytes).find(e => e.parts.join('/') === name)!.read());

function sample(): Workbook {
  const wb = new Workbook();
  wb.dateOrder = 'dmy';
  put(wb, { A1: 'Month', B1: 'Sales', C1: 'Costs', A2: 'Jan', B2: '120', C2: '80', A3: 'Feb', B3: '150', C3: '95', A4: 'Mar', B4: '90', C4: '70', E1: 'Paid', E2: 'Due' });
  const col = chartFromRange(wb, 0, R('A1:C4'), 'column');
  wb.addChart(0, { ...col, title: 'Sales and costs', legend: 'b', xTitle: 'Month', yTitle: 'Dollars', labels: true, at: { col: 5, row: 1, dx: 10, dy: 4 }, w: 480, h: 288 });
  wb.addChart(0, { ...chartFromRange(wb, 0, R('A1:B4'), 'pie'), at: { col: 5, row: 18, dx: 0, dy: 0 }, w: 320, h: 240 });
  wb.addChart(0, { ...col, type: 'bar', group: 'stacked', title: '', series: col.series.map((s, i) => (i ? { ...s, colour: '#d13438' } : s)), at: { col: 12, row: 1, dx: 0, dy: 0 }, w: 400, h: 260 });
  wb.addChart(0, { ...chartFromRange(wb, 0, R('B1:C4'), 'scatter'), at: { col: 12, row: 18, dx: 0, dy: 0 }, w: 400, h: 260 });
  wb.addChart(0, { ...col, type: 'line', at: { col: 0, row: 30, dx: 0, dy: 0 }, w: 400, h: 260 });
  wb.setCf(0, [
    { ranges: [R('B2:B4')], rule: { t: 'cell', op: 'gt', f1: '100', fmt: { fill: '#ffc7ce', color: '#9c0006' } }, stop: true },
    { ranges: [R('C2:C4'), R('E1:E2')], rule: { t: 'cell', op: 'between', f1: '$B$2', f2: '75', fmt: { b: true } } },
    { ranges: [R('A2:A4')], rule: { t: 'text', op: 'begins', text: 'J', fmt: { i: true, color: '#006100' } } },
    { ranges: [R('B2:C4')], rule: { t: 'top', n: 2, percent: true, bottom: true, fmt: { u: true } } },
    { ranges: [R('B2:B4')], rule: { t: 'avg', below: true, fmt: { fill: '#ffeb9c' } } },
    { ranges: [R('A1:A4')], rule: { t: 'dup', unique: true, fmt: { fill: '#c6efce' } } },
    { ranges: [R('D1:D4')], rule: { t: 'blank', not: true, fmt: { fill: '#dddddd' } } },
    { ranges: [R('B2:B4')], rule: { t: 'expr', f: 'B2>C2*1.5', fmt: { color: '#2f6fd0' } } },
    { ranges: [R('C2:C4')], rule: { t: 'scale', colours: ['#f8696b', '#ffeb84', '#63be7b'] } },
    { ranges: [R('B2:B4')], rule: { t: 'bar', colour: '#638ec6' } },
  ]);
  wb.setValidation(0, R('E1:E10'), { ...newValidation([]), type: 'list', f1: '"Paid,Due,Late"', dropdown: true, prompt: { show: true, title: 'Status', text: 'Pick one' }, error: { show: true, style: 'warning', title: 'Odd status', text: 'Not in the list' } });
  wb.setValidation(0, R('B2:C10'), { ...newValidation([]), type: 'decimal', op: 'between', f1: '0', f2: '1000', blank: false });
  wb.setValidation(0, R('G1'), { ...newValidation([]), type: 'list', f1: '$A$2:$A$4', dropdown: false });
  wb.setValidation(0, R('H1'), { ...newValidation([]), type: 'custom', f1: 'ISNUMBER(H1)', error: { show: false, style: 'info', title: '', text: '' } });
  wb.setPage(0, { ...defaultPage('letter'), orient: 'landscape', fit: { w: 1, h: 0 }, gridlines: true, headings: true, centerH: true, area: R('A1:R40'), titleRows: [0, 0], titleCols: [0, 0], header: '&L&A&RPage &P of &N', footer: '&C&F && more', margins: { t: 1, b: 1, l: 0.5, r: 0.5, header: 0.4, footer: 0.4 }, order: 'over' });
  return wb;
}

test('charts, rules, validation and page setup survive being saved as .xlsx and opened again', async () => {
  const wb = sample();
  const bytes = await saveXlsx(wb);
  const names = readZip(bytes).map(e => e.parts.join('/'));
  for (const n of ['xl/drawings/drawing1.xml', 'xl/drawings/_rels/drawing1.xml.rels', 'xl/worksheets/_rels/sheet1.xml.rels', 'xl/charts/chart1.xml', 'xl/charts/chart5.xml']) assert.ok(names.includes(n), n);
  const types = await partText(bytes, '[Content_Types].xml');
  assert.match(types, /PartName="\/xl\/charts\/chart5\.xml" ContentType="application\/vnd\.openxmlformats-officedocument\.drawingml\.chart\+xml"/);
  assert.match(types, /PartName="\/xl\/drawings\/drawing1\.xml" ContentType="application\/vnd\.openxmlformats-officedocument\.drawing\+xml"/);
  const sheet = await partText(bytes, 'xl/worksheets/sheet1.xml');
  // Excel refuses a worksheet whose parts are out of order: checked here.
  const order = ['sheetPr', 'dimension', 'sheetViews', 'sheetFormatPr', 'sheetData', 'conditionalFormatting', 'dataValidations', 'printOptions', 'pageMargins', 'pageSetup', 'headerFooter', 'drawing'];
  const at = order.map(t => sheet.indexOf(`<${t}`));
  assert.ok(at.every(i => i >= 0), `every part is there: ${order.filter((_, i) => at[i] < 0)}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'in schema order');
  assert.match(sheet, /<pageSetup paperSize="1" fitToWidth="1" fitToHeight="0" pageOrder="overThenDown" orientation="landscape"\/>/);
  assert.match(sheet, /<oddFooter>&amp;C&amp;F &amp;&amp; more<\/oddFooter>/);
  assert.match(sheet, /<dataValidation type="list" errorStyle="warning" allowBlank="1" showInputMessage="1" showErrorMessage="1" errorTitle="Odd status" error="Not in the list" promptTitle="Status" prompt="Pick one" sqref="E1:E10"><formula1>&quot;Paid,Due,Late&quot;<\/formula1>/);
  assert.match(sheet, /<cfRule type="cellIs" dxfId="0" priority="1" stopIfTrue="1" operator="greaterThan"><formula>100<\/formula><\/cfRule>/);
  assert.match(sheet, /<cfRule type="beginsWith" dxfId="2" priority="3" operator="beginsWith" text="J"><formula>LEFT\(A2,LEN\(&quot;J&quot;\)\)=&quot;J&quot;<\/formula>/);
  const book = await partText(bytes, 'xl/workbook.xml');
  assert.match(book, /<definedName name="_xlnm.Print_Area" localSheetId="0">'Sheet1'!\$A\$1:\$R\$40<\/definedName>/);
  assert.match(book, /<definedName name="_xlnm.Print_Titles" localSheetId="0">'Sheet1'!\$A:\$A,'Sheet1'!\$1:\$1<\/definedName>/);
  const styles = await partText(bytes, 'xl/styles.xml');
  assert.match(styles, /<dxfs count="8"><dxf><font><color rgb="FF9C0006"\/><\/font><fill><patternFill><bgColor rgb="FFFFC7CE"\/><\/patternFill><\/fill><\/dxf>/);
  const chart1 = await partText(bytes, 'xl/charts/chart1.xml');
  // Excel refuses a chart whose parts are out of the schema's order: the chart, its group, a series, an axis.
  const inOrder = (xml: string, tags: string[], what: string) => {
    const at = tags.map(t => xml.indexOf(`<c:${t}`));
    assert.ok(at.every(i => i >= 0), `${what}: every part is there (${tags.filter((_, i) => at[i] < 0)})`);
    assert.deepEqual([...at].sort((a, b) => a - b), at, `${what}: in schema order`);
  };
  inOrder(chart1, ['title', 'autoTitleDeleted', 'plotArea', 'legend', 'plotVisOnly', 'dispBlanksAs'], 'chart');
  inOrder(chart1, ['barDir', 'grouping', 'varyColors', 'ser', 'dLbls', 'gapWidth', 'axId'], 'bar group');
  inOrder(chart1.slice(chart1.indexOf('<c:ser>')), ['idx', 'order', 'tx', 'spPr', 'invertIfNegative', 'cat', 'val'], 'series');
  inOrder(chart1.slice(chart1.indexOf('<c:valAx>')), ['axId', 'scaling', 'delete', 'axPos', 'majorGridlines', 'title', 'numFmt', 'majorTickMark', 'minorTickMark', 'tickLblPos', 'crossAx', 'crosses', 'crossBetween'], 'value axis');
  const line = await partText(bytes, 'xl/charts/chart5.xml');
  inOrder(line.slice(line.indexOf('<c:ser>')), ['idx', 'order', 'tx', 'spPr', 'marker', 'cat', 'val', 'smooth'], 'line series');
  assert.match(chart1, /<c:barChart><c:barDir val="col"\/><c:grouping val="clustered"\/>/);
  assert.match(chart1, /<c:tx><c:strRef><c:f>Sheet1!\$B\$1<\/c:f><c:strCache><c:ptCount val="1"\/><c:pt idx="0"><c:v>Sales<\/c:v><\/c:pt><\/c:strCache>/);
  assert.match(chart1, /<c:val><c:numRef><c:f>Sheet1!\$B\$2:\$B\$4<\/c:f><c:numCache><c:formatCode>General<\/c:formatCode><c:ptCount val="3"\/><c:pt idx="0"><c:v>120<\/c:v>/);
  const drawing = await partText(bytes, 'xl/drawings/drawing1.xml');
  // 480 x 288 pixels from F2 (+10, +4): to M16, 42 px in and 12 px down (10 + 480 - 7 x 64; 4 + 288 - 14 x 20), in EMU (9525 a pixel).
  assert.match(drawing, /<xdr:from><xdr:col>5<\/xdr:col><xdr:colOff>95250<\/xdr:colOff><xdr:row>1<\/xdr:row><xdr:rowOff>38100<\/xdr:rowOff><\/xdr:from><xdr:to><xdr:col>12<\/xdr:col><xdr:colOff>400050<\/xdr:colOff><xdr:row>15<\/xdr:row><xdr:rowOff>114300<\/xdr:rowOff><\/xdr:to>/);

  const back = new Workbook();
  back.dateOrder = 'dmy';
  const report = await openXlsx(back, bytes);
  assert.deepEqual(report.dropped, [], 'nothing left out');
  const strip = (c: Chart) => ({ ...c, id: 0 });
  assert.deepEqual(back.sheets[0].charts.map(strip), wb.sheets[0].charts.map(strip));
  assert.deepEqual(back.sheets[0].cf, wb.sheets[0].cf);
  assert.deepEqual(back.sheets[0].dv, wb.sheets[0].dv);
  assert.deepEqual(back.sheets[0].page, wb.sheets[0].page);
  // Every cell looks the same as before.
  for (let r = 0; r < 6; r++) for (let c = 0; c < 8; c++) assert.deepEqual(cfLook(back, 0, c, r), cfLook(wb, 0, c, r), `cell ${c},${r}`);
  assert.deepEqual(cfLook(back, 0, 1, 2), { fill: '#ffc7ce', color: '#9c0006' }, 'B3: the first rule holds and stops the rest');
  assert.equal(validationAt(back, 0, 4, 5)?.error.style, 'warning');
});

/** A workbook laid out as Excel 365 writes these parts (trimmed). */
function excelMade(): Uint8Array {
  const parts: Record<string, string> = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': `<?xml version="1.0"?><workbook ${MAIN}><sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Lists" sheetId="2" r:id="rId2"/></sheets>
<definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">Data!$A$1:$D$20,Data!$F$1:$G$5</definedName><definedName name="_xlnm.Print_Titles" localSheetId="0">Data!$2:$3</definedName></definedNames></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': `<?xml version="1.0"?><styleSheet ${MAIN}><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><cellXfs count="1"><xf/></cellXfs>
<dxfs count="2"><dxf><font><color rgb="FF9C0006"/></font><fill><patternFill><bgColor rgb="FFFFC7CE"/></patternFill></fill></dxf><dxf><font><b/><color theme="4"/></font></dxf></dxfs></styleSheet>`,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet ${MAIN} xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main" xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main">
<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><cols><col min="1" max="1" width="18.7109375" customWidth="1"/></cols>
<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>9</v></c></row><row r="2"><c r="A2"><v>5</v></c></row></sheetData>
<conditionalFormatting sqref="A1:A9"><cfRule type="iconSet" priority="3"><iconSet iconSet="3Arrows"><cfvo type="percent" val="0"/><cfvo type="percent" val="33"/><cfvo type="percent" val="67"/></iconSet></cfRule>
<cfRule type="cellIs" dxfId="0" priority="2" operator="lessThan"><formula>3</formula></cfRule></conditionalFormatting>
<conditionalFormatting sqref="B1:B9"><cfRule type="expression" dxfId="1" priority="1"><formula>B1&gt;MAX($A$1:$A$9)</formula></cfRule>
<cfRule type="timePeriod" dxfId="0" priority="4" timePeriod="today"><formula>FLOOR(B1,1)=TODAY()</formula></cfRule></conditionalFormatting>
<dataValidations count="1"><dataValidation type="whole" operator="greaterThan" allowBlank="1" showErrorMessage="1" sqref="A1:A9"><formula1>0</formula1></dataValidation></dataValidations>
<printOptions gridLines="1"/><pageMargins left="0.25" right="0.25" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>
<pageSetup paperSize="9" orientation="landscape" fitToHeight="0" r:id="rId9"/><headerFooter><oddFooter>&amp;CPage &amp;P</oddFooter></headerFooter>
<rowBreaks count="1" manualBreakCount="1"><brk id="10" max="16383" man="1"/></rowBreaks>
<drawing r:id="rId1"/>
<extLst><ext uri="{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}"><x14:dataValidations count="1"><x14:dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1"><x14:formula1><xm:f>Lists!$A$1:$A$3</xm:f></x14:formula1><xm:sqref>C1:C9</xm:sqref></x14:dataValidation></x14:dataValidations></ext></extLst></worksheet>`,
    'xl/worksheets/_rels/sheet1.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>',
    'xl/worksheets/sheet2.xml': `<?xml version="1.0"?><worksheet ${MAIN}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Red</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Blue</t></is></c></row></sheetData></worksheet>`,
    'xl/drawings/drawing1.xml': `<?xml version="1.0"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>3</xdr:col><xdr:colOff>9525</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>8</xdr:col><xdr:colOff>19050</xdr:colOff><xdr:row>16</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Chart 1"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>
<xdr:oneCellAnchor><xdr:from><xdr:col>10</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="3048000" cy="1905000"/>
<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="3" name="Chart 2"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId2"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>`,
    'xl/drawings/_rels/drawing1.xml.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart2.xml"/></Relationships>`,
    'xl/charts/chart1.xml': `<?xml version="1.0"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart>
<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>Sales </a:t></a:r><a:r><a:t>by month</a:t></a:r></a:p></c:rich></c:tx></c:title><c:autoTitleDeleted val="0"/>
<c:plotArea><c:layout/><c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>
<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>Data!$B$1</c:f></c:strRef></c:tx><c:spPr><a:ln w="28575"><a:solidFill><a:schemeClr val="accent2"><a:lumMod val="75000"/></a:schemeClr></a:solidFill></a:ln></c:spPr><c:cat><c:numRef><c:f>Data!$A$2:$A$9</c:f></c:numRef></c:cat><c:val><c:numRef><c:f>Data!$B$2:$B$9</c:f></c:numRef></c:val></c:ser>
<c:dLbls><c:showLegendKey val="0"/><c:showVal val="1"/></c:dLbls><c:axId val="1"/><c:axId val="2"/></c:lineChart>
<c:catAx><c:axId val="1"/><c:axPos val="b"/><c:title><c:tx><c:rich><a:p><a:r><a:t>Month</a:t></a:r></a:p></c:rich></c:tx></c:title></c:catAx><c:valAx><c:axId val="2"/><c:axPos val="l"/></c:valAx></c:plotArea>
<c:legend><c:legendPos val="t"/></c:legend></c:chart></c:chartSpace>`,
    'xl/charts/chart2.xml': `<?xml version="1.0"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:plotArea><c:radarChart><c:ser><c:idx val="0"/><c:val><c:numRef><c:f>Data!$A$1:$A$3</c:f></c:numRef></c:val></c:ser></c:radarChart></c:plotArea></c:chart></c:chartSpace>`,
  };
  return zipStore(Object.entries(parts).map(([name, text]) => ({ name, data: new TextEncoder().encode(text), modified: Date.UTC(2026, 9, 13) })));
}

test('parts as Excel writes them are read in; what cannot be kept is reported', async () => {
  const wb = new Workbook();
  wb.dateOrder = 'dmy';
  const report = await openXlsx(wb, excelMade());
  const sh = wb.sheets[0];
  // The line chart: rich-text title, a theme colour darkened by a quarter, labels, axis title, legend at the top.
  assert.equal(sh.charts.length, 1);
  const ch = sh.charts[0];
  assert.equal(ch.type, 'line');
  assert.equal(ch.title, 'Sales by month');
  assert.equal(ch.legend, 't');
  assert.equal(ch.xTitle, 'Month');
  assert.equal(ch.labels, true);
  assert.deepEqual(ch.series, [{ name: '=Data!$B$1', cat: 'Data!$A$2:$A$9', val: 'Data!$B$2:$B$9', colour: '#c55a11' }], 'Excel\'s own "Orange, Accent 2, Darker 25%"');
  // D2 + 1 px; to I17 + 2 px: column A is 18.71 characters (136 px), the rest 64 px.
  assert.deepEqual([ch.at, ch.w, ch.h], [{ col: 3, row: 1, dx: 1, dy: 0 }, 64 * 5 + 1, 20 * 15]);
  // Conditional formatting in priority order; the icon set and the date rule are reported.
  assert.deepEqual(sh.cf.map(e => [e.rule.t, (e.rule as { fmt?: object }).fmt]), [['expr', { b: true, color: '#4472c4' }], ['cell', { fill: '#ffc7ce', color: '#9c0006' }]]);
  // Validation: the sheet's own rule and the Excel 2010 list rule (reading another sheet).
  assert.deepEqual(sh.dv.map(v => [v.type, v.f1, v.ranges]), [['whole', '0', [R('A1:A9')]], ['list', 'Lists!$A$1:$A$3', [R('C1:C9')]]]);
  // Page setup: A4 landscape, fit one page wide, gridlines, narrow-ish margins, footer, the first print area block, title rows.
  const p = sh.page!;
  assert.deepEqual([p.paper, p.orient, p.fit, p.gridlines, p.margins.l, p.footer, p.area, p.titleRows], ['a4', 'landscape', { w: 1, h: 0 }, true, 0.25, '&CPage &P', R('A1:D20'), [1, 2]]);
  const said = report.dropped.join(' | ');
  for (const words of ['radar chart', '2 conditional formatting rules', 'manual page breaks', 'only its first block']) assert.ok(said.includes(words), `${words}: ${said}`);
});

/** A one-sheet workbook whose rules, filter and print area are set on whole columns, as Excel writes them. */
function wholeColumns(): Uint8Array {
  const parts: Record<string, string> = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': `<?xml version="1.0"?><workbook ${MAIN}><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets>
<definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">Data!$A$1:$D$1048576</definedName></definedNames></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': `<?xml version="1.0"?><styleSheet ${MAIN}><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><cellXfs count="1"><xf/></cellXfs>
<dxfs count="1"><dxf><font><b/></font></dxf></dxfs></styleSheet>`,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet ${MAIN}>
<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Name</t></is></c><c r="B1" t="inlineStr"><is><t>Score</t></is></c><c r="C1" t="inlineStr"><is><t>Status</t></is></c></row><row r="2"><c r="B2"><v>5</v></c></row></sheetData>
<autoFilter ref="A1:C1048576"/>
<conditionalFormatting sqref="B2:B1048576"><cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan"><formula>3</formula></cfRule></conditionalFormatting>
<conditionalFormatting sqref="A6000:A6010"><cfRule type="cellIs" dxfId="0" priority="2" operator="lessThan"><formula>0</formula></cfRule></conditionalFormatting>
<dataValidations count="2"><dataValidation type="list" allowBlank="1" sqref="C2:C1048576"><formula1>"Paid,Due"</formula1></dataValidation>
<dataValidation type="whole" operator="greaterThan" sqref="XFD1:XFD9"><formula1>0</formula1></dataValidation></dataValidations>
</worksheet>`,
  };
  return zipStore(Object.entries(parts).map(([name, text]) => ({ name, data: new TextEncoder().encode(text), modified: Date.UTC(2026, 9, 13) })));
}

test('rules, a filter and a print area on whole columns are kept, cut to the sheet; only rules wholly past the edge are reported', async () => {
  const wb = new Workbook();
  const report = await openXlsx(wb, wholeColumns());
  const sh = wb.sheets[0];
  assert.deepEqual(sh.cf.map(e => [e.rule.t, e.ranges]), [['cell', [R('B2:B5000')]]], 'the whole-column format is kept, cut at row 5,000');
  assert.deepEqual(sh.dv.map(v => [v.type, v.f1, v.ranges]), [['list', '"Paid,Due"', [R('C2:C5000')]]], 'the whole-column drop-down list is kept');
  assert.deepEqual(sh.filter?.range, R('A1:C5000'), 'the whole-column filter is kept');
  assert.deepEqual(sh.page?.area, R('A1:D5000'), 'the whole-column print area is kept');
  const said = report.dropped.join(' | ');
  assert.ok(said.includes('1 conditional formatting rule on cells past row 5,000 or column IV'), said);
  assert.ok(said.includes('1 data validation rule on cells past row 5,000 or column IV'), said);
  assert.ok(!said.includes('filter on cells') && !said.includes('print area'), `nothing said for what was only cut: ${said}`);
});
