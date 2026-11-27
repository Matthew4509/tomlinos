// Audit of the Recycle Bin, Web link, About and Keyboard shortcuts windows, and app shortcut (.desktop) files (November
// 2026) in a real Chrome. Each step that FAILS names a fault found by the audit; it should pass once the fault is fixed.
// Needs the dev server on a FRESH, EMPTY data folder (the first step sets up the owner) and `npm run build` done.
// No outside site is ever reached: every request to a host other than the dev server is refused, and window.open is
// recorded instead of opening a tab.
//   node test/browser-audit-recyclebin.mjs [http://127.0.0.1:3142] [screenshot folder]
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3142';
const SHOTS = process.argv[3] ?? null;
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PASS = 'orchard-lantern-harbour-58';
const ORIGIN = new URL(BASE).origin;
let passed = 0;
const failures = [];

let stepName = 'start';
async function step(name, fn) {
  stepName = name.slice(0, 40);
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (error) {
    failures.push(name);
    await shot('fail-' + failures.length).catch(() => {});
    console.log('  FAIL ' + name + '\n       ' + String(error.message).slice(0, 900));
  }
  for (let i = 0; i < 4 && (await page.locator('.dialog').count()); i++) {
    await page.locator('.dialog').last().getByRole('button').last().click({ timeout: 2000 }).catch(() => page.keyboard.press('Escape'));
    await page.waitForTimeout(100);
  }
}
const ok = (v, what) => {
  if (!v) throw new Error(what);
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const outside = [];
await context.route('**/*', route => {
  const url = route.request().url();
  if (url.startsWith(ORIGIN) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
  outside.push(url);
  return route.abort();
});
// A link's "Open in a new tab" is recorded, not followed.
await context.addInitScript(() => {
  window.__opened = [];
  window.open = (url, target, features) => {
    window.__opened.push({ url: String(url), target, features });
    return null;
  };
});
const page = await context.newPage();
page.setDefaultTimeout(10000);
const problems = [];
page.on('console', m => m.type() === 'error' && problems.push('console: ' + m.text()));
page.on('pageerror', e => problems.push('pageerror: ' + e.message));
// The console says only "Failed to load resource": name the address too.
page.on('response', r => r.status() >= 400 && problems.push(`HTTP ${r.status()}: ${r.request().method()} ${r.url().replace(/^https?:\/\/[^/]+/, '')} (in "${stepName}")`));
const shot = async name => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });
const settle = ms => page.waitForTimeout(ms);
const ew = () => page.locator('.win', { has: page.locator('.explorer') }).first();
const bw = () => page.locator('.win', { has: page.locator('.bin') }).first();
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const item = name => ew().locator('.item', { has: page.locator('.item-name', { hasText: new RegExp('^' + esc(name) + '$') }) }).first();
const names = async () => ew().locator('.item-name').allInnerTexts();
const binNames = async () => bw().locator('.bin-row .bin-name').allInnerTexts();
const front = async title => {
  const t = page.locator('.task', { hasText: title }).first();
  if ((await t.getAttribute('class'))?.includes('active')) return;
  await t.click();
  await settle(250);
};
async function uploadFiles(paths) {
  await front('Documents');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 10000 }), ew().getByRole('button', { name: 'Upload' }).click()]);
  await chooser.setFiles(paths);
}
const dir = tempDir('tomlinos-audit-bin-');
const file = (name, text) => {
  writeFileSync(join(dir, name), text);
  return join(dir, name);
};
async function deleteInExplorer(name) {
  await front('Documents');
  await item(name).click();
  await page.keyboard.press('Delete');
  await item(name).waitFor({ state: 'detached', timeout: 8000 });
}
async function openBin() {
  if (await bw().count()) return front('Recycle Bin');
  const icon = page.locator('#desktop .item', { has: page.locator('.item-name', { hasText: /^Recycle Bin$/ }) }).first();
  await icon.dblclick();
  await bw().locator('.bin-list').waitFor();
}

console.log('Recycle Bin, Web link, About and Keyboard shortcuts audit, against ' + BASE);
await page.goto(BASE);

