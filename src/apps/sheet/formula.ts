// Reading and working out formulas: "=SUM(A1:A5)*2". Our own parser and evaluator (nothing is ever passed to eval).
// Operators: + - * / ^ & % = <> < > <= >= and brackets. Functions: see FUNCTIONS. A formula that is too long, too
// deeply nested, or that loops back on itself gives an error value instead of hanging.
// Lists work as in Excel 365: an operator or a one-value function given a list works on every value of it
// (B2:B10>5 is a list of TRUE/FALSE), and a formula whose answer is a list fills the cells around it (see workbook.ts).
import { daysInMonth, nowSerial, partsOf, readDateTime, serialOf, type DateOrder } from './dates.ts';
import { CodeProblem, formatCode } from './numfmt.ts';
import { parseCellRef, parseColRef, sheetNameOf, SyntaxProblem, tokenize, wholeColumns, type Ref, type Tok } from './refs.ts';
import { CellError, clean, E, type Value } from './values.ts';

export const MAX_FORMULA_LENGTH = 4000;
const MAX_DEPTH = 60;
/** The most values a list worked out inside a formula may hold. */
export const MAX_LIST = 1_000_000;

/** A block of values, row by row. */
export type Grid = Value[][];

export type Node =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'err'; e: CellError }
  /** An argument left empty, as in IF(A1>2,"y",): a blank, as a blank cell would be. */
  | { t: 'blank' }
  | { t: 'ref'; ref: Ref; sheet?: string }
  | { t: 'range'; a: Ref; b: Ref; sheet?: string }
  | { t: 'un'; op: '-' | '+' | '%'; x: Node }
  | { t: 'bin'; op: string; l: Node; r: Node }
  | { t: 'call'; name: string; args: Node[] }
  /** A list typed into the formula: {1,2,3} is one row, {1;2;3} one column. */
  | { t: 'array'; rows: Node[][] }
  /** A1#: all the cells A1's list answer fills. */
  | { t: 'spill'; ref: Ref; sheet?: string }
  /** A value or a list already worked out (used inside the evaluator, never parsed). */
  | { t: 'val'; v: Value }
  | { t: 'grid'; g: Grid };

// ---- Parsing -------------------------------------------------------------------------------------------------------

export function parseFormula(text: string): Node {
  if (text.length > MAX_FORMULA_LENGTH) throw new SyntaxProblem('That formula is too long.');
  const toks = tokenize(text);
  if (!toks.length) throw new SyntaxProblem('The formula is empty.');
  let p = 0;
  const peek = (): Tok | undefined => toks[p];
  const isOp = (t: Tok | undefined, ...ops: string[]) => t?.type === 'op' && ops.includes(t.text);
  const fail = (msg: string): never => {
    throw new SyntaxProblem(msg);
  };

  function comparison(d: number): Node {
    let l = concat(d);
    while (isOp(peek(), '=', '<>', '<', '>', '<=', '>=')) l = { t: 'bin', op: toks[p++].text, l, r: concat(d) };
    return l;
  }
  function concat(d: number): Node {
    let l = add(d);
    while (isOp(peek(), '&')) l = { t: 'bin', op: toks[p++].text, l, r: add(d) };
    return l;
  }
  function add(d: number): Node {
    let l = mul(d);
    while (isOp(peek(), '+', '-')) l = { t: 'bin', op: toks[p++].text, l, r: mul(d) };
    return l;
  }
  function mul(d: number): Node {
    let l = pow(d);
    while (isOp(peek(), '*', '/')) l = { t: 'bin', op: toks[p++].text, l, r: pow(d) };
    return l;
  }
  function pow(d: number): Node {
    let l = unary(d);
    while (isOp(peek(), '^')) l = { t: 'bin', op: '^', l: (p++, l), r: unary(d) };
    return l;
  }
  function unary(d: number): Node {
    if (d > MAX_DEPTH) fail('That formula is nested too deeply.');
    if (isOp(peek(), '-', '+')) {
      const op = toks[p++].text as '-' | '+';
      return { t: 'un', op, x: unary(d + 1) };
    }
    let x = primary(d + 1);
    while (isOp(peek(), '%')) {
      p++;
      x = { t: 'un', op: '%', x };
    }
    return x;
  }
  function refAt(tok: Tok, sheet?: string): Node | null {
    // A:C, whole columns (written with no space round the colon).
    if (toks[p]?.type === 'colon' && toks[p + 1]?.type === 'ident' && toks[p].start === tok.end && toks[p + 1].start === toks[p].end) {
      const ca = parseColRef(tok.text);
      const cb = ca ? parseColRef(toks[p + 1].text) : null;
      if (ca && cb) {
        p += 2;
        const [a, b] = wholeColumns(ca, cb);
        return { t: 'range', a, b, sheet };
      }
    }
    const a = parseCellRef(tok.text);
    if (!a) return null;
    if (toks[p]?.type === 'colon' && toks[p + 1]?.type === 'ident') {
      const b = parseCellRef(toks[p + 1].text);
      if (!b) return fail('That range is not written correctly.');
      p += 2;
      return { t: 'range', a, b: b!, sheet };
    }
    // A1# straight after the address: the spill range.
    if (toks[p]?.type === 'err' && toks[p].text === '#' && toks[p].start === tok.end) {
      p++;
      return { t: 'spill', ref: a, sheet };
    }
    return { t: 'ref', ref: a, sheet };
  }
  function primary(d: number): Node {
    const t = toks[p++];
    if (!t) return fail('The formula ends too early.');
    if (t.type === 'num') return { t: 'num', v: parseFloat(t.text) };
    if (t.type === 'str') return { t: 'str', v: t.text.slice(1, -1).replace(/""/g, '"') };
    if (t.type === 'err') {
      const known = Object.values(E).find(e => e.code === t.text.toUpperCase());
      return { t: 'err', e: known ?? E.NAME };
    }
    if (t.type === 'lp') {
      const inner = comparison(d + 1);
      if (toks[p++]?.type !== 'rp') fail('A closing bracket is missing.');
      return inner;
    }
    if (t.type === 'lb') {
      // Inside { }, a comma moves to the next column and a semicolon to the next row.
      const rows: Node[][] = [[]];
      for (;;) {
        rows[rows.length - 1].push(comparison(d + 1));
        const n = toks[p++];
        if (n?.type === 'rb') break;
        if (n?.type !== 'comma') fail('A list in { } needs a comma or semicolon between items, and a closing }.');
        if (n.text === ';') rows.push([]);
      }
      if (rows.some(r => r.length !== rows[0].length)) fail('Every row of a list in { } needs the same number of items.');
      return { t: 'array', rows };
    }
    if ((t.type === 'ident' || t.type === 'sheetq') && toks[p]?.type === 'bang' && toks[p + 1]?.type === 'ident') {
      const sheet = sheetNameOf(t);
      p += 2;
      const node = refAt(toks[p - 1], sheet);
      return node ?? fail('That is not a cell.');
    }
    if (t.type === 'ident') {
      if (toks[p]?.type === 'lp') {
        p++;
        const args: Node[] = [];
        if (toks[p]?.type === 'rp') p++;
        else {
          for (;;) {
            if (toks[p]?.type === 'comma' || toks[p]?.type === 'rp') args.push({ t: 'blank' });
            else args.push(comparison(d + 1));
            const n = toks[p++];
            if (n?.type === 'rp') break;
            if (n?.type !== 'comma') fail('A comma or closing bracket is missing.');
          }
        }
        return { t: 'call', name: t.text.toUpperCase(), args };
      }
      const upper = t.text.toUpperCase();
      if (upper === 'TRUE') return { t: 'bool', v: true };
      if (upper === 'FALSE') return { t: 'bool', v: false };
      const node = refAt(t);
      if (node) return node;
      return { t: 'err', e: E.NAME };
    }
    return fail(`The formula is not written correctly near "${t.text}".`);
  }

  const tree = comparison(0);
  if (p < toks.length) fail(`The formula is not written correctly near "${toks[p].text}".`);
  return tree;
}

// ---- Evaluating ----------------------------------------------------------------------------------------------------

export interface Context {
  /** The value of a cell (evaluating it first if it holds a formula). */
  cell(sheet: number, col: number, row: number): Value;
  /** Which sheet a name means, or -1. */
  sheetIndex(name: string): number;
  /** The sheet the formula lives on. */
  current: number;
  /**
   * How far the cells in use reach, so a big range stays cheap to read. `area` is the range being read: lists that
   * fill cells in it count too.
   */
  bounds(sheet: number, area?: { c0: number; r0: number; c1: number; r1: number }): { cols: number; rows: number };
  /** The list a formula cell fills (A1#): #REF! when the cell holds no list formula, #SPILL! when it cannot fill. */
  spill(sheet: number, col: number, row: number): Grid | CellError;
  /** Which way round typed dates are read (13/10/2026 or 10/13/2026). */
  dateOrder?: DateOrder;
}

/** How the formula being worked out reads dates in text ("13/10/2026"+1). */
let dateOrder: DateOrder = 'dmy';

/** Which arguments of a one-value function may be given a list, so the function runs once per value. */
const ALL = 'all';
const LIFT: Record<string, typeof ALL | number[]> = {
  TEXTBEFORE: [0, 2, 3, 4, 5], TEXTAFTER: [0, 2, 3, 4, 5],
  VLOOKUP: [0, 2], MATCH: [0, 2], XMATCH: [0], XLOOKUP: [0], INDEX: [1, 2],
  COUNTIF: [1], SUMIF: [1], AVERAGEIF: [1], NETWORKDAYS: [0, 1], WORKDAY: [0, 1],
};
for (const name of ['ABS', 'SIGN', 'INT', 'TRUNC', 'SQRT', 'EXP', 'LN', 'LOG10', 'POWER', 'MOD', 'ROUND', 'ROUNDUP', 'ROUNDDOWN',
  'IF', 'IFERROR', 'IFNA', 'IFS', 'SWITCH', 'CHOOSE', 'NOT', 'ISBLANK', 'ISNUMBER', 'ISTEXT', 'ISERROR', 'ISNA', 'ISERR', 'ISLOGICAL',
  'LEN', 'UPPER', 'LOWER', 'PROPER', 'TRIM', 'LEFT', 'RIGHT', 'MID', 'TEXT', 'FIND', 'SEARCH', 'SUBSTITUTE', 'REPLACE', 'CHAR',
  'CODE', 'UNICHAR', 'UNICODE', 'CLEAN', 'EXACT', 'REPT', 'VALUE', 'NUMBERVALUE',
  'DATE', 'TIME', 'YEAR', 'MONTH', 'DAY', 'HOUR', 'MINUTE', 'SECOND', 'WEEKDAY', 'WEEKNUM', 'ISOWEEKNUM', 'EDATE', 'EOMONTH',
  'DATEDIF', 'DAYS', 'DATEVALUE', 'TIMEVALUE']) LIFT[name] = ALL;

