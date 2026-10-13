// The Formulas tab's screens: Insert Function (find a function by what it does, see what goes in its brackets), the
// function menus by kind, Name Manager (names for cells and values: add, change, delete), Define Name, Create names from
// the selection's labels, and Use in formula. The names themselves live in workbook.ts.
import { h, on } from '../../core/dom.ts';
import type { MenuItem } from '../../shell/menu.ts';
import type { SheetContext } from './charts-ui.ts';
import { FN_CATEGORIES, FN_HELP, helpFor, type FnCategory } from './fn-help.ts';
import { FUNCTION_NAMES } from './formula.ts';
import { colName, quoteSheet, SyntaxProblem } from './refs.ts';
import { nameRuleProblem, type DefinedName, type Range } from './workbook.ts';

/** The selected cells as a name's formula would hold them: Sheet1!$A$2:$B$9. */
export function selectionRef(ctx: SheetContext, r: Range = ctx.grid.sel()): string {
  const abs = (c: number, row: number) => `$${colName(c)}$${row + 1}`;
  return `${quoteSheet(ctx.wb.sheets[ctx.wb.active].name)}!${abs(r.c0, r.r0)}${r.c1 > r.c0 || r.r1 > r.r0 ? `:${abs(r.c1, r.r1)}` : ''}`;
}

/** Puts a function in the active cell (or in the formula being typed), with its opening bracket. */
export function insertFunction(ctx: SheetContext, name: string): void {
  if (ctx.grid.editing()) ctx.grid.edit(`${name}(`);
  else ctx.grid.edit(`=${name}(`);
}

/** Formulas > Insert Function (Shift+F3): search by words or pick a kind, read what a function does, put it in. */
export async function insertFunctionDialog(ctx: SheetContext): Promise<void> {
  const { shell, grid } = ctx;
  const search = h('input', { type: 'search', class: 'field', placeholder: 'What do you want to do? (for example: add up, look up, average)', 'aria-label': 'Search for a function', autocomplete: 'off', spellcheck: false });
  const kind = h('select', { class: 'field', 'aria-label': 'Kind of function' }, h('option', { value: '' }, 'All kinds'), ...FN_CATEGORIES.map(c => h('option', { value: c }, c)));
  const list = h('select', { class: 'field fn-list', size: 10, 'aria-label': 'Functions' });
  const syntax = h('p', { class: 'fn-syntax' });
  const about = h('p', { class: 'fn-about' });
  const all = FUNCTION_NAMES.map(n => helpFor(n) ?? { name: n, category: 'Maths and trig' as FnCategory, args: '', text: '' });
  const fill = () => {
    const q = search.value.trim().toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    const hits = all.filter(f => (!kind.value || f.category === kind.value) && words.every(w => f.name.toLowerCase().includes(w) || f.text.toLowerCase().includes(w)));
    // A name that starts with what was typed comes first.
    hits.sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name));
    list.replaceChildren(...hits.map(f => h('option', { value: f.name }, f.name)));
    if (hits.length) list.selectedIndex = 0;
    show();
  };
  const show = () => {
    const f = list.value ? FN_HELP.get(list.value) ?? null : null;
    syntax.textContent = f ? `${f.name}(${f.args})` : list.value ? `${list.value}()` : 'No function matches. Try other words, or All kinds.';
    about.textContent = f ? `${f.text} (${f.category})` : '';
  };
  const done = new AbortController();
  on(search, 'input', fill, done.signal);
  on(kind, 'change', fill, done.signal);
  on(list, 'change', show, done.signal);
  fill();
  const answer = await shell.dialogs.ask<boolean>({
    title: 'Insert function',
    body: h('div', { class: 'fn-dialog' },
      h('label', { class: 'dialog-label' }, 'Search for a function', search),
      h('label', { class: 'dialog-label' }, 'Or pick a kind', kind),
      h('label', { class: 'dialog-label' }, 'Functions', list),
      syntax, about,
      h('p', { class: 'dialog-detail' }, 'Square brackets mark what may be left out. While you type a formula, a list offers functions as you go: Tab puts the chosen one in.')),
    buttons: [{ label: 'Insert', value: true, primary: true }, { label: 'Cancel', value: false }],
    cancel: false,
    primaryEnabled: () => !!list.value,
    focus: () => search,
  });
  done.abort();
  const name = list.value;
  if (answer && name) insertFunction(ctx, name);
  else if (!grid.editing()) grid.focus();
}

