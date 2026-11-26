// Audit of Write in a real Chrome: find, replace, clear formatting, tables, undo of page setup, paste from outside
// (a Word list, a code block, plain lines), the unsaved question, small windows and the keyboard. Each step states
// what a word processor should do; a FAIL is a finding.
// Needs the dev server on a FRESH, EMPTY data folder (the first step sets up the owner), and out/ built.
//   node test/browser-audit-write.mjs [http://127.0.0.1:3106] [screenshot folder]
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3106';
const SHOTS = process.argv[3] ?? null;
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PASS = 'write-audit-passphrase-73';
let passed = 0;
const failures = [];
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true, locale: 'en-GB' });
const page = await context.newPage();
page.setDefaultTimeout(10000);
const problems = [];
page.on('console', m => m.type() === 'error' && problems.push('console: ' + m.text() + ' ' + (m.location()?.url ?? '')));
page.on('response', r => r.status() >= 400 && problems.push('http ' + r.status() + ' ' + new URL(r.url()).pathname));
page.on('pageerror', e => problems.push('pageerror: ' + e.message));
const shot = async name => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });
async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (error) {
    failures.push(name);
    await shot('fail-' + failures.length).catch(() => {});
    console.log('  FAIL ' + name + '\n       ' + String(error.message).slice(0, 800));
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
const rb = name => W().locator('.ribbon .rb').filter({ hasText: new RegExp(`^${name}$`) });
const settle = () => page.waitForTimeout(350);
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
  await openApp('write');
  await doc().waitFor();
  await W().locator('.wp-furniture').waitFor({ state: 'attached' });
  await doc().click();
};
/** Puts text in the editor as one paragraph per line, through a paste of plain text. */
const pastePlain = text => doc().evaluate((el, t) => {
  const dt = new DataTransfer();
  dt.setData('text/plain', t);
  el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
}, text);
const pasteHtml = (html, plain) => doc().evaluate((el, [h, t]) => {
  const dt = new DataTransfer();
  dt.setData('text/html', h);
  dt.setData('text/plain', t);
  el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
}, [html, plain]);
const selectedText = () => page.evaluate(() => String(getSelection()));

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

// The steps below drive the ribbon. New desktops start Write in the Classic look, so View > Modern (ribbon) first
// (kept for this person, so every window after this one has the ribbon).
await step('Write starts in the Classic look; View > Modern (ribbon) brings the ribbon for the steps below', async () => {
  await openApp('write');
  await W().locator('.cbar-title[data-menu="View"]').waitFor({ timeout: 20000 });
  ok(!(await W().locator('.ribbon').isVisible()), 'no ribbon at first');
  await W().locator('.cbar-title[data-menu="View"]').click();
  await page.locator('.menu-item', { hasText: 'Modern (ribbon)' }).click();
  await W().locator('.ribbon').waitFor();
  ok(!(await W().locator('.cbar').count()), 'the menu bar is gone');
  await closeAllWrite();
});

await step('W-P0-1 find: Enter from the top goes to the first place found (the one marked current), not the second', async () => {
  await newDoc();
  await page.keyboard.type('apple one. apple two. apple three.');
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Control+F');
  await page.keyboard.type('apple');
  await settle();
  eq(await W().locator('.wp-find-count').innerText(), '1 of 3', 'count before Enter');
  await page.keyboard.press('Enter');
  await settle();
  // The first press should choose the first "apple" (the one already marked as current, "1 of 3").
  eq(await W().locator('.wp-find-count').innerText(), '1 of 3', 'count after the first Enter');
  const at = await page.evaluate(() => {
    const s = getSelection();
    const r = s.getRangeAt(0);
    const pre = document.createRange();
    pre.selectNodeContents(document.querySelector('.win .wp-doc'));
    pre.setEnd(r.startContainer, r.startOffset);
    return pre.toString().length;
  });
  eq(at, 0, 'the chosen "apple" starts at the beginning');
  await page.keyboard.press('Escape');
});

