// Audit of the Calendar's events (core/ical.ts): faults found by trying to break it. Each test that fails names a
// fault still open; a test marked todo is a lesser fault (P1) and does not fail the suite.
// Run: node --test test/audit-calendar.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, eventsOn, eventsShownOn, occursOn, parseIcs, timeLabel, writeIcs, type CalEvent } from '../src/core/ical.ts';
import { dueReminders } from '../src/shell/reminders.ts';

const ics = (...events: string[][]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events.flatMap(e => ['BEGIN:VEVENT', ...e, 'END:VEVENT']), 'END:VCALENDAR', ''].join('\r\n');

/** Runs `fn` with this computer's clock in another zone. */
function inZone(zone: string, fn: () => void): void {
  const before = process.env.TZ;
  process.env.TZ = zone;
  try {
    fn();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

/** Every showing (day and start) from `from` for `n` days. */
function showings(events: CalEvent[], from: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const day = addDays(from, i);
    for (const e of eventsOn(events, day)) out.push(`${day} ${e.start}`);
  }
  return out;
}

test('CAL-P0-1: a weekly invite on Mondays (BYDAY, as Google writes it) from a zone a day ahead shows on the same weekday here every week', () => {
  inZone('America/Los_Angeles', () => {
    // Monday 09:00 in Sydney is Sunday 14:00 in Los Angeles, every week.
    const events = parseIcs(ics(['UID:w1', 'DTSTART;TZID=Australia/Sydney:20261102T090000', 'DTEND;TZID=Australia/Sydney:20261102T100000', 'RRULE:FREQ=WEEKLY;BYDAY=MO', 'SUMMARY:Sync']));
    assert.deepEqual(showings(events, '2026-10-31', 16), ['2026-11-01 14:00', '2026-11-08 14:00', '2026-11-15 14:00']);
  });
});

test('CAL-P0-2: a monthly event on the 1st from a zone ahead shows on the last day of each month here, short months included', () => {
  inZone('Europe/London', () => {
    // 1st of the month 08:00 in Tokyo is 23:00 on the last day of the month before, in London.
    const events = parseIcs(ics(['UID:m1', 'DTSTART;TZID=Asia/Tokyo:20261101T080000', 'RRULE:FREQ=MONTHLY', 'SUMMARY:Rent']));
    assert.deepEqual(showings(events, '2026-10-25', 130), ['2026-10-31 23:00', '2026-11-30 23:00', '2026-12-31 23:00', '2027-01-31 23:00', '2027-02-28 23:00']);
  });
});

test('CAL-P0-3: a repeat whose time here crosses midnight after a daylight-saving change moves to the next day, not to 00:30 on the day before', () => {
  inZone('America/New_York', () => {
    // 04:30 in London: 23:30 the day before in New York, but in the week London has left summer time and New York
    // has not (25 Oct to 1 Nov) it is 00:30 on the Monday itself.
    const events = parseIcs(ics(['UID:d1', 'DTSTART;TZID=Europe/London:20261012T043000', 'RRULE:FREQ=WEEKLY', 'SUMMARY:Early']));
    assert.deepEqual(eventsOn(events, '2026-10-25').map(e => e.start), [], 'nothing at 00:30 on Sunday 25 Oct');
    assert.deepEqual(eventsOn(events, '2026-10-26').map(e => e.start), ['00:30'], 'Monday 26 Oct 00:30');
  });
});

test('CAL-P0-4: a repeat ending at a moment (UNTIL in UTC) has no extra showing after that moment', () => {
  inZone('Australia/Sydney', () => {
    // Daily 09:00 London, until the end of 4 Nov UTC: the last showing is 4 Nov 09:00 London (20:00 4 Nov in Sydney).
    // 5 Nov 09:00 London is after the end, though 4 Nov 23:59:59 UTC is 5 Nov here.
    const events = parseIcs(ics(['UID:u1', 'DTSTART;TZID=Europe/London:20261101T090000', 'RRULE:FREQ=DAILY;UNTIL=20261104T235959Z', 'SUMMARY:Course']));
    assert.deepEqual(showings(events, '2026-10-31', 8), ['2026-11-01 20:00', '2026-11-02 20:00', '2026-11-03 20:00', '2026-11-04 20:00']);
  });
});

test('CAL-P0-5: moving the first day of a weekly event from another calendar (BYDAY=TU) to a Thursday makes it every Thursday', () => {
  const text = ics(['UID:g1', 'DTSTART:20261103T090000', 'DTEND:20261103T100000', 'RRULE:FREQ=WEEKLY;BYDAY=TU', 'SUMMARY:Weekly']);
  const [e] = parseIcs(text);
  // What the Calendar's form saves when only the first day is changed: the rest of the event as it was.
  const out = writeIcs([{ ...e, date: '2026-11-05' }], text);
  const back = parseIcs(out);
  assert.deepEqual(showings(back, '2026-11-01', 21), ['2026-11-05 09:00', '2026-11-12 09:00', '2026-11-19 09:00']);
});

test('CAL-P0-6: moving the first day of a monthly event that names its day (BYMONTHDAY) keeps it repeating after the file is read again', () => {
  const text = ics(['UID:g2', 'DTSTART;VALUE=DATE:20261115', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=15', 'SUMMARY:Rent']);
  const [e] = parseIcs(text);
  const back = parseIcs(writeIcs([{ ...e, date: '2026-11-20' }], text));
  assert.equal(back[0].repeat, 'monthly', 'still a monthly repeat in the form');
  assert.ok(occursOn(back[0], '2026-12-20'), 'shows on 20 December');
});

test('CAL-P0-7: a later showing of a repeating overnight event says the day it ends, not the first showing\'s end day', () => {
  inZone('Europe/London', () => {
    const events = parseIcs(ics(['UID:n1', 'DTSTART:20261012T220000', 'DTEND:20261013T010000', 'RRULE:FREQ=WEEKLY', 'SUMMARY:Night shift']));
    const first = eventsShownOn(events, '2026-10-12').map(timeLabel)[0];
    const later = eventsShownOn(events, '2026-10-19').map(timeLabel)[0];
    assert.match(first, /13/);
    assert.match(later, /20/, `the 19 Oct showing ends on 20 Oct, label was "${later}"`);
  });
});

test('CAL-P1-1: deleting a repeat "and all its repeats" also removes its moved showing', { todo: 'P1' }, () => {
  const text = ics(['UID:s', 'DTSTART:20261102T090000', 'RRULE:FREQ=DAILY;COUNT=5', 'SUMMARY:Series'], ['UID:s', 'RECURRENCE-ID:20261103T090000', 'DTSTART:20261103T150000', 'SUMMARY:Series moved']);
  const list = parseIcs(text);
  const series = list.find(e => e.repeat !== 'none')!;
  // What the Calendar's Delete does: drop the event by its id.
  const after = parseIcs(writeIcs(list.filter(x => x.uid !== series.uid), text));
  assert.deepEqual(after.map(e => e.title), []);
});

test('CAL-P1-2: a common monthly rule from Google or Outlook (the second Tuesday) shows every month, not only its first day', { todo: 'P1' }, () => {
  const events = parseIcs(ics(['UID:t2', 'DTSTART:20261110T090000', 'RRULE:FREQ=MONTHLY;BYDAY=2TU', 'SUMMARY:Board']));
  assert.ok(occursOn(events[0], '2026-12-08'));
});

test('CAL-P1-3: a reminder due just before midnight is still shown when the check runs just after it', () => {
  inZone('Europe/London', () => {
    const e: CalEvent = { uid: 'r', title: 'R', date: '2026-11-02', start: '23:59', end: '', notes: '', repeat: 'none', remind: 0 };
    assert.equal(dueReminders([e], new Date(2026, 10, 3, 0, 1).getTime(), 0).length, 1);
  });
});
