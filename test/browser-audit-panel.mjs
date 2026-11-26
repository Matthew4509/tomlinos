// Audit of the Panel in a real Chrome: the scratch pad (saving, Open full, two tabs, very long text, odd names, a
// save still under way), the Overview tiles (Today, Focus, Recent files), Mail in the ticket shape against the stand-in
// mail server, what the Panel costs when idle, keyboard use and a small window. Each step marked FAULT failed when it
// was written (P0 or P1 as named). Needs the dev server on a FRESH, EMPTY data folder (the first step sets up the
// owner), `npm run build` done, and the server started with
//   DESKTOP_MAIL_ALLOW_HOSTS=127.0.0.1:3443,127.0.0.1:3887 DESKTOP_MAIL_ALLOW_PLAIN=1
// (the stand-in mail server is started here on those two ports). Nothing here loads an AI model or calls an AI service.
//   node test/browser-audit-panel.mjs [http://127.0.0.1:3143] [screenshot folder]
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startFakeMail, USER as MAIL_USER, PASS as MAIL_PASS } from './fake-mail.mjs';
import { tempDir } from './tmp.ts';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3143';
const SHOTS = process.argv[3] ?? null;
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PASS = 'orchard-lantern-harbour-58';
const IMAP = Number(process.env.AUDIT_IMAP ?? 3443);
const SMTP = Number(process.env.AUDIT_SMTP ?? 3887);
let passed = 0;
const failures = [];

