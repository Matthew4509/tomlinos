// Audit of Notepad (the "editor" app) in a real Chrome: encoding, line endings, saving twice, a file it cannot open,
// a small window, find in a long file. Each step marked FAULT failed when it was written. Needs the dev server on a
// FRESH, EMPTY data folder (the first step sets up the owner), and `npm run build` done.
//   node test/browser-audit-notepad.mjs [http://127.0.0.1:3102] [screenshot folder]
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3102';
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

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
const page = await context.newPage();
const shot = async name => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });
const front = () => page.locator('.win.active');
const pad = () => page.locator('.win', { has: page.locator('.editor') }).last();

async function closeAll() {
  for (let i = 0; i < 40; i++) {
    const dialog = page.locator('.dialog');
    if (await dialog.count()) {
      await dialog.getByRole('button', { name: /without saving|Do not save|Cancel|Close anyway/ }).first().click().catch(() => dialog.getByRole('button').last().click());
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
/** Opens a file from Documents in Notepad and waits until it has loaded (or said why not). */
async function openInNotepad(stem) {
  const w = await documents();
  await w.locator('.item', { hasText: stem }).first().dblclick();
  await pad().locator('.editor-status').filter({ hasText: /\S/ }).waitFor({ timeout: 10000 });
  return pad();
}
/** The saved bytes of a file in Documents, through Explorer's Download. */
async function downloadBytes(stem) {
  const w = await documents();
  await w.locator('.item', { hasText: stem }).first().click();
  const download = page.waitForEvent('download', { timeout: 10000 });
  await w.getByRole('button', { name: 'Download' }).click();
  const d = await download;
  return readFileSync(await d.path());
}

console.log('Notepad audit, against ' + BASE);
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

const dir = tempDir('tomlinos-audit-notepad-');
const lines = [];
for (let i = 1; i <= 30000; i++) lines.push(`line ${i} some ordinary words to make it long enough`);
lines.push('the NEEDLE is here');
const files = {
  'bom.txt': Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('hello\r\nworld\r\n')]),
  'oldmac.txt': Buffer.from('one\rtwo\rthree\r'),
  'latin.txt': Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]),
  'plain.txt': Buffer.from('save me\n'),
  'long.txt': Buffer.from(lines.join('\n')),
};
await step('upload the test files into Documents', async () => {
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes);
  const w = await documents();
  const chooser = page.waitForEvent('filechooser');
  await w.getByRole('button', { name: 'Upload' }).click();
  (await chooser).setFiles(Object.keys(files).map(n => join(dir, n)));
  for (const n of Object.keys(files)) await w.locator('.item', { hasText: n.replace('.txt', '') }).first().waitFor({ timeout: 15000 });
});

