// Charts, page setup and the PDF writer, as rules (no browser needed): how a chart reads the selected cells, what it
// draws, how it follows the cells when rows move or a sheet is renamed, undo and saving; how a sheet is cut into pages;
// and that a PDF written here is one a PDF reader opens, with every object where the file says it is.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { chartData, chartFromRange, drawChart, niceScale, refRange, switchRowCol, type Chart } from '../src/apps/sheet/chart.ts';
import { RecordPainter, textWidth, wrapText } from '../src/apps/sheet/paint.ts';
import { PdfDocument as Writer, pdfString } from '../src/apps/sheet/pdf.ts';
import { defaultPage, drawPage, headerParts, planPages, printRange } from '../src/apps/sheet/print.ts';
import { parseCellRef } from '../src/apps/sheet/refs.ts';
import { Workbook } from '../src/apps/sheet/workbook.ts';
import { PdfDocument as Reader } from '../src/apps/pdf/objects.ts';

function book(cells: Record<string, string>): Workbook {
  const wb = new Workbook();
  wb.dateOrder = 'dmy';
  for (const [addr, text] of Object.entries(cells)) {
    const r = parseCellRef(addr)!;
    wb.setInput(0, r.col, r.row, text);
  }
  return wb;
}
const R = (a: string) => {
  const [x, y] = a.split(':').map(t => parseCellRef(t)!);
  const z = y ?? x;
  return { c0: x.col, r0: x.row, c1: z.col, r1: z.row };
};
const reopen = (wb: Workbook): Workbook => {
  const back = new Workbook();
  back.load(JSON.parse(wb.serialize()));
  return back;
};
const place = { at: { col: 4, row: 1, dx: 0, dy: 0 }, w: 480, h: 288 };

const SALES = {
  A1: 'Month', B1: 'Sales', C1: 'Costs',
  A2: 'Jan', B2: '120', C2: '80',
  A3: 'Feb', B3: '150', C3: '95',
  A4: 'Mar', B4: '90', C4: '70',
  A5: 'Apr', B5: '200', C5: '110',
};

test('a chart reads the block as Excel does: headings are series names, the left column the categories', () => {
  const wb = book(SALES);
  const made = chartFromRange(wb, 0, R('A1:C5'), 'column');
  assert.deepEqual(made.series.map(s => [s.name, s.cat, s.val]), [
    ['=Sheet1!$B$1', 'Sheet1!$A$2:$A$5', 'Sheet1!$B$2:$B$5'],
    ['=Sheet1!$C$1', 'Sheet1!$A$2:$A$5', 'Sheet1!$C$2:$C$5'],
  ]);
  assert.equal(made.legend, 'r', 'two series get a legend');
  // One cell selected: the block round it.
  assert.deepEqual(chartFromRange(wb, 0, R('B3'), 'column').series.length, 2);
  // More columns than rows: each row is a series.
  const wide = book({ A1: '', B1: 'Q1', C1: 'Q2', D1: 'Q3', A2: 'North', B2: '1', C2: '2', D2: '3' });
  const w = chartFromRange(wide, 0, R('A1:D2'), 'line');
  assert.deepEqual(w.series.map(s => [s.name, s.cat, s.val]), [['=Sheet1!$A$2', 'Sheet1!$B$1:$D$1', 'Sheet1!$B$2:$D$2']]);
  // Numbers only: one series, categories 1, 2, 3.
  const bare = book({ A1: '5', A2: '7', A3: '9' });
  const b = chartFromRange(bare, 0, R('A1:A3'), 'column');
  assert.deepEqual(b.series.map(s => [s.name, s.cat]), [['', '']]);
  assert.deepEqual(chartData(bare, 0, { ...b, id: 1, ...place }).cats, ['1', '2', '3']);
  // Nothing to chart: said in words.
  assert.throws(() => chartFromRange(book({ A1: 'a', A2: 'b' }), 0, R('A1:A2'), 'column'), /no numbers here to chart/);
  // A scatter chart's first column is the X values.
  const xy = book({ A1: 'x', B1: 'y', A2: '1', B2: '2', A3: '3', B3: '5' });
  const sc = chartFromRange(xy, 0, R('A1:B3'), 'scatter');
  assert.deepEqual(sc.series.map(s => [s.name, s.cat, s.val]), [['=Sheet1!$B$1', 'Sheet1!$A$2:$A$3', 'Sheet1!$B$2:$B$3']]);
  const d = chartData(xy, 0, { ...sc, id: 1, ...place });
  assert.deepEqual(d.series[0].xs, [1, 3]);
  assert.deepEqual(d.series[0].values, [2, 5]);
});

