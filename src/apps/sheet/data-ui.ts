// The Data tab's screens: Sort (several columns, each A to Z or Z to A), Number and Text filters (one or two
// conditions, top 10, above or below average), Remove duplicates, and Text to columns. The work itself is in workbook.ts.
import { h, on } from '../../core/dom.ts';
import type { MenuItem } from '../../shell/menu.ts';
import type { SheetContext } from './charts-ui.ts';
import { readRanges } from './rules-ui.ts';
import { addressOf, colName, SyntaxProblem } from './refs.ts';
import type { FilterCond, FilterRule, Range } from './workbook.ts';

const rangeText = (r: Range) => `${addressOf(r.c0, r.r0)}:${addressOf(r.c1, r.r1)}`;

/** The block a Data command works on: the selection when it is more than one cell, else the table of data around the active cell. */
function dataBlock(ctx: SheetContext): Range {
  const { wb, grid } = ctx;
  const s = grid.sel();
  const a = grid.active();
  const used = wb.usedBounds(wb.active);
  if (s.r1 > s.r0 || s.c1 > s.c0) return { ...s, r1: Math.min(s.r1, Math.max(s.r0, used.rows - 1)), c1: Math.min(s.c1, Math.max(s.c0, used.cols - 1)) };
  const t = wb.tableAt(wb.active, a.col, a.row);
  // A table: its header and data rows (its total row stays out of sorting and duplicates).
  return t ? { ...t.range, r1: t.range.r1 - (t.totals ? 1 : 0) } : wb.currentRegion(wb.active, a.col, a.row);
}

/** Whether the block's first row looks like column names: words over figures, as Excel guesses it. */
function looksLikeHeader(ctx: SheetContext, r: Range): boolean {
  const { wb } = ctx;
  const row = (rr: number) => Array.from({ length: r.c1 - r.c0 + 1 }, (_, i) => wb.value(wb.active, r.c0 + i, rr));
  const first = row(r.r0);
  const second = r.r1 > r.r0 ? row(r.r0 + 1) : [];
  if (wb.tableAt(wb.active, r.c0, r.r0)?.header && wb.tableAt(wb.active, r.c0, r.r0)!.range.r0 === r.r0) return true;
  return first.some(v => typeof v === 'string') && first.every(v => v === null || typeof v === 'string') && second.some(v => v !== null && typeof v !== 'string');
}

/** A column's heading: its header cell's words, or "Column B". */
const heading = (ctx: SheetContext, r: Range, c: number, header: boolean) => (header ? ctx.wb.display(ctx.wb.active, c, r.r0) || `Column ${colName(c)}` : `Column ${colName(c)}`);

