// My Projects and the calendar fields it needs: daily repeats, "run for N days" (COUNT), "stop repeating" (UNTIL), a
// place (LOCATION) and the project link, each read, written once, and kept through a Calendar save; the projects file;
// the settings and the button list; and the event a filled-in window makes.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, eventsOn, nextShowing, occursOn, parseIcs, repeatLabel, repeatsAfter, stopRepeating, writeIcs, type CalEvent } from '../src/core/ical.ts';
import {
  DEFAULT_ACTIONS, actionProblem, cleanActions, cleanSettings, endAfter, entryFrom, entryTitle, moveAction, newProject, parseProjects,
  projectEntries, removeAction, shortTitle, siteHref, sortProjects, writeProjects, type EntryForm,
} from '../src/apps/projects/data.ts';

const ev = (fields: Partial<CalEvent>): CalEvent => ({ uid: 'u1', title: 'T', date: '2026-10-16', start: '09:00', end: '', notes: '', repeat: 'none', remind: 0, ...fields });
const lines = (ics: string, name: string) => ics.split('\r\n').filter(l => l.startsWith(name + ':') || l.startsWith(name + ';'));
const roundTrip = (e: CalEvent) => parseIcs(writeIcs([e]))[0];

test('daily, run for N days, until, where and project are written once each and read back', () => {
  const e = ev({ repeat: 'daily', count: 3, where: 'Cafe; corner, 2nd', project: 'p-123', notes: 'line 1\nline 2' });
  const ics = writeIcs([e]);
  assert.deepEqual(lines(ics, 'RRULE'), ['RRULE:FREQ=DAILY;COUNT=3']);
  assert.deepEqual(lines(ics, 'LOCATION'), ['LOCATION:Cafe\\; corner\\, 2nd']);
  assert.deepEqual(lines(ics, 'X-TOMLINOS-PROJECT'), ['X-TOMLINOS-PROJECT:p-123']);
  const back = roundTrip(e);
  assert.equal(back.repeat, 'daily');
  assert.equal(back.count, 3);
  assert.equal(back.where, 'Cafe; corner, 2nd');
  assert.equal(back.project, 'p-123');
  // A second save of what was read writes the same file (no line doubled by the kept-lines path).
  assert.equal(writeIcs([back]), ics);
  const u = roundTrip(ev({ repeat: 'daily', until: '2026-10-20' }));
  assert.equal(u.until, '2026-10-20');
  assert.deepEqual(lines(writeIcs([u]), 'RRULE'), ['RRULE:FREQ=DAILY;UNTIL=20261020T235959']);
  const allDay = writeIcs([ev({ start: '', repeat: 'weekly', until: '2026-12-01' })]);
  assert.deepEqual(lines(allDay, 'RRULE'), ['RRULE:FREQ=WEEKLY;UNTIL=20261201']);
});

test('a Calendar-app save (copy, change the title) keeps count, until, where and project', () => {
  const read = roundTrip(ev({ repeat: 'daily', count: 5, where: 'Office', project: 'abc' }));
  const changed: CalEvent = { ...read, title: 'Renamed' };
  const again = roundTrip(changed);
  assert.deepEqual([again.title, again.repeat, again.count, again.where, again.project], ['Renamed', 'daily', 5, 'Office', 'abc']);
  // Changing only the place writes the new one, never both.
  const moved = writeIcs([{ ...read, where: 'Library' }]);
  assert.deepEqual(lines(moved, 'LOCATION'), ['LOCATION:Library']);
  // Emptying it removes it.
  assert.deepEqual(lines(writeIcs([{ ...read, where: '' }]), 'LOCATION'), []);
});

const GOOGLE = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
  'BEGIN:VEVENT', 'DTSTART:20261012T140000Z', 'DTEND:20261012T150000Z', 'RRULE:FREQ=WEEKLY;BYDAY=MO;INTERVAL=1',
  'UID:g1@google.com', 'SUMMARY:Stand-up', 'LOCATION;LANGUAGE=en:Room 4\\, level 2', 'END:VEVENT', 'END:VCALENDAR', '',
].join('\r\n');

