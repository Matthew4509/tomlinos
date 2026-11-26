// Audit of File Explorer (November 2026) in a real Chrome: the path box, the System folder, deep and long names, a
// folder whose name has a dot, the Open window's keyboard, search, and a narrow window. Each step that FAILS names a
// fault found by the audit; it should pass once the fault is fixed. Needs the dev server on a FRESH, EMPTY data folder
// (the first step sets up the owner) and `npm run build` done.
//   node test/browser-audit-explorer.mjs [http://127.0.0.1:3104] [screenshot folder]
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3104';
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
    console.log('  FAIL ' + name + '\n       ' + String(error.message).slice(0, 900));
  }
  // A dialog a failed step left open would block the next one.
  for (let i = 0; i < 4 && (await page.locator('.dialog').count()); i++) {
    await page.locator('.dialog').last().getByRole('button').last().click({ timeout: 2000 }).catch(() => page.keyboard.press('Escape'));
    await page.waitForTimeout(100);
  }
}
const eq = (a, b, what) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const ok = (v, what) => {
  if (!v) throw new Error(what);
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
const page = await context.newPage();
page.setDefaultTimeout(10000);
const problems = [];
page.on('console', m => m.type() === 'error' && problems.push('console: ' + m.text()));
page.on('pageerror', e => problems.push('pageerror: ' + e.message));
const shot = async name => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });
const settle = ms => page.waitForTimeout(ms);
const ew = () => page.locator('.win', { has: page.locator('.explorer') }).first();
const item = name => ew().locator('.item', { has: page.locator('.item-name', { hasText: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') }) }).first();
const names = async () => ew().locator('.item-name').allInnerTexts();
async function menuPick(path) {
  for (const label of path) {
    await page.locator('.menu-item').filter({ has: page.locator('.menu-label', { hasText: new RegExp('^' + label + '$') }) }).first().click({ timeout: 8000 });
  }
}
async function typePath(text) {
  await ew().locator('.explorer-view').focus();
  await page.keyboard.press('Control+l');
  const box = ew().locator('input.address');
  await box.fill(text);
  await box.press('Enter');
}
async function newFolder(name) {
  await ew().locator('.explorer-view').focus();
  await page.keyboard.press('ContextMenu');
  await menuPick(['New', 'Folder']);
  const input = ew().locator('input.rename');
  await input.waitFor();
  await input.fill(name);
  await input.press('Enter');
  await item(name).waitFor({ timeout: 8000 });
}
async function uploadFiles(paths) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 10000 }), ew().getByRole('button', { name: 'Upload' }).click()]);
  await chooser.setFiles(paths);
}

console.log('File Explorer audit, against ' + BASE);
await page.goto(BASE);

await step('set up the owner and open File Explorer', async () => {
  await page.locator('.gate h1').first().waitFor({ timeout: 30000 });
  await page.getByLabel('Your name').fill('Sample Owner');
  const user = page.getByLabel('User name (for signing in)');
  if (await user.count()) await user.fill('tester');
  await page.locator('.gate input[type=password]').last().fill(PASS);
  const encrypt = page.locator('.gate-encrypt');
  if (await encrypt.count()) await encrypt.uncheck();
  await page.locator('.gate-go').click();
  await page.locator('.gate h1', { hasText: 'Your recovery key' }).waitFor({ timeout: 30000 });
  await page.locator('.gate .check-row input').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#desktop .item').first().waitFor({ timeout: 20000 });
  await page.keyboard.press('Control+Alt+e');
  await item('Documents').waitFor({ timeout: 15000 });
  await item('Documents').dblclick();
  await ew().locator('.crumb', { hasText: 'Documents' }).waitFor();
});

const dir = tempDir('tomlinos-audit-explorer-');
writeFileSync(join(dir, 'note.txt'), 'hello');

await step('upload a file into Documents', async () => {
  await uploadFiles([join(dir, 'note.txt')]);
  await item('note.txt').waitFor({ timeout: 10000 });
});

/** Whether the last crumb (the folder you are in) is fully inside the path bar. */
const lastCrumbShown = () => ew().locator('.crumbs').evaluate(el => {
  const box = el.getBoundingClientRect();
  const last = [...el.querySelectorAll('.crumb')].pop();
  const r = last.getBoundingClientRect();
  return { shown: r.left >= box.left - 1 && r.right <= box.right + 1, name: last.textContent, at: [Math.round(r.left), Math.round(r.right)], bar: [Math.round(box.left), Math.round(box.right)] };
});

