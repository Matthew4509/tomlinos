// Second audit (November 2026) of the shell, in a real Chrome: the file store's reads, File Explorer's path box and
// list view, the screensaver Preview, Settings › AI's "Remove my key" and Chat › Agents' "Open a saved thread...".
// Each step that FAILS names a fault; it passes once the fault is fixed. Needs the dev server on a FRESH, EMPTY data
// folder (the first step sets up the owner) and `node tools/build.mjs` done.
//   node test/browser-audit2-shell.mjs [http://127.0.0.1:3751] [screenshot folder]
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3751';
const SHOTS = process.argv[3] ?? null;
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PASS = 'quarry-violet-lantern-63';
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
    console.log('  FAIL ' + name + '\n       ' + String(error.message).slice(0, 900));
  }
  await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
  for (let i = 0; i < 4 && (await page.locator('.dialog').count()); i++) {
    await page.locator('.dialog').last().getByRole('button').last().click({ timeout: 2000 }).catch(() => page.keyboard.press('Escape'));
    await page.waitForTimeout(100);
  }
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
page.on('dialog', d => problems.push('native dialog: ' + d.message()));
const shot = async name => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });
const settle = ms => page.waitForTimeout(ms);
const D = () => page.locator('.dialog').last();
const ew = () => page.locator('.win', { has: page.locator('.explorer') }).first();
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const item = name => ew().locator('.item', { has: page.locator('.item-name', { hasText: new RegExp('^' + esc(name) + '$') }) }).first();
const names = async () => ew().locator('.item-name').allInnerTexts();
async function menuPick(path) {
  for (const label of path) {
    await page.locator('.menu-item').filter({ has: page.locator('.menu-label', { hasText: new RegExp('^' + label + '$') }) }).first().click({ timeout: 8000 });
  }
}
async function typePath(text) {
  await ew().locator('.explorer-view').focus();
  await page.keyboard.press('Control+l');
  const box = ew().locator('input.address');
  await box.fill(text);
  await box.press('Enter');
}
async function newFolder(name) {
  await ew().locator('.explorer-view').focus();
  await page.keyboard.press('ContextMenu');
  await menuPick(['New', 'Folder']);
  const input = ew().locator('input.rename');
  await input.waitFor();
  await input.fill(name);
  await input.press('Enter');
  await item(name).waitFor({ timeout: 8000 });
}
async function viewAs(kind) {
  await ew().locator('.explorer-view').focus();
  await page.keyboard.press('ContextMenu');
  await menuPick(['View', kind]);
  await settle(300);
}
const openApp = async label => {
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill(label);
  await page.locator(`.start-menu [data-label="${label}"]`).first().click();
};
async function closeAll() {
  for (let i = 0; i < 40; i++) {
    if (await page.locator('.dialog').count()) {
      await D().getByRole('button').last().click();
      continue;
    }
    const wins = page.locator('.win');
    if (!(await wins.count())) return;
    await wins.last().locator('.win-close').first().click();
    await settle(80);
  }
}

// A second "device" on the same account: its own file system, for files put in place without the windows.
const dev = {
  write: (path, text) => page.evaluate(async ([p, t]) => {
    const { FileSystem } = await import('/app/fs/fs.js');
    const { ServerStore } = await import('/app/store/server-store.js');
    await new FileSystem(new ServerStore('/api/store.php')).writeFile(p, new TextEncoder().encode(t));
  }, [path, text]),
  list: path => page.evaluate(async p => {
    const { FileSystem } = await import('/app/fs/fs.js');
    const { ServerStore } = await import('/app/store/server-store.js');
    return (await new FileSystem(new ServerStore('/api/store.php')).list(p)).map(e => e.name);
  }, path),
};

console.log('Shell round-2 audit, against ' + BASE);
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

// ---- QN-11: a read answered by something that is not the store ------------------------------------------------------

