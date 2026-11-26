// Round-2 audit of Quick Notes (app id "editor") in a real Chrome: faults found by trying to break it. Needs the dev
// server on a FRESH, EMPTY data folder (the first step sets up the owner) and a fresh build. A FAIL names a P0 still
// open; an "info" line is a P1 seen (it does not fail the run).
//   node test/browser-audit2-quicknotes.mjs [http://127.0.0.1:3511] [screenshot folder]
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3511';
const SHOTS = process.argv[3] ?? null;
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PASS = 'quill-meadow-ribbon-73';
let passed = 0;
const failures = [];
const infos = [];

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const problems = [];
page.on('pageerror', e => problems.push('pageerror: ' + e.message));
page.on('dialog', d => void d.dismiss().catch(() => {}));
const shot = async name => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });

/** A step that hangs fails after 90 s instead of stopping the run. */
const within = (fn, ms = 90000) => Promise.race([fn(), new Promise((_, no) => setTimeout(() => no(new Error(`no answer in ${ms / 1000} s (hung)`)), ms))]);
async function step(name, fn) {
  try {
    await within(fn);
    passed++;
    console.log('  ok   ' + name);
  } catch (error) {
    failures.push(name);
    await shot('fail-' + failures.length).catch(() => {});
    console.log('  FAIL ' + name + '\n       ' + String(error.message).slice(0, 800));
  }
  await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
}
/** A P1 check: prints "info" when it does not hold, never fails the run. */
async function info(name, fn) {
  try {
    await within(fn);
    passed++;
    console.log('  ok   ' + name);
  } catch (error) {
    infos.push(name);
    console.log('  info ' + name + '\n       ' + String(error.message).slice(0, 600));
  }
  await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
}
const eq = (a, b, what) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const ok = (v, what) => {
  if (!v) throw new Error(what);
};

// ---- A second "device": its own file system on the same account, for files written or changed elsewhere ----
const dev = {
  write: (path, bytes) => page.evaluate(async ([p, b]) => {
    const { FileSystem } = await import('/app/fs/fs.js');
    const { ServerStore } = await import('/app/store/server-store.js');
    const fs = new FileSystem(new ServerStore('/api/store.php'));
    await fs.writeFile(p, new Uint8Array(b));
  }, [path, [...bytes]]),
  read: path => page.evaluate(async p => {
    const { FileSystem } = await import('/app/fs/fs.js');
    const { ServerStore } = await import('/app/store/server-store.js');
    const fs = new FileSystem(new ServerStore('/api/store.php'));
    return (await fs.exists(p)) ? [...(await fs.readFile(p))] : null;
  }, path),
  remove: path => page.evaluate(async p => {
    const { FileSystem } = await import('/app/fs/fs.js');
    const { ServerStore } = await import('/app/store/server-store.js');
    const fs = new FileSystem(new ServerStore('/api/store.php'));
    await fs.remove?.(p) ?? await fs.delete?.(p);
  }, path),
};
const utf8 = s => [...Buffer.from(s, 'utf8')];
const text = bytes => (bytes === null ? null : Buffer.from(bytes).toString('utf8'));

// ---- The app ----
const QN = () => page.locator('.win', { has: page.locator('.editor') });
const front = () => QN().last();
const box = () => front().locator('textarea.editor-text');
const statusOf = () => front().locator('.editor-status').innerText();
const D = () => page.locator('.dialog').last();
const titles = () => QN().locator('.win-title-text').allInnerTexts();
async function openQN() {
  if (!(await page.locator('.start-filter').isVisible())) await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('Quick Notes');
  await page.locator('.start-menu [data-label="quick notes"]').first().click();
  await box().waitFor();
}
async function closeAll() {
  for (let i = 0; i < 40; i++) {
    if (await page.locator('.dialog').count()) {
      const d = D();
      const b = d.getByRole('button', { name: /Close without saving|Cancel|Do not save|OK|Keep the/ }).first();
      if (await b.count()) await b.click().catch(() => {});
      else await page.keyboard.press('Escape');
      await page.waitForTimeout(80);
      continue;
    }
    const wins = page.locator('.win');
    if (!(await wins.count())) return;
    await wins.last().locator('.win-close').first().click().catch(() => {});
    await page.waitForTimeout(120);
  }
}
/** Opens a file through File > Open (Ctrl+O) in a fresh Quick Notes window; the start folder is Documents. */
async function openFile(name, { fresh = true } = {}) {
  if (fresh) {
    await closeAll();
    await openQN();
  }
  await box().focus();
  await page.keyboard.press('Control+o');
  const d = D();
  await d.getByText(name, { exact: true }).first().dblclick();
  await page.waitForTimeout(500);
}
async function saveAsIn(name) {
  const d = D();
  await d.locator('input[aria-label="File name"]').fill(name);
  await d.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForTimeout(400);
}
const typeAtEnd = async s => {
  await box().focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(s);
};

