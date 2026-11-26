// Audit of the Calculator in a real Chrome: faults found by trying to break it. Needs the dev server on a FRESH, EMPTY
// data folder (the first step sets up the owner), and `npm run build` done. Each step that fails names a fault still open.
//   node test/browser-audit-calculator.mjs [http://127.0.0.1:3101] [screenshot folder]
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3101';
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
const ok = (v, what) => {
  if (!v) throw new Error(what);
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const problems = [];
page.on('pageerror', e => problems.push('pageerror: ' + e.message));
const shot = async name => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });
const openApp = async label => {
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill(label);
  await page.locator(`.start-menu [data-label="${label}"]`).first().click();
};
const calcWin = () => page.locator('.win', { has: page.locator('.calc') }).last();
const keyOf = k => calcWin().locator(`.calc-key[data-key="${k}"]`);
const pressKeys = async keys => {
  for (const k of keys) await keyOf(k).click();
};
const display = () => calcWin().locator('.calc-display').innerText();
const cellOf = id => calcWin().locator(`[data-id="${id}"]`);
async function closeAll() {
  for (let i = 0; i < 40; i++) {
    const dialog = page.locator('.dialog');
    if (await dialog.count()) {
      await dialog.getByRole('button', { name: /without saving|Lose the changes|Close anyway|Cancel/ }).first().click().catch(() => dialog.getByRole('button').last().click());
      continue;
    }
    const wins = page.locator('.win');
    if (!(await wins.count())) return;
    await wins.last().locator('.win-close').first().click();
    await page.waitForTimeout(80);
  }
}
async function freshCalc(extend = false) {
  await closeAll();
  await openApp('calculator');
  await calcWin().locator('.calc-pad').waitFor();
  if (extend) {
    await calcWin().getByRole('button', { name: /Extend/ }).click();
    await calcWin().locator('[data-id="R1"]').waitFor();
  }
}

console.log('Calculator audit, against ' + BASE);
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

await step('C-P0-display: a long result fits the display (no digits hidden behind an ellipsis)', async () => {
  await freshCalc();
  // 15 digits, a sign and a decimal point: every digit the keypad takes.
  await pressKeys([...'12345678901234', '.', '5', '±']);
  const fits = await calcWin().locator('.calc-display').evaluate(el => el.scrollWidth <= el.clientWidth);
  await shot('audit-calc-long');
  ok(fits, `the display is cut off: "${await display()}" is wider than the box`);
});

await step('C-P0-overflow: a result too big to hold is an error that C must clear, not a number "Too big" that ± turns into "-Too big"', async () => {
  await freshCalc();
  await pressKeys([...'999999999999999', '×', ...'999999999999999', '=']);
  for (let i = 0; i < 5; i++) await pressKeys(['×', '=']);
  eq(await display(), 'Too big', 'shows Too big');
  await keyOf('±').click();
  eq(await display(), 'Too big', '± on an overflow');
});

await step('C-P0-tocell-overflow: → cell refuses to put "Too big" into a number cell', async () => {
  await freshCalc(true);
  await pressKeys([...'999999999999999', '×', ...'999999999999999', '=']);
  for (let i = 0; i < 5; i++) await pressKeys(['×', '=']);
  await cellOf('A1').locator('input').click();
  await calcWin().getByRole('button', { name: '→ cell' }).click();
  eq(await cellOf('A1').locator('input').inputValue(), '', 'A1 after → cell with an overflow');
});

await step('C-P0-equals-hijack: after looking at a sum cell, the calculator\'s own 2 + 3 = still gives 5', async () => {
  await freshCalc(true);
  await cellOf('R1').click(); // only to look at it
  await calcWin().locator('.calc-pad').click({ position: { x: 5, y: 5 } });
  await pressKeys(['2', '+', '3', '=']);
  eq(await display(), '5', 'display after 2 + 3 =');
});

await step('C-P0-keyboard-sum: a sum cell can be reached with Tab (keyboard only)', async () => {
  await freshCalc(true);
  await cellOf('B1').locator('input').focus();
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => document.activeElement?.closest('[data-id]')?.getAttribute('data-id') ?? document.activeElement?.tagName);
  eq(focused, 'R1', 'Tab from B1 lands on');
});

await step('C-P0-escape-in-cell: Escape while typing a label does not wipe the calculator', async () => {
  await freshCalc(true);
  await pressKeys(['4', '+', '5']);
  await cellOf('L1').locator('input').click();
  await page.keyboard.type('Rent');
  await page.keyboard.press('Escape');
  eq(await display(), '5', 'calculator display after Escape in a label');
  await pressKeys(['=']);
  eq(await display(), '9', '4 + 5 = after Escape in a label');
});

await step('C-P0-saveas-stem: Save as with a stem that is taken ("Sums" when Sums.calc exists) is refused in the box, not by an error dialog', async () => {
  await freshCalc(true);
  await cellOf('A1').locator('input').fill('1');
  await calcWin().getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('.dialog input').fill('Sums');
  await page.locator('.dialog').getByRole('button', { name: 'Save' }).click();
  await page.locator('.toast', { hasText: 'Saved “Sums.calc”' }).waitFor();
  await calcWin().getByRole('button', { name: 'Save as...' }).click();
  await page.locator('.dialog input').fill('Sums');
  await page.waitForTimeout(200);
  const saveEnabled = await page.locator('.dialog').getByRole('button', { name: 'Save' }).isEnabled();
  const text = await page.locator('.dialog').innerText();
  ok(!saveEnabled || /already/.test(text), 'the name box accepted "Sums" although Sums.calc exists: ' + text.replace(/\s+/g, ' '));
});

await step('C-P0-narrow-window: with the sheet open, a narrow window still shows the A, B and = columns', async () => {
  await closeAll();
  await freshCalc(true);
  const win = calcWin();
  const box = await win.boundingBox();
  // Drag the right edge in to the smallest width the window allows.
  const x = box.x + box.width - 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(box.x + 300, y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const after = await win.boundingBox();
  const r = await cellOf('R1').boundingBox();
  await shot('audit-calc-narrow');
  ok(r && r.width >= 30 && r.x + r.width <= after.x + after.width + 1, `= column squeezed out at window width ${Math.round(after.width)}: R1 ${JSON.stringify(r)}`);
});

await closeAll().catch(() => {});
await browser.close();
console.log(`\n${passed} passed, ${failures.length} failed${problems.length ? '\npage errors:\n  ' + problems.join('\n  ') : ''}`);
process.exit(failures.length ? 1 : 0);
