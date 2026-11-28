// Contacts in a real Chrome: the menu bar (File, Edit, View, Help) and toolbar (New, Edit, Delete, Favourite, search),
// the filter buttons (All, Favourites, Family, Friends, Work and any other group), groups and the star from the form
// and from the menus, search, sort, and the two checks that need a real page now Contacts has a menu bar: a stale
// edit does not bring back a contact deleted in another window (O20), and an unsaved form is not dropped unasked (O21).
// Needs the dev server on a FRESH, EMPTY data folder (the first step sets up the owner), and `npm run build` done.
//   node test/browser-contacts-groups.mjs [http://127.0.0.1:3119] [screenshot folder]
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3119';
const SHOTS = process.argv[3] ?? null;
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PASS = 'meadow-copper-lantern-71';
let passed = 0;
const failures = [];
const problems = [];

async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (error) {
    failures.push(name);
    await shot('fail-' + failures.length).catch(() => {});
    console.log('  FAIL ' + name + '\n       ' + String(error.message).split('\n')[0].slice(0, 600) + ' ' + (String(error.stack).match(/groups\.mjs:\d+/g) ?? []).join(' '));
  }
}
const ok = (v, what) => {
  if (!v) throw new Error(what);
};
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), `${what}: ${JSON.stringify(a)} (wanted ${JSON.stringify(b)})`);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
const page = await context.newPage();
page.on('pageerror', e => problems.push('pageerror: ' + e.message));
page.on('console', m => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && problems.push('console: ' + m.text().split('\n')[0]));
page.on('response', r => r.status() >= 400 && problems.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`));
const shot = async name => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });

async function closeAll() {
  for (let i = 0; i < 40; i++) {
    const dialog = page.locator('.dialog');
    if (await dialog.count()) {
      await dialog.getByRole('button', { name: /Discard|Cancel|Keep/ }).first().click().catch(() => dialog.getByRole('button').last().click());
      continue;
    }
    const wins = page.locator('.win');
    if (!(await wins.count())) return;
    const top = (await page.locator('.win.active').count()) ? page.locator('.win.active') : wins.last();
    await top.locator('.win-close').first().click();
    await page.waitForTimeout(80);
  }
  throw new Error('windows would not close');
}
let opened = 0;
async function openContacts() {
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('contacts');
  await page.locator('.start-menu [data-label="contacts"]').first().click();
  // The window just opened is the one in front; it is marked so it stays this window when another comes in front.
  const front = page.locator('.win.active', { has: page.locator('.contacts-app') });
  await front.locator('.statusbar').filter({ hasText: /contact/ }).waitFor({ timeout: 10000 });
  const mark = String(++opened);
  await front.evaluate((el, m) => el.setAttribute('data-test-win', m), mark);
  return page.locator(`.win[data-test-win="${mark}"]`);
}
const tool = (w, name) => w.locator('.cbar-tool', { has: page.locator(`[aria-label="${name}"]`) }).or(w.locator(`.cbar-tool[aria-label="${name}"]`)).first();
const names = w => w.locator('.person-row .person-name').allInnerTexts().then(l => l.map(s => s.replace(/\s*★$/, '').trim()));
const filterNames = w => w.locator('.contacts-filter').evaluateAll(bs => bs.map(b => b.childNodes[b.childNodes.length - 2]?.textContent ?? b.textContent));
async function choose(w, name) {
  await w.locator('.person-row', { hasText: name }).first().click();
  await w.locator('.person h2', { hasText: name }).waitFor();
}
async function menu(w, title, ...path) {
  await w.locator('.cbar-title', { hasText: title }).click();
  for (const item of path) {
    const it = page.locator('.menu').last().locator('.menu-item', { has: page.locator('.menu-label', { hasText: new RegExp(`^${item}$`) }) }).first();
    await it.waitFor();
    await it.click();
  }
}
async function add(w, fields) {
  await tool(w, 'New contact').click();
  await w.getByLabel('Name', { exact: true }).fill(fields.name);
  if (fields.description) await w.getByLabel('Description').fill(fields.description);
  if (fields.org) await w.getByLabel('Company').fill(fields.org);
  if (fields.title) await w.getByLabel('Job title').fill(fields.title);
  for (const g of fields.groups ?? []) await w.locator('.form-group-ticks label', { hasText: g }).locator('input').check();
  if (fields.other) await w.getByLabel('Other groups (separate them with commas)').fill(fields.other);
  if (fields.favourite) await w.locator('.form-groups > .form-check input').check();
  if (fields.phone) await w.getByLabel('Phone numbers (one per line)').fill(fields.phone);
  await w.getByRole('button', { name: 'Save', exact: true }).click();
  await w.locator('.person h2', { hasText: fields.name }).waitFor();
}

console.log('Contacts groups, menus and filters, against ' + BASE);
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

let w;
await step('the window has a menu bar (File, Edit, View, Help), toolbar pictures and a search box', async () => {
  w = await openContacts();
  eq(await w.locator('.cbar-title:visible').allInnerTexts().then(l => l.map(s => s.trim()).filter(Boolean)), ['File', 'Edit', 'View', 'Help'], 'menus');
  for (const name of ['New contact', 'Edit contact', 'Delete contact', 'Favourite']) ok(await w.locator(`.cbar-tool[aria-label="${name}"] svg`).count(), `a picture on ${name}`);
  ok(await w.getByLabel('Search contacts').isVisible(), 'search box');
  eq(await w.locator(`.cbar-tool[aria-label="Edit contact"]`).getAttribute('aria-disabled'), 'true', 'Edit waits for someone to be chosen');
  eq(await filterNames(w), ['All', 'Favourites', 'Family', 'Friends', 'Work'], 'the filter buttons on an empty address book');
});

await step('people added with groups, a description, a job title and a star', async () => {
  await add(w, { name: 'Ada Fernley', description: 'Made the oak shelves', org: 'Fernley Joinery', title: 'Owner', groups: ['Work'], favourite: true, phone: '07700 900123' });
  await add(w, { name: 'Ben Okafor', groups: ['Friends'], other: 'Garden club' });
  await add(w, { name: 'Clara Lindqvist', groups: ['Family', 'Friends'] });
  await add(w, { name: 'Dev Patel' });
  const head = await w.locator('.person-head').innerText();
  ok(head.includes('Dev Patel'), 'the card shows the last one saved');
  await choose(w, 'Ada Fernley');
  const ada = await w.locator('.person-head').innerText();
  for (const bit of ['Made the oak shelves', 'Owner, Fernley Joinery', 'Work', '★']) ok(ada.includes(bit), `Ada's card shows ${bit}: ${JSON.stringify(ada)}`);
  eq(await w.locator('.person-head .person-pic').innerText(), 'AF', 'initials');
  eq(await filterNames(w), ['All', 'Favourites', 'Family', 'Friends', 'Work', 'Garden club'], 'a group typed in the form gets its own button');
  await shot('01-card');
});

