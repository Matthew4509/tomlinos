// Calendar (.ics) and contact (.vcf) files from other programs: what this desktop does not edit is kept, times given in
// UTC or a named zone are shown as local time, records with no UID can still be edited and deleted, and long lines
// with emoji survive folding.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventsOn, eventsShownOn, parseIcs, timeLabel, writeIcs } from '../src/core/ical.ts';
import { emptyContact, parseVcf, writeVcf } from '../src/core/vcard.ts';
import { foldLine, readLines } from '../src/core/lines.ts';

const local = (ms: number) => {
  const t = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return { date: `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`, time: `${p(t.getHours())}:${p(t.getMinutes())}` };
};

const GOOGLE = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Google Inc//Google Calendar 70.9054//EN', 'X-WR-CALNAME:Work',
  'BEGIN:VTIMEZONE', 'TZID:Australia/Sydney', 'BEGIN:STANDARD', 'TZOFFSETFROM:+1100', 'TZOFFSETTO:+1000', 'DTSTART:19700405T030000', 'END:STANDARD', 'END:VTIMEZONE',
  'BEGIN:VEVENT', 'DTSTART:20261012T140000Z', 'DTEND:20261012T150000Z', 'RRULE:FREQ=WEEKLY;INTERVAL=2;UNTIL=20261231T000000Z;BYDAY=MO',
  'DTSTAMP:20261001T000000Z', 'UID:abc123@google.com', 'SUMMARY:Stand-up', 'LOCATION:Room 4\\, level 2',
  'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT10M', 'END:VALARM', 'END:VEVENT',
  'END:VCALENDAR', '',
].join('\r\n');

test('a UTC time from another calendar is shown as local time, not as the same digits', () => {
  const [e] = parseIcs(GOOGLE);
  const want = local(Date.UTC(2026, 9, 12, 14, 0));
  assert.equal(e.date, want.date);
  assert.equal(e.start, want.time);
  assert.equal(e.end, local(Date.UTC(2026, 9, 12, 15, 0)).time);
});

test('a time in a named zone is shown as local time; an unknown zone keeps its digits', () => {
  const ny = parseIcs('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:n\r\nDTSTART;TZID=America/New_York:20260115T090000\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n')[0];
  const want = local(Date.UTC(2026, 0, 15, 14, 0));
  assert.deepEqual([ny.date, ny.start], [want.date, want.time]);
  const odd = parseIcs('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:o\r\nDTSTART;TZID=Not A Zone:20260115T090000\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n')[0];
  assert.deepEqual([odd.date, odd.start], ['2026-01-15', '09:00']);
});

test('saving another calendar\'s event keeps its place, alarm, repeat rule, time zones and exact times', () => {
  const list = parseIcs(GOOGLE);
  list[0] = { ...list[0], title: 'Stand-up (renamed)' };
  const out = writeIcs(list);
  for (const line of ['DTSTART:20261012T140000Z', 'DTEND:20261012T150000Z', 'RRULE:FREQ=WEEKLY;INTERVAL=2;UNTIL=20261231T000000Z;BYDAY=MO', 'LOCATION:Room 4\\, level 2', 'BEGIN:VALARM', 'TRIGGER:-PT10M', 'END:VALARM', 'UID:abc123@google.com', 'X-WR-CALNAME:Work', 'TZID:Australia/Sydney', 'END:VTIMEZONE', 'DTSTAMP:20261001T000000Z']) {
    assert.ok(out.includes(`\r\n${line}\r\n`), `kept: ${line}`);
  }
  assert.ok(out.includes('SUMMARY:Stand-up (renamed)'));
  assert.equal(parseIcs(out)[0].repeat, 'weekly');
  // The alarm stays inside the event, the time zone outside it.
  assert.ok(out.indexOf('BEGIN:VALARM') > out.indexOf('BEGIN:VEVENT') && out.indexOf('END:VTIMEZONE') < out.indexOf('BEGIN:VEVENT'));
});

test('a time or repeat changed here is written fresh, and only that', () => {
  const [e] = parseIcs(GOOGLE);
  const out = writeIcs([{ ...e, start: '08:00', end: '08:30', repeat: 'monthly' }]);
  assert.ok(!out.includes('T140000Z') && !out.includes('INTERVAL=2'));
  assert.ok(out.includes(`DTSTART:${e.date.replace(/-/g, '')}T080000`));
  assert.ok(out.includes('RRULE:FREQ=MONTHLY'));
  assert.ok(out.includes('LOCATION:Room 4'));
});

