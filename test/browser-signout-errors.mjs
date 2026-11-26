// The session ends under an open desktop: background work that fails because of it shows no error boxes behind the
// sign-in screen, a settings change made just before is kept once the same person signs in again, File Explorer shows its
// folder again, and when someone else signs in instead nothing of the first person's is written into their account.
// Needs the dev server on a FRESH, EMPTY data folder and `npm run build` done.
//   node test/browser-signout-errors.mjs [http://127.0.0.1:3043]
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3043';
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PASS = 'orchard-lantern-harbour-58';
const PASS2 = 'meadow-copper-signal-73';
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
  }
}
const eq = (a, b, what) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const ok = (v, what) => {
  if (!v) throw new Error(what);
};

const GREEN = 'rgb(75, 127, 79)';
const PLUM = 'rgb(117, 80, 123)';
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const settle = (ms, p = page) => p.waitForTimeout(ms);
const win = (title, p = page) => p.locator('.win', { has: p.locator('.win-title-text', { hasText: title }) });
const explorer = () => page.locator('.win', { has: page.locator('.explorer') }).first();
const openApp = async (label, p = page) => {
  await p.locator('.start-btn').click();
  await p.locator('.start-filter').fill(label);
  await p.locator(`.start-menu [data-label="${label.toLowerCase()}"]`).first().click();
};
const colour = (p = page) => p.evaluate(() => getComputedStyle(document.getElementById('wallpaper')).backgroundColor);
const dialogs = () => page.locator('#layer-modal .dialog-title').allInnerTexts();
const call = (p, op, body) => p.evaluate(([op, body]) => fetch(`api/auth.php?op=${op}`, {
  method: body ? 'POST' : 'GET', credentials: 'same-origin',
  headers: { 'X-Desktop-Store': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}).then(async r => ({ status: r.status, json: await r.json().catch(() => null) })), [op, body]);
const signIn = async (p, name, password) => {
  await p.locator('.gate h1', { hasText: 'Sign in' }).waitFor({ timeout: 20000 });
  await p.locator('.gate input[autocomplete=username]').fill(name);
  await p.locator('.gate input[type=password]').fill(password);
  await p.locator('.gate-go').click();
};
const desktopBack = async (p = page) => {
  await p.locator('.gate').first().waitFor({ state: 'detached', timeout: 20000 });
  for (let i = 0; i < 50 && await p.evaluate(() => getComputedStyle(document.getElementById('screen')).visibility === 'hidden'); i++) await settle(200, p);
};
/**
 * Ends this page's session on the server, as signing out in another tab or an idle sign-out would, then has the page
 * fail some background work: a change notice from another tab (File Explorer and the desktop read their folders again)
 * and coming back to the tab (the Recycle Bin's clearing runs).
 */
const endSessionUnderneath = async () => {
  eq((await call(page, 'logout', {})).status, 200, 'logged out on the server');
  const other = await context.newPage();
  await other.goto(BASE + '/version.json');
  await other.evaluate(() => new BroadcastChannel('tomlinos-changes').postMessage(['/']));
  await other.close();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.locator('.gate h1', { hasText: 'Sign in' }).waitFor({ timeout: 20000 });
  // Give the failing work time to come back (the settings save waits 800 ms before it writes).
  await settle(2500);
};

console.log('Errors after the session ends, against ' + BASE);
await page.goto(BASE);

await step('set-up: the owner, the sign-in page, a second person', async () => {
  await page.locator('.gate h1', { hasText: 'Set up this desktop' }).waitFor({ timeout: 20000 });
  await page.getByLabel('Your name').fill('Sam');
  await page.locator('.gate input[type=password]').fill(PASS);
  await page.locator('.gate-go').click();
  await page.locator('.gate h1', { hasText: 'Your recovery key' }).waitFor({ timeout: 30000 });
  await page.locator('.gate .check-row input').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#desktop .item').first().waitFor({ timeout: 20000 });
  eq((await call(page, 'site-front', { front: 'signin' })).status, 200, 'sign-in page on');
  eq((await call(page, 'user-create', { name: 'robin', display: 'Robin', next: PASS2, password: PASS })).status, 200, 'second person added');
});

await step('File Explorer and Settings are open; Green is chosen just before the session ends', async () => {
  await page.keyboard.press('Control+Alt+e');
  await explorer().locator('.item', { hasText: 'Documents' }).waitFor({ timeout: 15000 });
  await openApp('Settings');
  await win('Settings').getByRole('radiogroup', { name: 'Background colour' }).waitFor();
  await win('Settings').getByRole('radiogroup', { name: 'Background colour' }).getByRole('radio', { name: 'Green', exact: true }).click();
  eq(await colour(), GREEN, 'green on screen');
  await endSessionUnderneath();
});

await step('signing back in as the same person: no error boxes waiting', async () => {
  await signIn(page, 'sam', PASS);
  await desktopBack();
  await settle(3000);
  eq(await dialogs(), [], 'error boxes after signing in again');
});

await step('File Explorer shows its folder again, not the signed-out words', async () => {
  const w = explorer();
  await w.locator('.item', { hasText: 'Documents' }).waitFor({ timeout: 10000 });
  ok(!(await w.innerText()).includes('signed out'), 'still says signed out: ' + (await w.innerText()).slice(0, 300));
});

await step('the setting changed as the session ended is kept (a new tab reads Green from the server)', async () => {
  const other = await context.newPage();
  await other.goto(BASE);
  await other.locator('#desktop .item').first().waitFor({ timeout: 20000 });
  eq(await colour(other), GREEN, 'background in a new tab');
  await other.close();
});

await step('someone else signs in after the session ends: nothing of the first person is written into either account', async () => {
  await win('Settings').getByRole('radiogroup', { name: 'Background colour' }).getByRole('radio', { name: 'Plum', exact: true }).click();
  eq(await colour(), PLUM, 'plum on screen');
  await endSessionUnderneath();
  const reloaded = page.waitForEvent('framenavigated', { timeout: 20000 });
  await signIn(page, 'robin', PASS2);
  // Someone else: the page starts afresh as Robin's desktop.
  await reloaded;
  await page.locator('#desktop .item').first().waitFor({ timeout: 30000 });
  await page.locator('.start-btn').click();
  ok((await page.locator('.start-head').innerText()).includes('Robin'), "Robin's desktop");
  await page.keyboard.press('Escape');
  await settle(1500);
  ok(await colour() !== PLUM, "Robin's desktop took Sam's Plum");
  ok(await colour() !== GREEN, "Robin's desktop took Sam's Green");
  // Sam, in a browser of their own: Green, as last saved by Sam, not Plum.
  const own = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const sam = await own.newPage();
  await sam.goto(BASE);
  await signIn(sam, 'sam', PASS);
  await sam.locator('#desktop .item').first().waitFor({ timeout: 30000 });
  eq(await colour(sam), GREEN, "Sam's background");
  await own.close();
});

await browser.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