const liftsAt = (name: string, i: number): boolean => {
  const at = LIFT[name];
  return at === ALL || (!!at && at.includes(i));
};

const listCache = new WeakMap<Node, boolean>();

/** One value of a list as an operator sees it beside a list of another size: a single row or column is repeated. */
function pick(g: Grid, r: number, c: number): Value {
  const row = g.length === 1 ? g[0] : g[r];
  if (!row) return E.NA;
  const v = row.length === 1 ? row[0] : row[c];
  return v === undefined ? E.NA : v;
}

const first = (g: Grid | CellError): Value => (g instanceof CellError ? g : g[0]?.[0] ?? null);

class Ev {
  private steps = 0;
  ctx: Context;
  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  private sheetOf(name: string | undefined): number {
    return name === undefined ? this.ctx.current : this.ctx.sheetIndex(name);
  }

  range(n: { a: Ref; b: Ref; sheet?: string }): Grid | CellError {
    const s = this.sheetOf(n.sheet);
    if (s < 0) return E.REF;
    const c0 = Math.min(n.a.col, n.b.col);
    const c1 = Math.max(n.a.col, n.b.col);
    const r0 = Math.min(n.a.row, n.b.row);
    const r1 = Math.max(n.a.row, n.b.row);
    const limit = this.ctx.bounds(s, { c0, r0, c1, r1 });
    const grid: Grid = [];
    // Cells beyond the used area are empty, so stop there: "A:A"-sized ranges stay cheap.
    for (let r = r0; r <= r1; r++) {
      const row: Value[] = [];
      for (let c = c0; c <= c1; c++) {
        row.push(c < limit.cols && r < limit.rows ? this.cell(s, c, r) : null);
      }
      grid.push(row);
    }
    return grid;
  }

  private cell(s: number, c: number, r: number): Value {
    if (++this.steps > 2_000_000) return E.NUM;
    return this.ctx.cell(s, c, r);
  }

  /**
   * The value as a block of rows: a range, a list typed in { }, the list a function such as TEXTSPLIT gives back, or a
   * single value as a block of one.
   */
  block(n: Node, depth = 0): Grid | CellError {
    if (depth > MAX_DEPTH * 2) return E.NUM;
    switch (n.t) {
      case 'range': return this.range(n);
      case 'array': return n.rows.map(row => row.map(x => this.scalar(x, depth + 1)));
      case 'grid': return n.g;
      case 'spill': {
        const s = this.sheetOf(n.sheet);
        return s < 0 ? E.REF : this.ctx.spill(s, n.ref.col, n.ref.row);
      }
      case 'bin':
        if (Ev.isList(n)) {
          const l = this.block(n.l, depth + 1);
          if (l instanceof CellError) return l;
          const r = this.block(n.r, depth + 1);
          if (r instanceof CellError) return r;
          return zip(l, r, (a, b) => this.binary(n.op, a, b));
        }
        break;
      case 'un':
        if (Ev.isList(n.x)) {
          const g = this.block(n.x, depth + 1);
          return g instanceof CellError ? g : g.map(row => row.map(v => unary(n.op, v)));
        }
        break;
      case 'call': {
        const lifted = this.lift(n, depth);
        if (lifted) return lifted;
        if (LIST_FUNCTIONS[n.name]) return LIST_FUNCTIONS[n.name](this, n.args, depth);
        break;
      }
    }
    const v = this.scalar(n, depth);
    return v instanceof CellError ? v : [[v]];
  }

  /**
   * A one-value function given a list where it takes one value (LEN(A1:A5), IF(B2:B9>5,"big","small")): run once for
   * each value, giving a list. Null when no such argument is a list.
   */
  private lift(n: { name: string; args: Node[] }, depth: number): Grid | CellError | null {
    if (!LIFT[n.name] || !n.args.some((a, i) => liftsAt(n.name, i) && Ev.isList(a))) return null;
    const parts: Array<Grid | null> = [];
    let rows = 1;
    let cols = 1;
    for (const [i, a] of n.args.entries()) {
      if (liftsAt(n.name, i) && Ev.isList(a)) {
        // A list that is an error as a whole goes in as that error (IFNA(XLOOKUP(...),"none") gives "none").
        const found = this.block(a, depth + 1);
        const g = found instanceof CellError ? [[found]] : found;
        if (!g.length || !g[0].length) return E.CALC;
        parts.push(g);
        rows = Math.max(rows, g.length);
        cols = Math.max(cols, g[0].length);
      } else parts.push(null);
    }
    if (rows * cols > MAX_LIST) return E.NUM;
    // Other lists (a lookup table) are worked out once, not once for every value.
    const fixed = n.args.map((a, i): Node => {
      if (parts[i] || !Ev.isList(a)) return a;
      const g = this.block(a, depth + 1);
      return g instanceof CellError ? { t: 'err', e: g } : { t: 'grid', g };
    });
    const listFn = LIST_FUNCTIONS[n.name];
    const out: Grid = [];
    for (let r = 0; r < rows; r++) {
      const row: Value[] = [];
      for (let c = 0; c < cols; c++) {
        const args = fixed.map((a, i): Node => (parts[i] ? { t: 'val', v: pick(parts[i]!, r, c) } : a));
        row.push(listFn ? first(listFn(this, args, depth)) : callFunction(this, { name: n.name, args }, depth));
      }
      out.push(row);
    }
    return out;
  }

  /** True when the node gives a list of values rather than one (so a function takes all of it, as it takes a range). */
  static isList(n: Node): boolean {
    const known = listCache.get(n);
    if (known !== undefined) return known;
    let list: boolean;
    switch (n.t) {
      case 'range': case 'array': case 'grid': case 'spill': list = true; break;
      case 'bin': list = Ev.isList(n.l) || Ev.isList(n.r); break;
      case 'un': list = Ev.isList(n.x); break;
      case 'call': list = !!LIST_FUNCTIONS[n.name] || (!!LIFT[n.name] && n.args.some((a, i) => liftsAt(n.name, i) && Ev.isList(a))); break;
      default: list = false;
    }
    listCache.set(n, list);
    return list;
  }

  /** A single value; a range on its own is an error (there is no implicit "same row" rule here). */
  scalar(n: Node, depth = 0): Value {
    if (depth > MAX_DEPTH * 2) return E.NUM;
    switch (n.t) {
      // A list where one value is wanted: its first value.
      case 'array': case 'spill': return first(this.block(n, depth));
      case 'val': return n.v;
      case 'grid': return n.g[0]?.[0] ?? null;
      case 'num': return n.v;
      case 'str': return n.v;
      case 'bool': return n.v;
      case 'err': return n.e;
      case 'blank': return null;
      case 'ref': {
        const s = this.sheetOf(n.sheet);
        return s < 0 ? E.REF : this.cell(s, n.ref.col, n.ref.row);
      }
      case 'range': {
        const g = this.range(n);
        if (g instanceof CellError) return g;
        return g.length === 1 && g[0].length === 1 ? g[0][0] : E.VALUE;
      }
      case 'un':
        if (Ev.isList(n.x)) return first(this.block(n, depth));
        return unary(n.op, this.scalar(n.x, depth + 1));
      case 'bin':
        if (Ev.isList(n)) return first(this.block(n, depth));
        return this.binary(n.op, this.scalar(n.l, depth + 1), this.scalar(n.r, depth + 1));
      case 'call': {
        if (!Ev.isList(n)) return callFunction(this, n, depth);
        return first(this.block(n, depth));
      }
    }
  }

  binary(op: string, l: Value, r: Value): Value {
    if (l instanceof CellError) return l;
    if (r instanceof CellError) return r;
    if (op === '&') return text(l) + text(r);
    if (['=', '<>', '<', '>', '<=', '>='].includes(op)) return compare(op, l, r);
    const a = toNumber(l);
    if (a instanceof CellError) return a;
    const b = toNumber(r);
    if (b instanceof CellError) return b;
    switch (op) {
      case '+': return clean(a + b);
      case '-': return clean(a - b);
      case '*': return clean(a * b);
      case '/': return b === 0 ? E.DIV0 : clean(a / b);
      case '^': {
        const v = Math.pow(a, b);
        return Number.isFinite(v) ? clean(v) : E.NUM;
      }
    }
    return E.VALUE;
  }
}

function unary(op: '-' | '+' | '%', v: Value): Value {
  if (v instanceof CellError) return v;
  const num = toNumber(v);
  if (num instanceof CellError) return num;
  return op === '-' ? -num : op === '%' ? clean(num / 100) : num;
}

/** Two lists side by side, value by value; a single value, row or column is repeated to the other's size. */
function zip(l: Grid, r: Grid, f: (a: Value, b: Value) => Value): Grid | CellError {
  const rows = Math.max(l.length, r.length);
  const cols = Math.max(l[0]?.length ?? 0, r[0]?.length ?? 0);
  if (!rows || !cols) return E.CALC;
  if (rows * cols > MAX_LIST) return E.NUM;
  const out: Grid = [];
  for (let i = 0; i < rows; i++) {
    const row: Value[] = [];
    for (let j = 0; j < cols; j++) row.push(f(pick(l, i, j), pick(r, i, j)));
    out.push(row);
  }
  return out;
}

export function text(v: Value): string {
  if (v === null) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  // Every digit, as a spreadsheet joins a number into text (="Ref "&A1 with 123456789012 keeps all twelve).
  if (typeof v === 'number') return String(clean(v)).replace('e', 'E');
  if (v instanceof CellError) return v.code;
  return v;
}

