// The screens for conditional formatting (Home > Conditional Formatting: highlight rules, top and bottom rules, data
// bars, colour scales, a rule with a formula, clearing, and Manage rules) and for data validation (Data > Data
// Validation). The rules themselves are in condfmt.ts and validate.ts.
import { css, h, on } from '../../core/dom.ts';
import type { MenuItem } from '../../shell/menu.ts';
import type { SheetContext } from './charts-ui.ts';
import { describeRule, OP_WORDS, PRESETS, type CellOp, type CfEntry, type CfFormat, type CfRule } from './condfmt.ts';
import { parseFormula } from './formula.ts';
import { addressOf, parseCellRef, SyntaxProblem } from './refs.ts';
import { DV_LABEL, DV_TYPES, itemsFormula, literalItems, newValidation, validationAt, type DvType, type Validation } from './validate.ts';
import { parseEntry, type Range } from './workbook.ts';

const rangeText = (r: Range) => (r.c0 === r.c1 && r.r0 === r.r1 ? addressOf(r.c0, r.r0) : `${addressOf(r.c0, r.r0)}:${addressOf(r.c1, r.r1)}`);

/** "A1:B5, D2" as blocks; null when a part does not read. */
export function readRanges(text: string): Range[] | null {
  const out: Range[] = [];
  for (const part of text.split(/[,;]/).map(t => t.trim().replace(/\$/g, '')).filter(Boolean)) {
    const [a, b] = part.split(':');
    const ra = parseCellRef(a);
    const rb = b === undefined ? ra : parseCellRef(b);
    if (!ra || !rb) return null;
    out.push({ c0: Math.min(ra.col, rb.col), r0: Math.min(ra.row, rb.row), c1: Math.max(ra.col, rb.col), r1: Math.max(ra.row, rb.row) });
  }
  return out.length ? out : null;
}

/**
 * What a person typed as a value for a rule, as the formula the rule keeps: =B1 (or any formula) as it is; a number or a
 * date as its number; anything else as text in quotes. Null when a formula does not read.
 */
export function valueFormula(typed: string, order: Parameters<typeof parseEntry>[1]): string | null {
  const t = typed.trim();
  if (!t) return null;
  if (t.startsWith('=')) {
    try {
      parseFormula(t.slice(1));
      return t.slice(1);
    } catch {
      return null;
    }
  }
  let v: unknown;
  try {
    v = parseEntry(t, order).cell?.v;
  } catch {
    v = t;
  }
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return `"${t.replace(/"/g, '""')}"`;
}

/** A rule's formula as a person would type it back: a number or text as itself, anything else with "=". */
export function formulaShown(f: string): string {
  if (!f) return '';
  if (/^-?\d+(\.\d+)?(e[-+]?\d+)?$/i.test(f)) return f;
  const m = /^"((?:[^"]|"")*)"$/.exec(f);
  if (m) return m[1].replace(/""/g, '"');
  return `=${f}`;
}

/** A small sample of how a rule makes cells look. */
function sample(fmt: CfFormat): HTMLElement {
  const el = h('span', { class: 'cf-sample' }, 'AaBbCc 123');
  css(el, { background: fmt.fill ?? '#ffffff', color: fmt.color ?? '#000000', 'font-weight': fmt.b ? 700 : 400, 'font-style': fmt.i ? 'italic' : 'normal', 'text-decoration': fmt.u ? 'underline' : 'none' });
  return el;
}

const presetSelect = (): HTMLSelectElement => h('select', { class: 'field', 'aria-label': 'Format with' }, ...PRESETS.map((p, i) => h('option', { value: String(i) }, p.label)));