await step('W-P0-2 Clear formatting keeps a link (it takes the look off, not the address)', async () => {
  await newDoc();
  await page.keyboard.type('See ');
  await page.keyboard.press('Control+K');
  await D().locator('input').fill('https://example.org/');
  await D().getByRole('button', { name: 'Link' }).click();
  await settle();
  eq(await doc().locator('a[href="https://example.org/"]').count(), 1, 'link made');
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Control+B');
  await page.keyboard.press('Control+Space');
  await settle();
  eq(await doc().locator('strong').count(), 0, 'bold cleared');
  eq(await doc().locator('a[href="https://example.org/"]').count(), 1, 'the link is still there after Clear formatting');
});

await step('W-P1 Tab in the last cell of a table adds a row (as Word does) instead of typing a tab', async () => {
  await newDoc();
  await tab('Insert');
  await rb('▦ Table').click();
  await D().getByRole('button', { name: 'OK' }).click();
  await settle();
  const cells = await doc().locator('td').count();
  for (let i = 0; i < cells; i++) await page.keyboard.press('Tab');
  await settle();
  ok((await doc().locator('td').count()) > cells, `cells: ${cells} before, ${await doc().locator('td').count()} after Tab in the last cell`);
});

await step('W-P1-1 Undo (Ctrl+Z) undoes a page setup change (landscape), and Redo brings it back', async () => {
  await newDoc();
  await page.keyboard.type('Words');
  await page.waitForTimeout(700);
  const w0 = await W().locator('.wp-paper').evaluate(el => el.offsetWidth);
  await tab('Layout');
  await W().locator('.ribbon .rb', { hasText: 'Orientation' }).click();
  await page.locator('.menu').getByText('Landscape (wide)').click();
  await settle();
  const w1 = await W().locator('.wp-paper').evaluate(el => el.offsetWidth);
  ok(w1 > w0, 'landscape is wider');
  await doc().focus();
  await page.keyboard.press('Control+Z');
  await settle();
  const w2 = await W().locator('.wp-paper').evaluate(el => el.offsetWidth);
  eq({ text: await doc().innerText(), width: w2 }, { text: 'Words', width: w0 }, 'Ctrl+Z after landscape');
  await page.keyboard.press('Control+Y');
  await settle();
  const w3 = await W().locator('.wp-paper').evaluate(el => el.offsetWidth);
  eq({ text: await doc().innerText(), width: w3 }, { text: 'Words', width: w1 }, 'Ctrl+Y after that');
});

await step('W-P1 a list pasted from Word (MsoListParagraph) comes in as a list, not paragraphs starting "·"', async () => {
  await newDoc();
  const html = '<html><body><p class=MsoListParagraphCxSpFirst style="text-indent:-18.0pt;mso-list:l0 level1 lfo1"><![if !supportLists]><span style="font-family:Symbol">·<span style="font:7.0pt Times New Roman">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; </span></span><![endif]>First</p>'
    + '<p class=MsoListParagraphCxSpLast style="text-indent:-18.0pt;mso-list:l0 level1 lfo1"><![if !supportLists]><span style="font-family:Symbol">·<span style="font:7.0pt Times New Roman">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; </span></span><![endif]>Second</p></body></html>';
  await pasteHtml(html, '·       First\n·       Second');
  await settle();
  const info = await doc().evaluate(el => ({ li: el.querySelectorAll('li').length, text: el.innerText }));
  eq(info.li, 2, 'list items (text was ' + JSON.stringify(info.text) + ')');
});

await step('W-P1 a code block pasted from a web page keeps its lines', async () => {
  await newDoc();
  await pasteHtml('<pre><code>line one\nline two\n  indented</code></pre>', 'line one\nline two\n  indented');
  await settle();
  const t = await doc().innerText();
  ok(/line one\s*\n+\s*line two/.test(t), 'lines kept: ' + JSON.stringify(t));
});

await step('plain text pasted: each line its own paragraph, and undo takes the whole paste back in one step', async () => {
  await newDoc();
  await pastePlain('one\ntwo\nthree');
  await settle();
  const n = await doc().locator('p').count();
  ok(n >= 3, 'paragraphs: ' + n);
  await page.keyboard.press('Control+Z');
  await settle();
  eq((await doc().innerText()).trim(), '', 'one undo empties it');
});

