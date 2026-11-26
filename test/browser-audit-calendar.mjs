// Audit of the Calendar in a real Chrome: faults found by trying to break it. Needs the dev server on a FRESH, EMPTY
// data folder (the first step sets up the owner), and `npm run build` done. The browser runs in Los Angeles time, so a
// file from Sydney lands a day earlier here. Each step marked FAULT fails while that fault is open; a NOTE (a lesser
// fault) is reported but does not fail the run.
//   node test/browser-audit-calendar.mjs [http://127.0.0.1:3115] [screenshot folder]
import { chromium } from 'playwright-core';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3115';
const SHOTS = process.argv[3] ?? null;
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PASS = 'orchard-lantern-harbour-58';
let passed = 0;
const failures = [];
const notes = [];

async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (error) {
    await shot('fail-' + (failures.length + notes.length + 1)).catch(() => {});
    if (name.startsWith('NOTE')) {
      notes.push(name);
      console.log('  note ' + name + '\n       ' + String(error.message).slice(0, 400));
    } else {
      failures.push(name);
      console.log('  FAIL ' + name + '\n       ' + String(error.message).slice(0, 800));
    }
  }
}
const eq = (a, b, what) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const ok = (v, what) => {
  if (!v) throw new Error(what);
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
// Today in the test is 26 November 2026 (so November 2026 is the month that opens), in Los Angeles.
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, timezoneId: 'America/Los_Angeles' });
const page = await context.newPage();
await page.clock.install({ time: new Date('2026-11-26T18:00:00Z') });
const problems = [];
page.on('pageerror', e => problems.push('pageerror: ' + e.message));
const shot = async name => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });
const front = () => page.locator('.win').last();
const calWin = () => page.locator('.win', { has: page.locator('.calendar-app') }).last();
async function closeAll() {
  for (let i = 0; i < 40; i++) {
    const dialog = page.locator('.dialog');
    if (await dialog.count()) {
      await dialog.getByRole('button', { name: /Discard|without saving|Cancel|Keep it/ }).first().click().catch(() => dialog.getByRole('button').last().click());
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
async function openCalendar() {
  await closeAll();
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('calendar');
  await page.locator('.start-menu [data-label="calendar"]').first().click();
  await calWin().locator('.cal-cell').first().waitFor();
  return calWin();
}
const busy = async (w, day) => (await w.locator(`.cal-cell[data-day="${day}"]`).getAttribute('class')).includes('busy');

console.log('Calendar audit, against ' + BASE);
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

await step('upload a weekly invite written in Sydney (Mondays 09:00, BYDAY as Google writes it) into Documents', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cal-audit-'));
  const text = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:sync@example.com', 'DTSTART;TZID=Australia/Sydney:20261102T090000',
    'DTEND;TZID=Australia/Sydney:20261102T100000', 'RRULE:FREQ=WEEKLY;BYDAY=MO', 'SUMMARY:Sydney sync', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
  writeFileSync(join(dir, 'invite.ics'), text);
  const w = await documents();
  const chooser = page.waitForEvent('filechooser');
  await w.getByRole('button', { name: 'Upload' }).click();
  (await chooser).setFiles([join(dir, 'invite.ics')]);
  await w.locator('.item', { hasText: 'invite' }).first().waitFor({ timeout: 15000 });
});

await step('FAULT CAL-P0-1: the Sydney Monday invite shows on Sundays here (1, 8, 15 Nov), not on Mondays after the first', async () => {
  const w = front();
  await w.locator('.item', { hasText: 'invite' }).first().dblclick();
  const cal = calWin();
  await cal.locator('.cal-cell[data-day="2026-11-01"]').waitFor();
  await shot('invite-month');
  const got = {};
  for (const day of ['2026-11-01', '2026-11-02', '2026-11-08', '2026-11-09', '2026-11-15']) got[day] = await busy(cal, day);
  eq(got, { '2026-11-01': true, '2026-11-02': false, '2026-11-08': true, '2026-11-09': false, '2026-11-15': true }, 'days with the event');
});

await step('NOTE CAL-P1: Escape in the event form cancels it (asks first when something was typed)', async () => {
  const w = await openCalendar();
  await w.getByRole('button', { name: 'New event' }).click();
  await w.getByLabel('What').fill('x');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  ok((await page.locator('.dialog').count()) > 0 || (await w.getByLabel('What').count()) === 0, 'Escape did nothing');
});

await step('NOTE CAL-P1: Page Down in the month moves to the next month', async () => {
  const w = await openCalendar();
  await w.locator('.cal-cell.chosen').focus();
  await page.keyboard.press('PageDown');
  await page.waitForTimeout(200);
  eq(await w.locator('.cal-cell.chosen').getAttribute('data-day'), '2026-12-26', 'chosen day after Page Down');
});

await step('NOTE CAL-P1: the Calendar has a menu bar (File: Open, Import, Export, Print)', async () => {
  const w = await openCalendar();
  ok(await w.locator('.menubar, [role=menubar]').count(), 'no menu bar');
});

await step('NOTE CAL-P1: in a small window the day panel and the form fill the window (no empty band, the month stays in view)', async () => {
  await page.setViewportSize({ width: 420, height: 520 });
  const w = await openCalendar();
  await page.waitForTimeout(300);
  const gap = await w.evaluate(win => {
    const main = win.querySelector('.cal-main').getBoundingClientRect();
    const side = win.querySelector('.cal-side').getBoundingClientRect();
    return Math.round(main.bottom - side.bottom);
  });
  await shot('small');
  await w.getByRole('button', { name: 'New event' }).click();
  const gridHeight = await w.locator('.cal-month-grid').evaluate(g => g.getBoundingClientRect().height);
  await shot('small-form');
  await page.setViewportSize({ width: 1280, height: 800 });
  ok(gap < 8 && gridHeight > 100, `empty band under the panel: ${gap}px; month height with the form open: ${Math.round(gridHeight)}px`);
});

await closeAll().catch(() => {});
await browser.close();
if (problems.length) console.log('page errors:\n  ' + problems.join('\n  '));
console.log(`\n${passed} passed, ${failures.length} failed, ${notes.length} notes`);
process.exit(failures.length ? 1 : 0);
