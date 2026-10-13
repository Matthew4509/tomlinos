// Session 10: PivotTables. The report laid out as Excel's compact layout: row labels, column labels, sums and other
// summaries, subtotals and grand totals, report filters, shares of totals, dates grouped, items left out; and the
// report kept up to date, guarded, moved and saved. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCellRef } from '../src/apps/sheet/refs.ts';
import { Workbook } from '../src/apps/sheet/workbook.ts';

const put = (wb: Workbook, cells: Record<string, string>, s = 0) => {
  for (const [a, v] of Object.entries(cells)) {
    const r = parseCellRef(a)!;
    wb.setInput(s, r.col, r.row, v);
  }
};
/** The report as rows of what the cells show, from its top-left cell. */
function shown(wb: Workbook, s: number, from: string, rows: number, cols: number): string[][] {
  const at = parseCellRef(from)!;
  const out: string[][] = [];
  for (let r = 0; r < rows; r++) {
    const line: string[] = [];
    for (let c = 0; c < cols; c++) line.push(wb.display(s, at.col + c, at.row + r));
    out.push(line);
  }
  return out;
}

function sales(): Workbook {
  const wb = new Workbook();
  wb.dateOrder = 'dmy';
  put(wb, {
    A1: 'Region', B1: 'Rep', C1: 'Date', D1: 'Amount',
    A2: 'North', B2: 'Ann', C2: '5/01/2026', D2: '100',
    A3: 'South', B3: 'Bob', C3: '20/01/2026', D3: '200',
    A4: 'North', B4: 'Bob', C4: '3/02/2026', D4: '50',
    A5: 'North', B5: 'Ann', C5: '14/02/2026', D5: '25',
    A6: 'South', B6: 'Ann', C6: '1/03/2027', D6: '75',
  });
  wb.addSheet();
  return wb;
}

test('rows and one value field: Row Labels, a sum per item in order, a grand total; the amounts keep their format', () => {
  const wb = sales();
  wb.setStyle(0, { c0: 3, r0: 1, c1: 3, r1: 5 }, s => ({ ...s, fmt: 'currency', dec: 0 }));
  const p = wb.addPivot(1, 'Sheet1!$A$1:$D$6', { col: 0, row: 2 });
  wb.setPivot(1, p, { rows: [0], values: [{ field: 3, agg: 'sum' }] });
  assert.deepEqual(shown(wb, 1, 'A3', 4, 2), [['Row Labels', 'Sum of Amount'], ['North', '$175'], ['South', '$275'], ['Grand Total', '$450']]);
  assert.equal(wb.lookOf(1, 0, 2)?.b, true, 'the heading row is bold');
  assert.equal(wb.lookOf(1, 1, 5)?.bt, true, 'the grand total row has a line above it');
});

test('two row fields: each outer item with its subtotal, inner items indented under it', () => {
  const wb = sales();
  const p = wb.addPivot(1, 'Sheet1!$A$1:$D$6', { col: 0, row: 0 });
  wb.setPivot(1, p, { rows: [0, 1], values: [{ field: 3, agg: 'sum' }] });
  assert.deepEqual(shown(wb, 1, 'A1', 8, 2), [
    ['Row Labels', 'Sum of Amount'], ['North', '175'], ['Ann', '125'], ['Bob', '50'], ['South', '275'], ['Ann', '75'], ['Bob', '200'], ['Grand Total', '450'],
  ]);
  assert.equal(wb.lookOf(1, 0, 2)?.ind, 1, 'inner items are indented');
  assert.equal(wb.lookOf(1, 0, 1)?.b, true, 'outer items are bold');
  wb.setPivot(1, p, { subtotals: false, grandRows: false });
  assert.deepEqual(shown(wb, 1, 'A1', 7, 2), [['Row Labels', 'Sum of Amount'], ['North', ''], ['Ann', '125'], ['Bob', '50'], ['South', ''], ['Ann', '75'], ['Bob', '200']]);
  assert.equal(wb.display(1, 0, 7), '', 'no grand total, and the old one is cleared');
});

