// The parts of an Excel file added with charts and printing: conditional formatting (and the "dxf" looks it uses),
// data validation, page setup (margins, paper, scaling, header and footer, print area and titles), and charts (the
// drawing that places them and each chart's own part). Read into this spreadsheet's rules, and written back as Excel
// writes them. What cannot be kept is counted, so the person is told. Our own code; no browser needed.
import { cleanChart, refRange, SERIES_COLOURS, chartData, type Chart, type ChartSeries, type ChartType } from './chart.ts';
import { cleanRule, type CellOp, type CfEntry, type CfFormat, type CfRule } from './condfmt.ts';
import { cleanPage, defaultPage, PAPERS, type PageSetup, type Paper } from './print.ts';
import { addressOf, colName, MAX_COLS, MAX_ROWS } from './refs.ts';
import { cleanValidation, type DvType, type Validation } from './validate.ts';
import type { Range, Sheet, Workbook } from './workbook.ts';
import { child, children, escapeXml, tag, type XmlEl } from '../../core/xml.ts';
import { applyTint, fromExcelFormula, parseRange, rangeText, readColour, toExcelFormula } from './xlsx.ts';

/** Things in the file that could not be kept, counted while reading. */
export interface PartsReport {
  cfOther: number;
  dvOther: number;
  chartsOther: string[];
  pageOther: number;
}

export const newPartsReport = (): PartsReport => ({ cfOther: 0, dvOther: 0, chartsOther: [], pageOther: 0 });

const on = (v: string | undefined) => v === '1' || v === 'true';
const sqref = (text: string | undefined): Range[] => (text ?? '').split(/\s+/).filter(Boolean).map(parseRange).filter((r): r is Range => r !== null && r.c0 < MAX_COLS && r.r0 < MAX_ROWS)
  .map(r => ({ ...r, c1: Math.min(r.c1, MAX_COLS - 1), r1: Math.min(r.r1, MAX_ROWS - 1) }));

// ---- Conditional formatting -----------------------------------------------------------------------------------------

/** The looks conditional formats point at (styles.xml <dxfs>). In a dxf, a solid fill's colour is its background colour. */
export function readDxfs(styles: XmlEl | null, theme: string[]): CfFormat[] {
  return children(child(styles ?? undefined, 'dxfs'), 'dxf').map(d => {
    const out: CfFormat = {};
    const font = child(d, 'font');
    const yes = (el: XmlEl | undefined) => !!el && el.attrs.val !== '0' && el.attrs.val !== 'false' && el.attrs.val !== 'none';
    if (yes(child(font, 'b'))) out.b = true;
    if (yes(child(font, 'i'))) out.i = true;
    if (yes(child(font, 'u'))) out.u = true;
    const colour = readColour(child(font, 'color'), theme);
    if (colour) out.color = colour;
    const pf = child(child(d, 'fill'), 'patternFill');
    if (pf && pf.attrs.patternType !== 'none') {
      const fill = readColour(child(pf, 'bgColor'), theme) ?? readColour(child(pf, 'fgColor'), theme);
      if (fill) out.fill = fill;
    }
    return out;
  });
}

const CELL_OPS: Record<string, CellOp> = {
  greaterThan: 'gt', lessThan: 'lt', greaterThanOrEqual: 'ge', lessThanOrEqual: 'le', equal: 'eq', notEqual: 'ne', between: 'between', notBetween: 'notBetween',
};
const OPS_BACK = Object.fromEntries(Object.entries(CELL_OPS).map(([k, v]) => [v, k])) as Record<CellOp, string>;

/** A sheet's conditional formatting, highest priority first. */
export function readCf(ws: XmlEl, dxfs: CfFormat[], theme: string[], report: PartsReport): CfEntry[] {
  const found: Array<{ priority: number; entry: CfEntry }> = [];
  for (const block of children(ws, 'conditionalFormatting')) {
    const ranges = sqref(block.attrs.sqref);
    if (!ranges.length) continue;
    for (const r of children(block, 'cfRule')) {
      const fmt = dxfs[Number(r.attrs.dxfId ?? -1)] ?? {};
      const formulas = children(r, 'formula').map(f => fromExcelFormula(f.text.trim()) ?? '');
      let rule: CfRule | null = null;
      switch (r.attrs.type) {
        case 'cellIs': {
          const op = CELL_OPS[r.attrs.operator ?? ''];
          if (op && formulas[0]) rule = { t: 'cell', op, f1: formulas[0], ...(op === 'between' || op === 'notBetween' ? { f2: formulas[1] ?? '' } : {}), fmt };
          break;
        }
        case 'containsText': rule = { t: 'text', op: 'contains', text: r.attrs.text ?? '', fmt }; break;
        case 'notContainsText': rule = { t: 'text', op: 'notContains', text: r.attrs.text ?? '', fmt }; break;
        case 'beginsWith': rule = { t: 'text', op: 'begins', text: r.attrs.text ?? '', fmt }; break;
        case 'endsWith': rule = { t: 'text', op: 'ends', text: r.attrs.text ?? '', fmt }; break;
        case 'top10': rule = { t: 'top', n: Math.max(1, Math.min(1000, Number(r.attrs.rank ?? 10) || 10)), bottom: on(r.attrs.bottom) || undefined, percent: on(r.attrs.percent) || undefined, fmt }; break;
        case 'aboveAverage':
          // Above or below by some standard deviations is not kept (plain above/below average is).
          if (!r.attrs.stdDev) rule = { t: 'avg', below: r.attrs.aboveAverage === '0' || r.attrs.aboveAverage === 'false' || undefined, fmt };
          break;
        case 'duplicateValues': rule = { t: 'dup', fmt }; break;
        case 'uniqueValues': rule = { t: 'dup', unique: true, fmt }; break;
        case 'containsBlanks': rule = { t: 'blank', fmt }; break;
        case 'notContainsBlanks': rule = { t: 'blank', not: true, fmt }; break;
        case 'expression': if (formulas[0]) rule = { t: 'expr', f: formulas[0], fmt }; break;
        case 'colorScale': {
          const colours = children(child(r, 'colorScale'), 'color').map(c => readColour(c, theme)).filter((c): c is string => !!c);
          if (colours.length === 2 || colours.length === 3) rule = { t: 'scale', colours };
          break;
        }
        case 'dataBar': {
          const colour = readColour(child(child(r, 'dataBar'), 'color'), theme);
          rule = { t: 'bar', colour: colour ?? '#638ec6' };
          break;
        }
      }
      const clean = rule ? cleanRule(rule) : null;
      if (!clean) {
        report.cfOther++;
        continue;
      }
      found.push({ priority: Number(r.attrs.priority ?? 1e6), entry: { ranges, rule: clean, ...(on(r.attrs.stopIfTrue) ? { stop: true } : {}) } });
    }
  }
  return found.sort((a, b) => a.priority - b.priority).map(f => f.entry);
}

