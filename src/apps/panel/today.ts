// The Panel Overview's Today tile: where each of today's events stands against the clock (to come, on now, over).
// Pure, so the tests can give it any time.
import { dateKey, type CalEvent } from '../../core/ical.ts';

/** Minutes from now to the start of an event's showing on `day` (negative once started), or null for all-day events. */
export function minutesTo(e: CalEvent, day: string, now: Date): number | null {
  if (!e.start) return null;
  return minutesOf(day, e.start) - minutesOf(dateKey(now), clockOf(now));
}

/** Minutes from now to the end of an event's showing on `day` (negative once over): on its last day when that is a
 *  later one (past midnight), an hour after the start when it gives no end. */
export function endsIn(e: CalEvent, day: string, now: Date): number {
  if (!e.end) return 60 + (minutesTo(e, day, now) ?? 0);
  return minutesOf(e.endDate && e.endDate > day ? e.endDate : day, e.end) - minutesOf(dateKey(now), clockOf(now));
}

/** How the showing on `day` of a timed event stands now: `to` the minutes to its start (null for all day), on now,
 *  or over. */
export function standing(e: CalEvent, day: string, now: Date): { to: number | null; live: boolean; done: boolean } {
  const to = minutesTo(e, day, now);
  const left = endsIn(e, day, now);
  return { to, live: to !== null && to <= 0 && left > 0, done: to !== null && left <= 0 };
}

const two = (n: number) => String(n).padStart(2, '0');
const clockOf = (d: Date) => `${two(d.getHours())}:${two(d.getMinutes())}`;

/** Minutes from a fixed day to this day and time: day lengths taken as 24 hours, as the clock on the wall reads. */
function minutesOf(day: string, time: string): number {
  const [y, m, d] = day.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return Date.UTC(y, m - 1, d) / 60000 + hh * 60 + mm;
}
