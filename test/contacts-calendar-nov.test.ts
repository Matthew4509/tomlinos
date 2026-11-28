// November office-deep faults O16 to O24: cancelled imported events, the first showing of a series that skips it, a
// damaged contact card kept on save, a stale edit never reviving a deletion, unsaved-form protection in Contacts and
// Calendar, and the My Projects booking rules.
// Run: node --test test/contacts-calendar-nov.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventsOn, eventsShownOn, nextShowing, occursOn, parseIcs, writeIcs } from '../src/core/ical.ts';
import { parseVcf, writeVcf } from '../src/core/vcard.ts';
import { entryFrom, parseProjects, projectEntries, writeProjects, type EntryForm } from '../src/apps/projects/data.ts';

const ics = (...events: string[][]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events.flatMap(e => ['BEGIN:VEVENT', ...e, 'END:VEVENT']), 'END:VCALENDAR', ''].join('\r\n');

test('O16: a cancelled imported event is not shown or booked, and is written back as it was', () => {
  const text = ics(['UID:c1', 'DTSTART:20261110T090000', 'SUMMARY:Cancelled meeting', 'STATUS:CANCELLED']);
  const events = parseIcs(text);
  assert.equal(eventsOn(events, '2026-11-10').length, 0);
  assert.equal(eventsShownOn(events, '2026-11-10').length, 0);
  assert.equal(nextShowing(events[0], '2026-11-01'), null);
  assert.match(writeIcs(events, text), /STATUS:CANCELLED/);
});

test('O18: the next showing skips an excluded first day', () => {
  const [e] = parseIcs(ics(['UID:d1', 'DTSTART:20261110T090000', 'RRULE:FREQ=DAILY', 'EXDATE:20261110T090000', 'SUMMARY:Daily']));
  assert.equal(occursOn(e, '2026-11-10'), false);
  assert.equal(nextShowing(e, '2026-11-10'), '2026-11-11');
  assert.equal(nextShowing(e, '2026-11-05'), '2026-11-11');
});

test('O19: a damaged contact card is kept when another contact is saved', () => {
  const text = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:a\r\nFN:Alice\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:3.0\r\nUID:b\r\nFN:Bob\r\nTEL:123\r\n';
  const people = parseVcf(text);
  assert.deepEqual(people.map(p => p.name), ['Alice']);
  const out = writeVcf([...people, { ...people[0], uid: 'new', name: 'Carol', keep: undefined }], text);
  assert.match(out, /FN:Bob/);
  assert.match(out, /TEL:123/);
  assert.match(out, /FN:Carol/);
  // Written again from what was written, nothing grows or is lost.
  const again = writeVcf(parseVcf(out), out);
  assert.equal((again.match(/FN:Bob/g) ?? []).length, 1);
});

test('O19: a card cut off by the next BEGIN is kept too', () => {
  const text = 'BEGIN:VCARD\r\nFN:Cut\r\nBEGIN:VCARD\r\nUID:z\r\nFN:Zed\r\nEND:VCARD\r\n';
  assert.deepEqual(parseVcf(text).map(p => p.name), ['Zed']);
  assert.match(writeVcf(parseVcf(text), text), /FN:Cut/);
});

const form = (f: Partial<EntryForm>): EntryForm => ({ title: 'Visit', day: '2026-11-01', allDay: false, start: '09:00', hours: '', daily: false, runDays: 0, remind: 0, notes: '', ...f });

test('O22: an ongoing multi-day booking is coming, with its real end, not only past', () => {
  const e = entryFrom(form({ project: 'p', day: '2026-11-01', allDay: true }), 'v1');
  assert.ok(typeof e !== 'string');
  const ongoing = { ...e, endDate: '2026-11-04' };
  const { coming, past } = projectEntries([ongoing], 'p', '2026-11-02');
  assert.equal(coming.length, 1);
  assert.equal(coming[0].next, '2026-11-02');
  assert.equal(coming[0].event.endDate, '2026-11-04');
  assert.equal(past.length, 1);
  assert.equal(projectEntries([ongoing], 'p', '2026-11-05').coming.length, 0);
});