await step('QN-11 (P1): a file read answered with a 200 HTML page (a captive portal) fails plainly, never opens the page as the file', async () => {
  await dev.write('/Documents/portal.txt', 'the real words');
  await page.route('**/api/store.php?key=*', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Sign in to the Wi-Fi</title>' }));
  const got = await page.evaluate(async () => {
    const { ServerStore } = await import('/app/store/server-store.js');
    try {
      const r = await new ServerStore('/api/store.php').get('/');
      return 'read as bytes: ' + new TextDecoder().decode(r.data).slice(0, 60);
    } catch (e) {
      return 'error: ' + e.message;
    }
  });
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  ok(got.startsWith('error: ') && got.includes('could not be read just now') && !/unencrypted|someone else/.test(got), got);
});

// ---- File Explorer ---------------------------------------------------------------------------------------------------

await step('E-P1-1 (P1): typing Documents\\Letters (backslashes) in the path box opens that folder', async () => {
  await newFolder('Letters');
  await typePath('/');
  await settle(300);
  await typePath('Documents\\Letters');
  await settle(500);
  const dialog = await page.locator('.dialog').count();
  const crumbs = await ew().locator('.crumb').allInnerTexts();
  ok(!dialog && crumbs.slice(-2).join('/') === 'Documents/Letters', `dialog shown=${!!dialog}, path ${JSON.stringify(crumbs)}`);
});

const LONG = 'A very long folder name that goes on and on and on well past any column width you would choose';
await step('E-P1-2 (P1): in the list view a long name ends in "…" and its row\'s tooltip has the whole name', async () => {
  await typePath('/Documents');
  await settle(300);
  await newFolder(LONG);
  await viewAs('List');
  const name = ew().locator('.item-name', { hasText: 'A very long folder' });
  const cut = await name.evaluate(el => ({ over: el.scrollWidth > el.clientWidth, display: getComputedStyle(el).display, overflow: getComputedStyle(el).textOverflow }));
  ok(cut.over, 'the name is long enough to need cutting (window too wide for the test?)');
  eq([cut.display, cut.overflow], ['block', 'ellipsis'], 'the name box draws an ellipsis');
  eq(await item(LONG).getAttribute('title'), LONG, 'tooltip');
  await shot('list-ellipsis');
});

await step('E-P1-3 (P1): the list headings sort: Size, again reverses; folders stay first; Name puts it back', async () => {
  const dir = tempDir('tomlinos-audit2-shell-');
  writeFileSync(join(dir, 'b-small.txt'), 'x');
  writeFileSync(join(dir, 'a-big.txt'), 'x'.repeat(5000));
  writeFileSync(join(dir, 'c-mid.txt'), 'x'.repeat(300));
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 10000 }), ew().getByRole('button', { name: 'Upload' }).click()]);
  await chooser.setFiles(['b-small.txt', 'a-big.txt', 'c-mid.txt'].map(n => join(dir, n)));
  await item('c-mid.txt').waitFor({ timeout: 10000 });
  await settle(400);
  const files = async () => (await names()).filter(n => /^[abc]-.*\.txt$/.test(n));
  const head = label => ew().locator('.fv-head .fv-sort', { hasText: label });
  eq(await files(), ['a-big.txt', 'b-small.txt', 'c-mid.txt'], 'by name at first');
  await head('Size').click();
  await settle(300);
  eq(await files(), ['b-small.txt', 'c-mid.txt', 'a-big.txt'], 'Size: smallest first');
  ok((await head('Size').innerText()).includes('▲'), 'the Size heading shows the sort');
  ok((await names()).indexOf('Letters') < (await names()).indexOf('b-small.txt'), 'folders first: ' + (await names()).join(' | '));
  await head('Size').click();
  await settle(300);
  eq(await files(), ['a-big.txt', 'c-mid.txt', 'b-small.txt'], 'Size again: largest first');
  ok((await head('Size').innerText()).includes('▼'), 'the arrow turns');
  ok((await names()).indexOf('Letters') < (await names()).indexOf('a-big.txt'), 'folders still first when reversed: ' + (await names()).join(' | '));
  await head('Name').click();
  await settle(300);
  eq(await files(), ['a-big.txt', 'b-small.txt', 'c-mid.txt'], 'Name: back to A to Z');
  await viewAs('Icons');
});

// ---- The screensaver Preview -----------------------------------------------------------------------------------------

