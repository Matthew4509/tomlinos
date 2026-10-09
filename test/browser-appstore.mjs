// The app store, end to end in a real Chrome against a real server: a store is published with tools/store-publish.mjs
// (signed with a throwaway key made here) into a folder the server reads (DESKTOP_APPSTORE_DIR), so nothing leaves this
// computer. Checked: a new owner has no store app; the Games shelf lists Office Printer from the signed list; the owner
// downloads it onto the server; Install adds it to their own desktop; it opens sandboxed (no reach into the desktop, no
// security errors) and finds the Reader's books; a second person sees it on the server but not on their desktop until
// they press Install; Remove takes it off; the owner deletes it from the server; a list signed with another key is
// refused; a zip that does not match its fingerprint is thrown away.
// Needs `npm run build` done, PHP (PHP_BIN, or php on the PATH) with sodium and zip, and Chrome. It starts its own server.
//   node test/browser-appstore.mjs
import { chromium } from 'playwright-core';
import { spawn, execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHP, extFlags } from './php-bin.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = Number(process.env.PORT ?? 3093);
const BASE = `http://127.0.0.1:${PORT}`;
let passed = 0;
const failures = [];
async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (error) {
    failures.push(name);
    console.log('  FAIL ' + name + '\n       ' + String(error?.message ?? error).split('\n')[0]);
  }
}
const ok = (cond, what) => {
  if (!cond) throw new Error(what);
};

