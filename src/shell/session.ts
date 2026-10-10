// What the desktop remembers between visits: the wallpaper, where desktop icons sit, how each folder is shown, and
// where each app's window was last. One small JSON file in the hidden System folder. Every field is checked on the
// way in, so a damaged or hand-edited file falls back to defaults field by field instead of breaking the desktop.
// Nothing here lists files the person has opened: window prefs are per app, and a folder's view prefs are capped.
import { FsError, type FileSystem } from '../fs/fs.ts';

export type Wallpaper = { kind: 'colour'; value: string } | { kind: 'picture'; path: string };
/** The colour scheme: Xfce (Greybird, as Debian's Xfce ships it; the default), the blue original, olive green, silver or dark. */
export type Theme = 'blue' | 'olive' | 'silver' | 'dark' | 'xfce' | 'glass' | 'flat';
export const THEMES: Array<{ id: Theme; name: string }> = [
  { id: 'xfce', name: 'Standard (Xfce)' },
  { id: 'glass', name: 'Glass' },
  { id: 'flat', name: 'Flat' },
  { id: 'blue', name: 'Classic blue' },
  { id: 'olive', name: 'Olive green' },
  { id: 'silver', name: 'Silver' },
  { id: 'dark', name: 'Dark' },
];
export type SortKey = 'name' | 'size' | 'type' | 'date';
export interface ViewPrefs {
  view: 'icons' | 'list';
  sort: SortKey;
  desc: boolean;
}
export interface WindowPrefs {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** How the Recycle Bin looks after itself. Set by the person in Settings. */
export interface BinSettings {
  /** 'days': delete items after `days` days; 'daily': delete everything deleted before today; 'never'. */
  clear: 'days' | 'daily' | 'never';
  days: number;
  /** Deleting one item bigger than this asks first and then deletes it for good instead of binning it. */
  limitMb: number;
}
export const BIN_LIMIT_MIN_MB = 50;
export const BIN_LIMIT_MAX_MB = 4096;
export const BIN_DAYS_MAX = 365;
export const defaultBin = (): BinSettings => ({ clear: 'days', days: 30, limitMb: 100 });

/** The screensaver and lock, set by the person in My account. Kept with their files, so it follows them to any device. */
export interface LockSettings {
  /** Minutes without a touch, click or key before the screensaver; 0 = never by itself. */
  idle: number;
  /** The reader is a book open at a page, with "Log in for more" as the way back (auth/lock.ts). */
  saver: 'sheet' | 'reader' | 'clock' | 'blank';
  /**
   * The person picked the screensaver themselves. Settings saved before the Reader became the default carry the old
   * default (the spreadsheet) without this mark, and are read as the Reader.
   */
  chosen?: boolean;
  /** Lock when the screensaver shows (needs sign-in on the server). */
  lock: boolean;
  /** Escape twice, quickly, shows the spreadsheet screensaver and locks at once. */
  panic: boolean;
  /** The lock and sign-out keys written small on the desktop background (off: it tells passers-by what this is). */
  hint?: boolean;
  /**
   * How the lock screen looks to someone passing: default (TOMLIN OS, the person's name), plain (no name at all: "Session
   * timed out"), or custom (the person's own words, below).
   */
  look: 'default' | 'plain' | 'custom';
  /** The custom look's words: heading, the user name and password labels, the button. */
  words: LockWords;
  /** The disguise spreadsheet: what kind of work it shows, and its title ('' = the kind's usual title). */
  sheet: { kind: SheetKind; title: string };
}
export interface LockWords {
  title: string;
  user: string;
  pass: string;
  button: string;
}
export type SheetKind = 'budget' | 'stock' | 'timesheet' | 'sales';
export const SHEET_KINDS: Array<{ id: SheetKind; name: string; title: string }> = [
  { id: 'budget', name: 'Quarterly budget', title: 'Q3 Budget' },
  { id: 'stock', name: 'Stock list', title: 'Stock list' },
  { id: 'timesheet', name: 'Timesheet', title: 'Timesheet' },
  { id: 'sales', name: 'Sales report', title: 'Sales report' },
];
export const defaultWords = (): LockWords => ({ title: 'Sign in', user: 'Username', pass: 'Password', button: 'Continue' });
/** The longest custom word or title: a lock screen heading, not a paragraph. */
export const LOCK_WORDS_MAX = 40;
export const IDLE_CHOICES = [1, 2, 5, 10, 15, 30, 60, 0];
// The panic key is off until the person turns it on: two quick Escapes are easy to press by accident, and a
// spreadsheet appearing out of nowhere looked like a fault.
export const defaultLock = (): LockSettings => ({ idle: 10, saver: 'reader', lock: true, panic: false, look: 'default', words: defaultWords(), sheet: { kind: 'budget', title: '' } });

export interface SessionData {
  v: 1;
  bin: BinSettings;
  lock: LockSettings;
  wallpaper: Wallpaper;
  theme: Theme;
  /** Calendar reminders due at or before this moment (ms) have been shown, so a reload or another tab does not repeat them. */
  remindedUntil: number;
  /** Desktop icon cells, keyed by the item's id (not its path, so a rename keeps its place). */
  icons: Record<string, [number, number]>;
  views: Record<string, ViewPrefs>;
  windows: Record<string, WindowPrefs>;
  /** Apps pinned to the Start menu, in order; null = the starting set (startgroups.ts). */
  pinned: string[] | null;
  /** Chat › Agents conversations not changed for this many days are deleted for good (Settings); 0 = kept. */
  aiHistoryDays: number;
}

/** The choices for clearing AI chats (Settings): never, or after 3, 7 or 30 days. */
export const AI_HISTORY_CHOICES = [0, 3, 7, 30];

export const SESSION_PATH = '/System/session.json';
export const DEFAULT_COLOUR = '#3a6ea5';
export const MAX_VIEWS = 200;
export const MAX_ICONS = 2000;

export const WALLPAPER_COLOURS: Array<{ name: string; value: string }> = [
  { name: 'Blue', value: DEFAULT_COLOUR },
  { name: 'Teal', value: '#2f7f86' },
  { name: 'Green', value: '#4b7f4f' },
  { name: 'Slate', value: '#4d5b6b' },
  { name: 'Plum', value: '#75507b' },
  { name: 'Charcoal', value: '#2b2f36' },
];

const SORT_KEYS: SortKey[] = ['name', 'size', 'type', 'date'];
const COLOUR = /^#[0-9a-f]{6}$/i;

export function defaultSession(): SessionData {
  return { v: 1, bin: defaultBin(), lock: defaultLock(), wallpaper: { kind: 'colour', value: DEFAULT_COLOUR }, theme: 'xfce', remindedUntil: 0, icons: {}, views: {}, windows: {}, pinned: null, aiHistoryDays: 0 };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isInt = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

export function parseSession(raw: unknown): SessionData {
  const session = defaultSession();
  if (!isObject(raw)) return session;

  if (isObject(raw.bin)) {
    const b = raw.bin;
    if (b.clear === 'days' || b.clear === 'daily' || b.clear === 'never') session.bin.clear = b.clear;
    if (isInt(b.days, 1, BIN_DAYS_MAX)) session.bin.days = b.days;
    if (isInt(b.limitMb, BIN_LIMIT_MIN_MB, BIN_LIMIT_MAX_MB)) session.bin.limitMb = b.limitMb;
  }

  if (isObject(raw.lock)) {
    const l = raw.lock;
    if (typeof l.idle === 'number' && IDLE_CHOICES.includes(l.idle)) session.lock.idle = l.idle;
    if (l.chosen === true) session.lock.chosen = true;
    if (l.saver === 'sheet' || l.saver === 'reader' || l.saver === 'clock' || l.saver === 'blank') session.lock.saver = l.saver === 'sheet' && l.chosen !== true ? 'reader' : l.saver;
    if (typeof l.lock === 'boolean') session.lock.lock = l.lock;
    if (typeof l.panic === 'boolean') session.lock.panic = l.panic;
    if (l.hint === true) session.lock.hint = true;
    if (l.look === 'default' || l.look === 'plain' || l.look === 'custom') session.lock.look = l.look;
    const word = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, LOCK_WORDS_MAX) : '');
    if (isObject(l.words)) {
      for (const k of ['title', 'user', 'pass', 'button'] as const) session.lock.words[k] = word(l.words[k]) || session.lock.words[k];
    }
    if (isObject(l.sheet)) {
      if (SHEET_KINDS.some(k => k.id === (l.sheet as { kind?: unknown }).kind)) session.lock.sheet.kind = (l.sheet as { kind: SheetKind }).kind;
      session.lock.sheet.title = word((l.sheet as { title?: unknown }).title);
    }
  }