const argb = (hex: string) => `FF${hex.slice(1).toUpperCase()}`;

/** The <dxf> for a look, as Excel writes it. */
export function dxfXml(fmt: CfFormat): string {
  const font = fmt.b || fmt.i || fmt.u || fmt.color ? `<font>${fmt.b ? '<b/>' : ''}${fmt.i ? '<i/>' : ''}${fmt.u ? '<u/>' : ''}${fmt.color ? `<color rgb="${argb(fmt.color)}"/>` : ''}</font>` : '';
  const fill = fmt.fill ? `<fill><patternFill><bgColor rgb="${argb(fmt.fill)}"/></patternFill></fill>` : '';
  return `<dxf>${font}${fill}</dxf>`;
}

/** A sheet's conditional formatting as Excel writes it. `dxf` adds a look to styles.xml and gives its number. */
export function writeCf(sheet: Sheet, dxf: (fmt: CfFormat) => number, firstPriority: number): { xml: string; used: number } {
  let priority = firstPriority;
  const parts: string[] = [];
  for (const e of sheet.cf) {
    const r = e.rule;
    const tl = addressOf(e.ranges[0].c0, e.ranges[0].r0);
    const base: Record<string, string | number | undefined> = { priority: priority++, stopIfTrue: e.stop ? 1 : undefined };
    const f = (text: string) => `<formula>${escapeXml(toExcelFormula(text))}</formula>`;
    const quoted = (t: string) => `"${t.replace(/"/g, '""')}"`;
    let xml: string;
    switch (r.t) {
      case 'cell': xml = tag('cfRule', { type: 'cellIs', dxfId: dxf(r.fmt), ...base, operator: OPS_BACK[r.op] }, f(r.f1) + (r.f2 !== undefined && (r.op === 'between' || r.op === 'notBetween') ? f(r.f2) : '')); break;
      case 'text': {
        const type = { contains: 'containsText', notContains: 'notContainsText', begins: 'beginsWith', ends: 'endsWith' }[r.op];
        const op = { contains: 'containsText', notContains: 'notContains', begins: 'beginsWith', ends: 'endsWith' }[r.op];
        // Excel keeps the test as a formula too (and reads that one).
        const test = r.op === 'contains' ? `NOT(ISERROR(SEARCH(${quoted(r.text)},${tl})))` : r.op === 'notContains' ? `ISERROR(SEARCH(${quoted(r.text)},${tl}))`
          : r.op === 'begins' ? `LEFT(${tl},LEN(${quoted(r.text)}))=${quoted(r.text)}` : `RIGHT(${tl},LEN(${quoted(r.text)}))=${quoted(r.text)}`;
        xml = tag('cfRule', { type, dxfId: dxf(r.fmt), ...base, operator: op, text: r.text }, f(test));
        break;
      }
      case 'top': xml = tag('cfRule', { type: 'top10', dxfId: dxf(r.fmt), ...base, percent: r.percent ? 1 : undefined, bottom: r.bottom ? 1 : undefined, rank: r.n }); break;
      case 'avg': xml = tag('cfRule', { type: 'aboveAverage', dxfId: dxf(r.fmt), ...base, aboveAverage: r.below ? 0 : undefined }); break;
      case 'dup': xml = tag('cfRule', { type: r.unique ? 'uniqueValues' : 'duplicateValues', dxfId: dxf(r.fmt), ...base }); break;
      case 'blank': xml = tag('cfRule', { type: r.not ? 'notContainsBlanks' : 'containsBlanks', dxfId: dxf(r.fmt), ...base }, f(r.not ? `LEN(TRIM(${tl}))>0` : `LEN(TRIM(${tl}))=0`)); break;
      case 'expr': xml = tag('cfRule', { type: 'expression', dxfId: dxf(r.fmt), ...base }, f(r.f)); break;
      case 'scale': {
        const points = r.colours.length === 3 ? '<cfvo type="min"/><cfvo type="percentile" val="50"/><cfvo type="max"/>' : '<cfvo type="min"/><cfvo type="max"/>';
        xml = tag('cfRule', { type: 'colorScale', ...base }, `<colorScale>${points}${r.colours.map(c => `<color rgb="${argb(c)}"/>`).join('')}</colorScale>`);
        break;
      }
      case 'bar':
        // The bars start from zero here (Excel's "automatic" ends for values above zero).
        xml = tag('cfRule', { type: 'dataBar', ...base }, `<dataBar><cfvo type="num" val="0"/><cfvo type="max"/><color rgb="${argb(r.colour)}"/></dataBar>`);
        break;
    }
    parts.push(tag('conditionalFormatting', { sqref: e.ranges.map(rangeText).join(' ') }, xml));
  }
  return { xml: parts.join(''), used: priority - firstPriority };
}

