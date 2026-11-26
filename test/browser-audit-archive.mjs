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
/** Extract all into a folder of the given name; waits for the toast or a dialog. Returns the status line. */
async function extractAll(folder) {
  await aw().getByRole('button', { name: /Extract all/ }).click();
  const dialog = page.locator('.dialog');
  await dialog.locator('input').fill(folder);
  await dialog.getByRole('button', { name: 'Extract' }).click();
  await page.waitForFunction(() => /Extracted|Stopped/.test(document.querySelector('.archive')?.closest('.win')?.querySelector('.statusbar')?.textContent ?? ''), null, { timeout: 60000 });
  await page.waitForTimeout(500);
  let said = '';
  // A failed extract shows a dialog: keep its words for the step's message, then close it.
  for (let i = 0; i < 3 && (await page.locator('.dialog').count()); i++) {
    said += ' Dialog: ' + (await page.locator('.dialog').last().innerText()).replace(/\s+/g, ' ');
    await page.locator('.dialog').last().getByRole('button').last().click().catch(() => page.keyboard.press('Escape'));
    await page.waitForTimeout(200);
  }
  return (await aw().locator('.statusbar').innerText()) + said;
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
  const status = await extractAll('dups-out');
  await closeArchives();
  await typePath('/Documents/dups-out');
  const got = await names();
  ok(got.length === 6, `${status} The folder holds ${got.length} files: ${JSON.stringify(got)}. Each later entry silently replaced the one before it.`);
});

await step('AR-P1-1: a file "x" and a folder "x/" in one zip: Extract all still extracts the rest ("after.txt")', async () => {
  await openZip('clash.zip');
  const status = await extractAll('clash-out');
  await closeArchives();
  await typePath('/Documents/clash-out');
  const got = await names();
  ok(got.includes('after.txt'), `${status} Got ${JSON.stringify(got)}: the extract stopped at the clash.`);
});

await step('Extract selected: one ticked file inside "docs" comes out alone (docs/keep.txt)', async () => {
  await openZip('nest.zip');
  await aw().locator('.archive-row', { hasText: 'docs' }).dblclick();
  await aw().locator('.archive-row', { hasText: 'keep.txt' }).locator('input').check();
  await aw().getByRole('button', { name: /Extract selected/ }).click();
  const dialog = page.locator('.dialog');
  await dialog.locator('input').fill('pick-out');
  await dialog.getByRole('button', { name: 'Extract' }).click();
  await page.locator('.toast', { hasText: 'Extracted 1 file' }).waitFor({ timeout: 10000 });
  await closeArchives();
  await typePath('/Documents/pick-out/docs');
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
});

await step('AR-P1-3: keyboard: arrow keys move through the list rows', async () => {
  await openZip('nest.zip');
  await aw().locator('.archive-list').focus();
  await page.keyboard.press('ArrowDown');
  const focused = await page.evaluate(() => document.activeElement?.closest('.archive-row')?.textContent ?? document.activeElement?.className ?? '');
  ok(/docs/.test(focused), `ArrowDown in the list leaves focus on "${focused}"`);
});

await step('AR-P1-4: double-clicking a file inside the archive opens (or previews) it', async () => {
  await openZip('nest.zip');
  const before = await page.locator('.win').count();
  await aw().locator('.archive-row', { hasText: 'top.txt' }).dblclick();
  await page.waitForTimeout(1500);
  ok((await page.locator('.win').count()) > before, 'nothing happens: a file cannot be looked at without extracting the whole archive first');
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
  const status = await extractAll('locked-out');
  await closeArchives();
  await typePath('/Documents/locked-out');
  const got = await names();
  ok(got.includes('last.txt'), `${status} Got ${JSON.stringify(got)}: one locked file stops the whole extract, and the list never marks it as locked.`);
});

await step('AR-P1-6: typing "sub/inner" as the new folder name is refused in the dialog, with a reason', async () => {
  await openZip('nest.zip');
  await aw().getByRole('button', { name: /Extract all/ }).click();
  const dialog = page.locator('.dialog');
  await dialog.locator('input').fill('sub/inner');
  await dialog.getByRole('button', { name: 'Extract' }).click();
  await page.waitForTimeout(1500);
  const texts = (await page.locator('.dialog').allInnerTexts()).join(' | ').replace(/\s+/g, ' ');
  const status = await aw().locator('.statusbar').innerText();
  ok(/cannot contain/.test(texts), `dialogs now: "${texts}"; status: "${status}"`);
});

await step('AR-P0-2: one 300-level deep name extracts within 20 seconds (no near-hang)', async () => {
  await openZip('deep.zip');
  const t0 = Date.now();
  const status = await extractAll('deep-out').catch(e => 'did not finish: ' + e.message.split('\n')[0]);
  const secs = (Date.now() - t0) / 1000;
  // Finishing quickly is the point: extracted, or left out with a note saying so (uploads also cap the depth).
  ok(secs < 20 && (/Extracted 1 file/.test(status) || /left out/.test(status)), `took ${secs.toFixed(1)} s, status: ${status}`);
});

await closeArchives().catch(() => {});
await browser.close();
if (problems.length) console.log('page errors:\n  ' + problems.slice(0, 10).join('\n  '));
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
