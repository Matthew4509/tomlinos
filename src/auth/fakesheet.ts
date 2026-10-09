// The disguise screensaver: a whole-screen spreadsheet of made-up ordinary work (a quarterly budget, a stock list, a
// timesheet or a sales report, with the title the person chose), built from the real spreadsheet's grid so it looks and
// moves like the real thing. Its numbers drift a little now and then, as if someone were working. Nothing in it is saved
// anywhere, and none of it is real data.
import { h } from '../core/dom.ts';
import { createGrid, type Grid } from '../apps/sheet/grid.ts';
import { Workbook } from '../apps/sheet/workbook.ts';
import { icon } from '../shell/icons.ts';
import { SHEET_KINDS, type SheetKind } from '../shell/session.ts';
import type { Shell } from '../shell/types.ts';

const COLS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

/**
 * One kind of work: its heading, the column names after the first, the rows (a name and a typical number), which
 * columns hold typed numbers (the rest are formulas made by `formulas` for row r), and the other two tab names.
 */
interface Kind {
  heading: string;
  first: string;
  columns: string[];
  rows: Array<[string, number]>;
  typed: number[];
  value: (base: number, col: number) => number;
  formulas: (r: number) => Record<string, string>;
  total: string[];
  formats: Array<[number, number, 'comma' | 'percent' | 'currency']>;
  tabs: [string, string];
}

const rnd = (base: number) => Math.round(base * (0.9 + Math.random() * 0.2));

const KINDS: Record<SheetKind, Kind> = {
  budget: {
    heading: 'Operating budget, third quarter', first: 'Cost line',
    columns: ['July', 'August', 'September', 'Q3 total', 'Budget', 'Variance', '% used'],
    rows: [['Salaries', 48200], ['Contractors', 9600], ['Rent', 7400], ['Utilities', 1180], ['Software licences', 2350], ['Travel', 1900],
      ['Marketing', 4200], ['Training', 850], ['Equipment', 2600], ['Insurance', 1320], ['Office supplies', 640], ['Phone and internet', 910],
      ['Legal and accounting', 1750], ['Bank fees', 120], ['Repairs and upkeep', 780], ['Miscellaneous', 450]],
    typed: [1, 2, 3, 5],
    value: (base, col) => (col === 5 ? Math.round((base * 3.05) / 50) * 50 : rnd(base)),
    formulas: r => ({ E: `=SUM(B${r}:D${r})`, G: `=F${r}-E${r}`, H: `=E${r}/F${r}` }),
    total: ['B', 'C', 'D', 'E', 'F', 'G'],
    formats: [[1, 6, 'comma'], [7, 7, 'percent']],
    tabs: ['Actuals', 'Notes'],
  },
  stock: {
    heading: 'Stock on hand, main store', first: 'Item',
    columns: ['In stock', 'Reorder at', 'On order', 'Unit cost', 'Stock value', 'Above reorder', 'Weeks left'],
    rows: [['A4 paper, box of 5', 64], ['Toner, black', 18], ['Toner, colour set', 7], ['Envelopes DL, 500', 22], ['Sticky notes', 140], ['Pens, blue, 50', 31],
      ['Binders, A4', 46], ['Labels, 100 sheets', 12], ['Staples, 5000', 58], ['Coffee beans, 1 kg', 16], ['Milk, UHT, 12', 9], ['Cleaning spray', 27],
      ['Paper towels, 16', 20], ['Batteries AA, 24', 15], ['Whiteboard markers', 38], ['Printer paper A3', 11]],
    typed: [1, 2, 3, 4],
    value: (base, col) => (col === 1 ? rnd(base) : col === 2 ? Math.max(2, Math.round(base * 0.4)) : col === 3 ? (Math.random() < 0.4 ? Math.round(base * 0.5) : 0) : Math.round((5 + Math.random() * 60) * 100) / 100),
    formulas: r => ({ F: `=B${r}*E${r}`, G: `=B${r}-C${r}`, H: `=B${r}/(C${r}/4)` }),
    total: ['B', 'D', 'F'],
    formats: [[1, 4, 'comma'], [5, 5, 'currency'], [6, 7, 'comma']],
    tabs: ['Orders', 'Suppliers'],
  },
  timesheet: {
    heading: 'Hours worked, this week', first: 'Name',
    columns: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Total hours', 'Overtime'],
    rows: [['A. Nguyen', 8], ['B. Patel', 7.5], ['C. Smith', 8], ['D. Rossi', 6], ['E. Kowalski', 8.5], ['F. Garcia', 7.6], ['G. Brown', 8],
      ['H. Tanaka', 7], ['I. Murphy', 8], ['J. Santos', 9], ['K. Oconnor', 7.6], ['L. Chen', 8], ['M. Dubois', 6.5], ['N. Wilson', 8]],
    typed: [1, 2, 3, 4, 5],
    value: base => Math.round(base * (0.9 + Math.random() * 0.2) * 4) / 4,
    formulas: r => ({ G: `=SUM(B${r}:F${r})`, H: `=MAX(0,G${r}-38)` }),
    total: ['B', 'C', 'D', 'E', 'F', 'G', 'H'],
    formats: [[1, 7, 'comma']],
    tabs: ['Last week', 'Leave'],
  },
  sales: {
    heading: 'Sales by region, first quarter', first: 'Region',
    columns: ['January', 'February', 'March', 'Q1 total', 'Target', 'Variance', '% of target'],
    rows: [['North', 84200], ['North East', 61800], ['East', 72500], ['South East', 58900], ['South', 90300], ['South West', 47600],
      ['West', 66100], ['North West', 53400], ['City centre', 112800], ['Online', 97600], ['Wholesale', 71200], ['Export', 38900]],
    typed: [1, 2, 3, 5],
    value: (base, col) => (col === 5 ? Math.round((base * 3.1) / 500) * 500 : rnd(base)),
    formulas: r => ({ E: `=SUM(B${r}:D${r})`, G: `=E${r}-F${r}`, H: `=E${r}/F${r}` }),
    total: ['B', 'C', 'D', 'E', 'F', 'G'],
    formats: [[1, 6, 'comma'], [7, 7, 'percent']],
    tabs: ['By product', 'Notes'],
  },
};

