// Format Cells (Ctrl+1, or right-click > Format cells): Excel's one screen for a cell's number format, alignment, font,
// borders and fill. Only what is changed on it is applied, so cells with different looks keep the rest of their own.
import { css, h, on } from '../../core/dom.ts';
import type { SheetContext } from './charts-ui.ts';
import { FONT_FACES, FONT_SIZES, STANDARD_SIZE } from './fonts.ts';
import { codeProblem, formatCode, isDateCode } from './numfmt.ts';
import { longDateCode, shortDateCode } from './dates.ts';
import { CellError, type CellStyle, type Line } from './values.ts';
import { keyOf } from './workbook.ts';

export interface FormatTools {
  /** Changes every selected cell's style (one Undo). */
  style(patch: (s: CellStyle) => CellStyle): void;
  /** Changes every selected cell's style knowing which edges of the selection it is on (borders; one Undo). */
  edges(patch: (s: CellStyle, edge: { t: boolean; b: boolean; l: boolean; r: boolean }) => CellStyle): void;
  palette: Array<[string, string]>;
}

type Tab = 'number' | 'align' | 'font' | 'border' | 'fill';
const TABS: Array<[Tab, string]> = [['number', 'Number'], ['align', 'Alignment'], ['font', 'Font'], ['border', 'Border'], ['fill', 'Fill']];
type Category = 'general' | 'number' | 'currency' | 'percent' | 'date' | 'time' | 'scientific' | 'fraction' | 'text' | 'custom';
const CATEGORIES: Array<[Category, string]> = [
  ['general', 'General'], ['number', 'Number'], ['currency', 'Currency'], ['percent', 'Percentage'], ['date', 'Date'], ['time', 'Time'],
  ['scientific', 'Scientific'], ['fraction', 'Fraction'], ['text', 'Text'], ['custom', 'Custom'],
];

