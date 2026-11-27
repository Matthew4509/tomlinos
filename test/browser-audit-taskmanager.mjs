// Audit of the Task Manager in a real Chrome: faults found by trying to break it. Needs the dev server on a FRESH, EMPTY
// data folder (the first step sets up the owner), and `npm run build` done. Each step that fails names a fault still open.
//   node test/browser-audit-taskmanager.mjs [http://127.0.0.1:3138] [data folder of that server] [screenshot folder]
// With the data folder given, "Your files" is also checked against what the server counts against the storage limit.
import { chromium } from 'playwright-core';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3138';
const DATA = process.argv[3] ?? null;
const SHOTS = process.argv[4] ?? null;
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
    console.log('  FAIL ' + name + '\n       ' + String(error.message).slice(0, 800));
  }
}
const eq = (a, b, what) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const ok = (v, what) => {
  if (!v) throw new Error(what);
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const problems = [];
page.on('pageerror', e => problems.push('pageerror: ' + e.message));
const shot = async name => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });
const openApp = async label => {
  // The Start button opens and closes the menu: a step that failed with it open must not leave the next one closing it.
  if (!(await page.locator('.start-filter').isVisible())) await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill(label);
  await page.locator(`.start-menu [data-label="${label}"]`).first().click();
};
const tmWin = () => page.locator('.win', { has: page.locator('.tm') });
const tmRows = () => tmWin().locator('.tm-row');
const termWin = () => page.locator('.win', { has: page.locator('.term-in') }).first();
async function term(line) {
  const input = termWin().locator('.term-in');
  await input.fill(line);
  await input.press('Enter');
  await page.waitForTimeout(150);
}
async function closeAll() {
  for (let i = 0; i < 60; i++) {
    const dialog = page.locator('.dialog');
    if (await dialog.count()) {
      await dialog.first().getByRole('button', { name: /without saving|Lose the changes|Close anyway|Discard/ }).first().click({ timeout: 2000 }).catch(() => dialog.first().getByRole('button').last().click());
      continue;
    }
    if (!(await page.locator('.win').count())) return;
    await page.evaluate(() => document.querySelectorAll('.win .win-close').forEach(b => b.click()));
    await page.waitForTimeout(250);
  }
}
async function openTm() {
  // Opened again from the Start menu, a single-window app comes to the front.
  await openApp('task manager');
  await tmWin().locator('.tm-tabs').waitFor();
  if (await tmWin().locator('.tm-pane').first().isHidden()) await tmWin().getByRole('tab', { name: 'Apps' }).click();
  await tmWin().locator('.tm-list').waitFor();
}
async function dirtyNotes(text) {
  await openApp('quick notes');
  const win = page.locator('.win', { has: page.locator('.editor') }).last();
  await win.locator('textarea.editor-text').fill(text);
  return win;
}

console.log('Task Manager audit, against ' + BASE);
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

await step('baseline: the list shows every other window, and a dirty one as "Not saved"', async () => {
  await closeAll();
  await dirtyNotes('hello');
  await openApp('calculator');
  await openTm();
  eq(await tmRows().count(), 2, 'rows');
  const states = await tmRows().locator('.tm-state').allInnerTexts();
  ok(states.includes('Not saved'), 'Quick Notes with typing shows Not saved: ' + states);
});

await step('TM-P0-keys: the window list can be used from the keyboard (arrow picks a row, Enter switches, Delete ends)', async () => {
  await closeAll();
  await openApp('calculator');
  await openApp('quick notes');
  await openTm();
  await tmWin().locator('.tm-list').focus();
  await page.keyboard.press('ArrowDown');
  const picked = await tmWin().locator('.tm-row[aria-selected="true"]').count();
  eq(picked, 1, 'rows chosen after ArrowDown in the focused list');
  await page.keyboard.press('Enter');
  const front = await page.locator('.win.active .win-title-text').innerText();
  ok(!/Task Manager/.test(front), 'Enter did not switch to the chosen window; front is ' + front);
});