test('events and contacts with no UID keep the same id each time the file is read, so edits and deletes find them', () => {
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:A\r\nDTSTART;VALUE=DATE:20261201\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nSUMMARY:B\r\nDTSTART;VALUE=DATE:20261202\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  assert.deepEqual(parseIcs(ics).map(e => e.uid), parseIcs(ics).map(e => e.uid));
  // What Calendar does: read the file again, then drop the chosen event.
  const chosen = parseIcs(ics)[1];
  const after = parseIcs(writeIcs(parseIcs(ics).filter(x => x.uid !== chosen.uid)));
  assert.deepEqual(after.map(e => e.title), ['A']);

  const vcf = 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ann Lee\r\nTEL:123\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:3.0\r\nFN:Bo\r\nEND:VCARD\r\n';
  const ann = parseVcf(vcf)[0];
  const edited = parseVcf(vcf).map(c => (c.uid === ann.uid ? { ...ann, phones: ['999'] } : c));
  const back = parseVcf(writeVcf(edited));
  assert.deepEqual(back.map(c => [c.name, c.phones.join()]), [['Ann Lee', '999'], ['Bo', '']]);
  // Two identical cards are still two.
  const twice = parseVcf(vcf + vcf);
  assert.equal(new Set(twice.map(c => c.uid)).size, 4);
});

test('a moved showing of a repeating event is its own event here: deleting it keeps the series', () => {
  const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:s1', 'SUMMARY:Series', 'DTSTART:20261005T090000', 'RRULE:FREQ=WEEKLY', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:s1', 'RECURRENCE-ID:20261012T090000', 'SUMMARY:Moved', 'DTSTART:20261013T090000', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
  const list = parseIcs(ics);
  assert.notEqual(list[0].uid, list[1].uid);
  const kept = parseIcs(writeIcs(list.filter(e => e.uid !== list[1].uid)));
  assert.deepEqual(kept.map(e => e.title), ['Series']);
  const both = writeIcs(list);
  assert.equal(both.match(/UID:s1\r\n/g)?.length, 2, 'both still carry the file\'s own UID');
  assert.ok(both.includes('RECURRENCE-ID:20261012T090000'));
});

test('a contact from a phone keeps its phone types, photo and other fields; a changed field is written fresh', () => {
  const vcf = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:p1\r\nN:Lee;Ann;;;\r\nFN:Ann Lee\r\nTEL;TYPE=CELL:0411 000 000\r\nTEL;TYPE=WORK:02 9000 0000\r\nEMAIL;TYPE=HOME:ann@example.com\r\nURL:https://example.com\r\nPHOTO;ENCODING=b;TYPE=JPEG:AAAA\r\nADR;TYPE=HOME:;;1 Key St;Sydney;;;\r\nADR;TYPE=WORK:;;9 Office Rd;Sydney;;;\r\nEND:VCARD\r\n';
  const [c] = parseVcf(vcf);
  const same = writeVcf([{ ...c, notes: 'Met at the fair' }]);
  for (const line of ['TEL;TYPE=CELL:0411 000 000', 'TEL;TYPE=WORK:02 9000 0000', 'EMAIL;TYPE=HOME:ann@example.com', 'URL:https://example.com', 'PHOTO;ENCODING=b;TYPE=JPEG:AAAA', 'N:Lee;Ann;;;', 'ADR;TYPE=WORK:;;9 Office Rd;Sydney;;;']) {
    assert.ok(same.includes(`\r\n${line}\r\n`), `kept: ${line}`);
  }
  assert.ok(same.includes('NOTE:Met at the fair'));
  const changed = writeVcf([{ ...c, phones: ['0499 999 999'], address: '5 New St' }]);
  assert.ok(!changed.includes('0411 000 000') && changed.includes('TEL:0499 999 999'));
  assert.ok(changed.includes('ADR:;;5 New St;;;;') && changed.includes('ADR;TYPE=WORK:;;9 Office Rd'), 'the second address stays');
});