/** Data > Sort: by one column, then by another among equals, each A to Z (smallest first) or Z to A. */
export async function sortDialog(ctx: SheetContext): Promise<void> {
  const { shell, wb, grid } = ctx;
  if (!grid.commit()) return;
  const block = dataBlock(ctx);
  if (block.r1 <= block.r0 && block.c1 === block.c0) {
    await shell.dialogs.alert('Nothing to sort here', 'Click a cell in a table of data (or select the cells to sort), then choose Sort.');
    return;
  }
  const headIn = h('input', { type: 'checkbox' });
  headIn.checked = looksLikeHeader(ctx, block);
  const levels = h('div', { class: 'sort-levels' });
  const done = new AbortController();
  const options = () => Array.from({ length: block.c1 - block.c0 + 1 }, (_, i) => h('option', { value: String(block.c0 + i) }, heading(ctx, block, block.c0 + i, headIn.checked)));
  const addLevel = (col = grid.active().col, asc = true) => {
    if (levels.childElementCount >= 64) return;
    const colSel = h('select', { class: 'field', 'aria-label': 'Sort by column' }, ...options());
    colSel.value = String(Math.max(block.c0, Math.min(block.c1, col)));
    const orderSel = h('select', { class: 'field', 'aria-label': 'Order' }, h('option', { value: 'asc' }, 'A to Z (smallest first)'), h('option', { value: 'desc' }, 'Z to A (largest first)'));
    orderSel.value = asc ? 'asc' : 'desc';
    const drop = h('button', { type: 'button', class: 'btn', 'aria-label': 'Delete this level' }, 'Delete');
    const row = h('div', { class: 'sort-level' }, h('span', { class: 'sort-then' }, levels.childElementCount ? 'Then by' : 'Sort by'), colSel, orderSel, drop);
    on(drop, 'click', () => {
      if (levels.childElementCount > 1) row.remove();
      relabel();
    }, done.signal);
    levels.append(row);
  };
  const relabel = () => [...levels.children].forEach((row, i) => {
    (row.querySelector('.sort-then') as HTMLElement).textContent = i ? 'Then by' : 'Sort by';
  });
  const add = h('button', { type: 'button', class: 'btn' }, 'Add level');
  on(add, 'click', () => addLevel(block.c0), done.signal);
  // Ticking or unticking "headers" changes how the columns are named in the lists.
  on(headIn, 'change', () => {
    for (const sel of levels.querySelectorAll('select[aria-label="Sort by column"]')) {
      const v = (sel as HTMLSelectElement).value;
      (sel as HTMLSelectElement).replaceChildren(...options());
      (sel as HTMLSelectElement).value = v;
    }
  }, done.signal);
  addLevel();
  const ok = await shell.dialogs.ask<boolean>({
    title: 'Sort',
    body: h('div', { class: 'sort-dialog wide-dialog' },
      h('p', { class: 'dialog-text' }, `Sorting ${rangeText(block)}.`),
      h('label', {}, headIn, ' My data has headers'), levels, add),
    buttons: [{ label: 'OK', value: true, primary: true }, { label: 'Cancel', value: false }],
    cancel: false,
  });
  done.abort();
  if (!ok) {
    grid.focus();
    return;
  }
  const keys = [...levels.children].map(row => {
    const sels = row.querySelectorAll('select');
    return { col: Number((sels[0] as HTMLSelectElement).value), ascending: (sels[1] as HTMLSelectElement).value === 'asc' };
  });
  const r = headIn.checked ? { ...block, r0: block.r0 + 1 } : block;
  try {
    if (r.r1 >= r.r0) wb.sortBy(wb.active, r, keys);
    ctx.onChange();
  } catch (error) {
    void ctx.report(error);
  }
  grid.focus();
}

const NUMBER_OPS: Array<[string, string]> = [['equal', 'equals'], ['notEqual', 'does not equal'], ['greaterThan', 'is greater than'], ['greaterThanOrEqual', 'is greater than or equal to'], ['lessThan', 'is less than'], ['lessThanOrEqual', 'is less than or equal to']];
const TEXT_OPS: Array<[string, string]> = [['equal', 'equals'], ['notEqual', 'does not equal'], ['begins', 'begins with'], ['ends', 'ends with'], ['contains', 'contains'], ['notContains', 'does not contain']];

/** A text condition as Excel stores it (begins with "a" is equal to "a*"). */
function textCond(op: string, value: string): FilterCond {
  const v = value.replace(/[*?~]/g, m => `~${m}`);
  switch (op) {
    case 'begins': return { op: 'equal', val: `${v}*` };
    case 'ends': return { op: 'equal', val: `*${v}` };
    case 'contains': return { op: 'equal', val: `*${v}*` };
    case 'notContains': return { op: 'notEqual', val: `*${v}*` };
    default: return { op: op as FilterCond['op'], val: value };
  }
}

