// Importing an .ics file into the Calendar (core/ical.ts importEvents) and the Calendar's other calendars
// (apps/calendar-sources.ts): what is added, what was already there, what is left out and why, and that every line of
// an imported event is written back as it was.
// Run: node --test test/calendar-import.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarName, importEvents, importSummary, parseIcs, writeIcs } from '../src/core/ical.ts';
import { readLines } from '../src/core/lines.ts';
import { defaultSettings, fetchedLabel, isDue, linkSite, normaliseLink, readSettings, writeSettings } from '../src/apps/calendar-sources.ts';

const CRLF = (lines: string[]) => lines.join('\r\n') + '\r\n';

// As Google Calendar writes an export: a time zone, an alarm, guests, a weekly rule with a skipped day and one moved
// showing, a long folded description, a to-do, a cancelled event and one with no start.
const GOOGLE = CRLF([
  'BEGIN:VCALENDAR', 'PRODID:-//Google Inc//Google Calendar 70.9054//EN', 'VERSION:2.0', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
  'X-WR-CALNAME:Work', 'X-WR-TIMEZONE:Australia/Sydney',
  'BEGIN:VTIMEZONE', 'TZID:Australia/Sydney', 'X-LIC-LOCATION:Australia/Sydney',
  'BEGIN:STANDARD', 'TZOFFSETFROM:+1100', 'TZOFFSETTO:+1000', 'TZNAME:AEST', 'DTSTART:19700405T030000', 'RRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=1SU', 'END:STANDARD',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+1000', 'TZOFFSETTO:+1100', 'TZNAME:AEDT', 'DTSTART:19701004T020000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=1SU', 'END:DAYLIGHT',
  'END:VTIMEZONE',
  'BEGIN:VEVENT', 'DTSTART;TZID=Australia/Sydney:20261102T090000', 'DTEND;TZID=Australia/Sydney:20261102T100000',
  'RRULE:FREQ=WEEKLY;BYDAY=MO', 'EXDATE;TZID=Australia/Sydney:20261116T090000', 'DTSTAMP:20261101T000000Z', 'UID:weekly-sync@google.com',
  'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Sam Sample:mailto:sam@example.com', 'ORGANIZER;CN=Robin:mailto:robin@example.com',
  'CREATED:20261020T000000Z',
  'DESCRIPTION:A long description that goes on for well over seventy-five characters so that Google folds it on',
  '  to a second line\\, with a comma.', 'LAST-MODIFIED:20261021T000000Z', 'LOCATION:Level 3\\, 1 Sample Street', 'SEQUENCE:2', 'STATUS:CONFIRMED', 'SUMMARY:Weekly sync', 'TRANSP:OPAQUE',
  'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:This is an event reminder', 'TRIGGER:-P0DT0H10M0S', 'END:VALARM',
  'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART;TZID=Australia/Sydney:20261124T090000', 'DTEND;TZID=Australia/Sydney:20261124T100000', 'UID:weekly-sync@google.com',
  'RECURRENCE-ID;TZID=Australia/Sydney:20261123T090000', 'SUMMARY:Weekly sync (moved)', 'SEQUENCE:3', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20261225', 'DTEND;VALUE=DATE:20261226', 'UID:xmas@google.com', 'SUMMARY:Christmas lunch', 'X-GOOGLE-CONFERENCE:https://meet.example/abc', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART:20261201T010000Z', 'UID:cancelled@google.com', 'STATUS:CANCELLED', 'SUMMARY:Called off', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:nostart@google.com', 'SUMMARY:No start', 'END:VEVENT',
  'BEGIN:VTODO', 'UID:todo@google.com', 'SUMMARY:Buy milk', 'END:VTODO',
  'END:VCALENDAR',
]);

/** Each event's lines in a file (unfolded, as read), by UID and RECURRENCE-ID. */
function eventLines(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let cur: string[] | null = null;
  let depth = 0;
  for (const l of readLines(text)) {
    if (l.name === 'BEGIN' && l.value === 'VEVENT' && depth === 1) cur = [];
    else if (l.name === 'END' && l.value === 'VEVENT' && cur) {
      const id = `${cur.find(x => x.startsWith('UID'))}|${cur.find(x => x.startsWith('RECURRENCE-ID')) ?? ''}`;
      out.set(id, cur.sort());
      depth--;
      cur = null;
      continue;
    } else if (cur) cur.push(l.raw);
    if (l.name === 'BEGIN') depth++;
    else if (l.name === 'END') depth--;
  }
  return out;
}

test('an import says how many were added, and what was left out and why', () => {
  const { list, report } = importEvents([], GOOGLE);
  assert.equal(report.added, 3);
  assert.equal(report.already, 0);
  assert.deepEqual(report.leftOut, [
    { why: 'it is cancelled in the other calendar', count: 1 },
    { why: 'its start date could not be read', count: 1 },
    { why: 'it is a to-do, not calendar events', count: 1 },
  ]);
  assert.equal(list.length, 3);
  assert.deepEqual(importSummary(report), [
    '3 events added.',
    '1 item left out: it is cancelled in the other calendar.',
    '1 item left out: its start date could not be read.',
    '1 item left out: it is a to-do, not calendar events.',
  ]);
});

test('importing the same file again adds nothing: every event is already there', () => {
  const first = importEvents([], GOOGLE).list;
  const saved = writeIcs(first, null);
  const { list, report } = importEvents(parseIcs(saved), GOOGLE);
  assert.equal(report.added, 0);
  assert.equal(report.already, 3);
  assert.equal(list.length, 3);
  assert.match(importSummary(report)[1], /^3 events were already in your calendar/);
});

