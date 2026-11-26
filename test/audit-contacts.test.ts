// Audit of Contacts' file reader and writer (src/core/vcard.ts) and of what Write's mail merge takes from it. Tests
// without a todo failed when written (P0); { todo: 'P1' } marks the lesser faults so the suite stays green.
// Run: node --test test/audit-contacts.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVcf, writeVcf, type Contact } from '../src/core/vcard.ts';
import { contactsList } from '../src/apps/write/merge.ts';
import { isDate } from '../src/core/ical.ts';
import { FileSystem } from '../src/fs/fs.ts';
import { MemoryStore } from '../src/store/memory-store.ts';
import { recordFile } from '../src/shell/recordfile.ts';

const BS = '\\';
const card = (...l: string[]) => ['BEGIN:VCARD', ...l, 'END:VCARD', ''].join('\r\n');
const lines = (text: string) => text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
/** What the Contacts form saves when Edit is clicked and then Save with nothing typed (src/apps/contacts.ts:165). */
const formSave = (c: Contact): Contact => ({
  ...c, name: c.name.trim(), org: c.org.trim(), phones: lines(c.phones.join('\n')), emails: lines(c.emails.join('\n')),
  address: c.address.trim().replace(/\s*\n\s*/g, ', '), birthday: isDate(c.birthday) ? c.birthday : '', notes: c.notes.trim(),
});

test('CON-P0-1: an Apple Contacts card shows its grouped email and phone (item1.EMAIL, item2.TEL)', () => {
  const [c] = parseVcf(card('VERSION:3.0', 'FN:Anna Apple', 'item1.EMAIL;type=INTERNET;type=pref:anna@example.com', 'item1.X-ABLabel:_$!<Other>!$_', 'item2.TEL;type=CELL:+44 7700 900111', 'item3.ADR;type=HOME:;;1 Lane;Town;;AB1;UK'));
  assert.deepEqual(c.emails, ['anna@example.com']);
  assert.deepEqual(c.phones, ['+44 7700 900111']);
  assert.equal(c.address, '1 Lane, Town, AB1, UK');
});

test('CON-P0-1: a grouped email is written back once, on its own line, after it is kept unchanged', () => {
  const text = card('VERSION:3.0', 'UID:a', 'FN:Anna', 'item1.EMAIL;type=INTERNET:anna@example.com');
  const out = writeVcf(parseVcf(text), text);
  assert.equal(out.split('anna@example.com').length - 1, 1);
});

test('CON-P0-2: editing a contact whose street has a line break keeps the city, region, postcode and country in their places', () => {
  const text = card('VERSION:3.0', 'UID:b', 'FN:Bob', `ADR;TYPE=home:;;1 Main St${BS}nFlat 2;Springfield;IL;62704;USA`, 'TEL:555 0100');
  const [c] = parseVcf(text);
  const saved = formSave({ ...c, phones: ['555 0100', '555 0199'] });
  const adr = writeVcf([saved], text).split('\r\n').find(l => l.startsWith('ADR'))!;
  assert.match(adr, /;Springfield;IL;62704;USA$/);
});

test('CON-P0-4: adding a contact to a UTF-16 .vcf does not replace every card in it with the new one', async () => {
  // fs.readText decodes as UTF-8, so the reader sees no BEGIN:VCARD in a UTF-16 file, shows an empty book, and the
  // first save writes only the new contact over the whole file.
  const fs = new FileSystem(new MemoryStore());
  await fs.list('/');
  await fs.writeFile('/Documents/Old.vcf', new Uint8Array(Buffer.from('﻿' + card('VERSION:3.0', 'UID:u', 'FN:Una') + card('VERSION:3.0', 'UID:v', 'FN:Vic'), 'utf16le')));
  const file = recordFile(fs, '/Documents/Old.vcf', parseVcf, writeVcf);
  let refused = false;
  try {
    await file.change(list => [...list, { uid: 'n', name: 'New', org: '', phones: [], emails: [], address: '', birthday: '', notes: '' }]);
  } catch {
    refused = true;
  }
  const bytes = await fs.readFile('/Documents/Old.vcf');
  const text = new TextDecoder(bytes[0] === 0xff ? 'utf-16le' : 'utf-8').decode(bytes);
  assert.ok(refused ? text.includes('Una') : ['Una', 'Vic', 'New'].every(n => text.includes(n)), 'the file now holds: ' + JSON.stringify(text.slice(0, 120)));
});

