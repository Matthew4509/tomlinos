// RISC-V Studio audit (browser): tries to break it from the keyboard. No P0 was found, so every step checks something
// that works now and must keep working; "info" lines are P1 findings (reported, not failed), each measured live.
// Needs the dev server on a FRESH, EMPTY data folder (the first step sets up the owner), and out/ built.
//   node test/browser-audit-riscv.mjs [http://127.0.0.1:3134] [screenshot folder]
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3134';
const SHOTS = process.argv[3] ?? null;
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PASS = 'riscv-audit-passphrase-77';
let passed = 0;
const failures = [];
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
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
const settle = ms => page.waitForTimeout(ms);

const st = page.locator('.studio');
const area = st.locator('.code-input');
const badge = () => st.locator('.studio-badge').innerText();
const active = () => page.evaluate(() => document.activeElement?.className ?? '');
/** Replaces the code as typing would (so Undo and the dirty mark see it). */
async function setCode(text) {
  await area.click();
  await area.evaluate((el, t) => {
    el.focus();
    el.select();
    document.execCommand('insertText', false, t);
  }, text);
}

console.log('RISC-V Studio audit, against ' + BASE);
await page.goto(BASE);

await step('set up a fresh desktop and open RISC-V Studio', async () => {
  await page.locator('.gate h1', { hasText: 'Set up this desktop' }).waitFor({ timeout: 20000 });
  await page.getByLabel('Your name').fill('Audit Tester');
  await page.locator('.gate input.gate-input').last().fill(PASS);
  await page.locator('.gate-encrypt').uncheck();
  await page.locator('.gate-go').click();
  await page.locator('.gate h1', { hasText: 'Your recovery key' }).waitFor({ timeout: 30000 });
  await page.locator('.gate .check-row input').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#desktop .item').first().waitFor({ timeout: 20000 });
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('risc-v studio');
  await page.locator('.start-menu [data-label="risc-v studio"]').first().click();
  await st.locator('.hl-line').first().waitFor({ timeout: 15000 });
});

await step('an endless loop leaves the page responsive and F6 pauses it on its line', async () => {
  await setCode('loop: addi t0, t0, 1\n      j loop\n');
  await page.keyboard.press('F5');
  await settle(500);
  ok((await badge()) === 'RUNNING', 'running');
  const lag = await page.evaluate(() => new Promise(r => { const t = performance.now(); setTimeout(() => r(performance.now() - t), 0); }));
  ok(lag < 200, `the page answered a timer in ${Math.round(lag)} ms`);
  await page.keyboard.press('F6');
  await settle(200);
  ok((await badge()) === 'PAUSED', 'paused');
  ok(await st.locator('.code-mark.pc').count() === 1, 'the pc line is marked');
});

await step('an assembler mistake names its line and marks it', async () => {
  await setCode('nop\nnop\n\n# c\nbogus t0\n');
  await page.keyboard.press('F9');
  await st.locator('.dos-box', { hasText: 'Line 5' }).waitFor();
  ok(await st.locator('.code-mark.error').count() === 1, 'red line');
  await page.keyboard.press('Enter');
});

await step('P1 checks: Step after the end, a fault while stepping, Tab, Change', async () => {
  await setCode('li t0, 5\nebreak\n');
  for (let i = 0; i < 3; i++) await page.keyboard.press('F8');
  await settle(100);
  ok((await badge()) === 'ENDED', 'ended');
  await page.keyboard.press('F8');
  await settle(100);
  if ((await badge()) === 'ENDED') info('RV-P1-13', 'after a program ends, F8 Step cannot start it again from the top (Step only repeats the end message; there is no Reset/Stop in the Run menu, and Shift+F5 runs it to the end). Workaround: change the code.');

  await setCode('li t0, 1\nlw t1, 0(t0)\nebreak\n');
  await page.keyboard.press('F8');
  await page.keyboard.press('F8');
  await settle(100);
  ok((await badge()) === 'FAULT', 'fault');
  if (await st.locator('.code-mark.error').count() === 0) info('RV-P1-14', 'a fault met with F8 Step is not marked in red on its line (a fault met with F5 is).');

  await area.click();
  for (let i = 0; i < 3; i++) await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Escape');
  if ((await active()).includes('code-input')) info('RV-P1-15', 'keyboard trap: Tab, Shift+Tab and Escape all leave focus in the code box (Shift+Tab does nothing at all); only F10/Alt reach the menus.');

  await setCode('ADDI t0, t0, 1\naddi t1, t1, 1\n');
  await page.keyboard.press('Control+h');
  await st.locator('.dos-box input').fill('addi');
  await page.keyboard.press('Enter');
  const box = await st.locator('.dos-box').innerText();
  if (/Change 1\b/.test(box)) info('RV-P1-16', 'Change counts and replaces case-sensitively (1 of "addi"), while Find matches either case (2).');
  await page.keyboard.press('Escape');
  await settle(200);
});

// Save As and Open are the desktop's shared Open/Save window now (the DOS-style file box is gone). Its type drop-down
// gives the name the program's ending, so a ".txt" name becomes a .s program and Open can always list it (RV-P1-17).
const fileWin = title => page.locator('.dialog', { has: page.locator('.dialog-title', { hasText: title }) });
async function saveProgramAs(name) {
  await page.keyboard.press('Control+Shift+S');
  const d = fileWin('Save program as');
  await d.waitFor();
  await d.getByLabel('File name').fill(name);
  await d.getByRole('button', { name: 'Save', exact: true }).click();
  await d.waitFor({ state: 'detached' });
}
await step('a program saved with Save As reopens with the same text; a .txt name is saved as a program Open lists', async () => {
  await setCode('# mine\nli a0, 7\nebreak\n');
  await saveProgramAs('mine');
  await st.locator('.studio-code .dos-pane-title', { hasText: /mine\.s/i }).waitFor();
  await setCode('# notes\nebreak\n');
  await saveProgramAs('notes.txt');
  // The window takes the new name once the write is done, a moment after the Save window closes.
  await st.locator('.studio-code .dos-pane-title', { hasText: /notes\./i }).waitFor().catch(() => {});
  const title = await st.locator('.studio-code .dos-pane-title').innerText();
  ok(/notes\.s\b/i.test(title), 'a .txt name saves as a program: ' + title);
  await page.keyboard.press('Control+o');
  const open = fileWin('Open program');
  await open.waitFor();
  await open.locator('.pick-row').first().waitFor();
  const list = await open.locator('.pick-row').evaluateAll(rows => rows.map(r => r.getAttribute('title')));
  ok(list.some(n => /^mine\.s$/i.test(n)), 'mine.s listed: ' + list.join(', '));
  ok(list.some(n => /^notes\.s$/i.test(n)), 'notes.s listed: ' + list.join(', '));
  await open.locator('.pick-row', { hasText: /^mine\.s/i }).first().dblclick();
  await st.locator('.studio-code .dos-pane-title', { hasText: /mine\.s/i }).waitFor();
  ok((await area.inputValue()) === '# mine\nli a0, 7\nebreak\n', 'same text back');
});

await step('closing the window with unsaved code asks first', async () => {
  await setCode('nop\n');
  await page.locator('.win', { has: st }).locator('.win-close').first().click();
  await page.locator('text=Close without saving?').waitFor({ timeout: 5000 });
  ok(await st.count() === 1, 'still open');
});

console.log(problems.length ? 'page errors: ' + problems.join(' | ') : 'no page errors');
console.log(`${passed} passed, ${failures.length} failed`);
await browser.close();
process.exit(failures.length ? 1 : 0);
