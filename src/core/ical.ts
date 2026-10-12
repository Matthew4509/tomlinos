// Calendar events read from and written to an .ics file, so the calendar can be downloaded into (or copied from)
// any other calendar program. Times are "floating": 09:30 means 09:30 wherever the person is, as on a paper diary.
// A time the file gives in UTC or in a named time zone is shown as this computer's local time. What a file from
// elsewhere holds that this calendar does not edit (places, alarms, guests, a repeat rule richer than ours) is kept
// and written back as it was.
import { escapeValue, foldLine, idFromText, readLines, type ContentLine, unescapeValue, writeLine } from './lines.ts';

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
  /** What the file held for this event beyond the fields above (absent for an event made here). */
  keep?: EventKeep;
}

interface EventKeep {
  /** The file's own UID ('' when it gave none). */
  uid: string;
  /** Properties and inner parts (alarms) this calendar does not edit, as they were. */
  lines: string[];
  /** The file's own time lines (DTSTART, DTEND, DURATION) and repeat lines, written back while unchanged here. */
  time: string[];
  rule: string[];
  was: { date: string; start: string; end: string; repeat: Repeat };
  /** Everything in the file outside its events (time zones, the calendar's name), shared by all its events. */
  calendar: string[];
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

/** The moment (ms since 1970) a wall-clock time in a named zone stands for, or null for a zone this browser does not know. */
function zoneToUtc(y: number, mo: number, d: number, h: number, mi: number, zone: string): number | null {
  try {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const want = Date.UTC(y, mo - 1, d, h, mi);
    let guess = want;
    for (let i = 0; i < 3; i++) {
      const p = Object.fromEntries(f.formatToParts(guess).map(x => [x.type, x.value]));
      const shown = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
      if (shown === want) break;
      guess += want - shown;
    }
    return guess;
  } catch {
    return null;
  }
}

function parseStamp(line: ContentLine): { date: string; time: string } | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})\d{2}(Z?))?$/.exec(line.value.trim());
  if (!m) return null;
  let [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  let time = '';
  if (m[4] !== undefined) {
    let [h, mi] = [Number(m[4]), Number(m[5])];
    // UTC ("Z", as Google and Outlook write) or a named zone: shown as the local time it is here.
    const at = m[6] === 'Z' ? Date.UTC(y, mo - 1, d, h, mi) : line.params.TZID ? zoneToUtc(y, mo, d, h, mi, line.params.TZID) : null;
    if (at !== null && Number.isFinite(at)) {
      const t = new Date(at);
      [y, mo, d, h, mi] = [t.getFullYear(), t.getMonth() + 1, t.getDate(), t.getHours(), t.getMinutes()];
    }
    time = `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
    if (!isTime(time)) return null;
  }
  const date = `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return isDate(date) ? { date, time } : null;
}

const stamp = (date: string, time: string) => date.replace(/-/g, '') + (time ? `T${time.replace(':', '')}00` : '');

/** The repeat a rule maps to here; a rule this calendar cannot show (daily, every 2 weeks) still shows its first day. */
function repeatOf(rule: string): Repeat {
  const f = /(?:^|;)FREQ=(WEEKLY|MONTHLY|YEARLY)(?:;|$)/i.exec(rule);
  return f ? (f[1].toLowerCase() as Repeat) : 'none';
}

const EDITED = new Set(['UID', 'SUMMARY', 'DESCRIPTION', 'DTSTART', 'DTEND', 'DURATION', 'RRULE', 'X-TOMLINOS-REMIND']);
const CALENDAR_OWN = new Set(['VERSION', 'PRODID']);

export function parseIcs(text: string): CalEvent[] {
  const events: CalEvent[] = [];
  const calendar: string[] = [];
  const seen = new Map<string, number>();
  let cur: (Partial<CalEvent> & { keep: EventKeep; raw: string[]; recurrence: string }) | null = null;
  // Inner parts (an event's alarms; the calendar's time zones) are kept whole, line for line.
  let depth = 0;
  let inCalendar = false;
  for (const line of readLines(text)) {
    const begin = line.name === 'BEGIN' ? line.value.toUpperCase() : '';
    const end = line.name === 'END' ? line.value.toUpperCase() : '';
    if (cur) cur.raw.push(line.raw);
    if (depth > 0) {
      (cur ? cur.keep.lines : calendar).push(line.raw);
      if (begin) depth++;
      else if (end) depth--;
      continue;
    }
    if (begin === 'VCALENDAR' && !cur) inCalendar = true;
    else if (end === 'VCALENDAR' && !cur) inCalendar = false;
    else if (begin === 'VEVENT' && !cur) {
      cur = { notes: '', repeat: 'none', remind: -1, start: '', end: '', raw: [], recurrence: '', keep: { uid: '', lines: [], time: [], rule: [], was: { date: '', start: '', end: '', repeat: 'none' }, calendar } };
    } else if (end === 'VEVENT' && cur) {
      if (cur.date) {
        const keep = cur.keep;
        const fileUid = keep.uid;
        // A moved or changed showing of a repeating event shares its series' UID: it gets its own key here, so an
        // edit or delete of one never takes the other with it.
        const base = fileUid || idFromText(cur.raw.join('\n'), seen);
        const uid = cur.recurrence ? `${base}#${cur.recurrence}` : base;
        const e: CalEvent = { uid, title: cur.title || '(no title)', date: cur.date, start: cur.start ?? '', end: cur.end ?? '', notes: cur.notes ?? '', repeat: cur.repeat ?? 'none', remind: cur.remind ?? -1 };
        keep.uid = fileUid || base;
        keep.was = { date: e.date, start: e.start, end: e.end, repeat: e.repeat };
        e.keep = keep;
        events.push(e);
      }
      cur = null;
    } else if (begin) {
      depth = 1;
      (cur ? cur.keep.lines : calendar).push(line.raw);
    } else if (cur) {
      if (line.name === 'UID') cur.keep.uid = line.value.slice(0, 200);
      else if (line.name === 'SUMMARY') cur.title = unescapeValue(line.value).slice(0, 500);
      else if (line.name === 'DESCRIPTION') cur.notes = unescapeValue(line.value).slice(0, 20000);
      else if (line.name === 'DTSTART') {
        const s = parseStamp(line);
        if (s) [cur.date, cur.start] = [s.date, s.time];
      } else if (line.name === 'DTEND') {
        const s = parseStamp(line);
        if (s?.time) cur.end = s.time;
      } else if (line.name === 'RRULE') {
        cur.repeat = repeatOf(line.value);
        cur.keep.rule.push(line.raw);
      } else if (line.name === 'X-TOMLINOS-REMIND') {
        const n = Number(line.value);
        if (Number.isInteger(n) && n >= -1 && n <= 10080) cur.remind = n;
      }
      if (line.name === 'RECURRENCE-ID') cur.recurrence = line.value.trim().slice(0, 40);
      if (line.name === 'DTSTART' || line.name === 'DTEND' || line.name === 'DURATION') cur.keep.time.push(line.raw);
      else if (!EDITED.has(line.name)) cur.keep.lines.push(line.raw);
    } else if (inCalendar && !CALENDAR_OWN.has(line.name)) {
      calendar.push(line.raw);
    }
  }
  return events;
}

export function writeIcs(events: CalEvent[]): string {
  const out = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TomlinOS//Calendar//EN'];
  const calendar = events.find(e => e.keep?.calendar.length)?.keep?.calendar ?? [];
  for (const raw of calendar) out.push(foldLine(raw));
  for (const e of events) {
    const k = e.keep;
    out.push('BEGIN:VEVENT', writeLine('UID', k?.uid || e.uid), writeLine('SUMMARY', escapeValue(e.title)));
    if (k && k.time.length && k.was.date === e.date && k.was.start === e.start && k.was.end === e.end) {
      for (const raw of k.time) out.push(foldLine(raw));
    } else {
      out.push(e.start ? `DTSTART:${stamp(e.date, e.start)}` : `DTSTART;VALUE=DATE:${stamp(e.date, '')}`);
      if (e.start && e.end) out.push(`DTEND:${stamp(e.date, e.end)}`);
    }
    if (k && k.rule.length && k.was.repeat === e.repeat) {
      for (const raw of k.rule) out.push(foldLine(raw));
    } else if (e.repeat !== 'none') out.push(`RRULE:FREQ=${e.repeat.toUpperCase()}`);
    if (e.notes) out.push(writeLine('DESCRIPTION', escapeValue(e.notes)));
    if (e.remind >= 0) out.push(`X-TOMLINOS-REMIND:${e.remind}`);
    for (const raw of k?.lines ?? []) out.push(foldLine(raw));
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
