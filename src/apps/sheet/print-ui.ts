// Printing screens: Page Setup (paper, which way round, margins, scaling, gridlines and headings, print area, rows to
// repeat, header and footer), Print (a preview of every page with the common settings beside it), printing through the
// browser, and a PDF made here (downloaded, or saved in Documents). The pages themselves are drawn by print.ts.
import { h, on } from '../../core/dom.ts';
import { joinPath, uniqueName } from '../../fs/names.ts';
import type { SheetContext } from './charts-ui.ts';
import { SvgPainter } from './paint.ts';
import { PdfDocument } from './pdf.ts';
import {
  drawPage, HEADER_PRESETS, headerParts, MARGINS, pageOf, PAPERS, paperSize, planPages, type Margins, type PageSetup, type Paper, type PrintPlan,
} from './print.ts';
import { addressOf, colIndex, colName, MAX_COLS, MAX_ROWS } from './refs.ts';
import { readRanges } from './rules-ui.ts';

export interface PrintContext extends SheetContext {
  /** The file's name, for the header and footer (&F) and the PDF's name. */
  fileLabel(): string;
}

/** Margins as their preset's name, or "custom". */
export function marginName(m: Margins): 'normal' | 'wide' | 'narrow' | 'custom' {
  for (const k of ['normal', 'wide', 'narrow'] as const) {
    const p = MARGINS[k];
    if (p.t === m.t && p.b === m.b && p.l === m.l && p.r === m.r) return k;
  }
  return 'custom';
}

/** Changes how the active sheet prints (one Undo). */
export function setPage(ctx: SheetContext, patch: (p: PageSetup) => PageSetup): void {
  const { wb } = ctx;
  try {
    wb.setPage(wb.active, patch({ ...pageOf(wb, wb.active) }));
    ctx.onChange();
  } catch (error) {
    void ctx.report(error);
  }
}

/** "1:2" or "3" as rows (0-based), "A:B" or "C" as columns; null when it does not read. */
function readSpan(text: string, rows: boolean): [number, number] | null {
  const parts = text.replace(/\$/g, '').trim().split(':').map(t => t.trim());
  if (!parts[0] || parts.length > 2) return null;
  const one = (t: string) => {
    if (rows) {
      const n = Number(t);
      return Number.isInteger(n) && n >= 1 && n <= MAX_ROWS ? n - 1 : null;
    }
    const c = /^[A-Za-z]{1,3}$/.test(t) ? colIndex(t.toUpperCase()) : -1;
    return c >= 0 && c < MAX_COLS ? c : null;
  };
  const a = one(parts[0]);
  const b = parts.length === 2 ? one(parts[1]) : a;
  if (a === null || b === null) return null;
  return [Math.min(a, b), Math.max(a, b)];
}

const spanText = (p: [number, number] | null, rows: boolean): string =>
  !p ? '' : rows ? `${p[0] + 1}:${p[1] + 1}` : `${colName(p[0])}:${colName(p[1])}`;

/** Inches, or centimetres where people measure in them (everywhere that writes day/month dates). */
function unitFor(ctx: SheetContext): { name: string; per: number } {
  return ctx.wb.dateOrder === 'mdy' ? { name: 'inches', per: 1 } : { name: 'cm', per: 2.54 };
}

