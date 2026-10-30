// Calendar events read from and written to an .ics file, so the calendar can be downloaded into (or copied from)
// any other calendar program. Times are "floating": 09:30 means 09:30 wherever the person is, as on a paper diary.
// A time the file gives in UTC or in a named time zone is shown as this computer's local time. What a file from
// elsewhere holds that this calendar does not edit (places, alarms, guests, a repeat rule richer than ours) is kept
// and written back as it was.
import { copiesInOrder, escapeValue, foldLine, idFromText, readLines, type ContentLine, type Copy, unescapeValue, uniqueIds, writeLine } from './lines.ts';

/** Where the Calendar keeps its events (read by the Calendar and by the reminders). */
export const CALENDAR_PATH = '/Documents/Calendar.ics';

export type Repeat = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface CalEvent {
  uid: string;
  title: string;
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM, or '' for an all-day event. */
  start: string;
  end: string;
  /** The day it ends (YYYY-MM-DD) when that is later than `date`: past midnight, or over several days. Otherwise absent. */
  endDate?: string;
  notes: string;
  repeat: Repeat;
  /** Repeats this many showings in all, the first included ("run for 3 days"); 0 or absent: no limit. */
  count?: number;
  /** The last day (YYYY-MM-DD) a repeat may show on ("stop repeating"); '' or absent: no end. */
  until?: string;
  /** Where it is (the file's LOCATION). */
  where?: string;
  /** The My Projects project it belongs to (its uid), if any. */
  project?: string;
  /** Minutes before the start to show a reminder; -1 for none. All-day events count back from 09:00 on the day. */
  remind: number;
  /** What the file held for this event beyond the fields above (absent for an event made here). */
  keep?: EventKeep;
}

interface EventKeep {
  /** The file's own UID ('' when it gave none). */
  uid: string;
  /** Properties and inner parts (alarms) this calendar does not edit, as they were. */
  lines: string[];
  /** The file's own time lines (DTSTART, DTEND, DURATION), repeat lines and place lines, written back while unchanged here. */
  time: string[];
  rule: string[];
  place: string[];
  was: { date: string; start: string; end: string; endDate: string; repeat: Repeat; count: number; until: string; where: string };
  /** Everything in the file outside its events (time zones, the calendar's name), shared by all its events. */
  calendar: string[];
  /** The file's repeat rule beyond its kind: every how many (INTERVAL), on which weekdays (BYDAY, 0 = Sunday), the
   *  week's first day (WKST). Used while the event keeps that rule. */
  shape?: { every: number; days: number[]; weekStart: number };
  /** Days a repeat skips (EXDATE: a showing cancelled in the other calendar; or one moved, which has its own event). */
  skip?: string[];
  /** Which copy this is, when the file gives several events the same UID. */
  copy?: Copy;
}

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/**
 * What a repeat rule shows here: its kind and shape, or 'none' (its first day only) for a rule this calendar cannot
 * show on the right days (the second Tuesday of each month, say), so it never shows on wrong ones.
 */
