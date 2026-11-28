// The Calendar's other calendars in a real Chrome: the menu bar, public and school holidays for a chosen state, a
// calendar subscribed to by its link (from a stand-in calendar site on this computer, port 3894, the one address the
// server may fetch from in this run: DESKTOP_ICAL_ALLOW_HOSTS), and File > Import and Export through the desktop's
// Open and Save windows. Needs the dev server on a FRESH, EMPTY data folder, and `npm run build` done.
//   SUITES="calendar-subs" bash tools/run-browser-tests.sh <folder>
//   or: node test/browser-calendar-subs.mjs [http://127.0.0.1:3043] [screenshot folder]
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3043';
const SHOTS = process.argv[3] ?? null;
const SITE = 3894;
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PASS = 'harbour-quill-lantern-64';
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
const ok = (v, what) => {
  if (!v) throw new Error(what);
};
/** Waits (up to 10 s) for `check` to come true: a save goes to the server and back before the window redraws. */
async function until(check, what) {
  for (let i = 0; i < 50; i++) {
    if (await check()) return;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(typeof what === 'function' ? await what() : what);
}

// The stand-in calendar site: a team calendar whose content the steps change, and a switch to make it fail.
let team = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'X-WR-CALNAME:Team rota', 'BEGIN:VEVENT', 'UID:standup@team', 'DTSTART:20261130T090000', 'DTEND:20261130T093000',
  'SUMMARY:Team stand-up', 'LOCATION:Room 4', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
let failing = false;
let asked = 0;
const site = createServer((req, res) => {
  asked++;
  if (failing) return void res.writeHead(503).end('down');
  if (req.url === '/team.ics') return void res.writeHead(200, { 'Content-Type': 'text/calendar' }).end(team);
  res.writeHead(404).end();
});
await new Promise(r => site.listen(SITE, '127.0.0.1', r));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1360, height: 860 }, timezoneId: 'Australia/Sydney' });
const page = await context.newPage();
// Today in the test is 26 November 2026 in Sydney.
await page.clock.install({ time: new Date('2026-11-26T01:00:00Z') });
const problems = [];
page.on('pageerror', e => problems.push('pageerror: ' + e.message));
const shot = async name => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });
const cal = () => page.locator('.win', { has: page.locator('.calendar-app') }).last();
const dialog = () => page.locator('.dialog').last();
const busy = async day => (await cal().locator(`.cal-cell[data-day="${day}"]`).getAttribute('class')).includes('busy');
async function dayList(day) {
  await cal().locator(`.cal-cell[data-day="${day}"]`).click();
  await cal().locator('.cal-side h3').waitFor();
  return cal().locator('.cal-side .cal-event').allInnerTexts();
}
async function menu(title, item) {
  await cal().locator(`.cbar-title[data-menu="${title}"]`).click();
  await page.locator('.menu .menu-item', { hasText: item }).first().click();
}

console.log('Calendar subscriptions and holidays, against ' + BASE);
await page.goto(BASE);

await step('set up the owner', async () => {
  await page.locator('.gate h1', { hasText: 'Set up this desktop' }).waitFor({ timeout: 20000 });
  await page.getByLabel('Your name').fill('Sample Owner');
  await page.locator('.gate input.gate-input').last().fill(PASS);
  if (await page.locator('.gate-encrypt').count()) await page.locator('.gate-encrypt').uncheck();
  await page.locator('.gate-go').click();
  await page.locator('.gate h1', { hasText: 'Your recovery key' }).waitFor({ timeout: 30000 });
  await page.locator('.gate .check-row input').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#desktop .item').first().waitFor({ timeout: 20000 });
});