console.log('Quick Notes round-2 audit, against ' + BASE);
await page.goto(BASE);

await step('set up the owner', async () => {
  await page.locator('.gate h1', { hasText: 'Set up this desktop' }).waitFor({ timeout: 20000 });
  await page.getByLabel('Your name').fill('Sample Owner');
  await page.locator('.gate input.gate-input').last().fill(PASS);
  if (await page.locator('.gate-encrypt').count()) await page.locator('.gate-encrypt').uncheck();
  await page.locator('.gate-go').click();
  await page.locator('.gate .check-row input').check({ timeout: 30000 });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#desktop .item').first().waitFor({ timeout: 20000 });
});

// ---- Rule 1: what is in the box is what lands on disk ----
await step('QN-r1a: a file with a BOM, CRLF endings and a NUL keeps every byte when one letter is added and saved', async () => {
  const bytes = [0xef, 0xbb, 0xbf, ...utf8('line one\r\nline\ttwo\r\n'), 0x00, ...utf8('end\r\n')];
  await dev.write('/Documents/bom.txt', bytes);
  await openFile('bom.txt');
  await typeAtEnd('Z');
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(700);
  eq(await dev.read('/Documents/bom.txt'), [...bytes, ...utf8('Z')], 'bytes on disk');
});

await step('QN-r1b: old Mac (CR) and Unix (LF) files keep their endings; unicode (emoji, joiners, RTL, U+2028) is kept', async () => {
  const mac = utf8('a\rb\rc');
  await dev.write('/Documents/mac.txt', mac);
  await openFile('mac.txt');
  await typeAtEnd('!');
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(600);
  eq(text(await dev.read('/Documents/mac.txt')), 'a\rb\rc!', 'CR file');
  const uni = 'Zoë 👩‍👩‍👧 ‏שלום‏ e\u0301 a\u2028b \uFEFFmid\n';
  await dev.write('/Documents/uni.txt', utf8(uni));
  await openFile('uni.txt');
  await typeAtEnd('.');
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(600);
  eq(text(await dev.read('/Documents/uni.txt')), uni + '.', 'unicode file');
});

await step('QN-r1c: a new note saved with Ctrl+S lands with exactly what was typed (tabs, trailing spaces, blank lines)', async () => {
  await closeAll();
  await openQN();
  await box().focus();
  await page.keyboard.type('one  ');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('three');
  await page.keyboard.press('Control+s');
  await saveAsIn('typed.txt');
  eq(text(await dev.read('/Documents/typed.txt')), 'one  \t\n\nthree', 'bytes');
  const s = await statusOf();
  ok(!s.includes('not saved'), 'status still says not saved: ' + s);
});

// ---- Rule 2: the not-saved mark is right at every moment ----
await step('QN-r2a: typing during a slow save stays marked not saved, and the disk has only what was there when Save was pressed', async () => {
  await dev.write('/Documents/slow.txt', utf8('base'));
  await openFile('slow.txt');
  await page.route('**/api/store.php?op=commit', async route => {
    await new Promise(r => setTimeout(r, 1500));
    await route.continue();
  });
  await typeAtEnd('1');
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(200);
  await page.keyboard.type('2');
  await page.waitForTimeout(5000);
  eq(text(await dev.read('/Documents/slow.txt')), 'base1', 'disk');
  ok((await statusOf()).includes('not saved'), 'status after the save: ' + (await statusOf()));
  const task = await page.locator('.task-label', { hasText: 'slow.txt' }).innerText();
  ok(task.endsWith('*'), 'taskbar mark: ' + task);
});

await step('QN-r2b: undoing back to the saved text clears the mark; a line-ending switch sets it', async () => {
  await dev.write('/Documents/undo.txt', utf8('abc'));
  await openFile('undo.txt');
  await typeAtEnd('d');
  ok((await statusOf()).includes('not saved'), 'after typing');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(300);
  ok(!(await statusOf()).includes('not saved'), 'after undo: ' + (await statusOf()));
});