/** Page Setup: everything about how the active sheet prints, in one dialog. */
export async function pageSetupDialog(ctx: PrintContext): Promise<void> {
  const { shell, wb, grid } = ctx;
  if (!grid.commit()) return;
  const page = { ...pageOf(wb, wb.active), margins: { ...pageOf(wb, wb.active).margins } };
  const unit = unitFor(ctx);
  const done = new AbortController();
  const paper = h('select', { class: 'field', 'aria-label': 'Paper size' }, ...(Object.keys(PAPERS) as Paper[]).map(k => h('option', { value: k }, PAPERS[k].label)));
  paper.value = page.paper;
  const orient = h('select', { class: 'field', 'aria-label': 'Orientation' }, h('option', { value: 'portrait' }, 'Portrait (tall)'), h('option', { value: 'landscape' }, 'Landscape (wide)'));
  orient.value = page.orient;
  const scaleMode = h('select', { class: 'field', 'aria-label': 'Scaling' }, h('option', { value: 'scale' }, 'Adjust to a size'), h('option', { value: 'fit' }, 'Fit to pages'));
  scaleMode.value = page.fit ? 'fit' : 'scale';
  const scale = h('input', { type: 'number', class: 'field ps-num', min: 10, max: 400, value: page.scale, 'aria-label': 'Size, percent of normal' });
  const fitW = h('input', { type: 'number', class: 'field ps-num', min: 0, max: 999, value: page.fit?.w ?? 1, 'aria-label': 'Pages wide' });
  const fitH = h('input', { type: 'number', class: 'field ps-num', min: 0, max: 999, value: page.fit?.h ?? 0, 'aria-label': 'Pages tall (0 for as many as it takes)' });
  const scaleRow = h('div', { class: 'chart-row' }, h('span', {}, 'Size'), h('span', { class: 'cf-pair' }, scale, '% of normal size'));
  const fitRow = h('div', { class: 'chart-row' }, h('span', {}, 'Fit to'), h('span', { class: 'cf-pair' }, fitW, 'page(s) wide by', fitH, 'tall (0: as many as it takes)'));
  const marginSel = h('select', { class: 'field', 'aria-label': 'Margins' }, h('option', { value: 'normal' }, 'Normal'), h('option', { value: 'wide' }, 'Wide'), h('option', { value: 'narrow' }, 'Narrow'), h('option', { value: 'custom' }, 'Custom'));
  marginSel.value = marginName(page.margins);
  const marginInputs = (['t', 'b', 'l', 'r', 'header', 'footer'] as const).map(k => {
    const input = h('input', { type: 'number', class: 'field ps-num', min: 0, max: 12, step: 0.1, value: Math.round(page.margins[k] * unit.per * 100) / 100 });
    const label = { t: 'Top', b: 'Bottom', l: 'Left', r: 'Right', header: 'Header', footer: 'Footer' }[k];
    input.setAttribute('aria-label', `${label} margin, ${unit.name}`);
    return { k, input, row: h('label', { class: 'ps-margin' }, h('span', {}, label), input) };
  });
  const marginBox = h('div', { class: 'ps-margins' }, ...marginInputs.map(m => m.row));
  on(marginSel, 'change', () => {
    const preset = marginSel.value === 'custom' ? null : MARGINS[marginSel.value as 'normal'];
    if (preset) for (const m of marginInputs) m.input.value = String(Math.round(preset[m.k] * unit.per * 100) / 100);
  }, done.signal);
  for (const m of marginInputs) on(m.input, 'input', () => { marginSel.value = 'custom'; }, done.signal);
  const check = (label: string, on1: boolean) => {
    const box = h('input', { type: 'checkbox' });
    box.checked = on1;
    return { box, row: h('label', { class: 'chart-check' }, box, ` ${label}`) };
  };
  const gridlines = check('Print gridlines', page.gridlines);
  const headings = check('Print row and column headings', page.headings);
  const centerH = check('Centre on the page across', page.centerH);
  const centerV = check('Centre on the page down', page.centerV);
  const area = h('input', { type: 'text', class: 'field', value: page.area ? `${addressOf(page.area.c0, page.area.r0)}:${addressOf(page.area.c1, page.area.r1)}` : '', placeholder: 'The whole sheet', spellcheck: false, autocomplete: 'off', 'aria-label': 'Print area' });
  const rowsRep = h('input', { type: 'text', class: 'field', value: spanText(page.titleRows, true), placeholder: 'such as 1:1', spellcheck: false, autocomplete: 'off', 'aria-label': 'Rows to repeat at the top' });
  const colsRep = h('input', { type: 'text', class: 'field', value: spanText(page.titleCols, false), placeholder: 'such as A:A', spellcheck: false, autocomplete: 'off', 'aria-label': 'Columns to repeat at the left' });
  const order = h('select', { class: 'field', 'aria-label': 'Page order' }, h('option', { value: 'down' }, 'Down, then over'), h('option', { value: 'over' }, 'Over, then down'));
  order.value = page.order;
  // Header and footer: a ready-made one, or three parts of your own (&P page, &N pages, &A sheet, &F file, &D date).
  const hfBlock = (what: 'Header' | 'Footer', code: string) => {
    const parts = headerParts(code.replace(/&([PNAFDT])/gi, '&&$1'), { page: 0, pages: 0, sheet: '', file: '' });
    const raw = (s: string) => s.replace(/&&/g, '&');
    const inputs = (['l', 'c', 'r'] as const).map(k => h('input', { type: 'text', class: 'field', value: raw(parts[k]), maxlength: 80, spellcheck: false, autocomplete: 'off', 'aria-label': `${what}, ${{ l: 'left', c: 'centre', r: 'right' }[k]}` }));
    const preset = h('select', { class: 'field', 'aria-label': `${what}: ready-made` }, ...HEADER_PRESETS.map((p, i) => h('option', { value: String(i) }, p.label)), h('option', { value: 'own' }, 'Your own (below)'));
    const match = HEADER_PRESETS.findIndex(p => p.code === code);
    preset.value = match >= 0 ? String(match) : 'own';
    on(preset, 'change', () => {
      if (preset.value === 'own') return;
      const p = headerParts(HEADER_PRESETS[Number(preset.value)].code.replace(/&([PNAFDT])/gi, '&&$1'), { page: 0, pages: 0, sheet: '', file: '' });
      inputs.forEach((input, i) => { input.value = raw(p[(['l', 'c', 'r'] as const)[i]]); });
    }, done.signal);
    for (const input of inputs) on(input, 'input', () => { preset.value = 'own'; }, done.signal);
    const code2 = () => (['l', 'c', 'r'] as const).map((k, i) => (inputs[i].value ? `&${k.toUpperCase()}${inputs[i].value.replace(/&(?![PNAFDT&])/gi, '&&')}` : '')).join('');
    const el = h('div', { class: 'ps-hf' }, h('label', { class: 'chart-row' }, h('span', {}, what), preset), h('div', { class: 'ps-hf-parts' }, ...inputs));
    return { el, code: code2 };
  };
  const header = hfBlock('Header', page.header);
  const footer = hfBlock('Footer', page.footer);
  const problem = h('p', { class: 'dialog-problem', role: 'alert' });
  const syncScale = () => {
    scaleRow.hidden = scaleMode.value !== 'scale';
    fitRow.hidden = scaleMode.value !== 'fit';
  };
  on(scaleMode, 'change', syncScale, done.signal);
  syncScale();
  const build = (): PageSetup | null => {
    problem.textContent = '';
    const out: PageSetup = { ...page, paper: paper.value as Paper, orient: orient.value as PageSetup['orient'], order: order.value as PageSetup['order'] };
    const pct = Math.round(Number(scale.value));
    if (scaleMode.value === 'scale') {
      if (!Number.isFinite(pct) || pct < 10 || pct > 400) {
        problem.textContent = 'The size is a percent from 10 to 400.';
        return null;
      }
      out.scale = pct;
      out.fit = null;
    } else {
      const w = Math.round(Number(fitW.value));
      const hh = Math.round(Number(fitH.value));
      if (!Number.isFinite(w) || !Number.isFinite(hh) || w < 0 || hh < 0 || (w === 0 && hh === 0)) {
        problem.textContent = 'Fit to pages needs a number of pages wide or tall (0 for "as many as it takes" on one of them).';
        return null;
      }
      out.fit = { w, h: hh };
    }
    const margins = { ...out.margins };
    for (const m of marginInputs) {
      const v = Number(m.input.value) / unit.per;
      if (!Number.isFinite(v) || v < 0 || v > 5) {
        problem.textContent = `Each margin is from 0 to ${Math.round(5 * unit.per)} ${unit.name}.`;
        return null;
      }
      margins[m.k] = Math.round(v * 1000) / 1000;
    }
    const size = PAPERS[out.paper];
    if ((margins.l + margins.r) * 72 > Math.min(size.w, size.h) - 72 || (margins.t + margins.b) * 72 > Math.min(size.w, size.h) - 72) {
      problem.textContent = 'The margins leave no room on the paper for the cells.';
      return null;
    }
    out.margins = margins;
    out.gridlines = gridlines.box.checked;
    out.headings = headings.box.checked;
    out.centerH = centerH.box.checked;
    out.centerV = centerV.box.checked;
    if (area.value.trim()) {
      const got = readRanges(area.value);
      if (!got || got.length !== 1) {
        problem.textContent = 'The print area is one block of cells, such as A1:F40.';
        return null;
      }
      out.area = got[0];
    } else out.area = null;
    out.titleRows = rowsRep.value.trim() ? readSpan(rowsRep.value, true) : null;
    if (rowsRep.value.trim() && !out.titleRows) {
      problem.textContent = 'Rows to repeat are row numbers, such as 1:1 or 1:2.';
      return null;
    }
    out.titleCols = colsRep.value.trim() ? readSpan(colsRep.value, false) : null;
    if (colsRep.value.trim() && !out.titleCols) {
      problem.textContent = 'Columns to repeat are column letters, such as A:A or A:B.';
      return null;
    }
    out.header = header.code();
    out.footer = footer.code();
    return out;
  };
  const body = h('div', { class: 'ps-dialog' },
    h('fieldset', { class: 'dv-set' }, h('legend', {}, 'Page'),
      h('label', { class: 'chart-row' }, h('span', {}, 'Paper'), paper),
      h('label', { class: 'chart-row' }, h('span', {}, 'Orientation'), orient),
      h('label', { class: 'chart-row' }, h('span', {}, 'Scaling'), scaleMode), scaleRow, fitRow),
    h('fieldset', { class: 'dv-set' }, h('legend', {}, `Margins (${unit.name})`), h('label', { class: 'chart-row' }, h('span', {}, 'Margins'), marginSel), marginBox, centerH.row, centerV.row),
    h('fieldset', { class: 'dv-set' }, h('legend', {}, 'Header and footer'), header.el, footer.el,
      h('p', { class: 'dialog-detail' }, 'In your own: &P is the page number, &N the number of pages, &A the sheet name, &F the file name, &D the date, &T the time.')),
    h('fieldset', { class: 'dv-set' }, h('legend', {}, 'Sheet'),
      h('label', { class: 'chart-row' }, h('span', {}, 'Print area'), area),
      h('label', { class: 'chart-row' }, h('span', {}, 'Rows to repeat at top'), rowsRep),
      h('label', { class: 'chart-row' }, h('span', {}, 'Columns to repeat at left'), colsRep),
      gridlines.row, headings.row,
      h('label', { class: 'chart-row' }, h('span', {}, 'Page order'), order)),
    problem);
  let result: PageSetup | null = null;
  for (;;) {
    const answer = await shell.dialogs.ask<boolean>({
      title: `Page setup: ${wb.sheets[wb.active].name}`,
      body,
      buttons: [{ label: 'OK', value: true, primary: true }, { label: 'Cancel', value: false }],
      cancel: false,
      focus: () => paper,
    });
    if (!answer) break;
    result = build();
    if (result) break;
  }
  done.abort();
  if (result) {
    const final = result;
    setPage(ctx, () => final);
  }
  grid.focus();
}

