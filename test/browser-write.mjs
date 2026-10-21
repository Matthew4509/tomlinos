// Drives TOMLIN Write in a real Chrome: a letter typed and formatted from the ribbon and the keyboard (styles, bold,
// size, colour, centring, bullets and numbering typed as "* " and "1. "), pasted HTML that keeps its formatting and
// loses its scripts, saving as .docx and opening it again, pages (lines that fill a page carry on at the top of the
// next, nothing is written in the margins or the gap, a page break), the Layout tab (landscape, margins, page numbers
// in the footer), Print and PDF (the PDF has the pages the screen shows), a table (rows, merging, shading, kept
// through a save), a picture (inserted, resized, kept through a save), .txt, and a phone-sized screen. Then the other
// files (Markdown, WordPad, a Word file with a text box kept through a save), find and replace, a footnote and a
// contents page kept through a save, letters from a spreadsheet (a PDF and a document), a template, and spelling.
// Needs the dev server on a FRESH, EMPTY data folder (the first step sets up the owner), and `npm run build` done.
//   node test/browser-write.mjs [http://127.0.0.1:3043] [screenshot folder]
import { chromium } from 'playwright-core';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipDeflate } from '../src/core/zip.ts';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3043';
const SHOTS = process.argv[3] ?? null;
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PASS = 'write-walk-passphrase-41';
let passed = 0;
const failures = [];
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true, locale: 'en-GB' });
const page = await context.newPage();
page.setDefaultTimeout(10000);
const problems = [];
page.on('console', m => m.type() === 'error' && problems.push('console: ' + m.text()));
page.on('pageerror', e => problems.push('pageerror: ' + e.message));
const missing = [];
page.on('response', r => r.status() === 404 && missing.push(new URL(r.url()).pathname));
const dir = mkdtempSync(join(tmpdir(), 'tomlinos-write-'));
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
    for (let i = 0; i < 3 && (await page.locator('.dialog').count()); i++) await page.keyboard.press('Escape').catch(() => {});
  }
}
const eq = (a, b, what) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const ok = (v, what) => {
  if (!v) throw new Error(what);
};
const openApp = async label => {
  if (!(await page.locator('.start-filter').isVisible())) await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill(label);
  await page.locator(`.start-menu [data-label="${label}"]`).first().click();
};
const W = () => page.locator('.win', { has: page.locator('.write') }).last();
const D = () => page.locator('.dialog').last();
const doc = () => W().locator('.wp-doc');
const tab = name => W().locator('.ribbon-tab', { hasText: name }).click();
/** A ribbon button by the words on it (its accessible name is its longer tooltip). */
const rb = name => W().locator('.ribbon .rb').filter({ hasText: new RegExp(`^${name}$`) });
const toast = text => page.locator('.toast', { hasText: text }).last().waitFor({ timeout: 15000 });
/** Closes every Write window, saying "Close without saving" where one asks. */
async function closeAllWrite() {
  for (let i = 0; i < 10; i++) {
    const wins = page.locator('.win', { has: page.locator('.write') });
    if (!(await wins.count())) return;
    if (await page.locator('.dialog').count()) await page.keyboard.press('Escape');
    await wins.last().getByRole('button', { name: 'Close', exact: true }).first().click();
    const discard = page.locator('.dialog').getByRole('button', { name: 'Close without saving' });
    if (await discard.waitFor({ timeout: 1500 }).then(() => true, () => false)) await discard.click();
    await page.waitForTimeout(250);
  }
}
const newDoc = async () => {
  await closeAllWrite();
  await openApp('tomlin write');
  await doc().waitFor();
  await W().locator('.wp-furniture').waitFor({ state: 'attached' });
  await doc().click();
};
const settle = () => page.waitForTimeout(350);
async function saveAs(name) {
  await doc().focus();
  await page.keyboard.press('Control+Shift+S');
  await D().locator('input[aria-label="File name"]').fill(name);
  await D().getByRole('button', { name: 'Save' }).click();
}
async function reopen(name) {
  await W().getByRole('button', { name: 'File' }).click();
  await page.locator('.menu').getByText('Open...', { exact: true }).click();
  await D().locator('.pick-row', { hasText: name }).first().dblclick();
  await page.waitForFunction(n => [...document.querySelectorAll('.win')].some(w => w.querySelector('.write .wp-doc') && w.textContent.includes(n)), name);
}

