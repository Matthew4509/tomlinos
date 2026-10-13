// PivotTables (Insert > PivotTable): a summary of a table of data, with the values of some columns as row labels and
// column labels, and sums (counts, averages...) of others where they meet. The report is written into cells (as Excel
// writes it), and worked out again by Refresh, or whenever its fields change. Our own code, after Excel's compact layout.
import { CellError, clean, type CellStyle, type Value } from './values.ts';
import { partsOf } from './dates.ts';

export interface Range {
  c0: number;
  r0: number;
  c1: number;
  r1: number;
}

/** How a value field is summed up, by Excel's names for them. */
export type Agg = 'sum' | 'count' | 'average' | 'max' | 'min' | 'product' | 'countNums' | 'stdDev' | 'stdDevp' | 'var' | 'varp';
export const AGG_LABEL: Record<Agg, string> = {
  sum: 'Sum', count: 'Count', average: 'Average', max: 'Max', min: 'Min', product: 'Product', countNums: 'Count numbers', stdDev: 'StdDev', stdDevp: 'StdDevp', var: 'Var', varp: 'Varp',
};
export const AGGS = Object.keys(AGG_LABEL) as Agg[];

/** How a value is shown: as it is, or as a share of the grand total, its column's total or its row's total. */
export type ShowAs = 'normal' | 'pctTotal' | 'pctCol' | 'pctRow';
export const SHOW_LABEL: Record<ShowAs, string> = { normal: 'No calculation', pctTotal: '% of grand total', pctCol: '% of column total', pctRow: '% of row total' };

export interface PivotValue {
  field: number;
  agg: Agg;
  show?: ShowAs;
  /** The heading over its column ("Sum of Amount" when unset). */
  name?: string;
}

/** Dates in a row or column field grouped by year, quarter or month (as Excel's Group). */
export type DateGroup = 'years' | 'quarters' | 'months';

export interface Pivot {
  id: number;
  name: string;
  /** The data: a formula for its cells, with the header row first (Sheet1!$A$1:$D$200, or Table1[#All]). */
  source: string;
  /** The report's top-left cell, on the pivot's own sheet. */
  at: { col: number; row: number };
  rows: number[];
  cols: number[];
  values: PivotValue[];
  /** Report filters: a field, and the items kept (null: all). */
  filters: Array<{ field: number; keep: string[] | null }>;
  /** Items left out of a row or column field (its ▾ list on the report), by field. */
  hidden: Record<number, string[]>;
  groups: Record<number, DateGroup>;
  grandRows: boolean;
  grandCols: boolean;
  subtotals: boolean;
  /** The cells the report filled when last worked out (cleared when it is worked out again). */
  last: Range | null;
}

export const MAX_PIVOTS = 50;
/** The most distinct items a row or column field may have before the report is refused (it would be unreadable). */
const MAX_ITEMS = 5000;
const MAX_OUT_CELLS = 200_000;

/** One cell of a worked-out report. */
export interface OutCell {
  col: number;
  row: number;
  v: Value;
  /** Bold (headings, subtotals, grand totals), the heading look, an indent, a number format of the value's field. */
  look?: 'head' | 'total' | 'subtotal' | 'label';
  indent?: number;
  fmt?: CellStyle;
  /** The text for a share (shown as a percent). */
  pct?: boolean;
}

export interface Report {
  cells: OutCell[];
  range: Range;
}

/** The data a pivot reads: its field names (the header row) and its rows of values, and each field's number format. */
export interface PivotData {
  fields: string[];
  rows: Value[][];
  formats: Array<CellStyle | undefined>;
}

const BLANK = '(blank)';