/** The custom filter screen: one or two conditions, both or either. */
async function customFilter(ctx: SheetContext, col: number, kind: 'number' | 'text', firstOp: string, preset?: { op2?: string }): Promise<void> {
  const { shell, wb, grid } = ctx;
  const ops = kind === 'number' ? NUMBER_OPS : TEXT_OPS;
  const opSel = (v: string) => {
    const sel = h('select', { class: 'field', 'aria-label': 'Condition' }, h('option', { value: '' }, '(none)'), ...ops.map(([k, label]) => h('option', { value: k }, label)));
    sel.value = v;
    return sel;
  };
  const op1 = opSel(firstOp);
  const v1 = h('input', { type: 'text', class: 'field', 'aria-label': 'Value', autocomplete: 'off' });
  const op2 = opSel(preset?.op2 ?? '');
  const v2 = h('input', { type: 'text', class: 'field', 'aria-label': 'Second value', autocomplete: 'off' });
  const and = h('input', { type: 'radio', name: 'cf-join', checked: true });
  const or = h('input', { type: 'radio', name: 'cf-join' });
  const f = wb.sheets[wb.active].filter!;
  const ok = await shell.dialogs.ask<boolean>({
    title: `Show rows where ${heading(ctx, f.range, col, true)}`,
    body: h('div', { class: 'name-dialog' },
      h('div', { class: 'cf-pair' }, op1, v1),
      h('div', { class: 'cf-pair' }, h('label', {}, and, ' And'), h('label', {}, or, ' Or')),
      h('div', { class: 'cf-pair' }, op2, v2),
      h('p', { class: 'dialog-detail' }, kind === 'text' ? 'Use ? for any one character and * for any run of characters.' : 'Numbers are compared by size.')),
    buttons: [{ label: 'OK', value: true, primary: true }, { label: 'Cancel', value: false }],
    cancel: false,
    focus: () => v1,
  });
  if (!ok) {
    grid.focus();
    return;
  }
  const make = (op: string, value: string): FilterCond | null => (op ? (kind === 'number' ? { op: op as FilterCond['op'], val: value.trim() } : textCond(op, value)) : null);
  const a = make(op1.value, v1.value);
  const b = make(op2.value, v2.value);
  if (!a && !b) return;
  const rule: FilterRule = { kind: 'custom', and: and.checked, a: (a ?? b)!, ...(a && b ? { b } : {}) };
  try {
    wb.filterRule(wb.active, col, rule);
    ctx.onChange();
  } catch (error) {
    void ctx.report(error);
  }
  grid.focus();
}

/** Top 10: the highest (or lowest) N values, or N per cent of them. */
async function topFilter(ctx: SheetContext, col: number): Promise<void> {
  const { shell, wb, grid } = ctx;
  const which = h('select', { class: 'field', 'aria-label': 'Top or bottom' }, h('option', { value: 'top' }, 'Top'), h('option', { value: 'bottom' }, 'Bottom'));
  const n = h('input', { type: 'number', class: 'field cf-n', min: 1, max: 500, value: '10', 'aria-label': 'How many' });
  const unit = h('select', { class: 'field', 'aria-label': 'Items or per cent' }, h('option', { value: 'items' }, 'items'), h('option', { value: 'percent' }, 'per cent'));
  const ok = await shell.dialogs.ask<boolean>({
    title: 'Top 10 filter',
    body: h('div', { class: 'cf-pair' }, which, n, unit),
    buttons: [{ label: 'OK', value: true, primary: true }, { label: 'Cancel', value: false }],
    cancel: false,
    primaryEnabled: () => Number(n.value) >= 1 && Number(n.value) <= 500,
  });
  if (!ok) return;
  wb.filterRule(wb.active, col, { kind: 'top', top: which.value === 'top', n: Math.trunc(Number(n.value)), percent: unit.value === 'percent' });
  ctx.onChange();
  grid.focus();
}

