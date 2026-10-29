// The small window a one-click button (or Appointment) opens, filled in from the person's settings: what, which day (a
// small month to click on), the time or All day, hours, Repeat daily / Run for N days, the reminder and one note box.
// Enter saves (Shift+Enter in the note starts a new line); Escape closes it with nothing saved.
import { h, on } from '../../core/dom.ts';
import { REMIND_CHOICES, addDays, addMonths, dateKey, dayLabel, monthCells, weekdayNames, type CalEvent } from '../../core/ical.ts';
import type { Shell } from '../../shell/types.ts';
import { MAX_RUN_DAYS, defaultDay, entryFrom, type Project, type ProjectSettings } from './data.ts';

/** A month to pick a day from: one keyboard stop, arrows move the day, Page Up / Page Down the month. */
export function dayPicker(initial: string, signal: AbortSignal, onPick: (day: string) => void): { el: HTMLElement; value: () => string } {
  let chosen = initial;
  let [year, month] = [Number(initial.slice(0, 4)), Number(initial.slice(5, 7)) - 1];
  const today = dateKey(new Date());
  const title = h('span', { class: 'dp-title', 'aria-live': 'polite' });
  const prev = h('button', { type: 'button', class: 'tool', 'aria-label': 'Previous month' }, '‹');
  const next = h('button', { type: 'button', class: 'tool', 'aria-label': 'Next month' }, '›');
  const grid = h('div', { class: 'dp-grid', role: 'grid', tabindex: 0, 'aria-label': 'Day' });
  const said = h('p', { class: 'dp-said', 'aria-live': 'polite' });
  const draw = (focus = false) => {
    title.textContent = new Date(year, month, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const cells: Node[] = weekdayNames('narrow').map(n => h('span', { class: 'dp-dow', 'aria-hidden': 'true' }, n));
    for (const d of monthCells(year, month)) {
      const key = dateKey(d);
      cells.push(h('span', {
        class: `dp-day${d.getMonth() !== month ? ' other' : ''}${key === today ? ' today' : ''}${key === chosen ? ' on' : ''}${key < today ? ' gone' : ''}`,
        role: 'gridcell', 'aria-selected': String(key === chosen), 'data-day': key,
        'aria-label': d.toLocaleDateString(undefined, { dateStyle: 'full' }),
      }, d.getDate()));
    }
    grid.replaceChildren(...cells);
    const word = chosen === today ? 'Today, ' : chosen === addDays(today, 1) ? 'Tomorrow, ' : '';
    said.textContent = `${word}${dayLabel(chosen, true)}`;
    if (focus) grid.focus();
  };
  const pick = (day: string, focus = false) => {
    chosen = day;
    [year, month] = [Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1];
    draw(focus);
    onPick(day);
  };
  on(grid, 'click', (e: MouseEvent) => {
    const cell = e.target instanceof Element ? e.target.closest<HTMLElement>('.dp-day') : null;
    if (cell?.dataset.day) pick(cell.dataset.day, true);
  }, signal);
  on(grid, 'keydown', (e: KeyboardEvent) => {
    const steps: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (e.key in steps) {
      e.preventDefault();
      pick(addDays(chosen, steps[e.key]), true);
    } else if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault();
      const [y, m] = addMonths(Number(chosen.slice(0, 4)), Number(chosen.slice(5, 7)) - 1, e.key === 'PageUp' ? -1 : 1);
      const d = Math.min(Number(chosen.slice(8, 10)), new Date(y, m + 1, 0).getDate());
      pick(dateKey(new Date(y, m, d)), true);
    }
  }, signal);
  const shift = (n: number) => {
    [year, month] = addMonths(year, month, n);
    draw();
  };
  on(prev, 'click', () => shift(-1), signal);
  on(next, 'click', () => shift(1), signal);
  draw();
  return { el: h('div', { class: 'day-picker' }, h('div', { class: 'dp-head' }, prev, title, next), grid, said), value: () => chosen };
}

export interface EntryOptions {
  settings: ProjectSettings;
  /** The window's title ("Add new feature", "Appointment"). */
  heading: string;
  /** Filled into What (an action), or absent for an appointment (Who / Where / About instead). */
  title?: string;
  project?: Project;
  /** For an appointment: the projects it can be about, and names from Contacts to pick from. */
  appointment?: { projects: Project[]; people: string[] };
}

