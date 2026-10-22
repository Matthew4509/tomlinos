// Drives My Projects in a real Chrome: three projects, the one-click buttons into the Calendar and the Panel, Run for
// 3 days, Repeat daily then Stop repeating, an appointment with a place, the settings (default time, the button list),
// the star and the Panel's Focus tile, Finish and Bring back, the log with notes, and a Calendar save that keeps what
// My Projects set. Needs the dev server on a FRESH, EMPTY data folder (the first step sets up the owner), and
// `npm run build` done.
//   node test/browser-projects.mjs [http://127.0.0.1:3043] [screenshot folder]
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3043';
const SHOTS = process.argv[3] ?? null;
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PASS = 'projects-walk-passphrase-41';
let passed = 0;
const failures = [];
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await context.newPage();
page.setDefaultTimeout(10000);
const problems = [];
page.on('console', m => m.type() === 'error' && problems.push('console: ' + m.text()));
page.on('pageerror', e => problems.push('pageerror: ' + e.message));
/** Addresses that answered 404 (a file not made yet reads as one): listed at the end, not counted as faults. */
const missing = [];
page.on('response', r => r.status() === 404 && missing.push(new URL(r.url()).pathname + new URL(r.url()).search));
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
    // Leave no window open over the next step.
    for (let i = 0; i < 3 && (await page.locator('.dialog').count()); i++) await page.keyboard.press('Escape').catch(() => {});
    for (const w of await page.locator('.win').all()) {
      if (!(await w.locator('.projects-app').count())) await w.getByRole('button', { name: 'Close', exact: true }).first().click().catch(() => {});
    }
  }
}
const eq = (a, b, what) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const ok = (v, what) => {
  if (!v) throw new Error(what);
};
const key = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const plus = n => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return key(d);
};
const TODAY = plus(0);
const TOMORROW = plus(1);

const openApp = async label => {
  if (!(await page.locator('.start-filter').isVisible())) await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill(label);
  await page.locator(`.start-menu [data-label="${label}"]`).first().click();
};
const P = () => page.locator('.win', { has: page.locator('.projects-app') });
const C = () => page.locator('.win', { has: page.locator('.calendar-app') });
const D = () => page.locator('.dialog');
const row = name => P().locator('.proj-row', { has: page.locator('.proj-name', { hasText: name }) });
const close = async win => {
  await win.getByRole('button', { name: 'Close', exact: true }).first().click();
  await win.waitFor({ state: 'detached', timeout: 10000 });
};
/** The titles on a day in the Calendar's side list (opens the Calendar if needed). */
async function calendarDay(day) {
  if (!(await C().count())) {
    await openApp('calendar');
    await C().locator('.cal-month-grid .cal-cell').first().waitFor();
  }
  const cell = C().locator(`.cal-cell[data-day="${day}"]`);
  if (!(await cell.count())) await C().getByRole('button', { name: 'Next month' }).click();
  await C().locator(`.cal-cell[data-day="${day}"]`).click();
  await C().locator('.cal-side h3').waitFor();
  return C().locator('.cal-side .cal-event').allInnerTexts();
}
const toast = text => page.locator('.toast', { hasText: text }).last().waitFor({ timeout: 10000 });

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

await step('My Projects is in the Start menu beside Calendar (Office) and opens empty with a hint', async () => {
  await page.locator('.start-btn').click();
  const office = page.locator('.start-menu button', { hasText: 'Office' }).first();
  await office.click();
  const labels = await page.locator('.start-item').evaluateAll(els => els.map(e => e.getAttribute('data-label')));
  const at = labels.indexOf('calendar');
  ok(at >= 0 && labels[at + 1] === 'my projects', 'listed right after Calendar: ' + labels.join(', '));
  await openApp('my projects');
  await P().locator('.proj-empty').waitFor();
  ok((await P().locator('.proj-empty').innerText()).includes('No projects yet'), 'empty hint');
});

