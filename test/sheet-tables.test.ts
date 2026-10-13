// Session 9: Excel tables. Making one, its look, table references in formulas (Sales[Amount], [@Amount], #Totals),
// growing as rows are typed under it, calculated columns, the total row, renaming, converting back to cells, and
// tables in Excel files. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readZip } from '../src/apps/archive/read.ts';
import { parseCellRef } from '../src/apps/sheet/refs.ts';
import { keyOf, Workbook } from '../src/apps/sheet/workbook.ts';
import { openXlsx, saveXlsx } from '../src/apps/sheet/xlsx.ts';

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
const val = (wb: Workbook, a: string, s = 0) => {
  const r = parseCellRef(a)!;
  const v = wb.value(s, r.col, r.row);
  return v && typeof v === 'object' ? (v as { code: string }).code : v;
};
const cellAt = (wb: Workbook, a: string, s = 0) => {
  const r = parseCellRef(a)!;
  return wb.sheets[s].cells.get(keyOf(r.col, r.row));
};
const partText = async (bytes: Uint8Array, name: string) => new TextDecoder().decode(await readZip(bytes).find(e => e.parts.join('/') === name)!.read());

function sales(): Workbook {
  const wb = new Workbook();
  put(wb, { A1: 'Item', B1: 'Amount', C1: 'Qty', A2: 'Tea', B2: '4', C2: '10', A3: 'Cake', B3: '6', C3: '3', A4: 'Pie', B4: '5', C4: '2' });
  return wb;
}

test('a table: column names from its header row, filter buttons, and Excel\'s default style drawn under the cells', () => {
  const wb = sales();
  const t = wb.addTable(0, R('A1:C4'), { header: true });
  assert.equal(t.name, 'Table1');
  assert.deepEqual(t.columns.map(c => c.name), ['Item', 'Amount', 'Qty']);
  assert.deepEqual(wb.sheets[0].filter?.range, R('A1:C4'), 'the sheet\'s filter is the table\'s');
  // Medium 2: a blue header with white bold text, pale blue every other row; a cell's own fill wins.
  assert.deepEqual([wb.lookOf(0, 0, 0)?.fill, wb.lookOf(0, 0, 0)?.color, wb.lookOf(0, 0, 0)?.b], ['#4472c4', '#ffffff', true]);
  assert.equal(wb.lookOf(0, 0, 1)?.fill, '#dae3f3');
  assert.equal(wb.lookOf(0, 0, 2)?.fill, undefined);
  wb.setStyle(0, R('A2'), s => ({ ...s, fill: '#ff0000' }));
  assert.equal(wb.lookOf(0, 0, 1)?.fill, '#ff0000');
  // A second table cannot overlap it; names stay unique; one Undo takes the table away.
  assert.throws(() => wb.addTable(0, R('C3:D6'), { header: true }), /already a table/);
  wb.undo();
  wb.undo();
  assert.equal(wb.sheets[0].tables.length, 0);
  assert.equal(wb.sheets[0].filter, null);
});

test('without headers, the empty row above takes Column1, Column2...; numbers as headers become text', () => {
  const wb = new Workbook();
  put(wb, { A2: '1', B2: '2', A3: '3', B3: '4' });
  const t = wb.addTable(0, R('A2:B3'), { header: false });
  assert.deepEqual([t.range, t.columns.map(c => c.name)], [R('A1:B3'), ['Column1', 'Column2']]);
  const wb2 = new Workbook();
  put(wb2, { A1: '2025', B1: '2025', A2: '1', B2: '2' });
  const t2 = wb2.addTable(0, R('A1:B2'), { header: true });
  assert.deepEqual(t2.columns.map(c => c.name), ['2025', '20252']);
  assert.equal(cellAt(wb2, 'A1')?.v, '2025');
  assert.throws(() => wb.addTable(0, R('D1:E2'), { header: false }), /no empty row above/);
});

