// Write's small windows: Paragraph (spacing, line spacing, indents), Header and footer, Margins, Insert table,
// Picture size and its description. Each asks, checks what was typed, and returns the answer (null when cancelled);
// the window applies it. Lengths are shown in centimetres, or inches where the paper is Letter.
import { h, on } from '../../core/dom.ts';
import type { Shell } from '../../shell/types.ts';
import { LINE_CHOICES, marginProblem, type HeaderLine, type Margins, type PageSetup } from './model.ts';

/** Inches or centimetres, by the paper (Letter and Legal are measured in inches). */
export function unitOf(page: PageSetup): { name: string; perInch: number } {
  return page.paper === 'letter' || page.paper === 'legal' ? { name: 'inches', perInch: 1 } : { name: 'cm', perInch: 2.54 };
}

const round = (v: number) => Math.round(v * 100) / 100;

function numberField(label: string, value: number, step: number, min: number, max: number): { input: HTMLInputElement; row: HTMLElement } {
  const input = h('input', { type: 'number', class: 'field ps-num', step, min, max, value: round(value) });
  input.setAttribute('aria-label', label);
  return { input, row: h('label', { class: 'chart-row' }, h('span', {}, label), input) };
}

/** Asks again until what was typed reads (problem() says what is wrong, or null). */
async function askUntil<T>(shell: Shell, title: string, body: HTMLElement, problemEl: HTMLElement, build: () => T | null, focus: () => HTMLElement | null): Promise<T | null> {
  for (;;) {
    const ok = await shell.dialogs.ask<boolean>({ title, body, buttons: [{ label: 'OK', value: true, primary: true }, { label: 'Cancel', value: false }], cancel: false, focus });
    if (!ok) return null;
    problemEl.textContent = '';
    const out = build();
    if (out !== null) return out;
  }
}

export interface ParaValues {
  before: number;
  after: number;
  line: number;
  /** Points. */
  indent: number;
  first: number;
}

/** Home > Paragraph settings: space before and after (points), line spacing, left indent and the first line. */
export async function paragraphDialog(shell: Shell, page: PageSetup, now: ParaValues): Promise<ParaValues | null> {
  const unit = unitOf(page);
  const toUnit = (pt: number) => (pt / 72) * unit.perInch;
  const before = numberField('Space before (points)', now.before, 1, 0, 200);
  const after = numberField('Space after (points)', now.after, 1, 0, 200);
  const line = h('select', { class: 'field', 'aria-label': 'Line spacing' }, ...LINE_CHOICES.map(v => h('option', { value: String(v) }, v === 1 ? 'Single (1)' : v === 2 ? 'Double (2)' : String(v))));
  if (!LINE_CHOICES.includes(now.line)) line.append(h('option', { value: String(now.line) }, String(now.line)));
  line.value = String(now.line);
  const indent = numberField(`Left indent (${unit.name})`, toUnit(now.indent), 0.1, 0, 20);
  const firstKind = h('select', { class: 'field', 'aria-label': 'First line' }, h('option', { value: 'none' }, '(none)'), h('option', { value: 'first' }, 'First line in by'), h('option', { value: 'hang' }, 'Hanging (the rest in) by'));
  firstKind.value = now.first > 0 ? 'first' : now.first < 0 ? 'hang' : 'none';
  const firstBy = numberField(`By (${unit.name})`, toUnit(Math.abs(now.first)) || (unit.perInch === 1 ? 0.5 : 1.27), 0.1, 0, 20);
  const problem = h('p', { class: 'dialog-problem', role: 'alert' });
  const body = h('div', { class: 'ps-dialog' },
    h('fieldset', { class: 'dv-set' }, h('legend', {}, 'Spacing'), before.row, after.row, h('label', { class: 'chart-row' }, h('span', {}, 'Line spacing (times single)'), line)),
    h('fieldset', { class: 'dv-set' }, h('legend', {}, 'Indents'), indent.row, h('label', { class: 'chart-row' }, h('span', {}, 'First line'), firstKind), firstBy.row),
    problem);
  return askUntil(shell, 'Paragraph', body, problem, () => {
    const b = Number(before.input.value);
    const a = Number(after.input.value);
    const ind = Number(indent.input.value);
    const by = Number(firstBy.input.value);
    if (![b, a].every(v => Number.isFinite(v) && v >= 0 && v <= 200)) {
      problem.textContent = 'Space before and after are from 0 to 200 points.';
      return null;
    }
    if (!Number.isFinite(ind) || ind < 0 || ind > 20 || !Number.isFinite(by) || by < 0 || by > 20) {
      problem.textContent = `Indents are from 0 to 20 ${unit.name}.`;
      return null;
    }
    const pt = (v: number) => round((v / unit.perInch) * 72);
    const first = firstKind.value === 'none' ? 0 : firstKind.value === 'first' ? pt(by) : -pt(by);
    return { before: round(b), after: round(a), line: Number(line.value), indent: pt(ind), first };
  }, () => before.input);
}