await step('add three example projects (name, site, notes); the site is a link', async () => {
  for (const [name, site, notes] of [
    ['My Projects app', 'tomlinos.com', 'A reminder list for TOMLIN OS\nsecond line'],
    ['Word upgrade', '', 'Write'],
    ['Corner Bakery website', 'example.com', ''],
  ]) {
    await P().getByRole('button', { name: 'Add project' }).click();
    await D().getByLabel('Name').fill(name);
    await D().getByLabel('Site').fill(site);
    await D().getByLabel('Notes').fill(notes);
    await D().getByRole('button', { name: 'Add' }).click();
    await row(name).waitFor();
  }
  eq(await P().locator('.proj-name').allInnerTexts(), ['My Projects app', 'Word upgrade', 'Corner Bakery website'], 'in the order added');
  eq(await row('Corner Bakery').locator('a.proj-site').getAttribute('href'), 'https://example.com/', 'site link');
  eq(await row('Corner Bakery').locator('a.proj-site').getAttribute('target'), '_blank', 'opens in a new tab');
  eq(await row('My Projects app').locator('.proj-notes').innerText(), 'A reminder list for TOMLIN OS', 'first line of the notes');
  eq(await row('Word upgrade').locator('.proj-next').innerText(), 'Nothing booked', 'nothing booked yet');
  await shot('01-three-projects');
});

await step('Add new feature on Word upgrade: filled in (tomorrow, 9:00); Enter in the note saves; in the row, Calendar and Panel', async () => {
  await row('Word upgrade').getByRole('button', { name: 'Add new feature' }).click();
  eq(await D().getByLabel('What').inputValue(), 'Add new feature: Word upgrade', 'What');
  eq(await D().getByLabel('Time').inputValue(), '09:00', 'default time');
  eq(await D().locator('.dp-day.on').getAttribute('data-day'), TOMORROW, 'default day is tomorrow');
  ok((await D().locator('.dp-said').innerText()).startsWith('Tomorrow'), 'says Tomorrow');
  eq(await D().getByLabel('Reminder').inputValue(), '0', 'reminder at the start');
  await shot('02-action-window');
  await D().getByLabel('Note').fill('Tables and headings first');
  await D().getByLabel('Note').press('Enter');
  await D().waitFor({ state: 'detached', timeout: 10000 });
  await toast('In the calendar');
  await row('Word upgrade').locator('.proj-next', { hasText: 'Next: Tomorrow 09:00 · Add new feature' }).waitFor({ timeout: 10000 });
  const day = await calendarDay(TOMORROW);
  ok(day.some(t => t.includes('09:00') && t.includes('Add new feature: Word upgrade')), 'in the Calendar: ' + day.join(' | '));
  await close(C());
  await openApp('panel');
  const panel = page.locator('.win', { has: page.locator('.panel') });
  await panel.locator('.panel-row', { hasText: 'Add new feature: Word upgrade' }).first().waitFor({ timeout: 15000 });
  ok((await panel.locator('.panel-row', { hasText: 'Add new feature: Word upgrade' }).first().innerText()).includes('09:00'), 'Panel shows the time');
  await close(panel);
});

await step('Run for 3 days on Corner Bakery: three days in a row in the Calendar, not a fourth; the ticks undo each other', async () => {
  await row('Corner Bakery').getByRole('button', { name: 'Audit and review' }).click();
  await D().getByLabel('Repeat daily').check();
  await D().getByLabel('Run for a number of days').check();
  ok(!(await D().getByLabel('Repeat daily').isChecked()), 'ticking Run for unticks Repeat daily');
  eq(await D().getByLabel('Days in a row').inputValue(), '3', 'three by default');
  await D().getByRole('button', { name: 'Save' }).click();
  await D().waitFor({ state: 'detached' });
  for (let i = 1; i <= 4; i++) {
    const day = await calendarDay(plus(i));
    const has = day.some(t => t.includes('Audit and review: Corner Bakery'));
    ok(has === (i <= 3), `day ${i}: ${has ? 'shown' : 'not shown'}`);
    if (i === 1) ok(day.some(t => t.includes('Every day, for 3 days')), 'the side list says for 3 days');
  }
  await close(C());
});