test('long lines with emoji fold between whole characters, at most 75 bytes, and read back the same', () => {
  const title = '🎂 party '.repeat(30);
  const folded = foldLine(`SUMMARY:${title}`);
  for (const piece of folded.split('\r\n')) {
    assert.ok(Buffer.byteLength(piece, 'utf8') <= 75, `piece of ${Buffer.byteLength(piece, 'utf8')} bytes`);
    assert.ok(!/[\uD800-\uDBFF]$|^ ?[\uDC00-\uDFFF]/.test(piece), 'never half an emoji');
  }
  const [e] = parseIcs(writeIcs([{ uid: 'x', title, date: '2026-10-11', start: '', end: '', notes: '', repeat: 'none', remind: -1 }]));
  assert.equal(e.title, title.slice(0, 500));
  const bytes = new TextEncoder().encode(folded);
  assert.ok(!new TextDecoder().decode(bytes).includes('�'));
});

test('a quoted parameter may hold a colon or semicolon', () => {
  const [l] = readLines('ATTENDEE;CN="Lee: Ann; PhD";ROLE=REQ-PARTICIPANT:mailto:ann@example.com');
  assert.equal(l.name, 'ATTENDEE');
  assert.equal(l.params.CN, 'Lee: Ann; PhD');
  assert.equal(l.value, 'mailto:ann@example.com');
});

test('adding an event keeps the file\'s to-dos, its calendar name and an event this calendar cannot read', async () => {
  const { FileSystem } = await import('../src/fs/fs.ts');
  const { MemoryStore } = await import('../src/store/memory-store.ts');
  const { recordFile } = await import('../src/shell/recordfile.ts');
  const fs = new FileSystem(new MemoryStore());
  await fs.ensureFolder('/Documents');
  const thunderbird = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Mozilla.org/NONSGML Mozilla Calendar V1.1//EN', 'X-WR-CALNAME:Home',
    'BEGIN:VTODO', 'UID:todo-1', 'SUMMARY:Buy milk', 'END:VTODO',
    // A start time with no seconds: this calendar cannot read it, so it is not shown, but it is not ours to throw away.
    'BEGIN:VEVENT', 'UID:odd-1', 'DTSTART:20261110T1000', 'SUMMARY:Odd one', 'END:VEVENT',
    'END:VCALENDAR', '',
  ].join('\r\n');
  await fs.writeText('/Documents/Calendar.ics', thunderbird);
  const file = recordFile(fs, '/Documents/Calendar.ics', parseIcs, writeIcs);
  assert.deepEqual(await file.load(), [], 'nothing here can be shown');
  // One click on "Add to calendar" in My Projects.
  await file.change(list => [...list, { uid: 'new-1', title: 'New', date: '2026-11-11', start: '09:00', end: '', notes: '', repeat: 'none', remind: -1 }]);
  const saved = await fs.readText('/Documents/Calendar.ics');
  for (const kept of ['X-WR-CALNAME:Home', 'BEGIN:VTODO', 'SUMMARY:Buy milk', 'UID:odd-1', 'DTSTART:20261110T1000', 'SUMMARY:Odd one']) assert.ok(saved.includes(kept), `${kept} is still in the file`);
  assert.deepEqual((await file.load()).map(e => e.title), ['New']);
  // Deleting the last event read from another calendar keeps its calendar's name and time zones too.
  await fs.writeText('/Documents/Calendar.ics', GOOGLE);
  await file.change(() => []);
  const emptied = await fs.readText('/Documents/Calendar.ics');
  assert.ok(emptied.includes('X-WR-CALNAME:Work') && emptied.includes('TZID:Australia/Sydney'), emptied);
  assert.ok(!emptied.includes('Stand-up'), 'the deleted event is gone');
});

test('a vCard 2.1 card from a phone: quoted-printable names and notes read as words, and survive saving another card', () => {
  const phone = [
    'BEGIN:VCARD', 'VERSION:2.1',
    'N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:M=C3=BCller;J=C3=BCrgen;;;',
    'FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:J=C3=BCrgen M=C3=BCller',
    // A note over two lines: "=0D=0A" is the line break, and the "=" at the end says the line carries on below.
    'NOTE;ENCODING=QUOTED-PRINTABLE:line one=0D=0A=', 'line two',
    'TEL;CELL:+111',
    'END:VCARD',
    'BEGIN:VCARD', 'VERSION:2.1', 'FN:Other', 'END:VCARD', '',
  ].join('\r\n');
  const cards = parseVcf(phone);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].name, 'Jürgen Müller');
  assert.equal(cards[0].notes, 'line one\nline two');
  assert.deepEqual(cards[0].phones, ['+111']);
  cards[1].name = 'Other Person';
  const again = parseVcf(writeVcf(cards));
  assert.deepEqual(again.map(c => [c.name, c.notes, c.phones]), [['Jürgen Müller', 'line one\nline two', ['+111']], ['Other Person', '', []]]);
});