await step('E-P0-5: at the window\'s opening size, the path bar shows the folder you are in ("Documents")', async () => {
  const c = await lastCrumbShown();
  ok(c.shown, `"${c.name}" crumb at ${c.at}, path bar is ${c.bar}: the search box takes the room and the folder's name is cut off`);
});

await step('E-P0-9: F2 and a change of letter case only ("note.txt" to "Note.txt") renames it', async () => {
  await item('note.txt').click();
  await page.keyboard.press('F2');
  const input = ew().locator('input.rename');
  await input.fill('Note.txt');
  await input.press('Enter');
  await settle(800);
  ok((await names()).includes('Note.txt'), `names now: ${JSON.stringify(await names())}`);
});

await step('Delete sends a file to the Recycle Bin and the toast\'s Undo brings it back', async () => {
  writeFileSync(join(dir, 'gone.txt'), 'bye');
  await uploadFiles([join(dir, 'gone.txt')]);
  await item('gone.txt').waitFor({ timeout: 10000 });
  await item('gone.txt').click();
  await page.keyboard.press('Delete');
  await item('gone.txt').waitFor({ state: 'detached', timeout: 8000 });
  await page.getByRole('button', { name: 'Undo' }).first().click();
  await item('gone.txt').waitFor({ timeout: 8000 });
});

await step('E-P1-5: a folder open in Explorer that is renamed in a second Explorer window is followed, not shown as gone', async () => {
  await newFolder('Before');
  // A second Explorer window (Start > Documents; the first was opened at This desktop), sent to the folder by its path.
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('Documents');
  await page.locator('.start-menu .start-item[data-label="documents"]').first().click();
  await settle(800);
  const wins = page.locator('.win', { has: page.locator('.explorer') });
  if ((await wins.count()) < 2) throw new Error('no second Explorer window opened');
  const second = wins.last();
  await second.locator('.explorer-view').focus();
  await page.keyboard.press('Control+l');
  await second.locator('input.address').fill('/Documents/Before');
  await second.locator('input.address').press('Enter');
  await second.locator('.crumb', { hasText: 'Before' }).waitFor();
  await page.locator('.task', { hasText: 'Documents' }).first().click();
  await item('Before').click();
  await page.keyboard.press('F2');
  await ew().locator('input.rename').fill('After');
  await ew().locator('input.rename').press('Enter');
  await item('After').waitFor({ timeout: 8000 });
  await second.locator('.explorer-view').focus();
  await page.keyboard.press('F5');
  await settle(600);
  const text = await second.locator('.explorer-view').innerText();
  const crumbs = await second.locator('.crumb').allInnerTexts();
  await second.getByRole('button', { name: 'Close' }).click();
  ok(!/not there/.test(text) && crumbs.includes('After'), `the second window now says ${JSON.stringify(text.slice(0, 120))}, path still ${JSON.stringify(crumbs)}`);
});

await step('dragging a file onto a folder moves it there; Download on a folder gives "<name>.zip"', async () => {
  const from = await item('gone.txt').boundingBox();
  const to = await item('After').boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + 20);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + 20, { steps: 10 });
  await page.mouse.up();
  await item('gone.txt').waitFor({ state: 'detached', timeout: 8000 });
  await item('After').click();
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), ew().getByRole('button', { name: 'Download' }).click()]);
  eq(download.suggestedFilename(), 'After.zip', 'download name');
});

// ---- The path box ---------------------------------------------------------------------------------------------------

await step('E-P0-1: typing /System in the path box does not open the desktop\'s own hidden System folder', async () => {
  await typePath('/System');
  await settle(600);
  const crumbs = await ew().locator('.crumb').allInnerTexts();
  const dialog = await page.locator('.dialog').count();
  ok(dialog > 0 || !crumbs.includes('System'), `Explorer opened /System (path shown: ${JSON.stringify(crumbs)}); things pasted or uploaded there can then never be deleted, moved or downloaded`);
});

await step('E-P0-1b: a file put into /System can still be deleted (or could not be put there at all)', async () => {
  const crumbs = await ew().locator('.crumb').allInnerTexts();
  if (!crumbs.includes('System')) return;
  await uploadFiles([join(dir, 'note.txt')]);
  await item('note.txt').waitFor({ timeout: 10000 });
  await item('note.txt').click();
  await page.keyboard.press('Delete');
  await settle(600);
  const dialog = page.locator('.dialog');
  const text = (await dialog.count()) ? await dialog.innerText() : '';
  ok(!text.includes('cannot be changed'), `uploaded into /System, then Delete says: ${JSON.stringify(text.slice(0, 160))}`);
});

