// Is a personal file private? In a real Chrome against the real server: the owner sets up with "Encrypt my files" and
// saves a text file, then every other way in is tried: a stranger's browser, plain requests with no sign-in, guessed
// addresses for the stored files, a second person on the same desktop, and the server's own disk. The saved AI model
// files get the same treatment. Last, for contrast, what "Encrypt my files" left OFF means: the words are on the disk.
// Needs `npm run build` and a server on FRESH, EMPTY data and models folders (tools/run-browser-tests.sh does this):
//   node test/browser-privacy.mjs http://127.0.0.1:3043 "<data folder>" "<models folder>"
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3043';
const DATA = process.argv[3];
const MODELS = process.argv[4];
if (!DATA || !existsSync(DATA) || !MODELS || !existsSync(MODELS)) throw new Error('Pass the server\'s data folder and models folder.');
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SECRET = 'My bank PIN is 7391 and the spare key is under the blue pot';
const FILE = 'private-notes.txt';
const PASS = 'orchard-lantern-harbour-58';
const JO_PASS = 'harbour-kettle-meadow-19';
const JO_SECRET = 'Jo keeps the gate code 5528 in this unencrypted note';
let passed = 0;
const failures = [];
let page;

async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (error) {
    failures.push(name);
    const shot = join(tmpdir(), `tomlinos-privacy-fail-${failures.length}.png`);
    await page?.screenshot({ path: shot }).catch(() => undefined);
    console.log('  FAIL ' + name + '\n       ' + String(error.message).slice(0, 1200) + '\n       (screenshot: ' + shot + ')');
  }
}
const eq = (a, b, what) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const ok = (v, what) => {
  if (!v) throw new Error(what);
};
const hasWords = (text, words) => words.filter(w => text.includes(w));

/** A request exactly as written (fetch() would tidy "../" away), with no cookie unless given. */
function raw(path, headers = {}) {
  const url = new URL(BASE);
  return new Promise((resolve, reject) => {
    request({ host: url.hostname, port: url.port, path, headers }, res => {
      const parts = [];
      res.on('data', c => parts.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(parts).toString('latin1') }));
    }).on('error', reject).end();
  });
}

/** Every stored record of every person, as the server's disk holds it. */
function diskRecords() {
  const out = [];
  const users = join(DATA, 'users');
  for (const id of existsSync(users) ? readdirSync(users) : []) {
    const objects = join(users, id, 'objects');
    if (!existsSync(objects)) continue;
    for (const f of readdirSync(objects, { recursive: true, withFileTypes: true })) {
      if (!f.isFile()) continue;
      const full = join(f.parentPath ?? f.path, f.name);
      out.push({ user: id, rel: relative(objects, full).replaceAll('\\', '/'), bytes: readFileSync(full) });
    }
  }
  return out;
}
/** Everything under the data folder, as text, for a plain search. */
function wholeDisk(dir = DATA) {
  let text = '';
  for (const f of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (f.isFile()) text += readFileSync(join(f.parentPath ?? f.path, f.name)).toString('latin1') + '\n';
  }
  return text;
}
const MAGIC = Buffer.from([0x00, 0x4d, 0x59, 0x49, 0x45, 0x4e, 0x43, 0x01]); // "\0MYIENC\x01", src/auth/vault.ts

