// The classic menu bar in the apps that have it (Write, Spreadsheet, Notepad, Notepad Pro, File Explorer, Calculator), in
// a real Chrome: each opens in the Classic look with the shared menu bar, every menu opens, and checkShortcuts() finds no
// item showing a key the browser keeps for itself (Ctrl+N, Ctrl+W, Ctrl+T...), submenus included.
// Needs the dev server on a FRESH, EMPTY data folder (the first step sets up the owner), and `npm run build` done.
//   node test/browser-classic-menus.mjs [http://127.0.0.1:3101]
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3101';
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PASS = 'orchard-lantern-harbour-58';
let passed = 0;
const failures = [];

async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (error) {
    failures.push(name);
    console.log('  FAIL ' + name + '\n       ' + String(error.message).slice(0, 800));
  }
}
const eq = (a, b, what) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const ok = (v, what) => {
  if (!v) throw new Error(what);
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const problems = [];
page.on('pageerror', e => problems.push('pageerror: ' + e.message));

async function closeAll() {
  for (let i = 0; i < 40; i++) {
    const dialog = page.locator('.dialog');
    if (await dialog.count()) {
      await dialog.getByRole('button', { name: /without saving|Close anyway|Cancel|OK/ }).first().click().catch(() => dialog.getByRole('button').last().click());
      continue;
    }
    const wins = page.locator('.win');
    if (!(await wins.count())) return;
    await wins.last().locator('.win-close').first().click();
    await page.waitForTimeout(80);
  }
}
async function openApp(label) {
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill(label);
  await page.locator(`.start-menu [data-label="${label}"]`).first().click();
}

console.log('Classic menu bars, against ' + BASE);
await page.goto(BASE);

await step('set up the owner', async () => {
  await page.locator('.gate h1', { hasText: 'Set up this desktop' }).waitFor({ timeout: 20000 });
  await page.getByLabel('Your name').fill('Sample Owner');
  await page.locator('.gate input.gate-input').last().fill(PASS);
  if (await page.locator('.gate-encrypt').count()) await page.locator('.gate-encrypt').uncheck();
  await page.locator('.gate-go').click();
  await page.locator('.gate .check-row input').check({ timeout: 30000 });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#desktop .item').first().waitFor({ timeout: 20000 });
});

const APPS = [
  { label: 'write', name: 'Write', root: '.write', menus: ['File', 'Edit', 'View', 'Insert', 'Format', 'Table', 'Tools', 'Help'], toolbar: true },
  { label: 'spreadsheet', name: 'Spreadsheet', root: '.sheet', menus: ['File', 'Edit', 'View', 'Insert', 'Format', 'Tools', 'Data', 'Help'], toolbar: false },
  { label: 'notepad', name: 'Notepad', root: '.editor', menus: ['File', 'Edit', 'Format', 'View', 'Help'], toolbar: false },
  { label: 'notepad pro', name: 'Notepad Pro', root: '.npp', menus: ['File', 'Edit', 'Search', 'View', 'Format', 'Help'], toolbar: true },
  { label: 'file explorer', name: 'File Explorer', root: '.explorer', menus: ['File', 'Edit', 'View', 'Go', 'Help'], toolbar: true },
  { label: 'calculator', name: 'Calculator', root: '.calc-app', menus: ['Edit', 'View', 'Help'], toolbar: false },
];

for (const a of APPS) {
  await step(`${a.name}: opens in the Classic look with its menus, and no menu item shows a key the browser keeps`, async () => {
    await closeAll();
    await openApp(a.label);
    const win = page.locator('.win', { has: page.locator(a.root) }).last();
    await win.locator('.cbar').waitFor({ timeout: 20000 });
    eq(await win.locator('.cbar-title:visible').allInnerTexts(), a.menus, 'menus on the bar');
    eq(await win.locator('.cbar-tools').count(), a.toolbar ? 1 : 0, 'the shared toolbar');
    // Every menu opens (its items are made then), with at least one item.
    for (const m of a.menus) {
      await win.locator(`.cbar-title[data-menu="${m}"]`).click();
      ok(await page.locator('.menu-root .menu-item').count() > 0, `${m} has items`);
      await page.keyboard.press('Escape');
    }
    const bad = await win.locator('.cbar').evaluate(async el => {
      const mod = await import('/app/shell/menubar.js');
      const spec = mod.barSpecOf(el);
      return spec ? mod.checkShortcuts(spec.menus) : ['no description kept for this bar'];
    });
    eq(bad, [], 'items showing a key the browser keeps');
  });
}

await step('the page had no script errors', async () => eq(problems, [], 'page errors'));

await browser.close();
console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? ': ' + failures.join(' | ') : ''}`);
process.exit(failures.length ? 1 : 0);
