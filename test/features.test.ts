// Calendar and contact files, file search, and web links: the parts that need no browser.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventsOn, occursOn, parseIcs, reminderAt, writeIcs, type CalEvent } from '../src/core/ical.ts';
import { parseVcf, writeVcf, emptyContact } from '../src/core/vcard.ts';
import { FileSystem } from '../src/fs/fs.ts';
import { MemoryStore } from '../src/store/memory-store.ts';
import { searchFiles, snippetOf, type SearchHit } from '../src/shell/search.ts';
import { linkTarget, webAddress } from '../src/apps/link.ts';
import { parseSession } from '../src/shell/session.ts';

const ev = (over: Partial<CalEvent>): CalEvent => ({ uid: 'u1', title: 'Pruning, Smith; "garden"', date: '2026-09-26', start: '09:30', end: '11:00', notes: 'Line one\nLine two, with comma', repeat: 'none', remind: 15, ...over });

test('an event survives writing and reading back, commas, semicolons and new lines included', () => {
  const e = ev({});
  const back = parseIcs(writeIcs([e, ev({ uid: 'u2', start: '', end: '', repeat: 'yearly', remind: -1, title: 'Birthday' })]));
  assert.deepEqual(back[0], e);
  assert.equal(back[1].start, '');
  assert.equal(back[1].repeat, 'yearly');
});

test('an .ics from another program: folded lines, all-day dates, UTC stamps and unknown fields', () => {
  const text = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x@y\r\nSUMMARY:A very long title that some programs fold on\r\n  to the next line\r\nDTSTART;VALUE=DATE:20261225\r\nX-UNKNOWN:ignored\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nSUMMARY:No date\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  const list = parseIcs(text);
  assert.equal(list.length, 1, 'an event with no date is skipped, not fatal');
  assert.equal(list[0].title, 'A very long title that some programs fold on to the next line');
  assert.equal(list[0].date, '2026-12-25');
  assert.equal(list[0].start, '');
});

test('repeats land on the right days, never before the first', () => {
  assert.ok(occursOn(ev({ repeat: 'weekly' }), '2026-10-03'));
  assert.ok(!occursOn(ev({ repeat: 'weekly' }), '2026-10-04'));
  assert.ok(!occursOn(ev({ repeat: 'weekly' }), '2026-09-19'));
  assert.ok(occursOn(ev({ repeat: 'monthly' }), '2027-02-26'));
  assert.ok(!occursOn(ev({ repeat: 'monthly', date: '2026-01-31' }), '2026-02-28'), 'the 31st skips short months');
  assert.ok(occursOn(ev({ repeat: 'yearly' }), '2030-09-26'));
  assert.deepEqual(eventsOn([ev({ uid: 'b', start: '14:00' }), ev({ uid: 'a', start: '' })], '2026-09-26').map(e => e.uid), ['a', 'b']);
});

test('a reminder falls the chosen minutes before the start; all-day ones at 09:00', () => {
  assert.equal(reminderAt(ev({}), '2026-09-26'), new Date(2026, 8, 26, 9, 15).getTime());
  assert.equal(reminderAt(ev({ start: '', remind: 0 }), '2026-09-26'), new Date(2026, 8, 26, 9, 0).getTime());
  assert.equal(reminderAt(ev({ remind: -1 }), '2026-09-26'), null);
});

test('a contact survives writing and reading back; a phone export with N only and typed fields reads', () => {
  const c = { ...emptyContact(), name: 'Jane O\'Neil; Gardener', org: 'Gardens, Ltd', phones: ['+61 400 000 000', '02 9999 9999'], emails: ['jane@example.com'], address: '1 Key St, Sydney', birthday: '1980-02-29', notes: 'Prefers\nmornings' };
  assert.deepEqual(parseVcf(writeVcf([c]))[0], c);
  const phone = parseVcf('BEGIN:VCARD\nVERSION:2.1\nN:Smith;John;;;\nTEL;CELL;PREF:0411 111 111\nEMAIL;TYPE=INTERNET:j@s.com\nBDAY:19700101\nEND:VCARD\n');
  assert.equal(phone[0].name, 'John Smith');
  assert.deepEqual(phone[0].phones, ['0411 111 111']);
  assert.equal(phone[0].birthday, '1970-01-01');
});

