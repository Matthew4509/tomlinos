// Audit of My Projects in a real Chrome: unsaved edits, the settings form, renaming, a hand-edited Projects.json, a
// big list, the file deleted while open, keyboard focus, a small window and a short screen. Each step marked FAULT
// failed when it was written (P0 or P1 as named). Needs the dev server on a FRESH, EMPTY data folder (the first step
// sets up the owner), and `npm run build` done.
//   node test/browser-audit-projects.mjs [http://127.0.0.1:3119] [screenshot folder]
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3119';
const SHOTS = process.argv[3] ?? null;
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PASS = 'orchard-lantern-harbour-58';
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
const page = await context.newPage();
page.setDefaultTimeout(10000);
const problems = [];
page.on('pageerror', e => problems.push('pageerror: ' + e.message));
const shot = async name => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });
const front = () => page.locator('.win.active');
const P = () => page.locator('.win', { has: page.locator('.projects-app') });
const D = () => page.locator('.dialog');
const row = name => P().locator('.proj-row', { has: page.locator('.proj-name', { hasText: name }) });
const key = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const plus = n => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return key(d);
};

async function closeAll() {
  for (let i = 0; i < 40; i++) {
    const dialog = page.locator('.dialog');
    if (await dialog.count()) {
      await dialog.getByRole('button', { name: /without saving|Do not save|Discard|Cancel|Close anyway|OK/ }).first().click().catch(() => dialog.getByRole('button').last().click());
      continue;
    }
    const wins = page.locator('.win');
    if (!(await wins.count())) return;
    await wins.last().locator('.win-close').first().click();
    await page.waitForTimeout(80);
  }
  throw new Error('windows would not close');
}
async function openProjects() {
  if (!(await page.locator('.start-filter').isVisible())) await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('my projects');
  await page.locator('.start-menu [data-label="my projects"]').first().click();
  await P().locator('.proj-heading').waitFor();
  return P();
}
async function addProject(name, site = '', notes = '') {
  await P().getByRole('button', { name: 'Add project' }).click();
  await D().getByLabel('Name').fill(name);
  await D().getByLabel('Site').fill(site);
  await D().getByLabel('Notes').fill(notes);
  await D().getByRole('button', { name: 'Add' }).click();
  await row(name).waitFor();
}
async function documents() {
  await page.keyboard.press('Control+Alt+e');
  const w = front();
  await w.locator('.item', { hasText: 'Documents' }).first().dblclick();
  await page.waitForTimeout(300);
  return w;
}
/** A file or folder in Explorer by its exact name (with or without the extension shown). */
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
/** Puts these files in Documents, in place of any there by the same names. */
async function upload(files) {
  const dir = tempDir('tomlinos-audit-projects-');
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const w = await documents();
  for (const name of Object.keys(files)) await removeFile(w, name);
  const chooser = page.waitForEvent('filechooser');
  await w.getByRole('button', { name: 'Upload' }).click();
  (await chooser).setFiles(Object.keys(files).map(n => join(dir, n)));
  for (const n of Object.keys(files)) await item(w, n).first().waitFor({ timeout: 15000 });
  await w.locator('.win-close').first().click();
}
async function downloadText(stem) {
  const w = await documents();
  await item(w, stem).first().click();
  const download = page.waitForEvent('download', { timeout: 10000 });
  await w.getByRole('button', { name: 'Download' }).click();
  const d = await download;
  const text = readFileSync(await d.path(), 'utf8');
  await w.locator('.win-close').first().click();
  return text;
}

console.log('My Projects audit, against ' + BASE);
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

await step('add two projects', async () => {
  await openProjects();
  await addProject('Alpha', 'example.com', 'first notes');
  await addProject('Beta', '', '');
});

