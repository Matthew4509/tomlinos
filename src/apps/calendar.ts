// Calendar: a month to look at, the chosen day's events beside it, and a form to add or change one. Events are kept
// in Documents/Calendar.ics (a standard calendar file: download it into a phone or another calendar program, or
// open any .ics file here). Every change reads the file again first and changes only that one event, so two open
// windows or devices never undo each other's other events. Reminders appear as notifications while the desktop is open.
// The month is one keyboard stop: arrow keys move the day, Enter or a double-click adds an event on it.
//
// Beside the person's own events: other calendars subscribed to by their link (read-only, fetched by the server on a
// schedule and on demand) and the public and school holidays for a chosen place, each in its own colour with a tick to
// show or hide it (calendar-sources.ts). File > Import adds the events of another .ics file and says what happened to
// each; File > Export saves this calendar as an .ics file, line for line.
import { css, h, on } from '../core/dom.ts';
import { FsError } from '../fs/errors.ts';
import { baseName, uniqueName } from '../fs/names.ts';
import { COUNTRIES, regionOf, schoolNote, schoolYears } from '../core/holidays.ts';
import { CALENDAR_PATH, REMIND_CHOICES, addDays, addMonths, calendarName, dateKey, eventsShownOn, importEvents, importSummary, isDate, isTime, monthCells, occursOn, parseIcs, repeatLabel, timeLabel, weekdayNames, writeIcs, type CalEvent, type ImportReport, type Repeat } from '../core/ical.ts';
import { ServiceApi } from '../net/service.ts';
import { pickFile, pickSave, type FileTypeChoice } from '../shell/filepicker.ts';
import { classicBar, type BarItem } from '../shell/menubar.ts';
import { MAX_RECORD_FILE, decodeText, recordFile } from '../shell/recordfile.ts';
import type { AppDef } from '../shell/types.ts';
import { APPS } from './catalog.ts';
import { helpMenu } from './classic-menus.ts';
import { COLOURS, REFRESH_CHOICES, SETTINGS_PATH, SUBSCRIPTIONS_FOLDER, colourValue, fetchedLabel, holidayNotes, isDue, linkSite, normaliseLink, publicEvents, readSettings, schoolEvents, writeSettings, yearsAround, type CalendarSettings, type Subscription } from './calendar-sources.ts';

export { CALENDAR_PATH };

const REPEATS: Array<[Repeat, string]> = [['none', 'Does not repeat'], ['daily', 'Every day'], ['weekly', 'Every week'], ['monthly', 'Every month'], ['yearly', 'Every year']];
const REMINDS = REMIND_CHOICES;
const ICS_TYPES: FileTypeChoice[] = [{ label: 'Calendar file', ext: ['ics'] }];
/** How often the window looks for subscriptions due a refresh while it is open. */
const CHECK_EVERY_MS = 5 * 60_000;

/**
 * The list with this event deleted. A repeat goes "and all its repeats": its moved or changed showings (their own
 * events in the file, sharing its UID) go with it, so none is left behind on its own.
 */
export function withoutEvent(list: CalEvent[], e: CalEvent): CalEvent[] {
  const uid = e.keep?.uid;
  const series = e.repeat !== 'none' && !!uid && e.keep?.copy?.of === uid;
  return list.filter(x => x.uid !== e.uid && !(series && x.keep?.uid === uid && !!x.keep?.copy?.of.startsWith(`${uid}#`)));
}

/** Where a shown event comes from. */
interface Source {
  id: string;
  kind: 'own' | 'sub' | 'public' | 'school';
  name: string;
  colour: string;
  /** For a subscription: its site only (the link itself can be a secret). */
  site?: string;
}

/** Steps for finding a calendar's link, shown in Add a calendar and in Help. */
export const LINK_HELP: Array<[string, string[]]> = [
  ['Google Calendar', [
    'Open Google Calendar on a computer (the phone app does not show the link).',
    'Choose the cog at the top, then Settings.',
    'On the left, under “Settings for my calendars”, choose the calendar.',
    'Choose Integrate calendar, then copy “Secret address in iCal format”.',
    'Keep that address private: anyone who has it can see the calendar. If it gets out, choose Reset there.',
  ]],
  ['Outlook.com and Microsoft 365', ['Settings > Calendar > Shared calendars > Publish a calendar. Choose the calendar and “Can view all details”, then Publish, and copy the ICS link.']],
  ['Apple iCloud', ['In the Calendar app, share the calendar as a Public Calendar and copy its link (it starts webcal://).']],
];

