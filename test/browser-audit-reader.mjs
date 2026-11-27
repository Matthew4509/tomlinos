// Reader audit (browser): faults found by trying to break it. Steps marked P0 fail now and pass once fixed; the other
// steps check things that already work. "info" lines are P1 findings (reported, not failed). Books are made in code.
// Needs the dev server on a FRESH, EMPTY data folder (the first step sets up the owner), and out/ built. With the data
// folder given, made-up Gutenberg books are put in its books-cache, so nothing is fetched from Project Gutenberg;
// without it the long-book steps are skipped.
//   node test/browser-audit-reader.mjs [http://127.0.0.1:3129] [data folder] [screenshot folder]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3129';
const DATA = process.argv[3] ?? null;
const SHOTS = process.argv[4] ?? null;
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PASS = 'reader-audit-passphrase-77';
let passed = 0;
const failures = [];
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await context.newPage();
page.on('pageerror', e => console.log('  pageerror: ' + e.message));
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

// Made-up books, kept where the server keeps fetched Gutenberg books, under numbers that are in the library list.
const S = '*** START OF THE PROJECT GUTENBERG EBOOK TEST ***\n\n';
const E = '\n*** END OF THE PROJECT GUTENBERG EBOOK TEST ***\n';
function books() {
  let small = S;
  for (let i = 1; i <= 12; i++) {
    small += `\nCHAPTER ${i}.\n\n`;
    for (let k = 0; k < 60; k++) small += `Chapter ${i} paragraph ${k} ${'lorem ipsum dolor sit amet '.repeat(6)}\n\n`;
  }
  // Two "BOOK" headings, each 12,000 paragraphs (1.4 MB): a long epic or a book whose only headings are its parts.
  let long = S;
  for (const b of ['BOOK I.', 'BOOK II.']) {
    long += `\n${b}\n\n`;
    for (let k = 0; k < 12000; k++) long += `Paragraph ${k} of ${b} ${'the quick brown fox jumps over the lazy dog '.repeat(3)}\n\n`;
  }
  return { 27: small + E, 26: long + E };
}
const cached = (() => {
  if (!DATA) return false;
  const dir = join(DATA, 'books-cache');
  mkdirSync(dir, { recursive: true });
  for (const [id, text] of Object.entries(books())) writeFileSync(join(dir, `pg${id}.txt`), text);
  return true;
})();

const W = () => page.locator('.win', { has: page.locator('.reader-app-frame') }).last();
const F = () => page.frameLocator('.reader-app-frame').last();
const RF = () => page.frames().find(x => x.url().includes('/reader/index.html'));
async function openReader() {
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('reader');
  await page.locator('.start-menu [data-label="reader"]').first().click();
  await W().waitFor();
  await F().locator('.r-tile').first().waitFor({ timeout: 20000 });
}
/** Sends the Reader's own messages to the desktop from inside its frame, as library.js does; answers by rid. */
let rid = 1000;
const ask = msgs => RF().evaluate(async list => Promise.all(list.map(m => new Promise(resolve => {
  const listen = e => {
    if (e.data?.rid === m.rid) {
      removeEventListener('message', listen);
      resolve(e.data);
    }
  };
  addEventListener('message', listen);
  parent.postMessage(m, location.origin);
}))), msgs.map(m => ({ rid: ++rid, ...m })));
const shelfIds = async () => ((await ask([{ type: 'reader-shelf' }]))[0].books ?? []).map(b => b.id).sort((a, b) => a - b);
const book = (id, title, text) => ({ id, title, author: 'Lewis Carroll', years: '', genres: [], text, saved: Date.now() });
/** The address of the next store read the call makes (the hidden index's own record), found by watching. */
async function readAddressOf(fn) {
  const seen = [];
  const l = r => { if (r.method() === 'GET' && r.url().includes('store.php?key=')) seen.push(r.url()); };
  page.on('request', l);
  await fn();
  page.off('request', l);
  return seen.at(-1);
}
async function openPg(id) {
  await page.evaluate(n => { document.querySelector('.reader-app-frame').src = `reader/index.html?author=gutenberg&work=pg-${n}`; }, id);
  await page.waitForTimeout(300);
  await F().locator('.r-count').filter({ hasText: /Page/ }).waitFor({ timeout: 120000 });
}
const frozen = () => page.evaluate(() => Math.round(window.__gap));
const resetFrozen = () => page.evaluate(() => { window.__gap = 0; });

