// Contacts' groups, favourites, descriptions and job titles: how the .vcf file holds them (src/core/vcard.ts), and
// the list's filters, search, sort and pictures (src/apps/contacts.ts). The window itself: test/browser-contacts-groups.mjs.
// Run: node --test test/contacts-groups.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanGroups, emptyContact, parseVcf, writeVcf, type Contact } from '../src/core/vcard.ts';
import { allGroups, formChanges, formValues, initials, matches, shownBy, sorter, tintOf } from '../src/apps/contacts.ts';

const card = (...l: string[]) => ['BEGIN:VCARD', 'VERSION:3.0', ...l, 'END:VCARD', ''].join('\r\n');
const person = (more: Partial<Contact>): Contact => ({ ...emptyContact(), ...more });

test('groups are read from CATEGORIES, split on unescaped commas, from every CATEGORIES line', () => {
  const [c] = parseVcf(card('UID:a', 'FN:Ann', 'CATEGORIES:Family,Book club', 'CATEGORIES:Tea\\, and cake,work'));
  assert.deepEqual(c.groups, ['Family', 'Book club', 'Tea, and cake', 'Work']);
});

test('cleanGroups: one of each (any case), standard names written their standard way, empties and spaces tidied', () => {
  assert.deepEqual(cleanGroups(['  friends ', 'Friends', 'work', '', 'Book   club', 'book club']), ['Friends', 'Work', 'Book club']);
  assert.equal(cleanGroups(['x'.repeat(100)])[0].length, 40);
  assert.equal(cleanGroups(Array.from({ length: 30 }, (_, i) => `G${i}`)).length, 20);
});

test('groups, favourite, description and job title are written and read back', () => {
  const c = person({ uid: 'b', name: 'Ben Okafor', title: 'Treasurer; club', description: "Ben's sister, met at the club", groups: ['Friends', 'A;B, C'], favourite: true });
  const text = writeVcf([c]);
  assert.match(text, /\r\nCATEGORIES:Friends,A\\;B\\, C\r\n/);
  assert.match(text, /\r\nX-TOMLINOS-FAVOURITE:1\r\n/);
  assert.match(text, /\r\nTITLE:Treasurer\\; club\r\n/);
  const [back] = parseVcf(text);
  assert.deepEqual([back.title, back.description, back.groups, back.favourite], [c.title, c.description, c.groups, true]);
  assert.equal(writeVcf(parseVcf(text)), text, 'writing again gives the same file');
});

test('a card with none of the new fields gets no new lines, and a favourite taken off is written without the line', () => {
  assert.doesNotMatch(writeVcf([person({ uid: 'p', name: 'Plain' })]), /CATEGORIES|TITLE|X-TOMLINOS/);
  const [c] = parseVcf(card('UID:f', 'FN:Fay', 'X-TOMLINOS-FAVOURITE:1'));
  assert.equal(c.favourite, true);
  assert.doesNotMatch(writeVcf([{ ...c, favourite: false }]), /FAVOURITE/);
});

test("an unchanged card from a phone keeps its own CATEGORIES and TITLE lines (case, spacing, parameters)", () => {
  const text = card('UID:k', 'FN:Kim', 'TITLE;LANGUAGE=en:Chief cook', 'CATEGORIES:friends,  Neighbours');
  const out = writeVcf(parseVcf(text));
  assert.match(out, /\r\nTITLE;LANGUAGE=en:Chief cook\r\n/);
  assert.match(out, /\r\nCATEGORIES:friends,  Neighbours\r\n/);
  // Changed here: written fresh.
  const [c] = parseVcf(text);
  assert.match(writeVcf([{ ...c, groups: [...c.groups, 'Work'] }]), /\r\nCATEGORIES:Friends,Neighbours,Work\r\n/);
});

test('the form: groups and the star are saved only when changed; a new group typed is kept; a long name is refused', () => {
  const c = person({ uid: 'g', name: 'Gus', groups: ['Work'], favourite: false });
  const opened = formValues(c);
  assert.deepEqual(formChanges(opened, opened), {});
  assert.deepEqual(formChanges(opened, { ...opened, groups: 'Work, Book club', favourite: '1' }), { groups: ['Work', 'Book club'], favourite: true });
  assert.match(String(formChanges(opened, { ...opened, groups: 'x'.repeat(41) })), /up to 40/);
  assert.match(String(formChanges(opened, { ...opened, groups: Array.from({ length: 21 }, (_, i) => `G${i}`).join(', ') })), /up to 20 groups/);
  const made = formChanges(null, { ...opened, name: 'New', description: '  two\n lines ', title: ' Boss ' });
  assert.equal(typeof made, 'object');
  assert.deepEqual([(made as Contact).description, (made as Contact).title], ['two lines', 'Boss']);
});

test('filters: All, Favourites, or one group (any case)', () => {
  const ann = person({ name: 'Ann', groups: ['Family'], favourite: true });
  const bob = person({ name: 'Bob', groups: ['work'] });
  assert.ok(shownBy(bob, { kind: 'all' }));
  assert.deepEqual([ann, bob].filter(p => shownBy(p, { kind: 'favourites' })).map(p => p.name), ['Ann']);
  assert.deepEqual([ann, bob].filter(p => shownBy(p, { kind: 'group', name: 'Work' })).map(p => p.name), ['Bob']);
  assert.deepEqual(allGroups([ann, bob, person({ groups: ['Zumba', 'book club'] })]), ['Family', 'Friends', 'Work', 'book club', 'Zumba']);
});

test('search: every word found somewhere on the card; numbers match a phone however they are spaced', () => {
  const ada = person({ name: 'Ada Fernley', org: 'Fernley Joinery', groups: ['Work'], description: 'made the oak shelves', phones: ['07700 900-123'], notes: 'window seat' });
  for (const q of ['ada', 'ada work', 'OAK shelves', 'joinery window', '07700900123', '900 123', '0770']) assert.ok(matches(ada, q), q);
  for (const q of ['ada family', 'pine', '999']) assert.ok(!matches(ada, q), q);
  assert.ok(matches(ada, ''), 'nothing typed matches everyone');
});

test('sort: first name, last name (the card own family name, or the last word), company (none last)', () => {
  const list = [
    person({ name: 'Zed Adams', org: 'Beta' }),
    person({ name: 'Amy Young' }),
    person({ name: 'Bo Brown', family: 'Cole', given: 'Bo', org: 'Alpha' }),
  ];
  assert.deepEqual([...list].sort(sorter('first')).map(p => p.name), ['Amy Young', 'Bo Brown', 'Zed Adams']);
  assert.deepEqual([...list].sort(sorter('last')).map(p => p.name), ['Zed Adams', 'Bo Brown', 'Amy Young']);
  assert.deepEqual([...list].sort(sorter('company')).map(p => p.name), ['Bo Brown', 'Zed Adams', 'Amy Young']);
});

test('the round picture: initials of the first and last word, the same colour for the same name', () => {
  assert.equal(initials('Ada Fernley'), 'AF');
  assert.equal(initials('mary ann smith'), 'MS');
  assert.equal(initials('Élodie'), 'É');
  assert.equal(initials('(no name)'), 'NN');
  assert.equal(initials('😀 Kim'), 'K');
  assert.equal(initials('   '), '?');
  assert.equal(tintOf('Ada'), tintOf(' ada '));
  assert.ok(tintOf('Ada') >= 0 && tintOf('Ada') < 8);
});
