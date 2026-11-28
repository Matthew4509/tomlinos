// The Calculator sheet's "=" column buttons in a real Chrome: press × + − ÷ in a "=" cell, click the cells one after
// another, press Enter, and the "=" cell holds the answer. Needs the dev server on a FRESH, EMPTY data folder (the
// first step sets up the owner), and `npm run build` done.
//   node test/browser-calc-ops.mjs [http://127.0.0.1:3101] [screenshot folder]
//   or: SUITES="calc-ops" bash tools/run-browser-tests.sh
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
const display = () => calcWin().locator('.calc-display').innerText();
const note = () => calcWin().locator('.calc-note').innerText();
const cellOf = id => calcWin().locator(`[data-id="${id}"]`);
const sumOf = id => cellOf(id).locator('.calc-sum').innerText();
const opOf = (id, op) => cellOf(id).locator(`.calc-op[data-op="${op}"]`);
/** Picks a cell as a user would: on its number, at the right, not on a "=" cell's own buttons. */
const pick = async id => {
  const [w, h] = await cellOf(id).evaluate(el => [el.clientWidth, el.clientHeight]);
  await cellOf(id).click({ position: { x: w - 8, y: h / 2 } });
};
const type = async (id, text) => {
  await cellOf(id).locator('input').fill(text);
};
/** One sign, then the cells, then Enter. */
const make = async (target, op, ...ids) => {
  await opOf(target, op).click();
  for (const id of ids) await pick(id);
  await page.keyboard.press('Enter');
};
async function closeAll() {
  for (let i = 0; i < 40; i++) {
    const dialog = page.locator('.dialog');
    if (await dialog.count()) {
      await dialog.getByRole('button', { name: /without saving|Lose the changes|Close anyway|Cancel|Don't save/ }).first().click().catch(() => dialog.getByRole('button').last().click());
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
  await openApp('calculator');
  await calcWin().locator('.calc-pad').waitFor();
  await calcWin().getByRole('button', { name: /Extend/ }).click();
  await cellOf('R1').waitFor();
}

console.log('Calculator "=" buttons, against ' + BASE);
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

await step('every "=" cell has × + − ÷ buttons, and the A and B cells have none', async () => {
  await freshSheet();
  for (const id of ['R1', 'R2', 'Rf1', 'Rf2']) {
    eq(await cellOf(id).locator('.calc-op').evaluateAll(bs => bs.map(b => getComputedStyle(b, '::before').content)), ['"×"', '"+"', '"−"', '"÷"'], `${id} buttons`);
    eq(await cellOf(id).locator('.calc-op').evaluateAll(bs => bs.map(b => b.getAttribute('aria-label')?.split(':')[0])), ['Times', 'Add', 'Take away', 'Divide'], `${id} button names`);
  }
  eq(await calcWin().locator('[data-id^="A"] .calc-op, [data-id^="B"] .calc-op').count(), 0, 'buttons outside the = column');
  // 12px at least, and the buttons fit inside their cell.
  const size = await opOf('R1', '×').evaluate(el => parseFloat(getComputedStyle(el).fontSize));
  ok(size >= 12, `button text is ${size}px`);
  const cell = await cellOf('R1').boundingBox();
  const last = await opOf('R1', '÷').boundingBox();
  ok(last.x + last.width <= cell.x + cell.width, 'the ÷ button runs out of its cell');
  // The middle of a "=" cell is its number, not a button: clicking the cell chooses it, as it did before.
  ok(last.x + last.width < cell.x + cell.width / 2, 'the buttons reach the middle of the cell');
  await cellOf('R1').click();
  eq(await note(), '=1 is a sum cell. Press = on the calculator, then click cells and press + − × ÷ between them.', 'note after clicking =1');
  // The cell's text is its number only (the signs on the buttons are drawn, not text).
  eq(await cellOf('R1').innerText(), '', 'text of an empty = cell');
});

await step('=1 +: choose the sign, click three cells, Enter saves A1 + B1 + A2', async () => {
  await freshSheet();
  await type('A1', '12');
  await type('B1', '4');
  await type('A2', '5');
  await opOf('R1', '+').click();
  eq(await note(), '=1: add. Click the cells to add, one after another. Esc stops.', 'first prompt');
  eq(await display(), '? + ?', 'display before the first cell');
  ok(await opOf('R1', '+').evaluate(el => el.classList.contains('on')), 'the + pressed is not lit');
  await pick('A1');
  eq(await display(), 'A1 + ?', 'display after the first cell');
  eq(await note(), 'Click the next cell to add, or another sign to change it. Enter saves, Esc stops.', 'next prompt');
  eq(await cellOf('A1').locator('input').inputValue(), '12', 'clicking A1 to pick it does not change it');
  await pick('B1');
  await pick('A2');
  eq(await display(), 'A1 + B1 + A2 + ?', 'display after three cells');
  eq(await sumOf('R1'), '', 'nothing is saved before Enter');
  await shot('calc-ops-picking');
  await page.keyboard.press('Enter');
  eq(await sumOf('R1'), '21', '=1');
  eq(await note(), 'Saved =1 = A1 + B1 + A2.', 'note after saving');
  eq(await display(), '0', 'the calculator\'s display is back');
  await type('B1', '10');
  eq(await sumOf('R1'), '27', '=1 after B1 is changed');
  await shot('calc-ops-saved');
});

await step('× − ÷ over several cells; clicking the "=" cell or the keypad = also saves', async () => {
  await freshSheet();
  await type('A1', '2');
  await type('B1', '3');
  await type('A2', '4');
  await type('A3', '100');
  await type('B3', '10');
  await type('A4', '2');
  await opOf('R1', '×').click();
  for (const id of ['A1', 'B1', 'A2']) await pick(id);
  await pick('R1'); // clicking the cell being made saves it
  eq(await sumOf('R1'), '24', '2 × 3 × 4');
  await opOf('R2', '−').click();
  for (const id of ['A3', 'B3', 'A4']) await pick(id);
  await keyOf('=').click();
  eq(await sumOf('R2'), '88', '100 − 10 − 2');
  await make('R3', '÷', 'A3', 'B3', 'A4');
  eq(await sumOf('R3'), '5', '100 ÷ 10 ÷ 2');
  // "=" cells and foot cells can use the column.
  await make('Rf1', '+', 'R1', 'R2', 'R3');
  eq(await sumOf('Rf1'), '117', 'foot = cell from three = cells');
  eq(await cellOf('Rf1').getAttribute('title'), `${await cellOf('Rf1').getAttribute('aria-label')} = =1 + =2 + =3`, 'foot cell tooltip');
  // While clicking cells, a press that lands on another "=" cell's buttons picks that cell; it does not start over.
  await opOf('Rf2', '+').click();
  await opOf('R1', '÷').click();
  eq(await display(), '=1 + ?', 'display after pressing on =1\'s ÷ while clicking cells');
});

await step('another sign part-way changes it for the cells after; ⌫ takes the last cell off', async () => {
  await freshSheet();
  await type('A1', '2');
  await type('B1', '3');
  await type('A2', '4');
  await type('B2', '9');
  await opOf('R1', '×').click();
  await pick('A1');
  await pick('B1');
  await opOf('R1', '+').click(); // the cell's own + changes the sign
  eq(await display(), 'A1 × B1 + ?', 'after changing to +');
  await pick('A2');
  await pick('B2');
  await keyOf('⌫').click();
  eq(await display(), 'A1 × B1 + A2 + ?', 'after ⌫');
  await page.keyboard.press('x'); // the keyboard's × changes it too
  await pick('B2');
  await page.keyboard.press('Enter');
  eq(await sumOf('R1'), '42', '2 × 3 + 4 × 9 (× before +)');
  eq(await cellOf('R1').getAttribute('title'), '=1 = A1 × B1 + A2 × B2', 'tooltip');
});

await step('Escape stops and leaves the "=" cell as it was; Enter with no cells says so', async () => {
  await freshSheet();
  await type('A1', '5');
  await type('B1', '2');
  await make('R1', '+', 'A1', 'B1');
  eq(await sumOf('R1'), '7', '=1 before');
  await opOf('R1', '×').click();
  await page.keyboard.press('Enter');
  ok(/Click at least one cell first/.test(await note()), `Enter with no cells: ${await note()}`);
  await page.keyboard.press('Escape');
  eq(await note(), 'Stopped. Nothing was changed.', 'Escape before the first cell');
  await opOf('R1', '×').click();
  await pick('A1');
  await pick('B1');
  await page.keyboard.press('Escape');
  eq(await sumOf('R1'), '7', '=1 after Escape');
  eq(await opOf('R1', '×').evaluate(el => el.classList.contains('on')), false, '× still lit after Escape');
  for (const k of ['2', '+', '3', '=']) await keyOf(k).click();
  eq(await display(), '5', '2 + 3 = after stopping');
});

await step('a cell that uses the "=" cell, or a label, is refused with the reason', async () => {
  await freshSheet();
  await type('A1', '3');
  await type('B1', '8');
  await make('R1', '+', 'A1', 'B1');
  await make('R2', '−', 'R1');
  eq(await sumOf('R2'), '11', '=2 = =1');
  await opOf('R1', '−').click();
  await pick('R2');
  ok(/=2 already uses =1/.test(await note()), `note: ${await note()}`);
  eq(await display(), '? − ?', 'display after refusing =2');
  await pick('L1');
  ok(/Labels are text/.test(await note()), `label note: ${await note()}`);
  await pick('A1');
  await pick('B1');
  await page.keyboard.press('Enter');
  eq(await sumOf('R1'), '-5', '=1 = A1 − B1');
});

await step('÷ by an empty cell says why; the sheet saves and reads back', async () => {
  await freshSheet();
  await type('A1', '6');
  await make('R1', '÷', 'A1', 'B1');
  eq(await sumOf('R1'), "Can't divide by 0", '6 ÷ empty');
  await type('B1', '3');
  eq(await sumOf('R1'), '2', '6 ÷ 3');
  const fileWin = () => page.locator('.dialog', { has: page.getByLabel('File name') });
  await calcWin().getByRole('button', { name: 'Save', exact: true }).click();
  await fileWin().getByLabel('File name').fill('Chains');
  await fileWin().getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('.toast', { hasText: 'Saved “Chains.calc”' }).waitFor();
  await closeAll();
  await openApp('calculator');
  await calcWin().locator('.calc-pad').waitFor();
  await calcWin().getByRole('button', { name: /Extend/ }).click();
  await calcWin().getByRole('button', { name: 'Open...' }).click();
  await page.locator('.dialog', { hasText: 'Open a sheet' }).getByText('Chains.calc', { exact: true }).dblclick();
  await cellOf('R1').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-id="R1"] .calc-sum')?.textContent === '2', null, { timeout: 10000 });
  eq(await cellOf('R1').getAttribute('title'), '=1 = A1 ÷ B1', 'tooltip after reading back');
});

await step('in a narrow window the buttons show on the chosen "=" cell, and still work', async () => {
  await freshSheet();
  const win = calcWin();
  const box = await win.boundingBox();
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width - 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + 300, y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  ok(!(await opOf('R2', '×').isVisible()), 'buttons on every = cell in a narrow window');
  await type('A2', '7');
  await type('B2', '6');
  await cellOf('R2').click();
  ok(await opOf('R2', '×').isVisible(), 'no buttons on the chosen = cell');
  await shot('calc-ops-narrow');
  await make('R2', '×', 'A2', 'B2');
  eq(await sumOf('R2'), '42', '=2 in a narrow window');
});

await closeAll().catch(() => {});
await browser.close();
console.log(`\n${passed} passed, ${failures.length} failed${problems.length ? '\npage errors:\n  ' + problems.join('\n  ') : ''}`);
process.exit(failures.length ? 1 : 0);