/** One page drawn as an <svg> at paper size (points), for preview and for printing. */
function pageSvg(ctx: PrintContext, plan: PrintPlan, i: number): SVGElement {
  const size = paperSize(plan.setup);
  const p = new SvgPainter(size.w, size.h, { class: 'print-page-svg' });
  drawPage(p, ctx.wb, ctx.wb.active, plan, i, ctx.fileLabel());
  return p.root;
}

/** Prints through the browser: every page as a picture at paper size, everything else on screen hidden while it prints. */
export function printNow(ctx: PrintContext): void {
  const { wb, shell } = ctx;
  const plan = planPages(wb, wb.active);
  if (!plan) {
    void shell.dialogs.alert('Nothing to print', 'This sheet is empty. Type something in it (or set a print area), then print.');
    return;
  }
  const size = paperSize(plan.setup);
  const holder = h('div', { class: 'sheet-print', 'aria-hidden': 'true' });
  for (let i = 0; i < plan.pages.length; i++) {
    const svgEl = pageSvg(ctx, plan, i);
    svgEl.setAttribute('width', `${size.w}pt`);
    svgEl.setAttribute('height', `${size.h}pt`);
    holder.append(h('div', { class: `print-sheet-page paper-${plan.setup.paper}-${plan.setup.orient}` }, svgEl));
  }
  document.body.append(holder);
  document.body.classList.add('printing-sheet');
  const cleanup = () => {
    holder.remove();
    document.body.classList.remove('printing-sheet');
  };
  window.addEventListener('afterprint', cleanup, { once: true });
  // print() waits until the print box is closed in most browsers; the clean-up runs either way.
  try {
    window.print();
  } finally {
    setTimeout(() => {
      if (holder.isConnected) cleanup();
    }, 1000);
  }
}

