// "Open apps" in the taskbar tray, in a real Chrome: the list of open windows, switching to one, closing one (unsaved
// work still asked about), the keyboard, minimised windows, a list that follows windows closing elsewhere, and the
// empty list. Needs the dev server on a FRESH, EMPTY data folder (the first step sets up the owner), and `npm run build`.
//   node test/browser-openapps.mjs [http://127.0.0.1:3581] [screenshot folder]
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3581';
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
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const problems = [];
page.on('pageerror', e => problems.push('pageerror: ' + e.message));

const button = () => page.locator('.tray-apps');
const panel = () => page.locator('.open-apps');
const rows = () => panel().locator('[role="option"]');
const titles = () => rows().locator('.apps-title').allInnerTexts();
const frontTitle = () => page.locator('.win.active .win-title-text').innerText();
const openApp = async label => {
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill(label);
  await page.locator(`.start-menu [data-label="${label}"]`).first().click();
  await page.waitForTimeout(300);
};
async function closeEverything() {
  if (await panel().count()) await page.keyboard.press('Escape');
  for (let i = 0; i < 60; i++) {
    const dialog = page.locator('.dialog');
    if (await dialog.count()) {
      await dialog.first().getByRole('button', { name: /without saving/ }).first().click({ timeout: 2000 }).catch(() => dialog.first().getByRole('button').last().click());
      continue;
    }
    if (!(await page.locator('.win').count())) return;
    await page.evaluate(() => document.querySelectorAll('.win .win-close').forEach(b => b.click()));
    await page.waitForTimeout(250);
  }
}
/** Notepad, Calculator and Calendar, with typing left unsaved in Notepad. */
async function threeApps(unsavedLast = false) {
  await closeEverything();
  if (unsavedLast) await openApp('calculator');
  await openApp('notepad');
  await page.locator('.win', { has: page.locator('.editor') }).last().locator('textarea.editor-text').fill('a line not saved');
  if (!unsavedLast) await openApp('calculator');
  await openApp('calendar');
  eq(await page.locator('.win').count(), 3, 'windows open');
}
async function openPanel() {
  if (!(await panel().count())) await button().click();
  await panel().waitFor();
}

console.log('Open apps, against ' + BASE);
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

await step('the button sits in the tray just before Show the desktop, named and marked as opening a pop-up', async () => {
  const order = await page.locator('.tray > button:not([hidden])').evaluateAll(bs => bs.map(b => b.getAttribute('aria-label') || b.className));
  const at = order.indexOf('Open apps');
  ok(at >= 0, 'no Open apps button: ' + order);
  eq(order[at + 1], 'Show the desktop', 'button after Open apps');
  ok(order[at - 1].includes('clock'), 'clock before Open apps: ' + order);
  eq(await button().getAttribute('aria-haspopup'), 'dialog', 'aria-haspopup');
  eq(await button().getAttribute('aria-expanded'), 'false', 'aria-expanded closed');
  eq(await button().evaluate(b => b.tabIndex), 0, 'in the Tab order');
});

await step('empty: "No apps are open."', async () => {
  await closeEverything();
  await openPanel();
  eq(await rows().count(), 0, 'rows');
  ok(await panel().getByText('No apps are open.').isVisible(), 'empty message');
  ok(await panel().locator('.apps-close-all').isDisabled(), 'Close all is off with nothing open');
  ok(await button().locator('.apps-count').isHidden(), 'no count with nothing open');
  await page.keyboard.press('Escape');
  eq(await panel().count(), 0, 'Escape closes it');
});

