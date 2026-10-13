// Excel tables (Insert > Table, Home > Format as Table): a block of cells with a header row of column names, banded
// rows in a ready-made style, filter buttons, an optional total row, and names formulas can use (Sales[Amount],
// [@Amount] for the same row). The workbook keeps the tables (workbook.ts); this file has their rules: where a table
// is, what part of it a reference means, and how each of Excel's table styles colours a cell.
import { mixColour } from './paint.ts';
import { MAX_COLS, MAX_ROWS, type TablePart } from './refs.ts';
import { CellError, E, type CellStyle, type Line } from './values.ts';

export interface Range {
  c0: number;
  r0: number;
  c1: number;
  r1: number;
}

/** The sum a total row cell shows, by the SUBTOTAL number Excel writes for it. */
export type TotalFn = 'none' | 'sum' | 'average' | 'count' | 'countNums' | 'max' | 'min' | 'stdDev' | 'var' | 'custom';
export const TOTAL_CODE: Record<Exclude<TotalFn, 'none' | 'custom'>, number> = { average: 101, countNums: 102, count: 103, max: 104, min: 105, stdDev: 107, sum: 109, var: 110 };
export const TOTAL_LABEL: Record<TotalFn, string> = { none: 'None', average: 'Average', count: 'Count', countNums: 'Count numbers', max: 'Max', min: 'Min', sum: 'Sum', stdDev: 'StdDev', var: 'Var', custom: 'Own formula' };

export interface TableColumn {
  name: string;
  /** What the total row shows under this column. */
  total?: TotalFn;
  /** The words in the total row under this column, when it shows words (the first column's "Total"). */
  label?: string;
}

export interface Table {
  /** Unique in the workbook (Excel numbers its tables). */
  id: number;
  name: string;
  /** The whole table: header row (when shown), data rows, total row (when shown). */
  range: Range;
  header: boolean;
  totals: boolean;
  /** One of Excel's table styles ("TableStyleMedium2"), or "" for none. */
  style: string;
  bandRows: boolean;
  bandCols: boolean;
  firstCol: boolean;
  lastCol: boolean;
  /** Filter buttons on the header row (the sheet's filter is the table's while it has them). */
  filter: boolean;
  columns: TableColumn[];
}

export const MAX_TABLES = 100;
export const DEFAULT_STYLE = 'TableStyleMedium2';

/** The rows that hold data (not the header or the total row). */
export const dataRows = (t: Table): { r0: number; r1: number } => ({ r0: t.range.r0 + (t.header ? 1 : 0), r1: t.range.r1 - (t.totals ? 1 : 0) });

/** The table a cell is in, if any. */
export function tableAt(tables: Table[], col: number, row: number): Table | null {
  for (const t of tables) if (col >= t.range.c0 && col <= t.range.c1 && row >= t.range.r0 && row <= t.range.r1) return t;
  return null;
}

// ---- Styles ------------------------------------------------------------------------------------------------------------

/** The Office theme's accent colours; index 0 is "none" (black and greys). */
const ACCENTS = ['#000000', '#4472c4', '#ed7d31', '#a5a5a5', '#ffc000', '#5b9bd5', '#70ad47'];
const tint = (hex: string, t: number) => mixColour(hex, '#ffffff', t);
const shade = (hex: string, t: number) => mixColour(hex, '#000000', t);

type Kind = 'L1' | 'L2' | 'L3' | 'M1' | 'M2' | 'M3' | 'M4' | 'D1' | 'D2';

/** Excel's table styles by family and number, as the look this spreadsheet draws (close to Excel's, not the same). */
function recipe(style: string): { kind: Kind; accent: number } | null {
  const m = /^TableStyle(Light|Medium|Dark)(\d{1,2})$/.exec(style);
  if (!m) return null;
  const n = Number(m[2]);
  if (m[1] === 'Light' && n >= 1 && n <= 21) return { kind: n <= 7 ? 'L1' : n <= 14 ? 'L2' : 'L3', accent: (n - 1) % 7 };
  if (m[1] === 'Medium' && n >= 1 && n <= 28) return { kind: n <= 7 ? 'M1' : n <= 14 ? 'M2' : n <= 21 ? 'M3' : 'M4', accent: (n - 1) % 7 };
  if (m[1] === 'Dark' && n >= 1 && n <= 11) return n <= 7 ? { kind: 'D1', accent: n - 1 } : { kind: 'D2', accent: [0, 1, 3, 5][n - 8] };
  return null;
}

