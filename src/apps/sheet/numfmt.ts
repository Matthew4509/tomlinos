// Number format codes, as Excel writes them: "#,##0.00", "0%", "000-000", "dd/mm/yyyy", "h:mm AM/PM", "0.00E+00",
// "# ?/?", "[Red]-0.00", "0;-0;\"zero\";@". Used by a cell's number format and by TEXT(). Our own code.
import { DAYS, MAX_SERIAL, MONTHS, partsOf } from './dates.ts';

export interface Formatted {
  text: string;
  /** A colour the code asks for ([Red]), as #rrggbb. */
  color?: string;
}

type Tok =
  | { k: 'lit'; s: string }
  | { k: 'digit'; s: '0' | '#' | '?' }
  | { k: 'point'; s: string }
  | { k: 'comma'; s: string }
  | { k: 'pct'; s: string }
  | { k: 'exp'; s: string; plus: boolean }
  | { k: 'slash'; s: string }
  | { k: 'text'; s: string }
  | { k: 'general'; s: string }
  /** y, m, d, h, s runs as written; `minute` marks an m that means minutes. */
  | { k: 'date'; s: string; minute?: boolean }
  | { k: 'ampm'; s: string }
  | { k: 'elapsed'; s: string; unit: 'h' | 'm' | 's'; n: number };

interface Section {
  toks: Tok[];
  color?: string;
  cond?: { op: string; v: number };
  kind: 'number' | 'date' | 'text' | 'general' | 'literal';
}

const COLOURS: Record<string, string> = {
  black: '#000000', blue: '#0000ff', cyan: '#00ffff', green: '#00ff00', magenta: '#ff00ff', red: '#ff0000', white: '#ffffff', yellow: '#ffff00',
};
/** Excel's [Color1] to [Color8]. */
const NUMBERED = ['black', 'white', 'red', 'green', 'blue', 'yellow', 'magenta', 'cyan'];

export class CodeProblem extends Error {}

function tokenize(code: string): Section[] {
  const sections: Section[] = [];
  let toks: Tok[] = [];
  let color: string | undefined;
  let cond: Section['cond'];
  const close = () => {
    sections.push({ toks, color, cond, kind: 'literal' });
    toks = [];
    color = undefined;
    cond = undefined;
  };
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    const rest = code.slice(i);
    if (c === '"') {
      const end = code.indexOf('"', i + 1);
      if (end < 0) throw new CodeProblem('A quotation mark is not closed.');
      toks.push({ k: 'lit', s: code.slice(i + 1, end) });
      i = end;
    } else if (c === '\\') {
      if (i + 1 < code.length) toks.push({ k: 'lit', s: code[++i] });
    } else if (c === '_') {
      i++;
      toks.push({ k: 'lit', s: ' ' });
    } else if (c === '*') {
      // A fill character (repeat to the cell's width): left out, the text is not padded.
      i++;
    } else if (c === '[') {
      const end = code.indexOf(']', i);
      if (end < 0) throw new CodeProblem('A [ is not closed with ].');
      const inner = code.slice(i + 1, end);
      const lower = inner.toLowerCase();
      let m: RegExpExecArray | null;
      if (COLOURS[lower]) color = COLOURS[lower];
      else if ((m = /^color(\d{1,2})$/.exec(lower))) color = COLOURS[NUMBERED[(parseInt(m[1], 10) - 1) % 8] ?? 'black'];
      else if ((m = /^(<=|>=|<>|<|>|=)\s*(-?\d+(?:\.\d+)?)$/.exec(inner))) cond = { op: m[1], v: parseFloat(m[2]) };
      else if (/^(h+|m+|s+)$/i.test(inner)) toks.push({ k: 'elapsed', s: inner, unit: lower[0] as 'h' | 'm' | 's', n: inner.length });
      else if ((m = /^\$([^-]*)/.exec(inner))) {
        if (m[1]) toks.push({ k: 'lit', s: m[1] });
      }
      i = end;
    } else if (c === ';') close();
    else if (/^general/i.test(rest)) {
      toks.push({ k: 'general', s: 'General' });
      i += 6;
    } else if (c === '0' || c === '#' || c === '?') toks.push({ k: 'digit', s: c });
    else if (c === '.') toks.push({ k: 'point', s: c });
    else if (c === ',') toks.push({ k: 'comma', s: c });
    else if (c === '%') toks.push({ k: 'pct', s: c });
    else if ((c === 'E' || c === 'e') && (code[i + 1] === '+' || code[i + 1] === '-')) {
      toks.push({ k: 'exp', s: c + code[i + 1], plus: code[i + 1] === '+' });
      i++;
    } else if (c === '/') toks.push({ k: 'slash', s: c });
    else if (c === '@') toks.push({ k: 'text', s: c });
    else if (/^am\/pm/i.test(rest)) {
      toks.push({ k: 'ampm', s: rest.slice(0, 5) });
      i += 4;
    } else if (/^a\/p/i.test(rest)) {
      toks.push({ k: 'ampm', s: rest.slice(0, 3) });
      i += 2;
    } else if (/[ymdhs]/i.test(c)) {
      let j = i;
      while (j < code.length && code[j].toLowerCase() === c.toLowerCase()) j++;
      toks.push({ k: 'date', s: code.slice(i, j).toLowerCase() });
      i = j - 1;
    } else toks.push({ k: 'lit', s: c });
  }
  close();
  if (sections.length > 4) throw new CodeProblem('A format has at most four parts, split by semicolons.');
  for (const sec of sections) classify(sec);
  return sections;
}

