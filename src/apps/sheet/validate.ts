// Data validation: rules on what may be typed in cells, as Excel's Data > Data Validation. A drop-down list (from typed
// items or from cells), whole numbers, decimals, dates or times in a range, a length of text, or a formula that must be
// TRUE; with an optional message shown when the cell is selected, and a Stop, Warning or Information box when what is
// typed breaks the rule. As in Excel, only typing is checked: pasting, filling and formulas worked out later are not.
// No browser needed here.
import { refRange } from './chart.ts';
import { covers, OP_WORDS, type CellOp } from './condfmt.ts';
import { shiftFormula } from './refs.ts';
import { CellError, type Value } from './values.ts';
import type { Range, Workbook } from './workbook.ts';

export type DvType = 'any' | 'whole' | 'decimal' | 'list' | 'date' | 'time' | 'length' | 'custom';
export const DV_TYPES: DvType[] = ['any', 'whole', 'decimal', 'list', 'date', 'time', 'length', 'custom'];
export const DV_LABEL: Record<DvType, string> = {
  any: 'Any value', whole: 'Whole number', decimal: 'Decimal', list: 'List', date: 'Date', time: 'Time', length: 'Text length', custom: 'Custom (a formula)',
};

export interface Validation {
  ranges: Range[];
  type: DvType;
  op: CellOp;
  /** Formulas (without "="): a number, a date, $B$1. For a list: "Yes,No" typed in quotes ("\"Yes,No\""), or a range. */
  f1: string;
  f2: string;
  /** Ignore blank: an empty cell passes. */
  blank: boolean;
  /** A list shows a ▾ beside the cell to pick from. */
  dropdown: boolean;
  /** Shown beside the cell when it is selected. */
  prompt: { show: boolean; title: string; text: string };
  /** What happens when something that breaks the rule is typed. */
  error: { show: boolean; style: 'stop' | 'warning' | 'info'; title: string; text: string };
}

export const MAX_VALIDATIONS = 500;
export const MAX_ITEMS = 2000;

export function newValidation(ranges: Range[]): Validation {
  return {
    ranges, type: 'any', op: 'between', f1: '', f2: '', blank: true, dropdown: true,
    prompt: { show: true, title: '', text: '' }, error: { show: true, style: 'stop', title: '', text: '' },
  };
}

export function validationAt(wb: Workbook, s: number, col: number, row: number): Validation | null {
  return wb.sheets[s]?.dv.find(v => covers(v, col, row)) ?? null;
}

/** A list rule's items typed into the box ("Yes,No,Maybe" is stored as the text formula "Yes,No,Maybe" in quotes). */
export function literalItems(f1: string): string[] | null {
  const m = /^"((?:[^"]|"")*)"$/.exec(f1.trim());
  if (!m) return null;
  return m[1].replace(/""/g, '"').split(',').map(x => x.trim()).filter(x => x !== '');
}

/** Items typed by a person ("Yes, No") as the formula a list rule keeps. */
export const itemsFormula = (typed: string): string => `"${typed.split(',').map(x => x.trim()).filter(Boolean).join(',').replace(/"/g, '""')}"`;

/** A rule's formula worked out for one cell (moved from the top-left of the rule's first block, as Excel does). */
function formulaAt(wb: Workbook, s: number, v: Validation, f: string, col: number, row: number): Value | Value[][] {
  const anchor = v.ranges[0];
  let moved = f;
  if (anchor && (col !== anchor.c0 || row !== anchor.r0) && /[A-Za-z]/.test(f)) {
    try {
      moved = shiftFormula(f, col - anchor.c0, row - anchor.r0);
    } catch {
      return new CellError('#REF!');
    }
  }
  return wb.evalFormula(s, moved, { col, row });
}

const scalar = (x: Value | Value[][]): Value => (Array.isArray(x) ? x[0]?.[0] ?? null : x);