await page.goto(BASE);
await step('set up a fresh desktop and open the Reader', async () => {
  await page.locator('.gate h1', { hasText: 'Set up this desktop' }).waitFor({ timeout: 20000 });
  await page.getByLabel('Your name').fill('Audit Tester');
  await page.locator('.gate input.gate-input').last().fill(PASS);
  await page.locator('.gate-encrypt').uncheck().catch(() => {});
  await page.locator('.gate-go').click();
  await page.locator('.gate h1', { hasText: 'Your recovery key' }).waitFor({ timeout: 30000 });
  await page.locator('.gate .check-row input').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#desktop .item').first().waitFor({ timeout: 20000 });
  await openReader();
  // The longest gap between ticks on the desktop page: how long the desktop (and the Reader in it) stood still.
  await page.evaluate(() => {
    window.__gap = 0;
    let last = performance.now();
    setInterval(() => { const n = performance.now(); window.__gap = Math.max(window.__gap, n - last); last = n; }, 50);
  });
});

await step('Sherlock Holmes opens; arrow keys turn pages; larger text keeps the place in the chapter', async () => {
  const f = F();
  await f.locator('.r-tile', { hasText: 'Sherlock' }).click();
  await f.locator('.r-tile-book').first().click();
  // Picked at once, while the book's text (3.8 MB) may still be loading: it opens there once the text is in.
  await f.locator('.r-chapter', { hasText: 'Chapter II' }).first().click();
  await f.locator('.r-count', { hasText: /^Page 1 of \d+/ }).waitFor({ timeout: 15000 });
  ok((await f.locator('.r-chapter-title').textContent()).includes('Chapter II'), `opened at ${await f.locator('.r-chapter-title').textContent()}`);
  await f.locator('.r-flow').focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  const [a, of] = (await f.locator('.r-count').textContent()).match(/\d+/g).map(Number);
  ok(a === 4, `page ${a} after three presses`);
  await f.getByRole('button', { name: 'Larger text' }).click();
  const [b, of2] = (await f.locator('.r-count').textContent()).match(/\d+/g).map(Number);
  ok(of2 > of && Math.abs(b / of2 - a / of) < 0.1, `page ${a} of ${of} became ${b} of ${of2}`);
  const keys = {};
  for (const k of ['End', 'Home']) {
    const before = await f.locator('.r-count').textContent();
    await page.keyboard.press(k);
    keys[k] = before !== (await f.locator('.r-count').textContent());
  }
  if (!keys.End || !keys.Home) info('RD-P1-5', 'Home and End do nothing in a chapter (no first/last page keys); no key for the next chapter either.');
});

await step('P0 two books saved at once are both in My books, each with its own text', async () => {
  await ask([
    { type: 'reader-save', book: book(11, "Alice's Adventures in Wonderland", 'EDITION ONE') },
    { type: 'reader-save', book: book(19033, "Alice's Adventures in Wonderland", 'EDITION TWO') },
  ]);
  const ids = await shelfIds();
  const [one, two] = await ask([{ type: 'reader-load', id: 11 }, { type: 'reader-load', id: 19033 }]);
  ok(ids.includes(11) && ids.includes(19033), `My books holds ${JSON.stringify(ids)}`);
  ok(one.text === 'EDITION ONE' && two.text === 'EDITION TWO', `texts ${JSON.stringify([one.text, two.text])}`);
});