/** Every table style offered (Home > Format as Table), in Excel's order. */
export const TABLE_STYLES: Array<{ name: string; label: string }> = [
  ...Array.from({ length: 21 }, (_, i) => ({ name: `TableStyleLight${i + 1}`, label: `Light ${i + 1}` })),
  ...Array.from({ length: 28 }, (_, i) => ({ name: `TableStyleMedium${i + 1}`, label: `Medium ${i + 1}` })),
  ...Array.from({ length: 11 }, (_, i) => ({ name: `TableStyleDark${i + 1}`, label: `Dark ${i + 1}` })),
];

const ACCENT_NAMES = ['black and grey', 'blue', 'orange', 'grey', 'gold', 'light blue', 'green'];
/** A style's name in words, with its colour: "Medium 2 (blue)". */
export const styleLabel = (style: string): string => {
  const r = recipe(style);
  const own = TABLE_STYLES.find(s => s.name === style);
  return own && r ? `${own.label} (${ACCENT_NAMES[r.accent]})` : 'None';
};

/** The main colour of a style, for its swatch in the menu. */
export const styleSwatch = (style: string): string => {
  const r = recipe(style);
  return r ? (r.accent ? ACCENTS[r.accent] : '#595959') : '#ffffff';
};

/**
 * How a table's style colours one cell: fill, text colour, bold and borders. The cell's own formatting is laid over this
 * (as Excel lets a cell's formatting win over the table's).
 */
export function tableLook(t: Table, col: number, row: number): CellStyle | null {
  const r = recipe(t.style);
  if (!r) return null;
  const a = ACCENTS[r.accent];
  const dark = r.accent ? a : '#000000';
  const pale = r.accent ? tint(a, 0.8) : '#d9d9d9';
  const mid = r.accent ? tint(a, 0.6) : '#bfbfbf';
  const line = r.accent ? tint(a, 0.4) : '#8c8c8c';
  const { c0, c1 } = t.range;
  const head = t.header && row === t.range.r0;
  const total = t.totals && row === t.range.r1;
  const dr = dataRows(t);
  const k = row - dr.r0;
  const j = col - c0;
  const odd = t.bandRows && !head && !total && k % 2 === 0;
  const oddCol = t.bandCols && !head && !total && j % 2 === 0;
  const out: CellStyle = {};
  const box = (lineKind: Line, colour: string, top = true, bottom = true, sides = false) => {
    if (top) out.bt = lineKind;
    if (bottom) out.bb = lineKind;
    if (sides) {
      out.bl = lineKind;
      out.br = lineKind;
    }
    out.bc = colour;
  };
  switch (r.kind) {
    case 'L1':
      if (head) {
        out.b = true;
        box(true, dark, true, true);
      } else if (total) {
        out.b = true;
        out.bt = 'double';
        out.bb = true;
        out.bc = dark;
      } else {
        if (odd || oddCol) out.fill = pale;
        if (row === dr.r1 && !t.totals) {
          out.bb = true;
          out.bc = dark;
        }
      }
      break;
    case 'L2':
      if (head) {
        out.fill = dark;
        out.color = '#ffffff';
        out.b = true;
      } else if (total) {
        out.b = true;
        out.bt = 'double';
        out.bc = dark;
      } else box(true, dark, row === dr.r0, true);
      if (col === c0) out.bl = true;
      if (col === c1) out.br = true;
      out.bc ??= dark;
      if (row === t.range.r1) out.bb = true;
      break;
    case 'L3':
      if (head) out.b = true;
      if (total) {
        out.b = true;
        out.bt = 'double';
      }
      if (!head && !total && (odd || oddCol)) out.fill = pale;
      box(true, line, true, true, true);
      if (total) out.bt = 'double';
      break;
    case 'M1':
      if (head) {
        out.fill = dark;
        out.color = '#ffffff';
        out.b = true;
      } else if (total) {
        out.b = true;
        out.bt = 'double';
        out.bc = dark;
      } else {
        if (odd || oddCol) out.fill = pale;
        out.bb = true;
        out.bt = true;
        out.bc = line;
      }
      break;
    case 'M2':
      if (head) {
        out.fill = dark;
        out.color = '#ffffff';
        out.b = true;
      } else if (total) {
        out.fill = dark;
        out.color = '#ffffff';
        out.b = true;
      } else {
        out.fill = odd || oddCol ? mid : pale;
        box(true, '#ffffff', true, true, true);
      }
      break;
    case 'M3':
      if (head) {
        out.fill = '#000000';
        out.color = '#ffffff';
        out.b = true;
      } else if (total) {
        out.b = true;
        out.bt = 'double';
        out.bc = '#000000';
      } else out.fill = odd || oddCol ? (r.accent ? tint(a, 0.6) : '#a6a6a6') : r.accent ? tint(a, 0.8) : '#d9d9d9';
      if (row === t.range.r0 || row === t.range.r1) {
        out.bc ??= '#000000';
        if (row === t.range.r0) out.bt = 'medium';
        if (row === t.range.r1) out.bb = 'medium';
      }
      break;
    case 'M4':
      if (head) out.b = true;
      if (total) {
        out.b = true;
        out.bt = 'double';
      }
      out.fill = head || total ? pale : odd || oddCol ? mid : pale;
      box(true, line, true, true, true);
      if (total) out.bt = 'double';
      break;
    case 'D1':
      if (head) {
        out.fill = '#000000';
        out.color = '#ffffff';
        out.b = true;
        out.bb = 'medium';
        out.bc = '#ffffff';
      } else if (total) {
        out.fill = shade(dark, 0.5);
        out.color = '#ffffff';
        out.b = true;
        out.bt = 'double';
        out.bc = '#ffffff';
      } else {
        out.fill = odd || oddCol ? shade(r.accent ? a : '#737373', 0.25) : r.accent ? a : '#737373';
        out.color = '#ffffff';
      }
      break;
    case 'D2':
      if (head) {
        out.fill = '#000000';
        out.color = '#ffffff';
        out.b = true;
      } else if (total) {
        out.b = true;
        out.bt = 'double';
        out.bc = '#000000';
        out.fill = pale;
      } else out.fill = odd || oddCol ? mid : pale;
      break;
  }
  // First and last column picked out in bold, as the table's options ask.
  if (!head && ((t.firstCol && col === c0) || (t.lastCol && col === c1))) out.b = true;
  return out;
}