await step('L8 (P1): in the screensaver Preview, "Close preview" can be clicked once the lock screen shows', async () => {
  await closeAll();
  await openApp('my account');
  const acct = page.locator('.win', { has: page.locator('.account') });
  await acct.locator('.acct-tab', { hasText: 'Screensaver and lock' }).click();
  await acct.getByRole('button', { name: 'Preview', exact: true }).click();
  const layer = page.locator('#layer-lock');
  await layer.locator('.lock-preview-bar').waitFor({ timeout: 10000 });
  // Whatever screensaver is chosen, take its way back to the lock screen.
  await settle(500);
  if (await layer.locator('.fake-sheet').count()) await page.keyboard.press('Escape');
  else if (await layer.locator('.reader-login-link').count()) await layer.locator('.reader-login-link').click();
  else await page.mouse.click(640, 300);
  await layer.locator('.gate, .reader-login').first().waitFor({ timeout: 10000 });
  await shot('preview-lock');
  const close = layer.getByRole('button', { name: 'Close preview' });
  const onTop = await close.evaluate(b => {
    const r = b.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return at === b || b.contains(at);
  });
  ok(onTop, 'something covers the "Close preview" button');
  await close.click({ timeout: 3000 });
  await layer.waitFor({ state: 'hidden', timeout: 5000 });
  await closeAll();
});

// ---- Settings › AI: Remove my key ------------------------------------------------------------------------------------

await step('L18 (P1): "Remove my key" asks first, naming the provider; Cancel removes nothing', async () => {
  // The question itself, from the page's own code (a key needs a stand-in Anthropic, which this run does not start).
  const said = await page.evaluate(async () => {
    const { confirmRemoveKey } = await import('/app/apps/assistant/keytile.js');
    const { DialogLayer } = await import('/app/shell/dialogs.js');
    const host = document.createElement('div');
    document.body.append(host);
    const answer = confirmRemoveKey(new DialogLayer(host), 'OpenRouter');
    await new Promise(r => setTimeout(r, 50));
    const text = host.querySelector('.dialog')?.textContent ?? '';
    [...host.querySelectorAll('.dialog button')].find(b => b.textContent === 'Cancel')?.click();
    const result = await answer;
    host.remove();
    return { text, result };
  });
  ok(said.text.includes('Remove your OpenRouter key?') && said.text.includes('Remove'), 'the question: ' + said.text);
  eq(said.result, false, 'Cancel answers no');
});

// ---- Chat › Agents: Open a saved thread ------------------------------------------------------------------------------

await step('L21 (P1): Chat › Agents opens a thread saved with Save as... (a .md outside AI chats) as a new thread', async () => {
  const saved = [
    '# Pruning the magnolia', '',
    '<!-- TOMLIN OS AI chat. Each message starts with a "### " line; keep those lines as they are. -->', '',
    '### You · 2026-11-20T10:00:00.000Z', '', 'When should I prune the magnolia?', '',
    '### AI (Claude Sonnet 5) · 2026-11-20T10:00:05.000Z', '', 'Late spring, after it flowers.', '',
  ].join('\n');
  await dev.write('/Documents/magnolia copy.md', saved);
  await dev.write('/Documents/shopping.md', '# Shopping\n\n- eggs\n- bread\n');
  await closeAll();
  await openApp('chat');
  const w = page.locator('.win', { has: page.locator('.chat-app') });
  await w.getByRole('tab', { name: 'Agents' }).click();
  const openBtn = w.getByRole('button', { name: 'Open a saved thread...' });
  await openBtn.waitFor();
  // A Markdown file that is not a thread is refused, and nothing changes.
  await openBtn.click();
  await D().getByText('shopping.md', { exact: true }).first().dblclick();
  await page.locator('.dialog', { hasText: 'Not a saved thread' }).waitFor({ timeout: 5000 });
  await D().getByRole('button', { name: 'OK' }).click();
  await openBtn.click();
  await D().getByText('magnolia copy.md', { exact: true }).first().dblclick();
  await w.locator('.agent-pane .chat-msg', { hasText: 'Late spring, after it flowers.' }).waitFor({ timeout: 8000 });
  eq(await w.locator('.agent-pane .chat-msg').count(), 2, 'both messages');
  await settle(500);
  const kept = await dev.list('/Documents/AI chats');
  ok(kept.some(n => /^Pruning the magnolia/.test(n)), 'kept in AI chats as a new thread: ' + JSON.stringify(kept));
  ok((await dev.list('/Documents')).includes('magnolia copy.md'), 'the file opened is left where it was');
  await closeAll();
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (problems.length) console.log('page problems:\n  ' + problems.slice(0, 10).join('\n  '));
await browser.close();
process.exit(failures.length ? 1 : 0);