function classify(sec: Section): void {
  const t = sec.toks;
  // m means minutes right after an hour or right before seconds; otherwise it is the month.
  const timeLike = (x: Tok | undefined, unit: 'h' | 's') => x && ((x.k === 'date' && x.s[0] === unit) || (x.k === 'elapsed' && x.unit === unit));
  t.forEach((x, i) => {
    if (x.k !== 'date' || x.s[0] !== 'm' || x.s.length > 2) return;
    let before: Tok | undefined;
    for (let j = i - 1; j >= 0; j--) if (t[j].k === 'date' || t[j].k === 'elapsed') { before = t[j]; break; }
    let after: Tok | undefined;
    for (let j = i + 1; j < t.length; j++) if (t[j].k === 'date' || t[j].k === 'elapsed') { after = t[j]; break; }
    if (timeLike(before, 'h') || timeLike(after, 's')) x.minute = true;
  });
  if (t.some(x => x.k === 'date' || x.k === 'ampm' || x.k === 'elapsed')) sec.kind = 'date';
  else if (t.some(x => x.k === 'digit')) sec.kind = 'number';
  else if (t.some(x => x.k === 'general')) sec.kind = 'general';
  else if (t.some(x => x.k === 'text')) sec.kind = 'text';
  else sec.kind = 'literal';
}

const cache = new Map<string, Section[]>();
function sectionsOf(code: string): Section[] {
  let s = cache.get(code);
  if (!s) {
    s = tokenize(code);
    if (cache.size > 500) cache.clear();
    cache.set(code, s);
  }
  return s;
}

/** Why a format code cannot be used, or null when it is fine. */
export function codeProblem(code: string): string | null {
  if (!code.trim()) return 'Type a format, for example 0.00 or dd/mm/yyyy.';
  if (code.length > 255) return 'A format can be up to 255 characters long.';
  try {
    sectionsOf(code);
    return null;
  } catch (error) {
    if (error instanceof CodeProblem) return error.message;
    throw error;
  }
}

/** True when the code shows a number as a date or time (its first part has days, months, hours...). */
export function isDateCode(code: string): boolean {
  try {
    return sectionsOf(code)[0]?.kind === 'date';
  } catch {
    return false;
  }
}

// ---- Numbers -------------------------------------------------------------------------------------------------------

/** Fixed decimals, half away from zero; "" for the integer part when it is 0 and `dropZero`. */
function fixedParts(n: number, dec: number): [string, string] {
  const scaled = Number(`${n}e${dec}`);
  const r = Number.isFinite(scaled) ? Math.round(scaled) : Math.round(n * Math.pow(10, dec));
  let s = r.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 0 });
  if (dec === 0) return [s, ''];
  s = s.padStart(dec + 1, '0');
  return [s.slice(0, s.length - dec), s.slice(s.length - dec)];
}

function generalText(n: number): string {
  if (!Number.isFinite(n)) return '#NUM!';
  const c = parseFloat(n.toPrecision(15));
  if (c === 0) return '0';
  const abs = Math.abs(c);
  if (abs >= 1e11 || abs < 1e-9) return c.toExponential(5).replace(/\.?0+e/, 'e').replace('e+', 'E+').replace('e-', 'E-');
  const s = String(parseFloat(c.toPrecision(11)));
  return s.includes('e') ? c.toFixed(10).replace(/\.?0+$/, '') : s;
}