await step('Replace all "a" with "aa" doubles each, once, and one Ctrl+Z takes it back', async () => {
  await newDoc();
  await page.keyboard.type('a b a b a');
  await page.waitForTimeout(700);
  await page.keyboard.press('Control+H');
  await W().locator('input[aria-label="Find"]').fill('a');
  await W().locator('input[aria-label="Replace with"]').fill('aa');
  await W().getByRole('button', { name: 'Replace all' }).click();
  await settle();
  eq(await doc().innerText(), 'aa b aa b aa', 'replaced');
  await doc().focus();
  await page.keyboard.press('Control+Z');
  await settle();
  eq(await doc().innerText(), 'a b a b a', 'undone in one step');
});

await step('Replace one at a time walks through every place and replaces each once', async () => {
  await newDoc();
  await page.keyboard.type('cat dog cat dog cat');
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Control+H');
  await W().locator('input[aria-label="Find"]').fill('cat');
  await W().locator('input[aria-label="Replace with"]').fill('cow');
  const button = W().getByRole('button', { name: 'Replace', exact: true });
  for (let i = 0; i < 8; i++) await button.click();
  await settle();
  eq(await doc().innerText(), 'cow dog cow dog cow', 'every cat');
});

await step('W-P1 closing with unsaved changes offers Save (not only Close without saving / Keep it open)', async () => {
  await newDoc();
  await page.keyboard.type('unsaved words');
  await W().getByRole('button', { name: 'Close', exact: true }).first().click();
  await D().waitFor();
  const buttons = await D().locator('button').allInnerTexts();
  await page.keyboard.press('Escape');
  ok(buttons.some(b => /^Save/.test(b.trim())), 'buttons: ' + JSON.stringify(buttons));
});

await step('W-P1 the word count of a selection (Word shows "12 of 340 words")', async () => {
  await newDoc();
  await page.keyboard.type('one two three four five');
  await page.keyboard.press('Shift+Home');
  await settle();
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Control+Shift+ArrowRight');
  await settle();
  const s = await W().locator('.wp-status').innerText();
  ok(/of 5 words/.test(s), 'status: ' + JSON.stringify(s));
});

await step('a narrow window (420 px): the ribbon does not push the window wider, and the page is still reachable', async () => {
  await newDoc();
  await page.keyboard.type('Narrow window words');
  await page.setViewportSize({ width: 420, height: 700 });
  await page.waitForTimeout(600);
  const m = await W().evaluate(win => {
    const r = win.getBoundingClientRect();
    const rib = win.querySelector('.ribbon');
    const tabs = win.querySelector('.ribbon-tabs');
    const status = win.querySelector('.wp-status');
    const sr = status.getBoundingClientRect();
    return { winRight: r.right, vw: innerWidth, ribScroll: rib.scrollWidth, ribClient: rib.clientWidth, tabsScroll: tabs.scrollWidth, tabsClient: tabs.clientWidth, statusVisible: sr.bottom <= innerHeight + 1 && sr.height > 0, ribOverflow: getComputedStyle(rib).overflowX, tabsOverflow: getComputedStyle(tabs).overflowX };
  });
  await shot('narrow');
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForTimeout(300);
  ok(m.winRight <= m.vw + 1, 'window inside the screen ' + JSON.stringify(m));
  ok(m.statusVisible, 'status bar visible ' + JSON.stringify(m));
  ok(m.tabsScroll <= m.tabsClient + 1 || m.tabsOverflow !== 'visible', 'tabs row clipped or scrolls ' + JSON.stringify(m));
  console.log('       narrow metrics', JSON.stringify(m));
});

await step('W-P1 the keyboard can reach the File menu and the ribbon from the page (F10 or Alt, as in Word)', async () => {
  await newDoc();
  await page.keyboard.press('F10');
  await settle();
  const a = await page.evaluate(() => document.activeElement?.className + ' ' + document.activeElement?.textContent?.slice(0, 20));
  ok(!/wp-doc/.test(a), 'focus after F10: ' + a);
});

await step('Escape in the page (find open, the cursor in the text) closes the find bar', async () => {
  await newDoc();
  await page.keyboard.type('find me');
  await page.keyboard.press('Control+F');
  await page.keyboard.type('me');
  await doc().click();
  await page.keyboard.press('Escape');
  await settle();
  ok(await W().locator('.wp-find-panel').isHidden(), 'find bar still open after Escape in the text');
});

