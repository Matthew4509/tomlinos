// Encryption and recovery in a real Chrome, checked against the server's own disk: set up with "Encrypt my files", save
// a file, then prove its words and its name are nowhere readable in the data folder. Then: reload, sign in again,
// "Forgot your password?" with the recovery key, a reset by the server tool (the recovery key reopens the files), and
// turning encryption off. Also the Studio's Linux example and full-screen game.
// Needs `npm run build` and a server on a FRESH, EMPTY data folder (tools/fresh-server.sh prints it):
//   node test/browser-vault.mjs http://127.0.0.1:3045 "<data folder>"
import { chromium } from 'playwright-core';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3045';
const DATA = process.argv[3];
if (!DATA || !existsSync(DATA)) throw new Error('Pass the server\'s data folder as the second argument.');
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PHP = process.env.PHP_BIN ?? 'php';
const SECRET = 'The treasure is under the old oak tree';
let pass = 'orchard-lantern-harbour-58';
let recovery = '';
let passed = 0;
const failures = [];

async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (error) {
    failures.push(name);
    const shot = join(tmpdir(), `tomlinos-vault-fail-${failures.length}.png`);
    await page.screenshot({ path: shot }).catch(() => undefined);
    console.log('  FAIL ' + name + '\n       ' + String(error.message).slice(0, 1200) + '\n       (screenshot: ' + shot + ')');
  }
}
const eq = (a, b, what) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const ok = (v, what) => {
  if (!v) throw new Error(what);
};

/** Every record file of every person, as raw bytes (the 32-character version stamp removed). */
function records() {
  const out = [];
  const users = join(DATA, 'users');
  for (const id of existsSync(users) ? readdirSync(users) : []) {
    const objects = join(users, id, 'objects');
    if (!existsSync(objects)) continue;
    for (const f of readdirSync(objects, { recursive: true, withFileTypes: true })) {
      if (f.isFile() && !f.name.endsWith('.tmp')) out.push(readFileSync(join(f.parentPath ?? f.path, f.name)).subarray(32));
    }
  }
  return out;
}
const MAGIC = Buffer.from([0x00, 0x4d, 0x59, 0x49, 0x45, 0x4e, 0x43, 0x01]); // "\0MYIENC\x01", src/auth/vault.ts

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
const page = await context.newPage();
const problems = [];
page.on('console', m => m.type() === 'error' && problems.push('console: ' + m.text()));
page.on('pageerror', e => problems.push('pageerror: ' + e.message));
const settle = ms => page.waitForTimeout(ms);
const openApp = async label => {
  await page.locator('.start-btn').click();
  // Most apps sit in groups: find it by name in the Start menu's search box, as a person would.
  await page.locator('.start-filter').fill(label);
  await page.locator(`.start-menu [data-label="${label}"]`).first().click();
};
// These steps were written for the plain sign-in page; since the Reader became the default front, the owner turns
// the sign-in page on first (Settings offers the same choice). browser-touch.mjs covers the Reader front.
const signInFront = p => p.evaluate(() => fetch('api/auth.php?op=site-front', {
  method: 'POST', credentials: 'same-origin',
  headers: { 'X-Desktop-Store': '1', 'Content-Type': 'application/json' },
  body: JSON.stringify({ front: 'signin' }),
}).then(r => r.status));
const desktop = () => page.locator('#desktop .item').first().waitFor({ timeout: 30000 });
const signIn = async password => {
  await page.locator('.gate h1', { hasText: 'Sign in' }).waitFor({ timeout: 20000 });
  await page.getByLabel('User name').fill('alex');
  await page.locator('.gate input[type=password]').fill(password);
  await page.locator('.gate-go').click();
};
const signOut = async () => {
  await page.locator('.start-btn').click();
  await page.locator('.start-signout').click();
  await page.locator('.gate h1', { hasText: 'Sign in' }).waitFor({ timeout: 20000 });
};
/** Opens the saved file in the Text Editor and returns what it shows. */
const readSecret = async () => {
  await page.locator('#desktop .item', { hasText: 'My Files' }).dblclick();
  const explorer = page.locator('.win').last();
  await explorer.locator('.item', { hasText: 'Documents' }).dblclick();
  await explorer.locator('.item', { hasText: 'secret.txt' }).dblclick();
  const editor = page.locator('.win', { has: page.locator('.editor-text') });
  await editor.locator('.editor-text').waitFor();
  // The editor shows its box first and fills it once the file has been read (and opened).
  await page.waitForFunction(() => {
    const t = document.querySelector('.editor-text');
    return !!t && (t.value !== '' || t.disabled);
  }, null, { timeout: 15000 }).catch(() => undefined);
  const text = await editor.locator('.editor-text').inputValue();
  for (let i = 0; i < 6 && (await page.locator('.win').count()) > 0; i++) await page.locator('.win').last().getByRole('button', { name: 'Close' }).click();
  return text;
};