function ruleOf(rule: string, date: string): { repeat: Repeat; shape?: EventKeep['shape'] } {
  const repeat = repeatOf(rule);
  if (repeat === 'none') return { repeat };
  const part = (name: string) => new RegExp(`(?:^|;)${name}=([^;]*)`, 'i').exec(rule)?.[1]?.toUpperCase();
  if (['BYSETPOS', 'BYYEARDAY', 'BYWEEKNO', 'BYHOUR', 'BYMINUTE', 'BYSECOND'].some(p => part(p) !== undefined)) return { repeat: 'none' };
  const intervalText = part('INTERVAL');
  const every = intervalText === undefined ? 1 : Number(intervalText);
  if (!Number.isInteger(every) || every < 1 || every > 1000) return { repeat: 'none' };
  const [, m, d] = date.split('-').map(Number);
  const byMonthDay = part('BYMONTHDAY');
  if (byMonthDay !== undefined && (repeat === 'daily' || repeat === 'weekly' || byMonthDay !== String(d))) return { repeat: 'none' };
  const byMonth = part('BYMONTH');
  if (byMonth !== undefined && (repeat !== 'yearly' || byMonth !== String(m))) return { repeat: 'none' };
  const weekStart = WEEKDAYS.indexOf(part('WKST') ?? 'MO');
  let days: number[] = [];
  const byDay = part('BYDAY');
  if (byDay !== undefined) {
    days = byDay.split(',').map(code => WEEKDAYS.indexOf(code.trim()));
    // A numbered weekday (2TU), weekdays on a monthly or yearly rule, or weekdays every other day: not shown here.
    if (days.some(n => n < 0) || repeat === 'monthly' || repeat === 'yearly' || (repeat === 'daily' && every > 1)) return { repeat: 'none' };
    days = [...new Set(days)].sort((a, b) => a - b);
  }
  return { repeat, shape: { every, days, weekStart: weekStart < 0 ? 1 : weekStart } };
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

/** The time zone names Outlook writes (Windows' own, which browsers do not know), with the world name for each. */
const WINDOWS_ZONES: Record<string, string> = {
  'Dateline Standard Time': 'Etc/GMT+12', 'UTC-11': 'Etc/GMT+11', 'Hawaiian Standard Time': 'Pacific/Honolulu', 'Alaskan Standard Time': 'America/Anchorage',
  'Pacific Standard Time': 'America/Los_Angeles', 'US Mountain Standard Time': 'America/Phoenix', 'Mountain Standard Time': 'America/Denver',
  'Central Standard Time': 'America/Chicago', 'Central America Standard Time': 'America/Guatemala', 'Canada Central Standard Time': 'America/Regina',
  'Central Standard Time (Mexico)': 'America/Mexico_City', 'Eastern Standard Time': 'America/New_York', 'US Eastern Standard Time': 'America/Indiana/Indianapolis',
  'SA Pacific Standard Time': 'America/Bogota', 'Atlantic Standard Time': 'America/Halifax', 'Venezuela Standard Time': 'America/Caracas',
  'SA Western Standard Time': 'America/La_Paz', 'Pacific SA Standard Time': 'America/Santiago', 'Newfoundland Standard Time': 'America/St_Johns',
  'E. South America Standard Time': 'America/Sao_Paulo', 'Argentina Standard Time': 'America/Argentina/Buenos_Aires', 'SA Eastern Standard Time': 'America/Cayenne',
  'Azores Standard Time': 'Atlantic/Azores', UTC: 'Etc/UTC', 'GMT Standard Time': 'Europe/London', 'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'Morocco Standard Time': 'Africa/Casablanca', 'W. Europe Standard Time': 'Europe/Berlin', 'Central Europe Standard Time': 'Europe/Budapest',
  'Romance Standard Time': 'Europe/Paris', 'Central European Standard Time': 'Europe/Warsaw', 'W. Central Africa Standard Time': 'Africa/Lagos',
  'GTB Standard Time': 'Europe/Bucharest', 'E. Europe Standard Time': 'Europe/Chisinau', 'FLE Standard Time': 'Europe/Kiev', 'Egypt Standard Time': 'Africa/Cairo',
  'South Africa Standard Time': 'Africa/Johannesburg', 'Israel Standard Time': 'Asia/Jerusalem', 'Turkey Standard Time': 'Europe/Istanbul',
  'Arab Standard Time': 'Asia/Riyadh', 'Arabic Standard Time': 'Asia/Baghdad', 'E. Africa Standard Time': 'Africa/Nairobi', 'Russian Standard Time': 'Europe/Moscow',
  'Iran Standard Time': 'Asia/Tehran', 'Arabian Standard Time': 'Asia/Dubai', 'Afghanistan Standard Time': 'Asia/Kabul', 'Pakistan Standard Time': 'Asia/Karachi',
  'West Asia Standard Time': 'Asia/Tashkent', 'India Standard Time': 'Asia/Kolkata', 'Sri Lanka Standard Time': 'Asia/Colombo', 'Nepal Standard Time': 'Asia/Kathmandu',
  'Central Asia Standard Time': 'Asia/Almaty', 'Bangladesh Standard Time': 'Asia/Dhaka', 'Myanmar Standard Time': 'Asia/Yangon', 'SE Asia Standard Time': 'Asia/Bangkok',
  'China Standard Time': 'Asia/Shanghai', 'Singapore Standard Time': 'Asia/Singapore', 'W. Australia Standard Time': 'Australia/Perth', 'Taipei Standard Time': 'Asia/Taipei',
  'Tokyo Standard Time': 'Asia/Tokyo', 'Korea Standard Time': 'Asia/Seoul', 'AUS Central Standard Time': 'Australia/Darwin', 'Cen. Australia Standard Time': 'Australia/Adelaide',
  'E. Australia Standard Time': 'Australia/Brisbane', 'AUS Eastern Standard Time': 'Australia/Sydney', 'West Pacific Standard Time': 'Pacific/Port_Moresby',
  'Tasmania Standard Time': 'Australia/Hobart', 'New Zealand Standard Time': 'Pacific/Auckland', 'Fiji Standard Time': 'Pacific/Fiji', 'Tonga Standard Time': 'Pacific/Tongatapu',
};

/** The moment (ms since 1970) a wall-clock time in a named zone stands for, or null for a zone this browser does not know. */
function zoneToUtc(y: number, mo: number, d: number, h: number, mi: number, zone: string): number | null {
  try {
    // An own-property check: a file's zone name must not reach Object's built-ins ("constructor") through this table.
    const timeZone = Object.hasOwn(WINDOWS_ZONES, zone) ? WINDOWS_ZONES[zone] : zone;
    const f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
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

/**
 * An event's end from what its file says (a DTEND, or a DURATION: how long, as P2D or PT3H), as a time and the day it
 * falls on when later than the start's. A file's all-day end is the day after the last, so one day back here.
 */
function endOf(date: string, start: string, end: { date: string; time: string } | undefined, duration: string): { end: string; endDate?: string } {
  let time = '';
  let day = '';
  if (end) {
    time = start ? end.time : '';
    day = end.time && start ? end.date : addDays(end.date, -1);
  } else {
    const m = /^\+?P(?:(\d{1,5})W)?(?:(\d{1,6})D)?(?:T(?:(\d{1,7})H)?(?:(\d{1,9})M)?(?:\d+S)?)?$/.exec(duration.trim());
    const minutes = m ? (Number(m[1] ?? 0) * 7 + Number(m[2] ?? 0)) * 1440 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0) : 0;
    if (minutes <= 0) return { end: '' };
    const [y, mo, d] = date.split('-').map(Number);
    if (start) {
      const [h, mi] = start.split(':').map(Number);
      const t = new Date(y, mo - 1, d, h, mi + minutes);
      [time, day] = [`${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`, dateKey(t)];
    } else day = dateKey(new Date(y, mo - 1, d + Math.ceil(minutes / 1440) - 1));
  }
  return day > date && isDate(day) ? { end: time, endDate: day } : { end: isDate(day) ? time : '' };
}

/** The repeat a rule maps to here; a rule this calendar cannot show (hourly, say) still shows its first day. */
function repeatOf(rule: string): Repeat {
  const f = /(?:^|;)FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(?:;|$)/i.exec(rule);
  return f ? (f[1].toLowerCase() as Repeat) : 'none';
}

/** A rule's COUNT (0 when none) and UNTIL as a local day ('' when none). */
function limitsOf(rule: string): { count: number; until: string } {
  const c = /(?:^|;)COUNT=(\d{1,4})(?:;|$)/i.exec(rule);
  const u = /(?:^|;)UNTIL=([0-9TZ]{8,16})(?:;|$)/i.exec(rule);
  const count = c ? Number(c[1]) : 0;
  const until = u ? parseStamp({ name: 'UNTIL', params: {}, value: u[1], raw: '' })?.date ?? '' : '';
  return { count: count >= 1 ? count : 0, until };
}

/** The value of an RRULE line (after the colon). */
const ruleValue = (raw: string) => raw.slice(raw.indexOf(':') + 1);

/** The UNTIL value for the last day `until`: a date for an all-day event, the end of that day otherwise (in UTC when the
 *  event's start is written in UTC or a named zone, as the standard asks). */
function untilStamp(until: string, timed: boolean, utc: boolean): string {
  if (!timed) return stamp(until, '');
  if (!utc) return `${stamp(until, '23:59').slice(0, -2)}59`;
  const [y, m, d] = until.split('-').map(Number);
  return new Date(y, m - 1, d, 23, 59, 59).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

const PROJECT_ID = /^[\w-]{1,64}$/;

const EDITED = new Set(['UID', 'SUMMARY', 'DESCRIPTION', 'DTSTART', 'DTEND', 'DURATION', 'RRULE', 'LOCATION', 'X-TOMLINOS-REMIND', 'X-TOMLINOS-PROJECT']);
const CALENDAR_OWN = new Set(['VERSION', 'PRODID']);

export function parseIcs(text: string): CalEvent[] {
  return readIcs(text).events;
}

/**
 * The events, and what the file holds besides them: its own lines and parts (time zones, to-dos, the calendar's name)
 * and each event this calendar cannot read (a start it cannot make out), line for line.
 */
function readIcs(text: string): { events: CalEvent[]; calendar: string[]; unread: string[][] } {
  const events: CalEvent[] = [];
  const calendar: string[] = [];
  const unread: string[][] = [];
  const seen = new Map<string, number>();
  const ids = uniqueIds();
  // Each repeat by the file's UID, and each moved showing: the day it was moved from, for the series to skip.
  const series = new Map<string, EventKeep>();
  const moved: Array<{ uid: string; day: string }> = [];
  let cur: (Partial<CalEvent> & { keep: EventKeep; raw: string[]; recurrence: string; movedFrom?: string; ruleText?: string; endStamp?: { date: string; time: string }; duration?: string }) | null = null;
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
      cur = { notes: '', repeat: 'none', remind: -1, start: '', end: '', raw: [], recurrence: '', keep: { uid: '', lines: [], time: [], rule: [], place: [], was: { date: '', start: '', end: '', endDate: '', repeat: 'none', count: 0, until: '', where: '' }, calendar } };
    } else if (end === 'VEVENT' && cur) {
      if (cur.date) {
        const keep = cur.keep;
        if (cur.ruleText !== undefined) {
          const shown = ruleOf(cur.ruleText, cur.date);
          cur.repeat = shown.repeat;
          if (shown.shape) keep.shape = shown.shape;
        }
        const fileUid = keep.uid;
        // A moved or changed showing of a repeating event shares its series' UID: it gets its own key here, so an
        // edit or delete of one never takes the other with it.
        const base = fileUid || idFromText(cur.raw.join('\n'), seen);
        // Two events the file gives one UID (a merged file, say) each get an id of their own here too.
        const unique = ids(cur.recurrence ? `${base}#${cur.recurrence}` : base);
        keep.copy = unique.copy;
        const ends = endOf(cur.date, cur.start ?? '', cur.endStamp, cur.duration ?? '');
        const e: CalEvent = { uid: unique.id, title: cur.title || '(no title)', date: cur.date, start: cur.start ?? '', end: ends.end, notes: cur.notes ?? '', repeat: cur.repeat ?? 'none', remind: cur.remind ?? -1 };
        if (ends.endDate) e.endDate = ends.endDate;
        // A limit only means something on a repeat this calendar shows.
        if (e.repeat !== 'none') {
          if (cur.count) e.count = cur.count;
          if (cur.until) e.until = cur.until;
        }
        if (cur.where) e.where = cur.where;
        if (cur.project) e.project = cur.project;
        keep.uid = fileUid || base;
        keep.was = { date: e.date, start: e.start, end: e.end, endDate: e.endDate ?? '', repeat: e.repeat, count: e.count ?? 0, until: e.until ?? '', where: e.where ?? '' };
        e.keep = keep;
        events.push(e);
        if (cur.movedFrom) moved.push({ uid: keep.uid, day: cur.movedFrom });
        else if (!cur.recurrence && keep.rule.length && !series.has(keep.uid)) series.set(keep.uid, keep);
      } else unread.push(['BEGIN:VEVENT', ...cur.raw]);
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
        cur.endStamp = parseStamp(line) ?? undefined;
      } else if (line.name === 'DURATION') {
        cur.duration = line.value;
      } else if (line.name === 'RRULE') {
        // One rule is shown and edited; a second (rare, and gone from the standard) is kept but not shown.
        if (!cur.keep.rule.length) {
          cur.repeat = repeatOf(line.value);
          cur.ruleText = line.value;
          Object.assign(cur, limitsOf(line.value));
        }
        cur.keep.rule.push(line.raw);
      } else if (line.name === 'LOCATION') {
        if (!cur.keep.place.length) cur.where = unescapeValue(line.value).slice(0, 500);
        cur.keep.place.push(line.raw);
      } else if (line.name === 'X-TOMLINOS-REMIND') {
        const n = Number(line.value);
        if (Number.isInteger(n) && n >= -1 && n <= 10080) cur.remind = n;
      } else if (line.name === 'X-TOMLINOS-PROJECT') {
        const v = line.value.trim();
        if (PROJECT_ID.test(v)) cur.project = v;
      }
      if (line.name === 'RECURRENCE-ID') {
        cur.recurrence = line.value.trim().slice(0, 40);
        cur.movedFrom = parseStamp(line)?.date;
      }
      if (line.name === 'EXDATE') {
        for (const value of line.value.split(',').slice(0, 1000)) {
          const day = parseStamp({ ...line, value })?.date;
          if (day) (cur.keep.skip ??= []).push(day);
        }
      }
      if (line.name === 'DTSTART' || line.name === 'DTEND' || line.name === 'DURATION') cur.keep.time.push(line.raw);
      else if (!EDITED.has(line.name)) cur.keep.lines.push(line.raw);
    } else if (inCalendar && !CALENDAR_OWN.has(line.name)) {
      calendar.push(line.raw);
    }
  }
  // A moved showing is its own event: the repeat does not also show on the day it was moved from. Nothing about this
  // is written to the file, which says it already.
  for (const m of moved) {
    const keep = series.get(m.uid);
    if (keep) (keep.skip ??= []).push(m.day);
  }
  return { events, calendar, unread };
}