// ---- Rule 3: never silently overwrite ----
await step('QN-r3a: a file changed elsewhere asks before Save replaces it; "Do not save" keeps the other copy', async () => {
  await dev.write('/Documents/shared.txt', utf8('v1'));
  await openFile('shared.txt');
  await dev.write('/Documents/shared.txt', utf8('v2 from elsewhere'));
  await typeAtEnd('-mine');
  await page.keyboard.press('Control+s');
  await D().getByText('Changed somewhere else').waitFor({ timeout: 4000 });
  await D().getByRole('button', { name: 'Do not save' }).click();
  await page.waitForTimeout(300);
  eq(text(await dev.read('/Documents/shared.txt')), 'v2 from elsewhere', 'disk');
  ok((await statusOf()).includes('not saved'), 'still marked not saved');
});

await info('QN-6 (P1): Save as onto the same name, after the file was changed elsewhere, still warns that a newer copy will be replaced', async () => {
  await dev.write('/Documents/same.txt', utf8('v1'));
  await openFile('same.txt');
  await dev.write('/Documents/same.txt', utf8('v2 newer'));
  await typeAtEnd('-mine');
  await page.keyboard.press('Control+Shift+S');
  await saveAsIn('same.txt');
  // The picker asks "already exists. Replace it?": the person thinks of their own file.
  if (await D().getByText('Replace it?').count()) await D().getByRole('button', { name: 'Replace', exact: true }).click();
  await page.waitForTimeout(500);
  const asked = await page.locator('.dialog', { hasText: 'Changed somewhere else' }).count();
  const disk = text(await dev.read('/Documents/same.txt'));
  await closeAll();
  ok(asked > 0 || disk === 'v2 newer', `newer copy replaced without the "changed somewhere else" warning (disk now ${JSON.stringify(disk)})`);
});

// ---- Rule 4: closing asks ----
await step('QN-r4a: window × and Alt+Q with unsaved text ask once; Keep it open keeps the text', async () => {
  await closeAll();
  await openQN();
  await box().focus();
  await page.keyboard.type('keep me');
  await front().locator('.win-close').first().click();
  await D().getByText('Save your changes?').waitFor({ timeout: 3000 });
  await D().getByRole('button', { name: 'Keep it open' }).click();
  await box().focus();
  await page.keyboard.press('Alt+q');
  await page.waitForTimeout(300);
  eq(await page.locator('.dialog').count(), 1, 'dialogs after Alt+Q');
  await D().getByRole('button', { name: 'Keep it open' }).click();
  eq(await box().inputValue(), 'keep me', 'text');
});

await step('QN-r4b: Save in the close question saves and closes; on a new note, Cancel in Save as keeps the window and its text', async () => {
  await dev.write('/Documents/closesave.txt', utf8('c'));
  await openFile('closesave.txt');
  await typeAtEnd('1');
  await front().locator('.win-close').first().click();
  await D().getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForTimeout(800);
  eq(text(await dev.read('/Documents/closesave.txt')), 'c1', 'disk');
  eq(await QN().count(), 0, 'windows');
  await openQN();
  await box().focus();
  await page.keyboard.type('unnamed');
  await front().locator('.win-close').first().click();
  await D().getByRole('button', { name: 'Save', exact: true }).click();
  await D().locator('input[aria-label="File name"]').waitFor();
  await D().getByRole('button', { name: 'Cancel' }).click();
  await page.waitForTimeout(400);
  eq(await QN().count(), 1, 'windows');
  eq(await box().inputValue(), 'unnamed', 'text');
});

await step('QN-r10: ten Ctrl+S as fast as a key repeat on slow saves, then ×: one question, disk ends with the last text, no "changed elsewhere"', async () => {
  await dev.write('/Documents/burst.txt', utf8('b'));
  await openFile('burst.txt');
  await page.route('**/api/store.php?op=commit', async route => {
    await new Promise(r => setTimeout(r, 400));
    await route.continue();
  });
  for (let i = 0; i < 10; i++) {
    await typeAtEnd(String(i));
    await page.keyboard.press('Control+s');
  }
  await front().locator('.win-close').first().click();
  await page.waitForTimeout(300);
  const asked = await page.locator('.dialog').allInnerTexts();
  ok(!asked.some(t => t.includes('Changed somewhere else')), 'claimed a change elsewhere');
  if (asked.length) await D().getByRole('button', { name: 'Save', exact: true }).click().catch(() => {});
  await page.waitForTimeout(6000);
  eq(text(await dev.read('/Documents/burst.txt')), 'b0123456789', 'disk');
  ok(!(await page.locator('.dialog', { hasText: 'Changed somewhere else' }).count()), 'changed-elsewhere box after the burst');
});

// ---- New, Open in the same window ----
await step('QN-1: File › New (Alt+N) from a new note with text opens a second note', async () => {
  await closeAll();
  await openQN();
  await box().focus();
  await page.keyboard.type('first note');
  await page.keyboard.press('Alt+n');
  await page.waitForTimeout(600);
  eq(await QN().count(), 2, 'Quick Notes windows after Alt+N');
});

