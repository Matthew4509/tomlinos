// Audit of Settings' saved settings (src/shell/session.ts, what src/apps/settings.ts writes). Each test without todo is
// a P0 that fails today; each marked todo is a P1 finding that fails today. The window-level faults (a stale tab
// emptying the Recycle Bin by the old setting, pictures, keyboard, small windows) are in test/browser-audit-settings.mjs.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileSystem } from '../src/fs/fs.ts';
import { MemoryStore } from '../src/store/memory-store.ts';
import { Session, SESSION_PATH } from '../src/shell/session.ts';

const twoTabs = () => {
  const store = new MemoryStore();
  return { a: new FileSystem(store), b: new FileSystem(store) };
};

test('SET-P0-1: a colour chosen in one tab after another tab chose a picture is the background after a reload', async () => {
  const { a, b } = twoTabs();
  const sa = new Session(a);
  const sb = new Session(b);
  await sa.load();
  await sb.load();
  // Tab A picks a picture; tab B, open from before (it still shows the plain blue), then picks Teal.
  sa.data.wallpaper = { kind: 'picture', path: '/Pictures/Sunset.png' };
  await sa.flush();
  sb.data.wallpaper = { kind: 'colour', value: '#2f7f86' };
  await sb.flush();
  const fresh = new Session(a);
  await fresh.load();
  assert.deepEqual(fresh.data.wallpaper, { kind: 'colour', value: '#2f7f86' }, 'the last choice made (Teal) is lost: ' + (await a.readText(SESSION_PATH)));
});

test('SET-P0-1 (variant): a picture chosen in one tab after another tab chose a different picture is kept whole', async () => {
  const { a, b } = twoTabs();
  const sa = new Session(a);
  const sb = new Session(b);
  await sa.load();
  await sb.load();
  sa.data.wallpaper = { kind: 'colour', value: '#75507b' };
  await sa.flush();
  sb.data.wallpaper = { kind: 'picture', path: '/Pictures/Sunset.png' };
  await sb.flush();
  const saved = JSON.parse(await a.readText(SESSION_PATH));
  assert.deepEqual(saved.wallpaper, { kind: 'picture', path: '/Pictures/Sunset.png' });
});

test('SET-P1-1: a tab that changed a setting back to what it read still keeps it over another tab\'s change', { todo: 'P1' }, async () => {
  const { a, b } = twoTabs();
  const sa = new Session(a);
  const sb = new Session(b);
  await sa.load();
  await sb.load();
  // Tab A turns on Dark. Tab B (still on Standard) tries Glass, then goes back to Standard before its save.
  sa.data.theme = 'dark';
  await sa.flush();
  sb.data.theme = 'glass';
  sb.data.theme = 'xfce';
  await sb.flush();
  const fresh = new Session(a);
  await fresh.load();
  // Tab B shows Standard; the person's last click was Standard. Reloading tab B must not turn it Dark.
  assert.equal(fresh.data.theme, 'xfce');
});