/** The sheet as a PDF file's bytes; null when there is nothing to print. */
export async function pdfOf(ctx: PrintContext): Promise<Uint8Array<ArrayBuffer> | null> {
  const { wb } = ctx;
  const plan = planPages(wb, wb.active);
  if (!plan) return null;
  const size = paperSize(plan.setup);
  const doc = new PdfDocument();
  doc.title = `${ctx.fileLabel()} - ${wb.sheets[wb.active].name}`;
  for (let i = 0; i < plan.pages.length; i++) drawPage(doc.addPage(size.w, size.h), wb, wb.active, plan, i, ctx.fileLabel());
  return doc.bytes();
}

const pdfName = (ctx: PrintContext): string => `${ctx.fileLabel().replace(/\.(sheet|xlsx|xlsm|csv|tsv|txt)$/i, '') || 'Spreadsheet'}${ctx.wb.sheets.length > 1 ? ` - ${ctx.wb.sheets[ctx.wb.active].name}` : ''}.pdf`;

export async function downloadPdf(ctx: PrintContext): Promise<void> {
  try {
    const bytes = await pdfOf(ctx);
    if (!bytes) {
      await ctx.shell.dialogs.alert('Nothing to put in a PDF', 'This sheet is empty. Type something in it (or set a print area) first.');
      return;
    }
    ctx.shell.transfers.save(pdfName(ctx), bytes);
  } catch (error) {
    await ctx.report(error);
  }
}