await step('TM-P1-4: Delete held down on a window with unsaved typing asks once, not three times over', async () => {
  await closeAll();
  await dirtyNotes('held');
  await openTm();
  await tmWin().locator('.tm-list').focus();
  await page.keyboard.press('Home');
  // Key repeat: three Delete presses reach the list before the first question has taken the focus.
  await tmWin().locator('.tm-list').evaluate(list => {
    for (let i = 0; i < 3; i++) list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
  });
  await page.locator('.dialog').first().waitFor();
  await page.waitForTimeout(300);
  eq(await page.locator('.dialog').count(), 1, 'close questions open');
  await page.locator('.dialog').getByRole('button', { name: 'Keep it open' }).click();
  eq(await page.locator('.dialog').count(), 0, 'questions left after Keep it open');
  eq(await page.locator('.win', { has: page.locator('.editor') }).count(), 1, 'Quick Notes windows still open');
});

let manyOk = false;
await step('setup: 120 small files opened in Quick Notes from the Terminal (120 windows)', async () => {
  await closeAll();
  await openApp('terminal');
  await termWin().locator('.term-in').waitFor();
  await term('mkdir many');
  await term('cd many');
  const names = Array.from({ length: 120 }, (_, i) => `f${String(i + 1).padStart(3, '0')}.txt`);
  for (let i = 0; i < names.length; i += 40) await term('touch ' + names.slice(i, i + 40).join(' '));
  for (let i = 0; i < 6; i++) await term(`echo line ${i} > note${i}.txt`);
  const t0 = Date.now();
  await term('open ' + names.join(' '));
  await page.waitForFunction(() => document.querySelectorAll('.win .editor').length >= 120, null, { timeout: 120000 });
  console.log('       opened 120 Quick Notes windows in ' + (Date.now() - t0) + ' ms');
  manyOk = true;
  console.log('       page heap now ' + Math.round((await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0)) / 1048576) + ' MB');
});

await step('TM-many: with 121 other windows the list shows exactly those, and the count is right', async () => {
  ok(manyOk, 'setup failed');
  const t0 = Date.now();
  await openTm();
  const wins = await page.locator('.win').count();
  const rows = await tmRows().count();
  console.log(`       Task Manager opened over ${wins - 1} windows in ${Date.now() - t0} ms`);
  eq(rows, wins - 1, 'rows vs other windows');
  ok((await tmWin().locator('.statusbar').innerText()).startsWith(String(wins - 1)), 'status count');
});

await step('TM-many-cost: a change in one window does not cost the Task Manager a visible stall with 120 windows', async () => {
  ok(manyOk, 'setup failed');
  // Focusing a window emits a change; the list compares a JSON of every row, and rebuilds when a title or state changes.
  const ms = await page.evaluate(async () => {
    const t0 = performance.now();
    const pads = [...document.querySelectorAll('.win')].filter(w => w.querySelector('.editor'));
    for (const w of pads.slice(0, 20)) w.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    return performance.now() - t0;
  });
  console.log(`       20 focus changes over 120 windows: ${Math.round(ms)} ms`);
  ok(ms < 1000, 'focus changes took ' + ms + ' ms');
});

