// Conditional formatting: rules that change how cells look from what is in them, as Excel's Home > Conditional
// Formatting does. Highlight rules (greater than, between, text that contains, duplicates, blanks, a formula), top and
// bottom rules (top 10, above average), data bars and colour scales. Rules are kept per sheet in priority order (the
// first wins where two set the same thing; "stop if true" ends the list for that cell). No browser needed here.
// A formula in a rule is written for the top-left cell of the first block it covers and moves with each cell, as in Excel.
import { mixColour } from './paint.ts';
import { shiftFormula } from './refs.ts';
import { CellError, type Value } from './values.ts';
import type { Range, Workbook } from './workbook.ts';

/** How a cell looks when a highlight rule holds. */
export interface CfFormat {
  fill?: string;
  color?: string;
  b?: boolean;
  i?: boolean;
  u?: boolean;
}

export type CellOp = 'gt' | 'lt' | 'ge' | 'le' | 'eq' | 'ne' | 'between' | 'notBetween';
export type TextOp = 'contains' | 'notContains' | 'begins' | 'ends';

export type CfRule =
  /** The cell's value against one or two values (each a formula: 100, "Paid", $B$1). */
  | { t: 'cell'; op: CellOp; f1: string; f2?: string; fmt: CfFormat }
  | { t: 'text'; op: TextOp; text: string; fmt: CfFormat }
  | { t: 'top'; n: number; bottom?: boolean; percent?: boolean; fmt: CfFormat }
  | { t: 'avg'; below?: boolean; fmt: CfFormat }
  | { t: 'dup'; unique?: boolean; fmt: CfFormat }
  | { t: 'blank'; not?: boolean; fmt: CfFormat }
  /** A formula that is TRUE for the cells to format. */
  | { t: 'expr'; f: string; fmt: CfFormat }
  /** Lowest value in the first colour, highest in the last; with three, the middle (50th percentile) in the second. */
  | { t: 'scale'; colours: string[] }
  | { t: 'bar'; colour: string };

export interface CfEntry {
  ranges: Range[];
  rule: CfRule;
  stop?: boolean;
}

/** What the rules make of one cell. */
export interface CfLook extends CfFormat {
  /** A data bar: how far across the cell (0 to 1) and its colour. */
  bar?: { len: number; colour: string };
}

export const MAX_RULES = 200;
export const MAX_RANGES = 200;

/** Excel's ready-made looks for highlight rules. */
export const PRESETS: Array<{ label: string; fmt: CfFormat }> = [
  { label: 'Light red fill with dark red text', fmt: { fill: '#ffc7ce', color: '#9c0006' } },
  { label: 'Yellow fill with dark yellow text', fmt: { fill: '#ffeb9c', color: '#9c5700' } },
  { label: 'Green fill with dark green text', fmt: { fill: '#c6efce', color: '#006100' } },
  { label: 'Light red fill', fmt: { fill: '#ffc7ce' } },
  { label: 'Red text', fmt: { color: '#9c0006' } },
  { label: 'Bold text', fmt: { b: true } },
];

export const OP_WORDS: Record<CellOp, string> = {
  gt: 'greater than', lt: 'less than', ge: 'greater than or equal to', le: 'less than or equal to', eq: 'equal to',
  ne: 'not equal to', between: 'between', notBetween: 'not between',
};

const inRange = (r: Range, col: number, row: number) => col >= r.c0 && col <= r.c1 && row >= r.r0 && row <= r.r1;
export const covers = (e: CfEntry | { ranges: Range[] }, col: number, row: number): boolean => e.ranges.some(r => inRange(r, col, row));

/** The text of a value as a rule compares it (a number as typed, not as formatted). */
const plain = (v: Value): string => (v === null ? '' : v instanceof CellError ? v.code : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v));

/** Two values compared as Excel compares them: numbers below text below TRUE/FALSE; text without minding case. */
function compare(a: Value, b: Value): number {
  const rank = (v: Value) => (typeof v === 'number' || v === null ? 0 : typeof v === 'string' ? 1 : 2);
  const av = a === null ? (typeof b === 'string' ? '' : 0) : a;
  const bv = b === null ? (typeof a === 'string' ? '' : 0) : b;
  const ra = rank(av);
  const rb = rank(bv);
  if (ra !== rb) return ra - rb;
  if (typeof av === 'number' && typeof bv === 'number') return av - bv;
  if (typeof av === 'string' && typeof bv === 'string') return av.toLowerCase().localeCompare(bv.toLowerCase());
  return Number(av) - Number(bv);
}