// ---- Data validation ------------------------------------------------------------------------------------------------

const DV_TYPES: Record<string, DvType> = { whole: 'whole', decimal: 'decimal', list: 'list', date: 'date', time: 'time', textLength: 'length', custom: 'custom', none: 'any' };

function readOneDv(el: XmlEl, ranges: Range[], formula: (name: string) => string | undefined, report: PartsReport): Validation | null {
  const type = DV_TYPES[el.attrs.type ?? 'none'];
  if (!type) {
    report.dvOther++;
    return null;
  }
  const f1 = formula('formula1') ?? '';
  const f2 = formula('formula2') ?? '';
  const raw = {
    type, op: CELL_OPS[el.attrs.operator ?? 'between'] ?? 'between',
    f1: type === 'list' && /^".*"$/s.test(f1) ? f1 : fromExcelFormula(f1) ?? '', f2: fromExcelFormula(f2) ?? '',
    blank: on(el.attrs.allowBlank),
    // Excel's showDropDown="1" HIDES the drop-down (the name says the opposite).
    dropdown: !on(el.attrs.showDropDown),
    prompt: { show: on(el.attrs.showInputMessage), title: el.attrs.promptTitle ?? '', text: el.attrs.prompt ?? '' },
    error: { show: on(el.attrs.showErrorMessage), style: el.attrs.errorStyle === 'warning' ? 'warning' : el.attrs.errorStyle === 'information' ? 'info' : 'stop', title: el.attrs.errorTitle ?? '', text: el.attrs.error ?? '' },
  };
  const v = cleanValidation(raw, ranges);
  if (!v) report.dvOther++;
  return v;
}

/** A sheet's data validation rules, from its own list and from Excel 2010's list (rules that read another sheet). */
export function readDv(ws: XmlEl, report: PartsReport): Validation[] {
  const out: Validation[] = [];
  for (const el of children(child(ws, 'dataValidations'), 'dataValidation')) {
    const ranges = sqref(el.attrs.sqref);
    if (!ranges.length) continue;
    const v = readOneDv(el, ranges, name => child(el, name)?.text.trim(), report);
    if (v) out.push(v);
  }
  for (const ext of children(child(ws, 'extLst'), 'ext')) {
    for (const el of children(child(ext, 'dataValidations'), 'dataValidation')) {
      const ranges = sqref(child(el, 'sqref')?.text);
      if (!ranges.length) continue;
      const v = readOneDv(el, ranges, name => child(child(el, name), 'f')?.text.trim(), report);
      if (v) out.push(v);
    }
  }
  return out;
}

export function writeDv(sheet: Sheet): string {
  if (!sheet.dv.length) return '';
  const back: Record<DvType, string | undefined> = { any: undefined, whole: 'whole', decimal: 'decimal', list: 'list', date: 'date', time: 'time', length: 'textLength', custom: 'custom' };
  const items = sheet.dv.map(v => {
    const ranged = v.type !== 'any' && v.type !== 'list' && v.type !== 'custom';
    const two = ranged && (v.op === 'between' || v.op === 'notBetween');
    const f1 = v.type === 'any' ? '' : `<formula1>${escapeXml(v.type === 'list' && /^".*"$/s.test(v.f1) ? v.f1 : toExcelFormula(v.f1))}</formula1>`;
    const f2 = two ? `<formula2>${escapeXml(toExcelFormula(v.f2))}</formula2>` : '';
    return tag('dataValidation', {
      type: back[v.type], errorStyle: v.error.style === 'stop' ? undefined : v.error.style === 'info' ? 'information' : 'warning',
      operator: ranged && v.op !== 'between' ? OPS_BACK[v.op] : undefined, allowBlank: v.blank ? 1 : undefined,
      showDropDown: v.type === 'list' && !v.dropdown ? 1 : undefined, showInputMessage: v.prompt.show ? 1 : undefined, showErrorMessage: v.error.show ? 1 : undefined,
      errorTitle: v.error.title || undefined, error: v.error.text || undefined, promptTitle: v.prompt.title || undefined, prompt: v.prompt.text || undefined,
      sqref: v.ranges.map(rangeText).join(' '),
    }, f1 + f2);
  });
  return `<dataValidations count="${items.length}">${items.join('')}</dataValidations>`;
}

// ---- Page setup -----------------------------------------------------------------------------------------------------

const PAPER_BY_CODE: Record<number, Paper> = { 1: 'letter', 5: 'legal', 8: 'a3', 9: 'a4' };