/**
 * The calendar file for these events. Given the file's text as it was read before the change (`previous`), what it
 * holds besides the events (its name, time zones, to-dos, events this calendar cannot read) is written back as it was,
 * even when no event from it is left.
 */
export function writeIcs(events: CalEvent[], previous?: string | null): string {
  const out = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TomlinOS//Calendar//EN'];
  const before = typeof previous === 'string' ? readIcs(previous) : null;
  const calendar = before ? before.calendar : events.find(e => e.keep?.calendar.length)?.keep?.calendar ?? [];
  for (const raw of calendar) out.push(foldLine(raw));
  for (const raw of before?.unread.flat() ?? []) out.push(foldLine(raw));
  for (const e of copiesInOrder(events)) {
    const k = e.keep;
    out.push('BEGIN:VEVENT', writeLine('UID', k?.uid || e.uid), writeLine('SUMMARY', escapeValue(e.title)));
    const endDay = e.endDate && e.endDate > e.date && isDate(e.endDate) ? e.endDate : '';
    const timeKept = !!k && k.time.length > 0 && k.was.date === e.date && k.was.start === e.start && k.was.end === e.end && k.was.endDate === endDay;
    if (timeKept) {
      for (const raw of k!.time) out.push(foldLine(raw));
    } else {
      out.push(e.start ? `DTSTART:${stamp(e.date, e.start)}` : `DTSTART;VALUE=DATE:${stamp(e.date, '')}`);
      if (e.start && e.end) out.push(`DTEND:${stamp(endDay || e.date, e.end)}`);
      // In a file an all-day end is the day after the last.
      else if (!e.start && endDay) out.push(`DTEND;VALUE=DATE:${stamp(addDays(endDay, 1), '')}`);
    }
    const count = e.repeat !== 'none' && e.count && e.count >= 1 ? Math.floor(e.count) : 0;
    const until = e.repeat !== 'none' && e.until && isDate(e.until) ? e.until : '';
    if (k && k.rule.length && k.was.repeat === e.repeat) {
      if (k.was.count === count && k.was.until === until) {
        for (const raw of k.rule) out.push(foldLine(raw));
      } else if (e.repeat !== 'none') {
        // Only the end changed (Stop repeating): the file's own rule keeps its other parts (which weekdays, every 2 weeks).
        const dtstart = timeKept ? k.time.find(raw => /^DTSTART[;:]/i.test(raw)) : undefined;
        const utc = !!dtstart && (/TZID=/i.test(dtstart.slice(0, dtstart.indexOf(':'))) || /Z\s*$/i.test(dtstart));
        const parts = ruleValue(k.rule[0]).split(';').filter(p => p && !/^(COUNT|UNTIL)=/i.test(p));
        if (count) parts.push(`COUNT=${count}`);
        else if (until) parts.push(`UNTIL=${untilStamp(until, !!e.start, utc)}`);
        out.push(foldLine(`RRULE:${parts.join(';')}`));
        for (const raw of k.rule.slice(1)) out.push(foldLine(raw));
      }
    } else if (e.repeat !== 'none') {
      out.push(`RRULE:FREQ=${e.repeat.toUpperCase()}${count ? `;COUNT=${count}` : until ? `;UNTIL=${untilStamp(until, !!e.start, false)}` : ''}`);
    }
    if (e.notes) out.push(writeLine('DESCRIPTION', escapeValue(e.notes)));
    const where = (e.where ?? '').trim();
    if (k && k.place.length && k.was.where === (e.where ?? '')) {
      for (const raw of k.place) out.push(foldLine(raw));
    } else if (where) out.push(writeLine('LOCATION', escapeValue(where)));
    if (e.remind >= 0) out.push(`X-TOMLINOS-REMIND:${e.remind}`);
    if (e.project && PROJECT_ID.test(e.project)) out.push(`X-TOMLINOS-PROJECT:${e.project}`);
    for (const raw of k?.lines ?? []) out.push(foldLine(raw));
    out.push('END:VEVENT');
  }
  out.push('END:VCALENDAR');
  return out.join('\r\n') + '\r\n';
}