/** An item's label: a date grouped, a number, text or "(blank)". */
function itemOf(v: Value, group: DateGroup | undefined, shown: string): { key: string; sort: [number, number | string]; label: Value } {
  if (v === null || v === '') return { key: '\u0000blank', sort: [3, 0], label: BLANK };
  if (v instanceof CellError) return { key: `e${v.code}`, sort: [4, v.code], label: v };
  if (typeof v === 'number' && group) {
    const p = partsOf(Math.floor(v));
    if (group === 'years') return { key: `y${p.y}`, sort: [0, p.y], label: p.y };
    if (group === 'quarters') {
      const q = Math.floor((p.m - 1) / 3) + 1;
      return { key: `q${q}`, sort: [0, q], label: `Qtr${q}` };
    }
    const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return { key: `m${p.m}`, sort: [0, p.m], label: names[p.m - 1] };
  }
  if (typeof v === 'number') return { key: `n${clean(v)}`, sort: [0, v], label: v };
  if (typeof v === 'boolean') return { key: `l${v}`, sort: [2, Number(v)], label: v };
  void shown;
  return { key: `s${v.toLowerCase()}`, sort: [1, v.toLowerCase()], label: v };
}

const compareSort = (a: [number, number | string], b: [number, number | string]): number =>
  a[0] - b[0] || (typeof a[1] === 'number' && typeof b[1] === 'number' ? a[1] - b[1] : String(a[1]).localeCompare(String(b[1]), undefined, { numeric: true, sensitivity: 'base' }));

/** The label a filter or hidden list keeps an item by (as its ▾ list shows it). */
export const itemText = (label: Value): string => (label === null ? BLANK : label instanceof CellError ? label.code : typeof label === 'boolean' ? (label ? 'TRUE' : 'FALSE') : String(label));

/** A value field's heading: "Sum of Amount". */
export const valueName = (v: PivotValue, fields: string[]): string => v.name || `${AGG_LABEL[v.agg]} of ${fields[v.field] ?? '?'}`;

/** Sums up a list of values the way a value field asks. */
function aggregate(vals: Value[], agg: Agg): Value {
  const nums = vals.filter((v): v is number => typeof v === 'number');
  const err = vals.find(v => v instanceof CellError);
  if (err && agg !== 'count') return err;
  switch (agg) {
    case 'count': return vals.filter(v => v !== null && v !== '').length;
    case 'countNums': return nums.length;
    case 'sum': return clean(nums.reduce((s, x) => s + x, 0));
    case 'product': return nums.length ? clean(nums.reduce((s, x) => s * x, 1)) : 0;
    case 'average': return nums.length ? clean(nums.reduce((s, x) => s + x, 0) / nums.length) : new CellError('#DIV/0!');
    case 'max': return nums.length ? nums.reduce((m, x) => (x > m ? x : m)) : 0;
    case 'min': return nums.length ? nums.reduce((m, x) => (x < m ? x : m)) : 0;
    default: {
      const n = nums.length;
      const sample = agg === 'stdDev' || agg === 'var';
      if (n - (sample ? 1 : 0) < 1) return new CellError('#DIV/0!');
      const m = nums.reduce((s, x) => s + x, 0) / n;
      const ss = nums.reduce((s, x) => s + (x - m) * (x - m), 0) / (n - (sample ? 1 : 0));
      return clean(agg === 'stdDev' || agg === 'stdDevp' ? Math.sqrt(ss) : ss);
    }
  }
}

/** A tree of items along rows or columns: each node one item of a field, with the rows of data under it. */
interface Node {
  key: string;
  label: Value;
  sort: [number, number | string];
  rows: number[];
  kids: Node[];
}

function tree(data: PivotData, rowIdx: number[], fields: number[], p: Pivot, depth = 0): Node[] {
  if (depth >= fields.length) return [];
  const f = fields[depth];
  const by = new Map<string, Node>();
  const hidden = new Set((p.hidden[f] ?? []).map(x => x.toLowerCase()));
  for (const i of rowIdx) {
    const it = itemOf(data.rows[i][f], p.groups[f], '');
    if (hidden.has(itemText(it.label).toLowerCase())) continue;
    let node = by.get(it.key);
    if (!node) {
      if (by.size >= MAX_ITEMS) throw new Error(`The field "${data.fields[f]}" has more than ${MAX_ITEMS.toLocaleString()} different items, too many to lay out.`);
      node = { key: it.key, label: it.label, sort: it.sort, rows: [], kids: [] };
      by.set(it.key, node);
    }
    node.rows.push(i);
  }
  const nodes = [...by.values()].sort((a, b) => compareSort(a.sort, b.sort));
  for (const n of nodes) n.kids = tree(data, n.rows, fields, p, depth + 1);
  return nodes;
}