/** Every line of text on the paper, and the pages' writing areas: lines must sit inside one page's writing area. */
const layoutCheck = () => W().evaluate(win => {
  const paper = win.querySelector('.wp-paper');
  const docEl = win.querySelector('.wp-doc');
  const k = paper.getBoundingClientRect().width / paper.offsetWidth;
  const top0 = paper.getBoundingClientRect().top;
  const gaps = [...win.querySelectorAll('.wp-gap')].map(g => ({ top: parseFloat(g.style.top), h: parseFloat(g.style.height) }));
  const count = gaps.length + 1;
  const height = parseFloat(paper.style.height);
  const gap = gaps[0]?.h ?? 24;
  const pageH = (height + gap) / count - gap;
  const marginTop = parseFloat(docEl.style.paddingTop);
  const marginBottom = parseFloat(docEl.style.paddingBottom);
  const out = { count, pageH, outside: [], firstLines: [] };
  const range = document.createRange();
  const walker = document.createTreeWalker(docEl, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.parentElement.closest('.wp-break')) continue;
    range.selectNodeContents(n);
    for (const r of range.getClientRects()) {
      if (r.height < 1) continue;
      const y0 = (r.top - top0) / k;
      const y1 = (r.bottom - top0) / k;
      const i = Math.floor(y0 / (pageH + gap));
      const bodyTop = i * (pageH + gap) + marginTop;
      const bodyBottom = i * (pageH + gap) + pageH - marginBottom;
      if (y0 < bodyTop - 1 || y1 > bodyBottom + 1) out.outside.push({ text: n.data.slice(0, 20), y0: Math.round(y0), y1: Math.round(y1), page: i });
      if (!out.firstLines[i] || y0 < out.firstLines[i].y) out.firstLines[i] = { y: y0, off: Math.round((y0 - bodyTop) * 10) / 10, text: n.data.slice(0, 12) };
    }
  }
  return out;
});

await page.goto(BASE);
await step('set up a fresh desktop', async () => {
  await page.locator('.gate h1', { hasText: 'Set up this desktop' }).waitFor({ timeout: 20000 });
  await page.getByLabel('Your name').fill('Walk Tester');
  await page.locator('.gate input.gate-input').last().fill(PASS);
  await page.locator('.gate-encrypt').uncheck();
  await page.locator('.gate-go').click();
  await page.locator('.gate h1', { hasText: 'Your recovery key' }).waitFor({ timeout: 30000 });
  await page.locator('.gate .check-row input').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#desktop .item').first().waitFor({ timeout: 20000 });
});

await step('TOMLIN Write is first in Start > Office and opens on an empty A4 page', async () => {
  await page.locator('.start-btn').click();
  await page.locator('.start-menu button', { hasText: 'Office' }).first().click();
  const labels = await page.locator('.start-item').evaluateAll(els => els.map(e => e.getAttribute('data-label')));
  ok(labels.indexOf('tomlin write') >= 0 && labels.indexOf('tomlin write') < labels.indexOf('spreadsheet'), 'listed before the Spreadsheet: ' + labels.join(', '));
  await page.keyboard.press('Escape');
  await newDoc();
  eq(await W().locator('.wp-status').innerText().then(t => /Page 1 of 1/.test(t) && /0 words/.test(t)), true, 'status');
  const w = await W().locator('.wp-paper').evaluate(el => el.offsetWidth);
  eq(w, 794, 'A4 is 794 pixels wide at 100%');
});

await step('a letter: Title, Heading 1, bold, bigger, red, centred; "* " and "1. " start lists', async () => {
  await W().locator('.wp-style-rb', { hasText: 'Title' }).click();
  await page.keyboard.type('Quarterly letter');
  await page.keyboard.press('Enter');
  await W().locator('.wp-style-rb', { hasText: 'Heading 1' }).click();
  await page.keyboard.type('Dear reader');
  await page.keyboard.press('Enter');
  await W().locator('.wp-style-rb', { hasText: 'Normal' }).click();
  await page.keyboard.type('This is ');
  await page.keyboard.press('Control+B');
  await page.keyboard.type('bold');
  await page.keyboard.press('Control+B');
  await page.keyboard.type(' and this is ');
  await W().locator('.rb-size').fill('18');
  await W().locator('.rb-size').press('Enter');
  await page.keyboard.type('big');
  await W().getByRole('button', { name: 'Text colour' }).click();
  await page.locator('.palette-sw[aria-label="Red"]').click();
  await page.keyboard.type(' red');
  await page.keyboard.press('Enter');
  await W().locator('.rb-size').fill('11');
  await W().locator('.rb-size').press('Enter');
  await W().getByRole('button', { name: 'Text colour' }).click();
  await page.locator('.palette-none').click();
  await page.keyboard.type('Centred line');
  await page.keyboard.press('Control+E');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+L');
  await page.keyboard.type('* First point');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Second point');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('1. Step one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Step two');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Inner step');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Yours sincerely');
  await settle();
  eq(await doc().locator('p.wp-title').innerText(), 'Quarterly letter', 'title');
  eq(await doc().locator('p.wp-h1').innerText(), 'Dear reader', 'heading');
  eq(await doc().locator('strong').innerText(), 'bold', 'bold');
  ok(await doc().locator('span', { hasText: 'big' }).evaluate(el => getComputedStyle(el).fontSize === '24px'), '18 pt is 24 px');
  ok(await doc().locator('span', { hasText: /^\s*red$/ }).evaluate(el => getComputedStyle(el).color === 'rgb(255, 0, 0)'), 'red');
  ok(await doc().locator('p', { hasText: 'Centred line' }).evaluate(el => getComputedStyle(el).textAlign === 'center'), 'centred');
  eq(await doc().locator('ul > li').count(), 2, 'two bullets');
  eq(await doc().locator('ol > li').count(), 3, 'numbered: two and one inside');
  eq(await doc().locator('ol ol > li').innerText(), 'Inner step', 'Tab moved it in');
  ok(/Page 1 of 1/.test(await W().locator('.wp-status').innerText()), 'one page');
  ok(/2\d words/.test(await W().locator('.wp-status').innerText()), 'word count: ' + await W().locator('.wp-status').innerText());
  await shot('01-letter');
});