/** A sheet's page setup from its own parts (the print area and titles are workbook names, added by the caller). */
export function readPage(ws: XmlEl, report: PartsReport): PageSetup | null {
  const ps = child(ws, 'pageSetup');
  const po = child(ws, 'printOptions');
  const pm = child(ws, 'pageMargins');
  const hf = child(ws, 'headerFooter');
  const fitPr = child(child(ws, 'sheetPr'), 'pageSetUpPr');
  if (!ps && !po && !hf) return null;
  const page = defaultPage();
  if (ps) {
    const code = Number(ps.attrs.paperSize ?? 0);
    if (PAPER_BY_CODE[code]) page.paper = PAPER_BY_CODE[code];
    else if (code) report.pageOther++;
    if (ps.attrs.orientation === 'landscape') page.orient = 'landscape';
    const scale = Number(ps.attrs.scale);
    if (Number.isFinite(scale) && scale >= 10 && scale <= 400) page.scale = Math.round(scale);
    if (ps.attrs.pageOrder === 'overThenDown') page.order = 'over';
  }
  if (on(fitPr?.attrs.fitToPage)) {
    const n = (v: string | undefined) => (v === undefined ? 1 : Math.max(0, Math.min(999, Math.round(Number(v)) || 0)));
    page.fit = { w: n(ps?.attrs.fitToWidth), h: n(ps?.attrs.fitToHeight) };
    if (!page.fit.w && !page.fit.h) page.fit = null;
  }
  if (po) {
    page.gridlines = on(po.attrs.gridLines);
    page.headings = on(po.attrs.headings);
    page.centerH = on(po.attrs.horizontalCentered);
    page.centerV = on(po.attrs.verticalCentered);
  }
  if (pm) {
    for (const [k, attr] of [['l', 'left'], ['r', 'right'], ['t', 'top'], ['b', 'bottom'], ['header', 'header'], ['footer', 'footer']] as const) {
      const v = Number(pm.attrs[attr]);
      if (Number.isFinite(v) && v >= 0 && v <= 5) page.margins[k] = v;
    }
  }
  if (hf) {
    page.header = (child(hf, 'oddHeader')?.text ?? '').slice(0, 255);
    page.footer = (child(hf, 'oddFooter')?.text ?? '').slice(0, 255);
    if (on(hf.attrs.differentFirst) || on(hf.attrs.differentOddEven)) report.pageOther++;
  }
  if (child(ws, 'rowBreaks') || child(ws, 'colBreaks')) report.pageOther++;
  return cleanPage(page, () => page.area);
}