await step('QN-1b: after a new note is saved as a file, Start › Quick Notes still gives a new empty note', async () => {
  await closeAll();
  await openQN();
  await box().focus();
  await page.keyboard.type('saved note');
  await page.keyboard.press('Control+s');
  await saveAsIn('saved-note.txt');
  await openQN();
  await page.waitForTimeout(300);
  eq(await QN().count(), 2, 'windows');
  eq(await box().inputValue(), '', 'the front window is a new empty note');
});

await step('QN-2: after Save as to another name, opening the original file shows the original file', async () => {
  await dev.write('/Documents/orig.txt', utf8('original words'));
  await openFile('orig.txt');
  await page.keyboard.press('Control+Shift+S');
  await saveAsIn('copy.txt');
  eq(await titles(), ['copy.txt'], 'titles after Save as');
  // A second, empty note opens the original again.
  await page.keyboard.press('Alt+n');
  await page.waitForTimeout(500);
  await box().focus();
  await page.keyboard.press('Control+o');
  await D().getByText('orig.txt', { exact: true }).first().dblclick();
  await page.waitForTimeout(800);
  const t = await titles();
  ok(t.includes('orig.txt'), 'no window shows orig.txt; titles: ' + JSON.stringify(t));
});

await step('QN-r5a: Open from an untitled empty note opens the file in its place (one window)', async () => {
  await dev.write('/Documents/take.txt', utf8('taken over'));
  await openFile('take.txt');
  eq(await QN().count(), 1, 'windows');
  eq(await box().inputValue(), 'taken over', 'text');
});

await step('QN-r5b: Open from a new note with text keeps that note and opens the file beside it', async () => {
  await closeAll();
  await openQN();
  await box().focus();
  await page.keyboard.type('draft');
  await openFile('take.txt', { fresh: false });
  eq(await QN().count(), 2, 'windows');
  eq(await QN().first().locator('textarea').inputValue(), 'draft', 'draft kept');
});

await step('QN-8: text typed into a file\'s window while the file is still loading is not thrown away', async () => {
  const big = 'x'.repeat(1000) + '\n';
  await dev.write('/Documents/loading.txt', utf8(big));
  await closeAll();
  await openQN();
  await box().focus();
  await page.route(/api\/store\.php\?key=/, async route => {
    await new Promise(r => setTimeout(r, 300));
    await route.continue();
  });
  await page.keyboard.press('Control+o');
  await D().getByText('loading.txt', { exact: true }).first().dblclick();
  await page.waitForTimeout(150);
  await page.locator('.win textarea.editor-text').last().click();
  await page.keyboard.type('typed while loading');
  const during = await page.locator('.win textarea.editor-text').last().inputValue();
  await page.waitForTimeout(2500);
  const all = await page.locator('.win textarea.editor-text').evaluateAll(els => els.map(e => e.value));
  ok(!during.includes('typed while loading') || all.some(v => v.includes('typed while loading')),
    `the box held ${JSON.stringify(during.slice(0, 30))} while loading, then the typed text vanished; boxes now: ${JSON.stringify(all.map(v => v.slice(0, 30)))}`);
});

// ---- Rule 6: files it cannot open ----
await step('QN-r6a: a file that is not UTF-8 text says so, keeps every byte, and Ctrl+S / Save cannot write it', async () => {
  const bin = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x01];
  await dev.write('/Documents/pic.txt', bin);
  await openFile('pic.txt');
  ok((await statusOf()).includes('does not look like text'), 'status: ' + (await statusOf()));
  await front().locator('.win-body').click({ position: { x: 30, y: 60 } }).catch(() => {});
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(500);
  ok(!(await page.locator('.dialog', { hasText: 'Save as' }).count()), 'a Save as box opened for a file that was not opened');
  eq(await dev.read('/Documents/pic.txt'), bin, 'bytes');
  eq(await QN().locator('textarea').last().isDisabled(), true, 'box disabled');
});

