// The Panel Overview's Today tile (src/apps/panel/today.ts): where an event stands against an injected clock, and a
// refresh that never drops a change made while one is under way.
// Run: node --test test/panel-today.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventsOn, parseIcs, type CalEvent } from '../src/core/ical.ts';
import { latestRun, standing } from '../src/apps/panel/today.ts';

const ev = (over: Partial<CalEvent>): CalEvent => ({ uid: 'x', title: 'X', date: '2026-11-02', start: '09:00', end: '10:00', notes: '', repeat: 'none', remind: -1, ...over });

test('PN-P1-3: an evening event that runs past midnight (23:00 to 01:00) is not shown as over before it starts', () => {
  const late = ev({ start: '23:00', end: '01:00', endDate: '2026-11-03' });
  assert.deepEqual(standing(late, '2026-11-02', new Date(2026, 10, 2, 20, 0)), { to: 180, live: false, done: false });
  assert.deepEqual(standing(late, '2026-11-02', new Date(2026, 10, 2, 23, 30)), { to: -30, live: true, done: false });
  assert.equal(standing(late, '2026-11-02', new Date(2026, 10, 3, 1, 0)).done, true);
});

test('PN-P1-3: a later showing of a weekly overnight event is placed on its own day', () => {
  const events = parseIcs(['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:n', 'DTSTART:20261102T230000', 'DTEND:20261103T010000', 'RRULE:FREQ=WEEKLY', 'SUMMARY:Night', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n'));
  const [shown] = eventsOn(events, '2026-11-09');
  assert.deepEqual(standing(shown, '2026-11-09', new Date(2026, 10, 9, 22, 0)), { to: 60, live: false, done: false });
  assert.deepEqual(standing(shown, '2026-11-09', new Date(2026, 10, 9, 23, 15)), { to: -15, live: true, done: false });
});

test('the Today tile: a daytime event is to come, on now, then over; one with no end lasts an hour; all day is neither', () => {
  const e = ev({});
  assert.deepEqual(standing(e, '2026-11-02', new Date(2026, 10, 2, 8, 50)), { to: 10, live: false, done: false });
  assert.deepEqual(standing(e, '2026-11-02', new Date(2026, 10, 2, 9, 30)), { to: -30, live: true, done: false });
  assert.equal(standing(e, '2026-11-02', new Date(2026, 10, 2, 10, 0)).done, true);
  assert.equal(standing(ev({ end: '' }), '2026-11-02', new Date(2026, 10, 2, 9, 59)).live, true);
  assert.equal(standing(ev({ end: '' }), '2026-11-02', new Date(2026, 10, 2, 10, 0)).done, true);
  assert.deepEqual(standing(ev({ start: '', end: '' }), '2026-11-02', new Date(2026, 10, 2, 12, 0)), { to: null, live: false, done: false });
});

test('PN-P1-4: two quick calendar changes: the refresh asked for during the first still runs, so the second is shown', async () => {
  let file = 'one';
  let shown = '';
  let release = () => {};
  let runs = 0;
  const refresh = latestRun(async () => {
    runs++;
    const read = file;
    if (runs === 1) await new Promise<void>(r => (release = r));
    shown = read;
  });
  const first = refresh();
  file = 'two';
  const second = refresh();
  const third = refresh();
  release();
  await Promise.all([first, second, third]);
  assert.equal(shown, 'two');
  assert.equal(runs, 2, 'asks made during one run make one more run, not one each');
  await refresh();
  assert.equal(runs, 3, 'a later ask runs again');
});