console.log('Encryption and recovery, against ' + BASE);
await page.goto(BASE);

await step('set-up with "Encrypt my files": the recovery key is shown once, before the desktop', async () => {
  await page.locator('.gate h1', { hasText: 'Set up this desktop' }).waitFor({ timeout: 20000 });
  await page.getByLabel('Your name').fill('Alex');
  await page.locator('.gate input[type=password]').fill(pass);
  await page.locator('.gate-encrypt').check();
  await page.locator('.gate-go').click();
  await page.locator('.gate h1', { hasText: 'Your recovery key' }).waitFor({ timeout: 30000 });
  recovery = (await page.locator('.gate-rkey-show').innerText()).trim();
  ok(/^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/.test(recovery), 'recovery key: ' + recovery);
  ok(await page.getByRole('button', { name: 'Continue' }).isDisabled(), 'Continue waits for the tick');
  await page.locator('.gate .check-row input').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await desktop();
  eq(await signInFront(page), 200, 'the owner turns the sign-in page on');
});

await step('a saved file is stored sealed: its words and its name are nowhere on the server\'s disk', async () => {
  await openApp('notepad');
  const editor = page.locator('.win', { has: page.locator('.editor-text') });
  await editor.locator('.editor-text').fill(SECRET);
  await page.keyboard.press('Control+s');
  const input = page.locator('.dialog-label input');
  await input.fill('secret.txt');
  await page.keyboard.press('Enter');
  await page.locator('.toast', { hasText: 'Saved' }).first().waitFor();
  await editor.getByRole('button', { name: 'Close' }).click();
  await settle(1500);
  const all = records();
  ok(all.length >= 3, 'records on disk: ' + all.length);
  const plain = all.filter(r => !r.subarray(0, 8).equals(MAGIC));
  eq(plain.length, 0, 'records not sealed');
  const disk = Buffer.concat(all).toString('latin1');
  for (const word of ['treasure', 'secret.txt', 'Documents', 'session.json']) ok(!disk.includes(word), `"${word}" readable on the server's disk`);
});

await step('a reload opens the files without asking (the key kept in this browser)', async () => {
  await page.reload();
  await desktop();
  eq(await readSecret(), SECRET, 'the file');
});

await step('signing out forgets the kept key; signing in again opens the files with the password', async () => {
  await signOut();
  const kept = await page.evaluate(() => new Promise(r => {
    const req = indexedDB.open('tomlinos-keys', 1);
    req.onsuccess = () => {
      const all = req.result.transaction('keys').objectStore('keys').count();
      all.onsuccess = () => r(all.result);
    };
    req.onerror = () => r(-1);
  }));
  eq(kept, 0, 'keys kept after signing out');
  await signIn(pass);
  await desktop();
  eq(await readSecret(), SECRET, 'the file');
});

await step('"Forgot your password?" with the recovery key sets a new password; the files still open', async () => {
  await signOut();
  // The picture check's answer box is in the form from the start, in a hidden row, until the server asks for it.
  eq(await page.locator('.gate input:visible').count(), 2, 'the sign-in screen still shows two fields');
  ok(await page.locator('.gate-captcha-row').isHidden(), 'no picture check before a wrong try');
  await page.getByRole('button', { name: 'Forgot your password?' }).click();
  await page.locator('.gate h1', { hasText: 'Forgot your password?' }).waitFor();
  await page.getByLabel('User name').fill('alex');
  await page.locator('.gate-rkey').fill(recovery.toLowerCase().replace(/-/g, ' '));
  pass = 'new-meadow-lantern-5';
  await page.locator('.gate input[autocomplete=new-password]').fill(pass);
  await page.getByRole('button', { name: 'Set new password' }).click();
  await desktop();
  eq(await readSecret(), SECRET, 'the file');
});