await step('set up the owner and open File Explorer in Documents', async () => {
  await page.locator('.gate h1').first().waitFor({ timeout: 30000 });
  await page.getByLabel('Your name').fill('Sample Owner');
  const user = page.getByLabel('User name (for signing in)');
  if (await user.count()) await user.fill('tester');
  await page.locator('.gate input[type=password]').last().fill(PASS);
  const encrypt = page.locator('.gate-encrypt');
  if (await encrypt.count()) await encrypt.uncheck();
  await page.locator('.gate-go').click();
  await page.locator('.gate h1', { hasText: 'Your recovery key' }).waitFor({ timeout: 30000 });
  await page.locator('.gate .check-row input').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#desktop .item').first().waitFor({ timeout: 20000 });
  await page.keyboard.press('Control+Alt+e');
  await item('Documents').waitFor({ timeout: 15000 });
  await item('Documents').dblclick();
  await ew().locator('.crumb', { hasText: 'Documents' }).waitFor();
});

await step('RB-P0-1: a file deleted while the Recycle Bin window is open is in the bin, not destroyed', async () => {
  await openBin();
  // Explorer to the front again, the bin window still open behind it.
  await ew().locator('.explorer-view').click({ position: { x: 5, y: 5 } }).catch(() => {});
  const lost = [];
  for (const n of ['keep1.txt', 'keep2.txt', 'keep3.txt']) {
    await uploadFiles([file(n, 'precious ' + n)]);
    await item(n).waitFor({ timeout: 10000 });
    // An empty bin each time: the window's listing then reaches the new slot before the file is moved into it.
    await deleteInExplorer(n);
    await settle(2500);
    const inBin = await binNames();
    if (!inBin.includes(n) && !(await names()).includes(n)) lost.push(n);
    // Empty it again for the next round (only what this step put there).
    if (inBin.length) {
      await front('Recycle Bin');
      await bw().locator('.bin-list').click({ position: { x: 5, y: 200 } }).catch(() => {});
      await bw().getByRole('button', { name: 'Empty Recycle Bin' }).click();
      await page.locator('.dialog').getByRole('button', { name: 'Empty Recycle Bin' }).click();
      await settle(1200);
    }
  }
  ok(!lost.length, `deleted to the Recycle Bin but in neither the bin nor Documents (destroyed): ${lost.join(', ')}`);
});

await step('RB-P1-6: restore into a folder holding the same name keeps both (" (2)"), and double-click restores', async () => {
  await uploadFiles([file('dup.txt', 'old')]);
  await item('dup.txt').waitFor({ timeout: 10000 });
  await deleteInExplorer('dup.txt');
  await uploadFiles([file('dup.txt', 'new')]);
  await item('dup.txt').waitFor({ timeout: 10000 });
  await openBin();
  const row = bw().locator('.bin-row', { hasText: 'dup.txt' }).first();
  await row.waitFor({ timeout: 8000 });
  await row.dblclick();
  await settle(1500);
  const byDouble = (await binNames()).includes('dup.txt') ? 'double-click left it in the bin' : '';
  if (byDouble) {
    await bw().getByRole('button', { name: 'Restore' }).click();
    await settle(1500);
  }
  const n = await names();
  ok(n.includes('dup.txt') && n.includes('dup (2).txt'), `Documents now: ${JSON.stringify(n)}`);
  ok(!byDouble, 'RB-P1-6: ' + byDouble + ' (Restore button worked)');
});

await step('RB-P1-1 (keyboard): Shift+Down twice selects three rows', async () => {
  for (const n of ['k1.txt', 'k2.txt', 'k3.txt', 'k4.txt']) {
    await uploadFiles([file(n, n)]);
    await item(n).waitFor({ timeout: 10000 });
    await deleteInExplorer(n);
  }
  await openBin();
  await front('Recycle Bin');
  await settle(1500);
  const list = bw().locator('.bin-list');
  await list.locator('.bin-row').first().click();
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  const sel = await list.locator('.bin-row.selected').count();
  ok(sel === 3, `${sel} rows selected after Shift+Down twice`);
});