await step('three apps, one unsaved: the panel lists three, the unsaved one marked, and the button counts them', async () => {
  await threeApps();
  eq(await button().locator('.apps-count').innerText(), '3', 'count');
  await openPanel();
  eq(await button().getAttribute('aria-expanded'), 'true', 'aria-expanded open');
  eq(await rows().count(), 3, 'rows');
  const notes = await rows().evaluateAll(rs => rs.map(r => r.textContent));
  eq(notes.filter(t => t.includes('Not saved')).length, 1, 'one row says Not saved: ' + notes);
  ok(notes.find(t => t.includes('Not saved')).includes('Quick Notes') || (await rows().filter({ hasText: 'Not saved' }).locator('.apps-title').innerText()).length > 0, 'the unsaved row');
  eq(await rows().locator('svg.icon').count(), 3, 'each row has its app picture');
  eq(await panel().locator('[role="listbox"]').count(), 1, 'a listbox');
  const fonts = await panel().evaluate(el => [...el.querySelectorAll('*')].filter(e => e.childNodes.length && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())).map(e => parseFloat(getComputedStyle(e).fontSize)));
  ok(fonts.every(f => f >= 12), 'every text at least 12 px: ' + fonts);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/openapps.png` });
});

await step('clicking a row brings that window to the front and closes the panel', async () => {
  await openPanel();
  const row = rows().filter({ hasText: 'Calculator' });
  await row.locator('.apps-title').click();
  eq(await panel().count(), 0, 'panel closed');
  ok(/Calculator/.test(await frontTitle()), 'front is ' + (await frontTitle()));
  eq(await button().getAttribute('aria-expanded'), 'false', 'aria-expanded closed again');
});

await step('× on a clean window closes it, and the panel stays open with the list updated', async () => {
  await openPanel();
  await rows().filter({ hasText: 'Calendar' }).locator('.apps-x').click();
  await page.waitForTimeout(200);
  eq(await page.locator('.dialog').count(), 0, 'no question for a clean window');
  ok(await panel().isVisible(), 'panel still open');
  eq(await rows().count(), 2, 'rows left');
  ok(!(await titles()).some(t => /Calendar/.test(t)), 'Calendar gone from the list');
  eq(await page.locator('.win').count(), 2, 'windows left');
  ok(await panel().evaluate(el => el.contains(document.activeElement)), 'focus stays in the panel');
});

await step('× on the unsaved window asks; Keep it open keeps it, and the panel is still there', async () => {
  await openPanel();
  await rows().filter({ hasText: 'Not saved' }).locator('.apps-x').click();
  const dialog = page.locator('.dialog');
  await dialog.waitFor();
  ok(await dialog.getByRole('button', { name: 'Keep it open' }).isVisible(), 'Keep it open offered');
  ok(await dialog.getByRole('button', { name: /without saving/ }).isVisible(), 'Close without saving offered');
  // A second press while it asks does not ask twice.
  await page.evaluate(() => document.querySelector('.open-apps .apps-row.dirty .apps-x')?.click());
  await page.waitForTimeout(150);
  eq(await page.locator('.dialog').count(), 1, 'one question at a time');
  await dialog.getByRole('button', { name: 'Keep it open' }).click();
  await page.waitForTimeout(200);
  eq(await page.locator('.win').count(), 2, 'still two windows');
  ok(await panel().isVisible(), 'panel still open after the question');
  eq(await rows().count(), 2, 'rows');
});

await step('keyboard: Up/Down/Home/End move, Enter switches, Delete closes, Escape returns focus to the button', async () => {
  await threeApps();
  await button().focus();
  await page.keyboard.press('Enter');
  await panel().waitFor();
  const focused = () => page.evaluate(() => document.activeElement?.closest('[role="option"]')?.querySelector('.apps-title')?.textContent ?? document.activeElement?.className);
  const all = await titles();
  eq(await focused(), all[0], 'first row focused on opening');
  await page.keyboard.press('ArrowDown');
  eq(await focused(), all[1], 'ArrowDown');
  await page.keyboard.press('End');
  eq(await focused(), all[2], 'End');
  await page.keyboard.press('ArrowDown');
  eq(await focused(), all[2], 'ArrowDown at the end stays');
  await page.keyboard.press('Home');
  eq(await focused(), all[0], 'Home');
  await page.keyboard.press('ArrowUp');
  eq(await focused(), all[0], 'ArrowUp at the top stays');
  eq(await page.evaluate(() => document.activeElement?.getAttribute('aria-selected')), 'true', 'the focused row is the selected option');
  // Delete on the Calendar row (clean) closes it at once and leaves focus on a row.
  const cal = all.findIndex(t => /Calendar/.test(t));
  await page.keyboard.press('Home');
  for (let i = 0; i < cal; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(250);
  eq(await rows().count(), 2, 'Delete closed one');
  ok(await page.evaluate(() => !!document.activeElement?.closest('.open-apps [role="option"]')), 'focus on a row after Delete');
  // Enter on Calculator switches.
  await page.keyboard.press('Home');
  const now = await titles();
  for (let i = 0; i < now.findIndex(t => /Calculator/.test(t)); i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  eq(await panel().count(), 0, 'Enter closed the panel');
  ok(/Calculator/.test(await frontTitle()), 'Enter switched: front is ' + (await frontTitle()));
  // Escape gives focus back to the button.
  await button().focus();
  await page.keyboard.press('Enter');
  await panel().waitFor();
  await page.keyboard.press('Escape');
  eq(await panel().count(), 0, 'Escape closed it');
  eq(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Open apps', 'focus back on the button');
});

await step('a minimised window is listed as minimised and comes back when picked', async () => {
  await threeApps();
  const calc = page.locator('.win', { has: page.locator('.win-title-text', { hasText: 'Calculator' }) });
  await calc.locator('.win-btn[aria-label="Minimise"]').click();
  ok(await calc.evaluate(w => w.classList.contains('min')), 'minimised');
  await openPanel();
  const row = rows().filter({ hasText: 'Calculator' });
  ok((await row.innerText()).includes('minimised'), 'marked minimised: ' + (await row.innerText()));
  await row.locator('.apps-title').click();
  ok(!(await calc.evaluate(w => w.classList.contains('min'))), 'restored');
  ok(/Calculator/.test(await frontTitle()), 'in front');
});

await step('the list follows a window closed elsewhere while the panel is open', async () => {
  await threeApps();
  await openPanel();
  eq(await rows().count(), 3, 'rows before');
  // Closed by its own title-bar cross (a pointer press outside the panel would close the panel, so it is clicked in script).
  await page.evaluate(() => [...document.querySelectorAll('.win')].find(w => /Calendar/.test(w.querySelector('.win-title-text').textContent)).querySelector('.win-close').click());
  await page.waitForTimeout(200);
  ok(await panel().isVisible(), 'panel still open');
  eq(await rows().count(), 2, 'rows after');
  eq(await button().locator('.apps-count').innerText(), '2', 'count after');
  // And one opened elsewhere shows up.
  await page.evaluate(() => document.querySelector('.tray-apps').click());
  await openApp('calendar');
  await openPanel();
  eq(await rows().count(), 3, 'rows after opening another');
});

await step('Close all closes each in turn and stops at Keep it open', async () => {
  // Calculator, then the unsaved Notepad, then Calendar: Calculator goes, Notepad asks, Calendar is left alone.
  await threeApps(true);
  await openPanel();
  await panel().locator('.apps-close-all').click();
  const dialog = page.locator('.dialog');
  await dialog.waitFor();
  await dialog.getByRole('button', { name: 'Keep it open' }).click();
  await page.waitForTimeout(300);
  const left = await page.locator('.win .win-title-text').allInnerTexts();
  eq(left.length, 2, 'stopped part way: ' + left);
  ok(!left.some(t => /Calculator/.test(t)) && left.some(t => /Calendar/.test(t)), 'Calculator closed, Calendar not reached: ' + left);
  ok(await panel().isVisible(), 'panel still open');
  // Again, closing without saving this time: everything goes, and the panel says so.
  await panel().locator('.apps-close-all').click();
  await page.locator('.dialog').getByRole('button', { name: /without saving/ }).click();
  await page.waitForTimeout(300);
  eq(await page.locator('.win').count(), 0, 'all closed');
  ok(await panel().getByText('No apps are open.').isVisible(), 'empty message');
});

await step('a click outside closes the panel', async () => {
  await page.keyboard.press('Escape');
  await threeApps();
  await openPanel();
  await page.mouse.click(400, 200);
  eq(await panel().count(), 0, 'closed by a click outside');
});

await step('dark theme: the panel is readable', async () => {
  await threeApps();
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await openPanel();
  const [fg, bg] = await panel().evaluate(el => [getComputedStyle(el.querySelector('.apps-title')).color, getComputedStyle(el).backgroundColor]);
  ok(fg !== bg, `${fg} on ${bg}`);
  const lum = c => {
    const [r, g, b] = c.match(/\d+/g).map(Number).map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
  ok((a + 0.05) / (b + 0.05) >= 4.5, `contrast ${((a + 0.05) / (b + 0.05)).toFixed(2)}`);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/openapps-dark.png` });
  await page.keyboard.press('Escape');
});

