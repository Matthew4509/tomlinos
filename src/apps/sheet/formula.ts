// Reading and working out formulas: "=SUM(A1:A5)*2". Our own parser and evaluator (nothing is ever passed to eval).
// Operators: + - * / ^ & % = <> < > <= >= and brackets. Functions: see FUNCTIONS. A formula that is too long, too
// deeply nested, or that loops back on itself gives an error value instead of hanging.
import { parseCellRef, sheetNameOf, SyntaxProblem, tokenize, type Ref, type Tok } from './refs.ts';
import { CellError, clean, E, formatNumber, type Value } from './values.ts';

export const MAX_FORMULA_LENGTH = 4000;
const MAX_DEPTH = 60;

export type Node =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'err'; e: CellError }
  | { t: 'ref'; ref: Ref; sheet?: string }
  | { t: 'range'; a: Ref; b: Ref; sheet?: string }
  | { t: 'un'; op: '-' | '+' | '%'; x: Node }
  | { t: 'bin'; op: string; l: Node; r: Node }
  | { t: 'call'; name: string; args: Node[] };

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
    const a = parseCellRef(tok.text);
    if (!a) return null;
    if (toks[p]?.type === 'colon' && toks[p + 1]?.type === 'ident') {
      const b = parseCellRef(toks[p + 1].text);
      if (!b) return fail('That range is not written correctly.');
      p += 2;
      return { t: 'range', a, b: b!, sheet };
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
            if (toks[p]?.type === 'comma' || toks[p]?.type === 'rp') args.push({ t: 'err', e: E.NAME } as Node);
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
  /** Cells that have a value, in a range, to keep whole-column style ranges fast. */
  bounds(sheet: number): { cols: number; rows: number };
}

type Grid = Value[][];

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
    const limit = this.ctx.bounds(s);
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

  /** A single value; a range on its own is an error (there is no implicit "same row" rule here). */
  scalar(n: Node, depth = 0): Value {
    if (depth > MAX_DEPTH * 2) return E.NUM;
    switch (n.t) {
      case 'num': return n.v;
      case 'str': return n.v;
      case 'bool': return n.v;
      case 'err': return n.e;
      case 'ref': {
        const s = this.sheetOf(n.sheet);
        return s < 0 ? E.REF : this.cell(s, n.ref.col, n.ref.row);
      }
      case 'range': {
        const g = this.range(n);
        if (g instanceof CellError) return g;
        return g.length === 1 && g[0].length === 1 ? g[0][0] : E.VALUE;
      }
      case 'un': {
        const v = this.scalar(n.x, depth + 1);
        if (v instanceof CellError) return v;
        const num = toNumber(v);
        if (num instanceof CellError) return num;
        return n.op === '-' ? -num : n.op === '%' ? clean(num / 100) : num;
      }
      case 'bin': return this.binary(n.op, this.scalar(n.l, depth + 1), this.scalar(n.r, depth + 1));
      case 'call': return callFunction(this, n, depth);
    }
  }

  private binary(op: string, l: Value, r: Value): Value {
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

export function text(v: Value): string {
  if (v === null) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return formatNumber(v, undefined);
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
  if (Number.isNaN(n) || !/^[-+]?[\d.,]+(e[-+]?\d+)?%?$/i.test(s)) return E.VALUE;
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
    if (a.t === 'range') {
      const g = ev.range(a);
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

function grid(ev: Ev, n: Node | undefined): Grid | CellError {
  if (!n) return E.VALUE;
  if (n.t === 'range') return ev.range(n);
  return [[ev.scalar(n)]];
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
    const asNum = rest.trim() !== '' && !Number.isNaN(Number(rest)) ? Number(rest) : null;
    operand = asNum !== null ? asNum : rest;
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
  MIN: (ev, a, d) => { const n = numbers(ev, a, d); return n instanceof CellError ? n : n.length ? Math.min(...n) : 0; },
  MAX: (ev, a, d) => { const n = numbers(ev, a, d); return n instanceof CellError ? n : n.length ? Math.max(...n) : 0; },
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
  TRIM: (ev, a, d) => { const v = ev.scalar(a[0] ?? { t: 'str', v: '' }, d + 1); return v instanceof CellError ? v : text(v).trim().replace(/\s+/g, ' '); },
  LEFT: (ev, a, d) => { const v = ev.scalar(a[0] ?? { t: 'str', v: '' }, d + 1); const n = num1(ev, a, 1, d, 1); return v instanceof CellError ? v : n instanceof CellError ? n : n < 0 ? E.VALUE : text(v).slice(0, n); },
  RIGHT: (ev, a, d) => { const v = ev.scalar(a[0] ?? { t: 'str', v: '' }, d + 1); const n = num1(ev, a, 1, d, 1); return v instanceof CellError ? v : n instanceof CellError ? n : n < 0 ? E.VALUE : n === 0 ? '' : text(v).slice(-n); },
  MID: (ev, a, d) => { const v = ev.scalar(a[0] ?? { t: 'str', v: '' }, d + 1); const s = num1(ev, a, 1, d); const n = num1(ev, a, 2, d); return v instanceof CellError ? v : s instanceof CellError ? s : n instanceof CellError ? n : s < 1 || n < 0 ? E.VALUE : text(v).slice(s - 1, s - 1 + n); },
  TEXT: (ev, a, d) => {
    const v = ev.scalar(a[0] ?? { t: 'num', v: 0 }, d + 1);
    const f = text(ev.scalar(a[1] ?? { t: 'str', v: '' }, d + 1));
    if (v instanceof CellError) return v;
    const n = toNumber(v);
    if (n instanceof CellError) return text(v);
    const dec = (/\.(0+)/.exec(f)?.[1].length) ?? 0;
    if (f.includes('%')) return formatNumber(n, { fmt: 'percent', dec });
    if (f.includes(',')) return formatNumber(n, { fmt: 'comma', dec });
    if (/^[$]/.test(f)) return formatNumber(n, { fmt: 'currency', dec });
    if (/0/.test(f)) return formatNumber(n, { fmt: 'number', dec });
    return text(n);
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

function callFunction(ev: Ev, n: { name: string; args: Node[] }, depth: number): Value {
  const fn = FUNCTIONS[n.name];
  return fn ? fn(ev, n.args, depth) : E.NAME;
}

export function evaluate(node: Node, ctx: Context): Value {
  return new Ev(ctx).scalar(node);
}

export const FUNCTION_NAMES = Object.keys(FUNCTIONS).sort();