await step('E-P0-2: after "No such folder", the path box is still open with what was typed', async () => {
  await typePath('/Documents/Nope');
  const dialog = page.locator('.dialog');
  await dialog.waitFor({ timeout: 5000 });
  await dialog.getByRole('button').first().click();
  await settle(300);
  const box = ew().locator('input.address');
  const visible = await box.isVisible();
  const value = visible ? await box.inputValue() : null;
  const focused = await page.evaluate(() => document.activeElement?.className ?? '');
  ok(visible && value === '/Documents/Nope', `path box visible=${visible}, value=${JSON.stringify(value)}, focus on "${focused}"; the dialog says "Check the spelling" but the typing is gone`);
});

await step('E-P0-3: a path typed in other letter case shows the folder\'s real name in the path and title', async () => {
  await typePath('/documents');
  await settle(500);
  const crumbs = await ew().locator('.crumb').allInnerTexts();
  const title = await ew().locator('.win-title-text').innerText();
  eq([crumbs[crumbs.length - 1], title], ['Documents', 'Documents'], 'last crumb and window title');
});

await step('E-P1-1: a Windows-style path with backslashes (\\Documents) opens the folder', async () => {
  await typePath('/');
  await settle(300);
  await typePath('\\Documents');
  await settle(500);
  const dialog = await page.locator('.dialog').count();
  const crumbs = await ew().locator('.crumb').allInnerTexts();
  ok(!dialog && crumbs.includes('Documents'), `dialog shown=${!!dialog}, path ${JSON.stringify(crumbs)}`);
});

// ---- Names ----------------------------------------------------------------------------------------------------------

await step('E-P0-4: copying a folder called "Project v1.5" next to itself gives "Project v1.5 (2)"', async () => {
  await typePath('/Documents');
  await settle(300);
  await newFolder('Project v1.5');
  await item('Project v1.5').click();
  await page.keyboard.press('Control+c');
  // An empty spot near the foot of the view (the menu bar and toolbar above it leave less than 300 px at this size).
  const viewBox = await ew().locator('.explorer-view').boundingBox();
  await ew().locator('.explorer-view').click({ position: { x: 5, y: Math.round(viewBox.height) - 8 } });
  await page.keyboard.press('Control+v');
  await settle(800);
  const all = await names();
  ok(all.includes('Project v1.5 (2)'), `names now: ${JSON.stringify(all)}`);
});

const deep = ['Alpha level one folder', 'Beta level two folder', 'Gamma level three folder', 'Delta level four folder', 'Epsilon level five', 'Zeta level six', 'Eta level seven', 'Theta level eight'];
await step('upload a deep folder (eight levels, long names) with the folder picker', async () => {
  let at = join(dir, 'tree');
  for (const d of deep) at = join(at, d);
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, 'deepest file.txt'), 'deep');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 10000 }), ew().getByRole('button', { name: 'Upload' }).click({ modifiers: ['Shift'] })]);
  await chooser.setFiles(join(dir, 'tree'));
  await item('tree').waitFor({ timeout: 15000 });
});

await step('E-P0-5b: in a deep folder the current folder\'s name is visible in the path bar', async () => {
  await typePath('/Documents/tree/' + deep.join('/'));
  await item('deepest file.txt').waitFor({ timeout: 10000 });
  const info = await ew().locator('.crumbs').evaluate(el => {
    const box = el.getBoundingClientRect();
    const last = [...el.querySelectorAll('.crumb')].pop().getBoundingClientRect();
    return { barRight: Math.round(box.right), lastLeft: Math.round(last.left), lastRight: Math.round(last.right), scroll: el.scrollWidth, width: el.clientWidth };
  });
  ok(info.lastRight <= info.barRight + 1, `last crumb at ${info.lastLeft}-${info.lastRight}, bar ends at ${info.barRight} (content ${info.scroll}px in ${info.width}px): the folder you are in is cut off`);
});

await step('E-P1-2: list view shows a long name with an ellipsis, not cut mid-letter with no sign', async () => {
  await typePath('/Documents');
  await settle(300);
  await newFolder('A very long folder name that goes on and on and on well past any column width you would choose');
  await ew().locator('.explorer-view').focus();
  await page.keyboard.press('ContextMenu');
  await menuPick(['View', 'List']);
  await settle(400);
  const cut = await ew().locator('.item-name', { hasText: 'A very long folder' }).evaluate(el => ({ over: el.scrollWidth > el.clientWidth, style: getComputedStyle(el).display, ellipsis: getComputedStyle(el).textOverflow }));
  ok(!(cut.over && cut.style === 'flex'), `name overflows (display ${cut.style}, text-overflow ${cut.ellipsis}): a flex box does not draw the ellipsis`);
});