test('every line of an imported event is written back as it was, with the time zone it names', () => {
  const own = CRLF(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TomlinOS//Calendar//EN', 'X-WR-CALNAME:Mine',
    'BEGIN:VEVENT', 'UID:mine-1', 'SUMMARY:Dentist', 'DTSTART:20261203T140000', 'END:VEVENT', 'END:VCALENDAR']);
  const { list } = importEvents(parseIcs(own), GOOGLE);
  const out = writeIcs(list, own);
  const was = eventLines(GOOGLE);
  const now = eventLines(out);
  for (const [id, lines] of was) {
    if (/cancelled|nostart/.test(id)) continue;
    assert.deepEqual(now.get(id), lines, `the lines of ${id}`);
  }
  // The calendar's own name stays this calendar's; the imported time zone comes along, once.
  assert.equal(calendarName(out), 'Mine');
  assert.equal(out.match(/BEGIN:VTIMEZONE/g)?.length, 1);
  assert.match(out, /TZID:Australia\/Sydney\r\n/);
  assert.ok(now.has('UID:mine-1|'));
  // And it reads back the same: the moved showing still replaces the 23rd, the skipped 16th stays skipped.
  const again = parseIcs(out);
  assert.equal(again.length, 4);
  // Imported a second time over the written file, nothing changes.
  const twice = writeIcs(importEvents(again, GOOGLE).list, out);
  assert.equal(twice, out);
});

test('a moved showing of a repeat that is cancelled comes in with its repeat (it keeps that day empty)', () => {
  const text = CRLF(['BEGIN:VCALENDAR', 'VERSION:2.0',
    'BEGIN:VEVENT', 'UID:r@x', 'DTSTART:20261102T090000', 'RRULE:FREQ=DAILY;COUNT=5', 'SUMMARY:Run', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:r@x', 'RECURRENCE-ID:20261103T090000', 'DTSTART:20261103T090000', 'STATUS:CANCELLED', 'SUMMARY:Run', 'END:VEVENT',
    'END:VCALENDAR']);
  const { report } = importEvents([], text);
  assert.equal(report.added, 2);
  assert.deepEqual(report.leftOut, []);
});

test('a file with nothing in it imports nothing and says so', () => {
  const { report } = importEvents([], CRLF(['BEGIN:VCALENDAR', 'VERSION:2.0', 'END:VCALENDAR']));
  assert.deepEqual(importSummary(report), ['No events added.']);
});

test('calendar links: webcal is https; other schemes and links with a password are refused', () => {
  assert.equal(normaliseLink('webcal://p01-caldav.icloud.com/published/2/abc'), 'https://p01-caldav.icloud.com/published/2/abc');
  assert.equal(normaliseLink(' https://calendar.google.com/calendar/ical/a%40b/private-x/basic.ics '), 'https://calendar.google.com/calendar/ical/a%40b/private-x/basic.ics');
  // Plain http is the server's to refuse (it allows only hosts its owner listed).
  assert.equal(normaliseLink('http://example.com/cal.ics'), 'http://example.com/cal.ics');
  assert.match((normaliseLink('ftp://example.com/cal.ics') as { problem: string }).problem, /Only web links/);
  assert.match((normaliseLink('https://me:pw@example.com/cal.ics') as { problem: string }).problem, /password/);
  assert.match((normaliseLink('not a link') as { problem: string }).problem, /not a web address/);
  assert.equal(linkSite('https://calendar.google.com/calendar/ical/secret/basic.ics'), 'calendar.google.com');
});

test('the calendar settings: anything broken in the file gets its usual value', () => {
  const s = readSettings(JSON.stringify({
    own: { colour: '#ff0000', shown: false },
    subscriptions: [
      { id: 'ok-1', name: 'Work', url: 'webcal://example.com/a.ics', colour: 'teal', shown: true, every: 24, fetched: 5, problem: '' },
      { id: 'ok-1', name: 'Same id again', url: 'https://example.com/b.ics' },
      { id: '../../etc', name: 'Bad id', url: 'https://example.com/c.ics' },
      { id: 'ftp-1', name: 'Plain', url: 'ftp://example.com/d.ics' },
      { id: 'odd-1', url: 'https://example.com/e.ics', every: 3, colour: 'chartreuse' },
    ],
    holidays: { region: 'AU-XX', publicOn: true, schoolOn: 'yes' },
  }));
  assert.deepEqual(s.own, { colour: 'blue', shown: false });
  assert.deepEqual(s.subscriptions.map(x => [x.id, x.url, x.colour, x.every]), [['ok-1', 'https://example.com/a.ics', 'teal', 24], ['odd-1', 'https://example.com/e.ics', 'purple', 6]]);
  assert.equal(s.holidays.region, '');
  assert.equal(s.holidays.schoolOn, false);
  assert.deepEqual(readSettings('{not json'), defaultSettings());
  assert.deepEqual(readSettings(writeSettings(s)), s);
});

test('a subscription is due when never fetched or when its time has come', () => {
  const base = { id: 'a', name: 'A', url: 'https://x.example/a.ics', colour: 'blue', shown: true, every: 6, problem: '' };
  const now = Date.UTC(2026, 10, 28, 12);
  assert.equal(isDue({ ...base, fetched: 0 }, now), true);
  assert.equal(isDue({ ...base, fetched: now - 5 * 3600_000 }, now), false);
  assert.equal(isDue({ ...base, fetched: now - 6 * 3600_000 }, now), true);
  assert.equal(fetchedLabel({ ...base, fetched: now - 5 * 60_000 }, now), 'Updated 5 minutes ago');
  assert.equal(fetchedLabel({ ...base, fetched: 0 }, now), 'Not fetched yet');
});