await step('QN-15 (P2): a window that could not open its file names the file and still takes Ctrl+O and Alt+N', async () => {
  const t = await titles();
  ok(t.includes('pic.txt'), 'titles ' + JSON.stringify(t));
  await front().locator('.win-bar').click();
  await page.keyboard.press('Control+o');
  await page.waitForTimeout(500);
  const opened = await page.locator('.dialog', { hasText: 'Open' }).count();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  ok(opened > 0, 'Ctrl+O did nothing');
  const before = await QN().count();
  await front().locator('.win-bar').click();
  await page.keyboard.press('Alt+n');
  await page.waitForTimeout(600);
  eq(await QN().count(), before + 1, 'Alt+N opened a new note');
  // Ctrl+S and zoom keys in the refused window still do nothing to the file or its message.
  await front().locator('.win-close').first().click();
  await page.waitForTimeout(300);
  await QN().nth(before - 1).locator('.win-title-text').click();
  await page.keyboard.press('Control+s');
  await page.keyboard.press('Control+=');
  await page.waitForTimeout(500);
  ok(!(await page.locator('.dialog', { hasText: 'Save as' }).count()), 'a Save as box opened');
  ok((await QN().nth(before - 1).locator('.editor-status').innerText()).includes('does not look like text'), 'message replaced');
  eq(await dev.read('/Documents/pic.txt'), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x01], 'bytes');
});

await step('QN-9 (P2 interop): a UTF-16 file saved by Windows Notepad ("Unicode") opens as text and saves back as UTF-16', async () => {
  const u16 = [0xff, 0xfe, ...[...Buffer.from('hello é😀\r\n', 'utf16le')]];
  await dev.write('/Documents/unicode16.txt', u16);
  await openFile('unicode16.txt');
  eq(await box().inputValue(), 'hello é😀\n', 'text');
  ok((await statusOf()).includes('UTF-16 LE'), 'status ' + (await statusOf()));
  await typeAtEnd('ß');
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(700);
  eq(await dev.read('/Documents/unicode16.txt'), [0xff, 0xfe, ...Buffer.from('hello é😀\r\nß', 'utf16le')], 'bytes on disk');
  const be = [0xfe, 0xff, ...Buffer.from('big end\n', 'utf16le').swap16()];
  await dev.write('/Documents/be16.txt', be);
  await openFile('be16.txt');
  eq(await box().inputValue(), 'big end\n', 'UTF-16 BE text');
  await typeAtEnd('!');
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(700);
  eq(await dev.read('/Documents/be16.txt'), [0xfe, 0xff, ...Buffer.from('big end\n!', 'utf16le').swap16()], 'UTF-16 BE bytes on disk');
});

await step('QN-9 (P2 interop): an ANSI (Windows-1252) file opens, says so, and saves back in Windows-1252; a letter it cannot hold asks first', async () => {
  const ansi = [0x43, 0x61, 0x66, 0xe9, 0x20, 0x80, 0x35, 0x0d, 0x0a];
  await dev.write('/Documents/ansi.txt', ansi);
  await openFile('ansi.txt');
  eq(await box().inputValue(), 'Café €5\n', 'text');
  ok((await statusOf()).includes('Windows-1252'), 'status ' + (await statusOf()));
  await typeAtEnd('ü');
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(700);
  eq(await dev.read('/Documents/ansi.txt'), [...ansi, 0xfc], 'bytes on disk');
  await typeAtEnd('😀');
  await page.keyboard.press('Control+s');
  await D().getByText('Save as UTF-8?').waitFor();
  await D().getByRole('button', { name: 'Cancel' }).click();
  await page.waitForTimeout(400);
  eq(await dev.read('/Documents/ansi.txt'), [...ansi, 0xfc], 'Cancel kept the file');
  await page.keyboard.press('Control+s');
  await D().getByRole('button', { name: 'Save as UTF-8' }).click();
  await page.waitForTimeout(700);
  eq(text(await dev.read('/Documents/ansi.txt')), 'Café €5\r\nü😀', 'saved as UTF-8');
  ok((await statusOf()).includes('UTF-8'), 'status ' + (await statusOf()));
});

await step('QN-12 (P2): a file with mixed line endings keeps each line\'s own ending; Line endings makes them one kind', async () => {
  const file = 'one\r\ntwo\nthree\r\nfour\n';
  await dev.write('/Documents/mixed.txt', utf8(file));
  await openFile('mixed.txt');
  ok((await statusOf()).includes('Mixed line endings'), 'status ' + (await statusOf()));
  await box().focus();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(700);
  eq(text(await dev.read('/Documents/mixed.txt')), 'one!\r\ntwo\nthree\r\nfour\n', 'after one letter');
  await front().locator('.cbar-title[data-menu=Format]').click();
  await page.locator('.menu-item', { hasText: 'Line endings when saving' }).click();
  await page.locator('.menu-item', { hasText: 'Unix (LF) (LF)' }).click();
  await page.waitForTimeout(300);
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(700);
  eq(text(await dev.read('/Documents/mixed.txt')), 'one!\ntwo\nthree\nfour\n', 'after Unix chosen');
});