await step('pasted HTML keeps bold, italic, colour and size, and loses scripts, handlers and outside pictures', async () => {
  await page.keyboard.press('Enter');
  await doc().evaluate(el => {
    window.__pasteRan = false;
    const html = '<style>p{color:blue}</style><p><b>Pasted bold</b> <i>italic</i> <span style="color:#00b050;font-size:16pt">green 16</span>'
      + '<img src="https://example.invalid/x.png" onerror="window.__pasteRan=true"><script>window.__pasteRan=true<\/script>'
      + '<a href="javascript:window.__pasteRan=true" onclick="window.__pasteRan=true">link text</a></p>'
      + '<p class=MsoNormal style="margin-bottom:0cm;text-align:right"><span style="font-family:Georgia">From Word</span></p>';
    const dt = new DataTransfer();
    dt.setData('text/html', html);
    dt.setData('text/plain', 'Pasted bold italic green 16 link text From Word');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await settle();
  eq(await doc().locator('strong', { hasText: 'Pasted bold' }).count(), 1, 'bold kept');
  eq(await doc().locator('em', { hasText: 'italic' }).count(), 1, 'italic kept');
  ok(await doc().locator('span', { hasText: 'green 16' }).last().evaluate(el => getComputedStyle(el).color === 'rgb(0, 176, 80)'), 'colour kept');
  ok(await doc().locator('p', { hasText: 'From Word' }).evaluate(el => getComputedStyle(el).textAlign === 'right'), 'Word paragraph alignment kept');
  ok(await doc().locator('span', { hasText: 'From Word' }).evaluate(el => /Georgia/.test(getComputedStyle(el).fontFamily)), 'Word font kept');
  eq(await doc().locator('img').count(), 0, 'outside picture dropped');
  eq(await doc().locator('a, script, style').count(), 0, 'no links, scripts or styles');
  eq(await page.evaluate(() => window.__pasteRan), false, 'nothing ran');
  ok((await doc().innerText()).includes('link text'), 'the link’s words kept');
});

await step('Save as .docx, close, open it again: styles, formatting and lists are back', async () => {
  await saveAs('letter-walk');
  await toast('Saved “letter-walk.docx”');
  await closeAllWrite();
  await openApp('tomlin write');
  await doc().waitFor();
  await reopen('letter-walk.docx');
  const w = W();
  await w.locator('.wp-doc p.wp-title').waitFor();
  eq(await w.locator('.wp-doc p.wp-title').innerText(), 'Quarterly letter', 'title');
  eq(await w.locator('.wp-doc p.wp-h1').innerText(), 'Dear reader', 'heading');
  eq(await w.locator('.wp-doc strong', { hasText: /^bold$/ }).count(), 1, 'bold');
  ok(await w.locator('.wp-doc span', { hasText: 'big' }).first().evaluate(el => getComputedStyle(el).fontSize === '24px'), 'size');
  eq(await w.locator('.wp-doc ul > li').count(), 2, 'bullets');
  eq(await w.locator('.wp-doc ol ol > li').innerText(), 'Inner step', 'inner numbered');
  ok(await w.locator('.wp-doc p', { hasText: 'From Word' }).evaluate(el => getComputedStyle(el).textAlign === 'right'), 'pasted alignment');
  await closeAllWrite();
});

await step('pages: a long document carries on at the top of page 2 and 3; nothing lands in the margins or the gap', async () => {
  await newDoc();
  await doc().evaluate(() => {});
  for (let i = 1; i <= 70; i++) {
    await page.keyboard.type(`Line ${i} of a long document, with enough words to fill most of the width of the page here.`);
    await page.keyboard.press('Enter');
  }
  await settle();
  await settle();
  const r = await layoutCheck();
  ok(r.count >= 3, 'three pages or more: ' + r.count);
  eq(r.outside, [], 'no text in margins or gaps');
  for (const [i, f] of r.firstLines.entries()) if (i > 0) ok(Math.abs(f.off) < 3, `page ${i + 1} starts at its top margin (${f.off} px off, "${f.text}")`);
  ok(new RegExp(`of ${r.count}`).test(await W().locator('.wp-status').innerText()), 'status counts the pages');
  await shot('02-pages');
});

await step('typing near a page end moves only what must move; deleting lines pulls the next page back up', async () => {
  const before = await layoutCheck();
  await doc().locator('p').first().click();
  await page.keyboard.press('Home');
  for (let i = 0; i < 6; i++) await page.keyboard.press('Enter');
  await settle();
  await settle();
  const more = await layoutCheck();
  eq(more.outside, [], 'still nothing outside after adding lines');
  for (let i = 0; i < 6; i++) await page.keyboard.press('Backspace');
  await settle();
  await settle();
  const back = await layoutCheck();
  eq(back.count, before.count, 'the same number of pages again');
  eq(back.outside, [], 'nothing outside');
});

await step('Ctrl+Enter puts in a page break: what follows starts the next page', async () => {
  await doc().locator('p', { hasText: /^Line 3 of/ }).click();
  const at = await page.evaluate(() => getSelection().anchorNode?.textContent?.slice(0, 12));
  eq(at, 'Line 3 of a ', 'the click put the cursor in the line clicked');
  await page.keyboard.press('End');
  await page.keyboard.press('Control+Enter');
  await page.keyboard.type('After the break');
  await settle();
  await settle();
  eq(await doc().locator('.wp-break').count(), 1, 'one break');
  const r = await layoutCheck();
  eq(r.firstLines[1].text.startsWith('After the'), true, 'page 2 starts with the text after the break: ' + r.firstLines[1].text);
  eq(r.outside, [], 'nothing outside');
});

await step('Layout: landscape, narrow margins, and page numbers in the footer on every page', async () => {
  await tab('Layout');
  await W().getByRole('button', { name: 'Orientation', exact: true }).click();
  await page.locator('.menu').getByText('Landscape (wide)').click();
  await settle();
  eq(await W().locator('.wp-paper').evaluate(el => el.offsetWidth), 1123, 'A4 landscape is 1123 wide');
  await W().getByRole('button', { name: 'Margins', exact: true }).click();
  await page.locator('.menu').getByText(/^Narrow/).click();
  await W().getByRole('button', { name: 'Page numbers', exact: true }).click();
  await page.locator('.menu').getByText('Bottom, right: Page 1 of 3').click();
  await settle();
  await settle();
  const r = await layoutCheck();
  const footers = await W().locator('.wp-footer').allInnerTexts();
  eq(footers.length, r.count, 'a footer on every page');
  ok(footers[0].includes(`Page 1 of ${r.count}`) && footers[r.count - 1].includes(`Page ${r.count} of ${r.count}`), 'numbers: ' + footers.join(' | '));
  eq(r.outside, [], 'nothing outside after the change');
  await shot('03-landscape');
});

await step('Print and PDF: the preview shows the pages; the PDF has the same number of pages and the words', async () => {
  const r = await layoutCheck();
  await page.keyboard.press('Control+P');
  await D().locator('.pp-count').waitFor();
  ok((await D().locator('.pp-count').innerText()).includes(`of ${r.count}`), 'preview count');
  await shot('04-print');
  const dl = page.waitForEvent('download');
  await D().getByRole('button', { name: 'Download PDF' }).click();
  const download = await dl;
  const file = join(dir, 'out.pdf');
  await download.saveAs(file);
  const pdf = readFileSync(file, 'latin1');
  ok(pdf.startsWith('%PDF-1.4'), 'a PDF');
  eq((pdf.match(/\/Type \/Page /g) ?? []).length, r.count, 'pages in the PDF');
  ok(/\/Producer \(TOMLIN Write\)/.test(pdf), 'made by Write');
});

await step('a table: 3 by 3, typed in, a row added, two cells merged, a cell shaded; kept through a save', async () => {
  await closeAllWrite();
  await newDoc();
  await page.keyboard.type('Before the table');
  await page.keyboard.press('Enter');
  await tab('Insert');
  await W().getByRole('button', { name: 'Insert a table' }).click();
  await D().getByRole('button', { name: 'OK' }).click();
  await doc().locator('table td').first().waitFor();
  eq(await doc().locator('table tr').count(), 3, 'three rows');
  await doc().locator('td').first().click();
  for (const t of ['Name', 'Qty', 'Price']) {
    await page.keyboard.type(t);
    await page.keyboard.press('Tab');
  }
  await page.keyboard.type('Apples');
  await tab('Table');
  await rb('Row below').click();
  eq(await doc().locator('table tr').count(), 4, 'row added');
  // Merge the first row's last two cells: drag across them.
  const a = await doc().locator('tr').first().locator('td').nth(1).boundingBox();
  const b = await doc().locator('tr').first().locator('td').nth(2).boundingBox();
  await page.mouse.move(a.x + 10, a.y + 5);
  await page.mouse.down();
  await page.mouse.move(b.x + 20, b.y + 5, { steps: 5 });
  await page.mouse.up();
  await rb('Merge cells').click();
  eq(await doc().locator('tr').first().locator('td').count(), 2, 'merged');
  await doc().locator('td', { hasText: 'Name' }).click();
  await W().getByRole('button', { name: 'Cell shading' }).click();
  await page.locator('.palette-sw[aria-label="Pale blue"]').click();
  ok(await doc().locator('td', { hasText: 'Name' }).evaluate(el => getComputedStyle(el).backgroundColor === 'rgb(222, 234, 246)'), 'shaded');
  await shot('05-table');
  await saveAs('table-walk');
  await toast('Saved “table-walk.docx”');
  await closeAllWrite();
  await openApp('tomlin write');
  await doc().waitFor();
  await reopen('table-walk.docx');
  await W().locator('.wp-doc table').waitFor();
  eq(await W().locator('.wp-doc tr').count(), 4, 'rows kept');
  eq(await W().locator('.wp-doc tr').first().locator('td').count(), 2, 'merge kept');
  eq(await W().locator('.wp-doc td[colspan="2"]').count(), 1, 'spans two columns');
  ok(await W().locator('.wp-doc td', { hasText: 'Name' }).evaluate(el => getComputedStyle(el).backgroundColor === 'rgb(222, 234, 246)'), 'shading kept');
  eq(await W().locator('.wp-doc td', { hasText: 'Apples' }).count(), 1, 'text kept');
});

await step('a picture: inserted from the computer, made page-wide, kept with its size through a save', async () => {
  // A 120 x 60 PNG made by the browser.
  const png = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 120;
    c.height = 60;
    const g = c.getContext('2d');
    g.fillStyle = '#2b579a';
    g.fillRect(0, 0, 120, 60);
    g.fillStyle = '#ffd400';
    g.fillRect(10, 10, 40, 40);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  const file = join(dir, 'pic.png');
  writeFileSync(file, Buffer.from(png));
  await doc().locator('p').last().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await tab('Insert');
  const chooser = page.waitForEvent('filechooser');
  await W().getByRole('button', { name: /Insert a picture from this computer/ }).click();
  (await chooser).setFiles([file]);
  await doc().locator('img.wp-img').waitFor();
  eq(await doc().locator('img.wp-img').evaluate(el => [el.width, el.height]), [120, 60], 'its own size');
  await doc().locator('img.wp-img').click();
  await W().locator('.ribbon-tab', { hasText: 'Picture' }).waitFor({ state: 'visible' });
  await tab('Picture');
  await rb('Page width').click();
  await settle();
  const [w, h] = await doc().locator('img.wp-img').evaluate(el => [el.width, el.height]);
  ok(w > 500 && Math.abs(h - w / 2) <= 1, `page-wide, same shape: ${w} x ${h}`);
  await shot('06-picture');
  await page.keyboard.press('Control+S');
  await toast('Saved “table-walk.docx”');
  await closeAllWrite();
  await openApp('tomlin write');
  await doc().waitFor();
  await reopen('table-walk.docx');
  await W().locator('.wp-doc img.wp-img').waitFor();
  eq(await W().locator('.wp-doc img.wp-img').evaluate(el => [el.width, el.height, el.naturalWidth]), [w, h, 120], 'size kept, picture loaded');
  await closeAllWrite();
});

await step('plain text: Save as .txt asks first, then keeps only the words', async () => {
  await newDoc();
  await page.keyboard.press('Control+B');
  await page.keyboard.type('Bold words');
  await page.keyboard.press('Enter');
  await page.keyboard.type('second line');
  await saveAs('plain-walk.txt');
  await D().getByRole('button', { name: 'Save the words only' }).click();
  await toast('Saved “plain-walk.txt”');
  await closeAllWrite();
  await openApp('tomlin write');
  await doc().waitFor();
  await reopen('plain-walk.txt');
  await W().locator('.wp-doc p', { hasText: 'second line' }).waitFor();
  eq(await W().locator('.wp-doc strong').count(), 0, 'no bold in a .txt');
  await closeAllWrite();
});

await step('on a phone-sized screen the window fits and the page fits its width', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await newDoc();
  await page.keyboard.type('Small screen');
  await settle();
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scroll on the page');
  ok(await W().locator('.wp-scroll').evaluate(el => el.scrollWidth <= el.clientWidth + 2), 'the paper is zoomed to fit');
  await shot('07-phone');
  await closeAllWrite();
  await page.setViewportSize({ width: 1400, height: 900 });
});

/** Files from this computer into Documents, through File Explorer's Upload. */
async function upload(paths) {
  await closeAllWrite();
  await page.locator('#desktop .item', { hasText: 'My Files' }).first().dblclick();
  const w = page.locator('.win', { has: page.locator('.explorer') }).first();
  await w.waitFor();
  await w.locator('.explorer-view').focus();
  await page.keyboard.press('Control+L');
  await w.locator('input.address').fill('/Documents');
  await w.locator('input.address').press('Enter');
  await w.locator('.crumb', { hasText: /^Documents$/ }).waitFor();
  const chooser = page.waitForEvent('filechooser');
  await w.getByRole('button', { name: 'Upload' }).click();
  (await chooser).setFiles(paths);
  for (const p of paths) await w.locator('.item', { hasText: p.split(/[\\/]/).pop().replace(/\.[^.]+$/, '') }).first().waitFor({ timeout: 15000 });
  await w.getByRole('button', { name: 'Close', exact: true }).first().click();
}
const enc = new TextEncoder();
const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"';
const BOX = '<mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wps:wsp><wps:txbx><w:txbxContent><w:p><w:r><w:t>Inside the box</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp></w:drawing></mc:Choice></mc:AlternateContent>';

await step('Markdown, WordPad and a Word file with a text box open formatted; the text box is kept through a save', async () => {
  writeFileSync(join(dir, 'notes.md'), '# Plan\n\n- **one**\n- two\n');
  writeFileSync(join(dir, 'wordpad.rtf'), String.raw`{\rtf1\ansi{\fonttbl{\f0 Calibri;}{\f1 Symbol;}}\pard\f0\fs22 Hello \b WordPad\b0\par{\pntext\f1\'B7\tab}First\par}`);
  writeFileSync(join(dir, 'elsewhere.docx'), await zipDeflate([
    { name: '[Content_Types].xml', data: enc.encode('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'), modified: 0 },
    { name: '_rels/.rels', data: enc.encode('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'), modified: 0 },
    { name: 'word/document.xml', data: enc.encode(`<?xml version="1.0"?><w:document ${W_NS}><w:body><w:p><w:r><w:t xml:space="preserve">From elsewhere </w:t></w:r><w:r>${BOX}</w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`), modified: 0 },
  ]));
  await upload([join(dir, 'notes.md'), join(dir, 'wordpad.rtf'), join(dir, 'elsewhere.docx')]);
  await newDoc();
  await reopen('notes.md');
  await W().locator('.wp-doc p.wp-h1', { hasText: 'Plan' }).waitFor();
  eq(await W().locator('.wp-doc ul > li').count(), 2, 'Markdown list');
  eq(await W().locator('.wp-doc strong').innerText(), 'one', 'Markdown bold');
  await closeAllWrite();
  await newDoc();
  await reopen('wordpad.rtf');
  await W().locator('.wp-doc strong', { hasText: 'WordPad' }).waitFor();
  eq(await W().locator('.wp-doc ul > li').innerText(), 'First', 'WordPad bullet');
  await doc().focus();
  await page.keyboard.press('Control+S');
  eq(await D().locator('input[aria-label="File name"]').inputValue(), 'wordpad.docx', 'a WordPad file is saved as a Word document');
  await page.keyboard.press('Escape');
  await closeAllWrite();
  await newDoc();
  await reopen('elsewhere.docx');
  await D().getByText('Write keeps these as they are').waitFor();
  await D().getByRole('button', { name: 'OK' }).click();
  await W().locator('.wp-doc .wp-opaque', { hasText: 'Text box: Inside the box' }).waitFor();
  await doc().focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' and more');
  await page.keyboard.press('Control+S');
  await toast('Saved “elsewhere.docx”');
  await closeAllWrite();
  await newDoc();
  await reopen('elsewhere.docx');
  await D().getByRole('button', { name: 'OK' }).click();
  await W().locator('.wp-doc .wp-opaque', { hasText: 'Text box' }).waitFor();
  ok((await doc().innerText()).includes('and more'), 'the typing was saved with it');
});

