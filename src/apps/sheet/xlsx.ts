// Excel workbooks (.xlsx, and .xlsm without its macros): opening one into a Workbook, and saving a Workbook as one.
// Our own code: the file is a zip of XML parts (Office Open XML, ECMA-376), read with archive/read.ts and xml.ts.
// What is kept: every sheet's values and formulas, number formats, bold/italic/underline, text and fill colours, borders,
// alignment and wrapping, column widths and row heights, merged cells, frozen panes, hidden rows and columns, the
// filter, and (xlsx-parts.ts) charts, conditional formatting, data validation and page setup. What this spreadsheet does
// not have (pictures, some kinds of chart and rule...) is left out, and the person is told what,
// so nothing is lost without them knowing.
// Formulas: Excel's newer functions are stored with a prefix (_xlfn.XLOOKUP); A1# is stored as _xlfn.ANCHORARRAY(A1);
// a formula that works on lists is stored as a "dynamic array" formula, so Excel 365 fills the cells as it does here.
import { zipDeflate, type ZipEntry } from '../../core/zip.ts';
import { ArchiveError, readZip } from '../archive/read.ts';
import { serialOf, shortDateCode, type DateOrder } from './dates.ts';
import { FUNCTION_NAMES, parseFormula, worksOnLists } from './formula.ts';
import { codeProblem, isDateCode } from './numfmt.ts';
import { addressOf, colName, MAX_COLS, MAX_ROWS, parseCellRef, shiftFormula, SyntaxProblem, tokenize, type Tok } from './refs.ts';
import { CellError, type CellStyle, type Line, type Value } from './values.ts';
import { cleanFilterRule, colOfKey, FILE_FORMAT, keyOf, MAX_CELLS, rowOfKey, type Filter, type FilterRule, type Range, type Workbook } from './workbook.ts';
import { allText, child, children, escapeXml, parseXml, tag, XML_HEAD, XmlProblem, type XmlEl } from './xml.ts';
import {
  anchorOf, chartXml, drawingXml, dxfXml, finishChart, newPartsReport, printNames, readCf, readChartPart, readDv, readDxfs, readPage, readPrintNames,
  writeCf, writeDv, writePage,
} from './xlsx-parts.ts';
import type { Chart } from './chart.ts';
import type { CfFormat } from './condfmt.ts';
import { cleanFace, fontKind } from './fonts.ts';
import { rewriteStructs } from './workbook.ts';
import { dataRows, TOTAL_LABEL, type Table, type TotalFn } from './tables.ts';
import { AGGS, type Agg, type DateGroup, type ShowAs } from './pivot.ts';

/** What opening a file could not keep, said to the person. */
export interface XlsxReport {
  /** Parts of the file left out, in words ("2 charts", "comments on 3 cells"). */
  dropped: string[];
  /** Formulas kept as the answer Excel last saved, because they use something this spreadsheet does not have. */
  asValues: { count: number; examples: string[]; names: string[] };
  /** Formulas whose answer here is not the one Excel saved (worth checking). */
  differ: { count: number; examples: string[] };
}

/** The most an .xlsx may unpack to (its XML) before it is refused. */
const MAX_UNPACKED = 200 * 1024 * 1024;
const MAX_TEXT = 32_000;
const MAX_SHEETS = 50;

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const REL = (kind: string) => `${NS_REL}/${kind}`;
const CT = (kind: string) => `application/vnd.openxmlformats-officedocument.spreadsheetml.${kind}+xml`;

// ---- Small helpers -------------------------------------------------------------------------------------------------

/** "_x000D_" in an Excel string is a character by number (a carriage return); "_x005F_" is a plain underscore. */
function decodeOoxml(s: string): string {
  return s.includes('_x') ? s.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))) : s;
}
function encodeOoxml(s: string): string {
  return s
    .replace(/_x[0-9A-Fa-f]{4}_/g, m => `_x005F_${m.slice(1)}`)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, c => `_x${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_`);
}

export function parseRange(ref: string): Range | null {
  const [a, b] = ref.replace(/\$/g, '').split(':');
  const ra = parseCellRef(a ?? '');
  const rb = b === undefined ? ra : parseCellRef(b);
  if (!ra || !rb) return null;
  return { c0: Math.min(ra.col, rb.col), r0: Math.min(ra.row, rb.row), c1: Math.max(ra.col, rb.col), r1: Math.max(ra.row, rb.row) };
}
export const rangeText = (r: Range): string => (r.c0 === r.c1 && r.r0 === r.r1 ? addressOf(r.c0, r.r0) : `${addressOf(r.c0, r.r0)}:${addressOf(r.c1, r.r1)}`);

/** A1 to column and row, even past the edge of this spreadsheet's sheet (so a cell off the edge can be counted). */
function cellAddress(ref: string): { col: number; row: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(ref);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1].toUpperCase()) col = col * 26 + ch.charCodeAt(0) - 64;
  return { col: col - 1, row: parseInt(m[2], 10) - 1 };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

// ---- Colours -------------------------------------------------------------------------------------------------------

/** Excel's old numbered colours (indexed="10"). */
const INDEXED = [
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF', '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF',
  'FFFF00', 'FF00FF', '00FFFF', '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080', '9999FF', '993366',
  'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF', '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080',
  '0000FF', '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99', '3366FF', '33CCCC', '99CC00', 'FFCC00',
  'FF9900', 'FF6600', '666699', '969696', '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333',
];
/** The standard Office theme, used when a file has no theme of its own: dk1, lt1, dk2, lt2, accent 1-6, links. */
const OFFICE_THEME = ['000000', 'FFFFFF', '44546A', 'E7E6E6', '4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47', '0563C1', '954F72'];

function readTheme(xml: XmlEl | null): string[] {
  const out = [...OFFICE_THEME];
  const scheme = xml ? findDeep(xml, 'clrScheme') : undefined;
  if (!scheme) return out;
  const order = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
  order.forEach((name, i) => {
    const el = child(scheme, name);
    const c = child(el, 'srgbClr')?.attrs.val ?? child(el, 'sysClr')?.attrs.lastClr;
    if (c && /^[0-9A-Fa-f]{6}$/.test(c)) out[i] = c.toUpperCase();
  });
  return out;
}

function findDeep(el: XmlEl, name: string): XmlEl | undefined {
  const stack = [el];
  while (stack.length) {
    const e = stack.pop()!;
    if (e.name === name) return e;
    for (let i = e.kids.length - 1; i >= 0; i--) stack.push(e.kids[i]);
  }
  return undefined;
}

/** Lighter (tint > 0) or darker (tint < 0), as Excel shades a theme colour: on its lightness. */
export function applyTint(hex: string, tint: number): string {
  if (!tint) return hex;
  let r = parseInt(hex.slice(0, 2), 16) / 255;
  let g = parseInt(hex.slice(2, 4), 16) / 255;
  let b = parseInt(hex.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  let l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  l = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  if (s === 0) r = g = b = l;
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue(p, q, h + 1 / 3);
    g = hue(p, q, h);
    b = hue(p, q, h - 1 / 3);
  }
  const to = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0');
  return (to(r) + to(g) + to(b)).toUpperCase();
}

/** A <color> element as #rrggbb, or undefined for "automatic". */
export function readColour(el: XmlEl | undefined, theme: string[]): string | undefined {
  if (!el || el.attrs.auto === '1' || el.attrs.auto === 'true') return undefined;
  let hex: string | undefined;
  const rgb = el.attrs.rgb;
  if (rgb && /^[0-9A-Fa-f]{6,8}$/.test(rgb)) hex = rgb.slice(-6).toUpperCase();
  else if (el.attrs.theme !== undefined) {
    const i = Number(el.attrs.theme);
    // Excel numbers its theme colours light-first: 0 is lt1 (white) and 1 is dk1 (black), then 2 lt2, 3 dk2.
    const swapped = i === 0 ? 1 : i === 1 ? 0 : i === 2 ? 3 : i === 3 ? 2 : i;
    hex = theme[swapped];
  } else if (el.attrs.indexed !== undefined) {
    const i = Number(el.attrs.indexed);
    hex = i === 64 ? '000000' : i === 65 ? 'FFFFFF' : INDEXED[i];
  }
  if (!hex) return undefined;
  const tint = Number(el.attrs.tint ?? 0);
  return `#${applyTint(hex, Number.isFinite(tint) ? Math.max(-1, Math.min(1, tint)) : 0).toLowerCase()}`;
}

// ---- Number formats ------------------------------------------------------------------------------------------------

/** Excel's built-in formats by number (14 and 22 follow the computer's date order, as Excel's do). */
function builtinCode(id: number, order: DateOrder): string | undefined {
  const fixed: Record<number, string> = {
    0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00',
    5: '"$"#,##0_);("$"#,##0)', 6: '"$"#,##0_);[Red]("$"#,##0)', 7: '"$"#,##0.00_);("$"#,##0.00)', 8: '"$"#,##0.00_);[Red]("$"#,##0.00)',
    9: '0%', 10: '0.00%', 11: '0.00E+00', 12: '# ?/?', 13: '# ??/??', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy',
    18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss',
    37: '#,##0 ;(#,##0)', 38: '#,##0 ;[Red](#,##0)', 39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)',
    41: '_(* #,##0_);_(* \\(#,##0\\);_(* "-"_);_(@_)', 42: '_("$"* #,##0_);_("$"* \\(#,##0\\);_("$"* "-"_);_(@_)',
    43: '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)', 44: '_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)',
    45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mmss.0', 48: '##0.0E+0', 49: '@',
  };
  if (id === 14) return shortDateCode(order);
  if (id === 22) return `${shortDateCode(order)} h:mm`;
  return fixed[id];
}

/** A format code as this spreadsheet's own formats where one is the same (0.00 is Number), else as a code. */
function styleForCode(code: string, symbol: string): CellStyle | null {
  if (/^general$/i.test(code)) return {};
  if (code === '@') return { fmt: 'text' };
  let m = /^0(?:\.(0+))?$/.exec(code);
  if (m) return { fmt: 'number', dec: m[1]?.length ?? 0 };
  m = /^#,##0(?:\.(0+))?$/.exec(code);
  if (m) return { fmt: 'comma', dec: m[1]?.length ?? 0 };
  m = /^0(?:\.(0+))?%$/.exec(code);
  if (m) return { fmt: 'percent', dec: m[1]?.length ?? 0 };
  m = /^(?:"(.{1,3})"|\\(.)|(\$)|\[\$(.{1,3})-[0-9A-Fa-f]+\])#,##0(?:\.(0+))?$/.exec(code);
  if (m && (m[1] ?? m[2] ?? m[3] ?? m[4]) === symbol) return { fmt: 'currency', dec: m[5]?.length ?? 0 };
  if (code.length <= 255 && codeProblem(code) === null) return { fmt: 'custom', code };
  return null;
}

