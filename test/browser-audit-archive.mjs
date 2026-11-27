// Audit of the Archive Opener (November 2026) in a real Chrome: names that clash once cleaned, a file and a folder of
// one name, a deeply nested name, Extract selected, the keyboard, and a narrow window. Each step that FAILS names a
// fault found by the audit; it should pass once the fault is fixed. Needs the dev server on a FRESH, EMPTY data folder
// (the first step sets up the owner) and `npm run build` done. Every zip is made here in code.
//   node test/browser-audit-archive.mjs [http://127.0.0.1:3130] [screenshot folder]
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { tempDir } from './tmp.ts';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3130';
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
    console.log('  FAIL ' + name + '\n       ' + String(error.message).slice(0, 900));
  }
  for (let i = 0; i < 4 && (await page.locator('.dialog').count()); i++) {
    await page.locator('.dialog').last().getByRole('button').last().click({ timeout: 2000 }).catch(() => page.keyboard.press('Escape'));
    await page.waitForTimeout(100);
  }
}
const ok = (v, what) => {
  if (!v) throw new Error(what);
};
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), `${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

/** A zip of [name, text, deflate?, extra flags?] entries; names ending in "/" are folders; flag 1 marks it password-locked. */
function makeZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text, deflate, more = 0] of files) {
    const nameBuf = Buffer.from(name);
    const raw = Buffer.from(text ?? '');
    const data = deflate ? deflateRawSync(raw) : raw;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x800 | more, 6);
    head.writeUInt16LE(deflate ? 8 : 0, 8);
    head.writeUInt32LE(crc32(raw), 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(raw.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    locals.push(head, nameBuf, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x800 | more, 8);
    c.writeUInt16LE(deflate ? 8 : 0, 10);
    c.writeUInt32LE(crc32(raw), 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
page.setDefaultTimeout(10000);
const problems = [];
page.on('pageerror', e => problems.push('pageerror: ' + e.message));
const shot = async name => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });
const ew = () => page.locator('.win', { has: page.locator('.explorer') }).first();
const aw = () => page.locator('.win', { has: page.locator('.archive') }).first();
const exact = name => new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$');
const item = name => ew().locator('.item', { has: page.locator('.item-name', { hasText: exact(name) }) }).first();
const names = async () => (await ew().locator('.item-name').allInnerTexts()).sort();
async function typePath(text) {
  await ew().locator('.explorer-view').focus();
  await page.keyboard.press('Control+l');
  const box = ew().locator('input.address');
  await box.fill(text);
  await box.press('Enter');
  await page.waitForTimeout(400);
}
async function closeArchives() {
  while (await page.locator('.win', { has: page.locator('.archive') }).count()) {
    await aw().getByRole('button', { name: 'Close' }).click();
    await page.waitForTimeout(100);
  }
}
/** Opens /Documents/<zip> in the Archive Opener. */
async function openZip(zip) {
  await closeArchives();
  await typePath('/Documents');
  await item(zip).dblclick();
  await aw().locator('.archive-list').waitFor();
  await page.waitForTimeout(300);
}
/**
 * Extract all (or selected): the folder window asks where ("Extract to", opened on the archive's folder, Documents
 * here); Extract here makes a new folder named after the archive there. Waits for the status line or a dialog.
 * Returns the status line (with any dialog's words) and the new folder's path, read from "into “name”" (the
 * archive's stem when the line does not say).
 */
async function extractAll(stem, button = /Extract all/) {
  await aw().getByRole('button', { name: button }).click();
  const dialog = page.locator('.dialog', { has: page.locator('.dialog-title', { hasText: 'Extract to' }) });
  await dialog.waitFor();
  await dialog.locator('.pick-crumbs [aria-current="location"]', { hasText: 'Documents' }).waitFor();
  await dialog.getByRole('button', { name: 'Extract here' }).click();
  await page.waitForFunction(() => /Extracted|Stopped/.test(document.querySelector('.archive')?.closest('.win')?.querySelector('.statusbar')?.textContent ?? ''), null, { timeout: 60000 });
  await page.waitForTimeout(500);
  let said = '';
  // A failed extract shows a dialog: keep its words for the step's message, then close it.
  for (let i = 0; i < 3 && (await page.locator('.dialog').count()); i++) {
    said += ' Dialog: ' + (await page.locator('.dialog').last().innerText()).replace(/\s+/g, ' ');
    await page.locator('.dialog').last().getByRole('button').last().click().catch(() => page.keyboard.press('Escape'));
    await page.waitForTimeout(200);
  }
  const status = (await aw().locator('.statusbar').innerText()) + said;
  const into = /into “([^”]+)”/.exec(status);
  return { status, folder: '/Documents/' + (into ? into[1] : stem) };
}

const dir = tempDir('tomlinos-audit-archive-');
const deep = Array.from({ length: 300 }, () => 'd').join('/') + '/end.txt';
const zips = {
  'dups.zip': makeZip([['a.txt', 'one'], ['A.TXT', 'two'], ['q?.txt', 'three'], ['q_.txt', 'four'], ['caf\u00e9.txt', 'nfc'], ['cafe\u0301.txt', 'nfd']]),
  'clash.zip': makeZip([['x', 'a file called x'], ['x/inner.txt', 'inside a folder called x'], ['after.txt', 'last']]),
  'deep.zip': makeZip([[deep, 'bottom']]),
  'locked.zip': makeZip([['first.txt', '1'], ['secret.txt', 'zzz', false, 1], ['last.txt', '3']]),
  'nest.zip': makeZip([['docs/', ''], ['docs/keep.txt', 'keep', true], ['docs/skip.txt', 'skip'], ['top.txt', 'top']]),
};
for (const [name, bytes] of Object.entries(zips)) writeFileSync(join(dir, name), bytes);

console.log('Archive Opener audit, against ' + BASE);
await page.goto(BASE);

await step('set up the owner, open File Explorer and upload the zips into Documents', async () => {
  await page.locator('.gate h1').first().waitFor({ timeout: 30000 });
  await page.getByLabel('Your name').fill('Sample Owner');
  const user = page.getByLabel('User name (for signing in)');
  if (await user.count()) await user.fill('tester');
  await page.locator('.gate input[type=password]').last().fill(PASS);
  const encrypt = page.locator('.gate-encrypt');
  if (await encrypt.count()) await encrypt.uncheck();
  await page.locator('.gate-go').click();
  await page.locator('.gate h1', { hasText: 'Your recovery key' }).waitFor({ timeout: 30000 });
  await page.locator('.gate .check-row input').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#desktop .item').first().waitFor({ timeout: 20000 });
  await page.keyboard.press('Control+Alt+e');
  await item('Documents').waitFor({ timeout: 15000 });
  await item('Documents').dblclick();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), ew().getByRole('button', { name: 'Upload' }).click()]);
  await chooser.setFiles(Object.keys(zips).map(n => join(dir, n)));
  for (const n of Object.keys(zips)) await item(n).waitFor({ timeout: 15000 });
});

await step('AR-P0-1: six entries whose names clash once cleaned (case, "?", NFC/NFD) all come out; none is written over', async () => {
  await openZip('dups.zip');
  const { status, folder } = await extractAll('dups');
  await closeArchives();
  await typePath(folder);
  const got = await names();
  ok(got.length === 6, `${status} The folder holds ${got.length} files: ${JSON.stringify(got)}. Each later entry silently replaced the one before it.`);
});

await step('AR-P1-1: a file "x" and a folder "x/" in one zip: Extract all still extracts the rest ("after.txt")', async () => {
  await openZip('clash.zip');
  const { status, folder } = await extractAll('clash');
  await closeArchives();
  await typePath(folder);
  const got = await names();
  ok(got.includes('after.txt'), `${status} Got ${JSON.stringify(got)}: the extract stopped at the clash.`);
  eq(got, ['after.txt', 'x', 'x (2)'], 'the file, the renamed folder and the last file');
  ok(/came out as “x \(2\)”/.test(status), `the end message names the rename: ${status}`);
  await typePath(folder + '/x (2)');
  eq(await names(), ['inner.txt'], 'the folder "x" came out as "x (2)" with its file in it');
});

await step('Extract selected: one ticked file inside "docs" comes out alone (docs/keep.txt)', async () => {
  await openZip('nest.zip');
  await aw().locator('.archive-row', { hasText: 'docs' }).dblclick();
  await aw().locator('.archive-row', { hasText: 'keep.txt' }).locator('input').check();
  const { status, folder } = await extractAll('nest', /Extract selected/);
  ok(/Extracted 1 file\b/.test(status), status);
  await closeArchives();
  await typePath(folder + '/docs');
  const got = await names();
  ok(JSON.stringify(got) === '["keep.txt"]', JSON.stringify(got));
});

await step('AR-P1-2: keyboard: Enter on a folder row (focused by Tab) opens it', async () => {
  await openZip('nest.zip');
  await aw().locator('.archive-row', { hasText: 'docs' }).locator('input').focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  const where = await aw().locator('.archive-where').innerText();
  ok(where === '/docs', `still at "${where}": a folder opens only by double-click, so the keyboard cannot reach a file inside one`);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(300);
  eq(await aw().locator('.archive-where').innerText(), '/', 'Backspace goes up a folder');
});

await step('AR-P1-3: keyboard: arrow keys move through the list rows', async () => {
  await openZip('nest.zip');
  await aw().locator('.archive-list').focus();
  await page.keyboard.press('ArrowDown');
  const focused = await page.evaluate(() => document.activeElement?.closest('.archive-row')?.textContent ?? document.activeElement?.className ?? '');
  ok(/docs/.test(focused), `ArrowDown in the list leaves focus on "${focused}"`);
  const on = () => page.evaluate(() => document.activeElement?.closest('.archive-row')?.querySelector('.archive-name')?.textContent ?? '');
  await page.keyboard.press('ArrowDown');
  eq(await on(), 'top.txt', 'a second ArrowDown');
  await page.keyboard.press('ArrowDown');
  eq(await on(), 'top.txt', 'ArrowDown on the last row stays there');
  await page.keyboard.press('Home');
  eq(await on(), 'docs', 'Home');
  await page.keyboard.press('End');
  eq(await on(), 'top.txt', 'End');
  await page.keyboard.press('ArrowUp');
  eq(await on(), 'docs', 'ArrowUp');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  eq(await aw().locator('.archive-where').innerText(), '/docs', 'Enter on the focused folder row');
  eq(await on(), 'keep.txt', 'the first row inside has the focus');
});

await step('AR-P1-4: double-clicking a file inside the archive opens (or previews) it', async () => {
  // clash.zip, so that nest.zip's folders stay as the steps below expect ("clash" is taken by AR-P1-1).
  await openZip('clash.zip');
  const before = await page.locator('.win').count();
  await aw().locator('.archive-row', { hasText: 'after.txt' }).dblclick();
  await page.waitForTimeout(1500);
  ok((await page.locator('.win').count()) > before, 'nothing happens: a file cannot be looked at without extracting the whole archive first');
  const status = await aw().locator('.statusbar').innerText();
  ok(status.includes('/Documents/clash (2)'), `the status line says where the copy went: ${status}`);
  // Enter on the same file opens the copy already made, not a second one.
  await aw().locator('.archive-row', { hasText: 'after.txt' }).locator('input').focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1000);
  const opened = page.locator('.win:not(:has(.explorer)):not(:has(.archive))');
  for (let i = 0; i < 5 && (await opened.count()); i++) {
    await opened.first().getByRole('button', { name: 'Close' }).click();
    await page.waitForTimeout(200);
  }
  await closeArchives();
  await typePath('/Documents/clash (2)');
  eq(await names(), ['after.txt'], 'the copy, once');
  await typePath('/Documents');
  ok(!(await names()).includes('clash (3)'), 'a second open made no second folder');
});

await step('narrow window (380 px viewport): the three toolbar buttons are all on screen', async () => {
  await page.setViewportSize({ width: 380, height: 640 });
  await page.waitForTimeout(500);
  const boxes = await aw().locator('.toolbar button').evaluateAll(els => els.map(e => {
    const r = e.getBoundingClientRect();
    return { t: e.textContent, l: Math.round(r.left), r: Math.round(r.right), w: innerWidth };
  }));
  await shot('narrow');
  await page.setViewportSize({ width: 1280, height: 800 });
  ok(boxes.every(b => b.l >= 0 && b.r <= b.w), JSON.stringify(boxes));
});

await step('AR-P1-5: a password-locked file in the middle: Extract all still extracts the files after it ("last.txt")', async () => {
  await openZip('locked.zip');
  const { status, folder } = await extractAll('locked');
  await closeArchives();
  await typePath(folder);
  const got = await names();
  ok(got.includes('last.txt'), `${status} Got ${JSON.stringify(got)}: one locked file stops the whole extract, and the list never marks it as locked.`);
  eq(got, ['first.txt', 'last.txt'], 'the two unlocked files');
  ok(/“secret\.txt” is locked with a password/.test(status), `the end message names the locked file: ${status}`);
});

// AR-P1-6 was about a typed folder name ("sub/inner"); the name prompt is gone, the folder is named after the archive.
// What is left to check: extracting the same archive again makes a second folder and never writes into the first.
await step('AR-P1-6: Extract all of the same archive again goes into a new folder ("nest (2)"); the first is left as it was', async () => {
  await openZip('nest.zip');
  const { status, folder } = await extractAll('nest');
  eq(folder, '/Documents/nest (2)', `the second extract's folder (${status})`);
  await closeArchives();
  await typePath('/Documents/nest');
  eq(await names(), ['docs'], 'the first folder holds only what Extract selected put there');
  await typePath('/Documents/nest (2)');
  eq(await names(), ['docs', 'top.txt'], 'the new folder holds the whole archive');
});

await step('AR-P0-2: one 300-level deep name extracts within 20 seconds (no near-hang)', async () => {
  await openZip('deep.zip');
  const t0 = Date.now();
  const status = await extractAll('deep').then(r => r.status, e => 'did not finish: ' + e.message.split('\n')[0]);
  const secs = (Date.now() - t0) / 1000;
  // Finishing quickly is the point: extracted, or left out with a note saying so (uploads also cap the depth).
  ok(secs < 20 && (/Extracted 1 file/.test(status) || /left out/.test(status)), `took ${secs.toFixed(1)} s, status: ${status}`);
});

await closeArchives().catch(() => {});
await browser.close();
if (problems.length) console.log('page errors:\n  ' + problems.slice(0, 10).join('\n  '));
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