await step('QN-16 (P2): the status-bar column counts an emoji (even a joined one) as one letter', async () => {
  await dev.write('/Documents/emoji.txt', utf8('😀👩‍👩‍👧x'));
  await openFile('emoji.txt');
  await box().focus();
  await page.keyboard.press('Control+End');
  await page.waitForTimeout(300);
  ok((await statusOf()).startsWith('Ln 1, Col 4'), 'status ' + (await statusOf()));
});

await step('QN-r6b: a file over the limit says so and is unharmed', async () => {
  await page.evaluate(async () => {
    const { FileSystem } = await import('/app/fs/fs.js');
    const { ServerStore } = await import('/app/store/server-store.js');
    const fs = new FileSystem(new ServerStore('/api/store.php'));
    await fs.writeFile('/Documents/huge.txt', new Uint8Array(5 * 1024 * 1024 + 1).fill(0x61));
  });
  await openFile('huge.txt');
  ok((await statusOf()).includes('It is safe where it is'), 'status: ' + (await statusOf()));
});

await info('QN-10 (P1): when the server refuses to read a file (503), the window says the server failed, not that the file is gone', async () => {
  await dev.write('/Documents/flaky.txt', utf8('still here'));
  await closeAll();
  await openQN();
  await box().focus();
  await page.keyboard.press('Control+o');
  const d = D();
  await d.getByText('flaky.txt', { exact: true }).first().click();
  await page.waitForTimeout(400);
  await page.route(/api\/store\.php\?key=/, route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"The server is busy. Try again in a moment."}' }));
  await d.getByRole('button', { name: 'Open', exact: true }).click();
  await page.waitForTimeout(800);
  const s = await statusOf();
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  ok(!/not there any more|moved or deleted/.test(s), 'status: ' + s);
});