// Plain words: a "type label" is what a phone shows beside a number (mobile, work, home); a UID is the name a file gives
// a record so programs can tell records apart.
test('adding one phone or email keeps the type labels (mobile, work, home) on the numbers that did not change', () => {
  const vcf = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:p1\r\nFN:Ann Lee\r\nTEL;TYPE=CELL:0411 000 000\r\nTEL;TYPE=WORK:02 9000 0000\r\nEMAIL;TYPE=HOME:ann@example.com\r\nEND:VCARD\r\n';
  const [c] = parseVcf(vcf);
  const out = writeVcf([{ ...c, phones: [...c.phones, '0499 999 999'], emails: ['new@example.com', ...c.emails] }]);
  for (const line of ['TEL;TYPE=CELL:0411 000 000', 'TEL;TYPE=WORK:02 9000 0000', 'TEL:0499 999 999', 'EMAIL;TYPE=HOME:ann@example.com', 'EMAIL:new@example.com']) {
    assert.ok(out.includes(`\r\n${line}\r\n`), `kept: ${line}\n${out}`);
  }
  // Removing one keeps the label of the other, and the same number twice keeps both its labels.
  const fewer = writeVcf([{ ...c, phones: ['02 9000 0000'] }]);
  assert.ok(fewer.includes('\r\nTEL;TYPE=WORK:02 9000 0000\r\n') && !fewer.includes('0411 000 000'));
  const [twice] = parseVcf('BEGIN:VCARD\r\nVERSION:3.0\r\nUID:p2\r\nFN:Bo\r\nTEL;TYPE=WORK:1\r\nTEL;TYPE=HOME:1\r\nEND:VCARD\r\n');
  const both = writeVcf([{ ...twice, phones: ['1', '1', '2'] }]);
  assert.ok(both.includes('TEL;TYPE=WORK:1\r\n') && both.includes('TEL;TYPE=HOME:1\r\n'), both);
});

test('numbers past the 20 a card shows are still in the file after adding one', () => {
  const tels = Array.from({ length: 25 }, (_, i) => `TEL;TYPE=WORK:${1000 + i}`).join('\r\n');
  const [c] = parseVcf(`BEGIN:VCARD\r\nVERSION:3.0\r\nUID:p3\r\nFN:Many\r\n${tels}\r\nEND:VCARD\r\n`);
  assert.equal(c.phones.length, 20);
  const out = writeVcf([{ ...c, phones: c.phones.slice(1) }]);
  assert.ok(out.includes('TEL;TYPE=WORK:1024\r\n'), 'the last one is kept');
  assert.ok(!out.includes('TEL;TYPE=WORK:1000\r\n'), 'the one taken out is gone');
});

const twoCards = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:same\r\nFN:Ann\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:3.0\r\nUID:same\r\nFN:Bo\r\nEND:VCARD\r\n';
const twoEvents = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:same\r\nSUMMARY:One\r\nDTSTART;VALUE=DATE:20261201\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:same\r\nSUMMARY:Two\r\nDTSTART;VALUE=DATE:20261202\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';

async function sameIdFiles() {
  const { FileSystem } = await import('../src/fs/fs.ts');
  const { MemoryStore } = await import('../src/store/memory-store.ts');
  const { recordFile } = await import('../src/shell/recordfile.ts');
  const fs = new FileSystem(new MemoryStore());
  await fs.ensureFolder('/Documents');
  await fs.writeText('/Documents/C.vcf', twoCards);
  await fs.writeText('/Documents/C.ics', twoEvents);
  // As the Contacts app opens its file: sorted by name.
  const people = recordFile(fs, '/Documents/C.vcf', text => parseVcf(text).sort((a, b) => a.name.localeCompare(b.name)), writeVcf);
  const events = recordFile(fs, '/Documents/C.ics', parseIcs, writeIcs);
  return { fs, people, events };
}