/** The format code a style is saved with ("" = General). */
function codeForStyle(style: CellStyle, symbol: string): string {
  const dec = (n: number | undefined, d: number) => {
    const k = n ?? d;
    return k > 0 ? `.${'0'.repeat(k)}` : '';
  };
  switch (style.fmt) {
    case 'number': return `0${dec(style.dec, 2)}`;
    case 'comma': return `#,##0${dec(style.dec, 2)}`;
    case 'percent': return `0${dec(style.dec, 0)}%`;
    case 'currency': return `"${symbol.replace(/"/g, '')}"#,##0${dec(style.dec, 2)}`;
    case 'text': return '@';
    case 'custom': return style.code ?? '';
    default: return '';
  }
}

// ---- Formulas ------------------------------------------------------------------------------------------------------

/** Functions Excel stores with a prefix (added after Excel 2007); FILTER and SORT carry a second one. */
const XLFN = new Set([
  // Excel 2010
  'AGGREGATE', 'CEILING.PRECISE', 'COVARIANCE.P', 'COVARIANCE.S', 'FLOOR.PRECISE', 'MODE.MULT', 'MODE.SNGL', 'NETWORKDAYS.INTL', 'NORM.DIST',
  'NORM.INV', 'NORM.S.DIST', 'NORM.S.INV', 'PERCENTILE.EXC', 'PERCENTILE.INC', 'PERCENTRANK.EXC', 'PERCENTRANK.INC', 'QUARTILE.EXC',
  'QUARTILE.INC', 'RANK.AVG', 'RANK.EQ', 'STDEV.P', 'STDEV.S', 'VAR.P', 'VAR.S', 'WORKDAY.INTL',
  // Excel 2013
  'BASE', 'CEILING.MATH', 'DAYS', 'DECIMAL', 'FLOOR.MATH', 'FORMULATEXT', 'IFNA', 'ISFORMULA', 'ISOWEEKNUM', 'NUMBERVALUE', 'UNICHAR', 'UNICODE', 'XOR',
  // Excel 2016 and 2019
  'CONCAT', 'FORECAST.LINEAR', 'IFS', 'MAXIFS', 'MINIFS', 'SWITCH', 'TEXTJOIN',
  // Excel 365
  'ARRAYTOTEXT', 'CHOOSECOLS', 'CHOOSEROWS', 'DROP', 'EXPAND', 'HSTACK', 'LET', 'RANDARRAY', 'SEQUENCE', 'SORTBY', 'TAKE', 'TEXTAFTER', 'TEXTBEFORE',
  'TEXTSPLIT', 'TOCOL', 'TOROW', 'UNIQUE', 'VALUETOTEXT', 'VSTACK', 'WRAPCOLS', 'WRAPROWS', 'XLOOKUP', 'XMATCH',
]);
const XLWS = new Set(['FILTER', 'SORT']);
const KNOWN = new Set(FUNCTION_NAMES);
/** Formulas whose answer changes by itself, so one that differs from Excel's saved answer is not a fault. */
const VOLATILE = /\b(TODAY|NOW|RAND|RANDBETWEEN|RANDARRAY|OFFSET|INDIRECT|CELL|INFO)\s*\(/i;

/** The functions a formula calls that this spreadsheet does not have. */
function unknownFunctions(f: string): string[] {
  try {
    const toks = tokenize(f);
    return toks.filter((t, i) => t.type === 'ident' && toks[i + 1]?.type === 'lp' && !KNOWN.has(t.text.toUpperCase())).map(t => t.text.toUpperCase());
  } catch {
    return [];
  }
}

/** An Excel formula as this spreadsheet writes it (prefixes off, ANCHORARRAY(A1) as A1#), or null when it cannot be read. */
export function fromExcelFormula(f: string): string | null {
  let toks: Tok[];
  try {
    toks = tokenize(f);
  } catch {
    return null;
  }
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.type !== 'ident' || !/^_xl(fn|ws|pm)\./i.test(t.text)) continue;
    const bare = t.text.replace(/^(_xl(fn|ws|pm)\.)+/i, '');
    if (bare.toUpperCase() === 'ANCHORARRAY' && toks[k + 1]?.type === 'lp') {
      // ANCHORARRAY(A1) or ANCHORARRAY(Sheet2!A1) is the spill reference A1#.
      const inner = toks[k + 2]?.type === 'rp' ? [] : toks.slice(k + 2, toks.findIndex((x, i) => i > k + 1 && x.type === 'rp'));
      const close = k + 2 + inner.length;
      const isRef = inner.length === 1 ? inner[0].type === 'ident' : inner.length === 3 && inner[1].type === 'bang' && inner[2].type === 'ident';
      if (isRef && toks[close]?.type === 'rp') {
        edits.push({ start: t.start, end: toks[close].end, text: `${f.slice(inner[0].start, inner[inner.length - 1].end)}#` });
        k = close;
        continue;
      }
      return null;
    }
    edits.push({ start: t.start, end: t.end, text: bare });
  }
  let out = f;
  for (const e of edits.reverse()) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  try {
    parseFormula(out);
  } catch {
    return null;
  }
  return out;
}

/** A formula as Excel stores it: the newer functions prefixed, A1# as _xlfn.ANCHORARRAY(A1). */
export function toExcelFormula(f: string): string {
  let toks: Tok[];
  try {
    toks = tokenize(f);
  } catch {
    return f;
  }
  const edits: Array<{ start: number; end: number; text: string }> = [];
  // LET's names are stored with a prefix of their own (_xlpm.x), wherever they are used inside it.
  const letNames = new Set<string>();
  for (let k = 0; k < toks.length; k++) {
    if (toks[k].type !== 'ident' || toks[k].text.toUpperCase() !== 'LET' || toks[k + 1]?.type !== 'lp') continue;
    let depth = 0;
    let arg = 0;
    for (let j = k + 1; j < toks.length; j++) {
      const t = toks[j];
      if (t.type === 'lp') depth++;
      else if (t.type === 'rp' && --depth === 0) break;
      else if (t.type === 'comma' && depth === 1) arg++;
      else if (depth === 1 && arg % 2 === 0 && t.type === 'ident' && toks[j - 1]?.type !== 'bang' && toks[j + 1]?.type === 'comma') letNames.add(t.text.toUpperCase());
    }
  }
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.type === 'ident' && toks[k + 1]?.type === 'lp') {
      const up = t.text.toUpperCase();
      if (XLWS.has(up)) edits.push({ start: t.start, end: t.end, text: `_xlfn._xlws.${up}` });
      else if (XLFN.has(up)) edits.push({ start: t.start, end: t.end, text: `_xlfn.${up}` });
    } else if (t.type === 'ident' && letNames.has(t.text.toUpperCase()) && toks[k - 1]?.type !== 'bang' && toks[k + 1]?.type !== 'bang' && !parseCellRef(t.text)) {
      edits.push({ start: t.start, end: t.end, text: `_xlpm.${t.text}` });
    } else if (t.type === 'err' && t.text === '#' && toks[k - 1]?.type === 'ident' && toks[k - 1].end === t.start && parseCellRef(toks[k - 1].text)) {
      const sheeted = toks[k - 2]?.type === 'bang' && (toks[k - 3]?.type === 'ident' || toks[k - 3]?.type === 'sheetq');
      const start = sheeted ? toks[k - 3].start : toks[k - 1].start;
      // The reference itself may already have been given an edit: none apply to plain references, so this is safe.
      edits.push({ start, end: t.end, text: `_xlfn.ANCHORARRAY(${f.slice(start, toks[k - 1].end)})` });
    }
  }
  let out = f;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

// ---- Opening -------------------------------------------------------------------------------------------------------

interface ReadStyles {
  /** Per cell format (xf) number: this spreadsheet's style, and whether it shows dates. */
  xf: Array<{ style: CellStyle; date: boolean }>;
  unreadCodes: number;
}

function readStyles(xml: XmlEl | null, theme: string[], order: DateOrder, symbol: string): ReadStyles {
  const out: ReadStyles = { xf: [], unreadCodes: 0 };
  if (!xml) return out;
  const codes = new Map<number, string>();
  for (const n of children(child(xml, 'numFmts'), 'numFmt')) codes.set(Number(n.attrs.numFmtId), n.attrs.formatCode ?? '');
  const on = (el: XmlEl | undefined) => !!el && el.attrs.val !== '0' && el.attrs.val !== 'false' && el.attrs.val !== 'none';
  const fonts = children(child(xml, 'fonts'), 'font').map(f => ({
    b: on(child(f, 'b')), i: on(child(f, 'i')), u: on(child(f, 'u')), st: on(child(f, 'strike')),
    color: readColour(child(f, 'color'), theme),
    sz: child(f, 'sz')?.attrs.val, name: child(f, 'name')?.attrs.val,
  }));
  const base = fonts[0];
  const fills = children(child(xml, 'fills'), 'fill').map(f => {
    const p = child(f, 'patternFill');
    if (p && p.attrs.patternType && p.attrs.patternType !== 'none' && p.attrs.patternType !== 'gray125') {
      // A solid fill's colour is its foreground; a pattern without one shows its background.
      return readColour(child(p, 'fgColor'), theme) ?? readColour(child(p, 'bgColor'), theme);
    }
    const stop = child(child(f, 'gradientFill'), 'stop');
    return stop ? readColour(child(stop, 'color'), theme) : undefined;
  });
  const lineOf = (el: XmlEl | undefined): Line | undefined => {
    const st = el?.attrs.style;
    if (!st || st === 'none') return undefined;
    if (st === 'double') return 'double';
    if (st === 'thick') return 'thick';
    if (st === 'medium' || st === 'mediumDashed' || st === 'mediumDashDot' || st === 'mediumDashDotDot' || st === 'slantDashDot') return 'medium';
    return true;
  };
  const borders = children(child(xml, 'borders'), 'border').map(b => {
    const sides = { bl: child(b, 'left') ?? child(b, 'start'), br: child(b, 'right') ?? child(b, 'end'), bt: child(b, 'top'), bb: child(b, 'bottom') };
    const out: CellStyle = {};
    let colour: string | undefined;
    for (const [k, el] of Object.entries(sides) as Array<['bl' | 'br' | 'bt' | 'bb', XmlEl | undefined]>) {
      const line = lineOf(el);
      if (!line) continue;
      out[k] = line;
      colour ??= readColour(child(el, 'color'), theme);
    }
    if (colour && colour !== '#000000') out.bc = colour;
    return out;
  });
  for (const x of children(child(xml, 'cellXfs'), 'xf')) {
    const style: CellStyle = {};
    const font = fonts[Number(x.attrs.fontId ?? 0)];
    if (font) {
      if (font.b) style.b = true;
      if (font.i) style.i = true;
      if (font.u) style.u = true;
      if (font.st) style.st = true;
      if (font.color && font.color !== '#000000') style.color = font.color;
      // A size or typeface other than the workbook's standard one is kept (the standard shows as this spreadsheet's own).
      const sz = Number(font.sz);
      if (font.sz !== undefined && Number.isFinite(sz) && sz >= 1 && sz <= 409 && font.sz !== (base?.sz ?? '11')) style.fs = Math.round(sz * 2) / 2;
      const face = cleanFace(font.name);
      if (face && font.name !== (base?.name ?? font.name)) style.ff = face;
    }
    const fill = fills[Number(x.attrs.fillId ?? 0)];
    if (fill) style.fill = fill;
    Object.assign(style, borders[Number(x.attrs.borderId ?? 0)] ?? {});
    const al = child(x, 'alignment');
    const hz = al?.attrs.horizontal;
    if (hz === 'left') style.al = 'l';
    else if (hz === 'center' || hz === 'centerContinuous') style.al = 'c';
    else if (hz === 'right') style.al = 'r';
    if (al?.attrs.wrapText === '1' || al?.attrs.wrapText === 'true') style.wrap = true;
    if (al?.attrs.vertical === 'top') style.va = 't';
    else if (al?.attrs.vertical === 'center') style.va = 'm';
    const indent = Number(al?.attrs.indent ?? 0);
    if (Number.isInteger(indent) && indent >= 1) style.ind = Math.min(15, indent);
    const id = Number(x.attrs.numFmtId ?? 0);
    const code = codes.get(id) ?? builtinCode(id, order) ?? 'General';
    const fmt = styleForCode(code, symbol);
    if (fmt) Object.assign(style, fmt);
    else out.unreadCodes++;
    out.xf.push({ style, date: style.fmt === 'custom' && !!style.code && isDateCode(style.code) });
  }
  return out;
}