await step('reset by the server tool: the new password signs in, and the recovery key reopens the files once', async () => {
  await signOut();
  const out = spawnSync(PHP, ['server/tools/reset-password.php', 'alex'], { env: { ...process.env, DESKTOP_DATA_DIR: DATA }, encoding: 'utf8' });
  const newPass = /New password for alex: (\S+)/.exec(out.stdout)?.[1];
  ok(newPass, out.stdout + out.stderr);
  // As another device would: nothing kept in the browser, nothing in the page's memory.
  await page.evaluate(() => new Promise(r => { const d = indexedDB.deleteDatabase('tomlinos-keys'); d.onsuccess = d.onerror = () => r(0); }));
  await page.reload();
  await signIn(newPass);
  await page.locator('.gate h1', { hasText: 'Open your files' }).waitFor({ timeout: 20000 });
  await page.locator('.gate-rkey').fill('AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH');
  await page.getByRole('button', { name: 'Open my files' }).click();
  await page.locator('.gate-problem', { hasText: 'does not open' }).waitFor();
  await page.locator('.gate-rkey').fill(recovery);
  await page.getByRole('button', { name: 'Open my files' }).click();
  await desktop();
  eq(await readSecret(), SECRET, 'the file');
  pass = newPass;
  // Once: from now on the password alone opens the files. As another device would (nothing kept in this browser), a
  // reload asks for the password only, with no recovery key box. (Not by signing out and in: the wrong recovery key
  // above counts as a wrong try, so the next password sign-in asks for the picture check, which a test cannot read.)
  await page.evaluate(() => new Promise(r => { const d = indexedDB.deleteDatabase('tomlinos-keys'); d.onsuccess = d.onerror = () => r(0); }));
  await page.reload();
  await page.locator('.gate h1', { hasText: 'Open your files' }).waitFor({ timeout: 20000 });
  eq(await page.locator('.gate-rkey').count(), 0, 'no recovery key asked for any more');
  await page.locator('.gate input[type=password]').fill(pass);
  await page.getByRole('button', { name: 'Open my files' }).click();
  await desktop();
  eq(await readSecret(), SECRET, 'the file, opened with the new password alone');
});

await step('My account turns encryption off; afterwards the files are stored readable again', async () => {
  await openApp('my account');
  const w = page.locator('.win', { has: page.locator('.account') });
  await w.getByRole('button', { name: 'Your files' }).click();
  await w.getByText('On. Your files and their names are encrypted').waitFor();
  await w.getByRole('button', { name: 'Turn off encryption...' }).click();
  await w.locator('.acct-form input[type=password]').fill(pass);
  await w.getByRole('button', { name: 'Turn off encryption', exact: true }).click();
  await page.locator('.toast', { hasText: 'no longer encrypted' }).waitFor({ timeout: 30000 });
  await settle(500);
  const all = records();
  eq(all.filter(r => r.subarray(0, 8).equals(MAGIC)).length, 0, 'sealed records left');
  ok(Buffer.concat(all).toString('latin1').includes('treasure'), 'the file is plain again');
  await w.getByRole('button', { name: 'Close' }).click();
  eq(await readSecret(), SECRET, 'the file');
});

await step('Studio: the real Linux program prints the Fibonacci numbers; Alt+Enter makes the game screen full screen', async () => {
  await openApp('risc-v studio');
  const studio = page.locator('.studio');
  await studio.locator('.code-input').click();
  await page.keyboard.press('Alt+x');
  await page.keyboard.press('r');
  await studio.locator('.studio-code .dos-pane-title', { hasText: 'LINUX.S' }).waitFor();
  await page.keyboard.press('F5');
  await studio.locator('.studio-panel', { hasText: '89' }).waitFor({ timeout: 10000 });
  ok((await studio.locator('.studio-panel').innerText()).includes('exit code 0'), 'ended with exit code 0');
  await page.keyboard.press('Alt+Enter');
  await settle(500);
  eq(await page.evaluate(() => document.fullscreenElement?.className ?? null), 'screen-box', 'full screen element');
  await page.keyboard.press('Alt+Enter');
  await settle(500);
  eq(await page.evaluate(() => document.fullscreenElement), null, 'back from full screen');
});

await step('no page errors in the whole run', async () => {
  // 401/403: the wrong recovery key on purpose, and signing out. 404: a key not made yet.
  const real = problems.filter(p => !/40[134]|409/.test(p));
  eq(real, [], 'console problems');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) console.log('Failed: ' + failures.join('; '));
await Promise.race([browser.close(), new Promise(r => setTimeout(r, 3000))]);
process.exit(failures.length ? 1 : 0);