test('a column field: Column Labels across, a grand total column; counts and averages', () => {
  const wb = sales();
  const p = wb.addPivot(1, 'Sheet1!$A$1:$D$6', { col: 0, row: 0 });
  wb.setPivot(1, p, { rows: [0], cols: [1], values: [{ field: 3, agg: 'sum' }] });
  assert.deepEqual(shown(wb, 1, 'A1', 5, 4), [
    ['Sum of Amount', 'Column Labels', '', ''], ['Row Labels', 'Ann', 'Bob', 'Grand Total'], ['North', '125', '50', '175'], ['South', '75', '200', '275'], ['Grand Total', '200', '250', '450'],
  ]);
  wb.setPivot(1, p, { cols: [], values: [{ field: 3, agg: 'count' }, { field: 3, agg: 'average' }] });
  assert.deepEqual(shown(wb, 1, 'A1', 4, 3), [['Row Labels', 'Count of Amount', 'Average of Amount'], ['North', '3', '58.333333333'], ['South', '2', '137.5'], ['Grand Total', '5', '90']]);
});

test('a report filter, items left out, shares of the grand total, and dates grouped by month and year', () => {
  const wb = sales();
  const p = wb.addPivot(1, 'Sheet1!$A$1:$D$6', { col: 0, row: 0 });
  wb.setPivot(1, p, { filters: [{ field: 0, keep: ['North'] }], rows: [1], values: [{ field: 3, agg: 'sum' }] });
  assert.deepEqual(shown(wb, 1, 'A1', 6, 2), [['Region', 'North'], ['', ''], ['Row Labels', 'Sum of Amount'], ['Ann', '125'], ['Bob', '50'], ['Grand Total', '175']]);
  wb.setPivot(1, p, { filters: [], hidden: { 1: ['Bob'] } });
  assert.deepEqual(shown(wb, 1, 'A1', 3, 2), [['Row Labels', 'Sum of Amount'], ['Ann', '200'], ['Grand Total', '200']]);
  wb.setPivot(1, p, { hidden: {}, values: [{ field: 3, agg: 'sum', show: 'pctTotal' }] });
  assert.deepEqual(shown(wb, 1, 'A1', 4, 2), [['Row Labels', 'Sum of Amount'], ['Ann', '44.44%'], ['Bob', '55.56%'], ['Grand Total', '100.00%']]);
  wb.setPivot(1, p, { rows: [2], values: [{ field: 3, agg: 'sum' }], groups: { 2: 'months' } });
  assert.deepEqual(shown(wb, 1, 'A1', 5, 2), [['Row Labels', 'Sum of Amount'], ['Jan', '300'], ['Feb', '75'], ['Mar', '75'], ['Grand Total', '450']]);
  wb.setPivot(1, p, { groups: { 2: 'years' } });
  assert.deepEqual(shown(wb, 1, 'A1', 4, 2), [['Row Labels', 'Sum of Amount'], ['2026', '375'], ['2027', '75'], ['Grand Total', '450']]);
});

test('the report: its cells cannot be typed over, Refresh picks up new figures, it will not cover other cells', () => {
  const wb = sales();
  const p = wb.addPivot(1, 'Sheet1!$A$1:$D$6', { col: 0, row: 0 });
  wb.setPivot(1, p, { rows: [0], values: [{ field: 3, agg: 'sum' }] });
  assert.throws(() => wb.setInput(1, 1, 1, '5'), /part of the PivotTable/);
  put(wb, { D2: '1000' });
  assert.equal(wb.display(1, 1, 1), '175', 'not until Refresh');
  wb.refreshPivot(1, wb.sheets[1].pivots[0]);
  assert.equal(wb.display(1, 1, 1), '1075');
  wb.undo();
  assert.equal(wb.display(1, 1, 1), '175', 'one Undo takes the refresh back');
  // Growing into cells that hold something: refused, and nothing changes.
  put(wb, { A6: 'in the way' }, 1);
  assert.throws(() => wb.setPivot(1, wb.sheets[1].pivots[0], { rows: [0, 1] }), /hold something/);
  assert.deepEqual(wb.sheets[1].pivots[0].rows, [0]);
  assert.equal(wb.display(1, 0, 1), 'North');
});

