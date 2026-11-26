// Audit of the Spreadsheet in a real Chrome: faults found by trying to break it. Needs the dev server on a FRESH, EMPTY
// data folder (the first step sets up the owner, or logs in when it was set up already), and `npm run build` done.
// Each step that fails names a fault still open.
//   node test/browser-audit-sheet.mjs [http://127.0.0.1:3107] [screenshot folder]
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3107';
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
    console.log('  FAIL ' + name + '\n       ' + String(error.message).slice(0, 800));
  }
}
const eq = (a, b, what) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const problems = [];
page.on('pageerror', e => problems.push('pageerror: ' + e.message));
const shot = async name => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });

const grid = () => page.locator('.sheet .grid-scroll').last();
const goTo = async addr => {
  const box = page.locator('.sheet .name-box').last();
  await box.fill(addr);
  await box.press('Enter');
};
const cell = async addr => {
  await goTo(addr);
  await page.waitForFunction(a => [...document.querySelectorAll('.sheet [role=status][aria-live]')].pop()?.textContent?.startsWith(a + ':'), addr);
  return (await page.locator('.sheet [role=status][aria-live]').last().textContent()).slice(addr.length + 2);
};
const typeRow = async cells => {
  for (let i = 0; i < cells.length; i++) {
    await page.keyboard.type(cells[i]);
    await page.keyboard.press(i === cells.length - 1 ? 'Enter' : 'Tab');
  }
};
const keys = async (...list) => {
  await grid().focus();
  for (const k of list) await page.keyboard.press(k);
};
async function closeAll() {
  for (let i = 0; i < 40; i++) {
    const dialog = page.locator('.dialog');
    if (await dialog.count()) {
      await dialog.getByRole('button', { name: /without saving|Don.t save|Lose the changes|Close anyway|Cancel/ }).first().click().catch(() => dialog.getByRole('button').last().click());
      continue;
    }
    const wins = page.locator('.win');
    if (!(await wins.count())) return;
    await wins.last().locator('.win-close').first().click();
    await page.waitForTimeout(80);
  }
}
async function freshSheet() {
  await closeAll();
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('spreadsheet');
  await page.locator('.start-item', { hasText: 'Spreadsheet' }).first().click();
  await grid().waitFor();
  await page.waitForTimeout(250);
}
/** Name/Score list in A1:B5 with a filter that hides the "b" row (row 3: b, 1). */
async function filteredList() {
  await freshSheet();
  await goTo('A1');
  await typeRow(['Name', 'Score']);
  await typeRow(['a', '5']);
  await typeRow(['b', '1']);
  await typeRow(['a', '7']);
  await typeRow(['c', '3']);
  await goTo('A1');
  await keys('Control+Shift+L');
  // The ▾ button sits at the right-hand end of the heading cell.
  const box = await page.locator('.sheet .grid-canvas').last().boundingBox();
  await page.mouse.click(box.x + 103, box.y + 34);
  await page.locator('.filter-box').waitFor();
  await page.locator('.filter-box label.filter-value', { hasText: /^b$/ }).locator('input').uncheck();
  await page.locator('.filter-box').getByRole('button', { name: 'OK' }).click();
  await page.locator('.sheet', { hasText: '3 of 4 rows shown' }).waitFor();
}
const filterOff = () => keys('Control+Shift+L');

console.log('Spreadsheet audit, against ' + BASE);
await page.goto(BASE);

await step('set up the owner (or log in)', async () => {
  const first = await Promise.race([
    page.locator('.gate h1', { hasText: 'Set up' }).waitFor({ timeout: 30000 }).then(() => 'setup'),
    page.getByRole('button', { name: 'Log in for more' }).waitFor({ timeout: 30000 }).then(() => 'reader'),
  ]);
  if (first === 'setup') {
    await page.getByLabel('Your name').fill('Sample Owner');
    if (await page.getByLabel('User name (for signing in)').count()) await page.getByLabel('User name (for signing in)').fill('tester');
    await page.locator('.gate input[type=password]').last().fill(PASS);
    if (await page.locator('.gate-encrypt').count()) await page.locator('.gate-encrypt').uncheck();
    await page.locator('.gate-go').click();
    await page.locator('.gate .check-row input').check({ timeout: 30000 });
    await page.getByRole('button', { name: 'Continue' }).click();
  } else {
    await page.getByRole('button', { name: 'Log in for more' }).click();
    await page.getByLabel('Username').fill('tester');
    await page.locator('input[type=password]').first().fill(PASS);
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
  }
  await page.locator('#desktop .item').first().waitFor({ timeout: 30000 });
});

