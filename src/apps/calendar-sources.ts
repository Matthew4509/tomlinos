// The Calendar's other calendars, beside the person's own: ones subscribed to by their link (Google, Outlook, Apple
// and others, read-only, fetched by the server and kept here between refreshes) and the public and school holidays
// for a chosen place. What is chosen is kept in /System/calendar.json; each subscription's last copy in
// /System/calendar-subscriptions/<id>.ics. No plain-text secret is shown anywhere but in its own settings: a Google
// "secret address" is the key to that calendar.
import type { CalEvent } from '../core/ical.ts';
import { publicHolidays, publicNotKnown, regionOf, schoolHolidays, hasSchoolData, type Holiday } from '../core/holidays.ts';

export const SETTINGS_PATH = '/System/calendar.json';
export const SUBSCRIPTIONS_FOLDER = '/System/calendar-subscriptions';

/** Colour choices, by name (the person picks a name; the value is only for drawing). */
export const COLOURS: Array<{ id: string; name: string; value: string }> = [
  { id: 'blue', name: 'Blue', value: '#2f6fd0' },
  { id: 'green', name: 'Green', value: '#2e8b3e' },
  { id: 'red', name: 'Red', value: '#c8372d' },
  { id: 'orange', name: 'Orange', value: '#d9731a' },
  { id: 'purple', name: 'Purple', value: '#7b46b8' },
  { id: 'teal', name: 'Teal', value: '#16857f' },
  { id: 'pink', name: 'Pink', value: '#c43d82' },
  { id: 'brown', name: 'Brown', value: '#8a5a2b' },
  { id: 'grey', name: 'Grey', value: '#6b7280' },
];
export const colourValue = (id: string): string => (COLOURS.find(c => c.id === id) ?? COLOURS[0]).value;
const isColour = (id: unknown): id is string => typeof id === 'string' && COLOURS.some(c => c.id === id);

/** How often a subscription is fetched again, in hours. */
export const REFRESH_CHOICES: Array<[number, string]> = [[1, 'Every hour'], [6, 'Every 6 hours'], [12, 'Every 12 hours'], [24, 'Once a day'], [168, 'Once a week']];

export interface Subscription {
  id: string;
  name: string;
  url: string;
  colour: string;
  shown: boolean;
  /** Hours between refreshes. */
  every: number;
  /** When it was last fetched well (ms since 1970), 0 for never. */
  fetched: number;
  /** Why the last try failed, '' when it did not. */
  problem: string;
}

export interface CalendarSettings {
  own: { colour: string; shown: boolean };
  subscriptions: Subscription[];
  holidays: { region: string; publicOn: boolean; schoolOn: boolean; publicColour: string; schoolColour: string; publicShown: boolean; schoolShown: boolean };
}

export const defaultSettings = (): CalendarSettings => ({
  own: { colour: 'blue', shown: true },
  subscriptions: [],
  holidays: { region: '', publicOn: false, schoolOn: false, publicColour: 'red', schoolColour: 'green', publicShown: true, schoolShown: true },
});

const ID = /^[a-z0-9-]{1,40}$/;
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Settings from the file's text, every value checked: anything broken or missing gets its usual value. */
export function readSettings(raw: string | null): CalendarSettings {
  const out = defaultSettings();
  let data: any = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    return out;
  }
  if (!data || typeof data !== 'object') return out;
  if (data.own && typeof data.own === 'object') {
    if (isColour(data.own.colour)) out.own.colour = data.own.colour;
    if (typeof data.own.shown === 'boolean') out.own.shown = data.own.shown;
  }
  if (Array.isArray(data.subscriptions)) {
    const seen = new Set<string>();
    for (const s of data.subscriptions.slice(0, 50)) {
      if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !ID.test(s.id) || seen.has(s.id)) continue;
      const url = normaliseLink(text(s.url, 2000));
      if (typeof url !== 'string') continue;
      seen.add(s.id);
      out.subscriptions.push({
        id: s.id,
        name: text(s.name, 100).trim() || 'Calendar',
        url,
        colour: isColour(s.colour) ? s.colour : 'purple',
        shown: s.shown !== false,
        every: REFRESH_CHOICES.some(([h]) => h === s.every) ? s.every : 6,
        fetched: Number.isFinite(s.fetched) && s.fetched > 0 ? s.fetched : 0,
        problem: text(s.problem, 500),
      });
    }
  }
  const hol = data.holidays;
  if (hol && typeof hol === 'object') {
    if (typeof hol.region === 'string' && regionOf(hol.region)) out.holidays.region = hol.region;
    for (const k of ['publicOn', 'schoolOn', 'publicShown', 'schoolShown'] as const) if (typeof hol[k] === 'boolean') out.holidays[k] = hol[k];
    if (isColour(hol.publicColour)) out.holidays.publicColour = hol.publicColour;
    if (isColour(hol.schoolColour)) out.holidays.schoolColour = hol.schoolColour;
  }
  return out;
}

