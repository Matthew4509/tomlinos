// Drives the Archive opener, Notepad and the Calculator in a real Chrome. Needs the dev server on a FRESH, EMPTY data
// folder (the first step sets up the owner), and `npm run build` done.
//   node test/browser-apps.mjs [http://127.0.0.1:3047] [screenshot folder]
import { chromium } from 'playwright-core';
import { HIDDEN_APPS } from '../src/release.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { startFakeMail, USER as MAIL_USER, PASS as MAIL_PASS } from './fake-mail.mjs';
import { startFakeAnthropic, KEY as AI_KEY } from './fake-anthropic.mjs';
import { startFakeHuggingFace, SHARD_BYTES } from './fake-huggingface.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3047';
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
    console.log('  FAIL ' + name + '\n       ' + String(error.message).slice(0, 1200));
  }
}
const eq = (a, b, what) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const ok = (v, what) => {
  if (!v) throw new Error(what);
};

/** A small real zip: a folder, a deflated file, a stored file, and a name that tries to climb out. */
function makeZip() {
  const files = [['docs/', ''], ['docs/readme.txt', 'Hello from inside the zip.\r\nSecond line.\r\n'], ['top.txt', 'top'], ['../escape.txt', 'no']];
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of files) {
    const nameBuf = Buffer.from(name);
    const raw = Buffer.from(text);
    const deflate = name === 'docs/readme.txt';
    const data = deflate ? deflateRawSync(raw) : raw;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(deflate ? 8 : 0, 8);
    head.writeUInt32LE(0, 14); // CRC not checked by the opener
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(raw.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    locals.push(head, nameBuf, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(deflate ? 8 : 0, 10);
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
const problems = [];
page.on('console', m => m.type() === 'error' && problems.push('console: ' + m.text()));
page.on('pageerror', e => problems.push('pageerror: ' + e.message));
const shot = async name => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });
const openApp = async label => {
  await page.locator('.start-btn').click();
  // Most apps sit in groups: find it by name in the Start menu's search box, as a person would.
  await page.locator('.start-filter').fill(label);
  await page.locator(`.start-menu [data-label="${label}"]`).first().click();
};
const front = () => page.locator('.win.active');
const closeFront = () => front().getByRole('button', { name: 'Close' }).click();
/** Closes every window, answering "not saved" questions with close-without-saving, until none is left. */
async function closeAll() {
  for (let i = 0; i < 40; i++) {
    const dialog = page.locator('.dialog');
    if (await dialog.count()) {
      await dialog.getByRole('button', { name: /without saving|Lose the changes|Close anyway/ }).first().click().catch(() => dialog.getByRole('button').last().click());
      continue;
    }
    const wins = page.locator('.win');
    if (!(await wins.count())) return;
    await wins.last().locator('.win-close').first().click();
    await page.waitForTimeout(80);
  }
  throw new Error('windows would not close');
}

console.log('Archive opener, Notepad, Calculator, against ' + BASE);
await page.goto(BASE);

await step('set up the owner', async () => {
  await page.locator('.gate h1', { hasText: 'Set up this desktop' }).waitFor({ timeout: 20000 });
  await page.getByLabel('Your name').fill('Sample Owner');
  await page.locator('.gate input.gate-input').last().fill(PASS);
  // "Encrypt my files" starts ticked; this owner opts out, so the Chat steps below see "Not end to end".
  ok(await page.locator('.gate-encrypt').isChecked(), 'encryption is ticked by default');
  await page.locator('.gate-encrypt').uncheck();
  await page.locator('.gate-go').click();
  await page.locator('.gate h1', { hasText: 'Your recovery key' }).waitFor({ timeout: 30000 });
  await page.locator('.gate .check-row input').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#desktop .item').first().waitFor({ timeout: 20000 });
});

const dir = mkdtempSync(join(tmpdir(), 'tomlinos-apps2-'));
await step('upload a zip and a Windows (CRLF) text file into Documents', async () => {
  writeFileSync(join(dir, 'bundle.zip'), makeZip());
  writeFileSync(join(dir, 'windows.txt'), 'alpha\r\nbeta cat\r\ngamma Cat\r\n');
  await page.keyboard.press('Control+Alt+e');
  const w = front();
  await w.locator('.item', { hasText: 'Documents' }).first().dblclick();
  const chooser = page.waitForEvent('filechooser');
  await w.getByRole('button', { name: 'Upload' }).click();
  (await chooser).setFiles([join(dir, 'bundle.zip'), join(dir, 'windows.txt')]);
  await w.locator('.item', { hasText: 'bundle' }).first().waitFor({ timeout: 10000 });
  await w.locator('.item', { hasText: 'windows' }).first().waitFor({ timeout: 10000 });
});

await step('Archive opener: lists the zip, the climbing name is cleaned, a folder opens', async () => {
  const explorer = front();
  await explorer.locator('.item', { hasText: 'bundle' }).first().dblclick();
  const a = page.locator('.win', { has: page.locator('.archive') });
  await a.locator('.archive-row').first().waitFor({ timeout: 10000 });
  eq(await a.locator('.archive-name').allInnerTexts(), ['docs', 'escape.txt', 'top.txt'], 'top level');
  await a.locator('.archive-row', { hasText: 'docs' }).dblclick();
  eq(await a.locator('.archive-name').allInnerTexts(), ['readme.txt'], 'inside docs');
  await a.getByRole('button', { name: 'Up one folder' }).click();
  await shot('archive');
});

await step('Archive opener: Extract all makes a "bundle" folder holding the files', async () => {
  const a = page.locator('.win', { has: page.locator('.archive') });
  await a.getByRole('button', { name: /Extract all/ }).click();
  const dialog = page.locator('.dialog');
  eq(await dialog.locator('input').inputValue(), 'bundle', 'suggested name');
  await dialog.getByRole('button', { name: 'Extract' }).click();
  await page.locator('.toast', { hasText: 'Extracted 3 files into “bundle”' }).waitFor({ timeout: 10000 });
  await a.getByRole('button', { name: 'Close' }).click();
  const w = front();
  await w.locator('.item', { hasText: /^bundle$/ }).first().dblclick();
  await w.locator('.item', { hasText: 'docs' }).first().dblclick();
  await w.locator('.item', { hasText: 'readme' }).first().dblclick();
  const area = page.locator('.editor textarea');
  await page.waitForFunction(() => document.querySelector('.editor textarea')?.value.length > 0);
  eq(await area.inputValue(), 'Hello from inside the zip.\nSecond line.\n', 'extracted text');
  await closeFront();
});

await step('Notepad: a CRLF file says so; find, match case, replace all, go to line; CRLF kept on save', async () => {
  await closeFront();
  await page.keyboard.press('Control+Alt+e');
  await front().locator('.item', { hasText: 'Documents' }).first().dblclick();
  await front().locator('.item', { hasText: 'windows' }).first().dblclick();
  const n = page.locator('.win', { has: page.locator('.editor') });
  await page.waitForFunction(() => document.querySelector('.editor textarea')?.value.length > 0);
  const status = n.locator('.editor-status');
  ok((await status.innerText()).includes('Windows (CRLF)'), 'status shows CRLF: ' + (await status.innerText()));
  await page.keyboard.press('Control+h');
  await n.getByLabel('Find', { exact: true }).fill('cat');
  await n.getByLabel('Replace with').fill('dog');
  await n.getByRole('button', { name: 'Replace all' }).click();
  ok((await n.locator('.find-note').innerText()).includes('Replaced 2'), 'two replaced');
  await n.locator('textarea').press('Control+z');
  eq(await n.locator('textarea').inputValue(), 'alpha\nbeta cat\ngamma Cat\n', 'undo brings it back');
  await n.locator('.find-case input').check();
  await n.getByRole('button', { name: 'Replace all' }).click();
  eq(await n.locator('textarea').inputValue(), 'alpha\nbeta dog\ngamma Cat\n', 'match case');
  await page.keyboard.press('Escape');
  ok(await n.locator('.find-bar').isHidden(), 'find bar closes');
  await page.keyboard.press('Control+g');
  await page.locator('.dialog input').fill('3');
  await page.locator('.dialog').getByRole('button', { name: 'Go to' }).click();
  ok((await status.innerText()).startsWith('Ln 3, Col 1'), 'went to line 3: ' + (await status.innerText()));
  await page.keyboard.press('Control+=');
  ok((await status.innerText()).includes('110%'), 'zoomed');
  await shot('notepad');
  await page.keyboard.press('Control+s');
  await page.locator('.toast', { hasText: 'Saved “windows.txt”' }).waitFor();
  // Reopen: the endings are still CRLF (the size counts the \r characters: 26 letters + 3 × 2).
  await n.getByRole('button', { name: 'Close' }).click();
  await front().locator('.item', { hasText: 'windows' }).first().dblclick();
  await page.waitForFunction(() => document.querySelector('.editor textarea')?.value.length > 0);
  const again = await page.locator('.editor-status').innerText();
  ok(again.includes('Windows (CRLF)') && again.includes("28 bytes"), 'still CRLF after saving: ' + again);
  await closeFront();
});

await step('Calculator: × before + (2 + 3 × 4 = 14), keyboard too, ÷0 named', async () => {
  await openApp('calculator');
  const c = page.locator('.win', { has: page.locator('.calc') });
  const disp = c.locator('.calc-display');
  for (const k of ['2', '+', '3', '×', '4', '=']) await c.locator(`.calc-key[data-key="${k}"]`).click();
  eq(await disp.innerText(), '14', 'buttons');
  await c.locator('.calc-pad').focus();
  await page.keyboard.type('9/0');
  await page.keyboard.press('Enter');
  eq(await disp.innerText(), "Can't divide by 0", 'divide by 0');
  await page.keyboard.press('Escape');
  eq(await disp.innerText(), '0', 'cleared');
});

await step('Calculator sheet: Extend, type numbers, make =1 from A1 + B1 × A2, live update, → cell, loop refused', async () => {
  const c = page.locator('.win', { has: page.locator('.calc') });
  const before = (await c.boundingBox()).width;
  await c.getByRole('button', { name: /Extend/ }).click();
  await c.locator('.calc-sheet').waitFor();
  ok((await c.boundingBox()).width > before + 300, 'window widened');
  ok(await c.locator('.calc-row:not(.head)').count() >= 7, 'rows fill the height');
  const cellOf = id => c.locator(`[data-id="${id}"]`);
  await cellOf('L1').locator('input').fill('Rent');
  await cellOf('A1').locator('input').fill('2');
  await cellOf('B1').locator('input').fill('3');
  await cellOf('A2').locator('input').fill('4');
  const gleams = k => c.locator(`.calc-key[data-key="${k}"]`).evaluate(el => el.classList.contains('gleam'));
  await cellOf('R1').click();
  ok(await gleams('='), '= glows after choosing an = cell');
  await c.locator('.calc-key[data-key="="]').click();
  ok(!(await gleams('+')), 'no operator glows before a cell is clicked');
  await cellOf('A1').click();
  ok((await gleams('+')) && (await gleams('×')), 'operators glow after clicking a cell');
  await c.locator('.calc-key[data-key="+"]').click();
  ok(!(await gleams('+')), 'operators stop glowing once one is pressed');
  await cellOf('B1').click();
  await c.locator('.calc-key[data-key="×"]').click();
  await cellOf('A2').click();
  eq(await c.locator('.calc-display').innerText(), 'A1 + B1 × A2', 'display while making');
  ok(await cellOf('B1').evaluate(el => el.classList.contains('lit')), 'chosen cells light up');
  await shot('calc-making');
  await c.locator('.calc-key[data-key="="]').click();
  eq(await cellOf('R1').innerText(), '14', 'sum');
  await cellOf('A1').locator('input').fill('10');
  eq(await cellOf('R1').innerText(), '22', 'live');
  // A loop: =2 uses =1, then =1 tries to use =2.
  await cellOf('R2').click();
  await c.locator('.calc-key[data-key="="]').click();
  await cellOf('R1').click();
  await c.locator('.calc-key[data-key="="]').click();
  await cellOf('R1').click();
  await c.locator('.calc-key[data-key="="]').click();
  await cellOf('R2').click();
  await c.locator('.calc-key[data-key="="]').click();
  ok((await c.locator('.calc-note').innerText()).includes('loop'), 'loop refused: ' + (await c.locator('.calc-note').innerText()));
  await page.keyboard.press('Escape');
  eq(await cellOf('R1').innerText(), '22', 'unchanged after Esc');
  // → cell
  for (const k of ['7', '×', '6', '=']) await c.locator(`.calc-key[data-key="${k}"]`).click();
  await cellOf('B2').locator('input').click();
  await c.getByRole('button', { name: '→ cell' }).click();
  eq(await cellOf('B2').locator('input').inputValue(), '42', '→ cell');
  await shot('calc-sheet');
});

await step('Calculator sheet: saves as a .calc file in Documents and opens again with its sums', async () => {
  const c = page.locator('.win', { has: page.locator('.calc') });
  await c.getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('.dialog input').fill('Budget');
  await page.locator('.dialog').getByRole('button', { name: 'Save' }).click();
  await page.locator('.toast', { hasText: 'Saved “Budget.calc”' }).waitFor();
  await c.getByRole('button', { name: 'Close' }).click();
  await page.keyboard.press('Control+Alt+e');
  // File Explorer may still be open in Documents from an earlier step.
  if (!(await front().locator('.item', { hasText: 'Budget' }).count())) await front().locator('.item', { hasText: 'Documents' }).first().dblclick();
  await front().locator('.item', { hasText: 'Budget' }).first().dblclick();
  const again = page.locator('.win', { has: page.locator('.calc') });
  await again.locator('[data-id="R1"]').waitFor();
  eq(await again.locator('[data-id="R1"]').innerText(), '22', 'sum after reopening');
  eq(await again.locator('[data-id="L1"] input').inputValue(), 'Rent', 'label');
});

await step('Notepad Pro: the editor loads styled (no style-rule errors), colours Markdown, previews it safely', async () => {
  await closeAll();
  await openApp('notepad pro');
  const w = page.locator('.win', { has: page.locator('.npp') });
  await w.locator('.cm-content').waitFor({ timeout: 15000 });
  eq(await w.locator('.cm-editor').evaluate(el => getComputedStyle(el).display), 'flex', 'CodeMirror styles applied');
  await w.locator('.cm-content').click();
  await page.keyboard.type('# Plan\n\nSee [site](https://example.com) and [bad](javascript:alert(1)).\n\n<b onclick="x">raw</b>\n');
  await w.locator('.npp-lang').selectOption('markdown');
  await page.waitForTimeout(400);
  const pv = w.locator('.npp-preview');
  eq(await pv.locator('h1').innerText(), 'Plan', 'heading');
  eq(await pv.locator('a').count(), 1, 'only the https link is a link');
  eq(await pv.locator('b').count(), 0, 'HTML in the text is not made into elements');
  ok((await pv.innerText()).includes('<b onclick="x">raw</b>'), 'HTML shown as letters');
  await shot('npp-preview');
});

await step('Notepad Pro: Save as through the picker, tabs, bookmarks, Find in files, Replace in open files', async () => {
  const w = page.locator('.win', { has: page.locator('.npp') });
  await page.keyboard.press('Control+s');
  const dlg = page.locator('.dialog');
  await dlg.locator('input[aria-label="File name"]').fill('plan.md');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await page.locator('.toast', { hasText: 'Saved “plan.md”' }).waitFor();
  eq(await w.locator('.npp-tab.active .npp-tab-name').innerText(), 'plan.md', 'tab renamed');
  // A second tab, with a bookmark.
  await w.getByRole('button', { name: 'New', exact: true }).click();
  await w.locator('.cm-content').click();
  await page.keyboard.type('one Plan\ntwo\nthree plan');
  await page.keyboard.press('Control+F2');
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('F2');
  ok((await w.locator('.npp-status').innerText()).startsWith('Ln 3'), 'F2 jumps to the bookmark: ' + (await w.locator('.npp-status').innerText()));
  eq(await w.locator('.npp-tab').count(), 2, 'two tabs');
  // Find in files finds the saved file.
  await page.keyboard.press('Control+Shift+F');
  await w.locator('input[aria-label="Find in files"]').fill('plan');
  await w.getByRole('button', { name: 'Find all' }).click();
  await w.locator('.npp-found-path', { hasText: '/Documents/plan.md' }).waitFor();
  // Replace in all open tabs, match case off: "Plan" in both tabs, "plan" in the second.
  await w.locator('input[aria-label="Replace with"]').fill('Idea');
  await w.getByRole('button', { name: 'Replace in open files' }).click();
  await page.locator('.dialog').getByRole('button', { name: 'Replace all' }).click();
  ok((await w.locator('.npp-found-note').innerText()).includes('Replaced 3 matches in 2 tabs'), await w.locator('.npp-found-note').innerText());
  ok((await w.locator('.cm-content').innerText()).includes('three Idea'), 'second tab changed');
  // Closing a changed tab asks.
  await w.locator('.npp-tab.active .npp-tab-x').click();
  await page.locator('.dialog', { hasText: 'not saved' }).getByRole('button', { name: 'Close without saving' }).click();
  eq(await w.locator('.npp-tab').count(), 1, 'one tab left');
  await shot('npp-files');
});

await step('Open with lists Notepad and Notepad Pro for a text file', async () => {
  await page.keyboard.press('Control+Alt+e');
  const w = front();
  if (!(await w.locator('.item', { hasText: 'windows' }).count())) await w.locator('.item', { hasText: 'Documents' }).first().dblclick();
  await w.locator('.item', { hasText: 'windows' }).first().click({ button: 'right' });
  await page.locator('.menu-item', { hasText: 'Open with' }).hover();
  await page.locator('.menu-item', { hasText: 'Notepad Pro' }).click();
  const n = page.locator('.win.active', { has: page.locator('.npp') });
  await n.locator('.npp-tab-name', { hasText: 'windows.txt' }).waitFor({ timeout: 15000 });
  ok((await n.locator('.npp-status').innerText()).includes('Windows (CRLF)'), 'line endings read');
});

await step('Photo Editor: a new 300 × 200 picture, drawn on and saved as PNG in Pictures', async () => {
  await closeAll();
  await openApp('photo editor');
  const w = page.locator('.win', { has: page.locator('.pe') });
  await w.getByRole('button', { name: 'New...' }).click();
  await page.locator('.dialog input[aria-label="Width"]').fill('300');
  await page.locator('.dialog input[aria-label="Height"]').fill('200');
  await page.locator('.dialog').getByRole('button', { name: 'Create' }).click();
  ok((await w.locator('.pe-status').innerText()).includes('300 × 200'), 'new size');
  const box = await w.locator('.pe-over').boundingBox();
  await page.mouse.move(box.x + 10, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 10, box.y + box.height - 10, { steps: 6 });
  await page.mouse.up();
  ok(await w.getByRole('button', { name: 'Undo' }).isEnabled(), 'the stroke can be undone');
  await page.keyboard.press('Control+s');
  await page.locator('.dialog input[aria-label="File name"]').fill('sketch.png');
  await page.locator('.dialog').getByRole('button', { name: 'Save' }).click();
  await page.locator('.toast', { hasText: 'Saved “sketch.png”' }).waitFor();
  await w.getByRole('button', { name: 'Close' }).click();
});

await step('Pictures > Edit opens Photo Editor; rotate right makes it 200 × 300, and the saved file is too', async () => {
  await page.keyboard.press('Control+Alt+e');
  const x = front();
  await x.locator('.item', { hasText: 'Pictures' }).first().dblclick();
  await x.locator('.item', { hasText: 'sketch' }).first().dblclick();
  await page.locator('.photos .statusbar', { hasText: '300 × 200 pixels' }).waitFor({ timeout: 10000 });
  await page.locator('.win', { has: page.locator('.photos') }).getByRole('button', { name: 'Edit' }).click();
  const w = page.locator('.win', { has: page.locator('.pe') });
  await w.locator('.pe-status', { hasText: 'sketch.png' }).waitFor({ timeout: 10000 });
  await w.getByRole('button', { name: 'Rotate right' }).click();
  ok((await w.locator('.pe-status').innerText()).includes('200 × 300'), 'rotated');
  await page.keyboard.press('Control+s');
  // Not the toast: an earlier step's “Saved sketch.png” toast can still be showing on a busy machine, and closing
  // before this save lands asks about unsaved changes. The editor's own status says when it is saved.
  await w.locator('.pe-status:not(:has-text("not saved"))', { hasText: '200 × 300' }).waitFor({ timeout: 10000 });
  await w.getByRole('button', { name: 'Close' }).click();
  const viewer = page.locator('.win', { has: page.locator('.photos') });
  await viewer.getByRole('button', { name: 'Close' }).click();
  await x.locator('.item', { hasText: 'sketch' }).first().dblclick();
  await page.locator('.photos .statusbar', { hasText: '200 × 300 pixels' }).waitFor({ timeout: 10000 });
  await page.locator('.win', { has: page.locator('.photos') }).getByRole('button', { name: 'Close' }).click();
});

await step('About TOMLIN OS shows the version and credits every bundled package, with its licence text', async () => {
  // About sits in the Start menu's bottom row, not in a group.
  await page.locator('.start-btn').click();
  await page.locator('.start-foot .start-foot-app', { hasText: 'About TOMLIN OS' }).click();
  const w = page.locator('.win', { has: page.locator('.about') });
  await w.locator('.about-pkgs li', { hasText: '@codemirror/view' }).waitFor({ timeout: 10000 });
  ok((await w.locator('.about-head').innerText()).includes('Version 0.'), 'version shown');
  ok((await w.locator('.about-pkgs li').count()) >= 20, 'every package listed');
  await w.getByRole('button', { name: 'Show the licence texts' }).first().click();
  await w.locator('.about-text', { hasText: 'Permission is hereby granted' }).first().waitFor({ timeout: 10000 });
  await shot('about');
  await w.getByRole('button', { name: 'Close' }).click();
});

// Mail, against the stand-in mail server (test/fake-mail.mjs). The PHP server is started with
// DESKTOP_MAIL_ALLOW_HOSTS=127.0.0.1:3143,127.0.0.1:3587 and DESKTOP_MAIL_ALLOW_PLAIN=1 (tools/run-browser-tests.sh).
const fake = await startFakeMail({ imap: 3143, smtp: 3587 });

await step('Mail: set up a mailbox (test signs in to both servers), Inbox lists three messages', async () => {
  await closeAll();
  await openApp('mail');
  const w = page.locator('.win', { has: page.locator('.mail') });
  await w.locator('.mail-setup').waitFor();
  await w.getByLabel('Email address', { exact: true }).fill(MAIL_USER);
  await w.getByLabel('Provider', { exact: true }).selectOption('other');
  await w.getByLabel('Password', { exact: true }).fill(MAIL_PASS);
  await w.locator('.mail-adv summary').click();
  const servers = w.locator('.mail-servers');
  await servers.getByLabel('Server').nth(0).fill('127.0.0.1');
  await servers.getByLabel('Port').nth(0).fill('3143');
  await servers.getByLabel('Security').nth(0).selectOption('none');
  await servers.getByLabel('Server').nth(1).fill('127.0.0.1');
  await servers.getByLabel('Port').nth(1).fill('3587');
  await servers.getByLabel('Security').nth(1).selectOption('none');
  await w.getByRole('button', { name: 'Test and save' }).click();
  await w.locator('.mail-row').first().waitFor({ timeout: 20000 });
  eq(await w.locator('.mail-row').count(), 3, 'three messages');
  eq(await w.locator('.mail-row.unread').count(), 3, 'all unread');
  ok((await w.locator('.mail-folder.on').innerText()).includes('Inbox'), 'Inbox chosen');
  ok((await w.locator('.mail-folders').innerText()).includes('Garden'), 'other folders listed');
  await shot('mail-inbox');
});

await step('Mail: a hostile HTML email shows its text only: no script, frame, form, styles or web pictures', async () => {
  const w = page.locator('.win', { has: page.locator('.mail') });
  await w.locator('.mail-row', { hasText: 'Special offer' }).click();
  const body = w.locator('.mail-text');
  await body.locator('h1', { hasText: 'Big sale' }).waitFor({ timeout: 10000 });
  eq(await body.locator('script, iframe, form, input, style, img').count(), 0, 'nothing active or remote');
  eq(await body.locator('h1').getAttribute('onclick'), null, 'no handler attributes');
  eq(await body.locator('a').count(), 1, 'only the https link is a link');
  eq(await body.locator('a').getAttribute('href'), 'https://shop.example/sale', 'real link kept');
  ok((await w.locator('.mail-blocked').innerText()).includes('1 picture from the web was not loaded'), 'tracker picture blocked and said so');
  ok(!(await page.title()).includes('HACKED'), 'the script never ran');
  ok(!(await w.locator('.mail-row', { hasText: 'Special offer' }).getAttribute('class')).includes('unread'), 'marked read');
  await shot('mail-html');
});

await step('Mail: an attachment saves into your files', async () => {
  const w = page.locator('.win', { has: page.locator('.mail') });
  await w.locator('.mail-row', { hasText: 'Invoice attached' }).click();
  await w.locator('.mail-att', { hasText: 'invoice.txt' }).click();
  await page.locator('.dialog').getByRole('button', { name: 'Save' }).click();
  await page.locator('.toast', { hasText: 'Saved “invoice.txt”' }).waitFor();
});

await step('Mail: reply, send, and the server got it with In-Reply-To; Delete moves to Deleted', async () => {
  const w = page.locator('.win', { has: page.locator('.mail') });
  await w.locator('.mail-row', { hasText: 'Pruning on Friday' }).click();
  await w.locator('.mail-text', { hasText: 'magnolia' }).waitFor();
  await w.getByRole('button', { name: 'Reply', exact: true }).click();
  const c = page.locator('.win', { has: page.locator('.compose') });
  await c.locator('.compose-text').waitFor();
  eq(await c.getByLabel('To').inputValue(), 'Ann Lee <ann@example.org>', 'replies to the sender');
  eq(await c.getByLabel('Subject').inputValue(), 'Re: Pruning on Friday', 'subject');
  await c.locator('.compose-text').press('Control+Home');
  await page.keyboard.type('Friday at 10 is fine.');
  await c.getByRole('button', { name: 'Send' }).click();
  await page.locator('.toast', { hasText: 'Sent to 1 address' }).waitFor({ timeout: 15000 });
  eq(fake.delivered.length, 1, 'delivered');
  ok(fake.delivered[0].raw.includes('In-Reply-To: <m1@example.org>'), 'threaded');
  ok(fake.delivered[0].raw.includes('Friday at 10 is fine.'), 'text');
  eq(fake.boxes.Sent.msgs.length, 1, 'a copy in Sent');
  // Delete the open message: it moves to Deleted.
  await w.locator('.mail-row', { hasText: 'Pruning on Friday' }).click();
  await w.getByRole('button', { name: 'Delete' }).click();
  await w.locator('.statusbar', { hasText: 'Moved to Deleted' }).waitFor();
  eq(fake.boxes.Trash.msgs.length, 1, 'in Trash on the server');
  await shot('mail-after');
});

if (!HIDDEN_APPS.includes('planetziods')) await step('Planetziods: a new game, a fleet sent from your planet, turns end, and the game is saved in your files', async () => {
  await closeAll();
  await openApp('planetziods');
  const w = page.locator('.win', { has: page.locator('.pz') });
  await w.getByRole('button', { name: 'New game' }).click();
  const canvas = w.locator('canvas.pz-map');
  await canvas.waitFor();
  await page.waitForTimeout(300);
  // Find planet A (yours) and a neutral planet by pointing across the map.
  const box = await canvas.boundingBox();
  const find = async re => {
    for (let y = 8; y < box.height; y += 14) for (let x = 8; x < box.width; x += 14) {
      await page.mouse.move(box.x + x, box.y + y);
      if (re.test(await w.locator('.pz-info').innerText())) return [box.x + x, box.y + y];
    }
    throw new Error('planet not found ' + re);
  };
  const a = await find(/^A: You/);
  await page.mouse.click(...a);
  const n = await find(/: Nobody/);
  await page.mouse.click(...n);
  ok(/turns? away/.test(await w.locator('.pz-order').innerText()), 'travel time shown');
  await w.getByLabel('Ships to send').fill('4');
  await w.getByRole('button', { name: 'Send' }).click();
  ok((await w.locator('.pz-table').innerText()).includes('10'), 'standings shown');
  await w.getByRole('button', { name: 'End turn' }).click();
  await w.locator('.pz-turn', { hasText: 'Turn 2' }).waitFor();
  await shot('planetziods');
  await w.getByRole('button', { name: 'Close' }).click();
  // Reopening offers to continue the saved game.
  await openApp('planetziods');
  await page.locator('.win', { has: page.locator('.pz') }).getByRole('button', { name: 'Continue (turn 2)' }).waitFor();
  await page.locator('.win', { has: page.locator('.pz') }).getByRole('button', { name: 'Close' }).click();
});

if (!HIDDEN_APPS.includes('planetziods')) await step('Planetziods match bar: Menu keeps the match for Continue, Restart starts the same settings afresh, Quit match ends it', async () => {
  await closeAll();
  await openApp('planetziods');
  const w = page.locator('.win', { has: page.locator('.pz') });
  await w.getByRole('button', { name: 'Continue (turn 2)' }).click();
  await w.locator('.pz-turn', { hasText: 'Turn 2' }).waitFor();
  const bar = w.locator('.pz-bar');
  eq(await bar.getByRole('button').allInnerTexts(), ['Menu', 'Restart', 'Quit match'], 'the match bar');
  const barBox = await bar.boundingBox();
  const sideBox = await w.locator('.pz-side').boundingBox();
  ok(barBox.y - sideBox.y < 20, 'the bar is at the top of the side panel');
  await bar.getByRole('button', { name: 'Menu' }).click();
  await w.getByRole('button', { name: 'Continue (turn 2)' }).click();
  await w.locator('.pz-turn', { hasText: 'Turn 2' }).waitFor();
  await bar.getByRole('button', { name: 'Restart' }).click();
  await page.locator('.dialog').getByRole('button', { name: 'Restart' }).click();
  await w.locator('.pz-turn', { hasText: 'Turn 1' }).waitFor();
  eq(await w.locator('.pz-table tr').count(), 4, 'the same three players (and the heading row)');
  await bar.getByRole('button', { name: 'Quit match' }).click();
  await page.locator('.dialog').getByRole('button', { name: 'Quit match' }).click();
  await w.locator('.pz-setup').waitFor();
  await page.waitForTimeout(500);
  eq(await w.getByRole('button', { name: /^Continue/ }).count(), 0, 'nothing to continue after quitting');
  await w.getByRole('button', { name: 'Close' }).click();
});

if (!HIDDEN_APPS.includes('planetziods')) await step('Planetziods Trade & Trust: rules at setup, an alliance asked for, a sneak attack warned about, a defence sent, saved with its rules', async () => {
  await closeAll();
  await openApp('planetziods');
  const w = page.locator('.win', { has: page.locator('.pz') });
  const letters = { Orion: 'B', Vega: 'C', Lyra: 'D', Draco: 'E', Nova: 'F' };
  // Personalities are dealt at random; with 5 computers a Forgiver (starts at 7, so it will ally) is almost always
  // there. New games until one is.
  let friend = null;
  for (let tries = 0; tries < 12 && !friend; tries++) {
    if (tries) {
      await w.locator('.pz-bar').getByRole('button', { name: 'Quit match' }).click();
      await page.locator('.dialog').getByRole('button', { name: 'Quit match' }).click();
    }
    await w.getByLabel('Rules').selectOption('trade');
    const limits = await w.getByLabel('Turn limit').locator('option').allInnerTexts();
    eq(limits, ['50 turns', '100 turns', '150 turns', '200 turns'], 'Trade & Trust always has a turn limit');
    ok(await w.locator('.pz-note', { hasText: 'always has a turn limit' }).isVisible(), 'and says why');
    await w.getByLabel('Computer players').selectOption('5');
    await w.locator('.pz-setup').getByRole('button', { name: 'New game' }).click();
    await w.locator('.pz-turn', { hasText: 'Trade & Trust' }).waitFor();
    const row = w.locator('.pz-relations tr', { hasText: 'Forgiver' });
    if (await row.count()) friend = (await row.innerText()).match(/(Orion|Vega|Lyra|Draco|Nova)/)[1];
  }
  ok(friend, 'a Forgiver was dealt');
  eq(await w.locator('.pz-relations tr').count(), 5, 'one row per computer player');
  await w.locator('.pz-relations tr', { hasText: friend }).getByRole('button', { name: 'Ally?' }).click();
  await w.locator('.pz-answer', { hasText: 'accepted' }).waitFor();
  ok((await w.locator('.pz-relations tr', { hasText: friend }).innerText()).includes('Ally'), 'shown as an ally');
  const canvas = w.locator('canvas.pz-map');
  const box = await canvas.boundingBox();
  const find = async re => {
    for (let y = 8; y < box.height; y += 14) for (let x = 8; x < box.width; x += 14) {
      await page.mouse.move(box.x + x, box.y + y);
      if (re.test(await w.locator('.pz-info').innerText())) return [box.x + x, box.y + y];
    }
    throw new Error('planet not found ' + re);
  };
  const home = await find(/^A: You/);
  ok(/Mines \d+ iron and \d+ energy/.test(await w.locator('.pz-info').innerText()), 'resources shown');
  const theirs = await find(new RegExp(`^${letters[friend]}: ${friend}`));
  await page.mouse.click(...home);
  await page.mouse.click(...theirs);
  ok(/your ally/.test(await w.locator('.pz-order').innerText()), 'the order says it is an ally');
  await w.getByLabel('Ships to send').fill('3');
  await w.getByRole('button', { name: 'Attack' }).click();
  await page.locator('.dialog', { hasText: 'sneak attack' }).waitFor();
  await shot('planetziods-sneak-warning');
  await page.getByRole('button', { name: 'Keep the alliance' }).click();
  ok(await w.getByRole('button', { name: 'Take back' }).isDisabled(), 'no fleet sent');
  await w.getByRole('button', { name: 'Defend' }).click();
  ok(await w.getByRole('button', { name: 'Take back' }).isEnabled(), 'defence sent');
  await w.getByRole('button', { name: 'Take back' }).click();
  await page.mouse.click(...home);
  await page.mouse.click(...theirs);
  await w.getByLabel('Ships to send').fill('5');
  await w.getByRole('button', { name: 'Defend' }).click();
  await w.getByRole('button', { name: 'End turn' }).click();
  await w.locator('.pz-turn', { hasText: 'Turn 2' }).waitFor();
  await shot('planetziods-trade');
  await w.getByRole('button', { name: 'Close' }).first().click();
  await openApp('planetziods');
  await page.locator('.win', { has: page.locator('.pz') }).getByRole('button', { name: 'Continue (turn 2), Trade & Trust' }).waitFor();
  await page.locator('.win', { has: page.locator('.pz') }).getByRole('button', { name: 'Close' }).click();
});

await step('Task Manager lists open windows, ends one, and shows smoothness and file size', async () => {
  await closeAll();
  await openApp('calculator');
  await openApp('task manager');
  const w = page.locator('.win', { has: page.locator('.tm') });
  await w.locator('.tm-row', { hasText: 'Calculator' }).click();
  await w.getByRole('button', { name: 'End task' }).click();
  await page.locator('.win', { has: page.locator('.calc') }).waitFor({ state: 'detached' });
  await w.getByRole('tab', { name: 'Performance' }).click();
  await page.waitForTimeout(1500);
  ok(/^\d+$/.test(await w.locator('.tm-card strong').first().innerText()), 'frames a second shown');
  await w.getByRole('button', { name: 'Measure my files' }).click();
  await w.locator('.tm-files', { hasText: /\d+ files?/ }).waitFor({ timeout: 15000 });
  await shot('taskmanager');
  await w.getByRole('button', { name: 'Close' }).click();
});

// The AI is set up in Settings › AI (src/apps/assistant/aisettings.ts) and talked to in Chat › Agents.
const settingsWin = () => page.locator('.win', { has: page.locator('.set-ai') });
// Claude's section comes before OpenRouter's, which has boxes and buttons of the same names: scope to Claude's.
const claudeBox = s => s.locator('.set-ai section.ai-cloud', { has: page.locator('h2', { hasText: 'Claude, with your own API key' }) });
const chatWin = () => page.locator('.win', { has: page.locator('.chat-app') });

await step('Settings › AI: says what this device can do, offers the three built-in models named with their makers, promises free and private, with Claude in its own section', async () => {
  await closeAll();
  await openApp('settings');
  const s = settingsWin();
  const ai = s.locator('.set-ai');
  await ai.scrollIntoViewIfNeeded();
  const deviceLine = ai.locator('p.hint').first();
  await deviceLine.filter({ hasNotText: 'Checking' }).waitFor({ timeout: 15000 });
  const device = await deviceLine.innerText();
  ok(/can run the built-in AI|the built-in AI runs|cannot use the graphics chip/.test(device), device);
  ok(await ai.getByText('runs on this device: free and private').isVisible(), 'privacy promise shown');
  const claude = claudeBox(s);
  await claude.locator('h2').waitFor();
  // All three built-in models are offered, smallest first, saved here or not (this run's models folder starts empty).
  const pick = ai.getByLabel('Built-in model');
  await pick.locator('option').first().waitFor({ state: 'attached', timeout: 15000 });
  ok((await claude.boundingBox()).y > (await pick.boundingBox()).y, 'Claude\'s section follows the built-in AI');
  const options = await pick.locator('option').allInnerTexts();
  // Each is named with its maker (his: "in the listing, it should identify the model").
  ok(options.length === 3 && /^Qwen 3\.5 0\.8B by Qwen team, Alibaba Cloud \(/.test(options[0]) && /^Gemma 2 2B by Google \(/.test(options[1]) && /^Qwen 3\.5 4B by Qwen team, Alibaba Cloud \(/.test(options[2]), options.join(' | '));
  const note = ai.locator('p.hint', { hasText: ', made by ' });
  await pick.selectOption({ index: 1 });
  ok(/^Gemma 2 2B, made by Google \(Gemma Terms of Use\): the middle size/.test(await note.innerText()), 'the choice says who made it and what it trades');
  await pick.selectOption({ index: 2 });
  ok(/^Qwen 3\.5 4B, made by Qwen team, Alibaba Cloud \(Apache-2\.0\): the best answers/.test(await note.innerText()), 'the 4B says what it trades');
  await pick.selectOption({ index: 0 });
  await shot('settings-ai');
  await closeAll();
});

// The owner saves a model to this TOMLIN OS; browsers then get it from here, not from Hugging Face. The server fetches from a stand-in (test/fake-huggingface.mjs), into this
// run's own models folder: tools/run-browser-tests.sh sets DESKTOP_MODELS_TEST_URL and DESKTOP_MODELS_DIR.
const hf = await startFakeHuggingFace(3191);
await step('Settings › AI: the owner saves a model to this TOMLIN OS in pieces, browsers then get it from here; Remove frees the space', async () => {
  await closeAll();
  const listed = await page.evaluate(async () => (await fetch('/api/models.php?op=list', { headers: { 'X-Desktop-Store': '1' } })).json());
  ok(listed.owner === true && listed.models.every(m => !m.saved), 'needs an empty models folder of its own (run it with tools/run-browser-tests.sh): ' + JSON.stringify(listed).slice(0, 200));
  await openApp('settings');
  const ai = settingsWin().locator('.set-ai');
  const pick = ai.getByLabel('Built-in model');
  await pick.locator('option').first().waitFor({ state: 'attached', timeout: 15000 });
  await pick.selectOption('Qwen3.5-0.8B-q4f32_1-MLC');
  const source = ai.locator('p.hint', { hasText: /^(Not saved|Saved) on this TOMLIN OS/ });
  ok((await source.innerText()).startsWith('Not saved on this TOMLIN OS: this browser fetches it from Hugging Face'), await source.innerText());
  await ai.getByRole('button', { name: 'Save to this TOMLIN OS' }).click();
  // The save line: "Starting the save...", "Saving ... of ...", then how it ended.
  const said = ai.locator('p.hint[role=status]').first();
  await said.filter({ hasText: /^(?!Starting|Saving)\S/ }).waitFor({ timeout: 60000 });
  ok((await said.innerText()).startsWith('Qwen 3.5 0.8B is saved on this TOMLIN OS'), await said.innerText());
  await source.filter({ hasText: /^Saved on this TOMLIN OS/ }).waitFor({ timeout: 10000 });
  const pieces = hf.requests.filter(r => r.startsWith('/cdn/params_shard_0.bin'));
  eq(pieces.length, 2, 'the 20 MB file came in two pieces: ' + pieces.join(', '));
  // Browsers now get it from this TOMLIN OS.
  const served = await page.evaluate(async () => ({
    index: (await (await fetch('/models/models.json')).json()).models.map(m => m.id),
    shard: (await (await fetch('/models/Qwen3.5-0.8B-q4f32_1-MLC/resolve/main/params_shard_0.bin')).arrayBuffer()).byteLength,
  }));
  eq(served, { index: ['Qwen3.5-0.8B-q4f32_1-MLC'], shard: SHARD_BYTES });
  await ai.getByRole('button', { name: 'Remove from this TOMLIN OS' }).click();
  await page.locator('.dialog').getByRole('button', { name: 'Remove', exact: true }).click();
  await source.filter({ hasText: /^Not saved on this TOMLIN OS/ }).waitFor({ timeout: 10000 });
  eq(await page.evaluate(async () => (await fetch('/models/Qwen3.5-0.8B-q4f32_1-MLC/resolve/main/params_shard_0.bin')).status), 404, 'the files are gone');
  await closeAll();
});
await hf.close();

// Claude with the person's own key, against a stand-in for Anthropic (test/fake-anthropic.mjs). The PHP server must be
// started with DESKTOP_AI_TEST_URL=http://127.0.0.1:3190 (tools/run-browser-tests.sh does); no request leaves this computer.
const anthropic = await startFakeAnthropic(3190);
/** The Chat window that Use Claude opened, on the Agents tab, with Claude connected (its key saved in Settings › AI). */
const claudeInChat = async () => {
  const w = chatWin();
  await w.getByRole('tab', { name: 'Agents', selected: true }).waitFor({ timeout: 10000 });
  await w.locator('.agent-pick[aria-label="Agent"] option[value="claude"]:not([disabled])').waitFor({ state: 'attached', timeout: 10000 });
  await w.getByLabel('Agent', { exact: true }).selectOption('claude');
  await w.locator('.agent-note', { hasText: 'Connected: Claude Sonnet 5' }).waitFor({ timeout: 10000 });
  return w;
};
await step('your own Claude key in Settings › AI: checked before it is kept, never shown again; Use Claude opens Chat › Agents, answers stream there; the cap and the cost log hold', async () => {
  await closeAll();
  const problemsBefore = problems.length;
  await openApp('settings');
  let c = claudeBox(settingsWin());
  const state = () => c.locator('.ai-device');
  await state().filter({ hasText: 'No key saved yet' }).waitFor({ timeout: 10000 });
  ok(await c.getByRole('button', { name: 'Use Claude' }).isDisabled(), 'no key: Use Claude is off');
  await c.getByRole('button', { name: 'Claude settings...' }).click();
  const keyBox = c.getByLabel('Anthropic API key');
  eq(await keyBox.getAttribute('type'), 'password', 'the key is typed hidden');
  const msg = c.locator('.ai-cloud-msg');

  await keyBox.fill('hello');
  await c.getByRole('button', { name: 'Save', exact: true }).click();
  await msg.filter({ hasText: 'does not look like an Anthropic API key' }).waitFor();
  eq(anthropic.requests.length, 0, 'a key of the wrong shape is never sent anywhere');

  await keyBox.fill('sk-ant-api03-' + 'x'.repeat(40));
  await c.getByRole('button', { name: 'Save', exact: true }).click();
  await msg.filter({ hasText: 'Anthropic refused the API key' }).waitFor({ timeout: 15000 });
  eq(anthropic.requests.length, 1, 'a wrong key is tried once, and not kept');

  await keyBox.fill(AI_KEY);
  await c.getByLabel('Claude model').selectOption('claude-sonnet-5');
  await c.getByLabel('Monthly limit in US dollars').fill('1');
  await c.getByRole('button', { name: 'Save', exact: true }).click();
  await state().filter({ hasText: 'ending wxyz' }).waitFor({ timeout: 15000 });
  ok((await state().innerText()).includes('Claude Sonnet 5') && (await state().innerText()).includes('$1.00'), await state().innerText());
  eq(anthropic.requests[1].path.startsWith('/v1/models'), true, 'the key is proved with the free model list');
  // The page never gets the key back: the settings answer carries only its last four characters.
  const back = await page.evaluate(async () => (await fetch('/api/ai.php?op=settings', { headers: { 'X-Desktop-Store': '1' } })).text());
  ok(!back.includes('sk-ant-') && back.includes('"hint":"wxyz"'), 'settings answer: ' + back.slice(0, 200));

  // Use Claude goes to where the talking is: Chat › Agents.
  await c.getByRole('button', { name: 'Use Claude' }).click();
  let w = await claudeInChat();
  ok((await w.locator('.agent-note').innerText()).includes('of your $1.00 limit'), 'the chat says the limit: ' + await w.locator('.agent-note').innerText());
  // Enter sends; Shift+Enter is a new line and sends nothing.
  const box = w.getByLabel('Message to the agent');
  const asked = await w.locator('.agent-pane .chat-msg.mine').count();
  await box.fill('first line');
  await box.press('Shift+Enter');
  eq(await box.inputValue(), 'first line\n', 'Shift+Enter makes a new line');
  eq(await w.locator('.agent-pane .chat-msg.mine').count(), asked, 'and sends nothing');
  await box.fill('Please prune the magnolia');
  await box.press('Enter');
  const answer = w.locator('.agent-pane .chat-msg.agent').last();
  await answer.locator('.chat-text', { hasText: 'Stand-in Claude heard: Please prune the magnolia' }).waitFor({ timeout: 20000 });
  ok((await answer.locator('.chat-who').innerText()).startsWith('Claude Sonnet 5'), 'the answer names the AI that wrote it');
  const foot = await answer.locator('.agent-foot').innerText();
  ok(/^Answered in \d+ s$/.test(foot), 'foot: ' + foot);
  const sent = anthropic.requests.at(-1);
  eq(sent.key, AI_KEY, 'the saved key was used');
  eq(sent.auth, null, 'no other credential rode along');
  eq(sent.body.model, 'claude-sonnet-5', 'the chosen model');
  eq(sent.body.stream, true, 'streamed');
  eq(sent.body.messages, [{ role: 'user', content: 'Please prune the magnolia' }], 'exactly what was typed, nothing else');
  await shot('chat-claude');
  await closeAll();

  // A $0 limit stops the next question before anything is sent.
  const before = anthropic.requests.length;
  await openApp('settings');
  c = claudeBox(settingsWin());
  await c.getByRole('button', { name: 'Claude settings...' }).click();
  await c.getByLabel('Monthly limit in US dollars').fill('0');
  await c.getByRole('button', { name: 'Save', exact: true }).click();
  await state().filter({ hasText: '$0.00 limit' }).waitFor({ timeout: 10000 });
  await c.getByRole('button', { name: 'Use Claude' }).click();
  w = await claudeInChat();
  await w.getByLabel('Message to the agent').fill('One more question');
  await w.locator('.agent-pane').getByRole('button', { name: 'Send' }).click();
  await w.locator('.agent-pane .agent-error', { hasText: 'monthly limit' }).waitFor({ timeout: 10000 });
  eq(anthropic.requests.length, before, 'over the limit: Anthropic is not asked');
  eq(await w.getByLabel('Message to the agent').inputValue(), 'One more question', 'the unanswered question is back in the box');
  await closeAll();

  // The cost log, in Settings › AI: the answer above at list price, numbers only.
  await openApp('settings');
  c = claudeBox(settingsWin());
  await c.getByRole('button', { name: 'Cost log...' }).click();
  await c.locator('.ai-log-table tbody tr', { hasText: 'Claude Sonnet 5' }).first().waitFor({ timeout: 10000 });
  const rows = await c.locator('.ai-log-table tbody tr').allInnerTexts();
  // 120 in at $2/M + 42 out at $10/M = $0.00066
  ok(rows.some(r => r.includes('120') && r.includes('42') && r.includes('$0.0007')), 'tokens and cost at list price: ' + rows.join(' | '));
  ok(!rows.join(' ').includes('magnolia'), 'the cost log keeps numbers, never what was asked');
  await shot('settings-ai-claude-log');

  await c.getByRole('button', { name: 'Claude settings...' }).click();
  await c.getByRole('button', { name: 'Remove my key' }).click();
  await state().filter({ hasText: 'No key saved yet' }).waitFor({ timeout: 10000 });
  ok(await c.getByRole('button', { name: 'Use Claude' }).isDisabled(), 'removed: Use Claude is off');
  // The three refusals asked for above (a key of the wrong shape, a refused key, the $0 limit) show in the browser's
  // console as failed requests; exactly those are expected (a 404 is a key not made yet, as in the last step), and
  // anything else still fails the last step.
  const mine = problems.splice(problemsBefore).filter(p => !p.includes('404'));
  eq(mine.map(p => (/status of (\d+)/.exec(p) ?? [])[1]), ['400', '400', '402'], 'only the refusals asked for');
  await closeAll();
});

/** Saves the Claude key in Settings › AI, with a $1 limit; `null` removes it. */
const setClaudeKey = async key => {
  await openApp('settings');
  const c = claudeBox(settingsWin());
  await c.getByRole('button', { name: 'Claude settings...' }).click();
  if (key) {
    await c.getByLabel('Anthropic API key').fill(key);
    await c.getByLabel('Monthly limit in US dollars').fill('1');
    await c.getByRole('button', { name: 'Save', exact: true }).click();
    await c.locator('.ai-device').filter({ hasText: 'ending wxyz' }).waitFor({ timeout: 15000 });
  } else {
    await c.getByRole('button', { name: 'Remove my key' }).click();
    await c.locator('.ai-device').filter({ hasText: 'No key saved yet' }).waitFor({ timeout: 10000 });
  }
  await closeAll();
};

// Chat Agents: connect, then save, new thread, delete and recent threads; closing the browser or reloading loses
// nothing, as threads are kept in Documents/AI chats as they go. Claude is the stand-in; the built-in models need a graphics chip the run may not have.
await step('Chat Agents: Claude connects, the thread is kept as it goes, comes back when Chat opens again and carries on, then goes to the Recycle Bin', async () => {
  await closeAll();
  // The key again (the step above removed it), with a limit above $0.
  await setClaudeKey(AI_KEY);

  const openAgents = async () => {
    await openApp('chat');
    const w = page.locator('.win', { has: page.locator('.chat-app') });
    await w.getByRole('tab', { name: 'Agents' }).click();
    await w.locator('.agent-pick[aria-label="Agent"] option[value="claude"]:not([disabled])').waitFor({ state: 'attached', timeout: 10000 });
    return w;
  };
  let w = await openAgents();
  const recent = w.getByLabel('Recent threads');
  // The thread asked in the step above (Chat › Agents, Claude) was kept, so it is here, and opened as the newest.
  await recent.locator('option', { hasText: 'Please prune the magnolia' }).waitFor({ state: 'attached' });
  await w.locator('.agent-pane .chat-msg.agent .chat-text', { hasText: 'Stand-in Claude heard: Please prune the magnolia' }).waitFor({ timeout: 10000 });
  ok(await w.getByLabel('Message to the agent').isDisabled(), 'no agent connected: nothing to type into');
  await w.getByRole('button', { name: 'New thread' }).click();
  await w.getByLabel('Agent', { exact: true }).selectOption('claude');
  await w.locator('.agent-note', { hasText: 'Connected: Claude Sonnet 5' }).waitFor();
  await w.getByLabel('Message to the agent').fill('Tell me about the ISS');
  await w.getByLabel('Message to the agent').press('Enter');
  await w.locator('.agent-pane .chat-msg.agent .chat-text', { hasText: 'Stand-in Claude heard: Tell me about the ISS' }).waitFor({ timeout: 20000 });
  ok((await w.locator('.agent-pane .chat-msg.agent .chat-who').last().innerText()).startsWith('Claude Sonnet 5'), 'the answer names the AI that wrote it');
  await recent.locator('option', { hasText: 'Tell me about the ISS' }).waitFor({ state: 'attached' });
  await shot('chat-agents');

  // Closed and opened again (a new Chat, nothing kept in the page): the newest thread is read back from its file.
  await w.getByRole('button', { name: 'Close', exact: true }).click();
  w = await openAgents();
  await w.locator('.agent-pane .chat-msg.agent .chat-text', { hasText: 'Stand-in Claude heard: Tell me about the ISS' }).waitFor({ timeout: 10000 });
  await w.getByLabel('Agent', { exact: true }).selectOption('claude');
  await w.getByLabel('Message to the agent').fill('And how fast does it go?');
  await w.getByRole('button', { name: 'Send' }).click();
  await w.locator('.agent-pane .chat-msg.agent .chat-text', { hasText: 'Stand-in Claude heard: And how fast does it go?' }).waitFor({ timeout: 20000 });
  eq(anthropic.requests.at(-1).body.messages.map(m => m.role), ['user', 'assistant', 'user'], 'the kept thread went with the new question');
  eq(await w.locator('.agent-pane .chat-msg').count(), 4, 'two questions, two answers');

  // New thread empties the screen; the kept one stays in Recent; Delete sends it to the Recycle Bin.
  await w.getByRole('button', { name: 'New thread' }).click();
  eq(await w.locator('.agent-pane .chat-msg').count(), 0, 'a new thread starts empty');
  await recent.selectOption({ label: 'Tell me about the ISS' });
  await w.locator('.agent-pane .chat-msg').nth(3).waitFor();
  await w.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.locator('.dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await recent.locator('option', { hasText: 'Tell me about the ISS' }).waitFor({ state: 'detached', timeout: 10000 });
  ok(await recent.locator('option', { hasText: 'Please prune the magnolia' }).count() === 1, 'the other thread stays');
  await w.getByRole('button', { name: 'Close', exact: true }).click();

  // The key off again, so the Panel step below finds the built-in AI named on the rail.
  await setClaudeKey(null);
});

await step('Panel: control-panel layout; Chat in the Overview sends and shows a message; the Terminal runs inside and keeps its history', async () => {
  await closeAll();
  await openApp('panel');
  const w = front();
  await w.locator('.panel-nav-item', { hasText: 'OVERVIEW' }).waitFor();
  // Calendar, Chat, Notepad Pro and Terminal came off the rail; the AI sits under Mail as CONNECT AI MODELS (the
  // built-in models or Claude: not named after one model).
  await w.locator('.panel-nav-item', { hasText: 'CONNECT AI MODELS' }).waitFor({ timeout: 10000 });
  const names =(await w.locator('.panel-nav-item').allInnerTexts()).map(t => t.trim());
  eq(names, ['OVERVIEW', 'MAIL', 'CONNECT AI MODELS', 'FILES', 'CONTACTS', 'SETTINGS', 'MY ACCOUNT'], 'the rail');
  ok((await w.locator('.panel-nav-item[aria-selected="true"]').innerText()).includes('OVERVIEW'), 'opens on the Overview');
  ok(await w.evaluate(el => el.classList.contains('max')), 'opens filling the screen');
  // This owner did not encrypt their files, so the chat key is readable on the server: the screen must not say end to end.
  const chat = w.locator('.panel-chat');
  await chat.locator('.chat-lock', { hasText: 'Not end to end' }).waitFor({ timeout: 15000 });
  await chat.locator('.chat-thread .chat-box').fill('Panel test message');
  await chat.getByRole('button', { name: 'Send' }).click();
  await chat.locator('.chat-text', { hasText: 'Panel test message' }).waitFor({ timeout: 10000 });
  await shot('panel-overview');

  // Chat can take the whole Overview, and back.
  await w.getByRole('button', { name: 'Expand' }).click();
  ok(!(await w.locator('.panel-stack-left').isVisible()), 'expanded: the chat has the Overview');
  await w.getByRole('button', { name: 'Shrink' }).click();
  ok(await w.locator('.panel-stack-left').isVisible(), 'shrunk back');

  // Today & upcoming: today's heading, and it scrolls inside its tile.
  await w.locator('.panel-day', { hasText: 'Today' }).first().waitFor();
  eq(await w.locator('.panel-scroll').evaluate(el => getComputedStyle(el).overflowY), 'auto', 'the list scrolls');

  // The scratch pad: an unnamed pad is saved under the day's date; New starts another; the saved one reopens.
  const pad = w.locator('.scratch-pad');
  const d = new Date();
  const dayName = `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
  eq(await pad.locator('.pad-name').inputValue(), dayName, 'named by the day');
  await pad.locator('.pad-text').fill('Ring the gardener about Friday');
  await pad.locator('.pad-text').press('Control+s');
  await pad.locator('.pad-item', { hasText: dayName }).waitFor({ timeout: 10000 });
  eq(await pad.locator('.pad-state').innerText(), 'saved', 'says saved');
  await w.getByRole('button', { name: 'New', exact: true }).click();
  eq(await pad.locator('.pad-text').inputValue(), '', 'New: an empty pad');
  await pad.locator('.pad-item', { hasText: dayName }).click();
  // Opening reads the file: wait until the list marks it open, then look at the text.
  await pad.locator('.pad-item.on', { hasText: dayName }).waitFor({ timeout: 10000 });
  eq(await pad.locator('.pad-text').inputValue(), 'Ring the gardener about Friday', 'the saved pad reopens');
  // Open full: Notepad Pro, with the pad's file.
  await w.getByRole('button', { name: 'Open full' }).click();
  await page.locator('.win', { has: page.locator('.win-title-text', { hasText: `${dayName}.txt` }) }).waitFor({ timeout: 15000 });
  await page.locator('.win.active .win-close').click();
  await shot('panel-overview-pad');

  // The Terminal: off the rail, opened from the rail's foot.
  await w.locator('.panel-terminal').click();
  const input = w.locator('.panel-host .term-in');
  await input.waitFor();
  await input.fill('echo panel-was-here');
  await input.press('Enter');
  await w.locator('.term-row', { hasText: 'panel-was-here' }).first().waitFor();
  eq((await w.locator('.panel-bar-title').innerText()).length > 0, true, 'the bar names the section');
  await w.locator('.panel-nav-item', { hasText: 'OVERVIEW' }).click();
  await w.locator('.panel-terminal').click();
  ok(await w.locator('.term-row', { hasText: 'panel-was-here' }).first().isVisible(), 'the Terminal kept its history across sections');
  await closeAll();
});

await step('Panel Mail in the ticket shape: folder tabs, the message under the list, Contacts and Sent on the right, a message written in place and sent', async () => {
  await closeAll();
  // A contact with an email address, made in Contacts the way a person would.
  await openApp('contacts');
  let w = front();
  await w.getByRole('button', { name: 'New contact' }).click();
  await w.getByLabel('Name').fill('Grace Lee');
  await w.getByLabel('Email addresses (one per line)').fill('grace@example.com');
  await w.getByRole('button', { name: 'Save' }).click();
  await w.locator('.person h2', { hasText: 'Grace Lee' }).waitFor();
  await closeAll();

  await openApp('panel');
  w = front();
  await w.locator('.panel-nav-item', { hasText: 'MAIL' }).click();
  const m = w.locator('.mail.ticket');
  await m.locator('.mail-row').first().waitFor({ timeout: 20000 });
  ok((await m.locator('.mail-tab.on').innerText()).includes('Inbox'), 'Inbox is the open tab');
  const tabs = await m.locator('.mail-tabs').innerText();
  ok(tabs.includes('Sent') && tabs.includes('More'), `usual folders are tabs, the rest under More: ${tabs}`);
  await m.locator('.mail-row', { hasText: 'Invoice attached' }).click();
  await m.locator('.mail-reader h2', { hasText: 'Invoice attached' }).waitFor({ timeout: 10000 });
  const listBox = await m.locator('.mail-list').boundingBox();
  const readBox = await m.locator('.mail-reader').boundingBox();
  ok(readBox.y >= listBox.y + listBox.height - 1, 'the open message reads under the list');
  // Already read in an earlier step: Reply must still come on (it once stayed off for read messages).
  ok(!(await m.getByRole('button', { name: 'Reply', exact: true }).isDisabled()), 'Reply is on for a message already read');
  // The right-hand column: the contact, and the reply sent in the Mail step above.
  const side = m.locator('.mail-ticket-side');
  await side.locator('.mail-side-row', { hasText: 'Grace Lee' }).waitFor({ timeout: 10000 });
  await side.locator('.mail-side-row', { hasText: 'Re: Pruning on Friday' }).waitFor({ timeout: 10000 });

  // Clicking a contact writes to them in place: no new window.
  const windows = await page.locator('.win').count();
  await side.locator('.mail-side-row', { hasText: 'Grace Lee' }).click();
  const c = m.locator('.mail-compose');
  await c.locator('.compose-text').waitFor();
  eq(await page.locator('.win').count(), windows, 'no new window');
  eq(await c.getByLabel('To').inputValue(), 'Grace Lee <grace@example.com>', 'addressed to the contact');
  await c.getByLabel('Subject').fill('Lesson times');
  await c.locator('.compose-text').fill('Tuesday at 4?');
  // Opening another message while writing asks first; keep writing.
  await m.locator('.mail-row', { hasText: 'Invoice attached' }).click();
  await page.locator('.dialog').getByRole('button', { name: 'Keep writing' }).click();
  ok(await c.locator('.compose-text').isVisible(), 'still writing');
  const before = fake.delivered.length;
  await c.getByRole('button', { name: 'Send' }).click();
  await page.locator('.toast', { hasText: 'Sent to 1 address' }).waitFor({ timeout: 15000 });
  eq(fake.delivered.length, before + 1, 'delivered');
  ok(fake.delivered.at(-1).raw.includes('Tuesday at 4?'), 'the text went');
  await side.locator('.mail-side-row', { hasText: 'Lesson times' }).waitFor({ timeout: 10000 });
  eq(await m.locator('.mail-compose').count(), 0, 'the writing space closed after sending');
  ok(await m.locator('.mail-reader').isVisible(), 'the reader is back');
  await shot('panel-mail-ticket');
  await closeAll();
});

await step('Start menu > Add to desktop puts an app shortcut on the desktop; double-clicking it opens the app; Panel is there already', async () => {
  await closeAll();
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('calculator');
  const startIcon = await page.locator('.start-item', { hasText: 'Calculator' }).locator('svg').first().innerHTML();
  await page.locator('.start-item', { hasText: 'Calculator' }).click({ button: 'right' });
  await page.locator('.menu-item', { hasText: 'Add to desktop' }).click();
  await page.locator('.toast', { hasText: 'Calculator is on the desktop now' }).waitFor();
  await page.keyboard.press('Escape');
  const icon = page.locator('#desktop .item', { has: page.locator('.item-name', { hasText: /^Calculator$/ }) });
  await icon.waitFor({ timeout: 10000 });
  eq(await icon.locator('.item-icon svg').first().innerHTML(), startIcon, 'drawn with the Calculator icon, not the plain app icon');
  // A second time says so instead of making "Calculator (2)".
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('calculator');
  await page.locator('.start-item', { hasText: 'Calculator' }).click({ button: 'right' });
  await page.locator('.menu-item', { hasText: 'Add to desktop' }).click();
  await page.locator('.toast', { hasText: 'Calculator is already on the desktop' }).waitFor();
  await page.keyboard.press('Escape');
  eq(await page.locator('#desktop .item .item-name', { hasText: /^Calculator/ }).count(), 1, 'one shortcut');
  await icon.dblclick();
  await page.locator('.win', { hasText: 'Calculator' }).first().waitFor({ timeout: 15000 });
  await shot('desktop-shortcut');
  await closeAll();
  // Panel is one of the desktop's own icons: adding it again would only make a second Panel.
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('panel');
  await page.locator('.start-item', { hasText: 'Panel' }).click({ button: 'right' });
  await page.locator('.menu-item', { hasText: 'Add to desktop' }).click();
  await page.locator('.toast', { hasText: 'Panel is already on the desktop' }).waitFor();
  await page.keyboard.press('Escape');
  eq(await page.locator('#desktop .item .item-name', { hasText: /^Panel/ }).count(), 1, 'one Panel');
});

await step('no errors in the page', async () => eq(problems.filter(p => !p.includes('404')), [], 'problems'));

await fake.close();
await anthropic.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
// close() can hang on Windows (it did for 13 minutes after the Assistant step); the results are already printed.
await Promise.race([browser.close(), new Promise(r => setTimeout(r, 3000))]);
process.exit(failures.length ? 1 : 0);