await step('P0 a failed read of the saved-books index does not wipe My books', async () => {
  for (const id of [1, 2, 3]) await ask([{ type: 'reader-save', book: book(100 + id, `Book ${id}`, `TEXT ${id}`) }]);
  const before = await shelfIds();
  const url = await readAddressOf(() => shelfIds());
  await page.route(u => u.href === url, r => r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"busy"}' }));
  await ask([{ type: 'reader-save', book: book(1342, 'Pride and Prejudice', 'P') }]);
  await page.unrouteAll();
  const after = await shelfIds();
  ok(before.every(id => after.includes(id)), `before ${JSON.stringify(before)}, after ${JSON.stringify(after)}`);
});

await step('P0 a failed read of the reading places does not wipe every other book\'s place', async () => {
  for (const id of ['pg-201', 'pg-202']) await ask([{ type: 'reader-place-set', id, place: { chapter: 3, ratio: 0.5 } }]);
  const url = await readAddressOf(() => ask([{ type: 'reader-place-get', id: 'pg-201' }]));
  await page.route(u => u.href === url, r => r.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  await ask([{ type: 'reader-place-set', id: 'pg-203', place: { chapter: 1, ratio: 0 } }]);
  await page.unrouteAll();
  const [a, b] = await ask([{ type: 'reader-place-get', id: 'pg-201' }, { type: 'reader-place-get', id: 'pg-202' }]);
  ok(a.place && b.place, `places now ${JSON.stringify([a.place, b.place])}`);
});

if (cached) {
  await step('a Gutenberg book reopens where it was left', async () => {
    await openPg(27);
    const f = F();
    await f.locator('.r-chapter', { hasText: 'Chapter 5' }).first().click();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(1500);
    const at = await f.locator('.r-count').textContent();
    let commits = 0;
    const l = r => { if (r.method() === 'POST' && r.url().includes('store.php')) commits++; };
    page.on('request', l);
    for (let i = 0; i < 6; i++) { await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowLeft'); }
    await page.waitForTimeout(2500);
    page.off('request', l);
    if (commits >= 6) info('RD-P1-6', `${commits} saves to the person's files for 12 page turns: every page turn (and every resize step) rewrites /System/reader-places.json.`);
    await openPg(27);
    ok((await f.locator('.r-chapter-title').textContent()).startsWith('Chapter 5') && (await f.locator('.r-count').textContent()) === at, `reopened at ${await f.locator('.r-chapter-title').textContent()}, ${await f.locator('.r-count').textContent()} (left at Chapter 5, ${at})`);
  });

  await step('P0 turning a page in a long chapter (1.4 MB) does not freeze the desktop', async () => {
    await openPg(26);
    await page.waitForTimeout(2000);
    const times = [];
    for (let i = 0; i < 2; i++) {
      await resetFrozen();
      await F().locator('.r-page-btn.is-next').click();
      await page.waitForTimeout(800);
      times.push(await frozen());
    }
    ok(Math.max(...times) < 1000, `the desktop stood still ${JSON.stringify(times)} ms on each page turn`);
  });
} else info('skip', 'long-book steps skipped: no data folder given');

await step('at the smallest window size the page-turn buttons can be reached', async () => {
  await page.evaluate(() => { document.querySelector('.reader-app-frame').src = 'reader/index.html'; });
  const f = F();
  await f.locator('.r-tile', { hasText: 'Sherlock' }).click({ timeout: 60000 });
  await f.locator('.r-tile-book').first().click();
  await f.locator('.r-count').waitFor();
  const e = await W().locator('.edge-se').boundingBox();
  await page.mouse.move(e.x + e.width / 2, e.y + e.height / 2);
  await page.mouse.down();
  await page.mouse.move(60, 60, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(800);
  const m = await RF().evaluate(() => ({ vh: innerHeight, next: document.querySelector('.r-page-btn.is-next').getBoundingClientRect().bottom }));
  if (m.next > m.vh) info('RD-P1-7', `at the Reader's own smallest size (360 x 380) Next page sits at ${Math.round(m.next)} px in a ${m.vh} px frame: off screen, and the frame does not scroll, so mouse and touch users cannot turn pages (keys still work).`);
});

console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? ':\n  ' + failures.join('\n  ') : ''}`);
await browser.close();
process.exit(failures.length ? 1 : 0);