test('a file from another calendar with LOCATION keeps its own line (and its parameter) while unchanged', () => {
  const [e] = parseIcs(GOOGLE);
  assert.equal(e.where, 'Room 4, level 2');
  const out = writeIcs([e]);
  assert.deepEqual(lines(out, 'LOCATION'), ['LOCATION;LANGUAGE=en:Room 4\\, level 2']);
  assert.deepEqual(lines(out, 'RRULE'), ['RRULE:FREQ=WEEKLY;BYDAY=MO;INTERVAL=1']);
});

test('stop repeating on a file rule keeps its other parts and writes UNTIL in UTC for a UTC start', () => {
  const [e] = parseIcs(GOOGLE);
  const stopped = stopRepeating(e, '2026-11-02');
  assert.equal(stopped.until, '2026-11-02');
  const [rule] = lines(writeIcs([stopped]), 'RRULE');
  assert.match(rule, /^RRULE:FREQ=WEEKLY;BYDAY=MO;INTERVAL=1;UNTIL=\d{8}T\d{6}Z$/);
  // Read back, the last day is still 2 November here, and nothing after it shows.
  const back = parseIcs(writeIcs([stopped]))[0];
  assert.equal(back.until, '2026-11-02');
  assert.equal(occursOn(back, '2026-11-09'), false);
});

test('a daily rule from another calendar now shows every day (it showed only its first)', () => {
  const [e] = parseIcs('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:d\r\nDTSTART;VALUE=DATE:20261001\r\nRRULE:FREQ=DAILY;COUNT=2\r\nSUMMARY:x\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n');
  assert.equal(e.repeat, 'daily');
  assert.equal(e.count, 2);
  assert.deepEqual(['2026-10-01', '2026-10-02', '2026-10-03'].map(d => occursOn(e, d)), [true, true, false]);
});

