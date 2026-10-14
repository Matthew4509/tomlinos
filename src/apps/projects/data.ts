// My Projects' records and settings, and what it puts in the calendar. Kept apart from the window so the Panel's Focus
// tile and the tests can read them without loading the app.
//
// Projects live in Documents/Projects.json (a plain list a person can read), changed one record at a time through
// recordFile like the calendar. Nothing is ever deleted from it: a finished project moves to the Finished list. What
// is booked for a project is an ordinary calendar event carrying the project's id (X-TOMLINOS-PROJECT), so it shows in
// Calendar, in the Panel and in the reminders with nothing else to change; the project's past events, with their
// notes, are its log.
import { FsError, type FileSystem } from '../../fs/fs.ts';
import { addDays, isDate, isTime, nextShowing, type CalEvent } from '../../core/ical.ts';

export const PROJECTS_PATH = '/Documents/Projects.json';
export const SETTINGS_PATH = '/System/projects.json';

export interface Project {
  uid: string;
  name: string;
  /** A web address, or ''. */
  site: string;
  notes: string;
  /** Starred: listed first, and on the Panel's Focus tile. */
  focus: boolean;
  /** On the Finished list (brought back any time). */
  finished: boolean;
  /** When it was added (ms since 1970). */
  created: number;
}

export interface ProjectSettings {
  /** HH:MM a new entry starts at. */
  time: string;
  /** How long a new entry lasts, in hours; 0: no end time. */
  hours: number;
  /** The day a new entry is on. */
  day: 'today' | 'tomorrow';
  /** Minutes before the start for the reminder; -1 none. */
  remind: number;
  /** The one-click buttons on every project, in order (at least one). */
  actions: string[];
}

/** The button whose entry is called just by the project's name. */
export const PLAIN_ACTION = 'Add to calendar';
export const DEFAULT_ACTIONS = [PLAIN_ACTION, 'Add new feature', 'Audit and review'];
export const DEFAULT_SETTINGS: ProjectSettings = { time: '09:00', hours: 0, day: 'tomorrow', remind: 0, actions: DEFAULT_ACTIONS };
export const MAX_ACTIONS = 12;
export const MAX_ACTION_LENGTH = 40;
const REMINDS = new Set([-1, 0, 5, 15, 30, 60, 1440]);
const UID = /^[\w-]{1,64}$/;

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');

/** One record as it may be kept: anything else in it is dropped, anything missing filled in. null for no name or id. */
export function cleanProject(raw: unknown): Project | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const uid = typeof r.uid === 'string' && UID.test(r.uid) ? r.uid : '';
  const name = text(r.name, 200).trim();
  if (!uid || !name) return null;
  const created = typeof r.created === 'number' && Number.isFinite(r.created) ? r.created : 0;
  return { uid, name, site: text(r.site, 500).trim(), notes: text(r.notes, 20000), focus: r.focus === true, finished: r.finished === true, created };
}

/** The file's projects. A file that is not a list (damaged, or something else) throws, so it is never saved over. */
export function parseProjects(textIn: string): Project[] {
  if (!textIn.trim()) return [];
  const data: unknown = JSON.parse(textIn);
  if (!Array.isArray(data)) throw new FsError('Projects.json is not a list of projects. It was left as it is; open it in Notepad to look.');
  const seen = new Set<string>();
  const out: Project[] = [];
  for (const raw of data) {
    const p = cleanProject(raw);
    if (p && !seen.has(p.uid)) {
      seen.add(p.uid);
      out.push(p);
    }
  }
  return out;
}

export const writeProjects = (list: Project[]): string => JSON.stringify(list.map(p => cleanProject(p)).filter(Boolean), null, 1) + '\n';

export function newProject(name: string, site: string, notes: string, now = Date.now()): Project {
  return { uid: crypto.randomUUID(), name: name.trim().slice(0, 200), site: site.trim().slice(0, 500), notes: notes.slice(0, 20000), focus: false, finished: false, created: now };
}

