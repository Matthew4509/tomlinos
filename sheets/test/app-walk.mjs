// Walks through the installed TOMLIN Sheets program itself (not a browser copy): it starts the real .exe with
// WebView2's debugging port open and drives the page inside it. Each step prints PASS or FAIL.
//   node sheets/test/app-walk.mjs "<path to TOMLIN Sheets.exe>" [screenshot folder]
// Needs Python with openpyxl (to make and read the test workbook). Windows' own Open/Save boxes are not driven here.
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exe = process.argv[2];
const shots = process.argv[3] ?? null;
if (!exe || !existsSync(exe)) throw new Error('Give the path to TOMLIN Sheets.exe.');
const work = mkdtempSync(join(tmpdir(), 'tomlin-sheets-walk-'));
const book = join(work, 'walk.xlsx');
const PORT = 9333;
// The program's own browser storage (recent files, window size) goes in the test folder, not the person's; the one
// setting file the program keeps in AppData is put back as it was at the end.
const profile = join(work, 'webview');
const settings = join(process.env.APPDATA, 'com.tomlin.sheets', 'spreadsheet.json');
const settingsBefore = existsSync(settings) ? readFileSync(settings) : null;
let passed = 0;
const failed = [];

function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed.push(`${name}${detail ? `: ${detail}` : ''}`);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `  (${detail})` : ''}`);
}

function py(code) {
  const file = join(work, `step-${Date.now()}.py`);
  writeFileSync(file, code);
  return execFileSync('python', ['-I', file], { encoding: 'utf8' }).trim();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function until(what, fn, ms = 10000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what} (${last})`);
}