await step('a Word file with a link and a Heading 5 keeps both through a save; Ctrl+K makes a link; the ▾ beside Numbering gives (a)', async () => {
  const W_R = `${W_NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
  writeFileSync(join(dir, 'linked.docx'), await zipDeflate([
    { name: '[Content_Types].xml', data: enc.encode('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'), modified: 0 },
    { name: '_rels/.rels', data: enc.encode('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'), modified: 0 },
    { name: 'word/_rels/document.xml.rels', data: enc.encode('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/" TargetMode="External"/></Relationships>'), modified: 0 },
    { name: 'word/document.xml', data: enc.encode(`<?xml version="1.0"?><w:document ${W_R}><w:body><w:p><w:pPr><w:pStyle w:val="Heading5"/></w:pPr><w:r><w:t>Deep heading</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">See </w:t></w:r><w:hyperlink r:id="rId9"><w:r><w:t>our site</w:t></w:r></w:hyperlink></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`), modified: 0 },
  ]));
  await upload([join(dir, 'linked.docx')]);
  await newDoc();
  await reopen('linked.docx');
  await doc().locator('a.wp-link', { hasText: 'our site' }).waitFor();
  eq(await doc().locator('a.wp-link').getAttribute('href'), 'https://example.com/', 'the link keeps its address');
  await doc().locator('p.wp-h5', { hasText: 'Deep heading' }).waitFor();
  eq(await page.locator('.dialog').count(), 0, 'nothing left out, so nothing to report');
  await doc().focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('.');
  await page.keyboard.press('Control+S');
  await toast('Saved “linked.docx”');
  await closeAllWrite();
  await newDoc();
  await reopen('linked.docx');
  await doc().locator('a.wp-link[href="https://example.com/"]', { hasText: 'our site' }).waitFor();
  await doc().locator('p.wp-h5', { hasText: 'Deep heading' }).waitFor();
  // Ctrl+K on chosen words: an email address becomes a mailto link.
  await doc().focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Ask Ann');
  await page.keyboard.press('Shift+Home');
  await page.keyboard.press('Control+k');
  await D().locator('input').fill('ann@example.com');
  await D().getByRole('button', { name: 'Link' }).click();
  await doc().locator('a.wp-link[href="mailto:ann@example.com"]', { hasText: 'Ask Ann' }).waitFor();
  // The numbering format: (a) (b) (c).
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('1. first');
  await W().locator('button[title^="Numbering format"]').click();
  await page.locator('.menu').getByText('(a) (b) (c)', { exact: true }).click();
  const marker = await doc().locator('ol li').first().evaluate(li => getComputedStyle(li, '::marker').content);
  ok(/lower-alpha/.test(marker) && marker.includes('('), 'the list counts (a): ' + marker);
  await shot('write-link-numbering');
  await closeAllWrite();
});

