// Dates and times as a spreadsheet keeps them: a number of days since 1900 (a "serial"), with the time of day as the
// fraction. 1 is 1 January 1900. Like Excel, 1900 is counted as a leap year (serial 60 is 29 February 1900, a day that
// never was), so every serial after it matches Excel's. Also: reading a date or time someone typed. Our own code.

/** Which way round a typed date like 3/4/2026 is read: day first, month first, or year first. */
export type DateOrder = 'dmy' | 'mdy' | 'ymd';

const DAY_MS = 86_400_000;
/** The last day a serial can be: 31 December 9999. */
export const MAX_SERIAL = 2_958_465;

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The order this computer writes dates in (as Excel follows the computer's regional settings). */
export function localeDateOrder(): DateOrder {
  try {
    const parts = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(2001, 10, 22));
    const order = parts.filter(p => p.type === 'day' || p.type === 'month' || p.type === 'year').map(p => p.type[0]).join('');
    return order === 'mdy' || order === 'ymd' ? order : 'dmy';
  } catch {
    return 'dmy';
  }
}

/** The short date format for an order, as a format code. */
export function shortDateCode(order: DateOrder): string {
  return order === 'mdy' ? 'm/d/yyyy' : order === 'ymd' ? 'yyyy-mm-dd' : 'dd/mm/yyyy';
}

export function longDateCode(order: DateOrder): string {
  return order === 'mdy' ? 'dddd, mmmm d, yyyy' : 'dddd, d mmmm yyyy';
}

const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

export function daysInMonth(y: number, m: number): number {
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

/**
 * The serial of a year, month and day. Months and days past their ends roll over (month 13 is January of the next
 * year, day 0 the last day of the month before), as DATE does. NaN before 1900 or after 9999.
 */
export function serialOf(y: number, m: number, d: number): number {
  const year = y + Math.floor((m - 1) / 12);
  const month = ((((m - 1) % 12) + 12) % 12) + 1;
  if (year < 1900 || year > 9999) return NaN;
  // Day 1 of the month, then the days counted on from it (so 29 February 1900 is the day after the 28th, as in Excel).
  const days = (Date.UTC(year, month - 1, 1) - Date.UTC(1899, 11, 30)) / DAY_MS;
  const first = days < 61 ? days - 1 : days;
  return first + d - 1;
}

export interface Parts {
  y: number;
  m: number;
  d: number;
  /** 0 = Sunday. */
  wd: number;
}

/** The year, month, day and weekday of a serial (its whole-day part). Serial 0 is "0 January 1900", as Excel shows it. */
export function partsOf(serial: number): Parts {
  const n = Math.floor(serial);
  const wd = (((n - 1) % 7) + 7) % 7;
  if (n === 0) return { y: 1900, m: 1, d: 0, wd: 6 };
  if (n === 60) return { y: 1900, m: 2, d: 29, wd };
  const t = new Date(Date.UTC(1899, 11, n < 60 ? 31 : 30) + n * DAY_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), wd };
}

/** The serial for this moment (or today) on this computer's clock. */
export function nowSerial(withTime: boolean, at = new Date()): number {
  const day = serialOf(at.getFullYear(), at.getMonth() + 1, at.getDate());
  if (!withTime) return day;
  return day + (at.getHours() * 3600 + at.getMinutes() * 60 + at.getSeconds() + at.getMilliseconds() / 1000) / 86400;
}

// ---- Reading what was typed ----------------------------------------------------------------------------------------

export interface ReadDate {
  serial: number;
  /** The format the cell takes on, from the way it was typed (as Excel does: 13-Oct-26 shows as 13-Oct-26). */
  code: string;
}

const MONTH_WORD = /^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)$/i;
const monthOfWord = (w: string): number => (MONTH_WORD.test(w) ? ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(w.slice(0, 3).toLowerCase()) + 1 : 0);

/** A two-digit year as Excel reads it: 00-29 are 2000-2029, 30-99 are 1930-1999. */
function fullYear(text: string): number {
  const y = parseInt(text, 10);
  if (text.length > 2) return y;
  return y < 30 ? 2000 + y : 1900 + y;
}

function checkedSerial(y: number, m: number, d: number): number | null {
  // 29/02/1900 is a day Excel counts (serial 60), so it reads back as it is shown.
  if (y === 1900 && m === 2 && d === 29) return 60;
  if (!(m >= 1 && m <= 12) || y < 1900 || y > 9999 || !(d >= 1 && d <= daysInMonth(y, m))) return null;
  return serialOf(y, m, d);
}