test('the chart data: names, categories as shown, gaps for text, and the number format of the values', () => {
  const wb = book({ ...SALES, B4: 'n/a', A6: '' });
  wb.setStyle(0, R('B2:B5'), s => ({ ...s, fmt: 'currency', dec: 0 }));
  const ch: Chart = { ...chartFromRange(wb, 0, R('A1:C5'), 'column'), id: 1, ...place };
  const d = chartData(wb, 0, ch);
  assert.deepEqual(d.cats, ['Jan', 'Feb', 'Mar', 'Apr']);
  assert.deepEqual(d.series.map(s => s.name), ['Sales', 'Costs']);
  assert.deepEqual(d.series[0].values, [120, 150, null, 200], 'text in a value cell is a gap');
  assert.equal(d.fmt(1500), '$1,500');
  // The values follow the cells.
  wb.setInput(0, 1, 1, '=B3*2');
  assert.equal(chartData(wb, 0, ch).series[0].values[0], 300);
  // A hidden row (a filter's too) is left out of the chart, as Excel leaves it out: its value and its category.
  wb.setHidden(0, 'row', 2, 2, true);
  const shown = chartData(wb, 0, ch);
  assert.deepEqual(shown.cats, ['Jan', 'Mar', 'Apr']);
  assert.deepEqual(shown.series[0].values, [300, null, 200]);
  wb.setHidden(0, 'row', 2, 2, false);
  // A list constant as the values (as an Excel file can hold).
  assert.deepEqual(chartData(wb, 0, { ...ch, series: [{ name: 'Fixed', cat: '', val: '{1,2,3}' }] }).series[0].values, [1, 2, 3]);
});

test('drawing: title, legend, axis steps and one shape per value; pie slices; line markers differ by series', () => {
  const wb = book(SALES);
  const col: Chart = { ...chartFromRange(wb, 0, R('A1:C5'), 'column'), id: 1, ...place, title: 'Sales and costs' };
  const p = new RecordPainter();
  drawChart(p, col, chartData(wb, 0, col), col.w, col.h);
  const texts = p.texts();
  for (const t of ['Sales and costs', 'Sales', 'Costs', 'Jan', 'Apr', '0', '50', '100', '150', '200', '250']) assert.ok(texts.includes(t), `drawn: ${t}`);
  // 8 columns (4 months x 2 series) plus the background, the legend keys (2) and nothing else filled.
  const bars = p.ops.filter(o => o.op === 'rect' && (o.args[4] === '#4472c4' || o.args[4] === '#ed7d31'));
  assert.equal(bars.length, 8 + 2);
  // Taller value, taller column: Apr's Sales (200) against Jan's (120).
  const sales = bars.filter(o => o.args[4] === '#4472c4' && (o.args[3] as number) > 10).map(o => o.args[3] as number);
  assert.ok(Math.abs(sales[3] / sales[0] - 200 / 120) < 0.01, 'heights in proportion');

  const pie: Chart = { ...col, type: 'pie', title: null, labels: true, series: [col.series[0]] };
  const pp = new RecordPainter();
  drawChart(pp, pie, chartData(wb, 0, pie), pie.w, pie.h);
  assert.equal(pp.ops.filter(o => o.op === 'shape').length, 4, 'one slice per month');
  assert.ok(pp.texts().includes('Sales'), 'an automatic title: the one series name');
  assert.ok(pp.texts().includes('Jan') && pp.texts().includes('200'), 'slices in the legend, values on them');

  const line: Chart = { ...col, type: 'line' };
  const lp = new RecordPainter();
  drawChart(lp, line, chartData(wb, 0, line), line.w, line.h);
  // Sales markers are circles, Costs markers squares: not only colour tells them apart.
  assert.ok(lp.ops.filter(o => o.op === 'circle' && o.args[3] === '#4472c4').length >= 4);
  assert.ok(lp.ops.filter(o => o.op === 'rect' && o.args[4] === '#ed7d31').length >= 4);
});