/** "'Sheet 1'!$1:$2,'Sheet 1'!$A:$A" (print titles) or "'Sheet 1'!$A$1:$F$40" (print area), the sheet part dropped. */
export function readPrintNames(text: string): { area: Range | null; rows: [number, number] | null; cols: [number, number] | null; many: boolean } {
  const out = { area: null as Range | null, rows: null as [number, number] | null, cols: null as [number, number] | null, many: false };
  const parts = text.split(/,(?=(?:[^']*'[^']*')*[^']*$)/).map(p => p.trim().replace(/^.*!/, '').replace(/\$/g, ''));
  for (const p of parts) {
    let m = /^(\d+):(\d+)$/.exec(p);
    if (m) {
      out.rows = [Math.min(MAX_ROWS - 1, Number(m[1]) - 1), Math.min(MAX_ROWS - 1, Number(m[2]) - 1)];
      continue;
    }
    m = /^([A-Za-z]{1,3}):([A-Za-z]{1,3})$/.exec(p);
    if (m) {
      const idx = (s: string) => [...s.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      out.cols = [Math.min(MAX_COLS - 1, idx(m[1])), Math.min(MAX_COLS - 1, idx(m[2]))];
      continue;
    }
    const r = parseRange(p);
    if (r) {
      if (out.area) out.many = true;
      else out.area = { ...r, c1: Math.min(r.c1, MAX_COLS - 1), r1: Math.min(r.r1, MAX_ROWS - 1) };
    }
  }
  return out;
}

/** The page setup parts of a worksheet, in the order Excel's schema puts them. */
export function writePage(sheet: Sheet): { sheetPr: string; printOptions: string; margins: string; setup: string; headerFooter: string } {
  const p = sheet.page;
  if (!p) return { sheetPr: '', printOptions: '', margins: '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>', setup: '', headerFooter: '' };
  const m = p.margins;
  const any = p.gridlines || p.headings || p.centerH || p.centerV;
  return {
    sheetPr: p.fit ? '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' : '',
    printOptions: any ? tag('printOptions', { horizontalCentered: p.centerH ? 1 : undefined, verticalCentered: p.centerV ? 1 : undefined, headings: p.headings ? 1 : undefined, gridLines: p.gridlines ? 1 : undefined }) : '',
    margins: tag('pageMargins', { left: m.l, right: m.r, top: m.t, bottom: m.b, header: m.header, footer: m.footer }),
    setup: tag('pageSetup', {
      paperSize: PAPERS[p.paper].code, scale: p.fit ? undefined : p.scale, fitToWidth: p.fit ? p.fit.w : undefined, fitToHeight: p.fit ? p.fit.h : undefined,
      pageOrder: p.order === 'over' ? 'overThenDown' : undefined, orientation: p.orient,
    }),
    headerFooter: p.header || p.footer ? `<headerFooter>${p.header ? `<oddHeader>${escapeXml(p.header)}</oddHeader>` : ''}${p.footer ? `<oddFooter>${escapeXml(p.footer)}</oddFooter>` : ''}</headerFooter>` : '',
  };
}

/** The workbook names for a sheet's print area and print titles. */
export function printNames(sheet: Sheet, s: number): string[] {
  const p = sheet.page;
  if (!p) return [];
  const q = `'${sheet.name.replace(/'/g, "''")}'`;
  const out: string[] = [];
  if (p.area) out.push(tag('definedName', { name: '_xlnm.Print_Area', localSheetId: s }, escapeXml(`${q}!$${colName(p.area.c0)}$${p.area.r0 + 1}:$${colName(p.area.c1)}$${p.area.r1 + 1}`)));
  const titles: string[] = [];
  if (p.titleCols) titles.push(`${q}!$${colName(p.titleCols[0])}:$${colName(p.titleCols[1])}`);
  if (p.titleRows) titles.push(`${q}!$${p.titleRows[0] + 1}:$${p.titleRows[1] + 1}`);
  if (titles.length) out.push(tag('definedName', { name: '_xlnm.Print_Titles', localSheetId: s }, escapeXml(titles.join(','))));
  return out;
}

// ---- Charts ---------------------------------------------------------------------------------------------------------

const EMU = 9525;
const THEME_ORDER = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];

/** A DrawingML colour (a:srgbClr, a:schemeClr with its lightening or darkening) as #rrggbb. */
function drawingColour(holder: XmlEl | undefined, theme: string[]): string | undefined {
  const fill = child(holder, 'solidFill');
  if (!fill) return undefined;
  const rgb = child(fill, 'srgbClr');
  let hex: string | undefined;
  let mods: XmlEl | undefined = rgb;
  if (rgb?.attrs.val && /^[0-9a-f]{6}$/i.test(rgb.attrs.val)) hex = rgb.attrs.val.toUpperCase();
  else {
    const scheme = child(fill, 'schemeClr');
    const name = { tx1: 'dk1', bg1: 'lt1', tx2: 'dk2', bg2: 'lt2' }[scheme?.attrs.val ?? ''] ?? scheme?.attrs.val ?? '';
    const i = THEME_ORDER.indexOf(name);
    if (i >= 0) hex = theme[i];
    mods = scheme;
  }
  if (!hex) return undefined;
  // lumMod 75% darkens by a quarter; lumMod 60% with lumOff 40% lightens by two fifths (Excel's own shades).
  const lumMod = Number(child(mods, 'lumMod')?.attrs.val ?? 100000) / 100000;
  const lumOff = Number(child(mods, 'lumOff')?.attrs.val ?? 0) / 100000;
  const tint = lumOff > 0 ? lumOff : lumMod < 1 ? lumMod - 1 : 0;
  return `#${applyTint(hex, Math.max(-1, Math.min(1, tint))).toLowerCase()}`;
}

/** All the text inside a chart title's rich text (its runs joined), or its cell's last value. */
function titleText(title: XmlEl | undefined): string | null {
  const tx = child(title, 'tx');
  if (!tx) return null;
  const rich = child(tx, 'rich');
  if (rich) {
    return children(rich, 'p').map(p => [...children(p, 'r'), ...children(p, 'fld')].map(r => child(r, 't')?.text ?? '').join('')).join(' ').trim();
  }
  const cached = child(child(child(tx, 'strRef'), 'strCache'), 'pt');
  return child(cached, 'v')?.text ?? '';
}

/** A series part (tx, cat, val, xVal, yVal) as a reference, or a list constant for numbers written into the file. */
function seriesRef(el: XmlEl | undefined): string {
  if (!el) return '';
  for (const kind of ['numRef', 'strRef', 'multiLvlStrRef']) {
    const f = child(child(el, kind), 'f')?.text.trim();
    if (f) return fromExcelFormula(f) ?? '';
  }
  for (const kind of ['numLit', 'strLit']) {
    const lit = child(el, kind);
    if (!lit) continue;
    const pts = children(lit, 'pt').map(p => child(p, 'v')?.text ?? '');
    if (!pts.length) return '';
    return `{${pts.slice(0, 1000).map(v => (kind === 'numLit' && Number.isFinite(Number(v)) ? String(Number(v)) : `"${v.replace(/"/g, '""')}"`)).join(',')}}`;
  }
  return '';
}

const GROUPS: Record<string, ChartType | null> = {
  barChart: 'column', bar3DChart: 'column', lineChart: 'line', line3DChart: 'line', areaChart: 'area', area3DChart: 'area',
  pieChart: 'pie', pie3DChart: 'pie', ofPieChart: 'pie', doughnutChart: 'doughnut', scatterChart: 'scatter',
  radarChart: null, bubbleChart: null, stockChart: null, surfaceChart: null, surface3DChart: null,
};
const KIND_WORDS: Record<string, string> = { radarChart: 'radar', bubbleChart: 'bubble', stockChart: 'stock', surfaceChart: 'surface', surface3DChart: '3-D surface' };

/** One chart part (xl/charts/chartN.xml) as a chart of this spreadsheet, or null (with the reason counted). */
export function readChartPart(xml: XmlEl, theme: string[], report: PartsReport): Omit<Chart, 'id' | 'at' | 'w' | 'h'> | null {
  const chartEl = child(xml, 'chart');
  const plot = child(chartEl, 'plotArea');
  if (!chartEl || !plot) {
    report.chartsOther.push('a chart that could not be read');
    return null;
  }
  const groups = plot.kids.filter(k => k.name in GROUPS);
  const first = groups.find(g => GROUPS[g.name]);
  if (!first) {
    report.chartsOther.push(`a ${groups.map(g => KIND_WORDS[g.name] ?? 'kind of').join('/') || 'kind of'} chart, a kind this spreadsheet does not draw`);
    return null;
  }
  let type = GROUPS[first.name]!;
  if (first.name.includes('3D')) report.chartsOther.push('a 3-D chart, shown flat');
  if (first.name === 'ofPieChart') report.chartsOther.push('a pie-of-pie chart, shown as one pie');
  if (groups.length > 1) report.chartsOther.push('a combination chart, shown as one kind');
  if (type === 'column' && child(first, 'barDir')?.attrs.val === 'bar') type = 'bar';
  const grouping = child(first, 'grouping')?.attrs.val;
  const group = (type === 'column' || type === 'bar' || type === 'area') && grouping === 'stacked' ? 'stacked' as const : grouping === 'percentStacked' && (type === 'column' || type === 'bar' || type === 'area') ? 'percent' as const : undefined;
  let labels = on(child(child(first, 'dLbls'), 'showVal')?.attrs.val);
  const series: ChartSeries[] = [];
  for (const g of groups) {
    if (!GROUPS[g.name]) continue;
    for (const ser of children(g, 'ser')) {
      const tx = child(ser, 'tx');
      const nameRef = child(child(tx, 'strRef'), 'f')?.text.trim();
      const name = nameRef ? `=${fromExcelFormula(nameRef) ?? nameRef}` : child(tx, 'v')?.text ?? '';
      const val = seriesRef(child(ser, type === 'scatter' ? 'yVal' : 'val') ?? child(ser, 'val'));
      const cat = seriesRef(child(ser, type === 'scatter' ? 'xVal' : 'cat') ?? child(ser, 'cat'));
      if (!val) continue;
      const sp = child(ser, 'spPr');
      const colour = type === 'line' ? drawingColour(child(sp, 'ln'), theme) : drawingColour(sp, theme);
      const one: ChartSeries = { name, cat, val };
      if (colour && colour !== SERIES_COLOURS[series.length % SERIES_COLOURS.length]) one.colour = colour;
      series.push(one);
      if (on(child(child(ser, 'dLbls'), 'showVal')?.attrs.val)) labels = true;
    }
  }
  if (!series.length) {
    report.chartsOther.push('a chart with no series this spreadsheet can read');
    return null;
  }
  // The title: its own text; none when Excel's automatic title was deleted; else automatic (the series name).
  const titleEl = child(chartEl, 'title');
  const deleted = on(child(chartEl, 'autoTitleDeleted')?.attrs.val);
  // (Automatic shows the one series's name; with several series it shows nothing, as Excel does.)
  const title = titleEl ? titleText(titleEl) : deleted ? '' : null;
  const legendEl = child(chartEl, 'legend');
  const pos = child(legendEl, 'legendPos')?.attrs.val ?? 'r';
  const legend: Chart['legend'] = !legendEl ? 'none' : pos === 'b' ? 'b' : pos === 't' ? 't' : pos === 'l' ? 'l' : 'r';
  let xTitle: string | undefined;
  let yTitle: string | undefined;
  for (const ax of plot.kids.filter(k => k.name === 'catAx' || k.name === 'valAx' || k.name === 'dateAx')) {
    if (on(child(ax, 'delete')?.attrs.val)) continue;
    const t = titleText(child(ax, 'title'));
    if (!t) continue;
    const at = child(ax, 'axPos')?.attrs.val;
    if (at === 'b' || at === 't') xTitle = t;
    else yTitle = t;
  }
  return { type, group, title, series, legend, xTitle, yTitle, labels: labels || undefined };
}

/** Where a drawing anchor puts its chart: a cell and offset (pixels), and its size, from the sheet's column widths. */
export function anchorOf(anchor: XmlEl, colPx: (c: number) => number, rowPx: (r: number) => number): { at: Chart['at']; w: number; h: number } | null {
  const pos = (el: XmlEl | undefined) => el && {
    col: Math.max(0, Math.min(MAX_COLS - 1, Number(child(el, 'col')?.text ?? 0) || 0)), dx: Math.round((Number(child(el, 'colOff')?.text ?? 0) || 0) / EMU),
    row: Math.max(0, Math.min(MAX_ROWS - 1, Number(child(el, 'row')?.text ?? 0) || 0)), dy: Math.round((Number(child(el, 'rowOff')?.text ?? 0) || 0) / EMU),
  };
  const ext = (el: XmlEl | undefined) => (el ? { w: Math.round(Number(el.attrs.cx ?? 0) / EMU), h: Math.round(Number(el.attrs.cy ?? 0) / EMU) } : null);
  if (anchor.name === 'twoCellAnchor') {
    const from = pos(child(anchor, 'from'));
    const to = pos(child(anchor, 'to'));
    if (!from || !to) return null;
    let w = to.dx - from.dx;
    for (let c = from.col; c < to.col; c++) w += colPx(c);
    let h = to.dy - from.dy;
    for (let r = from.row; r < to.row; r++) h += rowPx(r);
    return { at: { col: from.col, row: from.row, dx: from.dx, dy: from.dy }, w, h };
  }
  if (anchor.name === 'oneCellAnchor') {
    const from = pos(child(anchor, 'from'));
    const size = ext(child(anchor, 'ext'));
    if (!from || !size) return null;
    return { at: { col: from.col, row: from.row, dx: from.dx, dy: from.dy }, w: size.w, h: size.h };
  }
  if (anchor.name === 'absoluteAnchor') {
    const p = child(anchor, 'pos');
    const size = ext(child(anchor, 'ext'));
    if (!p || !size) return null;
    // From the sheet's top-left corner: the cell under that point.
    let x = Math.round(Number(p.attrs.x ?? 0) / EMU);
    let y = Math.round(Number(p.attrs.y ?? 0) / EMU);
    let col = 0;
    while (col < MAX_COLS - 1 && x >= colPx(col) && colPx(col) > 0) x -= colPx(col++);
    let row = 0;
    while (row < MAX_ROWS - 1 && y >= rowPx(row) && rowPx(row) > 0) y -= rowPx(row++);
    return { at: { col, row, dx: x, dy: y }, ...size };
  }
  return null;
}

/** A finished chart from what a file said, checked as a saved chart is. */
export function finishChart(made: Omit<Chart, 'id' | 'at' | 'w' | 'h'>, place: { at: Chart['at']; w: number; h: number }, id: number): Chart | null {
  return cleanChart({ ...made, ...place, id });
}

// ---- Writing a chart ------------------------------------------------------------------------------------------------

const NS_C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export const NS_XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
const MARKER_SYMBOL = ['circle', 'square', 'diamond', 'triangle', 'x', 'plus', 'star'];

const rich = (text: string, rot = 0) => `<c:tx><c:rich><a:bodyPr${rot ? ` rot="${rot}" vert="horz"` : ''}/><a:lstStyle/><a:p><a:r><a:t>${escapeXml(text)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/>`;
const fillOf = (hex: string) => `<a:solidFill><a:srgbClr val="${hex.slice(1).toUpperCase()}"/></a:solidFill>`;

/** One chart as Excel's chart part (xl/charts/chartN.xml), with the values it shows saved beside its references. */
export function chartXml(wb: Workbook, s: number, chart: Chart): string {
  const data = chartData(wb, s, chart);
  const t = chart.type;
  const round = t === 'pie' || t === 'doughnut';
  const plainRef = (text: string) => !!text && !!refRange(wb, s, text);
  const strCache = (vals: string[]) => `<c:strCache><c:ptCount val="${vals.length}"/>${vals.map((v, i) => `<c:pt idx="${i}"><c:v>${escapeXml(v)}</c:v></c:pt>`).join('')}</c:strCache>`;
  const numCache = (vals: Array<number | null>, tagName = 'numCache') => `<c:${tagName}><c:formatCode>General</c:formatCode><c:ptCount val="${vals.length}"/>${vals.map((v, i) => (v === null ? '' : `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`)).join('')}</c:${tagName}>`;
  const strLit = (vals: string[]) => `<c:strLit><c:ptCount val="${vals.length}"/>${vals.map((v, i) => `<c:pt idx="${i}"><c:v>${escapeXml(v)}</c:v></c:pt>`).join('')}</c:strLit>`;
  const ref = (f: string) => escapeXml(toExcelFormula(f));
  const sers = chart.series.map((x, i) => {
    const d = data.series[i];
    const colour = x.colour ?? SERIES_COLOURS[i % SERIES_COLOURS.length];
    const tx = x.name.startsWith('=') && plainRef(x.name.slice(1))
      ? `<c:tx><c:strRef><c:f>${ref(x.name.slice(1))}</c:f>${strCache([d.name])}</c:strRef></c:tx>`
      : x.name ? `<c:tx><c:v>${escapeXml(x.name.replace(/^=/, ''))}</c:v></c:tx>` : '';
    const spPr = t === 'line' ? `<c:spPr><a:ln w="28575" cap="rnd">${fillOf(colour)}<a:round/></a:ln></c:spPr>`
      : t === 'scatter' ? '<c:spPr><a:ln w="19050"><a:noFill/></a:ln></c:spPr>'
        : round ? '' : `<c:spPr>${fillOf(colour)}</c:spPr>`;
    const marker = t === 'line' || t === 'scatter'
      ? `<c:marker><c:symbol val="${MARKER_SYMBOL[i % MARKER_SYMBOL.length]}"/><c:size val="7"/><c:spPr>${fillOf(colour)}<a:ln w="9525">${fillOf('#ffffff')}</a:ln></c:spPr></c:marker>` : '';
    const cats = t === 'scatter' ? (d.xs ?? []) : data.cats;
    let cat = '';
    if (x.cat && plainRef(x.cat)) {
      cat = t === 'scatter' ? `<c:xVal><c:numRef><c:f>${ref(x.cat)}</c:f>${numCache(cats as Array<number | null>)}</c:numRef></c:xVal>` : `<c:cat><c:strRef><c:f>${ref(x.cat)}</c:f>${strCache(cats as string[])}</c:strRef></c:cat>`;
    } else if (x.cat) {
      cat = t === 'scatter' ? `<c:xVal>${numCache(cats as Array<number | null>, 'numLit')}</c:xVal>` : `<c:cat>${strLit(cats as string[])}</c:cat>`;
    }
    const valTag = t === 'scatter' ? 'yVal' : 'val';
    const val = plainRef(x.val) ? `<c:${valTag}><c:numRef><c:f>${ref(x.val)}</c:f>${numCache(d.values)}</c:numRef></c:${valTag}>` : `<c:${valTag}>${numCache(d.values, 'numLit')}</c:${valTag}>`;
    const head = `<c:idx val="${i}"/><c:order val="${i}"/>${tx}${spPr}`;
    switch (t) {
      case 'column': case 'bar': return `<c:ser>${head}<c:invertIfNegative val="0"/>${cat}${val}</c:ser>`;
      case 'line': return `<c:ser>${head}${marker}${cat}${val}<c:smooth val="0"/></c:ser>`;
      case 'scatter': return `<c:ser>${head}${marker}${cat}${val}<c:smooth val="0"/></c:ser>`;
      default: return `<c:ser>${head}${cat}${val}</c:ser>`;
    }
  }).join('');
  const dLbls = chart.labels ? '<c:dLbls><c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls>' : '';
  const grouping = chart.group === 'stacked' ? 'stacked' : chart.group === 'percent' ? 'percentStacked' : t === 'column' || t === 'bar' ? 'clustered' : 'standard';
  const axIds = '<c:axId val="500000001"/><c:axId val="500000002"/>';
  let group: string;
  switch (t) {
    case 'column': case 'bar':
      group = `<c:barChart><c:barDir val="${t === 'bar' ? 'bar' : 'col'}"/><c:grouping val="${grouping}"/><c:varyColors val="0"/>${sers}${dLbls}<c:gapWidth val="150"/>${chart.group ? '<c:overlap val="100"/>' : ''}${axIds}</c:barChart>`;
      break;
    case 'line': group = `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${sers}${dLbls}<c:marker val="1"/>${axIds}</c:lineChart>`; break;
    case 'area': group = `<c:areaChart><c:grouping val="${grouping}"/><c:varyColors val="0"/>${sers}${dLbls}${axIds}</c:areaChart>`; break;
    case 'pie': group = `<c:pieChart><c:varyColors val="1"/>${sers}${dLbls}<c:firstSliceAng val="0"/></c:pieChart>`; break;
    case 'doughnut': group = `<c:doughnutChart><c:varyColors val="1"/>${sers}${dLbls}<c:firstSliceAng val="0"/><c:holeSize val="50"/></c:doughnutChart>`; break;
    default: group = `<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>${sers}${dLbls}${axIds}</c:scatterChart>`;
  }
  const axTitle = (text: string | undefined, vertical: boolean) => (text ? `<c:title>${rich(text, vertical ? -5400000 : 0)}</c:title>` : '');
  const fmt = chart.group === 'percent' ? '0%' : 'General';
  const valAx = (id: number, cross: number, pos: 'l' | 'b', grid: boolean, title: string | undefined, between: 'between' | 'midCat') =>
    `<c:valAx><c:axId val="${id}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${pos}"/>${grid ? '<c:majorGridlines/>' : ''}${axTitle(title, pos === 'l')}<c:numFmt formatCode="${fmt}" sourceLinked="${chart.group === 'percent' ? 0 : 1}"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="${cross}"/><c:crosses val="autoZero"/><c:crossBetween val="${between}"/></c:valAx>`;
  const catAx = (pos: 'b' | 'l', title: string | undefined) =>
    `<c:catAx><c:axId val="500000001"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${pos}"/>${axTitle(title, pos === 'l')}<c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="500000002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`;
  let axes = '';
  if (t === 'scatter') axes = valAx(500000001, 500000002, 'b', false, chart.xTitle, 'midCat') + valAx(500000002, 500000001, 'l', true, chart.yTitle, 'midCat');
  else if (t === 'bar') axes = catAx('l', chart.yTitle) + valAx(500000002, 500000001, 'b', true, chart.xTitle, 'between');
  else if (!round) axes = catAx('b', chart.xTitle) + valAx(500000002, 500000001, 'l', true, chart.yTitle, 'between');
  // Automatic title: none written, so Excel shows the series name itself; no title: Excel's automatic one deleted.
  const titleXml = chart.title ? `<c:title>${rich(chart.title)}</c:title>` : '';
  const legend = chart.legend === 'none' ? '' : `<c:legend><c:legendPos val="${chart.legend}"/><c:overlay val="0"/></c:legend>`;
  return `<c:chartSpace xmlns:c="${NS_C}" xmlns:a="${NS_A}" xmlns:r="${NS_R}"><c:roundedCorners val="0"/><c:chart>${titleXml}<c:autoTitleDeleted val="${chart.title === '' ? 1 : 0}"/><c:plotArea><c:layout/>${group}${axes}</c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`;
}

/** A sheet's charts placed in a drawing part (xl/drawings/drawingN.xml); chart k is relationship rId(k+1). */
export function drawingXml(sheet: Sheet, colPx: (c: number) => number, rowPx: (r: number) => number): string {
  const anchors = sheet.charts.map((ch, k) => {
    // The bottom-right corner: the cell the chart's far edge falls in, and how far into it.
    let x = ch.at.dx + ch.w;
    let col = ch.at.col;
    while (col < MAX_COLS - 1 && colPx(col) > 0 && x > colPx(col)) x -= colPx(col++);
    let y = ch.at.dy + ch.h;
    let row = ch.at.row;
    while (row < MAX_ROWS - 1 && rowPx(row) > 0 && y > rowPx(row)) y -= rowPx(row++);
    const at = (c: number, cOff: number, r: number, rOff: number) => `<xdr:col>${c}</xdr:col><xdr:colOff>${Math.round(cOff * EMU)}</xdr:colOff><xdr:row>${r}</xdr:row><xdr:rowOff>${Math.round(rOff * EMU)}</xdr:rowOff>`;
    return `<xdr:twoCellAnchor editAs="oneCell"><xdr:from>${at(ch.at.col, ch.at.dx, ch.at.row, ch.at.dy)}</xdr:from><xdr:to>${at(col, x, row, y)}</xdr:to>`
      + `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${k + 2}" name="Chart ${k + 1}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>`
      + `<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="${NS_C}"><c:chart xmlns:c="${NS_C}" r:id="rId${k + 1}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`;
  });
  return `<xdr:wsDr xmlns:xdr="${NS_XDR}" xmlns:a="${NS_A}" xmlns:r="${NS_R}">${anchors.join('')}</xdr:wsDr>`;
}