await step('the filter buttons show one group at a time; pressing the one that is on goes back to All', async () => {
  const filter = name => w.locator('.contacts-filter', { hasText: new RegExp(`^(★)?${name}\\d+$`) });
  await filter('Friends').click();
  eq(await names(w), ['Ben Okafor', 'Clara Lindqvist'], 'Friends');
  eq(await filter('Friends').getAttribute('aria-pressed'), 'true', 'Friends is on');
  ok((await w.locator('.statusbar').innerText()).includes('2 shown in Friends'), 'the status bar says so');
  await filter('Favourites').click();
  eq(await names(w), ['Ada Fernley'], 'Favourites');
  await filter('Garden club').click();
  eq(await names(w), ['Ben Okafor'], 'Garden club');
  await filter('Garden club').click();
  eq((await names(w)).length, 4, 'back to All');
  eq(await filter('All').getAttribute('aria-pressed'), 'true', 'All is on');
});

await step('View > Show picks the same filters, View > Sort by orders the list', async () => {
  await menu(w, 'View', 'Show', 'Family');
  eq(await names(w), ['Clara Lindqvist'], 'Family from the menu');
  await menu(w, 'View', 'Show', 'All contacts');
  await menu(w, 'View', 'Sort by', 'Last name');
  eq(await names(w), ['Ada Fernley', 'Clara Lindqvist', 'Ben Okafor', 'Dev Patel'], 'by last name');
  await menu(w, 'View', 'Sort by', 'Company');
  eq((await names(w))[0], 'Ada Fernley', 'the one with a company first');
  await menu(w, 'View', 'Sort by', 'First name');
});