/** One menu of the functions of a kind (Formulas > Financial, Logical, Text...). */
export function functionMenu(ctx: SheetContext, category: FnCategory): MenuItem[] {
  return FUNCTION_NAMES.filter(n => helpFor(n)?.category === category).map(n => ({ label: n, hint: helpFor(n)!.args ? '' : '()', action: () => insertFunction(ctx, n) }));
}

/** AutoSum's choices: the formula for the figures above (or to the left of) the active cell. */
export function autoSumMenu(ctx: SheetContext): MenuItem[] {
  const pick = (fn: string) => () => {
    const { grid, wb } = ctx;
    if (fn === 'SUM') {
      grid.autoSum();
      return;
    }
    // The figures above, as AutoSum finds them, in another function.
    const a = grid.active();
    let above = 0;
    while (a.row - above - 1 >= 0 && typeof wb.value(wb.active, a.col, a.row - above - 1) === 'number') above++;
    let left = 0;
    while (a.col - left - 1 >= 0 && typeof wb.value(wb.active, a.col - left - 1, a.row) === 'number') left++;
    const range = above ? `${colName(a.col)}${a.row - above + 1}:${colName(a.col)}${a.row}` : left ? `${colName(a.col - left)}${a.row + 1}:${colName(a.col - 1)}${a.row + 1}` : '';
    grid.edit(`=${fn}(${range}`);
  };
  return [
    { label: 'Sum', hint: 'Alt+=', action: pick('SUM') },
    { label: 'Average', action: pick('AVERAGE') },
    { label: 'Count numbers', action: pick('COUNT') },
    { label: 'Max', action: pick('MAX') },
    { label: 'Min', action: pick('MIN') },
    { separator: true },
    { label: 'More functions...', hint: 'Shift+F3', action: () => void insertFunctionDialog(ctx) },
  ];
}

/** New name, or a change to one: its name, where it counts (the workbook or a sheet), a note, and what it stands for. */
export async function nameDialog(ctx: SheetContext, existing?: DefinedName): Promise<boolean> {
  const { shell, wb } = ctx;
  // A first guess at a name: the label above or left of the selection, as Excel offers it.
  const guess = (): string => {
    const s = ctx.grid.sel();
    for (const [c, r] of [[s.c0, s.r0 - 1], [s.c0 - 1, s.r0]]) {
      if (c < 0 || r < 0) continue;
      const v = wb.value(wb.active, c, r);
      if (typeof v === 'string' && v.trim()) {
        const made = labelName(v);
        if (made && !wb.nameProblem(made)) return made;
      }
    }
    return '';
  };
  let values = { name: existing?.name ?? guess(), scope: existing?.scope ?? '', comment: existing?.comment ?? '', ref: existing ? `=${existing.ref}` : `=${selectionRef(ctx)}` };
  for (;;) {
    const nameIn = h('input', { type: 'text', class: 'field', value: values.name, 'aria-label': 'Name', autocomplete: 'off', spellcheck: false });
    const scopeIn = h('select', { class: 'field', 'aria-label': 'Where the name counts', disabled: !!existing },
      h('option', { value: '' }, 'The whole workbook'), ...wb.sheets.map(sh => h('option', { value: sh.name }, `Only on ${sh.name}`)));
    scopeIn.value = values.scope;
    const noteIn = h('input', { type: 'text', class: 'field', value: values.comment, 'aria-label': 'Comment', autocomplete: 'off', maxlength: 255 });
    const refIn = h('input', { type: 'text', class: 'field', value: values.ref, 'aria-label': 'Stands for', autocomplete: 'off', spellcheck: false });
    const problem = h('p', { class: 'dialog-problem', role: 'alert' });
    const check = () => {
      const why = nameRuleProblem(nameIn.value.trim());
      problem.textContent = nameIn.value.trim() ? why ?? '' : '';
      return !why && !!refIn.value.trim();
    };
    const done = new AbortController();
    on(nameIn, 'input', check, done.signal);
    on(refIn, 'input', check, done.signal);
    check();
    const ok = await shell.dialogs.ask<boolean>({
      title: existing ? `Edit name “${existing.name}”` : 'New name',
      body: h('div', { class: 'name-dialog' },
        h('label', { class: 'dialog-label' }, 'Name (letters, numbers, _ and full stops; no spaces)', nameIn),
        h('label', { class: 'dialog-label' }, 'Where it counts', scopeIn),
        h('label', { class: 'dialog-label' }, 'Comment (optional)', noteIn),
        h('label', { class: 'dialog-label' }, 'Stands for (cells such as =Sheet1!$A$2:$A$40, or a value such as =0.15)', refIn),
        problem),
      buttons: [{ label: 'OK', value: true, primary: true }, { label: 'Cancel', value: false }],
      cancel: false,
      primaryEnabled: check,
      focus: () => nameIn,
    });
    done.abort();
    if (!ok) return false;
    values = { name: nameIn.value.trim(), scope: scopeIn.value, comment: noteIn.value.trim(), ref: refIn.value.trim() };
    try {
      if (existing) wb.editName(existing, values.name, values.ref, values.comment || undefined);
      else wb.setName(values.name, values.ref, values.scope || undefined, values.comment || undefined);
      ctx.onChange();
      return true;
    } catch (error) {
      // Opened again with what was typed still in it, saying what is wrong.
      const why = error instanceof SyntaxProblem ? error.message : 'That could not be done.';
      await shell.dialogs.alert('That name could not be kept', why, 'Fix it and press OK again.');
    }
  }
}