await step('FAULT (P0): typed changes in Edit are not thrown away by the toolbar (Finished) without asking', async () => {
  await openProjects();
  await row('Alpha').locator('.proj-name').click();
  await P().getByRole('button', { name: 'Edit' }).click();
  await P().getByLabel('Notes').fill('a long note I typed and did not save yet');
  await P().getByRole('button', { name: /^Finished/ }).click();
  await page.waitForTimeout(300);
  const asked = await D().count();
  if (asked) return;
  await P().getByRole('button', { name: 'Back to projects' }).click();
  await row('Alpha').locator('.proj-name').click();
  const notes = await P().locator('.proj-notes-full').innerText();
  ok(notes.includes('did not save yet'), 'no question, and the typed notes are gone: notes now ' + JSON.stringify(notes));
});

await step('FAULT (P0): closing the window with typed, unsaved Edit changes asks first', async () => {
  await openProjects();
  await row('Alpha').locator('.proj-name').click();
  await P().getByRole('button', { name: 'Edit' }).click();
  await P().getByLabel('Notes').fill('more unsaved text');
  await P().locator('.win-close').first().click();
  await page.waitForTimeout(400);
  ok((await D().count()) > 0, 'the window closed with no question; the typed notes are lost');
});

await step('FAULT (P1): Escape inside the Notes box does not drop the typed notes without asking', async () => {
  await openProjects();
  await row('Alpha').locator('.proj-name').click();
  await P().getByRole('button', { name: 'Edit' }).click();
  await P().getByLabel('Notes').fill('typed then Escape');
  await P().getByLabel('Notes').press('Escape');
  await page.waitForTimeout(300);
  const editing = await P().getByLabel('Notes').count();
  ok(editing || (await D().count()), 'Escape in the notes closed the form with nothing kept and no question');
});

await step('FAULT (P1): a name typed in "New button name" but not added is not silently dropped by Save settings', async () => {
  await openProjects();
  await P().getByRole('button', { name: /Settings/ }).click();
  await P().getByLabel('New button name').fill('Write the docs');
  await P().getByRole('button', { name: 'Save settings' }).click();
  await page.waitForTimeout(400);
  const stillThere = await P().getByLabel('New button name').count();
  if (stillThere) return; // kept the form open to say so: fine
  const buttons = await row('Alpha').locator('.proj-actions .btn').allInnerTexts();
  ok(buttons.includes('Write the docs'), 'saved and closed; buttons are ' + buttons.join(', '));
});

await step('FAULT (P1): Default hours 0.1 is refused or kept, not silently turned into "no end time"', async () => {
  await openProjects();
  await P().getByRole('button', { name: /Settings/ }).click();
  await P().getByLabel('Default hours').fill('0.1');
  await P().getByRole('button', { name: 'Save settings' }).click();
  await page.waitForTimeout(400);
  if (await P().getByLabel('Default hours').count()) {
    const said = await P().locator('.proj-settings .dialog-problem').allInnerTexts();
    if (said.join('').trim()) return; // refused in words
  }
  await P().getByRole('button', { name: /Settings/ }).click();
  const v = await P().getByLabel('Default hours').inputValue();
  ok(v !== '', 'saved without a word; Default hours now reads empty (no end time)');
});

await step('book an entry for yesterday on Alpha (goes to its log)', async () => {
  await openProjects();
  await row('Alpha').getByRole('button', { name: 'Add new feature' }).click();
  const y = plus(-1);
  if (!(await D().locator(`.dp-day[data-day="${y}"]`).count())) await D().getByRole('button', { name: 'Previous month' }).click();
  await D().locator(`.dp-day[data-day="${y}"]`).click();
  await D().getByRole('button', { name: 'Save' }).click();
  await D().waitFor({ state: 'detached' });
  await page.locator('.toast', { hasText: 'In the calendar' }).last().waitFor();
  await row('Alpha').locator('.proj-name').click();
  eq(await P().locator('.proj-entries .proj-entry-title').allInnerTexts(), ['Add new feature'], 'log title before rename');
});