test('search finds by name and inside text files, in folders below, but never hidden items', async () => {
  const fs = new FileSystem(new MemoryStore());
  await fs.ensureFolder('/Documents/Invoices');
  await fs.writeText('/Documents/Invoices/March invoice.txt', 'Total due');
  await fs.writeText('/Documents/notes.txt', 'first line\nthe magnolia needs a hard prune\nlast');
  await fs.writeText('/Documents/photo.png', 'magnolia in binary');
  await fs.ensureFolder('/System', { hidden: true });
  await fs.writeText('/System/secret.txt', 'magnolia', { hidden: true });
  const run = async (q: string, contents: boolean, root = '/') => {
    const hits: SearchHit[] = [];
    await searchFiles(fs, root, q, { contents, signal: new AbortController().signal, onHit: h => hits.push(h) });
    return hits;
  };
  assert.deepEqual((await run('invoice march', false)).map(h => h.path), ['/Documents/Invoices/March invoice.txt']);
  assert.deepEqual((await run('invoices', false)).map(h => h.kind), ['folder']);
  const inside = await run('magnolia', true);
  assert.deepEqual(inside.map(h => h.path), ['/Documents/notes.txt'], 'pictures and hidden files are not read');
  assert.equal(inside[0].snippet, 'the magnolia needs a hard prune');
  assert.deepEqual(await run('magnolia', false), []);
  assert.deepEqual((await run('invoice', false, '/Pictures').catch(() => [])), []);
});

test('a snippet is cut around the match on its own line', () => {
  const long = 'x'.repeat(200) + ' needle ' + 'y'.repeat(200);
  const s = snippetOf(long, ['needle']);
  assert.ok(s.startsWith('…') && s.endsWith('…') && s.includes('needle'));
});

test('web links only follow http and https', () => {
  assert.equal(linkTarget('[InternetShortcut]\r\nURL=https://www.youtube.com/watch?v=1\r\n')?.hostname, 'www.youtube.com');
  assert.equal(linkTarget('[InternetShortcut]\nURL=javascript:alert(1)\n'), null);
  assert.equal(linkTarget('URL=file:///C:/Windows'), null);
  assert.equal(webAddress('youtube.com'), null, 'a bare name is not guessed at');
});

test('the colour scheme is remembered, and a damaged value falls back to Xfce (the default)', () => {
  assert.equal(parseSession({ theme: 'dark' }).theme, 'dark');
  assert.equal(parseSession({ theme: 'hotpink' }).theme, 'xfce');
});

test('reminders: a day-before reminder for tomorrow fires today; nothing twice; nothing stale', async () => {
  const { dueReminders } = await import('../src/shell/reminders.ts');
  const now = new Date(2026, 8, 26, 10, 0).getTime();
  const tomorrow = ev({ uid: 't', date: '2026-09-27', start: '10:00', remind: 1440 });
  const today = ev({ uid: 'n', date: '2026-09-26', start: '10:05', remind: 5 });
  const stale = ev({ uid: 's', date: '2026-09-26', start: '08:00', remind: 0 });
  assert.deepEqual(dueReminders([tomorrow, today, stale], now, 0).map(r => r.event.uid).sort(), ['n', 't']);
  assert.deepEqual(dueReminders([tomorrow, today], now, now), [], 'already shown up to now');
  const nearMidnight = ev({ uid: 'm', date: '2026-09-27', start: '00:30', remind: 60 });
  assert.deepEqual(dueReminders([nearMidnight], new Date(2026, 8, 26, 23, 31).getTime(), 0).map(r => r.day), ['2026-09-27']);
});

test('the AI-history choice is kept only when it is one of the offered ones', () => {
  assert.equal(parseSession({}).aiHistoryDays, 0, 'kept until deleted, unless chosen');
  assert.equal(parseSession({ aiHistoryDays: 7 }).aiHistoryDays, 7);
  assert.equal(parseSession({ aiHistoryDays: 5 }).aiHistoryDays, 0);
  assert.equal(parseSession({ aiHistoryDays: '30' }).aiHistoryDays, 0);
});

test('the lock keys on the desktop background are off unless chosen', () => {
  assert.equal(parseSession({}).lock.hint, undefined);
  assert.equal(parseSession({ lock: { hint: true } }).lock.hint, true);
  assert.equal(parseSession({ lock: { hint: 'yes' } }).lock.hint, undefined);
});