// A small stand-in model, as "Save to this TOMLIN OS" would leave it (the real ones are hundreds of MB).
const MODEL_FILE = '/models/Qwen3.5-0.8B-q4f32_1-MLC/resolve/main/params_shard_0.bin';
mkdirSync(join(MODELS, 'Qwen3.5-0.8B-q4f32_1-MLC', 'resolve', 'main'), { recursive: true });
writeFileSync(join(MODELS, 'Qwen3.5-0.8B-q4f32_1-MLC', 'resolve', 'main', 'params_shard_0.bin'), Buffer.alloc(4096, 9));
writeFileSync(join(MODELS, 'models.json'), JSON.stringify({ models: [] }));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ownerContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
page = await ownerContext.newPage();
const problems = [];
page.on('pageerror', e => problems.push('pageerror: ' + e.message));
const settle = ms => page.waitForTimeout(ms);
// These steps were written for the plain sign-in page; since the Reader became the default front, the owner turns
// the sign-in page on first (Settings offers the same choice). browser-touch.mjs covers the Reader front.
const signInFront = p => p.evaluate(() => fetch('api/auth.php?op=site-front', {
  method: 'POST', credentials: 'same-origin',
  headers: { 'X-Desktop-Store': '1', 'Content-Type': 'application/json' },
  body: JSON.stringify({ front: 'signin' }),
}).then(r => r.status));
const desktopOf = p => p.locator('#desktop .item').first().waitFor({ timeout: 30000 });
const openApp = async (p, label) => {
  await p.locator('.start-btn').click();
  await p.locator('.start-filter').fill(label);
  await p.locator(`.start-menu [data-label="${label}"]`).first().click();
};
const saveNote = async (p, text, name) => {
  await openApp(p, 'notepad');
  const editor = p.locator('.win', { has: p.locator('.editor-text') });
  await editor.locator('.editor-text').fill(text);
  await p.keyboard.press('Control+s');
  await p.locator('.dialog-label input').fill(name);
  await p.keyboard.press('Enter');
  await p.locator('.toast', { hasText: 'Saved' }).first().waitFor();
  await editor.getByRole('button', { name: 'Close' }).click();
};
/** In a page: the store's answer for every key, as the server sends it. */
const storeDump = p => p.evaluate(async () => {
  const h = { headers: { 'X-Desktop-Store': '1' } };
  const keys = (await (await fetch('/api/store.php?op=keys', h)).json()).keys;
  const out = [];
  for (const k of keys) {
    const r = await fetch('/api/store.php?key=' + encodeURIComponent(k), h);
    const b = new Uint8Array(await r.arrayBuffer());
    out.push({ key: k, status: r.status, text: Array.from(b, c => String.fromCharCode(c)).join('') });
  }
  return out;
});
let ownerKeys = [];

console.log('Privacy of a personal file, against ' + BASE);
await page.goto(BASE);

await step('the owner sets up with "Encrypt my files" and saves a personal text file', async () => {
  await page.locator('.gate h1', { hasText: 'Set up this desktop' }).waitFor({ timeout: 20000 });
  await page.getByLabel('Your name').fill('Alex');
  await page.locator('.gate input[type=password]').fill(PASS);
  await page.locator('.gate-encrypt').check();
  await page.locator('.gate-go').click();
  await page.locator('.gate h1', { hasText: 'Your recovery key' }).waitFor({ timeout: 30000 });
  await page.locator('.gate .check-row input').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await desktopOf(page);
  eq(await signInFront(page), 200, 'the owner turns the sign-in page on');
  await saveNote(page, SECRET, FILE);
  await settle(1500);
});

await step('the owner opens it again and reads the words (the file really holds them)', async () => {
  await page.locator('#desktop .item', { hasText: 'My Files' }).dblclick();
  const explorer = page.locator('.win').last();
  await explorer.locator('.item', { hasText: 'Documents' }).dblclick();
  await explorer.locator('.item', { hasText: FILE }).dblclick();
  const editor = page.locator('.win', { has: page.locator('.editor-text') });
  await page.waitForFunction(() => (document.querySelector('.editor-text')?.value ?? '') !== '', null, { timeout: 15000 });
  eq(await editor.locator('.editor-text').inputValue(), SECRET, 'what the owner reads');
  for (let i = 0; i < 6 && (await page.locator('.win').count()) > 0; i++) await page.locator('.win').last().getByRole('button', { name: 'Close' }).click();
});

await step('even to the signed-in owner, the server hands back only sealed bytes: the words and the name never travel readable', async () => {
  const dump = await storeDump(page);
  ownerKeys = dump.map(d => d.key);
  ok(dump.length >= 3, 'records: ' + dump.length);
  eq(dump.filter(d => d.status !== 200).length, 0, 'every record answered');
  const all = dump.map(d => d.text).join('\n');
  eq(hasWords(all, ['7391', 'blue pot', FILE, 'Documents']), [], 'readable words in what the server sent');
});

await step('the server\'s disk: every record sealed; the words and the file name appear nowhere in the whole data folder', async () => {
  const recs = diskRecords();
  ok(recs.length >= 3, 'records on disk: ' + recs.length);
  eq(recs.filter(r => !r.bytes.subarray(32, 40).equals(MAGIC)).map(r => r.rel), [], 'records not sealed');
  eq(hasWords(wholeDisk(), ['7391', 'blue pot', FILE]), [], 'readable on disk');
});