const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/**
 * Which showing of the event this day is (0 = its first day), counting its repeats but not its limits; -1 when it does
 * not fall on this day. A monthly event on the 31st skips short months, a yearly one on 29 February skips other years.
 */
function showingIndex(e: CalEvent, day: string): number {
  if (day === e.date) return 0;
  if (e.repeat === 'none' || day < e.date) return -1;
  // The file's own rule (every 2 weeks, on Mondays and Fridays) while the event keeps it; a repeat chosen here is plain.
  const shape = e.keep && e.keep.rule.length && e.keep.was.repeat === e.repeat ? e.keep.shape : undefined;
  const every = shape?.every ?? 1;
  const [y, m, d] = e.date.split('-').map(Number);
  const [Y, M, D] = day.split('-').map(Number);
  if (e.repeat === 'yearly') {
    if (M !== m || D !== d || (Y - y) % every) return -1;
    if (!(m === 2 && d === 29)) return (Y - y) / every;
    let n = 0;
    for (let yy = y; yy < Y; yy += every) if (daysIn(yy, 2) === 29) n++;
    return n;
  }
  if (e.repeat === 'monthly') {
    const months = (Y - y) * 12 + (M - m);
    if (D !== d || months % every) return -1;
    if (d <= 28) return months / every;
    let n = 0;
    for (let i = 0; i < months; i += every) if (daysIn(y + Math.floor((m - 1 + i) / 12), ((m - 1 + i) % 12) + 1) >= d) n++;
    return n;
  }
  const diff = Math.round((Date.UTC(Y, M - 1, D) - Date.UTC(y, m - 1, d)) / 86400000);
  if (shape?.days.length) return weekdayIndex(diff, new Date(Date.UTC(y, m - 1, d)).getUTCDay(), shape);
  if (e.repeat === 'daily') return diff % every ? -1 : diff / every;
  return diff % (7 * every) === 0 ? diff / (7 * every) : -1;
}