/** A cell's own look laid over its table's: whatever the cell sets itself wins, side by side for borders. */
export function overTable(own: CellStyle | undefined, look: CellStyle | null): CellStyle | undefined {
  if (!look) return own;
  if (!own) return look;
  const out: CellStyle = { ...look };
  for (const [k, v] of Object.entries(own) as Array<[keyof CellStyle, unknown]>) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  // A border colour of the cell's own counts only for its own borders.
  if (own.bc === undefined && (own.bt || own.bb || own.bl || own.br) && look.bc) out.bc = undefined;
  return out;
}

// ---- References to parts of a table ------------------------------------------------------------------------------------

/** The cells a structured reference covers: which table (by name, or the one the formula is in), which rows and columns. */
export function partBox(tables: Array<{ s: number; t: Table }>, part: TablePart, current: number, here?: { col: number; row: number }): { s: number; c0: number; r0: number; c1: number; r1: number } | CellError {
  let found: { s: number; t: Table } | undefined;
  if (part.table) found = tables.find(x => x.t.name.toLowerCase() === part.table.toLowerCase());
  else if (here) found = tables.find(x => x.s === current && x.t.range.c0 <= here.col && here.col <= x.t.range.c1 && x.t.range.r0 <= here.row && here.row <= x.t.range.r1);
  if (!found) return E.REF;
  const { s, t } = found;
  const colIndex = (name: string | undefined, fallback: number): number => {
    if (name === undefined) return fallback;
    const i = t.columns.findIndex(c => c.name.toLowerCase() === name.trim().toLowerCase());
    return i;
  };
  const a = colIndex(part.c0, 0);
  const b = part.c1 !== undefined ? colIndex(part.c1, 0) : part.c0 !== undefined ? a : t.columns.length - 1;
  if (a < 0 || b < 0) return E.REF;
  const c0 = t.range.c0 + Math.min(a, b);
  const c1 = t.range.c0 + Math.max(a, b);
  const dr = dataRows(t);
  if (part.thisRow) {
    // [@Amount]: the cell of that column in the formula's own row (inside the table's data).
    if (!here || here.row < dr.r0 || here.row > dr.r1) return E.VALUE;
    return { s, c0, c1, r0: here.row, r1: here.row };
  }
  const areas = part.areas.length ? part.areas : ['#data'];
  let r0 = Infinity;
  let r1 = -Infinity;
  for (const area of areas) {
    if (area === '#all') {
      r0 = Math.min(r0, t.range.r0);
      r1 = Math.max(r1, t.range.r1);
    } else if (area === '#headers') {
      if (!t.header) return E.REF;
      r0 = Math.min(r0, t.range.r0);
      r1 = Math.max(r1, t.range.r0);
    } else if (area === '#totals') {
      if (!t.totals) return E.REF;
      r0 = Math.min(r0, t.range.r1);
      r1 = Math.max(r1, t.range.r1);
    } else {
      if (dr.r1 < dr.r0) return E.REF;
      r0 = Math.min(r0, dr.r0);
      r1 = Math.max(r1, dr.r1);
    }
  }
  return { s, c0, c1, r0, r1 };
}