test('table references: Sales[Amount], [@Amount], #Totals, #Headers, #All, and the table\'s name alone', () => {
  const wb = sales();
  const t = wb.addTable(0, R('A1:C4'), { header: true });
  wb.renameTable(t, 'Sales');
  put(wb, {
    F1: '=SUM(Sales[Amount])', F2: '=COUNTA(Sales[#All])', F3: '=Sales[[#Headers],[Qty]]', F4: '=ROWS(Sales)', F5: '=SUMPRODUCT(Sales[Amount],Sales[Qty])',
    F6: '=SUM(Sales[[Amount]:[Qty]])', F7: '=Sales[@Amount]', F8: '=SUM(Nope[Amount])', F9: '=SUM(Sales[Price])',
  });
  assert.deepEqual(['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9'].map(a => val(wb, a)), [15, 12, 'Qty', 3, 68, 30, '#VALUE!', '#REF!', '#REF!']);
  // [@Amount] in the table's own rows: that row's amount.
  put(wb, { D1: 'Total', D2: '=[@Amount]*[@Qty]' });
  assert.deepEqual(['D2', 'D3', 'D4'].map(a => val(wb, a)), [40, 18, 10], 'typed once, filled down the new column');
  assert.deepEqual(t.columns.map(c => c.name), ['Item', 'Amount', 'Qty', 'Total'], 'typing beside the header added a column');
});

test('typing under a table takes the row in, carrying calculated columns on; Undo takes the growth back first', () => {
  const wb = sales();
  const t = wb.addTable(0, R('A1:C4'), { header: true });
  put(wb, { D1: 'Value', D2: '=B2*C2' });
  assert.equal(cellAt(wb, 'D4')?.f, 'B4*C4', 'a calculated column');
  put(wb, { A5: 'Scone' });
  assert.deepEqual(t.range, R('A1:D5'));
  assert.equal(cellAt(wb, 'D5')?.f, 'B5*C5', 'the calculated column carried on');
  assert.deepEqual(wb.sheets[0].filter?.range, R('A1:D5'));
  wb.undo();
  assert.deepEqual(wb.sheets[0].tables[0].range, R('A1:D4'));
  assert.equal(cellAt(wb, 'A5')?.v, 'Scone', 'the typing itself is the next Undo');
});

test('the total row: a SUBTOTAL that leaves filtered rows out, its function changed, words under the first column', () => {
  const wb = sales();
  const t = wb.addTable(0, R('A1:C4'), { header: true });
  wb.setTotals(0, t, true);
  const table = wb.sheets[0].tables[0];
  assert.deepEqual(table.range, R('A1:C5'));
  assert.deepEqual([cellAt(wb, 'A5')?.v, cellAt(wb, 'C5')?.f, val(wb, 'C5')], ['Total', 'SUBTOTAL(109,Table1[Qty])', 15]);
  wb.setTotalFn(0, table, 1, 'average');
  assert.deepEqual([cellAt(wb, 'B5')?.f, val(wb, 'B5')], ['SUBTOTAL(101,Table1[Amount])', 5]);
  wb.filterBy(0, 0, ['Tea', 'Pie']);
  assert.equal(val(wb, 'C5'), 12, 'Cake filtered out');
  // The row under a table must be free for a total row.
  const wb2 = sales();
  const t2 = wb2.addTable(0, R('A1:C4'), { header: true });
  // Typed as one step with others (a paste), so the table does not grow to take it in.
  wb2.batch(() => put(wb2, { B5: 'in the way' }));
  assert.throws(() => wb2.setTotals(0, wb2.sheets[0].tables[0], true), /holds something/);
  void t2;
  wb.setTotals(0, wb.sheets[0].tables[0], false);
  assert.deepEqual([wb.sheets[0].tables[0].range, cellAt(wb, 'C5')], [R('A1:C4'), undefined]);
});