/** The Number filters or Text filters menu of a filter column (from its ▾ list). */
export function filterRuleMenu(ctx: SheetContext, col: number): MenuItem[] {
  const { wb } = ctx;
  const f = wb.sheets[wb.active].filter;
  if (!f) return [];
  let nums = 0;
  let texts = 0;
  for (let r = f.range.r0 + 1; r <= f.range.r1; r++) {
    const v = wb.value(wb.active, col, r);
    if (typeof v === 'number') nums++;
    else if (typeof v === 'string') texts++;
  }
  if (nums >= texts) {
    return [
      ...NUMBER_OPS.map(([op, label]) => ({ label: `${label[0].toUpperCase()}${label.slice(1)}...`, action: () => void customFilter(ctx, col, 'number', op) })),
      { label: 'Between...', action: () => void customFilter(ctx, col, 'number', 'greaterThanOrEqual', { op2: 'lessThanOrEqual' }) },
      { separator: true },
      { label: 'Top 10...', action: () => void topFilter(ctx, col) },
      { label: 'Above average', action: () => { wb.filterRule(wb.active, col, { kind: 'average', above: true }); ctx.onChange(); } },
      { label: 'Below average', action: () => { wb.filterRule(wb.active, col, { kind: 'average', above: false }); ctx.onChange(); } },
    ];
  }
  return TEXT_OPS.map(([op, label]) => ({ label: `${label[0].toUpperCase()}${label.slice(1)}...`, action: () => void customFilter(ctx, col, 'text', op) }));
}

/** Data > Remove duplicates: which columns decide that two rows are the same. */
export async function removeDuplicatesDialog(ctx: SheetContext): Promise<void> {
  const { shell, wb, grid } = ctx;
  if (!grid.commit()) return;
  const block = dataBlock(ctx);
  if (block.r1 <= block.r0) {
    await shell.dialogs.alert('Nothing to check here', 'Click a cell in a table of data (or select the rows to check), then choose Remove duplicates.');
    return;
  }
  const headIn = h('input', { type: 'checkbox' });
  headIn.checked = looksLikeHeader(ctx, block);
  const ticks = Array.from({ length: block.c1 - block.c0 + 1 }, (_, i) => {
    const box = h('input', { type: 'checkbox', checked: true });
    const label = h('span', {}, heading(ctx, block, block.c0 + i, headIn.checked));
    return { col: block.c0 + i, box, label, row: h('label', { class: 'dup-col' }, box, ' ', label) };
  });
  const done = new AbortController();
  on(headIn, 'change', () => ticks.forEach(t => {
    t.label.textContent = heading(ctx, block, t.col, headIn.checked);
  }), done.signal);
  const ok = await shell.dialogs.ask<boolean>({
    title: 'Remove duplicates',
    body: h('div', { class: 'name-dialog' },
      h('p', { class: 'dialog-text' }, `Rows of ${rangeText(block)} that repeat an earlier row in the ticked columns are taken out; the rows below move up.`),
      h('label', {}, headIn, ' My data has headers'),
      h('div', { class: 'dup-cols' }, ...ticks.map(t => t.row))),
    buttons: [{ label: 'OK', value: true, primary: true }, { label: 'Cancel', value: false }],
    cancel: false,
    primaryEnabled: () => ticks.some(t => t.box.checked),
  });
  done.abort();
  if (!ok) {
    grid.focus();
    return;
  }
  try {
    const got = wb.removeDuplicates(wb.active, block, ticks.filter(t => t.box.checked).map(t => t.col), headIn.checked);
    ctx.onChange();
    await shell.dialogs.alert(got.removed ? 'Duplicates removed' : 'No duplicates found', got.removed ? `${got.removed.toLocaleString()} duplicate ${got.removed === 1 ? 'row was' : 'rows were'} taken out; ${got.kept.toLocaleString()} unique ${got.kept === 1 ? 'row remains' : 'rows remain'}. Ctrl+Z puts them back.` : `Every row of ${rangeText(block)} is different in the ticked columns.`);
  } catch (error) {
    void ctx.report(error);
  }
  grid.focus();
}