const BAR_COLOURS: Array<[string, string]> = [['Blue', '#638ec6'], ['Green', '#63c384'], ['Red', '#ff555a'], ['Orange', '#ffb628'], ['Light blue', '#008aef'], ['Purple', '#d6007b']];
const SCALES: Array<[string, string[]]> = [
  ['Green - yellow - red (highest green)', ['#f8696b', '#ffeb84', '#63be7b']],
  ['Red - yellow - green (highest red)', ['#63be7b', '#ffeb84', '#f8696b']],
  ['Blue - white - red (highest red)', ['#5a8ac6', '#fcfcff', '#f8696b']],
  ['Red - white - blue (highest blue)', ['#f8696b', '#fcfcff', '#5a8ac6']],
  ['White - green', ['#fcfcff', '#63be7b']],
  ['White - red', ['#fcfcff', '#f8696b']],
];

export function conditionalMenu(ctx: SheetContext): MenuItem[] {
  const { wb, grid } = ctx;
  const add = (rule: CfRule) => {
    if (!grid.commit()) return;
    try {
      wb.addCf(wb.active, { ranges: [grid.sel()], rule });
      ctx.onChange();
    } catch (error) {
      void ctx.report(error);
    }
  };
  const ask = (kind: string) => void highlightDialog(ctx, kind);
  return [
    { label: 'Highlight cells rules', submenu: [
      { label: 'Greater than...', action: () => ask('gt') },
      { label: 'Less than...', action: () => ask('lt') },
      { label: 'Between...', action: () => ask('between') },
      { label: 'Equal to...', action: () => ask('eq') },
      { label: 'Text that contains...', action: () => ask('text') },
      { label: 'Duplicate or unique values...', action: () => ask('dup') },
      { label: 'Blank cells...', action: () => ask('blank') },
    ] },
    { label: 'Top and bottom rules', submenu: [
      { label: 'Top 10 items...', action: () => ask('top') },
      { label: 'Top 10%...', action: () => ask('top%') },
      { label: 'Bottom 10 items...', action: () => ask('bottom') },
      { label: 'Bottom 10%...', action: () => ask('bottom%') },
      { label: 'Above average...', action: () => ask('above') },
      { label: 'Below average...', action: () => ask('below') },
    ] },
    { label: 'Data bars', submenu: BAR_COLOURS.map(([name, colour]) => ({ label: `${name} data bar`, action: () => add({ t: 'bar', colour }) })) },
    { label: 'Colour scales', submenu: SCALES.map(([name, colours]) => ({ label: name, action: () => add({ t: 'scale', colours }) })) },
    { separator: true },
    { label: 'New rule with a formula...', action: () => ask('expr') },
    { label: 'Clear rules', submenu: [
      { label: 'From the selected cells', action: () => { wb.clearCf(wb.active, grid.sel()); ctx.onChange(); } },
      { label: 'From the entire sheet', disabled: !wb.sheets[wb.active].cf.length, action: () => { wb.clearCf(wb.active, null); ctx.onChange(); } },
    ] },
    { label: 'Manage rules...', action: () => void manageRules(ctx) },
  ];
}