/** Per rule, numbers worked out over all its cells (the top-10 line, the average, value counts, the lowest and highest). */
interface Stats {
  version: number;
  numbers: number[];
  counts?: Map<string, number>;
  avg?: number;
  cut?: number;
  min?: number;
  max?: number;
  mid?: number;
}
const statsCache = new WeakMap<CfEntry, Stats>();

function cellsOf(wb: Workbook, s: number, e: CfEntry, fn: (v: Value, col: number, row: number) => void): void {
  const used = wb.usedBounds(s);
  let seen = 0;
  for (const r of e.ranges) {
    for (let row = r.r0; row <= Math.min(r.r1, used.rows - 1); row++) {
      for (let col = r.c0; col <= Math.min(r.c1, used.cols - 1); col++) {
        fn(wb.value(s, col, row), col, row);
        if (++seen > 400_000) return;
      }
    }
  }
}

function stats(wb: Workbook, s: number, e: CfEntry): Stats {
  const hit = statsCache.get(e);
  if (hit && hit.version === wb.version) return hit;
  const out: Stats = { version: wb.version, numbers: [] };
  const rule = e.rule;
  if (rule.t === 'dup') {
    out.counts = new Map();
    cellsOf(wb, s, e, v => {
      if (v === null || v === '') return;
      const k = typeof v === 'string' ? `s:${v.toLowerCase()}` : `v:${plain(v)}`;
      out.counts!.set(k, (out.counts!.get(k) ?? 0) + 1);
    });
  } else {
    cellsOf(wb, s, e, v => {
      if (typeof v === 'number') out.numbers.push(v);
    });
    const nums = out.numbers;
    if (nums.length) {
      const sorted = [...nums].sort((a, b) => a - b);
      out.min = sorted[0];
      out.max = sorted[sorted.length - 1];
      out.avg = nums.reduce((a, b) => a + b, 0) / nums.length;
      // The 50th percentile, as Excel's colour scale middle: between the two middle values.
      const pos = (sorted.length - 1) * 0.5;
      out.mid = sorted[Math.floor(pos)] + (sorted[Math.ceil(pos)] - sorted[Math.floor(pos)]) * (pos - Math.floor(pos));
      if (rule.t === 'top') {
        const count = rule.percent ? Math.max(1, Math.floor((sorted.length * rule.n) / 100)) : rule.n;
        const k = Math.min(sorted.length, Math.max(1, count));
        out.cut = rule.bottom ? sorted[k - 1] : sorted[sorted.length - k];
      }
    }
  }
  statsCache.set(e, out);
  return out;
}

/** A rule's formula worked out for one cell (moved from the top-left of the rule's first block to this cell). */
function formulaAt(wb: Workbook, s: number, e: CfEntry, f: string, col: number, row: number): Value {
  const anchor = e.ranges[0];
  let moved = f;
  if (anchor && (col !== anchor.c0 || row !== anchor.r0) && /[A-Za-z]/.test(f)) {
    try {
      moved = shiftFormula(f, col - anchor.c0, row - anchor.r0);
    } catch {
      return null;
    }
  }
  const got = wb.evalFormula(s, moved, { col, row });
  if (Array.isArray(got)) return got[0]?.[0] ?? null;
  return got;
}