await step('the Calendar has the classic menu bar (File, View, Calendars, Help) with small toolbar pictures, and no ribbon', async () => {
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('calendar');
  await page.locator('.start-menu [data-label="calendar"]').first().click();
  await cal().locator('.cal-cell').first().waitFor();
  const titles = await cal().locator('.cbar-title:not(.cbar-more)').allInnerTexts();
  ok(['File', 'View', 'Calendars', 'Help'].every(t => titles.includes(t)), `menus: ${titles}`);
  ok((await cal().locator('.cbar-tool[aria-label="Import from an .ics file"] svg').count()) === 1, 'Import has its picture');
  ok(!(await cal().locator('.ribbon').count()), 'no ribbon');
  const small = await cal().evaluate(el => [...el.querySelectorAll('*')].filter(e => e.childNodes.length && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && parseFloat(getComputedStyle(e).fontSize) < 12).map(e => e.className).slice(0, 5));
  ok(!small.length, `text under 12px: ${small}`);
});

// The event form's own checks (moved here from test/contacts-calendar-nov.test.ts: the menu bar needs a real page).
const wins = () => page.locator('.win', { has: page.locator('.calendar-app') });
const discard = () => page.locator('.dialog', { hasText: 'Discard your changes?' });
async function newEvent(w, what) {
  await w.getByRole('button', { name: 'New event' }).click();
  await w.locator('[aria-label="What"]').fill(what);
}

await step('O21: the Calendar asks before an unsaved form is dropped by choosing another day, New event, or closing', async () => {
  const w = wins().first();
  await newEvent(w, 'Typed but unsaved');
  await w.locator('.cal-cell[data-day="2026-11-10"]').click();
  await discard().waitFor();
  await discard().getByRole('button', { name: 'Keep editing' }).click();
  ok((await w.locator('[aria-label="What"]').inputValue()) === 'Typed but unsaved', 'the form stays when kept');
  await w.getByRole('button', { name: 'New event' }).click();
  await discard().waitFor();
  await discard().getByRole('button', { name: 'Keep editing' }).click();
  await w.locator('.win-close').first().click();
  await discard().waitFor();
  await discard().getByRole('button', { name: 'Keep editing' }).click();
  ok(await w.isVisible(), 'the window stays open');
  await w.locator('.cal-cell[data-day="2026-11-10"]').click();
  await discard().getByRole('button', { name: 'Discard' }).click();
  await w.locator('.cal-side h3', { hasText: '10' }).waitFor();
  ok(!(await w.locator('[aria-label="What"]').count()), 'the form is gone');
});

await step('CAL-P1-6: a day clicked while a save is on its way waits for it, and a form opened meanwhile is not replaced', async () => {
  const w = wins().first();
  let release = () => {};
  const hold = async () => {
    const gate = new Promise(r => (release = r));
    await page.route('**/api/store.php?op=commit*', async route => {
      await gate;
      await route.continue();
    }, { times: 1 });
  };
  // Lunch goes on the 11th; the 12th is clicked while it saves.
  await w.locator('.cal-cell[data-day="2026-11-11"]').click();
  await hold();
  await newEvent(w, 'Lunch');
  await w.getByRole('button', { name: 'Save' }).click();
  await page.waitForTimeout(300);
  await w.locator('.cal-cell[data-day="2026-11-12"]').click();
  await page.waitForTimeout(300);
  ok(!(await discard().count()), 'no "Discard?" while the save is on its way');
  release();
  await w.locator('.cal-side h3', { hasText: '12' }).waitFor({ timeout: 10000 });
  ok(!(await w.locator('[aria-label="What"]').count()), 'the day is shown after the save');
  await hold();
  await newEvent(w, 'Dinner');
  await w.getByRole('button', { name: 'Save' }).click();
  await page.waitForTimeout(300);
  await w.getByRole('button', { name: 'New event' }).click();
  await page.waitForTimeout(300);
  release();
  await until(async () => (await w.locator('[aria-label="What"]').count()) === 1 && (await w.locator('[aria-label="What"]').inputValue()) === '', 'the new, empty form is open');
  await page.waitForTimeout(800);
  ok((await w.locator('[aria-label="What"]').inputValue()) === '', 'and the finished save did not replace it');
  await w.locator('.cal-side').getByRole('button', { name: 'Cancel' }).click();
  await w.locator('.cal-cell[data-day="2026-11-11"]').click();
  const lunch = await w.locator('.cal-side .cal-event-title').allInnerTexts();
  await w.locator('.cal-cell[data-day="2026-11-12"]').click();
  const dinner = await w.locator('.cal-side .cal-event-title').allInnerTexts();
  ok(lunch.includes('Lunch') && dinner.includes('Dinner'), `both saved: ${lunch} / ${dinner}`);
});