// A throwaway signing key, and a store signed with it.
const work = mkdtempSync(join(tmpdir(), 'tomlinos-appstore-'));
const keys = generateKeyPairSync('ed25519');
writeFileSync(join(work, 'key.pem'), keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
const publicRaw = keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
const storeDir = join(work, 'store');
execFileSync(process.execPath, [join(root, 'tools', 'store-publish.mjs'), 'officeprinter', 'First release', '--out', storeDir],
  { env: { ...process.env, TOMLINOS_RELEASE_KEY: join(work, 'key.pem') }, stdio: 'pipe' });
const data = join(work, 'data');

const server = spawn(PHP, [...extFlags('openssl', 'mbstring', 'sodium', 'zip'), '-S', `127.0.0.1:${PORT}`, '-t', join(root, 'out'), join(root, 'server', 'dev-router.php')], {
  cwd: root,
  env: { ...process.env, DESKTOP_DATA_DIR: data, DESKTOP_APPSTORE_DIR: storeDir, DESKTOP_APPSTORE_KEY: publicRaw },
  stdio: 'ignore',
});
const stop = () => {
  server.kill();
  rmSync(join(root, 'out', 'apps'), { recursive: true, force: true });
};
await new Promise(r => setTimeout(r, 1500));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const problems = [];
const watch = p => {
  p.on('pageerror', e => problems.push(`page error: ${e.message}`));
  p.on('console', m => {
    if (m.type() === 'error' && /Trusted|Content Security|refused|CORS|blocked/i.test(m.text())) problems.push(m.text());
  });
};
const owner = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
watch(owner);

await owner.goto(BASE);
await owner.locator('.gate h1', { hasText: 'Set up' }).waitFor({ timeout: 30000 });
await owner.getByLabel('Your name').fill('Store Owner');
await owner.getByLabel('User name (for signing in)').fill('tester');
await owner.locator('.gate input[type=password]').fill('browser-test-passphrase-1');
await owner.locator('.gate-go').click();
await owner.locator('.gate h1', { hasText: 'Your recovery key' }).waitFor({ timeout: 30000 });
await owner.locator('.gate .check-row input').check();
await owner.getByRole('button', { name: 'Continue' }).click();
await owner.locator('#desktop .item').first().waitFor({ timeout: 30000 });

const startHas = async (p, title) => {
  await p.locator('.start-btn').click();
  await p.keyboard.type(title);
  const n = await p.locator('.start-menu .start-item', { hasText: title }).count();
  await p.keyboard.press('Escape');
  return n > 0;
};
const openManager = async p => {
  await p.locator('.start-btn').click();
  await p.keyboard.type('Application manager');
  await p.locator('.start-menu .start-item', { hasText: 'Application manager' }).first().click();
  const win = p.locator('.win', { hasText: 'Application manager' });
  await win.locator('.ast-kind', { hasText: 'Games' }).click();
  await win.getByText('Looking in the app store...').waitFor({ state: 'detached', timeout: 20000 });
  return win;
};
const tile = win => win.locator('.ast-tile', { hasText: 'Office Printer' });

await step('a new owner has no store app on their desktop', async () => {
  ok(!(await startHas(owner, 'Office Printer')), 'listed before anything was done');
});

await step('Games lists Office Printer from the signed list; the owner downloads it onto the server', async () => {
  const win = await openManager(owner);
  const t = tile(win);
  await t.waitFor({ timeout: 10000 });
  ok(await t.locator('.ast-app').isDisabled(), 'it opens before it is on the server');
  await t.getByRole('button', { name: 'Download to this server' }).click();
  await t.getByRole('button', { name: 'Install' }).waitFor({ timeout: 30000 });
  ok(!(await startHas(owner, 'Office Printer')), 'downloading put it on the owner\'s desktop without Install');
});

await step('Install adds it to the owner\'s own desktop, and it opens', async () => {
  const win = await openManager(owner);
  await tile(win).getByRole('button', { name: 'Install' }).click();
  await tile(win).getByRole('button', { name: 'Remove' }).waitFor({ timeout: 10000 });
  await win.locator('.win-close').click();
  ok(await startHas(owner, 'Office Printer'), 'not in the Start menu after Install');
  await owner.locator('.start-btn').click();
  await owner.keyboard.type('Office Printer');
  await owner.locator('.start-menu .start-item', { hasText: 'Office Printer' }).first().click();
  const frame = owner.frameLocator('.win iframe[title="Office Printer"]');
  await frame.locator('#desk > *').first().waitFor({ timeout: 20000 });
  await owner.waitForTimeout(1500);
  ok(await frame.locator('svg').count() > 0, 'no drawings in the game');
});

await step('it runs sandboxed: no reach into the desktop, the sign-in or the person\'s files', async () => {
  const game = owner.frames().find(f => f.url().includes('/apps/officeprinter/'));
  ok(game, 'the game frame is missing');
  const r = await game.evaluate(async () => {
    let parentDoc = 'blocked';
    try { parentDoc = window.parent.document ? 'reached' : 'blocked'; } catch { /* cross-origin */ }
    const files = await fetch('/api/store.php?op=list&path=%2F', { credentials: 'include', headers: { 'X-Desktop-Store': '1' } }).then(x => x.status, () => 'refused');
    return { origin: self.origin, parentDoc, files };
  });
  ok(r.origin === 'null', `its origin is ${r.origin}, not a sandbox`);
  ok(r.parentDoc === 'blocked', 'it reached the desktop page');
  ok(r.files !== 200, 'it read the person\'s files');
  // The browser reports that refused request as an error: expected here, not a fault.
  problems.splice(0, problems.length, ...problems.filter(p => !/api\/store\.php/.test(p)));
});

await step('it finds the Reader\'s books (library and Sherlock Holmes) from inside the sandbox', async () => {
  const game = owner.frames().find(f => f.url().includes('/apps/officeprinter/'));
  const codes = await game.evaluate(async () => Promise.all(['/reader/library.json', '/reader/texts/sherlock.txt'].map(u => fetch(u).then(r => r.status, () => 0))));
  ok(codes.every(c => c === 200), `answers ${codes.join(', ')}`);
  ok(problems.length === 0, problems.join(' | '));
});

await step('asked by the game, the desktop opens the book in its own Reader window; the same ask from elsewhere is ignored', async () => {
  const ask = { type: 'tomlinos-open-reader', author: 'doyle', work: 'a-study-in-scarlet' };
  await owner.evaluate(m => window.postMessage(m, '*'), ask);
  await owner.waitForTimeout(800);
  ok(await owner.locator('.win iframe[title="Reader"]').count() === 0, 'a message not from the game opened the Reader');
  const game = owner.frames().find(f => f.url().includes('/apps/officeprinter/'));
  await game.evaluate(m => window.parent.postMessage(m, '*'), ask);
  const reader = owner.locator('.win iframe[title="Reader"]');
  await reader.waitFor({ timeout: 10000 });
  ok((await reader.getAttribute('src')).includes('work=a-study-in-scarlet'), 'the Reader did not open that book');
  await owner.frameLocator('.win iframe[title="Reader"]').getByText('A Study in Scarlet').first().waitFor({ timeout: 15000 });
  await owner.locator('.win.active .win-close').click();
  ok(await reader.count() === 0, 'the Reader window did not close');
});

await step('a second person sees it on the server, but it is not on their desktop until they press Install', async () => {
  // The owner adds a person (My account > People) through the accounts API, as the page does (own password first).
  const made = await owner.evaluate(async () => {
    const r = await fetch('/api/auth.php?op=user-create', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Desktop-Store': '1' },
      body: JSON.stringify({ name: 'second', display: 'Second Person', next: 'second-person-passphrase-9', password: 'browser-test-passphrase-1', code: '' }) });
    return r.status;
  });
  ok(made === 200, `adding a person answered ${made}`);
  const other = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  watch(other);
  await other.goto(BASE);
  await other.getByRole('button', { name: 'Log in for more' }).click();
  await other.getByLabel('Username').fill('second');
  await other.locator('input[type=password]').first().fill('second-person-passphrase-9');
  await other.getByRole('button', { name: 'Log in', exact: true }).click();
  // A person's first sign-in asks how their files are kept (left as offered), then shows their recovery key once.
  await other.locator('.gate h1', { hasText: 'Your files' }).waitFor({ timeout: 30000 });
  await other.locator('.gate-go').click();
  await other.locator('.gate h1', { hasText: 'Your recovery key' }).waitFor({ timeout: 30000 });
  await other.locator('.gate .check-row input').check();
  await other.getByRole('button', { name: 'Continue' }).click();
  const where = await other.locator('#desktop .item').first().waitFor({ timeout: 30000 }).then(() => 'desktop', async () => other.locator('body').innerText());
  ok(where === 'desktop', `after signing in: ${String(where).replace(/\s+/g, ' ').slice(0, 300)}`);
  ok(!(await startHas(other, 'Office Printer')), 'it is on their desktop unasked');
  const win = await openManager(other);
  const t = tile(win);
  await t.getByRole('button', { name: 'Install' }).waitFor({ timeout: 10000 });
  ok(await t.getByRole('button', { name: 'Download to this server' }).count() === 0, 'a person who is not the owner is offered Download');
  ok(await t.getByRole('button', { name: 'Delete from server' }).count() === 0, 'a person who is not the owner is offered Delete');
  await other.context().close();
});