export function toNumber(v: Value): number | CellError {
  if (v instanceof CellError) return v;
  if (v === null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const s = v.trim();
  if (s === '') return E.VALUE;
  const pct = /^(-?[\d.,]+)%$/.exec(s);
  const n = Number((pct ? pct[1] : s).replace(/,/g, ''));
  if (Number.isNaN(n) || !/^[-+]?[\d.,]+(e[-+]?\d+)?%?$/i.test(s)) {
    // Text that reads as a date or a time counts as one, as in Excel ("13/10/2026"+7).
    const d = readDateTime(s, dateOrder);
    return d ? d.serial : E.VALUE;
  }
  return pct ? n / 100 : n;
}

function toBool(v: Value): boolean | CellError {
  if (v instanceof CellError) return v;
  if (typeof v === 'boolean') return v;
  if (v === null) return false;
  if (typeof v === 'number') return v !== 0;
  const u = v.trim().toUpperCase();
  if (u === 'TRUE') return true;
  if (u === 'FALSE') return false;
  return E.VALUE;
}

function rank(v: Value): number {
  return typeof v === 'number' || v === null ? 0 : typeof v === 'string' ? 1 : 2;
}

function compare(op: string, l: Value, r: Value): boolean {
  // A blank cell is "" next to text, FALSE next to TRUE/FALSE, and 0 next to a number (so =A1="" is TRUE when A1 is empty).
  const blankAs = (other: Value): Value => (typeof other === 'string' ? '' : typeof other === 'boolean' ? false : 0);
  if (l === null && r !== null) l = blankAs(r);
  else if (r === null && l !== null) r = blankAs(l);
  let c: number;
  if (rank(l) !== rank(r)) c = rank(l) - rank(r);
  else if (typeof l === 'string' && typeof r === 'string') c = l.toLowerCase() < r.toLowerCase() ? -1 : l.toLowerCase() > r.toLowerCase() ? 1 : 0;
  else {
    const a = typeof l === 'boolean' ? Number(l) : (l as number | null) ?? 0;
    const b = typeof r === 'boolean' ? Number(r) : (r as number | null) ?? 0;
    c = clean(a) < clean(b) ? -1 : clean(a) > clean(b) ? 1 : 0;
  }
  switch (op) {
    case '=': return c === 0;
    case '<>': return c !== 0;
    case '<': return c < 0;
    case '>': return c > 0;
    case '<=': return c <= 0;
    default: return c >= 0;
  }
}

// ---- Functions -----------------------------------------------------------------------------------------------------

type Fn = (ev: Ev, args: Node[], depth: number) => Value;

/** Every value in the arguments, ranges flattened, remembering which came from a range. */
function collect(ev: Ev, args: Node[], depth: number): Array<{ v: Value; fromRange: boolean }> | CellError {
  const out: Array<{ v: Value; fromRange: boolean }> = [];
  for (const a of args) {
    // A list (a range, { }, TEXTSPLIT's pieces) is taken whole; its text is skipped by the sums, as a range's is.
    if (Ev.isList(a)) {
      const g = ev.block(a, depth + 1);
      if (g instanceof CellError) return g;
      for (const row of g) for (const v of row) out.push({ v, fromRange: true });
    } else if (a.t === 'ref') {
      out.push({ v: ev.scalar(a, depth + 1), fromRange: true });
    } else out.push({ v: ev.scalar(a, depth + 1), fromRange: false });
  }
  return out;
}

/** The numbers an aggregate function works on: text and blanks in ranges are skipped; errors stop it. */
function numbers(ev: Ev, args: Node[], depth: number): number[] | CellError {
  const all = collect(ev, args, depth);
  if (all instanceof CellError) return all;
  const out: number[] = [];
  for (const { v, fromRange } of all) {
    if (v instanceof CellError) return v;
    if (typeof v === 'number') out.push(v);
    else if (!fromRange && v !== null) {
      const n = toNumber(v);
      if (n instanceof CellError) return n;
      out.push(n);
    }
  }
  return out;
}

function num1(ev: Ev, args: Node[], i: number, depth: number, fallback?: number): number | CellError {
  if (args[i] === undefined) return fallback ?? E.VALUE;
  return toNumber(ev.scalar(args[i], depth + 1));
}

function grid(ev: Ev, n: Node | undefined, depth = 0): Grid | CellError {
  if (!n) return E.VALUE;
  if (Ev.isList(n)) return ev.block(n, depth + 1);
  return [[ev.scalar(n, depth + 1)]];
}

/** A SUMIF-style condition: 5, ">5", "<>x", "=abc", "a*" (with * and ? wildcards). */
function makeMatcher(criteria: Value): ((v: Value) => boolean) | CellError {
  if (criteria instanceof CellError) return criteria;
  let op = '=';
  let operand: Value = criteria;
  if (typeof criteria === 'string') {
    const m = /^(<=|>=|<>|<|>|=)?(.*)$/s.exec(criteria)!;
    op = m[1] ?? '=';
    const rest = m[2];
    const asNum = rest.trim() !== '' && !Number.isNaN(Number(rest)) ? Number(rest) : readDateTime(rest, dateOrder)?.serial ?? null;
    operand = asNum !== null ? asNum : rest;
  }
  // "<>" alone counts the cells that hold something; "=" or "" alone counts the empty ones.
  if (operand === '' && (op === '=' || op === '<>')) {
    return v => ((v === null || v === '') === (op === '='));
  }
  if (typeof operand === 'string') {
    const pattern = new RegExp('^' + operand.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'is');
    return v => {
      const hit = typeof v === 'string' && pattern.test(v);
      return op === '<>' ? !hit : op === '=' ? hit : typeof v === 'string' && compare(op, v, operand as string);
    };
  }
  return v => (typeof v === 'number' || typeof v === 'boolean' ? compare(op, v, operand) : op === '<>' && !(v instanceof CellError));
}

function conditional(ev: Ev, args: Node[], depth: number, kind: 'sum' | 'count' | 'avg'): Value {
  const range = grid(ev, args[0]);
  if (range instanceof CellError) return range;
  const crit = ev.scalar(args[1] ?? { t: 'str', v: '' }, depth + 1);
  const match = makeMatcher(crit);
  if (match instanceof CellError) return match;
  const target = kind === 'count' ? range : args[2] ? grid(ev, args[2]) : range;
  if (target instanceof CellError) return target;
  let total = 0;
  let count = 0;
  range.forEach((row, r) => row.forEach((v, c) => {
    if (!match(v)) return;
    const t = target[r]?.[c] ?? null;
    if (kind === 'count') count++;
    else if (typeof t === 'number') {
      total += t;
      count++;
    }
  }));
  if (kind === 'count') return count;
  if (kind === 'avg') return count ? clean(total / count) : E.DIV0;
  return clean(total);
}

function roundTo(x: number, d: number, mode: 'round' | 'up' | 'down'): number {
  const f = Math.pow(10, d);
  const abs = Math.abs(x);
  const scaled = Number(`${abs}e${d}`);
  const s = Number.isFinite(scaled) ? scaled : abs * f;
  const r = mode === 'round' ? Math.round(clean(s)) : mode === 'up' ? Math.ceil(clean(s)) : Math.floor(clean(s));
  const back = Number(`${r}e${-d}`);
  return clean(Math.sign(x) * (Number.isFinite(back) ? back : r / f));
}

function lookupTable(ev: Ev, args: Node[], depth: number): Grid | CellError {
  void depth;
  return grid(ev, args[1]);
}

const FUNCTIONS: Record<string, Fn> = {
  SUM: (ev, a, d) => { const n = numbers(ev, a, d); return n instanceof CellError ? n : clean(n.reduce((x, y) => x + y, 0)); },
  PRODUCT: (ev, a, d) => { const n = numbers(ev, a, d); return n instanceof CellError ? n : clean(n.reduce((x, y) => x * y, 1)); },
  AVERAGE: (ev, a, d) => { const n = numbers(ev, a, d); return n instanceof CellError ? n : n.length ? clean(n.reduce((x, y) => x + y, 0) / n.length) : E.DIV0; },
  // A loop, not Math.min(...n): spreading a range of hundreds of thousands of cells overflows the call stack.
  MIN: (ev, a, d) => { const n = numbers(ev, a, d); return n instanceof CellError ? n : n.length ? n.reduce((x, y) => (y < x ? y : x)) : 0; },
  MAX: (ev, a, d) => { const n = numbers(ev, a, d); return n instanceof CellError ? n : n.length ? n.reduce((x, y) => (y > x ? y : x)) : 0; },
  MEDIAN: (ev, a, d) => {
    const n = numbers(ev, a, d);
    if (n instanceof CellError) return n;
    if (!n.length) return E.NUM;
    n.sort((x, y) => x - y);
    const m = n.length >> 1;
    return n.length % 2 ? n[m] : clean((n[m - 1] + n[m]) / 2);
  },
  COUNT: (ev, a, d) => {
    const all = collect(ev, a, d);
    return all instanceof CellError ? all : all.filter(x => typeof x.v === 'number' || (!x.fromRange && x.v !== null && !(x.v instanceof CellError) && !(toNumber(x.v) instanceof CellError))).length;
  },
  COUNTA: (ev, a, d) => { const all = collect(ev, a, d); return all instanceof CellError ? all : all.filter(x => x.v !== null).length; },
  COUNTBLANK: (ev, a, d) => { const all = collect(ev, a, d); return all instanceof CellError ? all : all.filter(x => x.v === null || x.v === '').length; },
  ABS: (ev, a, d) => { const x = num1(ev, a, 0, d); return x instanceof CellError ? x : Math.abs(x); },
  SIGN: (ev, a, d) => { const x = num1(ev, a, 0, d); return x instanceof CellError ? x : Math.sign(x); },
  INT: (ev, a, d) => { const x = num1(ev, a, 0, d); return x instanceof CellError ? x : Math.floor(clean(x)); },
  TRUNC: (ev, a, d) => { const x = num1(ev, a, 0, d); return x instanceof CellError ? x : Math.trunc(clean(x)); },
  SQRT: (ev, a, d) => { const x = num1(ev, a, 0, d); return x instanceof CellError ? x : x < 0 ? E.NUM : clean(Math.sqrt(x)); },
  EXP: (ev, a, d) => { const x = num1(ev, a, 0, d); return x instanceof CellError ? x : clean(Math.exp(x)); },
  LN: (ev, a, d) => { const x = num1(ev, a, 0, d); return x instanceof CellError ? x : x <= 0 ? E.NUM : clean(Math.log(x)); },
  LOG10: (ev, a, d) => { const x = num1(ev, a, 0, d); return x instanceof CellError ? x : x <= 0 ? E.NUM : clean(Math.log10(x)); },
  PI: () => Math.PI,
  POWER: (ev, a, d) => {
    const x = num1(ev, a, 0, d);
    const y = num1(ev, a, 1, d);
    if (x instanceof CellError) return x;
    if (y instanceof CellError) return y;
    const v = Math.pow(x, y);
    return Number.isFinite(v) ? clean(v) : E.NUM;
  },
  MOD: (ev, a, d) => {
    const x = num1(ev, a, 0, d);
    const y = num1(ev, a, 1, d);
    if (x instanceof CellError) return x;
    if (y instanceof CellError) return y;
    return y === 0 ? E.DIV0 : clean(x - y * Math.floor(x / y));
  },
  ROUND: (ev, a, d) => { const x = num1(ev, a, 0, d); const n = num1(ev, a, 1, d, 0); return x instanceof CellError ? x : n instanceof CellError ? n : roundTo(x, Math.trunc(n), 'round'); },
  ROUNDUP: (ev, a, d) => { const x = num1(ev, a, 0, d); const n = num1(ev, a, 1, d, 0); return x instanceof CellError ? x : n instanceof CellError ? n : roundTo(x, Math.trunc(n), 'up'); },
  ROUNDDOWN: (ev, a, d) => { const x = num1(ev, a, 0, d); const n = num1(ev, a, 1, d, 0); return x instanceof CellError ? x : n instanceof CellError ? n : roundTo(x, Math.trunc(n), 'down'); },
  IF: (ev, a, d) => {
    if (a.length < 2) return E.VALUE;
    const c = toBool(ev.scalar(a[0], d + 1));
    if (c instanceof CellError) return c;
    if (c) return ev.scalar(a[1], d + 1);
    return a[2] ? ev.scalar(a[2], d + 1) : false;
  },
  IFERROR: (ev, a, d) => {
    const v = ev.scalar(a[0] ?? { t: 'str', v: '' }, d + 1);
    return v instanceof CellError ? ev.scalar(a[1] ?? { t: 'str', v: '' }, d + 1) : v;
  },
  AND: (ev, a, d) => { const all = collect(ev, a, d); if (all instanceof CellError) return all; let r = true; for (const { v } of all) { if (v === null || typeof v === 'string' && v === '') continue; const b = toBool(v); if (b instanceof CellError) return b; r = r && b; } return r; },
  OR: (ev, a, d) => { const all = collect(ev, a, d); if (all instanceof CellError) return all; let r = false; for (const { v } of all) { if (v === null || typeof v === 'string' && v === '') continue; const b = toBool(v); if (b instanceof CellError) return b; r = r || b; } return r; },
  NOT: (ev, a, d) => { const b = toBool(ev.scalar(a[0] ?? { t: 'bool', v: false }, d + 1)); return b instanceof CellError ? b : !b; },
  TRUE: () => true,
  FALSE: () => false,
  ISBLANK: (ev, a, d) => ev.scalar(a[0] ?? { t: 'str', v: 'x' }, d + 1) === null,
  ISNUMBER: (ev, a, d) => typeof ev.scalar(a[0] ?? { t: 'str', v: '' }, d + 1) === 'number',
  ISTEXT: (ev, a, d) => typeof ev.scalar(a[0] ?? { t: 'num', v: 0 }, d + 1) === 'string',
  ISERROR: (ev, a, d) => ev.scalar(a[0] ?? { t: 'num', v: 0 }, d + 1) instanceof CellError,
  SUMIF: (ev, a, d) => conditional(ev, a, d, 'sum'),
  COUNTIF: (ev, a, d) => conditional(ev, a, d, 'count'),
  AVERAGEIF: (ev, a, d) => conditional(ev, a, d, 'avg'),
  CONCATENATE: (ev, a, d) => { const all = collect(ev, a, d); return all instanceof CellError ? all : all.some(x => x.v instanceof CellError) ? (all.find(x => x.v instanceof CellError)!.v as CellError) : all.map(x => text(x.v)).join(''); },
  CONCAT: (ev, a, d) => FUNCTIONS.CONCATENATE(ev, a, d),
  LEN: (ev, a, d) => { const v = ev.scalar(a[0] ?? { t: 'str', v: '' }, d + 1); return v instanceof CellError ? v : text(v).length; },
  UPPER: (ev, a, d) => { const v = ev.scalar(a[0] ?? { t: 'str', v: '' }, d + 1); return v instanceof CellError ? v : text(v).toUpperCase(); },
  LOWER: (ev, a, d) => { const v = ev.scalar(a[0] ?? { t: 'str', v: '' }, d + 1); return v instanceof CellError ? v : text(v).toLowerCase(); },
  PROPER: (ev, a, d) => { const v = ev.scalar(a[0] ?? { t: 'str', v: '' }, d + 1); return v instanceof CellError ? v : text(v).toLowerCase().replace(/(^|[^a-z])([a-z])/g, (_, p, c) => p + c.toUpperCase()); },
  // Spaces only, as Excel's TRIM: line breaks and tabs in the text stay (CLEAN takes those out).
  TRIM: (ev, a, d) => { const v = ev.scalar(a[0] ?? { t: 'str', v: '' }, d + 1); return v instanceof CellError ? v : text(v).replace(/^ +| +$/g, '').replace(/ {2,}/g, ' '); },
  LEFT: (ev, a, d) => { const v = ev.scalar(a[0] ?? { t: 'str', v: '' }, d + 1); const n = num1(ev, a, 1, d, 1); return v instanceof CellError ? v : n instanceof CellError ? n : n < 0 ? E.VALUE : text(v).slice(0, n); },
  RIGHT: (ev, a, d) => { const v = ev.scalar(a[0] ?? { t: 'str', v: '' }, d + 1); const n = num1(ev, a, 1, d, 1); return v instanceof CellError ? v : n instanceof CellError ? n : n < 0 ? E.VALUE : n === 0 ? '' : text(v).slice(-n); },
  MID: (ev, a, d) => { const v = ev.scalar(a[0] ?? { t: 'str', v: '' }, d + 1); const s = num1(ev, a, 1, d); const n = num1(ev, a, 2, d); return v instanceof CellError ? v : s instanceof CellError ? s : n instanceof CellError ? n : s < 1 || n < 0 ? E.VALUE : text(v).slice(s - 1, s - 1 + n); },
  // Any Excel format code: TEXT(A1,"dd/mm/yyyy"), TEXT(A1,"000-000"), TEXT(A1,"#,##0.00").
  TEXT: (ev, a, d) => {
    const v = ev.scalar(a[0] ?? { t: 'num', v: 0 }, d + 1);
    const f = ev.scalar(a[1] ?? { t: 'str', v: '' }, d + 1);
    if (v instanceof CellError) return v;
    if (f instanceof CellError) return f;
    const code = text(f);
    if (typeof v === 'boolean') return text(v);
    const n = typeof v === 'string' ? toNumber(v) : (v ?? 0);
    if (code === '') return '';
    try {
      return capped(formatCode(n instanceof CellError ? (v as string) : n, code).text);
    } catch (error) {
      if (error instanceof CodeProblem) return E.VALUE;
      throw error;
    }
  },
  VLOOKUP: (ev, a, d) => {
    const key = ev.scalar(a[0] ?? { t: 'str', v: '' }, d + 1);
    const table = lookupTable(ev, a, d);
    const col = num1(ev, a, 2, d);
    const approx = a[3] ? toBool(ev.scalar(a[3], d + 1)) : true;
    if (key instanceof CellError) return key;
    if (table instanceof CellError) return table;
    if (col instanceof CellError) return col;
    if (approx instanceof CellError) return approx;
    if (col < 1 || col > (table[0]?.length ?? 0)) return E.REF;
    let best = -1;
    for (let r = 0; r < table.length; r++) {
      const cell = table[r][0];
      if (approx) {
        if (cell !== null && rank(cell) === rank(key) && compare('<=', cell, key)) best = r;
        else if (cell !== null && rank(cell) === rank(key)) break;
      } else if (cell !== null && rank(cell) === rank(key) && compare('=', cell, key)) {
        best = r;
        break;
      }
    }
    return best < 0 ? E.NA : table[best][col - 1];
  },
  INDEX: (ev, a, d) => {
    const g = grid(ev, a[0]);
    const r = num1(ev, a, 1, d, 1);
    const c = num1(ev, a, 2, d, 1);
    if (g instanceof CellError) return g;
    if (r instanceof CellError) return r;
    if (c instanceof CellError) return c;
    const row = g.length === 1 && g[0].length > 1 && !a[2] ? 1 : r;
    const col = g.length === 1 && g[0].length > 1 && !a[2] ? r : c;
    if (row < 1 || col < 1 || row > g.length || col > g[0].length) return E.REF;
    return g[row - 1][col - 1];
  },
  MATCH: (ev, a, d) => {
    const key = ev.scalar(a[0] ?? { t: 'str', v: '' }, d + 1);
    const g = grid(ev, a[1]);
    const type = num1(ev, a, 2, d, 1);
    if (key instanceof CellError) return key;
    if (g instanceof CellError) return g;
    if (type instanceof CellError) return type;
    const flat = g.flat();
    let best = -1;
    for (let i = 0; i < flat.length; i++) {
      const v = flat[i];
      if (v === null || rank(v) !== rank(key)) continue;
      if (type === 0) {
        if (compare('=', v, key)) return i + 1;
      } else if (type > 0 ? compare('<=', v, key) : compare('>=', v, key)) best = i;
      else break;
    }
    return best < 0 ? E.NA : best + 1;
  },
};

// ---- Text and lookup functions (Excel 365's, with its rules) -------------------------------------------------------

/** The longest text a cell can hold, as in Excel: a longer result is #VALUE!. */
const MAX_RESULT = 32767;
const capped = (s: string): Value => (s.length > MAX_RESULT ? E.VALUE : s);

/** An argument as text (a missing one is `fallback`, or #VALUE! when there is none). */
function str(ev: Ev, a: Node[], i: number, d: number, fallback?: string): string | CellError {
  const n = a[i];
  if (n === undefined || n.t === 'blank') return fallback ?? (n ? '' : E.VALUE);
  const v = ev.scalar(n, d + 1);
  return v instanceof CellError ? v : text(v);
}

/** An optional whole-number argument; an empty one (",,") counts as missing. */
function int(ev: Ev, a: Node[], i: number, d: number, fallback: number): number | CellError {
  const n = a[i];
  if (n === undefined || n.t === 'blank') return fallback;
  const v = toNumber(ev.scalar(n, d + 1));
  return v instanceof CellError ? v : Math.trunc(v);
}

/** Every value of an argument that may be a list, as text (TEXTSPLIT's delimiters, {",",";"}). */
function texts(ev: Ev, n: Node | undefined, d: number): string[] | CellError {
  if (n === undefined || n.t === 'blank') return [];
  const g = grid(ev, n, d);
  if (g instanceof CellError) return g;
  const out: string[] = [];
  for (const row of g) for (const v of row) {
    if (v instanceof CellError) return v;
    out.push(text(v));
  }
  return out;
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A SEARCH / XLOOKUP pattern: * any run, ? one character, ~ before either (or ~) means the character itself. */
function wildcard(pattern: string): string {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '~' && i + 1 < pattern.length && '*?~'.includes(pattern[i + 1])) out += escapeRegex(pattern[++i]);
    else if (c === '*') out += '[\\s\\S]*';
    else if (c === '?') out += '[\\s\\S]';
    else out += escapeRegex(c);
  }
  return out;
}