await step('FAULT (P1): after renaming a project its log still shows "Add new feature", not the old full title', async () => {
  await openProjects();
  await row('Alpha').locator('.proj-name').click();
  await P().getByRole('button', { name: 'Edit' }).click();
  await P().getByLabel('Name').fill('Alpha renamed');
  await P().getByRole('button', { name: 'Save' }).click();
  await P().locator('.proj-title', { hasText: 'Alpha renamed' }).waitFor();
  eq(await P().locator('.proj-entries .proj-entry-title').allInnerTexts(), ['Add new feature'], 'log title after rename');
});

await step('FAULT (P1): a quick double click on the star toggles twice (back to unstarred)', async () => {
  await openProjects();
  await row('Beta').locator('.proj-star').evaluate(b => {
    b.click();
    b.click();
  });
  await page.waitForTimeout(1200);
  eq(await row('Beta').locator('.proj-star').getAttribute('aria-pressed'), 'false', 'starred after two clicks');
});

await step('FAULT (P1): opening a project with the keyboard leaves the keyboard in the window (not on the page body)', async () => {
  await openProjects();
  await row('Beta').locator('.proj-name').focus();
  await page.keyboard.press('Enter');
  await P().locator('.proj-title', { hasText: 'Beta' }).waitFor();
  const inside = await P().evaluate(w => w.contains(document.activeElement) && document.activeElement !== w);
  ok(inside, 'focus after opening: ' + (await page.evaluate(() => document.activeElement?.tagName + '.' + document.activeElement?.className)));
});

await step('FAULT (P1): a project typed into Projects.json by hand (no uid) is kept on the next save', async () => {
  await closeAll();
  const current = JSON.parse(await downloadText('Projects'));
  current.push({ name: 'Hand added', notes: 'typed in Notepad' });
  await upload({ 'Projects.json': JSON.stringify(current, null, 1) });
  await openProjects();
  const shown = await P().locator('.proj-name').allInnerTexts();
  await addProject('Gamma');
  await closeAll();
  const after = await downloadText('Projects');
  ok(after.includes('Hand added'), 'shown on open: ' + shown.join(', ') + '; the hand-added record is gone from the file after one save');
});

await step('Projects.json deleted while open: the list empties, a new project starts a new file, no error', async () => {
  await openProjects();
  const w = await documents();
  await removeFile(w, 'Projects.json');
  await w.locator('.win-close').first().click();
  await page.waitForTimeout(1000);
  const names = await P().locator('.proj-name').allInnerTexts();
  console.log('       after delete, listed: ' + JSON.stringify(names));
  await addProject('After delete');
  ok(!problems.length, problems.join('; '));
});

await step('FAULT (P1): big list: 3000 projects and 3000 calendar entries draw and star in reasonable time', async () => {
  await closeAll();
  const list = [];
  for (let i = 0; i < 3000; i++) list.push({ uid: `p${i}`, name: `Project ${i}`, site: i % 3 ? '' : `site${i}.example.com`, notes: `notes ${i}\nmore`, focus: i % 50 === 0, finished: i % 7 === 0, created: i });
  const day = plus(2).replaceAll('-', '');
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//audit//EN'];
  for (let i = 0; i < 3000; i++) ics.push('BEGIN:VEVENT', `UID:e${i}@audit`, `SUMMARY:Add new feature: Project ${i}`, `DTSTART:${day}T090000`, `X-TOMLINOS-PROJECT:p${i}`, 'END:VEVENT');
  ics.push('END:VCALENDAR');
  await upload({ 'Projects.json': JSON.stringify(list), 'Calendar.ics': ics.join('\r\n') + '\r\n' });
  const t0 = Date.now();
  await openProjects();
  await row('Project 2999').waitFor({ timeout: 30000 });
  const openMs = Date.now() - t0;
  console.log(`       open ${openMs} ms`);
  const redraws = await P().evaluate(win => new Promise(done => {
    let n = 0;
    const body = win.querySelector('.proj-body');
    const mo = new MutationObserver(() => n++);
    mo.observe(body, { childList: true });
    setTimeout(() => (mo.disconnect(), done(n)), 3000);
  }));
  const star = P().locator('.proj-row', { has: page.getByRole('button', { name: 'Project 1', exact: true }) }).locator('.proj-star');
  console.log(`       redraws in 3 s while idle: ${redraws}; star rows ${await star.count()}; visible ${await star.isVisible()}`);
  const t1 = Date.now();
  await P().locator('.proj-row', { has: page.getByRole('button', { name: 'Project 1', exact: true }) }).locator('.proj-star').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.proj-row.focus .proj-name')].some(b => b.textContent === 'Project 1'), null, { timeout: 30000 });
  const starMs = Date.now() - t1;
  console.log(`       open ${openMs} ms, star ${starMs} ms, rows ${await P().locator('.proj-row').count()}`);
  ok(openMs < 8000 && starMs < 4000, `open ${openMs} ms, star ${starMs} ms`);
});

