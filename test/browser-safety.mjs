// Saving, locking and starting safely, in a real Chrome: a save made while typing leaves the new typing
// marked unsaved; a save over a file another tab saved meanwhile asks first; a lock the server never got (it could not
// be reached) lets no PIN through and survives a reload; and a storage.json that cannot be read stops the start
// instead of opening an empty desktop kept in the browser. Needs the dev server on a FRESH, EMPTY data folder and
// `npm run build` done.
//   node test/browser-safety.mjs [http://127.0.0.1:3043]
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3043';
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PASS = 'quarry-lantern-meadow-73';
let passed = 0;
const failures = [];

async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (error) {
    failures.push(name);
    console.log('  FAIL ' + name + '\n       ' + String(error.message).slice(0, 1200));
    // What the page showed, so a failure says where it stopped.
    const shown = await page.locator('body').innerText().catch(() => '');
    console.log('       page shows: ' + shown.replace(/\s+/g, ' ').slice(0, 400));
  }
}
const eq = (a, b, what) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const ok = (v, what) => {
  if (!v) throw new Error(what);
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const problems = [];
page.on('pageerror', e => problems.push('pageerror: ' + e.message));
const front = p => p.locator('.win.active');
const openApp = async (p, label) => {
  await p.locator('.start-btn').click();
  await p.locator('.start-filter').fill(label);
  await p.locator(`.start-menu [data-label="${label}"]`).first().click();
};
// Matchers for page.route (functions: in a glob, "?" is not the literal question mark of an address).
const COMMIT = url => url.pathname.endsWith('/api/store.php') && url.searchParams.get('op') === 'commit';
const LOCK = url => url.pathname.endsWith('/api/auth.php') && url.searchParams.get('op') === 'lock';
const STORAGE = url => url.pathname.endsWith('/storage.json');
const storeStatus = p => p.evaluate(() => fetch('/api/store.php?key=/', { headers: { 'X-Desktop-Store': '1' } }).then(r => r.status));
/** Closes every window on page p, answering "not saved" with close-without-saving. */
async function closeAll(p) {
  for (let i = 0; i < 30; i++) {
    const dialog = p.locator('.dialog');
    if (await dialog.count()) {
      await dialog.getByRole('button', { name: /without saving|Do not save/ }).first().click();
      continue;
    }
    const wins = p.locator('.win');
    if (!(await wins.count())) return;
    await wins.last().locator('.win-close').first().click();
    await p.waitForTimeout(80);
  }
  throw new Error('windows would not close');
}
/** Opens Documents/note.txt in Notepad on page p (every other window closed first); returns its window. */
async function openNote(p) {
  await closeAll(p);
  await p.keyboard.press('Control+Alt+e');
  await front(p).locator('.item', { hasText: 'Documents' }).first().dblclick();
  await front(p).locator('.item', { hasText: 'note' }).first().dblclick();
  const n = p.locator('.win', { has: p.locator('.editor') });
  await p.waitForFunction(() => document.querySelector('.editor textarea')?.value.length > 0);
  return n;
}
/** The file as the server has it, read fresh in a new tab of the same person. */
async function noteNow() {
  const p = await context.newPage();
  await p.goto(BASE);
  await p.locator('#desktop .item').first().waitFor({ timeout: 20000 });
  const n = await openNote(p);
  const text = await n.locator('textarea').inputValue();
  await p.close();
  return text;
}

console.log('Saving, locking and starting safely, against ' + BASE);
await page.goto(BASE);

await step('set up the owner (files encrypted, the default)', async () => {
  await page.locator('.gate h1', { hasText: 'Set up this desktop' }).waitFor({ timeout: 20000 });
  await page.getByLabel('Your name').fill('Sample Owner');
  await page.locator('.gate input.gate-input').last().fill(PASS);
  ok(await page.locator('.gate-encrypt').isChecked(), 'encryption is ticked by default');
  await page.locator('.gate-go').click();
  await page.locator('.gate h1', { hasText: 'Your recovery key' }).waitFor({ timeout: 30000 });
  await page.locator('.gate .check-row input').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#desktop .item').first().waitFor({ timeout: 20000 });
  // The lock steps below read the plain lock screen, not the Reader front (browser-touch.mjs covers that one).
  eq(await page.evaluate(() => fetch('api/auth.php?op=site-front', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'X-Desktop-Store': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ front: 'signin' }),
  }).then(r => r.status)), 200, 'the sign-in page is the front');
});

