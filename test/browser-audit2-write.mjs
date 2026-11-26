// Round-2 audit of Write in a real Chrome: the rules a person relies on (saved means on disk, a lossy kind always warns,
// a file changed elsewhere asks, unsaved work asks on close and comes back after a crash, Save PDF as never clobbers,
// letters one per row, find and replace right on unicode, undo never corrupts, both looks at phone width, crafted files
// never hang or run script). A P0 step fails now and passes once fixed; a P1 step prints an "info" line.
// Needs the dev server on a FRESH, EMPTY data folder (the first step sets up the owner), and the build done.
//   node test/browser-audit2-write.mjs [http://127.0.0.1:3521] [screenshot folder]
import { chromium } from 'playwright-core';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipDeflate } from '../src/core/zip.ts';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3521';
const SHOTS = process.argv[3] ?? null;
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PASS = 'audit-two-write-passphrase-73';
let passed = 0;
const failures = [];
const infos = [];
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true, locale: 'en-GB' });
let page = await context.newPage();
page.setDefaultTimeout(10000);
const problems = [];
const watch = p => {
  p.on('console', m => m.type() === 'error' && problems.push('console: ' + m.text()));
  p.on('pageerror', e => problems.push('pageerror: ' + e.message));
  p.on('dialog', d => d.accept().catch(() => {}));
};
watch(page);
const dir = mkdtempSync(join(tmpdir(), 'tomlinos-audit2-write-'));
const shot = async name => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });
async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (error) {
    failures.push(name);
    console.log('  FAIL ' + name + '\n       ' + String(error.message).split('\n')[0].slice(0, 600));
    await Promise.race([(async () => {
      await shot('fail-' + failures.length).catch(() => {});
      for (let i = 0; i < 3 && (await page.locator('.dialog').count().catch(() => 0)); i++) await page.keyboard.press('Escape').catch(() => {});
    })(), new Promise(r => setTimeout(r, 8000))]);
  }
}
const info = (id, text) => {
  infos.push(id);
  console.log(`  info ${id}: ${text}`);
};
const eq = (a, b, what) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const ok = (v, what) => {
  if (!v) throw new Error(what);
};
const enc = new TextEncoder();
const openApp = async label => {
  if (!(await page.locator('.start-filter').isVisible())) await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill(label);
  await page.locator(`.start-menu [data-label="${label}"]`).first().click();
};
const W = () => page.locator('.win', { has: page.locator('.write') }).last();
const D = () => page.locator('.dialog').last();
const doc = () => W().locator('.wp-doc');
const tab = name => W().locator('.ribbon-tab', { hasText: name }).click();
const rb = name => W().locator('.ribbon .rb').filter({ hasText: new RegExp(`^${name}$`) });
const toast = text => page.locator('.toast', { hasText: text }).last().waitFor({ timeout: 15000 });
const appears = (loc, ms = 3000) => loc.waitFor({ timeout: ms }).then(() => true, () => false);
const clearToasts = () => page.locator('.toast').evaluateAll(ts => ts.forEach(t => t.remove())).catch(() => {});
async function closeAllWrite() {
  await clearToasts();
  for (let i = 0; i < 12; i++) {
    const wins = page.locator('.win', { has: page.locator('.write') });
    if (!(await wins.count())) return;
    for (let k = 0; k < 4 && (await page.locator('.dialog').count()); k++) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    }
    await wins.last().getByRole('button', { name: 'Close', exact: true }).first().click();
    const discard = page.locator('.dialog').getByRole('button', { name: 'Close without saving' });
    if (await discard.waitFor({ timeout: 1500 }).then(() => true, () => false)) await discard.click();
    await page.waitForTimeout(250);
  }
}
/** A clean desktop: the page loaded again (every window gone), a recovery offer from that answered with Delete. */
async function reset() {
  await page.reload();
  await page.locator('.start-btn').waitFor({ timeout: 20000 });
}
async function startWrite() {
  await openApp('write');
  const offer = page.locator('.dialog', { hasText: 'not saved' });
  await doc().waitFor();
  if (await appears(offer, 1500)) {
    await offer.getByRole('button', { name: /^Delete/ }).click();
    await page.waitForTimeout(300);
  }
}
const newDoc = async () => {
  await reset();
  await startWrite();
  await W().locator('.wp-furniture').waitFor({ state: 'attached' });
  await doc().click();
};
const settle = () => page.waitForTimeout(400);
async function saveAs(name) {
  await doc().focus();
  await page.keyboard.press('Control+Shift+S');
  await D().locator('input[aria-label="File name"]').fill(name);
  await D().getByRole('button', { name: 'Save' }).click();
}
async function fileMenu(item) {
  await W().getByRole('button', { name: 'File' }).click();
  await page.locator('.menu').getByText(item, { exact: true }).click();
}
async function reopen(name) {
  await fileMenu('Open...');
  await D().locator('.pick-row', { hasText: name }).first().dblclick();
  await page.waitForFunction(n => [...document.querySelectorAll('.win')].some(w => w.querySelector('.write .wp-doc') && w.textContent.includes(n)), name);
}
/** A file from this computer, through Write's own File > Open a Word file from your computer (copied into Documents). */
async function bring(path) {
  await startWrite();
  await doc().waitFor();
  const chooser = page.waitForEvent('filechooser');
  await fileMenu('Open a Word file from your computer...');
  (await chooser).setFiles(path);
}
const sheetOf = async (body, extra = []) => zipDeflate([
  { name: '[Content_Types].xml', data: enc.encode('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'), modified: 0 },
  { name: '_rels/.rels', data: enc.encode('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'), modified: 0 },
  { name: 'word/document.xml', data: enc.encode(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><w:body>${body}</w:body></w:document>`), modified: 0 },
  ...extra,
]);
/** The text of every Write window's document. */
const allText = () => page.evaluate(() => [...document.querySelectorAll('.wp-doc')].map(d => d.textContent).join('\n'));

await page.goto(BASE);
await step('set up a fresh desktop', async () => {
  await page.locator('.gate h1', { hasText: 'Set up this desktop' }).waitFor({ timeout: 20000 });
  await page.getByLabel('Your name').fill('Audit Tester');
  await page.locator('.gate input.gate-input').last().fill(PASS);
  await page.locator('.gate-encrypt').uncheck();
  await page.locator('.gate-go').click();
  await page.locator('.gate h1', { hasText: 'Your recovery key' }).waitFor({ timeout: 30000 });
  await page.locator('.gate .check-row input').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#desktop .item').first().waitFor({ timeout: 20000 });
});

await step('Classic look by keyboard: Alt+F opens File, arrows move, Escape closes only the menu', async () => {
  await openApp('write');
  await W().locator('.cbar-title[data-menu="File"]').waitFor({ timeout: 20000 });
  await doc().click();
  await page.keyboard.press('Alt+F');
  await page.locator('.menu').first().waitFor();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  ok(!(await page.locator('.menu').count()) || !(await page.locator('.menu').first().isVisible()), 'menu closed');
  ok(await W().isVisible(), 'the window is still open');
  // Then the ribbon for the rest of the steps.
  await W().locator('.cbar-title[data-menu="View"]').click();
  await page.locator('.menu-item', { hasText: 'Modern (ribbon)' }).click();
  await W().locator('.ribbon').waitFor();
  await reset();
});

await step('rule 5a: unsaved changes ask on close; Keep it open keeps the words', async () => {
  await newDoc();
  await page.keyboard.type('unsaved words');
  await W().getByRole('button', { name: 'Close', exact: true }).first().click();
  await D().getByRole('button', { name: 'Close without saving' }).waitFor();
  await page.keyboard.press('Escape');
  await settle();
  ok((await doc().innerText()).includes('unsaved words'), 'still there');
  await reset();
});

await step('WR-8: a header (words on every page) is not left out of a .txt save without the warning', async () => {
  await newDoc();
  await page.keyboard.type('Body words only');
  await tab('Layout');
  await rb('Header & footer...').click();
  await D().locator('input[aria-label="Header, left"]').fill('Secret header words');
  await D().getByRole('button', { name: 'OK' }).click();
  await saveAs('hdr-only.txt');
  const warned = await appears(D().getByText('Save as plain text?'), 4000);
  if (warned) await page.keyboard.press('Escape');
  ok(warned, 'saved as plain text with no warning: the header words are gone from the file');
  await reset();
});

await step('WR-8b: a .txt file with a header added: Save (over it) warns before the header is dropped', async () => {
  writeFileSync(join(dir, 'plain-notes.txt'), 'line one\r\nline two\r\n');
  await reset();
  await bring(join(dir, 'plain-notes.txt'));
  await page.waitForFunction(() => [...document.querySelectorAll('.win')].some(w => w.textContent.includes('plain-notes.txt') && w.querySelector('.wp-doc')));
  await doc().click();
  await tab('Layout');
  await rb('Header & footer...').click();
  await D().locator('input[aria-label="Footer, centre"]').fill('Footer words');
  await D().getByRole('button', { name: 'OK' }).click();
  await doc().focus();
  await page.keyboard.press('Control+S');
  const warned = await appears(D().getByText('Save as plain text?'), 4000);
  if (warned) await page.keyboard.press('Escape');
  ok(warned, 'saved over the .txt with no warning: the footer words are gone');
  await reset();
});

await step('rule 2: bold text to .txt warns, and Cancel writes nothing', async () => {
  await newDoc();
  await page.keyboard.press('Control+B');
  await page.keyboard.type('Bold words');
  await saveAs('keep-me.docx');
  await toast('Saved “keep-me.docx”');
  await saveAs('keep-me.txt');
  await D().getByText('Save as plain text?').waitFor();
  await D().getByRole('button', { name: 'Cancel' }).click();
  await settle();
  await reset();
  await newDoc();
  await fileMenu('Open...');
  const rows = await D().locator('.pick-row').allInnerTexts();
  await page.keyboard.press('Escape');
  ok(!rows.some(r => r.includes('keep-me.txt')), 'no .txt was written: ' + rows.join(' | '));
});

await step('rule 4a: the same file open in two windows: the second save asks before replacing the first', async () => {
  await reset();
  await newDoc();
  await reopen('keep-me.docx');
  const wins = page.locator('.win', { has: page.locator('.write .wp-doc') });
  // A second window on the same file (File > Open again).
  await fileMenu('Open...');
  await D().locator('.pick-row', { hasText: 'keep-me.docx' }).first().dblclick();
  await settle();
  const n = await wins.count();
  if (n < 3) {
    info('rule 4a', `opening the same file again gives ${n - 1} window(s) on it (focus moves to the open one), so only a second tab can race it`);
    return;
  }
  const a = wins.nth(n - 2);
  const b = wins.nth(n - 1);
  await a.locator('.wp-doc').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' from A');
  await page.keyboard.press('Control+S');
  await toast('Saved “keep-me.docx”');
  await b.locator('.wp-doc').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' from B');
  await page.keyboard.press('Control+S');
  await D().getByText('Changed somewhere else').waitFor();
  await D().getByRole('button', { name: 'Do not save' }).click();
});

await step('rule 4: a second tab saves the file; the first tab asks before replacing it', async () => {
  await reset();
  await newDoc();
  await reopen('keep-me.docx');
  const other = await context.newPage();
  watch(other);
  await other.goto(BASE);
  await other.locator('.start-btn').waitFor({ timeout: 20000 });
  await other.locator('.start-btn').click();
  await other.locator('.start-filter').fill('write');
  await other.locator('.start-menu [data-label="write"]').first().click();
  const ow = other.locator('.win', { has: other.locator('.write') }).last();
  await ow.locator('.wp-doc').waitFor();
  await ow.getByRole('button', { name: 'File' }).click();
  await other.locator('.menu').getByText('Open...', { exact: true }).click();
  await other.locator('.dialog .pick-row', { hasText: 'keep-me.docx' }).first().dblclick();
  await other.waitForFunction(() => [...document.querySelectorAll('.win')].some(w => w.textContent.includes('keep-me.docx') && w.querySelector('.wp-doc')));
  const ow2 = other.locator('.win', { hasText: 'keep-me.docx' }).last();
  await ow2.locator('.wp-doc').click();
  await other.keyboard.press('Control+End');
  await other.keyboard.type(' second tab');
  await other.keyboard.press('Control+S');
  await other.locator('.toast', { hasText: 'Saved' }).last().waitFor({ timeout: 15000 });
  await other.close();
  await doc().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' first tab');
  await page.keyboard.press('Control+S');
  await D().getByText('Changed somewhere else').waitFor();
  await D().getByRole('button', { name: 'Do not save' }).click();
  await reset();
});

await step('rule 5: unsaved work comes back after the page stops (a copy kept when the page goes to the background)', async () => {
  await newDoc();
  await page.keyboard.type('Words that must come back after a crash');
  await settle();
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(2500);
  await page.close({ runBeforeUnload: false });
  page = await context.newPage();
  page.setDefaultTimeout(10000);
  watch(page);
  await page.goto(BASE);
  await page.locator('.start-btn').waitFor({ timeout: 20000 });
  await openApp('write');
  await D().getByText('Documents not saved').waitFor({ timeout: 15000 });
  await D().getByRole('button', { name: 'Open it' }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.wp-doc')].some(d => d.textContent.includes('come back after a crash')), null, { timeout: 15000 });
  await reset();
});

await step('rule 6: Save PDF as has every page, and a second save under the same name asks first', async () => {
  await newDoc();
  for (let i = 1; i <= 3; i++) {
    await page.keyboard.type(`Page ${i} words`);
    if (i < 3) await page.keyboard.press('Control+Enter');
  }
  await settle();
  const count = await W().locator('.wp-gap').count();
  eq(count + 1, 3, 'three pages on screen');
  await fileMenu('Save PDF as...');
  await D().locator('input[aria-label="File name"]').fill('three.pdf');
  await D().getByRole('button', { name: 'Save' }).click();
  await toast('Saved “three.pdf”');
  await fileMenu('Save PDF as...');
  await D().locator('input[aria-label="File name"]').fill('three.pdf');
  await D().getByRole('button', { name: 'Save' }).click();
  await D().getByText('Replace it?').waitFor();
  await D().getByRole('button', { name: 'Choose another name' }).click();
  await page.locator('.dialog', { hasText: 'Save PDF as' }).waitFor();
  await page.waitForTimeout(300);
  await D().getByRole('button', { name: 'Cancel' }).click();
  await page.waitForFunction(() => !document.querySelector('.dialog'));
  // The same pages through Print and PDF > Download PDF: every page and every word.
  await doc().focus();
  await page.keyboard.press('Control+P');
  await D().locator('.pp-count').waitFor();
  const dl = page.waitForEvent('download');
  dl.catch(() => {});
  await clearToasts();
  await D().getByRole('button', { name: 'Download PDF' }).click();
  const file = join(dir, 'three.pdf');
  await (await dl).saveAs(file);
  const pdf = readFileSync(file, 'latin1');
  eq((pdf.match(/\/Type \/Page /g) ?? []).length, 3, 'pages in the PDF');
  await reset();
});

await step('rule 7: letters from a list: one per row, unicode, empty fields and a two-line address', async () => {
  writeFileSync(join(dir, 'people.csv'), 'Name,City,Note\n"Zoë Ångström",Kraków,\n"Li, Wei",北京,"Line one\nLine two"\n,,\nÉmile,,only note\n');
  await reset();
  await bring(join(dir, 'people.csv'));
  await settle();
  await reset();
  await newDoc();
  await page.keyboard.type('Dear ');
  await tab('Mailings');
  await rb('From a spreadsheet...').click();
  await D().locator('.pick-row', { hasText: 'people' }).first().dblclick();
  await W().locator('.wp-tip', { hasText: '3 rows' }).waitFor();
  await doc().focus();
  await page.keyboard.press('Control+End');
  for (const f of ['Name', 'City', 'Note']) {
    await W().getByRole('button', { name: 'Insert a field: filled in from each row' }).click();
    await page.locator('.menu').getByText(f, { exact: true }).click();
    await page.keyboard.type(' | ');
  }
  await rb('Letters as a document').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.win')].some(w => w.textContent.includes('letters.docx') && w.querySelector('.wp-doc')));
  const letters = page.locator('.win', { hasText: 'letters.docx' }).last();
  await letters.locator('.wp-break').first().waitFor();
  const text = await letters.locator('.wp-doc').innerText();
  eq(await letters.locator('.wp-break').count(), 2, 'a page break between each of 3 letters');
  ok(text.includes('Dear Zoë Ångström | Kraków |  |'), 'letter 1: ' + text);
  ok(text.includes('Dear Li, Wei | 北京 | Line one\nLine two'), 'letter 2 (comma in a name, CJK, two lines): ' + text);
  ok(text.includes('Dear Émile |  | only note'), 'letter 3: ' + text);
  await reset();
});

await step('WR-18: letters from a CSV keep each value as written (postcode 02134, amount 1,234.50, date 2025-12-31)', async () => {
  writeFileSync(join(dir, 'values.csv'), 'Name,Postcode,Amount,Due\nAnn,02134,"1,234.50",2025-12-31\n');
  await reset();
  await bring(join(dir, 'values.csv'));
  await settle();
  await newDoc();
  await tab('Mailings');
  await rb('From a spreadsheet...').click();
  await D().locator('.pick-row', { hasText: 'values' }).first().dblclick();
  await W().locator('.wp-tip', { hasText: '1 row' }).waitFor();
  await doc().focus();
  for (const f of ['Postcode', 'Amount', 'Due']) {
    await W().getByRole('button', { name: 'Insert a field: filled in from each row' }).click();
    await page.locator('.menu').getByText(f, { exact: true }).click();
    await page.keyboard.type(' ; ');
  }
  await rb('Preview').click();
  await settle();
  const shown = await doc().innerText();
  await reset();
  eq(shown.trim(), '02134 ; 1,234.50 ; 2025-12-31 ;', 'the letter as previewed');
});

await step('W-P1-9 (round 1): Save as "notes.rtf" asks and offers notes.docx, never a silent notes.rtf.docx', async () => {
  await newDoc();
  await page.keyboard.type('rtf name');
  await saveAs('notes.rtf');
  const asked = await appears(D().getByText('Save as a Word document?'), 3000);
  if (!asked) {
    const said = await page.locator('.toast', { hasText: 'Saved' }).last().innerText().catch(() => '?');
    info('W-P1-9', `no question; the toast said: ${said} (the Save window adds .docx to an ending it does not list, so Write never sees .rtf)`);
  }
  await reset();
});

await step('rule 8: find on unicode (emoji neighbours, ß, Turkish İ) and Replace all, then one Undo puts it all back', async () => {
  await newDoc();
  await page.keyboard.insertText('a😀a😀a straße STRASSE İstanbul café');
  // A pause, as a person makes: typing and the replace are separate steps to undo.
  await page.waitForTimeout(800);
  const before = await doc().innerText();
  await page.keyboard.press('Control+H');
  await W().locator('input[aria-label="Find"]').fill('a');
  await settle();
  const count = await W().locator('.wp-find-count').innerText();
  ok(/of 7$/.test(count), 'seven "a" (three by emoji, straße, STRASSE, İstanbul, café): ' + count);
  await W().locator('input[aria-label="Replace with"]').fill('b');
  await W().getByRole('button', { name: 'Replace all' }).click();
  await settle();
  eq(await doc().innerText(), 'b😀b😀b strbße STRbSSE İstbnbul cbfé', 'replaced');
  await W().locator('input[aria-label="Find"]').fill('straße');
  await settle();
  await W().locator('input[aria-label="Find"]').fill('strbße');
  await settle();
  ok(/of 1$/.test(await W().locator('.wp-find-count').innerText()), 'ß found once');
  await W().locator('input[aria-label="Find"]').fill('istbnbul');
  await settle();
  const tr = await W().locator('.wp-find-count').innerText();
  if (!/of 1$/.test(tr)) info('rule 8a', `"istbnbul" against "İstbnbul" (case off) gives "${tr}"`);
  await page.keyboard.press('Escape');
  await doc().focus();
  await page.keyboard.press('Control+Z');
  await settle();
  eq(await doc().innerText(), before, 'one Undo restores the text exactly');
  await page.keyboard.press('Control+Y');
  await settle();
  eq(await doc().innerText(), 'b😀b😀b strbße STRbSSE İstbnbul cbfé', 'Redo again');
  await reset();
});

await step('WR-7: Replace all replaces every place, not the first 5,000', async () => {
  await newDoc();
  await page.keyboard.insertText('x '.repeat(6000));
  await page.keyboard.press('Control+H');
  await W().locator('input[aria-label="Find"]').fill('x');
  await settle();
  const shown = await W().locator('.wp-find-count').innerText();
  await W().locator('input[aria-label="Replace with"]').fill('y');
  await W().getByRole('button', { name: 'Replace all' }).click();
  await settle();
  const left = (await doc().innerText()).split('x').length - 1;
  if (left) info('WR-7', `the count showed "${shown}" for 6,000; Replace all left ${left} of them, and the toast said all were replaced`);
  await page.keyboard.press('Escape');
  await reset();
});

await step('rule 9: 375 px wide, both looks: no sideways scroll, and File > Save as reachable', async () => {
  await page.setViewportSize({ width: 375, height: 740 });
  await newDoc();
  await page.keyboard.type('Phone words');
  await settle();
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scroll (Modern)');
  await W().getByRole('button', { name: 'File' }).click();
  await page.locator('.menu').getByText('Save as...', { exact: true }).click();
  await D().locator('input[aria-label="File name"]').waitFor();
  const box = await D().boundingBox();
  ok(box && box.x >= 0 && box.x + box.width <= 376, 'the Save as window fits: ' + JSON.stringify(box));
  await page.keyboard.press('Escape');
  // Classic
  await W().locator('.ribbon-tab', { hasText: /^View$/ }).click();
  await W().locator('.ribbon .rb', { hasText: /^Classic/ }).first().click().catch(async () => {
    info('rule 9a', 'no Classic button on the View tab at 375 px');
  });
  await settle();
  if (await W().locator('.cbar').count()) {
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scroll (Classic)');
    const titles = await W().locator('.cbar-title').evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return { t: e.textContent, right: r.right }; }));
    const out = titles.filter(t => t.right > 376);
    if (out.length) info('rule 9a', 'menu titles past the right edge at 375 px: ' + out.map(t => t.t).join(', '));
    await W().locator('.cbar-title[data-menu="View"]').click();
    await page.locator('.menu-item', { hasText: 'Modern (ribbon)' }).click();
  }
  await reset();
  await page.setViewportSize({ width: 1400, height: 900 });
});

await step('rule 10: script in a Word file (a text box, a link, a field name) shows as letters and never runs', async () => {
  const evil = '&lt;img src=x onerror="window.__wrRan=1"&gt;';
  const box = `<mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wps:wsp><wps:txbx><w:txbxContent><w:p><w:r><w:t>${evil}</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp></w:drawing></mc:Choice></mc:AlternateContent>`;
  writeFileSync(join(dir, 'crafted.docx'), await sheetOf(`<w:p><w:r><w:t>${evil}</w:t></w:r><w:r>${box}</w:r><w:fldSimple w:instr=" MERGEFIELD ${'&lt;b&gt;x'} "><w:r><w:t>f</w:t></w:r></w:fldSimple><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> HYPERLINK "javascript:window.__wrRan=1" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>click</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`));
  await reset();
  await page.evaluate(() => { window.__wrRan = 0; });
  await bring(join(dir, 'crafted.docx'));
  await page.waitForFunction(() => [...document.querySelectorAll('.win')].some(w => w.textContent.includes('crafted.docx') && w.querySelector('.wp-doc')));
  await settle();
  if (await page.locator('.dialog').count()) await page.keyboard.press('Escape');
  await W().locator('.wp-doc a').evaluateAll(as => as.forEach(a => a.click()));
  await settle();
  eq(await page.evaluate(() => window.__wrRan), 0, 'nothing ran');
  ok((await doc().innerText()).includes('<img src=x'), 'shown as letters');
  eq(await W().locator('.wp-doc img:not(.ProseMirror-separator)').count(), 0, 'no picture made from the text');
  await reset();
});

await step('WR-16: File > Save PDF as says which letters will show as "?" (as Print and PDF does) before it writes', async () => {
  await newDoc();
  await page.keyboard.insertText('Dear Łukasz Wiśniewski of 北京, Ελλάδα');
  await settle();
  await fileMenu('Save PDF as...');
  // The warning comes first, before a name is asked for: nothing is written unless the person goes on.
  const warning = page.locator('.dialog', { hasText: '"?"' });
  const warned = await appears(warning, 3000);
  if (!warned) throw new Error('the PDF was about to be written with "?" for Ł, ś, 北京 and the Greek word, and nothing said so');
  const text = await warning.textContent();
  if (!/Ł/.test(text) || !/北/.test(text)) throw new Error(`the warning does not name the letters: ${text}`);
  await warning.getByRole('button', { name: 'Cancel' }).click();
  await reset();
});

await step('scale: a 2 MB text file of short lines opens, and Save writes it back whole', async () => {
  const line = 'The quick brown fox jumps over the lazy dog 0123456789';
  const lines = Array.from({ length: Math.ceil(2_000_000 / (line.length + 2)) }, (_, i) => `${i} ${line}`);
  const body = lines.join('\r\n') + '\r\n';
  writeFileSync(join(dir, 'big.txt'), body);
  await reset();
  const t0 = Date.now();
  await bring(join(dir, 'big.txt'));
  await page.waitForFunction(() => [...document.querySelectorAll('.win')].some(w => w.textContent.includes('big.txt') && w.querySelector('.wp-doc p')), null, { timeout: 60000 });
  // Until the page answers again (the pages are laid out after the text shows).
  for (let i = 0; i < 90; i++) {
    const s = Date.now();
    const answered = await Promise.race([page.evaluate(() => 1).then(() => true), new Promise(r => setTimeout(() => r(false), 2000))]);
    if (answered && Date.now() - s < 200) break;
    await page.waitForTimeout(500);
  }
  const openMs = Date.now() - t0;
  const big = page.locator('.win', { hasText: 'big.txt' }).last();
  const t1 = Date.now();
  await big.locator('.wp-doc').click({ timeout: 60000 });
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('X');
  await page.waitForFunction(() => [...document.querySelectorAll('.win')].find(w => w.textContent.includes('big.txt'))?.querySelector('.wp-doc p')?.textContent.startsWith('X0'), null, { timeout: 60000 });
  const typeMs = Date.now() - t1;
  await page.keyboard.press('Control+S');
  await page.locator('.toast', { hasText: 'Saved “big.txt”' }).last().waitFor({ timeout: 120000 });
  if (openMs > 15000 || typeMs > 1000) info('WR-17', `2 MB of lines: the page was busy for ${openMs} ms after opening; a click and one key took ${typeMs} ms`);
  else console.log(`       (opened in ${openMs} ms, a key in ${typeMs} ms)`);
  await reset();
});

// Last: a crafted Word file of about 2 KB whose table is padded out to a square of millions of cells. It can hang the
// page, so it runs under a watchdog of its own.
await step('WR-1: a 2 KB Word file with a table of one long row and many short rows opens or is refused within 20 s', async () => {
  const N = 1500;
  const wide = '<w:tr>' + '<w:tc><w:p/></w:tc>'.repeat(N) + '</w:tr>';
  const tall = '<w:tr><w:tc><w:p/></w:tc></w:tr>'.repeat(N);
  writeFileSync(join(dir, 'square.docx'), await sheetOf(`<w:tbl>${wide}${tall}</w:tbl>`));
  await reset();
  await startWrite();
  const chooser = page.waitForEvent('filechooser');
  await fileMenu('Open a Word file from your computer...');
  const started = Date.now();
  const run = (async () => {
    (await chooser).setFiles(join(dir, 'square.docx'));
    return page.waitForFunction(() => {
      const w = [...document.querySelectorAll('.win')].find(x => x.textContent.includes('square.docx'));
      return !!w && (!!w.querySelector('.wp-doc table') || !!w.querySelector('.app-message'));
    }, null, { timeout: 20000, polling: 500 }).then(() => true, () => false);
  })();
  const settled = await Promise.race([run, new Promise(r => setTimeout(() => r('hung'), 45000))]);
  const alive = settled !== 'hung' && await Promise.race([page.evaluate(() => 1).then(() => true, () => false), new Promise(r => setTimeout(() => r(false), 5000))]);
  ok(settled === true && alive, `after ${Math.round((Date.now() - started) / 1000)} s the window ${settled === true ? 'settled' : 'had not opened or said why'} and the page ${alive ? 'answers' : 'does not answer'}`);
});

console.log(`\n${passed} passed, ${failures.length} failed, ${infos.length} info`);
if (failures.length) console.log('FAILED: ' + failures.join(' | '));
const seen = problems.filter(p => !/Failed to load resource/.test(p));
if (seen.length) console.log('page problems:\n  ' + seen.slice(0, 20).join('\n  '));
// A hung page can keep close() waiting for ever.
await Promise.race([browser.close().catch(() => {}), new Promise(r => setTimeout(r, 5000))]);
process.exit(failures.length ? 1 : 0);
