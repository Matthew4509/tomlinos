// The spreadsheet's data and its rules: sheets of cells, formulas that are worked out when needed, styles, undo and
// redo, inserting and deleting rows and columns (formulas follow), sorting, filling, CSV in and out, and the saved
// file format. No page code here, so it can be tested without a browser.
// A formula whose answer is a list (=SORT(A2:A9), =FILTER(...), =A1:A5*2) fills the cells below and to the right of it
// ("spills"), as in Excel 365; nothing is stored in those cells, so typing in one of them stops the list (#SPILL!).
import { localeDateOrder, readDateTime, shortDateCode, type DateOrder } from './dates.ts';
import { evaluateCell, givesList, leadingFunction, MAX_FORMULA_LENGTH, parseFormula, text as valueToText, type Context, type Grid, type Node } from './formula.ts';
import { codeProblem, formatCode, isDateCode, type Formatted } from './numfmt.ts';
import { plural } from '../../core/format.ts';
import { colName, MAX_COLS, MAX_ROWS, mapRefs, parseCellRef, renameSheetInFormula, shiftFormula, SyntaxProblem, tokenize, type Ref } from './refs.ts';
import { CellError, clean, E, formatNumber, formatValue, type CellStyle, type Value } from './values.ts';
import { cleanChart, mapChartRefs, MAX_CHARTS, type Chart } from './chart.ts';
import { cleanRule, MAX_RANGES, MAX_RULES, subtractAll, type CfEntry } from './condfmt.ts';
import { cleanPage, type PageSetup } from './print.ts';
import { cleanValidation, MAX_VALIDATIONS, type Validation } from './validate.ts';
import { cleanFace } from './fonts.ts';
import {
  cleanTable, dataRows, DEFAULT_STYLE, escapeColumn, MAX_TABLES, overTable, partBox, tableAt, tableLook, TOTAL_CODE, uniqueColumns,
  type Table, type TotalFn,
} from './tables.ts';
import { CellLocked, parseTablePart } from './refs.ts';
import { buildReport, cleanPivot, MAX_PIVOTS, type Pivot, type PivotData } from './pivot.ts';
import { Ev } from './formula.ts';

export const FILE_FORMAT = 'tomlinos-sheet';
/** Spreadsheets saved before the desktop's rename carry this tag; they still open, and are saved with the new one. */
const OLD_FILE_FORMAT = 'myiaos-sheet';
export const MAX_CELLS = 400_000;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_CHANGES_PER_EDIT = 120_000;
/** How many different cell looks (styles) a workbook holds, in a file or being worked on. Excel's own limit is under this. */
export const MAX_STYLES = 70_000;
const MAX_UNDO = 100;
const MAX_TEXT = 32_000;
const MAX_SHEETS = 50;
/** How many formulas deep one look may go before the sheet is worked out top-down instead (well inside a browser's stack). */
const MAX_CHAIN = 400;

/** A chain of formulas deeper than one look may follow (caught by Workbook.value). */
class TooDeep extends Error {}

export interface Cell {
  v?: number | string | boolean;
  /** Formula text, without the leading "=". */
  f?: string;
  /** Index into the workbook's style list. */
  s?: number;
  /** A note on the cell (Review > New note): shown when the pointer is over the cell, marked by a red corner. */
  n?: string;
}

/** The longest note kept, as Excel's limit for a note's text. */
export const MAX_NOTE = 32_000;

/** True when a cell holds nothing at all: no value, formula, look or note (so it is not kept). */
const bare = (c: Cell): boolean => c.v === undefined && c.f === undefined && !c.s && c.n === undefined;

export const keyOf = (col: number, row: number): number => row * MAX_COLS + col;
export const colOfKey = (k: number): number => k % MAX_COLS;
export const rowOfKey = (k: number): number => Math.floor(k / MAX_COLS);

export class Sheet {
  name: string;
  cells = new Map<number, Cell>();
  colW = new Map<number, number>();
  rowH = new Map<number, number>();
  /** Rows whose height was set to fit wrapped text (not dragged by hand): they grow and shrink with it. */
  rowFit = new Set<number>();
  /** Merged blocks: each shows as one cell (the top-left cell's value and look). Never overlapping, never 1 by 1. */
  merges: Range[] = [];
  /** Rows above and columns left of the split stay in view while the rest scrolls (Freeze Panes). */
  freeze = { rows: 0, cols: 0 };
  hiddenRows = new Set<number>();
  hiddenCols = new Set<number>();
  /** The filter (the ▾ buttons on its header row), if this sheet has one. */
  filter: Filter | null = null;
  /** Charts over the cells, back to front. */
  charts: Chart[] = [];
  /** Conditional formatting rules, the first in the list first. */
  cf: CfEntry[] = [];
  /** Data validation rules (each cell has at most one). */
  dv: Validation[] = [];
  /** How the sheet prints (null: as usual, see print.ts defaultPage). */
  page: PageSetup | null = null;
  /** Excel tables on the sheet (Insert > Table). */
  tables: Table[] = [];
  /** PivotTables whose reports are on this sheet. */
  pivots: Pivot[] = [];
  /** The lines between cells are not drawn on screen (View > Gridlines). */
  noGrid = false;
  constructor(name: string) {
    this.name = name;
  }
}

export interface Range {
  c0: number;
  r0: number;
  c1: number;
  r1: number;
}

/** A name for cells or a value ("Prices" = Sheet1!$A$2:$A$40, "TaxRate" = 0.15), for the whole workbook or one sheet. */
export interface DefinedName {
  name: string;
  /** What it stands for: a formula without its "=" (Sheet1!$A$2:$A$40, 0.15, Sheet1!$B$1*12). */
  ref: string;
  /** The sheet it belongs to (only formulas on that sheet see it); unset for the whole workbook. */
  scope?: string;
  comment?: string;
}

const MAX_NAMES = 2000;

/** Why a name cannot be used (null when it can): Excel's rules for names. */
export function nameRuleProblem(name: string): string | null {
  if (!name) return 'A name needs at least one letter.';
  if (name.length > 255) return 'A name can be up to 255 characters long.';
  if (/\s/.test(name)) return 'A name cannot contain spaces. Use an underscore (Sales_tax) or capitals (SalesTax) instead.';
  if (!/^[A-Za-z_]/.test(name)) return 'A name must start with a letter or an underscore (_).';
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) return 'A name can only hold letters, numbers, underscores (_) and full stops (.).';
  if (/^(TRUE|FALSE)$/i.test(name)) return 'TRUE and FALSE cannot be names.';
  if (parseCellRef(name) || /^[A-Za-z]{1,3}\d+$/.test(name) || /^(R|C|R\d+|C\d+|R\d+C\d+)$/i.test(name)) return `"${name}" is a cell address, so it cannot be a name. Try "${name}_" or "My${name}".`;
  return null;
}

/** A filter: its range (the header row first) and, per filtered column, the values (as shown) whose rows stay in view. */
export interface Filter {
  range: Range;
  /** Column index -> the shown texts kept; '' stands for empty cells ("(Blanks)"). */
  cols: Map<number, string[]>;
  /** Column index -> a rule instead of a list (Number filters, Text filters: greater than, contains, top 10...). */
  rules?: Map<number, FilterRule>;
}

/** One condition of a custom filter, as Excel writes it: text may hold * and ? ("a*" begins with a). */
export interface FilterCond {
  op: 'equal' | 'notEqual' | 'greaterThan' | 'greaterThanOrEqual' | 'lessThan' | 'lessThanOrEqual';
  val: string;
}

/** A filter rule on a column: one or two conditions, the top or bottom N (or N%), or above or below the average. */
export type FilterRule =
  | { kind: 'custom'; and: boolean; a: FilterCond; b?: FilterCond }
  | { kind: 'top'; top: boolean; n: number; percent: boolean }
  | { kind: 'average'; above: boolean };

const FILTER_OPS = new Set(['equal', 'notEqual', 'greaterThan', 'greaterThanOrEqual', 'lessThan', 'lessThanOrEqual']);

/** A filter rule from a saved file, checked; null when damaged. */
export function cleanFilterRule(raw: unknown): FilterRule | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const cond = (x: unknown): FilterCond | null => {
    const c = x as Record<string, unknown> | null;
    return c && typeof c.op === 'string' && FILTER_OPS.has(c.op) && typeof c.val === 'string' && c.val.length <= 255 ? { op: c.op as FilterCond['op'], val: c.val } : null;
  };
  if (r.kind === 'custom') {
    const a = cond(r.a);
    const b = r.b === undefined ? undefined : cond(r.b);
    return a && b !== null ? { kind: 'custom', and: r.and !== false, a, ...(b ? { b } : {}) } : null;
  }
  if (r.kind === 'top' && typeof r.n === 'number' && r.n >= 1 && r.n <= 500) return { kind: 'top', top: r.top !== false, n: Math.trunc(r.n), percent: r.percent === true };
  if (r.kind === 'average') return { kind: 'average', above: r.above !== false };
  return null;
}

/** True when a value passes one condition: numbers by size, text without case and with * and ? (as Excel's filter). */
export function condHolds(v: Value, shown: string, c: FilterCond): boolean {
  const num = c.val.trim() !== '' && !Number.isNaN(Number(c.val)) ? Number(c.val) : null;
  if (num !== null && typeof v === 'number') {
    switch (c.op) {
      case 'equal': return v === num;
      case 'notEqual': return v !== num;
      case 'greaterThan': return v > num;
      case 'greaterThanOrEqual': return v >= num;
      case 'lessThan': return v < num;
      default: return v <= num;
    }
  }
  const text = shown.toLowerCase();
  if (c.op === 'equal' || c.op === 'notEqual') {
    const hit = findPattern(c.val, false, true).test(shown);
    return c.op === 'equal' ? hit : !hit;
  }
  // Greater or less than for text: in order of the alphabet.
  const cmp = text.localeCompare(c.val.toLowerCase());
  if (v === null) return false;
  switch (c.op) {
    case 'greaterThan': return cmp > 0;
    case 'greaterThanOrEqual': return cmp >= 0;
    case 'lessThan': return cmp < 0;
    default: return cmp <= 0;
  }
}

export interface FindOptions {
  text: string;
  matchCase?: boolean;
  /** The whole of the cell must match, not just part of it. */
  wholeCell?: boolean;
  /** 'values': what the cells show; 'formulas': what is typed in them (a formula's text). */
  lookIn?: 'values' | 'formulas';
  allSheets?: boolean;
}

export interface Found {
  s: number;
  col: number;
  row: number;
}

export const overlaps = (a: Range, b: Range): boolean => a.c0 <= b.c1 && b.c0 <= a.c1 && a.r0 <= b.r1 && b.r0 <= a.r1;

/**
 * What Excel's Find reads: * is any run of characters, ? any one, ~ makes the next one plain (~* is a star). Matches
 * part of the cell unless `whole`.
 */
export function findPattern(text: string, matchCase = false, whole = false): RegExp {
  let src = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '~' && i + 1 < text.length && '*?~'.includes(text[i + 1])) {
      src += '\\' + text[++i];
    } else if (c === '*') src += '[\\s\\S]*';
    else if (c === '?') src += '[\\s\\S]';
    else src += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  return new RegExp(whole ? `^(?:${src})$` : src, matchCase ? 'g' : 'gi');
}

interface Change {
  sheet: number;
  key: number;
  before?: Cell;
  after?: Cell;
}
type UndoEntry =
  | { kind: 'cells'; changes: Change[] }
  /** `run`: a name shared by steps that count as one (a chart nudged with the arrow keys). */
  | { kind: 'snap'; before: string; after: string; run?: string }
  /** How a sheet is shown (a width, freeze panes, gridlines): small enough to be two little actions, not two copies of the workbook. */
  | { kind: 'view'; before: () => void; after: () => void };

export interface Entry {
  cell?: Cell;
  /** A format the typed text implies (12% is a percent). */
  fmt?: CellStyle;
  /** Text on several lines: the cell wraps, as Excel turns on Wrap Text for it. */
  wrap?: boolean;
}

const NUMBER = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:e[-+]?\d+)?$/i;

/** True when a style shows numbers as dates or times. */
export function isDateStyle(style: CellStyle | undefined): boolean {
  return style?.fmt === 'custom' && !!style.code && isDateCode(style.code);
}

/** A date (and time) as it is put in the editor: in the short date format, so it reads back as the same date. */
function dateEditText(v: number, order: DateOrder): string {
  let day = Math.floor(v);
  let secs = Math.round((v - day) * 86400);
  if (secs >= 86400) {
    day++;
    secs = 0;
  }
  const time = formatCode(secs / 86400, 'h:mm:ss AM/PM').text;
  if (day === 0) return secs ? time : '0';
  const date = formatCode(day, shortDateCode(order)).text;
  return secs ? `${date} ${time}` : date;
}

/**
 * What typing `input` into a cell means. Throws SyntaxProblem for a formula that is not written correctly. `order` is
 * how a typed date is read (13/10/2026 is 13 October when day comes first).
 */
export function parseEntry(input: string, order: DateOrder = 'dmy'): Entry {
  if (input.length > MAX_TEXT) throw new SyntaxProblem('That is too much text for one cell.');
  if (input === '') return {};
  if (input.startsWith('=') && input.length > 1) {
    parseFormula(input.slice(1));
    return { cell: { f: input.slice(1) } };
  }
  if (input.startsWith("'")) return { cell: { v: input.slice(1) } };
  const t = input.trim();
  const upper = t.toUpperCase();
  if (upper === 'TRUE') return { cell: { v: true } };
  if (upper === 'FALSE') return { cell: { v: false } };
  const pct = /^([-+]?[\d.,]+)%$/.exec(t);
  if (pct && NUMBER.test(pct[1]) && /\d/.test(pct[1])) {
    const digits = pct[1].split('.')[1]?.length ?? 0;
    return { cell: { v: clean(Number(pct[1].replace(/,/g, '')) / 100) }, fmt: { fmt: 'percent', dec: digits } };
  }
  const cur = /^(-?)\$\s?([\d.,]+)$/.exec(t);
  if (cur && NUMBER.test(cur[2]) && /\d/.test(cur[2])) {
    return { cell: { v: Number(cur[1] + cur[2].replace(/,/g, '')) }, fmt: { fmt: 'currency', dec: cur[2].split('.')[1]?.length ?? 2 } };
  }
  if (NUMBER.test(t) && /\d/.test(t)) {
    const n = Number(t.replace(/,/g, ''));
    if (Number.isFinite(n)) return { cell: { v: n } };
  }
  // A date or a time is kept as a number of days (as Excel does), shown in the format it was typed in.
  const date = input.includes('\n') ? null : readDateTime(t, order);
  if (date) return { cell: { v: date.serial }, fmt: { fmt: 'custom', code: date.code } };
  return input.includes('\n') ? { cell: { v: input }, wrap: true } : { cell: { v: input } };
}

export class Workbook {
  sheets: Sheet[] = [new Sheet('Sheet1')];
  styles: CellStyle[] = [{}];
  symbol = '$';
  active = 0;
  /** Bumped by every change, so views know to redraw. */
  version = 0;
  /** How typed dates are read: this computer's order (day first in most of the world), as Excel follows Windows. */
  dateOrder: DateOrder = localeDateOrder();
  /** Named ranges and values (Formulas > Name Manager). */
  names: DefinedName[] = [];
  private memo = new Map<number, Value>();
  /** The list each list formula fills, by its memo key; null when it cannot fill (it shows #SPILL!). */
  private spills = new Map<number, Grid | null>();
  /** Per sheet: the cells whose formula can give a list, in key order (top row first), worked out once per change. */
  private listCells: Array<{ v: number; keys: number[] }> = [];
  private fullBoundsCache: Array<{ v: number; cols: number; rows: number }> = [];
  private visiting = new Set<number>();
  /** Parsed formulas, by their text, so a formula that is rewritten in place is always read again. */
  private ast = new Map<string, Node | CellError>();
  private undoStack: UndoEntry[] = [];
  /** The copy the last structural step ended on: the next one starts from it, if nothing has changed since. */
  private lastDump: { version: number; active: number; text: string } | null = null;
  /** Set while asOneStep runs: the view changes that will be one Undo step. */
  private viewGroup: { before: Array<() => void>; after: Array<() => void> } | null = null;
  /** Finds a look already in `styles` without comparing it against every one (see internStyle). */
  private styleIds = new Map<string, number>();
  private styleIdsOf: { list: CellStyle[]; length: number } | null = null;
  private redoStack: UndoEntry[] = [];
  /** Rows and columns the last importText could not fit on the sheet. */
  lastCut = { rows: 0, cols: 0 };
  private boundsCache: Array<{ v: number; cols: number; rows: number }> = [];
  private depth = 0;

  // ---- Working out values ------------------------------------------------------------------------------------------