test('a PivotTable is kept in the saved file, moves with inserted rows, and follows its data\'s sheet being renamed', () => {
  const wb = sales();
  const p = wb.addPivot(1, 'Sheet1!$A$1:$D$6', { col: 1, row: 1 });
  wb.setPivot(1, p, { rows: [1], values: [{ field: 3, agg: 'max' }] });
  const again = new Workbook();
  again.load(JSON.parse(wb.serialize()));
  assert.deepEqual(again.sheets[1].pivots[0].values, [{ field: 3, agg: 'max' }]);
  assert.equal(again.display(1, 2, 2), '100');
  wb.shiftAxis(1, 'row', 0, 2);
  assert.deepEqual(wb.sheets[1].pivots[0].at, { col: 1, row: 3 });
  assert.equal(wb.pivotAt(1, 1, 3)?.name, 'PivotTable1');
  wb.renameSheet(0, 'Data');
  assert.equal(wb.sheets[1].pivots[0].source, 'Data!$A$1:$D$6');
  wb.refreshPivot(1, wb.sheets[1].pivots[0]);
  assert.equal(wb.display(1, 2, 4), '100');
  // A table as the data: it grows, and the PivotTable reads the new rows at the next Refresh.
  const wb2 = sales();
  wb2.addTable(0, { c0: 0, r0: 0, c1: 3, r1: 5 }, { header: true });
  const p2 = wb2.addPivot(1, 'Table1[#All]', { col: 0, row: 0 });
  wb2.setPivot(1, p2, { rows: [0], values: [{ field: 3, agg: 'sum' }] });
  put(wb2, { A7: 'East', D7: '9' });
  wb2.refreshPivot(1, wb2.sheets[1].pivots[0]);
  assert.deepEqual(shown(wb2, 1, 'A1', 5, 2), [['Row Labels', 'Sum of Amount'], ['East', '9'], ['North', '175'], ['South', '275'], ['Grand Total', '459']]);
  wb2.deletePivot(1, wb2.sheets[1].pivots[0]);
  assert.deepEqual([wb2.sheets[1].pivots.length, wb2.display(1, 0, 0)], [0, '']);
});