await step('a stranger (plain requests, not signed in) gets no file, no list of files, and no file bytes', async () => {
  const h = { 'X-Desktop-Store': '1' };
  eq((await raw('/api/store.php?op=keys', h)).status, 401, 'list of files');
  for (const k of ownerKeys) {
    const r = await raw('/api/store.php?key=' + encodeURIComponent(k), h);
    ok(r.status === 401 && r.body.length < 200, `key ${k}: ${r.status}, ${r.body.length} bytes`);
  }
  eq((await raw('/api/store.php?key=' + encodeURIComponent(ownerKeys[0]))).status, 400, 'without the desktop header');
  const forged = await raw('/api/store.php?op=keys', { ...h, Cookie: '__Host-tomlinos=' + 'a'.repeat(43) });
  ok(forged.status === 401, 'a made-up sign-in cookie: ' + forged.status);
});

await step('a stranger\'s own browser: the sign-in screen, and the store refuses', async () => {
  const context = await browser.newContext();
  const p = await context.newPage();
  await p.goto(BASE);
  await p.locator('.gate h1', { hasText: 'Sign in' }).waitFor({ timeout: 20000 });
  const status = await p.evaluate(k => fetch('/api/store.php?key=' + encodeURIComponent(k), { headers: { 'X-Desktop-Store': '1' } }).then(r => r.status), ownerKeys[0]);
  eq(status, 401, 'store from a browser that is not signed in');
  eq(await p.evaluate(() => fetch('/models/models.json').then(r => r.status)), 401, 'model list from a browser that is not signed in');
  await context.close();
});

await step('guessed addresses for the stored files (the real paths on disk, climbing out of the web folder) serve nothing', async () => {
  const recs = diskRecords();
  const user = recs[0].user;
  const guesses = ['/users/', '/data/', '/desktop-data/', '/tomlinos/data/', '/accounts/users.json', `/users/${user}/objects/${recs[0].rel}`,
    `/../${DATA.split(/[\\/]/).pop()}/users/${user}/objects/${recs[0].rel}`, '/..%2f..%2fdesktop-data/accounts/users.json',
    '/api/../server/config.example.php', '/api/store.php/../../users', '/server/lib/store.php', '/.htaccess', '/storage.json/..'];
  for (const g of guesses) {
    const r = await raw(g);
    ok(r.status >= 400 && !r.body.includes('7391'), `${g}: ${r.status}`);
  }
});

let joPage;
await step('a second person on the same desktop sees only their own files: the owner\'s are not listed and cannot be fetched', async () => {
  const made = await page.evaluate(([pw, owner]) => fetch('/api/auth.php?op=user-create', {
    method: 'POST', headers: { 'X-Desktop-Store': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'jo', display: 'Jo', next: pw, password: owner }),
  }).then(r => r.status), [JO_PASS, PASS]);
  eq(made, 200, 'owner adds Jo');
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  joPage = await context.newPage();
  joPage.on('pageerror', e => problems.push('jo pageerror: ' + e.message));
  await joPage.goto(BASE);
  await joPage.locator('.gate h1', { hasText: 'Sign in' }).waitFor({ timeout: 20000 });
  await joPage.getByLabel('User name').fill('jo');
  await joPage.locator('.gate input[type=password]').fill(JO_PASS);
  await joPage.locator('.gate-go').click();
  // A person the owner added gets the owner's set-up choice at their first sign-in, ticked; Jo unticks it (the last
  // step shows what that means on the disk), then gets a recovery key.
  await joPage.locator('.gate h1', { hasText: 'Your files' }).waitFor({ timeout: 30000 });
  ok(await joPage.locator('.gate-encrypt').isChecked(), 'encryption ticked by default for a new person');
  await joPage.locator('.gate-encrypt').uncheck();
  await joPage.getByRole('button', { name: 'Continue' }).click();
  await joPage.locator('.gate h1', { hasText: 'Your recovery key' }).waitFor({ timeout: 30000 });
  await joPage.locator('.gate .check-row input').check();
  await joPage.getByRole('button', { name: 'Continue' }).click();
  await desktopOf(joPage);
  const joDump = await storeDump(joPage);
  eq(hasWords(joDump.map(d => d.text).join('\n'), ['7391', 'blue pot', FILE]), [], 'the owner\'s file in Jo\'s store');
  // Jo asks for each of the owner's records by name: the server looks only in Jo's own store.
  const sameKeys = await joPage.evaluate(async keys => {
    const out = [];
    for (const k of keys) {
      const r = await fetch('/api/store.php?key=' + encodeURIComponent(k), { headers: { 'X-Desktop-Store': '1' } });
      const b = new Uint8Array(await r.arrayBuffer());
      out.push({ status: r.status, text: Array.from(b, c => String.fromCharCode(c)).join('') });
    }
    return out;
  }, ownerKeys);
  const joRecords = new Set(joDump.map(d => d.text));
  eq(sameKeys.filter(r => r.status === 200 && !joRecords.has(r.text)).length, 0, 'records of the owner\'s that Jo received');
  eq(hasWords(sameKeys.map(r => r.text).join('\n'), ['7391', 'blue pot', FILE]), [], 'owner\'s words reaching Jo');
});