await step('find and replace: every "cat" becomes "fox", formatting and all', async () => {
  await newDoc();
  await page.keyboard.type('cat cat dog ');
  await page.keyboard.press('Control+B');
  await page.keyboard.type('cat');
  await page.keyboard.press('Control+H');
  await W().getByLabel('Find', { exact: true }).fill('cat');
  ok((await W().locator('.wp-find-count').innerText()).includes('of 3'), 'three found');
  eq(await doc().locator('.wp-found').count(), 3, 'marked in the text');
  await W().getByLabel('Replace with').fill('fox');
  await W().locator('.wp-find-panel').getByRole('button', { name: 'Replace all' }).click();
  await toast('Replaced 3 places');
  eq((await doc().innerText()).trim(), 'fox fox dog fox', 'replaced');
  eq(await doc().locator('strong').innerText(), 'fox', 'the bold one stays bold');
  await W().getByLabel('Find', { exact: true }).press('Escape');
  ok(await W().locator('.wp-find-panel').isHidden(), 'Esc closes the bar');
});

await step('a footnote stands at the foot of its page; a contents page lists the headings; both kept through a save', async () => {
  await newDoc();
  await W().locator('.wp-style-rb', { hasText: 'Heading 1' }).click();
  await page.keyboard.type('Alpha');
  await page.keyboard.press('Enter');
  await page.keyboard.type('A claim');
  await page.keyboard.press('Control+Alt+F');
  await D().locator('input').fill('Smith, 2024, page 7');
  await D().getByRole('button', { name: 'Insert' }).click();
  await page.keyboard.press('Enter');
  await W().locator('.wp-style-rb', { hasText: 'Heading 1' }).click();
  await page.keyboard.type('Beta');
  await settle();
  eq(await doc().locator('.wp-fn').innerText(), '1', 'numbered');
  ok((await W().locator('.wp-notes').innerText()).includes('Smith, 2024, page 7'), 'at the foot of the page');
  await page.keyboard.press('Control+Home');
  await tab('Insert');
  await W().getByRole('button', { name: /A contents page/ }).click();
  await settle();
  await settle();
  eq(await doc().locator('.wp-toc-row .wp-toc-text').allInnerTexts(), ['Alpha', 'Beta'], 'headings listed');
  eq(await doc().locator('.wp-toc-row .wp-toc-page').first().innerText(), '1', 'with their page');
  await shot('08-footnote-contents');
  await saveAs('notes-walk');
  await toast('Saved “notes-walk.docx”');
  await closeAllWrite();
  await newDoc();
  await reopen('notes-walk.docx');
  await W().locator('.wp-doc .wp-toc-row').first().waitFor();
  eq(await W().locator('.wp-doc .wp-fn').count(), 1, 'footnote kept');
  ok((await W().locator('.wp-notes').innerText()).includes('Smith, 2024'), 'its words kept');
});