/** The category a style belongs to (as the Number tab shows it). */
function categoryOf(s: CellStyle): Category {
  if (!s.fmt) return 'general';
  if (s.fmt === 'number' || s.fmt === 'comma') return 'number';
  if (s.fmt === 'currency') return 'currency';
  if (s.fmt === 'percent') return 'percent';
  if (s.fmt === 'text') return 'text';
  const code = s.code ?? '';
  if (isDateCode(code)) return /[dy]/i.test(code.replace(/"[^"]*"/g, '')) ? 'date' : 'time';
  if (/E[+-]/.test(code)) return 'scientific';
  if (/\?\/\?/.test(code)) return 'fraction';
  return 'custom';
}

export async function formatCellsDialog(ctx: SheetContext, tools: FormatTools, first: Tab = 'number'): Promise<void> {
  const { shell, wb, grid } = ctx;
  if (!grid.commit()) return;
  const a = grid.active();
  const own: CellStyle = wb.styleOf(wb.sheets[wb.active].cells.get(keyOf(a.col, a.row))) ?? {};
  const value = wb.value(wb.active, a.col, a.row);
  const order = wb.dateOrder;
  const touched = new Set<string>();
  const touch = (k: string) => () => {
    touched.add(k);
    preview();
  };
  const done = new AbortController();
  const sig = done.signal;

  // ---- Number ----
  const cat = h('select', { class: 'field', size: 10, 'aria-label': 'Category' }, ...CATEGORIES.map(([k, label]) => h('option', { value: k }, label)));
  cat.value = categoryOf(own);
  const dec = h('input', { type: 'number', class: 'field cf-n', min: 0, max: 15, 'aria-label': 'Decimal places' });
  dec.value = String(own.dec ?? (own.fmt === 'percent' ? 0 : 2));
  const sep = h('input', { type: 'checkbox' });
  sep.checked = own.fmt === 'comma' || own.fmt === 'currency';
  const negRed = h('input', { type: 'checkbox' });
  const DATES = [shortDateCode(order), longDateCode(order), 'd mmm yyyy', 'd-mmm-yy', 'mmm-yy', 'mmmm yyyy', 'dddd, d mmmm yyyy', 'yyyy-mm-dd', `${shortDateCode(order)} h:mm`];
  const TIMES = ['h:mm', 'h:mm AM/PM', 'h:mm:ss', 'h:mm:ss AM/PM', '[h]:mm:ss', 'mm:ss.0'];
  const kinds = h('select', { class: 'field', size: 6, 'aria-label': 'Type' });
  const code = h('input', { type: 'text', class: 'field', 'aria-label': 'Format code', autocomplete: 'off', spellcheck: false, value: own.fmt === 'custom' ? own.code ?? '' : '' });
  const sample = h('output', { class: 'fmt-sample' });
  const problem = h('p', { class: 'dialog-problem', role: 'alert' });
  const decRow = h('label', { class: 'cf-pair' }, 'Decimal places ', dec);
  const sepRow = h('label', {}, sep, ' Use 1000 separator (,)');
  const redRow = h('label', {}, negRed, ' Show minus numbers in red');
  const kindsRow = h('label', { class: 'dialog-label' }, 'Type', kinds);
  const codeRow = h('label', { class: 'dialog-label' }, 'Format code (as Excel writes it)', code);
  /** The style the Number tab stands for now. */
  const numberStyle = (): Partial<CellStyle> | null => {
    const d = Math.max(0, Math.min(15, Math.trunc(Number(dec.value) || 0)));
    const places = d ? `.${'0'.repeat(d)}` : '';
    switch (cat.value as Category) {
      case 'general': return { fmt: undefined, code: undefined, dec: undefined };
      case 'number':
        if (negRed.checked) return { fmt: 'custom', code: `${sep.checked ? '#,##0' : '0'}${places};[Red]-${sep.checked ? '#,##0' : '0'}${places}`, dec: undefined };
        return { fmt: sep.checked ? 'comma' : 'number', dec: d, code: undefined };
      case 'currency':
        if (negRed.checked) return { fmt: 'custom', code: `"${wb.symbol}"#,##0${places};[Red]-"${wb.symbol}"#,##0${places}`, dec: undefined };
        return { fmt: 'currency', dec: d, code: undefined };
      case 'percent': return { fmt: 'percent', dec: d, code: undefined };
      case 'scientific': return { fmt: 'custom', code: `0${places}E+00`, dec: undefined };
      case 'text': return { fmt: 'text', code: undefined, dec: undefined };
      case 'date': case 'time': case 'fraction': return kinds.value ? { fmt: 'custom', code: kinds.value, dec: undefined } : null;
      default: return code.value && !codeProblem(code.value) ? { fmt: 'custom', code: code.value, dec: undefined } : null;
    }
  };
  const showNumberParts = () => {
    const c = cat.value as Category;
    decRow.hidden = !['number', 'currency', 'percent', 'scientific'].includes(c);
    sepRow.hidden = c !== 'number';
    redRow.hidden = c !== 'number' && c !== 'currency';
    kindsRow.hidden = !['date', 'time', 'fraction'].includes(c);
    codeRow.hidden = c !== 'custom';
    const list = c === 'date' ? DATES : c === 'time' ? TIMES : c === 'fraction' ? ['# ?/?', '# ??/??', '# ?/2', '# ?/4', '# ?/8', '# ??/16', '# ?/10', '# ??/100'] : [];
    if (!kindsRow.hidden && (kinds.dataset.for !== c)) {
      kinds.dataset.for = c;
      kinds.replaceChildren(...list.map(x => h('option', { value: x }, `${x}    ${formatCode(c === 'fraction' ? 1.3125 : 46308.604166667, x).text}`)));
      kinds.value = own.code && list.includes(own.code) ? own.code : list[0];
    }
  };
  for (const el of [cat, kinds]) on(el, 'change', () => {
    showNumberParts();
    touched.add('number');
    preview();
  }, sig);
  for (const el of [dec, sep, negRed, code]) on(el, 'input', touch('number'), sig);
  on(sep, 'change', touch('number'), sig);
  on(negRed, 'change', touch('number'), sig);

  // ---- Alignment ----
  const hz = h('select', { class: 'field', 'aria-label': 'Horizontal' }, h('option', { value: '' }, 'General'), h('option', { value: 'l' }, 'Left'), h('option', { value: 'c' }, 'Centre'), h('option', { value: 'r' }, 'Right'));
  hz.value = own.al ?? '';
  const vt = h('select', { class: 'field', 'aria-label': 'Vertical' }, h('option', { value: 't' }, 'Top'), h('option', { value: 'm' }, 'Middle'), h('option', { value: '' }, 'Bottom'));
  vt.value = own.va ?? '';
  const ind = h('input', { type: 'number', class: 'field cf-n', min: 0, max: 15, value: String(own.ind ?? 0), 'aria-label': 'Indent' });
  const wrap = h('input', { type: 'checkbox' });
  wrap.checked = !!own.wrap;
  on(hz, 'change', touch('align'), sig);
  on(vt, 'change', touch('align'), sig);
  on(ind, 'input', touch('align'), sig);
  on(wrap, 'change', touch('align'), sig);

  // ---- Font ----
  const face = h('select', { class: 'field', size: 8, 'aria-label': 'Font' }, h('option', { value: '' }, 'Standard'), ...FONT_FACES.map(f => h('option', { value: f.name }, f.name)));
  face.value = own.ff && FONT_FACES.some(f => f.name === own.ff) ? own.ff : '';
  const weight = h('select', { class: 'field', size: 4, 'aria-label': 'Font style' }, h('option', { value: '' }, 'Regular'), h('option', { value: 'i' }, 'Italic'), h('option', { value: 'b' }, 'Bold'), h('option', { value: 'bi' }, 'Bold italic'));
  weight.value = `${own.b ? 'b' : ''}${own.i ? 'i' : ''}`;
  const size = h('select', { class: 'field', size: 8, 'aria-label': 'Size' }, ...FONT_SIZES.map(n => h('option', { value: String(n) }, String(n))));
  size.value = String(own.fs ?? STANDARD_SIZE);
  const under = h('input', { type: 'checkbox' });
  under.checked = !!own.u;
  const strike = h('input', { type: 'checkbox' });
  strike.checked = !!own.st;
  const colour = h('select', { class: 'field', 'aria-label': 'Colour' }, h('option', { value: '' }, 'Automatic (black)'), ...tools.palette.map(([n, hex]) => h('option', { value: hex }, n)));
  colour.value = own.color && tools.palette.some(p => p[1] === own.color) ? own.color : '';
  for (const el of [face, weight, size, colour]) on(el, 'change', touch('font'), sig);
  on(under, 'change', touch('font'), sig);
  on(strike, 'change', touch('font'), sig);

  // ---- Border ----
  const lineSel = h('select', { class: 'field', 'aria-label': 'Line style' }, h('option', { value: 'thin' }, 'Thin'), h('option', { value: 'medium' }, 'Medium'), h('option', { value: 'thick' }, 'Thick'), h('option', { value: 'double' }, 'Double'));
  const lineColour = h('select', { class: 'field', 'aria-label': 'Line colour' }, h('option', { value: '' }, 'Automatic (black)'), ...tools.palette.filter(p => p[1] !== '#ffffff').map(([n, hex]) => h('option', { value: hex }, n)));
  let borderAct: 'none' | 'outline' | 'inside' | 'all' | null = null;
  const sides = { t: h('input', { type: 'checkbox' }), b: h('input', { type: 'checkbox' }), l: h('input', { type: 'checkbox' }), r: h('input', { type: 'checkbox' }) };
  sides.t.checked = !!own.bt;
  sides.b.checked = !!own.bb;
  sides.l.checked = !!own.bl;
  sides.r.checked = !!own.br;
  const preset = (act: 'none' | 'outline' | 'inside' | 'all', label: string) => {
    const b = h('button', { type: 'button', class: 'btn' }, label);
    on(b, 'click', () => {
      borderAct = act;
      for (const k of ['t', 'b', 'l', 'r'] as const) sides[k].checked = act === 'outline' || act === 'all';
      touched.add('border');
      preview();
    }, sig);
    return b;
  };
  for (const k of ['t', 'b', 'l', 'r'] as const) on(sides[k], 'change', () => {
    borderAct = null;
    touch('border')();
  }, sig);
  on(lineSel, 'change', touch('border'), sig);
  on(lineColour, 'change', touch('border'), sig);

  // ---- Fill ----
  let fill: string | null | undefined = undefined;
  const fillSwatches = h('div', { class: 'palette-grid' }, ...tools.palette.map(([n, hex]) => {
    const sw = h('button', { type: 'button', class: 'palette-sw', title: n, 'aria-label': n });
    css(sw, { background: hex });
    on(sw, 'click', () => {
      fill = hex;
      touched.add('fill');
      preview();
    }, sig);
    return sw;
  }));
  const noFill = h('button', { type: 'button', class: 'btn' }, 'No colour');
  on(noFill, 'click', () => {
    fill = null;
    touched.add('fill');
    preview();
  }, sig);

  // ---- The tabs and the preview ----
  const look = h('div', { class: 'fc-preview', 'aria-label': 'Preview' }, h('span', {}, 'AaBbCc 123'));
  /** The style the screen stands for, laid over a cell's own (only what was changed). */
  const result = (s: CellStyle): CellStyle => {
    let out: CellStyle = { ...s };
    if (touched.has('number')) {
      const n = numberStyle();
      if (n) out = { ...out, ...n };
    }
    if (touched.has('align')) out = { ...out, al: (hz.value || undefined) as CellStyle['al'], va: (vt.value || undefined) as CellStyle['va'], ind: Number(ind.value) > 0 ? Math.min(15, Math.trunc(Number(ind.value))) : undefined, wrap: wrap.checked || undefined };
    if (touched.has('font')) {
      const fs = Number(size.value);
      out = { ...out, ff: face.value || undefined, b: weight.value.includes('b') || undefined, i: weight.value.includes('i') || undefined, fs: fs === STANDARD_SIZE ? undefined : fs, u: under.checked || undefined, st: strike.checked || undefined, color: colour.value || undefined };
    }
    if (touched.has('fill')) out = { ...out, fill: fill ?? undefined };
    return out;
  };
  function preview(): void {
    const s = result(own);
    const span = look.firstElementChild as HTMLElement;
    const v = value === null || value instanceof CellError ? -1234.5678 : value;
    let text = 'AaBbCc 123';
    problem.textContent = '';
    if (cat.value === 'custom' && touched.has('number')) {
      const why = codeProblem(code.value);
      if (why) problem.textContent = why;
    }
    try {
      if (touched.has('number') && !problem.textContent) text = s.fmt === 'custom' && s.code ? formatCode(v, s.code).text : typeof v === 'number' ? formatCode(v, s.fmt === 'percent' ? `0${s.dec ? `.${'0'.repeat(s.dec)}` : ''}%` : s.fmt === 'currency' ? `"${wb.symbol}"#,##0${s.dec ? `.${'0'.repeat(s.dec)}` : ''}` : s.fmt === 'comma' ? `#,##0${s.dec ? `.${'0'.repeat(s.dec)}` : ''}` : s.fmt === 'number' ? `0${s.dec ? `.${'0'.repeat(s.dec)}` : ''}` : 'General').text : String(v);
      else text = wb.display(wb.active, a.col, a.row) || text;
    } catch {
      // Shown as it is.
    }
    span.textContent = text;
    sample.textContent = text;
    css(look, { background: s.fill ?? '#ffffff', 'justify-content': s.al === 'c' ? 'center' : s.al === 'r' ? 'flex-end' : 'flex-start', 'align-items': s.va === 't' ? 'flex-start' : s.va === 'm' ? 'center' : 'flex-end' });
    css(span, {
      color: s.color ?? '#000000', 'font-weight': s.b ? '700' : '400', 'font-style': s.i ? 'italic' : 'normal', 'font-size': `${Math.min(36, ((s.fs ?? STANDARD_SIZE) / STANDARD_SIZE) * 13)}px`,
      'font-family': s.ff ? `"${s.ff}", sans-serif` : '"Segoe UI", Arial, sans-serif', 'text-decoration': [s.u ? 'underline' : '', s.st ? 'line-through' : ''].filter(Boolean).join(' ') || 'none',
      'padding-left': `${(s.ind ?? 0) * 9}px`,
    });
    css(look, { 'border-top': sides.t.checked ? '2px solid #000' : '1px dashed #c8c8c8', 'border-bottom': sides.b.checked ? '2px solid #000' : '1px dashed #c8c8c8', 'border-left': sides.l.checked ? '2px solid #000' : '1px dashed #c8c8c8', 'border-right': sides.r.checked ? '2px solid #000' : '1px dashed #c8c8c8' });
  }
  const panels: Record<Tab, HTMLElement> = {
    number: h('div', { class: 'fc-panel fc-number' }, h('label', { class: 'dialog-label' }, 'Category', cat), h('div', { class: 'fc-side' }, h('p', { class: 'fmt-sample-row' }, 'Sample: ', sample), decRow, sepRow, redRow, kindsRow, codeRow, problem)),
    align: h('div', { class: 'fc-panel' }, h('label', { class: 'dialog-label' }, 'Horizontal', hz), h('label', { class: 'dialog-label' }, 'Vertical', vt), h('label', { class: 'cf-pair' }, 'Indent ', ind), h('label', {}, wrap, ' Wrap text')),
    font: h('div', { class: 'fc-panel fc-font' }, h('label', { class: 'dialog-label' }, 'Font', face), h('label', { class: 'dialog-label' }, 'Font style', weight), h('label', { class: 'dialog-label' }, 'Size', size),
      h('div', { class: 'fc-side' }, h('label', {}, under, ' Underline'), h('label', {}, strike, ' Strikethrough'), h('label', { class: 'dialog-label' }, 'Colour', colour))),
    border: h('div', { class: 'fc-panel' }, h('div', { class: 'cf-pair' }, preset('none', 'None'), preset('outline', 'Outline'), preset('inside', 'Inside'), preset('all', 'All')),
      h('p', { class: 'dialog-text' }, 'Edges of the selection:'),
      h('div', { class: 'cf-pair' }, h('label', {}, sides.t, ' Top'), h('label', {}, sides.b, ' Bottom'), h('label', {}, sides.l, ' Left'), h('label', {}, sides.r, ' Right')),
      h('label', { class: 'dialog-label' }, 'Line style', lineSel), h('label', { class: 'dialog-label' }, 'Colour', lineColour)),
    fill: h('div', { class: 'fc-panel' }, h('p', { class: 'dialog-text' }, 'Background colour:'), fillSwatches, noFill),
  };
  const strip = h('div', { class: 'fc-tabs', role: 'tablist' });
  const tabBtns = TABS.map(([k, label]) => {
    const b = h('button', { type: 'button', role: 'tab', class: 'fc-tab', 'aria-selected': String(k === first) }, label);
    on(b, 'click', () => show(k), sig);
    strip.append(b);
    return b;
  });
  function show(k: Tab): void {
    for (const [key, panel] of Object.entries(panels)) panel.hidden = key !== k;
    tabBtns.forEach((b, i) => b.setAttribute('aria-selected', String(TABS[i][0] === k)));
  }
  show(first);
  showNumberParts();
  preview();
  const ok = await shell.dialogs.ask<boolean>({
    title: 'Format cells',
    body: h('div', { class: 'fc-dialog wide-dialog' }, strip, ...Object.values(panels), h('div', { class: 'fc-look' }, h('span', { class: 'dialog-detail' }, 'Preview'), look)),
    buttons: [{ label: 'OK', value: true, primary: true }, { label: 'Cancel', value: false }],
    cancel: false,
    primaryEnabled: () => !(cat.value === 'custom' && touched.has('number') && codeProblem(code.value)),
  });
  done.abort();
  if (!ok) {
    grid.focus();
    return;
  }
  if (touched.size && [...touched].some(k => k !== 'border')) tools.style(result);
  if (touched.has('border')) {
    const line: Line = lineSel.value === 'thin' ? true : (lineSel.value as Line);
    const bc = lineColour.value || undefined;
    tools.edges((s, e) => {
      const out: CellStyle = { ...s };
      const set = (k: 'bt' | 'bb' | 'bl' | 'br', on1: boolean) => {
        out[k] = on1 ? line : undefined;
      };
      if (borderAct === 'none') {
        out.bt = out.bb = out.bl = out.br = undefined;
        out.bc = undefined;
        return out;
      }
      out.bc = bc;
      if (borderAct === 'inside' || borderAct === 'all') {
        // Lines between the selected cells (and, for All, round them too).
        set('bt', !e.t || borderAct === 'all');
        set('bb', !e.b || borderAct === 'all');
        set('bl', !e.l || borderAct === 'all');
        set('br', !e.r || borderAct === 'all');
        return out;
      }
      // Outline, or the edges ticked one by one: only the selection's outer edges change.
      if (e.t) set('bt', sides.t.checked);
      if (e.b) set('bb', sides.b.checked);
      if (e.l) set('bl', sides.l.checked);
      if (e.r) set('br', sides.r.checked);
      return out;
    });
  }
  grid.focus();
}
