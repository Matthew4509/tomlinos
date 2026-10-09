// Calendar reminders. Reads the calendar file when the desktop starts and whenever it changes, and every 30 seconds
// shows any reminder that has fallen due: today's events, and tomorrow's for reminders set a day (or across midnight)
// ahead. Never a flood of old ones after a long time away: only those due in the last 10 minutes. The saved settings
// remember up to when reminders were shown, so a reload does not show the same one again.
import { CALENDAR_PATH } from '../core/ical.ts';
import { addDays, dateKey, eventsOn, parseIcs, reminderAt, timeLabel, writeIcs, type CalEvent } from '../core/ical.ts';
import { recordFile } from './recordfile.ts';
import type { Shell } from './types.ts';

const LATE_LIMIT = 10 * 60000;

/** The reminders due in (after, now], with the day of the showing each belongs to. Pure, for the tests. */
export function dueReminders(events: CalEvent[], now: number, after: number): Array<{ event: CalEvent; day: string }> {
  const today = dateKey(new Date(now));
  const out: Array<{ event: CalEvent; day: string }> = [];
  for (const day of [today, addDays(today, 1)]) {
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
    for (const { event, day } of due) {
      const when = day === dateKey(new Date(now)) ? timeLabel(event) : `Tomorrow, ${timeLabel(event)}`;
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
