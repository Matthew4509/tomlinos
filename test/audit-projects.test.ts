// Audit of My Projects' records (src/apps/projects/data.ts). Each test marked todo is a P1 finding that fails today.
// The window-level faults (unsaved Edit changes, the settings form, the star, focus, a big list) are in
// test/browser-audit-projects.mjs.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIcs } from '../src/core/ical.ts';
import { cleanSettings, parseProjects, projectEntries, shortTitle, writeProjects } from '../src/apps/projects/data.ts';

test('P1: a log entry keeps its short title ("Add new feature") after the project is renamed', { todo: 'P1' }, () => {
  // Booked as "Add new feature: Alpha"; the project is now called "Alpha renamed".
  assert.equal(shortTitle({ title: 'Add new feature: Alpha' }, { name: 'Alpha renamed' }), 'Add new feature');
});

test('PRJ-P1-3: Default hours 0.1 is not silently turned into "no end time"', () => {
  assert.notEqual(cleanSettings({ hours: 0.1 }).hours, 0);
  assert.equal(cleanSettings({ hours: 0.1 }).hours, 0.25);
  assert.equal(cleanSettings({ hours: 1.3 }).hours, 1.25);
  assert.equal(cleanSettings({ hours: 0 }).hours, 0);
});

test('P1: a project typed into Projects.json by hand with no id is kept (given an id), not dropped on the next save', { todo: 'P1' }, () => {
  const kept = writeProjects(parseProjects(JSON.stringify([{ uid: 'a1', name: 'Known' }, { name: 'Hand added', notes: 'typed in Notepad' }])));
  assert.match(kept, /Hand added/);
});

test('P1: a cancelled entry is not listed in a project\'s log as if it happened', { todo: 'P1' }, () => {
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:b', 'SUMMARY:Call off', 'DTSTART:20261101T090000', 'STATUS:CANCELLED',
    'X-TOMLINOS-PROJECT:p1', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const { past } = projectEntries(parseIcs(ics), 'p1', '2026-11-26');
  assert.deepEqual(past.map(e => e.title), []);
});