/**
 * Which showing a day `diff` days after the first is, for a rule on certain weekdays every `every` weeks (weeks
 * starting on `weekStart`, as the file says); -1 when it does not show then. The first day counts as a showing even
 * if it is not one of the weekdays, as the standard says.
 */
function weekdayIndex(diff: number, firstDay: number, shape: NonNullable<EventKeep['shape']>): number {
  const place = (weekday: number) => (weekday - shape.weekStart + 7) % 7;
  const places = shape.days.map(place).sort((a, b) => a - b);
  const startPlace = place(firstDay);
  const at = startPlace + diff;
  const week = Math.floor(at / 7);
  const here = at % 7;
  if (week % shape.every || !places.includes(here)) return -1;
  const firstWeek = places.filter(p => p >= startPlace).length + (places.includes(startPlace) ? 0 : 1);
  if (week === 0) return places.filter(p => p < here).length - places.filter(p => p < startPlace).length + (places.includes(startPlace) ? 0 : 1);
  return firstWeek + (week / shape.every - 1) * places.length + places.filter(p => p < here).length;
}

/** Does the event fall on this day (YYYY-MM-DD), counting its repeats and where they end ("for 3 days", "until")? */
export function occursOn(e: CalEvent, day: string): boolean {
  // A rule this calendar cannot show still has its first day, which may be skipped like any other.
  if ((e.repeat !== 'none' || e.keep?.rule.length) && e.keep?.skip?.includes(day)) return false;
  if (day === e.date) return true;
  if (e.repeat === 'none' || day < e.date) return false;
  if (e.until && day > e.until) return false;
  const n = showingIndex(e, day);
  return n >= 0 && (!e.count || n < e.count);
}

