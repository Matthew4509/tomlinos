// Session 8: text size, typeface, strikethrough, up-and-down alignment and indent (kept in the file, in Excel files and on
// paper), Paste Special, Format Painter, Clear formats; and names and LET as Excel files hold them. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readZip } from '../src/apps/archive/read.ts';
import { drawPage, planPages } from '../src/apps/sheet/print.ts';
import { RecordPainter } from '../src/apps/sheet/paint.ts';
import { PdfDocument } from '../src/apps/sheet/pdf.ts';
import { parseCellRef } from '../src/apps/sheet/refs.ts';
import { keyOf, Workbook } from '../src/apps/sheet/workbook.ts';
import { openXlsx, saveXlsx } from '../src/apps/sheet/xlsx.ts';
import { FUNCTION_NAMES } from '../src/apps/sheet/formula.ts';
import { helpFor } from '../src/apps/sheet/fn-help.ts';
import { labelName } from '../src/apps/sheet/formulas-ui.ts';

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
const styleAt = (wb: Workbook, a: string, s = 0) => {
  const r = parseCellRef(a)!;
  return wb.styleOf(wb.sheets[s].cells.get(keyOf(r.col, r.row))) ?? {};
};
const cellAt = (wb: Workbook, a: string, s = 0) => {
  const r = parseCellRef(a)!;
  return wb.sheets[s].cells.get(keyOf(r.col, r.row));
};
const partText = async (bytes: Uint8Array, name: string) => new TextDecoder().decode(await readZip(bytes).find(e => e.parts.join('/') === name)!.read());

test('fonts: size, typeface, strikethrough, vertical alignment and indent are kept, checked when loaded, and saved', () => {
  const wb = new Workbook();
  put(wb, { A1: 'Title', A2: 'x' });
  wb.setStyle(0, R('A1'), s => ({ ...s, fs: 18, ff: 'Georgia', st: true, va: 'm', ind: 2 }));
  const again = new Workbook();
  again.load(JSON.parse(wb.serialize()));
  assert.deepEqual(styleAt(again, 'A1'), { fs: 18, ff: 'Georgia', st: true, va: 'm', ind: 2 });
  // A damaged or hostile file: odd values are dropped, a typeface that could break the page's CSS is refused.
  const raw = JSON.parse(wb.serialize());
  raw.styles[1] = { fs: 9999, ff: 'Arial"; background:url(x)', st: 'yes', va: 'x', ind: 99 };
  again.load(raw);
  assert.deepEqual(styleAt(again, 'A1'), {});
});

test('fonts go into an Excel file and come back; a size or typeface from Excel is kept, not reported', async () => {
  const wb = new Workbook();
  put(wb, { A1: 'Big', A2: 'Mono', A3: 'Plain' });
  wb.setStyle(0, R('A1'), s => ({ ...s, fs: 20, b: true, va: 't' }));
  wb.setStyle(0, R('A2'), s => ({ ...s, ff: 'Courier New', st: true, ind: 3, al: 'r' }));
  const bytes = await saveXlsx(wb);
  const styles = await partText(bytes, 'xl/styles.xml');
  assert.match(styles, /<font><b\/><sz val="20"\/><color theme="1"\/><name val="Calibri"\/>/);
  assert.match(styles, /<font><strike\/><sz val="11"\/><color theme="1"\/><name val="Courier New"\/><family val="3"\/><\/font>/);
  assert.match(styles, /<alignment vertical="top"\/>/);
  assert.match(styles, /<alignment horizontal="right" indent="3"\/>/);
  const back = new Workbook();
  const report = await openXlsx(back, bytes);
  assert.deepEqual(styleAt(back, 'A1'), { b: true, fs: 20, va: 't' });
  assert.deepEqual(styleAt(back, 'A2'), { st: true, ff: 'Courier New', ind: 3, al: 'r' });
  assert.deepEqual(styleAt(back, 'A3'), {});
  assert.ok(!report.dropped.join(' ').includes('typeface'), report.dropped.join(' | '));
});

test('printing and PDFs use each cell\'s size, kind of typeface and strikethrough', async () => {
  const wb = new Workbook();
  put(wb, { A1: 'Heading', A2: 'Code', A3: 'Struck' });
  wb.setStyle(0, R('A1'), s => ({ ...s, fs: 22 }));
  wb.setStyle(0, R('A2'), s => ({ ...s, ff: 'Consolas' }));
  wb.setStyle(0, R('A3'), s => ({ ...s, st: true, ff: 'Times New Roman' }));
  const plan = planPages(wb, 0)!;
  const p = new RecordPainter();
  drawPage(p, wb, 0, plan, 0);
  const looks = new Map(p.ops.filter(o => o.op === 'text').map(o => [String(o.args[2]), o.args[3] as { size: number; kind?: string; strike?: boolean }]));
  assert.ok(looks.get('Heading')!.size > looks.get('Code')!.size * 1.9, 'the 22-point heading prints twice the size');
  assert.equal(looks.get('Code')!.kind, 'mono');
  assert.equal(looks.get('Struck')!.kind, 'serif');
  assert.equal(looks.get('Struck')!.strike, true);
  // The PDF names the standard Times and Courier fonts, and every object is where its index says.
  const doc = new PdfDocument();
  const page = doc.addPage(595, 842);
  drawPage(page, wb, 0, plan, 0);
  const bytes = await doc.bytes();
  const text = new TextDecoder('latin1').decode(bytes);
  for (const f of ['Times-Roman', 'Courier', 'Helvetica-BoldOblique', 'Courier-BoldOblique']) assert.ok(text.includes(`/BaseFont /${f} `), f);
  const xref = Number(/startxref\n(\d+)/.exec(text)![1]);
  const offsets = text.slice(xref).split('\n').slice(3).filter(l => / n $/.test(l)).map(l => Number(l.slice(0, 10)));
  offsets.forEach((at, i) => assert.ok(text.startsWith(`${i + 1} 0 obj`, at), `object ${i + 1}`));
});

