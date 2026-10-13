// The spreadsheet's data and its rules: sheets of cells, formulas that are worked out when needed, styles, undo and
// redo, inserting and deleting rows and columns (formulas follow), sorting, filling, CSV in and out, and the saved
// file format. No page code here, so it can be tested without a browser.
// A formula whose answer is a list (=SORT(A2:A9), =FILTER(...), =A1:A5*2) fills the cells below and to the right of it
// ("spills"), as in Excel 365; nothing is stored in those cells, so typing in one of them stops the list (#SPILL!).
import { localeDateOrder, readDateTime, shortDateCode, type DateOrder } from './dates.ts';
import { evaluateCell, givesList, leadingFunction, parseFormula, text as valueToText, type Context, type Grid, type Node } from './formula.ts';
import { codeProblem, formatCode, isDateCode, type Formatted } from './numfmt.ts';
import { MAX_COLS, MAX_ROWS, mapRefs, parseCellRef, renameSheetInFormula, shiftFormula, SyntaxProblem, tokenize, type Ref } from './refs.ts';
import { CellError, clean, E, formatNumber, formatValue, type CellStyle, type Value } from './values.ts';
import { cleanChart, mapChartRefs, MAX_CHARTS, type Chart } from './chart.ts';
import { cleanRule, MAX_RANGES, MAX_RULES, subtractAll, type CfEntry } from './condfmt.ts';
import { cleanPage, type PageSetup } from './print.ts';
import { cleanValidation, MAX_VALIDATIONS, type Validation } from './validate.ts';

export const FILE_FORMAT = 'tomlinos-sheet';
/** Spreadsheets saved before the desktop's rename carry this tag; they still open, and are saved with the new one. */
const OLD_FILE_FORMAT = 'myiaos-sheet';
export const MAX_CELLS = 400_000;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_CHANGES_PER_EDIT = 120_000;
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
}

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

/** A filter: its range (the header row first) and, per filtered column, the values (as shown) whose rows stay in view. */
export interface Filter {
  range: Range;
  /** Column index -> the shown texts kept; '' stands for empty cells ("(Blanks)"). */
  cols: Map<number, string[]>;
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
type UndoEntry = { kind: 'cells'; changes: Change[] } | { kind: 'snap'; before: string; after: string };

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
  private redoStack: UndoEntry[] = [];
  private boundsCache: Array<{ v: number; cols: number; rows: number }> = [];
  private depth = 0;

  // ---- Working out values ------------------------------------------------------------------------------------------

