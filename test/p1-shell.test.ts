// Shell-wide P1 faults (no browser): a refusal from the server is shown in the server's own words; the owner's
// password prompt sends Enter to the guarded action; closing a window with unsaved work can save it first; one close
// question per window at a time. The browser halves are in test/browser-audit-appstore.mjs (Enter in the delete prompt),
// test/browser-audit-write.mjs, test/browser-audit-notepad.mjs and test/browser-audit-notepadpro.mjs (Save on close).
// Run: node --test test/p1-shell.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describeError, isLockRefusal, isSignedOutRefusal } from '../src/shell/dialogs.ts';
import { AuthFailure } from '../src/auth/api.ts';
import { StoreError } from '../src/store/store.ts';
import { FileSystem } from '../src/fs/fs.ts';
import { MemoryStore } from '../src/store/memory-store.ts';
import { Session, SESSION_PATH } from '../src/shell/session.ts';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('AS-P1-5: a refusal from the server (wrong password, fingerprint, zip turned off) is shown in its own words', () => {
  for (const words of ['That password is not right.', 'The zip extension is turned off on this server.', 'The app does not match its fingerprint.']) {
    assert.equal(describeError(new AuthFailure(403, words, {})), words);
  }
  // The server could not be reached: its own words too, not "Reload the page".
  assert.match(describeError(new AuthFailure(0, "The desktop's server could not be reached. Check the connection, then try again.", {})), /could not be reached/);
});

test('AS-P1-5: a fault in the desktop itself still gets the general words (no stack trace)', () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.match(describeError(new TypeError('x is undefined')), /Something unexpected went wrong/);
  } finally {
    console.error = quiet;
  }
});

test('AS-P1-6: in the owner\'s password prompt the guarded action is the primary button (Enter does it), and Cancel is never held back by the password', () => {
  const src = read('src/auth/identity.ts');
  assert.match(src, /\{ label: options\.ok, value: true, primary: true, danger: options\.danger \}/);
  assert.match(src, /\{ label: 'Cancel', value: false \}/);
});

test('close with unsaved work: the shell offers Save when the app gives a save, and stays open when it fails', () => {
  const win = read('src/shell/windows.ts');
  assert.match(win, /save: \(\(\) => Promise<boolean>\) \| null = null/);
  assert.match(win, /if \(win\.dirty && win\.save\) \{\s+const answer = await this\.confirmClose\(win\.title, true\);/);
  assert.match(win, /answer === 'save' && !\(await win\.save!\(\)\)\) return false;/);
  const shell = read('src/shell/shell.ts');
  assert.match(shell, /label: 'Save', value: 'save', primary: true/);
  assert.match(shell, /onSave: save => \{\s+win\.save = save;/);
  assert.match(read('src/shell/types.ts'), /onSave\?\(save: \(\) => Promise<boolean>\): void;/);
});

test('W-P1-5 / NP-P1-1 / N-P1-4 / PRJ: Write, Notepad, Notepad Pro and My Projects give the shell their save', () => {
  for (const path of ['src/apps/write.ts', 'src/apps/editor.ts', 'src/apps/notepadpro.ts', 'src/apps/projects.ts']) {
    assert.match(read(path), /app\.onSave\?\.\(/, `${path} gives no save to the close question`);
  }
});

test('TM-P1-4: one close question per window at a time (End task held down does not stack them)', () => {
  const win = read('src/shell/windows.ts');
  assert.match(win, /if \(win\.closing\) return win\.closing;/);
});

test('signed out: a refusal because the session ended is told apart from every other error (no error box for it)', () => {
  assert.equal(isSignedOutRefusal(new AuthFailure(401, 'You are signed out. Sign in again to carry on.', { auth: 'signin' })), true);
  assert.equal(isSignedOutRefusal(new StoreError('You are signed out. Sign in again to carry on.', 401)), true);
  // A wrong password at the sign-in screen is a 401 too, but not an ended session; locked is the lock screen's own case.
  assert.equal(isSignedOutRefusal(new AuthFailure(401, 'That password is not right.', {})), false);
  assert.equal(isSignedOutRefusal(new StoreError('The screen is locked.', 423)), false);
  assert.equal(isLockRefusal(new StoreError('The screen is locked.', 423)), true);
  assert.equal(isSignedOutRefusal(new StoreError('The server could not be reached.')), false);
  assert.equal(isSignedOutRefusal(new Error('x')), false);
  // The shell's report() is where the rule is kept, for every app's background work.
  assert.match(read('src/shell/shell.ts'), /async report\(title: string, error: unknown\): Promise<void> \{\s*\/\/[^\n]*\n\s*if \(isSignedOutRefusal\(error\)\) return;/);
});

test('signed out: desktop settings changed meanwhile wait, and are written when the same person is back', async () => {
  const g = globalThis as unknown as { window?: unknown };
  const hadWindow = 'window' in g;
  if (!hadWindow) g.window = globalThis;
  try {
    const fs = new FileSystem(new MemoryStore());
    const s = new Session(fs);
    await s.load();
    s.hold(true);
    s.data.theme = 'dark';
    s.touch();
    await s.flush();
    assert.equal(await fs.stat(SESSION_PATH), null, 'nothing written while the session has ended');
    s.hold(false);
    await s.flushWaiting();
    assert.equal(JSON.parse(await fs.readText(SESSION_PATH)).theme, 'dark', 'written once back');
  } finally {
    if (!hadWindow) delete g.window;
  }
});