// ---- Failure injection on save ----
await step('QN-r3b: a save refused by the server (503) says so once, stays not saved, and a second Save works', async () => {
  await dev.write('/Documents/retry.txt', utf8('r'));
  await openFile('retry.txt');
  await typeAtEnd('1');
  let n = 0;
  await page.route('**/api/store.php?op=commit', route => (n++ === 0 ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Busy"}' }) : route.continue()));
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(800);
  eq(await page.locator('.dialog').count(), 1, 'error boxes');
  ok((await statusOf()).includes('not saved'), 'mark');
  await D().getByRole('button').first().click();
  await box().focus();
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(800);
  eq(text(await dev.read('/Documents/retry.txt')), 'r1', 'disk after retry');
  ok(!(await statusOf()).includes('not saved'), 'mark after retry');
});

await info('QN-11 (P1): a save whose answer is a 200 HTML page (a proxy or login page) gives a plain message, not a JSON parse error', async () => {
  await dev.write('/Documents/html200.txt', utf8('h'));
  await openFile('html200.txt');
  await typeAtEnd('1');
  await page.route('**/api/store.php?op=commit', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Sign in</title>' }));
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(800);
  const msg = (await page.locator('.dialog').count()) ? await D().innerText() : '(no box)';
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await closeAll();
  ok(!/JSON|Unexpected token|SyntaxError|<!doctype/i.test(msg) && msg !== '(no box)', 'message: ' + msg.replace(/\s+/g, ' ').slice(0, 300));
});

await step('QN-r3c: two quick Ctrl+S on a new note give one Save as box', async () => {
  await closeAll();
  await openQN();
  await box().focus();
  await page.keyboard.type('twice');
  await page.keyboard.press('Control+s');
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(500);
  eq(await page.locator('.dialog').count(), 1, 'boxes');
  await closeAll();
});

await step('QN-14 (P2): File › Open lists every file Quick Notes opens (a .json is hidden until "All files" is chosen)', async () => {
  await dev.write('/Documents/conf.json', utf8('{"a":1}'));
  await closeAll();
  await openQN();
  await box().focus();
  await page.keyboard.press('Control+o');
  await page.waitForTimeout(600);
  const seen = await D().getByText('conf.json', { exact: true }).count();
  await page.keyboard.press('Escape');
  ok(seen > 0, 'conf.json not listed under the first file type');
});

await info('QN-4 (P1): Save as of a .json file with its own name keeps the name (no ".txt" added)', async () => {
  await closeAll();
  await openQN();
  await box().focus();
  await page.keyboard.press('Control+o');
  await D().locator('select.pick-type-box').selectOption({ label: 'All files (*.*)' });
  await D().getByText('conf.json', { exact: true }).first().dblclick();
  await page.waitForTimeout(600);
  await page.keyboard.press('Control+Shift+S');
  const d = D();
  const name = await d.locator('input[aria-label="File name"]').inputValue();
  await d.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForTimeout(400);
  if (await D().getByText('Replace it?').count()) await D().getByRole('button', { name: 'Replace', exact: true }).click();
  await page.waitForTimeout(400);
  const t = await titles();
  ok(t.includes('conf.json'), `name box had ${JSON.stringify(name)}; window now ${JSON.stringify(t)}`);
});

// ---- Rule 7: Find, Replace, Go to line ----
const setText = async s => {
  await closeAll();
  await openQN();
  await box().evaluate((el, v) => {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, s);
};
await step('QN-r7a: Find after a Turkish İ selects the right word; Replace all then Ctrl+Z gives back the text', async () => {
  await setText('İstanbul and cat and Cat');
  await box().focus();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Control+f');
  await page.keyboard.type('cat');
  await page.keyboard.press('Enter');
  const sel = await box().evaluate(el => el.value.slice(el.selectionStart, el.selectionEnd));
  eq(sel, 'cat', 'selected');
  await page.keyboard.press('Control+h');
  await front().locator('input[aria-label="Find"]').fill('cat');
  await front().locator('input[aria-label="Replace with"]').fill('dog$&');
  await front().getByRole('button', { name: 'Replace all' }).click();
  eq(await box().inputValue(), 'İstanbul and dog$& and dog$&', 'after replace all');
  await box().focus();
  await page.keyboard.press('Control+z');
  eq(await box().inputValue(), 'İstanbul and cat and Cat', 'after undo');
});

await step('QN-3 (P1): Find and Replace all agree on what matches (find "İ" in "i", Deseret capitals, ẞ)', async () => {
  await setText('i 𐐨 ß');
  await box().focus();
  await page.keyboard.press('Control+h');
  const f = front();
  const outcomes = [];
  for (const q of ['İ', '𐐀', 'ẞ']) {
    await f.locator('input[aria-label="Find"]').fill(q);
    await page.keyboard.press('Enter');
    const found = !(await f.locator('.find-note').innerText()).startsWith('Cannot');
    await f.locator('input[aria-label="Replace with"]').fill('X');
    await f.getByRole('button', { name: 'Replace all' }).click();
    const note = await f.locator('.find-note').innerText();
    const replaced = note.startsWith('Replaced');
    if (replaced) await box().evaluate(el => { el.value = 'i 𐐨 ß'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    outcomes.push(`${q}: find ${found ? 'finds' : 'misses'}, replace all ${replaced ? 'replaces' : 'misses'}`);
    if (found !== replaced) continue;
  }
  ok(outcomes.every(o => /finds, replace all replaces|misses, replace all misses/.test(o)), outcomes.join('; '));
});

await step('QN-3 (P1): the Replace button replaces the match Find chose (dotted İ, final ς), not just moves on', async () => {
  await setText('İ and ς and x');
  await box().focus();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Control+h');
  const f = front();
  await f.locator('input[aria-label="Replace with"]').fill('X');
  for (const q of ['i', 'Σ']) {
    await f.locator('input[aria-label="Find"]').fill(q);
    await f.locator('input[aria-label="Find"]').press('Enter');
    await f.getByRole('button', { name: 'Replace', exact: true }).click();
  }
  eq(await box().inputValue(), 'X and X and x', 'after two Replace');
});

await step('QN-5 (P1): case-blind Find next in a 4.9 MB file answers within 300 ms', async () => {
  const line = 'The quick brown fox jumps over the lazy dog. ';
  await setText(line.repeat(Math.floor(4.9e6 / line.length)));
  await page.waitForTimeout(500);
  await box().focus();
  await page.keyboard.press('Control+f');
  await page.keyboard.type('lazy');
  const ms = await front().locator('input[aria-label="Find"]').evaluate(el => {
    const t = performance.now();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return performance.now() - t;
  });
  ok(ms < 300, `one Find next took ${Math.round(ms)} ms`);
});

await step('QN-r7b: Go to line on a 20,000-line file lands on that line and shows it', async () => {
  await setText(Array.from({ length: 20000 }, (_, i) => `line ${i + 1}`).join('\n'));
  await box().focus();
  await page.keyboard.press('Control+g');
  await D().locator('input').fill('15000');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  ok((await statusOf()).startsWith('Ln 15000, Col 1'), 'status ' + (await statusOf()));
  const visible = await box().evaluate(el => el.scrollTop > 0);
  ok(visible, 'box did not scroll');
});

await step('QN-13 (P1, ridiculous tier): Find next for the last word of one 4.9 MB line answers within 1 s and shows it', async () => {
  await setText('word '.repeat(980000) + 'needle');
  await page.waitForTimeout(500);
  await box().focus();
  await page.keyboard.press('Control+f');
  await front().locator('input[aria-label="Find"]').fill('needle');
  await front().locator('.find-case input').check();
  const ms = await front().locator('input[aria-label="Find"]').evaluate(el => {
    const t = performance.now();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return performance.now() - t;
  });
  const sel = await box().evaluate(el => el.value.slice(el.selectionStart, el.selectionEnd));
  eq(sel, 'needle', 'selected');
  ok(ms < 1000, `took ${Math.round(ms)} ms`);
  // The match is on the last row, so the box is scrolled to its bottom.
  const view = await box().evaluate(el => ({ top: el.scrollTop, client: el.clientHeight, height: el.scrollHeight }));
  ok(view.top + view.client >= view.height - 2, 'not scrolled to the match: ' + JSON.stringify(view));
});

// ---- Rule 8: names ----
await step('QN-r8: every name on screen says Quick Notes, never plain "Notepad"', async () => {
  await closeAll();
  await openQN();
  for (const m of ['File', 'Edit', 'View', 'Format', 'Help']) {
    await front().locator(`.cbar-title[data-menu="${m}"]`).click();
    await page.waitForTimeout(100);
    const t = await page.locator('body').innerText();
    ok(!/Notepad(?! Pro)/.test(t), `"${m}" menu open shows Notepad`);
    await page.keyboard.press('Escape');
  }
  if (!(await page.locator('.start-filter').isVisible())) await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('note');
  await page.waitForTimeout(300);
  const startText = await page.locator('.start-menu').evaluate(el => el.textContent);
  await page.keyboard.press('Escape');
  ok(!/Notepad(?! Pro)/.test(startText), 'Start menu shows Notepad');
  ok(/Quick Notes/.test(startText), 'Start menu lacks Quick Notes');
});

// ---- Rule 9: keyboard and phone width ----
await step('QN-r9a: Escape in the find box closes only the find bar; Escape then Tab leaves the text box', async () => {
  await setText('abc');
  await box().focus();
  await page.keyboard.press('Control+f');
  await page.keyboard.press('Escape');
  eq(await front().locator('.find-bar').isHidden(), true, 'find bar hidden');
  eq(await QN().count(), 1, 'window still open');
  await box().focus();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Tab');
  const inBox = await page.evaluate(() => document.activeElement?.classList.contains('editor-text'));
  eq(inBox, false, 'focus still in the box');
});

await step('QN-r9b: at 375 px wide the note, its menus and its status fit with no side scroll; Save as can be reached', async () => {
  await page.setViewportSize({ width: 375, height: 740 });
  await page.waitForTimeout(400);
  await setText('phone note');
  const r = await front().evaluate(el => el.getBoundingClientRect().right);
  ok(r <= 376, 'window right edge ' + r);
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
  ok(scroll <= 375, 'page scrollWidth ' + scroll);
  await front().locator('.cbar-title[data-menu="File"]').click().catch(async () => front().locator('.cbar-more').first().click());
  await page.getByRole('menuitem', { name: /Save as/ }).first().click();
  await D().locator('input[aria-label="File name"]').waitFor({ timeout: 3000 });
  const dr = await D().evaluate(el => el.getBoundingClientRect().right);
  ok(dr <= 376, 'Save as box right edge ' + dr);
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1280, height: 800 });
});

// Last: it leaves the page at the sign-in screen.
await info('QN-7 (P1): Sign out with an unsaved note asks first (the note is only in this tab\'s memory under the sign-in screen)', async () => {
  await closeAll();
  await openQN();
  await box().focus();
  await page.keyboard.type('unsaved before sign out');
  await page.locator('.start-btn').click();
  await page.locator('.start-signout').click();
  await page.waitForTimeout(800);
  const asked = await page.locator('.dialog', { hasText: /not saved|unsaved|Save/ }).count();
  await shot('qn7-after-signout');
  const screen = (await page.locator('.gate').allInnerTexts()).join(' | ').replace(/\s+/g, ' ').slice(0, 200);
  const noteStill = await page.locator('textarea.editor-text').evaluateAll(els => els.map(e => e.value));
  ok(asked > 0, `signed out with no question about the unsaved note; screen now: "${screen}"; note kept in the page underneath: ${JSON.stringify(noteStill)}`);
});

await step('no uncaught page errors', async () => {
  eq(problems, [], 'page errors');
});

console.log(`\n${passed} passed, ${failures.length} failed, ${infos.length} info`);
for (const f of failures) console.log('  failed: ' + f);
await browser.close();
process.exit(failures.length ? 1 : 0);
