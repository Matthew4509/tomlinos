// Terminal audit (browser): faults found by trying to break it. Steps marked P0 fail now and pass once fixed; "info"
// lines are P1 findings (reported, not failed). The engine's own faults are in test/audit-terminal.test.ts.
// Needs the dev server on a FRESH, EMPTY data folder (the first step sets up the owner), and out/ built.
//   node test/browser-audit-terminal.mjs [http://127.0.0.1:3131] [screenshot folder]
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3131';
const SHOTS = process.argv[3] ?? null;
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PASS = 'terminal-audit-passphrase-77';
let passed = 0;
const failures = [];
const dir = mkdtempSync(join(tmpdir(), 'term-audit-'));
// 30,000 short lines (about 60 KB): a plain log or a list of numbers, well under the 512 KB the terminal shows.
writeFileSync(join(dir, 'k30.txt'), 'z\n'.repeat(30000));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage();
const problems = [];
page.on('pageerror', e => problems.push('pageerror: ' + e.message));
const shot = async name => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });
async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (error) {
    failures.push(name);
    await shot('fail-' + failures.length).catch(() => {});
    console.log('  FAIL ' + name + '\n       ' + String(error.message).slice(0, 1500));
  }
}
const info = (id, text) => console.log(`  info ${id} ${text}`);
const ok = (v, what) => {
  if (!v) throw new Error(what);
};

const term = () => page.locator('.terminal').first();
const inp = () => term().locator('input.term-in');
const rows = async (n = 5) => (await term().locator('.term-row').allInnerTexts()).slice(-n);
async function type(cmd, timeout = 60000) {
  await inp().fill(cmd);
  const t0 = Date.now();
  await inp().press('Enter');
  await page.waitForFunction(i => !i.disabled, await inp().elementHandle(), { timeout });
  return Date.now() - t0;
}

await page.goto(BASE);
await step('set up a fresh desktop, upload k30.txt to Documents, open the Terminal (Ctrl+Alt+T)', async () => {
  await page.locator('.gate h1', { hasText: 'Set up this desktop' }).waitFor({ timeout: 20000 });
  await page.getByLabel('Your name').fill('Audit Tester');
  const user = page.getByLabel('User name (for signing in)');
  if (await user.count()) await user.fill('tester');
  await page.locator('.gate input.gate-input').last().fill(PASS);
  const encrypt = page.locator('.gate-encrypt');
  if (await encrypt.count()) await encrypt.uncheck();
  await page.locator('.gate-go').click();
  await page.locator('.gate h1', { hasText: 'Your recovery key' }).waitFor({ timeout: 30000 });
  await page.locator('.gate .check-row input').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#desktop .item').first().waitFor({ timeout: 20000 });
  await page.keyboard.press('Control+Alt+e');
  const ew = () => page.locator('.win', { has: page.locator('.explorer') }).first();
  await ew().locator('.item', { has: page.locator('.item-name', { hasText: /^Documents$/ }) }).first().dblclick();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), ew().getByRole('button', { name: 'Upload' }).click()]);
  await chooser.setFiles([join(dir, 'k30.txt')]);
  await ew().locator('.item-name', { hasText: /^k30\.txt$/ }).waitFor({ timeout: 15000 });
  await ew().locator('.win-close, [aria-label=Close]').first().click();
  await page.keyboard.press('Control+Alt+t');
  await inp().waitFor();
});

await step('T-P0-5: cat of a 30,000-line text file does not freeze the desktop (took about 5 s; 250,000 lines froze it for minutes)', async () => {
  await type('cd Documents');
  const ms = await type('cat k30.txt', 120000);
  ok(ms < 1500, `cat k30.txt held the page for ${ms} ms: print() adds every line to the page, then removes the extras one by one`);
});

await step('T-P0-1 (browser): echo > /System/session.json is refused, as rm and mv are', async () => {
  await page.waitForTimeout(3000);
  const before = (await type('cat /System/session.json'), await rows(1))[0];
  await type('echo broken > /System/session.json');
  await type('cat /System/session.json');
  const after = (await rows(1))[0];
  ok(after !== 'broken', `the desktop's own settings file now reads "${after}" (was ${before.slice(0, 60)}...)`);
});

await step('T-P1-13: a prompt five folders deep wraps instead of scrolling the screen sideways', async () => {
  const deep = 'Documents/' + Array.from({ length: 5 }, (_, i) => 'Project Archive 202' + i).join('/');
  await type(`mkdir -p "${deep}"`);
  await type(`cd "${deep}"`);
  const s = await term().locator('.term-screen').evaluate(el => ({ sw: el.scrollWidth, cw: el.clientWidth }));
  const w = (await inp().boundingBox())?.width ?? 0;
  await type('cd /');
  ok(s.sw <= s.cw + 2 && w >= 80, `the screen is ${s.sw} px wide in ${s.cw} and the input is ${Math.round(w)} px wide`);
});

await step('T-P1-14: pasting two lines runs the first and leaves the second in the line', async () => {
  await inp().focus();
  await page.evaluate(() => navigator.clipboard.writeText('cd Documents\nls'));
  await page.keyboard.press('Control+v');
  await page.waitForFunction(i => !i.disabled && i.value === 'ls', await inp().elementHandle(), { timeout: 10000 }).catch(() => {});
  const pasted = await inp().inputValue();
  const where = await term().locator('.term-line .term-path').innerText();
  await inp().fill('');
  await type('cd /');
  ok(pasted === 'ls', `the line holds ${JSON.stringify(pasted)}`);
  ok(where.includes('Documents'), `the pasted "cd Documents" did not run (prompt ${where})`);
});

await step('P1 checks (reported as info)', async () => {
  // A second terminal: Ctrl+Alt+T only brings the first one forward.
  await page.keyboard.press('Control+Alt+t');
  await page.waitForTimeout(1000);
  const n = await page.locator('.terminal').count();
  if (n < 2) info('T-P1-15', 'Ctrl+Alt+T with a Terminal open brings the same window forward; there is no way to open a second terminal on the same folder');
});

console.log(problems.length ? '  page errors: ' + problems.join(' | ') : '  no page errors');
console.log(`\n${passed} passed, ${failures.length} failed`);
await browser.close();
rmSync(dir, { recursive: true, force: true });
process.exit(failures.length ? 1 : 0);
