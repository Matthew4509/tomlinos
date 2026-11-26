// Audit of Notepad Pro in a real Chrome: find in files on Windows (CRLF) files and on text with emoji, old Mac (CR)
// line endings, bookmarks after Replace in open files, a quick double save, and the window at its smallest. Needs the
// dev server on a FRESH, EMPTY data folder (the first step sets up the owner), and `npm run build` done.
//   node test/browser-audit-notepadpro.mjs [http://127.0.0.1:3103] [screenshot folder]
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3103';
const SHOTS = process.argv[3] ?? null;
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
    await shot('fail-' + failures.length).catch(() => {});
    console.log('  FAIL ' + name + '\n       ' + String(error.message).slice(0, 1200));
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
page.on('console', m => m.type() === 'error' && problems.push('console: ' + m.text()));
page.on('pageerror', e => problems.push('pageerror: ' + e.message));
const shot = async name => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png`, timeout: 5000 });
const front = () => page.locator('.win.active');
const npp = () => page.locator('.win', { has: page.locator('.npp') }).last();
const status = async () => npp().locator('.npp-status').innerText();
async function closeAll() {
  for (let i = 0; i < 40; i++) {
    const dialog = page.locator('.dialog');
    if (await dialog.count()) {
      await dialog.getByRole('button', { name: /without saving|Lose the changes|Close anyway|Discard/ }).first().click().catch(() => dialog.getByRole('button').last().click());
      continue;
    }
    const wins = page.locator('.win');
    if (!(await wins.count())) return;
    await wins.last().locator('.win-close').first().click();
    await page.waitForTimeout(80);
  }
  throw new Error('windows would not close');
}
/** Opens a file in Documents with Notepad Pro, through Explorer's Open with. */
async function openInPro(name) {
  await page.keyboard.press('Control+Alt+e');
  const w = front();
  if (!(await w.locator('.item', { hasText: name }).count())) await w.locator('.item', { hasText: 'Documents' }).first().dblclick();
  await w.locator('.item', { hasText: name }).first().click({ button: 'right' });
  await page.locator('.menu-item', { hasText: 'Open with' }).hover();
  await page.locator('.menu-item', { hasText: 'Notepad Pro' }).click();
  await npp().locator('.npp-tab-name', { hasText: name }).waitFor({ timeout: 15000 });
  await w.getByRole('button', { name: 'Close' }).click().catch(() => {});
}

console.log('Notepad Pro audit, against ' + BASE);
await page.goto(BASE);

await step('set up the owner', async () => {
  await page.locator('.gate h1', { hasText: 'Set up this desktop' }).waitFor({ timeout: 20000 });
  await page.getByLabel('Your name').fill('Sample Owner');
  await page.locator('.gate input.gate-input').last().fill(PASS);
  await page.locator('.gate-encrypt').uncheck();
  await page.locator('.gate-go').click();
  await page.locator('.gate h1', { hasText: 'Your recovery key' }).waitFor({ timeout: 30000 });
  await page.locator('.gate .check-row input').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#desktop .item').first().waitFor({ timeout: 20000 });
});

const dir = tempDir('tomlinos-npp-audit-');
await step('upload test files into Documents', async () => {
  const files = {
    'crlf.txt': 'one\r\ntwo\r\nthree target\r\n',
    'mac.txt': 'a\rb\rc',
    'emoji.txt': 'hi 😀 there\n',
  };
  for (const [n, t] of Object.entries(files)) writeFileSync(join(dir, n), t);
  await page.keyboard.press('Control+Alt+e');
  const w = front();
  await w.locator('.item', { hasText: 'Documents' }).first().dblclick();
  const chooser = page.waitForEvent('filechooser');
  await w.getByRole('button', { name: 'Upload' }).click();
  (await chooser).setFiles(Object.keys(files).map(n => join(dir, n)));
  for (const n of ['crlf', 'mac', 'emoji']) await w.locator('.item', { hasText: n }).first().waitFor({ timeout: 10000 });
  await closeAll();
});

await step('find in files: clicking a hit in a Windows (CRLF) file selects that match', async () => {
  await openInPro('crlf.txt');
  const w = npp();
  await page.keyboard.press('Control+Shift+F');
  await w.locator('input[aria-label="Find in files"]').fill('target');
  await w.getByRole('button', { name: 'Find all' }).click();
  await w.locator('.npp-found-hit').first().click();
  // "target" is line 3, columns 7 to 12: the caret ends after it with six letters chosen.
  const s = await status();
  ok(s.startsWith('Ln 3, Col 13, 6 chosen'), 'status after clicking the hit: ' + s);
});

await step('old Mac (CR) file: the line-ending button agrees with the status bar', async () => {
  await openInPro('mac.txt');
  const w = npp();
  const s = await status();
  ok(s.includes('Old Mac (CR)'), 'status reads CR: ' + s);
  // The old button row's LF/CR/CRLF button is Format > Line endings when saving now: the file's own is ticked.
  await w.locator('.cbar-title[data-menu=Format]').click();
  await page.locator('.menu-item', { hasText: 'Line endings when saving' }).click();
  const label = await page.locator('.menu-item[aria-checked="true"]', { hasText: /\((CR|LF|CRLF)\)/ }).innerText();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  ok(label.includes('(CR)'), 'line ending ticked in the Format menu: ' + label);
});

await step('Replace in open files keeps the bookmarks of the tabs it changes', async () => {
  const w = npp();
  await w.getByRole('button', { name: 'New tab', exact: true }).click();
  await w.locator('.cm-content').click();
  await page.keyboard.type('first\nsecond\nthird word');
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Control+F2');
  ok((await status()).includes('1 bookmark'), 'bookmarked: ' + (await status()));
  await page.keyboard.press('Control+Shift+F');
  await w.locator('input[aria-label="Find in files"]').fill('word');
  await w.locator('input[aria-label="Replace with"]').fill('thing');
  await w.getByRole('button', { name: 'Replace in open files' }).click();
  await page.locator('.dialog').getByRole('button', { name: 'Replace all' }).click();
  await w.locator('.npp-found-note', { hasText: 'Replaced' }).waitFor();
  await w.locator('.cm-content').click();
  ok((await status()).includes('1 bookmark'), 'after replacing, status: ' + (await status()));
  await w.locator('.npp-files button[aria-label="Close find in files"]').click();
});

await step('the status bar size of a Windows (CRLF) file is its size in bytes', async () => {
  await closeAll();
  await openInPro('crlf.txt');
  const s = await status();
  ok(s.includes('24 bytes'), 'the file is 24 bytes (CRLF endings): ' + s);
});

await step('pressing Save twice quickly does not warn that the file changed somewhere else', async () => {
  await closeAll();
  await openInPro('crlf.txt');
  const w = npp();
  await w.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('x');
  await page.keyboard.press('Control+s');
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(1500);
  eq(await page.locator('.dialog', { hasText: 'Changed somewhere else' }).count(), 0, 'false "changed somewhere else" question');
});

await step('closing the window with unsaved tabs offers to save them', async () => {
  while (await page.locator('.dialog').count()) await page.locator('.dialog').getByRole('button').last().click();
  const w = npp();
  await w.locator('.cm-content').click();
  await page.keyboard.type('y');
  await w.locator('.win-close').first().click();
  const dlg = page.locator('.dialog');
  await dlg.waitFor({ timeout: 3000 });
  const buttons = await dlg.getByRole('button').allInnerTexts();
  ok(buttons.some(b => /^Save/.test(b)), 'buttons offered: ' + JSON.stringify(buttons) + ' text: ' + (await dlg.innerText()));
});

await step('at a small window size the toolbar stays inside and the text keeps room', async () => {
  await closeAll();
  await page.setViewportSize({ width: 480, height: 600 });
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('notepad pro');
  await page.locator('.start-menu [data-label="notepad pro"]').first().click();
  const w = npp();
  await w.locator('.cm-content').waitFor({ timeout: 15000 });
  await shot('npp-small');
  const m = await w.evaluate(win => {
    const root = win.querySelector('.npp');
    const ed = win.querySelector('.cm-editor').getBoundingClientRect();
    return { overflowX: root.scrollWidth - root.clientWidth, editorH: Math.round(ed.height), editorW: Math.round(ed.width), winW: Math.round(win.getBoundingClientRect().width) };
  });
  ok(m.overflowX <= 0 && m.editorH >= 120 && m.editorW >= 200, 'measures: ' + JSON.stringify(m));
  await page.setViewportSize({ width: 1280, height: 800 });
});

await step('the open tab can be reached with the keyboard (one tab in the Tab order)', async () => {
  const w = npp();
  eq(await w.locator('.npp-tab.active').getAttribute('tabindex'), '0', 'active tab tabindex');
});

await step('NP-P1-7: the New and Close shortcuts shown are ones the browser lets through (Alt+N, Alt+W), and they work', async () => {
  await closeAll();
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('notepad pro');
  await page.locator('.start-menu [data-label="notepad pro"]').first().click();
  const w = npp();
  await w.locator('.cm-content').waitFor({ timeout: 15000 });
  const tips = [await w.getByRole('button', { name: 'New tab', exact: true }).getAttribute('title'), await w.locator('.npp-tab-x').first().getAttribute('title')].join(' | ');
  ok(!/Ctrl\+[NW]\b/.test(tips) && /Alt\+N/.test(tips) && /Alt\+W/.test(tips), 'tooltips: ' + tips);
  await w.locator('.cm-content').click();
  await page.keyboard.press('Alt+n');
  eq(await w.locator('.npp-tab').count(), 2, 'tabs after Alt+N');
  await page.keyboard.press('Alt+w');
  eq(await w.locator('.npp-tab').count(), 1, 'tabs after Alt+W');
});

await step('NP-P1-2: the tab strip is a tab list the arrow keys move along', async () => {
  const w = npp();
  await w.locator('.cm-content').click();
  await page.keyboard.press('Alt+n');
  await page.keyboard.press('Alt+n');
  eq(await w.locator('[role=tab]').count(), 3, 'tabs');
  await w.locator('.npp-tab.active').focus();
  const focused = () => page.evaluate(() => document.activeElement?.querySelector?.('.npp-tab-name')?.textContent ?? document.activeElement?.className);
  const before = await focused();
  await page.keyboard.press('ArrowLeft');
  const left = await focused();
  ok(left !== before && (await w.locator('.npp-tab.active .npp-tab-name').innerText()) === left, `ArrowLeft: focus ${before} -> ${left}`);
  await page.keyboard.press('Home');
  eq(await w.locator('[role=tab]').first().evaluate(t => t === document.activeElement && t.getAttribute('aria-selected')), 'true', 'Home: first tab focused and selected');
  await page.keyboard.press('End');
  eq(await w.locator('[role=tab]').last().evaluate(t => t === document.activeElement && t.getAttribute('aria-selected')), 'true', 'End: last tab focused and selected');
  await page.keyboard.press('ArrowRight');
  eq(await w.locator('[role=tab]').first().evaluate(t => t === document.activeElement), true, 'ArrowRight from the last goes round to the first');
  eq(await w.locator('[role=tab][tabindex="0"]').count(), 1, 'tabs in the Tab order');
  eq(await w.locator('.npp-tab-x[tabindex="-1"]').count(), 3, 'close buttons kept out of the Tab order');
  await page.keyboard.press('Delete');
  eq(await w.locator('[role=tab]').count(), 2, 'tabs after Delete on a tab');
  ok(await page.evaluate(() => document.activeElement?.getAttribute('role') === 'tab'), 'after Delete the focus stays on the tab list');
});

await step('no errors in the page', async () => eq(problems.filter(p => !p.includes('404')), [], 'problems'));

// Last, because it can hang the page for good: a pattern that can match nothing, on a file holding an emoji.
await step('find in files: a pattern that can match nothing finishes on text with an emoji (does not freeze)', async () => {
  await closeAll();
  await openInPro('emoji.txt');
  const w = npp();
  await page.keyboard.press('Control+Shift+F');
  await w.locator('input[aria-label="Find in files"]').fill('x*');
  await w.locator('.npp-files input[type=checkbox]').nth(1).check();
  await w.getByRole('button', { name: 'Find all' }).click();
  const done = await Promise.race([
    page.waitForFunction(() => /searched/.test(document.querySelector('.npp-found-note')?.textContent ?? ''), null, { timeout: 8000 }).then(() => true, () => false),
    new Promise(r => setTimeout(() => r(false), 9000)),
  ]);
  ok(done, 'the search never finished: the page is frozen');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
await Promise.race([browser.close(), new Promise(r => setTimeout(r, 3000))]);
process.exit(failures.length ? 1 : 0);