/** Opens an .xlsx (or .xlsm) into the workbook, replacing what it held. Throws SyntaxProblem with a plain reason. */
export async function openXlsx(wb: Workbook, bytes: Uint8Array): Promise<XlsxReport> {
  if (bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    throw new SyntaxProblem('This is an older Excel file (.xls), or an Excel file locked with a password. Neither can be opened here. In Excel, use File > Save As > Excel Workbook (.xlsx), without a password, and open that file.');
  }
  let entries;
  try {
    entries = readZip(bytes);
  } catch (error) {
    if (error instanceof ArchiveError) throw new SyntaxProblem(`This is not an Excel workbook this spreadsheet can open. ${error.message}`);
    throw error;
  }
  const byPath = new Map(entries.filter(e => !e.folder).map(e => [e.parts.join('/'), e]));
  const lower = new Map([...byPath.keys()].map(p => [p.toLowerCase(), p]));
  let unpacked = 0;
  const readText = async (path: string): Promise<string | null> => {
    const real = lower.get(path.replace(/^\/+/, '').toLowerCase());
    const entry = real ? byPath.get(real) : undefined;
    if (!entry) return null;
    unpacked += entry.size;
    if (unpacked > MAX_UNPACKED) throw new SyntaxProblem('This workbook unpacks to more than 200 MB of data, which is more than this spreadsheet opens.');
    let data: Uint8Array;
    try {
      data = await entry.read();
    } catch (error) {
      if (error instanceof ArchiveError) throw new SyntaxProblem(`This Excel file is damaged. ${error.message}`);
      throw error;
    }
    return new TextDecoder('utf-8').decode(data).replace(/^﻿/, '');
  };
  const readXml = async (path: string): Promise<XmlEl | null> => {
    const text = await readText(path);
    if (text === null) return null;
    try {
      return parseXml(text);
    } catch (error) {
      if (error instanceof XmlProblem) throw new SyntaxProblem(`Part of this Excel file (${path}) is damaged: ${error.message}`);
      throw error;
    }
  };
  const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/') + 1);
  const resolve = (base: string, target: string): string => {
    if (target.startsWith('/')) return target.slice(1);
    const parts = (dirOf(base) + target).split('/');
    const out: string[] = [];
    for (const p of parts) {
      if (p === '..') out.pop();
      else if (p !== '.' && p !== '') out.push(p);
    }
    return out.join('/');
  };
  const relsOf = async (part: string): Promise<Array<{ id: string; type: string; target: string }>> => {
    const xml = await readXml(`${dirOf(part)}_rels/${part.slice(part.lastIndexOf('/') + 1)}.rels`);
    return children(xml ?? undefined, 'Relationship').map(r => ({
      id: r.attrs.Id ?? '', type: r.attrs.Type ?? '', target: r.attrs.TargetMode === 'External' ? '' : resolve(part, r.attrs.Target ?? ''),
    }));
  };

  const report: XlsxReport = { dropped: [], asValues: { count: 0, examples: [], names: [] }, differ: { count: 0, examples: [] } };
  const rootRels = await relsOf('');
  const bookPath = rootRels.find(r => r.type.endsWith('/officeDocument'))?.target ?? 'xl/workbook.xml';
  const book = await readXml(bookPath);
  if (!book || book.name !== 'workbook') throw new SyntaxProblem('This is not an Excel workbook (it has no list of sheets). It may be a Word or PowerPoint file, or damaged.');
  const bookRels = await relsOf(bookPath);
  const relTarget = (kind: string) => bookRels.find(r => r.type.endsWith(`/${kind}`))?.target;
  const date1904 = ['1', 'true'].includes(child(book, 'workbookPr')?.attrs.date1904 ?? '');
  // PivotTables' data caches, by their number: where the data is, the field names, each field's items.
  const caches = new Map<string, { source: string; fields: string[]; items: string[][]; groups: Record<number, DateGroup> }>();
  for (const pc of children(child(book, 'pivotCaches'), 'pivotCache')) {
    const target = bookRels.find(r => r.id === (pc.attrs['r:id'] ?? pc.attrs.id))?.target;
    const xml = target ? await readXml(target) : null;
    const ws = child(child(xml ?? undefined, 'cacheSource'), 'worksheetSource');
    if (!xml || !ws) continue;
    const quoted = (n: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(n) ? n : `'${n.replace(/'/g, "''")}'`);
    // A table's data (worksheetSource name="Table1") is its whole block, header row first; a defined name as it is.
    const named = ws.attrs.name;
    const definedHere = children(child(book, 'definedNames'), 'definedName').some(d => (d.attrs.name ?? '').toLowerCase() === (named ?? '').toLowerCase());
    const source = named ? (definedHere || /[[!]/.test(named) ? named : `${named}[[#Headers],[#Data]]`) : ws.attrs.ref && ws.attrs.sheet ? `${quoted(ws.attrs.sheet)}!${ws.attrs.ref.split(':').map(a => a.replace(/^\$?([A-Za-z]+)\$?(\d+)$/, '$$$1$$$2')).join(':')}` : '';
    const fields: string[] = [];
    const items: string[][] = [];
    const groups: Record<number, DateGroup> = {};
    children(child(xml, 'cacheFields'), 'cacheField').forEach((cf, i) => {
      fields.push(decodeOoxml(cf.attrs.name ?? ''));
      items.push((child(cf, 'sharedItems')?.kids ?? []).map(k => (k.name === 'm' ? '(blank)' : decodeOoxml(k.attrs.v ?? ''))));
      const by = child(child(cf, 'fieldGroup'), 'rangePr')?.attrs.groupBy;
      if (by === 'years' || by === 'quarters' || by === 'months') groups[i] = by;
    });
    if (source) caches.set(pc.attrs.cacheId ?? '', { source, fields, items, groups });
  }

  const sst: string[] = [];
  const sstPath = relTarget('sharedStrings');
  const sstXml = sstPath ? await readXml(sstPath) : null;
  // Text with part of it in bold or a colour (rich text) is kept as its words.
  let richText = 0;
  for (const si of children(sstXml ?? undefined, 'si')) {
    sst.push(decodeOoxml(stringOf(si)));
    if (children(si, 'r').some(r => child(r, 'rPr'))) richText++;
  }
  const themePath = relTarget('theme');
  const theme = readTheme(themePath ? await readXml(themePath) : null);
  const stylesPath = relTarget('styles');
  const stylesEl = stylesPath ? await readXml(stylesPath) : null;
  const styles = readStyles(stylesEl, theme, wb.dateOrder, wb.symbol);
  // The looks conditional formatting uses.
  const dxfs = readDxfs(stylesEl, theme);
  const parts = newPartsReport();
  /** The file's sheet number (as its print names count them) to this spreadsheet's. */
  const ourSheet = new Map<number, number>();

  // This spreadsheet's style list, built from the file's cell formats (equal ones shared).
  const styleList: CellStyle[] = [{}];
  const styleIds = new Map<string, number>([['{}', 0]]);
  const ourStyle = (xf: number): number => {
    const st = styles.xf[xf]?.style;
    if (!st) return 0;
    const json = JSON.stringify(st, Object.keys(st).sort());
    let id = styleIds.get(json);
    if (id === undefined) {
      id = styleList.length;
      styleList.push(st);
      styleIds.set(json, id);
    }
    return id;
  };

  const sheetsOut: unknown[] = [];
  const cached = new Map<string, Value>();
  const addExample = (list: string[], text: string) => {
    if (list.length < 5) list.push(text);
  };
  let total = 0;
  let offSheet = 0;
  let cut = 0;
  let hiddenSheets = 0;
  let customFilters = 0;
  let notesRead = 0;
  let tablesLost = 0;
  let pivotsLost = 0;
  let shapes = 0;
  let sparklines = 0;
  let dataTables = 0;
  const counts = { links: 0, protect: 0 };
  const names = new Set<string>();
  const sheetEls = children(child(book, 'sheets'), 'sheet');
  let activeTab = Number(child(child(book, 'bookViews'), 'workbookView')?.attrs.activeTab ?? 0);
  let skipped = 0;

  for (const [index, sheetEl] of sheetEls.entries()) {
    const rel = bookRels.find(r => r.id === (sheetEl.attrs['r:id'] ?? sheetEl.attrs.id));
    if (!rel || !rel.type.endsWith('/worksheet')) {
      skipped++;
      if (index < activeTab) activeTab--;
      continue;
    }
    if (sheetsOut.length >= MAX_SHEETS) {
      skipped++;
      continue;
    }
    const ws = await readXml(rel.target);
    if (!ws) throw new SyntaxProblem(`A sheet of this Excel file is missing (${rel.target}). The file may be damaged.`);
    const name = (sheetEl.attrs.name ?? `Sheet${index + 1}`).slice(0, 31).replace(/[\\/?*[\]:]/g, '_') || `Sheet${index + 1}`;
    if (sheetEl.attrs.state === 'hidden' || sheetEl.attrs.state === 'veryHidden') hiddenSheets++;
    const s = sheetsOut.length;
    const cells: unknown[] = [];
    const colW: Record<number, number> = {};
    const rowH: Record<number, number> = {};
    const hiddenRows: number[] = [];
    const hiddenCols: number[] = [];
    for (const c of children(child(ws, 'cols'), 'col')) {
      const lo = Math.max(1, Number(c.attrs.min ?? 1));
      const hi = Math.min(MAX_COLS, Number(c.attrs.max ?? lo));
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
      const w = Number(c.attrs.width);
      const hidden = c.attrs.hidden === '1' || c.attrs.hidden === 'true';
      for (let i = lo - 1; i <= hi - 1; i++) {
        if (hidden) hiddenCols.push(i);
        // Excel keeps a width in characters of its standard font; this is its own sum for the pixels on screen.
        if (Number.isFinite(w) && w > 0 && (c.attrs.customWidth === '1' || Math.abs(w - 9.140625) > 0.01)) {
          colW[i] = Math.max(16, Math.min(800, Math.trunc(((256 * w + 18) / 256) * 7)));
        }
      }
    }
    const pane = child(child(child(ws, 'sheetViews'), 'sheetView'), 'pane');
    const freeze = pane && (pane.attrs.state === 'frozen' || pane.attrs.state === 'frozenSplit')
      ? [Math.max(0, Math.min(MAX_ROWS - 1, Math.floor(Number(pane.attrs.ySplit ?? 0)) || 0)), Math.max(0, Math.min(MAX_COLS - 1, Math.floor(Number(pane.attrs.xSplit ?? 0)) || 0))]
      : [0, 0];

    // Cells a list formula fills hold Excel's saved copy of the list: kept out, so the formula fills them itself.
    const arrays: Range[] = [];
    const shared = new Map<string, { f: string | null; col: number; row: number }>();
    let rowNo = -1;
    for (const rowEl of children(child(ws, 'sheetData'), 'row')) {
      rowNo = rowEl.attrs.r ? Number(rowEl.attrs.r) - 1 : rowNo + 1;
      if (!Number.isInteger(rowNo) || rowNo < 0) continue;
      if (rowNo < MAX_ROWS) {
        if ((rowEl.attrs.customHeight === '1' || rowEl.attrs.customHeight === 'true') && rowEl.attrs.ht) {
          const px = Math.round(Number(rowEl.attrs.ht) * 4 / 3);
          if (Number.isFinite(px)) rowH[rowNo] = Math.max(12, Math.min(400, px));
        }
        if (rowEl.attrs.hidden === '1' || rowEl.attrs.hidden === 'true') hiddenRows.push(rowNo);
      }
      let colNo = -1;
      for (const c of children(rowEl, 'c')) {
        const at = c.attrs.r ? cellAddress(c.attrs.r) : { col: colNo + 1, row: rowNo };
        if (!at) continue;
        colNo = at.col;
        const fEl = child(c, 'f');
        const vText = child(c, 'v')?.text;
        const t = c.attrs.t ?? 'n';
        const xf = Number(c.attrs.s ?? 0);
        if (at.row >= MAX_ROWS || at.col >= MAX_COLS) {
          if (vText !== undefined || fEl || t === 'inlineStr') offSheet++;
          continue;
        }
        const info = styles.xf[xf];
        let v: number | string | boolean | null = null;
        let error: string | null = null;
        if (t === 's') v = sst[Number(vText)] ?? null;
        else if (t === 'str') v = vText !== undefined ? decodeOoxml(vText) : null;
        else if (t === 'inlineStr') v = decodeOoxml(stringOf(child(c, 'is')));
        else if (t === 'b') v = vText === '1' || vText === 'true';
        else if (t === 'e') error = vText ?? '#N/A';
        else if (t === 'd') v = vText ? isoSerial(vText) : null;
        else if (vText !== undefined && vText !== '') {
          const n = Number(vText);
          v = Number.isFinite(n) ? n : null;
        }
        if (typeof v === 'string' && v.length > MAX_TEXT) {
          v = v.slice(0, MAX_TEXT);
          cut++;
        }
        if (typeof v === 'number' && date1904 && info?.date && !fEl) v += 1462;

        let f: string | null = null;
        if (fEl) {
          const kind = fEl.attrs.t ?? 'normal';
          const raw = fEl.text;
          if (kind === 'shared') {
            const si = fEl.attrs.si ?? '';
            if (raw.trim()) {
              f = fromExcelFormula(raw.trim());
              shared.set(si, { f, col: at.col, row: at.row });
            } else {
              const master = shared.get(si);
              if (master?.f) {
                try {
                  f = shiftFormula(master.f, at.col - master.col, at.row - master.row);
                } catch {
                  f = null;
                }
              }
            }
          } else if (kind === 'array' || kind === 'normal') {
            if (raw.trim()) f = fromExcelFormula(raw.trim());
            const area = kind === 'array' && fEl.attrs.ref ? parseRange(fEl.attrs.ref) : null;
            if (area && (area.c1 > area.c0 || area.r1 > area.r0)) arrays.push(area);
          }
          const was: Value = error !== null ? new CellError(error) : v;
          if (f !== null) {
            // Some programs save a formula without its answer: then there is nothing to set it beside.
            if (error !== null || (vText !== undefined && (vText !== '' || t === 'str'))) cached.set(`${s}:${at.col}:${at.row}`, was);
            if (f.length > 4000) f = null;
          }
          if (kind === 'dataTable') dataTables++;
          if (f === null && kind !== 'dataTable') {
            report.asValues.count++;
            addExample(report.asValues.examples, `${name}!${addressOf(at.col, at.row)}`);
            for (const n of unknownFunctions(raw.replace(/_xl(fn|ws|pm)\./gi, ''))) names.add(n);
          }
        } else if (arrays.some(a => at.col >= a.c0 && at.col <= a.c1 && at.row >= a.r0 && at.row <= a.r1)) {
          // Part of a list Excel saved: the list formula fills it again.
          const style = ourStyle(xf);
          if (style) {
            cells.push([at.col, at.row, null, null, style]);
            total++;
          }
          continue;
        }
        if (f === null && error !== null) f = /^#(NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A)$/i.test(error) ? error.toUpperCase() : null;
        const style = ourStyle(xf);
        if (f === null && v === null && !style) continue;
        if (++total > MAX_CELLS) throw new SyntaxProblem(`This workbook has more than ${MAX_CELLS.toLocaleString()} cells, which is more than this spreadsheet holds.`);
        cells.push([at.col, at.row, f === null ? v : null, f, style]);
      }
    }

    const merges: number[][] = [];
    for (const m of children(child(ws, 'mergeCells'), 'mergeCell')) {
      const r = m.attrs.ref ? parseRange(m.attrs.ref) : null;
      if (r) merges.push([r.c0, r.r0, r.c1, r.r1]);
    }
    let filter: unknown = null;
    const af = child(ws, 'autoFilter');
    const afRange = af?.attrs.ref ? parseRange(af.attrs.ref) : null;
    if (af && afRange && afRange.r1 > afRange.r0) {
      const cols: Record<number, string[]> = {};
      const rules: Record<number, FilterRule> = {};
      for (const fc of children(af, 'filterColumn')) {
        const c = afRange.c0 + Number(fc.attrs.colId ?? -1);
        const list = child(fc, 'filters');
        if (!Number.isInteger(c) || c < afRange.c0 || c > afRange.c1) continue;
        if (!list) {
          // A condition (greater than, contains...), top 10, or above average: kept; by colour: the rows stay hidden.
          const rule = filterRuleOf(fc);
          if (rule) rules[c] = rule;
          else customFilters++;
          continue;
        }
        const keep = children(list, 'filter').map(x => x.attrs.val ?? '');
        if (list.attrs.blank === '1' || list.attrs.blank === 'true') keep.push('');
        if (children(list, 'dateGroupItem').length) customFilters++;
        cols[c] = keep;
      }
      filter = { range: [afRange.c0, afRange.r0, afRange.c1, afRange.r1], cols, rules };
    }
    if (child(ws, 'hyperlinks')) counts.links++;
    if (findDeep(ws, 'sparklineGroup')) sparklines++;
    if (child(ws, 'sheetProtection')) counts.protect++;
    const asArray = (r: Range) => [r.c0, r.r0, r.c1, r.r1];
    const cf = readCf(ws, dxfs, theme, parts).map(e => ({ ranges: e.ranges.map(asArray), rule: e.rule, stop: e.stop }));
    const dv = readDv(ws, parts).map(v => ({ ...v, ranges: v.ranges.map(asArray) }));
    const page = readPage(ws, parts);
    // Charts: the sheet's drawing places them; each is a part of its own.
    const charts: Chart[] = [];
    const drawingId = child(ws, 'drawing')?.attrs['r:id'] ?? child(ws, 'drawing')?.attrs.id;
    if (drawingId) {
      const drawingPath = (await relsOf(rel.target)).find(r => r.id === drawingId)?.target;
      const drawing = drawingPath ? await readXml(drawingPath) : null;
      const drawingRels = drawingPath ? await relsOf(drawingPath) : [];
      const hiddenC = new Set(hiddenCols);
      const hiddenR = new Set(hiddenRows);
      const colPx = (c: number) => (hiddenC.has(c) ? 0 : colW[c] ?? 64);
      const rowPx = (r: number) => (hiddenR.has(r) ? 0 : rowH[r] ?? 20);
      for (const anchor of drawing?.kids ?? []) {
        const frame = child(anchor, 'graphicFrame');
        const chartRef = frame ? findDeep(frame, 'chart') : undefined;
        const partPath = chartRef ? drawingRels.find(r => r.id === (chartRef.attrs['r:id'] ?? chartRef.attrs.id))?.target : undefined;
        // Shapes, text boxes and arrows (pictures are counted by their files).
        if (!partPath && (child(anchor, 'sp') || child(anchor, 'grpSp') || child(anchor, 'cxnSp') || (frame && !chartRef))) shapes++;
        if (!partPath) continue;
        const partXml = await readXml(partPath);
        const made = partXml ? readChartPart(partXml, theme, parts) : null;
        const place = anchorOf(anchor, colPx, rowPx);
        const chart = made && place ? finishChart(made, place, charts.length + 1) : null;
        if (chart && charts.length < 50) charts.push(chart);
        else if (made && place) parts.chartsOther.push('a chart past the 50 a sheet holds here');
      }
    }
    const sheetRels = await relsOf(rel.target);
    // Excel tables: each is a part of its own, named by the sheet's tableParts.
    const tables: unknown[] = [];
    for (const tp of children(child(ws, 'tableParts'), 'tablePart')) {
      const target = sheetRels.find(r => r.id === (tp.attrs['r:id'] ?? tp.attrs.id))?.target;
      const xml = target ? await readXml(target) : null;
      if (!xml || xml.name !== 'table') continue;
      const where = xml.attrs.ref ? parseRange(xml.attrs.ref) : null;
      const cols = children(child(xml, 'tableColumns'), 'tableColumn');
      const name = xml.attrs.displayName ?? xml.attrs.name ?? '';
      if (!where || where.r1 >= MAX_ROWS || where.c1 >= MAX_COLS || cols.length !== where.c1 - where.c0 + 1 || !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) {
        tablesLost++;
        continue;
      }
      const info = child(xml, 'tableStyleInfo');
      const flag = (v: string | undefined, d: boolean) => (v === undefined ? d : v === '1' || v === 'true');
      const af = child(xml, 'autoFilter');
      const header = xml.attrs.headerRowCount !== '0';
      const totals = Number(xml.attrs.totalsRowCount ?? 0) > 0;
      tables.push({
        id: Number(xml.attrs.id) || tables.length + 1,
        name,
        range: [where.c0, where.r0, where.c1, where.r1],
        header, totals,
        style: info?.attrs.name ?? '',
        bandRows: flag(info?.attrs.showRowStripes, true), bandCols: flag(info?.attrs.showColumnStripes, false),
        firstCol: flag(info?.attrs.showFirstColumn, false), lastCol: flag(info?.attrs.showLastColumn, false),
        filter: !!af && !filter,
        columns: cols.map(c => ({
          name: decodeOoxml(c.attrs.name ?? ''),
          ...(c.attrs.totalsRowFunction && c.attrs.totalsRowFunction in TOTAL_LABEL ? { total: c.attrs.totalsRowFunction as TotalFn } : {}),
          ...(c.attrs.totalsRowLabel ? { label: decodeOoxml(c.attrs.totalsRowLabel) } : {}),
        })),
      });
      // The table's filter buttons are the sheet's filter here (a sheet has one filter).
      if (af && !filter && header) {
        const fr = { ...where, r1: where.r1 - (totals ? 1 : 0) };
        const keep: Record<number, string[]> = {};
        const rules: Record<number, FilterRule> = {};
        for (const fc of children(af, 'filterColumn')) {
          const list = child(fc, 'filters');
          if (!list) {
            const rule = filterRuleOf(fc);
            if (rule) rules[fr.c0 + Number(fc.attrs.colId ?? 0)] = rule;
            continue;
          }
          const vals = children(list, 'filter').map(x => x.attrs.val ?? '');
          if (list.attrs.blank === '1' || list.attrs.blank === 'true') vals.push('');
          keep[fr.c0 + Number(fc.attrs.colId ?? 0)] = vals;
        }
        filter = { range: [fr.c0, fr.r0, fr.c1, fr.r1], cols: keep, rules };
      }
    }
    // PivotTables: kept live, their cells as Excel wrote them until they are changed or refreshed here.
    const pivots: unknown[] = [];
    for (const r of sheetRels.filter(x => x.type.endsWith('/pivotTable'))) {
      const xml = await readXml(r.target);
      const cache = xml ? caches.get(xml.attrs.cacheId ?? '') : undefined;
      const loc = child(xml ?? undefined, 'location');
      const where = loc?.attrs.ref ? parseRange(loc.attrs.ref) : null;
      if (!xml || !cache || !where || where.r1 >= MAX_ROWS || where.c1 >= MAX_COLS) {
        pivotsLost++;
        continue;
      }
      const fieldEls = children(child(xml, 'pivotFields'), 'pivotField');
      const axis = (name: string) => children(child(xml, name), 'field').map(f => Number(f.attrs.x)).filter(x => Number.isInteger(x) && x >= 0 && x < cache.fields.length);
      const hidden: Record<number, string[]> = {};
      fieldEls.forEach((pf, i) => {
        const off = children(child(pf, 'items'), 'item').filter(it => it.attrs.h === '1' || it.attrs.h === 'true').map(it => cache.items[i]?.[Number(it.attrs.x)]).filter((x): x is string => x !== undefined);
        if (off.length) hidden[i] = off;
      });
      const SHOW: Record<string, ShowAs> = { percentOfTotal: 'pctTotal', percentOfCol: 'pctCol', percentOfRow: 'pctRow' };
      const values = children(child(xml, 'dataFields'), 'dataField').map(df => ({
        field: Number(df.attrs.fld),
        agg: (AGGS.includes((df.attrs.subtotal ?? 'sum') as Agg) ? df.attrs.subtotal ?? 'sum' : 'sum') as Agg,
        ...(df.attrs.showDataAs && SHOW[df.attrs.showDataAs] ? { show: SHOW[df.attrs.showDataAs] } : {}),
        ...(df.attrs.name ? { name: decodeOoxml(df.attrs.name) } : {}),
      })).filter(v => Number.isInteger(v.field) && v.field >= 0 && v.field < cache.fields.length);
      const pages = children(child(xml, 'pageFields'), 'pageField').map(pf => {
        const f = Number(pf.attrs.fld);
        const item = pf.attrs.item !== undefined ? cache.items[f]?.[Number(pf.attrs.item)] : undefined;
        return { field: f, keep: item !== undefined ? [item] : null };
      }).filter(pf => Number.isInteger(pf.field) && pf.field >= 0 && pf.field < cache.fields.length);
      // Report filters sit above the report, with a blank row between.
      const top = Math.max(0, where.r0 - (pages.length ? pages.length + 1 : 0));
      const flag = (v: string | undefined) => v !== '0' && v !== 'false';
      pivots.push({
        id: pivots.length + 1 + index * 100, name: decodeOoxml(xml.attrs.name ?? `PivotTable${pivots.length + 1}`), source: cache.source,
        at: { col: where.c0, row: top }, rows: axis('rowFields'), cols: axis('colFields'), values, filters: pages, hidden, groups: cache.groups,
        grandRows: flag(xml.attrs.rowGrandTotals), grandCols: flag(xml.attrs.colGrandTotals), subtotals: fieldEls.every(pf => pf.attrs.defaultSubtotal !== '0'),
        last: [where.c0, top, Math.max(where.c1, where.c0 + 1), where.r1],
      });
    }
    // Notes (Excel's comments part; Excel 365's threaded comments keep a copy there too).
    const commentsPath = sheetRels.find(r => r.type.endsWith('/comments'))?.target;
    if (commentsPath) {
      const xml = await readXml(commentsPath);
      const authors = children(child(xml ?? undefined, 'authors'), 'author').map(a => a.text);
      const byAt = new Map<string, unknown[]>();
      for (const c of cells as unknown[][]) byAt.set(`${c[0]}:${c[1]}`, c);
      for (const cm of children(child(xml ?? undefined, 'commentList'), 'comment')) {
        const at = cm.attrs.ref ? cellAddress(cm.attrs.ref) : null;
        if (!at || at.row >= MAX_ROWS || at.col >= MAX_COLS) continue;
        const textEl = child(cm, 'text');
        let note = decodeOoxml(stringOf(textEl));
        // Excel starts a note with its author's name in bold ("Ann Lee:" and a new line): left out, as Excel shows it apart.
        const author = authors[Number(cm.attrs.authorId ?? -1)];
        if (author && note.startsWith(`${author}:`)) note = note.slice(author.length + 1).replace(/^\r?\n/, '');
        note = note.replace(/\r\n/g, '\n').slice(0, 32_000);
        if (!note.trim()) continue;
        const own = byAt.get(`${at.col}:${at.row}`);
        if (own) {
          while (own.length < 5) own.push(null);
          own[5] = note;
        } else {
          cells.push([at.col, at.row, null, null, 0, note]);
          total++;
        }
        notesRead++;
      }
    }
    ourSheet.set(index, sheetsOut.length);
    const view = child(child(ws, 'sheetViews'), 'sheetView');
    const noGrid = view?.attrs.showGridLines === '0' || view?.attrs.showGridLines === 'false';
    sheetsOut.push({ name, colW, rowH, rowFit: [], cells, merges, freeze, hiddenRows, hiddenCols, filter, charts, cf, dv, page: page ? { ...page, area: null } : null, tables, pivots, noGrid });
  }
  if (!sheetsOut.length) throw new SyntaxProblem('This Excel file has no sheets of cells this spreadsheet can open (only charts or the like).');

  // Two sheets whose names differ only in characters this spreadsheet cannot use: the second is renamed.
  const taken = new Set<string>();
  for (const sh of sheetsOut as Array<{ name: string }>) {
    let n = sh.name;
    for (let k = 2; taken.has(n.toLowerCase()); k++) n = `${sh.name.slice(0, 27)} (${k})`;
    taken.add(n.toLowerCase());
    sh.name = n;
  }

  // What was left out, in words.
  const count = (re: RegExp) => [...byPath.keys()].filter(p => re.test(p)).length;
  const say = (n: number, text: string) => {
    if (n > 0) report.dropped.push(text);
  };
  // Charts this spreadsheet could not draw, each said once ("a radar chart...").
  for (const [what, n] of [...parts.chartsOther.reduce((m, w) => m.set(w, (m.get(w) ?? 0) + 1), new Map<string, number>())]) report.dropped.push(n > 1 ? `${what} (${n} of them)` : what);
  say(count(/^xl\/media\//i), plural(count(/^xl\/media\//i), 'picture'));
  say(pivotsLost, `${plural(pivotsLost, 'PivotTable')} this spreadsheet could not read (their cells are kept as plain values)`);
  // Excel 365's threaded comments (a conversation) keep their first text as a note here; the replies are not kept.
  say(count(/^xl\/threadedComments\/.*\.xml$/i), 'replies in threaded comments (each comment\'s first text is kept as a note)');
  void notesRead;
  say(tablesLost, `${plural(tablesLost, 'Excel table')} this spreadsheet could not read (the cells are kept as plain cells)`);
  say(count(/vbaProject\.bin$/i), 'macros (VBA): they are never run or saved here');
  say(shapes, `${plural(shapes, 'shape')} (text boxes, arrows, drawn shapes)`);
  say(sparklines, `sparklines (the small charts in cells) on ${plural(sparklines, 'sheet')}`);
  say(count(/^xl\/(slicers|timelines)\/.*\.xml$/i), 'slicers and timelines (the filter buttons beside PivotTables and tables)');
  say(count(/^xl\/externalLinks\/.*\.xml$/i), 'links to other workbooks (formulas that use them keep the answer Excel last saved)');
  say(count(/^xl\/(ctrlProps|activeX)\//i), 'form controls (buttons, tick boxes, drop-downs drawn on the sheet)');
  say(dataTables, `${plural(dataTables, 'what-if data table')} (their answers are kept as values)`);
  say(richText, `${plural(richText, 'cell')} with part of the text in bold, italics or a colour (shown in one style)`);
  say(parts.cfOther, `${plural(parts.cfOther, 'conditional formatting rule')} of a kind this spreadsheet does not have (icon sets, dates occurring, errors, above or below by standard deviations)`);
  say(parts.dvOther, `${plural(parts.dvOther, 'data validation rule')} this spreadsheet could not read`);
  say(parts.pageOther, 'some print settings (another paper size, manual page breaks, or a different header on the first or even pages)');
  say(counts.links, 'links on cells (the text is kept)');
  say(counts.protect, 'sheet protection');
  say(skipped, `${plural(skipped, 'sheet')} that ${skipped === 1 ? 'is' : 'are'} not a sheet of cells (a chart sheet), or past the ${MAX_SHEETS}-sheet limit`);
  say(hiddenSheets, `${plural(hiddenSheets, 'hidden sheet')}: shown here`);
  say(styles.unreadCodes, `${plural(styles.unreadCodes, 'number format')} this spreadsheet cannot read (shown as General)`);
  say(customFilters ? 1 : 0, 'a filter rule (top 10, a condition, by colour or by date group): the rows it hid stay hidden');
  say(offSheet, `${plural(offSheet, 'cell')} past row ${MAX_ROWS.toLocaleString()} or column ${colName(MAX_COLS - 1)}, the edge of a sheet here`);
  say(cut, `the end of ${plural(cut, 'very long text')} (over ${MAX_TEXT.toLocaleString()} characters)`);
  // Named ranges and values: kept (with the sheet they belong to); Excel's own hidden ones (_xlnm., _xlfn.) are not names.
  const namesOut: Array<{ name: string; ref: string; scope?: string; comment?: string }> = [];
  let unreadNames = 0;
  for (const d of children(child(book, 'definedNames'), 'definedName')) {
    const name = d.attrs.name ?? '';
    if (/^_xl/i.test(name)) continue;
    const ref = fromExcelFormula(d.text.trim().replace(/^=/, ''));
    const local = d.attrs.localSheetId !== undefined ? ourSheet.get(Number(d.attrs.localSheetId)) : undefined;
    if (!ref || (d.attrs.localSheetId !== undefined && local === undefined)) {
      unreadNames++;
      continue;
    }
    namesOut.push({ name, ref, ...(local !== undefined ? { scope: (sheetsOut[local] as { name: string }).name } : {}), ...(d.attrs.comment ? { comment: d.attrs.comment } : {}) });
  }
  say(unreadNames, `${plural(unreadNames, 'named range')} this spreadsheet could not read (formulas that use them keep their last answer)`);
  // A sheet's print area and print titles are names the workbook keeps for it.
  let areas = 0;
  for (const d of children(child(book, 'definedNames'), 'definedName')) {
    const which = (d.attrs.name ?? '').toLowerCase();
    if (which !== '_xlnm.print_area' && which !== '_xlnm.print_titles') continue;
    const s = ourSheet.get(Number(d.attrs.localSheetId ?? -1));
    if (s === undefined) continue;
    const sheetOut = sheetsOut[s] as { page: Record<string, unknown> | null };
    const read = readPrintNames(d.text);
    const page = sheetOut.page ?? { margins: { t: 0.75, b: 0.75, l: 0.7, r: 0.7, header: 0.3, footer: 0.3 } };
    if (which === '_xlnm.print_area' && read.area) {
      page.area = [read.area.c0, read.area.r0, read.area.c1, read.area.r1];
      if (read.many) areas++;
    }
    if (which === '_xlnm.print_titles') {
      if (read.rows) page.titleRows = read.rows;
      if (read.cols) page.titleCols = read.cols;
    }
    sheetOut.page = page;
  }
  say(areas, 'a print area made of several blocks (only its first block is kept)');

  wb.load({
    format: FILE_FORMAT,
    version: 1,
    symbol: wb.symbol,
    active: Math.max(0, Math.min(sheetsOut.length - 1, activeTab)),
    styles: styleList,
    sheets: sheetsOut,
    names: namesOut,
  });

  // Every formula is worked out here and set beside the answer Excel saved: one that uses something this spreadsheet
  // does not have (#NAME?) keeps Excel's answer as a plain value; one that gives another answer is listed to check.
  let changed = false;
  for (const [key, was] of cached) {
    const [s, col, row] = key.split(':').map(Number);
    const sheet = wb.sheets[s];
    const cell = sheet.cells.get(keyOf(col, row));
    if (!cell?.f) continue;
    const now = wb.value(s, col, row);
    const where = `${sheet.name}!${addressOf(col, row)}`;
    if (now instanceof CellError && now.code === '#NAME?' && !(was instanceof CellError && was.code === '#NAME?')) {
      for (const n of unknownFunctions(cell.f)) names.add(n);
      if (was instanceof CellError) cell.f = /^#(NULL!|DIV\/0!|VALUE!|REF!|NUM!|N\/A)$/.test(was.code) ? was.code : '#N/A';
      else {
        delete cell.f;
        if (was === null) {
          if (!cell.s) sheet.cells.delete(keyOf(col, row));
        } else cell.v = was;
      }
      report.asValues.count++;
      addExample(report.asValues.examples, where);
      changed = true;
    } else if (!sameAnswer(now, was) && !VOLATILE.test(cell.f)) {
      report.differ.count++;
      addExample(report.differ.examples, where);
    }
  }
  report.asValues.names = [...names].sort().slice(0, 12);
  // Inside a table, Excel shows Sales[[#This Row],[Amount]] as [@Amount]: written that way here too.
  for (const sheet of wb.sheets) {
    for (const t of sheet.tables) {
      for (let r = t.range.r0; r <= t.range.r1; r++) {
        for (let c = t.range.c0; c <= t.range.c1; c++) {
          const cell = sheet.cells.get(keyOf(c, r));
          if (!cell?.f || !/#this row/i.test(cell.f)) continue;
          cell.f = rewriteStructs(cell.f, part => (part.thisRow && part.table.toLowerCase() === t.name.toLowerCase() ? { ...part, table: '' } : null));
          changed = true;
        }
      }
    }
  }
  if (changed) wb.load(JSON.parse(wb.serialize()));
  // A formula with no saved answer that calls a function this spreadsheet lacks can only show #NAME?: said too.
  const missing = new Set<string>();
  let nameErrors = 0;
  for (const sheet of wb.sheets) {
    for (const cell of sheet.cells.values()) {
      if (cell.f === undefined) continue;
      const fns = unknownFunctions(cell.f);
      if (!fns.length) continue;
      nameErrors++;
      for (const n of fns) missing.add(n);
    }
  }
  if (nameErrors) report.dropped.push(`${plural(nameErrors, 'formula')} using ${[...missing].sort().slice(0, 8).join(', ')}, which this spreadsheet does not have yet: ${nameErrors === 1 ? 'it shows' : 'they show'} #NAME?`);
  return report;
}

/** The text of a string in the file: its <t>, or its rich-text runs joined (the pronunciation guide left out). */
function stringOf(el: XmlEl | undefined): string {
  if (!el) return '';
  let out = '';
  for (const k of el.kids) {
    if (k.name === 't') out += k.text;
    else if (k.name === 'r') out += children(k, 't').map(allText).join('');
  }
  return out;
}

/** An ISO date ("2026-10-13T14:30:00") as a day number. */
function isoSerial(text: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?/.exec(text);
  if (!m) return null;
  const day = serialOf(Number(m[1]), Number(m[2]), Number(m[3]));
  if (day === null) return null;
  return day + (Number(m[4] ?? 0) * 3600 + Number(m[5] ?? 0) * 60 + Number(m[6] ?? 0)) / 86400;
}

function sameAnswer(a: Value, b: Value): boolean {
  if (a instanceof CellError || b instanceof CellError) return a instanceof CellError && b instanceof CellError && a.code === b.code;
  if (a === null || b === null) return (a ?? 0) === (b ?? 0) || (a ?? '') === (b ?? '');
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  return a === b;
}

// ---- Saving --------------------------------------------------------------------------------------------------------

const ERRORS_EXCEL_KNOWS = new Set(['#NULL!', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A']);
const LINE_STYLE: Record<string, string> = { true: 'thin', medium: 'medium', thick: 'thick', double: 'double' };

function numberText(n: number): string {
  return Number.isFinite(n) ? String(n) : '0';
}

function textTag(s: string): string {
  const t = escapeXml(encodeOoxml(s));
  return /^\s|\s$|\n/.test(s) ? `<t xml:space="preserve">${t}</t>` : `<t>${t}</t>`;
}

/** A filter column's rule as Excel writes it (customFilters, top10, dynamicFilter), read; null for one not kept. */
function filterRuleOf(fc: XmlEl): FilterRule | null {
  const custom = child(fc, 'customFilters');
  const top = child(fc, 'top10');
  const dyn = child(fc, 'dynamicFilter');
  if (custom) {
    const conds = children(custom, 'customFilter').slice(0, 2).map(x => ({ op: x.attrs.operator ?? 'equal', val: decodeOoxml(x.attrs.val ?? '') }));
    return conds.length ? cleanFilterRule({ kind: 'custom', and: custom.attrs.and === '1' || custom.attrs.and === 'true', a: conds[0], ...(conds[1] ? { b: conds[1] } : {}) }) : null;
  }
  if (top) return cleanFilterRule({ kind: 'top', top: top.attrs.top !== '0' && top.attrs.top !== 'false', n: Number(top.attrs.val ?? 10), percent: top.attrs.percent === '1' || top.attrs.percent === 'true' });
  if (dyn && (dyn.attrs.type === 'aboveAverage' || dyn.attrs.type === 'belowAverage')) return { kind: 'average', above: dyn.attrs.type === 'aboveAverage' };
  return null;
}

/** A filter's columns as Excel's filterColumn elements: kept values, or a rule. */
function filterColumnsXml(f: Filter, c0: number): string {
  const out: string[] = [];
  for (const [c, keep] of [...f.cols].sort((a, b) => a[0] - b[0])) {
    const blank = keep.includes('');
    out.push(tag('filterColumn', { colId: c - c0 }, `<filters${blank ? ' blank="1"' : ''}>${keep.filter(k => k !== '').map(k => tag('filter', { val: k })).join('')}</filters>`));
  }
  for (const [c, rule] of [...(f.rules ?? [])].sort((a, b) => a[0] - b[0])) {
    let inner: string;
    if (rule.kind === 'custom') inner = tag('customFilters', { and: rule.and && rule.b ? 1 : undefined }, [rule.a, ...(rule.b ? [rule.b] : [])].map(x => tag('customFilter', { operator: x.op === 'equal' ? undefined : x.op, val: x.val })).join(''));
    else if (rule.kind === 'top') inner = tag('top10', { top: rule.top ? undefined : 0, percent: rule.percent ? 1 : undefined, val: rule.n });
    else inner = tag('dynamicFilter', { type: rule.above ? 'aboveAverage' : 'belowAverage' });
    out.push(tag('filterColumn', { colId: c - c0 }, inner));
  }
  return out.join('');
}

/** A formula's table references as Excel files hold them: with the table's name, and "this row" written out. */
function excelStructs(f: string, owner: string): string {
  if (!f.includes('[')) return f;
  return rewriteStructs(f, part => ({ ...part, table: part.table || owner }), true);
}

/** A table's own part (xl/tables/tableN.xml): where it is, its columns, total row, style and filter. */
function tableXml(t: Table, id: number, filter: Filter | null): string {
  const dr = dataRows(t);
  const filterXml = filter ? tag('autoFilter', { ref: rangeText({ ...t.range, r1: dr.r1 }) }, filterColumnsXml(filter, t.range.c0) || undefined) : '';
  const cols = t.columns.map((c, i) => tag('tableColumn', {
    id: i + 1, name: encodeOoxml(c.name),
    totalsRowLabel: t.totals && c.label ? c.label : undefined,
    totalsRowFunction: t.totals && c.total && c.total !== 'none' ? c.total : undefined,
  })).join('');
  return `<table xmlns="${NS_MAIN}" ${[
    `id="${id}"`, `name="${escapeXml(t.name)}"`, `displayName="${escapeXml(t.name)}"`, `ref="${rangeText(t.range)}"`,
    ...(t.header ? [] : ['headerRowCount="0"']), ...(t.totals ? ['totalsRowCount="1"'] : ['totalsRowShown="0"']),
  ].join(' ')}>${filterXml}<tableColumns count="${t.columns.length}">${cols}</tableColumns>${tag('tableStyleInfo', {
    name: t.style || undefined, showFirstColumn: t.firstCol ? 1 : 0, showLastColumn: t.lastCol ? 1 : 0, showRowStripes: t.bandRows ? 1 : 0, showColumnStripes: t.bandCols ? 1 : 0,
  })}</table>`;
}

/**
 * The old-style drawing (VML) Excel still needs to show notes: one hidden yellow box per note, anchored beside its
 * cell. `n` keeps each sheet's shape numbers apart.
 */
function noteVml(n: number, notes: Array<{ col: number; row: number }>): string {
  const shapes = notes.map((nt, i) => `<v:shape id="_x0000_s${n * 1024 + i + 1}" type="#_x0000_t202" style="position:absolute;margin-left:59.25pt;margin-top:1.5pt;width:108pt;height:59.25pt;z-index:${i + 1};visibility:hidden" fillcolor="#ffffe1" o:insetmode="auto"><v:fill color2="#ffffe1"/><v:shadow on="t" color="black" obscured="t"/><v:path o:connecttype="none"/><v:textbox style="mso-direction-alt:auto"><div style="text-align:left"></div></v:textbox><x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/><x:Anchor>${nt.col + 1}, 15, ${Math.max(0, nt.row - 1)}, 2, ${nt.col + 3}, 15, ${nt.row + 3}, 16</x:Anchor><x:AutoFill>False</x:AutoFill><x:Row>${nt.row}</x:Row><x:Column>${nt.col}</x:Column></x:ClientData></v:shape>`).join('');
  return `<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="${n}"/></o:shapelayout><v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype>${shapes}</xml>`;
}

/** The workbook as an .xlsx file (Office Open XML), packed. */
export async function saveXlsx(wb: Workbook): Promise<Uint8Array<ArrayBuffer>> {
  const strings = new Map<string, number>();
  const stringId = (s: string) => {
    let id = strings.get(s);
    if (id === undefined) {
      id = strings.size;
      strings.set(s, id);
    }
    return id;
  };

  // Styles: each of this spreadsheet's styles is one cell format (xf) of the same number.
  const fonts: string[] = ['<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>'];
  const fills: string[] = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  const borders: string[] = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
  const numFmts: string[] = [];
  const codeIds = new Map<string, number>();
  const BUILT: Record<string, number> = { '0': 1, '0.00': 2, '#,##0': 3, '#,##0.00': 4, '0%': 9, '0.00%': 10, '0.00E+00': 11, '# ?/?': 12, '# ??/??': 13, '@': 49 };
  const indexOf = (list: string[], xml: string) => {
    const i = list.indexOf(xml);
    if (i >= 0) return i;
    list.push(xml);
    return list.length - 1;
  };
  const argb = (hex: string) => `FF${hex.slice(1).toUpperCase()}`;
  const xfs = wb.styles.map((st, i) => {
    if (i === 0) return '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>';
    const code = codeForStyle(st, wb.symbol);
    let numFmtId = 0;
    if (code) {
      numFmtId = BUILT[code] ?? codeIds.get(code) ?? 0;
      if (!numFmtId) {
        numFmtId = 164 + codeIds.size;
        codeIds.set(code, numFmtId);
        numFmts.push(tag('numFmt', { numFmtId, formatCode: code }));
      }
    }
    const fontId = st.b || st.i || st.u || st.st || st.color || st.fs || st.ff
      ? indexOf(fonts, `<font>${st.b ? '<b/>' : ''}${st.i ? '<i/>' : ''}${st.st ? '<strike/>' : ''}${st.u ? '<u/>' : ''}<sz val="${st.fs ?? 11}"/>${st.color ? `<color rgb="${argb(st.color)}"/>` : '<color theme="1"/>'}${st.ff ? `<name val="${escapeXml(st.ff)}"/><family val="${{ sans: 2, serif: 1, mono: 3 }[fontKind(st.ff)]}"/>` : '<name val="Calibri"/><family val="2"/><scheme val="minor"/>'}</font>`)
      : 0;
    const fillId = st.fill ? indexOf(fills, `<fill><patternFill patternType="solid"><fgColor rgb="${argb(st.fill)}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
    const side = (name: string, line: Line | undefined) => (line ? `<${name} style="${LINE_STYLE[String(line)]}"><color ${st.bc ? `rgb="${argb(st.bc)}"` : 'indexed="64"'}/></${name}>` : `<${name}/>`);
    const borderId = st.bt || st.bb || st.bl || st.br ? indexOf(borders, `<border>${side('left', st.bl)}${side('right', st.br)}${side('top', st.bt)}${side('bottom', st.bb)}<diagonal/></border>`) : 0;
    const align = st.al || st.wrap || st.va || st.ind
      ? tag('alignment', {
        horizontal: st.al === 'l' || (st.ind && !st.al) ? 'left' : st.al === 'c' ? 'center' : st.al === 'r' ? 'right' : undefined,
        vertical: st.va === 't' ? 'top' : st.va === 'm' ? 'center' : undefined,
        indent: st.ind && st.al !== 'c' ? st.ind : undefined,
        wrapText: st.wrap ? 1 : undefined,
      })
      : '';
    return tag('xf', {
      numFmtId, fontId, fillId, borderId, xfId: 0,
      applyNumberFormat: numFmtId ? 1 : undefined, applyFont: fontId ? 1 : undefined, applyFill: fillId ? 1 : undefined,
      applyBorder: borderId ? 1 : undefined, applyAlignment: align ? 1 : undefined,
    }, align);
  });

  // Looks used by conditional formatting (styles.xml <dxfs>).
  const dxfs: string[] = [];
  const dxfId = (fmt: CfFormat) => indexOf(dxfs, dxfXml(fmt));
  const overridesExtra: string[] = [];
  let chartNo = 0;
  let drawingNo = 0;
  let notesNo = 0;
  let tableNo = 0;
  let vml = false;
  let dynamic = false;
  const files: ZipEntry[] = [];
  const now = Date.now();
  const add = (name: string, xml: string) => files.push({ name, data: new TextEncoder().encode(XML_HEAD + xml), modified: now });
  const definedNames: string[] = [];

  wb.sheets.forEach((sheet, s) => {
    // The rows to write: every row with a cell, a set height or hidden, plus cells filled by lists (Excel keeps their
    // values too, so a program that does not work formulas out still shows them).
    const rows = new Map<number, Map<number, string>>();
    const rowOf = (r: number) => {
      let m = rows.get(r);
      if (!m) rows.set(r, (m = new Map()));
      return m;
    };
    const valueXml = (v: Value): { t?: string; v?: string } => {
      if (v === null) return {};
      if (v instanceof CellError) return ERRORS_EXCEL_KNOWS.has(v.code) ? { t: 'e', v: v.code } : {};
      if (typeof v === 'number') return { v: numberText(v) };
      if (typeof v === 'boolean') return { t: 'b', v: v ? '1' : '0' };
      return { t: 'str', v: escapeXml(encodeOoxml(v)) };
    };
    for (const [k, cell] of sheet.cells) {
      const col = colOfKey(k);
      const row = rowOfKey(k);
      const r = addressOf(col, row);
      const sAttr = cell.s ? ` s="${cell.s}"` : '';
      let xml: string;
      if (cell.f !== undefined) {
        const answer = valueXml(wb.value(s, col, row));
        let tree = null;
        try {
          tree = parseFormula(cell.f);
        } catch {
          tree = null;
        }
        const area = wb.spillArea(s, col, row);
        const list = tree !== null && worksOnLists(tree);
        if (list) dynamic = true;
        const fAttrs = list ? ` t="array" ref="${area && area.col === col && area.row === row ? rangeText(area) : r}"` : '';
        xml = `<c r="${r}"${sAttr}${answer.t ? ` t="${answer.t}"` : ''}${list ? ' cm="1"' : ''}><f${fAttrs}>${escapeXml(toExcelFormula(excelStructs(cell.f, wb.tableAt(s, col, row)?.name ?? '')))}</f>${answer.v !== undefined ? `<v>${answer.v}</v>` : ''}</c>`;
        if (list && area && area.col === col && area.row === row) {
          for (let rr = area.r0; rr <= area.r1; rr++) {
            for (let cc = area.c0; cc <= area.c1; cc++) {
              if (rr === row && cc === col) continue;
              const own = sheet.cells.get(keyOf(cc, rr));
              if (own && (own.v !== undefined || own.f !== undefined)) continue;
              const fill = valueXml(wb.value(s, cc, rr));
              if (fill.v === undefined) continue;
              rowOf(rr).set(cc, `<c r="${addressOf(cc, rr)}"${own?.s ? ` s="${own.s}"` : ''}${fill.t && fill.t !== 'str' ? ` t="${fill.t}"` : fill.t === 'str' ? ' t="str"' : ''}><v>${fill.v}</v></c>`);
            }
          }
        }
      } else if (typeof cell.v === 'string') {
        xml = `<c r="${r}"${sAttr} t="s"><v>${stringId(cell.v)}</v></c>`;
      } else if (typeof cell.v === 'number') {
        xml = `<c r="${r}"${sAttr}><v>${numberText(cell.v)}</v></c>`;
      } else if (typeof cell.v === 'boolean') {
        xml = `<c r="${r}"${sAttr} t="b"><v>${cell.v ? 1 : 0}</v></c>`;
      } else {
        xml = `<c r="${r}"${sAttr}/>`;
      }
      rowOf(row).set(col, xml);
    }
    for (const r of sheet.rowH.keys()) rowOf(r);
    for (const r of sheet.hiddenRows) rowOf(r);

    const used = wb.usedBounds(s);
    const parts: string[] = [];
    const pageXml = writePage(sheet);
    parts.push(`<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">`);
    parts.push(pageXml.sheetPr);
    parts.push(tag('dimension', { ref: used.cols && used.rows ? rangeText({ c0: 0, r0: 0, c1: used.cols - 1, r1: used.rows - 1 }) : 'A1' }));
    const { rows: fr, cols: fc } = sheet.freeze;
    const paneXml = fr || fc
      ? tag('pane', { xSplit: fc || undefined, ySplit: fr || undefined, topLeftCell: addressOf(fc, fr), activePane: fr && fc ? 'bottomRight' : fr ? 'bottomLeft' : 'topRight', state: 'frozen' })
      : '';
    parts.push(`<sheetViews>${tag('sheetView', { showGridLines: sheet.noGrid ? 0 : undefined, tabSelected: s === wb.active ? 1 : undefined, workbookViewId: 0 }, paneXml)}</sheetViews>`);
    parts.push('<sheetFormatPr defaultRowHeight="15"/>');
    const colIdx = [...new Set([...sheet.colW.keys(), ...sheet.hiddenCols])].sort((a, b) => a - b);
    if (colIdx.length) {
      parts.push('<cols>');
      for (const c of colIdx) {
        const px = sheet.colW.get(c) ?? 64;
        parts.push(tag('col', { min: c + 1, max: c + 1, width: Math.trunc((px / 7) * 256) / 256, customWidth: sheet.colW.has(c) ? 1 : undefined, hidden: sheet.hiddenCols.has(c) ? 1 : undefined }));
      }
      parts.push('</cols>');
    }
    parts.push('<sheetData>');
    for (const r of [...rows.keys()].sort((a, b) => a - b)) {
      const cellsXml = [...rows.get(r)!].sort((a, b) => a[0] - b[0]).map(x => x[1]).join('');
      const h = sheet.rowH.get(r);
      parts.push(`${tag('row', { r: r + 1, ht: h !== undefined ? Math.round(h * 0.75 * 100) / 100 : undefined, customHeight: h !== undefined ? 1 : undefined, hidden: sheet.hiddenRows.has(r) ? 1 : undefined }, cellsXml || undefined)}`);
    }
    parts.push('</sheetData>');
    const tableFilter = sheet.tables.find(t => wb.isTableFilter(s, t));
    if (sheet.filter && !tableFilter) {
      const f = sheet.filter;
      parts.push(tag('autoFilter', { ref: rangeText(f.range) }, filterColumnsXml(f, f.range.c0) || undefined));
      const quoted = `'${sheet.name.replace(/'/g, "''")}'`;
      definedNames.push(tag('definedName', { name: '_xlnm._FilterDatabase', localSheetId: s, hidden: 1 }, escapeXml(`${quoted}!$${colName(f.range.c0)}$${f.range.r0 + 1}:$${colName(f.range.c1)}$${f.range.r1 + 1}`)));
    }
    if (sheet.merges.length) parts.push(`<mergeCells count="${sheet.merges.length}">${sheet.merges.map(m => tag('mergeCell', { ref: rangeText(m) })).join('')}</mergeCells>`);
    parts.push(writeCf(sheet, dxfId, 1).xml);
    parts.push(writeDv(sheet));
    parts.push(pageXml.printOptions, pageXml.margins, pageXml.setup, pageXml.headerFooter);
    definedNames.push(...printNames(sheet, s));
    const sheetRels: string[] = [];
    const relId = (type: string, target: string) => {
      const id = `rId${sheetRels.length + 1}`;
      sheetRels.push(tag('Relationship', { Id: id, Type: REL(type), Target: target }));
      return id;
    };
    const tail: string[] = [];
    if (sheet.charts.length) {
      // The sheet's drawing (where each chart sits) and one part per chart, each with its relationships.
      const d = ++drawingNo;
      const colPx = (c: number) => (sheet.hiddenCols.has(c) ? 0 : sheet.colW.get(c) ?? 64);
      const rowPx = (r: number) => (sheet.hiddenRows.has(r) ? 0 : sheet.rowH.get(r) ?? 20);
      add(`xl/drawings/drawing${d}.xml`, drawingXml(sheet, colPx, rowPx));
      const rels: string[] = [];
      sheet.charts.forEach((ch, k) => {
        const n = ++chartNo;
        add(`xl/charts/chart${n}.xml`, chartXml(wb, s, ch));
        overridesExtra.push(tag('Override', { PartName: `/xl/charts/chart${n}.xml`, ContentType: 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml' }));
        rels.push(tag('Relationship', { Id: `rId${k + 1}`, Type: REL('chart'), Target: `../charts/chart${n}.xml` }));
      });
      add(`xl/drawings/_rels/drawing${d}.xml.rels`, `<Relationships xmlns="${NS_PKG_REL}">${rels.join('')}</Relationships>`);
      overridesExtra.push(tag('Override', { PartName: `/xl/drawings/drawing${d}.xml`, ContentType: 'application/vnd.openxmlformats-officedocument.drawing+xml' }));
      tail.push(`<drawing r:id="${relId('drawing', `../drawings/drawing${d}.xml`)}"/>`);
    }
    // Tables: a part each; written after the notes' drawing, as Excel orders them (tableParts last).
    const tableIds: string[] = [];
    for (const t of sheet.tables) {
      const n = ++tableNo;
      add(`xl/tables/table${n}.xml`, tableXml(t, n, tableFilter === t ? sheet.filter : null));
      overridesExtra.push(tag('Override', { PartName: `/xl/tables/table${n}.xml`, ContentType: CT('table') }));
      tableIds.push(relId('table', `../tables/table${n}.xml`));
    }
    // Notes: Excel's comments part, and the old-style drawing (VML) that places each note's box.
    const notes = wb.notesOf(s);
    if (notes.length) {
      const n = ++notesNo;
      add(`xl/comments${n}.xml`, `<comments xmlns="${NS_MAIN}"><authors><author>Author</author></authors><commentList>${notes.map(nt => tag('comment', { ref: addressOf(nt.col, nt.row), authorId: 0 }, `<text><r><rPr><sz val="9"/><color indexed="81"/><rFont val="Tahoma"/><family val="2"/></rPr>${textTag(nt.text.replace(/\n/g, '\r\n'))}</r></text>`)).join('')}</commentList></comments>`);
      files.push({ name: `xl/drawings/vmlDrawing${n}.vml`, data: new TextEncoder().encode(noteVml(n, notes)), modified: now });
      overridesExtra.push(tag('Override', { PartName: `/xl/comments${n}.xml`, ContentType: CT('comments') }));
      relId('comments', `../comments${n}.xml`);
      tail.push(`<legacyDrawing r:id="${relId('vmlDrawing', `../drawings/vmlDrawing${n}.vml`)}"/>`);
      vml = true;
    }
    if (tableIds.length) tail.push(`<tableParts count="${tableIds.length}">${tableIds.map(id => tag('tablePart', { 'r:id': id })).join('')}</tableParts>`);
    parts.push(...tail);
    if (sheetRels.length) add(`xl/worksheets/_rels/sheet${s + 1}.xml.rels`, `<Relationships xmlns="${NS_PKG_REL}">${sheetRels.join('')}</Relationships>`);
    parts.push('</worksheet>');
    add(`xl/worksheets/sheet${s + 1}.xml`, parts.join(''));
  });

  for (const n of wb.names) {
    const local = n.scope !== undefined ? wb.sheets.findIndex(sh => sh.name.toLowerCase() === n.scope!.toLowerCase()) : -1;
    definedNames.push(tag('definedName', { name: n.name, comment: n.comment, localSheetId: local >= 0 ? local : undefined }, escapeXml(toExcelFormula(n.ref))));
  }
  // Excel wants its names in order of name.
  const nameOf = (x: string) => (/name="([^"]*)"/.exec(x)?.[1] ?? '').toLowerCase();
  definedNames.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  const sheetsXml = wb.sheets.map((sh, i) => tag('sheet', { name: sh.name, sheetId: i + 1, 'r:id': `rId${i + 1}` })).join('');
  add('xl/workbook.xml', `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><bookViews>${tag('workbookView', { activeTab: wb.active || undefined })}</bookViews><sheets>${sheetsXml}</sheets>${definedNames.length ? `<definedNames>${definedNames.join('')}</definedNames>` : ''}<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`);

  const sst = [...strings.keys()].map(s => `<si>${textTag(s)}</si>`).join('');
  add('xl/sharedStrings.xml', `<sst xmlns="${NS_MAIN}" count="${strings.size}" uniqueCount="${strings.size}">${sst}</sst>`);
  add('xl/styles.xml', `<styleSheet xmlns="${NS_MAIN}">${numFmts.length ? `<numFmts count="${numFmts.length}">${numFmts.join('')}</numFmts>` : ''}<fonts count="${fonts.length}">${fonts.join('')}</fonts><fills count="${fills.length}">${fills.join('')}</fills><borders count="${borders.length}">${borders.join('')}</borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>${dxfs.length ? `<dxfs count="${dxfs.length}">${dxfs.join('')}</dxfs>` : ''}</styleSheet>`);
  if (dynamic) {
    // Marks the formulas carrying cm="1" as Excel 365 "dynamic array" formulas (they fill the cells around them).
    add('xl/metadata.xml', `<metadata xmlns="${NS_MAIN}" xmlns:xda="http://schemas.microsoft.com/office/spreadsheetml/2017/dynamicarray"><metadataTypes count="1"><metadataType name="XLDAPR" minSupportedVersion="120000" copy="1" pasteAll="1" pasteValues="1" merge="1" splitFirst="1" rowColShift="1" clearFormats="1" clearComments="1" assign="1" coerce="1" cellMeta="1"/></metadataTypes><futureMetadata name="XLDAPR" count="1"><bk><extLst><ext uri="{bdbb8cdc-fa1e-496e-a857-3c3f30c029c3}"><xda:dynamicArrayProperties fDynamic="1" fCollapsed="0"/></ext></extLst></bk></futureMetadata><cellMetadata count="1"><bk><rc t="1" v="0"/></bk></cellMetadata></metadata>`);
  }

  const n = wb.sheets.length;
  const rels = [
    ...wb.sheets.map((_, i) => tag('Relationship', { Id: `rId${i + 1}`, Type: REL('worksheet'), Target: `worksheets/sheet${i + 1}.xml` })),
    tag('Relationship', { Id: `rId${n + 1}`, Type: REL('styles'), Target: 'styles.xml' }),
    tag('Relationship', { Id: `rId${n + 2}`, Type: REL('sharedStrings'), Target: 'sharedStrings.xml' }),
    ...(dynamic ? [tag('Relationship', { Id: `rId${n + 3}`, Type: REL('sheetMetadata'), Target: 'metadata.xml' })] : []),
  ];
  add('xl/_rels/workbook.xml.rels', `<Relationships xmlns="${NS_PKG_REL}">${rels.join('')}</Relationships>`);
  add('_rels/.rels', `<Relationships xmlns="${NS_PKG_REL}">${tag('Relationship', { Id: 'rId1', Type: REL('officeDocument'), Target: 'xl/workbook.xml' })}</Relationships>`);
  const overrides = [
    tag('Override', { PartName: '/xl/workbook.xml', ContentType: CT('sheet.main') }),
    ...wb.sheets.map((_, i) => tag('Override', { PartName: `/xl/worksheets/sheet${i + 1}.xml`, ContentType: CT('worksheet') })),
    tag('Override', { PartName: '/xl/styles.xml', ContentType: CT('styles') }),
    tag('Override', { PartName: '/xl/sharedStrings.xml', ContentType: CT('sharedStrings') }),
    ...(dynamic ? [tag('Override', { PartName: '/xl/metadata.xml', ContentType: CT('sheetMetadata') })] : []),
    ...overridesExtra,
  ];
  // The list of parts goes first, as Excel writes it.
  files.unshift({
    name: '[Content_Types].xml',
    modified: now,
    data: new TextEncoder().encode(`${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${vml ? '<Default Extension="vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/>' : ''}${overrides.join('')}</Types>`),
  });
  return zipDeflate(files);
}