test('Paste Special: values, formulas, formatting, values with formatting, and transpose; one Undo each', () => {
  const wb = new Workbook();
  put(wb, { A1: '2', A2: '3', B1: '=A1*10', B2: '=A2*10', D1: 'kept' });
  wb.setStyle(0, R('B1:B2'), s => ({ ...s, b: true, fill: '#ffff00' }));
  wb.setStyle(0, R('D1'), s => ({ ...s, i: true }));
  // Values: the answers, not the formulas; the cell keeps its own look.
  wb.copyBlock(0, R('B1:B2'), { col: 3, row: 0 }, { what: 'values' });
  assert.deepEqual([cellAt(wb, 'D1')?.v, cellAt(wb, 'D1')?.f, cellAt(wb, 'D2')?.v], [20, undefined, 30]);
  assert.deepEqual(styleAt(wb, 'D1'), { i: true });
  wb.undo();
  assert.equal(cellAt(wb, 'D1')?.v, 'kept');
  // Formulas: moved as a copy is, without the look.
  wb.copyBlock(0, R('B1:B2'), { col: 4, row: 0 }, { what: 'formulas' });
  assert.equal(cellAt(wb, 'E1')?.f, 'D1*10', 'moved three columns, as a copy is');
  assert.deepEqual(styleAt(wb, 'E1'), {});
  // Formatting only: the look, what is typed stays.
  wb.copyBlock(0, R('B1'), { col: 3, row: 0 }, { what: 'formats' });
  assert.equal(cellAt(wb, 'D1')?.v, 'kept');
  assert.deepEqual(styleAt(wb, 'D1'), { b: true, fill: '#ffff00' });
  // Values and formatting.
  wb.copyBlock(0, R('B1'), { col: 5, row: 0 }, { what: 'valuesFormats' });
  assert.equal(cellAt(wb, 'F1')?.v, 20);
  assert.deepEqual(styleAt(wb, 'F1'), { b: true, fill: '#ffff00' });
  // Transpose: a column becomes a row.
  wb.copyBlock(0, R('A1:A2'), { col: 0, row: 4 }, { transpose: true });
  assert.deepEqual([cellAt(wb, 'A5')?.v, cellAt(wb, 'B5')?.v], [2, 3]);
});

test('Format Painter brushes a look onto other cells, repeating a pattern; Clear formats takes looks off and keeps values', () => {
  const wb = new Workbook();
  put(wb, { A1: 'h', A2: '1', C1: 'a', C2: 'b', C3: 'c', C4: 'd' });
  wb.setStyle(0, R('A1'), s => ({ ...s, b: true }));
  wb.setStyle(0, R('A2'), s => ({ ...s, fill: '#c6efce' }));
  wb.paintFormats(0, R('A1:A2'), 0, R('C1:C4'));
  assert.deepEqual(['C1', 'C2', 'C3', 'C4'].map(a => styleAt(wb, a)), [{ b: true }, { fill: '#c6efce' }, { b: true }, { fill: '#c6efce' }]);
  assert.equal(cellAt(wb, 'C3')?.v, 'c');
  wb.undo();
  assert.deepEqual(styleAt(wb, 'C1'), {});
  wb.clearFormats(0, R('A1:A2'));
  assert.deepEqual([styleAt(wb, 'A1'), cellAt(wb, 'A1')?.v], [{}, 'h']);
});

