// Audit of My Projects' records (src/apps/projects/data.ts). Each test marked todo is a P1 finding that fails today.
// The window-level faults (unsaved Edit changes, the settings form, the star, focus, a big list) are in
// test/browser-audit-projects.mjs.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIcs } from '../src/core/ical.ts';
import { cleanSettings, parseProjects, projectEntries, shortTitle, writeProjects } from '../src/apps/projects/data.ts';

test('P1: a log entry keeps its short title ("Add new feature") after the project is renamed', () => {
  // Booked as "Add new feature: Alpha"; the project is now called "Alpha renamed".
  assert.equal(shortTitle({ title: 'Add new feature: Alpha' }, { name: 'Alpha renamed' }), 'Add new feature');
  // A button of the person's own, passed in from the settings, reads the same way.
  assert.equal(shortTitle({ title: 'Write the docs: Alpha' }, { name: 'Alpha renamed' }, ['Write the docs']), 'Write the docs');
  // A title that is not a button's stays whole; a plain Add to calendar entry keeps the old name it was booked by.
  assert.equal(shortTitle({ title: 'Meet Sam: about Alpha' }, { name: 'Alpha renamed' }), 'Meet Sam: about Alpha');
  assert.equal(shortTitle({ title: 'Alpha' }, { name: 'Alpha renamed' }), 'Alpha');
});

test('PRJ-P1-3: Default hours 0.1 is not silently turned into "no end time"', () => {
  assert.notEqual(cleanSettings({ hours: 0.1 }).hours, 0);
  assert.equal(cleanSettings({ hours: 0.1 }).hours, 0.25);
  assert.equal(cleanSettings({ hours: 1.3 }).hours, 1.25);
  assert.equal(cleanSettings({ hours: 0 }).hours, 0);
});

test('P1: a project typed into Projects.json by hand with no id is kept (given an id), not dropped on the next save', () => {
  const file = JSON.stringify([{ uid: 'a1', name: 'Known' }, { name: 'Hand added', notes: 'typed in Notepad' }]);
  const kept = writeProjects(parseProjects(file));
  assert.match(kept, /Hand added/);
  // The same id on every read of the same file (a change reads the file again), and the saved file keeps it.
  const id = parseProjects(file)[1].uid;
  assert.match(id, /^[\w-]{1,64}$/);
  assert.equal(parseProjects(file)[1].uid, id);
  assert.equal(parseProjects(kept)[1].uid, id);
  // Two different hand-typed projects get different ids.
  const two = parseProjects(JSON.stringify([{ name: 'One' }, { name: 'Two' }]));
  assert.notEqual(two[0].uid, two[1].uid);
});

test('P1: a cancelled entry is not listed in a project\'s log as if it happened', { todo: 'P1' }, () => {
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:b', 'SUMMARY:Call off', 'DTSTART:20261101T090000', 'STATUS:CANCELLED',
    'X-TOMLINOS-PROJECT:p1', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const { past } = projectEntries(parseIcs(ics), 'p1', '2026-11-26');
  assert.deepEqual(past.map(e => e.title), []);
});