test('two contacts with the same UID get their own ids: one is edited and deleted without the other, and both keep the file\'s UID', async () => {
  const { fs, people } = await sameIdFiles();
  let list = await people.load();
  assert.equal(new Set(list.map(c => c.uid)).size, 2);
  const bo = list.find(c => c.name === 'Bo')!;
  // Edit Bo so the list order changes, then edit again from the list the app was handed back.
  list = await people.change(l => [...l.filter(x => x.uid !== bo.uid), { ...bo, name: 'Aaron' }].sort((a, b) => a.name.localeCompare(b.name)));
  assert.deepEqual(list.map(c => c.name), ['Aaron', 'Ann']);
  const aaron = list.find(c => c.name === 'Aaron')!;
  assert.equal(aaron.uid, bo.uid, 'the id stays the same after the save');
  list = await people.change(l => [...l.filter(x => x.uid !== aaron.uid), { ...aaron, notes: 'seen' }].sort((a, b) => a.name.localeCompare(b.name)));
  assert.deepEqual(list.map(c => [c.name, c.notes]), [['Aaron', 'seen'], ['Ann', '']]);
  assert.equal((await fs.readText('/Documents/C.vcf')).match(/UID:same\r\n/g)?.length, 2, 'the file still says its own UID');
  // Delete the first in the file, then edit the one left, from the list handed back.
  const ann = list.find(c => c.name === 'Ann')!;
  list = await people.change(l => l.filter(x => x.uid !== ann.uid));
  assert.deepEqual(list.map(c => c.name), ['Aaron']);
  const left = list[0];
  list = await people.change(l => [...l.filter(x => x.uid !== left.uid), { ...left, org: 'Acme' }]);
  assert.deepEqual((await people.load()).map(c => [c.name, c.org]), [['Aaron', 'Acme']]);
});

test('two events with the same UID get their own ids: one is edited and deleted without the other, and both keep the file\'s UID', async () => {
  const { fs, events } = await sameIdFiles();
  let list = await events.load();
  assert.equal(new Set(list.map(e => e.uid)).size, 2);
  const one = list.find(e => e.title === 'One')!;
  // The Calendar puts an edited event at the end of the list; reading again must still find each by its id.
  list = await events.change(l => [...l.filter(x => x.uid !== one.uid), { ...one, title: 'One changed' }]);
  const again = await events.load();
  assert.deepEqual(again.map(e => [e.uid, e.title]).sort(), list.map(e => [e.uid, e.title]).sort());
  assert.deepEqual(list.find(e => e.uid === one.uid)?.title, 'One changed');
  assert.equal((await fs.readText('/Documents/C.ics')).match(/UID:same\r\n/g)?.length, 2);
  list = await events.change(l => l.filter(x => x.uid !== one.uid));
  assert.deepEqual(list.map(e => e.title), ['Two']);
  const two = list[0];
  await events.change(l => [...l.filter(x => x.uid !== two.uid), { ...two, notes: 'n' }]);
  assert.deepEqual((await events.load()).map(e => [e.title, e.notes]), [['Two', 'n']]);
});

test('a showing moved to another day shows once: on its new day, not also on its old one, and no reminder there', () => {
  const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:s1', 'SUMMARY:Series', 'DTSTART:20261005T090000', 'RRULE:FREQ=WEEKLY', 'X-TOMLINOS-REMIND:15', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:s1', 'RECURRENCE-ID:20261012T090000', 'SUMMARY:Moved', 'DTSTART:20261013T090000', 'X-TOMLINOS-REMIND:15', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
  const list = parseIcs(ics);
  const on = (day: string) => eventsOn(list, day).map(e => e.title);
  assert.deepEqual(on('2026-10-05'), ['Series']);
  assert.deepEqual(on('2026-10-12'), [], 'not on its old day');
  assert.deepEqual(on('2026-10-13'), ['Moved']);
  assert.deepEqual(on('2026-10-19'), ['Series']);
  // Saving keeps the file as it was, with no cancelled day written into the series.
  const out = writeIcs(list);
  assert.ok(!out.includes('EXDATE'));
  assert.deepEqual(eventsOn(parseIcs(out), '2026-10-12'), []);
});

test('an event past midnight reads with its end day, saves, and shows on both days', () => {
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:n\r\nSUMMARY:Night shift\r\nDTSTART:20261201T220000\r\nDTEND:20261202T010000\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  const [e] = parseIcs(ics);
  assert.deepEqual([e.date, e.start, e.end, e.endDate], ['2026-12-01', '22:00', '01:00', '2026-12-02']);
  assert.deepEqual(['2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03'].map(d => eventsShownOn([e], d).length), [0, 1, 1, 0]);
  // Unchanged: the file's own lines. A new start: the end stays on its own day.
  assert.ok(writeIcs([{ ...e, title: 'Shift' }]).includes('DTEND:20261202T010000'));
  const moved = writeIcs([{ ...e, start: '21:00' }]);
  assert.ok(moved.includes('DTSTART:20261201T210000') && moved.includes('DTEND:20261202T010000'), moved);
  const [back] = parseIcs(moved);
  assert.deepEqual([back.start, back.end, back.endDate], ['21:00', '01:00', '2026-12-02']);
  // Ending on the stroke of midnight is not a showing on the next day.
  const [late] = parseIcs(ics.replace('DTEND:20261202T010000', 'DTEND:20261202T000000'));
  assert.deepEqual(['2026-12-01', '2026-12-02'].map(d => eventsShownOn([late], d).length), [1, 0]);
});

