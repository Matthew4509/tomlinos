// Calendar (.ics) and contact (.vcf) files from other programs: what this desktop does not edit is kept, times given in
// UTC or a named zone are shown as local time, records with no UID can still be edited and deleted, and long lines
// with emoji survive folding.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIcs, writeIcs } from '../src/core/ical.ts';
import { parseVcf, writeVcf } from '../src/core/vcard.ts';
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