await step('Repeat daily from today, then Stop repeating on the project page: today stays, tomorrow is gone', async () => {
  await row('My Projects app').getByRole('button', { name: 'Add to calendar' }).click();
  eq(await D().getByLabel('What').inputValue(), 'My Projects app', 'plain Add to calendar = the name');
  await D().locator(`.dp-day[data-day="${TODAY}"]`).click();
  await D().getByLabel('All day').check();
  ok(await D().locator('.entry-times').isHidden(), 'All day hides the times');
  await D().getByLabel('Repeat daily').check();
  await D().getByRole('button', { name: 'Save' }).click();
  await D().waitFor({ state: 'detached' });
  ok((await calendarDay(plus(5))).some(t => t.includes('My Projects app')), 'repeats');
  await close(C());
  await row('My Projects app').locator('.proj-name').click();
  const entry = P().locator('.proj-entry', { hasText: 'Every day' });
  await entry.waitFor();
  await entry.getByRole('button', { name: 'Stop repeating' }).click();
  await toast('stops repeating after today');
  await P().locator('.proj-entry', { hasText: 'Every day, until' }).first().waitFor({ timeout: 10000 });
  ok(!(await P().getByRole('button', { name: 'Stop repeating' }).count()), 'no Stop repeating left');
  ok((await calendarDay(TODAY)).some(t => t.includes('My Projects app')), 'today stays');
  ok(!(await calendarDay(TOMORROW)).some(t => t.includes('My Projects app')), 'tomorrow is gone');
  await close(C());
  await P().getByRole('button', { name: '‹ All projects' }).click();
});

await step('Appointment from the toolbar: who, where, about a project; titled Meet <who> with the place', async () => {
  await P().getByRole('button', { name: 'Appointment', exact: true }).first().click();
  ok((await D().locator('.dialog-title').innerText()) === 'Appointment', 'its title');
  await D().getByRole('button', { name: 'Save' }).click();
  ok((await D().locator('.dialog-problem').innerText()).includes('who you are meeting'), 'Save says why when Who is empty');
  await D().getByLabel('Who').fill('Sam Lee');
  await D().getByLabel('Where').fill('Cafe on King St');
  await D().getByLabel('About').selectOption({ label: 'Word upgrade' });
  await D().getByLabel('Time').fill('14:00');
  await D().getByLabel('Hours').fill('1.5');
  await D().getByRole('button', { name: 'Save' }).click();
  await D().waitFor({ state: 'detached' });
  const day = await calendarDay(TOMORROW);
  ok(day.some(t => t.includes('14:00–15:30') && t.includes('Meet Sam Lee') && t.includes('Cafe on King St')), 'in the Calendar: ' + day.join(' | '));
  await close(C());
  await row('Word upgrade').locator('.proj-name').click();
  await P().locator('.proj-entry', { hasText: 'Meet Sam Lee' }).waitFor();
  ok((await P().locator('.proj-entry', { hasText: 'Meet Sam Lee' }).innerText()).includes('At Cafe on King St'), 'the project page shows the place');
  await P().getByRole('button', { name: '‹ All projects' }).click();
});

await step('the log: an entry booked for yesterday shows under Log with its two-line note (Shift+Enter)', async () => {
  await row('Word upgrade').getByRole('button', { name: 'Audit and review' }).click();
  await D().locator('.dp-grid').focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  eq(await D().locator('.dp-day.on').getAttribute('data-day'), plus(-1), 'arrows move the day');
  await D().getByLabel('Note').fill('Looked at the old editor');
  await D().getByLabel('Note').press('Shift+Enter');
  await D().getByLabel('Note').pressSequentially('kept the toolbar');
  eq(await D().getByLabel('Note').inputValue(), 'Looked at the old editor\nkept the toolbar', 'Shift+Enter is a new line');
  await D().getByLabel('Note').press('Enter');
  await D().waitFor({ state: 'detached' });
  await row('Word upgrade').locator('.proj-name').click();
  const log = P().locator('.proj-page h3', { hasText: 'Log' }).locator('xpath=following-sibling::ul[1]');
  await log.locator('.proj-entry', { hasText: 'Audit and review' }).waitFor();
  eq(await log.locator('.proj-entry-notes').first().innerText(), 'Looked at the old editor\nkept the toolbar', 'the note, both lines');
  await shot('03-project-page');
  await P().getByRole('button', { name: '‹ All projects' }).click();
});