/** Starred first; otherwise as added. Finished ones are a separate list. */
export function sortProjects(list: Project[]): Project[] {
  return [...list].sort((a, b) => Number(b.focus) - Number(a.focus));
}

/** A site as a link: "example.com" becomes https://example.com; anything that is not a web address, null. */
export function siteHref(site: string): string | null {
  const s = site.trim();
  if (!s) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    const web = u.protocol === 'https:' || u.protocol === 'http:';
    return web && (u.hostname.includes('.') || u.hostname === 'localhost') ? u.href : null;
  } catch {
    return null;
  }
}

/** The action list as it may be kept: trimmed, no blanks, each once (whatever the capitals), at least the defaults. */
export function cleanActions(raw: unknown): string[] {
  const out: string[] = [];
  if (Array.isArray(raw)) {
    for (const v of raw) {
      const s = typeof v === 'string' ? v.trim().slice(0, MAX_ACTION_LENGTH) : '';
      if (s && !out.some(x => x.toLowerCase() === s.toLowerCase())) out.push(s);
      if (out.length >= MAX_ACTIONS) break;
    }
  }
  return out.length ? out : [...DEFAULT_ACTIONS];
}

export function cleanSettings(raw: unknown): ProjectSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const hours = typeof r.hours === 'number' && Number.isFinite(r.hours) && r.hours > 0 && r.hours <= 24 ? Math.round(r.hours * 4) / 4 : 0;
  return {
    time: typeof r.time === 'string' && isTime(r.time) ? r.time : DEFAULT_SETTINGS.time,
    hours,
    day: r.day === 'today' ? 'today' : 'tomorrow',
    remind: typeof r.remind === 'number' && REMINDS.has(r.remind) ? r.remind : DEFAULT_SETTINGS.remind,
    actions: cleanActions(r.actions),
  };
}

/** The person's settings; none kept, or damaged, reads as the defaults. `strict` (before a change): a read that failed
 *  for another reason (the server out of reach) throws, so the change is not saved over settings that are kept. */
export async function readSettings(fs: FileSystem, strict = false): Promise<ProjectSettings> {
  let raw: string;
  try {
    raw = await fs.readText(SETTINGS_PATH);
  } catch (error) {
    if (strict && !(error instanceof FsError)) throw error;
    return cleanSettings({});
  }
  try {
    return cleanSettings(JSON.parse(raw));
  } catch {
    return cleanSettings({});
  }
}

export async function writeSettings(fs: FileSystem, settings: ProjectSettings): Promise<void> {
  await fs.ensureFolder('/System', { hidden: true });
  await fs.writeText(SETTINGS_PATH, JSON.stringify(cleanSettings(settings), null, 1), { hidden: true });
}