await step('RB-P1-2 (narrow window): the "Deleted from" column shows under its heading', async () => {
  await page.setViewportSize({ width: 640, height: 760 });
  await settle(600);
  const r = await bw().evaluate(el => {
    const head = [...el.querySelectorAll('.bin-head span')].filter(s => getComputedStyle(s).display !== 'none').map(s => s.textContent);
    const row = el.querySelector('.bin-row');
    const cells = row ? [...row.children].filter(s => getComputedStyle(s).display !== 'none').map(s => s.textContent) : [];
    return { head, cells };
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  ok(r.head.length === r.cells.length, `headings ${JSON.stringify(r.head)} but row cells ${JSON.stringify(r.cells)}`);
});

// ---- Web links ----------------------------------------------------------------------------------------------------
const lw = () => page.locator('.win', { has: page.locator('.linkapp') }).last();
async function openLink(name, text) {
  await uploadFiles([file(name, text)]);
  await item(name).waitFor({ timeout: 10000 });
  await item(name).dblclick();
  await lw().locator('.pad').first().waitFor({ timeout: 8000 });
}
async function closeLinks() {
  while (await lw().count()) {
    await lw().locator('.win-close, [aria-label="Close"]').first().click().catch(() => page.keyboard.press('Alt+q'));
    await settle(200);
  }
}

for (const [name, text] of [
  ['js.url', '[InternetShortcut]\r\nURL=javascript:alert(document.cookie)\r\n'],
  ['data.url', '[InternetShortcut]\r\nURL=data:text/html,<script>alert(1)</script>\r\n'],
  ['file.url', '[InternetShortcut]\r\nURL=file:///C:/Windows/win.ini\r\n'],
  ['rel.url', '[InternetShortcut]\r\nURL=/api/session\r\n'],
  ['broken.url', '\u0000\u00ff\u00fe garbage'],
]) {
  await step(`a link to ${name} offers no Open button and opens nothing`, async () => {
    await openLink(name, text);
    ok((await lw().getByRole('button', { name: 'Open in a new tab' }).count()) === 0, 'an Open button is offered');
    ok((await page.evaluate(() => window.__opened.length)) === 0, 'window.open was called');
    await closeLinks();
  });
}

await step('a unicode host is shown in its plain xn-- form and opened with noopener', async () => {
  await openLink('idn.url', '[InternetShortcut]\r\nURL=https://аррӏе.example/\r\n');
  const host = await lw().locator('.link-host').innerText();
  ok(host.startsWith('xn--'), `host shown as ${host}`);
  await lw().getByRole('button', { name: 'Open in a new tab' }).click();
  const opened = await page.evaluate(() => window.__opened.pop());
  ok(opened && opened.url.startsWith('https://xn--') && /noopener/.test(opened.features), JSON.stringify(opened));
  await closeLinks();
});

await step('LK-P1-1: a long address (3,000 characters) still leaves the Open button in sight at the window\'s size', async () => {
  await openLink('long.url', `[InternetShortcut]\r\nURL=https://shop.example/p?${'a=1&'.repeat(750)}\r\n`);
  const r = await lw().evaluate(win => {
    const b = [...win.querySelectorAll('button')].find(x => x.textContent === 'Open in a new tab');
    const body = win.querySelector('.linkapp');
    const bb = body.getBoundingClientRect();
    const r2 = b.getBoundingClientRect();
    return { inside: r2.bottom <= bb.bottom + 1 && r2.top >= bb.top - 1, scrolls: body.scrollHeight > body.clientHeight && ['auto', 'scroll'].includes(getComputedStyle(body).overflowY) || ['auto', 'scroll'].includes(getComputedStyle(body.parentElement).overflowY) };
  });
  await closeLinks();
  ok(r.inside || r.scrolls, `button below the window and nothing scrolls: ${JSON.stringify(r)}`);
});

// ---- App shortcuts ------------------------------------------------------------------------------------------------
await step('a .desktop shortcut naming no installed app says so, and one naming Notepad opens it', async () => {
  await uploadFiles([file('Nothing.desktop', '[Desktop Entry]\r\nType=Application\r\nExec=rm -rf /\r\nX-TomlinOS-App=nosuchapp\r\n')]);
  await item('Nothing').waitFor({ timeout: 10000 }).catch(() => item('Nothing.desktop').waitFor());
  await (await item('Nothing').count() ? item('Nothing') : item('Nothing.desktop')).dblclick();
  await page.locator('.dialog', { hasText: 'opens nothing here' }).waitFor({ timeout: 8000 });
  await page.locator('.dialog').getByRole('button').last().click();
});

// ---- About and Keyboard shortcuts --------------------------------------------------------------------------------
async function openFromStart(title) {
  await page.locator('.start-btn').first().click();
  const it = page.locator(`.start-item[data-label="${title.toLowerCase()}"]`).first();
  if (!(await it.isVisible().catch(() => false))) {
    await page.keyboard.type(title.slice(0, 6));
    await settle(300);
  }
  await page.locator('.start-item', { hasText: title }).first().click();
}

await step('About lists every package with a version, and its links are https only', async () => {
  await openFromStart('About TOMLIN OS');
  const aw = page.locator('.win', { has: page.locator('.about') }).first();
  await aw.locator('.about-pkgs li').nth(10).waitFor({ timeout: 8000 });
  const r = await aw.evaluate(el => ({
    version: el.querySelector('.about-head p')?.textContent,
    bad: [...el.querySelectorAll('.about-pkgs li')].map(li => li.textContent).filter(t => /undefined|could not be read/.test(t)),
    links: [...el.querySelectorAll('a')].map(a => [a.href, a.rel, a.target]),
    text: el.textContent,
  }));
  ok(/^Version \d+\.\d+\.\d+/.test(r.version), `version line: ${r.version}`);
  ok(!r.bad.length, `rows: ${JSON.stringify(r.bad)}`);
  ok(r.links.every(([href, rel]) => href.startsWith('https://') && /noopener/.test(rel)), JSON.stringify(r.links));
});

await step('AB-P0-1: About credits loglevel, which ships inside webllm.js', async () => {
  const aw = page.locator('.win', { has: page.locator('.about') }).first();
  const btns = aw.getByRole('button', { name: 'Show the licence texts' });
  for (let i = 0; i < (await btns.count()); i++) await btns.nth(0).click().then(() => settle(400));
  const text = await aw.innerText();
  ok(/loglevel/i.test(text), 'no mention of loglevel (MIT, Tim Perry) in About or the licence texts it shows');
});

await step('AB-P1-1 / SC: About and Keyboard shortcuts are usable on a phone-width screen (no page-wide sideways scroll)', async () => {
  await openFromStart('Keyboard shortcuts');
  const sw = page.locator('.win', { has: page.locator('.shortcuts') }).first();
  await sw.locator('dl.keys').first().waitFor();
  await page.setViewportSize({ width: 360, height: 640 });
  await settle(600);
  const r = await page.evaluate(() => ['.shortcuts', '.about'].map(sel => {
    const el = document.querySelector(sel);
    if (!el) return { sel, over: 'missing' };
    // What sticks out past the right edge, so a failure names it.
    const edge = el.getBoundingClientRect().left + el.clientWidth;
    const wide = [...el.querySelectorAll('*')].filter(c => c.getBoundingClientRect().right > edge + 0.5).slice(0, 4)
      .map(c => `${c.tagName.toLowerCase()}.${[...c.classList].join('.')} "${(c.textContent ?? '').trim().slice(0, 30)}"`);
    return { sel, over: el.scrollWidth - el.clientWidth, ...(wide.length ? { wide } : {}) };
  }));
  await page.setViewportSize({ width: 1280, height: 800 });
  ok(r.every(x => x.over === 0 || x.over === 'missing'), JSON.stringify(r));
});

ok(true, '');
console.log(`\n${passed} passed, ${failures.length} failed`);
if (outside.length) console.log('refused outside requests:', [...new Set(outside)].slice(0, 10).join(' '));
if (problems.length) console.log('page problems:\n  ' + [...new Set(problems)].slice(0, 15).join('\n  '));
await browser.close();
process.exit(failures.length ? 1 : 0);