test('renaming a table or a column rewrites the formulas that use it; Convert to range keeps the look as cell formatting', () => {
  const wb = sales();
  const t = wb.addTable(0, R('A1:C4'), { header: true });
  put(wb, { F1: '=SUM(Table1[Amount])', F2: '=MAX(Table1[[#All],[Qty]])' });
  wb.renameTable(wb.sheets[0].tables[0], 'Orders');
  assert.equal(cellAt(wb, 'F1')?.f, 'SUM(Orders[Amount])');
  assert.throws(() => wb.renameTable(wb.sheets[0].tables[0], 'A1'), /cell address/);
  put(wb, { B1: 'Price' });
  assert.equal(cellAt(wb, 'F1')?.f, 'SUM(Orders[Price])');
  assert.equal(val(wb, 'F1'), 15);
  wb.convertTable(0, wb.sheets[0].tables[0]);
  assert.equal(wb.sheets[0].tables.length, 0);
  assert.equal(cellAt(wb, 'F1')?.f, 'SUM($B$2:$B$4)');
  assert.equal(cellAt(wb, 'F2')?.f, 'MAX($C$1:$C$4)');
  assert.equal(wb.styleOf(cellAt(wb, 'A1'))?.fill, '#4472c4', 'the header keeps its look as its own');
  void t;
});

test('rows and columns inserted or deleted in a table make it bigger or smaller; header row off and on', () => {
  const wb = sales();
  wb.addTable(0, R('A1:C4'), { header: true });
  wb.shiftAxis(0, 'row', 2, 1);
  assert.deepEqual(wb.sheets[0].tables[0].range, R('A1:C5'));
  wb.shiftAxis(0, 'col', 1, -1);
  assert.deepEqual([wb.sheets[0].tables[0].range, wb.sheets[0].tables[0].columns.map(c => c.name)], [R('A1:B5'), ['Item', 'Qty']]);
  wb.setHeader(0, wb.sheets[0].tables[0], false);
  assert.deepEqual([wb.sheets[0].tables[0].range, cellAt(wb, 'A1')], [R('A2:B5'), undefined]);
  wb.setHeader(0, wb.sheets[0].tables[0], true);
  assert.deepEqual([wb.sheets[0].tables[0].range, cellAt(wb, 'B1')?.v], [R('A1:B5'), 'Qty']);
});