/** Opens the window; resolves to the event to save, or null when the person closed it. */
export async function askEntry(shell: Shell, o: EntryOptions): Promise<CalEvent | null> {
  const abort = new AbortController();
  const signal = abort.signal;
  const s = o.settings;
  let day = defaultDay(s, dateKey(new Date()));
  const appt = o.appointment;

  const whatIn = h('input', { type: 'text', class: 'field', value: o.title ?? '', maxlength: 500, 'aria-label': 'What' });
  const whoIn = h('input', { type: 'text', class: 'field', maxlength: 200, 'aria-label': 'Who', autocomplete: 'off' });
  // Contacts as a list to pick from beside the box (a suggestion list under the box would save the window on the Enter
  // that picks a name).
  const names = appt?.people ?? [];
  const people = names.length
    ? h('select', { class: 'field entry-people', 'aria-label': 'Pick from Contacts' }, h('option', { value: '' }, 'Pick from Contacts'), ...names.map(p => h('option', { value: p }, p)))
    : null;
  if (people) {
    on(people, 'change', () => {
      if (people.value) whoIn.value = people.value;
      people.value = '';
      whoIn.focus();
    }, signal);
  }
  const whereIn = h('input', { type: 'text', class: 'field', maxlength: 500, 'aria-label': 'Where' });
  const aboutSel = h('select', { class: 'field', 'aria-label': 'About' },
    h('option', { value: '' }, 'No project'),
    ...(appt?.projects ?? []).map(p => h('option', { value: p.uid }, p.name)));
  if (o.project) aboutSel.value = o.project.uid;

  const picker = dayPicker(day, signal, d => {
    day = d;
    check();
  });
  const allDay = h('input', { type: 'checkbox', 'aria-label': 'All day' });
  const timeIn = h('input', { type: 'time', class: 'field', value: s.time, 'aria-label': 'Time' });
  const hoursIn = h('input', { type: 'number', class: 'field', min: 0.25, max: 24, step: 0.25, value: s.hours ? String(s.hours) : '', 'aria-label': 'Hours', placeholder: 'none' });
  const daily = h('input', { type: 'checkbox', 'aria-label': 'Repeat daily' });
  const runFor = h('input', { type: 'checkbox', 'aria-label': 'Run for a number of days' });
  const runDays = h('input', { type: 'number', class: 'field entry-run-days', min: 2, max: MAX_RUN_DAYS, step: 1, value: '3', 'aria-label': 'Days in a row' });
  const remindSel = h('select', { class: 'field', 'aria-label': 'Reminder' }, ...REMIND_CHOICES.map(([v, l]) => h('option', { value: v }, l)));
  remindSel.value = String(s.remind);
  const noteIn = h('textarea', { class: 'field', rows: 3, maxlength: 20000, 'aria-label': 'Note' });
  const problem = h('p', { class: 'dialog-problem', role: 'alert' });
  const times = h('div', { class: 'entry-times' }, h('label', {}, 'Time ', timeIn), h('label', {}, 'Hours ', hoursIn));

  // The two ticks contradict each other (forever, or N days), so ticking one unticks the other.
  on(daily, 'change', () => daily.checked && (runFor.checked = false), signal);
  on(runFor, 'change', () => runFor.checked && (daily.checked = false), signal);
  on(runDays, 'input', () => (runFor.checked = true, daily.checked = false), signal);
  const syncAllDay = () => (times.hidden = allDay.checked);
  on(allDay, 'change', syncAllDay, signal);

  let result: CalEvent | string = '';
  const build = (): CalEvent | string => {
    const who = whoIn.value.trim();
    if (appt && !who) return 'Say who you are meeting.';
    return entryFrom({
      title: appt ? `Meet ${who}` : whatIn.value,
      day,
      allDay: allDay.checked,
      start: timeIn.value,
      hours: hoursIn.value,
      daily: !appt && daily.checked,
      runDays: !appt && runFor.checked ? Number(runDays.value.trim() || Number.NaN) : 0,
      remind: Number(remindSel.value),
      notes: noteIn.value,
      where: appt ? whereIn.value : undefined,
      project: appt ? aboutSel.value || undefined : o.project?.uid,
    });
  };
  // Checked on every change; the reason shows under the form (the Save button stays pressable: it says why if pressed).
  let touched = false;
  function check(): boolean {
    result = build();
    problem.textContent = typeof result === 'string' && (touched || !appt) ? result : '';
    return typeof result !== 'string';
  }

  const body = h('form', { class: 'entry-form', novalidate: true },
    ...(appt
      ? [h('div', { class: 'form-row' }, h('label', { class: 'entry-who' }, 'Who ', whoIn), people), h('label', { class: 'form-row' }, 'Where ', whereIn), h('label', { class: 'form-row' }, 'About ', aboutSel)]
      : [h('label', { class: 'form-row' }, 'What ', whatIn)]),
    h('div', { class: 'form-row' }, appt ? 'When ' : 'Day ', picker.el),
    h('label', { class: 'form-check' }, allDay, ' All day'),
    times,
    appt ? null : h('div', { class: 'entry-repeat' },
      h('label', { class: 'form-check' }, daily, ' Repeat daily'),
      h('label', { class: 'form-check' }, runFor, ' Run for ', runDays, ' days')),
    h('label', { class: 'form-row' }, 'Reminder ', remindSel),
    h('label', { class: 'form-row' }, 'Note ', noteIn),
    h('p', { class: 'hint' }, 'Enter saves. Shift+Enter starts a new line in the note.'),
    problem);
  on(body, 'submit', (e: Event) => e.preventDefault(), signal);
  on(body, 'input', () => (touched = true, check()), signal);
  on(body, 'change', () => (touched = true, check()), signal);
  // Enter in the note saves, as in the other boxes (the dialog itself only answers Enter in a one-line box).
  on(noteIn, 'keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    body.closest('.dialog')?.querySelector<HTMLButtonElement>('.dialog-buttons .btn.primary')?.click();
  }, signal);
  syncAllDay();
  check();

  try {
    for (;;) {
      const answer = await shell.dialogs.ask<boolean>({
        title: o.heading,
        body,
        buttons: [{ label: 'Save', value: true, primary: true }, { label: 'Cancel', value: false }],
        cancel: false,
        focus: () => (appt ? whoIn : whatIn),
      });
      if (!answer) return null;
      touched = true;
      if (check() && typeof result !== 'string') return result;
      // Not saveable: the window opens again with everything as typed and the reason showing.
    }
  } finally {
    abort.abort();
  }
}