/** Where each delimiter is found, left to right, never overlapping: [start, end] pairs. */
function delimiterHits(s: string, delims: string[], caseless: boolean): Array<[number, number]> {
  const hay = caseless ? s.toLowerCase() : s;
  const needles = delims.filter(x => x !== '').map(x => (caseless ? x.toLowerCase() : x)).sort((x, y) => y.length - x.length);
  const hits: Array<[number, number]> = [];
  if (!needles.length) return hits;
  for (let i = 0; i < hay.length;) {
    const found = needles.find(n => hay.startsWith(n, i));
    if (found) {
      hits.push([i, i + found.length]);
      i += found.length;
    } else i++;
  }
  return hits;
}

function splitAt(s: string, delims: string[], caseless: boolean): string[] {
  const out: string[] = [];
  let from = 0;
  for (const [start, end] of delimiterHits(s, delims, caseless)) {
    out.push(s.slice(from, start));
    from = end;
  }
  out.push(s.slice(from));
  return out;
}

/** TEXTBEFORE and TEXTAFTER: the text before (or after) the nth delimiter; a negative n counts from the end. */
function textAround(ev: Ev, a: Node[], d: number, after: boolean): Value {
  const s = str(ev, a, 0, d);
  if (s instanceof CellError) return s;
  const delims = texts(ev, a[1], d);
  if (delims instanceof CellError) return delims;
  const n = int(ev, a, 2, d, 1);
  const mode = int(ev, a, 3, d, 0);
  const matchEnd = int(ev, a, 4, d, 0);
  if (n instanceof CellError) return n;
  if (mode instanceof CellError) return mode;
  if (matchEnd instanceof CellError) return matchEnd;
  if (a[1] === undefined || (mode !== 0 && mode !== 1) || (matchEnd !== 0 && matchEnd !== 1)) return E.VALUE;
  if (s === '') return '';
  if (n === 0 || Math.abs(n) > s.length) return E.VALUE;
  const notFound = (): Value => (a[5] === undefined || a[5].t === 'blank' ? E.NA : ev.scalar(a[5], d + 1));
  // An empty delimiter matches at once: at the start, or at the end when counting from the end.
  if (!delims.length || delims.includes('')) return n > 0 ? (after ? s : '') : after ? '' : s;
  const hits = delimiterHits(s, delims, mode === 1);
  if (matchEnd === 1) {
    if (n > 0) hits.push([s.length, s.length]);
    else hits.unshift([0, 0]);
  }
  const hit = n > 0 ? hits[n - 1] : hits[hits.length + n];
  if (!hit) return notFound();
  return after ? s.slice(hit[1]) : s.slice(0, hit[0]);
}