/** Every distinct item of a field (as its ▾ list or a report filter offers them), in order. */
export function fieldItems(data: PivotData, field: number, group?: DateGroup): string[] {
  const seen = new Map<string, { sort: [number, number | string]; text: string }>();
  for (const row of data.rows) {
    const it = itemOf(row[field], group, '');
    if (!seen.has(it.key)) seen.set(it.key, { sort: it.sort, text: itemText(it.label) });
    if (seen.size > MAX_ITEMS) break;
  }
  return [...seen.values()].sort((a, b) => compareSort(a.sort, b.sort)).map(x => x.text);
}

/**
 * Works out the report: Excel's compact layout. Report filters at the top, then a heading row, one row per row item
 * (an outer item first with its subtotal, inner items indented under it), the grand total last; one column per
 * column item and value field, and a grand total column.
 */
export function buildReport(p: Pivot, data: PivotData): Report {
  const out: OutCell[] = [];
  const { col: c0, row: r00 } = p.at;
  // No fields yet: a note where the report will be, as Excel shows an empty PivotTable.
  if (!p.rows.length && !p.cols.length && !p.values.length && !p.filters.length) {
    out.push({ col: c0, row: r00, v: `${p.name}: tick fields in the PivotTable Fields pane to build the report`, look: 'label' });
    return { cells: out, range: { c0, r0: r00, c1: c0 + 2, r1: r00 + 2 } };
  }
  let r0 = r00;
  // Report filters, each on a row of its own, then a blank row.
  let keepRows = data.rows.map((_, i) => i);
  for (const f of p.filters) {
    out.push({ col: c0, row: r0, v: data.fields[f.field] ?? '?', look: 'label' });
    out.push({ col: c0 + 1, row: r0, v: !f.keep ? '(All)' : f.keep.length === 1 ? f.keep[0] : '(Multiple items)' });
    if (f.keep) {
      const keep = new Set(f.keep.map(k => k.toLowerCase()));
      keepRows = keepRows.filter(i => keep.has(itemText(itemOf(data.rows[i][f.field], p.groups[f.field], '').label).toLowerCase()));
    }
    r0++;
  }
  if (p.filters.length) r0++;
  // Items left out of a row or column field leave the totals too, as in Excel.
  for (const f of [...p.rows, ...p.cols]) {
    const hide = new Set((p.hidden[f] ?? []).map(x => x.toLowerCase()));
    if (hide.size) keepRows = keepRows.filter(i => !hide.has(itemText(itemOf(data.rows[i][f], p.groups[f], '').label).toLowerCase()));
  }
  const values = p.values;
  const rowTree = tree(data, keepRows, p.rows, p);
  const colTree = tree(data, keepRows, p.cols, p);
  // The columns: each leaf of the column items (or one, when there are no column fields), times each value field.
  type Col = { path: Node[]; rows: number[] | null; value: number; total: boolean };
  const leaves: Array<{ path: Node[]; rows: number[] }> = [];
  const walk = (nodes: Node[], path: Node[]) => {
    for (const n of nodes) {
      if (n.kids.length) walk(n.kids, [...path, n]);
      else leaves.push({ path: [...path, n], rows: n.rows });
    }
  };
  walk(colTree, []);
  const nv = Math.max(1, values.length);
  // The column of row labels (left out when there are neither row nor column fields: just the sums).
  const lc = p.rows.length || p.cols.length ? 1 : 0;
  const columns: Col[] = [];
  if (p.cols.length) {
    for (const leaf of leaves) for (let v = 0; v < nv; v++) columns.push({ path: leaf.path, rows: leaf.rows, value: v, total: false });
    if (p.grandCols) for (let v = 0; v < nv; v++) columns.push({ path: [], rows: null, value: v, total: true });
  } else for (let v = 0; v < nv; v++) columns.push({ path: [], rows: null, value: v, total: false });

  // Headings: with column fields, a row naming the value field (or "Column Labels"), then the column items' rows.
  const colDepth = p.cols.length;
  const headRows = colDepth ? colDepth + (values.length > 1 ? 1 : 0) + 1 : 1;
  const firstData = r0 + headRows;
  const top = r0;
  if (colDepth) {
    out.push({ col: c0, row: top, v: values.length === 1 ? valueName(values[0], data.fields) : null, look: 'head' });
    out.push({ col: c0 + 1, row: top, v: 'Column Labels', look: 'head' });
    // Each column item, written over the first of its columns.
    columns.forEach((c, j) => {
      for (let d = 0; d < colDepth; d++) {
        const node = c.path[d];
        const prev = columns[j - 1];
        const first = !prev || prev.path[d]?.key !== node?.key || prev.total !== c.total || c.path.slice(0, d).some((n, k) => prev.path[k]?.key !== n.key);
        if (c.total) {
          if (d === 0 && c.value === 0) out.push({ col: c0 + 1 + j, row: top + 1, v: values.length > 1 ? `Total ${valueName(values[0], data.fields)}` : 'Grand Total', look: 'head' });
          continue;
        }
        if (node && first && (values.length <= 1 || c.value === 0)) out.push({ col: c0 + 1 + j, row: top + 1 + d, v: node.label, look: 'head' });
      }
      if (values.length > 1) {
        const label = c.total ? `Total ${valueName(values[c.value], data.fields)}` : valueName(values[c.value], data.fields);
        out.push({ col: c0 + 1 + j, row: top + 1 + colDepth, v: label, look: 'head' });
      }
    });
    out.push({ col: c0, row: firstData - 1, v: p.rows.length ? 'Row Labels' : null, look: 'head' });
  } else {
    if (lc) out.push({ col: c0, row: top, v: 'Row Labels', look: 'head' });
    columns.forEach((c, j) => out.push({ col: c0 + lc + j, row: top, v: values.length ? valueName(values[c.value], data.fields) : null, look: 'head' }));
  }

  // The figures: a value field summed over the rows that are in both a row item and a column.
  const cellValue = (rows: number[], c: Col): Value => {
    const v = values[c.value];
    if (!v) return null;
    const set = c.rows ? new Set(c.rows) : null;
    const these = set ? rows.filter(i => set.has(i)) : rows;
    if (!these.length) return null;
    return aggregate(these.map(i => data.rows[i][v.field]), v.agg);
  };
  // Shares need the totals they are shares of.
  const grand = columns.map(c => cellValue(keepRows, { ...c, rows: c.total ? null : c.rows }));
  const grandFor = (vi: number) => {
    const v = values[vi];
    return v ? aggregate(keepRows.map(i => data.rows[i][v.field]), v.agg) : null;
  };
  const show = (val: Value, rows: number[], c: Col, j: number): { v: Value; pct: boolean } => {
    const v = values[c.value];
    if (!v || !v.show || v.show === 'normal' || typeof val !== 'number') return { v: val, pct: false };
    let base: Value = null;
    if (v.show === 'pctTotal') base = grandFor(c.value);
    else if (v.show === 'pctCol') base = grand[j];
    else base = cellValue(rows, { path: [], rows: null, value: c.value, total: true });
    return { v: typeof base === 'number' && base !== 0 ? clean(val / base) : new CellError('#DIV/0!'), pct: true };
  };
  let r = firstData;
  const fmtOf = (c: Col) => (values[c.value] && !['count', 'countNums'].includes(values[c.value].agg) ? data.formats[values[c.value].field] : undefined);
  const writeRow = (label: Value, rows: number[], look: OutCell['look'], indent: number) => {
    if (lc) out.push({ col: c0, row: r, v: label, look, indent });
    columns.forEach((c, j) => {
      const got = show(cellValue(rows, c), rows, c, j);
      if (got.v !== null) out.push({ col: c0 + lc + j, row: r, v: got.v, look: look === 'subtotal' || (look === 'total' && lc) ? look : undefined, fmt: got.pct ? undefined : fmtOf(c), pct: got.pct });
    });
    r++;
  };
  const rowsOut = (nodes: Node[], depth: number) => {
    for (const n of nodes) {
      if (r - firstData > MAX_ITEMS * 4) throw new Error('This PivotTable would be too long to lay out. Use fewer row fields, or filter some items out.');
      if (n.kids.length) {
        // An outer item: its subtotal on its own row (compact form), the inner items under it.
        if (p.subtotals) writeRow(n.label, n.rows, 'subtotal', depth);
        else {
          out.push({ col: c0, row: r, v: n.label, look: 'subtotal', indent: depth });
          r++;
        }
        rowsOut(n.kids, depth + 1);
      } else writeRow(n.label, n.rows, undefined, depth);
    }
  };
  if (p.rows.length) rowsOut(rowTree, 0);
  if (p.grandRows || !p.rows.length) writeRow(p.rows.length ? 'Grand Total' : null, keepRows, 'total', 0);
  const width = columns.length;
  const range = { c0, r0: r00, c1: Math.max(c0 + 1, c0 + lc + width - 1), r1: Math.max(r - 1, firstData - 1) };
  if ((range.c1 - range.c0 + 1) * (range.r1 - range.r0 + 1) > MAX_OUT_CELLS) throw new Error('This PivotTable would be too big to lay out. Use fewer fields, or filter some items out.');
  return { cells: out, range };
}