/** Data > Text to columns: split the text of one column at a delimiter into the columns to its right. */
export async function textToColumnsDialog(ctx: SheetContext): Promise<void> {
  const { shell, wb, grid } = ctx;
  if (!grid.commit()) return;
  const s = grid.sel();
  if (s.c1 !== s.c0) {
    await shell.dialogs.alert('Select one column', 'Text to columns splits one column at a time. Select cells in a single column, then try again.');
    return;
  }
  const used = wb.usedBounds(wb.active);
  const r0 = s.r0;
  const r1 = Math.min(s.r1, Math.max(s.r0, used.rows - 1));
  const box = (label: string, on1 = false) => {
    const b = h('input', { type: 'checkbox', checked: on1 });
    return { b, row: h('label', {}, b, ` ${label}`) };
  };
  const tab = box('Tab', true);
  const semi = box('Semicolon');
  const comma = box('Comma', true);
  const space = box('Space');
  const other = box('Other:');
  const otherIn = h('input', { type: 'text', class: 'field cf-n', maxlength: 1, 'aria-label': 'Other delimiter' });
  const consecutive = box('Treat delimiters next to each other as one');
  const quote = h('select', { class: 'field', 'aria-label': 'Text qualifier' }, h('option', { value: '"' }, '" (double quote)'), h('option', { value: "'" }, "' (single quote)"), h('option', { value: '' }, '(none)'));
  const destIn = h('input', { type: 'text', class: 'field', value: addressOf(s.c0, r0), 'aria-label': 'Destination', autocomplete: 'off' });
  const sample = h('pre', { class: 'ttc-sample' });
  const delims = () => [tab.b.checked ? '\t' : '', semi.b.checked ? ';' : '', comma.b.checked ? ',' : '', space.b.checked ? ' ' : '', other.b.checked ? otherIn.value : ''].filter(Boolean);
  const done = new AbortController();
  const preview = () => {
    const lines: string[] = [];
    for (let r = r0; r <= Math.min(r1, r0 + 4); r++) {
      const text = wb.display(wb.active, s.c0, r);
      let parts = [text];
      for (const d of delims()) parts = parts.flatMap(p => p.split(d));
      if (consecutive.b.checked) parts = parts.filter((p, i) => p !== '' || i === 0);
      lines.push(parts.map(p => `[${p}]`).join(' '));
    }
    sample.textContent = lines.join('\n');
  };
  for (const el of [tab.b, semi.b, comma.b, space.b, other.b, consecutive.b]) on(el, 'change', preview, done.signal);
  on(otherIn, 'input', preview, done.signal);
  preview();
  const ok = await shell.dialogs.ask<boolean>({
    title: 'Text to columns',
    body: h('div', { class: 'name-dialog wide-dialog' },
      h('p', { class: 'dialog-text' }, `Split ${rangeText({ c0: s.c0, r0, c1: s.c0, r1 })} at:`),
      h('div', { class: 'dup-cols' }, tab.row, semi.row, comma.row, space.row, h('span', {}, other.row, ' ', otherIn)),
      consecutive.row,
      h('label', { class: 'dialog-label' }, 'Text in quotes is kept whole (text qualifier)', quote),
      h('label', { class: 'dialog-label' }, 'Put the pieces from (destination)', destIn),
      h('p', { class: 'dialog-detail' }, 'Preview (each piece in brackets):'), sample),
    buttons: [{ label: 'Split', value: true, primary: true }, { label: 'Cancel', value: false }],
    cancel: false,
    primaryEnabled: () => delims().length > 0,
  });
  done.abort();
  if (!ok) {
    grid.focus();
    return;
  }
  const dest = readRanges(destIn.value);
  try {
    if (!dest) throw new SyntaxProblem('The destination is not a cell address. Type one such as B2.');
    // Cells to the right that would be written over: asked first, as Excel asks.
    let busy = false;
    for (let r = r0; r <= r1 && !busy; r++) for (let c = dest[0].c0 + 1; c < dest[0].c0 + 30 && !busy; c++) busy = c !== s.c0 && wb.value(wb.active, c, dest[0].r0 + r - r0) !== null;
    if (busy && !(await shell.dialogs.confirm({ title: 'Replace what is there?', text: 'There is already data in the cells the pieces go into. Replace it? Ctrl+Z takes it back.', ok: 'Replace' }))) return;
    wb.splitText(wb.active, s.c0, r0, r1, { delims: delims(), consecutive: consecutive.b.checked, quote: quote.value || null }, { col: dest[0].c0, row: dest[0].r0 });
    grid.fitRows();
    ctx.onChange();
  } catch (error) {
    void ctx.report(error);
  }
  grid.focus();
}
