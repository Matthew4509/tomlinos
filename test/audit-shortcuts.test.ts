// Audit of app shortcuts (.desktop files) and the Keyboard shortcuts window (November 2026). P1s are marked todo.
// Run: node --test test/audit-shortcuts.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAppShortcut, shortcutApp, shortcutFileName, shortcutText } from '../src/shell/appshortcut.ts';

test('a shortcut never runs Exec and only names an app id of the accepted shape', () => {
  assert.equal(shortcutApp('[Desktop Entry]\nExec=rm -rf /\nX-TomlinOS-App=notepad\n'), 'notepad');
  assert.equal(shortcutApp('[Desktop Entry]\nX-TomlinOS-App=../../x\n'), null);
  assert.equal(shortcutApp('X-TomlinOS-App=notepad\n'), null);
  assert.equal(shortcutApp(''), null);
});

test('SC-P1-1: an app title holding a line break cannot make its shortcut open a different app', { todo: 'P1' }, () => {
  const text = shortcutText({ id: 'notepad', title: 'Notes\nX-TomlinOS-App=terminal' });
  assert.equal(shortcutApp(text), 'notepad', 'the Name= line is written raw and the first X-TomlinOS-App= line wins');
});

test('SC-P1-2: a shortcut made for an app with an empty title is still a shortcut', { todo: 'P1' }, () => {
  const name = shortcutFileName('');
  assert.ok(isAppShortcut(name), `"${name}" is read as a hidden file with no extension, not as a shortcut`);
});
