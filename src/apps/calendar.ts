// Calendar: a month to look at, the chosen day's events beside it, and a form to add or change one. Events are kept
// in Documents/Calendar.ics (a standard calendar file: download it into a phone or another calendar program, or
// open any .ics file here). Every change reads the file again first and changes only that one event, so two open
// windows or devices never undo each other's other events. Reminders appear as notifications while the desktop is open.
// The month is one keyboard stop: arrow keys move the day, Enter or a double-click adds an event on it.
import { h, on } from '../core/dom.ts';
import { baseName } from '../fs/names.ts';
import { CALENDAR_PATH, REMIND_CHOICES, addDays, addMonths, dateKey, eventsShownOn, isDate, isTime, monthCells, occursOn, parseIcs, repeatLabel, timeLabel, weekdayNames, writeIcs, type CalEvent, type Repeat } from '../core/ical.ts';
import { recordFile } from '../shell/recordfile.ts';
import type { AppDef } from '../shell/types.ts';
import { APPS } from './catalog.ts';

export { CALENDAR_PATH };

const REPEATS: Array<[Repeat, string]> = [['none', 'Does not repeat'], ['daily', 'Every day'], ['weekly', 'Every week'], ['monthly', 'Every month'], ['yearly', 'Every year']];
const REMINDS = REMIND_CHOICES;