/** True when a rule holds for this cell (scales and bars always "hold": they draw a look of their own). */
function holds(wb: Workbook, s: number, e: CfEntry, v: Value, col: number, row: number): boolean {
  const rule = e.rule;
  switch (rule.t) {
    case 'cell': {
      // An empty cell counts as 0 against a number (Excel): "less than 5" holds for it, "greater than 5" does not.
      if (v instanceof CellError) return false;
      const a = formulaAt(wb, s, e, rule.f1, col, row);
      if (a instanceof CellError) return false;
      const c = compare(v, a);
      switch (rule.op) {
        case 'gt': return c > 0;
        case 'lt': return c < 0;
        case 'ge': return c >= 0;
        case 'le': return c <= 0;
        case 'eq': return c === 0;
        case 'ne': return c !== 0;
        case 'between':
        case 'notBetween': {
          const b = formulaAt(wb, s, e, rule.f2 ?? '', col, row);
          if (b instanceof CellError) return false;
          const lo = compare(a, b) <= 0 ? a : b;
          const hi = lo === a ? b : a;
          const inside = compare(v, lo) >= 0 && compare(v, hi) <= 0;
          return rule.op === 'between' ? inside : !inside;
        }
      }
      return false;
    }
    case 'text': {
      const t = plain(v).toLowerCase();
      const want = rule.text.toLowerCase();
      if (rule.op === 'contains') return t.includes(want);
      if (rule.op === 'notContains') return !t.includes(want);
      if (rule.op === 'begins') return t.startsWith(want);
      return t.endsWith(want);
    }
    case 'top': {
      if (typeof v !== 'number') return false;
      const st = stats(wb, s, e);
      if (st.cut === undefined) return false;
      return rule.bottom ? v <= st.cut : v >= st.cut;
    }
    case 'avg': {
      if (typeof v !== 'number') return false;
      const st = stats(wb, s, e);
      if (st.avg === undefined) return false;
      return rule.below ? v < st.avg : v > st.avg;
    }
    case 'dup': {
      if (v === null || v === '') return false;
      const st = stats(wb, s, e);
      const k = typeof v === 'string' ? `s:${v.toLowerCase()}` : `v:${plain(v)}`;
      const n = st.counts?.get(k) ?? 0;
      return rule.unique ? n === 1 : n > 1;
    }
    case 'blank': {
      const empty = v === null || (typeof v === 'string' && v.trim() === '');
      return rule.not ? !empty : empty;
    }
    case 'expr': {
      const r = formulaAt(wb, s, e, rule.f, col, row);
      if (typeof r === 'boolean') return r;
      if (typeof r === 'number') return r !== 0;
      return false;
    }
    default:
      return true;
  }
}

/**
 * How the rules on this sheet make the cell look, or null when none apply. Highlight rules set fill, text colour, bold,
 * italic, underline (the first rule in the list to set one wins); a colour scale sets the fill; a data bar draws a bar.
 */
export function cfLook(wb: Workbook, s: number, col: number, row: number): CfLook | null {
  const list = wb.sheets[s]?.cf;
  if (!list?.length) return null;
  let out: CfLook | null = null;
  let v: Value | undefined;
  for (const e of list) {
    if (!covers(e, col, row)) continue;
    v ??= wb.value(s, col, row);
    if (!holds(wb, s, e, v, col, row)) continue;
    out ??= {};
    const rule = e.rule;
    if (rule.t === 'scale') {
      if (typeof v === 'number' && out.fill === undefined) {
        const st = stats(wb, s, e);
        if (st.min !== undefined && st.max !== undefined) {
          const [c0, c1, c2] = rule.colours;
          if (st.max === st.min) out.fill = c2 ? c1 : c0;
          else if (c2 && st.mid !== undefined) {
            out.fill = v <= st.mid
              ? mixColour(c0, c1, st.mid === st.min ? 1 : (v - st.min) / (st.mid - st.min))
              : mixColour(c1, c2, st.max === st.mid ? 1 : (v - st.mid) / (st.max - st.mid));
          } else out.fill = mixColour(c0, c1, (v - st.min) / (st.max - st.min));
        }
      }
    } else if (rule.t === 'bar') {
      if (typeof v === 'number' && !out.bar) {
        const st = stats(wb, s, e);
        // Bars start from zero (Excel's "automatic" ends): the longest is the highest value.
        const lo = Math.min(0, st.min ?? 0);
        const hi = Math.max(0, st.max ?? 0);
        const len = hi === lo ? 0 : (v - lo) / (hi - lo);
        out.bar = { len: Math.max(0, Math.min(1, len)), colour: rule.colour };
      }
    } else {
      const f = rule.fmt;
      if (f.fill && out.fill === undefined) out.fill = f.fill;
      if (f.color && out.color === undefined) out.color = f.color;
      if (f.b && out.b === undefined) out.b = true;
      if (f.i && out.i === undefined) out.i = true;
      if (f.u && out.u === undefined) out.u = true;
    }
    if (e.stop) break;
  }
  return out;
}

/** A rule in words, for the Manage rules list ("Cell value greater than 100"). */
export function describeRule(rule: CfRule): string {
  const f = (x: string | undefined) => (x ?? '').replace(/^=/, '');
  switch (rule.t) {
    case 'cell': return `Cell value ${OP_WORDS[rule.op]} ${f(rule.f1)}${rule.op === 'between' || rule.op === 'notBetween' ? ` and ${f(rule.f2)}` : ''}`;
    case 'text': return `Text that ${rule.op === 'contains' ? 'contains' : rule.op === 'notContains' ? 'does not contain' : rule.op === 'begins' ? 'begins with' : 'ends with'} “${rule.text}”`;
    case 'top': return `${rule.bottom ? 'Bottom' : 'Top'} ${rule.n}${rule.percent ? '%' : ''}`;
    case 'avg': return `${rule.below ? 'Below' : 'Above'} average`;
    case 'dup': return rule.unique ? 'Unique values' : 'Duplicate values';
    case 'blank': return rule.not ? 'Cells that are not blank' : 'Blank cells';
    case 'expr': return `Formula: =${rule.f}`;
    case 'scale': return `${rule.colours.length}-colour scale`;
    case 'bar': return 'Data bar';
  }
}