test('axis steps are round numbers, starting at zero unless the values sit in a narrow band', () => {
  // Excel leaves 5% room above the highest value: 200 reaches 250, as Excel's own axis does.
  assert.deepEqual(niceScale(0, 200, 6, true), { lo: 0, hi: 250, step: 50 });
  assert.deepEqual(niceScale(3, 97, 7, true), { lo: 0, hi: 120, step: 20 });
  const narrow = niceScale(1000, 1050, 5, false);
  assert.ok(narrow.lo >= 980 && narrow.lo <= 1000 && narrow.hi >= 1050 && narrow.hi <= 1080, `a narrow band keeps its own start, not zero: ${JSON.stringify(narrow)}`);
  assert.deepEqual(niceScale(-40, 60, 7, true), { lo: -60, hi: 80, step: 20 });
});

test('charts follow their cells: rows inserted above, a sheet renamed or deleted, undo, saving', () => {
  const wb = book(SALES);
  wb.addSheet();
  const id = wb.addChart(0, { ...chartFromRange(wb, 0, R('A1:C5'), 'column'), ...place });
  assert.equal(wb.sheets[0].charts.length, 1);
  wb.shiftAxis(0, 'row', 0, 2);
  const moved = wb.sheets[0].charts[0];
  assert.equal(moved.at.row, 3, 'the chart moved down with its cell');
  assert.equal(moved.series[0].val, 'Sheet1!$B$4:$B$7', 'and its references with the data');
  assert.deepEqual(chartData(wb, 0, moved).series[0].values, [120, 150, 90, 200]);
  wb.renameSheet(0, 'Money');
  assert.equal(wb.sheets[0].charts[0].series[0].val, 'Money!$B$4:$B$7');
  // A chart on another sheet that reads this one is renamed too; when this sheet goes, it reads nothing.
  wb.addChart(1, { ...wb.sheets[0].charts[0], at: { col: 0, row: 0, dx: 0, dy: 0 } });
  assert.equal(wb.sheets[1].charts[0].series[1].cat, 'Money!$A$4:$A$7');
  wb.undo();
  wb.undo();
  assert.equal(wb.sheets[0].charts[0].series[0].val, 'Sheet1!$B$4:$B$7');
  wb.undo();
  assert.equal(wb.sheets[0].charts[0].at.row, 1);
  // Saved and opened again: the same chart.
  wb.setChart(0, id, { ...wb.sheets[0].charts[0], title: 'Kept', labels: true, legend: 'b', group: 'stacked', xTitle: 'Month' });
  const back = reopen(wb);
  const ch = back.sheets[0].charts[0];
  assert.equal(ch.title, 'Kept');
  assert.equal(ch.legend, 'b');
  assert.equal(ch.group, 'stacked');
  assert.equal(ch.xTitle, 'Month');
  assert.equal(ch.labels, true);
  // A damaged chart in a file is left out, not a reason to refuse the file.
  const raw = JSON.parse(wb.serialize());
  raw.sheets[0].charts.push({ type: 'pie3d', series: [] }, { type: 'pie', at: { col: 1, row: 1 }, series: [{ val: '' }] });
  const again = new Workbook();
  again.load(raw);
  assert.equal(again.sheets[0].charts.length, 1);
  // Deleted, and back with Undo.
  wb.setChart(0, id, null);
  assert.equal(wb.sheets[0].charts.length, 0);
  wb.undo();
  assert.equal(wb.sheets[0].charts.length, 1);
});

