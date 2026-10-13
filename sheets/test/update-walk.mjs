// Tries an update end to end on this computer: an installed TEST build (release.mjs --test-feed) is started, asked
// to check for updates through its File menu, told to install, and must come back as the newer version, with
// Windows' Apps list saying so too. Serve the newer test build's folder at the test address first.
//   node sheets/test/update-walk.mjs "<path to TOMLIN Sheets.exe>" <expected new version> [screenshot folder]
// With --tampered the served update has been changed on purpose: it must be refused and nothing installed.
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tampered = process.argv.includes('--tampered');
const [exe, expected, shots] = process.argv.slice(2).filter(a => a !== '--tampered');
if (!exe || !existsSync(exe) || !expected) throw new Error('Give the path to TOMLIN Sheets.exe and the version it should update to.');
const PORT = 9334;
const work = mkdtempSync(join(tmpdir(), 'tomlin-sheets-update-'));
const env = { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`, WEBVIEW2_USER_DATA_FOLDER: join(work, 'webview') };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0;
const failed = [];
const check = (name, ok, detail = '') => {
  if (ok) passed++;
  else failed.push(name);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `  (${detail})` : ''}`);
};
async function until(what, fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await Promise.resolve().then(fn).catch(() => null);
    if (v) return v;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}`);
}
async function page(title) {
  const browser = await until('the debugging port', () => chromium.connectOverCDP(`http://127.0.0.1:${PORT}`), 30000);
  const p = await until(`a window titled ${title}`, async () => {
    for (const c of browser.contexts()) for (const pg of c.pages()) if ((await pg.title()) === title) return pg;
    return null;
  }, 30000);
  // A window that has just opened is still showing itself (which closes menus): let it settle.
  await p.waitForSelector('.grid-wrap');
  await sleep(1200);
  return { browser, p };
}
const registryVersion = () => execFileSync('powershell', ['-NoProfile', '-Command', "(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' | Where-Object { $_.DisplayName -eq 'TOMLIN Sheets' }).DisplayVersion"], { encoding: 'utf8' }).trim();
const running = () => execFileSync('powershell', ['-NoProfile', '-Command', "@(Get-Process | Where-Object { $_.ProcessName -eq 'TOMLIN Sheets' }).Id -join ','"], { encoding: 'utf8' }).trim();

const before = registryVersion();
try {
  spawn(exe, [], { env, stdio: 'ignore', detached: true }).unref();
  let { browser, p } = await page('Book1 - TOMLIN Sheets');
  const version = async () => p.evaluate(() => (window).__TAURI__.app.getVersion());
  const old = await version();
  check(`the installed copy is the older version (${old}, Apps list ${before})`, old !== expected && before === old);
  await p.click('.file-tab');
  await p.click('.menu-item:has-text("Check for updates")');
  const offer = await until('the update offer', async () => {
    const t = await p.evaluate(() => document.querySelector('.dialog')?.textContent ?? '');
    return t.includes(`Version ${expected} is available`) ? t : null;
  });
  check(`File > Check for updates offers ${expected} with its notes`, /Test build/.test(offer), offer.slice(0, 160));
  if (shots) await p.screenshot({ path: join(shots, 'update-offer.png') });
  const pidsBefore = running();
  await p.click('.dialog .btn:has-text("Install and restart")');
  if (tampered) {
    // A download that is not the signed one must be refused, with the program left as it was.
    const refusal = await until('the refusal', async () => {
      const t = await p.evaluate(() => document.querySelector('.dialog')?.textContent ?? '');
      return t.includes('was not installed') ? t : null;
    }, 60000);
    check('a changed download is refused for its signature', refusal.includes('does not carry this program\'s signature'), refusal);
    if (shots) await p.screenshot({ path: join(shots, 'update-refused.png') });
    check('the program is still the old version and still running', (await version()) === old && running() === pidsBefore && registryVersion() === old);
    await p.keyboard.press('Enter');
    await p.click('.file-tab');
    await p.click('.menu-item:has-text("Exit TOMLIN Sheets")');
    throw new Error('DONE');
  }
  await browser.close().catch(() => undefined);
  // The program closes, the installer runs without questions, and the program opens again.
  await until('the old program to close', () => running() !== pidsBefore, 60000);
  ({ browser, p } = await page('Book1 - TOMLIN Sheets'));
  const now = await p.evaluate(() => (window).__TAURI__.app.getVersion());
  check(`it came back by itself as ${expected}`, now === expected, now);
  check(`Windows' Apps list says ${expected}`, registryVersion() === expected, registryVersion());
  await p.click('.file-tab');
  await p.click('.menu-item:has-text("Check for updates")');
  globalThis.lastPage = p;
  // The installer starts it behind other windows; a person's click brings it forward, the test does so itself.
  await p.evaluate(() => (window).__TAURI__.window.appWindow.setFocus());
  await sleep(500);
  const after = await until('the up-to-date answer', async () => {
    const t = await p.evaluate(() => document.querySelector('.dialog')?.textContent ?? '');
    return t.includes('up to date') ? t : null;
  });
  check('checking again says it is up to date', after.includes(`${expected} is the newest version`), after);
  if (shots) await p.screenshot({ path: join(shots, 'update-done.png') });
  await p.keyboard.press('Enter');
  await p.click('.file-tab');
  await p.click('.menu-item:has-text("Exit TOMLIN Sheets")');
  await browser.close().catch(() => undefined);
} catch (error) {
  // 'DONE' ends the tampered run early on purpose; anything else is a failure, shown with what was on screen.
  const lp = error.message === 'DONE' ? null : globalThis.lastPage;
  if (error.message !== 'DONE') {
    failed.push(error.message);
    console.log(`FAIL  stopped: ${error.message}`);
  }
  if (lp) {
    console.log('  on screen:', await lp.evaluate(() => ({ dialog: document.querySelector('.dialog')?.textContent ?? null, menu: document.querySelector('.menu')?.textContent?.slice(0, 80) ?? null, toasts: document.querySelector('#layer-toasts')?.textContent ?? '' })).then(JSON.stringify, e => String(e)));
    console.log('  raw check:', await lp.evaluate(() => (window).__TAURI__.tauri.invoke('update_check').then(r => 'ok ' + JSON.stringify(r), e => 'ERR ' + e)).catch(e => String(e)));
    if (shots) await lp.screenshot({ path: join(shots, 'update-stuck.png') }).catch(() => undefined);
  }
} finally {
  await sleep(1500);
  // Only this program, by its process ids (never by name for other programs).
  for (const id of running().split(',').filter(Boolean)) {
    try {
      execFileSync('taskkill', ['/PID', id, '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // Gone already.
    }
  }
  await sleep(500);
  rmSync(work, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