test('tables in Excel files: their own part, "this row" written out in full, read back as they were', async () => {
  const wb = sales();
  const t = wb.addTable(0, R('A1:C4'), { header: true });
  put(wb, { D1: 'Value', D2: '=[@Amount]*[@Qty]', F1: '=SUM(Table1[Value])' });
  wb.setTotals(0, wb.sheets[0].tables[0], true);
  wb.setTableOptions(0, wb.sheets[0].tables[0], { style: 'TableStyleLight9', firstCol: true });
  wb.filterBy(0, 0, ['Tea', 'Cake']);
  const bytes = await saveXlsx(wb);
  const tableXml = await partText(bytes, 'xl/tables/table1.xml');
  assert.match(tableXml, /<table [^>]*id="1" name="Table1" displayName="Table1" ref="A1:D5" totalsRowCount="1">/);
  assert.match(tableXml, /<autoFilter ref="A1:D4"><filterColumn colId="0"><filters><filter val="Tea"\/><filter val="Cake"\/><\/filters><\/filterColumn><\/autoFilter>/);
  assert.match(tableXml, /<tableColumn id="1" name="Item" totalsRowLabel="Total"\/>/);
  assert.match(tableXml, /<tableColumn id="4" name="Value" totalsRowFunction="sum"\/>/);
  assert.match(tableXml, /<tableStyleInfo name="TableStyleLight9" showFirstColumn="1" showLastColumn="0" showRowStripes="1" showColumnStripes="0"\/>/);
  const sheetXml = await partText(bytes, 'xl/worksheets/sheet1.xml');
  assert.match(sheetXml, /<f>Table1\[\[#This Row\],\[Amount\]\]\*Table1\[\[#This Row\],\[Qty\]\]<\/f>/);
  assert.match(sheetXml, /<tableParts count="1"><tablePart r:id="rId1"\/><\/tableParts><\/worksheet>$/);
  assert.ok(!/<autoFilter/.test(sheetXml), 'the table\'s filter is in the table, not the sheet');
  assert.match(await partText(bytes, '[Content_Types].xml'), /\/xl\/tables\/table1\.xml/);
  const back = new Workbook();
  const report = await openXlsx(back, bytes);
  const bt = back.sheets[0].tables[0];
  assert.deepEqual([bt.name, bt.range, bt.totals, bt.style, bt.firstCol, bt.columns.map(c => c.name)], ['Table1', R('A1:D5'), true, 'TableStyleLight9', true, ['Item', 'Amount', 'Qty', 'Value']]);
  assert.equal(cellAt(back, 'D3')?.f, '[@Amount]*[@Qty]');
  assert.deepEqual(back.sheets[0].filter?.cols.get(0), ['Tea', 'Cake']);
  assert.deepEqual([val(back, 'F1'), val(back, 'D5')], [68, 58], 'Pie is filtered out of the total, not of SUM');
  assert.equal(report.differ.count, 0, report.differ.examples.join(', '));
  void t;
});

test('Remove duplicates in a table makes the table shorter and moves its total row up', () => {
  const wb = sales();
  put(wb, { A5: 'Tea', B5: '4', C5: '10' });
  wb.batch(() => undefined);
  const t = wb.addTable(0, R('A1:C5'), { header: true });
  wb.setTotals(0, t, true);
  const got = wb.removeDuplicates(0, R('A1:C5'), [0, 1, 2], true);
  assert.deepEqual(got, { removed: 1, kept: 3 });
  const table = wb.sheets[0].tables[0];
  assert.deepEqual(table.range, R('A1:C5'));
  assert.deepEqual([cellAt(wb, 'A5')?.v, cellAt(wb, 'C5')?.f, val(wb, 'C5'), cellAt(wb, 'A6')], ['Total', 'SUBTOTAL(109,Table1[Qty])', 15, undefined]);
  wb.undo();
  assert.deepEqual(wb.sheets[0].tables[0].range, R('A1:C6'));
});

test('features that lean on each other: a list rule fed by a name or a table column, a rule with a name or [@Column], a PivotTable fed by a name', async () => {
  const { newValidation, passes, listItems } = await import('../src/apps/sheet/validate.ts');
  const { cfLook } = await import('../src/apps/sheet/condfmt.ts');
  const wb = sales();
  wb.setName('Items', 'Sheet1!$A$2:$A$4');
  wb.addTable(0, R('A1:C4'), { header: true });
  for (const f1 of ['Items', 'Table1[Item]', 'INDIRECT("Table1[Item]")']) {
    const v = { ...newValidation([R('F6')]), type: 'list' as const, f1 };
    assert.deepEqual(listItems(wb, 0, v, 5, 5), ['Tea', 'Cake', 'Pie'], f1);
    assert.equal(wb.withInput(0, 5, 5, 'cake', () => passes(wb, 0, v, wb.value(0, 5, 5), 5, 5)), true, f1);
    assert.equal(wb.withInput(0, 5, 5, 'Bun', () => passes(wb, 0, v, wb.value(0, 5, 5), 5, 5)), false, f1);
  }
  wb.setName('Limit', '=5');
  wb.addCf(0, { ranges: [R('B2:B4')], rule: { t: 'expr', f: 'B2>Limit', fmt: { fill: '#ff0000' } } } as never);
  wb.addCf(0, { ranges: [R('A2:A4')], rule: { t: 'expr', f: '[@Amount]>5', fmt: { fill: '#00ff00' } } } as never);
  assert.deepEqual([cfLook(wb, 0, 1, 2)?.fill, cfLook(wb, 0, 1, 1)?.fill, cfLook(wb, 0, 0, 2)?.fill, cfLook(wb, 0, 0, 1)?.fill], ['#ff0000', undefined, '#00ff00', undefined]);
  wb.addSheet();
  wb.setName('Data', 'Sheet1!$A$1:$C$4');
  const p = wb.addPivot(1, 'Data', { col: 0, row: 0 });
  wb.setPivot(1, p, { rows: [0], values: [{ field: 1, agg: 'sum' }] });
  assert.deepEqual([wb.display(1, 0, 4), wb.display(1, 1, 4)], ['Grand Total', '15']);
  put(wb, { D1: 'Double', D2: '=LET(x,[@Amount],x*2)' });
  assert.deepEqual([val(wb, 'D2'), val(wb, 'D4')], [8, 10], 'LET with [@Amount] filled down a new column');
});