/** The first day on or after `from` the event shows on, looking at most `within` days ahead; null when none. */
export function nextShowing(e: CalEvent, from: string, within = 400): string | null {
  if (e.date >= from) return e.date;
  return e.repeat === 'none' ? null : nextAfter(e, from, within);
}

function nextAfter(e: CalEvent, from: string, within: number): string | null {
  for (let i = 0, day = from; i < within; i++, day = addDays(day, 1)) {
    if (e.until && day > e.until) return null;
    if (occursOn(e, day)) return day;
  }
  return null;
}

/** Does the event still repeat after `day` (one more showing within a year)? */
export const repeatsAfter = (e: CalEvent, day: string): boolean => e.repeat !== 'none' && nextShowing(e, addDays(day, 1), 370) !== null;

/** The event with its repeats ended after `today` (its showings up to today stay), or unchanged when none are left. */
export function stopRepeating(e: CalEvent, today: string): CalEvent {
  if (!repeatsAfter(e, today)) return e;
  return { ...e, count: 0, until: today > e.date ? today : e.date };
}

const EVERY: Record<Exclude<Repeat, 'none'>, [string, string, string]> = {
  daily: ['Every day', 'day', 'days'],
  weekly: ['Every week', 'week', 'weeks'],
  monthly: ['Every month', 'month', 'months'],
  yearly: ['Every year', 'year', 'years'],
};