export const writeSettings = (s: CalendarSettings): string => JSON.stringify(s, null, 1);

/**
 * A pasted calendar link made ready to fetch, or the reason it cannot be used. webcal:// (Apple's and Outlook's
 * links) is https. The server checks it again, more strictly (https only, public addresses only).
 */
export function normaliseLink(input: string): string | { problem: string } {
  let url = input.trim();
  if (!url) return { problem: 'Paste the calendar’s link first.' };
  if (/^webcals?:\/\//i.test(url)) url = `https://${url.slice(url.indexOf('://') + 3)}`;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { problem: 'That is not a web address. Copy the whole link, starting with https:// or webcal://.' };
  }
  // Plain http is left to the server, which refuses it unless its owner listed that calendar server.
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return { problem: 'Only web links (starting with https:// or webcal://) can be added.' };
  if (parsed.username || parsed.password) return { problem: 'Links with a name and password in them cannot be added.' };
  if (url.length > 2000) return { problem: 'That link is too long to be a calendar address.' };
  return parsed.href;
}

/** Is the subscription due to be fetched again (never fetched, or its time has come)? */
export const isDue = (s: Subscription, now: number): boolean => !s.fetched || now - s.fetched >= s.every * 3600_000;

/** A short, safe way to show a link without its secret part: the site only ("calendar.google.com"). */
export function linkSite(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** "Updated 5 minutes ago", "Not fetched yet". */
export function fetchedLabel(s: Subscription, now: number): string {
  if (!s.fetched) return 'Not fetched yet';
  const minutes = Math.max(0, Math.round((now - s.fetched) / 60000));
  if (minutes < 1) return 'Updated just now';
  if (minutes < 60) return `Updated ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `Updated ${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `Updated ${Math.round(hours / 24)} days ago`;
}

/** A holiday as a read-only, all-day calendar event. */
function holidayEvent(h: Holiday, prefix: string): CalEvent {
  const e: CalEvent = { uid: `${prefix}:${h.date}:${h.name}`, title: h.name, date: h.date, start: '', end: '', notes: '', repeat: 'none', remind: -1 };
  if (h.end && h.end > h.date) e.endDate = h.end;
  return e;
}

/** The public holidays of a region for these years, as events. */
export function publicEvents(region: string, years: number[]): CalEvent[] {
  return years.flatMap(y => publicHolidays(region, y).map(h => holidayEvent(h, `public:${region}`)));
}

/** The school holidays of a region for these years, as events, and the years among them that are not known yet. */
export function schoolEvents(region: string, years: number[]): { events: CalEvent[]; unknown: number[] } {
  const events: CalEvent[] = [];
  const unknown: number[] = [];
  for (const y of years) {
    const s = schoolHolidays(region, y);
    if (!s.known) unknown.push(y);
    events.push(...s.days.map(h => holidayEvent(h, `school:${region}`)));
  }
  return { events, unknown };
}

/** What the person is told about a year shown: school dates not known yet, a proclaimed day not announced yet. */
export function holidayNotes(settings: CalendarSettings['holidays'], year: number): string[] {
  const r = regionOf(settings.region);
  if (!r) return [];
  const out: string[] = [];
  if (settings.publicOn) {
    const missing = publicNotKnown(r.code, year);
    if (missing.length) out.push(`${r.name}: ${missing.join(' and ')} for ${year} is not announced yet, so it is not shown.`);
  }
  if (settings.schoolOn) {
    if (!hasSchoolData(r.code)) out.push(`School holidays in the UK are set by each council or school, so they are not included. Ask your school or council for its calendar link and add it with Calendars > Add a calendar by its link.`);
    else if (!schoolHolidays(r.code, year).known) out.push(`School holidays for ${year} in ${r.name} are not known yet, so none are shown for that year.`);
  }
  return out;
}

/** The years a month view needs (the month's own, and the one either side for weeks that run over). */
export function yearsAround(year: number): number[] {
  return [year - 1, year, year + 1];
}