/** The dialog for one kind of highlight or top/bottom rule: its value(s) and how matching cells look. */
async function highlightDialog(ctx: SheetContext, kind: string): Promise<void> {
  const { shell, wb, grid } = ctx;
  if (!grid.commit()) return;
  const range = grid.sel();
  const a = grid.active();
  const done = new AbortController();
  const v1 = h('input', { type: 'text', class: 'field', autocomplete: 'off', spellcheck: false });
  const v2 = h('input', { type: 'text', class: 'field', autocomplete: 'off', spellcheck: false, 'aria-label': 'and' });
  const n = h('input', { type: 'number', class: 'field cf-n', min: 1, max: 1000, value: 10 });
  const which = h('select', { class: 'field', 'aria-label': 'Values' }, h('option', { value: 'dup' }, 'Duplicate'), h('option', { value: 'unique' }, 'Unique'));
  const blankSel = h('select', { class: 'field', 'aria-label': 'Cells' }, h('option', { value: 'blank' }, 'Blank'), h('option', { value: 'not' }, 'Not blank'));
  const preset = presetSelect();
  const look = h('span', { class: 'cf-sample-wrap' });
  const problem = h('p', { class: 'dialog-problem', role: 'alert' });
  const showLook = () => look.replaceChildren(sample(PRESETS[Number(preset.value)].fmt));
  on(preset, 'change', showLook, done.signal);
  showLook();
  const current = wb.editText(wb.active, a.col, a.row);
  const titles: Record<string, string> = {
    gt: 'Greater than', lt: 'Less than', between: 'Between', eq: 'Equal to', text: 'Text that contains', dup: 'Duplicate values', blank: 'Blank cells',
    top: 'Top 10 items', 'top%': 'Top 10%', bottom: 'Bottom 10 items', 'bottom%': 'Bottom 10%', above: 'Above average', below: 'Below average', expr: 'New rule with a formula',
  };
  const parts: Node[] = [];
  const hint = h('p', { class: 'dialog-detail' }, 'Type a number, a date or text, or a formula such as =$B$1 to compare with a cell.');
  if (kind === 'gt' || kind === 'lt' || kind === 'eq') {
    v1.value = current.startsWith('=') ? '' : current;
    v1.setAttribute('aria-label', `Format cells that are ${OP_WORDS[kind as CellOp]}`);
    parts.push(h('label', { class: 'dialog-label' }, `Format cells that are ${OP_WORDS[kind as CellOp].toUpperCase()}:`, v1), hint);
  } else if (kind === 'between') {
    v1.setAttribute('aria-label', 'Format cells that are between');
    parts.push(h('p', { class: 'dialog-text' }, 'Format cells that are BETWEEN:'), h('div', { class: 'cf-pair' }, v1, h('span', {}, 'and'), v2), hint);
  } else if (kind === 'text') {
    v1.setAttribute('aria-label', 'Format cells that contain the text');
    parts.push(h('label', { class: 'dialog-label' }, 'Format cells that contain the text:', v1));
  } else if (kind === 'dup') {
    parts.push(h('label', { class: 'dialog-label' }, 'Format cells that contain values that are:', which));
  } else if (kind === 'blank') {
    parts.push(h('label', { class: 'dialog-label' }, 'Format cells that are:', blankSel));
  } else if (kind.startsWith('top') || kind.startsWith('bottom')) {
    n.setAttribute('aria-label', `Format cells that rank in the ${kind.startsWith('top') ? 'top' : 'bottom'}`);
    parts.push(h('label', { class: 'dialog-label' }, `Format cells that rank in the ${kind.startsWith('top') ? 'TOP' : 'BOTTOM'}:`, h('span', { class: 'cf-pair' }, n, kind.endsWith('%') ? '%' : 'items')));
  } else if (kind === 'above' || kind === 'below') {
    parts.push(h('p', { class: 'dialog-text' }, `Format cells that are ${kind.toUpperCase()} the average of the selected cells.`));
  } else if (kind === 'expr') {
    v1.value = '=';
    v1.setAttribute('aria-label', 'Format cells where this formula is true');
    parts.push(h('label', { class: 'dialog-label' }, 'Format cells where this formula is TRUE:', v1),
      h('p', { class: 'dialog-detail' }, `Write it for the top-left cell of the selection (${addressOf(range.c0, range.r0)}); it moves with each cell, as a copied formula does. Use $ to keep a reference fixed: =${addressOf(range.c0, range.r0)}>$B$1.`));
  }
  parts.push(h('label', { class: 'dialog-label' }, 'with', preset), h('p', { class: 'cf-look-row' }, 'Looks like: ', look), problem);
  const build = (): CfRule | null => {
    problem.textContent = '';
    const fmt = { ...PRESETS[Number(preset.value)].fmt };
    const val = (input: HTMLInputElement) => {
      const f = valueFormula(input.value, wb.dateOrder);
      if (f === null) problem.textContent = input.value.trim() ? 'That formula is not written correctly.' : 'Type a value.';
      return f;
    };
    switch (kind) {
      case 'gt': case 'lt': case 'eq': {
        const f1 = val(v1);
        return f1 === null ? null : { t: 'cell', op: kind as CellOp, f1, fmt };
      }
      case 'between': {
        const f1 = val(v1);
        const f2 = f1 === null ? null : val(v2);
        return f1 === null || f2 === null ? null : { t: 'cell', op: 'between', f1, f2, fmt };
      }
      case 'text':
        if (!v1.value) {
          problem.textContent = 'Type the text to look for.';
          return null;
        }
        return { t: 'text', op: 'contains', text: v1.value, fmt };
      case 'dup': return { t: 'dup', unique: which.value === 'unique' || undefined, fmt };
      case 'blank': return { t: 'blank', not: blankSel.value === 'not' || undefined, fmt };
      case 'above': return { t: 'avg', fmt };
      case 'below': return { t: 'avg', below: true, fmt };
      case 'expr': {
        const f = v1.value.trim().replace(/^=/, '');
        try {
          parseFormula(f);
        } catch (error) {
          problem.textContent = error instanceof SyntaxProblem ? error.message : 'That formula is not written correctly.';
          return null;
        }
        return f ? { t: 'expr', f, fmt } : null;
      }
      default: {
        const count = Math.round(Number(n.value));
        if (!Number.isFinite(count) || count < 1 || count > 1000) {
          problem.textContent = 'Type a number from 1 to 1000.';
          return null;
        }
        return { t: 'top', n: count, bottom: kind.startsWith('bottom') || undefined, percent: kind.endsWith('%') || undefined, fmt };
      }
    }
  };
  const body = h('div', { class: 'cf-dialog' }, ...parts);
  let rule: CfRule | null = null;
  // Asked again, with what was typed still in it, until it reads or is cancelled.
  for (;;) {
    const answer = await shell.dialogs.ask<boolean>({
      title: titles[kind] ?? 'Conditional formatting',
      body,
      buttons: [{ label: 'OK', value: true, primary: true }, { label: 'Cancel', value: false }],
      cancel: false,
      focus: () => (kind === 'dup' ? which : kind === 'blank' ? blankSel : kind.startsWith('top') || kind.startsWith('bottom') ? n : kind === 'above' || kind === 'below' ? preset : v1),
    });
    if (!answer) break;
    rule = build();
    if (rule) break;
  }
  done.abort();
  if (!rule) {
    grid.focus();
    return;
  }
  try {
    wb.addCf(wb.active, { ranges: [range], rule });
    ctx.onChange();
  } catch (error) {
    void ctx.report(error);
  }
  grid.focus();
}