const dir = tempDir('tomlinos-safety-');
await step('upload a text file into Documents', async () => {
  writeFileSync(join(dir, 'note.txt'), 'one');
  await page.keyboard.press('Control+Alt+e');
  const w = front(page);
  await w.locator('.item', { hasText: 'Documents' }).first().dblclick();
  const chooser = page.waitForEvent('filechooser');
  await w.getByRole('button', { name: 'Upload' }).click();
  (await chooser).setFiles([join(dir, 'note.txt')]);
  await w.locator('.item', { hasText: 'note' }).first().waitFor({ timeout: 15000 });
  await w.getByRole('button', { name: 'Close' }).click();
});

await step('typing while a save is on its way stays marked "not saved"', async () => {
  const n = await openNote(page);
  const area = n.locator('textarea');
  await area.press('End');
  await area.pressSequentially(' two');
  // Every save is held up on its way to the server for a moment, so the next typing lands while this one is in flight.
  let held = 0;
  await page.route(COMMIT, async route => {
    held++;
    await new Promise(r => setTimeout(r, 1500));
    await route.continue();
  });
  await area.press('Control+s');
  await page.waitForTimeout(300);
  await area.pressSequentially(' three');
  await page.locator('.toast', { hasText: 'Saved “note.txt”' }).waitFor({ timeout: 15000 });
  await page.unroute(COMMIT);
  ok(held > 0, 'the save went through the held-up route');
  ok((await n.locator('.editor-status').innerText()).includes('not saved'), 'status: ' + (await n.locator('.editor-status').innerText()));
  eq(await noteNow(), 'one two', 'what the server has: the text as it was when Save was pressed');
  // Closing asks, because " three" is not saved.
  await n.getByRole('button', { name: 'Close' }).click();
  await page.locator('.dialog').waitFor({ timeout: 5000 });
  await page.locator('.dialog').getByRole('button', { name: /without saving|Close anyway|Lose/ }).first().click();
});

await step('saving over a copy another tab saved meanwhile asks first; "Do not save" keeps theirs, "Replace it" writes mine', async () => {
  const mine = await openNote(page);
  const other = await context.newPage();
  await other.goto(BASE);
  await other.locator('#desktop .item').first().waitFor({ timeout: 20000 });
  const theirs = await openNote(other);
  await theirs.locator('textarea').fill('from the other tab');
  await theirs.locator('textarea').press('Control+s');
  await other.locator('.toast', { hasText: 'Saved' }).waitFor({ timeout: 15000 });
  await other.close();

  await mine.locator('textarea').fill('from this tab');
  await mine.locator('textarea').press('Control+s');
  const ask = page.locator('.dialog', { hasText: 'Changed somewhere else' });
  await ask.waitFor({ timeout: 10000 });
  await ask.getByRole('button', { name: 'Do not save' }).click();
  eq(await noteNow(), 'from the other tab', 'their copy is kept');
  ok((await mine.locator('.editor-status').innerText()).includes('not saved'), 'mine is still unsaved');

  await mine.locator('textarea').press('Control+s');
  await ask.waitFor({ timeout: 10000 });
  await ask.getByRole('button', { name: 'Replace it' }).click();
  await page.locator('.toast', { hasText: 'Saved “note.txt”' }).last().waitFor({ timeout: 15000 });
  eq(await noteNow(), 'from this tab', 'mine replaced it after asking');
  await mine.getByRole('button', { name: 'Close' }).click();
});

await step('set a PIN and the spreadsheet screensaver', async () => {
  await closeAll(page);
  await openApp(page, 'my account');
  const w = page.locator('.win', { has: page.locator('.account') });
  await w.locator('.acct-tab', { hasText: 'Sign-in options' }).click();
  await w.getByRole('button', { name: 'Set a PIN...' }).click();
  await w.locator('.acct-form input[autocomplete=current-password]').fill(PASS);
  await w.locator('.acct-form input[maxlength="4"]').fill('4821');
  await w.getByRole('button', { name: 'Save PIN' }).click();
  await w.getByText('Set. The locked screen opens with your 4-digit PIN.').waitFor();
  await w.locator('.acct-tab', { hasText: 'Screensaver and lock' }).click();
  // Other tabs of this person's were saving too: a clash (409) is retried, so wait for the save that went through.
  const written = page.waitForResponse(r => r.url().includes('store.php') && r.request().method() === 'POST' && r.status() === 200, { timeout: 15000 });
  await w.locator('select:has(option[value="sheet"])').selectOption('sheet');
  await written;
  await w.getByRole('button', { name: 'Close' }).click();
});