export const calendarApp: AppDef = {
  ...APPS.calendar,
  async launch(app, arg) {
    const shell = app.shell;
    const file = recordFile(shell.fs, arg ?? CALENDAR_PATH, parseIcs, writeIcs);
    app.root.classList.add('calendar-app');
    if (arg) app.setTitle(`${baseName(arg)} - Calendar`);

    let events: CalEvent[] = [];
    const today = dateKey(new Date());
    let chosen = today;
    let [year, month] = [new Date().getFullYear(), new Date().getMonth()];
    /** The side panel holds a form: looking at another month must not throw away what is typed in it. */
    let editing = false;
    /** Aborted on every redraw of the side panel, so its buttons' listeners never pile up. */
    let sideDraw = new AbortController();
    const fresh = () => {
      sideDraw.abort();
      sideDraw = new AbortController();
      return sideDraw.signal;
    };
    const showMonthOf = (day: string) => [year, month] = [Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1];

    const title = h('h2', { class: 'cal-month', 'aria-live': 'polite' });
    const prev = h('button', { type: 'button', class: 'tool', 'aria-label': 'Previous month' }, '‹');
    const next = h('button', { type: 'button', class: 'tool', 'aria-label': 'Next month' }, '›');
    const todayBtn = h('button', { type: 'button', class: 'tool wide' }, 'Today');
    const newBtn = h('button', { type: 'button', class: 'tool wide' }, 'New event');
    const grid = h('div', { class: 'cal-month-grid', role: 'grid', 'aria-label': 'Month' });
    const side = h('div', { class: 'cal-side' });
    app.root.append(h('div', { class: 'toolbar' }, prev, next, todayBtn, title, newBtn), h('div', { class: 'cal-main' }, grid, side));

    const cellOf = (day: string) => grid.querySelector<HTMLElement>(`[data-day="${day}"]`);

    function drawMonth(): void {
      title.textContent = new Date(year, month, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
      const rows: Node[] = [h('div', { class: 'cal-row', role: 'row' }, ...weekdayNames('short').map(n => h('span', { class: 'cal-dow', role: 'columnheader' }, n)))];
      const days = monthCells(year, month);
      for (let w = 0; w < 6; w++) {
        rows.push(h('div', { class: 'cal-row', role: 'row' }, ...days.slice(w * 7, w * 7 + 7).map(d => {
          const key = dateKey(d);
          const list = eventsShownOn(events, key);
          return h('div', {
            role: 'gridcell', tabindex: key === chosen ? 0 : -1,
            class: `cal-cell${d.getMonth() !== month ? ' other' : ''}${key === today ? ' today' : ''}${key === chosen ? ' chosen' : ''}${list.length ? ' busy' : ''}`,
            'aria-selected': String(key === chosen), 'aria-current': key === today ? 'date' : null,
            'aria-label': `${d.toLocaleDateString(undefined, { dateStyle: 'full' })}${list.length ? `, ${list.length} event${list.length === 1 ? '' : 's'}` : ''}`,
            'data-day': key,
          }, h('span', { class: 'cal-num', 'aria-hidden': 'true' }, d.getDate()),
          ...list.slice(0, 3).map(e => h('span', { class: 'cal-chip', 'aria-hidden': 'true' }, `${e.start ? e.start + ' ' : ''}${e.title}`)),
          list.length > 3 ? h('span', { class: 'cal-more', 'aria-hidden': 'true' }, `+${list.length - 3} more`) : null);
        })));
      }
      grid.replaceChildren(...rows);
    }

    function drawDay(focusAfter = false): void {
      const signal = fresh();
      editing = false;
      const [y, m, d] = chosen.split('-').map(Number);
      const rows = eventsShownOn(events, chosen).map(e => {
        const b = h('button', { type: 'button', class: 'cal-event' },
          h('span', { class: 'cal-event-time' }, timeLabel(e)),
          h('span', { class: 'cal-event-title' }, e.title),
          e.where ? h('span', { class: 'hint' }, e.where) : null,
          e.repeat !== 'none' ? h('span', { class: 'hint' }, repeatLabel(e)) : null);
        b.addEventListener('click', () => edit(e), { signal });
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

    function edit(existing: CalEvent | null): void {
      const signal = fresh();
      editing = true;
      const e: CalEvent = existing ? { ...existing } : { uid: crypto.randomUUID(), title: '', date: chosen, start: '', end: '', notes: '', repeat: 'none', remind: -1 };
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
        if (await save(list => [...list.filter(x => x.uid !== saved.uid), saved], [saveBtn, del])) {
          // Saving a later showing stays on that day, unless the event was moved off it.
          if (saved.date !== e.date || !occursOn(saved, chosen)) {
            chosen = saved.date;
            showMonthOf(chosen);
          }
          draw(true);
        }
      }, { signal });
      cancel.addEventListener('click', () => drawDay(true), { signal });
      del.addEventListener('click', async () => {
        const ok = await shell.dialogs.confirm({ title: 'Delete this event?', text: `“${e.title}”${e.repeat !== 'none' ? ' and all its repeats' : ''} will be removed from the calendar.`, ok: 'Delete', danger: true, cancel: 'Keep it' });
        if (ok && (await save(list => list.filter(x => x.uid !== e.uid), [saveBtn, del]))) draw(true);
      }, { signal });
    }

    function choose(day: string, focus: boolean): void {
      chosen = day;
      if (Number(day.slice(5, 7)) - 1 !== month || Number(day.slice(0, 4)) !== year) showMonthOf(day);
      draw(focus);
    }

    on(grid, 'click', (event: MouseEvent) => {
      const cell = event.target instanceof Element ? event.target.closest<HTMLElement>('.cal-cell') : null;
      if (cell?.dataset.day) choose(cell.dataset.day, true);
    }, app.signal);
    on(grid, 'dblclick', (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest('.cal-cell')) edit(null);
    }, app.signal);
    on(grid, 'keydown', (event: KeyboardEvent) => {
      const steps: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
      if (event.key in steps) {
        event.preventDefault();
        choose(addDays(chosen, steps[event.key]), true);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        edit(null);
      }
    }, app.signal);
    const shift = (n: number) => {
      [year, month] = addMonths(year, month, n);
      // The chosen day comes along (the same date, or the month's last if shorter): it is the month's one keyboard
      // stop, so the month shown always has one.
      const day = Math.min(Number(chosen.slice(8)), new Date(year, month + 1, 0).getDate());
      chosen = dateKey(new Date(year, month, day));
      drawMonth();
      if (!editing) drawDay();
    };
    on(prev, 'click', () => shift(-1), app.signal);
    on(next, 'click', () => shift(1), app.signal);
    on(todayBtn, 'click', () => choose(today, true), app.signal);
    on(newBtn, 'click', () => edit(null), app.signal);
    file.watch(shell.changes, app.signal, list => {
      events = list;
      drawMonth();
    });

    try {
      events = await file.load();
    } catch (error) {
      await shell.report('Could not open the calendar', error);
      app.close();
      return;
    }
    draw();
  },
};