await step('S-P0-1: Delete on a filtered list clears only the rows in view (the hidden "b, 1" row survives)', async () => {
  await filteredList();
  await goTo('A2:B5');
  await keys('Delete');
  await filterOff();
  eq([await cell('A3'), await cell('B3')], ['b', '1'], 'hidden row 3 after Delete over A2:B5 and the filter taken off');
});

await step('S-P0-2: Copy of a filtered list pastes only the rows in view', async () => {
  await filteredList();
  await goTo('A1:B5');
  await keys('Control+C');
  await goTo('D1');
  await keys('Control+V');
  await filterOff();
  eq([await cell('D2'), await cell('D3'), await cell('D4'), await cell('D5')], ['a', 'a', 'c', 'empty'], 'pasted names D2:D5');
});

await step('S-P0-3: Ctrl+D on a filtered list fills only the rows in view (hidden B3 keeps 1)', async () => {
  await filteredList();
  await goTo('B2:B5');
  await keys('Control+D');
  await filterOff();
  eq(await cell('B3'), '1', 'hidden B3 after Ctrl+D over B2:B5');
});

await step('S-P0-1b: Delete row on a filtered list deletes only the rows in view (the hidden "b, 1" row survives)', async () => {
  await filteredList();
  await goTo('A2:B5');
  await page.locator('.sheet').getByRole('button', { name: 'Delete rows or columns' }).last().click();
  await page.locator('.menu [role=menuitem], .menu-item', { hasText: 'Delete row' }).first().click();
  await page.waitForTimeout(200);
  await filterOff();
  eq([await cell('A2'), await cell('B2')], ['b', '1'], 'the hidden row, moved up to row 2 after the shown rows were deleted');
});

await step('S-P0-4: Cut on Sheet1 and paste on Sheet2: the moved formula still reads Sheet1, and a formula pointing at the cut cell follows it', async () => {
  await freshSheet();
  await goTo('A1');
  await typeRow(['=B1', '7', '=A1']);
  eq(await cell('A1'), '7', 'A1 before');
  await goTo('A1');
  await keys('Control+X');
  await page.locator('.sheet .sheet-add').last().click();
  await page.locator('.sheet-tab', { hasText: 'Sheet2' }).waitFor();
  await goTo('A1');
  await keys('Control+V');
  eq(await cell('A1'), '7', 'moved formula on Sheet2 (Excel makes it =Sheet1!B1)');
  await page.locator('.sheet-tab', { hasText: 'Sheet1' }).click();
  eq(await cell('C1'), '7', 'Sheet1!C1, which pointed at the cut cell (Excel makes it =Sheet2!A1)');
});

const dataTab = async () => {
  await page.locator('.sheet [role=tab]', { hasText: /^Data$/ }).last().click();
};

await step('S-P0-6: Data > Z→A on a filtered list keeps the filter true (the excluded "b" row stays hidden, every "a" row stays in view)', async () => {
  await filteredList();
  await goTo('B2');
  await dataTab();
  await page.locator('.sheet button', { hasText: 'Z→A' }).last().click();
  await page.waitForTimeout(200);
  // Move down from A2 with the keyboard: hidden rows are skipped, so the names met are the names in view.
  await goTo('A2');
  const seen = [];
  for (let i = 0; i < 3; i++) {
    const t = await page.locator('.sheet [role=status][aria-live]').last().textContent();
    seen.push(t.replace(/^A\d+: /, ''));
    await keys('ArrowDown');
    await page.waitForTimeout(60);
  }
  eq(seen.sort(), ['a', 'a', 'c'], 'names in view after sorting the filtered list (the filter hides "b")');
});

await step('S-P0-7: A→Z on a filtered list of words keeps its heading row on top', async () => {
  await freshSheet();
  await goTo('A1');
  await typeRow(['Name', 'Town']);
  await typeRow(['Zoe', 'York']);
  await typeRow(['Adam', 'Leeds']);
  await typeRow(['Mia', 'Bath']);
  await goTo('A1');
  await keys('Control+Shift+L');
  await goTo('A3');
  await dataTab();
  await page.locator('.sheet button', { hasText: 'A→Z' }).last().click();
  await page.waitForTimeout(200);
  eq(await cell('A1'), 'Name', 'heading row (the filter\'s ▾ row) after A→Z');
});

await step('no errors in the page', async () => eq(problems, [], 'page errors'));

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log('  - ' + f);
await browser.close();
process.exit(failures.length ? 1 : 0);