/** Formulas > Name Manager: every name, what it stands for, where it counts; New, Edit and Delete. */
export async function nameManager(ctx: SheetContext): Promise<void> {
  const { shell, wb } = ctx;
  for (;;) {
    const rows = [...wb.names].sort((a, b) => a.name.localeCompare(b.name) || (a.scope ?? '').localeCompare(b.scope ?? ''));
    const list = h('select', { class: 'field name-list', size: Math.max(4, Math.min(12, rows.length)), 'aria-label': 'Names' },
      ...rows.map((n, i) => {
        const v = wb.evalFormula(wb.active, n.ref);
        const shown = Array.isArray(v) ? `${v.length} x ${v[0]?.length ?? 0} cells` : v === null ? '(empty)' : typeof v === 'object' ? v.code : String(v);
        return h('option', { value: String(i) }, `${n.name}    =${n.ref}    ${n.scope ? `(${n.scope} only)` : '(workbook)'}    ${shown}${n.comment ? `    ${n.comment}` : ''}`);
      }));
    if (rows.length) list.selectedIndex = 0;
    const answer = await shell.dialogs.ask<'new' | 'edit' | 'delete' | null>({
      title: 'Name manager',
      body: h('div', { class: 'name-manager' },
        rows.length ? list : h('p', { class: 'dialog-text' }, 'This workbook has no names yet. A name stands for cells or a value, so a formula can say =SUM(Sales) instead of =SUM(Sheet1!$B$2:$B$40).'),
        h('p', { class: 'dialog-detail' }, 'Each line: the name, what it stands for, where it counts, and what it holds now.')),
      buttons: [{ label: 'New...', value: 'new', primary: true }, ...(rows.length ? [{ label: 'Edit...', value: 'edit' as const }, { label: 'Delete', value: 'delete' as const, danger: true }] : []), { label: 'Close', value: null }],
      cancel: null,
      focus: () => (rows.length ? list : null),
    });
    const picked = rows[Number(list.value)];
    if (answer === null) break;
    if (answer === 'new') await nameDialog(ctx);
    else if (answer === 'edit' && picked) await nameDialog(ctx, picked);
    else if (answer === 'delete' && picked) {
      const sure = await shell.dialogs.confirm({ title: `Delete the name “${picked.name}”?`, text: 'Formulas that use it will show #NAME? until it is given again. Ctrl+Z takes this back.', ok: 'Delete', danger: true });
      if (sure) {
        wb.deleteName(picked);
        ctx.onChange();
      }
    }
  }
  ctx.grid.focus();
}

/** A label from a cell as a name Excel would make of it: spaces and other characters become _, a digit start gets _. */
export function labelName(label: string): string | null {
  let n = label.trim().replace(/[^A-Za-z0-9_.]+/g, '_').replace(/^_+|_+$/g, '');
  if (!n) return null;
  if (!/^[A-Za-z_]/.test(n)) n = `_${n}`;
  if (nameRuleProblem(n)) n = `${n}_`;
  return nameRuleProblem(n) ? null : n.slice(0, 255);
}