/** The choices of a list rule, as the cells show them (a list from cells), or as typed. */
export function listItems(wb: Workbook, s: number, v: Validation, col: number, row: number): string[] {
  const typed = literalItems(v.f1);
  if (typed) return typed.slice(0, MAX_ITEMS);
  const plain = refRange(wb, s, v.f1);
  const out: string[] = [];
  if (plain) {
    const used = wb.usedBounds(plain.s);
    for (let r = plain.range.r0; r <= Math.min(plain.range.r1, used.rows - 1); r++) {
      for (let c = plain.range.c0; c <= Math.min(plain.range.c1, used.cols - 1); c++) {
        const t = wb.display(plain.s, c, r);
        if (t !== '') out.push(t);
        if (out.length >= MAX_ITEMS) return out;
      }
    }
    return out;
  }
  const got = formulaAt(wb, s, v, v.f1, col, row);
  for (const x of Array.isArray(got) ? got.flat() : [got]) {
    if (x === null || x instanceof CellError) continue;
    out.push(typeof x === 'boolean' ? (x ? 'TRUE' : 'FALSE') : String(x));
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

const plain = (v: Value): string => (v === null ? '' : v instanceof CellError ? v.code : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v));

/** True when the value may go in the cell under this rule. */
export function passes(wb: Workbook, s: number, v: Validation, value: Value, col: number, row: number): boolean {
  if (v.type === 'any') return true;
  const empty = value === null || value === '';
  if (empty) return v.blank;
  if (value instanceof CellError) return false;
  if (v.type === 'list') {
    const t = plain(value).toLowerCase();
    return listItems(wb, s, v, col, row).some(x => x.toLowerCase() === t);
  }
  if (v.type === 'custom') {
    const r = scalar(formulaAt(wb, s, v, v.f1, col, row));
    return r === true || (typeof r === 'number' && r !== 0);
  }
  let x: number;
  if (v.type === 'length') x = plain(value).length;
  else {
    if (typeof value !== 'number') return false;
    x = value;
    if (v.type === 'whole' && !Number.isInteger(x)) return false;
    // A time is the part of a day; a date is a whole number of days (a date and time is still a date).
    if (v.type === 'time' && (x < 0 || x >= 1)) return false;
  }
  const num = (f: string): number | null => {
    const r = scalar(formulaAt(wb, s, v, f, col, row));
    return typeof r === 'number' ? r : typeof r === 'string' && r.trim() !== '' && Number.isFinite(Number(r)) ? Number(r) : null;
  };
  const a = num(v.f1);
  if (a === null) return false;
  const eps = 1e-9;
  switch (v.op) {
    case 'gt': return x > a + eps;
    case 'lt': return x < a - eps;
    case 'ge': return x >= a - eps;
    case 'le': return x <= a + eps;
    case 'eq': return Math.abs(x - a) <= eps;
    case 'ne': return Math.abs(x - a) > eps;
    case 'between':
    case 'notBetween': {
      const b = num(v.f2);
      if (b === null) return false;
      const inside = x >= Math.min(a, b) - eps && x <= Math.max(a, b) + eps;
      return v.op === 'between' ? inside : !inside;
    }
  }
  return false;
}

/** The rule in words, for the error box when the person did not write their own message. */
export function describeValidation(v: Validation): string {
  switch (v.type) {
    case 'any': return 'Any value';
    case 'list': return 'one of the values in the list';
    case 'custom': return `a value for which =${v.f1} is TRUE`;
    default: {
      const what = v.type === 'whole' ? 'a whole number' : v.type === 'decimal' ? 'a number' : v.type === 'date' ? 'a date' : v.type === 'time' ? 'a time' : 'text with a length';
      return `${what} ${OP_WORDS[v.op]} ${v.f1}${v.op === 'between' || v.op === 'notBetween' ? ` and ${v.f2}` : ''}`;
    }
  }
}

// ---- Saving ---------------------------------------------------------------------------------------------------------

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');

/** A rule from a saved file, every field checked (the ranges are checked by the caller); null when it is not one. */
export function cleanValidation(raw: unknown, ranges: Range[]): Validation | null {
  if (!raw || typeof raw !== 'object' || !ranges.length) return null;
  const r = raw as Record<string, unknown>;
  if (!DV_TYPES.includes(r.type as DvType)) return null;
  const ops: CellOp[] = ['gt', 'lt', 'ge', 'le', 'eq', 'ne', 'between', 'notBetween'];
  const out = newValidation(ranges);
  out.type = r.type as DvType;
  out.op = ops.includes(r.op as CellOp) ? (r.op as CellOp) : 'between';
  out.f1 = text(r.f1, 1000).replace(/^=/, '');
  out.f2 = text(r.f2, 1000).replace(/^=/, '');
  out.blank = r.blank !== false;
  out.dropdown = r.dropdown !== false;
  const p = r.prompt as Record<string, unknown> | undefined;
  if (p && typeof p === 'object') out.prompt = { show: p.show !== false, title: text(p.title, 32), text: text(p.text, 255) };
  const e = r.error as Record<string, unknown> | undefined;
  if (e && typeof e === 'object') {
    out.error = { show: e.show !== false, style: e.style === 'warning' || e.style === 'info' ? e.style : 'stop', title: text(e.title, 32), text: text(e.text, 255) };
  }
  if (out.type !== 'any' && out.f1 === '') return null;
  return out;
}