// ---- Saving ---------------------------------------------------------------------------------------------------------

const COLOUR = /^#[0-9a-f]{6}$/i;

function cleanFormat(raw: unknown): CfFormat {
  const out: CfFormat = {};
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.fill === 'string' && COLOUR.test(r.fill)) out.fill = r.fill.toLowerCase();
  if (typeof r.color === 'string' && COLOUR.test(r.color)) out.color = r.color.toLowerCase();
  if (r.b === true) out.b = true;
  if (r.i === true) out.i = true;
  if (r.u === true) out.u = true;
  return out;
}

const formulaText = (v: unknown): string | null => (typeof v === 'string' && v.length <= 1000 ? v.replace(/^=/, '') : null);

/** A rule from a saved file, every field checked; null when it is not one. */
export function cleanRule(raw: unknown): CfRule | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const fmt = cleanFormat(r.fmt);
  switch (r.t) {
    case 'cell': {
      const ops: CellOp[] = ['gt', 'lt', 'ge', 'le', 'eq', 'ne', 'between', 'notBetween'];
      const f1 = formulaText(r.f1);
      if (!ops.includes(r.op as CellOp) || f1 === null || f1 === '') return null;
      const out: CfRule = { t: 'cell', op: r.op as CellOp, f1, fmt };
      if (r.op === 'between' || r.op === 'notBetween') {
        const f2 = formulaText(r.f2);
        if (!f2) return null;
        out.f2 = f2;
      }
      return out;
    }
    case 'text': {
      const ops: TextOp[] = ['contains', 'notContains', 'begins', 'ends'];
      if (!ops.includes(r.op as TextOp) || typeof r.text !== 'string' || r.text.length > 255) return null;
      return { t: 'text', op: r.op as TextOp, text: r.text, fmt };
    }
    case 'top': {
      const n = typeof r.n === 'number' && Number.isInteger(r.n) ? Math.max(1, Math.min(1000, r.n)) : 10;
      return { t: 'top', n, bottom: r.bottom === true || undefined, percent: r.percent === true || undefined, fmt };
    }
    case 'avg': return { t: 'avg', below: r.below === true || undefined, fmt };
    case 'dup': return { t: 'dup', unique: r.unique === true || undefined, fmt };
    case 'blank': return { t: 'blank', not: r.not === true || undefined, fmt };
    case 'expr': {
      const f = formulaText(r.f);
      return f ? { t: 'expr', f, fmt } : null;
    }
    case 'scale': {
      if (!Array.isArray(r.colours) || (r.colours.length !== 2 && r.colours.length !== 3)) return null;
      if (!r.colours.every(c => typeof c === 'string' && COLOUR.test(c))) return null;
      return { t: 'scale', colours: (r.colours as string[]).map(c => c.toLowerCase()) };
    }
    case 'bar': return typeof r.colour === 'string' && COLOUR.test(r.colour) ? { t: 'bar', colour: r.colour.toLowerCase() } : null;
    default: return null;
  }
}

/** Takes one block out of another: what is left of `a`, in up to four blocks. */
export function subtractRange(a: Range, b: Range): Range[] {
  if (b.c0 > a.c1 || b.c1 < a.c0 || b.r0 > a.r1 || b.r1 < a.r0) return [a];
  const out: Range[] = [];
  if (b.r0 > a.r0) out.push({ c0: a.c0, r0: a.r0, c1: a.c1, r1: b.r0 - 1 });
  if (b.r1 < a.r1) out.push({ c0: a.c0, r0: b.r1 + 1, c1: a.c1, r1: a.r1 });
  const r0 = Math.max(a.r0, b.r0);
  const r1 = Math.min(a.r1, b.r1);
  if (b.c0 > a.c0) out.push({ c0: a.c0, r0, c1: b.c0 - 1, r1 });
  if (b.c1 < a.c1) out.push({ c0: b.c1 + 1, r0, c1: a.c1, r1 });
  return out;
}

/** Ranges with a block taken out of each. */
export function subtractAll(ranges: Range[], b: Range): Range[] {
  return ranges.flatMap(r => subtractRange(r, b));
}