/** Writes `digits` into the integer placeholders, right to left: extra digits go in front of the leftmost one. */
function fillInteger(toks: Tok[], digits: string): string {
  const out: string[] = [];
  let left = digits;
  const firstDigit = toks.findIndex(t => t.k === 'digit');
  // No placeholder before the point (".00"): the digits still show, ahead of it.
  if (firstDigit < 0) return toks.filter(t => t.k !== 'comma').map(t => t.s).join('') + digits;
  for (let i = toks.length - 1; i >= 0; i--) {
    const t = toks[i];
    if (t.k === 'digit') {
      if (left.length) {
        out.push(left[left.length - 1]);
        left = left.slice(0, -1);
      } else out.push(t.s === '0' ? '0' : t.s === '?' ? ' ' : '');
      if (i === firstDigit && left.length) {
        out.push(left);
        left = '';
      }
    } else if (t.k !== 'comma') out.push(t.s);
  }
  return out.reverse().join('');
}

function fillDecimals(toks: Tok[], digits: string): string {
  let out = '';
  let d = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.k !== 'digit') {
      if (t.k !== 'comma') out += t.s;
      continue;
    }
    const ch = digits[d] ?? '0';
    // Trailing zeros under # or ? are dropped (#) or shown as spaces (?), unless a 0 placeholder still follows.
    const restZero = /^0*$/.test(digits.slice(d));
    const zeroAfter = toks.slice(i).some(x => x.k === 'digit' && x.s === '0');
    if (t.s !== '0' && restZero && !zeroAfter) out += t.s === '?' ? ' ' : '';
    else out += ch;
    d++;
  }
  return out;
}

function placeholders(toks: Tok[]): number {
  return toks.filter(t => t.k === 'digit').length;
}

function renderFraction(toks: Tok[], slash: number, v: number): string {
  // The numerator is the run of placeholders just before the slash; any placeholders before that are the whole part.
  let numStart = slash;
  while (numStart > 0 && toks[numStart - 1].k === 'digit') numStart--;
  const head = toks.slice(0, numStart);
  const numToks = toks.slice(numStart, slash);
  const after = toks.slice(slash + 1);
  let denEnd = 0;
  while (denEnd < after.length && (after[denEnd].k === 'digit' || (after[denEnd].k === 'lit' && /^\d$/.test(after[denEnd].s)))) denEnd++;
  const denToks = after.slice(0, denEnd);
  const tail = after.slice(denEnd);
  const fixedDen = denToks.length && denToks.every(t => t.k === 'lit') ? parseInt(denToks.map(t => t.s).join(''), 10) : 0;
  const hasWhole = head.some(t => t.k === 'digit');
  let whole = hasWhole ? Math.floor(v) : 0;
  const f = v - whole;
  let num: number;
  let den: number;
  if (fixedDen > 0) {
    den = fixedDen;
    num = Math.round(f * den);
  } else {
    const maxDen = Math.min(9999, Math.pow(10, Math.max(1, placeholders(denToks))) - 1);
    num = Math.round(f);
    den = 1;
    let best = Math.abs(f - num);
    for (let d = 2; d <= maxDen && best > 1e-12; d++) {
      const n = Math.round(f * d);
      const err = Math.abs(f - n / d);
      if (err < best - 1e-12) {
        best = err;
        num = n;
        den = d;
      }
    }
  }
  if (hasWhole && num === den) {
    whole++;
    num = 0;
  }
  const headText = hasWhole ? fillInteger(head, whole === 0 && num !== 0 ? '' : String(whole)) : '';
  if (hasWhole && num === 0) {
    const width = numToks.length + 1 + (fixedDen ? String(fixedDen).length : denToks.length);
    return headText + ' '.repeat(width) + tail.map(t => t.s).join('');
  }
  // The numerator lines up on the right, the denominator on the left (spaces fill ? places).
  const numText = fillInteger(numToks, String(num));
  const denText = fixedDen ? String(fixedDen) : denToks.some(x => x.s === '?') ? String(den).padEnd(denToks.length, ' ') : denToks.some(x => x.s === '0') ? String(den).padStart(denToks.length, '0') : String(den);
  return headText + numText + '/' + denText + tail.map(t => t.s).join('');
}