test('switch row/column turns series in columns into series in rows', () => {
  const wb = book(SALES);
  const ch: Chart = { ...chartFromRange(wb, 0, R('A1:C5'), 'column'), id: 1, ...place };
  const sw = switchRowCol(wb, 0, ch)!;
  assert.equal(sw.series.length, 4);
  assert.deepEqual([sw.series[0].name, sw.series[0].cat, sw.series[0].val], ['=Sheet1!$A$2', 'Sheet1!$B$1:$C$1', 'Sheet1!$B$2:$C$2']);
  const back = switchRowCol(wb, 0, sw)!;
  assert.deepEqual(back.series.map(s => s.val), ch.series.map(s => s.val));
  assert.deepEqual(refRange(wb, 0, "'Sheet1'!$A$1:$B$2")?.range, R('A1:B2'));
  assert.equal(refRange(wb, 0, 'Nowhere!A1'), null);
});

test('text measuring and wrapping use Helvetica widths', () => {
  assert.equal(textWidth('Hello', 10), (722 + 556 + 222 + 222 + 556) / 100);
  assert.ok(textWidth('W', 10, true) > textWidth('i', 10, true));
  assert.deepEqual(wrapText('one two three four', textWidth('one two ', 10), 10), ['one two', 'three', 'four']);
});