await step('search finds by any word on the card, a group, or a phone number however it is spaced', async () => {
  const find = w.getByLabel('Search contacts');
  await find.fill('oak');
  eq(await names(w), ['Ada Fernley'], 'description');
  await find.fill('friends clara');
  eq(await names(w), ['Clara Lindqvist'], 'group and name');
  await find.fill('07700900123');
  eq(await names(w), ['Ada Fernley'], 'phone digits');
  await find.fill('nobody here');
  ok((await w.locator('.people').innerText()).includes('No one matches that.'), 'nothing matches');
  await find.fill('');
});

await step('the star from the toolbar, and groups from Edit > Groups, change the contact at once', async () => {
  await choose(w, 'Dev Patel');
  await w.locator('.cbar-tool[aria-label="Favourite"]').click();
  await w.locator('.person h2', { hasText: '★' }).waitFor();
  eq(await w.locator('.cbar-tool[aria-label="Favourite"]').getAttribute('aria-pressed'), 'true', 'the star is pressed');
  await menu(w, 'Edit', 'Groups', 'Work');
  await w.locator('.person-group', { hasText: 'Work' }).waitFor();
  await w.locator('.contacts-filter', { hasText: /^Work\d+$/ }).click();
  eq(await names(w), ['Ada Fernley', 'Dev Patel'], 'Dev is now in Work');
  await w.locator('.contacts-filter', { hasText: /^Work\d+$/ }).click();
});

await step('Edit > Groups > New group... adds a group of your own', async () => {
  await choose(w, 'Dev Patel');
  await menu(w, 'Edit', 'Groups', 'New group...');
  const d = page.locator('.dialog');
  await d.locator('input').fill('Plumbers');
  await d.getByRole('button', { name: 'Add' }).click();
  await w.locator('.person-group', { hasText: 'Plumbers' }).waitFor();
  ok((await filterNames(w)).includes('Plumbers'), 'a Plumbers button');
});

await step('a new contact made while a group is shown starts in that group', async () => {
  await w.locator('.contacts-filter', { hasText: /^Family\d+$/ }).click();
  await tool(w, 'New contact').click();
  ok(await w.locator('.form-group-ticks label', { hasText: 'Family' }).locator('input').isChecked(), 'Family is ticked');
  await w.getByLabel('Name', { exact: true }).fill('Elena Rossi');
  await w.getByRole('button', { name: 'Save', exact: true }).click();
  await w.locator('.person h2', { hasText: 'Elena Rossi' }).waitFor();
  eq(await names(w), ['Clara Lindqvist', 'Elena Rossi'], 'Family');
  await w.locator('.contacts-filter', { hasText: /^Family\d+$/ }).click();
});

await step('keys: F2 edits the chosen person, Escape leaves, Delete asks first, Ctrl+F goes to search, Alt+N starts a new one', async () => {
  await choose(w, 'Elena Rossi');
  await page.keyboard.press('F2');
  await w.locator('.person h2', { hasText: 'Edit contact' }).waitFor();
  await page.keyboard.press('Escape');
  await w.locator('.person h2', { hasText: 'Elena Rossi' }).waitFor();
  await w.locator('.person-row', { hasText: 'Elena Rossi' }).focus();
  await page.keyboard.press('Delete');
  await page.locator('.dialog', { hasText: 'Delete this contact?' }).getByRole('button', { name: 'Keep' }).click();
  ok((await names(w)).includes('Elena Rossi'), 'kept');
  await page.keyboard.press('Control+f');
  ok(await w.getByLabel('Search contacts').evaluate(el => el === document.activeElement), 'search has the keyboard');
  await page.keyboard.press('Alt+n');
  await w.locator('.person h2', { hasText: 'New contact' }).waitFor();
  await w.getByRole('button', { name: 'Cancel', exact: true }).click();
});

