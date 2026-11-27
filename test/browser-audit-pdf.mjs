// Audit of the PDF Viewer in a real Chrome: pages, keys, the page box, rotation, huge and tiny pages, many pages,
// damaged and encrypted files, thin lines, a filled form, redrawing while the window is resized, a small window.
// Each step marked FAULT failed when it was written. Needs the dev server on a FRESH, EMPTY data folder (the first
// step sets up the owner), and `npm run build` done.
//   node test/browser-audit-pdf.mjs [http://127.0.0.1:3109] [screenshot folder]
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { tempDir } from './tmp.ts';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3109';
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
    console.log('  FAIL ' + name + '\n       ' + String(error.message).split('\n')[0].slice(0, 600));
  }
  await closeAll().catch(() => {});
}
const eq = (a, b, what) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const ok = (v, what) => {
  if (!v) throw new Error(what);
};

// ---- Test files, made here ----
function pdf(objects, trailer = '') {
  const parts = [Buffer.from('%PDF-1.4\n')];
  for (const [id, body] of Object.entries(objects)) {
    if (typeof body === 'string') parts.push(Buffer.from(`${id} 0 obj\n${body}\nendobj\n`));
    else parts.push(Buffer.from(`${id} 0 obj\n${body[0].replace('LEN', String(body[1].length))}\nstream\n`), body[1], Buffer.from('\nendstream\nendobj\n'));
  }
  parts.push(Buffer.from(`trailer\n<< /Root 1 0 R ${trailer}>>\n%%EOF\n`));
  return Buffer.concat(parts);
}
const FONT = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
function pages(contents, box = '[0 0 612 792]', extra = () => '') {
  const objs = { 1: '<< /Type /Catalog /Pages 2 0 R >>', 3: FONT };
  const kids = [];
  contents.forEach((c, i) => {
    const id = 10 + i * 2;
    kids.push(`${id} 0 R`);
    objs[id] = `<< /Type /Page /Parent 2 0 R /Contents ${id + 1} 0 R /Resources << /Font << /F1 3 0 R >> >> ${extra(i)} >>`;
    objs[id + 1] = ['<< /Length LEN /Filter /FlateDecode >>', deflateSync(Buffer.from(c))];
  });
  objs[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} /MediaBox ${box} >>`;
  return pdf(objs);
}
const label = n => `BT /F1 36 Tf 72 700 Td (Page ${n}) Tj ET`;
// A busy page: 40000 small coloured squares in a pattern, so drawing it pauses several times.
const busy = (() => {
  const ops = [];
  for (let i = 0; i < 40000; i++) {
    const x = (i % 100) * 6;
    const y = 100 + (Math.floor(i / 100) % 60) * 10;
    ops.push(`q ${(i % 7) / 7} ${(i % 3) / 3} 0.5 rg ${x} ${y} 5 8 re f Q`);
  }
  return ops.join('\n');
})();
const files = {
  'three.pdf': pages([label(1), label(2), label(3)]),
  'many.pdf': pages(Array.from({ length: 1200 }, (_, i) => label(i + 1))),
  'busy.pdf': pages([busy + '\n' + label(1), busy + '\n' + label(2)]),
  'hairline.pdf': pages(['0 w 0 0 1 RG 50 50 m 560 740 l S']),
  'rotated.pdf': pages([label(1)], '[0 0 612 792]', () => '/Rotate 90'),
  'huge.pdf': pages([label(1)], '[0 0 14400 14400]'),
  'tiny.pdf': pages([label(1)], '[0 0 20 20]'),
  'form.pdf': pdf({
    1: '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [8 0 R] >> >>',
    2: '<< /Type /Pages /Kids [4 0 R] /Count 1 /MediaBox [0 0 612 792] >>',
    3: FONT,
    4: '<< /Type /Page /Parent 2 0 R /Contents 5 0 R /Resources << /Font << /F1 3 0 R >> >> /Annots [8 0 R] >>',
    5: ['<< /Length LEN >>', Buffer.from('BT /F1 14 Tf 72 700 Td (Name:) Tj ET 0 G 140 690 200 24 re S')],
    8: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /V (Jane Smith) /Rect [140 690 340 714] /AP << /N 9 0 R >> >>',
    9: ['<< /Type /XObject /Subtype /Form /BBox [0 0 200 24] /Resources << /Font << /F1 3 0 R >> >> /Length LEN >>', Buffer.from('BT /F1 14 Tf 4 7 Td (Jane Smith) Tj ET')],
  }),
  'locked.pdf': pdf({
    1: '<< /Type /Catalog /Pages 2 0 R >>', 2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 3: '<< /Type /Page /Parent 2 0 R >>',
    9: '<< /Filter /Standard /V 1 /R 2 /O <00> /U <00> /P -44 >>',
  }, '/Encrypt 9 0 R '),
  'notpdf.pdf': Buffer.from('just some text, not a PDF at all\n'),
};
files['cutoff.pdf'] = files['three.pdf'].subarray(0, Math.floor(files['three.pdf'].length * 0.6));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const shot = async name => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });
const front = () => page.locator('.win.active');
const viewer = () => page.locator('.win', { has: page.locator('.win-body.pdf, .pdf') }).last();

async function closeAll() {
  for (let i = 0; i < 40; i++) {
    const dialog = page.locator('.dialog');
    if (await dialog.count()) {
      await dialog.getByRole('button').last().click();
      continue;
    }
    const wins = page.locator('.win');
    if (!(await wins.count())) return;
    await wins.last().locator('.win-close').first().click();
    await page.waitForTimeout(80);
  }
  throw new Error('windows would not close');
}
async function documents() {
  await page.keyboard.press('Control+Alt+e');
  const w = front();
  await w.locator('.item', { hasText: 'Documents' }).first().dblclick();
  return w;
}
/** Opens a PDF from Documents and waits until the viewer has drawn its first page or said why not. */
async function openPdf(stem) {
  const w = await documents();
  await w.locator('.item', { hasText: stem }).first().dblclick();
  const v = viewer();
  await v.locator('.statusbar:not(:text("Drawing...")), .app-message').first().waitFor({ timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('.win.active .statusbar') || !/Drawing/.test(document.querySelector('.win.active .statusbar').textContent), null, { timeout: 20000 }).catch(() => {});
  return v;
}
const status = v => v.locator('.statusbar').innerText();
const settle = async v => {
  await page.waitForTimeout(150);
  await page.waitForFunction(() => !/Drawing/.test(document.querySelector('.win.active .statusbar')?.textContent ?? ''), null, { timeout: 20000 });
};
/** A short fingerprint of the canvas pixels. */
const canvasHash = v => v.locator('canvas.pdf-canvas').evaluate(c => {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let h = 0;
  for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i] * 3 + d[i + 1] * 5 + d[i + 2] * 7) >>> 0;
  return `${c.width}x${c.height}:${h}`;
});

console.log('PDF Viewer audit, against ' + BASE);
await page.goto(BASE);

await step('set up the owner', async () => {
  await page.locator('.gate h1', { hasText: 'Set up this desktop' }).waitFor({ timeout: 20000 });
  await page.getByLabel('Your name').fill('Sample Owner');
  await page.locator('.gate input.gate-input').last().fill(PASS);
  await page.locator('.gate-encrypt').uncheck();
  await page.locator('.gate-go').click();
  await page.locator('.gate h1', { hasText: 'Your recovery key' }).waitFor({ timeout: 30000 });
  await page.locator('.gate .check-row input').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#desktop .item').first().waitFor({ timeout: 20000 });
});

const dir = tempDir('tomlinos-audit-pdf-');
await step('upload the test PDFs into Documents', async () => {
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes);
  const w = await documents();
  const chooser = page.waitForEvent('filechooser');
  await w.getByRole('button', { name: 'Upload' }).click();
  (await chooser).setFiles(Object.keys(files).map(n => join(dir, n)));
  for (const n of Object.keys(files)) await w.locator('.item', { hasText: n.replace('.pdf', '') }).first().waitFor({ timeout: 15000 });
});

await step('pages: Page Down, Page Up, End, Home and the buttons move through the document', async () => {
  const v = await openPdf('three');
  eq(await status(v), 'Page 1 of 3', 'status');
  ok((await v.locator('[data-pdf-text]').textContent()).includes('Page 1'), 'text of page 1');
  await page.keyboard.press('PageDown');
  await settle(v);
  eq(await status(v), 'Page 2 of 3', 'after Page Down');
  await page.keyboard.press('End');
  await settle(v);
  eq(await status(v), 'Page 3 of 3', 'after End');
  ok(await v.getByRole('button', { name: 'Next page' }).isDisabled(), 'Next disabled on the last page');
  await page.keyboard.press('Home');
  await settle(v);
  eq(await status(v), 'Page 1 of 3', 'after Home');
});

await step('FAULT (P1, fixed): typing a page number out of range in the page box shows the page actually shown', async () => {
  const v = await openPdf('three');
  const box = v.getByLabel('Page number');
  await box.fill('0');
  await box.press('Enter');
  await settle(v);
  eq(await box.inputValue(), '1', 'box after typing 0 on page 1');
  await page.keyboard.press('End');
  await box.fill('99');
  await box.press('Enter');
  await settle(v);
  eq(await box.inputValue(), '3', 'box after typing 99 on page 3');
});

await step('1200 pages: opens, End goes to the last page', async () => {
  const t0 = Date.now();
  const v = await openPdf('many');
  eq(await status(v), 'Page 1 of 1200', 'status');
  await v.locator('canvas').click();
  await page.keyboard.press('End');
  await settle(v);
  eq(await status(v), 'Page 1200 of 1200', 'status after End');
  console.log('       (opened and went to the end in ' + (Date.now() - t0) + ' ms)');
});

await step('a turned page (Rotate 90) is drawn wider than tall', async () => {
  const v = await openPdf('rotated');
  const size = await v.locator('canvas').evaluate(c => [c.width, c.height]);
  ok(size[0] > size[1], `canvas ${size}`);
});

await step('a huge page (200 x 200 inches) and a tiny one draw without hanging', async () => {
  let v = await openPdf('huge');
  eq(await status(v), 'Page 1 of 1', 'huge status');
  await closeAll();
  v = await openPdf('tiny');
  eq(await status(v), 'Page 1 of 1', 'tiny status');
  const w = await v.locator('canvas').evaluate(c => c.getBoundingClientRect().width);
  console.log(`       (a 20 pt page fits the width at ${Math.round(w)} css px)`);
});

await step('a damaged, a non-PDF and an encrypted file each say why, without hanging', async () => {
  let v = await openPdf('cutoff');
  console.log('       cutoff: ' + (await v.innerText()).replace(/\s+/g, ' ').slice(0, 160));
  await closeAll();
  v = await openPdf('notpdf');
  ok((await v.innerText()).includes('does not look like a PDF'), 'not-PDF message');
  await closeAll();
  v = await openPdf('locked');
  ok(/password|encrypted/i.test(await v.innerText()), 'encrypted message');
});

await step('FAULT: a zero-width line (the thinnest line, common in drawings) can be seen', async () => {
  const v = await openPdf('hairline');
  // Count clearly blue pixels along the diagonal.
  const blue = await v.locator('canvas').evaluate(c => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 2] > 200 && d[i] < 150 && d[i + 1] < 150) n++;
    return n;
  });
  ok(blue > 200, `only ${blue} blue pixels on the line`);
});

await step('FAULT: a filled-in form shows the value typed into its field', async () => {
  const v = await openPdf('form');
  const text = await v.locator('[data-pdf-text]').textContent();
  ok(text.includes('Jane Smith'), `page text is "${text}"`);
});

await step('FAULT: resizing the window while a busy page draws leaves the page drawn correctly', async () => {
  const v = await openPdf('busy');
  await settle(v);
  const clean = await canvasHash(v);
  await shot('busy-clean');
  // The drawing is repeatable: Fit width redraws it the same when nothing interrupts it.
  await v.getByRole('button', { name: 'Fit width' }).click();
  await settle(v);
  await page.waitForTimeout(500);
  eq(await canvasHash(v), clean, 'a second, uninterrupted drawing');
  // Drag the window narrower and back a few times, as a person resizing it does; each change redraws the page.
  const original = await v.evaluate(el => el.style.width);
  for (let i = 0; i < 6; i++) {
    await v.evaluate((el, w) => { el.style.width = w; }, i % 2 ? '700px' : '660px');
    await page.waitForTimeout(40 + i * 15);
  }
  await v.evaluate((el, w) => { el.style.width = w; }, original);
  await page.waitForTimeout(300);
  await settle(v);
  await page.waitForTimeout(300);
  const after = await canvasHash(v);
  await shot('busy-after-resize');
  eq(after, clean, 'canvas after resizing back');
});

await step('FAULT: turning pages quickly through busy pages leaves the last one drawn correctly', async () => {
  const v = await openPdf('busy');
  await settle(v);
  const page1 = await canvasHash(v);
  await v.locator('canvas').click();
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press(i % 2 ? 'PageUp' : 'PageDown');
    await page.waitForTimeout(25 + i * 10);
  }
  await settle(v);
  await page.waitForTimeout(300);
  eq(await status(v), 'Page 1 of 2', 'back on page 1');
  eq(await canvasHash(v), page1, 'page 1 drawn as before');
});

await step('a small window (320 x 240): the page and the toolbar still fit', async () => {
  const v = await openPdf('three');
  await v.evaluate(el => { el.style.width = '320px'; el.style.height = '240px'; });
  await page.waitForTimeout(400);
  await settle(v);
  const r = await v.evaluate(el => {
    const bar = el.querySelector('.toolbar').getBoundingClientRect();
    const win = el.getBoundingClientRect();
    const buttons = [...el.querySelectorAll('.toolbar button, .toolbar input')].map(b => b.getBoundingClientRect()).filter(b => b.right > win.right + 1 || b.width === 0).length;
    return { hidden: buttons, bar: bar.width, win: win.width, canvas: el.querySelector('canvas').getBoundingClientRect().width };
  });
  await shot('small-window');
  eq(r.hidden, 0, `toolbar controls cut off (${JSON.stringify(r)})`);
});

await step('FAULT (P1, fixed): Ctrl+F finds words in the PDF, as every PDF viewer does', async () => {
  const v = await openPdf('three');
  await v.locator('canvas').click();
  await page.keyboard.press('Control+f');
  const field = v.getByLabel('Find in the PDF');
  await field.waitFor({ timeout: 3000 });
  ok(await field.evaluate(el => el === document.activeElement), 'the find box has the cursor');
  const note = v.locator('.find-note');
  const current = v.locator('[data-pdf-mark="current"]');
  // "page" is on all three pages: Enter goes from match to match, Shift+Enter back.
  await field.fill('PAGE');
  await field.press('Enter');
  await note.filter({ hasText: '1 of 3' }).waitFor({ timeout: 10000 });
  await current.first().waitFor({ timeout: 5000 });
  eq(await status(v), 'Page 1 of 3', 'first match on page 1');
  // The mark sits on the words "Page 1", drawn 72 pt from the left and 92 pt from the top of a 612 x 792 page.
  const where = await v.evaluate(el => {
    const c = el.querySelector('canvas.pdf-canvas').getBoundingClientRect();
    const m = el.querySelector('[data-pdf-mark="current"]').getBoundingClientRect();
    return { left: (m.left - c.left) / c.width, top: (m.top - c.top) / c.height, bottom: (m.bottom - c.top) / c.height, width: m.width / c.width };
  });
  ok(where.left > 0.09 && where.left < 0.14, `mark left at ${JSON.stringify(where)}`);
  ok(where.top > 0.05 && where.top < 0.12 && where.bottom > 0.1 && where.bottom < 0.16, `mark top at ${JSON.stringify(where)}`);
  ok(where.width > 0.05 && where.width < 0.25, `mark width ${JSON.stringify(where)}`);
  await field.press('Enter');
  await note.filter({ hasText: '2 of 3' }).waitFor({ timeout: 5000 });
  await settle(v);
  eq(await status(v), 'Page 2 of 3', 'Enter goes to page 2');
  await current.first().waitFor({ timeout: 5000 });
  await field.press('Shift+Enter');
  await note.filter({ hasText: '1 of 3' }).waitFor({ timeout: 5000 });
  await settle(v);
  eq(await status(v), 'Page 1 of 3', 'Shift+Enter goes back to page 1');
  // F3 from the page (the menu's Find next) goes on to the next one.
  await v.locator('canvas').click();
  await page.keyboard.press('F3');
  await note.filter({ hasText: '2 of 3' }).waitFor({ timeout: 5000 });
  // A word not there says so plainly, and leaves no marks.
  await field.fill('zebra');
  await field.press('Enter');
  await note.filter({ hasText: 'Not found' }).waitFor({ timeout: 5000 });
  eq(await v.locator('[data-pdf-mark]').count(), 0, 'no marks for a word not there');
  // Escape closes the bar and takes the marks away.
  await field.fill('page 3');
  await field.press('Enter');
  await current.first().waitFor({ timeout: 5000 });
  await settle(v);
  eq(await status(v), 'Page 3 of 3', '"page 3" found on page 3');
  await field.press('Escape');
  ok(await v.locator('.find-bar').isHidden(), 'Escape closes the find bar');
  eq(await v.locator('[data-pdf-mark]').count(), 0, 'no marks after Escape');
});

await step('Find in a PDF with no words (a drawing or scanned pages) says there is nothing to search', async () => {
  const v = await openPdf('hairline');
  await v.locator('canvas').click();
  await page.keyboard.press('Control+f');
  const field = v.getByLabel('Find in the PDF');
  await field.fill('anything');
  await field.press('Enter');
  await v.locator('.find-note', { hasText: 'no words to search' }).waitFor({ timeout: 5000 });
});

/** Swaps the browser's print box for a look at what would be printed, taken while it would be on paper. */
async function stubPrint() {
  await page.evaluate(() => {
    window.__printed = null;
    window.print = () => {
      const holder = document.querySelector('body > .sheet-print');
      window.__printed = {
        printing: document.body.classList.contains('printing-sheet'),
        pages: holder ? [...holder.querySelectorAll('.print-sheet-page')].map(p => {
          const img = p.querySelector('img');
          return { blob: img.src.startsWith('blob:'), loaded: img.complete && img.naturalWidth > 0, w: img.style.width, h: img.style.height, cls: p.className };
        }) : [],
        rules: document.adoptedStyleSheets.flatMap(s => [...s.cssRules].map(r => r.cssText)).join('\n'),
      };
    };
  });
}

await step('FAULT (P1, fixed): the viewer has a way to print the PDF (CAD tells the person to print its PDFs at 100%)', async () => {
  const v = await openPdf('three');
  await stubPrint();
  await v.getByRole('menuitem', { name: 'File' }).click();
  await page.getByRole('menuitem', { name: /Print/ }).first().click();
  await page.waitForFunction(() => window.__printed, null, { timeout: 15000 });
  const p = await page.evaluate(() => window.__printed);
  ok(p.printing, 'the page is in printing mode while the print box is up');
  eq(p.pages.length, 3, 'one printed page per PDF page');
  for (const pg of p.pages) {
    ok(pg.blob && pg.loaded, `each page is a loaded picture (${JSON.stringify(pg)})`);
    eq([pg.w, pg.h], ['612pt', '792pt'], 'printed at the page\'s own size');
  }
  ok(/@page pdf-size-0\s*\{[^}]*size:\s*612pt 792pt[^}]*margin:\s*0/.test(p.rules), `paper size from the PDF, no margin: ${p.rules}`);
  ok(/pdf-print-size-0[^{]*\{\s*page:\s*pdf-size-0/.test(p.rules), `pages use that paper: ${p.rules}`);
  // Afterwards everything printing added is gone.
  await page.waitForFunction(() => !document.querySelector('body > .sheet-print') && !document.body.classList.contains('printing-sheet') && document.adoptedStyleSheets.length === 0, null, { timeout: 5000 });
  eq(await status(v), 'Page 1 of 3', 'status back after printing');
});

await step('Ctrl+P prints a turned page on turned paper', async () => {
  const v = await openPdf('rotated');
  await stubPrint();
  await v.locator('canvas').click();
  await page.keyboard.press('Control+p');
  await page.waitForFunction(() => window.__printed, null, { timeout: 15000 });
  const p = await page.evaluate(() => window.__printed);
  eq(p.pages.length, 1, 'one page');
  eq([p.pages[0].w, p.pages[0].h], ['792pt', '612pt'], 'turned page size');
  ok(/size:\s*792pt 612pt/.test(p.rules), `turned paper: ${p.rules}`);
});

await browser.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log('  - ' + f);
process.exit(failures.length ? 1 : 0);