/** A number through one number section. `v` is already the size to show (the sign is the caller's). */
function renderNumber(sec: Section, v: number): string {
  let toks = sec.toks.filter(t => t.k !== 'text');
  let value = v;
  for (const t of toks) if (t.k === 'pct') value *= 100;
  const slash = toks.findIndex((t, i) => t.k === 'slash' && toks[i - 1]?.k === 'digit' && (toks[i + 1]?.k === 'digit' || (toks[i + 1]?.k === 'lit' && /^\d$/.test(toks[i + 1].s))));
  if (slash >= 0) return renderFraction(toks, slash, value);
  toks = toks.map(t => (t.k === 'slash' ? { k: 'lit', s: '/' } : t));
  if (toks.some(t => t.k === 'general')) {
    return toks.map(t => (t.k === 'general' ? generalText(value) : t.k === 'digit' ? '' : t.s)).join('');
  }
  const expAt = toks.findIndex(t => t.k === 'exp');
  const mant = expAt >= 0 ? toks.slice(0, expAt) : toks;
  const expToks = expAt >= 0 ? toks.slice(expAt + 1) : [];
  // Commas right after the last placeholder divide by a thousand each ("0.0,," shows millions); a comma between
  // placeholders before the point turns on thousands separators.
  let lastDigit = -1;
  mant.forEach((t, i) => { if (t.k === 'digit') lastDigit = i; });
  let scale = 0;
  for (let i = lastDigit + 1; i < mant.length && (mant[i].k === 'comma' || mant[i].k === 'point'); i++) if (mant[i].k === 'comma') scale++;
  const pointAt = mant.findIndex(t => t.k === 'point');
  const intToks = pointAt >= 0 ? mant.slice(0, pointAt) : mant;
  const decToks = pointAt >= 0 ? mant.slice(pointAt + 1) : [];
  const firstInt = intToks.findIndex(t => t.k === 'digit');
  let lastInt = -1;
  intToks.forEach((t, i) => { if (t.k === 'digit') lastInt = i; });
  const thousands = intToks.some((t, i) => t.k === 'comma' && i > firstInt && i < lastInt && firstInt >= 0);
  value /= Math.pow(1000, scale);
  const decimals = placeholders(decToks);

  let expText = '';
  if (expAt >= 0) {
    const k = Math.max(1, placeholders(intToks));
    const engineering = k > 1 && intToks.find(t => t.k === 'digit')?.s === '#';
    let e = 0;
    if (value !== 0) {
      const mag = Math.floor(Math.log10(value));
      e = engineering ? Math.floor(mag / k) * k : mag - (k - 1);
    }
    let m = value / Math.pow(10, e);
    const [mi] = fixedParts(m, decimals);
    if (mi.length > k && !engineering) {
      e++;
      m = value / Math.pow(10, e);
    }
    value = m;
    const sign = e < 0 ? '-' : (toks[expAt] as { plus: boolean }).plus ? '+' : '';
    expText = toks[expAt].s[0] + sign + fillInteger(expToks, String(Math.abs(e)));
  }

  if (value >= 1e21) return generalText(value);
  const [ip, dp] = fixedParts(value, decimals);
  const zeroInt = ip === '0' && !intToks.some(t => t.k === 'digit' && t.s === '0');
  let intText: string;
  if (thousands) {
    const zeros = intToks.filter(t => t.k === 'digit' && t.s === '0').length;
    const digits = (zeroInt ? '' : ip).padStart(zeros, '0');
    const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    intText = intToks.slice(0, firstInt).map(t => t.s).join('') + grouped + intToks.slice(lastInt + 1).filter(t => t.k !== 'comma').map(t => t.s).join('');
  } else intText = fillInteger(intToks, zeroInt ? '' : ip);
  const decText = pointAt >= 0 ? '.' + fillDecimals(decToks, dp) : '';
  return intText + decText + expText;
}

// ---- Dates and times -----------------------------------------------------------------------------------------------