/** ONLY=<words>: run just the steps whose names hold them (and the set-up). */
const ONLY = process.env.ONLY ?? '';
async function step(name, fn) {
  if (ONLY && !name.includes(ONLY) && !name.startsWith('set up')) return;
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
let page = await context.newPage();
page.setDefaultTimeout(10000);
const problems = [];
const watch = p => {
  p.on('pageerror', e => problems.push('pageerror: ' + e.message));
  // Nothing here may reach anything but this computer.
  p.on('request', r => {
    const u = new URL(r.url());
    if (!['127.0.0.1', 'localhost'].includes(u.hostname) && !u.protocol.startsWith('data') && !u.protocol.startsWith('blob')) problems.push('left this computer: ' + r.url());
  });
};
watch(page);
const shot = async name => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png`, timeout: 5000 });
const front = (p = page) => p.locator('.win.active');
const D = (p = page) => p.locator('.dialog');
const panel = (p = page) => p.locator('.win', { has: p.locator('.panel-app') });
const pad = (p = page) => panel(p).locator('.scratch-pad');
const today = () => {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
};

async function closeAll(p = page) {
  for (let i = 0; i < 40; i++) {
    const dialog = p.locator('.dialog');
    if (await dialog.count()) {
      await dialog.getByRole('button', { name: /without saving|without sending|Leave them|Discard|Close anyway|Cancel|OK/ }).first().click().catch(() => dialog.getByRole('button').last().click());
      continue;
    }
    const wins = p.locator('.win');
    if (!(await wins.count())) return;
    await wins.last().locator('.win-close').first().click();
    await p.waitForTimeout(80);
  }
  throw new Error('windows would not close');
}
async function openApp(label, p = page) {
  if (!(await p.locator('.start-filter').isVisible())) await p.locator('.start-btn').click();
  await p.locator('.start-filter').fill(label);
  await p.locator(`.start-menu [data-label="${label}"]`).first().click();
}
async function openPanel(p = page) {
  await openApp('panel', p);
  await panel(p).locator('.panel-nav-item', { hasText: 'OVERVIEW' }).waitFor({ timeout: 15000 });
  await pad(p).locator('.pad-name').waitFor();
  return panel(p);
}
/** Types into the pad and saves with Ctrl+S, waiting for "saved". */
async function padSave(text, name, p = page) {
  if (name !== undefined) await pad(p).locator('.pad-name').fill(name);
  if (text !== undefined) await pad(p).locator('.pad-text').fill(text);
  await pad(p).locator('.pad-text').press('Control+s');
  await pad(p).locator('.pad-state', { hasText: /^saved$/ }).waitFor({ timeout: 15000 });
}
/** Opens a saved pad by its name in the list, waits till it is the open one. */
async function padOpen(label, p = page) {
  await pad(p).locator('.pad-item', { hasText: label }).first().click();
  await pad(p).locator('.pad-item.on', { hasText: label }).first().waitFor({ timeout: 10000 });
}
/** The text of a file, read through the Panel's own Terminal (cat), so no other app is in the way. */
async function fileText(path, p = page) {
  const w = panel(p);
  await w.locator('.panel-terminal').click();
  const input = w.locator('.panel-host .term-in');
  await input.waitFor();
  const mark = `END-${Math.random().toString(36).slice(2, 8)}`;
  const rows = w.locator('.panel-host:not([hidden]) .term-row');
  const start = await rows.count();
  await input.fill(`cat "${path}"`);
  await input.press('Enter');
  await input.fill(`echo ${mark}`);
  await input.press('Enter');
  await w.locator('.term-row', { hasText: mark }).last().waitFor({ timeout: 15000 });
  const all = await rows.allInnerTexts();
  await w.locator('.panel-brand').click();
  return all.slice(start).join('\n');
}
async function documents(p = page) {
  await p.keyboard.press('Control+Alt+e');
  const w = front(p);
  await w.locator('.item', { hasText: 'Documents' }).first().dblclick();
  await p.waitForTimeout(300);
  return w;
}
const item = (w, name) => {
  const stem = name.replace(/\.\w+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return w.locator('.item', { has: page.locator('.item-name', { hasText: new RegExp(`^${stem}(\\.\\w+)?$`) }) });
};
async function removeFile(w, name) {
  if (!(await item(w, name).count())) return;
  await item(w, name).first().click();
  await page.keyboard.press('Delete');
  await page.waitForTimeout(300);
  if (await D().count()) await D().getByRole('button', { name: /Delete|Yes|Move|OK|Recycle/ }).first().click();
  await item(w, name).first().waitFor({ state: 'detached' });
}
/** Puts these files in Documents (uploaded as a person would). */
async function upload(files) {
  const dir = tempDir('tomlinos-audit-panel-');
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const w = await documents();
  for (const name of Object.keys(files)) await removeFile(w, name);
  const chooser = page.waitForEvent('filechooser');
  await w.getByRole('button', { name: 'Upload' }).click();
  (await chooser).setFiles(Object.keys(files).map(n => join(dir, n)));
  await page.waitForTimeout(500);
  if (await D().count()) await D().getByRole('button', { name: /Replace|Overwrite|Yes/ }).first().click().catch(() => undefined);
  for (const n of Object.keys(files)) await item(w, n).first().waitFor({ timeout: 15000 });
  await w.locator('.win-close').first().click();
}

console.log('Panel audit, against ' + BASE);
const fake = await startFakeMail({ imap: IMAP, smtp: SMTP });
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

await step('Panel opens on the Overview; the Chat tile, with no AI set up, says something sensible and nothing is downloaded', async () => {
  const w = await openPanel();
  await page.waitForTimeout(2500);
  const chat = await w.locator('.panel-chat').innerText();
  console.log('       chat tile reads: ' + JSON.stringify(chat.slice(0, 300)));
  ok(chat.trim().length > 0, 'the chat tile is not blank');
  await shot('overview');
});

await step('PROBE what the Panel costs when idle on the Overview (requests in 40 s)', async () => {
  await openPanel();
  await page.waitForTimeout(3000);
  const seen = [];
  const listen = r => seen.push(new URL(r.url()).pathname + new URL(r.url()).search.slice(0, 40));
  page.on('request', listen);
  const mutations = await panel().evaluate(win => new Promise(done => {
    let n = 0;
    const mo = new MutationObserver(list => (n += list.length));
    mo.observe(win, { childList: true, subtree: true, characterData: true });
    setTimeout(() => (mo.disconnect(), done(n)), 40000);
  }));
  page.off('request', listen);
  const counts = {};
  for (const s of seen) counts[s.split('?')[0]] = (counts[s.split('?')[0]] ?? 0) + 1;
  console.log(`       ${seen.length} requests in 40 s: ${JSON.stringify(counts)}; ${mutations} DOM changes`);
});

await step('the scratch pad saves under the day, and a named pad under its name', async () => {
  await openPanel();
  await padSave('first note');
  await pad().locator('.pad-item', { hasText: today() }).waitFor();
  await pad().getByText('', { exact: false });
  await panel().getByRole('button', { name: 'New', exact: true }).click();
  await padSave('shopping: eggs', 'Shopping');
  await pad().locator('.pad-item', { hasText: 'Shopping' }).waitFor();
  const t = await fileText('/Documents/Scratch pad/Shopping.txt');
  ok(t.includes('shopping: eggs'), 'the file holds the text: ' + t.slice(0, 200));
});

await step('FAULT (P0): edits made with Open full (Notepad Pro) are not overwritten by the Panel pad on its next save', async () => {
  const w = await openPanel();
  await padOpen('Shopping');
  await w.getByRole('button', { name: 'Open full' }).click();
  const npp = page.locator('.win', { has: page.locator('.npp') }).last();
  await npp.locator('.npp-tab-name', { hasText: 'Shopping' }).waitFor({ timeout: 15000 });
  await npp.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nmilk (added in Notepad Pro)');
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(1500);
  await npp.locator('.win-close').first().click();
  await page.waitForTimeout(500);
  if (await D().count()) await D().getByRole('button').first().click();
  ok((await fileText('/Documents/Scratch pad/Shopping.txt')).includes('milk (added in Notepad Pro)'), 'Notepad Pro did not save (test set-up)');
  // Back in the Panel, still on the same pad: it should show the Notepad Pro line (or at least not throw it away).
  const shown = await pad().locator('.pad-text').inputValue();
  console.log('       the Panel pad shows: ' + JSON.stringify(shown));
  await pad().locator('.pad-text').press('End');
  await pad().locator('.pad-text').pressSequentially(' and bread');
  await pad().locator('.pad-text').press('Control+s');
  await pad().locator('.pad-state', { hasText: /^saved$/ }).waitFor({ timeout: 15000 });
  const t = await fileText('/Documents/Scratch pad/Shopping.txt');
  ok(t.includes('milk (added in Notepad Pro)'), 'the line written in Notepad Pro was overwritten by the Panel pad. File now: ' + JSON.stringify(t.slice(0, 200)));
});

await step('FAULT (P1): clicking the open pad in the list reads it again (it is the only way to see changes made elsewhere)', async () => {
  const w = await openPanel();
  await padOpen('Shopping');
  await w.getByRole('button', { name: 'Open full' }).click();
  const npp = page.locator('.win', { has: page.locator('.npp') }).last();
  await npp.locator('.npp-tab-name', { hasText: 'Shopping' }).waitFor({ timeout: 15000 });
  await npp.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nlemons');
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(1500);
  await npp.locator('.win-close').first().click();
  await pad().locator('.pad-item', { hasText: 'Shopping' }).first().click();
  await page.waitForTimeout(800);
  ok((await pad().locator('.pad-text').inputValue()).includes('lemons'), 'the open pad was not read again');
});

await step('FAULT (P0): two tabs on one pad: a save in the second tab does not silently overwrite the first tab\'s save', async () => {
  await openPanel();
  await panel().getByRole('button', { name: 'New', exact: true }).click();
  await padSave('base', 'Shared');
  const page2 = await context.newPage();
  watch(page2);
  await page2.goto(BASE);
  await page2.locator('#desktop .item').first().waitFor({ timeout: 20000 });
  await closeAll(page2);
  await openPanel(page2);
  await padOpen('Shared', page2);
  // Tab one writes and saves.
  await padSave('base\nline from tab ONE');
  // Tab two, still showing "base", writes and saves.
  await pad(page2).locator('.pad-text').fill('base\nline from tab TWO');
  await pad(page2).locator('.pad-text').press('Control+s');
  await page2.waitForTimeout(2000);
  const asked = await D(page2).count();
  const t = await fileText('/Documents/Scratch pad/Shared.txt');
  await page2.close();
  ok(asked || t.includes('tab ONE'), 'tab one\'s line was overwritten without a word. File now: ' + JSON.stringify(t.slice(0, 200)));
});

await step('FAULT (P0): New while a save is still under way: the new pad\'s first save does not overwrite the pad just saved', async () => {
  await openPanel();
  await panel().getByRole('button', { name: 'New', exact: true }).click();
  // A pad named by the day (the default), saved, with something worth keeping.
  const name = 'Race ' + Date.now();
  await padSave('KEEP ME: the first pad', name);
  // Slow the file store's next writes down, as a slow network would.
  let slow = true;
  await page.route('**/*', async route => {
    const r = route.request();
    if (slow && r.method() !== 'GET') await new Promise(done => setTimeout(done, 1500));
    await route.continue().catch(() => undefined);
  });
  await pad().locator('.pad-text').fill('KEEP ME: the first pad, edited');
  await pad().locator('.pad-text').press('Control+s');
  await page.waitForTimeout(100);
  // Not dirty yet? It is dirty (edited), so New asks; leave the notes (they are being saved).
  await panel().getByRole('button', { name: 'New', exact: true }).click();
  if (await D().count()) await D().getByRole('button', { name: 'Leave them' }).click();
  await pad().locator('.pad-name').fill(name);
  await pad().locator('.pad-text').fill('second pad');
  await page.waitForTimeout(4000);
  slow = false;
  await page.unroute('**/*');
  await pad().locator('.pad-text').press('Control+s');
  await page.waitForTimeout(2500);
  const listed = await pad().locator('.pad-item').allInnerTexts();
  const t = await fileText(`/Documents/Scratch pad/${name}.txt`);
  console.log('       pads now: ' + JSON.stringify(listed.filter(x => x.includes('Race'))) + '; first file: ' + JSON.stringify(t.slice(0, 120)));
  ok(t.includes('KEEP ME'), 'the first pad was overwritten by the second one');
});

await step('very long text (2 MB) saves and reads back whole', async () => {
  await openPanel();
  await panel().getByRole('button', { name: 'New', exact: true }).click();
  await page.waitForTimeout(300);
  const line = 'The quick brown fox jumps over the lazy dog 0123456789.\n';
  const big = line.repeat(Math.ceil(2_000_000 / line.length)) + 'LAST LINE';
  await pad().locator('.pad-name').fill('Big');
  await pad().locator('.pad-text').evaluate((el, v) => {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, big);
  const t0 = Date.now();
  await pad().locator('.pad-text').press('Control+s');
  await pad().locator('.pad-state', { hasText: /^saved$/ }).waitFor({ timeout: 60000 });
  console.log(`       saved 2 MB in ${Date.now() - t0} ms`);
  await panel().getByRole('button', { name: 'New', exact: true }).click();
  await padOpen('Big');
  const back = await pad().locator('.pad-text').inputValue();
  eq(back.length, big.length, 'length read back');
  ok(back.endsWith('LAST LINE'), 'ends right');
});

await step('a long pad name (40 emoji and 39 letters, all the name box takes) saves', async () => {
  await openPanel();
  await panel().getByRole('button', { name: 'New', exact: true }).click();
  if (await D().count()) await D().getByRole('button', { name: 'Leave them' }).click();
  await pad().locator('.pad-name').fill('😀'.repeat(40) + 'abc'.repeat(13));
  await pad().locator('.pad-text').fill('emoji name');
  await pad().locator('.pad-text').press('Control+s');
  await page.waitForTimeout(2500);
  const state = await pad().locator('.pad-state').innerText();
  const err = (await D().count()) ? await D().innerText() : '';
  ok(state === 'saved', `not saved (state "${state}"): ${err.slice(0, 200)}`);
});

await step('odd pad names: slashes, a device name, dots, .txt typed, a blank name', async () => {
  await openPanel();
  const tries = [['a/b\\c', /a_b_c/], ['CON', /CON_/], ['..', /Untitled/], ['notes.TXT', /^notes/], ['   ', new RegExp(today())]];
  for (const [name, want] of tries) {
    await panel().getByRole('button', { name: 'New', exact: true }).click();
    if (await D().count()) await D().getByRole('button', { name: 'Leave them' }).click();
    await padSave('x ' + name, name);
    const shownName = await pad().locator('.pad-name').inputValue();
    ok(want.test(shownName), `name ${JSON.stringify(name)} became ${JSON.stringify(shownName)}`);
  }
});

await step('renaming the open pad renames its file (no leftover); renaming onto another pad\'s name does not overwrite it', async () => {
  await openPanel();
  await panel().getByRole('button', { name: 'New', exact: true }).click();
  if (await D().count()) await D().getByRole('button', { name: 'Leave them' }).click();
  await padSave('to rename', 'Old name');
  await padSave(undefined, 'New name');
  eq(await pad().locator('.pad-item', { hasText: /^Old name/ }).count(), 0, 'old name gone');
  await padSave(undefined, 'Shopping');
  const shopping = await fileText('/Documents/Scratch pad/Shopping.txt');
  ok(!shopping.includes('to rename'), 'Shopping was overwritten');
  ok((await pad().locator('.pad-name').inputValue()).startsWith('Shopping ('), 'got a (2) name');
});

await step('closing the Panel with an unsaved pad asks first; Keep it open keeps the text', async () => {
  await openPanel();
  await pad().locator('.pad-text').fill('unsaved words');
  await panel().locator('.win-close').first().click();
  await D().waitFor();
  await D().getByRole('button', { name: 'Keep it open' }).click();
  eq(await pad().locator('.pad-text').inputValue(), 'unsaved words', 'kept');
});

await step('FAULT (P1): a half-typed Chat message on the Overview is asked about when the Panel closes', async () => {
  await openPanel();
  await pad().locator('.pad-text').fill('');
  const box = panel().locator('.panel-chat .chat-box').first();
  if (!(await box.count())) throw new Error('no chat box on the Overview');
  await box.fill('a long message I have not sent yet');
  await panel().locator('.win-close').first().click();
  await page.waitForTimeout(600);
  const asked = await D().count();
  ok(asked, 'the Panel closed and the half-typed chat message went with it, without asking');
});

await step('Today tile: an event in Calendar.ics shows, with the strip when it starts within 15 minutes', async () => {
  const now = new Date();
  const ymd = d => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const hm = d => `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}00`;
  const soon = new Date(now.getTime() + 10 * 60000);
  const end = new Date(now.getTime() + 70 * 60000);
  // An event crossing midnight (22:00 to 01:00 the next day) on today too.
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//audit//EN',
    'BEGIN:VEVENT', 'UID:soon@audit', 'SUMMARY:Dentist soon', `DTSTART:${ymd(soon)}T${hm(soon)}`, `DTEND:${ymd(end)}T${hm(end)}`, 'END:VEVENT',
    'END:VCALENDAR'];
  await upload({ 'Calendar.ics': ics.join('\r\n') + '\r\n' });
  const w = await openPanel();
  if (soon.getDate() !== now.getDate()) return console.log('       (too near midnight to check)');
  await w.locator('.panel-row', { hasText: 'Dentist soon' }).waitFor({ timeout: 10000 });
  await w.locator('.panel-critical', { hasText: 'Dentist soon' }).waitFor({ timeout: 10000 });
  await w.locator('.panel-critical').getByRole('button', { name: 'Dismiss' }).click();
  ok(await w.locator('.panel-critical').isHidden(), 'dismissed');
});

await step('FAULT (P1): an evening event that runs past midnight (23:00 to 01:00) is not shown as over before it starts', async () => {
  const now = new Date();
  if (now.getHours() >= 23) return console.log('       (too late in the day to check)');
  const ymd = d => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const next = new Date(now.getTime() + 86400000);
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//audit//EN',
    'BEGIN:VEVENT', 'UID:late@audit', 'SUMMARY:Late shift', `DTSTART:${ymd(now)}T230000`, `DTEND:${ymd(next)}T010000`, 'END:VEVENT',
    'END:VCALENDAR'];
  await upload({ 'Calendar.ics': ics.join('\r\n') + '\r\n' });
  const w = await openPanel();
  const row = w.locator('.panel-row', { hasText: 'Late shift' }).first();
  await row.waitFor({ timeout: 10000 });
  ok(!(await row.getAttribute('class')).includes('done'), 'the event that has not started yet is greyed out as done');
});

await step('FAULT (P1): the Today tile follows a calendar file replaced in another tab (delete, then upload) while the Overview is showing', async () => {
  const w = await openPanel();
  const now = new Date();
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//audit//EN', 'BEGIN:VEVENT', 'UID:later@audit', 'SUMMARY:Added while open', `DTSTART;VALUE=DATE:${ymd}`, 'END:VEVENT', 'END:VCALENDAR'];
  // The change is made in another tab (as Calendar in a second tab would).
  const page2 = await context.newPage();
  watch(page2);
  await page2.goto(BASE);
  await page2.locator('#desktop .item').first().waitFor({ timeout: 20000 });
  const p1 = page;
  page = page2;
  try {
    await closeAll(page2);
    await upload({ 'Calendar.ics': ics.join('\r\n') + '\r\n' });
  } finally {
    page = p1;
    await page2.close();
  }
  await w.locator('.panel-row', { hasText: 'Added while open' }).waitFor({ timeout: 8000 });
});

await step('Focus tile: a starred project shows with its next entry; finished and unstarred ones do not', async () => {
  const now = new Date();
  const t = new Date(now.getTime() + 86400000);
  const ymd = `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}${String(t.getDate()).padStart(2, '0')}`;
  await upload({
    'Projects.json': JSON.stringify([
      { uid: 'p1', name: 'Starred one', site: '', notes: '', focus: true, finished: false, created: 1 },
      { uid: 'p2', name: 'Not starred', site: '', notes: '', focus: false, finished: false, created: 2 },
      { uid: 'p3', name: 'Starred but finished', site: '', notes: '', focus: true, finished: true, created: 3 },
    ]),
    'Calendar.ics': ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//audit//EN', 'BEGIN:VEVENT', 'UID:f1@audit', 'SUMMARY:Add new feature: Starred one', `DTSTART:${ymd}T090000`, 'X-TOMLINOS-PROJECT:p1', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n') + '\r\n',
  });
  const w = await openPanel();
  const focus = w.locator('.panel-focus');
  await focus.locator('.panel-row', { hasText: 'Starred one' }).waitFor({ timeout: 10000 });
  const text = await focus.innerText();
  console.log('       focus reads: ' + JSON.stringify(text));
  ok(!text.includes('Not starred') && !text.includes('finished'), 'only the starred, open project');
  ok(/Tomorrow 09:00/.test(text), 'next entry shown');
  await focus.locator('.panel-row', { hasText: 'Starred one' }).click();
  await page.locator('.win', { has: page.locator('.projects-app') }).waitFor({ timeout: 10000 });
});

await step('FAULT (P1): a Recent files row opens with Space or a single click, as other buttons do', async () => {
  await upload({ 'recent-probe.txt': 'hello' });
  const w = await openPanel();
  const row = w.locator('.panel-rows .panel-row-btn', { hasText: 'recent-probe.txt' });
  await row.waitFor({ timeout: 10000 });
  const before = await page.locator('.win').count();
  await row.focus();
  await page.keyboard.press('Space');
  await page.waitForTimeout(1500);
  ok((await page.locator('.win').count()) > before, 'Space on the focused row does nothing');
});

await step('FAULT (P1): the rail is a tab list: arrow keys move between its sections', async () => {
  const w = await openPanel();
  await w.locator('.panel-nav-item', { hasText: 'OVERVIEW' }).focus();
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(300);
  const focused = await page.evaluate(() => document.activeElement?.textContent ?? '');
  ok(focused.includes('MAIL'), 'ArrowDown did not move to MAIL; focus is on ' + JSON.stringify(focused.slice(0, 40)));
});

await step('small window (420 x 700): no part of the Overview is cut off sideways; the pad can be typed in and saved', async () => {
  await page.setViewportSize({ width: 420, height: 700 });
  try {
    const w = await openPanel();
    await page.waitForTimeout(800);
    const wide = await w.evaluate(win => {
      const out = [];
      const r0 = win.getBoundingClientRect();
      for (const el of win.querySelectorAll('.panel-tile, .panel-nav, .scratch-pad, .pad-text, .panel-bar')) {
        const r = el.getBoundingClientRect();
        if (r.width && (r.right > r0.right + 1 || r.left < r0.left - 1)) out.push(`${el.className} ${Math.round(r.left)}-${Math.round(r.right)} (window ${Math.round(r0.left)}-${Math.round(r0.right)})`);
      }
      return { out, scroll: document.documentElement.scrollWidth };
    });
    await shot('small');
    console.log('       small: ' + JSON.stringify(wide));
    await pad().locator('.pad-text').scrollIntoViewIfNeeded();
    await panel().getByRole('button', { name: 'New', exact: true }).click();
    if (await D().count()) await D().getByRole('button', { name: 'Leave them' }).click();
    await padSave('small screen note', 'Small');
    ok(!wide.out.length, 'cut off: ' + wide.out.join('; '));
  } finally {
    await page.setViewportSize({ width: 1280, height: 800 });
  }
});

// ---- Mail in the ticket shape -------------------------------------------------------------------------------------
await step('Mail (ticket): set up the mailbox inside the Panel and read the Inbox', async () => {
  const w = await openPanel();
  await w.locator('.panel-nav-item', { hasText: 'MAIL' }).click();
  const m = w.locator('.mail.ticket');
  await m.locator('.mail-setup').waitFor({ timeout: 15000 });
  await m.getByLabel('Email address', { exact: true }).fill(MAIL_USER);
  await m.getByLabel('Provider', { exact: true }).selectOption('other');
  await m.getByLabel('Password', { exact: true }).fill(MAIL_PASS);
  await m.locator('.mail-adv summary').click();
  const servers = m.locator('.mail-servers');
  await servers.getByLabel('Server').nth(0).fill('127.0.0.1');
  await servers.getByLabel('Port').nth(0).fill(String(IMAP));
  await servers.getByLabel('Security').nth(0).selectOption('none');
  await servers.getByLabel('Server').nth(1).fill('127.0.0.1');
  await servers.getByLabel('Port').nth(1).fill(String(SMTP));
  await servers.getByLabel('Security').nth(1).selectOption('none');
  await m.getByRole('button', { name: 'Test and save' }).click();
  await m.locator('.mail-row').first().waitFor({ timeout: 20000 });
  eq(await m.locator('.mail-row').count(), 3, 'three messages');
  ok((await w.locator('.panel-bar-title').innerText()).includes('Mail'), 'the bar names Mail');
  await shot('mail-ticket');
});

await step('FAULT (P1): Mail (ticket): the Delete key on a focused compose button does not delete the open message', async () => {
  const w = await openPanel();
  await w.locator('.panel-nav-item', { hasText: 'MAIL' }).click();
  const m = w.locator('.mail.ticket');
  await m.locator('.mail-row').first().waitFor({ timeout: 20000 });
  await m.locator('.mail-row', { hasText: 'Pruning on Friday' }).click();
  await m.locator('.mail-reader h2', { hasText: 'Pruning' }).waitFor();
  await m.getByRole('button', { name: 'Reply', exact: true }).click();
  const c = m.locator('.mail-compose');
  await c.locator('.compose-text').waitFor();
  await c.getByRole('button', { name: 'Discard' }).focus();
  const before = await m.locator('.mail-row').count();
  await page.keyboard.press('Delete');
  await page.waitForTimeout(1500);
  if (await D().count()) await D().getByRole('button', { name: 'Keep writing' }).click().catch(() => undefined);
  const after = await m.locator('.mail-row').count();
  eq(after, before, 'messages in the Inbox after Delete on the Discard button');
});

await step('Mail (ticket): writing in place survives a trip to another section; closing the Panel asks about it', async () => {
  const w = await openPanel();
  await w.locator('.panel-nav-item', { hasText: 'MAIL' }).click();
  const m = w.locator('.mail.ticket');
  await m.locator('.mail-row').first().waitFor({ timeout: 20000 });
  await m.getByRole('button', { name: '✉ New' }).click();
  const c = m.locator('.mail-compose');
  await c.locator('.compose-text').fill('draft kept across sections');
  await w.locator('.panel-nav-item', { hasText: 'FILES' }).click();
  await page.waitForTimeout(500);
  await w.locator('.panel-nav-item', { hasText: 'MAIL' }).click();
  eq(await c.locator('.compose-text').inputValue(), 'draft kept across sections', 'kept');
  await w.locator('.win-close').first().click();
  await D().waitFor({ timeout: 5000 });
  const t = await D().innerText();
  await D().getByRole('button', { name: /Keep/ }).first().click();
  ok(/not (been )?sent|not saved|lost/i.test(t), 'asked: ' + t.slice(0, 120));
});

await step('Mail (ticket): send in place reaches the stand-in server and shows under Sent', async () => {
  const w = await openPanel();
  await w.locator('.panel-nav-item', { hasText: 'MAIL' }).click();
  const m = w.locator('.mail.ticket');
  await m.locator('.mail-row').first().waitFor({ timeout: 20000 });
  await m.getByRole('button', { name: '✉ New' }).click();
  const c = m.locator('.mail-compose');
  await c.getByLabel('To').fill('someone@example.org');
  await c.getByLabel('Subject').fill('Panel audit send');
  await c.locator('.compose-text').fill('hello from the panel');
  const before = fake.delivered.length;
  await c.getByRole('button', { name: 'Send' }).click();
  await page.locator('.toast', { hasText: 'Sent to 1 address' }).waitFor({ timeout: 15000 });
  eq(fake.delivered.length, before + 1, 'delivered');
  await m.locator('.mail-ticket-side .mail-side-row', { hasText: 'Panel audit send' }).waitFor({ timeout: 10000 });
});

await step('Mail (ticket) at 420 px: list, message and the side column are all reachable', async () => {
  await page.setViewportSize({ width: 420, height: 700 });
  try {
    const w = await openPanel();
    await w.locator('.panel-nav-item', { hasText: 'MAIL' }).click();
    const m = w.locator('.mail.ticket');
    await m.locator('.mail-row').first().waitFor({ timeout: 20000 });
    await m.locator('.mail-row').first().click();
    await page.waitForTimeout(800);
    await shot('mail-small');
    const r = await m.evaluate(el => {
      const box = el.getBoundingClientRect();
      const parts = ['.mail-list', '.mail-reader', '.mail-ticket-side', '.mail-bar'].map(s => {
        const e = el.querySelector(s);
        const b = e?.getBoundingClientRect();
        return b ? `${s} ${Math.round(b.left)}-${Math.round(b.right)} w${Math.round(b.width)} h${Math.round(b.height)}` : `${s} missing`;
      });
      return { box: `${Math.round(box.left)}-${Math.round(box.right)}`, parts };
    });
    console.log('       mail small: ' + JSON.stringify(r));
  } finally {
    await page.setViewportSize({ width: 1280, height: 800 });
  }
});

await fake.close?.();
await browser.close();
if (problems.length) console.log('  problems: ' + problems.slice(0, 10).join(' | '));
console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log('  - ' + f);
process.exit(failures.length ? 1 : 0);