await step('a table inserted inside a table cell (a nested table, as Word allows)', async () => {
  await newDoc();
  await tab('Insert');
  await rb('▦ Table').click();
  await D().getByRole('button', { name: 'OK' }).click();
  await settle();
  await tab('Insert');
  await rb('▦ Table').click();
  await D().getByRole('button', { name: 'OK' }).click();
  await settle();
  const nested = await doc().locator('td table').count();
  console.log('       nested tables:', nested);
});

await step('Select all and delete, then one undo brings everything back', async () => {
  await newDoc();
  await pastePlain(Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1} of the text`).join('\n'));
  await settle();
  const before = await doc().innerText();
  await page.waitForTimeout(700);
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(700);
  await page.keyboard.press('Control+Z');
  await settle();
  eq(await doc().innerText(), before, 'all back');
});

await step('a long document (3,000 paragraphs): a key typed in the middle shows within 150 ms', async () => {
  await newDoc();
  await pastePlain(Array.from({ length: 3000 }, (_, i) => `Paragraph ${i + 1}: the quick brown fox jumps over the lazy dog again and again.`).join('\n'));
  await page.waitForTimeout(2500);
  const times = [];
  for (let i = 0; i < 5; i++) {
    const t = await page.evaluate(async () => {
      const el = document.querySelector('.win .wp-doc');
      const t0 = performance.now();
      el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'x', bubbles: true, cancelable: true }));
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      return performance.now() - t0;
    });
    times.push(Math.round(t));
  }
  const pages = await W().locator('.wp-status').innerText();
  console.log('       key times ms', times.join(', '), pages);
  ok(Math.max(...times.slice(1)) < 150, 'times ' + times.join(', '));
});


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

await step('W-P0-3 a paragraph that is just "---" survives Save as Markdown and opening it again', async () => {
  await newDoc();
  await pastePlain('Above the line\n---\nBelow the line');
  await page.waitForTimeout(400);
  await saveAs('dashes.md');
  const confirm = D().getByRole('button', { name: 'Save as Markdown' });
  if (await confirm.waitFor({ timeout: 1500 }).then(() => true, () => false)) throw new Error('Save asked about losses for plain words');
  await page.locator('.toast', { hasText: 'Saved' }).last().waitFor({ timeout: 15000 });
  await closeAllWrite();
  await openApp('write');
  await doc().waitFor();
  await reopen('dashes.md');
  await page.waitForTimeout(600);
  for (let i = 0; i < 2 && (await page.locator('.dialog').count()); i++) await D().getByRole('button', { name: 'OK' }).click().catch(() => {});
  const t = await W().locator('.wp-doc').innerText();
  ok(/^---$/m.test(t), 'text after reopening: ' + JSON.stringify(t));
});

await step('W-P1-9 Save as "notes.rtf" says Write cannot save .rtf and offers "notes.docx" (never a silent "notes.rtf.docx")', async () => {
  await newDoc();
  await page.keyboard.type('rtf name');
  await saveAs('notes.rtf');
  const ask = D();
  await ask.filter({ hasText: 'cannot save .rtf' }).waitFor({ timeout: 5000 });
  await ask.getByRole('button', { name: 'Save as “notes.docx”' }).click();
  const t = await page.locator('.toast', { hasText: 'Saved' }).last().innerText({ timeout: 15000 });
  ok(/Saved “notes\.docx”/.test(t) && !/notes.rtf.docx/.test(t), 'toast: ' + t);
});

await step('W-P1-9 Cancel on that question saves nothing', async () => {
  await newDoc();
  await page.keyboard.type('odt name');
  await saveAs('other.odt');
  await D().filter({ hasText: 'cannot save .odt' }).getByRole('button', { name: 'Cancel' }).click();
  await settle();
  ok(!(await page.locator('.toast', { hasText: 'other.' }).count()), 'a Saved toast for other.*');
  ok(!(await W().innerText()).includes('other.'), 'the window is still unnamed');
});

await step('no errors in the console', async () => {
  eq(problems.filter(p => !/favicon|store.php/.test(p)), [], 'console (the setup screen asks /api/store.php?key=/ once and gets 404: not Write)');
});

console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? ': ' + failures.join(' | ') : ''}`);
await browser.close();
process.exit(failures.length ? 1 : 0);