/** A pivot from a saved file, checked; null when damaged. */
export function cleanPivot(raw: unknown, range: (raw: unknown) => Range | null): Pivot | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const ints = (x: unknown): number[] | null => (Array.isArray(x) && x.length <= 64 && x.every(n => Number.isInteger(n) && n >= 0 && n < 16384) ? (x as number[]) : null);
  const at = r.at as Record<string, unknown> | undefined;
  if (!Number.isInteger(r.id) || typeof r.name !== 'string' || r.name.length > 255 || typeof r.source !== 'string' || r.source.length > 4000) return null;
  if (!at || !Number.isInteger(at.col) || !Number.isInteger(at.row) || (at.col as number) < 0 || (at.row as number) < 0 || (at.col as number) >= 256 || (at.row as number) >= 5000) return null;
  const rows = ints(r.rows);
  const cols = ints(r.cols);
  if (!rows || !cols || !Array.isArray(r.values) || !Array.isArray(r.filters)) return null;
  const values: PivotValue[] = [];
  for (const v of r.values.slice(0, 64)) {
    const x = v as Record<string, unknown> | null;
    if (!x || !Number.isInteger(x.field) || !AGGS.includes(x.agg as Agg)) return null;
    values.push({ field: x.field as number, agg: x.agg as Agg, ...(typeof x.show === 'string' && x.show !== 'normal' && x.show in SHOW_LABEL ? { show: x.show as ShowAs } : {}), ...(typeof x.name === 'string' && x.name.length <= 255 && x.name ? { name: x.name } : {}) });
  }
  const filters: Pivot['filters'] = [];
  for (const f of r.filters.slice(0, 64)) {
    const x = f as Record<string, unknown> | null;
    if (!x || !Number.isInteger(x.field)) return null;
    const keep = Array.isArray(x.keep) ? x.keep.filter((k): k is string => typeof k === 'string').slice(0, 20000) : null;
    filters.push({ field: x.field as number, keep });
  }
  const hidden: Record<number, string[]> = {};
  if (r.hidden && typeof r.hidden === 'object') {
    for (const [k, list] of Object.entries(r.hidden as Record<string, unknown>).slice(0, 64)) {
      if (Number.isInteger(Number(k)) && Array.isArray(list)) hidden[Number(k)] = list.filter((x): x is string => typeof x === 'string').slice(0, 20000);
    }
  }
  const groups: Record<number, DateGroup> = {};
  if (r.groups && typeof r.groups === 'object') {
    for (const [k, g] of Object.entries(r.groups as Record<string, unknown>).slice(0, 64)) {
      if (Number.isInteger(Number(k)) && (g === 'years' || g === 'quarters' || g === 'months')) groups[Number(k)] = g;
    }
  }
  return {
    id: r.id as number, name: r.name, source: r.source, at: { col: at.col as number, row: at.row as number },
    rows, cols, values, filters, hidden, groups,
    grandRows: r.grandRows !== false, grandCols: r.grandCols !== false, subtotals: r.subtotals !== false,
    last: range(r.last),
  };
}