  private context(current: number, here?: { col: number; row: number }): Context {
    return {
      current,
      here,
      cell: (s, c, r) => this.value(s, c, r),
      sheetIndex: name => this.sheets.findIndex(x => x.name.toLowerCase() === name.toLowerCase()),
      bounds: (s, area) => (area ? this.areaBounds(s, area) : this.fullBounds(s)),
      spill: (s, c, r) => this.spillOf(s, c, r),
      dateOrder: this.dateOrder,
      name: (n, sheet) => this.nameNode(n, sheet, current),
      rowHidden: (s, r) => {
        const sh = this.sheets[s];
        if (!sh?.hiddenRows.has(r)) return null;
        const f = sh.filter;
        return f && (f.cols.size || f.rules?.size) && r > f.range.r0 && r <= f.range.r1 ? 'filter' : 'hand';
      },
      isSubtotal: (s, c, r) => {
        const f = this.sheets[s]?.cells.get(keyOf(c, r))?.f;
        return f !== undefined && /\b(SUBTOTAL|AGGREGATE)\s*\(/i.test(f);
      },
      formulaAt: (s, c, r) => {
        const f = this.sheets[s]?.cells.get(keyOf(c, r))?.f;
        return f === undefined ? null : `=${f}`;
      },
      sheetName: s => this.sheets[s]?.name ?? '',
      table: (part, cur, here) => partBox(this.allTables(), part, cur, here),
    };
  }

  /** Every table in the workbook, with its sheet. */
  allTables(): Array<{ s: number; t: Table }> {
    const out: Array<{ s: number; t: Table }> = [];
    this.sheets.forEach((sh, s) => {
      for (const t of sh.tables) out.push({ s, t });
    });
    return out;
  }

  /** The table a cell is in, if any. */
  tableAt(s: number, col: number, row: number): Table | null {
    return tableAt(this.sheets[s]?.tables ?? [], col, row);
  }

  /** How a cell looks: its own formatting laid over its table's style (when it is in a table). */
  lookOf(s: number, col: number, row: number): CellStyle | undefined {
    const own = this.styleOf(this.sheets[s]?.cells.get(keyOf(col, row)));
    const t = this.sheets[s]?.tables.length ? this.tableAt(s, col, row) : null;
    return t ? overTable(own, tableLook(t, col, row)) : own;
  }

  /** A name's formula, read: one kept for the sheet (the formula's own, or the one named) first, then the workbook's. */
  private nameNode(name: string, sheet: string | undefined, current: number): Node | null {
    const lower = name.toLowerCase();
    const scope = sheet ?? this.sheets[current]?.name;
    const hit = (scope !== undefined ? this.names.find(n => n.scope !== undefined && n.scope.toLowerCase() === scope.toLowerCase() && n.name.toLowerCase() === lower) : undefined)
      ?? (sheet === undefined ? this.names.find(n => n.scope === undefined && n.name.toLowerCase() === lower) : undefined);
    if (!hit) {
      // A table's name on its own stands for its data, as Sales[] does.
      const tab = sheet === undefined ? this.allTables().find(x => x.t.name.toLowerCase() === lower) : undefined;
      return tab ? { t: 'struct', part: { table: tab.t.name, areas: [], thisRow: false } } : null;
    }
    const tree = this.parsed(hit.ref);
    return tree instanceof CellError ? { t: 'err', e: tree } : tree;
  }

  private parsed(f: string): Node | CellError {
    let tree = this.ast.get(f);
    if (!tree) {
      try {
        tree = parseFormula(f);
      } catch (error) {
        // Only a formula that does not read is #NAME?; anything else (the stack running out) is not this formula's fault.
        if (!(error instanceof SyntaxProblem)) throw error;
        tree = E.NAME;
      }
      if (this.ast.size > 50_000) this.ast.clear();
      this.ast.set(f, tree);
    }
    return tree;
  }

  private memoKey(s: number, col: number, row: number): number {
    return s * MAX_ROWS * MAX_COLS + keyOf(col, row);
  }

  /** The cells on a sheet whose formula can give a list, top row first. */
  private listKeys(s: number): number[] {
    const hit = this.listCells[s];
    if (hit && hit.v === this.version) return hit.keys;
    const keys: number[] = [];
    for (const [k, cell] of this.sheets[s]?.cells ?? []) {
      if (cell.f === undefined) continue;
      const tree = this.parsed(cell.f);
      if (!(tree instanceof CellError) && givesList(tree, this.context(s, { col: colOfKey(k), row: rowOfKey(k) }))) keys.push(k);
    }
    keys.sort((a, b) => a - b);
    this.listCells[s] = { v: this.version, keys };
    return keys;
  }

  /** The list a list formula fills (working it out if needed); null when it cannot fill, or it is being worked out. */
  private spillGrid(s: number, key: number): Grid | null {
    const mk = s * MAX_ROWS * MAX_COLS + key;
    if (this.visiting.has(mk)) return null;
    if (!this.spills.has(mk)) this.valueOf(s, colOfKey(key), rowOfKey(key));
    return this.spills.get(mk) ?? null;
  }

  /** The list formula whose list covers this cell (not counting the formula's own cell), and the value it puts there. */
  private spillHit(s: number, col: number, row: number): { key: number; v: Value } | null {
    for (const k of this.listKeys(s)) {
      const ac = colOfKey(k);
      const ar = rowOfKey(k);
      if (ar > row) break;
      if (ac > col || (ac === col && ar === row)) continue;
      const g = this.spillGrid(s, k);
      // The first list (from the top, then the left) that reaches the cell is the one shown there.
      if (g && row < ar + g.length && col < ac + g[0].length) return { key: k, v: g[row - ar][col - ac] };
    }
    return null;
  }

  /** A1#: the list a formula cell fills. */
  private spillOf(s: number, col: number, row: number): Grid | CellError {
    const cell = this.sheets[s]?.cells.get(keyOf(col, row));
    if (cell?.f === undefined) return E.REF;
    const mk = this.memoKey(s, col, row);
    if (this.visiting.has(mk)) return E.CIRC;
    const v = this.valueOf(s, col, row);
    const g = this.spills.get(mk);
    if (g) return g;
    return v instanceof CellError ? v : E.REF;
  }

  /** True when the cell shows a value from a list formula above or to the left of it. */
  isSpilled(s: number, col: number, row: number): boolean {
    const cell = this.sheets[s]?.cells.get(keyOf(col, row));
    if (cell && (cell.v !== undefined || cell.f !== undefined)) return false;
    return this.spillHit(s, col, row) !== null;
  }

  /** The cells a list fills, when this cell is its formula or one of the cells it fills. */
  spillArea(s: number, col: number, row: number): (Range & { col: number; row: number }) | null {
    const cell = this.sheets[s]?.cells.get(keyOf(col, row));
    let key: number;
    if (cell?.f !== undefined) key = keyOf(col, row);
    else if (cell?.v !== undefined) return null;
    else {
      const hit = this.spillHit(s, col, row);
      if (!hit) return null;
      key = hit.key;
    }
    if (!this.listKeys(s).includes(key)) return null;
    const g = this.spillGrid(s, key);
    if (!g || (g.length === 1 && g[0].length === 1)) return null;
    const c0 = colOfKey(key);
    const r0 = rowOfKey(key);
    return { c0, r0, c1: c0 + g[0].length - 1, r1: r0 + g.length - 1, col: c0, row: r0 };
  }

  /** The formula of the list that fills this cell (shown greyed in the formula bar), or null. */
  spillFormula(s: number, col: number, row: number): string | null {
    const cell = this.sheets[s]?.cells.get(keyOf(col, row));
    if (cell && (cell.v !== undefined || cell.f !== undefined)) return null;
    const hit = this.spillHit(s, col, row);
    if (!hit) return null;
    const f = this.sheets[s].cells.get(hit.key)?.f;
    return f === undefined ? null : `=${f}`;
  }

  /**
   * Puts a list formula's answer in place: it fills the cells below and to the right, unless one of them holds
   * something, an earlier list already fills one, or it runs off the sheet; then the formula shows #SPILL!.
   */
  private place(s: number, col: number, row: number, mk: number, g: Grid): Value {
    const rows = g.length;
    const cols = g[0].length;
    if (rows === 1 && cols === 1) {
      this.spills.set(mk, g);
      return g[0][0];
    }
    const blocked = (): boolean => {
      if (row + rows > MAX_ROWS || col + cols > MAX_COLS || rows * cols > MAX_CELLS) return true;
      const inside = (c: number, r: number) => c >= col && c < col + cols && r >= row && r < row + rows && !(c === col && r === row);
      const sheet = this.sheets[s];
      if (rows * cols > sheet.cells.size) {
        for (const [k, cell] of sheet.cells) if ((cell.v !== undefined || cell.f !== undefined) && inside(colOfKey(k), rowOfKey(k))) return true;
      } else {
        for (let r = row; r < row + rows; r++) {
          for (let c = col; c < col + cols; c++) {
            if (c === col && r === row) continue;
            const cell = sheet.cells.get(keyOf(c, r));
            if (cell && (cell.v !== undefined || cell.f !== undefined)) return true;
          }
        }
      }
      // A list cannot fill merged cells (as in Excel).
      const area = { c0: col, r0: row, c1: col + cols - 1, r1: row + rows - 1 };
      if (sheet.merges.some(m => overlaps(m, area))) return true;
      const me = keyOf(col, row);
      for (const k of this.listKeys(s)) {
        if (k >= me) break;
        const other = this.spillGrid(s, k);
        if (!other) continue;
        const oc = colOfKey(k);
        const or = rowOfKey(k);
        if (oc < col + cols && oc + other[0].length > col && or < row + rows && or + other.length > row) return true;
      }
      return false;
    };
    if (blocked()) {
      this.spills.set(mk, null);
      return E.SPILL;
    }
    // Empty cells in the list show as 0, as in Excel.
    const filled = g.map(r => r.map(v => (v === null ? 0 : v)));
    this.spills.set(mk, filled);
    return filled[0][0];
  }

  /**
   * The used area as a range being read sees it: the cells in use, and the lists that could fill cells in the range
   * (only those: a list whose formula is below or to the right of the range cannot reach it, so it is not worked out,
   * and so cannot seem to lean on the formula that is reading the range).
   */
  private areaBounds(s: number, area: Range): { cols: number; rows: number } {
    let { cols, rows } = this.bounds(s);
    for (const k of this.listKeys(s)) {
      const ac = colOfKey(k);
      const ar = rowOfKey(k);
      if (ar > area.r1) break;
      if (ac > area.c1) continue;
      const g = this.spillGrid(s, k);
      if (!g) continue;
      cols = Math.max(cols, ac + g[0].length);
      rows = Math.max(rows, ar + g.length);
    }
    return { cols, rows };
  }

  /** The used area including the cells lists fill. */
  private fullBounds(s: number): { cols: number; rows: number } {
    const hit = this.fullBoundsCache[s];
    if (hit && hit.v === this.version) return { cols: hit.cols, rows: hit.rows };
    let { cols, rows } = this.bounds(s);
    let complete = true;
    for (const k of this.listKeys(s)) {
      const mk = s * MAX_ROWS * MAX_COLS + k;
      if (this.visiting.has(mk)) {
        complete = false;
        continue;
      }
      const g = this.spillGrid(s, k);
      if (!g) continue;
      cols = Math.max(cols, colOfKey(k) + g[0].length);
      rows = Math.max(rows, rowOfKey(k) + g.length);
    }
    // Asked while one of the lists was being worked out, the answer may still grow: it is not kept.
    if (complete) this.fullBoundsCache[s] = { v: this.version, cols, rows };
    return { cols, rows };
  }

  private bounds(s: number): { cols: number; rows: number } {
    const hit = this.boundsCache[s];
    if (hit && hit.v === this.version) return { cols: hit.cols, rows: hit.rows };
    let cols = 0;
    let rows = 0;
    for (const k of this.sheets[s]?.cells.keys() ?? []) {
      cols = Math.max(cols, colOfKey(k) + 1);
      rows = Math.max(rows, rowOfKey(k) + 1);
    }
    this.boundsCache[s] = { v: this.version, cols, rows };
    return { cols, rows };
  }

  usedBounds(s: number): { cols: number; rows: number } {
    return this.fullBounds(s);
  }

  value(s: number, col: number, row: number): Value {
    if (this.depth > 0) return this.valueOf(s, col, row);
    // The cell asked for from outside (the grid, a sum): a chain of formulas each leaning on the one above (a running
    // total down 5,000 rows) is too deep to work out in one go. Then the sheet is worked out from the top down once, each
    // cell remembered, so every cell of the chain needs only its neighbour; only a chain that is still too deep is #NUM!.
    try {
      return this.valueOf(s, col, row);
    } catch (error) {
      if (!(error instanceof TooDeep) && !(error instanceof RangeError)) throw error;
    }
    this.depth = 0;
    this.visiting.clear();
    if (!this.warming) {
      this.warming = true;
      try {
        for (const k of [...this.sheets[s].cells.keys()].sort((a, b) => a - b)) {
          if (k > keyOf(col, row)) break;
          try {
            this.valueOf(s, colOfKey(k), rowOfKey(k));
          } catch (error) {
            if (!(error instanceof TooDeep) && !(error instanceof RangeError)) throw error;
            this.depth = 0;
            this.visiting.clear();
          }
        }
      } finally {
        this.warming = false;
      }
      try {
        return this.valueOf(s, col, row);
      } catch (error) {
        if (!(error instanceof TooDeep) && !(error instanceof RangeError)) throw error;
        this.depth = 0;
        this.visiting.clear();
      }
    }
    // Not remembered: the next look may find more of the chain worked out.
    return E.NUM;
  }

  private warming = false;

  private valueOf(s: number, col: number, row: number): Value {
    const cell = this.sheets[s]?.cells.get(keyOf(col, row));
    if (!cell || (cell.f === undefined && cell.v === undefined)) return this.spillHit(s, col, row)?.v ?? null;
    if (cell.f === undefined) return cell.v ?? null;
    const memoKey = s * MAX_ROWS * MAX_COLS + keyOf(col, row);
    const known = this.memo.get(memoKey);
    if (known !== undefined) return known;
    if (this.visiting.has(memoKey)) return E.CIRC;
    if (this.depth > MAX_CHAIN) throw new TooDeep();
    this.visiting.add(memoKey);
    this.depth++;
    let result: Value;
    try {
      const tree = this.parsed(cell.f);
      if (tree instanceof CellError) result = tree;
      else {
        const ctx = this.context(s, { col, row });
        const out = evaluateCell(tree, ctx);
        if (Array.isArray(out)) result = this.place(s, col, row, memoKey, out);
        else {
          result = out;
          if (givesList(tree, ctx)) this.spills.set(memoKey, out instanceof CellError ? null : [[out]]);
        }
      }
    } finally {
      this.visiting.delete(memoKey);
      this.depth--;
    }
    this.memo.set(memoKey, result);
    return result;
  }

  styleOf(cell: Cell | undefined): CellStyle | undefined {
    return cell?.s ? this.styles[cell.s] : undefined;
  }

  /** What is shown in the cell, and the colour its number format asks for ([Red]), if any. */
  shown(s: number, col: number, row: number): Formatted {
    const cell = this.sheets[s]?.cells.get(keyOf(col, row));
    const v = this.value(s, col, row);
    const style = this.styleOf(cell);
    if (style?.fmt === 'text' && cell?.f === undefined && v !== null) return { text: valueToText(v) };
    return formatValue(v, style, this.symbol);
  }

  /** What is shown in the cell. */
  display(s: number, col: number, row: number): string {
    return this.shown(s, col, row).text;
  }

  /** The text to put in the editor for this cell. */
  editText(s: number, col: number, row: number): string {
    const cell = this.sheets[s]?.cells.get(keyOf(col, row));
    if (!cell) return '';
    if (cell.f !== undefined) return `=${cell.f}`;
    const v = cell.v;
    if (typeof v === 'number') {
      const style = this.styleOf(cell);
      // A date is edited as a date (13/10/2026), not as its number of days.
      if (isDateStyle(style) && v >= 0 && v < 2_958_466) return dateEditText(v, this.dateOrder);
      return style?.fmt === 'percent' ? `${formatNumber(v, { fmt: 'percent', dec: style.dec }, this.symbol)}` : String(clean(v));
    }
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (typeof v === 'string') {
      if (/^[='"]/.test(v) || (parseEntry(v, this.dateOrder).cell?.v !== v && v !== '')) return `'${v}`;
      return v;
    }
    return '';
  }

  internStyle(style: CellStyle): number {
    const clean: CellStyle = {};
    for (const [k, v] of Object.entries(style)) if (v !== undefined && v !== false && v !== null) (clean as Record<string, unknown>)[k] = v;
    const json = JSON.stringify(clean, Object.keys(clean).sort());
    if (json === '{}') return 0;
    if (this.styleIdsOf?.list !== this.styles || this.styleIdsOf.length !== this.styles.length) {
      // A file was opened, or the list changed some other way: looked through once, not once per cell.
      this.styleIds.clear();
      for (let i = this.styles.length - 1; i > 0; i--) this.styleIds.set(JSON.stringify(this.styles[i], Object.keys(this.styles[i]).sort()), i);
    }
    let at = this.styleIds.get(json);
    if (at === undefined) {
      if (this.styles.length >= MAX_STYLES) throw new SyntaxProblem(`A workbook holds up to ${MAX_STYLES.toLocaleString()} different cell looks. Clear the formatting of some cells, save and open the file again, then try once more.`);
      at = this.styles.push(clean) - 1;
      this.styleIds.set(json, at);
    }
    this.styleIdsOf = { list: this.styles, length: this.styles.length };
    return at;
  }

  // ---- Changing cells (with undo) ----------------------------------------------------------------------------------

  private touch(): void {
    this.version++;
    this.memo.clear();
    this.spills.clear();
  }

  /**
   * The date format a new formula takes on, as in Excel: =DATE(...), =TODAY(), =EDATE(...) show a date, =NOW() a date
   * and time, =TIME(...) a time, and =A1+7 (or =MAX(A1:A9)) the date format of the first cell it uses.
   */
  private autoFormat(s: number, f: string): CellStyle | null {
    const tree = this.parsed(f);
    if (tree instanceof CellError) return null;
    const lead = leadingFunction(tree);
    if (lead && ['DATE', 'TODAY', 'EDATE', 'EOMONTH', 'DATEVALUE', 'WORKDAY'].includes(lead)) return { fmt: 'custom', code: shortDateCode(this.dateOrder) };
    if (lead === 'NOW') return { fmt: 'custom', code: `${shortDateCode(this.dateOrder)} h:mm` };
    if (lead === 'TIME' || lead === 'TIMEVALUE') return { fmt: 'custom', code: 'h:mm AM/PM' };
    if (lead && !['MIN', 'MAX'].includes(lead)) return null;
    if (givesList(tree) && lead === null) return null;
    let toks;
    try {
      toks = tokenize(f);
    } catch {
      return null;
    }
    for (let k = 0; k < toks.length; k++) {
      const t = toks[k];
      if (t.type !== 'ident' || toks[k + 1]?.type === 'lp') continue;
      const ref = parseCellRef(t.text);
      if (!ref) continue;
      let sheet = s;
      if (toks[k - 1]?.type === 'bang' && toks[k - 2]) {
        const name = toks[k - 2].type === 'sheetq' ? toks[k - 2].text.slice(1, -1).replace(/''/g, "'") : toks[k - 2].text;
        sheet = this.sheets.findIndex(x => x.name.toLowerCase() === name.toLowerCase());
        if (sheet < 0) return null;
      }
      const style = this.styleOf(this.sheets[sheet].cells.get(keyOf(ref.col, ref.row)));
      return isDateStyle(style) ? { fmt: 'custom', code: style!.code } : null;
    }
    return null;
  }

  /** Applies changes as one undoable step. */
  private applyChanges(changes: Change[]): void {
    if (changes.length > MAX_CHANGES_PER_EDIT) throw new SyntaxProblem('That is too many cells to change at once.');
    for (const ch of changes) {
      const sheet = this.sheets[ch.sheet];
      const before = sheet.cells.get(ch.key);
      ch.before = before;
      if (ch.after) sheet.cells.set(ch.key, ch.after);
      else sheet.cells.delete(ch.key);
    }
    this.pushUndo({ kind: 'cells', changes });
    this.touch();
  }

  /** Runs several changes (a tiled paste, a row of totals) as one step: one Undo takes them all back. */
  batch(fn: () => void): void {
    if (this.batching) return fn();
    this.batching = [];
    try {
      fn();
    } finally {
      const changes = this.batching;
      this.batching = null;
      if (changes.length) this.pushUndo({ kind: 'cells', changes });
    }
  }

  private batching: Change[] | null = null;

  private pushUndo(entry: UndoEntry): void {
    if (this.batching && entry.kind === 'cells') {
      this.batching.push(...entry.changes);
      this.redoStack = [];
      return;
    }
    this.undoStack.push(entry);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
  }

  private assertRoom(extra: number): void {
    let total = 0;
    for (const s of this.sheets) total += s.cells.size;
    if (total + extra > MAX_CELLS) throw new SyntaxProblem(`A workbook holds up to ${MAX_CELLS.toLocaleString()} cells.`);
  }

  /** Types `input` into a cell. Throws SyntaxProblem (with words for the person) if a formula is wrong. */
  setInput(s: number, col: number, row: number, input: string): void {
    // Outside the sheet a cell's number would land on another cell (the next row's first), or make a file that will not open.
    if (!Number.isInteger(col) || !Number.isInteger(row) || col < 0 || row < 0 || col >= MAX_COLS || row >= MAX_ROWS) {
      throw new SyntaxProblem('That is past the edge of the sheet.');
    }
    const pivot = this.pivotAt(s, col, row);
    if (pivot) throw new CellLocked(`This cell is part of the PivotTable “${pivot.name}”, which writes its own cells. Change it with the PivotTable Fields pane, or delete the PivotTable (PivotTable Analyze > Delete) to type here.`);
    const entry = parseEntry(input, this.dateOrder);
    const old = this.sheets[s].cells.get(keyOf(col, row));
    let after: Cell | undefined = entry.cell ? { ...entry.cell } : undefined;
    if (after || old?.s) {
      let style = old?.s ? this.styles[old.s] : undefined;
      if (entry.fmt && !style?.fmt) style = { ...style, ...entry.fmt };
      if (after?.f !== undefined && !style?.fmt) {
        const auto = this.autoFormat(s, after.f);
        if (auto) style = { ...style, ...auto };
      }
      if (entry.wrap && !style?.wrap) style = { ...style, wrap: true };
      // Typing a number into a "Text" cell keeps it as text.
      if (after && style?.fmt === 'text' && after.v !== undefined && typeof after.v !== 'string' && after.f === undefined) after = { v: input };
      const id = style ? this.internStyle(style) : 0;
      if (after) {
        if (id) after.s = id;
      } else if (id) after = { s: id };
    }
    // A note stays on the cell whatever is typed in it.
    if (old?.n !== undefined) after = { ...(after ?? {}), n: old.n };
    if (!old && after) this.assertRoom(1);
    this.applyChanges([{ sheet: s, key: keyOf(col, row), after }]);
    if (this.sheets[s].tables.length && !this.batching) this.afterTyping(s, col, row);
  }

  /** Clears what is typed in the cells but keeps their formatting. */
  clearContents(s: number, r: Range): void {
    const changes: Change[] = [];
    for (const [k, cell] of this.sheets[s].cells) {
      const c = colOfKey(k);
      const rw = rowOfKey(k);
      if (c < r.c0 || c > r.c1 || rw < r.r0 || rw > r.r1) continue;
      const kept: Cell = { ...(cell.s ? { s: cell.s } : {}), ...(cell.n !== undefined ? { n: cell.n } : {}) };
      if (kept.s === cell.s && kept.n === cell.n && cell.v === undefined && cell.f === undefined) continue;
      changes.push({ sheet: s, key: k, after: bare(kept) ? undefined : kept });
    }
    if (changes.length) this.applyChanges(changes);
  }

  /** What formatting a selection reaches: all of it, or if that is too many cells (Select All, several whole columns) as far as the sheet is used. */
  formatArea(s: number, r: Range): Range {
    if ((r.c1 - r.c0 + 1) * (r.r1 - r.r0 + 1) <= MAX_CHANGES_PER_EDIT) return r;
    const used = this.usedBounds(s);
    return { ...r, r1: Math.min(r.r1, Math.max(r.r0, used.rows - 1)), c1: Math.min(r.c1, Math.max(r.c0, used.cols - 1)) };
  }

  /** Changes formatting for every cell in the range (creating empty formatted cells where needed). */
  setStyle(s: number, range: Range, patch: (old: CellStyle) => CellStyle): void {
    const r = this.formatArea(s, range);
    const total = (r.c1 - r.c0 + 1) * (r.r1 - r.r0 + 1);
    if (total > MAX_CHANGES_PER_EDIT) throw new SyntaxProblem('That is too many cells to format at once.');
    const changes: Change[] = [];
    let created = 0;
    for (let row = r.r0; row <= r.r1; row++) {
      for (let col = r.c0; col <= r.c1; col++) {
        const key = keyOf(col, row);
        const old = this.sheets[s].cells.get(key);
        const id = this.internStyle(patch({ ...(old?.s ? this.styles[old.s] : {}) }));
        if ((old?.s ?? 0) === id) continue;
        if (!old) created++;
        const after: Cell = { ...old };
        if (id) after.s = id;
        else delete after.s;
        changes.push({ sheet: s, key, after: bare(after) ? undefined : after });
      }
    }
    this.assertRoom(created);
    if (changes.length) this.applyChanges(changes);
  }

  /**
   * Format Painter: the formatting of the `src` cells laid over `target`, repeated when the target is bigger (as Excel
   * brushes it). What is typed in the target stays. One Undo takes it back.
   */
  paintFormats(fromSheet: number, src: Range, s: number, target: Range): void {
    const w = src.c1 - src.c0 + 1;
    const h = src.r1 - src.r0 + 1;
    // A whole row or column brushed with one cell's look: only as far as the sheet is used (and at least the pattern).
    const used = this.usedBounds(s);
    const t = { ...target, r1: Math.min(target.r1, Math.max(target.r0 + h - 1, used.rows - 1)), c1: Math.min(target.c1, Math.max(target.c0 + w - 1, used.cols - 1)) };
    if ((t.c1 - t.c0 + 1) * (t.r1 - t.r0 + 1) > MAX_CHANGES_PER_EDIT) throw new SyntaxProblem('That is too many cells to format at once.');
    const changes: Change[] = [];
    let created = 0;
    for (let r = t.r0; r <= t.r1; r++) {
      for (let c = t.c0; c <= t.c1; c++) {
        const look = this.sheets[fromSheet].cells.get(keyOf(src.c0 + ((c - t.c0) % w), src.r0 + ((r - t.r0) % h)))?.s;
        const key = keyOf(c, r);
        const old = this.sheets[s].cells.get(key);
        if ((old?.s ?? 0) === (look ?? 0)) continue;
        const after: Cell = { ...old };
        if (look) after.s = look;
        else delete after.s;
        if (!old) created++;
        changes.push({ sheet: s, key, after: bare(after) ? undefined : after });
      }
    }
    this.assertRoom(created);
    if (changes.length) this.applyChanges(changes);
  }

  // ---- Excel tables ---------------------------------------------------------------------------------------------------

  /** Why a table name cannot be used (null when it can): the rules for names, and not taken by a table or a name. */
  tableNameProblem(name: string, except?: Table): string | null {
    const rule = nameRuleProblem(name);
    if (rule) return rule;
    if (this.allTables().some(x => x.t !== except && x.t.name.toLowerCase() === name.toLowerCase())) return `There is already a table called "${name}". Choose another name.`;
    if (this.names.some(n => n.name.toLowerCase() === name.toLowerCase())) return `"${name}" is already a name in this workbook (see the Name Manager, Ctrl+F3). Choose another.`;
    return null;
  }

  /**
   * Makes the block into a table (Insert > Table). Its first row is the header row; without one, the empty row above
   * becomes it. Header cells hold the column names as text, made unique. The sheet's filter becomes the table's when
   * the sheet has none. One Undo.
   */
  addTable(s: number, range: Range, opts: { header: boolean; style?: string }): Table {
    const sheet = this.sheets[s];
    let r = { ...range };
    if (this.allTables().length >= MAX_TABLES) throw new SyntaxProblem(`A workbook holds up to ${MAX_TABLES} tables.`);
    if (sheet.tables.some(t => overlaps(t.range, r))) throw new SyntaxProblem('Part of these cells is already a table. Choose cells outside it, or change that table (Table Design).');
    if (sheet.merges.some(m => overlaps(m, r))) throw new SyntaxProblem('Some of these cells are merged, and a table cannot hold merged cells. Unmerge them first (Merge > Unmerge cells).');
    if (sheet.cells.size && [...this.listKeys(s)].some(k => overlaps({ c0: colOfKey(k), r0: rowOfKey(k), c1: colOfKey(k), r1: rowOfKey(k) }, r) && this.spillArea(s, colOfKey(k), rowOfKey(k)))) {
      throw new SyntaxProblem('A formula in these cells fills the cells around it (a list), which a table cannot hold. Choose other cells.');
    }
    if (!opts.header) {
      // The row above takes the column names, when it is free.
      const above = r.r0 - 1;
      let free = above >= 0;
      for (let c = r.c0; c <= r.c1 && free; c++) free = this.value(s, c, above) === null && !sheet.tables.some(t => overlaps(t.range, { c0: c, r0: above, c1: c, r1: above }));
      if (!free) throw new SyntaxProblem('There is no empty row above these cells for the column names. Insert a row above them (right-click > Insert row) and try again, or tick "My table has headers" if its first row holds them.');
      r = { ...r, r0: above };
    }
    if (r.r1 <= r.r0) r = { ...r, r1: r.r0 + 1 };
    if (r.r1 >= MAX_ROWS) throw new SyntaxProblem('That does not fit on the sheet.');
    const names = uniqueColumns(Array.from({ length: r.c1 - r.c0 + 1 }, (_, i) => (opts.header ? this.display(s, r.c0 + i, r.r0) : '')));
    let n = 1;
    while (this.tableNameProblem(`Table${n}`)) n++;
    const id = Math.max(0, ...this.allTables().map(x => x.t.id)) + 1;
    const table: Table = {
      id, name: `Table${n}`, range: r, header: true, totals: false, style: opts.style ?? DEFAULT_STYLE,
      bandRows: true, bandCols: false, firstCol: false, lastCol: false, filter: !sheet.filter, columns: names.map(name => ({ name })),
    };
    this.snapshotChange(() => {
      // The header cells hold their names as text (a number there becomes its text, as Excel does).
      names.forEach((name, i) => {
        const key = keyOf(r.c0 + i, r.r0);
        const old = sheet.cells.get(key);
        const cell: Cell = { ...old, v: name };
        delete cell.f;
        sheet.cells.set(key, cell);
      });
      sheet.tables.push(table);
      if (table.filter) sheet.filter = { range: { ...r, r1: dataRows(table).r1 }, cols: new Map() };
    });
    return table;
  }

  /** Changes a table's options (style, banding, first and last column, filter buttons). One Undo. */
  setTableOptions(s: number, t: Table, patch: Partial<Pick<Table, 'style' | 'bandRows' | 'bandCols' | 'firstCol' | 'lastCol' | 'filter'>>): void {
    const sheet = this.sheets[s];
    if (patch.filter && !t.filter && sheet.filter && !this.isTableFilter(s, t)) throw new SyntaxProblem('This sheet already has a filter elsewhere (Data > Filter). Turn that one off first, then turn on the table\'s filter buttons.');
    this.snapshotChange(() => {
      Object.assign(t, patch);
      if (patch.filter === true) sheet.filter = { range: { ...t.range, r1: dataRows(t).r1 }, cols: new Map() };
      if (patch.filter === false && this.isTableFilter(s, t)) {
        for (let r = t.range.r0 + 1; r <= t.range.r1; r++) sheet.hiddenRows.delete(r);
        sheet.filter = null;
      }
    });
  }

  /** True when the sheet's filter is this table's. */
  isTableFilter(s: number, t: Table): boolean {
    const f = this.sheets[s].filter;
    return !!f && f.range.r0 === t.range.r0 && f.range.c0 === t.range.c0 && f.range.c1 === t.range.c1;
  }

  /** Renames a table; formulas that use its name are rewritten (as Excel does). */
  renameTable(t: Table, name: string): void {
    const problem = this.tableNameProblem(name.trim(), t);
    if (problem) throw new SyntaxProblem(problem);
    const old = t.name;
    const to = name.trim();
    if (old === to) return;
    this.snapshotChange(() => {
      t.name = to;
      this.rewriteTableRefs(part => (part.table.toLowerCase() === old.toLowerCase() ? { ...part, table: to } : null));
    });
  }

  /** Rewrites the table references in every formula of the workbook; `fn` gives a reference's new parts, or null to leave it. */
  private rewriteTableRefs(fn: (part: ReturnType<typeof parseTablePart>) => ReturnType<typeof parseTablePart> | null): void {
    const swap = (f: string) => rewriteStructs(f, fn);
    for (const sheet of this.sheets) {
      for (const cell of sheet.cells.values()) if (cell.f !== undefined) cell.f = swap(cell.f);
      mapSheetFormulas(sheet, swap);
    }
    for (const n of this.names) n.ref = swap(n.ref);
  }

  /** Total row on or off. On: the row under the table (it must be empty) gets "Total" and a sum under the last column. */
  setTotals(s: number, t: Table, on: boolean): void {
    if (t.totals === on) return;
    const sheet = this.sheets[s];
    if (on) {
      const below = t.range.r1 + 1;
      if (below >= MAX_ROWS) throw new SyntaxProblem('There is no room under the table for a total row.');
      for (let c = t.range.c0; c <= t.range.c1; c++) {
        if (this.value(s, c, below) !== null || sheet.tables.some(x => x !== t && overlaps(x.range, { c0: c, r0: below, c1: c, r1: below }))) {
          throw new SyntaxProblem('The row under the table holds something, so the total row has no room. Move or clear what is in that row, then try again.');
        }
      }
    }
    const owned = this.isTableFilter(s, t);
    this.snapshotChange(() => {
      if (on) {
        t.range = { ...t.range, r1: t.range.r1 + 1 };
        t.totals = true;
        const last = t.columns.length - 1;
        t.columns = t.columns.map((c, i) => ({ ...c, ...(i === 0 && last > 0 ? { label: 'Total', total: undefined } : {}), ...(i === last ? { total: c.total && c.total !== 'none' ? c.total : 'sum' } : {}) }));
        t.columns.forEach((_, i) => this.writeTotal(s, t, i));
      } else {
        for (let c = t.range.c0; c <= t.range.c1; c++) {
          const key = keyOf(c, t.range.r1);
          const cell = sheet.cells.get(key);
          if (!cell) continue;
          const kept: Cell = { ...(cell.s ? { s: cell.s } : {}), ...(cell.n !== undefined ? { n: cell.n } : {}) };
          if (bare(kept)) sheet.cells.delete(key);
          else sheet.cells.set(key, kept);
        }
        t.range = { ...t.range, r1: t.range.r1 - 1 };
        t.totals = false;
      }
      if (owned && sheet.filter) sheet.filter.range = { ...sheet.filter.range, r1: dataRows(t).r1 };
    });
  }

  /** The total row cell of a column: its words, or SUBTOTAL over the column (which leaves filtered rows out). */
  private writeTotal(s: number, t: Table, i: number): void {
    const col = t.columns[i];
    const key = keyOf(t.range.c0 + i, t.range.r1);
    const old = this.sheets[s].cells.get(key);
    const base: Cell = { ...(old?.s ? { s: old.s } : {}), ...(old?.n !== undefined ? { n: old.n } : {}) };
    let cell: Cell = base;
    if (col.total && col.total !== 'none' && col.total !== 'custom') cell = { ...base, f: `SUBTOTAL(${TOTAL_CODE[col.total]},${t.name}[${escapeColumn(col.name)}])` };
    else if (col.label) cell = { ...base, v: col.label };
    else if (col.total === 'custom' && old?.f !== undefined) cell = { ...base, f: old.f };
    if (bare(cell)) this.sheets[s].cells.delete(key);
    else this.sheets[s].cells.set(key, cell);
  }

  /** What a column's total row cell shows (Sum, Average, Count...). One Undo. */
  setTotalFn(s: number, t: Table, i: number, fn: TotalFn): void {
    if (!t.totals || !t.columns[i]) return;
    this.snapshotChange(() => {
      t.columns[i] = { ...t.columns[i], total: fn === 'none' ? undefined : fn, label: undefined };
      this.writeTotal(s, t, i);
    });
  }

  /** Header row on or off; off keeps the column names (formulas still use them), and the row above holds them again when on. */
  setHeader(s: number, t: Table, on: boolean): void {
    if (t.header === on) return;
    const sheet = this.sheets[s];
    if (on) {
      const above = t.range.r0 - 1;
      let free = above >= 0;
      for (let c = t.range.c0; c <= t.range.c1 && free; c++) free = this.value(s, c, above) === null;
      if (!free) throw new SyntaxProblem('The row above the table holds something, so the header row has no room. Clear that row, then try again.');
    } else if (dataRows(t).r1 - dataRows(t).r0 + 1 < 1) return;
    this.snapshotChange(() => {
      if (on) {
        t.range = { ...t.range, r0: t.range.r0 - 1 };
        t.columns.forEach((c, i) => {
          const key = keyOf(t.range.c0 + i, t.range.r0);
          sheet.cells.set(key, { ...sheet.cells.get(key), v: c.name });
        });
      } else {
        for (let c = t.range.c0; c <= t.range.c1; c++) {
          const key = keyOf(c, t.range.r0);
          const cell = sheet.cells.get(key);
          if (!cell) continue;
          const kept: Cell = { ...(cell.s ? { s: cell.s } : {}), ...(cell.n !== undefined ? { n: cell.n } : {}) };
          if (bare(kept)) sheet.cells.delete(key);
          else sheet.cells.set(key, kept);
        }
        if (this.isTableFilter(s, t)) {
          for (let r = t.range.r0; r <= t.range.r1; r++) sheet.hiddenRows.delete(r);
          sheet.filter = null;
          t.filter = false;
        }
        t.range = { ...t.range, r0: t.range.r0 + 1 };
      }
      t.header = on;
    });
  }

  /** Makes the table bigger or smaller (Table Design > Resize table); its top-left cell stays. */
  resizeTable(s: number, t: Table, to: Range): void {
    const sheet = this.sheets[s];
    if (to.r0 !== t.range.r0 || to.c0 !== t.range.c0) throw new SyntaxProblem(`The table's top-left cell has to stay where it is (${colLabel(t.range.c0)}${t.range.r0 + 1}). Choose a range that starts there.`);
    if (to.r1 - to.r0 + 1 < 1 + (t.header ? 1 : 0) + (t.totals ? 1 : 0)) throw new SyntaxProblem('A table needs at least one row of data under its header.');
    if (sheet.tables.some(x => x !== t && overlaps(x.range, to))) throw new SyntaxProblem('That would run into another table.');
    if (sheet.merges.some(m => overlaps(m, to))) throw new SyntaxProblem('Some of those cells are merged, and a table cannot hold merged cells.');
    const width = to.c1 - to.c0 + 1;
    const fresh = t.header ? Array.from({ length: width }, (_, i) => (i < t.columns.length ? t.columns[i].name : this.display(s, to.c0 + i, to.r0))) : Array.from({ length: width }, (_, i) => t.columns[i]?.name ?? '');
    const names = uniqueColumns(fresh);
    const owned = this.isTableFilter(s, t);
    this.snapshotChange(() => {
      t.range = { ...to };
      t.columns = names.map((name, i) => ({ ...(t.columns[i] ?? {}), name }));
      if (t.header) names.forEach((name, i) => sheet.cells.set(keyOf(to.c0 + i, to.r0), { ...sheet.cells.get(keyOf(to.c0 + i, to.r0)), v: name }));
      if (owned && sheet.filter) sheet.filter.range = { ...t.range, r1: dataRows(t).r1 };
    });
  }

  /**
   * Convert to range: the table goes, its look stays as the cells' own formatting, and formulas that used its name use
   * plain cell addresses instead (as Excel does). One Undo.
   */
  convertTable(s: number, t: Table): void {
    const sheet = this.sheets[s];
    this.snapshotChange(() => {
      for (let r = t.range.r0; r <= t.range.r1; r++) {
        for (let c = t.range.c0; c <= t.range.c1; c++) {
          const look = this.lookOf(s, c, r);
          const key = keyOf(c, r);
          const old = sheet.cells.get(key);
          const id = look ? this.internStyle(look) : 0;
          if ((old?.s ?? 0) === id) continue;
          const cell: Cell = { ...old };
          if (id) cell.s = id;
          else delete cell.s;
          if (bare(cell)) sheet.cells.delete(key);
          else sheet.cells.set(key, cell);
        }
      }
      // Formulas: each reference to this table becomes the cells it covered.
      const tables = this.allTables();
      for (const [si, sh] of this.sheets.entries()) {
        for (const [k, cell] of sh.cells) {
          if (cell.f === undefined) continue;
          const here = { col: colOfKey(k), row: rowOfKey(k) };
          cell.f = structsToRefs(cell.f, tables, t, si, here, this.sheets.map(x => x.name), s);
        }
      }
      if (this.isTableFilter(s, t)) {
        // The filter stays on the cells, as Excel keeps it; only the table goes.
      }
      sheet.tables = sheet.tables.filter(x => x !== t);
    });
  }

  /**
   * After typing in a cell beside a table: the table grows to take in a row typed just under it (or a column just to
   * its right), and a formula typed in an empty table column fills the whole column (a calculated column). Each is a
   * step of its own, so Ctrl+Z takes it back first, as in Excel.
   */
  private afterTyping(s: number, col: number, row: number): void {
    const sheet = this.sheets[s];
    const cell = sheet.cells.get(keyOf(col, row));
    if (cell?.v === undefined && cell?.f === undefined) return;
    const inside = tableAt(sheet.tables, col, row);
    if (inside) {
      // A header typed over: the column's name follows it.
      if (inside.header && row === inside.range.r0) {
        const i = col - inside.range.c0;
        const text = this.display(s, col, row);
        const names = uniqueColumns(inside.columns.map((c, k) => (k === i ? text : c.name)));
        if (names[i] !== inside.columns[i].name || typeof cell.v !== 'string') {
          const old = inside.columns[i].name;
          this.snapshotChange(() => {
            inside.columns[i] = { ...inside.columns[i], name: names[i] };
            const head: Cell = { ...sheet.cells.get(keyOf(col, row)), v: names[i] };
            delete head.f;
            sheet.cells.set(keyOf(col, row), head);
            this.rewriteTableRefs(part => {
              if (part.table && part.table.toLowerCase() !== inside.name.toLowerCase()) return null;
              const swapCol = (x: string | undefined) => (x !== undefined && x.toLowerCase() === old.toLowerCase() ? names[i] : x);
              if (swapCol(part.c0) === part.c0 && swapCol(part.c1) === part.c1) return null;
              return { ...part, c0: swapCol(part.c0), c1: swapCol(part.c1) };
            });
          });
        }
        return;
      }
      // A formula in an otherwise empty data column: the whole column gets it.
      const dr = dataRows(inside);
      if (cell.f !== undefined && row >= dr.r0 && row <= dr.r1 && dr.r1 > dr.r0) {
        let empty = true;
        for (let r = dr.r0; r <= dr.r1 && empty; r++) {
          if (r === row) continue;
          const other = sheet.cells.get(keyOf(col, r));
          empty = other?.v === undefined && other?.f === undefined;
        }
        if (empty) {
          const changes: Change[] = [];
          for (let r = dr.r0; r <= dr.r1; r++) {
            if (r === row) continue;
            const old = sheet.cells.get(keyOf(col, r));
            changes.push({ sheet: s, key: keyOf(col, r), after: { ...old, ...(cell.s && !old?.s ? { s: cell.s } : {}), f: shiftFormula(cell.f, 0, r - row) } });
          }
          this.applyChanges(changes);
        }
      }
      return;
    }
    // Just under a table without a total row: the table takes the row in.
    const below = sheet.tables.find(t => !t.totals && row === t.range.r1 + 1 && col >= t.range.c0 && col <= t.range.c1);
    if (below) {
      const prev = below.range.r1;
      const owned = this.isTableFilter(s, below);
      this.snapshotChange(() => {
        below.range = { ...below.range, r1: row };
        if (owned && sheet.filter) sheet.filter.range = { ...sheet.filter.range, r1: row };
        // Calculated columns carry on into the new row.
        for (let i = 0; i < below.columns.length; i++) {
          const c = below.range.c0 + i;
          if (c === col) continue;
          const above = sheet.cells.get(keyOf(c, prev));
          const mine = sheet.cells.get(keyOf(c, row));
          if (above?.f === undefined || mine?.v !== undefined || mine?.f !== undefined) continue;
          if (!this.calculatedColumn(s, below, i)) continue;
          sheet.cells.set(keyOf(c, row), { ...mine, ...(above.s && !mine?.s ? { s: above.s } : {}), f: shiftFormula(above.f, 0, row - prev) });
        }
      });
      return;
    }
    // Just right of a table: the table takes the column in, named by its header cell.
    const right = sheet.tables.find(t => col === t.range.c1 + 1 && row >= t.range.r0 && row <= t.range.r1 && t.header);
    if (right && !sheet.tables.some(t => t !== right && overlaps(t.range, { c0: col, r0: right.range.r0, c1: col, r1: right.range.r1 }))) {
      const owned = this.isTableFilter(s, right);
      this.snapshotChange(() => {
        const name = uniqueColumns([...right.columns.map(c => c.name), row === right.range.r0 ? this.display(s, col, row) : ''])[right.columns.length];
        right.range = { ...right.range, c1: col };
        right.columns = [...right.columns, { name }];
        const hk = keyOf(col, right.range.r0);
        sheet.cells.set(hk, { ...sheet.cells.get(hk), v: name });
        if (owned && sheet.filter) sheet.filter.range = { ...sheet.filter.range, c1: col };
      });
    }
  }

  /** True when every filled data cell of a table column holds the same formula (moved row by row): a calculated column. */
  private calculatedColumn(s: number, t: Table, i: number): boolean {
    const dr = dataRows(t);
    const c = t.range.c0 + i;
    let first: { f: string; row: number } | null = null;
    for (let r = dr.r0; r <= dr.r1; r++) {
      const cell = this.sheets[s].cells.get(keyOf(c, r));
      if (cell?.f === undefined) {
        if (cell?.v !== undefined) return false;
        continue;
      }
      if (!first) first = { f: cell.f, row: r };
      else if (shiftFormula(first.f, 0, r - first.row) !== cell.f) return false;
    }
    return !!first;
  }

  // ---- PivotTables ----------------------------------------------------------------------------------------------------

  /** The PivotTable whose report covers a cell (or whose top-left cell it is), if any. */
  pivotAt(s: number, col: number, row: number): Pivot | null {
    for (const p of this.sheets[s]?.pivots ?? []) {
      if (p.at.col === col && p.at.row === row) return p;
      const l = p.last;
      if (l && col >= l.c0 && col <= l.c1 && row >= l.r0 && row <= l.r1) return p;
    }
    return null;
  }

  /** The cells a formula stands for (a range, a name for one, part of a table), or null. */
  refBox(s: number, formula: string): { s: number; range: Range } | null {
    const tree = this.parsed(formula.replace(/^=/, ''));
    if (tree instanceof CellError) return null;
    const box = new Ev(this.context(s)).refOf(tree);
    if (!box || box instanceof CellError) return null;
    return { s: box.s, range: { c0: box.c0, r0: box.r0, c1: box.c1, r1: box.r1 } };
  }

  /** A PivotTable's data: the header row's names, the rows under it (empty rows at the end left out), each column's format. */
  pivotData(s: number, source: string): PivotData {
    const at = this.refBox(s, source);
    if (!at) throw new SyntaxProblem(`The PivotTable's data (${source}) cannot be found: its cells, table or sheet may have been deleted. Choose it again (PivotTable Analyze > Change data source).`);
    const { range: r } = at;
    const used = this.usedBounds(at.s);
    const r1 = Math.min(r.r1, Math.max(r.r0, used.rows - 1));
    if (r1 <= r.r0) throw new SyntaxProblem('The PivotTable\'s data needs a header row (a name for each column) and at least one row under it.');
    if (r.c1 - r.c0 > 255) throw new SyntaxProblem('A PivotTable here reads up to 256 columns of data.');
    const fields: string[] = [];
    for (let c = r.c0; c <= r.c1; c++) {
      const name = this.display(at.s, c, r.r0).trim();
      if (!name) throw new SyntaxProblem(`The PivotTable's data needs a name in every column of its header row; ${colLabel(c)}${r.r0 + 1} is empty. Type a name there, or choose the data again.`);
      fields.push(name);
    }
    const rows: Value[][] = [];
    for (let row = r.r0 + 1; row <= r1; row++) {
      const vals: Value[] = [];
      for (let c = r.c0; c <= r.c1; c++) vals.push(this.value(at.s, c, row));
      rows.push(vals);
    }
    while (rows.length && rows[rows.length - 1].every(v => v === null)) rows.pop();
    const formats = fields.map((_, i) => {
      const st = this.styleOf(this.sheets[at.s].cells.get(keyOf(r.c0 + i, r.r0 + 1)));
      return st?.fmt ? { fmt: st.fmt, code: st.code, dec: st.dec } : undefined;
    });
    return { fields, rows, formats };
  }

  /**
   * Writes a PivotTable's report into its cells: its old cells cleared, the new ones written with their looks.
   * Refuses (and changes nothing) when the report would cover cells that hold something else.
   */
  private writePivot(s: number, p: Pivot): void {
    const sheet = this.sheets[s];
    const data = this.pivotData(s, p.source);
    let report;
    try {
      report = buildReport(p, data);
    } catch (error) {
      throw new SyntaxProblem(error instanceof Error ? error.message : 'This PivotTable could not be laid out.');
    }
    const old = p.last;
    const mine = (c: number, r: number) => !!old && c >= old.c0 && c <= old.c1 && r >= old.r0 && r <= old.r1;
    const nr = report.range;
    if (nr.r1 >= MAX_ROWS || nr.c1 >= MAX_COLS) throw new SyntaxProblem('The PivotTable would run off the edge of the sheet. Put it further up or left, or use fewer items.');
    for (const [k, cell] of sheet.cells) {
      const c = colOfKey(k);
      const r = rowOfKey(k);
      if (c < nr.c0 || c > nr.c1 || r < nr.r0 || r > nr.r1 || mine(c, r)) continue;
      if (cell.v !== undefined || cell.f !== undefined) {
        throw new SyntaxProblem(`The PivotTable needs the cells ${colLabel(nr.c0)}${nr.r0 + 1}:${colLabel(nr.c1)}${nr.r1 + 1}, and some of them hold something. Move or clear those cells, or put the PivotTable somewhere else.`);
      }
    }
    if (sheet.tables.some(t => overlaps(t.range, nr)) || sheet.merges.some(m => overlaps(m, nr))) throw new SyntaxProblem('The PivotTable would run into a table or merged cells. Put it somewhere else.');
    if (old) for (let r = old.r0; r <= old.r1; r++) for (let c = old.c0; c <= old.c1; c++) sheet.cells.delete(keyOf(c, r));
    const looks: Record<string, CellStyle> = {
      head: { b: true, fill: '#ddebf7', bb: true, bc: '#9bc2e6' },
      total: { b: true, fill: '#ddebf7', bt: true, bc: '#9bc2e6' },
      subtotal: { b: true },
      label: { b: true },
    };
    for (const o of report.cells) {
      const style: CellStyle = { ...(o.look ? looks[o.look] : {}), ...(o.fmt ?? {}), ...(o.indent ? { ind: Math.min(15, o.indent) } : {}), ...(o.pct ? { fmt: 'percent', dec: 2 } : {}) };
      const id = this.internStyle(style);
      const cell: Cell = {};
      if (o.v instanceof CellError) cell.f = o.v.code;
      else if (o.v !== null) cell.v = o.v;
      if (id) cell.s = id;
      if (!bare(cell)) sheet.cells.set(keyOf(o.col, o.row), cell);
    }
    p.last = { ...nr };
  }

  /** Makes a PivotTable from data (a range or a table) at a cell of a sheet. One Undo. */
  addPivot(s: number, source: string, at: { col: number; row: number }): Pivot {
    if (this.sheets.reduce((n, sh) => n + sh.pivots.length, 0) >= MAX_PIVOTS) throw new SyntaxProblem(`A workbook holds up to ${MAX_PIVOTS} PivotTables.`);
    this.pivotData(s, source);
    const taken = new Set(this.sheets.flatMap(sh => sh.pivots.map(p => p.name.toLowerCase())));
    let n = 1;
    while (taken.has(`pivottable${n}`)) n++;
    const id = Math.max(0, ...this.sheets.flatMap(sh => sh.pivots.map(p => p.id))) + 1;
    const pivot: Pivot = {
      id, name: `PivotTable${n}`, source: source.replace(/^=/, ''), at: { ...at }, rows: [], cols: [], values: [], filters: [], hidden: {}, groups: {},
      grandRows: true, grandCols: true, subtotals: true, last: null,
    };
    try {
      this.snapshotChange(() => {
        this.sheets[s].pivots.push(pivot);
        this.writePivot(s, pivot);
      });
    } catch (error) {
      this.sheets[s].pivots = this.sheets[s].pivots.filter(x => x !== pivot);
      throw error;
    }
    return pivot;
  }

  /** Changes a PivotTable's fields or options and works its report out again. One Undo; nothing changes if it does not fit. */
  setPivot(s: number, p: Pivot, patch: Partial<Omit<Pivot, 'id' | 'last'>>): void {
    const before = JSON.stringify(p);
    try {
      this.snapshotChange(() => {
        Object.assign(p, patch);
        this.writePivot(s, p);
      });
    } catch (error) {
      // Nothing was written (the report is checked before any cell changes): the PivotTable is put back as it was.
      Object.assign(p, JSON.parse(before));
      throw error;
    }
  }

  /** Works a PivotTable out again from its data (Refresh). */
  refreshPivot(s: number, p: Pivot): void {
    this.snapshotChange(() => this.writePivot(s, p));
  }

  /** Works every PivotTable of the workbook out again (Refresh all); returns the ones that could not be. */
  refreshAll(): string[] {
    const failed: string[] = [];
    this.snapshotChange(() => {
      this.sheets.forEach((sh, s) => {
        for (const p of sh.pivots) {
          try {
            this.writePivot(s, p);
          } catch (error) {
            failed.push(`${p.name}: ${error instanceof Error ? error.message : 'could not be worked out'}`);
          }
        }
      });
    });
    return failed;
  }

  /** Deletes a PivotTable and its report's cells. One Undo. */
  deletePivot(s: number, p: Pivot): void {
    const sheet = this.sheets[s];
    this.snapshotChange(() => {
      const l = p.last;
      if (l) for (let r = l.r0; r <= l.r1; r++) for (let c = l.c0; c <= l.c1; c++) sheet.cells.delete(keyOf(c, r));
      sheet.pivots = sheet.pivots.filter(x => x !== p);
    });
  }

  /** Puts a note on a cell, changes it, or takes it off (null or empty). One Undo. */
  setNote(s: number, col: number, row: number, text: string | null): void {
    if (text !== null && text.length > MAX_NOTE) throw new SyntaxProblem(`A note can be up to ${MAX_NOTE.toLocaleString()} characters long.`);
    const key = keyOf(col, row);
    const old = this.sheets[s].cells.get(key);
    const after: Cell = { ...old };
    if (text) after.n = text;
    else delete after.n;
    if ((old?.n ?? null) === (after.n ?? null)) return;
    if (!old) this.assertRoom(1);
    this.applyChanges([{ sheet: s, key, after: bare(after) ? undefined : after }]);
  }

  /** Takes the notes off a block of cells (Clear > Clear notes). */
  clearNotes(s: number, r: Range): void {
    const changes: Change[] = [];
    for (const [k, cell] of this.sheets[s].cells) {
      if (cell.n === undefined) continue;
      const c = colOfKey(k);
      const rw = rowOfKey(k);
      if (c < r.c0 || c > r.c1 || rw < r.r0 || rw > r.r1) continue;
      const after: Cell = { ...cell };
      delete after.n;
      changes.push({ sheet: s, key: k, after: bare(after) ? undefined : after });
    }
    if (changes.length) this.applyChanges(changes);
  }

  /** Every cell with a note on a sheet, row by row. */
  notesOf(s: number): Array<{ col: number; row: number; text: string }> {
    const out: Array<{ col: number; row: number; text: string }> = [];
    for (const [k, cell] of this.sheets[s]?.cells ?? []) if (cell.n !== undefined) out.push({ col: colOfKey(k), row: rowOfKey(k), text: cell.n });
    return out.sort((a, b) => a.row - b.row || a.col - b.col);
  }

  /** Takes the formatting off the cells (what is typed in them stays), as Home > Clear > Clear formats. */
  clearFormats(s: number, r: Range): void {
    const changes: Change[] = [];
    for (const [k, cell] of this.sheets[s].cells) {
      const c = colOfKey(k);
      const rw = rowOfKey(k);
      if (c < r.c0 || c > r.c1 || rw < r.r0 || rw > r.r1 || !cell.s) continue;
      const after: Cell = { ...cell };
      delete after.s;
      changes.push({ sheet: s, key: k, after: bare(after) ? undefined : after });
    }
    if (changes.length) this.applyChanges(changes);
  }

  /**
   * Copies cells from `src` onto `dest` (top-left corner), shifting relative references. `cut` empties the source.
   * `what` pastes only part of each cell (Paste Special): its value (a formula's answer), its formula, its formatting,
   * or its value with its formatting; `transpose` turns rows into columns.
   */
  copyBlock(s: number, src: Range, dest: { col: number; row: number }, opts: { cut?: boolean; fromSheet?: number; what?: 'all' | 'values' | 'formulas' | 'formats' | 'valuesFormats'; transpose?: boolean } = {}): void {
    const from = opts.fromSheet ?? s;
    const what = opts.cut ? 'all' : opts.what ?? 'all';
    const width = src.c1 - src.c0 + 1;
    const height = src.r1 - src.r0 + 1;
    const [outW, outH] = opts.transpose ? [height, width] : [width, height];
    if (dest.col + outW > MAX_COLS || dest.row + outH > MAX_ROWS) throw new SyntaxProblem('That does not fit on the sheet.');
    const grabbed: Array<{ dc: number; dr: number; cell?: Cell; value: Value }> = [];
    for (let dr = 0; dr < height; dr++) {
      for (let dc = 0; dc < width; dc++) {
        const cell = this.sheets[from].cells.get(keyOf(src.c0 + dc, src.r0 + dr));
        // A formula's answer (or a value a list formula fills in) is what Paste Values puts down.
        const value = what === 'values' || what === 'valuesFormats' ? this.value(from, src.c0 + dc, src.r0 + dr) : null;
        grabbed.push(opts.transpose ? { dc: dr, dr: dc, cell, value } : { dc, dr, cell, value });
      }
    }
    const changes: Change[] = [];
    const moved = new Set<number>();
    let created = 0;
    for (const g of grabbed) {
      const key = keyOf(dest.col + g.dc, dest.row + g.dr);
      moved.add(key);
      const old = this.sheets[s].cells.get(key);
      const srcCol = src.c0 + (opts.transpose ? g.dr : g.dc);
      const srcRow = src.r0 + (opts.transpose ? g.dc : g.dr);
      const shifted = (c: Cell): Cell => (c.f !== undefined ? { ...c, f: shiftFormula(c.f, dest.col + g.dc - srcCol, dest.row + g.dr - srcRow) } : { ...c });
      let after: Cell | undefined;
      if (what === 'all') after = g.cell ? shifted(g.cell) : undefined;
      else {
        // The part pasted, with the rest of the cell as it was.
        const keepStyle = what === 'values' || what === 'formulas' ? old?.s : g.cell?.s;
        let body: Cell = {};
        if (what === 'formats') body = old ? { ...old } : {};
        else if (what === 'formulas') body = g.cell ? shifted(g.cell) : {};
        else if (g.value !== null && !(g.value instanceof CellError)) body = { v: g.value };
        else if (g.value instanceof CellError) body = { f: g.value.code };
        delete body.s;
        delete body.n;
        if (keepStyle) body.s = keepStyle;
        // A note stays with its cell when only part of what was copied is pasted.
        if (old?.n !== undefined) body.n = old.n;
        after = bare(body) ? undefined : body;
      }
      if (!old && after) created++;
      changes.push({ sheet: s, key, after });
    }
    if (opts.cut) {
      for (const g of grabbed) {
        const key = keyOf(src.c0 + g.dc, src.r0 + g.dr);
        if (from === s && moved.has(key)) continue;
        changes.push({ sheet: from, key, after: undefined });
      }
    }
    this.assertRoom(created);
    this.applyChanges(changes);
  }

  /** Fills `target` from the pattern in `src` (copies; a run of two or more numbers continues as a series). */
  fill(s: number, src: Range, target: Range): void {
    const changes: Change[] = [];
    const sheet = this.sheets[s];
    const down = target.r1 > src.r1 || target.r0 < src.r0;
    const right = target.c1 > src.c1 || target.c0 < src.c0;
    if (down && right) return;
    let created = 0;
    const put = (col: number, row: number, after: Cell | undefined) => {
      const key = keyOf(col, row);
      if (!sheet.cells.has(key) && after) created++;
      changes.push({ sheet: s, key, after });
    };
    const mod = (n: number, m: number) => ((n % m) + m) % m;
    if (down) {
      const height = src.r1 - src.r0 + 1;
      for (let col = src.c0; col <= src.c1; col++) {
        const nums: number[] = [];
        for (let r = src.r0; r <= src.r1; r++) {
          const c = sheet.cells.get(keyOf(col, r));
          if (c && c.f === undefined && typeof c.v === 'number') nums.push(c.v);
        }
        // One date filled on goes a day at a time, as in Excel (a single plain number is copied).
        const oneDate = height === 1 && nums.length === 1 && isDateStyle(this.styleOf(sheet.cells.get(keyOf(col, src.r0))));
        const series = (nums.length >= 2 && nums.length === height) || oneDate;
        const step = oneDate ? 1 : series ? nums[nums.length - 1] - nums[nums.length - 2] : 0;
        for (let row = target.r0; row <= target.r1; row++) {
          if (row >= src.r0 && row <= src.r1) continue;
          const srcRow = src.r0 + mod(row - src.r0, height);
          const offset = row < src.r0 ? row - src.r0 : row - src.r1;
          const from = sheet.cells.get(keyOf(col, srcRow));
          if (!from) { put(col, row, undefined); continue; }
          const after: Cell = { ...from };
          if (after.f !== undefined) after.f = shiftFormula(after.f, 0, row - srcRow);
          // Filled upward the series runs back from its first number (1, 2 filled up gives 0, -1), downward on from its last.
          else if (series && typeof after.v === 'number') after.v = clean((offset < 0 ? nums[0] : nums[nums.length - 1]) + step * offset);
          put(col, row, after);
        }
      }
    } else if (right) {
      for (let row = src.r0; row <= src.r1; row++) {
        const nums: number[] = [];
        for (let c = src.c0; c <= src.c1; c++) {
          const cell = sheet.cells.get(keyOf(c, row));
          if (cell && cell.f === undefined && typeof cell.v === 'number') nums.push(cell.v);
        }
        const oneDate = src.c1 === src.c0 && nums.length === 1 && isDateStyle(this.styleOf(sheet.cells.get(keyOf(src.c0, row))));
        const series = (nums.length >= 2 && nums.length === src.c1 - src.c0 + 1) || oneDate;
        const step = oneDate ? 1 : series ? nums[nums.length - 1] - nums[nums.length - 2] : 0;
        for (let col = target.c0; col <= target.c1; col++) {
          if (col >= src.c0 && col <= src.c1) continue;
          const width = src.c1 - src.c0 + 1;
          const srcCol = src.c0 + mod(col - src.c0, width);
          const offset = col < src.c0 ? col - src.c0 : col - src.c1;
          const from = sheet.cells.get(keyOf(srcCol, row));
          if (!from) { put(col, row, undefined); continue; }
          const after: Cell = { ...from };
          if (after.f !== undefined) after.f = shiftFormula(after.f, col - srcCol, 0);
          else if (series && typeof after.v === 'number') after.v = clean((offset < 0 ? nums[0] : nums[nums.length - 1]) + step * offset);
          put(col, row, after);
        }
      }
    }
    if (!changes.length) return;
    this.assertRoom(created);
    this.applyChanges(changes);
  }

  // ---- Sorting -----------------------------------------------------------------------------------------------------

  sortRange(s: number, r: Range, byCol: number, ascending: boolean): void {
    this.sortBy(s, r, [{ col: byCol, ascending }]);
  }

  /**
   * Sorts the rows of a block by several columns in turn (Data > Sort): the first key, then the next among equals.
   * Numbers come before text, then TRUE/FALSE, then errors; empty cells always go last, as in Excel.
   */
  sortBy(s: number, r: Range, keys: Array<{ col: number; ascending: boolean }>): void {
    if (this.sheets[s].merges.some(m => overlaps(m, r))) throw new SyntaxProblem('Some of these cells are merged, and merged cells cannot be sorted. Unmerge them first (Merge > Unmerge cells), then sort.');
    if (!keys.length) return;
    const rows: number[] = [];
    for (let row = r.r0; row <= r.r1; row++) rows.push(row);
    const rank = (v: Value) => (v === null ? 3 : typeof v === 'number' ? 0 : typeof v === 'boolean' ? 2 : v instanceof CellError ? 4 : 1);
    const values = new Map(rows.map(row => [row, keys.map(k => this.value(s, k.col, row))]));
    const sorted = [...rows].sort((a, b) => {
      const ka = values.get(a)!;
      const kb = values.get(b)!;
      for (let i = 0; i < keys.length; i++) {
        const va = ka[i];
        const vb = kb[i];
        const ra = rank(va);
        const rb = rank(vb);
        if (ra !== rb) return ra - rb;
        let c = 0;
        if (typeof va === 'number' && typeof vb === 'number') c = va - vb;
        else if (typeof va === 'string' && typeof vb === 'string') c = va.toLowerCase().localeCompare(vb.toLowerCase());
        else if (typeof va === 'boolean' && typeof vb === 'boolean') c = Number(va) - Number(vb);
        if (c) return keys[i].ascending ? c : -c;
      }
      return a - b;
    });
    // Blank rows always stay last, so descending does not push them to the top.
    const changes: Change[] = [];
    const cells = this.sheets[s].cells;
    sorted.forEach((fromRow, i) => {
      const toRow = r.r0 + i;
      for (let col = r.c0; col <= r.c1; col++) {
        const src = cells.get(keyOf(col, fromRow));
        let after: Cell | undefined;
        if (src) {
          after = { ...src };
          if (after.f !== undefined) after.f = shiftFormula(after.f, 0, toRow - fromRow);
        }
        changes.push({ sheet: s, key: keyOf(col, toRow), after });
      }
    });
    // Compute afters from the ORIGINAL cells before any of them is overwritten (done above), then apply together.
    this.applyChanges(changes);
  }

  /**
   * Remove duplicates (Data tab): rows of the block that repeat an earlier row in the chosen columns (text compared
   * without case) are taken out and the rows below move up, inside the block only. One Undo.
   */
  removeDuplicates(s: number, r: Range, cols: number[], header: boolean): { removed: number; kept: number } {
    if (this.sheets[s].merges.some(m => overlaps(m, r))) throw new SyntaxProblem('Some of these cells are merged. Unmerge them first, then remove duplicates.');
    if (!cols.length) throw new SyntaxProblem('Tick at least one column to compare.');
    const first = r.r0 + (header ? 1 : 0);
    const seen = new Set<string>();
    const keep: number[] = [];
    for (let row = first; row <= r.r1; row++) {
      const key = cols.map(c => {
        const v = this.value(s, c, row);
        return v === null ? 'b' : v instanceof CellError ? `e${v.code}` : typeof v === 'string' ? `s${v.toLowerCase()}` : typeof v === 'boolean' ? `l${v}` : `n${clean(v)}`;
      }).join('\u0000');
      if (seen.has(key)) continue;
      seen.add(key);
      keep.push(row);
    }
    const removed = r.r1 - first + 1 - keep.length;
    if (!removed) return { removed: 0, kept: keep.length };
    const cells = this.sheets[s].cells;
    const changes: Change[] = [];
    for (let i = 0; i <= r.r1 - first; i++) {
      const toRow = first + i;
      const fromRow = keep[i];
      for (let col = r.c0; col <= r.c1; col++) {
        let after: Cell | undefined;
        if (fromRow !== undefined) {
          const src = cells.get(keyOf(col, fromRow));
          if (src) {
            after = { ...src };
            if (after.f !== undefined) after.f = shiftFormula(after.f, 0, toRow - fromRow);
          }
        }
        changes.push({ sheet: s, key: keyOf(col, toRow), after });
      }
    }
    // In a table, the rows taken out leave the table: it gets shorter and its total row moves up, as in Excel.
    const t = this.sheets[s].tables.find(x => x.range.c0 === r.c0 && x.range.c1 === r.c1 && x.range.r0 === r.r0 && dataRows(x).r1 === r.r1);
    if (!t) {
      this.applyChanges(changes);
      return { removed, kept: keep.length };
    }
    const owned = this.isTableFilter(s, t);
    this.snapshotChange(() => {
      for (const ch of changes) {
        if (ch.after) cells.set(ch.key, ch.after);
        else cells.delete(ch.key);
      }
      if (t.totals) {
        for (let col = t.range.c0; col <= t.range.c1; col++) {
          const total = cells.get(keyOf(col, t.range.r1));
          cells.delete(keyOf(col, t.range.r1));
          if (total) cells.set(keyOf(col, t.range.r1 - removed), total.f !== undefined ? { ...total, f: shiftFormula(total.f, 0, -removed) } : total);
        }
      }
      t.range = { ...t.range, r1: t.range.r1 - removed };
      const f = this.sheets[s].filter;
      if (owned && f) f.range = { ...f.range, r1: dataRows(t).r1 };
    });
    return { removed, kept: keep.length };
  }

  /**
   * Text to columns (Data tab): each cell of one column split at the delimiters into the cells to its right (or from
   * `dest`); each piece is read as typing would read it (numbers, dates). Text in quotes keeps its delimiters. One Undo.
   */
  splitText(s: number, col: number, r0: number, r1: number, opts: { delims: string[]; consecutive: boolean; quote: string | null }, dest = { col, row: r0 }): number {
    const changes: Change[] = [];
    let created = 0;
    let widest = 0;
    const delims = opts.delims.filter(Boolean);
    if (!delims.length) throw new SyntaxProblem('Choose at least one delimiter (the character the text is split at).');
    for (let row = r0; row <= r1; row++) {
      const text = this.display(s, col, row);
      if (text === '' && this.sheets[s].cells.get(keyOf(col, row))?.v === undefined) continue;
      const pieces: string[] = [];
      let cur = '';
      let quoted = false;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (opts.quote && ch === opts.quote) {
          if (quoted && text[i + 1] === opts.quote) {
            cur += ch;
            i++;
          } else quoted = !quoted;
          continue;
        }
        if (!quoted && delims.includes(ch)) {
          pieces.push(cur);
          cur = '';
          if (opts.consecutive) while (i + 1 < text.length && delims.includes(text[i + 1])) i++;
          continue;
        }
        cur += ch;
      }
      pieces.push(cur);
      widest = Math.max(widest, pieces.length);
      pieces.forEach((piece, k) => {
        const c = dest.col + k;
        const rr = dest.row + (row - r0);
        if (c >= MAX_COLS || rr >= MAX_ROWS) return;
        const key = keyOf(c, rr);
        const old = this.sheets[s].cells.get(key);
        let after: Cell | undefined;
        try {
          const entry = parseEntry(piece, this.dateOrder);
          after = entry.cell ? { ...entry.cell } : undefined;
          if (after?.f !== undefined) after = { v: piece };
          if (entry.fmt && after && !this.styleOf(old)?.fmt) after.s = this.internStyle({ ...this.styleOf(old), ...entry.fmt });
        } catch {
          after = piece ? { v: piece } : undefined;
        }
        if (old?.s && after && after.s === undefined) after.s = old.s;
        if (!after && old?.s) after = { s: old.s };
        if (old?.n !== undefined) after = { ...(after ?? {}), n: old.n };
        if (!old && after) created++;
        changes.push({ sheet: s, key, after });
      });
    }
    this.assertRoom(created);
    if (changes.length) this.applyChanges(changes);
    return widest;
  }

  // ---- Rows, columns, sheets ---------------------------------------------------------------------------------------

  private snapshotChange(fn: () => void, run?: string): void {
    // The step before ended on this very workbook: one copy serves as its "after" and this one's "before".
    const last = this.lastDump;
    const before = last && last.version === this.version && last.active === this.active ? last.text : this.dump(false);
    fn();
    const after = this.dump(false);
    const top = this.undoStack[this.undoStack.length - 1];
    if (run !== undefined && top?.kind === 'snap' && top.run === run) {
      top.after = after;
      this.redoStack = [];
    } else this.pushUndo({ kind: 'snap', before, after, ...(run === undefined ? {} : { run }) });
    this.touch();
    this.lastDump = { version: this.version, active: this.active, text: after };
  }

  /** A change to how a sheet is shown, already made: its own Undo step, so restoring a copy from an earlier structural step cannot take it away. */
  private viewStep(before: () => void, after: () => void, join = false): void {
    this.version++;
    if (this.viewGroup) {
      this.viewGroup.before.push(before);
      this.viewGroup.after.push(after);
      return;
    }
    const top = this.undoStack[this.undoStack.length - 1];
    if (join && top?.kind === 'view') {
      top.after = after;
      this.redoStack = [];
    } else this.pushUndo({ kind: 'view', before, after });
  }

  /** Several widths or heights changed together (a whole selection): one Undo. */
  asOneStep(fn: () => void): void {
    if (this.viewGroup) return fn();
    const group: { before: Array<() => void>; after: Array<() => void> } = { before: [], after: [] };
    this.viewGroup = group;
    try {
      fn();
    } finally {
      this.viewGroup = null;
      if (group.after.length) {
        this.pushUndo({
          kind: 'view',
          before: () => {
            for (let i = group.before.length - 1; i >= 0; i--) group.before[i]();
          },
          after: () => {
            for (const f of group.after) f();
          },
        });
      }
    }
  }

  /** Inserts (n > 0) or deletes (n < 0, at..at-n-1) rows or columns, moving cells and rewriting formulas. */
  shiftAxis(s: number, axis: 'row' | 'col', at: number, n: number): void {
    const limit = axis === 'row' ? MAX_ROWS : MAX_COLS;
    if (n > 0 && this.bounds(s)[axis === 'row' ? 'rows' : 'cols'] + n > limit) throw new SyntaxProblem('There is no room to insert that many.');
    this.snapshotChange(() => {
      const target = this.sheets[s];
      const remap = (i: number): number | null => {
        if (n > 0) return i >= at ? i + n : i;
        const cut = -n;
        if (i >= at && i < at + cut) return null;
        return i >= at + cut ? i - cut : i;
      };
      const moveRefs = (f: string, sheet: Sheet): string => mapRefs(f, (a, b, refSheet) => {
            const pointsAtTarget = (refSheet === undefined ? sheet : this.sheets.find(x => x.name.toLowerCase() === refSheet.toLowerCase())) === target;
            if (!pointsAtTarget) return [a, b];
            const idx = (r: Ref) => (axis === 'row' ? r.row : r.col);
            const set = (r: Ref, v: number): Ref => (axis === 'row' ? { ...r, row: v } : { ...r, col: v });
            if (!b) {
              const m = remap(idx(a));
              return m === null ? null : [set(a, m), null];
            }
            let lo = Math.min(idx(a), idx(b));
            let hi = Math.max(idx(a), idx(b));
            if (n < 0) {
              const cut = -n;
              const newLo = lo >= at && lo < at + cut ? at : remap(lo);
              const newHi = hi >= at && hi < at + cut ? at - 1 : remap(hi);
              if (newLo === null || newHi === null || newHi < newLo) return null;
              lo = newLo;
              hi = newHi;
            } else {
              lo = remap(lo)!;
              hi = remap(hi)!;
            }
            return [set(a, idx(a) <= idx(b) ? lo : hi), set(b, idx(a) <= idx(b) ? hi : lo)];
          });
      for (const sheet of this.sheets) {
        for (const cell of sheet.cells.values()) {
          if (cell.f === undefined) continue;
          cell.f = moveRefs(cell.f, sheet);
        }
        // Charts, rules and validations read cells too: their references move the same way.
        mapSheetFormulas(sheet, f => moveRefs(f, sheet));
      }
      // So do names (a name's cells are on its own sheet, or the first, when it does not say).
      for (const n of this.names) {
        const home = (n.scope ? this.sheets.find(x => x.name.toLowerCase() === n.scope!.toLowerCase()) : undefined) ?? this.sheets[0];
        try {
          n.ref = moveRefs(n.ref, home);
        } catch {
          // A name whose formula does not read is left as it is.
        }
      }
      const moved = new Map<number, Cell>();
      for (const [k, cell] of target.cells) {
        const col = colOfKey(k);
        const row = rowOfKey(k);
        const m = remap(axis === 'row' ? row : col);
        if (m === null) continue;
        moved.set(axis === 'row' ? keyOf(col, m) : keyOf(m, row), cell);
      }
      target.cells = moved;
      const sizes = axis === 'row' ? target.rowH : target.colW;
      const next = new Map<number, number>();
      for (const [i, size] of sizes) {
        const m = remap(i);
        if (m !== null) next.set(m, size);
      }
      if (axis === 'row') {
        target.rowH = next;
        target.rowFit = new Set([...target.rowFit].map(remap).filter((m): m is number => m !== null && next.has(m)));
      } else target.colW = next;
      const hidden = axis === 'row' ? target.hiddenRows : target.hiddenCols;
      const moved2 = new Set([...hidden].map(remap).filter((m): m is number => m !== null));
      if (axis === 'row') target.hiddenRows = moved2;
      else target.hiddenCols = moved2;
      // A block's ends move with the rows or columns; a block cut down to one cell is no longer merged.
      const span = (lo: number, hi: number): [number, number] | null => {
        if (n > 0) return [remap(lo)!, remap(hi)!];
        const cut = -n;
        const a = lo >= at && lo < at + cut ? at : remap(lo);
        const b = hi >= at && hi < at + cut ? at - 1 : remap(hi);
        return a === null || b === null || b < a ? null : [a, b];
      };
      const moveRange = (r: Range): Range | null => {
        const got = span(axis === 'row' ? r.r0 : r.c0, axis === 'row' ? r.r1 : r.c1);
        if (!got) return null;
        return axis === 'row' ? { ...r, r0: got[0], r1: got[1] } : { ...r, c0: got[0], c1: got[1] };
      };
      target.merges = target.merges.map(moveRange).filter((m): m is Range => m !== null && (m.c1 > m.c0 || m.r1 > m.r0));
      // A chart sits on a cell and moves with it; one whose cell is deleted moves to the first row (column) after the cut.
      target.charts = target.charts.map(ch => {
        const idx = axis === 'row' ? ch.at.row : ch.at.col;
        const gone = n < 0 && idx >= at && idx < at - n;
        const m = Math.min(limit - 1, gone ? at : remap(idx) ?? at);
        return { ...ch, at: axis === 'row' ? { ...ch.at, row: m, dy: gone ? 0 : ch.at.dy } : { ...ch.at, col: m, dx: gone ? 0 : ch.at.dx } };
      });
      const moveAll = (ranges: Range[]) => ranges.map(moveRange).filter((m): m is Range => m !== null);
      target.cf = target.cf.map(e => ({ ...e, ranges: moveAll(e.ranges) })).filter(e => e.ranges.length);
      // A PivotTable's report moves with its cells (a report cut through is worked out again by Refresh).
      target.pivots = target.pivots.flatMap(p => {
        const idx = axis === 'row' ? p.at.row : p.at.col;
        const m = remap(idx);
        if (m === null) return [];
        return [{ ...p, at: axis === 'row' ? { ...p.at, row: m } : { ...p.at, col: m }, last: p.last ? moveRange(p.last) : null }];
      });
      // Tables grow and shrink with the rows and columns inserted or deleted in them; deleted columns go from their list.
      target.tables = target.tables.flatMap(t => {
        const moved = moveRange(t.range);
        if (!moved) return [];
        let columns = t.columns;
        if (axis === 'col' && n < 0) columns = t.columns.filter((_, i) => remap(t.range.c0 + i) !== null);
        else if (axis === 'col' && n > 0 && at > t.range.c0 && at <= t.range.c1) {
          const i = at - t.range.c0;
          const added = uniqueColumns([...t.columns.map(c => c.name), ...Array<string>(n).fill('')]).slice(t.columns.length);
          columns = [...t.columns.slice(0, i), ...added.map(name => ({ name })), ...t.columns.slice(i)];
        }
        if (columns.length !== moved.c1 - moved.c0 + 1) return [];
        const next = { ...t, range: moved, columns };
        const rows = moved.r1 - moved.r0 + 1 - (t.header ? 1 : 0) - (t.totals ? 1 : 0);
        return rows >= 1 ? [next] : [];
      });
      target.dv = target.dv.map(v => ({ ...v, ranges: moveAll(v.ranges) })).filter(v => v.ranges.length);
      if (target.page) {
        const pg = target.page;
        const pair = (p: [number, number] | null, which: 'row' | 'col'): [number, number] | null => (p && axis === which ? span(p[0], p[1]) : p);
        target.page = { ...pg, area: pg.area ? moveRange(pg.area) : null, titleRows: pair(pg.titleRows, 'row'), titleCols: pair(pg.titleCols, 'col') };
      }
      // Rows inserted above the split are frozen too; deleted ones are no longer counted.
      const frozen = axis === 'row' ? target.freeze.rows : target.freeze.cols;
      if (frozen > 0) {
        const kept = n > 0 ? (at < frozen ? frozen + n : frozen) : frozen - Math.max(0, Math.min(frozen, at - n) - at);
        target.freeze = axis === 'row' ? { ...target.freeze, rows: Math.min(kept, MAX_ROWS - 1) } : { ...target.freeze, cols: Math.min(kept, MAX_COLS - 1) };
      }
      if (target.filter) {
        const f = target.filter;
        const headerGone = axis === 'row' && remap(f.range.r0) === null;
        const range = headerGone ? null : moveRange(f.range);
        if (!range) target.filter = null;
        else {
          const cols = new Map<number, string[]>();
          for (const [c, keep] of f.cols) {
            const m = axis === 'col' ? remap(c) : c;
            if (m !== null) cols.set(m, keep);
          }
          const rules = new Map<number, FilterRule>();
          for (const [c, rule] of f.rules ?? []) {
            const m = axis === 'col' ? remap(c) : c;
            if (m !== null) rules.set(m, rule);
          }
          target.filter = { range, cols, ...(rules.size ? { rules } : {}) };
        }
      }
    });
  }

  addSheet(): number {
    if (this.sheets.length >= MAX_SHEETS) throw new SyntaxProblem(`A workbook holds up to ${MAX_SHEETS} sheets.`);
    let n = this.sheets.length + 1;
    while (this.sheets.some(x => x.name.toLowerCase() === `sheet${n}`)) n++;
    this.snapshotChange(() => {
      this.sheets.push(new Sheet(`Sheet${n}`));
    });
    return this.sheets.length - 1;
  }

  sheetNameProblem(name: string, except = -1): string | null {
    if (!name.trim()) return 'A sheet needs a name.';
    if (name.length > 31) return 'A sheet name can be up to 31 letters long.';
    if (/[\\/?*[\]:]/.test(name)) return 'A sheet name cannot contain any of \\ / ? * [ ] :';
    if (this.sheets.some((x, i) => i !== except && x.name.toLowerCase() === name.toLowerCase())) return 'There is already a sheet with that name.';
    return null;
  }

  /**
   * Refuses a rename that would make a cell's formula longer than a formula may be (such a workbook would not open
   * again), naming the first cell it would happen in.
   */
  private refuseLongFormulas(rewrite: (f: string) => string, what: string, onSheet: (sheet: Sheet) => boolean): void {
    for (const sheet of this.sheets) {
      if (!onSheet(sheet)) continue;
      for (const [key, cell] of sheet.cells) {
        if (cell.f === undefined || rewrite(cell.f).length <= MAX_FORMULA_LENGTH) continue;
        throw new SyntaxProblem(`With ${what}, the formula in ${sheet.name}!${colName(key % MAX_COLS)}${Math.floor(key / MAX_COLS) + 1} would be longer than ${MAX_FORMULA_LENGTH.toLocaleString('en-GB')} characters, the most a formula may have. Choose a shorter name.`);
      }
    }
  }

  renameSheet(s: number, name: string): void {
    const problem = this.sheetNameProblem(name, s);
    if (problem) throw new SyntaxProblem(problem);
    const old = this.sheets[s].name;
    this.refuseLongFormulas(f => renameSheetInFormula(f, old, name), 'that sheet name', () => true);
    this.snapshotChange(() => {
      for (const sheet of this.sheets) {
        for (const cell of sheet.cells.values()) if (cell.f !== undefined) cell.f = renameSheetInFormula(cell.f, old, name);
        mapSheetFormulas(sheet, f => renameSheetInFormula(f, old, name));
      }
      for (const n of this.names) {
        n.ref = renameSheetInFormula(n.ref, old, name);
        if (n.scope?.toLowerCase() === old.toLowerCase()) n.scope = name;
      }
      this.sheets[s].name = name;
    });
  }

  deleteSheet(s: number): void {
    if (this.sheets.length <= 1) throw new SyntaxProblem('A workbook needs at least one sheet.');
    const gone = this.sheets[s].name;
    this.snapshotChange(() => {
      this.sheets.splice(s, 1);
      for (const sheet of this.sheets) {
        for (const cell of sheet.cells.values()) {
          if (cell.f === undefined) continue;
          cell.f = mapRefs(cell.f, (a, b, refSheet) => (refSheet !== undefined && refSheet.toLowerCase() === gone.toLowerCase() ? null : [a, b]));
        }
        mapSheetFormulas(sheet, f => mapRefs(f, (a, b, refSheet) => (refSheet !== undefined && refSheet.toLowerCase() === gone.toLowerCase() ? null : [a, b])));
      }
      // A name kept for the sheet goes with it; one that pointed at it now says #REF!.
      this.names = this.names.filter(n => n.scope?.toLowerCase() !== gone.toLowerCase());
      for (const n of this.names) {
        try {
          n.ref = mapRefs(n.ref, (a, b, refSheet) => (refSheet !== undefined && refSheet.toLowerCase() === gone.toLowerCase() ? null : [a, b]));
        } catch {
          // Left as it is.
        }
      }
      this.active = Math.min(this.active, this.sheets.length - 1);
    });
  }

  /** A width or height, one Undo step. `join`: part of the same drag as the step before, so it adds to that one. */
  setSize(s: number, axis: 'row' | 'col', index: number, size: number | null, join = false): void {
    const put = (to: number | undefined, fit: boolean) => () => {
      const sheet = this.sheets[s];
      const map = axis === 'row' ? sheet.rowH : sheet.colW;
      if (to === undefined) map.delete(index);
      else map.set(index, to);
      // A height set by hand stays as set: fitting the text no longer changes it.
      if (axis === 'row' && fit) sheet.rowFit.add(index);
      else if (axis === 'row') sheet.rowFit.delete(index);
    };
    const sheet = this.sheets[s];
    const next = size === null ? undefined : Math.max(axis === 'row' ? 12 : 16, Math.min(axis === 'row' ? 400 : 800, Math.round(size)));
    const was = (axis === 'row' ? sheet.rowH : sheet.colW).get(index);
    const wasFit = axis === 'row' && sheet.rowFit.has(index);
    if (was === next && !wasFit) return;
    const after = put(next, false);
    after();
    this.viewStep(put(was, wasFit), after, join);
  }

  /** Widens a column for a number that would not fit: part of the edit that caused it, so not an Undo step of its own. */
  fitColumn(s: number, col: number, width: number): void {
    this.sheets[s].colW.set(col, Math.max(16, Math.min(800, Math.round(width))));
    this.version++;
  }

  /** Sets a row to the height its wrapped text needs (null: the standard height). Rows sized by hand are left alone. */
  fitRow(s: number, row: number, height: number | null): void {
    const sheet = this.sheets[s];
    if (sheet.rowH.has(row) && !sheet.rowFit.has(row)) return;
    const h = height === null ? null : Math.max(12, Math.min(400, Math.round(height)));
    if ((sheet.rowH.get(row) ?? null) === h) return;
    if (h === null) {
      sheet.rowH.delete(row);
      sheet.rowFit.delete(row);
    } else {
      sheet.rowH.set(row, h);
      sheet.rowFit.add(row);
    }
    this.version++;
  }

  // ---- Merged cells ------------------------------------------------------------------------------------------------

  /** The merged block this cell is part of, if any. */
  mergeAt(s: number, col: number, row: number): Range | null {
    for (const m of this.sheets[s]?.merges ?? []) if (col >= m.c0 && col <= m.c1 && row >= m.r0 && row <= m.r1) return m;
    return null;
  }

  /** The range grown to take in every merged block it touches, as Excel grows a selection. */
  growToMerges(s: number, r: Range): Range {
    const merges = this.sheets[s]?.merges ?? [];
    if (!merges.length) return r;
    const out = { ...r };
    for (let grew = true; grew; ) {
      grew = false;
      for (const m of merges) {
        if (!overlaps(m, out)) continue;
        if (m.c0 < out.c0 || m.c1 > out.c1 || m.r0 < out.r0 || m.r1 > out.r1) {
          out.c0 = Math.min(out.c0, m.c0);
          out.c1 = Math.max(out.c1, m.c1);
          out.r0 = Math.min(out.r0, m.r0);
          out.r1 = Math.max(out.r1, m.r1);
          grew = true;
        }
      }
    }
    return out;
  }

  /** The blocks a merge of `r` makes: the whole range, or one per row ("Merge across"). */
  private mergeBlocks(r: Range, across: boolean): Range[] {
    if (!across) return [r];
    const out: Range[] = [];
    for (let row = r.r0; row <= r.r1; row++) out.push({ c0: r.c0, r0: row, c1: r.c1, r1: row });
    return out;
  }

  /** True when merging would throw away something typed in a cell that is not the top-left one of its block. */
  mergeWouldLose(s: number, r: Range, across = false): boolean {
    const blocks = this.mergeBlocks(r, across);
    for (const [k, cell] of this.sheets[s].cells) {
      if (cell.v === undefined && cell.f === undefined) continue;
      const col = colOfKey(k);
      const row = rowOfKey(k);
      for (const b of blocks) if (col >= b.c0 && col <= b.c1 && row >= b.r0 && row <= b.r1 && !(col === b.c0 && row === b.r0)) return true;
    }
    return false;
  }

  /**
   * Merges the range into one cell ('across': one per row). Only the top-left value of each block is kept, as in
   * Excel; 'center' also centres it. Merged blocks it touches are taken into it.
   */
  merge(s: number, r: Range, how: 'center' | 'all' | 'across'): void {
    const sheet = this.sheets[s];
    const range = this.growToMerges(s, r);
    if (range.c0 === range.c1 && range.r0 === range.r1) return;
    if ((range.c1 - range.c0 + 1) * (range.r1 - range.r0 + 1) > MAX_CHANGES_PER_EDIT) throw new SyntaxProblem('That is too many cells to merge at once.');
    this.snapshotChange(() => {
      sheet.merges = sheet.merges.filter(m => !overlaps(m, range));
      for (const b of this.mergeBlocks(range, how === 'across')) {
        if (b.c0 === b.c1 && b.r0 === b.r1) continue;
        for (const [k, cell] of [...sheet.cells]) {
          const col = colOfKey(k);
          const row = rowOfKey(k);
          if (col < b.c0 || col > b.c1 || row < b.r0 || row > b.r1 || (col === b.c0 && row === b.r0)) continue;
          const kept: Cell = { ...(cell.s ? { s: cell.s } : {}), ...(cell.n !== undefined ? { n: cell.n } : {}) };
          if (bare(kept)) sheet.cells.delete(k);
          else sheet.cells.set(k, kept);
        }
        sheet.merges.push(b);
        if (how === 'center') {
          const key = keyOf(b.c0, b.r0);
          const cell = sheet.cells.get(key);
          const id = this.internStyle({ ...this.styleOf(cell), al: 'c' });
          sheet.cells.set(key, { ...cell, s: id });
        }
      }
    });
  }

  /** Splits every merged block that touches the range back into single cells. */
  unmerge(s: number, r: Range): void {
    const sheet = this.sheets[s];
    if (!sheet.merges.some(m => overlaps(m, r))) return;
    this.snapshotChange(() => {
      sheet.merges = sheet.merges.filter(m => !overlaps(m, r));
    });
  }

  // ---- Freeze panes, hidden rows and columns -----------------------------------------------------------------------

  /** The lines between cells shown on screen, or not (View > Gridlines). */
  setGridlines(s: number, on: boolean): void {
    const was = !!this.sheets[s].noGrid;
    if (was === !on) return;
    const put = (noGrid: boolean) => () => {
      this.sheets[s].noGrid = noGrid;
    };
    put(!on)();
    this.viewStep(put(was), put(!on));
  }

  /** Keeps `rows` rows and `cols` columns in view while the rest scrolls (0, 0: nothing frozen). */
  setFreeze(s: number, rows: number, cols: number): void {
    const f = this.sheets[s].freeze;
    const r = Math.max(0, Math.min(MAX_ROWS - 1, Math.floor(rows)));
    const c = Math.max(0, Math.min(MAX_COLS - 1, Math.floor(cols)));
    if (f.rows === r && f.cols === c) return;
    const put = (freeze: { rows: number; cols: number }) => () => {
      this.sheets[s].freeze = freeze;
    };
    put({ rows: r, cols: c })();
    this.viewStep(put(f), put({ rows: r, cols: c }));
  }

  /** Hides (or shows again) rows or columns from..to. */
  setHidden(s: number, axis: 'row' | 'col', from: number, to: number, hidden: boolean): void {
    const set = axis === 'row' ? this.sheets[s].hiddenRows : this.sheets[s].hiddenCols;
    const max = axis === 'row' ? MAX_ROWS : MAX_COLS;
    const lo = Math.max(0, Math.min(from, to));
    const hi = Math.min(max - 1, Math.max(from, to));
    let any = false;
    for (let i = lo; i <= hi; i++) if (set.has(i) !== hidden) any = true;
    if (!any) return;
    if (hidden && hi - lo + 1 >= max) throw new SyntaxProblem(`Every ${axis === 'row' ? 'row' : 'column'} cannot be hidden: at least one has to stay in view.`);
    this.snapshotChange(() => {
      const target = axis === 'row' ? this.sheets[s].hiddenRows : this.sheets[s].hiddenCols;
      for (let i = lo; i <= hi; i++) {
        if (hidden) target.add(i);
        else target.delete(i);
      }
    });
  }

  // ---- Filter ------------------------------------------------------------------------------------------------------

  /** The block of filled cells around a cell, as Excel finds it for a filter or a sort (empty rows and columns end it). */
  currentRegion(s: number, col: number, row: number): Range {
    let c0 = col;
    let c1 = col;
    let r0 = row;
    let r1 = row;
    const used = this.usedBounds(s);
    const filled = (c: number, r: number) => r < used.rows && c < used.cols && this.value(s, c, r) !== null;
    const rowFilled = (r: number) => { for (let c = c0; c <= c1; c++) if (filled(c, r)) return true; return false; };
    const colFilled = (c: number) => { for (let r = r0; r <= r1; r++) if (filled(c, r)) return true; return false; };
    for (let grew = true; grew; ) {
      grew = false;
      if (r0 > 0 && rowFilled(r0 - 1)) { r0--; grew = true; }
      if (r1 < MAX_ROWS - 1 && rowFilled(r1 + 1)) { r1++; grew = true; }
      if (c0 > 0 && colFilled(c0 - 1)) { c0--; grew = true; }
      if (c1 < MAX_COLS - 1 && colFilled(c1 + 1)) { c1++; grew = true; }
    }
    return { c0, r0, c1, r1 };
  }

  /** Puts a filter on the range (its first row is the header row), or takes the sheet's filter off (null: every row shows again). */
  setFilter(s: number, range: Range | null): void {
    const sheet = this.sheets[s];
    if (range && range.r1 <= range.r0) throw new SyntaxProblem('A filter needs a header row and at least one row of data under it. Select the table (or a cell in it) and try again.');
    this.snapshotChange(() => {
      if (sheet.filter) for (let r = sheet.filter.range.r0 + 1; r <= sheet.filter.range.r1; r++) sheet.hiddenRows.delete(r);
      sheet.filter = range ? { range: { ...range }, cols: new Map() } : null;
    });
  }

  /** Keeps in view only the rows whose cell in `col` shows one of `keep` (null: every value, the column's filter cleared). */
  filterBy(s: number, col: number, keep: string[] | null): void {
    const sheet = this.sheets[s];
    const f = sheet.filter;
    if (!f || col < f.range.c0 || col > f.range.c1) return;
    this.snapshotChange(() => {
      const filter = sheet.filter!;
      // New rows typed under the table are taken in, as Excel does when a filter is applied again (a table's own
      // filter grows with the table instead, and stops above its total row).
      const used = this.usedBounds(s);
      const owned = sheet.tables.some(t => this.isTableFilter(s, t));
      while (!owned && filter.range.r1 + 1 < Math.min(MAX_ROWS, used.rows)) {
        let any = false;
        for (let c = filter.range.c0; c <= filter.range.c1 && !any; c++) any = this.value(s, c, filter.range.r1 + 1) !== null;
        if (!any) break;
        filter.range.r1++;
      }
      if (keep) filter.cols.set(col, [...new Set(keep)]);
      else filter.cols.delete(col);
      filter.rules?.delete(col);
      this.applyFilter(s);
    });
  }

  /** Data > Clear: every column's filter taken off (the ▾ buttons stay), every row in view again. */
  clearFilters(s: number): void {
    const f = this.sheets[s].filter;
    if (!f || (!f.cols.size && !f.rules?.size)) return;
    this.snapshotChange(() => {
      f.cols.clear();
      f.rules?.clear();
      this.applyFilter(s);
    });
  }

  /** Keeps in view only the rows whose cell in `col` meets a rule (Number filters, Text filters); null clears it. */
  filterRule(s: number, col: number, rule: FilterRule | null): void {
    const sheet = this.sheets[s];
    const f = sheet.filter;
    if (!f || col < f.range.c0 || col > f.range.c1) return;
    this.snapshotChange(() => {
      const filter = sheet.filter!;
      filter.rules ??= new Map();
      filter.cols.delete(col);
      if (rule) filter.rules.set(col, rule);
      else filter.rules.delete(col);
      this.applyFilter(s);
    });
  }

  /** Hides the filter's rows that do not pass, and shows those that do. */
  private applyFilter(s: number): void {
    const sheet = this.sheets[s];
    const f = sheet.filter;
    if (!f) return;
    const tests = [...f.cols].map(([c, keep]) => ({ c, keep: new Set(keep.map(k => k.toLowerCase())) }));
    // Rules over a whole column (top 10, above average) look at every row of the filter, shown or hidden.
    const ruled = [...(f.rules ?? [])].map(([c, rule]) => {
      const nums: number[] = [];
      for (let r = f.range.r0 + 1; r <= f.range.r1; r++) {
        const v = this.value(s, c, r);
        if (typeof v === 'number') nums.push(v);
      }
      let line = 0;
      if (rule.kind === 'top' && nums.length) {
        const sorted = [...nums].sort((x, y) => (rule.top ? y - x : x - y));
        const count = rule.percent ? Math.max(1, Math.floor((nums.length * rule.n) / 100)) : rule.n;
        line = sorted[Math.min(sorted.length, count) - 1];
      } else if (rule.kind === 'average' && nums.length) line = nums.reduce((a, b) => a + b, 0) / nums.length;
      return { c, rule, line, any: nums.length > 0 };
    });
    const passes = (r: number) => ruled.every(({ c, rule, line, any }) => {
      const v = this.value(s, c, r);
      if (rule.kind === 'custom') {
        const shown = this.display(s, c, r);
        const a = condHolds(v, shown, rule.a);
        if (!rule.b) return a;
        const b = condHolds(v, shown, rule.b);
        return rule.and ? a && b : a || b;
      }
      if (typeof v !== 'number' || !any) return false;
      if (rule.kind === 'top') return rule.top ? v >= line : v <= line;
      return rule.above ? v > line : v < line;
    });
    for (let r = f.range.r0 + 1; r <= f.range.r1; r++) {
      const pass = tests.every(t => t.keep.has(this.display(s, t.c, r).toLowerCase())) && passes(r);
      if (pass) sheet.hiddenRows.delete(r);
      else sheet.hiddenRows.add(r);
    }
  }

  /**
   * The different values (as shown) in a filter column, numbers in order of size, then text A to Z, empty last ('').
   * Counted over every row of the filter, shown or hidden.
   */
  filterValues(s: number, col: number): string[] {
    const f = this.sheets[s].filter;
    if (!f) return [];
    const seen = new Map<string, { text: string; v: Value }>();
    for (let r = f.range.r0 + 1; r <= f.range.r1; r++) {
      const text = this.display(s, col, r);
      const k = text.toLowerCase();
      if (!seen.has(k)) seen.set(k, { text, v: this.value(s, col, r) });
    }
    const rank = (v: Value) => (v === null ? 3 : typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2);
    return [...seen.values()]
      .sort((a, b) => rank(a.v) - rank(b.v) || (typeof a.v === 'number' && typeof b.v === 'number' ? a.v - b.v : a.text.toLowerCase().localeCompare(b.text.toLowerCase())))
      .map(x => (x.v === null ? '' : x.text));
  }

  /** Sorts the filter's data rows by one column (every row, shown or hidden), then filters again. */
  sortFilter(s: number, col: number, ascending: boolean): void {
    const f = this.sheets[s].filter;
    if (!f || f.range.r1 <= f.range.r0) return;
    this.snapshotChange(() => {
      const r = { ...f.range, r0: f.range.r0 + 1 };
      if (this.sheets[s].merges.some(m => overlaps(m, r))) throw new SyntaxProblem('Some of these cells are merged, and merged cells cannot be sorted. Unmerge them first, then sort.');
      const undo = this.undoStack.length;
      this.sortRange(s, r, col, ascending);
      // sortRange made its own undo step: this whole change is one step.
      this.undoStack.length = undo;
      this.applyFilter(s);
    });
  }

  // ---- Find and replace --------------------------------------------------------------------------------------------

  /** Every cell that matches, row by row, starting on sheet `from` (then the sheets after it, when allSheets). */
  findAll(from: number, opts: FindOptions): Found[] {
    if (!opts.text) return [];
    const re = findPattern(opts.text, opts.matchCase, opts.wholeCell);
    const order = opts.allSheets ? this.sheets.map((_, i) => (from + i) % this.sheets.length) : [from];
    const out: Found[] = [];
    for (const s of order) {
      const sheet = this.sheets[s];
      const keys = new Set<number>();
      for (const [k, cell] of sheet.cells) if (cell.v !== undefined || cell.f !== undefined) keys.add(k);
      // Cells a list fills hold nothing themselves, but show values (found when looking in values).
      if (opts.lookIn !== 'formulas') {
        for (const k of this.listKeys(s)) {
          const g = this.spillGrid(s, k);
          if (!g) continue;
          for (let r = 0; r < g.length; r++) for (let c = 0; c < g[0].length; c++) keys.add(keyOf(colOfKey(k) + c, rowOfKey(k) + r));
        }
      }
      for (const k of [...keys].sort((a, b) => a - b)) {
        const col = colOfKey(k);
        const row = rowOfKey(k);
        const text = opts.lookIn === 'formulas' ? this.editText(s, col, row) : this.display(s, col, row);
        if (text === '') continue;
        re.lastIndex = 0;
        if (re.test(text)) out.push({ s, col, row });
      }
    }
    return out;
  }

  /** What replacing in one cell would type into it, or null when it does not match. Replace works on what is typed. */
  private replaced(s: number, col: number, row: number, opts: FindOptions, by: string): string | null {
    const cell = this.sheets[s].cells.get(keyOf(col, row));
    if (!cell || (cell.v === undefined && cell.f === undefined)) return null;
    const before = this.editText(s, col, row);
    const re = findPattern(opts.text, opts.matchCase, opts.wholeCell);
    if (!re.test(before)) return null;
    re.lastIndex = 0;
    // Excel's wildcard "*" can match nothing; a pattern that matched an empty piece moves on rather than repeating.
    return before.replace(re, m => (m === '' ? '' : by));
  }

  /** Replaces in one cell. False when it does not match, or the result is a formula that does not read. */
  replaceOne(s: number, col: number, row: number, opts: FindOptions, by: string): boolean {
    const next = this.replaced(s, col, row, opts, by);
    if (next === null) return false;
    try {
      this.setInput(s, col, row, next);
    } catch (error) {
      if (error instanceof SyntaxProblem) return false;
      throw error;
    }
    return true;
  }

  /** Replaces in every matching cell as one undo step. `skipped`: cells where the result would be a broken formula. */
  replaceAll(from: number, opts: FindOptions, by: string): { changed: number; skipped: number } {
    let changed = 0;
    let skipped = 0;
    const cells = this.findAll(from, { ...opts, lookIn: 'formulas' });
    this.batch(() => {
      for (const f of cells) {
        if (this.replaceOne(f.s, f.col, f.row, opts, by)) changed++;
        else if (this.replaced(f.s, f.col, f.row, opts, by) !== null) skipped++;
      }
    });
    return { changed, skipped };
  }

  // ---- Undo and redo -----------------------------------------------------------------------------------------------

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    const e = this.undoStack.pop();
    if (!e) return;
    this.redoStack.push(e);
    this.apply(e, 'before');
  }

  redo(): void {
    const e = this.redoStack.pop();
    if (!e) return;
    this.undoStack.push(e);
    this.apply(e, 'after');
  }

  private apply(e: UndoEntry, which: 'before' | 'after'): void {
    if (e.kind === 'snap') {
      this.load(JSON.parse(which === 'before' ? e.before : e.after), true);
      return;
    }
    if (e.kind === 'view') {
      (which === 'before' ? e.before : e.after)();
      this.version++;
      return;
    }
    for (const ch of which === 'before' ? [...e.changes].reverse() : e.changes) {
      const cell = which === 'before' ? ch.before : ch.after;
      if (cell) this.sheets[ch.sheet].cells.set(ch.key, cell);
      else this.sheets[ch.sheet].cells.delete(ch.key);
    }
    this.touch();
  }

  // ---- Charts, conditional formatting, validation, page setup (each change is one Undo) -------------------------------

  /** A formula (without "=") worked out on a sheet: one value, or the list it gives. */
  evalFormula(s: number, f: string, here?: { col: number; row: number }): Value | Grid {
    const tree = this.parsed(f);
    if (tree instanceof CellError) return tree;
    try {
      return evaluateCell(tree, this.context(s, here));
    } catch (error) {
      if (!(error instanceof TooDeep) && !(error instanceof RangeError)) throw error;
      this.depth = 0;
      this.visiting.clear();
      return E.NUM;
    }
  }

  /** The value typing `input` into a cell would give, without typing it (a formula is worked out). */
  entryValue(s: number, input: string): Value {
    const entry = parseEntry(input, this.dateOrder);
    if (!entry.cell) return null;
    if (entry.cell.f !== undefined) {
      const got = this.evalFormula(s, entry.cell.f);
      return Array.isArray(got) ? got[0]?.[0] ?? null : got;
    }
    return entry.cell.v ?? null;
  }

  private tries = 0;

  /**
   * Works something out as if `input` were typed in the cell (a validation formula reads the new value), then puts the
   * cell back as it was: nothing to undo, and the workbook is not changed.
   */
  withInput<T>(s: number, col: number, row: number, input: string, fn: () => T): T {
    const entry = parseEntry(input, this.dateOrder);
    const sheet = this.sheets[s];
    const key = keyOf(col, row);
    const old = sheet.cells.get(key);
    const keep = this.version;
    const after: Cell | undefined = entry.cell ? { ...entry.cell, ...(old?.s ? { s: old.s } : {}) } : old?.s ? { s: old.s } : undefined;
    if (after) sheet.cells.set(key, after);
    else sheet.cells.delete(key);
    // A version of its own while the try lasts, so nothing worked out now is kept for later.
    this.version = -++this.tries;
    this.memo.clear();
    this.spills.clear();
    try {
      return fn();
    } finally {
      if (old) sheet.cells.set(key, old);
      else sheet.cells.delete(key);
      this.version = keep;
      this.memo.clear();
      this.spills.clear();
    }
  }

  /** Adds a chart to the sheet (in front of the others); returns its number. */
  addChart(s: number, chart: Omit<Chart, 'id'>): number {
    const sheet = this.sheets[s];
    if (sheet.charts.length >= MAX_CHARTS) throw new SyntaxProblem(`A sheet holds up to ${MAX_CHARTS} charts.`);
    const id = Math.max(0, ...sheet.charts.map(c => c.id)) + 1;
    this.snapshotChange(() => {
      sheet.charts.push({ ...chart, id });
    });
    return id;
  }

  /** Changes a chart (moved, resized, retitled...), or deletes it (null). */
  /** `run`: steps with the same name, one straight after another, are one Undo (a chart nudged with the arrow keys). */
  setChart(s: number, id: number, chart: Chart | null, run?: string): void {
    const sheet = this.sheets[s];
    const i = sheet.charts.findIndex(c => c.id === id);
    if (i < 0) return;
    this.snapshotChange(() => {
      if (chart) sheet.charts[i] = { ...chart, id };
      else sheet.charts.splice(i, 1);
    }, run);
  }

  /** Puts a chart in front of the others (last drawn), or behind them. */
  orderChart(s: number, id: number, front: boolean): void {
    const sheet = this.sheets[s];
    const i = sheet.charts.findIndex(c => c.id === id);
    if (i < 0) return;
    this.snapshotChange(() => {
      const [ch] = sheet.charts.splice(i, 1);
      if (front) sheet.charts.push(ch);
      else sheet.charts.unshift(ch);
    });
  }

  /** The sheet's conditional formatting rules, all at once (the first in the list wins). */
  setCf(s: number, list: CfEntry[]): void {
    if (list.length > MAX_RULES) throw new SyntaxProblem(`A sheet holds up to ${MAX_RULES} conditional formatting rules.`);
    const clean = list.map(e => ({ ...e, ranges: e.ranges.slice(0, MAX_RANGES) })).filter(e => e.ranges.length);
    this.snapshotChange(() => {
      this.sheets[s].cf = clean;
    });
  }

  /** Adds a conditional formatting rule at the top of the list (it wins over the older ones, as in Excel). */
  addCf(s: number, entry: CfEntry): void {
    this.setCf(s, [entry, ...this.sheets[s].cf]);
  }

  /** Takes conditional formatting off a block of cells (or the whole sheet when `r` is null). */
  clearCf(s: number, r: Range | null): void {
    this.setCf(s, r ? this.sheets[s].cf.map(e => ({ ...e, ranges: subtractAll(e.ranges, r) })) : []);
  }

  /** Puts a validation rule on a block of cells (replacing any rule there), or takes the rules off it (null). */
  setValidation(s: number, r: Range, v: Validation | null): void {
    const sheet = this.sheets[s];
    const kept = sheet.dv.map(x => ({ ...x, ranges: subtractAll(x.ranges, r) })).filter(x => x.ranges.length);
    if (v) kept.push({ ...v, ranges: [r] });
    if (kept.length > MAX_VALIDATIONS) throw new SyntaxProblem(`A sheet holds up to ${MAX_VALIDATIONS} validation rules.`);
    this.snapshotChange(() => {
      sheet.dv = kept;
    });
  }

  // ---- Names (Formulas > Name Manager) -------------------------------------------------------------------------------

  /** Why `name` cannot be given (null when it can): Excel's rules, and no second name of that kind in the same place. */
  nameProblem(name: string, scope?: string, except?: DefinedName): string | null {
    const rule = nameRuleProblem(name);
    if (rule) return rule;
    const clash = this.names.find(n => n !== except && n.name.toLowerCase() === name.toLowerCase() && (n.scope ?? '').toLowerCase() === (scope ?? '').toLowerCase());
    if (clash) return `There is already a name "${clash.name}"${scope ? ` on ${scope}` : ''}. Choose another, or edit that one.`;
    return null;
  }

  /** What a name may stand for: a formula that reads (an "=" in front is fine). */
  private nameRef(ref: string): string {
    const f = ref.trim().replace(/^=/, '');
    if (!f) throw new SyntaxProblem('Type what the name stands for: cells (=Sheet1!$A$1:$A$10) or a value (=0.15).');
    parseFormula(f);
    return f;
  }

  /** Adds a name ("Prices" for Sheet1!$A$2:$A$40), for the whole workbook or one sheet (`scope`). */
  setName(name: string, ref: string, scope?: string, comment?: string): void {
    const problem = this.nameProblem(name.trim(), scope);
    if (problem) throw new SyntaxProblem(problem);
    if (this.names.length >= MAX_NAMES) throw new SyntaxProblem(`A workbook holds up to ${MAX_NAMES} names.`);
    const f = this.nameRef(ref);
    this.snapshotChange(() => {
      this.names.push({ name: name.trim(), ref: f, ...(scope ? { scope } : {}), ...(comment ? { comment } : {}) });
    });
  }

  /** Changes a name: what it stands for, and its own name (formulas that use it are rewritten to the new one, as in Excel). */
  editName(old: DefinedName, name: string, ref: string, comment?: string): void {
    const at = this.names.indexOf(old);
    if (at < 0) throw new SyntaxProblem('That name is not there any more.');
    const problem = this.nameProblem(name.trim(), old.scope, old);
    if (problem) throw new SyntaxProblem(problem);
    const f = this.nameRef(ref);
    const renamed = name.trim() !== old.name;
    if (renamed) this.refuseLongFormulas(formula => renameInFormula(formula, old.name, name.trim()), 'that name', sheet => !old.scope || sheet.name.toLowerCase() === old.scope.toLowerCase());
    this.snapshotChange(() => {
      this.names[at] = { name: name.trim(), ref: f, ...(old.scope ? { scope: old.scope } : {}), ...(comment ? { comment } : {}) };
      if (!renamed) return;
      const swap = (formula: string) => renameInFormula(formula, old.name, name.trim());
      for (const sheet of this.sheets) {
        if (old.scope && sheet.name.toLowerCase() !== old.scope.toLowerCase()) continue;
        for (const cell of sheet.cells.values()) if (cell.f !== undefined) cell.f = swap(cell.f);
        mapSheetFormulas(sheet, swap);
      }
      for (const n of this.names) n.ref = swap(n.ref);
    });
  }

  /** Deletes a name; formulas that use it show #NAME? (as in Excel). */
  deleteName(name: string | DefinedName, scope?: string): void {
    const target = typeof name === 'string' ? this.names.find(n => n.name.toLowerCase() === name.toLowerCase() && (n.scope ?? '').toLowerCase() === (scope ?? '').toLowerCase()) : name;
    if (!target || !this.names.includes(target)) return;
    this.snapshotChange(() => {
      this.names = this.names.filter(n => n !== target);
    });
  }

  /** The block of cells a name stands for, when it stands for one (Go To, the Name box). */
  nameRange(name: string, current: number): { s: number; range: Range } | null {
    const node = this.nameNode(name, undefined, current);
    if (!node) return null;
    const take = (n: Node): { s: number; range: Range } | null => {
      if (n.t !== 'ref' && n.t !== 'range') return null;
      const s = n.sheet === undefined ? current : this.sheets.findIndex(x => x.name.toLowerCase() === n.sheet!.toLowerCase());
      if (s < 0) return null;
      const a = n.t === 'ref' ? n.ref : n.a;
      const b = n.t === 'ref' ? n.ref : n.b;
      return { s, range: { c0: Math.min(a.col, b.col), r0: Math.min(a.row, b.row), c1: Math.max(a.col, b.col), r1: Math.max(a.row, b.row) } };
    };
    return take(node);
  }

  /** How the sheet prints (null: back to the usual setup). */
  setPage(s: number, page: PageSetup | null): void {
    this.snapshotChange(() => {
      this.sheets[s].page = page;
    });
  }

  // ---- Saving and loading ------------------------------------------------------------------------------------------

  /** The workbook as a saved file holds it: looks no cell uses any more are left out. */
  serialize(): string {
    return this.dump(true);
  }

  /** `prune`: leave out looks no cell uses. Not for Undo's copies: its other steps know looks by their place in the list. */
  private dump(prune: boolean): string {
    let styles = this.styles;
    const place = new Map<number, number>();
    if (prune) {
      for (const sh of this.sheets) for (const c of sh.cells.values()) if (c.s) place.set(c.s, 0);
      const ids = [...place.keys()].sort((a, b) => a - b);
      ids.forEach((id, i) => place.set(id, i + 1));
      styles = [this.styles[0], ...ids.map(id => this.styles[id])];
    }
    const idOf = (c: Cell) => (prune ? place.get(c.s ?? 0) ?? 0 : c.s ?? 0);
    const sheets = this.sheets.map(sh => ({
      name: sh.name,
      colW: Object.fromEntries(sh.colW),
      rowH: Object.fromEntries(sh.rowH),
      rowFit: [...sh.rowFit],
      cells: [...sh.cells].map(([k, c]) => (c.n !== undefined ? [colOfKey(k), rowOfKey(k), c.v ?? null, c.f ?? null, idOf(c), c.n] : [colOfKey(k), rowOfKey(k), c.v ?? null, c.f ?? null, idOf(c)])),
      merges: sh.merges.map(m => [m.c0, m.r0, m.c1, m.r1]),
      freeze: [sh.freeze.rows, sh.freeze.cols],
      hiddenRows: [...sh.hiddenRows],
      hiddenCols: [...sh.hiddenCols],
      filter: sh.filter ? { range: [sh.filter.range.c0, sh.filter.range.r0, sh.filter.range.c1, sh.filter.range.r1], cols: Object.fromEntries(sh.filter.cols), ...(sh.filter.rules?.size ? { rules: Object.fromEntries(sh.filter.rules) } : {}) } : null,
      // Added with charts and printing: written only when the sheet has them, so other files stay as they were.
      ...(sh.charts.length ? { charts: sh.charts } : {}),
      ...(sh.cf.length ? { cf: sh.cf.map(e => ({ ranges: e.ranges.map(rangeArray), rule: e.rule, stop: e.stop || undefined })) } : {}),
      ...(sh.dv.length ? { dv: sh.dv.map(v => ({ ...v, ranges: v.ranges.map(rangeArray) })) } : {}),
      ...(sh.page ? { page: { ...sh.page, area: sh.page.area ? rangeArray(sh.page.area) : null } } : {}),
      ...(sh.tables.length ? { tables: sh.tables.map(t => ({ ...t, range: rangeArray(t.range) })) } : {}),
      ...(sh.pivots.length ? { pivots: sh.pivots.map(p => ({ ...p, last: p.last ? rangeArray(p.last) : null })) } : {}),
      ...(sh.noGrid ? { noGrid: true } : {}),
    }));
    return JSON.stringify({ format: FILE_FORMAT, version: 1, symbol: this.symbol, active: this.active, styles, sheets, ...(this.names.length ? { names: this.names } : {}) });
  }

  /** Loads a saved workbook, checking every field. Throws SyntaxProblem with a plain reason if the file is not one. */
  load(data: unknown, keepUndo = false): void {
    const bad = (why: string): never => {
      throw new SyntaxProblem(`This is not a spreadsheet this app can open (${why}).`);
    };
    if (!data || typeof data !== 'object') return bad('not a spreadsheet file');
    const d = data as Record<string, unknown>;
    if (d.format !== FILE_FORMAT && d.format !== OLD_FILE_FORMAT) return bad('wrong kind of file');
    if (!Array.isArray(d.sheets) || d.sheets.length < 1 || d.sheets.length > MAX_SHEETS) return bad('no sheets');
    const styles: CellStyle[] = [{}];
    if (Array.isArray(d.styles)) {
      for (const raw of d.styles.slice(1, MAX_STYLES)) styles.push(cleanStyle(raw));
    }
    const sheets: Sheet[] = [];
    let total = 0;
    for (const rawSheet of d.sheets) {
      const rs = rawSheet as Record<string, unknown>;
      if (!rs || typeof rs.name !== 'string' || rs.name.length > 31 || !Array.isArray(rs.cells)) return bad('a sheet is damaged');
      const sheet = new Sheet(rs.name);
      for (const c of rs.cells) {
        if (!Array.isArray(c) || c.length < 5) return bad('a cell is damaged');
        const [col, row, v, f, s] = c as [unknown, unknown, unknown, unknown, unknown];
        if (!Number.isInteger(col) || !Number.isInteger(row) || (col as number) < 0 || (col as number) >= MAX_COLS || (row as number) < 0 || (row as number) >= MAX_ROWS) return bad('a cell is outside the sheet');
        const cell: Cell = {};
        if (typeof f === 'string') {
          // Up to 8 times the longest a formula may be typed: one made longer by a rename before such renames were
          // refused still opens (it shows #NAME? until it is shortened), instead of the whole file being refused.
          if (f.length > MAX_FORMULA_LENGTH * 8) return bad('a formula is too long');
          cell.f = f;
        } else if (typeof v === 'number' && Number.isFinite(v)) cell.v = v;
        else if (typeof v === 'string' && v.length <= MAX_TEXT) cell.v = v;
        else if (typeof v === 'boolean') cell.v = v;
        if (typeof s === 'number' && Number.isInteger(s) && s > 0 && s < styles.length) cell.s = s;
        const note = (c as unknown[])[5];
        if (typeof note === 'string' && note.length <= MAX_NOTE) cell.n = note;
        if (bare(cell)) continue;
        sheet.cells.set(keyOf(col as number, row as number), cell);
        if (++total > MAX_CELLS) return bad('too many cells');
      }
      for (const [field, target, max] of [['colW', sheet.colW, MAX_COLS], ['rowH', sheet.rowH, MAX_ROWS]] as const) {
        const raw = rs[field];
        if (raw && typeof raw === 'object') {
          for (const [i, w] of Object.entries(raw as Record<string, unknown>).slice(0, 5000)) {
            const idx = Number(i);
            if (Number.isInteger(idx) && idx >= 0 && idx < max && typeof w === 'number' && w >= 8 && w <= 800) target.set(idx, w);
          }
        }
      }
      if (Array.isArray(rs.rowFit)) {
        for (const r of rs.rowFit.slice(0, 5000)) if (Number.isInteger(r) && sheet.rowH.has(r as number)) sheet.rowFit.add(r as number);
      }
      // Fields added later (merged cells, frozen panes, hidden rows and columns, the filter): each is checked, and a
      // file without them opens as before.
      const range = (raw: unknown): Range | null => {
        if (!Array.isArray(raw) || raw.length !== 4 || !raw.every(x => Number.isInteger(x))) return null;
        const [c0, r0, c1, r1] = raw as number[];
        return c0 >= 0 && r0 >= 0 && c1 >= c0 && r1 >= r0 && c1 < MAX_COLS && r1 < MAX_ROWS ? { c0, r0, c1, r1 } : null;
      };
      if (Array.isArray(rs.merges)) {
        for (const raw of rs.merges.slice(0, 20000)) {
          const m = range(raw);
          if (m && (m.c1 > m.c0 || m.r1 > m.r0) && !sheet.merges.some(x => overlaps(x, m))) sheet.merges.push(m);
        }
      }
      if (Array.isArray(rs.freeze) && rs.freeze.length === 2) {
        const [fr, fc] = rs.freeze as unknown[];
        if (Number.isInteger(fr) && Number.isInteger(fc) && (fr as number) >= 0 && (fc as number) >= 0) {
          sheet.freeze = { rows: Math.min(fr as number, MAX_ROWS - 1), cols: Math.min(fc as number, MAX_COLS - 1) };
        }
      }
      for (const [field, target, max] of [['hiddenRows', sheet.hiddenRows, MAX_ROWS], ['hiddenCols', sheet.hiddenCols, MAX_COLS]] as const) {
        const raw = rs[field];
        if (Array.isArray(raw)) for (const i of raw.slice(0, max)) if (Number.isInteger(i) && (i as number) >= 0 && (i as number) < max) target.add(i as number);
      }
      if (sheet.hiddenRows.size >= MAX_ROWS) sheet.hiddenRows.clear();
      if (sheet.hiddenCols.size >= MAX_COLS) sheet.hiddenCols.clear();
      const rf = rs.filter as Record<string, unknown> | null | undefined;
      const fr = rf && typeof rf === 'object' ? range(rf.range) : null;
      if (fr && fr.r1 > fr.r0) {
        const cols = new Map<number, string[]>();
        if (rf!.cols && typeof rf!.cols === 'object') {
          for (const [k, keep] of Object.entries(rf!.cols as Record<string, unknown>).slice(0, MAX_COLS)) {
            const c = Number(k);
            if (!Number.isInteger(c) || c < fr.c0 || c > fr.c1 || !Array.isArray(keep)) continue;
            cols.set(c, keep.slice(0, 20000).filter((x): x is string => typeof x === 'string' && x.length <= MAX_TEXT));
          }
        }
        const rules = new Map<number, FilterRule>();
        if (rf!.rules && typeof rf!.rules === 'object') {
          for (const [k, raw] of Object.entries(rf!.rules as Record<string, unknown>).slice(0, MAX_COLS)) {
            const c = Number(k);
            const rule = cleanFilterRule(raw);
            if (Number.isInteger(c) && c >= fr.c0 && c <= fr.c1 && rule && !cols.has(c)) rules.set(c, rule);
          }
        }
        sheet.filter = { range: fr, cols, ...(rules.size ? { rules } : {}) };
      }
      const ranges = (raw: unknown): Range[] => (Array.isArray(raw) ? raw.slice(0, MAX_RANGES).map(range).filter((r): r is Range => r !== null) : []);
      if (Array.isArray(rs.charts)) {
        const ids = new Set<number>();
        for (const raw of rs.charts.slice(0, MAX_CHARTS)) {
          const ch = cleanChart(raw);
          if (!ch) continue;
          while (ids.has(ch.id)) ch.id++;
          ids.add(ch.id);
          sheet.charts.push(ch);
        }
      }
      if (Array.isArray(rs.cf)) {
        for (const raw of rs.cf.slice(0, MAX_RULES)) {
          const e = raw as Record<string, unknown> | null;
          const rule = e && typeof e === 'object' ? cleanRule(e.rule) : null;
          const where = e ? ranges(e.ranges) : [];
          if (rule && where.length) sheet.cf.push({ ranges: where, rule, ...(e!.stop === true ? { stop: true } : {}) });
        }
      }
      if (Array.isArray(rs.dv)) {
        for (const raw of rs.dv.slice(0, MAX_VALIDATIONS)) {
          const v = cleanValidation(raw, raw && typeof raw === 'object' ? ranges((raw as Record<string, unknown>).ranges) : []);
          if (v) sheet.dv.push(v);
        }
      }
      if (rs.page && typeof rs.page === 'object') sheet.page = cleanPage(rs.page, range);
      if (rs.noGrid === true) sheet.noGrid = true;
      if (Array.isArray(rs.pivots)) {
        for (const raw of rs.pivots.slice(0, MAX_PIVOTS)) {
          const p = cleanPivot(raw, range);
          if (p) sheet.pivots.push(p);
        }
      }
      if (Array.isArray(rs.tables)) {
        for (const raw of rs.tables.slice(0, MAX_TABLES)) {
          const t = cleanTable(raw, range);
          if (t && !sheet.tables.some(x => overlaps(x.range, t.range))) sheet.tables.push(t);
        }
      }
      sheets.push(sheet);
    }
    const sheetNames = new Set(sheets.map(s => s.name.toLowerCase()));
    if (sheetNames.size !== sheets.length) return bad('two sheets have the same name');
    // Table names and numbers are unique in a workbook: a repeat is renamed or renumbered.
    const tableNames = new Set<string>();
    const tableIds = new Set<number>();
    for (const sh of sheets) {
      for (const t of sh.tables) {
        let name = t.name;
        for (let k = 2; tableNames.has(name.toLowerCase()); k++) name = `${t.name}_${k}`;
        t.name = name;
        tableNames.add(name.toLowerCase());
        while (tableIds.has(t.id)) t.id++;
        tableIds.add(t.id);
      }
    }
    // Names: each checked; one that breaks a rule, or says what it stands for in a way that does not read, is left out.
    const defined: DefinedName[] = [];
    if (Array.isArray(d.names)) {
      for (const raw of d.names.slice(0, MAX_NAMES)) {
        const n = raw as Record<string, unknown> | null;
        if (!n || typeof n.name !== 'string' || typeof n.ref !== 'string' || n.ref.length > 4000 || nameRuleProblem(n.name)) continue;
        const scope = typeof n.scope === 'string' && sheetNames.has(n.scope.toLowerCase()) ? n.scope : undefined;
        if (n.scope !== undefined && scope === undefined) continue;
        if (defined.some(x => x.name.toLowerCase() === (n.name as string).toLowerCase() && (x.scope ?? '').toLowerCase() === (scope ?? '').toLowerCase())) continue;
        try {
          parseFormula(n.ref);
        } catch {
          continue;
        }
        defined.push({ name: n.name, ref: n.ref, ...(scope ? { scope } : {}), ...(typeof n.comment === 'string' && n.comment ? { comment: n.comment.slice(0, 255) } : {}) });
      }
    }
    this.sheets = sheets;
    this.styles = styles;
    this.names = defined;
    this.symbol = typeof d.symbol === 'string' && d.symbol.length <= 3 ? d.symbol : '$';
    this.active = typeof d.active === 'number' && d.active >= 0 && d.active < sheets.length ? d.active : 0;
    if (!keepUndo) {
      this.undoStack = [];
      this.redoStack = [];
    }
    this.touch();
  }

  // ---- CSV ---------------------------------------------------------------------------------------------------------

  /**
   * Puts CSV/TSV text into the sheet starting at (col, row). Returns how many cells were set. A paste passes '\t': split
   * at tabs only, as Excel does, so a comma in pasted text stays in its cell. Left out, the delimiter is guessed (a CSV file).
   * What did not fit on the sheet is in `lastCut` afterwards (cutInWords says it).
   */
  importText(s: number, col: number, row: number, textIn: string, delimiter?: '\t'): number {
    const split = splitDelimited(textIn, delimiter);
    const table = split.rows;
    this.lastCut = { rows: Math.max(0, row + split.rowCount - MAX_ROWS), cols: Math.max(0, col + split.widest - MAX_COLS) };
    const changes: Change[] = [];
    let created = 0;
    let count = 0;
    table.forEach((line, r) => line.forEach((field, c) => {
      const cc = col + c;
      const rr = row + r;
      if (cc >= MAX_COLS || rr >= MAX_ROWS) return;
      const key = keyOf(cc, rr);
      const old = this.sheets[s].cells.get(key);
      let after: Cell | undefined;
      let wrap = false;
      try {
        // A pasted "=..." from elsewhere is kept as a formula only if it is one we understand.
        // A CSV split at semicolons writes numbers with a decimal comma (1,5): read as 1.5.
        const entry = parseEntry(split.delimiter === ';' ? decimalComma(field) : field, this.dateOrder);
        after = entry.cell;
        wrap = !!entry.wrap;
        // A pasted date takes the date format it was written in, unless the cell has a format already.
        if (entry.fmt && after && !this.styleOf(old)?.fmt) after = { ...after, s: this.internStyle({ ...this.styleOf(old), ...entry.fmt }) };
      } catch {
        after = { v: field };
      }
      if (wrap && !this.styleOf(old)?.wrap) after = { ...(after ?? {}), s: this.internStyle({ ...this.styleOf(old), wrap: true }) };
      else if (old?.s && after?.s === undefined) after = { ...(after ?? {}), s: old.s };
      if (old?.n !== undefined) after = { ...(after ?? {}), n: old.n };
      if (!old && after) created++;
      changes.push({ sheet: s, key, after });
      if (after) count++;
    }));
    this.assertRoom(created);
    if (changes.length) this.applyChanges(changes);
    return count;
  }

  /** The values of a range as CSV (or tab-separated). Text that could run as a formula in another program is defused. */
  exportText(s: number, r: Range, delimiter: ',' | '\t', shown = true): string {
    const lines: string[] = [];
    for (let row = r.r0; row <= r.r1; row++) {
      const fields: string[] = [];
      for (let col = r.c0; col <= r.c1; col++) {
        const v = this.value(s, col, row);
        let t = shown ? this.display(s, col, row) : valueToText(v);
        // Any text that a spreadsheet program would read as a formula (typed, or the result of one) is kept as text.
        if (typeof v === 'string' && runsAsFormula(t)) t = `'${t}`;
        // A copy (tab-separated): a cell with line breaks or tabs goes in quotes, as Excel copies it, so it pastes back
        // as one cell.
        if (delimiter === '\t') {
          if (/[\t\r\n]/.test(t) || t.startsWith('"')) t = `"${t.replace(/"/g, '""')}"`;
        } else if (/[",\r\n]/.test(t)) t = `"${t.replace(/"/g, '""')}"`;
        fields.push(t);
      }
      lines.push(fields.join(delimiter));
    }
    return lines.join('\r\n');
  }

  usedRange(s: number): Range {
    const b = this.bounds(s);
    return { c0: 0, r0: 0, c1: Math.max(0, b.cols - 1), r1: Math.max(0, b.rows - 1) };
  }
}

const rangeArray = (r: Range): number[] => [r.c0, r.r0, r.c1, r.r1];

const colLabel = (c: number): string => {
  let s = '';
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/** A table reference written back from its parts: Sales[Amount], Sales[[#Totals],[Amount]], [@Amount]. */
export function tablePartText(p: ReturnType<typeof parseTablePart>, long = false): string {
  const cols = p.c0 === undefined ? '' : p.c1 === undefined ? `[${escapeColumn(p.c0)}]` : `[${escapeColumn(p.c0)}]:[${escapeColumn(p.c1)}]`;
  // Excel files hold "this row" written out in full: Sales[[#This Row],[Amount]].
  if (p.thisRow && long) return cols ? `${p.table}[[#This Row],${cols}]` : `${p.table}[#This Row]`;
  if (p.thisRow) {
    if (!cols) return `${p.table}[@]`;
    return p.c1 === undefined && /^[A-Za-z0-9_]+$/.test(p.c0!) ? `${p.table}[@${p.c0}]` : `${p.table}[@${cols}]`;
  }
  const areas = p.areas.map(a => `[${a === '#all' ? '#All' : a === '#data' ? '#Data' : a === '#headers' ? '#Headers' : '#Totals'}]`);
  if (!areas.length) return `${p.table}${p.c1 === undefined && cols ? cols : `[${cols}]`}`;
  return `${p.table}[${[...areas, ...(cols ? [cols] : [])].join(',')}]`;
}

/** A formula with its table references rewritten by `fn` (null leaves a reference as it is). */
export function rewriteStructs(formula: string, fn: (part: ReturnType<typeof parseTablePart>) => ReturnType<typeof parseTablePart> | null, long = false): string {
  let toks;
  try {
    toks = tokenize(formula);
  } catch {
    return formula;
  }
  let out = formula;
  for (let k = toks.length - 1; k >= 0; k--) {
    const t = toks[k];
    if (t.type !== 'struct') continue;
    let part;
    try {
      part = parseTablePart(t.text);
    } catch {
      continue;
    }
    const next = fn(part);
    if (next) out = out.slice(0, t.start) + tablePartText(next, long) + out.slice(t.end);
  }
  return out;
}

/** A formula with its references to one table turned into plain cell addresses (Convert to range). */
function structsToRefs(formula: string, tables: Array<{ s: number; t: Table }>, table: Table, formulaSheet: number, here: { col: number; row: number }, sheetNames: string[], tableSheet: number): string {
  let toks;
  try {
    toks = tokenize(formula);
  } catch {
    return formula;
  }
  let out = formula;
  for (let k = toks.length - 1; k >= 0; k--) {
    const tk = toks[k];
    if (tk.type !== 'struct') continue;
    let part;
    try {
      part = parseTablePart(tk.text);
    } catch {
      continue;
    }
    const named = part.table ? part.table.toLowerCase() === table.name.toLowerCase() : formulaSheet === tableSheet && here.col >= table.range.c0 && here.col <= table.range.c1 && here.row >= table.range.r0 && here.row <= table.range.r1;
    if (!named) continue;
    const box = partBox(tables, part, formulaSheet, here);
    if (box instanceof CellError) {
      out = out.slice(0, tk.start) + '#REF!' + out.slice(tk.end);
      continue;
    }
    const abs = !part.thisRow;
    const a = `${abs ? '$' : ''}${colLabel(box.c0)}${abs ? '$' : ''}${box.r0 + 1}`;
    const b = `${abs ? '$' : ''}${colLabel(box.c1)}${abs ? '$' : ''}${box.r1 + 1}`;
    const prefix = box.s !== formulaSheet ? `${/^[A-Za-z_][A-Za-z0-9_]*$/.test(sheetNames[box.s]) ? sheetNames[box.s] : `'${sheetNames[box.s].replace(/'/g, "''")}'`}!` : '';
    out = out.slice(0, tk.start) + prefix + (a === b ? a : `${a}:${b}`) + out.slice(tk.end);
  }
  return out;
}

/** A formula with every use of a name changed to another (not a function of that name, nor a cell address). */
export function renameInFormula(formula: string, from: string, to: string): string {
  let toks;
  try {
    toks = tokenize(formula);
  } catch {
    return formula;
  }
  let out = formula;
  for (let k = toks.length - 1; k >= 0; k--) {
    const t = toks[k];
    if (t.type !== 'ident' || t.text.toLowerCase() !== from.toLowerCase() || toks[k + 1]?.type === 'lp' || toks[k + 1]?.type === 'bang') continue;
    out = out.slice(0, t.start) + to + out.slice(t.end);
  }
  return out;
}

/** Rewrites every formula a sheet's charts, conditional formats and validation rules hold (a reference that cannot be
 *  read is left as it is). */
function mapSheetFormulas(sheet: Sheet, fn: (f: string) => string): void {
  const safe = (f: string) => {
    if (!f) return f;
    try {
      return fn(f);
    } catch {
      return f;
    }
  };
  sheet.charts = sheet.charts.map(ch => mapChartRefs(ch, safe));
  for (const p of sheet.pivots) p.source = safe(p.source);
  for (const e of sheet.cf) {
    const r = e.rule;
    if (r.t === 'cell') e.rule = { ...r, f1: safe(r.f1), ...(r.f2 !== undefined ? { f2: safe(r.f2) } : {}) };
    else if (r.t === 'expr') e.rule = { ...r, f: safe(r.f) };
  }
  for (const v of sheet.dv) {
    v.f1 = safe(v.f1);
    v.f2 = safe(v.f2);
  }
}

const COLOUR = /^#[0-9a-f]{6}$/i;
function cleanStyle(raw: unknown): CellStyle {
  const out: CellStyle = {};
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  for (const k of ['b', 'i', 'u', 'wrap'] as const) if (r[k] === true) out[k] = true;
  for (const k of ['bt', 'bb', 'bl', 'br'] as const) if (r[k] === true || r[k] === 'medium' || r[k] === 'thick' || r[k] === 'double') out[k] = r[k] as CellStyle['bt'];
  if (typeof r.bc === 'string' && COLOUR.test(r.bc)) out.bc = r.bc;
  if (r.al === 'l' || r.al === 'c' || r.al === 'r') out.al = r.al;
  if (r.fmt === 'number' || r.fmt === 'currency' || r.fmt === 'percent' || r.fmt === 'comma' || r.fmt === 'text') out.fmt = r.fmt;
  // A format code is kept only if it reads; otherwise the cell is shown as General.
  if (r.fmt === 'custom' && typeof r.code === 'string' && r.code.length <= 255 && codeProblem(r.code) === null) {
    out.fmt = 'custom';
    out.code = r.code;
  }
  if (typeof r.dec === 'number' && Number.isInteger(r.dec) && r.dec >= 0 && r.dec <= 15) out.dec = r.dec;
  if (typeof r.fill === 'string' && COLOUR.test(r.fill)) out.fill = r.fill;
  if (typeof r.color === 'string' && COLOUR.test(r.color)) out.color = r.color;
  // Added with fonts (session 8): size 1 to 409 points (Excel's range), a plain typeface name, strikethrough,
  // vertical alignment and indent.
  if (typeof r.fs === 'number' && r.fs >= 1 && r.fs <= 409) out.fs = Math.round(r.fs * 2) / 2;
  const face = cleanFace(r.ff);
  if (face) out.ff = face;
  if (r.st === true) out.st = true;
  if (r.va === 't' || r.va === 'm') out.va = r.va;
  if (typeof r.ind === 'number' && Number.isInteger(r.ind) && r.ind >= 1 && r.ind <= 15) out.ind = r.ind;
  return out;
}

/**
 * Splits CSV or tab-separated text into rows of fields (quotes, doubled quotes, and line breaks inside quotes work).
 * The delimiter is guessed from the first line unless one is given. Only a sheet's worth is kept; see splitDelimited.
 */
export function parseDelimited(input: string, given?: '\t'): string[][] {
  return splitDelimited(input, given).rows;
}

/**
 * parseDelimited, also saying how big the text really was: `rowCount` rows and `widest` fields in its longest row,
 * counted past the edge of a sheet, where `rows` stops.
 */
export function splitDelimited(input: string, given?: '\t'): { rows: string[][]; rowCount: number; widest: number; delimiter: string } {
  const firstLine = input.split(/\r?\n/, 1)[0] ?? '';
  const count = (ch: string) => firstLine.split(ch).length - 1;
  const delimiter = given ?? (count('\t') > 0 && count('\t') >= count(',') ? '\t' : count(';') > count(',') ? ';' : ',');
  const rows: string[][] = [];
  let rowCount = 0;
  let widest = 0;
  const end = (line: string[]) => {
    rowCount++;
    widest = Math.max(widest, line.length);
    if (rows.length < MAX_ROWS) rows.push(line.slice(0, MAX_COLS));
  };
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && input[i + 1] === '\n') i++;
      row.push(field);
      end(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    end(row);
  }
  return { rows, rowCount, widest, delimiter };
}

/**
 * A number written with a decimal comma ("1,5", "1.234,5", "12,5%"), as a CSV split at semicolons writes it (Excel in
 * much of Europe), put with a decimal point so it reads as a number. "1,500" there is one and a half, not 1500. Any other
 * text comes back as it was.
 */
export function decimalComma(field: string): string {
  const m = /^\s*([-+]?)(\d{1,3}(?:\.\d{3})+|\d+),(\d+)(%?)\s*$/.exec(field);
  return m ? `${m[1]}${m[2].replace(/\./g, '')}.${m[3]}${m[4]}` : field;
}

/**
 * True when text put in a CSV would run as a formula in another spreadsheet program: it starts with = or @ (or a tab or
 * a return), or with + or - followed by more than a plain number or a phone number. "+64 21 555 0100", "-12.5" and a
 * lone "-" are left as they are; "+SUM(A1)" and "-1+2" are not.
 */
export function runsAsFormula(text: string): boolean {
  if (/^[=@\t\r]/.test(text)) return true;
  if (!/^[+-]/.test(text)) return false;
  if (text.length === 1) return false;
  if (/^[+-](?:\d[\d,]*(?:\.\d+)?|\.\d+)(?:e[-+]?\d+)?%?$/i.test(text)) return false;
  // A phone number: + then digits, with spaces, brackets, dots or dashes between them, at least seven digits.
  if (/^\+\d[\d ().-]*\d$/.test(text) && (text.match(/\d/g) ?? []).length >= 7) return false;
  return true;
}

/** Rows and columns an import or paste could not fit, in words, or '' when it all fitted. */
export function cutInWords(cut: { rows: number; cols: number }): string {
  const parts = [cut.rows ? plural(cut.rows, 'row') : '', cut.cols ? plural(cut.cols, 'column') : ''].filter(Boolean);
  if (!parts.length) return '';
  return `${parts.join(' and ')} did not fit and ${cut.rows + cut.cols === 1 ? 'was' : 'were'} left out: a sheet here holds ${MAX_ROWS.toLocaleString()} rows and ${MAX_COLS} columns (to column ${colName(MAX_COLS - 1)}).`;
}

/**
 * Reads a text file's bytes as text. A byte-order mark says UTF-8 or UTF-16; otherwise UTF-8 if the bytes are valid
 * UTF-8, else Windows-1252 (Excel's "CSV (Comma delimited)" on Windows), so £ and é come through either way.
 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}