test('CON-P1: a name saved unchanged keeps the card\'s first and family names (trailing space in FN)', { todo: 'P1' }, () => {
  const text = card('VERSION:3.0', 'UID:a', 'FN:John Smith ', 'N:Smith;John;;Dr.;');
  const out = writeVcf([formSave(parseVcf(text)[0])], text);
  assert.match(out, /N:Smith;John;;Dr\.;/);
});

test('CON-P1: a birthday the date box cannot show is not dropped by Edit then Save', { todo: 'P1' }, () => {
  const text = card('VERSION:3.0', 'UID:c', 'FN:C', 'BDAY:1985-02-30');
  assert.match(writeVcf([formSave(parseVcf(text)[0])], text), /BDAY/);
});

test('CON-P1: a vCard 4.0 birthday without a year (--0415) is shown', { todo: 'P1' }, () => {
  const [c] = parseVcf(card('VERSION:4.0', 'FN:Ann', 'BDAY:--0415'));
  assert.notEqual(c.birthday, '');
});

test('CON-P1: a vCard 4.0 phone given as a tel: link shows the number', { todo: 'P1' }, () => {
  const [c] = parseVcf(card('VERSION:4.0', 'FN:Ann', 'TEL;VALUE=uri;TYPE=cell:tel:+1-555-0100'));
  assert.deepEqual(c.phones, ['+1-555-0100']);
});

test('CON-P1: a base64 text value (FN;ENCODING=b) is decoded', { todo: 'P1' }, () => {
  const [c] = parseVcf(card('VERSION:3.0', 'FN;ENCODING=b;CHARSET=UTF-8:SsO8cmdlbg=='));
  assert.equal(c.name, 'Jürgen');
});

test('CON-P1: a vCard 2.1 folded line keeps the space it was folded at', { todo: 'P1' }, () => {
  const [c] = parseVcf(card('VERSION:2.1', 'FN:John', 'NOTE:hello', ' world'));
  assert.equal(c.notes, 'hello world');
});

test('CON-P1: a 2.1 AGENT card inside a card does not replace the outer person', { todo: 'P1' }, () => {
  const people = parseVcf(card('VERSION:2.1', 'FN:Boss', 'AGENT:', 'BEGIN:VCARD', 'VERSION:2.1', 'FN:Assistant', 'END:VCARD', 'TEL:999'));
  assert.deepEqual(people.map(p => p.name), ['Boss']);
});

test('CON-P1: a name edited on a 2.1 card is written so 2.1 readers read it (no \\, escape, charset given)', { todo: 'P1' }, () => {
  const text = card('VERSION:2.1', 'FN:Old', 'N:Old;;;;');
  const [c] = parseVcf(text);
  const out = writeVcf([{ ...c, name: 'Müller, Jürgen' }], text);
  assert.ok(!out.includes(`${BS},`) && /CHARSET=UTF-8|VERSION:3\.0/.test(out), out);
});

test('CON-P1: a card with only a company is not given a person name equal to the company on an unrelated save', { todo: 'P1' }, () => {
  const text = card('VERSION:3.0', 'UID:o', 'ORG:Acme Ltd') + card('VERSION:3.0', 'UID:r', 'NOTE:nothing');
  const out = writeVcf(parseVcf(text), text);
  assert.ok(!out.includes('FN:Acme Ltd') && !out.includes('(no name)'), out);
});

test('CON-P1: an edited address is written in its parts, not all into the street', { todo: 'P1' }, () => {
  const text = card('VERSION:3.0', 'UID:b', 'FN:Bob', 'ADR;TYPE=home:;;1 Main St;Springfield;IL;62704;USA');
  const [c] = parseVcf(text);
  const out = writeVcf([{ ...c, address: '2 Main St, Springfield, IL, 62704, USA' }], text);
  assert.match(out, /;Springfield;IL;62704;USA/);
});

test('CON-P1: mail merge splits a name made in Contacts into first and last as a person would (Mary Ann Smith)', { todo: 'P1' }, () => {
  const made = writeVcf([{ uid: 'm', name: 'Mary Ann Smith', org: '', phones: [], emails: [], address: '', birthday: '', notes: '' }]);
  const [row] = contactsList(made).rows;
  assert.equal(row['Last name'], 'Smith');
});

test('CON-P1: a long quoted-printable value with many soft line breaks reads in under 2 seconds', { todo: 'P1' }, () => {
  const text = 'BEGIN:VCARD\r\nVERSION:2.1\r\nNOTE;ENCODING=QUOTED-PRINTABLE:' + Array(60000).fill('=41=42=').join('\r\n') + '\r\nEND:VCARD\r\n';
  const t0 = performance.now();
  parseVcf(text);
  assert.ok(performance.now() - t0 < 2000, `${Math.round(performance.now() - t0)} ms`);
});