await step('letters from a spreadsheet: a field, a preview, then the letters as a PDF and as a document', async () => {
  writeFileSync(join(dir, 'people.csv'), 'Name,City\nAnn Lee,Perth\nBob Stone,Hobart\n');
  await upload([join(dir, 'people.csv')]);
  await newDoc();
  await page.keyboard.type('Dear ');
  await tab('Mailings');
  await rb('From a spreadsheet...').click();
  await D().locator('.pick-row', { hasText: 'people' }).first().dblclick();
  await W().locator('.wp-tip', { hasText: 'people.csv: 2 rows' }).waitFor();
  await doc().focus();
  await page.keyboard.press('Control+End');
  await W().getByRole('button', { name: 'Insert a field: filled in from each row' }).click();
  await page.locator('.menu').getByText('Name', { exact: true }).click();
  eq(await doc().locator('.wp-field').innerText(), '«Name»', 'the field');
  await rb('Preview').click();
  eq(await doc().locator('.wp-field').innerText(), 'Ann Lee', 'previewing row 1');
  await rb('Letters as a PDF').click();
  await toast('Made 2 letters');
  eq(await doc().locator('.wp-field').count(), 1, 'the letter itself is back');
  await rb('Letters as a document').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.win')].some(w => w.textContent.includes('letters.docx') && w.querySelector('.wp-doc')));
  const letters = page.locator('.win', { hasText: 'letters.docx' }).last();
  await letters.locator('.wp-break').waitFor();
  const text = await letters.locator('.wp-doc').innerText();
  ok(text.includes('Dear Ann Lee') && text.includes('Dear Bob Stone'), 'one letter each: ' + text);
});

