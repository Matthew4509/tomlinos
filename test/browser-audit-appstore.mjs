// Audit of the App Manager and store apps in a real Chrome against its own PHP server (port 3141). The server's web root
// is a throw-away copy of out/ (so installing apps never writes into the shared out/apps), its data folder is fresh, and
// its store is a folder made here, signed with a throw-away key: nothing leaves this computer.
// Checked: a hostile signed app cannot reach the desktop, the sign-in, storage, popups or the top window; the owner's
// password prompt works from the keyboard (Enter in the field, Escape); a wrong password changes nothing; a store that is
// down still leaves the built-in shelves usable; small window sizes keep every button reachable; an app deleted from
// the server while someone has it open.
// Needs `npm run build` done, PHP with sodium and zip, Chrome.   node test/browser-audit-appstore.mjs
import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHP, extFlags } from './php-bin.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = Number(process.env.PORT ?? 3141);
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = 'orchard-lantern-harbour-58';
let passed = 0;
const failures = [];
async function step(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); } catch (error) { failures.push(name); console.log('  FAIL ' + name + '\n       ' + String(error?.message ?? error).split('\n')[0]); }
}
const ok = (cond, what) => { if (!cond) throw new Error(what); };

const work = mkdtempSync(join(tmpdir(), 'tomlinos-audit-appstore-'));
const web = join(work, 'web');
cpSync(join(root, 'out'), web, { recursive: true, filter: src => !/[\\/]out[\\/]apps([\\/]|$)/.test(src) });
const storeDir = join(work, 'store');
mkdirSync(storeDir, { recursive: true });
const keys = generateKeyPairSync('ed25519');
const PUBLIC = keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');