test('an event over several days shows on each of them; its end stays right when saved; a reminder goes only with its start', () => {
  const allDay = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nSUMMARY:Holiday\r\nDTSTART;VALUE=DATE:20261201\r\nDTEND;VALUE=DATE:20261204\r\nX-TOMLINOS-REMIND:0\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  const [e] = parseIcs(allDay);
  assert.equal(e.endDate, '2026-12-03', 'an all-day end in a file is the day after the last');
  assert.deepEqual(['2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04'].map(d => eventsShownOn([e], d).length), [1, 1, 1, 0]);
  assert.deepEqual(['2026-12-01', '2026-12-02'].map(d => eventsOn([e], d).length), [1, 0], 'eventsOn is for its start: reminders use it');
  const moved = writeIcs([{ ...e, endDate: '2026-12-05' }]);
  assert.ok(moved.includes('DTEND;VALUE=DATE:20261206'), moved);
  assert.equal(parseIcs(moved)[0].endDate, '2026-12-05');
  // A one-day event with the usual "next day" end has no end day of its own.
  assert.equal(parseIcs(allDay.replace('20261204', '20261202'))[0].endDate, undefined);
  // The same from DURATION (how long, instead of when it ends).
  const [d] = parseIcs(allDay.replace('DTEND;VALUE=DATE:20261204', 'DURATION:P3D'));
  assert.equal(d.endDate, '2026-12-03');
  const [t] = parseIcs('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:t\r\nDTSTART:20261201T220000\r\nDURATION:PT3H\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n');
  assert.deepEqual([t.end, t.endDate], ['01:00', '2026-12-02']);
  // Each showing of a weekly two-day event runs over its two days.
  const [w] = parseIcs('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:w\r\nDTSTART;VALUE=DATE:20261201\r\nDTEND;VALUE=DATE:20261203\r\nRRULE:FREQ=WEEKLY\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n');
  assert.deepEqual(['2026-12-08', '2026-12-09', '2026-12-10'].map(day => eventsShownOn([w], day).length), [1, 1, 0]);
  assert.match(timeLabel(t), /^22:00/);
});

test('an Outlook time zone name (a Windows name, not a world one) is shown as local time, not as the same digits', () => {
  const at = (tz: string) => parseIcs(`BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:o\r\nDTSTART;TZID=${tz}:20260115T100000\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`)[0];
  const berlin = local(Date.UTC(2026, 0, 15, 9, 0));
  assert.deepEqual([at('W. Europe Standard Time').date, at('W. Europe Standard Time').start], [berlin.date, berlin.time]);
  const quoted = at('"W. Europe Standard Time"');
  assert.deepEqual([quoted.date, quoted.start], [berlin.date, berlin.time]);
  const la = local(Date.UTC(2026, 0, 15, 18, 0));
  assert.deepEqual([at('Pacific Standard Time').date, at('Pacific Standard Time').start], [la.date, la.time]);
  const syd = local(Date.UTC(2026, 0, 14, 23, 0));
  assert.deepEqual([at('AUS Eastern Standard Time').date, at('AUS Eastern Standard Time').start], [syd.date, syd.time]);
});

test('a card\'s own given and family names are there for letters, not guessed from spaces', () => {
  const [c] = parseVcf('BEGIN:VCARD\r\nVERSION:3.0\r\nUID:g\r\nFN:Dr. Jane van der Berg\r\nN:van der Berg;Jane;;Dr.;\r\nEND:VCARD\r\n');
  assert.deepEqual([c.given, c.family], ['Jane', 'van der Berg']);
  // A card made here keeps the whole name in one part: nothing to go on, so nothing is claimed.
  const [made] = parseVcf(writeVcf([{ ...emptyContact(), name: 'Jane Smith' }]));
  assert.deepEqual([made.given, made.family], [undefined, undefined]);
});