/** FIND (case matters, no wildcards) and SEARCH (case ignored, * ? ~ wildcards): 1-based position, or #VALUE!. */
function findText(ev: Ev, a: Node[], d: number, search: boolean): Value {
  const needle = str(ev, a, 0, d);
  const hay = str(ev, a, 1, d);
  const start = int(ev, a, 2, d, 1);
  if (needle instanceof CellError) return needle;
  if (hay instanceof CellError) return hay;
  if (start instanceof CellError) return start;
  if (start < 1 || start > hay.length + (needle === '' ? 1 : 0)) return E.VALUE;
  if (needle === '') return start;
  if (!search) {
    const at = hay.indexOf(needle, start - 1);
    return at < 0 ? E.VALUE : at + 1;
  }
  const m = new RegExp(wildcard(needle), 'i').exec(hay.slice(start - 1));
  return m ? m.index + start : E.VALUE;
}

// CHAR and CODE use the Windows character set, as Excel on Windows does: CHAR(128) is €, CHAR(150) an en dash.
const CP1252 = [0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178];

/** A number typed as text, the way VALUE reads it: spaces, a $ sign, thousands commas, a %, (brackets) for minus. */
function readNumber(raw: string, dec = '.', group = ','): number | CellError {
  let s = raw.replace(/[\s ]+/g, '');
  if (s === '') return 0;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) {
    sign = -1;
    s = s.slice(1, -1);
  }
  let pct = 0;
  while (s.endsWith('%')) {
    pct++;
    s = s.slice(0, -1);
  }
  s = s.replace(/^([-+]?)\$/, '$1');
  if (group) s = s.split(group).join('');
  if (dec !== '.') {
    if (s.includes('.')) return E.VALUE;
    s = s.split(dec).join('.');
  }
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return E.VALUE;
  return clean((sign * Number(s)) / Math.pow(100, pct));
}

/** Where key is found in a one-row or one-column list (XLOOKUP / XMATCH rules), as a 0-based index, or -1. */
function seek(list: Value[], key: Value, mode: number, search: number): number {
  const order = search === -1 || search === -2 ? list.map((_, i) => list.length - 1 - i) : list.map((_, i) => i);
  let same: (v: Value) => boolean;
  if (key === null) same = v => v === null || v === '';
  else if (mode === 2 && typeof key === 'string') {
    const rx = new RegExp(`^${wildcard(key)}$`, 'i');
    same = v => typeof v === 'string' && rx.test(v);
  } else same = v => v !== null && rank(v) === rank(key) && compare('=', v, key);
  for (const i of order) if (same(list[i])) return i;
  if (mode !== -1 && mode !== 1) return -1;
  // No exact match: the next smaller (-1) or next larger (1) value of the same kind.
  let best = -1;
  for (const i of order) {
    const v = list[i];
    if (v === null || key === null || rank(v) !== rank(key)) continue;
    if (mode === -1 ? !compare('<', v, key) : !compare('>', v, key)) continue;
    if (best < 0 || (mode === -1 ? compare('>', v, list[best]) : compare('<', v, list[best]))) best = i;
  }
  return best;
}

/** XLOOKUP / XMATCH's arguments read and checked: the list as one line, which way it runs, and the two modes. */
function lookupLine(ev: Ev, a: Node[], d: number, modeAt: number): { key: Value; look: Grid; line: Value[]; down: boolean; mode: number; search: number } | CellError {
  if (a.length < 2) return E.VALUE;
  const key = a[0].t === 'blank' ? null : ev.scalar(a[0], d + 1);
  if (key instanceof CellError) return key;
  const look = grid(ev, a[1], d);
  if (look instanceof CellError) return look;
  const mode = int(ev, a, modeAt, d, 0);
  const search = int(ev, a, modeAt + 1, d, 1);
  if (mode instanceof CellError) return mode;
  if (search instanceof CellError) return search;
  if (![-1, 0, 1, 2].includes(mode) || ![-2, -1, 1, 2].includes(search)) return E.VALUE;
  const down = look[0].length === 1;
  if (!down && look.length !== 1) return E.VALUE;
  const line = down ? look.map(r => r[0]) : look[0];
  return { key, look, line, down, mode, search };
}