function renderDate(sec: Section, serial: number): string {
  if (serial < 0 || serial >= MAX_SERIAL + 1) return '#'.repeat(10);
  const toks = sec.toks;
  const fracTok = toks.findIndex((t, i) => t.k === 'point' && toks[i + 1]?.k === 'digit' && toks.slice(0, i).some(x => (x.k === 'date' && x.s[0] === 's') || (x.k === 'elapsed' && x.unit === 's')));
  let fracDigits = 0;
  if (fracTok >= 0) for (let i = fracTok + 1; toks[i]?.k === 'digit'; i++) fracDigits++;
  // Shown to the nearest second (or tenth...); minutes and hours are then cut, not rounded, as in Excel.
  const unit = Math.pow(10, fracDigits);
  const totalUnits = Math.round(serial * 86400 * unit);
  const day = Math.floor(totalUnits / (86400 * unit));
  const inDay = totalUnits - day * 86400 * unit;
  const secs = Math.floor(inDay / unit);
  const sub = inDay - secs * unit;
  const p = partsOf(day);
  const hour = Math.floor(secs / 3600);
  const minute = Math.floor((secs % 3600) / 60);
  const second = secs % 60;
  const twelve = toks.some(t => t.k === 'ampm');
  const two = (n: number) => String(n).padStart(2, '0');
  let out = '';
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (i === fracTok) {
      out += '.' + String(sub).padStart(fracDigits, '0');
      i += fracDigits;
      continue;
    }
    if (t.k === 'elapsed') {
      const total = t.unit === 'h' ? Math.floor(totalUnits / unit / 3600) : t.unit === 'm' ? Math.floor(totalUnits / unit / 60) : Math.floor(totalUnits / unit);
      out += String(total).padStart(t.n, '0');
    } else if (t.k === 'ampm') {
      const pm = hour >= 12;
      const word = t.s.length === 5 ? (pm ? 'PM' : 'AM') : pm ? 'P' : 'A';
      out += t.s[0] === t.s[0].toLowerCase() ? word.toLowerCase() : word;
    } else if (t.k === 'date') {
      const s = t.s;
      const n = s.length;
      if (s[0] === 'y') out += n <= 2 ? two(p.y % 100) : String(p.y);
      else if (s[0] === 'd') out += n === 1 ? String(p.d) : n === 2 ? two(p.d) : n === 3 ? DAYS[p.wd].slice(0, 3) : DAYS[p.wd];
      else if (s[0] === 'h') {
        const hh = twelve ? hour % 12 || 12 : hour;
        out += n >= 2 ? two(hh) : String(hh);
      } else if (s[0] === 's') out += n >= 2 ? two(second) : String(second);
      else if (t.minute) out += n >= 2 ? two(minute) : String(minute);
      else out += n === 1 ? String(p.m) : n === 2 ? two(p.m) : n === 3 ? MONTHS[p.m - 1].slice(0, 3) : n === 4 ? MONTHS[p.m - 1] : MONTHS[p.m - 1][0];
    } else out += t.s;
  }
  return out;
}

// ---- Putting it together -------------------------------------------------------------------------------------------

function matches(cond: { op: string; v: number }, n: number): boolean {
  switch (cond.op) {
    case '<': return n < cond.v;
    case '>': return n > cond.v;
    case '<=': return n <= cond.v;
    case '>=': return n >= cond.v;
    case '=': return n === cond.v;
    default: return n !== cond.v;
  }
}

function renderSection(sec: Section, n: number, text?: string): string {
  if (text !== undefined) return sec.toks.map(t => (t.k === 'text' ? text : t.k === 'lit' ? t.s : '')).join('');
  if (sec.kind === 'date') return renderDate(sec, n);
  if (sec.kind === 'number' || sec.kind === 'general') return renderNumber(sec, n);
  return sec.toks.map(t => (t.k === 'lit' ? t.s : '')).join('');
}

/** A value shown through a format code. Throws CodeProblem for a code that cannot be read (see codeProblem). */
export function formatCode(v: number | string | boolean, code: string): Formatted {
  const secs = sectionsOf(code);
  if (typeof v === 'boolean') return { text: v ? 'TRUE' : 'FALSE' };
  if (typeof v === 'string') {
    const textSec = secs.length === 4 ? secs[3] : secs.find(s => s.kind === 'text');
    return textSec ? { text: renderSection(textSec, 0, v), color: textSec.color } : { text: v };
  }
  if (!Number.isFinite(v)) return { text: '#NUM!' };
  // A last part that is only for text (it holds @) does not count as a number part.
  const numeric = secs.filter((s, i) => !(i === secs.length - 1 && i > 0 && s.kind === 'text') && i < 3);
  let sec: Section;
  let shown = Math.abs(v);
  let minus = false;
  if (numeric.some(s => s.cond)) {
    const hit = numeric.findIndex(s => (s.cond ? matches(s.cond, v) : true));
    sec = numeric[hit >= 0 ? hit : numeric.length - 1];
    minus = v < 0 && (hit <= 0 || !!sec.cond);
  } else if (v < 0 && numeric.length >= 2) sec = numeric[1];
  else if (v === 0 && numeric.length >= 3) sec = numeric[2];
  else {
    sec = numeric[0] ?? { toks: [], kind: 'literal' };
    minus = v < 0;
  }
  if (sec.kind === 'date') {
    if (v < 0) return { text: '#'.repeat(10), color: sec.color };
    shown = v;
    minus = false;
  }
  let text = renderSection(sec, shown);
  // A minus is not shown when the number rounds to nothing ("-0.001" as "0.00" is "0.00").
  if (minus && /[1-9]/.test(text)) text = '-' + text;
  return { text, color: sec.color };
}