test('O23: a duration under a minute is refused', () => {
  assert.match(String(entryFrom(form({ hours: '0.001' }))), /minute/);
  assert.equal(typeof entryFrom(form({ hours: '0.25' })), 'object');
});

test('O24: two different projects with one id both survive and stay apart', () => {
  const list = parseProjects(JSON.stringify([{ uid: 'b', name: 'B' }, { uid: 'b', name: 'B2' }, { uid: 'b', name: 'B' }]));
  assert.deepEqual(list.map(p => p.name), ['B', 'B2']);
  assert.equal(new Set(list.map(p => p.uid)).size, 2);
  assert.equal(list[0].uid, 'b');
  const back = parseProjects(writeProjects(list));
  assert.deepEqual(back.map(p => [p.uid, p.name]), list.map(p => [p.uid, p.name]));
});

// Contacts and Calendar both have a classic menu bar now, which needs a real page (it measures and watches sizes),
// so their O20 and O21 checks run in Chrome: test/browser-contacts-groups.mjs and test/browser-calendar-subs.mjs.

test('O17: a repeating event written in another zone keeps its time there across a daylight-saving change, so it moves here', () => {
  const before = process.env.TZ;
  process.env.TZ = 'Australia/Sydney';
  try {
    const text = ics(['UID:z1', 'DTSTART;TZID=Europe/London:20261012T090000', 'DTEND;TZID=Europe/London:20261012T100000', 'RRULE:FREQ=WEEKLY', 'SUMMARY:London stand-up']);
    const events = parseIcs(text);
    const at = (day: string) => eventsOn(events, day).map(e => `${e.start}-${e.end}`);
    // London is on summer time (UTC+1) and Sydney on summer time (UTC+11): 09:00 there is 19:00 here.
    assert.deepEqual(at('2026-10-12'), ['19:00-20:00']);
    assert.deepEqual(at('2026-10-19'), ['19:00-20:00']);
    // London goes back to UTC on 25 October: the same 09:00 there is an hour later here.
    assert.deepEqual(at('2026-10-26'), ['20:00-21:00']);
    assert.deepEqual(at('2026-11-02'), ['20:00-21:00']);
    assert.deepEqual(eventsShownOn(events, '2026-11-02').map(e => e.start), ['20:00']);
    // Sydney goes back to winter time on 4 April 2027, London already on summer time again (28 March): 09:00 there is 18:00 here.
    assert.deepEqual(at('2027-03-22'), ['20:00-21:00']);
    assert.deepEqual(at('2027-04-12'), ['18:00-19:00']);
    // Only what is shown moves: the event itself, and what is written back, keep the first showing's time.
    assert.equal(events[0].start, '19:00');
    assert.equal(writeIcs(events, text), writeIcs(parseIcs(text), text));
    assert.match(writeIcs(events, text), /DTSTART;TZID=Europe\/London:20261012T090000/);
    // A showing opened to edit is the event itself, not the moved copy.
    assert.equal(eventsOn(events, '2026-11-02')[0].of, events[0]);
    // A UTC time repeats by the same rule; a time with no zone (a floating one) never moves.
    const utc = parseIcs(ics(['UID:z2', 'DTSTART:20261012T080000Z', 'RRULE:FREQ=WEEKLY', 'SUMMARY:UTC']));
    assert.deepEqual(eventsOn(utc, '2026-11-02').map(e => e.start), ['19:00']);
    const floating = parseIcs(ics(['UID:z3', 'DTSTART:20261012T090000', 'RRULE:FREQ=WEEKLY', 'SUMMARY:Floating']));
    assert.deepEqual(eventsOn(floating, '2026-11-02').map(e => e.start), ['09:00']);
  } finally {
    if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
  }
});