/** Functions that give back a list (several cells' worth). In a cell on their own they show their first value. */
const LIST_FUNCTIONS: Record<string, (ev: Ev, args: Node[], depth: number) => Grid | CellError> = {
  TEXTSPLIT: (ev, a, d) => {
    const s = str(ev, a, 0, d);
    if (s instanceof CellError) return s;
    const cols = texts(ev, a[1], d);
    const rows = texts(ev, a[2], d);
    if (cols instanceof CellError) return cols;
    if (rows instanceof CellError) return rows;
    const ignore = a[3] === undefined || a[3].t === 'blank' ? false : toBool(ev.scalar(a[3], d + 1));
    const mode = int(ev, a, 4, d, 0);
    if (ignore instanceof CellError) return ignore;
    if (mode instanceof CellError) return mode;
    if (mode !== 0 && mode !== 1) return E.VALUE;
    const pad: Value = a[5] === undefined || a[5].t === 'blank' ? E.NA : ev.scalar(a[5], d + 1);
    if (s === '' || (!cols.some(x => x !== '') && !rows.some(x => x !== ''))) return E.VALUE;
    let lines = rows.some(x => x !== '') ? splitAt(s, rows, mode === 1) : [s];
    if (ignore) lines = lines.filter(x => x !== '');
    const table = lines.map(line => {
      const parts = cols.some(x => x !== '') ? splitAt(line, cols, mode === 1) : [line];
      return ignore ? parts.filter(x => x !== '') : parts;
    }).filter(r => r.length);
    if (!table.length) return E.CALC;
    const width = Math.max(...table.map(r => r.length));
    return table.map(r => [...r, ...Array<Value>(width - r.length).fill(pad)]);
  },
  XLOOKUP: (ev, a, d) => {
    const l = lookupLine(ev, a, d, 4);
    if (l instanceof CellError) return l;
    const ret = grid(ev, a[2], d);
    if (ret instanceof CellError) return ret;
    if (l.down ? ret.length !== l.line.length : ret[0].length !== l.line.length) return E.VALUE;
    const i = seek(l.line, l.key, l.mode, l.search);
    if (i < 0) {
      if (a[3] === undefined || a[3].t === 'blank') return E.NA;
      return grid(ev, a[3], d);
    }
    return l.down ? [ret[i]] : ret.map(r => [r[i]]);
  },
  // Rows (or columns) of a list where `include` is TRUE: FILTER(A2:C99, B2:B99="Paid"), FILTER(A2:C99, (B2:B99>5)*(C2:C99<9)).
  FILTER: (ev, a, d) => {
    const arr = grid(ev, a[0], d);
    if (arr instanceof CellError) return arr;
    const inc = grid(ev, a[1], d);
    if (inc instanceof CellError) return inc;
    const rows = arr.length;
    const cols = arr[0]?.length ?? 0;
    let byRow: boolean;
    if (inc[0].length === 1 && inc.length === rows) byRow = true;
    else if (inc.length === 1 && inc[0].length === cols) byRow = false;
    else return E.VALUE;
    const keep: boolean[] = [];
    for (const v of byRow ? inc.map(r => r[0]) : inc[0]) {
      if (v instanceof CellError) return v;
      if (typeof v === 'string') return E.VALUE;
      keep.push(v === true || (typeof v === 'number' && v !== 0));
    }
    const out = byRow ? arr.filter((_, i) => keep[i]) : arr.map(r => r.filter((_, j) => keep[j]));
    if (!out.length || !out[0].length) {
      if (a[2] === undefined || a[2].t === 'blank') return E.CALC;
      return grid(ev, a[2], d);
    }
    return out;
  },
  // SORT(list, [by which column], [1 smallest first / -1 largest first], [sort columns instead of rows]).
  SORT: (ev, a, d) => {
    const arr = grid(ev, a[0], d);
    if (arr instanceof CellError) return arr;
    const byCol = a[3] === undefined || a[3].t === 'blank' ? false : toBool(ev.scalar(a[3], d + 1));
    if (byCol instanceof CellError) return byCol;
    const lines = byCol ? transpose(arr) : arr;
    const width = lines[0]?.length ?? 0;
    const idx = numberList(ev, a[1], d, [1]);
    const ord = numberList(ev, a[2], d, [1]);
    if (idx instanceof CellError) return idx;
    if (ord instanceof CellError) return ord;
    const keys: Array<{ at: number; desc: boolean }> = [];
    for (let i = 0; i < idx.length; i++) {
      const at = Math.trunc(idx[i]);
      const o = ord[i] ?? ord[0];
      if (at < 1 || at > width || (o !== 1 && o !== -1)) return E.VALUE;
      keys.push({ at: at - 1, desc: o === -1 });
    }
    const sorted = sortLines(lines, line => keys.map(k => ({ v: line[k.at], desc: k.desc })));
    return byCol ? transpose(sorted) : sorted;
  },
  // SORTBY(list, by_list1, [order1], by_list2, [order2], ...): sorted by other columns that need not be shown.
  SORTBY: (ev, a, d) => {
    const arr = grid(ev, a[0], d);
    if (arr instanceof CellError) return arr;
    if (a.length < 2) return E.VALUE;
    const bys: Array<{ line: Value[]; desc: boolean }> = [];
    let byCol: boolean | null = null;
    for (let i = 1; i < a.length; i += 2) {
      const g = grid(ev, a[i], d);
      if (g instanceof CellError) return g;
      const o = a[i + 1] === undefined || a[i + 1].t === 'blank' ? 1 : toNumber(ev.scalar(a[i + 1], d + 1));
      if (o instanceof CellError) return o;
      if (o !== 1 && o !== -1) return E.VALUE;
      const col = g[0].length === 1 && g.length === arr.length && (arr.length > 1 || g.length === 1);
      const row = g.length === 1 && g[0].length === (arr[0]?.length ?? 0);
      const asCol = col ? false : row ? true : null;
      if (asCol === null || (byCol !== null && byCol !== asCol)) return E.VALUE;
      byCol = asCol;
      bys.push({ line: asCol ? g[0] : g.map(r => r[0]), desc: o === -1 });
    }
    const lines = byCol ? transpose(arr) : arr;
    const order = lines.map((_, i) => i);
    const sortedIdx = sortLines(order.map(i => [i]), line => bys.map(b => ({ v: b.line[line[0] as number], desc: b.desc })));
    const sorted = sortedIdx.map(r => lines[r[0] as number]);
    return byCol ? transpose(sorted) : sorted;
  },
  // UNIQUE(list, [compare columns], [only the ones that appear once]). Text is compared without case, as in Excel.
  UNIQUE: (ev, a, d) => {
    const arr = grid(ev, a[0], d);
    if (arr instanceof CellError) return arr;
    const byCol = a[1] === undefined || a[1].t === 'blank' ? false : toBool(ev.scalar(a[1], d + 1));
    const once = a[2] === undefined || a[2].t === 'blank' ? false : toBool(ev.scalar(a[2], d + 1));
    if (byCol instanceof CellError) return byCol;
    if (once instanceof CellError) return once;
    const lines = byCol ? transpose(arr) : arr;
    const seen = new Map<string, { line: Value[]; count: number }>();
    for (const line of lines) {
      const key = line.map(v => (v === null ? 'b' : v instanceof CellError ? `e${v.code}` : typeof v === 'string' ? `s${v.toLowerCase()}` : typeof v === 'boolean' ? `l${v}` : `n${clean(v)}`)).join('\u0000');
      const hit = seen.get(key);
      if (hit) hit.count++;
      else seen.set(key, { line, count: 1 });
    }
    const out = [...seen.values()].filter(x => !once || x.count === 1).map(x => x.line);
    if (!out.length) return E.CALC;
    return byCol ? transpose(out) : out;
  },
  // SEQUENCE(rows, [columns], [start], [step]): 1, 2, 3...
  SEQUENCE: (ev, a, d) => {
    const rows = int(ev, a, 0, d, NaN);
    const cols = int(ev, a, 1, d, 1);
    const start = num1(ev, a[2]?.t === 'blank' ? [] : a, 2, d, 1);
    const step = num1(ev, a[3]?.t === 'blank' ? [] : a, 3, d, 1);
    if (rows instanceof CellError) return rows;
    if (cols instanceof CellError) return cols;
    if (start instanceof CellError) return start;
    if (step instanceof CellError) return step;
    if (!(rows >= 1) || !(cols >= 1)) return rows === 0 || cols === 0 ? E.CALC : E.VALUE;
    if (rows * cols > MAX_LIST) return E.NUM;
    const out: Grid = [];
    for (let r = 0; r < rows; r++) {
      const row: Value[] = [];
      for (let c = 0; c < cols; c++) row.push(clean(start + step * (r * cols + c)));
      out.push(row);
    }
    return out;
  },
  TRANSPOSE: (ev, a, d) => {
    const arr = grid(ev, a[0], d);
    return arr instanceof CellError ? arr : transpose(arr);
  },
};

function transpose(g: Grid): Grid {
  const cols = g[0]?.length ?? 0;
  const out: Grid = [];
  for (let c = 0; c < cols; c++) out.push(g.map(row => row[c] ?? null));
  return out;
}

/** An argument that may be one number or a list of them ({1,3}); `fallback` when it is left out. */
function numberList(ev: Ev, n: Node | undefined, d: number, fallback: number[]): number[] | CellError {
  if (n === undefined || n.t === 'blank') return fallback;
  const g = grid(ev, n, d);
  if (g instanceof CellError) return g;
  const out: number[] = [];
  for (const row of g) for (const v of row) {
    const x = toNumber(v);
    if (x instanceof CellError) return x;
    out.push(x);
  }
  return out.length ? out : fallback;
}

/**
 * Sorts rows by keys, as Excel's SORT does: numbers, then text (case ignored), then TRUE/FALSE, then errors; largest
 * first turns that round; empty cells always go last. Rows with equal keys keep their order.
 */
function sortLines(lines: Grid, keysOf: (line: Value[]) => Array<{ v: Value; desc: boolean }>): Grid {
  const kind = (v: Value) => (typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : typeof v === 'boolean' ? 2 : 3);
  const keyed = lines.map((line, i) => ({ line, i, keys: keysOf(line) }));
  keyed.sort((x, y) => {
    for (let k = 0; k < x.keys.length; k++) {
      const a = x.keys[k].v ?? null;
      const b = y.keys[k].v ?? null;
      const desc = x.keys[k].desc;
      if (a === null || b === null) {
        if (a === null && b === null) continue;
        return a === null ? 1 : -1;
      }
      let c = kind(a) - kind(b);
      if (!c) {
        if (typeof a === 'number' && typeof b === 'number') c = a - b;
        else if (typeof a === 'string' && typeof b === 'string') c = a.localeCompare(b, undefined, { sensitivity: 'base' });
        else if (typeof a === 'boolean' && typeof b === 'boolean') c = Number(a) - Number(b);
      }
      if (c) return desc ? -c : c;
    }
    return x.i - y.i;
  });
  return keyed.map(k => k.line);
}

