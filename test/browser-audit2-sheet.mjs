// Round-2 audit of the Spreadsheet (app id "sheet") in a real Chrome: its rules tried through the window itself
// (Save as CSV keeps the workbook unsaved, saved means on disk, a file changed elsewhere asks first, unsaved changes ask
// on close, Escape scoped to the cell, usable at 375 px), plus the P0 formula faults seen in the grid.
// Needs the dev server on a FRESH, EMPTY data folder (the first step sets up the owner) and `node tools/build.mjs`.
//   node test/browser-audit2-sheet.mjs [http://127.0.0.1:3531] [screenshot folder]
// A failing step names a P0 still open; "info" lines are P1/P2 notes that do not fail the run.
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3531';
const SHOTS = process.argv[3] ?? null;
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PASS = 'copper-meadow-lantern-73';
let passed = 0;
const failures = [];
const infos = [];

async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (error) {
    failures.push(name);
    await shot('fail-' + failures.length).catch(() => {});
    console.log('  FAIL ' + name + '\n       ' + String(error.message).split('\n')[0].slice(0, 600));
    await closeAll().catch(() => {});
  }
}
const info = text => {
  infos.push(text);
  console.log('  info ' + text);
};
const ok = (cond, what) => {
  if (!cond) throw new Error(what);
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
let page = await context.newPage();
const problems = [];
page.on('pageerror', e => problems.push('pageerror: ' + e.message));
const shot = async name => SHOTS && page.screenshot({ path: `${SHOTS}/sh-${name}.png` });

const win = () => page.locator('.win:has(.sheet)').last();
const nameBox = () => win().locator('.name-box');
const goTo = async addr => {
  await nameBox().fill(addr);
  await nameBox().press('Enter');
};
/** What the grid's live line says about a cell ("A1: ..."), without the address. */
const cell = async addr => {
  await goTo(addr);
  await page.waitForFunction(a => [...document.querySelectorAll('.sheet [role=status][aria-live]')].pop()?.textContent?.startsWith(a + ':'), addr);
  return (await win().locator('[role=status][aria-live]').last().textContent()).slice(addr.length + 2);
};
const typeAt = async (addr, text) => {
  await goTo(addr);
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
};
const pick = () => page.locator('.dialog:has(.pick)').last();

async function closeAll() {
  for (let i = 0; i < 30; i++) {
    const dialog = page.locator('.dialog').last();
    if (await dialog.count()) {
      const b = dialog.getByRole('button', { name: /Close without saving|Cancel|Do not save|OK/ }).first();
      if (await b.count()) await b.click();
      else await page.keyboard.press('Escape');
      await page.waitForTimeout(150);
      continue;
    }
    const close = page.locator('.win .win-close').last();
    if (!(await close.count())) return;
    await close.click();
    await page.waitForTimeout(200);
  }
}
async function openSheet() {
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('spreadsheet');
  await page.locator('.start-item', { hasText: 'Spreadsheet' }).first().click();
  await win().locator('.grid-scroll').waitFor();
  await page.waitForTimeout(300);
  // A "Spreadsheets not saved" offer from an earlier step is put aside.
  const offer = page.locator('.dialog', { hasText: 'not saved' });
  if (await offer.count()) await offer.getByRole('button').last().click();
}
async function menu(top, item) {
  await win().locator(`.cbar-title[data-menu="${top}"]`).click();
  await page.locator('.menu-item', { hasText: item }).first().click();
}
/** File > Save as, saved as `name` in Documents (with the type box set to `type` when given). */
async function saveAsName(name, type) {
  await menu('File', 'Save as...');
  await pick().waitFor();
  if (type) {
    const labels = await pick().locator('select.pick-type-box option').allTextContents();
    const label = labels.find(l => l.toLowerCase().includes(type));
    ok(label, `no ${type} choice in the Save as type box: ${JSON.stringify(labels)}`);
    await pick().locator('select.pick-type-box').selectOption({ label });
  }
  await pick().locator('.pick-name-box').fill(name);
  await pick().locator('.btn.primary').click();
  await page.waitForTimeout(1200);
}
async function openByName(name) {
  await menu('File', 'Open...');
  await pick().waitFor();
  await pick().locator('.pick-row', { hasText: name }).first().dblclick();
  await page.waitForTimeout(1500);
}

console.log('Spreadsheet round-2 audit, against ' + BASE);
await page.goto(BASE);

await step('set up the owner', async () => {
  await page.locator('.gate h1', { hasText: 'Set up' }).waitFor({ timeout: 30000 });
  await page.getByLabel('Your name').fill('Sample Owner');
  if (await page.getByLabel('User name (for signing in)').count()) await page.getByLabel('User name (for signing in)').fill('tester');
  await page.locator('.gate input[type=password]').last().fill(PASS);
  if (await page.locator('.gate-encrypt').count()) await page.locator('.gate-encrypt').uncheck();
  await page.locator('.gate-go').click();
  await page.locator('.gate .check-row input').check({ timeout: 30000 });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#desktop .item').first().waitFor({ timeout: 30000 });
});

await step('SH-1 (in the grid): =INT(10/3*3) shows 10, as in Excel', async () => {
  await openSheet();
  await typeAt('A1', '=INT(10/3*3)');
  const shown = await cell('A1');
  ok(/(^|\s)10(\s|$|,)/.test(shown) || shown.includes('10'), `A1 shows "${shown}"`);
  ok(!/\b9\b/.test(shown), `A1 shows "${shown}" (9, not Excel's 10)`);
  await closeAll();
});

await step('rule 3: Save as CSV writes a copy only; the two-sheet workbook still counts as unsaved and Close asks', async () => {
  await openSheet();
  await typeAt('A1', 'one');
  await win().locator('.sheet-add').click();
  await typeAt('A1', 'two');
  await saveAsName('audit-copy.csv', 'csv');
  await page.locator('.toast', { hasText: 'is not saved' }).first().waitFor({ timeout: 5000 }).catch(() => info('no toast saying the spreadsheet itself is not saved'));
  await win().locator('.win-close').first().click();
  const ask = page.locator('.dialog', { hasText: 'not saved' });
  await ask.waitFor({ timeout: 3000 });
  await ask.getByRole('button', { name: 'Close without saving' }).click();
});

await step('rule 2: Save as .sheet, close, reopen: both sheets, the formula and bold come back', async () => {
  await openSheet();
  await typeAt('A1', '5');
  await typeAt('A2', '=A1*3');
  await goTo('A1');
  await page.keyboard.press('Control+B');
  await win().locator('.sheet-add').click();
  await typeAt('B2', 'second');
  await saveAsName('audit-book.sheet');
  ok((await page.locator('.dialog').count()) === 0, 'a dialog was left open after Save as');
  await win().locator('.win-close').first().click();
  await page.waitForTimeout(400);
  ok((await page.locator('.dialog', { hasText: 'not saved' }).count()) === 0, 'Close asked about unsaved changes right after Save as');
  await openSheet();
  await openByName('audit-book');
  const tabs = await win().locator('.sheet-tabs [role=tab]').allTextContents();
  ok(tabs.length === 2, `sheets after reopening: ${JSON.stringify(tabs)}`);
  await win().locator('.sheet-tabs [role=tab]').first().click();
  const a2 = await cell('A2');
  ok(a2.includes('15'), `A2 after reopening: "${a2}"`);
  await goTo('A2');
  await page.keyboard.press('F2');
  const editing = await page.evaluate(() => document.activeElement?.value ?? document.activeElement?.textContent ?? '');
  await page.keyboard.press('Escape');
  ok(editing.includes('=A1*3'), `A2 holds "${editing}" (the formula should come back)`);
  await closeAll();
});

await step('rule 5: a file saved in another tab meanwhile asks before this window saves over it', async () => {
  const one = page;
  await openSheet();
  await openByName('audit-book');
  await typeAt('C1', 'from tab one');
  // The same desktop in a second tab: the file is opened, changed and saved there.
  const two = await context.newPage();
  two.on('pageerror', e => problems.push('pageerror (tab two): ' + e.message));
  await two.goto(BASE);
  await two.locator('#desktop .item').first().waitFor({ timeout: 30000 });
  page = two;
  try {
    await openSheet();
    await openByName('audit-book');
    await typeAt('C2', 'from tab two');
    await page.keyboard.press('Control+S');
    await page.waitForTimeout(1500);
    ok((await page.locator('.dialog').count()) === 0, "the second tab's plain save asked something");
  } finally {
    page = one;
  }
  await two.close();
  await win().locator('.grid-scroll').click({ position: { x: 300, y: 200 } });
  await page.keyboard.press('Control+S');
  const ask = page.locator('.dialog', { hasText: 'Changed somewhere else' });
  await ask.waitFor({ timeout: 4000 });
  await ask.getByRole('button', { name: 'Do not save' }).click();
  await closeAll();
});

await step('rule 9: Escape while typing in a cell drops only the typing; the cell keeps its value and the window stays', async () => {
  await openSheet();
  await typeAt('A1', 'kept');
  await goTo('A1');
  await page.keyboard.type('gone');
  await page.keyboard.press('Escape');
  ok((await page.locator('.win:has(.sheet)').count()) >= 1, 'the window closed');
  const a1 = await cell('A1');
  ok(a1.includes('kept'), `A1 shows "${a1}"`);
  await closeAll();
});

await step('rule 9: at 375 px the window fits (no sideways page scroll) and a cell can be typed into', async () => {
  await page.setViewportSize({ width: 375, height: 740 });
  await page.waitForTimeout(400);
  await openSheet();
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok(wide <= 0, `the page scrolls sideways by ${wide}px`);
  const box = await win().boundingBox();
  ok(box && box.x >= -1 && box.x + box.width <= 376, `the window runs past the screen: ${JSON.stringify(box)}`);
  await typeAt('B3', '42');
  const b3 = await cell('B3');
  ok(b3.includes('42'), `B3 shows "${b3}"`);
  const fileMenu = win().locator('.cbar-title[data-menu="File"]');
  ok(await fileMenu.isVisible(), 'neither the File menu nor a More menus button can be seen');
  await closeAll();
  await page.setViewportSize({ width: 1280, height: 800 });
});

await step('SH-4 (P1 note): Save as over the Excel file it came from says what saving over it leaves out', async () => {
  // An Excel file with a part this spreadsheet leaves out (a chart sheet), copied in through "Open an Excel file".
  const { zipStore } = await import('../src/core/zip.ts').catch(() => ({ zipStore: null }));
  if (!zipStore) {
    info('SH-4 not run here: the zip writer could not be loaded by this script');
    return;
  }
  const MAIN = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const parts = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': `<?xml version="1.0"?><workbook ${MAIN}><sheets><sheet name="S1" sheetId="1" r:id="rId1"/><sheet name="Chart1" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartsheet" Target="chartsheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet ${MAIN}><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`,
    'xl/chartsheets/sheet1.xml': '<?xml version="1.0"?><chartsheet/>',
  };
  const bytes = zipStore(Object.entries(parts).map(([name, text]) => ({ name, data: new TextEncoder().encode(text), modified: Date.UTC(2026, 9, 13) })));
  await openSheet();
  const chooser = page.waitForEvent('filechooser');
  await menu('File', 'Open an Excel file from your computer...');
  await (await chooser).setFiles({ name: 'lossy.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(bytes) });
  const report = page.locator('.dialog', { hasText: 'Opened' });
  await report.waitFor({ timeout: 8000 });
  await report.getByRole('button', { name: 'OK' }).click();
  await typeAt('B1', 'changed');
  await saveAsName('lossy.xlsx');
  const replace = page.locator('.dialog', { hasText: /Replace/ }).last();
  if (await replace.count()) await replace.getByRole('button', { name: /Replace/ }).first().click();
  await page.waitForTimeout(800);
  const warned = await page.locator('.dialog', { hasText: /left out|Save over/ }).count();
  if (!warned) info('SH-4 (P1): Save as over the opened .xlsx replaced it without the "parts left out" question that Save asks');
  await closeAll();
});

await step('rule 6: a recovery copy left behind is offered once, and Open it brings the work back in one window only', async () => {
  await openSheet();
  await typeAt('A1', 'unsaved work 1');
  // The page going to the background keeps a copy at once; then the page stops without the window being closed.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(2000);
  await page.reload();
  await page.locator('#desktop .item').first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(800);
  // Two Spreadsheet windows started straight after one another: the copy must be offered (and opened) once.
  for (let i = 0; i < 2; i++) {
    await page.locator('.start-btn').click();
    await page.locator('.start-filter').fill('spreadsheet');
    await page.locator('.start-item', { hasText: 'Spreadsheet' }).first().click();
  }
  const offer = page.locator('.dialog', { hasText: 'not saved' }).first();
  await offer.waitFor({ timeout: 8000 });
  await offer.getByRole('button', { name: /Open it|Open them/ }).click();
  await page.waitForTimeout(2500);
  const again = page.locator('.dialog', { hasText: 'not saved' });
  if (await again.count()) {
    await again.first().getByRole('button', { name: /Open it|Open them/ }).click();
    await page.waitForTimeout(2500);
  }
  const titles = await page.locator('.win:has(.sheet) .win-title').allTextContents().catch(() => []);
  let holding = 0;
  for (const w of await page.locator('.win:has(.sheet)').all()) {
    await w.locator('.name-box').fill('A1');
    await w.locator('.name-box').press('Enter');
    const live = await w.locator('[role=status][aria-live]').last().textContent();
    if (live.includes('unsaved work 1')) holding++;
  }
  ok(holding === 1, `the recovered work is open in ${holding} windows (${JSON.stringify(titles)})`);
  await closeAll();
});

if (problems.length) {
  failures.push('page errors');
  console.log('  FAIL page errors:\n       ' + problems.join('\n       '));
}
console.log(`\n${passed} passed, ${failures.length} failed, ${infos.length} info`);
await browser.close();
process.exit(failures.length ? 1 : 0);