await step('Settings: default time 10:30 is used by the next window; a new button appears; the last button cannot be removed', async () => {
  await P().getByRole('button', { name: '⚙ Settings' }).click();
  await P().getByLabel('Default time').fill('10:30');
  await P().getByLabel('New button name').fill('Write the blog post');
  await P().getByRole('button', { name: 'Add button' }).click();
  eq(await P().locator('.proj-action-item input').evaluateAll(els => els.map(e => e.value)), ['Add to calendar', 'Add new feature', 'Audit and review', 'Write the blog post'], 'four buttons');
  await P().getByRole('button', { name: 'Move “Write the blog post” up' }).click();
  eq(await P().locator('.proj-action-item input').nth(2).inputValue(), 'Write the blog post', 'moved up');
  await shot('07-settings');
  await P().getByRole('button', { name: 'Save settings' }).click();
  await toast('settings saved');
  eq(await row('Corner Bakery').locator('.proj-actions .btn').allInnerTexts(), ['Add to calendar', 'Add new feature', 'Write the blog post', 'Audit and review', 'Appointment'], 'the row buttons');
  await row('Corner Bakery').getByRole('button', { name: 'Write the blog post' }).click();
  eq(await D().getByLabel('What').inputValue(), 'Write the blog post: Corner Bakery website', 'What');
  eq(await D().getByLabel('Time').inputValue(), '10:30', 'the new default time');
  await page.keyboard.press('Escape');
  await D().waitFor({ state: 'detached' });
  // Remove all but one, then the last says why it stays (and stays). Cancel: nothing saved.
  await P().getByRole('button', { name: '⚙ Settings' }).click();
  for (let i = 0; i < 3; i++) await P().locator('.proj-action-item').first().getByRole('button', { name: /^Remove/ }).click();
  eq(await P().locator('.proj-action-item').count(), 1, 'one left');
  await P().locator('.proj-action-item').first().getByRole('button', { name: /^Remove/ }).click();
  ok((await P().locator('.proj-settings .dialog-problem').first().innerText()).includes('Keep at least one'), 'says why');
  eq(await P().locator('.proj-action-item').count(), 1, 'still one');
  await P().getByRole('button', { name: 'Cancel' }).click();
  eq(await row('Corner Bakery').locator('.proj-actions .btn').count(), 5, 'Cancel saved nothing');
});

await step('star: sorts first, a filled star (shape, not just colour); the Panel Focus tile lists it and opens its page', async () => {
  await row('Corner Bakery').getByRole('button', { name: 'Focus: Corner Bakery website' }).click();
  await P().locator('.proj-row.focus').waitFor();
  eq((await P().locator('.proj-name').allInnerTexts())[0], 'Corner Bakery website', 'first');
  eq(await row('Corner Bakery').locator('.proj-star').innerText(), '★', 'filled star');
  eq(await row('Corner Bakery').locator('.proj-star').getAttribute('aria-pressed'), 'true', 'pressed');
  eq(await row('Word upgrade').locator('.proj-star').innerText(), '☆', 'outline star on the others');
  ok(await row('Corner Bakery').locator('.proj-star').evaluate(el => el === document.activeElement), 'the keyboard stays on the star after the list redraws');
  await openApp('panel');
  const panel = page.locator('.win', { has: page.locator('.panel') });
  const focus = panel.locator('.panel-tile', { has: page.locator('h3', { hasText: 'Focus' }) });
  await focus.locator('.panel-row', { hasText: 'Corner Bakery website' }).waitFor({ timeout: 15000 });
  ok((await focus.innerText()).includes('Next: Tomorrow'), 'its next entry: ' + (await focus.innerText()));
  ok(!(await focus.innerText()).includes('Word upgrade'), 'only starred projects');
  await shot('04-panel-focus');
  await focus.locator('.panel-row', { hasText: 'Corner Bakery website' }).click();
  await P().locator('.proj-title', { hasText: 'Corner Bakery website' }).waitFor({ timeout: 10000 });
  await close(panel);
});