const TEXT_FUNCTIONS: Record<string, Fn> = {
  TEXTBEFORE: (ev, a, d) => textAround(ev, a, d, false),
  TEXTAFTER: (ev, a, d) => textAround(ev, a, d, true),
  FIND: (ev, a, d) => findText(ev, a, d, false),
  SEARCH: (ev, a, d) => findText(ev, a, d, true),
  SUBSTITUTE: (ev, a, d) => {
    const s = str(ev, a, 0, d);
    const from = str(ev, a, 1, d);
    const to = str(ev, a, 2, d);
    const n = int(ev, a, 3, d, 0);
    if (s instanceof CellError) return s;
    if (from instanceof CellError) return from;
    if (to instanceof CellError) return to;
    if (n instanceof CellError) return n;
    if (a[3] !== undefined && a[3].t !== 'blank' && n < 1) return E.VALUE;
    if (from === '') return s;
    if (n === 0) return capped(s.split(from).join(to));
    // Only the nth time it appears (counted left to right, not overlapping).
    let at = -from.length;
    for (let k = 0; k < n; k++) {
      at = s.indexOf(from, at + from.length);
      if (at < 0) return s;
    }
    return capped(s.slice(0, at) + to + s.slice(at + from.length));
  },
  REPLACE: (ev, a, d) => {
    const s = str(ev, a, 0, d);
    const start = int(ev, a, 1, d, NaN);
    const count = int(ev, a, 2, d, NaN);
    const put = str(ev, a, 3, d);
    if (s instanceof CellError) return s;
    if (start instanceof CellError) return start;
    if (count instanceof CellError) return count;
    if (put instanceof CellError) return put;
    if (!(start >= 1) || !(count >= 0)) return E.VALUE;
    return capped(s.slice(0, start - 1) + put + s.slice(start - 1 + count));
  },
  CHAR: (ev, a, d) => {
    const n = int(ev, a, 0, d, NaN);
    if (n instanceof CellError) return n;
    if (!(n >= 1 && n <= 255)) return E.VALUE;
    return String.fromCharCode(n >= 128 && n < 160 ? CP1252[n - 128] : n);
  },
  CODE: (ev, a, d) => {
    const s = str(ev, a, 0, d);
    if (s instanceof CellError) return s;
    if (s === '') return E.VALUE;
    const c = s.charCodeAt(0);
    const win = CP1252.indexOf(c);
    if (win >= 0) return 128 + win;
    // A character the Windows set does not have reads as "?", as in Excel.
    return c < 128 || (c >= 160 && c < 256) ? c : 63;
  },
  UNICHAR: (ev, a, d) => {
    const n = int(ev, a, 0, d, NaN);
    if (n instanceof CellError) return n;
    if (!(n >= 1 && n <= 0x10ffff) || (n >= 0xd800 && n <= 0xdfff)) return E.VALUE;
    return String.fromCodePoint(n);
  },
  UNICODE: (ev, a, d) => {
    const s = str(ev, a, 0, d);
    if (s instanceof CellError) return s;
    return s === '' ? E.VALUE : s.codePointAt(0)!;
  },
  CLEAN: (ev, a, d) => { const s = str(ev, a, 0, d); return s instanceof CellError ? s : s.replace(/[\x00-\x1f]/g, ''); },
  EXACT: (ev, a, d) => {
    const x = str(ev, a, 0, d);
    const y = str(ev, a, 1, d);
    if (x instanceof CellError) return x;
    if (y instanceof CellError) return y;
    return x === y;
  },
  REPT: (ev, a, d) => {
    const s = str(ev, a, 0, d);
    const n = int(ev, a, 1, d, NaN);
    if (s instanceof CellError) return s;
    if (n instanceof CellError) return n;
    if (!(n >= 0) || s.length * n > MAX_RESULT) return E.VALUE;
    return s.repeat(n);
  },
  TEXTJOIN: (ev, a, d) => {
    if (a.length < 3) return E.VALUE;
    const seps = texts(ev, a[0], d);
    if (seps instanceof CellError) return seps;
    const ignore = a[1].t === 'blank' ? false : toBool(ev.scalar(a[1], d + 1));
    if (ignore instanceof CellError) return ignore;
    const all = collect(ev, a.slice(2), d);
    if (all instanceof CellError) return all;
    const parts: string[] = [];
    for (const { v } of all) {
      if (v instanceof CellError) return v;
      const t = text(v);
      if (ignore && t === '') continue;
      parts.push(t);
    }
    // Several delimiters are used in turn.
    let out = '';
    parts.forEach((p, i) => {
      out += (i && seps.length ? seps[(i - 1) % seps.length] : '') + p;
    });
    return capped(out);
  },
  VALUE: (ev, a, d) => {
    const v = ev.scalar(a[0] ?? { t: 'blank' }, d + 1);
    if (v instanceof CellError || typeof v === 'number') return v;
    if (typeof v === 'boolean') return E.VALUE;
    const n = readNumber(v ?? '');
    // Text that is a date or a time gives its number of days, as in Excel (VALUE("13/10/2026") is 46308).
    if (n instanceof CellError && v) return readDateTime(v, dateOrder)?.serial ?? n;
    return n;
  },
  NUMBERVALUE: (ev, a, d) => {
    const s = str(ev, a, 0, d);
    const dec = str(ev, a, 1, d, '.');
    const group = str(ev, a, 2, d, ',');
    if (s instanceof CellError) return s;
    if (dec instanceof CellError) return dec;
    if (group instanceof CellError) return group;
    if (dec === '' || dec[0] === group[0]) return E.VALUE;
    return readNumber(s, dec[0], group[0] ?? '');
  },
  XMATCH: (ev, a, d) => {
    const l = lookupLine(ev, a, d, 2);
    if (l instanceof CellError) return l;
    const i = seek(l.line, l.key, l.mode, l.search);
    return i < 0 ? E.NA : i + 1;
  },
  IFS: (ev, a, d) => {
    if (a.length < 2 || a.length % 2) return E.VALUE;
    for (let i = 0; i < a.length; i += 2) {
      const c = toBool(ev.scalar(a[i], d + 1));
      if (c instanceof CellError) return c;
      if (c) return ev.scalar(a[i + 1], d + 1);
    }
    return E.NA;
  },
  SWITCH: (ev, a, d) => {
    if (a.length < 3) return E.VALUE;
    const x = ev.scalar(a[0], d + 1);
    if (x instanceof CellError) return x;
    let i = 1;
    for (; i + 1 < a.length; i += 2) {
      const v = ev.scalar(a[i], d + 1);
      if (v instanceof CellError) return v;
      const blankX = x === null ? 0 : x;
      const blankV = v === null ? 0 : v;
      if (rank(blankV) === rank(blankX) && compare('=', blankV, blankX)) return ev.scalar(a[i + 1], d + 1);
    }
    return i < a.length ? ev.scalar(a[i], d + 1) : E.NA;
  },
  IFNA: (ev, a, d) => {
    const v = ev.scalar(a[0] ?? { t: 'blank' }, d + 1);
    return v instanceof CellError && v.code === E.NA.code ? ev.scalar(a[1] ?? { t: 'str', v: '' }, d + 1) : v;
  },
  ISNA: (ev, a, d) => { const v = ev.scalar(a[0] ?? { t: 'num', v: 0 }, d + 1); return v instanceof CellError && v.code === E.NA.code; },
  ISERR: (ev, a, d) => { const v = ev.scalar(a[0] ?? { t: 'num', v: 0 }, d + 1); return v instanceof CellError && v.code !== E.NA.code; },
  ISLOGICAL: (ev, a, d) => typeof ev.scalar(a[0] ?? { t: 'num', v: 0 }, d + 1) === 'boolean',
  CHOOSE: (ev, a, d) => {
    const i = int(ev, a, 0, d, NaN);
    if (i instanceof CellError) return i;
    if (!(i >= 1 && i < a.length)) return E.VALUE;
    return ev.scalar(a[i], d + 1);
  },
  ROWS: (ev, a, d) => { const g = grid(ev, a[0], d); return g instanceof CellError ? g : g.length; },
  COLUMNS: (ev, a, d) => { const g = grid(ev, a[0], d); return g instanceof CellError ? g : g[0]?.length ?? 0; },
};
Object.assign(FUNCTIONS, TEXT_FUNCTIONS);

// ---- SUMPRODUCT, dates and times ------------------------------------------------------------------------------------

/** A date argument as a serial: a number, or text that reads as a date. Negative is #NUM!, as in Excel. */
function serialArg(ev: Ev, a: Node[], i: number, d: number, fallback?: number): number | CellError {
  const n = num1(ev, a[i]?.t === 'blank' ? [] : a, i, d, fallback);
  if (n instanceof CellError) return n;
  return n < 0 || n > 2_958_465.99999 ? E.NUM : n;
}

const dayOf = (n: number): number => Math.floor(n);
/** Seconds into the day, to the nearest second (so 0.999999 is the next day's 0:00:00). */
const secondsOf = (n: number): number => Math.round((n - Math.floor(n)) * 86400) % 86400;

/** The same day `months` later (or the month's last day when it has fewer). */
function addMonths(serial: number, months: number): number {
  const p = partsOf(serial);
  const total = p.y * 12 + (p.m - 1) + months;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  if (y < 1900 || y > 9999) return NaN;
  return serialOf(y, m, 1) + Math.min(p.d, daysInMonth(y, m)) - 1;
}

/** Holidays for WORKDAY and NETWORKDAYS, as whole days. */
function holidays(ev: Ev, n: Node | undefined, d: number): Set<number> | CellError {
  const out = new Set<number>();
  if (n === undefined || n.t === 'blank') return out;
  const g = grid(ev, n, d);
  if (g instanceof CellError) return g;
  for (const row of g) for (const v of row) {
    if (v === null) continue;
    const x = toNumber(v);
    if (x instanceof CellError) return x;
    out.add(Math.floor(x));
  }
  return out;
}

const weekend = (serial: number): boolean => {
  const wd = partsOf(serial).wd;
  return wd === 0 || wd === 6;
};

/** The weekday of a serial with WEEKDAY's return types (1: Sunday is 1, 2: Monday is 1, 3: Monday is 0, 11-17). */
function weekday(serial: number, type: number): number | CellError {
  const wd = partsOf(serial).wd;
  if (type === 1 || type === 17) return wd + 1;
  if (type === 2 || type === 11) return ((wd + 6) % 7) + 1;
  if (type === 3) return (wd + 6) % 7;
  if (type >= 12 && type <= 16) return ((wd - (type - 10) + 7) % 7) + 1;
  return E.NUM;
}

function isoWeek(serial: number): number {
  const p = partsOf(serial);
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d));
  const dn = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - dn + 3);
  const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((t.getTime() - firstThu.getTime()) / 86_400_000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
}

