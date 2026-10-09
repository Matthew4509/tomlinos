// Calendar events read from and written to an .ics file, so the calendar can be downloaded into (or copied from)
// any other calendar program. Times are "floating": 09:30 means 09:30 wherever the person is, as on a paper diary.
import { escapeValue, readLines, unescapeValue, writeLine } from './lines.ts';

/** Where the Calendar keeps its events (read by the Calendar and by the reminders). */
export const CALENDAR_PATH = '/Documents/Calendar.ics';

export type Repeat = 'none' | 'weekly' | 'monthly' | 'yearly';

export interface CalEvent {
  uid: string;
  title: string;
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM, or '' for an all-day event. */
  start: string;
  end: string;
  notes: string;
  repeat: Repeat;
  /** Minutes before the start to show a reminder; -1 for none. All-day events remind at 09:00 on the day. */
  remind: number;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}
export const isTime = (value: string): boolean => TIME.test(value);

export function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseStamp(value: string): { date: string; time: string } | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})\d{2}Z?)?$/.exec(value.trim());
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  return isDate(date) ? { date, time: m[4] ? `${m[4]}:${m[5]}` : '' } : null;
}

const stamp = (date: string, time: string) => date.replace(/-/g, '') + (time ? `T${time.replace(':', '')}00` : '');

export function parseIcs(text: string): CalEvent[] {
  const events: CalEvent[] = [];
  let cur: Partial<CalEvent> | null = null;
  for (const line of readLines(text)) {
    if (line.name === 'BEGIN' && line.value.toUpperCase() === 'VEVENT') cur = { notes: '', repeat: 'none', remind: -1, start: '', end: '' };
    else if (line.name === 'END' && line.value.toUpperCase() === 'VEVENT') {
      if (cur?.date) events.push({ uid: cur.uid || crypto.randomUUID(), title: cur.title || '(no title)', date: cur.date, start: cur.start ?? '', end: cur.end ?? '', notes: cur.notes ?? '', repeat: cur.repeat ?? 'none', remind: cur.remind ?? -1 });
      cur = null;
    } else if (cur) {
      if (line.name === 'UID') cur.uid = line.value.slice(0, 200);
      else if (line.name === 'SUMMARY') cur.title = unescapeValue(line.value).slice(0, 500);
      else if (line.name === 'DESCRIPTION') cur.notes = unescapeValue(line.value).slice(0, 20000);
      else if (line.name === 'DTSTART') {
        const s = parseStamp(line.value);
        if (s) [cur.date, cur.start] = [s.date, s.time];
      } else if (line.name === 'DTEND') {
        const s = parseStamp(line.value);
        if (s?.time) cur.end = s.time;
      } else if (line.name === 'RRULE') {
        const f = /FREQ=(WEEKLY|MONTHLY|YEARLY)/i.exec(line.value);
        if (f) cur.repeat = f[1].toLowerCase() as Repeat;
      } else if (line.name === 'X-TOMLINOS-REMIND') {
        const n = Number(line.value);
        if (Number.isInteger(n) && n >= -1 && n <= 10080) cur.remind = n;
      }
    }
  }
  return events;
}

export function writeIcs(events: CalEvent[]): string {
  const out = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TomlinOS//Calendar//EN'];
  for (const e of events) {
    out.push('BEGIN:VEVENT', writeLine('UID', e.uid), writeLine('SUMMARY', escapeValue(e.title)));
    out.push(e.start ? `DTSTART:${stamp(e.date, e.start)}` : `DTSTART;VALUE=DATE:${stamp(e.date, '')}`);
    if (e.start && e.end) out.push(`DTEND:${stamp(e.date, e.end)}`);
    if (e.repeat !== 'none') out.push(`RRULE:FREQ=${e.repeat.toUpperCase()}`);
    if (e.notes) out.push(writeLine('DESCRIPTION', escapeValue(e.notes)));
    if (e.remind >= 0) out.push(`X-TOMLINOS-REMIND:${e.remind}`);
    out.push('END:VEVENT');
  }
  out.push('END:VCALENDAR');
  return out.join('\r\n') + '\r\n';
}

/** Does the event fall on this day (YYYY-MM-DD), counting its repeats? A monthly event on the 31st skips short months. */
export function occursOn(e: CalEvent, day: string): boolean {
  if (day === e.date) return true;
  if (e.repeat === 'none' || day < e.date) return false;
  const [y, m, d] = e.date.split('-').map(Number);
  const [Y, M, D] = day.split('-').map(Number);
  if (e.repeat === 'yearly') return M === m && D === d;
  if (e.repeat === 'monthly') return D === d;
  const a = Date.UTC(y, m - 1, d);
  const b = Date.UTC(Y, M - 1, D);
  return Math.round((b - a) / 86400000) % 7 === 0;
}

/** The events on a day, all-day first, then by start time. */
export function eventsOn(events: CalEvent[], day: string): CalEvent[] {
  return events.filter(e => occursOn(e, day)).sort((a, b) => (a.start || '').localeCompare(b.start || '') || a.title.localeCompare(b.title));
}

/** When the reminder for this event's showing on `day` is due, in ms since 1970 (local time); null if none. */
export function reminderAt(e: CalEvent, day: string): number | null {
  if (e.remind < 0) return null;
  const [Y, M, D] = day.split('-').map(Number);
  const [h, min] = (e.start || '09:00').split(':').map(Number);
  return new Date(Y, M - 1, D, h, min).getTime() - (e.start ? e.remind : 0) * 60000;
}

/** "09:30–11:00", "09:30", or "All day". */
export function timeLabel(e: CalEvent): string {
  return e.start ? `${e.start}${e.end ? '–' + e.end : ''}` : 'All day';
}

/** The 42 days (six Monday-first weeks) a month grid shows, starting on the Monday on or before the 1st. */
export function monthCells(year: number, month: number): Date[] {
  const lead = (new Date(year, month, 1).getDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, i) => new Date(year, month, 1 - lead + i));
}

/** Weekday names Monday first, in the person's language. */
export function weekdayNames(style: 'narrow' | 'short'): string[] {
  return Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: style }));
}

/** [year, month] moved by n months. */
export function addMonths(year: number, month: number, n: number): [number, number] {
  const d = new Date(year, month + n, 1);
  return [d.getFullYear(), d.getMonth()];
}

/** A YYYY-MM-DD day moved by n days. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return dateKey(new Date(y, m - 1, d + n));
}