await step('Finish moves a project to Finished (its calendar entries stay); Bring back returns it', async () => {
  await P().getByRole('button', { name: 'Finish', exact: true }).click();
  await toast('moved to Finished');
  await P().locator('.proj-page .hint', { hasText: 'Finished.' }).waitFor();
  await P().getByRole('button', { name: '‹ All projects' }).click();
  ok(!(await row('Corner Bakery').count()), 'not on the main list');
  ok((await P().getByRole('button', { name: /^Finished \(1\)/ }).count()) === 1, 'Finished (1)');
  ok((await calendarDay(TOMORROW)).some(t => t.includes('Audit and review: Corner Bakery')), 'its entries stay in the Calendar');
  await close(C());
  await P().getByRole('button', { name: /^Finished/ }).click();
  await row('Corner Bakery').getByRole('button', { name: 'Bring back' }).click();
  await toast('is back on your projects');
  await P().getByRole('button', { name: 'Back to projects' }).click();
  await row('Corner Bakery').waitFor();
});

await step('edit in place: rename and change the site; the calendar entries still belong to it', async () => {
  await row('Word upgrade').locator('.proj-name').click();
  await P().getByRole('button', { name: 'Edit' }).click();
  await P().getByLabel('Name').fill('Word upgrade (Write)');
  await P().getByLabel('Site').fill('tomlinos.com/write');
  await P().getByRole('button', { name: 'Save' }).click();
  await P().locator('.proj-title', { hasText: 'Word upgrade (Write)' }).waitFor();
  ok(await P().locator('.proj-entry', { hasText: 'Meet Sam Lee' }).count(), 'still linked to its entries');
  await P().getByRole('button', { name: '‹ All projects' }).click();
});

await step('Calendar: "Every day" is offered; a run-for event shows "Ends: for 3 days", keeps it on save; Where is there', async () => {
  await calendarDay(TOMORROW);
  await C().locator('.cal-side .cal-event', { hasText: 'Audit and review: Corner Bakery' }).click();
  eq(await C().getByLabel('Repeats').inputValue(), 'daily', 'Every day selected (not blank)');
  ok((await C().locator('.cal-ends').innerText()).includes('for 3 days'), 'says how it ends');
  await C().getByLabel('Where').fill('Home office');
  await C().getByRole('button', { name: 'Save' }).click();
  await C().locator('.cal-side .cal-event', { hasText: 'Home office' }).waitFor({ timeout: 10000 });
  ok(!(await calendarDay(plus(4))).some(t => t.includes('Audit and review: Corner Bakery')), 'still three days only after the save');
  await close(C());
});

await step('on a phone-sized screen the list, the page and the booking window fit without sideways scrolling', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  const fits = sel => page.locator(sel).first().evaluate(el => el.scrollWidth <= el.clientWidth + 1);
  ok(await fits('.proj-body'), 'the list');
  await row('Corner Bakery').getByRole('button', { name: 'Add new feature' }).click();
  ok(await D().evaluate(el => el.getBoundingClientRect().right <= window.innerWidth && el.scrollWidth <= el.clientWidth + 1), 'the window');
  await shot('05-phone-window');
  await page.keyboard.press('Escape');
  await row('Corner Bakery').locator('.proj-name').click();
  ok(await fits('.proj-body'), 'the page');
  await shot('06-phone-page');
  await page.setViewportSize({ width: 1400, height: 900 });
});

await step('no errors in the console', async () => {
  if (missing.length) console.log('       (404, expected for files not made yet: ' + [...new Set(missing)].join(', ') + ')');
  eq(problems.filter(p => !/status of 404/.test(p)), [], 'console');
});

console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? ': ' + failures.join('; ') : ''}`);
await browser.close().catch(() => {});
process.exit(failures.length ? 1 : 0);