await step('E-P1-3: list view column headings sort when clicked', async () => {
  const head = ew().locator('.fv-head span', { hasText: 'Size' });
  const before = await names();
  await head.click().catch(() => {});
  await settle(300);
  const after = await names();
  ok(JSON.stringify(before) !== JSON.stringify(after) || (await head.getAttribute('role')) === 'button', 'clicking "Size" in the list heading does nothing');
  await ew().locator('.explorer-view').focus();
  await page.keyboard.press('ContextMenu');
  await menuPick(['View', 'Icons']);
});

// ---- Search ---------------------------------------------------------------------------------------------------------

await step('E-P0-6: clearing the search box by deleting the text puts the folder\'s own status back', async () => {
  const search = ew().locator('input.search');
  await search.fill('note');
  await search.press('Enter');
  await ew().locator('.search-hit').first().waitFor({ timeout: 8000 });
  await search.fill('');
  await search.dispatchEvent('input');
  await settle(700);
  const status = await ew().locator('.statusbar').innerText();
  ok(!/found|Searching/.test(status), `status still says ${JSON.stringify(status)} with the folder shown again`);
});

await step('E-P1-4: a folder found by search opens in this Explorer window, not a second one', async () => {
  const before = await page.locator('.win').count();
  const search = ew().locator('input.search');
  await search.fill('Project');
  await search.press('Enter');
  const hit = ew().locator('.search-hit', { hasText: 'Project v1.5' }).first();
  await hit.waitFor({ timeout: 8000 });
  await hit.click();
  await settle(800);
  const after = await page.locator('.win').count();
  if (after > before) await page.locator('.win.active').getByRole('button', { name: 'Close' }).click();
  eq(after, before, 'windows open');
});

// ---- The Open window ------------------------------------------------------------------------------------------------

await step('E-P0-7: in the Open window, the arrow keys move through the list when it has focus', async () => {
  await page.keyboard.press('Escape');
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('Notepad Pro');
  await page.locator('.start-menu').getByText('Notepad Pro', { exact: true }).first().click();
  const np = page.locator('.win.active');
  await np.waitFor();
  await settle(500);
  await page.keyboard.press('Control+o');
  const dialog = page.locator('.dialog');
  await dialog.locator('.pick-row').first().waitFor({ timeout: 8000 });
  await dialog.locator('.pick-list').focus();
  await page.keyboard.press('ArrowDown');
  await settle(200);
  const selected = await dialog.locator('.pick-row[aria-selected="true"]').count();
  const focused = await page.evaluate(() => document.activeElement?.className ?? '');
  await page.keyboard.press('Escape');
  await settle(200);
  await np.getByRole('button', { name: 'Close' }).click().catch(() => {});
  ok(selected === 1, `ArrowDown on the list selected ${selected} rows (focus on "${focused}"): a keyboard user cannot reach a file`);
});

// ---- A narrow window ------------------------------------------------------------------------------------------------

await step('E-P0-8: in a narrow Explorer window the toolbar stays inside the window', async () => {
  await page.setViewportSize({ width: 820, height: 800 });
  await settle(300);
  const w = ew();
  // Make the window as narrow as it will go by dragging its right edge to the left.
  const box = await w.boundingBox();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await settle(300);
  const info = await w.evaluate(el => {
    const r = el.getBoundingClientRect();
    const tb = el.querySelector('.explorer .toolbar');
    const outside = [...tb.children].filter(c => c.offsetParent && c.getBoundingClientRect().right > r.right + 1).map(c => c.className || c.tagName);
    return { width: Math.round(r.width), outside, toolbarHeight: Math.round(tb.getBoundingClientRect().height) };
  });
  await shot('narrow');
  ok(!info.outside.length, `window ${info.width}px wide: ${JSON.stringify(info.outside)} stick out past its edge`);
  console.log('       (window ' + info.width + 'px, toolbar ' + info.toolbarHeight + 'px tall)');
  await page.setViewportSize({ width: 1280, height: 800 });
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (problems.length) console.log('page problems:\n  ' + problems.slice(0, 10).join('\n  '));
await browser.close();
process.exit(failures.length ? 1 : 0);