export const calendarApp: AppDef = {
  ...APPS.calendar,
  async launch(app, arg) {
    const shell = app.shell;
    const file = recordFile(shell.fs, arg ?? CALENDAR_PATH, parseIcs, writeIcs);
    app.root.classList.add('calendar-app');
    if (arg) app.setTitle(`${baseName(arg)} - Calendar`);
    const api = shell.account ? new ServiceApi(shell.account.api.base, 'calendar') : null;

    let events: CalEvent[] = [];
    let settings: CalendarSettings = readSettings(null);
    /** Each subscription's events, from its last copy. */
    const subEvents = new Map<string, CalEvent[]>();
    const sourceOf = new WeakMap<CalEvent, Source>();
    /** Holidays by kind, region and year, worked out once. */
    const holidayCache = new Map<string, CalEvent[]>();
    const refreshing = new Set<string>();
    let locked = false;
    shell.lockChanged.on(l => (locked = l), app.signal);

    const today = dateKey(new Date());
    let chosen = today;
    let [year, month] = [new Date().getFullYear(), new Date().getMonth()];
    /** The side panel holds a form: looking at another month must not throw away what is typed in it. */
    let editing = false;
    /** Set while a form is open: whether anything in it differs from what it opened with. */
    let formDirty: (() => boolean) | null = null;
    const isDirty = () => !!formDirty?.();
    /** Set while a save from the form is on its way, until the form has been redrawn after it. */
    let saving: Promise<void> | null = null;
    /** True when it is fine to leave the form (it holds nothing unsaved, or the person chose to discard it). */
    async function leaveForm(): Promise<boolean> {
      // A save on its way is waited for: once saved, nothing is left to lose; if it failed, the form is still there.
      while (saving) await saving;
      if (!isDirty()) return true;
      const ok = await shell.dialogs.confirm({ title: 'Discard your changes?', text: 'This event has changes that are not saved. If you leave, they are lost.', ok: 'Discard', danger: true, cancel: 'Keep editing' });
      if (ok) {
        formDirty = null;
        app.setDirty(false);
      }
      return ok;
    }
    /** Aborted on every redraw of the side panel, so its buttons' listeners never pile up. */
    let sideDraw = new AbortController();
    const fresh = () => {
      sideDraw.abort();
      sideDraw = new AbortController();
      return sideDraw.signal;
    };
    const showMonthOf = (day: string) => [year, month] = [Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1];

    // ---- The calendars shown ----

    const ownName = arg ? baseName(arg).replace(/\.ics$/i, '') : 'My calendar';
    const ownSource = (): Source => ({ id: 'own', kind: 'own', name: ownName, colour: settings.own.colour });

    function holidaysFor(kind: 'public' | 'school', region: string, y: number): CalEvent[] {
      const k = `${kind}:${region}:${y}`;
      let list = holidayCache.get(k);
      if (!list) {
        list = kind === 'public' ? publicEvents(region, [y]) : schoolEvents(region, [y]).events;
        holidayCache.set(k, list);
      }
      return list;
    }

    /** Every event of every calendar that is shown, each with its source noted. */
    function allShown(): CalEvent[] {
      const out: CalEvent[] = [];
      const put = (list: CalEvent[], src: Source) => {
        for (const e of list) {
          sourceOf.set(e, src);
          out.push(e);
        }
      };
      if (settings.own.shown) put(events, ownSource());
      for (const s of settings.subscriptions) {
        if (s.shown) put(subEvents.get(s.id) ?? [], { id: s.id, kind: 'sub', name: s.name, colour: s.colour, site: linkSite(s.url) });
      }
      const hol = settings.holidays;
      const r = regionOf(hol.region);
      if (r) {
        for (const y of yearsAround(year)) {
          if (hol.publicOn && hol.publicShown) put(holidaysFor('public', r.code, y), { id: 'public', kind: 'public', name: `Public holidays (${r.short})`, colour: hol.publicColour });
          if (hol.schoolOn && hol.schoolShown) put(holidaysFor('school', r.code, y), { id: 'school', kind: 'school', name: `School holidays (${r.short})`, colour: hol.schoolColour });
        }
      }
      return out;
    }

    /** Only the events that can show between two days (a long subscribed calendar is mostly other months). */
    function within(list: CalEvent[], from: string, to: string): CalEvent[] {
      const a = addDays(from, -1);
      const b = addDays(to, 1);
      return list.filter(e => e.repeat !== 'none' || !!e.keep?.rule.length || (e.date <= b && (e.endDate ?? e.date) >= a));
    }

    const sourceFor = (e: CalEvent): Source => sourceOf.get(e.of ?? e) ?? ownSource();

    // ---- The window ----

    const title = h('h2', { class: 'cal-month', 'aria-live': 'polite' });
    const prev = h('button', { type: 'button', class: 'tool', 'aria-label': 'Previous month' }, '‹');
    const next = h('button', { type: 'button', class: 'tool', 'aria-label': 'Next month' }, '›');
    const todayBtn = h('button', { type: 'button', class: 'tool wide' }, 'Today');
    const grid = h('div', { class: 'cal-month-grid', role: 'grid', 'aria-label': 'Month' });
    const side = h('div', { class: 'cal-side' });
    const list = h('div', { class: 'cal-list', role: 'group', 'aria-label': 'Calendars' });
    const status = h('div', { class: 'cal-status', role: 'status' });

    const canAdd = () => !!api;
    const bar = classicBar({
      menus: [
        { label: 'File', items: [
          { label: 'New event', icon: 'new', action: () => void leaveForm().then(ok => ok && edit(null)) },
          { separator: true },
          { label: 'Import from an .ics file...', icon: 'open', action: () => void importFile() },
          { label: 'Export as an .ics file...', icon: 'save-as', action: () => void exportFile() },
          { separator: true },
          { label: 'Close', icon: 'close', action: () => app.close() },
        ] },
        { label: 'View', items: [
          { label: 'Today', action: () => void leaveForm().then(ok => ok && choose(today, true)) },
          { label: 'Previous month', icon: 'back', action: () => shift(-1) },
          { label: 'Next month', icon: 'forward', action: () => shift(1) },
        ] },
        { label: 'Calendars', items: () => [
          { label: 'Add a calendar by its link...', enabled: canAdd, action: () => void addSubscription() },
          { label: 'Public and school holidays...', icon: 'settings', action: () => void holidaySettings() },
          { separator: true },
          { label: 'Refresh subscribed calendars', icon: 'refresh', enabled: () => !!api && settings.subscriptions.length > 0, action: () => void refreshAll(true) },
          { separator: true },
          ...calendarTicks(),
          ...(settings.subscriptions.length ? [{ separator: true }, { label: 'Calendar settings', submenu: () => settings.subscriptions.map(s => ({ label: `${s.name}...`, action: () => void subscriptionSettings(s.id) })) }] : []),
        ] },
        helpMenu(shell, [{ label: 'Finding a calendar’s link', icon: 'help', action: () => void linkHelp() }]),
      ],
      tools: [
        { id: 'new', label: 'New event', icon: 'new', action: () => void leaveForm().then(ok => ok && edit(null)) },
        '|',
        { id: 'import', label: 'Import from an .ics file', icon: 'open', action: () => void importFile() },
        { id: 'export', label: 'Export as an .ics file', icon: 'save-as', action: () => void exportFile() },
        '|',
        { id: 'refresh', label: 'Refresh subscribed calendars', icon: 'refresh', enabled: () => !!api && settings.subscriptions.length > 0, action: () => void refreshAll(true) },
        { id: 'holidays', label: 'Public and school holidays', icon: 'settings', action: () => void holidaySettings() },
      ],
    }, { layer: shell.menus, signal: app.signal, scope: app.root, label: 'Calendar menu bar', doc: () => grid.querySelector<HTMLElement>('.cal-cell[tabindex="0"]') });

    // The list of calendars shows on the left but comes after the month for the keyboard: Tab goes from the month's
    // buttons to its days first.
    app.root.append(bar.el, h('div', { class: 'toolbar' }, prev, next, todayBtn, title), h('div', { class: 'cal-main with-list' }, grid, list, side), status);

    function calendarTicks(): BarItem[] {
      const items: BarItem[] = [{ label: ownName, checked: () => settings.own.shown, action: () => void toggle('own') }];
      for (const s of settings.subscriptions) items.push({ label: s.name, checked: () => s.shown, action: () => void toggle(s.id) });
      if (regionOf(settings.holidays.region)) {
        if (settings.holidays.publicOn) items.push({ label: 'Public holidays', checked: () => settings.holidays.publicShown, action: () => void toggle('public') });
        if (settings.holidays.schoolOn) items.push({ label: 'School holidays', checked: () => settings.holidays.schoolShown, action: () => void toggle('school') });
      }
      return items;
    }

    const cellOf = (day: string) => grid.querySelector<HTMLElement>(`[data-day="${day}"]`);

    function drawMonth(): void {
      title.textContent = new Date(year, month, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
      const rows: Node[] = [h('div', { class: 'cal-row', role: 'row' }, ...weekdayNames('short').map(n => h('span', { class: 'cal-dow', role: 'columnheader' }, n)))];
      const days = monthCells(year, month);
      const shown = within(allShown(), dateKey(days[0]), dateKey(days[days.length - 1]));
      for (let w = 0; w < 6; w++) {
        rows.push(h('div', { class: 'cal-row', role: 'row' }, ...days.slice(w * 7, w * 7 + 7).map(d => {
          const key = dateKey(d);
          const list = eventsShownOn(shown, key);
          return h('div', {
            role: 'gridcell', tabindex: key === chosen ? 0 : -1,
            class: `cal-cell${d.getMonth() !== month ? ' other' : ''}${key === today ? ' today' : ''}${key === chosen ? ' chosen' : ''}${list.length ? ' busy' : ''}`,
            'aria-selected': String(key === chosen), 'aria-current': key === today ? 'date' : null,
            'aria-label': `${d.toLocaleDateString(undefined, { dateStyle: 'full' })}${list.length ? `, ${list.length} event${list.length === 1 ? '' : 's'}` : ''}`,
            'data-day': key,
          }, h('span', { class: 'cal-num', 'aria-hidden': 'true' }, d.getDate()),
          ...list.slice(0, 3).map(e => coloured(h('span', { class: 'cal-chip', 'aria-hidden': 'true' }, `${e.start ? e.start + ' ' : ''}${e.title}`), sourceFor(e))),
          list.length > 3 ? h('span', { class: 'cal-more', 'aria-hidden': 'true' }, `+${list.length - 3} more`) : null);
        })));
      }
      grid.replaceChildren(...rows);
      drawStatus();
    }

    function coloured<T extends HTMLElement>(el: T, src: Source): T {
      css(el, { '--cal': colourValue(src.colour) });
      return el;
    }

    /** Under the month: what is not known for the year shown (school dates, a day not announced yet), and failed refreshes. */
    function drawStatus(): void {
      const lines = holidayNotes(settings.holidays, year);
      const failed = settings.subscriptions.filter(s => s.problem);
      if (failed.length) lines.push(`${failed.map(s => s.name).join(', ')} could not be refreshed; the last copy is shown.`);
      status.replaceChildren(...lines.map(l => h('p', {}, l)));
      status.hidden = !lines.length;
    }

    function drawList(): void {
      const now = Date.now();
      const row = (id: string, name: string, colour: string, shown: boolean, detail: string, problem = '', settingsOf?: () => void) => {
        const tick = h('input', { type: 'checkbox', checked: shown, 'aria-label': `Show ${name}` });
        tick.addEventListener('change', () => void toggle(id));
        const label = settingsOf
          ? h('button', { type: 'button', class: 'cal-list-name link', title: `Settings for ${name}` }, name)
          : h('span', { class: 'cal-list-name' }, name);
        if (settingsOf) label.addEventListener('click', settingsOf);
        return h('div', { class: 'cal-list-row', 'data-calendar': id },
          tick, coloured(h('span', { class: 'cal-swatch', 'aria-hidden': 'true' }), { id, kind: 'own', name, colour }),
          h('span', { class: 'cal-list-text' }, label,
            detail ? h('span', { class: 'hint' }, detail) : null,
            problem ? h('span', { class: 'hint cal-problem' }, `Could not refresh: ${problem}`) : null));
      };
      const rows: Node[] = [h('h3', {}, 'Calendars'), row('own', ownName, settings.own.colour, settings.own.shown, '')];
      for (const s of settings.subscriptions) {
        rows.push(row(s.id, s.name, s.colour, s.shown, `Read-only · ${refreshing.has(s.id) ? 'Refreshing...' : fetchedLabel(s, now)}`, s.problem, () => void subscriptionSettings(s.id)));
      }
      const r = regionOf(settings.holidays.region);
      if (r && settings.holidays.publicOn) rows.push(row('public', `Public holidays (${r.short})`, settings.holidays.publicColour, settings.holidays.publicShown, 'Read-only', '', () => void holidaySettings()));
      if (r && settings.holidays.schoolOn) rows.push(row('school', `School holidays (${r.short})`, settings.holidays.schoolColour, settings.holidays.schoolShown, 'Read-only', '', () => void holidaySettings()));
      const add = h('button', { type: 'button', class: 'btn' }, 'Add by link...');
      add.disabled = !api;
      add.title = api ? 'Subscribe to a Google, Outlook, Apple or other calendar by its iCal link' : 'Needs the desktop’s server: sign in to a desktop kept on a server';
      add.addEventListener('click', () => void addSubscription());
      const hol = h('button', { type: 'button', class: 'btn' }, 'Holidays...');
      hol.addEventListener('click', () => void holidaySettings());
      rows.push(h('div', { class: 'row-buttons' }, add, hol));
      list.replaceChildren(...rows);
      bar.refresh();
    }

    function drawDay(focusAfter = false): void {
      const signal = fresh();
      editing = false;
      formDirty = null;
      app.setDirty(false);
      const [y, m, d] = chosen.split('-').map(Number);
      const rows = eventsShownOn(within(allShown(), chosen, chosen), chosen).map(e => {
        const src = sourceFor(e);
        const b = coloured(h('button', { type: 'button', class: `cal-event${src.kind === 'own' ? '' : ' other-calendar'}` },
          h('span', { class: 'cal-event-time' }, timeLabel(e)),
          h('span', { class: 'cal-event-title' }, e.title),
          e.where ? h('span', { class: 'hint' }, e.where) : null,
          e.repeat !== 'none' ? h('span', { class: 'hint' }, repeatLabel(e)) : null,
          src.kind === 'own' ? null : h('span', { class: 'hint' }, src.name)), src);
        b.addEventListener('click', () => (src.kind === 'own' ? edit(e) : view(e, src)), { signal });
        return b;
      });
      const add = h('button', { type: 'button', class: 'btn' }, 'Add an event on this day');
      add.addEventListener('click', () => edit(null), { signal });
      side.replaceChildren(
        h('h3', {}, new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })),
        ...(rows.length ? rows : [h('p', { class: 'hint' }, 'Nothing on this day.')]),
        add,
      );
      if (focusAfter) cellOf(chosen)?.focus();
    }

    function draw(focusAfter = false): void {
      drawMonth();
      drawDay(focusAfter);
    }

    /** An event from a read-only calendar: what it says, and where to change it. */
    function view(e: CalEvent, src: Source): void {
      const signal = fresh();
      const back = h('button', { type: 'button', class: 'btn' }, 'Back to the day');
      back.addEventListener('click', () => drawDay(true), { signal });
      const facts: Array<[string, string]> = [['When', timeLabel(e)]];
      if (e.repeat !== 'none') facts.push(['Repeats', repeatLabel(e)]);
      if (e.where) facts.push(['Where', e.where]);
      if (e.notes) facts.push(['Notes', e.notes]);
      const where = src.kind === 'sub'
        ? `Read-only: this event comes from “${src.name}”${src.site ? ` (${src.site})` : ''}. Change it there; the change shows here at the next refresh.`
        : `Read-only: from the ${src.name.toLowerCase()}, worked out by the Calendar. Check with your employer or school for days that matter.`;
      side.replaceChildren(
        h('h3', {}, e.title),
        h('dl', { class: 'person-facts' }, ...facts.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
        coloured(h('p', { class: 'hint cal-readonly' }, where), src),
        h('div', { class: 'row-buttons' }, back),
      );
      back.focus();
    }

    async function save(apply: (list: CalEvent[]) => CalEvent[], busy: HTMLButtonElement[]): Promise<boolean> {
      for (const b of busy) b.disabled = true;
      try {
        events = await file.change(apply);
        return true;
      } catch (error) {
        await shell.report('Could not save the calendar', error);
        return false;
      } finally {
        for (const b of busy) b.disabled = false;
      }
    }

    /** After a save from a form that was closed meanwhile: the month and the day shown, with the change in them. */
    function redrawBehind(): void {
      drawMonth();
      if (!editing) drawDay();
    }

    /** Runs a save from the form, with `saving` set until it and the redraw after it are done. */
    async function whileSaving(run: () => Promise<void>): Promise<void> {
      let done = () => {};
      saving = new Promise<void>(r => (done = r));
      try {
        await run();
      } finally {
        saving = null;
        done();
      }
    }

    function edit(existing: CalEvent | null): void {
      const signal = fresh();
      editing = true;
      const e: CalEvent = existing ? { ...(existing.of ?? existing) } : { uid: crypto.randomUUID(), title: '', date: chosen, start: '', end: '', notes: '', repeat: 'none', remind: -1 };
      const titleIn = h('input', { type: 'text', class: 'field', value: e.title, maxlength: 500, 'aria-label': 'What' });
      // A repeat is one event: its date is the day of its first showing, whichever showing was opened, and moving it
      // moves them all. Named for what it is, so that is never a surprise.
      const isSeries = !!existing && e.repeat !== 'none';
      const dateName = isSeries ? 'First day' : 'Date';
      const dateIn = h('input', { type: 'date', class: 'field', value: e.date, 'aria-label': dateName });
      const allDay = h('input', { type: 'checkbox', checked: !e.start });
      const startIn = h('input', { type: 'time', class: 'field', value: e.start || '09:00', 'aria-label': 'Starts' });
      const endIn = h('input', { type: 'time', class: 'field', value: e.end, 'aria-label': 'Ends' });
      // Only for an event past midnight or over several days. It moves along with the date, so it keeps its length.
      const endDayIn = h('input', { type: 'date', class: 'field', value: e.endDate ?? '', 'aria-label': 'Ends on' });
      let dateWas = e.date;
      dateIn.addEventListener('change', () => {
        if (endDayIn.value && isDate(endDayIn.value) && isDate(dateWas) && isDate(dateIn.value)) {
          const [[y0, m0, d0], [y1, m1, d1]] = [dateWas, dateIn.value].map(v => v.split('-').map(Number));
          endDayIn.value = addDays(endDayIn.value, Math.round((Date.UTC(y1, m1 - 1, d1) - Date.UTC(y0, m0 - 1, d0)) / 86400000));
        }
        if (isDate(dateIn.value)) dateWas = dateIn.value;
      }, { signal });
      // Plain text: an address, a room, a contact's address (a place to go, later, for a day's route).
      const whereIn = h('input', { type: 'text', class: 'field', value: e.where ?? '', maxlength: 500, 'aria-label': 'Where' });
      const repeatSel = h('select', { class: 'field', 'aria-label': 'Repeats' }, ...REPEATS.map(([v, l]) => h('option', { value: v }, l)));
      repeatSel.value = e.repeat;
      // Where a repeat ends ("for 3 days", "until ...") is set in My Projects; shown here, and kept while Repeats stays
      // the same. A different repeat drops the count (3 days are not 3 weeks); "until" is a date, so it stays.
      const limits = (): Pick<CalEvent, 'count' | 'until'> => {
        const repeat = repeatSel.value as Repeat;
        if (repeat === 'none') return { count: 0, until: '' };
        return { count: repeat === e.repeat ? e.count ?? 0 : 0, until: e.until ?? '' };
      };
      const ends = h('p', { class: 'hint cal-ends' });
      const syncEnds = () => {
        const l = limits();
        const label = l.count || l.until ? repeatLabel({ repeat: repeatSel.value as Repeat, ...l }) : '';
        ends.textContent = label ? `Ends: ${label.slice(label.indexOf(',') + 2)}` : '';
        ends.hidden = !label;
      };
      syncEnds();
      repeatSel.addEventListener('change', syncEnds, { signal });
      const remindSel = h('select', { class: 'field', 'aria-label': 'Reminder' }, ...REMINDS.map(([v, l]) => h('option', { value: v }, l)));
      remindSel.value = String(REMINDS.some(r => r[0] === e.remind) ? e.remind : -1);
      const notesIn = h('textarea', { class: 'field', rows: 4, 'aria-label': 'Notes' });
      notesIn.value = e.notes;
      const problem = h('p', { class: 'dialog-problem', role: 'alert' });
      const saveBtn = h('button', { type: 'button', class: 'btn primary' }, 'Save');
      const cancel = h('button', { type: 'button', class: 'btn' }, 'Cancel');
      const del = h('button', { type: 'button', class: 'btn danger' }, 'Delete');
      const times = h('div', { class: 'cal-times' }, h('label', {}, 'Starts ', startIn), h('label', {}, 'Ends ', endIn));
      const syncTimes = () => (times.hidden = allDay.checked);
      syncTimes();
      allDay.addEventListener('change', syncTimes, { signal });
      side.replaceChildren(
        h('h3', {}, existing ? 'Change event' : 'New event'),
        h('label', { class: 'form-row' }, 'What ', titleIn),
        h('label', { class: 'form-row' }, `${dateName} `, dateIn),
        ...(isSeries ? [h('p', { class: 'hint cal-series' }, 'This changes every showing, not only the one you opened.')] : []),
        h('label', { class: 'form-check' }, allDay, ' All day'),
        times,
        h('label', { class: 'form-row' }, 'Ends on, if a later day ', endDayIn),
        h('label', { class: 'form-row' }, 'Where ', whereIn),
        h('label', { class: 'form-row' }, 'Repeats ', repeatSel),
        ends,
        h('label', { class: 'form-row' }, 'Reminder ', remindSel),
        h('label', { class: 'form-row' }, 'Notes ', notesIn),
        problem,
        h('div', { class: 'row-buttons' }, saveBtn, cancel, existing ? del : null),
      );
      const snap = () => JSON.stringify([titleIn.value, dateIn.value, allDay.checked, startIn.value, endIn.value, endDayIn.value, whereIn.value, repeatSel.value, remindSel.value, notesIn.value]);
      const was = snap();
      formDirty = () => snap() !== was;
      side.addEventListener('input', () => app.setDirty(isDirty()), { signal });
      side.addEventListener('change', () => app.setDirty(isDirty()), { signal });
      titleIn.focus();
      saveBtn.addEventListener('click', async () => {
        const start = allDay.checked ? '' : startIn.value;
        const end = allDay.checked ? '' : endIn.value;
        if (!titleIn.value.trim()) return void (problem.textContent = 'Give the event a name.');
        if (!isDate(dateIn.value)) return void (problem.textContent = 'Choose a date.');
        if (!allDay.checked && !isTime(start)) return void (problem.textContent = 'Choose a start time, or tick All day.');
        const endDay = endDayIn.value;
        if (endDay && !isDate(endDay)) return void (problem.textContent = 'That end day is not a real date.');
        if (endDay && endDay < dateIn.value) return void (problem.textContent = 'The end day cannot be before the start.');
        const later = endDay > dateIn.value;
        if (later && !allDay.checked && !end) return void (problem.textContent = 'Choose an end time for that end day, or clear the end day.');
        if (end && (!isTime(end) || (!later && end <= start))) return void (problem.textContent = 'The end time must be after the start time, or choose a later end day (or leave it empty).');
        const saved: CalEvent = { ...e, title: titleIn.value.trim(), date: dateIn.value, start, end, endDate: later ? endDay : undefined, notes: notesIn.value, where: whereIn.value.trim(), repeat: repeatSel.value as Repeat, ...limits(), remind: Number(remindSel.value) };
        // An edit of an event someone deleted meanwhile (another window) is refused, not quietly put back.
        const edited = existing !== null;
        await whileSaving(async () => {
          if (!(await save(list => {
            if (edited && !list.some(x => x.uid === saved.uid)) throw new FsError('This event was deleted in another window, so your changes were not saved. Choose New event to add it again.');
            return [...list.filter(x => x.uid !== saved.uid), saved];
          }, [saveBtn, del]))) return;
          // The form was closed meanwhile (Cancel): what is shown now stays, with the saved event in it.
          if (signal.aborted) return redrawBehind();
          // Saving a later showing stays on that day, unless the event was moved off it.
          if (saved.date !== e.date || !occursOn(saved, chosen)) {
            chosen = saved.date;
            showMonthOf(chosen);
          }
          draw(true);
        });
      }, { signal });
      cancel.addEventListener('click', () => drawDay(true), { signal });
      del.addEventListener('click', async () => {
        const ok = await shell.dialogs.confirm({ title: 'Delete this event?', text: `“${e.title}”${e.repeat !== 'none' ? ' and all its repeats' : ''} will be removed from the calendar.`, ok: 'Delete', danger: true, cancel: 'Keep it' });
        if (!ok) return;
        await whileSaving(async () => {
          if (!(await save(list => withoutEvent(list, e), [saveBtn, del]))) return;
          if (signal.aborted) return redrawBehind();
          draw(true);
        });
      }, { signal });
    }

    function choose(day: string, focus: boolean): void {
      chosen = day;
      if (Number(day.slice(5, 7)) - 1 !== month || Number(day.slice(0, 4)) !== year) showMonthOf(day);
      draw(focus);
    }

    // ---- Import and export ----

    async function importFile(): Promise<void> {
      if (!(await leaveForm())) return;
      const path = await pickFile(shell, { title: 'Import from an .ics file', folder: '/Documents', ok: 'Import', types: ICS_TYPES });
      if (!path || app.signal.aborted) return;
      if (path.toLowerCase() === file.path.toLowerCase()) {
        await shell.dialogs.alert('That is this calendar', 'Its events are already here. Choose another .ics file to import.');
        return;
      }
      let text: string;
      try {
        const entry = await shell.fs.stat(path);
        if (!entry || entry.kind !== 'file') throw new Error('gone');
        if (entry.size > MAX_RECORD_FILE) {
          await shell.dialogs.alert('Too large to import', `“${entry.name}” is larger than ${MAX_RECORD_FILE >> 20} MB, so it was not read.`);
          return;
        }
        text = decodeText(await shell.fs.readFile(path));
      } catch (error) {
        await shell.report('Could not read that file', error);
        return;
      }
      if (!/BEGIN:VCALENDAR/i.test(text)) {
        await shell.dialogs.alert('Not a calendar file', `“${baseName(path)}” is not an iCalendar (.ics) file, so nothing was imported.`);
        return;
      }
      let report: ImportReport | null = null;
      try {
        events = await file.change(current => {
          const done = importEvents(current, text);
          report = done.report;
          return done.list;
        });
      } catch (error) {
        await shell.report('Could not import the events', error);
        return;
      }
      draw();
      const r = report as ImportReport | null;
      if (!r) return;
      const lines = importSummary(r);
      await shell.dialogs.ask({
        title: 'Import finished',
        body: h('div', { class: 'cal-report' }, h('p', {}, `From “${baseName(path)}”:`), h('ul', {}, ...lines.map(l => h('li', {}, l)))),
        buttons: [{ label: 'OK', value: true, primary: true }],
        cancel: true,
      });
    }

    async function exportFile(): Promise<void> {
      let taken: string[] = [];
      try {
        taken = (await shell.fs.list('/Documents', true)).map(e => e.name);
      } catch {
        // Saving will say what is wrong.
      }
      const chosenPath = await pickSave(shell, { title: 'Export as an .ics file', folder: '/Documents', name: uniqueName(`${ownName}.ics`, taken), ok: 'Export', types: ICS_TYPES });
      if (!chosenPath) return;
      const target = /\.ics$/i.test(chosenPath.path) ? chosenPath.path : `${chosenPath.path}.ics`;
      if (target.toLowerCase() === file.path.toLowerCase()) {
        await shell.dialogs.alert('That is this calendar', 'Choose another name: exporting over the calendar itself would change nothing.');
        return;
      }
      try {
        // The file as it is, line for line (everything another program wrote into it comes too).
        const entry = await shell.fs.stat(file.path);
        const bytes = entry ? await shell.fs.readFile(file.path) : new TextEncoder().encode(writeIcs([]));
        const replace = target === chosenPath.path ? chosenPath.replace : !!(await shell.fs.stat(target).catch(() => null));
        const saved = await shell.fs.writeFile(target, bytes, replace ? {} : { mustBeNew: true });
        shell.toast(`Exported ${events.length} event${events.length === 1 ? '' : 's'} to “${saved.name}”.`);
      } catch (error) {
        await shell.report('Could not export the calendar', error);
      }
    }

    // ---- Settings, subscriptions and holidays ----

    async function loadSettings(): Promise<void> {
      try {
        settings = readSettings((await shell.fs.stat(SETTINGS_PATH)) ? await shell.fs.readText(SETTINGS_PATH) : null);
      } catch {
        settings = readSettings(null);
      }
    }

    /** Reads the settings again, applies one change and writes them, so another window's changes are kept. */
    async function changeSettings(apply: (s: CalendarSettings) => void): Promise<boolean> {
      try {
        await loadSettings();
        apply(settings);
        await shell.fs.ensureFolder('/System', { hidden: true });
        await shell.fs.writeText(SETTINGS_PATH, writeSettings(settings), { hidden: true });
        return true;
      } catch (error) {
        await shell.report('Could not save the calendar settings', error);
        return false;
      } finally {
        // A form being filled in stays as it is (a refresh can finish while someone types).
        if (!app.signal.aborted) {
          drawList();
          drawMonth();
          if (!editing) drawDay();
        }
      }
    }

    const copyPath = (id: string) => `${SUBSCRIPTIONS_FOLDER}/${id}.ics`;

    async function loadCopies(): Promise<void> {
      for (const s of settings.subscriptions) {
        try {
          const entry = await shell.fs.stat(copyPath(s.id));
          if (entry && entry.size <= MAX_RECORD_FILE) subEvents.set(s.id, parseIcs(decodeText(await shell.fs.readFile(copyPath(s.id)))));
        } catch {
          // No copy yet: the next refresh brings one.
        }
      }
      // A copy whose calendar is not (or not yet) in the settings is kept: only calendars in the settings are shown, and
      // one being added in this window has its copy before its settings are written.
    }

    async function toggle(id: string): Promise<void> {
      await changeSettings(s => {
        if (id === 'own') s.own.shown = !s.own.shown;
        else if (id === 'public') s.holidays.publicShown = !s.holidays.publicShown;
        else if (id === 'school') s.holidays.schoolShown = !s.holidays.schoolShown;
        else {
          const sub = s.subscriptions.find(x => x.id === id);
          if (sub) sub.shown = !sub.shown;
        }
      });
    }

    /** Fetches a calendar by its link through the server: its text, or the reason in words. */
    async function fetchLink(url: string): Promise<{ text: string } | { problem: string }> {
      if (!api) return { problem: 'Subscribing needs the desktop’s server.' };
      try {
        const got = await api.call<{ text: string }>('fetch', { body: { url } });
        if (typeof got.text !== 'string') return { problem: 'The server’s answer could not be read.' };
        return { text: got.text };
      } catch (error) {
        return { problem: error instanceof Error ? error.message : 'The calendar could not be fetched.' };
      }
    }

    /** Fetches one subscription now and keeps its copy; a failure keeps the last copy and is noted. */
    async function refresh(id: string): Promise<boolean> {
      const sub = settings.subscriptions.find(s => s.id === id);
      if (!sub || refreshing.has(id) || !api || locked) return false;
      refreshing.add(id);
      drawList();
      const got = await fetchLink(sub.url);
      let ok = false;
      if ('text' in got) {
        try {
          const list = parseIcs(got.text);
          await shell.fs.ensureFolder(SUBSCRIPTIONS_FOLDER, { hidden: true });
          await shell.fs.writeText(copyPath(id), got.text, { hidden: true });
          subEvents.set(id, list);
          ok = true;
        } catch (error) {
          refreshing.delete(id);
          await changeSettings(s => {
            const x = s.subscriptions.find(y => y.id === id);
            if (x) x.problem = error instanceof Error ? error.message : 'Its copy could not be kept.';
          });
          return false;
        }
      }
      refreshing.delete(id);
      if (app.signal.aborted) return ok;
      await changeSettings(s => {
        const x = s.subscriptions.find(y => y.id === id);
        if (!x) return;
        if (ok) {
          x.fetched = Date.now();
          x.problem = '';
        } else x.problem = 'problem' in got ? got.problem : 'It could not be fetched.';
      });
      return ok;
    }

    /** Refreshes the subscriptions due (or all, when asked from the menu). */
    async function refreshAll(all: boolean): Promise<void> {
      if (!api || locked) return;
      const now = Date.now();
      const due = settings.subscriptions.filter(s => all || isDue(s, now));
      for (const s of due) await refresh(s.id);
      if (all && due.length) {
        const failed = settings.subscriptions.filter(s => s.problem).length;
        shell.toast(failed ? `Refreshed; ${failed} calendar${failed === 1 ? '' : 's'} could not be fetched (the last copy is shown).` : `Refreshed ${due.length} calendar${due.length === 1 ? '' : 's'}.`);
      }
    }

    function colourSelect(value: string, label: string): HTMLSelectElement {
      const sel = h('select', { class: 'field', 'aria-label': label }, ...COLOURS.map(c => h('option', { value: c.id }, c.name)));
      sel.value = value;
      return sel;
    }
    function refreshSelect(value: number): HTMLSelectElement {
      const sel = h('select', { class: 'field', 'aria-label': 'Refresh' }, ...REFRESH_CHOICES.map(([v, l]) => h('option', { value: String(v) }, l)));
      sel.value = String(value);
      return sel;
    }
    function helpBlock(open = false): HTMLElement {
      const d = h('details', { class: 'cal-help' }, h('summary', {}, 'Where to find the link'),
        ...LINK_HELP.map(([name, steps]) => h('div', {}, h('strong', {}, name), steps.length > 1 ? h('ol', {}, ...steps.map(s => h('li', {}, s))) : h('p', {}, steps[0]))));
      d.open = open;
      return d;
    }

    async function linkHelp(): Promise<void> {
      await shell.dialogs.ask({ title: 'Finding a calendar’s link', body: helpBlock(true), buttons: [{ label: 'OK', value: true, primary: true }], cancel: true });
    }

    async function addSubscription(start = { url: '', name: '', colour: 'purple', every: 6 }): Promise<void> {
      if (!api) {
        await shell.dialogs.alert('Needs the desktop’s server', 'Adding a calendar by its link needs the desktop’s server, which fetches it for you. Sign in to a desktop kept on a server to use it.');
        return;
      }
      const urlIn = h('input', { type: 'url', class: 'field', value: start.url, 'aria-label': 'Calendar link', placeholder: 'Paste the link here', spellcheck: false, autocomplete: 'off' });
      const nameIn = h('input', { type: 'text', class: 'field', value: start.name, maxlength: 100, 'aria-label': 'Name', placeholder: 'The calendar’s own name' });
      const colourIn = colourSelect(start.colour, 'Colour');
      const everyIn = refreshSelect(start.every);
      const body = h('div', { class: 'cal-add' },
        h('label', { class: 'form-row' }, 'Link (iCal or ICS address) ', urlIn),
        h('label', { class: 'form-row' }, 'Name ', nameIn),
        h('label', { class: 'form-row' }, 'Colour ', colourIn),
        h('label', { class: 'form-row' }, 'Refresh ', everyIn),
        h('p', { class: 'hint' }, 'Read-only: its events show here and are changed where the calendar comes from. Changes there show here at the next refresh. The link is kept with your files, and only the desktop’s server uses it.'),
        helpBlock());
      const ok = await shell.dialogs.ask({
        title: 'Add a calendar by its link',
        body,
        buttons: [{ label: 'Add', value: true, primary: true }, { label: 'Cancel', value: false }],
        cancel: false,
        primaryEnabled: () => !!urlIn.value.trim(),
        focus: () => urlIn,
      });
      if (!ok) return;
      const values = { url: urlIn.value, name: nameIn.value, colour: colourIn.value, every: Number(everyIn.value) };
      const url = normaliseLink(values.url);
      if (typeof url !== 'string') {
        await shell.dialogs.alert('That link cannot be used', url.problem);
        return addSubscription(values);
      }
      if (settings.subscriptions.some(s => s.url === url)) {
        await shell.dialogs.alert('Already added', 'That calendar is already in your list.');
        return;
      }
      shell.toast('Fetching the calendar...');
      const got = await fetchLink(url);
      if ('problem' in got) {
        await shell.dialogs.alert('Could not add that calendar', got.problem);
        return addSubscription(values);
      }
      const id = crypto.randomUUID().slice(0, 8);
      const list = parseIcs(got.text);
      try {
        await shell.fs.ensureFolder(SUBSCRIPTIONS_FOLDER, { hidden: true });
        await shell.fs.writeText(copyPath(id), got.text, { hidden: true });
      } catch (error) {
        await shell.report('Could not keep a copy of that calendar', error);
        return;
      }
      subEvents.set(id, list);
      const sub: Subscription = { id, name: values.name.trim() || calendarName(got.text) || linkSite(url) || 'Calendar', url, colour: values.colour, shown: true, every: values.every, fetched: Date.now(), problem: '' };
      if (await changeSettings(s => void s.subscriptions.push(sub))) shell.toast(`Added “${sub.name}” with ${list.length} event${list.length === 1 ? '' : 's'}.`);
    }

    async function subscriptionSettings(id: string): Promise<void> {
      const sub = settings.subscriptions.find(s => s.id === id);
      if (!sub) return;
      const nameIn = h('input', { type: 'text', class: 'field', value: sub.name, maxlength: 100, 'aria-label': 'Name' });
      const colourIn = colourSelect(sub.colour, 'Colour');
      const everyIn = refreshSelect(sub.every);
      const now = Date.now();
      const body = h('div', { class: 'cal-add' },
        h('label', { class: 'form-row' }, 'Name ', nameIn),
        h('label', { class: 'form-row' }, 'Colour ', colourIn),
        h('label', { class: 'form-row' }, 'Refresh ', everyIn),
        h('p', { class: 'hint' }, `From ${linkSite(sub.url) || 'its link'}. Read-only. ${fetchedLabel(sub, now)}; ${(subEvents.get(id) ?? []).length} events.`),
        sub.problem ? h('p', { class: 'dialog-problem' }, `The last refresh failed: ${sub.problem}`) : null);
      const answer = await shell.dialogs.ask<'save' | 'refresh' | 'remove' | 'cancel'>({
        title: `Calendar settings: ${sub.name}`,
        body,
        buttons: [{ label: 'Save', value: 'save', primary: true }, { label: 'Refresh now', value: 'refresh' }, { label: 'Remove', value: 'remove', danger: true }, { label: 'Cancel', value: 'cancel' }],
        cancel: 'cancel',
        focus: () => nameIn,
      });
      if (answer === 'save' || answer === 'refresh') {
        await changeSettings(s => {
          const x = s.subscriptions.find(y => y.id === id);
          if (!x) return;
          x.name = nameIn.value.trim().slice(0, 100) || x.name;
          x.colour = colourIn.value;
          x.every = Number(everyIn.value);
        });
        if (answer === 'refresh') {
          const ok = await refresh(id);
          shell.toast(ok ? `Refreshed “${sub.name}”.` : `“${sub.name}” could not be refreshed: ${settings.subscriptions.find(s => s.id === id)?.problem ?? ''}`);
        }
      } else if (answer === 'remove') {
        if (!(await shell.dialogs.confirm({ title: 'Remove this calendar?', text: `“${sub.name}” and its events go from this Calendar. The calendar itself, where it comes from, is not changed.`, ok: 'Remove', danger: true, cancel: 'Keep it' }))) return;
        subEvents.delete(id);
        await changeSettings(s => void (s.subscriptions = s.subscriptions.filter(x => x.id !== id)));
        try {
          // Only the desktop's own hidden copy goes; the calendar where it comes from is not touched.
          if (await shell.fs.stat(copyPath(id))) await shell.fs.remove([copyPath(id)]);
        } catch {
          // Its copy is left in the hidden folder; it is never shown.
        }
      }
    }

    async function holidaySettings(): Promise<void> {
      const hol = settings.holidays;
      const r = regionOf(hol.region);
      const countryIn = h('select', { class: 'field', 'aria-label': 'Country' }, h('option', { value: '' }, 'None'), ...COUNTRIES.map(c => h('option', { value: c.code }, c.name)));
      countryIn.value = r?.country ?? '';
      const regionIn = h('select', { class: 'field', 'aria-label': 'State or region' });
      const publicIn = h('input', { type: 'checkbox', checked: hol.publicOn });
      const schoolIn = h('input', { type: 'checkbox', checked: hol.schoolOn });
      const publicColour = colourSelect(hol.publicColour, 'Public holidays colour');
      const schoolColour = colourSelect(hol.schoolColour, 'School holidays colour');
      const note = h('div', { class: 'hint cal-data-note' });
      const fillRegions = (keep: string) => {
        const c = COUNTRIES.find(x => x.code === countryIn.value);
        regionIn.replaceChildren(...(c?.regions ?? []).map(x => h('option', { value: x.code }, x.name)));
        regionIn.disabled = !c;
        if (c) regionIn.value = c.regions.some(x => x.code === keep) ? keep : c.regions[0].code;
      };
      const syncNote = () => {
        const code = regionIn.disabled ? '' : regionIn.value;
        const region = regionOf(code);
        const lines: string[] = [];
        if (!region) lines.push('Choose a country, then a state or region.');
        else if (region.country === 'AU') {
          lines.push('Public holidays are worked out from each state’s rules, with Easter worked out for each year. Days the government sets each year (Western Australia’s King’s Birthday until 2027, Victoria’s Grand Final Friday) are included once announced; until then the Calendar says they are not known. Regional days (a show day for one town) are not included.');
          const years = schoolYears(code);
          lines.push(years ? `School holidays: government schools, ${years[0]} to ${years[1]}, from the state’s education department. Other years show as not known yet, never guessed.` : 'School holidays: not known yet for this state.');
          const extra = schoolNote(code);
          if (extra) lines.push(extra);
        } else {
          lines.push('Bank holidays are worked out from the rules for England and Wales, Scotland and Northern Ireland, with Easter for each year and the one-off days announced so far.');
          lines.push('School holidays in the UK are set by each council or school, so they are not included. If your school or council offers a calendar link, add it with Calendars > Add a calendar by its link.');
        }
        schoolIn.disabled = !region || region.country !== 'AU';
        note.replaceChildren(...lines.map(l => h('p', {}, l)));
      };
      fillRegions(hol.region);
      syncNote();
      countryIn.addEventListener('change', () => {
        fillRegions('');
        syncNote();
      });
      regionIn.addEventListener('change', syncNote);
      const body = h('div', { class: 'cal-add' },
        h('label', { class: 'form-row' }, 'Country ', countryIn),
        h('label', { class: 'form-row' }, 'State or region ', regionIn),
        h('div', { class: 'cal-hol-row' }, h('label', { class: 'form-check' }, publicIn, ' Public holidays'), publicColour),
        h('div', { class: 'cal-hol-row' }, h('label', { class: 'form-check' }, schoolIn, ' School holidays'), schoolColour),
        note);
      const ok = await shell.dialogs.ask({
        title: 'Public and school holidays',
        body,
        buttons: [{ label: 'Save', value: true, primary: true }, { label: 'Cancel', value: false }],
        cancel: false,
        focus: () => countryIn,
      });
      if (!ok) return;
      const region = regionIn.disabled ? '' : regionIn.value;
      await changeSettings(s => {
        s.holidays.region = region;
        s.holidays.publicOn = !!region && publicIn.checked;
        s.holidays.schoolOn = !!region && !schoolIn.disabled && schoolIn.checked;
        s.holidays.publicColour = publicColour.value;
        s.holidays.schoolColour = schoolColour.value;
        if (s.holidays.publicOn) s.holidays.publicShown = true;
        if (s.holidays.schoolOn) s.holidays.schoolShown = true;
      });
    }

    // ---- The keyboard and the mouse ----

    on(grid, 'click', (event: MouseEvent) => {
      const cell = event.target instanceof Element ? event.target.closest<HTMLElement>('.cal-cell') : null;
      const day = cell?.dataset.day;
      if (day) void leaveForm().then(ok => ok && choose(day, true));
    }, app.signal);
    on(grid, 'dblclick', (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest('.cal-cell')) void leaveForm().then(ok => ok && edit(null));
    }, app.signal);
    on(grid, 'keydown', (event: KeyboardEvent) => {
      const steps: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
      if (event.key in steps) {
        event.preventDefault();
        const day = addDays(chosen, steps[event.key]);
        void leaveForm().then(ok => ok && choose(day, true));
      } else if (event.key === 'Enter') {
        event.preventDefault();
        void leaveForm().then(ok => ok && edit(null));
      }
    }, app.signal);
    function shift(n: number): void {
      [year, month] = addMonths(year, month, n);
      // The chosen day comes along (the same date, or the month's last if shorter): it is the month's one keyboard
      // stop, so the month shown always has one.
      const day = Math.min(Number(chosen.slice(8)), new Date(year, month + 1, 0).getDate());
      chosen = dateKey(new Date(year, month, day));
      drawMonth();
      if (!editing) drawDay();
    }
    on(prev, 'click', () => shift(-1), app.signal);
    on(next, 'click', () => shift(1), app.signal);
    on(todayBtn, 'click', () => void leaveForm().then(ok => ok && choose(today, true)), app.signal);
    app.onClose(leaveForm);
    file.watch(shell.changes, app.signal, list => {
      events = list;
      drawMonth();
    });
    // Another window changed the calendars (a tick, a new subscription, a refresh): shown here too.
    shell.changes.on(paths => {
      const copies = paths.some(p => p.toLowerCase() === SUBSCRIPTIONS_FOLDER.toLowerCase());
      if (!copies && !paths.some(p => p.toLowerCase() === '/system')) return;
      // The copies are read again only when one changed (a refresh): a tick changes the settings alone.
      void loadSettings().then(() => (copies ? loadCopies() : undefined)).then(() => {
        if (app.signal.aborted) return;
        drawList();
        drawMonth();
        if (!editing) drawDay();
      });
    }, app.signal);

    try {
      events = await file.load();
    } catch (error) {
      await shell.report('Could not open the calendar', error);
      app.close();
      return;
    }
    await loadSettings();
    await loadCopies();
    drawList();
    draw();
    // Subscriptions due a refresh are fetched now, and looked at again every few minutes while the window is open.
    void refreshAll(false);
    const timer = setInterval(() => void refreshAll(false), CHECK_EVERY_MS);
    app.signal.addEventListener('abort', () => clearInterval(timer), { once: true });
  },
};