  private context(current: number): Context {
    return {
      current,
      cell: (s, c, r) => this.value(s, c, r),
      sheetIndex: name => this.sheets.findIndex(x => x.name.toLowerCase() === name.toLowerCase()),
      bounds: (s, area) => (area ? this.areaBounds(s, area) : this.fullBounds(s)),
      spill: (s, c, r) => this.spillOf(s, c, r),
      dateOrder: this.dateOrder,
    };
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
      if (!(tree instanceof CellError) && givesList(tree)) keys.push(k);
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
        const out = evaluateCell(tree, this.context(s));
        if (Array.isArray(out)) result = this.place(s, col, row, memoKey, out);
        else {
          result = out;
          if (givesList(tree)) this.spills.set(memoKey, out instanceof CellError ? null : [[out]]);
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
    const at = this.styles.findIndex((s, i) => i > 0 && JSON.stringify(s, Object.keys(s).sort()) === json);
    if (at > 0) return at;
    this.styles.push(clean);
    return this.styles.length - 1;
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
    if (!old && after) this.assertRoom(1);
    this.applyChanges([{ sheet: s, key: keyOf(col, row), after }]);
  }

  /** Clears what is typed in the cells but keeps their formatting. */
  clearContents(s: number, r: Range): void {
    const changes: Change[] = [];
    for (const [k, cell] of this.sheets[s].cells) {
      const c = colOfKey(k);
      const rw = rowOfKey(k);
      if (c < r.c0 || c > r.c1 || rw < r.r0 || rw > r.r1) continue;
      changes.push({ sheet: s, key: k, after: cell.s ? { s: cell.s } : undefined });
    }
    if (changes.length) this.applyChanges(changes);
  }

  /** Changes formatting for every cell in the range (creating empty formatted cells where needed). */
  setStyle(s: number, r: Range, patch: (old: CellStyle) => CellStyle): void {
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
        changes.push({ sheet: s, key, after: after.v === undefined && after.f === undefined && !after.s ? undefined : after });
      }
    }
    this.assertRoom(created);
    if (changes.length) this.applyChanges(changes);
  }

  /** Copies cells from `src` onto `dest` (top-left corner), shifting relative references. `cut` empties the source. */
  copyBlock(s: number, src: Range, dest: { col: number; row: number }, opts: { cut?: boolean; fromSheet?: number } = {}): void {
    const from = opts.fromSheet ?? s;
    const width = src.c1 - src.c0 + 1;
    const height = src.r1 - src.r0 + 1;
    if (dest.col + width > MAX_COLS || dest.row + height > MAX_ROWS) throw new SyntaxProblem('That does not fit on the sheet.');
    const grabbed: Array<{ dc: number; dr: number; cell?: Cell }> = [];
    for (let dr = 0; dr < height; dr++) for (let dc = 0; dc < width; dc++) grabbed.push({ dc, dr, cell: this.sheets[from].cells.get(keyOf(src.c0 + dc, src.r0 + dr)) });
    const changes: Change[] = [];
    const moved = new Set<number>();
    let created = 0;
    for (const g of grabbed) {
      const key = keyOf(dest.col + g.dc, dest.row + g.dr);
      moved.add(key);
      let after: Cell | undefined;
      if (g.cell) {
        after = { ...g.cell };
        if (after.f !== undefined) after.f = shiftFormula(after.f, dest.col - src.c0, dest.row - src.r0);
      }
      if (!this.sheets[s].cells.has(key) && after) created++;
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
    if (this.sheets[s].merges.some(m => overlaps(m, r))) throw new SyntaxProblem('Some of these cells are merged, and merged cells cannot be sorted. Unmerge them first (Merge > Unmerge cells), then sort.');
    const rows: number[] = [];
    for (let row = r.r0; row <= r.r1; row++) rows.push(row);
    const keyValue = (row: number): Value => this.value(s, byCol, row);
    const rank = (v: Value) => (v === null ? 3 : typeof v === 'number' ? 0 : typeof v === 'boolean' ? 2 : v instanceof CellError ? 4 : 1);
    const sorted = [...rows].sort((a, b) => {
      const va = keyValue(a);
      const vb = keyValue(b);
      const ra = rank(va);
      const rb = rank(vb);
      if (ra !== rb) return ra - rb;
      let c = 0;
      if (typeof va === 'number' && typeof vb === 'number') c = va - vb;
      else if (typeof va === 'string' && typeof vb === 'string') c = va.toLowerCase().localeCompare(vb.toLowerCase());
      return (ascending ? c : -c) || a - b;
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

  // ---- Rows, columns, sheets ---------------------------------------------------------------------------------------

  private snapshotChange(fn: () => void): void {
    const before = this.serialize();
    fn();
    const after = this.serialize();
    this.pushUndo({ kind: 'snap', before, after });
    this.touch();
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
          target.filter = { range, cols };
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

  renameSheet(s: number, name: string): void {
    const problem = this.sheetNameProblem(name, s);
    if (problem) throw new SyntaxProblem(problem);
    const old = this.sheets[s].name;
    this.snapshotChange(() => {
      for (const sheet of this.sheets) {
        for (const cell of sheet.cells.values()) if (cell.f !== undefined) cell.f = renameSheetInFormula(cell.f, old, name);
        mapSheetFormulas(sheet, f => renameSheetInFormula(f, old, name));
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
      this.active = Math.min(this.active, this.sheets.length - 1);
    });
  }

  setSize(s: number, axis: 'row' | 'col', index: number, size: number | null): void {
    const map = axis === 'row' ? this.sheets[s].rowH : this.sheets[s].colW;
    if (size === null) map.delete(index);
    else map.set(index, Math.max(axis === 'row' ? 12 : 16, Math.min(axis === 'row' ? 400 : 800, Math.round(size))));
    // A height set by hand stays as set: fitting the text no longer changes it.
    if (axis === 'row') this.sheets[s].rowFit.delete(index);
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
          if (cell.s) sheet.cells.set(k, { s: cell.s });
          else sheet.cells.delete(k);
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

  /** Keeps `rows` rows and `cols` columns in view while the rest scrolls (0, 0: nothing frozen). Not an undo step, as in Excel. */
  setFreeze(s: number, rows: number, cols: number): void {
    const f = this.sheets[s].freeze;
    const r = Math.max(0, Math.min(MAX_ROWS - 1, Math.floor(rows)));
    const c = Math.max(0, Math.min(MAX_COLS - 1, Math.floor(cols)));
    if (f.rows === r && f.cols === c) return;
    this.sheets[s].freeze = { rows: r, cols: c };
    this.version++;
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
      // New rows typed under the table are taken in, as Excel does when a filter is applied again.
      const used = this.usedBounds(s);
      while (filter.range.r1 + 1 < Math.min(MAX_ROWS, used.rows)) {
        let any = false;
        for (let c = filter.range.c0; c <= filter.range.c1 && !any; c++) any = this.value(s, c, filter.range.r1 + 1) !== null;
        if (!any) break;
        filter.range.r1++;
      }
      if (keep) filter.cols.set(col, [...new Set(keep)]);
      else filter.cols.delete(col);
      this.applyFilter(s);
    });
  }

  /** Hides the filter's rows that do not pass, and shows those that do. */
  private applyFilter(s: number): void {
    const sheet = this.sheets[s];
    const f = sheet.filter;
    if (!f) return;
    const tests = [...f.cols].map(([c, keep]) => ({ c, keep: new Set(keep.map(k => k.toLowerCase())) }));
    for (let r = f.range.r0 + 1; r <= f.range.r1; r++) {
      const pass = tests.every(t => t.keep.has(this.display(s, t.c, r).toLowerCase()));
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
    for (const ch of which === 'before' ? [...e.changes].reverse() : e.changes) {
      const cell = which === 'before' ? ch.before : ch.after;
      if (cell) this.sheets[ch.sheet].cells.set(ch.key, cell);
      else this.sheets[ch.sheet].cells.delete(ch.key);
    }
    this.touch();
  }

  // ---- Charts, conditional formatting, validation, page setup (each change is one Undo) -------------------------------

  /** A formula (without "=") worked out on a sheet: one value, or the list it gives. */
  evalFormula(s: number, f: string): Value | Grid {
    const tree = this.parsed(f);
    if (tree instanceof CellError) return tree;
    try {
      return evaluateCell(tree, this.context(s));
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
  setChart(s: number, id: number, chart: Chart | null): void {
    const sheet = this.sheets[s];
    const i = sheet.charts.findIndex(c => c.id === id);
    if (i < 0) return;
    this.snapshotChange(() => {
      if (chart) sheet.charts[i] = { ...chart, id };
      else sheet.charts.splice(i, 1);
    });
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

  /** How the sheet prints (null: back to the usual setup). */
  setPage(s: number, page: PageSetup | null): void {
    this.snapshotChange(() => {
      this.sheets[s].page = page;
    });
  }

  // ---- Saving and loading ------------------------------------------------------------------------------------------

  serialize(): string {
    const sheets = this.sheets.map(sh => ({
      name: sh.name,
      colW: Object.fromEntries(sh.colW),
      rowH: Object.fromEntries(sh.rowH),
      rowFit: [...sh.rowFit],
      cells: [...sh.cells].map(([k, c]) => [colOfKey(k), rowOfKey(k), c.v ?? null, c.f ?? null, c.s ?? 0]),
      merges: sh.merges.map(m => [m.c0, m.r0, m.c1, m.r1]),
      freeze: [sh.freeze.rows, sh.freeze.cols],
      hiddenRows: [...sh.hiddenRows],
      hiddenCols: [...sh.hiddenCols],
      filter: sh.filter ? { range: [sh.filter.range.c0, sh.filter.range.r0, sh.filter.range.c1, sh.filter.range.r1], cols: Object.fromEntries(sh.filter.cols) } : null,
      // Added with charts and printing: written only when the sheet has them, so other files stay as they were.
      ...(sh.charts.length ? { charts: sh.charts } : {}),
      ...(sh.cf.length ? { cf: sh.cf.map(e => ({ ranges: e.ranges.map(rangeArray), rule: e.rule, stop: e.stop || undefined })) } : {}),
      ...(sh.dv.length ? { dv: sh.dv.map(v => ({ ...v, ranges: v.ranges.map(rangeArray) })) } : {}),
      ...(sh.page ? { page: { ...sh.page, area: sh.page.area ? rangeArray(sh.page.area) : null } } : {}),
    }));
    return JSON.stringify({ format: FILE_FORMAT, version: 1, symbol: this.symbol, active: this.active, styles: this.styles, sheets });
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
      for (const raw of d.styles.slice(1, 5000)) styles.push(cleanStyle(raw));
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
          if (f.length > 4000) return bad('a formula is too long');
          cell.f = f;
        } else if (typeof v === 'number' && Number.isFinite(v)) cell.v = v;
        else if (typeof v === 'string' && v.length <= MAX_TEXT) cell.v = v;
        else if (typeof v === 'boolean') cell.v = v;
        if (typeof s === 'number' && Number.isInteger(s) && s > 0 && s < styles.length) cell.s = s;
        if (cell.v === undefined && cell.f === undefined && !cell.s) continue;
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
        sheet.filter = { range: fr, cols };
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
      sheets.push(sheet);
    }
    const names = new Set(sheets.map(s => s.name.toLowerCase()));
    if (names.size !== sheets.length) return bad('two sheets have the same name');
    this.sheets = sheets;
    this.styles = styles;
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
   */
  importText(s: number, col: number, row: number, textIn: string, delimiter?: '\t'): number {
    const table = parseDelimited(textIn, delimiter);
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
        const entry = parseEntry(field, this.dateOrder);
        after = entry.cell;
        wrap = !!entry.wrap;
        // A pasted date takes the date format it was written in, unless the cell has a format already.
        if (entry.fmt && after && !this.styleOf(old)?.fmt) after = { ...after, s: this.internStyle({ ...this.styleOf(old), ...entry.fmt }) };
      } catch {
        after = { v: field };
      }
      if (wrap && !this.styleOf(old)?.wrap) after = { ...(after ?? {}), s: this.internStyle({ ...this.styleOf(old), wrap: true }) };
      else if (old?.s && after?.s === undefined) after = { ...(after ?? {}), s: old.s };
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
        if (typeof v === 'string' && /^[=+\-@\t\r]/.test(t)) t = `'${t}`;
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
  return out;
}

/**
 * Splits CSV or tab-separated text into rows of fields (quotes, doubled quotes, and line breaks inside quotes work).
 * The delimiter is guessed from the first line unless one is given.
 */
export function parseDelimited(input: string, given?: '\t'): string[][] {
  const firstLine = input.split(/\r?\n/, 1)[0] ?? '';
  const count = (ch: string) => firstLine.split(ch).length - 1;
  const delimiter = given ?? (count('\t') > 0 && count('\t') >= count(',') ? '\t' : count(';') > count(',') ? ';' : ',');
  const rows: string[][] = [];
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
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
    if (rows.length > MAX_ROWS) break;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.slice(0, MAX_ROWS).map(r => r.slice(0, MAX_COLS));
}