await step('FAULT: a UTF-8 file with a BOM keeps it when Notepad saves (Notepad Pro does)', async () => {
  const n = await openInNotepad('bom');
  await n.locator('textarea').press('End');
  await n.locator('textarea').type('!');
  await page.keyboard.press('Control+s');
  await page.locator('.toast', { hasText: 'Saved “bom.txt”' }).waitFor();
  await closeAll();
  const bytes = await downloadBytes('bom');
  eq([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'first three bytes');
});

await step('FAULT: an old Mac (CR) file: the line-ending button names CR, not LF', async () => {
  const n = await openInNotepad('oldmac');
  ok((await n.locator('.editor-status').innerText()).includes('Old Mac (CR)'), 'status says CR');
  // Format > Line endings when saving ticks the file's own (the old button row's LF/CR/CRLF button is a menu now).
  await n.locator('.cbar-title[data-menu=Format]').click();
  await page.locator('.menu-item', { hasText: 'Line endings when saving' }).click();
  const label = await page.locator('.menu-item[aria-checked="true"]', { hasText: /\((CR|LF|CRLF)\)/ }).innerText();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  ok(label.includes('(CR)'), 'line ending ticked in the Format menu: ' + label);
});

await step('FAULT: a file Notepad cannot open leaves no dead buttons (Find, Replace, Go to, zoom look usable but do nothing)', async () => {
  const n = await openInNotepad('latin');
  ok((await n.locator('.editor-status').innerText()).includes('does not look like text'), 'refused as not text');
  // Every command that works on the text is off in the menus (File keeps Close; Help is the desktop's).
  const live = [];
  for (const menu of ['File', 'Edit', 'View', 'Format']) {
    await n.locator(`.cbar-title[data-menu=${menu}]`).click();
    live.push(...(await page.locator('.menu-root .menu-item:not([aria-disabled="true"]) .menu-label').allInnerTexts()));
    await page.keyboard.press('Escape');
  }
  eq(live, ['Close'], 'menu commands still enabled');
});

await step('FAULT: clicking Save twice quickly does not claim the file was changed somewhere else', async () => {
  const n = await openInNotepad('plain');
  await n.locator('textarea').press('End');
  await n.locator('textarea').type(' now');
  // Two Saves at once (the old button row's Save button is File > Save and Ctrl+S now).
  await n.locator('textarea').evaluate(area => {
    for (let i = 0; i < 2; i++) area.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(1500);
  const dialog = await page.locator('.dialog').count() ? await page.locator('.dialog').innerText() : '';
  ok(!dialog.includes('Changed somewhere else'), 'a "changed somewhere else" question came up: ' + dialog.slice(0, 120));
});

await step('FAULT: Ctrl+S twice on a new note does not open two Save as boxes', async () => {
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('notepad');
  await page.locator('.start-menu [data-label="notepad"]').first().click();
  const n = pad();
  await n.locator('textarea').type('fresh');
  await page.keyboard.press('Control+s');
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(500);
  eq(await page.locator('.dialog').count(), 1, 'Save as boxes open');
});

await step('FAULT: the find bar lays out in one row at the opening size (a Spreadsheet ".find-row" grid rule overrides it)', async () => {
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('notepad');
  await page.locator('.start-menu [data-label="notepad"]').first().click();
  const n = pad();
  await n.locator('textarea').click();
  await page.keyboard.press('Control+f');
  // Controls of different heights share a row when their middles line up (a shorter label sits a few pixels lower).
  const mids = await n.locator('.find-bar .find-row').first().evaluate(row =>
    [...row.children].filter(c => c.offsetParent).map(c => { const r = c.getBoundingClientRect(); return Math.round(r.top + r.height / 2); }));
  ok(Math.max(...mids) - Math.min(...mids) < 8, 'the find controls are on more than one row (middles ' + mids.join(',') + ')');
});

await step('FAULT: Find in a long file brings the match into view', async () => {
  const n = await openInNotepad('long');
  await page.waitForFunction(() => (document.querySelector('.editor textarea')?.value.length ?? 0) > 100000);
  await n.locator('textarea').press('Control+Home');
  await page.keyboard.press('Control+f');
  await n.getByLabel('Find', { exact: true }).fill('NEEDLE');
  await page.keyboard.press('Enter');
  const top = await n.locator('textarea').evaluate(a => a.scrollTop);
  ok(top > 1000, 'textarea scrollTop after find: ' + top);
});

// N-P1-2. What is timed is Notepad's own work on each key (its input and keyup handlers). The browser's own change to a
// 1.5 MB text box (setRangeText) is timed beside it and only printed: in headless Chrome it alone is about 45 ms.
await step('N-P1-2: typing in a 1.5 MB file: Notepad\'s own work is under 10 ms a key (no full encode a key)', async () => {
  const n = await openInNotepad('long');
  await page.waitForFunction(() => (document.querySelector('.editor textarea')?.value.length ?? 0) > 100000);
  const { mine, browser } = await n.locator('textarea').evaluate(a => {
    a.focus();
    let mine = 0;
    let browser = 0;
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      a.setRangeText('x', a.selectionStart, a.selectionStart, 'end');
      const t1 = performance.now();
      a.dispatchEvent(new Event('input'));
      a.dispatchEvent(new KeyboardEvent('keyup'));
      mine += performance.now() - t1;
      browser += t1 - t0;
    }
    return { mine: mine / 20, browser: browser / 20 };
  });
  console.log(`       ms per key: Notepad ${mine.toFixed(1)}, the browser's own text change ${browser.toFixed(1)}`);
  ok(mine < 10, 'Notepad ms per key ' + mine.toFixed(1));
  await n.locator('.editor-status', { hasText: 'not saved' }).waitFor({ timeout: 5000 }).catch(() => {});
  const said = await n.locator('.editor-status').innerText();
  ok(said.includes('not saved'),'the status bar did not catch up once typing paused: ' + said);
});

await step('FAULT: at its smallest size the window still shows some of the text with the find bar open', async () => {
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('notepad');
  await page.locator('.start-menu [data-label="notepad"]').first().click();
  const n = pad();
  const grip = n.locator('.win-edge.edge-se');
  const box = await grip.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 1000, box.y - 1000, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.press('Control+h');
  await shot('notepad-small');
  const h = await n.locator('textarea').evaluate(a => a.getBoundingClientRect().height);
  ok(h >= 40, 'text box height at the smallest size: ' + h);
});

await step('FAULT (P1): text Notepad saved over 2 MB can be opened again by Notepad', async () => {
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('notepad');
  await page.locator('.start-menu [data-label="notepad"]').first().click();
  const n = pad();
  await n.locator('textarea').evaluate(a => {
    a.value = 'x'.repeat(2.2 * 1024 * 1024);
    a.dispatchEvent(new Event('input'));
  });
  await page.keyboard.press('Control+Shift+s');
  await page.locator('.dialog input').fill('huge.txt');
  await page.locator('.dialog').getByRole('button', { name: 'Save' }).click();
  await page.locator('.toast', { hasText: 'Saved “huge.txt”' }).waitFor({ timeout: 20000 });
  await closeAll();
  const again = await openInNotepad('huge');
  const status = await again.locator('.editor-status').innerText();
  ok(!status.includes('Quick Notes opens text up to'), 'reopening says: ' + status);
});

await step('N-P1-1: text over what Notepad can open again is refused before saving, and the text stays in the window', async () => {
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('notepad');
  await page.locator('.start-menu [data-label="notepad"]').first().click();
  const n = pad();
  await n.locator('textarea').evaluate(a => {
    a.value = 'y'.repeat(5.5 * 1024 * 1024);
    a.dispatchEvent(new Event('input'));
  });
  // Said before a name is asked for, so no time is spent naming a file that cannot be saved.
  await page.keyboard.press('Control+Shift+s');
  const box = page.locator('.dialog', { hasText: 'Too big to save' });
  await box.waitFor({ timeout: 10000 });
  ok(!(await box.locator('input').count()), 'a name was asked for first');
  await box.getByRole('button').first().click();
  eq(await page.locator('.dialog').count(), 0, 'boxes still open');
  ok((await n.locator('textarea').inputValue()).length > 5 * 1024 * 1024, 'the text is still in the window');
});

await step('N-P1-3: Tab types a tab into the text; Escape then Tab leaves the text box', async () => {
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('notepad');
  await page.locator('.start-menu [data-label="notepad"]').first().click();
  const n = pad();
  await n.locator('textarea').type('a');
  await page.keyboard.press('Tab');
  eq(await n.locator('textarea').inputValue(), 'a\t', 'text after Tab');
  await page.keyboard.press('Control+z');
  eq(await n.locator('textarea').inputValue(), 'a', 'text after Ctrl+Z (the tab can be undone)');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Tab');
  eq(await n.locator('textarea').inputValue(), 'a', 'text after Escape, Tab');
  ok(!(await n.locator('textarea').evaluate(a => document.activeElement === a)), 'Escape then Tab left the focus in the text');
});

await step('P1: closing with changes offers to save them', async () => {
  const n = await openInNotepad('plain');
  await n.locator('textarea').type('z');
  await n.locator('.win-close').first().click();
  const text = await page.locator('.dialog').innerText();
  ok(/\bSave\b/.test(await page.locator('.dialog').getByRole('button').allInnerTexts().then(a => a.join('|'))), 'buttons in the close box: ' + text.replace(/\s+/g, ' ').slice(0, 160));
});

await step('N-P1-4: Save in the close question saves the file, then the window closes', async () => {
  const n = await openInNotepad('plain');
  const before = await n.locator('textarea').inputValue();
  await n.locator('textarea').press('End');
  await n.locator('textarea').type('Q');
  await n.locator('.win-close').first().click();
  await page.locator('.dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('.win', { has: page.locator('.editor') }).waitFor({ state: 'detached', timeout: 10000 });
  await closeAll();
  const bytes = (await downloadBytes('plain')).toString('utf8');
  ok(bytes.includes('Q') && !before.includes('Q'), 'saved text: ' + JSON.stringify(bytes.slice(0, 80)));
});

await step('N-P1-4: Save in the close question of a new, unnamed text, then Cancel in Save as, keeps the window open', async () => {
  await page.keyboard.press('Escape');
  if (!(await page.locator('.start-filter').isVisible())) await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('notepad');
  await page.locator('.start-menu [data-label="notepad"]').first().click();
  const n = pad();
  await n.locator('textarea').type('new words');
  await n.locator('.win-close').first().click();
  await page.locator('.dialog').getByRole('button', { name: 'Save', exact: true }).click();
  const saveAs = page.locator('.dialog').last();
  await saveAs.getByRole('button', { name: 'Cancel' }).click();
  await page.waitForTimeout(300);
  eq(await page.locator('.win', { has: page.locator('.editor') }).count(), 1, 'Notepad windows after Cancel in Save as');
  eq(await pad().locator('textarea').inputValue(), 'new words', 'the typing');
});

await browser.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) console.log('failed: ' + failures.join('; '));
process.exit(failures.length ? 1 : 0);
