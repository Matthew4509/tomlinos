// The made-up work behind the spreadsheet screensaver: each kind's heading, columns, rows and formulas. Kept apart from
// the fake spreadsheet itself (which carries the spreadsheet's grid) so the setup guide's small preview can draw the
// same sheet without loading the grid.
import { SHEET_KINDS, type SheetKind } from '../shell/session.ts';

export const COLS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

/**
 * One kind of work: its heading, the column names after the first, the rows (a name and a typical number), which
 * columns hold typed numbers (the rest are formulas made by `formulas` for row r), and the other two tab names.
 */
export interface Kind {
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

export const KINDS: Record<SheetKind, Kind> = {
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