await step('saved AI model files: the signed-in page gets them; a stranger, an address typed into a tab, and another site do not', async () => {
  eq(await page.evaluate(f => fetch(f).then(r => r.status), MODEL_FILE), 200, 'the owner\'s desktop page');
  eq(await joPage.evaluate(f => fetch(f).then(r => r.status), MODEL_FILE), 200, 'Jo\'s desktop page (everyone signed in may run the AI)');
  const stranger = await raw(MODEL_FILE);
  ok(stranger.status === 401 && stranger.body.length < 200, `stranger: ${stranger.status}, ${stranger.body.length} bytes`);
  eq((await raw('/models/models.json')).status, 401, 'stranger, model list');
  const typed = await page.context().newPage();
  const res = await typed.goto(BASE + MODEL_FILE);
  eq(res.status(), 403, 'the file\'s address typed into a signed-in browser tab');
  await typed.close();
  const cookie = (await page.context().cookies()).map(c => `${c.name}=${c.value}`).join('; ');
  eq((await raw(MODEL_FILE, { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' })).status, 403, 'another site using the owner\'s cookie');
  for (const g of ['/models/../server/config.example.php', '/models/.htaccess', '/models/Qwen3.5-0.8B-q4f32_1-MLC/../../../server/lib/auth.php'])
    eq((await raw(g, { Cookie: cookie })).status, 404, g);
});

await step('for contrast, encryption OFF (Jo did not choose it): Jo\'s words ARE readable on the server\'s disk, though still refused to strangers', async () => {
  await saveNote(joPage, JO_SECRET, 'jo-note.txt');
  await joPage.waitForTimeout(1500);
  ok(wholeDisk().includes('gate code 5528'), 'an unencrypted file is stored as it is');
  const keys = (await storeDump(joPage)).map(d => d.key);
  for (const k of keys) eq((await raw('/api/store.php?key=' + encodeURIComponent(k), { 'X-Desktop-Store': '1' })).status, 401, 'stranger, Jo\'s ' + k);
});

await step('a person added who keeps the default (encryption ticked) has their note sealed on the disk', async () => {
  const made = await page.evaluate(owner => fetch('/api/auth.php?op=user-create', {
    method: 'POST', headers: { 'X-Desktop-Store': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'kim', display: 'Kim', next: 'meadow-kettle-lantern-27', password: owner }),
  }).then(r => r.status), PASS);
  eq(made, 200, 'owner adds Kim');
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const kim = await context.newPage();
  kim.on('pageerror', e => problems.push('kim pageerror: ' + e.message));
  await kim.goto(BASE);
  await kim.locator('.gate h1', { hasText: 'Sign in' }).waitFor({ timeout: 20000 });
  await kim.getByLabel('User name').fill('kim');
  await kim.locator('.gate input[type=password]').fill('meadow-kettle-lantern-27');
  await kim.locator('.gate-go').click();
  await kim.locator('.gate h1', { hasText: 'Your files' }).waitFor({ timeout: 30000 });
  await kim.getByRole('button', { name: 'Continue' }).click();
  await kim.locator('.gate h1', { hasText: 'Your recovery key' }).waitFor({ timeout: 30000 });
  await kim.locator('.gate .check-row input').check();
  await kim.getByRole('button', { name: 'Continue' }).click();
  await desktopOf(kim);
  await saveNote(kim, 'Kim hides the ferry ticket number 88412', 'kim-note.txt');
  await kim.waitForTimeout(3000);
  eq(hasWords(wholeDisk(), ['88412', 'kim-note.txt']), [], 'Kim\'s words or file name readable on disk');
  await context.close();
});

await step('no page errors in the whole run', async () => {
  eq(problems, [], 'page errors');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) console.log('Failed: ' + failures.join('; '));
await Promise.race([browser.close(), new Promise(r => setTimeout(r, 3000))]);
process.exit(failures.length ? 1 : 0);
