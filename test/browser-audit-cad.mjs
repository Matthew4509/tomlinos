// CAD Draft audit (26 Nov): faults found by trying to break the app in a real Chrome. Each step fails while its fault
// is there. Needs the dev server on a FRESH, EMPTY data folder (the first step sets up the owner), and out/ built.
//   node test/browser-audit-cad.mjs [http://127.0.0.1:3108]
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3108';
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PASS = 'cad-audit-passphrase-61';
let passed = 0;
const failures = [];
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: 'en-GB' });
const page = await context.newPage();
page.setDefaultTimeout(10000);
const problems = [];
page.on('console', m => m.type() === 'error' && problems.push('console: ' + m.text()));
page.on('pageerror', e => problems.push('pageerror: ' + e.message));
page.on('response', r => r.status() >= 400 && console.log('   (http ' + r.status() + ': ' + r.url() + ')'));
async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (error) {
    failures.push(name);
    console.log('  FAIL ' + name + '\n       ' + String(error.message).slice(0, 1500));
    for (let i = 0; i < 3 && (await page.locator('.dialog').count()); i++) await page.keyboard.press('Escape').catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
  }
}
const eq = (a, b, what) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const ok = (v, what) => {
  if (!v) throw new Error(what);
};
const W = () => page.locator('.win', { has: page.locator('.cad') }).last();
const D = () => page.locator('.dialog').last();
const canvas = () => W().locator('.cad-canvas');
async function cmd(...entries) {
  for (const e of entries) {
    if (e === '' && (await W().locator('.cad-done').isVisible())) {
      await W().locator('.cad-done').click();
      continue;
    }
    const box = W().locator('.cad-command-line input:visible').first();
    await box.fill(e);
    await box.press('Enter');
  }
}
const said = async (n = 3) => (await W().locator('.cad-said').allInnerTexts()).slice(-n).join(' | ');
const count = async layer => Number(await W().locator('.cad-layer', { hasText: layer }).locator('.cad-count').innerText());
const xy = async () => {
  const [x, y] = await W().locator('.cad-xy').allInnerTexts();
  return [Number(x.slice(2)), Number(y.slice(2))];
};
async function openCad() {
  if (!(await page.locator('.start-filter').isVisible())) await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('cad draft');
  await page.locator('.start-menu [data-label="cad draft"]').first().click();
  await canvas().waitFor();
  await W().getByRole('button', { name: 'Maximise' }).click();
  await page.waitForTimeout(300);
}
async function mapper() {
  const box = await canvas().boundingBox();
  await cmd('line');
  await page.keyboard.press('F3');
  const a = { x: box.x + 200, y: box.y + 150 };
  const b = { x: box.x + 600, y: box.y + 450 };
  await page.mouse.move(a.x, a.y);
  const wa = await xy();
  await page.mouse.move(b.x, b.y);
  const wb = await xy();
  await page.keyboard.press('F3');
  await page.keyboard.press('Escape');
  const kx = (b.x - a.x) / (wb[0] - wa[0]);
  const ky = (b.y - a.y) / (wb[1] - wa[1]);
  return (x, y) => ({ x: a.x + (x - wa[0]) * kx, y: a.y + (y - wa[1]) * ky });
}
async function listAt(at, x, y) {
  await cmd('list');
  const p = at(x, y);
  await page.mouse.click(p.x, p.y);
  const t = await D().innerText();
  await D().getByRole('button').first().click();
  await page.keyboard.press('Escape');
  return t;
}
async function clearAll() {
  await page.keyboard.press('Escape');
  await canvas().focus();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
}

await page.goto(BASE);
await step('set up a fresh desktop', async () => {
  await page.locator('.gate h1', { hasText: 'Set up this desktop' }).waitFor({ timeout: 20000 });
  await page.getByLabel('Your name').fill('CAD Auditor');
  await page.locator('.gate input.gate-input').last().fill(PASS);
  await page.locator('.gate-encrypt').uncheck();
  await page.locator('.gate-go').click();
  await page.locator('.gate h1', { hasText: 'Your recovery key' }).waitFor({ timeout: 30000 });
  await page.locator('.gate .check-row input').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#desktop .item').first().waitFor({ timeout: 20000 });
  await openCad();
});

await step('CAD-P1-1: a radius typed with a decimal comma (12,5) is not taken as the point 12,5 (a circle of radius 13)', async () => {
  await cmd('circle', '0,0', '12,5');
  await page.keyboard.press('Escape');
  await W().getByRole('button', { name: 'Zoom fit: the whole drawing' }).click();
  const at = await mapper();
  await cmd('list');
  const p = at(0, 13);
  await page.mouse.click(p.x, p.y);
  const made = await D().waitFor({ timeout: 1500 }).then(() => true, () => false);
  const text = made ? await D().innerText() : '';
  if (made) await D().getByRole('button').first().click();
  await page.keyboard.press('Escape');
  await clearAll();
  ok(!text.includes('Radius 13'), 'typed 12,5 at "Radius" and got, without a word: ' + text.replace(/\n/g, ' / '));
});

await step('CAD-P1-2: drawing on the current layer while it is hidden says so (the new items cannot be seen)', async () => {
  const tick = W().locator('.cad-layer', { hasText: 'Geometry' }).locator('input, button').first();
  await tick.click();
  await cmd('line', '0,0', '100,0', '');
  const words = await said(4);
  const n = await count('Geometry');
  await tick.click();
  await clearAll();
  eq(n, 1, 'the line was made');
  ok(/hidden/i.test(words), 'a line drawn onto the hidden Geometry layer, nothing said: ' + words);
});

await step('no errors in the console (the desktop set-up store.php 404 is not CAD Draft)', async () => {
  const mine = problems.filter(p => !/status of 404/.test(p));
  ok(!mine.length, mine.join('\n'));
});
await browser.close();
console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? ': ' + failures.join('; ') : ''}`);
process.exit(failures.length ? 1 : 0);