test('pages: the used cells cut down then over, fit to one page wide, print area, title rows, headers', () => {
  const cells: Record<string, string> = {};
  for (let r = 1; r <= 120; r++) for (const c of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L']) cells[`${c}${r}`] = String(r);
  const wb = book(cells);
  const setup = defaultPage('a4');
  // A4 portrait inside normal margins: 494.5 x 733.9 points; columns 48 points, rows 15.
  const plan = planPages(wb, 0, setup)!;
  assert.equal(plan.k, 1);
  assert.deepEqual(plan.pages.slice(0, 3).map(p => [p.c0, p.c1, p.r0, p.r1]), [[0, 9, 0, 47], [0, 9, 48, 95], [0, 9, 96, 119]]);
  assert.deepEqual(plan.pages.slice(3).map(p => [p.c0, p.c1]), [[10, 11], [10, 11], [10, 11]], 'down, then over');
  assert.equal(plan.pages.length, 6);
  const over = planPages(wb, 0, { ...setup, order: 'over' })!;
  assert.deepEqual([over.pages[1].c0, over.pages[1].r0], [10, 0]);
  const fit = planPages(wb, 0, { ...setup, fit: { w: 1, h: 0 } })!;
  assert.ok(fit.k < 1 && fit.k >= 0.8, `fit to one page wide shrinks it: ${fit.k}`);
  assert.ok(fit.pages.every(p => p.c0 === 0 && p.c1 === 11));
  const one = planPages(wb, 0, { ...setup, fit: { w: 1, h: 1 } })!;
  assert.equal(one.pages.length, 1);
  // Fitting never makes a small sheet bigger than it is (Excel's fit stops at 100%).
  assert.equal(planPages(book({ A1: 'x' }), 0, { ...setup, fit: { w: 1, h: 1 } })!.k, 1);
  const area = planPages(wb, 0, { ...setup, area: R('B2:C4') })!;
  assert.deepEqual(area.pages, [{ c0: 1, c1: 2, r0: 1, r1: 3 }]);
  assert.equal(planPages(new Workbook(), 0, setup), null, 'an empty sheet has nothing to print');
  // Title rows are drawn again on page 2.
  const p2 = new RecordPainter();
  wb.setInput(0, 0, 0, 'Heading');
  drawPage(p2, wb, 0, planPages(wb, 0, { ...setup, titleRows: [0, 0], footer: '&CPage &P of &N', header: '&L&A' })!, 1, 'Book.sheet');
  assert.ok(p2.texts().includes('Heading'), 'the title row repeats');
  assert.ok(p2.texts().includes('Page 2 of 6'));
  assert.ok(p2.texts().includes('Sheet1'));
  assert.deepEqual(headerParts('&LLeft &&&C&"Arial,Bold"&14Mid &P&RRight &N', { page: 3, pages: 9, sheet: 'S', file: 'F' }), { l: 'Left &', c: 'Mid 3', r: 'Right 9' });
  // A chart reaches past the cells: the print range takes it in.
  const small = book({ A1: '1', A2: '2' });
  small.addChart(0, { ...chartFromRange(small, 0, R('A1:A2'), 'column'), at: { col: 2, row: 0, dx: 0, dy: 0 }, w: 200, h: 100 });
  const pr = printRange(small, 0)!;
  assert.ok(pr.c1 >= 5 && pr.r1 >= 4, `chart's cells included: ${JSON.stringify(pr)}`);
});

test('a PDF written here opens in a PDF reader, its index points at every object, and text is in Windows letters', async () => {
  const wb = book({ ...SALES, A7: 'Café € “quoted” (x) \\ 日本' });
  wb.addChart(0, { ...chartFromRange(wb, 0, R('A1:C5'), 'pie'), at: { col: 4, row: 0, dx: 5, dy: 5 }, w: 300, h: 200 });
  const plan = planPages(wb, 0, { ...defaultPage('letter'), gridlines: true, headings: true, footer: '&CPage &P' })!;
  const doc = new Writer();
  doc.title = 'Sales.sheet';
  for (let i = 0; i < plan.pages.length; i++) drawPage(doc.addPage(612, 792), wb, 0, plan, i, 'Sales.sheet');
  const bytes = await doc.bytes();
  // Byte for byte (TextDecoder's "latin1" is really Windows-1252, which would change bytes 128-159).
  const text = Buffer.from(bytes).toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  // Every object is where the index says it is.
  const start = Number(/startxref\n(\d+)/.exec(text)![1]);
  assert.ok(text.slice(start).startsWith('xref'));
  const rows = text.slice(start).split('\n').slice(2).filter(l => / n $/.test(l));
  rows.forEach((row, i) => assert.ok(text.slice(Number(row.slice(0, 10))).startsWith(`${i + 1} 0 obj`), `object ${i + 1} is where the index says`));
  const read = await Reader.open(bytes);
  assert.equal(read.pages.length, plan.pages.length);
  assert.deepEqual(read.pages[0].box, [0, 0, 612, 792]);
  // The page's drawing, unpacked: the words are there, in Windows letters.
  const m = /stream\n([\s\S]*?)\nendstream/.exec(text.slice(text.indexOf('/Type /Page /Parent')))!;
  const content = inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
  assert.ok(content.includes('(Month) Tj'));
  assert.ok(content.includes(`${pdfString('Café € “quoted” \\(x\\)').slice(0, 5)}`));
  assert.equal(pdfString('Café € “q” (x) \\ 日'), '(Caf\\351 \\200 \\223q\\224 \\(x\\) \\\\ ?)');
  assert.ok(content.includes('(Page 1) Tj'));
  assert.ok(/re f/.test(content) && /\d+ \d+ m .* l/.test(content), 'shapes and lines drawn');
});

test('moving a chart with the arrow keys: a whole run of nudges is one Undo, so it cannot push real edits out of the 100 steps', () => {
  const wb = book({ A1: 'n', A2: '1', A3: '2' });
  wb.addChart(0, { ...chartFromRange(wb, 0, R('A1:A3'), 'column'), at: { col: 2, row: 0, dx: 0, dy: 0 }, w: 200, h: 100 });
  const ch = wb.sheets[0].charts[0];
  const place = () => wb.sheets[0].charts[0].at.col;
  for (let i = 1; i <= 150; i++) wb.setChart(0, ch.id, { ...ch, at: { ...ch.at, col: i } }, 'run 1');
  assert.equal(place(), 150);
  wb.undo();
  assert.equal(place(), ch.at.col, 'one Undo: back where the run started');
  assert.equal(wb.display(0, 0, 0), 'n', 'the typing is still there');
  wb.redo();
  assert.equal(place(), 150, 'one Redo: where it ended');
  // A new run, or anything done in between, starts a new step.
  wb.setChart(0, ch.id, { ...ch, at: { ...ch.at, col: 200 } }, 'run 2');
  wb.undo();
  assert.equal(place(), 150);
  wb.setChart(0, ch.id, { ...ch, at: { ...ch.at, col: 201 } }, 'run 3');
  wb.setInput(0, 5, 5, 'typed');
  wb.setChart(0, ch.id, { ...ch, at: { ...ch.at, col: 202 } }, 'run 3');
  wb.undo();
  assert.equal(place(), 201, 'the nudge after the typing is a step of its own');
});