// ---- Checking a saved table --------------------------------------------------------------------------------------------

const TOTALS = new Set<TotalFn>(['none', 'sum', 'average', 'count', 'countNums', 'max', 'min', 'stdDev', 'var', 'custom']);

/** A table from a saved file, checked; null when it is damaged. */
export function cleanTable(raw: unknown, range: (raw: unknown) => Range | null): Table | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const where = range(r.range);
  if (!where || typeof r.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.]{0,254}$/.test(r.name) || !Number.isInteger(r.id) || (r.id as number) < 1) return null;
  if (!Array.isArray(r.columns) || r.columns.length !== where.c1 - where.c0 + 1) return null;
  const columns: TableColumn[] = [];
  for (const c of r.columns) {
    const col = c as Record<string, unknown> | null;
    if (!col || typeof col.name !== 'string' || !col.name || col.name.length > 255) return null;
    columns.push({
      name: col.name,
      ...(typeof col.total === 'string' && TOTALS.has(col.total as TotalFn) && col.total !== 'none' ? { total: col.total as TotalFn } : {}),
      ...(typeof col.label === 'string' && col.label.length <= 255 ? { label: col.label } : {}),
    });
  }
  const names = new Set(columns.map(c => c.name.toLowerCase()));
  if (names.size !== columns.length) return null;
  const header = r.header !== false;
  const totals = r.totals === true;
  // A table needs a row of data (besides its header and total rows).
  if (where.r1 - where.r0 + 1 < 1 + (header ? 1 : 0) + (totals ? 1 : 0)) return null;
  if (where.r1 >= MAX_ROWS || where.c1 >= MAX_COLS) return null;
  return {
    id: r.id as number,
    name: r.name,
    range: where,
    header,
    totals,
    style: typeof r.style === 'string' && (r.style === '' || recipe(r.style)) ? r.style : DEFAULT_STYLE,
    bandRows: r.bandRows !== false,
    bandCols: r.bandCols === true,
    firstCol: r.firstCol === true,
    lastCol: r.lastCol === true,
    filter: r.filter !== false,
    columns,
  };
}

/** Column names made unique and never empty, as Excel makes them ("Column1", "Amount2"). */
export function uniqueColumns(names: string[]): string[] {
  const out: string[] = [];
  const taken = new Set<string>();
  names.forEach((n, i) => {
    const base = n.replace(/[\r\n]+/g, ' ').trim().slice(0, 250) || `Column${i + 1}`;
    let name = base;
    for (let k = 2; taken.has(name.toLowerCase()); k++) name = `${base}${k}`;
    taken.add(name.toLowerCase());
    out.push(name);
  });
  return out;
}

/** A column name as a structured reference writes it (special characters marked with '). */
export const escapeColumn = (name: string): string => name.replace(/['#[\]@]/g, m => `'${m}`);