await step('O20: an edit of an event deleted in another window is refused, not quietly put back', async () => {
  const a = wins().first();
  await a.locator('.cal-cell[data-day="2026-11-11"]').click();
  await a.locator('.cal-side .cal-event', { hasText: 'Lunch' }).click();
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('calendar');
  await page.locator('.start-menu [data-label="calendar"]').first().click();
  await wins().nth(1).locator('.cal-cell').first().waitFor();
  const b = wins().nth(1);
  await b.locator('.cal-cell[data-day="2026-11-11"]').click();
  await b.locator('.cal-side .cal-event', { hasText: 'Lunch' }).click();
  await b.locator('.cal-side').getByRole('button', { name: 'Delete' }).click();
  await page.locator('.dialog', { hasText: 'Delete this event?' }).getByRole('button', { name: 'Delete' }).click();
  await b.locator('.cal-side .hint', { hasText: 'Nothing on this day.' }).waitFor();
  await b.locator('.win-close').first().click();
  await a.locator('[aria-label="What"]').fill('Late edit');
  await a.locator('.cal-side').getByRole('button', { name: 'Save' }).click();
  const report = page.locator('.dialog', { hasText: 'Could not save the calendar' });
  await report.waitFor({ timeout: 10000 });
  ok(/deleted in another window/.test(await report.innerText()), await report.innerText());
  await report.getByRole('button').first().click();
  await a.locator('.cal-side').getByRole('button', { name: 'Cancel' }).click();
  await a.locator('.cal-cell[data-day="2026-11-11"]').click();
  const titles = await a.locator('.cal-side .cal-event-title').allInnerTexts();
  ok(!titles.includes('Late edit') && !titles.includes('Lunch'), `not revived: ${titles}`);
});

await step('public and school holidays for New South Wales: Christmas, the Boxing Day substitute and the summer break show', async () => {
  await cal().getByRole('button', { name: 'Public and school holidays' }).click();
  await dialog().getByLabel('Country').selectOption('AU');
  await dialog().getByLabel('State or region').selectOption('AU-NSW');
  await dialog().locator('label', { hasText: 'Public holidays' }).locator('input').check();
  await dialog().locator('label', { hasText: 'School holidays' }).locator('input').check();
  ok(/2026 to 2027/.test(await dialog().locator('.cal-data-note').innerText()), 'the note gives the school years covered');
  await dialog().getByRole('button', { name: 'Save' }).click();
  await cal().locator('.cal-list-row[data-calendar="public"]').waitFor();
  await cal().getByRole('button', { name: 'Next month' }).click();
  const boxing = await dayList('2026-12-28');
  ok(boxing.some(t => t.includes('Boxing Day (substitute day)')), `28 Dec: ${boxing}`);
  ok(boxing.some(t => t.includes('School holidays (summer)')), `the summer break runs over the 28th: ${boxing}`);
  await cal().locator('.cal-side .cal-event', { hasText: 'Christmas' }).count();
  const xmas = await dayList('2026-12-25');
  ok(xmas.some(t => t.includes('Christmas Day')), `25 Dec: ${xmas}`);
  await cal().locator('.cal-side .cal-event', { hasText: 'Christmas Day' }).first().click();
  ok(/Read-only/.test(await cal().locator('.cal-side .cal-readonly').innerText()), 'a holiday opens read-only');
  await shot('holidays');
});

await step('a year whose school dates are not published says so, rather than guessing', async () => {
  for (let i = 0; i < 13; i++) await cal().getByRole('button', { name: 'Next month' }).click();
  const status = await cal().locator('.cal-status').innerText();
  ok(/School holidays for 2028 in New South Wales are not known yet/.test(status), `status: ${status}`);
  await cal().getByRole('button', { name: 'Today', exact: true }).click();
});