/** Formulas > Create from selection: names from the labels in the selection's top row, left column... */
export async function createFromSelection(ctx: SheetContext): Promise<void> {
  const { shell, wb, grid } = ctx;
  const s = grid.sel();
  const used = wb.usedBounds(wb.active);
  const r = { ...s, r1: Math.min(s.r1, Math.max(s.r0, used.rows - 1)), c1: Math.min(s.c1, Math.max(s.c0, used.cols - 1)) };
  if (r.r1 === r.r0 && r.c1 === r.c0) {
    await shell.dialogs.alert('Select a table first', 'Select cells with labels in their top row or left column (and the figures under or beside them), then choose Create from selection.');
    return;
  }
  const textAt = (c: number, row: number) => wb.value(wb.active, c, row);
  const top = h('input', { type: 'checkbox' });
  const left = h('input', { type: 'checkbox' });
  const bottom = h('input', { type: 'checkbox' });
  const right = h('input', { type: 'checkbox' });
  // Ticked as Excel guesses: words along the top, words down the left.
  top.checked = [...Array(r.c1 - r.c0 + 1).keys()].some(i => typeof textAt(r.c0 + i, r.r0) === 'string');
  left.checked = [...Array(r.r1 - r.r0 + 1).keys()].some(i => typeof textAt(r.c0, r.r0 + i) === 'string') && typeof textAt(r.c0, r.r1) === 'string';
  const ok = await shell.dialogs.ask<boolean>({
    title: 'Create names from the selection',
    body: h('div', { class: 'name-dialog' },
      h('p', { class: 'dialog-text' }, 'Make names from the labels in:'),
      h('label', {}, top, ' Top row'), h('label', {}, left, ' Left column'), h('label', {}, bottom, ' Bottom row'), h('label', {}, right, ' Right column')),
    buttons: [{ label: 'OK', value: true, primary: true }, { label: 'Cancel', value: false }],
    cancel: false,
  });
  if (!ok) return;
  const body = { c0: r.c0 + (left.checked ? 1 : 0), c1: r.c1 - (right.checked ? 1 : 0), r0: r.r0 + (top.checked ? 1 : 0), r1: r.r1 - (bottom.checked ? 1 : 0) };
  if (body.c1 < body.c0 || body.r1 < body.r0) {
    await shell.dialogs.alert('Nothing left to name', 'With those labels taken off, the selection has no cells left. Select the labels and the figures together.');
    return;
  }
  const made: Array<{ name: string; ref: string }> = [];
  const add = (label: unknown, block: Range) => {
    if (typeof label !== 'string') return;
    const n = labelName(label);
    if (n && !made.some(m => m.name.toLowerCase() === n.toLowerCase())) made.push({ name: n, ref: selectionRef(ctx, block) });
  };
  if (top.checked) for (let c = body.c0; c <= body.c1; c++) add(textAt(c, r.r0), { c0: c, c1: c, r0: body.r0, r1: body.r1 });
  if (bottom.checked) for (let c = body.c0; c <= body.c1; c++) add(textAt(c, r.r1), { c0: c, c1: c, r0: body.r0, r1: body.r1 });
  if (left.checked) for (let row = body.r0; row <= body.r1; row++) add(textAt(r.c0, row), { c0: body.c0, c1: body.c1, r0: row, r1: row });
  if (right.checked) for (let row = body.r0; row <= body.r1; row++) add(textAt(r.c1, row), { c0: body.c0, c1: body.c1, r0: row, r1: row });
  let kept = 0;
  const skipped: string[] = [];
  for (const m of made) {
    const old = wb.names.find(n => n.scope === undefined && n.name.toLowerCase() === m.name.toLowerCase());
    try {
      if (old) wb.editName(old, old.name, m.ref, old.comment);
      else wb.setName(m.name, m.ref);
      kept++;
    } catch {
      skipped.push(m.name);
    }
  }
  ctx.onChange();
  shell.toast(kept ? `Made ${kept} ${kept === 1 ? 'name' : 'names'}: ${made.map(m => m.name).slice(0, 6).join(', ')}${made.length > 6 ? '...' : ''}.${skipped.length ? ` Not made: ${skipped.join(', ')}.` : ''}` : 'No labels were found to make names from.');
}

/** Formulas > Use in formula: the names, to put in the formula being typed (or start one). */
export function useInFormulaMenu(ctx: SheetContext): MenuItem[] {
  const names = [...ctx.wb.names].sort((a, b) => a.name.localeCompare(b.name));
  if (!names.length) return [{ label: 'No names yet (Define name makes one)', disabled: true, action: () => {} }];
  return names.map(n => ({ label: n.name, hint: n.scope ? `${n.scope} only` : '', action: () => ctx.grid.edit(ctx.grid.editing() ? n.name : `=${n.name}`) }));
}
