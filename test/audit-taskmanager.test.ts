// Audit of the Task Manager (src/apps/taskmanager.ts) without a browser: what the app's own code does and leaves out.
// The browser half, which holds the P0 checks, is test/browser-audit-taskmanager.mjs. Tests marked todo are P1 findings.
// Run: node --test test/audit-taskmanager.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/apps/taskmanager.ts', import.meta.url), 'utf8');
const store = readFileSync(new URL('../server/lib/store.php', import.meta.url), 'utf8');

test('End task goes through the same close as the Close button, so unsaved work is asked about', () => {
  assert.match(src, /shell\.windows\.close\(w\)/);
});

test('the frame counter stops when the Task Manager closes', () => {
  assert.match(src, /addEventListener\('abort', \(\) => \(running = false\)/);
});

// TM-P0-keys (browser test TM-P0-keys): the list is a focusable listbox, but no key moves the choice, so from the
// keyboard no window can be chosen, switched to or ended.
test('TM-P0-keys: the window list handles arrow keys and Enter', () => {
  assert.match(src, /ArrowDown/);
  assert.match(src, /'Enter'/);
});

// TM-P1-twice (TM-P1-4): Delete held down sent End task again while the close was still asking, and three asks stacked.
// The shell now keeps one close per window: a second close of the same window waits for the first one's answer.
test('TM-P1-twice: End task is not run again while a close of that window is still asking', () => {
  const windows = readFileSync(new URL('../src/shell/windows.ts', import.meta.url), 'utf8');
  assert.match(windows, /if \(win\.closing\) return win\.closing;/);
});

// TM-P1-files: "Your files" added up the file sizes only, but the server charges every record (files AND folders) its
// size plus the version stamp, at least STORE_MIN_CHARGE. The figure now follows the server's rule; the browser test
// checks it against the server's .usage file.
test('TM-P1-files: the files figure uses the server\'s own charging rule (minimum per record, stamp, folders counted)', () => {
  const min = /STORE_MIN_CHARGE = (\d+);/.exec(store)?.[1];
  const stamp = /STORE_VERSION_LEN = (\d+);/.exec(store)?.[1];
  assert.ok(min && stamp, 'the server rule is still in server/lib/store.php');
  assert.match(src, new RegExp(`RECORD_MIN_CHARGE = ${min};`), 'same minimum as the server');
  assert.match(src, new RegExp(`RECORD_STAMP = ${stamp};`), 'same version stamp as the server');
  assert.match(store, /store_charge\(STORE_VERSION_LEN \+ strlen\(\$o\['data'\]\)\)/, 'the server still charges stamp + bytes');
  assert.match(src, /counted \+= recordCharge\(folderRecordBytes\(entries\)\)/, 'folder records are counted');
  assert.match(src, /counted against your storage limit/);
});

test('TM-P1-sort: the window list can be sorted (name, app, state)', { todo: 'P1' }, () => {
  assert.match(src, /sort/i);
});

test('TM-P1-jobs: uploads, downloads and other background jobs (transfers, an AI reply still running) are listed', { todo: 'P1' }, () => {
  assert.match(src, /transfer|job/i);
});

test('TM-P1-force: a window whose close never answers (a stuck guard) can still be ended by force', { todo: 'P1' }, () => {
  assert.match(src, /force/i);
});

test('TM-P1-cost: the frame counter pauses while the Task Manager is minimised or the Performance tab is not shown', { todo: 'P1' }, () => {
  assert.match(src, /visibilitychange|document\.hidden/);
});

test('TM-P1-stalls: Stalls says it counts only since the Task Manager opened, and can be reset', { todo: 'P1' }, () => {
  assert.match(src, /since/i);
});

test('TM-P1-graph: the graph follows the dark theme (no fixed light colours)', { todo: 'P1' }, () => {
  assert.doesNotMatch(src, /#f4f3ee/);
});

test('TM-P1-graph-label: the graph has a text equivalent (latest and lowest rate), not only a canvas', { todo: 'P1' }, () => {
  assert.match(src, /lowest/i);
});

test('TM-P1-tabs: the tabs follow the tab pattern (arrow keys, aria-controls)', { todo: 'P1' }, () => {
  assert.match(src, /aria-controls/);
});

test('TM-P1-menu: a right-click menu on a row (Switch to, Minimise, Maximise, End task)', { todo: 'P1' }, () => {
  assert.match(src, /contextmenu/);
});

test('TM-P1-measure-stop: a files measurement can be stopped, and one bad folder does not void the whole count', { todo: 'P1' }, () => {
  assert.match(src, /Stop|cancel/);
});