await step('the file keeps groups as CATEGORIES and the star and description as X-TOMLINOS lines', async () => {
  await page.keyboard.press('Control+Alt+e');
  const ex = page.locator('.win.active');
  await ex.locator('.item', { hasText: 'Documents' }).first().dblclick();
  await ex.locator('.item', { hasText: 'Contacts' }).first().click();
  const download = page.waitForEvent('download', { timeout: 10000 });
  await ex.getByRole('button', { name: 'Download' }).click();
  const text = readFileSync(await (await download).path(), 'utf8');
  await ex.locator('.win-close').first().click();
  for (const line of ['CATEGORIES:Work', 'X-TOMLINOS-FAVOURITE:1', 'X-TOMLINOS-DESCRIPTION:Made the oak shelves', 'TITLE:Owner', 'CATEGORIES:Friends,Garden club']) ok(text.includes(line), `the file has ${line}`);
});

await step('O20: a stale edit does not bring back a contact deleted in another window', async () => {
  await choose(w, 'Ben Okafor');
  await w.getByRole('button', { name: 'Edit', exact: true }).click();
  await w.getByLabel('Notes').fill('late edit');
  // A second Contacts window deletes Ben.
  const other = await openContacts();
  await choose(other, 'Ben Okafor');
  await tool(other, 'Delete contact').click();
  await page.locator('.dialog', { hasText: 'Delete this contact?' }).getByRole('button', { name: 'Delete' }).click();
  await other.locator('.person-row', { hasText: 'Ben Okafor' }).waitFor({ state: 'detached' });
  await other.locator('.win-close').first().click();
  await w.click({ position: { x: 600, y: 10 } });
  await w.getByRole('button', { name: 'Save', exact: true }).click();
  // The desktop's report says the save failed (its words are the general ones for an error it does not know).
  const said = page.locator('.dialog', { hasText: 'Could not save the contacts' });
  await said.waitFor({ timeout: 10000 });
  await said.getByRole('button').first().click();
  await w.getByRole('button', { name: 'Cancel', exact: true }).click();
  ok(!(await names(w)).includes('Ben Okafor'), 'Ben stays deleted');
});

await step('O21: an unsaved form asks before it is dropped by choosing someone else, New, or closing', async () => {
  await tool(w, 'New contact').click();
  await w.getByLabel('Name', { exact: true }).fill('Typed but unsaved');
  await w.locator('.person-row', { hasText: 'Ada Fernley' }).click();
  const ask = page.locator('.dialog', { hasText: 'Discard your changes?' });
  await ask.getByRole('button', { name: 'Keep editing' }).click();
  eq(await w.getByLabel('Name', { exact: true }).inputValue(), 'Typed but unsaved', 'the form stays when kept');
  await tool(w, 'New contact').click();
  await ask.getByRole('button', { name: 'Keep editing' }).click();
  await w.locator('.win-close').first().click();
  await ask.getByRole('button', { name: 'Keep editing' }).click();
  ok(await w.isVisible(), 'the window stays open');
  await w.locator('.person-row', { hasText: 'Ada Fernley' }).click();
  await ask.getByRole('button', { name: 'Discard' }).click();
  await w.locator('.person h2', { hasText: 'Ada Fernley' }).waitFor();
  await shot('02-after');
});

await step('a narrow window keeps the bar, the filters and the form usable', async () => {
  await w.locator('.win-max, [aria-label="Restore"]').first().click().catch(() => {});
  await w.evaluate(el => { el.style.width = '460px'; el.style.height = '600px'; });
  await page.waitForTimeout(400);
  ok(await w.locator('.contacts-filters').isVisible(), 'filters visible');
  const box = await w.boundingBox();
  const filters = await w.locator('.contacts-filters').boundingBox();
  ok(filters && box && filters.x + filters.width <= box.x + box.width + 1, 'the filter buttons wrap inside the window');
  await shot('03-narrow');
});

ok(true);
// The O20 step's refused save is reported on purpose; a read of a file not made yet (a new desktop) is a 404.
const real = problems.filter(p => !/favicon|ERR_ABORTED|deleted in another window|^404 GET \/api\/store\.php$/.test(p));
if (real.length) console.log('  page errors:\n   ' + real.slice(0, 8).join('\n   '));
console.log(`\n${passed} passed, ${failures.length} failed${real.length ? `, ${real.length} page errors` : ''}`);
await browser.close();
process.exit(failures.length || real.length ? 1 : 0);