/** A time of day: 14:30, 2:30 pm, 14:30:15, 9 AM, 0:05:30.5. Hours past 24 are allowed when there are minutes (35:00). */
function readTime(text: string): { frac: number; code: string } | null {
  const m = /^(\d{1,4})(?::(\d{1,2}))?(?::(\d{1,2}(?:\.\d+)?))?\s*([ap]\.?m?\.?)?$/i.exec(text.trim());
  if (!m) return null;
  const [, hs, ms, ss, ampm] = m;
  if (ms === undefined && !ampm) return null;
  let hour = parseInt(hs, 10);
  const min = ms === undefined ? 0 : parseInt(ms, 10);
  const sec = ss === undefined ? 0 : parseFloat(ss);
  if (min > 59 || sec >= 60) return null;
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    const pm = ampm[0].toLowerCase() === 'p';
    hour = (hour % 12) + (pm ? 12 : 0);
  } else if (hour > 23 && ms === undefined) return null;
  if (hour > 9999) return null;
  const frac = (hour * 3600 + min * 60 + sec) / 86400;
  const code = hour > 23 ? '[h]:mm:ss' : ampm ? (ss !== undefined ? 'h:mm:ss AM/PM' : 'h:mm AM/PM') : ss !== undefined ? 'h:mm:ss' : 'h:mm';
  return { frac, code };
}

/** A date with no time: 13/10/2026, 2026-10-13, 13 Oct 2026, Oct 13, 2026, 13-Oct, March 2026, 13/10. */
function readDay(text: string, order: DateOrder, thisYear: number): ReadDate | null {
  const t = text.trim().replace(/\s+/g, ' ');
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(t);
  if (m) {
    const s = checkedSerial(+m[1], +m[2], +m[3]);
    return s === null ? null : { serial: s, code: shortDateCode(order) };
  }
  m = /^(\d{1,2})([-/.])(\d{1,2})\2(\d{2}|\d{4})$/.exec(t);
  if (m) {
    const [a, b] = [+m[1], +m[3]];
    const y = fullYear(m[4]);
    const s = order === 'mdy' ? checkedSerial(y, a, b) : checkedSerial(y, b, a);
    return s === null ? null : { serial: s, code: shortDateCode(order) };
  }
  m = /^(\d{1,2})[/-](\d{1,2})$/.exec(t);
  if (m) {
    const [a, b] = [+m[1], +m[2]];
    const s = order === 'mdy' ? checkedSerial(thisYear, a, b) : checkedSerial(thisYear, b, a);
    return s === null ? null : { serial: s, code: order === 'mdy' ? 'mmm-d' : 'd-mmm' };
  }
  // Words: 13 Oct 2026, 13-Oct-26, 13 October, Oct 13 2026, October 13, 2026, Oct-2026, March 26.
  m = /^(\d{1,2})[ -]([A-Za-z]+)\.?(?:[ ,-]+(\d{2}|\d{4}))?$/.exec(t);
  if (m && monthOfWord(m[2])) {
    const y = m[3] ? fullYear(m[3]) : thisYear;
    const s = checkedSerial(y, monthOfWord(m[2]), +m[1]);
    return s === null ? null : { serial: s, code: m[3] ? 'd-mmm-yy' : 'd-mmm' };
  }
  m = /^([A-Za-z]+)\.?[ -](\d{1,2})(?:,? (\d{4}))?$/.exec(t);
  if (m && monthOfWord(m[1])) {
    const s = checkedSerial(m[3] ? +m[3] : thisYear, monthOfWord(m[1]), +m[2]);
    return s === null ? null : { serial: s, code: m[3] ? 'd-mmm-yy' : 'd-mmm' };
  }
  m = /^([A-Za-z]+)\.?[ -](\d{4})$/.exec(t);
  if (m && monthOfWord(m[1])) {
    const s = checkedSerial(+m[2], monthOfWord(m[1]), 1);
    return s === null ? null : { serial: s, code: 'mmm-yy' };
  }
  return null;
}

/** Reads typed text as a date, a time, or both; null when it is neither. */
export function readDateTime(text: string, order: DateOrder, thisYear = new Date().getFullYear()): ReadDate | null {
  const t = text.trim();
  if (!t || t.length > 40 || !/\d/.test(t)) return null;
  const time = readTime(t);
  if (time) return { serial: time.frac, code: time.code };
  const day = readDay(t, order, thisYear);
  if (day) return day;
  // A date and a time: 13/10/2026 14:30, 2026-10-13 2:30 PM, 2026-10-13T14:30.
  const split = /^(.+?)(?:\s+|T)(\d{1,2}:\d.*|\d{1,2}\s*[ap]\.?m?\.?)$/i.exec(t);
  if (split) {
    const d = readDay(split[1], order, thisYear);
    const tm = readTime(split[2]);
    if (d && tm && tm.frac < 1) {
      return { serial: d.serial + tm.frac, code: `${shortDateCode(order)} ${tm.code.includes('AM/PM') ? 'h:mm AM/PM' : 'h:mm'}` };
    }
  }
  return null;
}