export async function savePdfInDocuments(ctx: PrintContext): Promise<void> {
  const { shell } = ctx;
  try {
    const bytes = await pdfOf(ctx);
    if (!bytes) {
      await shell.dialogs.alert('Nothing to put in a PDF', 'This sheet is empty. Type something in it (or set a print area) first.');
      return;
    }
    let taken: string[] = [];
    try {
      taken = (await shell.fs.list('/Documents', true)).map(e => e.name);
    } catch {
      // Writing says so if Documents is not there.
    }
    const entry = await shell.fs.writeFile(joinPath('/Documents', uniqueName(pdfName(ctx), taken)), bytes, { mustBeNew: true });
    shell.toast(`Saved “${entry.name}” in Documents.`, { label: 'Open', run: () => void shell.openPath(joinPath('/Documents', entry.name)) });
  } catch (error) {
    await shell.report('Could not save the PDF', error);
  }
}

/** File > Print: a preview of each page, the common settings beside it, then Print or a PDF. */
export async function printPreview(ctx: PrintContext): Promise<void> {
  const { shell, wb, grid } = ctx;
  if (!grid.commit()) return;
  const done = new AbortController();
  let index = 0;
  const view = h('div', { class: 'pp-view' });
  const count = h('span', { class: 'pp-count', role: 'status', 'aria-live': 'polite' });
  const prev = h('button', { type: 'button', class: 'btn', 'aria-label': 'Previous page' }, '◀');
  const next = h('button', { type: 'button', class: 'btn', 'aria-label': 'Next page' }, '▶');
  const paper = h('select', { class: 'field', 'aria-label': 'Paper size' }, ...(Object.keys(PAPERS) as Paper[]).map(k => h('option', { value: k }, PAPERS[k].label)));
  const orient = h('select', { class: 'field', 'aria-label': 'Orientation' }, h('option', { value: 'portrait' }, 'Portrait'), h('option', { value: 'landscape' }, 'Landscape'));
  const margins = h('select', { class: 'field', 'aria-label': 'Margins' }, h('option', { value: 'normal' }, 'Normal margins'), h('option', { value: 'wide' }, 'Wide margins'), h('option', { value: 'narrow' }, 'Narrow margins'), h('option', { value: 'custom', hidden: true }, 'Custom margins'));
  const scaling = h('select', { class: 'field', 'aria-label': 'Scaling' },
    h('option', { value: 'none' }, 'No scaling (actual size)'), h('option', { value: 'page' }, 'Fit sheet on one page'),
    h('option', { value: 'cols' }, 'Fit all columns on one page'), h('option', { value: 'rows' }, 'Fit all rows on one page'), h('option', { value: 'custom', hidden: true }, 'Custom scaling'));
  const gridlines = h('input', { type: 'checkbox' });
  const setupBtn = h('button', { type: 'button', class: 'btn' }, 'Page setup...');
  const read = () => {
    const page = pageOf(wb, wb.active);
    paper.value = page.paper;
    orient.value = page.orient;
    margins.value = marginName(page.margins);
    const f = page.fit;
    scaling.value = !f ? (page.scale === 100 ? 'none' : 'custom') : f.w === 1 && f.h === 1 ? 'page' : f.w === 1 && f.h === 0 ? 'cols' : f.w === 0 && f.h === 1 ? 'rows' : 'custom';
    gridlines.checked = page.gridlines;
  };
  const draw = () => {
    const plan = planPages(wb, wb.active);
    if (!plan) {
      view.replaceChildren(h('p', { class: 'pp-empty' }, 'This sheet is empty, so there is nothing to print. Type something in it, or set a print area.'));
      count.textContent = 'No pages';
      prev.disabled = true;
      next.disabled = true;
      return;
    }
    index = Math.max(0, Math.min(index, plan.pages.length - 1));
    const svgEl = pageSvg(ctx, plan, index);
    svgEl.setAttribute('role', 'img');
    svgEl.setAttribute('aria-label', `Page ${index + 1} of ${plan.pages.length}`);
    const size = paperSize(plan.setup);
    // The page fits the view: as tall as the view allows, at most its own size.
    const room = { w: 420, h: 520 };
    const k = Math.min(room.w / size.w, room.h / size.h);
    svgEl.setAttribute('width', String(Math.round(size.w * k)));
    svgEl.setAttribute('height', String(Math.round(size.h * k)));
    view.replaceChildren(svgEl);
    count.textContent = `Page ${index + 1} of ${plan.pages.length}${plan.k !== 1 ? ` · printed at ${Math.round(plan.k * 100)}%` : ''}`;
    prev.disabled = index === 0;
    next.disabled = index >= plan.pages.length - 1;
  };
  on(prev, 'click', () => { index--; draw(); }, done.signal);
  on(next, 'click', () => { index++; draw(); }, done.signal);
  const change = (patch: (p: PageSetup) => PageSetup) => {
    setPage(ctx, patch);
    read();
    draw();
  };
  on(paper, 'change', () => change(p => ({ ...p, paper: paper.value as Paper })), done.signal);
  on(orient, 'change', () => change(p => ({ ...p, orient: orient.value as PageSetup['orient'] })), done.signal);
  on(margins, 'change', () => {
    if (margins.value !== 'custom') change(p => ({ ...p, margins: { ...MARGINS[margins.value as 'normal'] } }));
  }, done.signal);
  on(scaling, 'change', () => {
    const v = scaling.value;
    if (v === 'custom') return;
    change(p => ({ ...p, scale: 100, fit: v === 'none' ? null : v === 'page' ? { w: 1, h: 1 } : v === 'cols' ? { w: 1, h: 0 } : { w: 0, h: 1 } }));
  }, done.signal);
  on(gridlines, 'change', () => change(p => ({ ...p, gridlines: gridlines.checked })), done.signal);
  read();
  draw();
  const body = h('div', { class: 'pp-dialog' },
    h('div', { class: 'pp-side' },
      h('label', { class: 'dialog-label' }, 'Paper', paper),
      h('label', { class: 'dialog-label' }, 'Orientation', orient),
      h('label', { class: 'dialog-label' }, 'Margins', margins),
      h('label', { class: 'dialog-label' }, 'Scaling', scaling),
      h('label', { class: 'chart-check' }, gridlines, ' Print gridlines'),
      setupBtn,
      h('p', { class: 'dialog-detail' }, 'Changes here are kept with the sheet (Ctrl+Z takes them back).')),
    h('div', { class: 'pp-main' }, view, h('div', { class: 'pp-nav' }, prev, count, next)));
  for (;;) {
    let toSetup = false;
    const setupDone = new AbortController();
    const answer = await new Promise<'print' | 'pdf' | 'save' | null>(resolve => {
      void shell.dialogs.ask<'print' | 'pdf' | 'save' | null>({
        title: `Print: ${wb.sheets[wb.active].name}`,
        body,
        buttons: [{ label: 'Print', value: 'print', primary: true }, { label: 'Download PDF', value: 'pdf' }, { label: 'Save PDF in Documents', value: 'save' }, { label: 'Close', value: null }],
        cancel: null,
        focus: () => paper,
      }).then(resolve);
      // Page setup opens over the preview: the preview closes, the setup opens, then the preview comes back.
      on(setupBtn, 'click', () => {
        toSetup = true;
        (body.closest('.dialog')?.querySelector('.dialog-buttons button:last-child') as HTMLButtonElement | null)?.click();
      }, setupDone.signal);
    });
    setupDone.abort();
    if (toSetup) {
      await pageSetupDialog(ctx);
      read();
      draw();
      continue;
    }
    done.abort();
    if (answer === 'print') printNow(ctx);
    else if (answer === 'pdf') await downloadPdf(ctx);
    else if (answer === 'save') await savePdfInDocuments(ctx);
    break;
  }
  grid.focus();
}