  const wp = raw.wallpaper;
  if (isObject(wp)) {
    if (wp.kind === 'colour' && typeof wp.value === 'string' && COLOUR.test(wp.value)) {
      session.wallpaper = { kind: 'colour', value: wp.value.toLowerCase() };
    } else if (wp.kind === 'picture' && typeof wp.path === 'string' && wp.path.startsWith('/') && wp.path.length < 1024) {
      session.wallpaper = { kind: 'picture', path: wp.path };
    }
  }

  if (THEMES.some(t => t.id === raw.theme)) session.theme = raw.theme as Theme;
  if (typeof raw.remindedUntil === 'number' && Number.isFinite(raw.remindedUntil) && raw.remindedUntil >= 0) session.remindedUntil = raw.remindedUntil;

  if (isObject(raw.icons)) {
    for (const [id, cell] of Object.entries(raw.icons).slice(0, MAX_ICONS)) {
      if (Array.isArray(cell) && cell.length === 2 && isInt(cell[0], 0, 500) && isInt(cell[1], 0, 500)) {
        session.icons[id] = [cell[0], cell[1]];
      }
    }
  }

  if (isObject(raw.views)) {
    for (const [path, prefs] of Object.entries(raw.views).slice(-MAX_VIEWS)) {
      if (!isObject(prefs)) continue;
      session.views[path] = {
        view: prefs.view === 'list' ? 'list' : 'icons',
        sort: SORT_KEYS.includes(prefs.sort as SortKey) ? (prefs.sort as SortKey) : 'name',
        desc: prefs.desc === true,
      };
    }
  }