test('repeats from other calendars show on their own days: every 2 weeks, Mon-Wed-Fri, a cancelled day, a rule it cannot show', () => {
  const read = (rule: string, extra = '', start = 'DTSTART;VALUE=DATE:20261102') =>
    parseIcs(`BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:r\r\n${start}\r\n${rule}\r\n${extra}SUMMARY:x\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`)[0];
  const on = (e: CalEvent, days: string[]) => days.map(d => occursOn(e, d));
  // 2 Nov 2026 is a Monday. Bins every second Monday.
  const bins = read('RRULE:FREQ=WEEKLY;INTERVAL=2');
  assert.deepEqual(on(bins, ['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30']), [true, false, true, false, true]);
  // Monday, Wednesday and Friday; six showings in all.
  const mwf = read('RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=6');
  assert.deepEqual(on(mwf, ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-06', '2026-11-09', '2026-11-11', '2026-11-13', '2026-11-16']), [true, false, true, true, true, true, true, false]);
  // Every 2 weeks on Tuesday and Thursday, the week starting on Sunday.
  const tt = read('RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;WKST=SU', '', 'DTSTART;VALUE=DATE:20261103');
  assert.deepEqual(on(tt, ['2026-11-03', '2026-11-05', '2026-11-10', '2026-11-12', '2026-11-17', '2026-11-19']), [true, true, false, false, true, true]);
  // Every other day; every 3 months; every 2 years.
  assert.deepEqual(on(read('RRULE:FREQ=DAILY;INTERVAL=2'), ['2026-11-03', '2026-11-04']), [false, true]);
  assert.deepEqual(on(read('RRULE:FREQ=MONTHLY;INTERVAL=3'), ['2026-12-02', '2027-01-02', '2027-02-02']), [false, false, true]);
  assert.deepEqual(on(read('RRULE:FREQ=YEARLY;INTERVAL=2'), ['2027-11-02', '2028-11-02']), [false, true]);
  // A cancelled day (EXDATE) does not show, as a date or as a time.
  assert.deepEqual(on(read('RRULE:FREQ=DAILY', 'EXDATE;VALUE=DATE:20261104,20261106\r\n'), ['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']), [true, false, true, false]);
  assert.deepEqual(on(read('RRULE:FREQ=DAILY', 'EXDATE:20261103T090000\r\n', 'DTSTART:20261102T090000'), ['2026-11-03', '2026-11-04']), [false, true]);
  // The second Tuesday of each month: not shown on the wrong days; its first day only, and the rule is kept as it was.
  const second = read('RRULE:FREQ=MONTHLY;BYDAY=2TU', '', 'DTSTART;VALUE=DATE:20261110');
  assert.deepEqual(on(second, ['2026-11-10', '2026-12-10', '2026-12-08']), [true, false, false]);
  assert.deepEqual(lines(writeIcs([second]), 'RRULE'), ['RRULE:FREQ=MONTHLY;BYDAY=2TU']);
  // Changed here to repeat daily: shown and written as plain daily.
  const daily = { ...bins, repeat: 'daily' as const };
  assert.deepEqual(on(daily, ['2026-11-03']), [true]);
  assert.deepEqual(lines(writeIcs([daily]), 'RRULE'), ['RRULE:FREQ=DAILY']);
});

test('eventsOn: repeat daily, run for 3 days, until', () => {
  const daily = ev({ uid: 'a', repeat: 'daily' });
  const three = ev({ uid: 'b', repeat: 'daily', count: 3 });
  const until = ev({ uid: 'c', repeat: 'daily', until: '2026-10-18' });
  const all = [daily, three, until];
  const on = (d: string) => eventsOn(all, d).map(e => e.uid).join('');
  assert.equal(on('2026-10-15'), '');
  assert.equal(on('2026-10-16'), 'abc');
  assert.equal(on('2026-10-18'), 'abc');
  assert.equal(on('2026-10-19'), 'a');
  assert.equal(on('2027-10-19'), 'a');
});

test('counts on monthly (31st skips short months) and yearly (29 February skips other years)', () => {
  const m = ev({ date: '2026-01-31', repeat: 'monthly', count: 3 });
  // Shows Jan 31, Mar 31, May 31 (no 31st in February or April).
  assert.deepEqual(['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31'].map(d => occursOn(m, d)), [true, true, true, false]);
  const y = ev({ date: '2028-02-29', repeat: 'yearly', count: 2 });
  assert.deepEqual(['2028-02-29', '2032-02-29', '2036-02-29'].map(d => occursOn(y, d)), [true, true, false]);
  const w = ev({ repeat: 'weekly', count: 2 });
  assert.deepEqual(['2026-10-16', '2026-10-23', '2026-10-30'].map(d => occursOn(w, d)), [true, true, false]);
});

test('next showing, repeats after, stop repeating', () => {
  const daily = ev({ date: '2026-10-10', repeat: 'daily' });
  assert.equal(nextShowing(daily, '2026-10-14'), '2026-10-14');
  assert.equal(repeatsAfter(daily, '2026-10-14'), true);
  const stopped = stopRepeating(daily, '2026-10-14');
  assert.deepEqual([stopped.until, stopped.count], ['2026-10-14', 0]);
  assert.equal(occursOn(stopped, '2026-10-14'), true);
  assert.equal(occursOn(stopped, '2026-10-15'), false);
  assert.equal(repeatsAfter(stopped, '2026-10-14'), false);
  // A run that already ended is left as it is (stopping must never lengthen it).
  const ran = ev({ date: '2026-10-01', repeat: 'daily', count: 3 });
  assert.equal(stopRepeating(ran, '2026-10-14'), ran);
  // A run still going is cut at today.
  const going = ev({ date: '2026-10-13', repeat: 'daily', count: 5 });
  const cut = stopRepeating(going, '2026-10-14');
  assert.deepEqual([cut.count, cut.until], [0, '2026-10-14']);
  // Not started yet: only its first day stays.
  const later = stopRepeating(ev({ date: '2026-10-20', repeat: 'daily' }), '2026-10-14');
  assert.equal(later.until, '2026-10-20');
  assert.equal(nextShowing(ev({ date: '2026-10-01' }), '2026-10-14'), null);
});

test('repeat labels', () => {
  assert.equal(repeatLabel({ repeat: 'none' }), '');
  assert.equal(repeatLabel({ repeat: 'daily' }), 'Every day');
  assert.equal(repeatLabel({ repeat: 'daily', count: 3 }), 'Every day, for 3 days');
  assert.match(repeatLabel({ repeat: 'weekly', until: '2026-10-17' }), /^Every week, until .*2026/);
});

test('Projects.json: shape, junk dropped, a damaged file refused (so never saved over)', () => {
  const p = newProject('  Word upgrade ', ' tomlinos.com ', 'notes', 1000);
  assert.deepEqual(Object.keys(p).sort(), ['created', 'finished', 'focus', 'name', 'notes', 'site', 'uid']);
  assert.equal(p.name, 'Word upgrade');
  assert.equal(p.site, 'tomlinos.com');
  const text = writeProjects([p, { ...p, uid: 'second', name: 'Corner Bakery', focus: true, extra: 'x' } as never]);
  const back = parseProjects(text);
  assert.equal(back.length, 2);
  assert.equal('extra' in back[1], false);
  assert.deepEqual(sortProjects(back).map(x => x.name), ['Corner Bakery', 'Word upgrade']);
  // No name, no id, a repeated id: dropped.
  assert.equal(parseProjects(JSON.stringify([{ uid: 'a' }, { name: 'x' }, { uid: 'b', name: 'B' }, { uid: 'b', name: 'B2' }])).length, 1);
  assert.deepEqual(parseProjects(''), []);
  assert.throws(() => parseProjects('{"not":"a list"}'));
  assert.throws(() => parseProjects('[{"uid":'));
});

test('settings: defaults, cleaning, and the button list (the last one cannot be removed)', () => {
  const d = cleanSettings(undefined);
  assert.deepEqual(d, { time: '09:00', hours: 0, day: 'tomorrow', remind: 0, actions: DEFAULT_ACTIONS });
  const odd = cleanSettings({ time: '25:00', hours: -2, day: 'yesterday', remind: 7, actions: ['  A ', 'a', '', 5, 'B'] });
  assert.deepEqual(odd, { time: '09:00', hours: 0, day: 'tomorrow', remind: 0, actions: ['A', 'B'] });
  assert.equal(cleanSettings({ hours: 1.3, day: 'today', remind: 60 }).hours, 1.25);
  assert.deepEqual(cleanActions([]), DEFAULT_ACTIONS);
  assert.deepEqual(moveAction(['a', 'b', 'c'], 2, -1), ['a', 'c', 'b']);
  assert.deepEqual(moveAction(['a', 'b'], 0, -1), ['a', 'b']);
  assert.deepEqual(removeAction(['a', 'b'], 0), ['b']);
  assert.equal(removeAction(['a'], 0), null);
  assert.equal(actionProblem(['Add to calendar'], 'add to CALENDAR'), 'There is a “add to CALENDAR” button already.');
  assert.equal(actionProblem(['Add to calendar'], 'Add to calendar', 0), null);
  assert.match(actionProblem([], '  ') ?? '', /name/);
});

const form = (f: Partial<EntryForm>): EntryForm => ({ title: 'Add new feature: Word upgrade', day: '2026-10-17', allDay: false, start: '09:00', hours: '', daily: false, runDays: 0, remind: 0, notes: '', ...f });

test('the event a filled-in window makes', () => {
  const e = entryFrom(form({ project: 'p1', notes: 'bring the list\n\n' }), 'id1') as CalEvent;
  assert.deepEqual({ ...e }, { uid: 'id1', title: 'Add new feature: Word upgrade', date: '2026-10-17', start: '09:00', end: '', notes: 'bring the list', repeat: 'none', remind: 0, project: 'p1' });
  assert.equal((entryFrom(form({ hours: '2.5' })) as CalEvent).end, '11:30');
  assert.match(entryFrom(form({ start: '22:00', hours: '3' })) as string, /past midnight/);
  assert.match(entryFrom(form({ hours: 'abc' })) as string, /Hours/);
  const run = entryFrom(form({ runDays: 3 })) as CalEvent;
  assert.deepEqual([run.repeat, run.count], ['daily', 3]);
  assert.equal((entryFrom(form({ daily: true })) as CalEvent).repeat, 'daily');
  assert.match(entryFrom(form({ daily: true, runDays: 3 })) as string, /not both/);
  assert.match(entryFrom(form({ runDays: 1 })) as string, /2 to/);
  // Run for ticked with the number box empty or not a number: said, not saved as a one-off.
  assert.match(entryFrom(form({ runDays: Number.NaN })) as string, /2 to/);
  assert.match(entryFrom(form({ daily: true, runDays: Number.NaN })) as string, /not both/);
  assert.match(entryFrom(form({ title: '  ' })) as string, /What/);
  const allDay = entryFrom(form({ allDay: true, start: '', hours: '3' })) as CalEvent;
  assert.deepEqual([allDay.start, allDay.end], ['', '']);
  const meet = entryFrom(form({ title: 'Meet Sam', where: ' Cafe ', project: undefined })) as CalEvent;
  assert.deepEqual([meet.where, meet.project], ['Cafe', undefined]);
  assert.equal(endAfter('23:00', 1), null);
});

test('titles, links, and a project entries split into coming up and its log', () => {
  assert.equal(entryTitle('Add to calendar', { name: 'Corner Bakery' }), 'Corner Bakery');
  assert.equal(entryTitle('Audit and review', { name: 'Corner Bakery' }), 'Audit and review: Corner Bakery');
  assert.equal(shortTitle({ title: 'Audit and review: Corner Bakery' }, { name: 'Corner Bakery' }), 'Audit and review');
  assert.equal(shortTitle({ title: 'Corner Bakery' }, { name: 'Corner Bakery' }), '');
  assert.equal(shortTitle({ title: 'Meet Sam' }, { name: 'Corner Bakery' }), 'Meet Sam');
  assert.equal(siteHref('example.com'), 'https://example.com/');
  assert.equal(siteHref('http://x.org/a'), 'http://x.org/a');
  assert.equal(siteHref('javascript:alert(1)'), null);
  assert.equal(siteHref('ftp://localhost'), null);
  assert.equal(siteHref('just words'), null);
  const today = '2026-10-14';
  const events = [
    ev({ uid: 'old', date: '2026-10-01', project: 'p', notes: 'first look' }),
    ev({ uid: 'older', date: '2026-09-20', project: 'p' }),
    ev({ uid: 'run', date: '2026-10-12', repeat: 'daily', project: 'p' }),
    ev({ uid: 'next', date: addDays(today, 3), project: 'p' }),
    ev({ uid: 'now', date: today, start: '07:00', project: 'p' }),
    ev({ uid: 'other', date: addDays(today, 1), project: 'q' }),
  ];
  const { coming, past } = projectEntries(events, 'p', today);
  assert.deepEqual(coming.map(c => [c.event.uid, c.next]), [['now', today], ['run', today], ['next', '2026-10-17']]);
  assert.deepEqual(past.map(e => e.uid), ['run', 'old', 'older']);
});