/** Every rule on the sheet: where each applies, stop if true, order, delete. OK saves the list as one change. */
async function manageRules(ctx: SheetContext): Promise<void> {
  const { shell, wb, grid } = ctx;
  if (!grid.commit()) return;
  const done = new AbortController();
  const list: Array<CfEntry & { text: string }> = wb.sheets[wb.active].cf.map(e => ({ ...e, text: e.ranges.map(rangeText).join(', ') }));
  const box = h('div', { class: 'cf-manage', role: 'list' });
  const problem = h('p', { class: 'dialog-problem', role: 'alert' });
  const draw = () => {
    if (!list.length) {
      box.replaceChildren(h('p', { class: 'dialog-text' }, 'This sheet has no conditional formatting rules.'));
      return;
    }
    box.replaceChildren(...list.map((e, i) => {
      const where = h('input', { type: 'text', class: 'field', value: e.text, 'aria-label': `Rule ${i + 1} applies to`, spellcheck: false, autocomplete: 'off' });
      on(where, 'input', () => {
        list[i].text = where.value;
      }, done.signal);
      const stop = h('input', { type: 'checkbox' });
      stop.checked = !!e.stop;
      on(stop, 'change', () => {
        list[i].stop = stop.checked || undefined;
      }, done.signal);
      const btn = (label: string, title: string, run: () => void, disabled = false) => {
        const b = h('button', { type: 'button', class: 'btn', title, 'aria-label': title, disabled }, label);
        on(b, 'click', () => {
          run();
          draw();
        }, done.signal);
        return b;
      };
      const r = e.rule;
      const lookEl = r.t === 'bar' || r.t === 'scale' ? h('span', { class: 'cf-sample' }, r.t === 'bar' ? 'Bar' : 'Scale') : sample(r.fmt);
      if (r.t === 'bar') css(lookEl, { background: r.colour, color: '#fff' });
      if (r.t === 'scale') css(lookEl, { background: `linear-gradient(90deg, ${r.colours.join(', ')})` });
      return h('div', { class: 'cf-rule', role: 'listitem' },
        h('div', { class: 'cf-rule-head' }, h('span', { class: 'cf-rule-text' }, `${i + 1}. ${describeRule(r)}`), lookEl),
        h('label', { class: 'cf-rule-where' }, h('span', {}, 'Applies to'), where),
        h('div', { class: 'cf-rule-tools' },
          h('label', {}, stop, ' Stop if true'),
          btn('↑', 'Move up (wins over the rules below it)', () => list.splice(i - 1, 0, ...list.splice(i, 1)), i === 0),
          btn('↓', 'Move down', () => list.splice(i + 1, 0, ...list.splice(i, 1)), i === list.length - 1),
          btn('Delete', `Delete rule ${i + 1}`, () => list.splice(i, 1))));
    }));
  };
  draw();
  const check = (): CfEntry[] | null => {
    const out: CfEntry[] = [];
    for (const [i, e] of list.entries()) {
      const ranges = readRanges(e.text);
      if (!ranges) {
        problem.textContent = `Rule ${i + 1}: "${e.text}" is not a block of cells. Type something like A1:A20 (several with commas).`;
        return null;
      }
      out.push({ ranges, rule: e.rule, ...(e.stop ? { stop: true } : {}) });
    }
    problem.textContent = '';
    return out;
  };
  const body = h('div', { class: 'cf-manage-wrap' }, h('p', { class: 'dialog-detail' }, 'Rules higher in the list win where two set the same thing.'), box, problem);
  let out: CfEntry[] | null = null;
  for (;;) {
    const answer = await shell.dialogs.ask<boolean>({
      title: 'Manage conditional formatting rules',
      body,
      buttons: [{ label: 'OK', value: true, primary: true }, { label: 'Cancel', value: false }],
      cancel: false,
    });
    if (!answer) break;
    out = check();
    if (out) break;
  }
  done.abort();
  if (out) {
    try {
      wb.setCf(wb.active, out);
      ctx.onChange();
    } catch (error) {
      void ctx.report(error);
    }
  }
  grid.focus();
}