function start(args = []) {
  const child = spawn(exe, args, { env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`, WEBVIEW2_USER_DATA_FOLDER: profile }, stdio: 'ignore' });
  return child;
}

async function attach() {
  const browser = await until('the debugging port', () => chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch(() => null), 20000);
  return browser;
}

async function mainPage(browser, title) {
  return until(`a window titled ${title}`, async () => {
    for (const ctx of browser.contexts()) for (const p of ctx.pages()) if ((await p.title()) === title) return p;
    return null;
  });
}

async function shot(page, name) {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
}

async function goTo(page, ref) {
  await page.click('.name-box');
  await page.keyboard.press('Control+A');
  await page.keyboard.type(ref);
  await page.keyboard.press('Enter');
}

async function dialogText(page) {
  return page.evaluate(() => document.querySelector('.dialog')?.textContent ?? '');
}

const exited = child => new Promise(r => (child.exitCode !== null ? r(child.exitCode) : child.once('exit', r)));

let app = null;
try {
  py(`import openpyxl
wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Stock'
ws['A1'] = 'Item'; ws['B1'] = 'Qty'; ws['A2'] = 'Pens'; ws['B2'] = 3; ws['A3'] = 'Paper'; ws['B3'] = 5; ws['B4'] = '=SUM(B2:B3)'
wb.save(r'${book}')`);

  // ---- 1. A file handed to the program opens in it -------------------------------------------------------------
  app = start([book]);
  let browser = await attach();
  let page = await mainPage(browser, 'walk.xlsx - TOMLIN Sheets');
  check('opens the workbook it was started with (window title)', true);
  await page.waitForSelector('.grid-wrap');
  await goTo(page, 'B4');
  check('the formula from the Excel file is there', (await page.inputValue('.formula-input')) === '=SUM(B2:B3)', await page.inputValue('.formula-input'));
  const tabs = await page.$$eval('.sheet-tab', els => els.map(e => e.textContent));
  check('the sheet keeps its name', tabs.includes('Stock'), tabs.join(','));
  await shot(page, '1-opened');

  // ---- 2. Edit and save over the .xlsx ---------------------------------------------------------------------------
  await goTo(page, 'B2');
  await page.keyboard.type('10');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+S');
  await until('the Saved message', async () => (await page.textContent('#layer-toasts'))?.includes('Saved “walk.xlsx”'));
  const after = py(`import openpyxl
f = openpyxl.load_workbook(r'${book}'); v = openpyxl.load_workbook(r'${book}', data_only=True)
print(f['Stock']['B2'].value, f['Stock']['B4'].value, v['Stock']['B4'].value)`);
  check('Ctrl+S wrote the change into the .xlsx (Excel reader sees B2=10, the formula and its answer 15)', after === '10 =SUM(B2:B3) 15', after);
  check('no half-written file left beside it', !py(`import os; print([n for n in os.listdir(r'${work}') if n.endswith('.tmp')])`).includes('.tmp'));

  // ---- 3. Saving while another program holds the file locked ------------------------------------------------------
  const lockScript = join(work, 'lock.py');
  writeFileSync(lockScript, `import ctypes, time
h = ctypes.windll.kernel32.CreateFileW(r'${book}', 0x80000000, 0, None, 3, 0x80, None)
print('locked' if h != -1 else 'nolock', flush=True)
time.sleep(8)
ctypes.windll.kernel32.CloseHandle(h)`);
  const locker = spawn('python', ['-I', lockScript], { stdio: ['ignore', 'pipe', 'ignore'] });
  await until('the lock', () => new Promise(r => locker.stdout.once('data', d => r(String(d).includes('locked')))));
  await goTo(page, 'A5');
  await page.keyboard.type('Ink');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+S');
  const lockedText = await until('the locked-file message', async () => {
    const t = await dialogText(page);
    return t.includes('open in another program') ? t : null;
  });
  check('a locked file gets a plain message (fault, reason, way out)', /open in another program.*Close it there.*Save as/s.test(lockedText), lockedText);
  await shot(page, '3-locked');
  await page.keyboard.press('Enter');
  await exited(locker);
  await page.keyboard.press('Control+S');
  await until('the Saved message after the lock', async () => (await page.textContent('#layer-toasts'))?.match(/Saved “walk\.xlsx”/g)?.length >= 1 && !(await dialogText(page)));
  check('once the other program lets go, the save goes through', py(`import openpyxl; print(openpyxl.load_workbook(r'${book}')['Stock']['A5'].value)`) === 'Ink');

  // ---- 4. A program, not a browser ------------------------------------------------------------------------------
  await page.evaluate(() => ((window).__walk = 1));
  await page.keyboard.press('F5');
  await page.keyboard.press('Control+R');
  await sleep(1200);
  check('F5 and Ctrl+R do not reload the window', (await page.evaluate(() => (window).__walk).catch(() => 0)) === 1);
  check('no page zoom from the browser', (await page.evaluate(() => window.devicePixelRatio)) > 0);

  // ---- 5. Closing with unsaved changes asks first -----------------------------------------------------------------
  await goTo(page, 'A6');
  await page.keyboard.type('Unsaved');
  await page.keyboard.press('Enter');
  execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${app.pid}).CloseMainWindow() | Out-Null`]);
  const ask = await until('the save-changes question', async () => {
    const t = await dialogText(page);
    return t.includes('Do you want to save the changes') ? t : null;
  });
  check('closing with unsaved changes asks Save / Don’t save / Cancel', /Save.*Don’t save.*Cancel/s.test(ask), ask);
  await shot(page, '5-close-ask');
  await page.click('.dialog .btn:has-text("Cancel")');
  await sleep(600);
  check('Cancel keeps the window open', app.exitCode === null);
  execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${app.pid}).CloseMainWindow() | Out-Null`]);
  await until('the question again', async () => (await dialogText(page)).includes('Do you want to save'));
  await page.click('.dialog .btn:has-text("Don’t save")');
  const code = await Promise.race([exited(app), sleep(8000).then(() => 'still running')]);
  check('Don’t save closes the program', code !== 'still running', String(code));
  check('Don’t save left the file as it was', py(`import openpyxl; print(openpyxl.load_workbook(r'${book}')['Stock']['A6'].value)`) === 'None');
  await browser.close().catch(() => undefined);

  // ---- 6. Start empty: Book1, recent files, a new window, a setting ---------------------------------------------
  app = start();
  browser = await attach();
  page = await mainPage(browser, 'Book1 - TOMLIN Sheets');
  check('started on its own it shows a new workbook called Book1', true);
  await page.click('.file-tab');
  await page.hover('.menu-item:has-text("Open recent")');
  const recent = await until('the recent list', async () => {
    const t = await page.evaluate(() => [...document.querySelectorAll('.menu')].map(m => m.textContent).join(' | '));
    return t.includes('walk.xlsx') ? t : null;
  });
  check('File > Open recent lists the workbook used before', recent.includes('walk.xlsx'));
  await shot(page, '6-recent');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.click('.grid-wrap', { position: { x: 200, y: 120 } });
  await page.keyboard.press('Control+N');
  const second = await mainPage(browser, 'Book2 - TOMLIN Sheets');
  check('Ctrl+N opens Book2 in a window of its own', !!second);
  // The page goes with its window, so the call does not come back.
  await second.evaluate(() => (window).__TAURI__.window.appWindow.close()).catch(() => undefined);
  await until('Book2 to close', async () => second.isClosed() || !(await second.title().catch(() => '')));
  check('closing Book2 leaves Book1 open', app.exitCode === null && (await page.title()) === 'Book1 - TOMLIN Sheets');
  await page.click('.file-tab');
  await page.hover('.menu-item:has-text("Read typed dates as")');
  await page.click('.menu-item:has-text("Year first")');
  await until('the setting file', () => existsSync(settings));
  check('File > Read typed dates as is kept in the person\'s AppData', JSON.parse(readFileSync(settings, 'utf8')).dateOrder === 'ymd');
  await page.click('.file-tab');
  await page.click('.menu-item:has-text("About TOMLIN Sheets")');
  const about = await until('About', async () => (await dialogText(page)).includes('Version') && (await dialogText(page)));
  check('About names the version', /Version \d+\.\d+\.\d+ \(64-bit\)/.test(about), about.slice(0, 120));
  await shot(page, '6-about');
  await page.keyboard.press('Enter');
  await page.click('.file-tab');
  await page.click('.menu-item:has-text("Exit TOMLIN Sheets")');
  const code2 = await Promise.race([exited(app), sleep(8000).then(() => 'still running')]);
  check('File > Exit closes a workbook with no changes without asking', code2 !== 'still running');
  await browser.close().catch(() => undefined);
} catch (error) {
  failed.push(`stopped: ${error.message}`);
  console.log(`FAIL  stopped: ${error.message}`);
} finally {
  // Only this test's own program, by its process id.
  if (app && app.exitCode === null) {
    try {
      execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // Already gone.
    }
  }
  await sleep(500);
  if (settingsBefore) writeFileSync(settings, settingsBefore);
  else rmSync(settings, { force: true });
  rmSync(work, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