/** "Every day", "Every day, for 3 days", "Every week, until Sat 17 Oct 2026"; '' for none. */
export function repeatLabel(e: Pick<CalEvent, 'repeat' | 'count' | 'until'>): string {
  if (e.repeat === 'none') return '';
  const [every, one, many] = EVERY[e.repeat];
  if (e.count) return `${every}, for ${e.count} ${e.count === 1 ? one : many}`;
  if (e.until && isDate(e.until)) return `${every}, until ${dayLabel(e.until, true)}`;
  return every;
}

/** "Sat 17 Oct", or with the year "Sat 17 Oct 2026", in the person's language. */
export function dayLabel(day: string, year = false): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}) });
}

/** The reminder choices offered wherever an event is made (minutes before the start; -1 none). */
export const REMIND_CHOICES: Array<[number, string]> = [[-1, 'No reminder'], [0, 'At the start'], [5, '5 minutes before'], [15, '15 minutes before'], [30, '30 minutes before'], [60, '1 hour before'], [1440, '1 day before']];

/** The events on a day, all-day first, then by start time. */
export function eventsOn(events: CalEvent[], day: string): CalEvent[] {
  return events.filter(e => occursOn(e, day)).sort((a, b) => (a.start || '').localeCompare(b.start || '') || a.title.localeCompare(b.title));
}

