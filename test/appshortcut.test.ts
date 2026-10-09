// App shortcuts (src/shell/appshortcut.ts): the file written, what is read back, and what is refused.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAppShortcut, shortcutApp, shortcutIcon, shortcutLabel, shortcutText } from '../src/shell/appshortcut.ts';

test('a shortcut is a freedesktop Desktop Entry naming the app, and reads back to that app', () => {
  const text = shortcutText({ id: 'panel', title: 'Panel' });
  assert.ok(text.startsWith('[Desktop Entry]\r\nType=Application\r\nName=Panel\r\n'));
  assert.equal(shortcutApp(text), 'panel');
  assert.equal(shortcutApp(text.replace(/\r\n/g, '\n')), 'panel', 'Unix line endings too');
  assert.equal(shortcutApp('# made by hand\n[Desktop Entry]\nX-TomlinOS-App=chat\n'), 'chat');
});

test('only an app id is ever taken from it: commands and odd ids are ignored', () => {
  assert.equal(shortcutApp('[Desktop Entry]\nType=Application\nExec=rm -rf /\n'), null, 'Exec is never used');
  assert.equal(shortcutApp('[Desktop Entry]\nX-TomlinOS-App=../../etc\n'), null);
  assert.equal(shortcutApp('[Desktop Entry]\nX-TomlinOS-App=Panel\n'), null, 'ids are lower case');
  assert.equal(shortcutApp('X-TomlinOS-App=panel\n'), null, 'not a Desktop Entry');
  assert.equal(shortcutApp(''), null);
});

test('the desktop shows the name without .desktop, and the app icon while the name is the app title', () => {
  const apps = [{ title: 'Panel', icon: 'panel' as const }, { title: 'Chat', icon: 'chat' as const }];
  assert.equal(isAppShortcut('Panel.desktop'), true);
  assert.equal(isAppShortcut('Panel.DESKTOP'), true);
  assert.equal(isAppShortcut('notes.txt'), false);
  assert.equal(shortcutLabel('Panel.desktop'), 'Panel');
  assert.equal(shortcutLabel('notes.txt'), 'notes.txt');
  assert.equal(shortcutIcon('Panel.desktop', apps), 'panel');
  assert.equal(shortcutIcon('Panel (2).desktop', apps), 'panel');
  assert.equal(shortcutIcon('My tools.desktop', apps), 'app', 'renamed: the plain app icon');
});