await step('at its smallest size the list does not scroll sideways and the toolbar buttons all show', async () => {
  await closeAll();
  await upload({ 'Projects.json': JSON.stringify([{ uid: 'a1', name: 'A project with a fairly long name to wrap', site: 'a-very-long-site-address.example.com/with/a/path', notes: 'n', focus: true, finished: false, created: 1 }]) });
  const w = await openProjects();
  const grip = w.locator('.win-edge.edge-se');
  const box = await grip.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 1500, box.y - 1500, { steps: 5 });
  await page.mouse.up();
  await shot('small');
  const m = await w.evaluate(win => {
    const body = win.querySelector('.proj-body');
    const tb = win.querySelector('.projects-app .toolbar');
    const r = tb.getBoundingClientRect();
    const hidden = [...tb.querySelectorAll('button')].filter(b => { const q = b.getBoundingClientRect(); return q.right > r.right + 1 || q.bottom > r.bottom + 1; }).map(b => b.textContent);
    return { w: win.getBoundingClientRect().width, sw: body.scrollWidth, cw: body.clientWidth, hidden };
  });
  console.log('       ' + JSON.stringify(m));
  ok(m.sw <= m.cw + 1 && !m.hidden.length, JSON.stringify(m));
});

await step('on a short screen (1280x520) the booking window can still be saved with the mouse', async () => {
  await page.setViewportSize({ width: 1280, height: 520 });
  try {
    await openProjects();
    await P().locator('.proj-row').first().getByRole('button', { name: 'Appointment' }).click();
    const save = D().getByRole('button', { name: 'Save' });
    await save.scrollIntoViewIfNeeded();
    const b = await save.boundingBox();
    ok(b && b.y >= 0 && b.y + b.height <= 520, 'Save button box ' + JSON.stringify(b));
  } finally {
    await page.setViewportSize({ width: 1280, height: 800 });
  }
});

await step('a row booked for "Tomorrow" says "Today" once midnight has passed with the window open', async () => {
  await closeAll();
  await upload({ 'Projects.json': JSON.stringify([{ uid: 'm1', name: 'Midnight', site: '', notes: '', focus: false, finished: false, created: 1 }]) });
  const late = new Date();
  late.setHours(23, 58, 0, 0);
  await page.clock.install({ time: late });
  await page.reload();
  await page.locator('#desktop .item').first().waitFor({ timeout: 20000 });
  await openProjects();
  await row('Midnight').getByRole('button', { name: 'Add new feature' }).click();
  await D().getByRole('button', { name: 'Save' }).click();
  await D().waitFor({ state: 'detached' });
  await row('Midnight').locator('.proj-next', { hasText: 'Tomorrow' }).waitFor();
  await page.clock.fastForward('05:00');
  await page.waitForTimeout(500);
  const text = await row('Midnight').locator('.proj-next').innerText();
  ok(text.includes('Today'), 'five minutes after midnight the row says: ' + text);
});

console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? ':\n  - ' + failures.join('\n  - ') : ''}`);
if (problems.length) console.log('page errors: ' + problems.join('; '));
await browser.close();
process.exit(failures.length ? 1 : 0);