/** The spreadsheet's title: the person's own, or the kind's usual one. */
export function sheetTitle(kind: SheetKind, title: string): string {
  return title.trim() || SHEET_KINDS.find(k => k.id === kind)?.title || 'Workbook';
}

export interface FakeSheet {
  el: HTMLElement;
  grid: Grid;
  /** Nudges one number, as a person editing would. */
  drift(): void;
  /** The title bar's close button (the lock screen hangs its way out on it). */
  close: HTMLButtonElement;
  /** What the browser tab and title bar say ("Q3 Budget - Spreadsheet"). */
  windowTitle: string;
}

export function createFakeSheet(shell: Shell, signal: AbortSignal, kindId: SheetKind = 'budget', title = ''): FakeSheet {
  const k = KINDS[kindId] ?? KINDS.budget;
  const name = sheetTitle(kindId, title);
  const wb = new Workbook();
  wb.renameSheet(0, name.slice(0, 31));
  wb.addSheet();
  wb.renameSheet(1, k.tabs[0]);
  wb.addSheet();
  wb.renameSheet(2, k.tabs[1]);
  wb.active = 0;
  const s = 0;
  const put = (addr: string, text: string) => {
    const col = COLS.indexOf(addr[0]);
    const row = Number(addr.slice(1)) - 1;
    wb.setInput(s, col, row, text);
  };
  put('A1', k.heading);
  put('A3', k.first);
  k.columns.forEach((t, i) => put(`${COLS[i + 1]}3`, t));
  k.rows.forEach(([label, base], i) => {
    const r = i + 4;
    put(`A${r}`, label);
    for (const c of k.typed) put(`${COLS[c]}${r}`, String(k.value(base, c)));
    for (const [col, f] of Object.entries(k.formulas(r))) put(`${col}${r}`, f);
  });
  const last = k.rows.length + 3;
  const total = last + 2;
  put(`A${total}`, 'Total');
  for (const c of k.total) put(`${c}${total}`, `=SUM(${c}4:${c}${last})`);

  const all = (c0: number, r0: number, c1: number, r1: number) => ({ c0, r0, c1, r1 });
  wb.setStyle(s, all(0, 0, 0, 0), st => ({ ...st, b: true }));
  wb.setStyle(s, all(0, 2, 7, 2), st => ({ ...st, b: true, fill: '#dbe9df', bb: true }));
  wb.setStyle(s, all(1, 2, 7, 2), st => ({ ...st, al: 'r' }));
  for (const [c0, c1, fmt] of k.formats) wb.setStyle(s, all(c0, 3, c1, total - 1), st => ({ ...st, fmt, dec: fmt === 'percent' ? 1 : fmt === 'currency' ? 2 : kindId === 'timesheet' ? 2 : 0 }));
  wb.setStyle(s, all(0, total - 1, 7, total - 1), st => ({ ...st, b: true, bt: true }));
  wb.setSize(s, 'col', 0, 170);
  for (let c = 1; c <= 7; c++) wb.setSize(s, 'col', c, 96);

  const grid = createGrid(shell, wb, signal);
  grid.formulaInput.readOnly = true;
  grid.nameBox.readOnly = true;
  const fake = (label: string) => h('span', { class: 'rb text-rb', 'aria-hidden': 'true' }, label);
  const group = (gname: string, ...kids: Node[]) => h('div', { class: 'rgroup' }, h('div', { class: 'rgroup-items' }, ...kids), h('div', { class: 'rgroup-name' }, gname));
  // A window's close button, as any spreadsheet has: the way out a person tries first. It brings up the lock screen.
  const close = h('button', { type: 'button', class: 'fake-close', title: 'Close', 'aria-label': 'Close' }, '✕');
  const tabs = [name, ...k.tabs].map((t, i) => h('span', { class: `sheet-tab${i === 0 ? ' active' : ''}` }, t));
  const windowTitle = `${name} - Spreadsheet`;
  const el = h(
    'div',
    { class: 'sheet fake-sheet' },
    h('div', { class: 'fake-titlebar' }, icon('sheet', 16), h('span', {}, windowTitle), close),
    h('div', { class: 'ribbon-tabs' }, h('span', { class: 'file-tab' }, 'File'), h('span', { class: 'home-tab' }, 'Home')),
    h('div', { class: 'ribbon' },
      group('Clipboard', fake('Paste'), fake('Cut'), fake('Copy')),
      group('Font', fake('B'), fake('I'), fake('U')),
      group('Number', fake('$'), fake('%'), fake(',')),
      group('Editing', fake('Σ AutoSum'), fake('A→Z'), fake('Z→A')),
    ),
    h('div', { class: 'formula-bar' }, grid.nameBox, h('span', { class: 'fx', 'aria-hidden': 'true' }, 'fx'), grid.formulaInput),
    grid.el,
    h('div', { class: 'tabs-bar' }, h('div', { class: 'sheet-tabs' }, ...tabs)),
    h('div', { class: 'statusbar sheet-status' }, h('span', { class: 'fake-mode' }, 'Ready'), h('span', { class: 'spacer' }), h('span', {}, '100%')),
  );

  const drift = () => {
    const i = Math.floor(Math.random() * k.rows.length);
    const row = 3 + i;
    const col = k.typed[Math.floor(Math.random() * Math.min(3, k.typed.length))];
    const now = Number(wb.editText(s, col, row)) || k.rows[i][1];
    const next = Math.max(0, now * (0.985 + Math.random() * 0.03));
    wb.setInput(s, col, row, String(kindId === 'timesheet' ? Math.round(next * 4) / 4 : Math.round(next)));
    grid.goTo(col, row);
    grid.redraw();
  };
  return { el, grid, drift, close, windowTitle };
}
