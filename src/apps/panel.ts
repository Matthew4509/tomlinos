// Panel: one window laid out like a control panel, holding several apps: an interface for multiple apps, loaded as
// one. A bar across the top (name, the open section, the clock top right), a rail of sections down the left with a
// few facts and the Terminal button at its foot, and the open app filling the rest. It keeps its own navy and grey
// whatever the desktop theme; on a phone the rail stacks on top.
//
// Each section runs the real app (Mail, Chat, Terminal...) inside the panel instead of in a window of its own: the app
// is given a handle whose root is the section's area. A section is opened the first time it is chosen and kept while
// the panel is open, so moving between sections loses nothing (a half-written message, a Terminal's history). Closing
// the panel closes them all, asking first if any has unsaved work.
import { h, on } from '../core/dom.ts';
import { readLocalJson } from '../core/local.ts';
import { addDays, CALENDAR_PATH, dateKey, eventsOn, parseIcs, timeLabel, type CalEvent } from '../core/ical.ts';
import type { Entry } from '../fs/fs.ts';
import { icon, type IconName } from '../shell/icons.ts';
import type { AppDef, AppHandle } from '../shell/types.ts';
import { APPS } from './catalog.ts';
import { ChatSession } from './chat/session.ts';
import { joinPath } from '../fs/names.ts';
import { dayName, listPads, padLabel, PAD_FOLDER, savePad } from './panel/scratchpad.ts';

interface Section {
  id: string;
  label: string;
  icon: IconName;
  /** The app it runs; none for the Overview, which is the panel's own. */
  app?: string;
  /** Handed to the app as it opens ("panel": Mail takes the ticket layout). */
  arg?: string;
  /** false: kept (other parts of the Panel open it) but not listed on the rail. Delete the flag to list it again. */
  rail?: false;
}

/** The rail, in order. The Overview first, then the apps (the day's work first, settings last). */
// Off the rail, as they would only repeat what is already on screen: Calendar opens from the Today tile, Terminal
// from the rail's foot, the chat lives on the Overview, and a scratch pad opens full in Notepad Pro. To bring one
// back, delete its `rail: false`.
export const SECTIONS: Section[] = [
  { id: 'overview', label: 'OVERVIEW', icon: 'panel' },
  { id: 'mail', label: 'MAIL', icon: 'mail', app: 'mail', arg: 'panel' },
  { id: 'chat', label: 'CHAT', icon: 'chat', app: 'chat', rail: false },
  // Chat › Agents, where an AI is connected: the built-in models on this device, or Claude with the person's key. Named
  // for what it is for, not after one model (the rail said QWEN 3.5 0.8B, which read as if that were the only choice).
  { id: 'assistant', label: 'CONNECT AI MODELS', icon: 'assistant', app: 'chat', arg: 'agents' },
  { id: 'files', label: 'FILES', icon: 'files', app: 'explorer' },
  { id: 'calendar', label: 'CALENDAR', icon: 'calendar', app: 'calendar', rail: false },
  { id: 'contacts', label: 'CONTACTS', icon: 'contacts', app: 'contacts' },
  { id: 'notes', label: 'NOTEPAD PRO', icon: 'code', app: 'notepadpro', rail: false },
  { id: 'terminal', label: 'TERMINAL', icon: 'terminal', app: 'terminal', rail: false },
  { id: 'settings', label: 'SETTINGS', icon: 'gear', app: 'settings' },
  { id: 'account', label: 'MY ACCOUNT', icon: 'user', app: 'account' },
];

/** How many days the Overview's "Today & upcoming" looks ahead (today included). */
const UPCOMING_DAYS = 14;
/** How far ahead a calendar event shows in the strip across the top ("starting soon"). */
const SOON_MIN = 15;
/** Folders the Overview's Recent files looks in (their top level only: quick, and where people keep things). */
const RECENT_FOLDERS = ['/Desktop', '/Documents', '/Pictures', '/Music', '/Videos'];

