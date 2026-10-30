// Calendar reminders. Reads the calendar file when the desktop starts and whenever it changes, and every 30 seconds
// shows any reminder that has fallen due: today's events, and those of the days ahead as far as the longest reminder
// set reaches (tomorrow's for a reminder set a day ahead; a calendar file from elsewhere may say a week). Never a flood
// of old ones after a long time away: only those due in the last 10 minutes. The saved settings remember up to when
// reminders were shown, so a reload does not show the same one again.
import { CALENDAR_PATH } from '../core/ical.ts';
import { addDays, dateKey, eventsOn, parseIcs, reminderAt, timeLabel, writeIcs, type CalEvent } from '../core/ical.ts';
import { recordFile } from './recordfile.ts';
import type { Shell } from './types.ts';

const LATE_LIMIT = 10 * 60000;
/** How many days ahead to look at most, whatever a file says: a year. */
const MAX_DAYS_AHEAD = 366;

/** The reminders due in (after, now], with the day of the showing each belongs to. Pure, for the tests. */
export function dueReminders(events: CalEvent[], now: number, after: number): Array<{ event: CalEvent; day: string }> {
  const today = dateKey(new Date(now));
  const out: Array<{ event: CalEvent; day: string }> = [];
  // One day more than the longest reminder reaches, for one set across midnight.
  const longest = Math.max(0, ...events.map(e => e.remind));
  const ahead = Math.min(MAX_DAYS_AHEAD, Math.ceil(longest / 1440) + 1);
  for (let i = 0; i <= ahead; i++) {
    const day = addDays(today, i);
    for (const event of eventsOn(events, day)) {
      const due = reminderAt(event, day);
      if (due !== null && due <= now && now - due <= LATE_LIMIT && due > after) out.push({ event, day });
    }
  }
  return out;
}

export function startReminders(shell: Shell, signal: AbortSignal): void {
  const file = recordFile(shell.fs, CALENDAR_PATH, parseIcs, writeIcs);
  let events: CalEvent[] = [];
  const load = () => file.load().then(list => (events = list), () => (events = []));
  const check = () => {
    const now = Date.now();
    const due = dueReminders(events, now, shell.session.data.remindedUntil);
    const today = dateKey(new Date(now));
    for (const { event, day } of due) {
      const [Y, M, D] = day.split('-').map(Number);
      const dayLabel = day === addDays(today, 1) ? 'Tomorrow' : new Date(Y, M - 1, D).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      const when = day === today ? timeLabel(event) : `${dayLabel}, ${timeLabel(event)}`;
      shell.notify(event.title, `${when}${event.notes ? ' · ' + event.notes.split('\n')[0].slice(0, 120) : ''}`, { label: 'Open Calendar', run: () => void shell.openApp('calendar') });
    }
    // Written only when something was shown, so the settings file is not saved every 30 seconds.
    if (due.length) {
      shell.session.data.remindedUntil = now;
      shell.session.touch();
    }
  };
  void load().then(check);
  file.watch(shell.changes, signal, list => {
    events = list;
    check();
  });
  const timer = window.setInterval(check, 30000);
  signal.addEventListener('abort', () => clearInterval(timer), { once: true });
}