  if (isObject(raw.windows)) {
    for (const [app, box] of Object.entries(raw.windows).slice(0, 50)) {
      if (isObject(box) && isInt(box.x, -5000, 20000) && isInt(box.y, -5000, 20000) && isInt(box.w, 100, 20000) && isInt(box.h, 60, 20000)) {
        session.windows[app] = { x: box.x, y: box.y, w: box.w, h: box.h };
      }
    }
  }

  if (Array.isArray(raw.pinned)) {
    session.pinned = [...new Set(raw.pinned.filter((id): id is string => typeof id === 'string' && /^[a-z]{1,32}$/.test(id)))].slice(0, 40);
  }
  if (typeof raw.aiHistoryDays === 'number' && AI_HISTORY_CHOICES.includes(raw.aiHistoryDays)) session.aiHistoryDays = raw.aiHistoryDays;
  return session;
}

export class Session {
  data: SessionData = defaultSession();
  private fs: FileSystem;
  private timer = 0;
  private waiting = false;
  private loaded = false;
  /** Why the settings kept could not be read at the start (not "none yet"): nothing is then saved over them. */
  private unread: unknown = null;
  private saving: Promise<void> = Promise.resolve();
  /** Called with the reason when saving fails, so the person is told once instead of every attempt. */
  onSaveError: (error: unknown) => void = () => {};

  constructor(fs: FileSystem) {
    this.fs = fs;
  }

  async load(): Promise<void> {
    this.data = defaultSession();
    this.unread = null;
    try {
      // A damaged file starts from the defaults too, and the next save replaces it.
      this.data = parseSession(JSON.parse(await this.fs.readText(SESSION_PATH)));
    } catch (error) {
      // None yet: the defaults, kept on the first change. One that is there but could not be read (the server out of
      // reach, say): the defaults for this page only, never saved over the person's real settings.
      if (!(error instanceof FsError) && !(error instanceof SyntaxError)) this.unread = error;
    }
    this.loaded = true;
  }

  /** Marks the session changed; it is written a moment later, once, however many changes come in between. */
  touch(): void {
    if (!this.loaded) return;
    clearTimeout(this.timer);
    this.waiting = true;
    this.timer = window.setTimeout(() => void this.flush(), 800);
  }

  /** Writes a change that is still waiting for its moment (before the screen locks, when the server refuses writes). */
  flushWaiting(): Promise<void> {
    return this.waiting ? this.flush() : this.saving;
  }

  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.waiting = false;
    if (!this.loaded) return this.saving;
    if (this.unread) {
      const reason = this.unread instanceof Error ? ` (${this.unread.message})` : '';
      this.unread = null;
      this.loaded = false;
      this.onSaveError(new Error(`Your desktop settings could not be read when this page opened${reason}, so changes made here are not kept, rather than replace them. Reload the page to read them again.`));
      return this.saving;
    }
    const text = JSON.stringify(this.data);
    this.saving = this.saving
      .then(async () => {
        await this.fs.ensureFolder('/System', { hidden: true });
        await this.fs.writeText(SESSION_PATH, text, { hidden: true });
      })
      .catch(error => this.onSaveError(error));
    return this.saving;
  }

  setView(path: string, prefs: ViewPrefs): void {
    delete this.data.views[path];
    this.data.views[path] = prefs;
    const keys = Object.keys(this.data.views);
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_VIEWS))) delete this.data.views[old];
    this.touch();
  }

  viewFor(path: string): ViewPrefs {
    return this.data.views[path] ?? { view: 'icons', sort: 'name', desc: false };
  }
}