function clockParts(now: Date): [string, string] {
  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const off = -now.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const hours = Math.floor(Math.abs(off) / 60);
  const mins = Math.abs(off) % 60;
  return [time, `UTC${sign}${hours}${mins ? `:${String(mins).padStart(2, '0')}` : ''}`];
}

function since(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m} min`;
  const hrs = Math.floor(m / 60);
  return hrs < 24 ? `${hrs} h ${m % 60} min` : `${Math.floor(hrs / 24)} d ${hrs % 24} h`;
}

/** Minutes from now to an event's start today (negative once started), or null for all-day events. */
function minutesTo(e: CalEvent, now: Date): number | null {
  if (!e.start) return null;
  const [hh, mm] = e.start.split(':').map(Number);
  return hh * 60 + mm - (now.getHours() * 60 + now.getMinutes());
}

function endsIn(e: CalEvent, now: Date): number {
  if (!e.end) return 60 + (minutesTo(e, now) ?? 0);
  const [hh, mm] = e.end.split(':').map(Number);
  return hh * 60 + mm - (now.getHours() * 60 + now.getMinutes());
}

export const panelApp: AppDef = {
  ...APPS.panel,
  async launch(app) {
    const { shell, signal } = app;
    app.root.classList.add('panel-app');
    const opened = Date.now();

    // Open filling the screen, as a control panel does (the person can still restore it to a window).
    const win = shell.windows.list().find(w => w.id === app.id);
    if (win && win.state === 'normal') shell.windows.toggleMax(win);

    const [time, zone] = clockParts(new Date());
    const clockTime = h('span', {}, time);
    const clockZone = h('small', {}, zone);
    const brand = h('button', { type: 'button', class: 'panel-brand', title: 'Overview' }, icon('logo', 18), 'TOMLIN OS', h('small', {}, 'Panel'));
    const barTitle = h('span', { class: 'panel-bar-title' });
    // Lock and Sign out, at the top where they are quick to find.
    const lockBtn = h('button', { type: 'button', class: 'panel-quick', title: 'Lock the screen (Alt+L)', hidden: !shell.lock.canLock }, icon('lock', 14), 'Lock screen');
    const outBtn = h('button', { type: 'button', class: 'panel-quick', title: 'Sign out and show the book (Alt+Shift+L)', hidden: !shell.account }, 'Sign out');
    on(lockBtn, 'click', () => void shell.lock.show(true), signal);
    on(outBtn, 'click', () => void shell.account?.signOut(), signal);
    const bar = h('header', { class: 'panel-bar' }, brand, barTitle, lockBtn, outBtn, h('span', { class: 'panel-clock' }, clockTime, clockZone));

    const nav = h('nav', { class: 'panel-nav', role: 'tablist', 'aria-label': 'Panel sections', 'aria-orientation': 'vertical' });
    const navButtons = new Map<string, { button: HTMLButtonElement; count: HTMLElement }>();
    for (const s of SECTIONS) {
      if (s.rail === false) continue;
      const count = h('span', { class: 'panel-count', hidden: true });
      const button = h('button', { type: 'button', class: 'panel-nav-item', role: 'tab', 'aria-selected': 'false' }, icon(s.icon, 16), h('span', {}, s.label), count);
      on(button, 'click', () => void show(s.id), signal);
      navButtons.set(s.id, { button, count });
      nav.append(button);
    }

    const user = shell.account?.user() ?? null;
    const upValue = h('span', {}, since(0));
    const terminalBtn = h('button', { type: 'button', class: 'panel-terminal' }, icon('terminal', 16), 'Open Terminal');
    on(terminalBtn, 'click', () => void show('terminal'), signal);
    const specs = h('dl', { class: 'panel-specs' },
      h('dt', {}, 'User'), h('dd', {}, user ? user.display : 'This browser'),
      h('dt', {}, 'Files'), h('dd', {}, !user ? 'Kept in this browser' : user.vault === 'on' ? 'Encrypted' : 'Not encrypted'),
      h('dt', {}, 'Store'), h('dd', {}, shell.storeLabel),
      h('dt', {}, 'Open for'), h('dd', {}, upValue));
    const version = h('p', { class: 'panel-version' }, 'TOMLIN OS');
    const side = h('aside', { class: 'panel-side', 'aria-label': 'Panel' }, nav, h('div', { class: 'panel-foot' }, specs, terminalBtn, version));

    const critical = h('div', { class: 'panel-critical', role: 'alert', hidden: true });
    const overview = h('div', { class: 'panel-overview' });
    const main = h('div', { class: 'panel-main' }, critical, overview);
    app.root.append(h('div', { class: 'panel' }, bar, h('div', { class: 'panel-body' }, side, main)));

    // ---- The sections that run an app ----------------------------------------------------------------------------
    interface Hosted {
      area: HTMLElement;
      abort: AbortController;
      title: string;
      dirty: boolean;
      guard: (() => boolean | Promise<boolean>) | null;
    }
    const hosted = new Map<string, Hosted>();
    let padDirty = false;
    const updateDirty = () => app.setDirty(padDirty || [...hosted.values()].some(x => x.dirty));
    let current = '';
    let hostCount = 0;

    /** Runs an app inside `area`, as if `area` were its window. */
    function host(appId: string, area: HTMLElement, onTitle: (t: string) => void, onClose: () => void, arg?: string): Hosted {
      const abort = new AbortController();
      signal.addEventListener('abort', () => abort.abort(), { once: true, signal: abort.signal });
      const entry: Hosted = { area, abort, title: APPS[appId as keyof typeof APPS]?.title ?? appId, dirty: false, guard: null };
      const handle: AppHandle = {
        id: `${app.id}-in-${++hostCount}`,
        root: area,
        signal: abort.signal,
        shell,
        setTitle: t => {
          entry.title = t;
          onTitle(t);
        },
        setIcon: () => undefined,
        setWidth: () => undefined,
        close: onClose,
        setDirty: dirty => {
          entry.dirty = dirty;
          updateDirty();
        },
        onClose: guard => {
          entry.guard = guard;
        },
      };
      const def = shell.apps().find(a => a.id === appId);
      if (!def) area.append(h('p', { class: 'app-message' }, 'That app is not installed on this desktop.'));
      else {
        Promise.resolve(def.launch(handle, arg)).catch(error => {
          area.replaceChildren(h('p', { class: 'app-message' }, `${entry.title} could not open.`));
          void shell.report(`Could not open ${entry.title}`, error);
        });
      }
      return entry;
    }

    async function closeSection(id: string): Promise<boolean> {
      const entry = hosted.get(id);
      if (!entry) return true;
      if (entry.guard && !(await entry.guard())) return false;
      entry.abort.abort();
      entry.area.remove();
      hosted.delete(id);
      updateDirty();
      return true;
    }

    function show(id: string): void {
      const section = SECTIONS.find(s => s.id === id) ?? SECTIONS[0];
      current = section.id;
      for (const [sid, { button }] of navButtons) button.setAttribute('aria-selected', String(sid === section.id));
      overview.hidden = section.id !== 'overview';
      for (const [sid, entry] of hosted) entry.area.hidden = sid !== section.id;
      if (section.app && !hosted.has(section.id)) {
        const area = h('div', { class: 'win-body panel-host' });
        main.append(area);
        hosted.set(section.id, host(section.app, area, t => current === section.id && (barTitle.textContent = t), () => {
          void closeSection(section.id).then(done => done && show('overview'));
        }, section.arg));
      }
      barTitle.textContent = section.id === 'overview' ? 'Overview' : hosted.get(section.id)?.title ?? section.label;
      if (section.id === 'overview') void refreshOverview();
    }

    on(brand, 'click', () => show('overview'), signal);

    // Unsaved work in any section: ask before the panel closes (the shell asks the same for an ordinary window).
    app.onClose(async () => {
      if (padDirty && !(await shell.dialogs.confirm({ title: 'Close without saving?', text: 'The scratch pad has notes that are not saved. If you close the Panel they will be lost.', ok: 'Close without saving', danger: true, cancel: 'Keep it open' }))) return false;
      for (const [id, entry] of hosted) {
        if (!entry.dirty) continue;
        show(id);
        if (entry.guard && !(await entry.guard())) return false;
        if (!entry.guard && !(await shell.dialogs.confirm({ title: 'Close without saving?', text: `“${entry.title}” in the Panel has changes that are not saved. If you close the Panel they will be lost.`, ok: 'Close without saving', danger: true, cancel: 'Keep it open' }))) return false;
      }
      return true;
    });

    // ---- The Overview ---------------------------------------------------------------------------------------------
    const todayList = h('div', { class: 'panel-rows panel-scroll' });
    const recentList = h('div', { class: 'panel-rows' });
    const chatArea = h('div', { class: 'win-body panel-host panel-chat' });
    const tile = (title: string, body: HTMLElement, ...actions: Array<[string, () => void] | HTMLElement>): HTMLElement => {
      const head = h('header', {}, h('h3', {}, title));
      actions.forEach((a, i) => {
        if (a instanceof HTMLElement) return void head.append(a);
        const b = h('button', { type: 'button', class: 'panel-see' + (i ? ' next' : '') }, a[0]);
        on(b, 'click', a[1], signal);
        head.append(b);
      });
      return h('section', { class: 'panel-tile' }, head, body);
    };

    // The scratch pad: the note on the left half, the saved pads' names on the right.
    const padName = h('input', { type: 'text', class: 'pad-name', 'aria-label': 'Scratch pad name', spellcheck: false, maxlength: 80 });
    const padText = h('textarea', { class: 'pad-text', 'aria-label': 'Scratch pad', placeholder: 'Scratch notes here. Ctrl+S saves.' });
    const padState = h('span', { class: 'pad-state', role: 'status' });
    const padList = h('div', { class: 'pad-list', role: 'listbox', 'aria-label': 'Saved scratch pads' });
    const padBody = h('div', { class: 'scratch-pad' }, h('div', { class: 'pad-edit' }, h('div', { class: 'pad-top' }, padName, padState), padText), padList);

    const chatCount = h('span', { class: 'panel-count', hidden: true });
    const expandBtn = h('button', { type: 'button', class: 'panel-see', 'aria-pressed': 'false' }, 'Expand');
    overview.append(
      h('div', { class: 'panel-stack panel-stack-left' },
        tile('Today & upcoming', todayList, ['Calendar', () => show('calendar')]),
        tile('Scratch pad', padBody, ['New', () => void newPad()], ['Save', () => void savePadNow()], ['Open full', () => void openPadFull()]),
        tile('Recent files', recentList, ['Files', () => show('files')])),
      h('div', { class: 'panel-stack panel-stack-chat' }, tile('Chat', chatArea, chatCount, expandBtn)));
    // The chat can take the whole Overview, for a longer conversation, and give it back.
    on(expandBtn, 'click', () => {
      const wide = overview.classList.toggle('chat-wide');
      expandBtn.textContent = wide ? 'Shrink' : 'Expand';
      expandBtn.setAttribute('aria-pressed', String(wide));
    }, signal);

    // ---- Scratch pad ----
    let padFile: string | null = null;
    let padSaved = { name: '', text: '' };
    const setPadDirty = () => {
      padDirty = padText.value !== padSaved.text || padName.value.trim() !== padSaved.name;
      padState.textContent = padDirty ? 'not saved' : padFile ? 'saved' : '';
      updateDirty();
    };
    async function paintPads(): Promise<void> {
      const pads = await listPads(shell.fs);
      padList.replaceChildren(...pads.map(p => {
        const b = h('button', { type: 'button', class: 'pad-item' + (p.name === padFile ? ' on' : ''), role: 'option', 'aria-selected': String(p.name === padFile) },
          padLabel(p.name), h('span', { class: 'panel-sub' }, new Date(p.modified).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })));
        on(b, 'click', () => void openPad(p.name), signal);
        return b;
      }));
      if (!pads.length) padList.append(h('p', { class: 'panel-empty' }, 'Saved pads appear here.'));
    }
    const keepPad = async (): Promise<boolean> => !padDirty || shell.dialogs.confirm({ title: 'Leave this pad?', text: 'The scratch pad has notes that are not saved. Leave them?', ok: 'Leave them', danger: true, cancel: 'Keep writing' });
    async function newPad(): Promise<void> {
      if (!(await keepPad())) return;
      padFile = null;
      padName.value = dayName(new Date());
      padText.value = '';
      padSaved = { name: padName.value, text: '' };
      setPadDirty();
      void paintPads();
      padText.focus();
    }
    async function openPad(name: string): Promise<void> {
      if (name === padFile || !(await keepPad())) return;
      try {
        padText.value = await shell.fs.readText(joinPath(PAD_FOLDER, name));
        padFile = name;
        padName.value = padLabel(name);
        padSaved = { name: padName.value, text: padText.value };
        setPadDirty();
        void paintPads();
      } catch (error) {
        await shell.report('Could not open that scratch pad', error);
      }
    }
    async function savePadNow(): Promise<void> {
      try {
        padFile = await savePad(shell.fs, padName.value, padText.value, padFile, new Date());
        padName.value = padLabel(padFile);
        padSaved = { name: padName.value, text: padText.value };
        setPadDirty();
        await paintPads();
      } catch (error) {
        await shell.report('Could not save the scratch pad', error);
      }
    }
    async function openPadFull(): Promise<void> {
      if (padDirty || !padFile) await savePadNow();
      if (padFile) void shell.openApp('notepadpro', joinPath(PAD_FOLDER, padFile));
    }
    on(padText, 'input', setPadDirty, signal);
    on(padName, 'input', setPadDirty, signal);
    for (const el of [padText, padName]) {
      on(el, 'keydown', (e: KeyboardEvent) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          void savePadNow();
        }
      }, signal);
    }
    padName.value = dayName(new Date());
    padSaved = { name: padName.value, text: '' };
    void paintPads();

    let events: CalEvent[] = [];
    const dismissed = new Set<string>();

    async function readCalendar(): Promise<void> {
      try {
        events = parseIcs(await shell.fs.readText(CALENDAR_PATH));
      } catch {
        events = [];
      }
    }

    function renderToday(): void {
      const now = new Date();
      const todayKey = dateKey(now);
      const today = eventsOn(events, todayKey);
      // Today, then the next days that have anything on them, each under its day. The list scrolls inside the tile.
      const rows: HTMLElement[] = [];
      for (let i = 0; i < UPCOMING_DAYS; i++) {
        const key = addDays(todayKey, i);
        const on_ = i === 0 ? today : eventsOn(events, key);
        if (!on_.length && i > 0) continue;
        const [y, m, d] = key.split('-').map(Number);
        const label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
        rows.push(h('div', { class: 'panel-day' }, label));
        if (!on_.length) rows.push(h('p', { class: 'panel-empty' }, 'Nothing on the calendar today.'));
        for (const e of on_) {
          const to = i === 0 ? minutesTo(e, now) : null;
          const live = to !== null && to <= 0 && endsIn(e, now) > 0;
          const done = to !== null && endsIn(e, now) <= 0;
          rows.push(h('div', { class: 'panel-row' + (done ? ' done' : '') },
            h('span', { class: 'panel-t' }, timeLabel(e)),
            h('span', { class: 'panel-row-main' }, e.title || '(no title)'),
            live ? h('b', { class: 'panel-tag now' }, 'NOW') : to !== null && to > 0 && to <= SOON_MIN ? h('b', { class: 'panel-tag soon' }, `IN ${to} MIN`) : null));
        }
      }
      if (rows.length <= 2 && !today.length) rows.push(h('p', { class: 'panel-empty' }, `Nothing in the next ${UPCOMING_DAYS} days either.`));
      todayList.replaceChildren(...rows);

      // The strip across the top: an event starting within 15 minutes, or on now (a critical strip; one click
      // opens the calendar, Dismiss hides it until the Panel is next opened).
      const soon = today.find(e => {
        const to = minutesTo(e, now);
        return to !== null && to <= SOON_MIN && endsIn(e, now) > 0 && !dismissed.has(e.uid);
      });
      critical.hidden = !soon;
      if (soon) {
        const to = minutesTo(soon, now) ?? 0;
        const open = h('button', { type: 'button', class: 'panel-btn' }, 'Open');
        const dismiss = h('button', { type: 'button', class: 'panel-btn' }, 'Dismiss');
        on(open, 'click', () => show('calendar'), signal);
        on(dismiss, 'click', () => {
          dismissed.add(soon.uid);
          renderToday();
        }, signal);
        critical.replaceChildren(
          h('b', { class: 'panel-critical-tag' }, to <= 0 ? 'ON NOW' : `IN ${to} MIN`),
          h('span', { class: 'panel-critical-main' }, `Calendar: ${soon.title || '(no title)'} · ${timeLabel(soon)}`),
          open, dismiss);
      }
    }

    async function renderRecent(): Promise<void> {
      const found: Array<{ folder: string; entry: Entry }> = [];
      for (const folder of RECENT_FOLDERS) {
        try {
          for (const entry of await shell.fs.list(folder)) if (entry.kind === 'file') found.push({ folder, entry });
        } catch {
          // A folder that is not there is simply not looked in.
        }
      }
      found.sort((a, b) => b.entry.modified - a.entry.modified);
      recentList.replaceChildren(...found.slice(0, 6).map(({ folder, entry }) => {
        const b = h('button', { type: 'button', class: 'panel-row panel-row-btn' },
          h('span', { class: 'panel-row-main' }, entry.name, h('span', { class: 'panel-sub' }, `${folder.slice(1)} · ${new Date(entry.modified).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`)));
        on(b, 'dblclick', () => void shell.openPath(`${folder}/${entry.name}`), signal);
        on(b, 'keydown', (e: KeyboardEvent) => e.key === 'Enter' && void shell.openPath(`${folder}/${entry.name}`), signal);
        b.title = 'Double-click to open';
        return b;
      }));
      if (!found.length) recentList.append(h('p', { class: 'panel-empty' }, 'No files yet in Desktop, Documents, Pictures, Music or Videos.'));
    }

    let overviewBusy = false;
    async function refreshOverview(): Promise<void> {
      if (overviewBusy) return;
      overviewBusy = true;
      try {
        await readCalendar();
        renderToday();
        await renderRecent();
      } finally {
        overviewBusy = false;
      }
    }

    // The Overview's chat is the Chat app itself, in the right-hand column (the advanced layout).
    host('chat', chatArea, () => undefined, () => undefined);

    // Chat's unread count, on its tile and on the rail's CHAT entry if that is ever listed again.
    if (shell.account) {
      const chat = ChatSession.for(shell);
      chat.changed.on(() => {
        const n = chat.unread();
        for (const c of [chatCount, navButtons.get('chat')?.count]) {
          if (!c) continue;
          c.hidden = n === 0;
          c.textContent = String(n);
        }
      }, signal);
    }

    shell.changes.on(paths => {
      if (current === 'overview' && paths.some(p => p === '/Documents' || RECENT_FOLDERS.includes(p))) void refreshOverview();
      if (paths.includes(PAD_FOLDER)) void paintPads();
    }, signal);

    // The clock, the "Open for" line and the calendar strip move on the minute.
    const tick = setInterval(() => {
      const [t, z] = clockParts(new Date());
      clockTime.textContent = t;
      clockZone.textContent = z;
      upValue.textContent = since(Date.now() - opened);
      renderToday();
    }, 15000);
    signal.addEventListener('abort', () => clearInterval(tick), { once: true });

    try {
      const v = await readLocalJson<{ version?: string }>('version.json');
      if (v.version) version.textContent = `TOMLIN OS ${v.version}`;
    } catch {
      // No version file (a copy not built by tools/build.mjs): the name alone.
    }
    show('overview');
  },
};