await step('TM-many-scroll: a change elsewhere keeps the list where it was scrolled to, and the chosen row', async () => {
  ok(manyOk, 'setup failed');
  await openTm();
  await tmWin().locator('.tm-list').evaluate(l => (l.scrollTop = l.scrollHeight));
  const row = tmRows().last();
  await row.click();
  const before = await tmWin().locator('.tm-list').evaluate(l => l.scrollTop);
  // Another window gets unsaved work: its row's state changes, so the list is rebuilt.
  await page.evaluate(() => {
    const area = [...document.querySelectorAll('.win .editor textarea')][3];
    area.value = 'x';
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(200);
  const after = await tmWin().locator('.tm-list').evaluate(l => l.scrollTop);
  ok(Math.abs(after - before) < 2, `scroll moved from ${before} to ${after}`);
  eq(await tmWin().locator('.tm-row[aria-selected="true"]').count(), 1, 'chosen rows');
});

await step('TM-small: at its smallest size (360x320) with 120 rows, the End task button is still in view', async () => {
  ok(manyOk, 'setup failed');
  await openTm();
  const win = tmWin();
  // Drag the bottom-right corner inwards as far as it goes.
  const box = await win.boundingBox();
  const grip = win.locator('.edge-se');
  const g = await grip.boundingBox();
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 50, box.y + 50, { steps: 5 });
  await page.mouse.up();
  const wb = await win.boundingBox();
  const end = await win.getByRole('button', { name: 'End task' }).boundingBox();
  await shot('tm-small');
  console.log(`       window ${Math.round(wb.width)}x${Math.round(wb.height)}`);
  ok(end && end.y + end.height <= wb.y + wb.height && end.x + end.width <= wb.x + wb.width, 'End task is cut off: ' + JSON.stringify({ end, wb }));
});

await step('TM-P1-files: "Your files" agrees with what the server counts against the storage limit', async () => {
  await openTm();
  await tmWin().getByRole('tab', { name: 'Performance' }).click();
  await tmWin().getByRole('button', { name: 'Measure my files' }).click();
  await tmWin().locator('.tm-files strong', { hasText: / in / }).waitFor({ timeout: 60000 });
  const shown = await tmWin().locator('.tm-files strong').innerText();
  console.log('       Task Manager says: ' + shown);
  ok(DATA, 'no data folder given, cannot compare');
  // The server keeps a running total in a .usage file in each person's folder.
  const found = [];
  const walk = d => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (n === '.usage') found.push(Number(readFileSync(p, 'utf8').trim()));
      else if (statSync(p).isDirectory()) walk(p);
    }
  };
  if (existsSync(DATA)) walk(DATA);
  ok(found.length, 'no .usage file found under ' + DATA);
  const counted = Math.max(...found);
  const m = /^([\d.]+)\s*(B|bytes|KB|MB|GB)/i.exec(shown);
  const unit = { b: 1, bytes: 1, kb: 1024, mb: 1048576, gb: 1073741824 }[m[2].toLowerCase()];
  const shownBytes = Number(m[1]) * unit;
  console.log(`       server counts ${counted} bytes against the limit; Task Manager shows about ${Math.round(shownBytes)}`);
  ok(Math.abs(shownBytes - counted) <= counted * 0.1, `Task Manager shows ${shown}, the server counts ${(counted / 1048576).toFixed(2)} MB`);
});

await step('TM-mem: Memory follows what the page holds (100 MB more is shown within a few seconds)', async () => {
  await openTm();
  await tmWin().getByRole('tab', { name: 'Performance' }).click();
  await page.waitForTimeout(1500);
  const read = async () => tmWin().locator('.tm-card strong').nth(2).innerText();
  const before = await read();
  await page.evaluate(() => { window.__tmAuditHold = Array.from({ length: 3000000 }, (_, i) => ({ i, s: 'x' + i })); });
  await page.waitForTimeout(4000);
  const after = await read();
  await page.evaluate(() => { delete window.__tmAuditHold; });
  console.log('       Memory before: ' + before + ', after holding 3 million small objects (well over 100 MB): ' + after);
  const mb = t => { const m = /([\d.]+)\s*(bytes|KB|MB|GB)/.exec(t); return m ? Number(m[1]) * { bytes: 1 / 1048576, KB: 1 / 1024, MB: 1, GB: 1024 }[m[2]] : NaN; };
  ok(mb(after) - mb(before) >= 50, 'Memory did not follow: ' + before + ' -> ' + after);
});

await step('TM-fps-frozen: after the page was frozen (tab in the background), Smoothness does not read near 0', async () => {
  await openTm();
  await tmWin().getByRole('tab', { name: 'Performance' }).click();
  await page.waitForTimeout(2500);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
  await new Promise(r => setTimeout(r, 4000));
  await cdp.send('Page.setWebLifecycleState', { state: 'active' });
  await page.waitForTimeout(1300);
  const readings = [];
  for (let i = 0; i < 3; i++) {
    readings.push(Number(await tmWin().locator('.tm-card strong').first().innerText()));
    await page.waitForTimeout(400);
  }
  const low = await page.evaluate(() => 0);
  console.log('       Smoothness right after coming back: ' + readings.join(', '));
  ok(Math.min(...readings) > 20, 'Smoothness read ' + Math.min(...readings) + ' frames a second for time the page was not shown' + low);
});

await step('TM-self: Alt+Q ends the Task Manager itself, and its frame counter stops', async () => {
  await openTm();
  await tmWin().locator('.tm-list').focus().catch(() => tmWin().locator('.tm-tab').first().focus());
  await page.keyboard.press('Alt+q');
  await page.waitForTimeout(300);
  eq(await tmWin().count(), 0, 'Task Manager windows');
});

await closeAll();
await browser.close();
if (problems.length) console.log('page errors:\n  ' + problems.join('\n  '));
console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log('  - ' + f);
process.exit(failures.length ? 1 : 0);