// ---- Data validation ------------------------------------------------------------------------------------------------

/** Data > Data Validation: the rule for the selected cells, their input message and their error alert. */
export async function validationDialog(ctx: SheetContext): Promise<void> {
  const { shell, wb, grid } = ctx;
  if (!grid.commit()) return;
  const range = grid.sel();
  const a = grid.active();
  const existing = validationAt(wb, wb.active, a.col, a.row);
  const v: Validation = existing ? { ...existing, prompt: { ...existing.prompt }, error: { ...existing.error } } : newValidation([range]);
  const done = new AbortController();
  const allow = h('select', { class: 'field', 'aria-label': 'Allow' }, ...DV_TYPES.map(t => h('option', { value: t }, DV_LABEL[t])));
  allow.value = v.type;
  const ops: CellOp[] = ['between', 'notBetween', 'eq', 'ne', 'gt', 'lt', 'ge', 'le'];
  const op = h('select', { class: 'field', 'aria-label': 'Data' }, ...ops.map(o => h('option', { value: o }, OP_WORDS[o])));
  op.value = v.op;
  const f1 = h('input', { type: 'text', class: 'field', autocomplete: 'off', spellcheck: false });
  const f2 = h('input', { type: 'text', class: 'field', autocomplete: 'off', spellcheck: false });
  const typedList = literalItems(v.f1);
  f1.value = v.type === 'list' ? (typedList ? typedList.join(',') : v.f1 ? `=${v.f1}` : '') : v.type === 'custom' ? (v.f1 ? `=${v.f1}` : '') : formulaShown(v.f1);
  f2.value = formulaShown(v.f2);
  const f1Label = h('span', {});
  const f2Label = h('span', {}, 'Maximum');
  const opRow = h('label', { class: 'chart-row' }, h('span', {}, 'Data'), op);
  const f1Row = h('label', { class: 'chart-row' }, f1Label, f1);
  const f2Row = h('label', { class: 'chart-row' }, f2Label, f2);
  const blank = h('input', { type: 'checkbox' });
  blank.checked = v.blank;
  const dropdown = h('input', { type: 'checkbox' });
  dropdown.checked = v.dropdown;
  const dropRow = h('label', { class: 'chart-check' }, dropdown, ' In-cell drop-down list');
  const sourceHint = h('p', { class: 'dialog-detail' });
  const showPrompt = h('input', { type: 'checkbox' });
  showPrompt.checked = v.prompt.show;
  const promptTitle = h('input', { type: 'text', class: 'field', value: v.prompt.title, maxlength: 32, 'aria-label': 'Input message title' });
  const promptText = h('textarea', { class: 'field dv-text', maxlength: 255, rows: 2, 'aria-label': 'Input message' });
  promptText.value = v.prompt.text;
  const showError = h('input', { type: 'checkbox' });
  showError.checked = v.error.show;
  const style = h('select', { class: 'field', 'aria-label': 'Error style' }, h('option', { value: 'stop' }, 'Stop (the value is not allowed)'), h('option', { value: 'warning' }, 'Warning (asks whether to keep it)'), h('option', { value: 'info' }, 'Information (says so, keeps it)'));
  style.value = v.error.style;
  const errTitle = h('input', { type: 'text', class: 'field', value: v.error.title, maxlength: 32, 'aria-label': 'Error title' });
  const errText = h('textarea', { class: 'field dv-text', maxlength: 255, rows: 2, 'aria-label': 'Error message' });
  errText.value = v.error.text;
  const problem = h('p', { class: 'dialog-problem', role: 'alert' });
  const sync = () => {
    const t = allow.value as DvType;
    const ranged = t === 'whole' || t === 'decimal' || t === 'date' || t === 'time' || t === 'length';
    opRow.hidden = !ranged;
    f1Row.hidden = t === 'any';
    const two = ranged && (op.value === 'between' || op.value === 'notBetween');
    f2Row.hidden = !two;
    f1Label.textContent = t === 'list' ? 'Source' : t === 'custom' ? 'Formula' : two ? 'Minimum' : 'Value';
    f1.setAttribute('aria-label', f1Label.textContent);
    f2.setAttribute('aria-label', 'Maximum');
    dropRow.hidden = t !== 'list';
    sourceHint.hidden = !(t === 'list' || t === 'custom' || ranged);
    sourceHint.textContent = t === 'list'
      ? 'The choices with commas between (Yes,No,Maybe), or =$A$1:$A$10 for the values in those cells.'
      : t === 'custom' ? 'A formula that is TRUE for allowed values, written for the top-left cell (=ISNUMBER(A1)).'
        : t === 'date' ? 'A date (1/1/2026), or a formula such as =TODAY() or =$B$1.' : t === 'time' ? 'A time (9:00), or a formula such as =$B$1.' : 'A number, or a formula such as =$B$1.';
  };
  on(allow, 'change', sync, done.signal);
  on(op, 'change', sync, done.signal);
  sync();
  const build = (): Validation | null => {
    problem.textContent = '';
    const t = allow.value as DvType;
    const out: Validation = {
      ...newValidation([range]), type: t, op: op.value as CellOp, blank: blank.checked, dropdown: dropdown.checked,
      prompt: { show: showPrompt.checked, title: promptTitle.value.slice(0, 32), text: promptText.value.slice(0, 255) },
      error: { show: showError.checked, style: style.value as Validation['error']['style'], title: errTitle.value.slice(0, 32), text: errText.value.slice(0, 255) },
    };
    if (t === 'any') return out;
    const text = f1.value.trim();
    if (!text) {
      problem.textContent = t === 'list' ? 'Type the choices, or the cells that hold them.' : t === 'custom' ? 'Type the formula.' : 'Type a value.';
      return null;
    }
    if (t === 'list' || t === 'custom') {
      if (text.startsWith('=') || t === 'custom') {
        const f = text.replace(/^=/, '');
        try {
          parseFormula(f);
        } catch {
          problem.textContent = 'That formula is not written correctly.';
          return null;
        }
        out.f1 = f;
      } else out.f1 = itemsFormula(text);
      if (t === 'list' && out.f1 === '""') {
        problem.textContent = 'Type at least one choice.';
        return null;
      }
      return out;
    }
    const a1 = valueFormula(text, wb.dateOrder);
    if (a1 === null || a1.startsWith('"')) {
      problem.textContent = `"${text}" is not a ${t === 'date' ? 'date' : t === 'time' ? 'time' : 'number'} or a formula.`;
      return null;
    }
    out.f1 = a1;
    if (out.op === 'between' || out.op === 'notBetween') {
      const b1 = valueFormula(f2.value, wb.dateOrder);
      if (b1 === null || b1.startsWith('"')) {
        problem.textContent = 'Type the maximum as well.';
        return null;
      }
      out.f2 = b1;
    }
    return out;
  };
  const body = h('div', { class: 'dv-dialog' },
      h('fieldset', { class: 'dv-set' }, h('legend', {}, 'Settings'),
        h('label', { class: 'chart-row' }, h('span', {}, 'Allow'), allow),
        opRow, f1Row, f2Row, sourceHint,
        h('label', { class: 'chart-check' }, blank, ' Ignore blank'),
        dropRow),
      h('fieldset', { class: 'dv-set' }, h('legend', {}, 'Input message'),
        h('label', { class: 'chart-check' }, showPrompt, ' Show this message when the cell is selected'),
        h('label', { class: 'chart-row' }, h('span', {}, 'Title'), promptTitle),
        h('label', { class: 'chart-row' }, h('span', {}, 'Message'), promptText)),
      h('fieldset', { class: 'dv-set' }, h('legend', {}, 'Error alert'),
        h('label', { class: 'chart-check' }, showError, ' Show this alert when something not allowed is typed'),
        h('label', { class: 'chart-row' }, h('span', {}, 'Style'), style),
        h('label', { class: 'chart-row' }, h('span', {}, 'Title'), errTitle),
        h('label', { class: 'chart-row' }, h('span', {}, 'Message'), errText)),
      h('p', { class: 'dialog-detail' }, 'Only typing is checked: pasted values, filled cells and formulas are not (as in Excel).'),
      problem);
  let answer: 'ok' | 'clear' | null = null;
  let rule: Validation | null = null;
  for (;;) {
    answer = await shell.dialogs.ask<'ok' | 'clear' | null>({
      title: `Data validation (${rangeText(range)})`,
      body,
      buttons: [{ label: 'OK', value: 'ok', primary: true }, { label: 'Clear all', value: 'clear' }, { label: 'Cancel', value: null }],
      cancel: null,
      focus: () => allow,
    });
    if (answer !== 'ok') break;
    rule = build();
    if (rule) break;
  }
  done.abort();
  try {
    if (answer === 'clear') {
      wb.setValidation(wb.active, range, null);
      ctx.onChange();
    } else if (answer === 'ok' && rule) {
      wb.setValidation(wb.active, range, rule.type === 'any' && !rule.prompt.title && !rule.prompt.text ? null : rule);
      ctx.onChange();
    }
  } catch (error) {
    void ctx.report(error);
  }
  grid.focus();
}