await step('phone width with touch: the panel fits the screen and a tap on × closes a window', async () => {
  await closeEverything();
  // The same signed-in session, on a small touch screen.
  const phone = await browser.newContext({ viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true, storageState: await context.storageState() });
  const p = await phone.newPage();
  p.on('pageerror', e => problems.push('phone pageerror: ' + e.message));
  await p.goto(BASE);
  await p.locator('#desktop .item').first().waitFor({ timeout: 20000 });
  await p.locator('.start-btn').tap();
  await p.locator('.start-filter').fill('calculator');
  await p.locator('.start-menu [data-label="calculator"]').first().tap();
  await p.waitForTimeout(300);
  await p.locator('.tray-apps').tap();
  await p.locator('.open-apps').waitFor();
  const box = await p.locator('.open-apps').boundingBox();
  ok(box.x >= 0 && box.x + box.width <= 360, `fits across: ${JSON.stringify(box)}`);
  ok(box.y >= 0, 'fits down');
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/openapps-phone.png` });
  await p.locator('.open-apps [role="option"] .apps-x').first().tap();
  await p.waitForTimeout(300);
  eq(await p.locator('.win').count(), 0, 'closed by a tap');
  await phone.close();
});

await step('no page errors', async () => {
  eq(problems, [], 'page errors');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
await browser.close();
process.exit(failures.length ? 1 : 0);