test('a PivotTable made in Excel opens as a live PivotTable: its data, fields, sums and filter read from the file', async () => {
  const { zipStore } = await import('../src/core/zip.ts');
  const { openXlsx } = await import('../src/apps/sheet/xlsx.ts');
  const MAIN = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const rels = (items: Array<[string, string, string]>) => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join('')}</Relationships>`;
  const c = (r: string, v: string | number) => (typeof v === 'number' ? `<c r="${r}"><v>${v}</v></c>` : `<c r="${r}" t="inlineStr"><is><t>${v}</t></is></c>`);
  const parts: Record<string, string> = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    '_rels/.rels': rels([['rId1', 'officeDocument', 'xl/workbook.xml']]),
    'xl/workbook.xml': `<?xml version="1.0"?><workbook ${MAIN}><sheets><sheet name="My data" sheetId="1" r:id="rId1"/><sheet name="Report" sheetId="2" r:id="rId2"/></sheets><pivotCaches><pivotCache cacheId="7" r:id="rId3"/></pivotCaches></workbook>`,
    'xl/_rels/workbook.xml.rels': rels([['rId1', 'worksheet', 'worksheets/sheet1.xml'], ['rId2', 'worksheet', 'worksheets/sheet2.xml'], ['rId3', 'pivotCacheDefinition', 'pivotCache/pivotCacheDefinition1.xml']]),
    'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet ${MAIN}><sheetData>
<row r="1">${c('A1', 'Region')}${c('B1', 'Rep')}${c('C1', 'Amount')}</row>
<row r="2">${c('A2', 'North')}${c('B2', 'Ann')}${c('C2', 100)}</row>
<row r="3">${c('A3', 'South')}${c('B3', 'Bob')}${c('C3', 200)}</row>
<row r="4">${c('A4', 'North')}${c('B4', 'Bob')}${c('C4', 50)}</row></sheetData></worksheet>`,
    // The report as Excel wrote it: a filter on Rep (Bob), Region down the side.
    'xl/worksheets/sheet2.xml': `<?xml version="1.0"?><worksheet ${MAIN}><sheetData>
<row r="1">${c('A1', 'Rep')}${c('B1', 'Bob')}</row>
<row r="3">${c('A3', 'Row Labels')}${c('B3', 'Total of Amount')}</row>
<row r="4">${c('A4', 'North')}${c('B4', 50)}</row><row r="5">${c('A5', 'South')}${c('B5', 200)}</row><row r="6">${c('A6', 'Grand Total')}${c('B6', 250)}</row></sheetData></worksheet>`,
    'xl/worksheets/_rels/sheet2.xml.rels': rels([['rId1', 'pivotTable', '../pivotTables/pivotTable1.xml']]),
    'xl/pivotCache/pivotCacheDefinition1.xml': `<?xml version="1.0"?><pivotCacheDefinition ${MAIN}><cacheSource type="worksheet"><worksheetSource ref="A1:C4" sheet="My data"/></cacheSource><cacheFields count="3">
<cacheField name="Region"><sharedItems><s v="North"/><s v="South"/></sharedItems></cacheField><cacheField name="Rep"><sharedItems><s v="Ann"/><s v="Bob"/></sharedItems></cacheField><cacheField name="Amount"><sharedItems containsNumber="1"/></cacheField></cacheFields></pivotCacheDefinition>`,
    'xl/pivotTables/pivotTable1.xml': `<?xml version="1.0"?><pivotTableDefinition ${MAIN} name="Sales by region" cacheId="7" colGrandTotals="0"><location ref="A3:B6" firstHeaderRow="1" firstDataRow="1" firstDataCol="1" rowPageCount="1" colPageCount="1"/><pivotFields count="3"><pivotField axis="axisRow"><items count="3"><item x="0"/><item x="1"/><item t="default"/></items></pivotField><pivotField axis="axisPage"><items count="3"><item x="0"/><item x="1"/><item t="default"/></items></pivotField><pivotField dataField="1"/></pivotFields><rowFields count="1"><field x="0"/></rowFields><pageFields count="1"><pageField fld="1" item="1" hier="-1"/></pageFields><dataFields count="1"><dataField name="Total of Amount" fld="2" baseField="0" baseItem="0"/></dataFields></pivotTableDefinition>`,
  };
  const bytes = zipStore(Object.entries(parts).map(([name, text]) => ({ name, data: new TextEncoder().encode(text), modified: Date.UTC(2026, 9, 13) })));
  const wb = new Workbook();
  const report = await openXlsx(wb, bytes);
  const p = wb.sheets[1].pivots[0];
  assert.deepEqual(
    [p.name, p.source, p.at, p.rows, p.values, p.filters, p.grandCols, p.last],
    ['Sales by region', "'My data'!$A$1:$C$4", { col: 0, row: 0 }, [0], [{ field: 2, agg: 'sum', name: 'Total of Amount' }], [{ field: 1, keep: ['Bob'] }], false, { c0: 0, r0: 0, c1: 1, r1: 5 }],
  );
  assert.ok(!report.dropped.join(' ').includes('PivotTable'), report.dropped.join(' | '));
  // Refreshed here, the report comes out the same as Excel's.
  wb.refreshPivot(1, p);
  assert.deepEqual(shown(wb, 1, 'A1', 6, 2), [['Rep', 'Bob'], ['', ''], ['Row Labels', 'Total of Amount'], ['North', '50'], ['South', '200'], ['Grand Total', '250']]);
});