await step('a template, and spelling on and off', async () => {
  await newDoc();
  await W().getByRole('button', { name: 'File' }).click();
  await page.locator('.menu').getByText('New from a template').hover();
  await page.locator('.menu').getByText('Letter', { exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.wp-doc')].some(d => d.textContent.includes('Dear Their name,')));
  eq(await W().locator('.wp-doc').getAttribute('spellcheck'), 'true', 'spelling checked at first');
  await tab('Review');
  await rb('Spelling').click();
  eq(await W().locator('.wp-doc').getAttribute('spellcheck'), 'false', 'off');
  await rb('Spelling').click();
  eq(await W().locator('.wp-doc').getAttribute('spellcheck'), 'true', 'on again');
});

await step('unsaved work is kept as a recovery copy; after the page stops, the next Write window offers it back', async () => {
  await newDoc();
  await page.keyboard.type('Kept through a crash');
  // The page goes to the background (a lid closing): a copy is kept at once.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    delete document.visibilityState;
  });
  await page.waitForTimeout(1500);
  // The page stops without saving, as a crash or a closed tab would.
  page.once('dialog', d => d.accept());
  await page.goto(BASE, { waitUntil: 'load' });
  await page.locator('#desktop .item').first().waitFor();
  await openApp('tomlin write');
  const offer = page.locator('.dialog', { hasText: 'Documents not saved' });
  await offer.waitFor({ timeout: 10000 });
  ok((await offer.innerText()).includes('Document: kept'), 'the copy is listed: ' + (await offer.innerText()));
  await offer.getByRole('button', { name: 'Open it' }).click();
  await page.locator('.toast', { hasText: 'Recovered “Document”' }).first().waitFor();
  await doc().waitFor();
  ok((await doc().innerText()).includes('Kept through a crash'), 'the work is back');
  eq(await page.locator('.win .write').count(), 1, 'the empty window made way for the recovered one');
  await shot('write-recovered');
  await closeAllWrite();
  await openApp('tomlin write');
  await doc().waitFor();
  await page.waitForTimeout(1500);
  eq(await page.locator('.dialog', { hasText: 'Documents not saved' }).count(), 0, 'closed on purpose: nothing offered again');
  await closeAllWrite();
});

await step('no errors in the console', async () => {
  if (missing.length) console.log('       (404, expected for files not made yet: ' + [...new Set(missing)].join(', ') + ')');
  eq(problems.filter(p => !/status of 404/.test(p)), [], 'console');
});

console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? ': ' + failures.join('; ') : ''}`);
await browser.close().catch(() => {});
process.exit(failures.length ? 1 : 0);