// A signed app that tries everything a hostile app would; what it found is read from its frame.
const PROBE_HTML = '<!doctype html><meta charset="utf-8"><title>Probe</title><body><h1>Probe</h1><script src="probe.js"></script>';
// Inline scripts are refused by the desktop's own policy, so the probe is a file of its own, as a real app ships it.
const PROBE = `
window.probe = async () => {
  const r = {};
  const t = (k, f) => { try { r[k] = String(f()); } catch (e) { r[k] = 'blocked'; } };
  t('origin', () => self.origin);
  t('parentDoc', () => window.parent.document.title);
  t('topHref', () => window.top.location.href);
  t('cookie', () => document.cookie);
  t('local', () => localStorage.length);
  t('popup', () => window.open('/', '_blank'));
  t('session', () => sessionStorage.length);
  try { r.sw = await navigator.serviceWorker.register('/sw.js').then(() => 'registered', () => 'blocked'); } catch (e) { r.sw = 'blocked'; }
  r.here = await fetch('/api/apps.php?op=here', { credentials: 'include', headers: { 'X-Desktop-Store': '1' } }).then(x => x.status, () => 'blocked');
  r.plain = await fetch('/api/apps.php?op=here', { credentials: 'include' }).then(x => x.status, () => 'blocked');
  r.post = await fetch('/api/apps.php?op=delete', { method: 'POST', credentials: 'include', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ id: 'probe' }) }).then(x => x.type, () => 'blocked');
  return r;
};
`;
function zipApp(id, version, files) {
  const path = join(storeDir, `${id}-${version}.zip`);
  const r = spawnSync(PHP, [...extFlags('zip'), '-r', `$z = new ZipArchive(); $z->open(getenv('ZIP'), ZipArchive::CREATE | ZipArchive::OVERWRITE); foreach (json_decode(getenv('F'), true) as $n => $b) { $z->addFromString($n, $b); } $z->close();`],
    { env: { ...process.env, ZIP: path, F: JSON.stringify(files) }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return { id, title: id === 'probe' ? 'Probe App' : 'Second Game', icon: 'app', kind: 'games', version, date: '2026-11-01', notes: 'Audit', bytes: readFileSync(path).length,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'), zips: [`https://example.invalid/${id}-${version}.zip`], size: [500, 400] };
}
function publish(apps) {
  const bytes = Buffer.from(JSON.stringify({ made: '2026-11-01', apps }));
  writeFileSync(join(storeDir, 'catalogue.json'), JSON.stringify({ catalogue: bytes.toString('base64'), sig: sign(null, bytes, keys.privateKey).toString('base64') }));
}
publish([zipApp('probe', '1.0', { 'index.html': PROBE_HTML, 'probe.js': PROBE }), zipApp('second', '1.0', { 'index.html': '<!doctype html><title>Second</title><p id="v">one</p>' })]);

const server = spawn(PHP, [...extFlags('openssl', 'mbstring', 'sodium', 'zip'), '-d', 'opcache.enable=0', '-d', 'display_errors=0', '-d', 'memory_limit=1G', '-S', `127.0.0.1:${PORT}`, '-t', web, join(root, 'server', 'dev-router.php')], {
  cwd: root, env: { ...process.env, DESKTOP_DATA_DIR: join(work, 'data'), DESKTOP_APPSTORE_DIR: storeDir, DESKTOP_APPSTORE_KEY: PUBLIC }, stdio: 'ignore',
});
console.log(`server pid ${server.pid}, work ${work}`);
await new Promise(r => setTimeout(r, 1500));

process.on('exit', () => { try { server.kill(); } catch { /* gone */ } });
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const owner = await ctx.newPage();
const errors = [];
owner.on('pageerror', e => errors.push(e.message));
await owner.goto(BASE);
await owner.locator('.gate h1', { hasText: 'Set up this desktop' }).waitFor({ timeout: 30000 });
await owner.getByLabel('Your name').fill('Audit Owner');
await owner.locator('.gate input.gate-input').last().fill(PASS);
await owner.locator('.gate-encrypt').uncheck().catch(() => undefined);
await owner.locator('.gate-go').click();
await owner.locator('.gate h1', { hasText: 'Your recovery key' }).waitFor({ timeout: 30000 });
await owner.locator('.gate .check-row input').check();
await owner.getByRole('button', { name: 'Continue' }).click();
await owner.locator('#desktop .item').first().waitFor({ timeout: 30000 });

const openManager = async () => {
  await owner.locator('.start-btn').click();
  await owner.keyboard.type('Application manager');
  await owner.locator('.start-menu .start-item', { hasText: 'Application manager' }).first().click();
  const win = owner.locator('.win', { hasText: 'Application manager' });
  await win.locator('.ast-kind', { hasText: 'Games' }).click();
  await win.getByText('Looking in the app store...').waitFor({ state: 'detached', timeout: 20000 });
  return win;
};
const tile = (win, title) => win.locator('.ast-tile', { hasText: title });

await step('keyboard: the owner downloads with Tab and Enter; the password field has focus and Enter in it confirms', async () => {
  const win = await openManager();
  const t = tile(win, 'Probe App');
  await t.waitFor({ timeout: 10000 });
  await t.getByRole('button', { name: 'Download to this server' }).focus();
  await owner.keyboard.press('Enter');
  const dialog = owner.locator('.dialog');
  await dialog.waitFor({ timeout: 5000 });
  ok(await owner.evaluate(() => document.activeElement?.getAttribute('type') === 'password'), 'the password field does not have focus');
  await owner.keyboard.type(PASS);
  await owner.keyboard.press('Enter');
  await t.getByRole('button', { name: 'Install' }).waitFor({ timeout: 30000 });
});

await step('a wrong password at the prompt changes nothing and says so', async () => {
  const win = await openManager();
  const t = tile(win, 'Second Game');
  await t.getByRole('button', { name: 'Download to this server' }).click();
  await owner.locator('.dialog').getByLabel('Your password').fill('not-the-password-1');
  await owner.locator('.dialog').getByRole('button', { name: 'Download', exact: true }).click();
  await owner.waitForTimeout(3000);
  const said = (await owner.locator('.dialog').allTextContents()).join(' | ').replace(/\s+/g, ' ');
  console.log(`       after a wrong password: ${said.slice(0, 300)}`);
  // Whatever it shows is closed again with its own button, so the next steps start clear.
  while (await owner.locator('.dialog').count()) {
    await owner.locator('.dialog button').last().click();
    await owner.waitForTimeout(300);
  }
  ok(/password is not right/.test(said), 'no word that the password was wrong');
  ok(await t.getByRole('button', { name: 'Download to this server' }).isEnabled(), 'the Download button stayed disabled');
  ok(await t.getByRole('button', { name: 'Install' }).count() === 0, 'it was downloaded with a wrong password');
});

await step('keyboard: Delete from server, password typed and Enter pressed, deletes (or the prompt says Enter cancels)', async () => {
  const win = await openManager();
  const t = tile(win, 'Probe App');
  await t.getByRole('button', { name: 'Delete from server' }).focus();
  await owner.keyboard.press('Enter');
  await owner.locator('.dialog').waitFor({ timeout: 5000 });
  await owner.keyboard.type(PASS);
  await owner.keyboard.press('Enter');
  await owner.waitForTimeout(2500);
  const stillThere = await owner.evaluate(() => fetch('/apps/probe/index.html').then(r => r.status));
  const dialogOpen = await owner.locator('.dialog').count();
  ok(stillThere === 404, `Enter in the password field of the delete prompt did not delete (page answers ${stillThere}, dialog open: ${dialogOpen}), with no word that it was cancelled`);
});

await step('a hostile signed app reaches nothing: not the desktop, top window, storage, popups, a service worker or the API', async () => {
  // (Downloaded again if the step above deleted it.)
  const win = await openManager();
  const t = tile(win, 'Probe App');
  if (await t.getByRole('button', { name: 'Download to this server' }).count()) {
    await t.getByRole('button', { name: 'Download to this server' }).click();
    await owner.locator('.dialog').getByLabel('Your password').fill(PASS);
    await owner.locator('.dialog').getByRole('button', { name: 'Download', exact: true }).click();
  }
  await t.getByRole('button', { name: 'Install' }).click();
  await t.getByRole('button', { name: 'Remove' }).waitFor({ timeout: 10000 });
  await t.locator('.ast-app').click();
  await owner.frameLocator('.win iframe[title="Probe App"]').locator('h1').waitFor({ timeout: 15000 });
  const frame = owner.frames().find(f => f.url().includes('/apps/probe/'));
  const r = await frame.evaluate(() => window.probe());
  console.log('       probe:', JSON.stringify(r));
  ok(r.origin === 'null', `origin ${r.origin}`);
  for (const k of ['parentDoc', 'topHref', 'cookie', 'local', 'session', 'sw']) ok(r[k] === 'blocked', `${k}: ${r[k]}`);
  ok(r.popup === 'blocked' || r.popup === 'null', `a popup opened: ${r.popup}`);
  ok(r.here === 'blocked' && r.plain === 'blocked', `the API answered: ${r.here} / ${r.plain}`);
  const status = await owner.evaluate(() => fetch('/apps/probe/index.html').then(x => x.status));
  ok(status === 200, 'a blind POST from the app deleted it from the server');
});

await step('the app is deleted from the server while it is open in another signed-in tab: that tab is told, not left on a dead page', async () => {
  const other = await ctx.newPage();
  await other.goto(BASE);
  await other.locator('#desktop .item').first().waitFor({ timeout: 30000 });
  await other.locator('.start-btn').click();
  await other.keyboard.type('Probe App');
  await other.locator('.start-menu .start-item', { hasText: 'Probe App' }).first().click();
  await other.frameLocator('.win iframe[title="Probe App"]').locator('h1').waitFor({ timeout: 15000 });
  const win = await openManager();
  await tile(win, 'Probe App').getByRole('button', { name: 'Delete from server' }).click();
  await owner.locator('.dialog').getByLabel('Your password').fill(PASS);
  await owner.locator('.dialog button', { hasText: 'Delete from server' }).click();
  await tile(win, 'Probe App').getByRole('button', { name: 'Download to this server' }).waitFor({ timeout: 10000 });
  await other.waitForTimeout(1500);
  const stillOpen = await other.locator('.win iframe[title="Probe App"]').count();
  const reload = await other.evaluate(() => fetch('/apps/probe/index.html').then(x => x.status));
  console.log(`       other tab: window still open ${stillOpen}, its page now answers ${reload}`);
  await other.close();
  ok(stillOpen === 0 || reload === 200, 'P1: the other tab keeps a window on an app whose files are gone (it shows Not found inside it)');
});

await step('the store down (no catalogue): the shelves still show the built-in apps and say why the store is empty', async () => {
  renameSync(join(storeDir, 'catalogue.json'), join(storeDir, 'gone.json'));
  try {
    await owner.locator('.win', { hasText: 'Application manager' }).locator('.win-close').click().catch(() => undefined);
    const win = await openManager();
    await win.locator('.ast-kind', { hasText: 'System' }).click();
    ok(await win.locator('.ast-tile').count() > 3, 'no built-in apps on the System shelf');
    const note = await win.locator('.ast-panel [role=status]').first().textContent();
    console.log(`       store-down note: ${note}`);
    ok(!!note, 'no word at all for a store that is down');
  } finally {
    renameSync(join(storeDir, 'gone.json'), join(storeDir, 'catalogue.json'));
  }
});

await step('small window and phone width: every App Manager button stays reachable, nothing wider than the window', async () => {
  await owner.setViewportSize({ width: 375, height: 700 });
  await owner.waitForTimeout(500);
  await owner.locator('.win', { hasText: 'Application manager' }).locator('.win-close').click().catch(() => undefined);
  const win = await openManager();
  const r = await win.evaluate(el => {
    const box = el.getBoundingClientRect();
    const panel = el.querySelector('.ast-panel');
    const out = [...el.querySelectorAll('button')].filter(b => { const x = b.getBoundingClientRect(); return x.width > 0 && (x.right > innerWidth + 1 || x.left < -1); }).map(b => b.textContent);
    return { win: [Math.round(box.width), Math.round(box.height)], scrollW: panel.scrollWidth, clientW: panel.clientWidth, out };
  });
  console.log('       small:', JSON.stringify(r));
  ok(r.out.length === 0, `buttons off screen: ${r.out.join(', ')}`);
  ok(r.scrollW <= r.clientW + 1, `the panel scrolls sideways (${r.scrollW} > ${r.clientW})`);
  await owner.setViewportSize({ width: 1280, height: 800 });
});

await step('no page errors', async () => ok(errors.length === 0, errors.join(' | ')));

await browser.close();
server.kill();
await new Promise(r => setTimeout(r, 500));
rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