test('names, sheet names and LET go into an Excel file as Excel writes them, and come back', async () => {
  const wb = new Workbook();
  put(wb, { A1: '10', A2: '20', B1: '=SUM(Prices)', B2: '=LET(x,A1,y,x*2,x+y)', B3: '=SUMIFS(A1:A2,A1:A2,">5")', B4: '=STDEV.S(A1:A2)', B5: '=XOR(TRUE,FALSE)' });
  wb.setName('Prices', 'Sheet1!$A$1:$A$2');
  wb.setName('Local', '=5', 'Sheet1', 'only here');
  const bytes = await saveXlsx(wb);
  const book = await partText(bytes, 'xl/workbook.xml');
  assert.match(book, /<definedName name="Local" comment="only here" localSheetId="0">5<\/definedName><definedName name="Prices">Sheet1!\$A\$1:\$A\$2<\/definedName>/);
  const sheet = await partText(bytes, 'xl/worksheets/sheet1.xml');
  assert.match(sheet, /<f>_xlfn\.LET\(_xlpm\.x,A1,_xlpm\.y,_xlpm\.x\*2,_xlpm\.x\+_xlpm\.y\)<\/f>/);
  assert.match(sheet, /<f>_xlfn\.STDEV\.S\(A1:A2\)<\/f>/);
  assert.match(sheet, /<f>_xlfn\.XOR\(TRUE,FALSE\)<\/f>/);
  assert.match(sheet, /<f>SUMIFS\(/, 'SUMIFS is an Excel 2007 function: no prefix');
  const back = new Workbook();
  await openXlsx(back, bytes);
  assert.deepEqual(back.names, [{ name: 'Local', ref: '5', scope: 'Sheet1', comment: 'only here' }, { name: 'Prices', ref: 'Sheet1!$A$1:$A$2' }]);
  assert.equal(cellAt(back, 'B2')?.f, 'LET(x,A1,y,x*2,x+y)');
  assert.deepEqual(['B1', 'B2'].map(a => back.value(0, parseCellRef(a)!.col, parseCellRef(a)!.row)), [30, 30]);
});

test('every function has a line of help, and a label makes a name the way Excel makes one', () => {
  const missing = FUNCTION_NAMES.filter(n => !helpFor(n));
  assert.deepEqual(missing, []);
  assert.equal(labelName('Sales 2026'), 'Sales_2026');
  assert.equal(labelName('2026 sales'), '_2026_sales');
  assert.equal(labelName('Q1'), 'Q1_');
  assert.equal(labelName('  '), null);
});

test('a conditional format or validation formula with ROW() reads the cell it is checking', () => {
  const wb = new Workbook();
  put(wb, { A1: 'a', A2: 'b', A3: 'c' });
  assert.equal(wb.evalFormula(0, 'MOD(ROW(),2)=0', { col: 0, row: 1 }), true);
  assert.equal(wb.evalFormula(0, 'MOD(ROW(),2)=0', { col: 0, row: 2 }), false);
});

test('notes: kept on cells through typing, clearing, copying, sorting and inserting rows; saved and read in Excel files', async () => {
  const wb = new Workbook();
  put(wb, { A1: 'b', A2: 'a' });
  wb.setNote(0, 0, 0, 'First note');
  wb.setNote(0, 3, 3, 'On an empty cell');
  assert.equal(cellAt(wb, 'A1')?.n, 'First note');
  // Typing over the cell and clearing its contents keep the note; Clear notes takes it off; Undo puts it back.
  put(wb, { A1: 'c' });
  wb.clearContents(0, R('A1'));
  assert.equal(cellAt(wb, 'A1')?.n, 'First note');
  wb.clearNotes(0, R('A1'));
  assert.equal(cellAt(wb, 'A1'), undefined);
  wb.undo();
  assert.equal(cellAt(wb, 'A1')?.n, 'First note');
  put(wb, { A1: 'b' });
  // Sorting moves a note with its row; inserting a row above moves it down.
  wb.sortRange(0, R('A1:A2'), 0, true);
  assert.deepEqual([cellAt(wb, 'A1')?.v, cellAt(wb, 'A2')?.v, cellAt(wb, 'A2')?.n], ['a', 'b', 'First note']);
  wb.shiftAxis(0, 'row', 0, 1);
  assert.equal(cellAt(wb, 'A3')?.n, 'First note');
  assert.equal(cellAt(wb, 'D5')?.n, 'On an empty cell');
  // Copy and paste carries it; Paste values leaves the target's own note.
  wb.copyBlock(0, R('A3'), { col: 1, row: 0 });
  assert.equal(cellAt(wb, 'B1')?.n, 'First note');
  // The saved file keeps notes, an Excel file holds them as comments with the box drawing Excel needs.
  const again = new Workbook();
  again.load(JSON.parse(wb.serialize()));
  assert.deepEqual(again.notesOf(0).map(n => n.text), ['First note', 'First note', 'On an empty cell']);
  const bytes = await saveXlsx(wb);
  const comments = await partText(bytes, 'xl/comments1.xml');
  assert.match(comments, /<comment ref="B1" authorId="0">/);
  const vml = await partText(bytes, 'xl/drawings/vmlDrawing1.vml');
  assert.match(vml, /<x:ClientData ObjectType="Note">.*<x:Row>4<\/x:Row><x:Column>3<\/x:Column>/s);
  const sheetXml = await partText(bytes, 'xl/worksheets/sheet1.xml');
  assert.match(sheetXml, /<legacyDrawing r:id="rId\d"\/><\/worksheet>$/);
  const types = await partText(bytes, '[Content_Types].xml');
  assert.match(types, /Extension="vml"/);
  assert.match(types, /\/xl\/comments1\.xml/);
  const back = new Workbook();
  await openXlsx(back, bytes);
  assert.deepEqual(back.notesOf(0).map(n => [n.col, n.row, n.text]), [[1, 0, 'First note'], [0, 2, 'First note'], [3, 4, 'On an empty cell']]);
});