/** How far back to look for a repeat's showing that runs on into a day: a year, whatever a file says. */
const MAX_SPAN_DAYS = 366;

/** Is the event on this day: a showing starts then, or one that began earlier runs into it (past midnight, or over several days)? */
function runsOn(e: CalEvent, day: string): boolean {
  if (occursOn(e, day)) return true;
  if (!e.endDate || day <= e.date) return false;
  // Ending on the stroke of midnight is not a showing on that day.
  const last = e.start && e.end === '00:00' ? addDays(e.endDate, -1) : e.endDate;
  if (e.repeat === 'none') return day <= last && occursOn(e, e.date);
  const [y, m, d] = e.date.split('-').map(Number);
  const [Y, M, D] = last.split('-').map(Number);
  const span = Math.min(MAX_SPAN_DAYS, Math.round((Date.UTC(Y, M - 1, D) - Date.UTC(y, m - 1, d)) / 86400000));
  for (let back = 1; back <= span; back++) if (occursOn(e, addDays(day, -back))) return true;
  return false;
}

/** The events to show on a day of the month grid and its list: with those that began earlier and run into it. (eventsOn
 *  gives only what starts that day: reminders and the Panel count from the start.) */
export function eventsShownOn(events: CalEvent[], day: string): CalEvent[] {
  return events.filter(e => runsOn(e, day)).sort((a, b) => (a.start || '').localeCompare(b.start || '') || a.title.localeCompare(b.title));
}

/** When the reminder for this event's showing on `day` is due, in ms since 1970 (local time); null if none. Counted back
 *  on the clock, so "1 day before" is the same time the day before even across a clock change; all-day events from 09:00. */
export function reminderAt(e: CalEvent, day: string): number | null {
  if (e.remind < 0) return null;
  const [Y, M, D] = day.split('-').map(Number);
  const [h, min] = (e.start || '09:00').split(':').map(Number);
  return new Date(Y, M - 1, D, h, min - e.remind).getTime();
}

/** "09:30–11:00", "09:30", "All day"; with its last day when that is a later one ("22:00 to Wed 2 Dec 01:00"). */
export function timeLabel(e: CalEvent): string {
  if (e.endDate) return e.start ? `${e.start} to ${dayLabel(e.endDate)}${e.end ? ` ${e.end}` : ''}` : `All day, to ${dayLabel(e.endDate)}`;
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