const DATE_FUNCTIONS: Record<string, Fn> = {
  // Lists multiplied value by value, then added up; text and blanks count as 0.
  SUMPRODUCT: (ev, a, d) => {
    if (!a.length) return E.VALUE;
    const grids: Grid[] = [];
    for (const n of a) {
      const g = grid(ev, n, d);
      if (g instanceof CellError) return g;
      if (grids.length && (g.length !== grids[0].length || g[0].length !== grids[0][0].length)) return E.VALUE;
      grids.push(g);
    }
    let total = 0;
    for (let r = 0; r < grids[0].length; r++) {
      for (let c = 0; c < grids[0][0].length; c++) {
        let p = 1;
        for (const g of grids) {
          const v = g[r][c];
          if (v instanceof CellError) return v;
          p *= typeof v === 'number' ? v : 0;
        }
        total += p;
      }
    }
    return clean(total);
  },
  TODAY: () => nowSerial(false),
  NOW: () => nowSerial(true),
  // DATE(year, month, day): months and days past their ends roll over; a year under 1900 has 1900 added, as in Excel.
  DATE: (ev, a, d) => {
    const y = int(ev, a, 0, d, NaN);
    const m = int(ev, a, 1, d, NaN);
    const day = int(ev, a, 2, d, NaN);
    if (y instanceof CellError) return y;
    if (m instanceof CellError) return m;
    if (day instanceof CellError) return day;
    if (Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(day)) return E.VALUE;
    const year = y >= 0 && y < 1900 ? y + 1900 : y;
    if (year < 0 || year > 9999) return E.NUM;
    const s = serialOf(year, m, 1) + day - 1;
    return Number.isNaN(s) || s < 0 || s > 2_958_465 ? E.NUM : s;
  },
  TIME: (ev, a, d) => {
    const h = int(ev, a, 0, d, NaN);
    const m = int(ev, a, 1, d, NaN);
    const sec = int(ev, a, 2, d, NaN);
    if (h instanceof CellError) return h;
    if (m instanceof CellError) return m;
    if (sec instanceof CellError) return sec;
    const total = h * 3600 + m * 60 + sec;
    if (!(total >= 0)) return E.NUM;
    return clean((total % 86400) / 86400);
  },
  YEAR: (ev, a, d) => { const n = serialArg(ev, a, 0, d, 0); return n instanceof CellError ? n : partsOf(dayOf(n)).y; },
  MONTH: (ev, a, d) => { const n = serialArg(ev, a, 0, d, 0); return n instanceof CellError ? n : partsOf(dayOf(n)).m; },
  DAY: (ev, a, d) => { const n = serialArg(ev, a, 0, d, 0); return n instanceof CellError ? n : partsOf(dayOf(n)).d; },
  HOUR: (ev, a, d) => { const n = serialArg(ev, a, 0, d, 0); return n instanceof CellError ? n : Math.floor(secondsOf(n) / 3600); },
  MINUTE: (ev, a, d) => { const n = serialArg(ev, a, 0, d, 0); return n instanceof CellError ? n : Math.floor((secondsOf(n) % 3600) / 60); },
  SECOND: (ev, a, d) => { const n = serialArg(ev, a, 0, d, 0); return n instanceof CellError ? n : secondsOf(n) % 60; },
  WEEKDAY: (ev, a, d) => {
    const n = serialArg(ev, a, 0, d, 0);
    const type = int(ev, a, 1, d, 1);
    if (n instanceof CellError) return n;
    if (type instanceof CellError) return type;
    return weekday(n, type);
  },
  // WEEKNUM: the week holding 1 January is week 1; weeks start on Sunday (type 1), Monday (2 or 11), ... ; 21 is ISO.
  WEEKNUM: (ev, a, d) => {
    const n = serialArg(ev, a, 0, d, 0);
    const type = int(ev, a, 1, d, 1);
    if (n instanceof CellError) return n;
    if (type instanceof CellError) return type;
    if (type === 21) return isoWeek(n);
    const start = type === 1 || type === 17 ? 0 : type === 2 || type === 11 ? 1 : type >= 12 && type <= 16 ? type - 10 : -1;
    if (start < 0) return E.NUM;
    const day = dayOf(n);
    const jan1 = serialOf(partsOf(day).y, 1, 1);
    const offset = (partsOf(jan1).wd - start + 7) % 7;
    return Math.floor((day - jan1 + offset) / 7) + 1;
  },
  ISOWEEKNUM: (ev, a, d) => { const n = serialArg(ev, a, 0, d); return n instanceof CellError ? n : isoWeek(n); },
  EDATE: (ev, a, d) => {
    const n = serialArg(ev, a, 0, d);
    const m = int(ev, a, 1, d, NaN);
    if (n instanceof CellError) return n;
    if (m instanceof CellError) return m;
    const s = addMonths(dayOf(n), m);
    return Number.isNaN(s) || s < 0 ? E.NUM : s;
  },
  EOMONTH: (ev, a, d) => {
    const n = serialArg(ev, a, 0, d);
    const m = int(ev, a, 1, d, NaN);
    if (n instanceof CellError) return n;
    if (m instanceof CellError) return m;
    const p = partsOf(dayOf(n));
    const total = p.y * 12 + (p.m - 1) + m + 1;
    const s = serialOf(Math.floor(total / 12), (total % 12) + 1, 1) - 1;
    return Number.isNaN(s) || s < 0 ? E.NUM : s;
  },
  // DATEDIF(start, end, "Y" | "M" | "D" | "YM" | "MD" | "YD"): whole years, months or days between two dates.
  DATEDIF: (ev, a, d) => {
    const s0 = serialArg(ev, a, 0, d);
    const e0 = serialArg(ev, a, 1, d);
    const unit = str(ev, a, 2, d);
    if (s0 instanceof CellError) return s0;
    if (e0 instanceof CellError) return e0;
    if (unit instanceof CellError) return unit;
    const s = dayOf(s0);
    const e = dayOf(e0);
    if (s > e) return E.NUM;
    const ps = partsOf(s);
    const pe = partsOf(e);
    const months = (pe.y - ps.y) * 12 + (pe.m - ps.m) - (pe.d < ps.d ? 1 : 0);
    switch (unit.toUpperCase()) {
      case 'D': return e - s;
      case 'M': return months;
      case 'Y': return Math.floor(months / 12);
      case 'YM': return months % 12;
      case 'MD': {
        if (pe.d >= ps.d) return pe.d - ps.d;
        const pm = pe.m === 1 ? 12 : pe.m - 1;
        const py = pe.m === 1 ? pe.y - 1 : pe.y;
        return daysInMonth(py, pm) - ps.d + pe.d;
      }
      case 'YD': {
        let from = serialOf(pe.y, ps.m, 1) + Math.min(ps.d, daysInMonth(pe.y, ps.m)) - 1;
        if (from > e) from = serialOf(pe.y - 1, ps.m, 1) + Math.min(ps.d, daysInMonth(pe.y - 1, ps.m)) - 1;
        return e - from;
      }
    }
    return E.NUM;
  },
  DAYS: (ev, a, d) => {
    const e = serialArg(ev, a, 0, d);
    const s = serialArg(ev, a, 1, d);
    if (e instanceof CellError) return e;
    if (s instanceof CellError) return s;
    return dayOf(e) - dayOf(s);
  },
  DATEVALUE: (ev, a, d) => {
    const t = ev.scalar(a[0] ?? { t: 'blank' }, d + 1);
    if (t instanceof CellError) return t;
    if (typeof t !== 'string') return E.VALUE;
    const r = readDateTime(t, dateOrder);
    return r ? dayOf(r.serial) : E.VALUE;
  },
  TIMEVALUE: (ev, a, d) => {
    const t = ev.scalar(a[0] ?? { t: 'blank' }, d + 1);
    if (t instanceof CellError) return t;
    if (typeof t !== 'string') return E.VALUE;
    const r = readDateTime(t, dateOrder);
    return r ? clean(r.serial - dayOf(r.serial)) : E.VALUE;
  },
  // Working days (Monday to Friday) from start to end, both counted, less any holidays.
  NETWORKDAYS: (ev, a, d) => {
    const s0 = serialArg(ev, a, 0, d);
    const e0 = serialArg(ev, a, 1, d);
    if (s0 instanceof CellError) return s0;
    if (e0 instanceof CellError) return e0;
    const off = holidays(ev, a[2], d);
    if (off instanceof CellError) return off;
    const s = dayOf(s0);
    const e = dayOf(e0);
    const step = s <= e ? 1 : -1;
    let count = 0;
    for (let day = s; step > 0 ? day <= e : day >= e; day += step) if (!weekend(day) && !off.has(day)) count++;
    return step * count;
  },
  // The working day `days` working days after (or before) start, skipping weekends and holidays.
  WORKDAY: (ev, a, d) => {
    const s0 = serialArg(ev, a, 0, d);
    const n = int(ev, a, 1, d, NaN);
    if (s0 instanceof CellError) return s0;
    if (n instanceof CellError) return n;
    if (!Number.isFinite(n) || Math.abs(n) > 1_000_000) return E.NUM;
    const off = holidays(ev, a[2], d);
    if (off instanceof CellError) return off;
    let day = dayOf(s0);
    const step = n >= 0 ? 1 : -1;
    for (let left = Math.abs(n); left > 0;) {
      day += step;
      if (day < 0 || day > 2_958_465) return E.NUM;
      if (!weekend(day) && !off.has(day)) left--;
    }
    return day;
  },
};
Object.assign(FUNCTIONS, DATE_FUNCTIONS);

function callFunction(ev: Ev, n: { name: string; args: Node[] }, depth: number): Value {
  const fn = FUNCTIONS[n.name];
  return fn ? fn(ev, n.args, depth) : E.NAME;
}

export function evaluate(node: Node, ctx: Context): Value {
  dateOrder = ctx.dateOrder ?? 'dmy';
  return new Ev(ctx).scalar(node);
}

/** True when a formula's answer can be a list (it may fill the cells around it). */
export function givesList(node: Node): boolean {
  return Ev.isList(node);
}

/**
 * True when the formula works on lists anywhere (=A1:A3*2, SUM(IF(B2:B9>5,1)), FILTER(...)): an Excel file marks such
 * a formula as a "dynamic array" one, or older Excel rules would read it as one value per row.
 */
export function worksOnLists(node: Node): boolean {
  if (Ev.isList(node)) return true;
  const walk = (n: Node): boolean => {
    switch (n.t) {
      case 'bin': return Ev.isList(n) || walk(n.l) || walk(n.r);
      case 'un': return Ev.isList(n) || walk(n.x);
      case 'call': return Ev.isList(n) || n.args.some(walk);
      case 'array': return n.rows.some(r => r.some(walk));
      default: return false;
    }
  };
  return walk(node);
}

/** A cell's formula worked out: one value, or the list it fills the cells around it with. */
export function evaluateCell(node: Node, ctx: Context): Value | Grid {
  dateOrder = ctx.dateOrder ?? 'dmy';
  const ev = new Ev(ctx);
  if (!Ev.isList(node)) return ev.scalar(node);
  const g = ev.block(node);
  if (g instanceof CellError) return g;
  return g.length && g[0].length ? g : E.CALC;
}

/** The first function a formula calls, read from its top (=DATE(...)+1 is DATE), for choosing a format. */
export function leadingFunction(node: Node): string | null {
  let n: Node = node;
  for (;;) {
    if (n.t === 'call') return n.name;
    if (n.t === 'bin') n = n.l;
    else if (n.t === 'un') n = n.x;
    else return null;
  }
}

export const FUNCTION_NAMES = [...Object.keys(FUNCTIONS), ...Object.keys(LIST_FUNCTIONS)].sort();
