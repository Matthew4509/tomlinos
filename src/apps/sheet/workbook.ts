// The spreadsheet's data and its rules: sheets of cells, formulas that are worked out when needed, styles, undo and
// redo, inserting and deleting rows and columns (formulas follow), sorting, filling, CSV in and out, and the saved
// file format. No page code here, so it can be tested without a browser.
import { evaluate, parseFormula, text as valueToText, type Context, type Node } from './formula.ts';
import { MAX_COLS, MAX_ROWS, mapRefs, renameSheetInFormula, shiftFormula, SyntaxProblem, type Ref } from './refs.ts';
import { CellError, clean, E, formatNumber, type CellStyle, type Value, valueText } from './values.ts';

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
}

const NUMBER = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:e[-+]?\d+)?$/i;

/** What typing `input` into a cell means. Throws SyntaxProblem for a formula that is not written correctly. */
export function parseEntry(input: string): Entry {
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
  return { cell: { v: input } };
}

export class Workbook {
  sheets: Sheet[] = [new Sheet('Sheet1')];
  styles: CellStyle[] = [{}];
  symbol = '$';
  active = 0;
  /** Bumped by every change, so views know to redraw. */
  version = 0;
  private memo = new Map<number, Value>();
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
      bounds: s => this.bounds(s),
    };
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
    return this.bounds(s);
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
    if (!cell) return null;
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
      let tree = this.ast.get(cell.f);
      if (!tree) {
        try {
          tree = parseFormula(cell.f);
        } catch (error) {
          // Only a formula that does not read is #NAME?; anything else (the stack running out) is not this formula's fault.
          if (!(error instanceof SyntaxProblem)) throw error;
          tree = E.NAME;
        }
        if (this.ast.size > 50_000) this.ast.clear();
        this.ast.set(cell.f, tree);
      }
      result = tree instanceof CellError ? tree : evaluate(tree, this.context(s));
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

  /** What is shown in the cell. */
  display(s: number, col: number, row: number): string {
    const cell = this.sheets[s]?.cells.get(keyOf(col, row));
    const v = this.value(s, col, row);
    const style = this.styleOf(cell);
    if (style?.fmt === 'text' && cell?.f === undefined && v !== null) return valueToText(v);
    return valueText(v, style, this.symbol);
  }

  /** The text to put in the editor for this cell. */
  editText(s: number, col: number, row: number): string {
    const cell = this.sheets[s]?.cells.get(keyOf(col, row));
    if (!cell) return '';
    if (cell.f !== undefined) return `=${cell.f}`;
    const v = cell.v;
    if (typeof v === 'number') {
      const style = this.styleOf(cell);
      return style?.fmt === 'percent' ? `${formatNumber(v, { fmt: 'percent', dec: style.dec }, this.symbol)}` : String(clean(v));
    }
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (typeof v === 'string') {
      if (/^[='"]/.test(v) || (parseEntry(v).cell?.v !== v && v !== '')) return `'${v}`;
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
    const entry = parseEntry(input);
    const old = this.sheets[s].cells.get(keyOf(col, row));
    let after: Cell | undefined = entry.cell ? { ...entry.cell } : undefined;
    if (after || old?.s) {
      let style = old?.s ? this.styles[old.s] : undefined;
      if (entry.fmt && !style?.fmt) style = { ...style, ...entry.fmt };
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
        const series = nums.length >= 2 && nums.length === height;
        const step = series ? nums[nums.length - 1] - nums[nums.length - 2] : 0;
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
        const series = nums.length >= 2 && nums.length === src.c1 - src.c0 + 1;
        const step = series ? nums[nums.length - 1] - nums[nums.length - 2] : 0;
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
      for (const sheet of this.sheets) {
        for (const cell of sheet.cells.values()) {
          if (cell.f === undefined) continue;
          cell.f = mapRefs(cell.f, (a, b, refSheet) => {
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
      if (axis === 'row') target.rowH = next;
      else target.colW = next;
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
      for (const sheet of this.sheets) for (const cell of sheet.cells.values()) if (cell.f !== undefined) cell.f = renameSheetInFormula(cell.f, old, name);
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
      }
      this.active = Math.min(this.active, this.sheets.length - 1);
    });
  }

  setSize(s: number, axis: 'row' | 'col', index: number, size: number | null): void {
    const map = axis === 'row' ? this.sheets[s].rowH : this.sheets[s].colW;
    if (size === null) map.delete(index);
    else map.set(index, Math.max(axis === 'row' ? 12 : 16, Math.min(axis === 'row' ? 400 : 800, Math.round(size))));
    this.version++;
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

  // ---- Saving and loading ------------------------------------------------------------------------------------------

  serialize(): string {
    const sheets = this.sheets.map(sh => ({
      name: sh.name,
      colW: Object.fromEntries(sh.colW),
      rowH: Object.fromEntries(sh.rowH),
      cells: [...sh.cells].map(([k, c]) => [colOfKey(k), rowOfKey(k), c.v ?? null, c.f ?? null, c.s ?? 0]),
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

  /** Puts CSV/TSV text into the sheet starting at (col, row). Returns how many cells were set. */
  importText(s: number, col: number, row: number, textIn: string): number {
    const table = parseDelimited(textIn);
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
      try {
        // A pasted "=..." from elsewhere is kept as a formula only if it is one we understand.
        after = parseEntry(field).cell;
      } catch {
        after = { v: field };
      }
      if (old?.s) after = { ...(after ?? {}), s: old.s };
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
        if (delimiter === '\t') t = t.replace(/[\t\r\n]+/g, ' ');
        else if (/[",\r\n]/.test(t)) t = `"${t.replace(/"/g, '""')}"`;
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

const COLOUR = /^#[0-9a-f]{6}$/i;
function cleanStyle(raw: unknown): CellStyle {
  const out: CellStyle = {};
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  for (const k of ['b', 'i', 'u', 'bt', 'bb', 'bl', 'br'] as const) if (r[k] === true) out[k] = true;
  if (r.al === 'l' || r.al === 'c' || r.al === 'r') out.al = r.al;
  if (r.fmt === 'number' || r.fmt === 'currency' || r.fmt === 'percent' || r.fmt === 'comma' || r.fmt === 'text') out.fmt = r.fmt;
  if (typeof r.dec === 'number' && Number.isInteger(r.dec) && r.dec >= 0 && r.dec <= 15) out.dec = r.dec;
  if (typeof r.fill === 'string' && COLOUR.test(r.fill)) out.fill = r.fill;
  if (typeof r.color === 'string' && COLOUR.test(r.color)) out.color = r.color;
  return out;
}

/** Splits CSV or tab-separated text into rows of fields (quotes, doubled quotes, and line breaks inside quotes work). */
export function parseDelimited(input: string): string[][] {
  const firstLine = input.split(/\r?\n/, 1)[0] ?? '';
  const count = (ch: string) => firstLine.split(ch).length - 1;
  const delimiter = count('\t') > 0 && count('\t') >= count(',') ? '\t' : count(';') > count(',') ? ';' : ',';
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