/** Layout > Header and footer: three parts each (left, centre, right), with &P for the page number and &N for the pages. */
export async function headerFooterDialog(shell: Shell, page: PageSetup): Promise<{ header: HeaderLine; footer: HeaderLine } | null> {
  const part = (what: string, v: string) => {
    const input = h('input', { type: 'text', class: 'field', value: v, maxlength: 120, spellcheck: false, autocomplete: 'off' });
    input.setAttribute('aria-label', what);
    return input;
  };
  const block = (which: 'Header' | 'Footer', l: HeaderLine) => {
    const inputs = (['l', 'c', 'r'] as const).map(k => part(`${which}, ${{ l: 'left', c: 'centre', r: 'right' }[k]}`, l[k]));
    return { inputs, el: h('fieldset', { class: 'dv-set' }, h('legend', {}, which), h('div', { class: 'ps-hf-parts' }, ...inputs)) };
  };
  const head = block('Header', page.header);
  const foot = block('Footer', page.footer);
  const problem = h('p', { class: 'dialog-problem', role: 'alert' });
  const body = h('div', { class: 'ps-dialog' }, head.el, foot.el,
    h('p', { class: 'dialog-detail' }, 'Left, centre and right. &P is the page number and &N the number of pages ("Page &P of &N"); && is one &. Leave all three empty for none.'),
    problem);
  const read = (inputs: HTMLInputElement[]): HeaderLine => ({ l: inputs[0].value, c: inputs[1].value, r: inputs[2].value });
  return askUntil(shell, 'Header and footer', body, problem, () => ({ header: read(head.inputs), footer: read(foot.inputs) }), () => head.inputs[0]);
}

/** Layout > Margins > Custom margins. */
export async function marginsDialog(shell: Shell, page: PageSetup): Promise<Margins | null> {
  const unit = unitOf(page);
  const fields = (['t', 'b', 'l', 'r', 'header', 'footer'] as const).map(k => ({
    k,
    f: numberField(`${{ t: 'Top', b: 'Bottom', l: 'Left', r: 'Right', header: 'Header from the top edge', footer: 'Footer from the bottom edge' }[k]} (${unit.name})`, page.margins[k] * unit.perInch, 0.1, 0, 20),
  }));
  const problem = h('p', { class: 'dialog-problem', role: 'alert' });
  const body = h('div', { class: 'ps-dialog' }, h('fieldset', { class: 'dv-set' }, h('legend', {}, 'Margins'), ...fields.map(x => x.f.row)), problem);
  return askUntil(shell, 'Custom margins', body, problem, () => {
    const m = { ...page.margins };
    for (const { k, f } of fields) {
      const v = Number(f.input.value) / unit.perInch;
      if (!Number.isFinite(v) || v < 0 || v > 8) {
        problem.textContent = `Each margin is from 0 to ${round(8 * unit.perInch)} ${unit.name}.`;
        return null;
      }
      m[k] = round(v * 1000) / 1000;
    }
    const why = marginProblem({ ...page, margins: m });
    if (why) {
      problem.textContent = why;
      return null;
    }
    return m;
  }, () => fields[0].f.input);
}

/** Insert > Table: how many columns and rows. */
export async function tableDialog(shell: Shell): Promise<{ cols: number; rows: number } | null> {
  const cols = numberField('Columns', 3, 1, 1, 20);
  const rows = numberField('Rows', 3, 1, 1, 200);
  const problem = h('p', { class: 'dialog-problem', role: 'alert' });
  const body = h('div', { class: 'ps-dialog' }, cols.row, rows.row, problem);
  return askUntil(shell, 'Insert table', body, problem, () => {
    const c = Math.round(Number(cols.input.value));
    const r = Math.round(Number(rows.input.value));
    if (!(c >= 1 && c <= 20) || !(r >= 1 && r <= 200)) {
      problem.textContent = 'A table has 1 to 20 columns and 1 to 200 rows.';
      return null;
    }
    return { cols: c, rows: r };
  }, () => cols.input);
}

/** Picture > Size: width and height (keeping its shape unless that is unticked), in the page's unit. */
export async function pictureSizeDialog(shell: Shell, page: PageSetup, now: { w: number; h: number }, natural: { w: number; h: number }, most: number): Promise<{ w: number; h: number } | null> {
  const unit = unitOf(page);
  const per = unit.perInch / 96;
  const width = numberField(`Width (${unit.name})`, now.w * per, 0.1, 0.1, 100);
  const height = numberField(`Height (${unit.name})`, now.h * per, 0.1, 0.1, 100);
  const keep = h('input', { type: 'checkbox' });
  keep.checked = true;
  const ratio = natural.h / natural.w;
  const done = new AbortController();
  on(width.input, 'input', () => {
    if (keep.checked) height.input.value = String(round(Number(width.input.value) * ratio));
  }, done.signal);
  on(height.input, 'input', () => {
    if (keep.checked) width.input.value = String(round(Number(height.input.value) / ratio));
  }, done.signal);
  const problem = h('p', { class: 'dialog-problem', role: 'alert' });
  const body = h('div', { class: 'ps-dialog' }, width.row, height.row, h('label', { class: 'chart-check' }, keep, ' Keep its shape'),
    h('p', { class: 'dialog-detail' }, `Its own size is ${round(natural.w * per)} × ${round(natural.h * per)} ${unit.name}. The widest it can be on this page is ${round(most * per)} ${unit.name}.`), problem);
  const out = await askUntil(shell, 'Picture size', body, problem, () => {
    const w = Number(width.input.value) / per;
    const hh = Number(height.input.value) / per;
    if (!(w >= 8 && hh >= 8)) {
      problem.textContent = 'Width and height must each be more than about 2 mm.';
      return null;
    }
    if (w > most + 0.5) {
      problem.textContent = `That is wider than the writing on this page (${round(most * per)} ${unit.name}).`;
      return null;
    }
    return { w: Math.round(w), h: Math.round(hh) };
  }, () => width.input);
  done.abort();
  return out;
}