await step('a lock the server never got lets no PIN through, and a reload does not open the desktop', async () => {
  await page.route(LOCK, route => route.abort());
  await page.locator('.start-btn').click();
  await page.locator('.start-lock').click();
  await page.locator('#layer-lock .fake-sheet').waitFor({ timeout: 10000 });
  await page.locator('#layer-lock .fake-close').click();
  await page.locator('#layer-lock .lock-pin').waitFor({ timeout: 10000 });
  eq(await storeStatus(page), 200, 'the server never got the lock');
  // Before: the server said "not locked, carry on" to any PIN. Now no PIN is tried until the server holds the lock.
  await page.locator('.lock-pin').fill('0000');
  await page.locator('.gate-problem', { hasText: 'cannot be reached' }).waitFor({ timeout: 10000 });
  ok(await page.locator('#layer-lock .lock-pin').isVisible(), 'still on the lock screen');
  // Reloaded while the lock still cannot get through: nothing opens.
  await page.reload();
  await page.locator('.fatal h1', { hasText: 'could not start' }).waitFor({ timeout: 20000 });
  eq(await page.locator('#desktop .item').count(), 0, 'no desktop');
  // The connection is back: the reload locks the session on the server first, then asks for the PIN.
  await page.unroute(LOCK);
  await page.reload();
  await page.locator('.gate h1', { hasText: 'Locked' }).waitFor({ timeout: 20000 });
  eq(await storeStatus(page), 423, 'the server holds the lock now');
  await page.locator('.lock-pin').fill('4821');
  await page.locator('#desktop .item').first().waitFor({ timeout: 20000 });
  eq(await storeStatus(page), 200, 'open again with the right PIN');
});

await step('a lock that gets through once the connection is back unlocks with the PIN, without a reload', async () => {
  let blocked = true;
  await page.route(LOCK, route => (blocked ? route.abort() : route.continue()));
  await page.locator('.start-btn').click();
  await page.locator('.start-lock').click();
  await page.locator('#layer-lock .fake-close').click();
  await page.locator('#layer-lock .lock-pin').waitFor({ timeout: 10000 });
  blocked = false;
  await page.waitForTimeout(6000); // the lock is asked for again every few seconds
  eq(await storeStatus(page), 423, 'the retry got the lock to the server');
  await page.locator('.lock-pin').fill('4821');
  await page.locator('#desktop .item').first().waitFor({ timeout: 20000 });
  await page.unroute(LOCK);
});

await step('a storage.json that cannot be read stops the start; it never opens an empty desktop in the browser', async () => {
  const p = await context.newPage();
  for (const [answer, words] of [[{ status: 500, body: 'oops' }, 'answered 500'], [{ status: 200, body: 'not json' }, 'damaged'], [{ status: 200, body: '{}' }, 'names no place']]) {
    await p.route(STORAGE, route => route.fulfill({ ...answer, contentType: 'application/json' }));
    await p.goto(BASE);
    await p.locator('.fatal h1', { hasText: 'could not start' }).waitFor({ timeout: 20000 });
    ok((await p.locator('.fatal').innerText()).includes(words), `says why (${words}): ${await p.locator('.fatal').innerText()}`);
    eq(await p.locator('#desktop .item').count(), 0, 'no desktop');
    await p.unroute(STORAGE);
  }
  await p.close();
});

await step('no page errors', async () => {
  eq(problems, [], 'page errors');
});

// Chrome on this PC sometimes never finishes closing (seen in the aichat suite too): the result is not held up by it.
await Promise.race([browser.close(), new Promise(r => setTimeout(r, 10000))]);
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log('  - ' + f);
}
process.exit(failures.length ? 1 : 0);