/** Moves the action at `from` by `by` places (-1 up, +1 down); unchanged at an end. */
export function moveAction(list: string[], from: number, by: number): string[] {
  const to = from + by;
  if (from < 0 || from >= list.length || to < 0 || to >= list.length) return list;
  const next = [...list];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/** Removes the action at `at`, unless it is the last one left (null then: at least one button stays). */
export function removeAction(list: string[], at: number): string[] | null {
  if (list.length <= 1) return null;
  return list.filter((_, i) => i !== at);
}

/** Why an action name cannot be used, or null. */
export function actionProblem(list: string[], name: string, at = -1): string | null {
  const s = name.trim();
  if (!s) return 'Give the button a name.';
  if (s.length > MAX_ACTION_LENGTH) return `Keep the name to ${MAX_ACTION_LENGTH} letters or fewer.`;
  if (list.some((x, i) => i !== at && x.toLowerCase() === s.toLowerCase())) return `There is a “${s}” button already.`;
  return null;
}

/** What a one-click entry is called: "Add new feature: Word upgrade", or just the name for Add to calendar. */
export function entryTitle(action: string, project: Pick<Project, 'name'>): string {
  return action.trim().toLowerCase() === PLAIN_ACTION.toLowerCase() ? project.name : `${action.trim()}: ${project.name}`;
}

/** The entry's title without the project's name on it, for a line that already says which project ('' for a plain
 *  Add to calendar entry, which is just the name). */
export function shortTitle(e: Pick<CalEvent, 'title'>, p: Pick<Project, 'name'>): string {
  if (e.title === p.name) return '';
  const tail = `: ${p.name}`;
  return e.title.endsWith(tail) ? e.title.slice(0, -tail.length) : e.title;
}

/** The day a new entry starts on by default. */
export const defaultDay = (settings: ProjectSettings, today: string): string => (settings.day === 'today' ? today : addDays(today, 1));

/** HH:MM `hours` after `start`, or null when that would pass midnight. */
export function endAfter(start: string, hours: number): string | null {
  const [h, m] = start.split(':').map(Number);
  const total = h * 60 + m + Math.round(hours * 60);
  if (total >= 24 * 60) return null;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export interface EntryForm {
  title: string;
  day: string;
  allDay: boolean;
  start: string;
  /** '' or a number of hours as typed. */
  hours: string;
  daily: boolean;
  /** 0, or 2 and up: that many days in a row. */
  runDays: number;
  remind: number;
  notes: string;
  where?: string;
  project?: string;
}

export const MAX_RUN_DAYS = 366;

/** The calendar event a filled-in window makes, or the reason it cannot be saved (a sentence for the person). */
export function entryFrom(form: EntryForm, uid: string = crypto.randomUUID()): CalEvent | string {
  const title = form.title.trim();
  if (!title) return 'Say what it is (the “What” box is empty).';
  if (!isDate(form.day)) return 'Choose a day.';
  let start = '';
  let end = '';
  if (!form.allDay) {
    if (!isTime(form.start)) return 'Choose a start time, or tick All day.';
    start = form.start;
    const hoursText = form.hours.trim();
    if (hoursText) {
      const hours = Number(hoursText);
      if (!Number.isFinite(hours) || hours <= 0 || hours > 24) return 'Hours must be a number above 0, such as 1 or 2.5 (or leave it empty).';
      const e = endAfter(start, hours);
      if (!e) return `${hoursText} hours from ${start} runs past midnight. Choose fewer hours, an earlier time, or leave Hours empty.`;
      end = e;
    }
  }
  if (form.daily && form.runDays) return 'Choose Repeat daily or Run for days, not both.';
  if (form.runDays && (!Number.isInteger(form.runDays) || form.runDays < 2 || form.runDays > MAX_RUN_DAYS)) return `Run for: choose 2 to ${MAX_RUN_DAYS} days.`;
  const event: CalEvent = {
    uid,
    title: title.slice(0, 500),
    date: form.day,
    start,
    end,
    notes: form.notes.replace(/\s+$/, '').slice(0, 20000),
    repeat: form.daily || form.runDays ? 'daily' : 'none',
    remind: REMINDS.has(form.remind) ? form.remind : -1,
  };
  if (form.runDays) event.count = form.runDays;
  const where = form.where?.trim();
  if (where) event.where = where.slice(0, 500);
  if (form.project) event.project = form.project;
  return event;
}

/** A project's events: those still to come (with the day each next shows) and those already past, newest first. */
export function projectEntries(events: CalEvent[], projectUid: string, today: string): { coming: Array<{ event: CalEvent; next: string }>; past: CalEvent[] } {
  const mine = events.filter(e => e.project === projectUid);
  const coming = mine.flatMap(event => {
    const next = nextShowing(event, today);
    return next ? [{ event, next }] : [];
  }).sort((a, b) => a.next.localeCompare(b.next) || (a.event.start || '').localeCompare(b.event.start || ''));
  // Past: began before today (a repeat still running is in both lists: it began earlier and shows again).
  const past = mine.filter(e => e.date < today).sort((a, b) => b.date.localeCompare(a.date) || (b.start || '').localeCompare(a.start || ''));
  return { coming, past };
}

/** The next thing booked for a project, for its row: the soonest showing on or after today; null when none. */
export function nextFor(events: CalEvent[], projectUid: string, today: string): { event: CalEvent; next: string } | null {
  return projectEntries(events, projectUid, today).coming[0] ?? null;
}