await step('the public holidays can be hidden with their tick, and shown again', async () => {
  await cal().getByRole('button', { name: 'Next month' }).click();
  const chips = () => cal().locator('.cal-cell[data-day="2026-12-25"] .cal-chip').allInnerTexts();
  try {
    ok((await chips()).includes('Christmas Day'), 'Christmas shows');
    await cal().getByLabel('Show Public holidays (NSW)').uncheck();
    // The school summer break still shows on the day; Christmas does not.
    await until(async () => !(await chips()).includes('Christmas Day'), async () => `hidden: ${await chips()}`);
    await cal().getByLabel('Show Public holidays (NSW)').check();
    await until(async () => (await chips()).includes('Christmas Day'), 'shown again');
  } finally {
    await cal().getByRole('button', { name: 'Today', exact: true }).click();
  }
});

await step('Add by link: the Google steps are there; a link inside the network is refused in words', async () => {
  await cal().getByRole('button', { name: 'Add by link...' }).click();
  await dialog().locator('summary', { hasText: 'Where to find the link' }).click();
  ok(/Secret address in iCal format/.test(await dialog().locator('.cal-help').innerText()), 'the Google steps');
  ok(/Read-only/.test(await dialog().innerText()), 'says read-only');
  await dialog().getByLabel('Calendar link').fill('https://192.168.1.1/cal.ics');
  await dialog().getByRole('button', { name: 'Add' }).click();
  await page.locator('.dialog', { hasText: 'Could not add that calendar' }).waitFor({ timeout: 15000 });
  ok(/inside the server's own network/.test(await dialog().innerText()), await dialog().innerText());
  await dialog().getByRole('button', { name: 'OK' }).click();
  // The form comes back with what was typed.
  await page.locator('.dialog', { hasText: 'Add a calendar by its link' }).waitFor();
  await dialog().getByRole('button', { name: 'Cancel' }).click();
});

await step('subscribe to the stand-in calendar: it shows as its own read-only calendar, named from the file', async () => {
  await cal().getByRole('button', { name: 'Add by link...' }).click();
  await dialog().getByLabel('Calendar link').fill(`http://127.0.0.1:${SITE}/team.ics`);
  await dialog().getByLabel('Colour').selectOption({ label: 'Orange' });
  await dialog().getByRole('button', { name: 'Add' }).click();
  const row = cal().locator('.cal-list-row', { hasText: 'Team rota' });
  await row.waitFor({ timeout: 15000 });
  ok(/Read-only/.test(await row.innerText()), await row.innerText());
  const list = await dayList('2026-11-30');
  ok(list.some(t => t.includes('Team stand-up') && t.includes('Team rota')), `30 Nov: ${list}`);
  await cal().locator('.cal-side .cal-event', { hasText: 'Team stand-up' }).click();
  const text = await cal().locator('.cal-side').innerText();
  ok(/Room 4/.test(text) && /comes from “Team rota” \(127\.0\.0\.1\)/.test(text), text);
  ok(!(await cal().locator('.cal-side input').count()), 'no form to change it');
  await shot('subscribed');
});

await step('Refresh brings the calendar’s changes; a failed refresh keeps the last copy and says why', async () => {
  team = team.replace('END:VCALENDAR', ['BEGIN:VEVENT', 'UID:retro@team', 'DTSTART:20261127T150000', 'SUMMARY:Retro', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'));
  await cal().getByRole('button', { name: 'Refresh subscribed calendars' }).click();
  await page.waitForFunction(() => document.querySelector('.calendar-app .cal-cell[data-day="2026-11-27"]')?.classList.contains('busy'), null, { timeout: 15000 });
  failing = true;
  await cal().getByRole('button', { name: 'Refresh subscribed calendars' }).click();
  await cal().locator('.cal-list .cal-problem').waitFor({ timeout: 15000 });
  ok(/503/.test(await cal().locator('.cal-list .cal-problem').innerText()), 'says why');
  ok(await busy('2026-11-30'), 'the last copy still shows');
  failing = false;
});

await step('the subscribed calendar can be hidden from the Calendars menu', async () => {
  await menu('Calendars', 'Team rota');
  await until(async () => !(await busy('2026-11-30')), 'hidden');
  await menu('Calendars', 'Team rota');
  await until(() => busy('2026-11-30'), 'shown');
});

await step('File > Import from an .ics file through the Open window, with a report of what happened', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cal-import-'));
  writeFileSync(join(dir, 'trip.ics'), ['BEGIN:VCALENDAR', 'VERSION:2.0',
    'BEGIN:VEVENT', 'UID:flight@x', 'DTSTART;TZID=Europe/London:20261203T080000', 'DTEND;TZID=Europe/London:20261203T110000', 'SUMMARY:Flight', 'ATTENDEE:mailto:sam@example.com', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:gone@x', 'DTSTART:20261204T080000', 'STATUS:CANCELLED', 'SUMMARY:Off', 'END:VEVENT',
    'BEGIN:VTODO', 'UID:t@x', 'SUMMARY:Pack', 'END:VTODO', 'END:VCALENDAR', ''].join('\r\n'));
  await page.keyboard.press('Control+Alt+e');
  const ex = page.locator('.win').last();
  await ex.locator('.item', { hasText: 'Documents' }).first().dblclick();
  const chooser = page.waitForEvent('filechooser');
  await ex.getByRole('button', { name: 'Upload' }).click();
  (await chooser).setFiles([join(dir, 'trip.ics')]);
  await ex.locator('.item', { hasText: 'trip' }).first().waitFor({ timeout: 15000 });
  await ex.locator('.win-close').first().click();
  await menu('File', 'Import from an .ics file');
  const pick = page.locator('.dialog:has(.pick)').last();
  await pick.locator('.pick-row', { hasText: 'trip' }).first().waitFor({ timeout: 10000 });
  await pick.locator('.pick-row', { hasText: 'trip' }).first().dblclick();
  const report = page.locator('.dialog', { hasText: 'Import finished' });
  await report.waitFor({ timeout: 15000 });
  const text = await report.innerText();
  ok(/1 event added/.test(text) && /cancelled in the other calendar/.test(text) && /to-do/.test(text), text);
  await report.getByRole('button', { name: 'OK' }).click();
  // Again: already there.
  await menu('File', 'Import from an .ics file');
  await pick.locator('.pick-row', { hasText: 'trip' }).first().dblclick();
  await report.waitFor({ timeout: 15000 });
  ok(/1 event was already in your calendar/.test(await report.innerText()), await report.innerText());
  await report.getByRole('button', { name: 'OK' }).click();
});

await step('File > Export as an .ics file through the Save window keeps every line of the imported event', async () => {
  await menu('File', 'Export as an .ics file');
  const pick = page.locator('.dialog:has(.pick)').last();
  await pick.locator('.pick-name-box').fill('Exported.ics');
  await pick.getByRole('button', { name: 'Export' }).click();
  await page.locator('.toast', { hasText: 'Exported' }).waitFor({ timeout: 15000 });
  // Opened in a Calendar of its own, the exported file has the imported flight (every line kept: test/calendar-import.test.ts).
  await page.keyboard.press('Control+Alt+e');
  const ex = page.locator('.win').last();
  await ex.locator('.item', { hasText: 'Documents' }).first().dblclick();
  await ex.locator('.item', { hasText: 'Exported' }).first().dblclick({ timeout: 10000 });
  const opened = page.locator('.win', { has: page.locator('.calendar-app') }).last();
  await opened.locator('.cal-list-name', { hasText: 'Exported' }).waitFor({ timeout: 10000 });
  await opened.getByRole('button', { name: 'Next month' }).click();
  await opened.locator('.cal-cell[data-day="2026-12-03"]').click();
  const day = await opened.locator('.cal-side .cal-event').allInnerTexts();
  ok(day.some(t => t.includes('Flight')), `3 Dec in the exported file: ${day}`);
});

if (problems.length) {
  failures.push('page errors');
  console.log('  FAIL page errors\n       ' + problems.join('\n       '));
}
console.log(`  (the stand-in calendar site was asked ${asked} times)`);
await browser.close();
site.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