await step('Remove takes it off the owner\'s desktop and closes it; kept after a reload', async () => {
  const win = await openManager(owner);
  await tile(win).getByRole('button', { name: 'Remove' }).click();
  await tile(win).getByRole('button', { name: 'Install' }).waitFor({ timeout: 10000 });
  ok(await owner.locator('.win iframe[title="Office Printer"]').count() === 0, 'its window stayed open');
  await owner.reload();
  await owner.locator('#desktop .item').first().waitFor({ timeout: 30000 });
  ok(!(await startHas(owner, 'Office Printer')), 'back after a reload');
});

await step('the owner deletes it from the server: its files are gone', async () => {
  const win = await openManager(owner);
  await tile(win).getByRole('button', { name: 'Delete from server' }).click();
  await owner.locator('.dialog button', { hasText: 'Delete from server' }).click();
  await tile(win).getByRole('button', { name: 'Download to this server' }).waitFor({ timeout: 10000 });
  const status = await owner.evaluate(() => fetch('/apps/officeprinter/index.html').then(r => r.status));
  ok(status === 404, `its page still answers ${status}`);
});

await step('a list not signed by TOMLIN OS is refused, and so is a zip that does not match its fingerprint', async () => {
  const good = readFileSync(join(storeDir, 'catalogue.json'), 'utf8');
  const signed = JSON.parse(good);
  const payload = JSON.parse(Buffer.from(signed.catalogue, 'base64').toString('utf8'));
  payload.apps[0].title = 'Office Printer (changed)';
  writeFileSync(join(storeDir, 'catalogue.json'), JSON.stringify({ catalogue: Buffer.from(JSON.stringify(payload)).toString('base64'), sig: signed.sig }));
  const list = await owner.evaluate(() => fetch('/api/apps.php?op=list', { credentials: 'same-origin', headers: { 'X-Desktop-Store': '1' } }).then(r => r.json()));
  ok(/not signed by TOMLIN OS/.test(list.error ?? '') && list.apps.length === 0, `a changed list was believed: ${JSON.stringify(list).slice(0, 120)}`);
  writeFileSync(join(storeDir, 'catalogue.json'), good);
  const zip = join(storeDir, `officeprinter-${payload.apps[0].version}.zip`);
  const bytes = readFileSync(zip);
  writeFileSync(zip, Buffer.concat([bytes, Buffer.from('tampered')]));
  const r = await owner.evaluate(() => fetch('/api/apps.php?op=download', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Desktop-Store': '1' }, body: JSON.stringify({ id: 'officeprinter' }) }).then(async x => [x.status, await x.text()]));
  ok(r[0] !== 200 && /fingerprint/.test(r[1]), `a changed zip was installed: ${r[0]} ${r[1].slice(0, 100)}`);
  writeFileSync(zip, bytes);
  const status = await owner.evaluate(() => fetch('/apps/officeprinter/index.html').then(x => x.status));
  ok(status === 404, 'something was unpacked from the changed zip');
});

await step('no page errors in the whole run', async () => ok(problems.length === 0, problems.join(' | ')));

await browser.close();
stop();
rmSync(work, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
