// Audit of Contacts in a real Chrome: an Apple-style card's grouped email and phone, an address with a line break
// kept as an address when another field is edited, two windows on one address book, a small window, keyboard use.
// Each step marked FAULT failed when it was written. Needs the dev server on a FRESH, EMPTY data folder (the first
// step sets up the owner), and `npm run build` done.
//   node test/browser-audit-contacts.mjs [http://127.0.0.1:3118] [screenshot folder]
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3118';
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
    console.log('  FAIL ' + name + '\n       ' + String(error.message).split('\n')[0].slice(0, 600) + ' ' + (String(error.stack).match(/contacts\.mjs:\d+/g) ?? []).join(' '));
  }
  await closeAll().catch(() => {});
}
const ok = (v, what) => {
  if (!v) throw new Error(what);
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
const page = await context.newPage();
const shot = async name => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });
const front = () => page.locator('.win.active');

async function closeAll() {
  for (let i = 0; i < 40; i++) {
    const dialog = page.locator('.dialog');
    if (await dialog.count()) {
      await dialog.getByRole('button', { name: /Discard|without saving|Do not save|Cancel|Close anyway/ }).first().click().catch(() => dialog.getByRole('button').last().click());
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
async function documents() {
  await page.keyboard.press('Control+Alt+e');
  const w = front();
  await w.locator('.item', { hasText: 'Documents' }).first().dblclick();
  return w;
}
async function downloadText(stem) {
  const w = await documents();
  await w.locator('.item', { hasText: stem }).first().click();
  const download = page.waitForEvent('download', { timeout: 10000 });
  await w.getByRole('button', { name: 'Download' }).click();
  const d = await download;
  const text = readFileSync(await d.path(), 'utf8');
  await closeAll();
  return text;
}
async function openContacts() {
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('contacts');
  await page.locator('.start-menu [data-label="contacts"]').first().click();
  const w = page.locator('.win', { has: page.locator('.contacts-app') }).last();
  await w.locator('.statusbar').filter({ hasText: /contact/ }).waitFor({ timeout: 10000 });
  return w;
}
async function choose(w, name) {
  await w.locator('.person-row', { hasText: name }).first().click();
  await w.locator('.person h2', { hasText: name }).waitFor();
}

console.log('Contacts audit, against ' + BASE);
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

// An address book as Apple Contacts and Google write them: grouped lines (item1.EMAIL) and a street with a line break.
const BS = '\\';
const vcf = [
  'BEGIN:VCARD', 'VERSION:3.0', 'UID:apple-1', 'FN:Anna Apple', 'N:Apple;Anna;;;',
  'item1.EMAIL;type=INTERNET;type=pref:anna@example.com', 'item1.X-ABLabel:_$!<Other>!$_',
  'item2.TEL;type=CELL:+44 7700 900111', 'item2.X-ABLabel:mobile', 'END:VCARD',
  'BEGIN:VCARD', 'VERSION:3.0', 'UID:bob-1', 'FN:Bob Builder', 'N:Builder;Bob;;;',
  `ADR;TYPE=home:;;1 Main St${BS}nFlat 2;Springfield;IL;62704;USA`, 'TEL;TYPE=cell:555 0100', 'END:VCARD',
  'BEGIN:VCARD', 'VERSION:3.0', 'UID:cara-1', 'FN:Cara Clay', 'N:Clay;Cara;;;', 'END:VCARD', '',
].join('\r\n');

await step('upload Contacts.vcf into Documents', async () => {
  const dir = tempDir('tomlinos-audit-contacts-');
  writeFileSync(join(dir, 'Contacts.vcf'), vcf);
  const w = await documents();
  const chooser = page.waitForEvent('filechooser');
  await w.getByRole('button', { name: 'Upload' }).click();
  (await chooser).setFiles([join(dir, 'Contacts.vcf')]);
  await w.locator('.item', { hasText: 'Contacts' }).first().waitFor({ timeout: 15000 });
});

await step('FAULT CON-P0-1: an Apple-style card shows its grouped email and phone (item1.EMAIL, item2.TEL)', async () => {
  const w = await openContacts();
  await choose(w, 'Anna Apple');
  const facts = await w.locator('.person-facts').innerText();
  ok(facts.includes('anna@example.com'), 'email not shown: ' + JSON.stringify(facts));
  ok(facts.includes('7700 900111'), 'phone not shown: ' + JSON.stringify(facts));
});

await step('FAULT CON-P0-2: editing only the phone keeps an address with a line break as a structured address', async () => {
  const w = await openContacts();
  await choose(w, 'Bob Builder');
  await w.getByRole('button', { name: 'Edit' }).click();
  await w.getByLabel('Phone numbers (one per line)').fill('555 0100\n555 0199');
  await w.getByRole('button', { name: 'Save' }).click();
  await w.locator('.person-facts', { hasText: '555 0199' }).waitFor();
  await closeAll();
  const text = await downloadText('Contacts');
  const adr = text.split('\r\n').find(l => l.startsWith('ADR')) ?? '';
  ok(/;Springfield;IL;62704;USA$/.test(adr), 'address line now: ' + JSON.stringify(adr));
});

await step('FAULT CON-P0-3: a card changed in another window is shown fresh, and editing it there does not undo that change', async () => {
  await openContacts();
  const a = page.locator('.win', { has: page.locator('.contacts-app') }).filter({ hasNotText: 'Contacts.vcf - Contacts' });
  await choose(a, 'Cara Clay');
  // A second window on the same file (opened from File Explorer) adds a phone to Cara.
  const e = await documents();
  await e.locator('.item', { hasText: 'Contacts' }).first().dblclick();
  const b = page.locator('.win', { has: page.locator('.contacts-app') }).filter({ hasText: 'Contacts.vcf - Contacts' });
  await b.locator('.statusbar').filter({ hasText: /contact/ }).waitFor({ timeout: 10000 });
  await choose(b, 'Cara Clay');
  await b.getByRole('button', { name: 'Edit' }).click();
  await b.getByLabel('Phone numbers (one per line)').fill('020 7946 0000');
  await b.getByRole('button', { name: 'Save' }).click();
  await b.locator('.person-facts', { hasText: '020 7946 0000' }).waitFor();
  await page.waitForTimeout(1500);
  // Back in the first window (brought to the front), still showing Cara: change only her notes.
  await a.click({ position: { x: 150, y: 10 } });
  const shown = await a.locator('.person').innerText();
  await a.getByRole('button', { name: 'Edit' }).click();
  await a.getByLabel('Notes').fill('met at the fair');
  await a.getByRole('button', { name: 'Save' }).click();
  await a.locator('.person-facts', { hasText: 'met at the fair' }).waitFor();
  await closeAll();
  const text = await downloadText('Contacts');
  ok(text.includes('020 7946 0000'), 'the other window\'s phone was lost (first window showed: ' + JSON.stringify(shown.slice(0, 80)) + ')');
});

await step('FAULT CON-P1-13: in the smallest window the edit form fits: no field is cut off sideways and Save can be reached', async () => {
  const w = await openContacts();
  await w.evaluate(win => {
    win.style.width = '360px';
    win.style.height = '320px';
  });
  await page.waitForTimeout(200);
  await choose(w, 'Bob Builder');
  await w.getByRole('button', { name: 'Edit' }).click();
  const box = await w.locator('.person').evaluate(p => ({ scroll: p.scrollWidth, client: p.clientWidth, width: p.getBoundingClientRect().width }));
  const name = await w.getByLabel('Name', { exact: true }).evaluate(i => i.getBoundingClientRect().width);
  await shot('small-form');
  ok(box.scroll <= box.client + 1 && name >= 120, `card ${Math.round(box.width)}px wide, scrolls to ${box.scroll}px; the Name field is ${Math.round(name)}px`);
});

await step('FAULT CON-P1-14: Escape leaves the edit form (asking if changed) and Ctrl+S or Enter saves it', async () => {
  const w = await openContacts();
  await choose(w, 'Bob Builder');
  await w.getByRole('button', { name: 'Edit' }).click();
  await w.getByLabel('Name', { exact: true }).fill('Robert');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  ok(await w.locator('.person-row', { hasText: 'Robert' }).count(), 'Enter in the Name field did not save');
  await w.getByRole('button', { name: 'Edit' }).click();
  await page.keyboard.press('Escape');
  ok(await w.getByRole('button', { name: 'Edit' }).count(), 'Escape did not leave the form');
  // Ctrl+S saves from a many-line box too.
  await w.getByRole('button', { name: 'Edit' }).click();
  await w.getByLabel('Notes').fill('keyed save');
  await page.keyboard.press('Control+s');
  await w.locator('.person-facts', { hasText: 'keyed save' }).waitFor({ timeout: 3000 });
  // Escape with something typed asks first; Keep editing keeps the typing.
  await w.getByRole('button', { name: 'Edit' }).click();
  await w.getByLabel('Notes').fill('not yet saved');
  await page.keyboard.press('Escape');
  const ask = page.locator('.dialog');
  await ask.waitFor({ timeout: 3000 });
  await ask.getByRole('button', { name: 'Keep editing' }).click();
  ok((await w.getByLabel('Notes').inputValue()) === 'not yet saved', 'the typed notes were lost');
});

await browser.close();
console.log(`${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
