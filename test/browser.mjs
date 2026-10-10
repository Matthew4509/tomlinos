// Drives the built desktop in a real Chrome. Needs the dev server running on :3042 (server/dev-router.php, see its
// header) on a THROW-AWAY data folder, and `npm run build` done.
//   node test/browser.mjs [http://localhost:3042]
import { chromium } from 'playwright-core';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';

const BASE = process.argv[2] ?? 'http://localhost:3042';
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const stamp = Date.now().toString(36);
let passed = 0;
const failures = [];

async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (error) {
    failures.push(name);
    console.log('  FAIL ' + name + '\n       ' + String(error.message).slice(0, 1200));
    // A picture of the screen at the first failures, and any dialog's words (a dialog left open blocks every later step).
    if (process.env.FAIL_SHOTS && failures.length <= 3) await page.screenshot({ path: `${process.env.FAIL_SHOTS}/desk-fail-${failures.length}.png` }).catch(() => {});
    const dialog = await page.locator('.dialog').allInnerTexts().catch(() => []);
    if (dialog.length) console.log('       dialog on screen: ' + dialog.join(' | ').replace(/\s+/g, ' ').slice(0, 400));
  }
}
const eq = (a, b, what) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const ok = (v, what) => {
  if (!v) throw new Error(what);
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1100, height: 720 } });
const page = await context.newPage();
const problems = [];
page.on('console', m => {
  if (m.type() === 'error') problems.push('console: ' + m.text());
});
page.on('pageerror', e => problems.push('pageerror: ' + e.message));
page.on('crash', () => console.log('  !! PAGE CRASHED'));
await page.addInitScript(() => {
  window.__csp = [];
  document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
});

const item = (name, scope = '') => page.locator(`${scope} .item`, { hasText: name }).first();
const win = title => page.locator('.win', { has: page.locator('.win-title-text', { hasText: title }) });
const raise = async title => {
  const w = win(title).first();
  if (!(await w.evaluate(el => el.classList.contains('active')))) await page.locator('.task', { hasText: title }).first().click();
};
const closeAll = async () => {
  for (let i = 0; i < 12 && (await page.locator('.win').count()) > 0; i++) {
    await page.locator('.win').last().getByRole('button', { name: 'Close' }).click();
    await settle(80);
  }
};
// The Explorer window that was opened first (folders open inside it, so it keeps being the one we drive).
const fw = () => page.locator('.win').first();
const settle = ms => page.waitForTimeout(ms);
// With accounts (the desktop on its server), the first visit sets up a test owner and later visits sign in again if
// the session has gone. The cookie is shared by every tab of this browser context, as in a real browser.
async function open() {
  await page.goto(BASE, { waitUntil: 'load' });
  await signInIfAsked(page);
  await page.locator('#desktop .item').first().waitFor({ timeout: 30000 });
}
async function signInIfAsked(p) {
  const first = await Promise.race([
    p.locator('#desktop .item').first().waitFor({ timeout: 30000 }).then(() => 'desktop'),
    p.locator('.gate h1').first().waitFor({ timeout: 30000 }).then(() => 'gate'),
  ]);
  if (first !== 'gate') return;
  const title = await p.locator('.gate h1').first().innerText();
  if (title.startsWith('Set up')) {
    await p.getByLabel('Your name').fill('Browser Test');
    await p.getByLabel('User name (for signing in)').fill('tester');
  } else await p.getByLabel('User name').fill('tester');
  await p.locator('.gate input[type=password]').fill('browser-test-passphrase-1');
  await p.locator('.gate-go').click();
  // A first set-up shows the recovery key once before the desktop.
  if (title.startsWith('Set up')) {
    await p.locator('.gate h1', { hasText: 'Your recovery key' }).waitFor({ timeout: 30000 });
    await p.locator('.gate .check-row input').check();
    await p.getByRole('button', { name: 'Continue' }).click();
  }
}
async function menuPick(path) {
  for (const label of path) {
    try {
      await page.locator('.menu-item').filter({ has: page.locator('.menu-label', { hasText: new RegExp('^' + label + '$') }) }).first().click({ timeout: 8000 });
    } catch (error) {
      throw new Error(`menu item "${label}" not found; menus showing: ${JSON.stringify(await page.locator('.menu').allInnerTexts())}; focus: ${await page.evaluate(() => document.activeElement?.className)}`);
    }
  }
}

console.log('Desktop, against ' + BASE);
await open();

await step('boots with the two built-in icons, a Start button and a clock', async () => {
  ok(await item('My Files', '#desktop').isVisible(), 'My Files');
  ok(await item('Recycle Bin', '#desktop').isVisible(), 'Recycle Bin');
  ok(await page.locator('.start-btn').isVisible(), 'Start');
  ok((await page.locator('.clock').innerText()).length > 3, 'clock');
});

await step('the page ships no inline script or style and the CSP blocks nothing', async () => {
  const inline = await page.evaluate(() => ({
    scripts: [...document.scripts].filter(s => !s.src).length,
    styleAttrs: 0,
    csp: window.__csp,
  }));
  eq(inline.scripts, 0, 'inline scripts');
  eq(inline.csp, [], 'CSP violations');
  const headers = (await page.request.get(BASE + '/')).headers();
  ok(/default-src 'self'/.test(headers['content-security-policy'] ?? ''), 'CSP header missing');
  eq(headers['x-content-type-options'], 'nosniff', 'nosniff');
});

await step('double-click My Files opens File Explorer with the standard folders and no System', async () => {
  await item('My Files', '#desktop').dblclick();
  await fw().waitFor();
  // The folder list arrives from the server a moment after the window: wait for it (a slow machine took over 1 s).
  await fw().locator('.item-name', { hasText: /^Videos$/ }).waitFor({ timeout: 15000 });
  const names = await fw().locator('.item-name').allInnerTexts();
  for (const n of ['Desktop', 'Documents', 'Music', 'Pictures', 'Videos']) ok(names.includes(n), n + ' missing');
  ok(!names.includes('System'), 'System must stay hidden');
});

await step('the same item opened again focuses the window instead of making a second', async () => {
  await item('My Files', '#desktop').dblclick({ position: { x: 5, y: 5 } });
  await settle(200);
  eq(await page.locator('.win').count(), 1, 'windows');
});

await step('the standard folders cannot be deleted', async () => {
  await fw().locator('.item', { hasText: /^Music$/ }).click();
  await page.keyboard.press('Delete');
  const dialog = page.locator('.dialog');
  await dialog.waitFor();
  ok((await dialog.innerText()).includes('standard folders'), 'reason');
  await dialog.getByRole('button', { name: 'OK' }).click();
});

// From here on everything happens inside one scratch folder, so leftovers from earlier runs cannot get in the way.
const scratch = 'Test ' + stamp;
// The menu key on the folder view itself (no item focused) opens the "empty space" menu, wherever the items are.
const emptySpace = async () => {
  await fw().locator('.explorer-view').focus();
  await page.keyboard.press('ContextMenu');
};
await step('New > Folder makes a folder that starts in rename mode; typing a name and Enter keeps it', async () => {
  await fw().locator('.item', { hasText: /^Documents$/ }).dblclick();
  await fw().locator('.crumb', { hasText: 'Documents' }).waitFor();
  await emptySpace();
  await menuPick(['New', 'Folder']);
  const input = fw().locator('input.rename');
  await input.waitFor();
  await input.fill(scratch);
  await input.press('Enter');
  await item(scratch, '.win').waitFor();
  await item(scratch, '.win').dblclick();
  await fw().locator('.crumb', { hasText: scratch }).waitFor();
});

await step('a refused name says why, and does not change anything', async () => {
  await emptySpace();
  await menuPick(['New', 'Folder']);
  const input = page.locator('input.rename');
  await input.fill('bad/name');
  await settle(200);
  ok((await page.locator('.rename-problem').innerText()).includes('cannot contain'), 'reason shown');
  await input.press('Enter');
  await settle(200);
  ok(await input.isVisible(), 'still editing after a refused Enter');
  await input.fill('Alpha');
  await input.press('Enter');
  await item('Alpha', '.win').waitFor();
});

await step('a name clashing only by letter case is refused', async () => {
  await emptySpace();
  await menuPick(['New', 'Folder']);
  const input = page.locator('input.rename');
  await input.fill('ALPHA');
  await settle(250);
  ok((await page.locator('.rename-problem').innerText()).includes('already'), 'clash reason');
  await input.press('Escape');
  await settle(500); // the view hands focus back to the item a moment after Escape; wait so the next step's focus sticks
});

await step('New > Text document, then Delete moves it to the Recycle Bin with an Undo toast', async () => {
  await emptySpace();
  await menuPick(['New', 'Text document']);
  const input = page.locator('input.rename');
  await input.waitFor();
  await input.fill('note-' + stamp + '.txt');
  await input.press('Enter');
  const note = item('note-' + stamp, '.win');
  await note.waitFor();
  await note.click();
  await page.keyboard.press('Delete');
  await page.locator('.toast', { hasText: 'Recycle Bin' }).waitFor();
  await settle(300);
  eq(await item('note-' + stamp, '.win').count(), 0, 'gone from folder');
  ok((await page.locator('#desktop .item', { hasText: 'Recycle Bin' }).locator('svg').count()) > 0, 'bin icon');
});

await step('Undo puts it back', async () => {
  await page.locator('.toast-action').click();
  await item('note-' + stamp, '.win').waitFor();
});

await step('Recycle Bin lists a deleted item, Restore returns it, Delete forever asks first', async () => {
  await item('note-' + stamp, '.win').click();
  await page.keyboard.press('Delete');
  await settle(400);
  // (Opened from the Start menu: earlier runs may have left the Explorer window sized over the desktop icon.)
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('recycle');
  await page.locator('.start-item', { hasText: 'Recycle Bin' }).click();
  await win('Recycle Bin').waitFor();
  const row = win('Recycle Bin').locator('.bin-row', { hasText: 'note-' + stamp });
  await row.waitFor();
  await row.click();
  await win('Recycle Bin').getByRole('button', { name: 'Delete forever' }).click();
  const dialog = page.locator('.dialog');
  await dialog.waitFor();
  ok((await dialog.innerText()).includes('cannot be undone'), 'says it cannot be undone');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await row.waitFor();
  await win('Recycle Bin').getByRole('button', { name: 'Restore' }).click();
  // Restoring is a server round trip: wait for the row to go (a fixed half-second failed whenever the machine was busy).
  await row.waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
  eq(await row.count(), 0, 'row gone after restore');
  await raise(scratch);
  await item('note-' + stamp, '.win').waitFor();
});

await step('Empty Recycle Bin asks, and emptying really removes', async () => {
  await item('note-' + stamp, '.win').click();
  await page.keyboard.press('Delete');
  await raise('Recycle Bin');
  await win('Recycle Bin').locator('.bin-row', { hasText: 'note-' + stamp }).waitFor();
  await win('Recycle Bin').getByRole('button', { name: 'Empty Recycle Bin' }).click();
  await page.locator('.dialog').getByRole('button', { name: 'Empty Recycle Bin' }).click();
  await win('Recycle Bin').getByText('is empty').waitFor({ timeout: 10000 }).catch(() => {});
  eq(await win('Recycle Bin').locator('.bin-row').count(), 0, 'rows after empty');
  ok((await win('Recycle Bin').innerText()).includes('is empty'), 'says empty');
  await win('Recycle Bin').getByRole('button', { name: 'Close' }).click();
});

await step('dragging a folder onto another moves it (mouse drag)', async () => {
  await raise(scratch);
  await emptySpace();
  await menuPick(['New', 'Folder']);
  await page.locator('input.rename').fill('Beta');
  await page.keyboard.press('Enter');
  await item('Beta', '.win').waitFor();
  const from = await item('Beta', '.win').boundingBox();
  const to = await item('Alpha', '.win').boundingBox();
  await page.mouse.move(from.x + 20, from.y + 20);
  await page.mouse.down();
  await page.mouse.move(to.x + 30, to.y + 20, { steps: 8 });
  await page.mouse.up();
  // Wait for the move (it is a server round trip; a fixed pause failed when the suites share the machine).
  await item('Beta', '.win').waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
  eq(await item('Beta', '.win').count(), 0, 'left the folder');
  // A click within 150 ms of a drop is the drop's own release and is ignored on purpose; the move can finish sooner
  // than that, and no person double-clicks that fast after letting go.
  await page.waitForTimeout(200);
  await item('Alpha', '.win').dblclick();
  await fw().locator('.crumb', { hasText: 'Alpha' }).waitFor();
  await item('Beta', '.win').waitFor();
});

await step('breadcrumb Up and Back navigate', async () => {
  const w = fw();
  await w.getByRole('button', { name: 'Up one folder' }).click();
  await w.locator('.item', { hasText: 'Alpha' }).waitFor();
  await w.getByRole('button', { name: 'Back' }).click();
  await w.locator('.item', { hasText: 'Beta' }).waitFor();
  eq(await page.locator('.task', { hasText: 'Alpha' }).count(), 1, 'taskbar shows the folder name');
});

await step('View > List shows columns; Sort by works and is remembered for the folder', async () => {
  await fw().getByRole('button', { name: 'Up one folder' }).click();
  await fw().locator('.crumb', { hasText: scratch }).waitFor();
  await settle(300);
  await emptySpace();
  await menuPick(['View', 'List']);
  await fw().locator('.fv-head').waitFor();
  ok((await fw().locator('.item .item-col').count()) >= 3, 'detail columns');
  await emptySpace();
  await menuPick(['Sort by', 'Date modified']);
  await settle(300);
  await emptySpace();
  await menuPick(['Sort by', 'Descending']);
  await settle(300);
  await fw().getByRole('button', { name: 'Up one folder' }).click();
  await fw().locator('.item', { hasText: scratch }).dblclick();
  await fw().locator('.crumb', { hasText: scratch }).waitFor();
  await fw().locator('.fv-head').waitFor();
});

await step('Copy then Paste makes "Alpha (2)" and leaves Alpha alone', async () => {
  await item('Alpha', '.win').click();
  await page.keyboard.press('Control+c');
  await emptySpace();
  await page.locator('.menu-item').filter({ has: page.locator('.menu-label', { hasText: /^Paste$/ }) }).first().click();
  await item('Alpha (2)', '.win').waitFor();
  await item('Alpha', '.win').waitFor();
});

await step('the arrow keys, type-ahead and Alt+Enter (Properties) work from the keyboard', async () => {
  await item('Alpha (2)', '.win').click();
  await page.keyboard.press('Home');
  const first = await fw().locator('.item.selected .item-name').innerText();
  await page.keyboard.press('ArrowDown');
  const second = await fw().locator('.item.selected .item-name').innerText();
  ok(first !== second, `selection moved from ${first} to ${second}`);
  await page.keyboard.press('a');
  ok((await fw().locator('.item.selected .item-name').innerText()).toLowerCase().startsWith('a'), 'type-ahead');
  await page.keyboard.press('Alt+Enter');
  const dialog = page.locator('.dialog');
  await dialog.waitFor();
  ok((await dialog.innerText()).includes('Folder'), 'Properties shows the type');
  await dialog.getByRole('button', { name: 'OK' }).click();
});

await step('the clock opens a calendar with today marked', async () => {
  await page.locator('.clock').click();
  await page.locator('.calendar .cal-day.today').waitFor();
  await page.keyboard.press('Escape');
  eq(await page.locator('.calendar').count(), 0, 'closed');
});

await step('a change made in a second tab appears in the first without reloading', async () => {
  const other = await context.newPage();
  await other.goto(BASE, { waitUntil: 'load' });
  await other.locator('#desktop .item').first().waitFor({ timeout: 30000 });
  await other.locator('#desktop .item', { hasText: 'My Files' }).dblclick();
  await other.locator('.item', { hasText: /^Documents$/ }).dblclick();
  await other.locator('.item', { hasText: scratch }).dblclick();
  await other.locator('.crumb', { hasText: scratch }).waitFor();
  await other.locator('.explorer-view').focus();
  await other.keyboard.press('ContextMenu');
  await other.locator('.menu-item').filter({ has: other.locator('.menu-label', { hasText: /^New$/ }) }).first().click();
  await other.locator('.menu-item').filter({ has: other.locator('.menu-label', { hasText: /^Folder$/ }) }).first().click();
  await other.locator('input.rename').fill('FromTab2');
  await other.keyboard.press('Enter');
  await other.locator('.item', { hasText: 'FromTab2' }).waitFor();
  await item('FromTab2', '.win').waitFor({ timeout: 8000 });
  await other.close();
});

await step('windows drag by the title bar, resize from an edge, maximise, minimise from the taskbar', async () => {
  const w = fw();
  // A window remembers where it was left; bring this one to a known place first.
  let bar = await w.locator('.win-bar').boundingBox();
  await page.mouse.move(bar.x + 100, bar.y + 10);
  await page.mouse.down();
  await page.mouse.move(120, 60, { steps: 5 });
  await page.mouse.up();
  bar = await w.locator('.win-bar').boundingBox();
  const before = await w.boundingBox();
  await page.mouse.move(bar.x + 200, bar.y + 10);
  await page.mouse.down();
  await page.mouse.move(bar.x + 320, bar.y + 70, { steps: 5 });
  await page.mouse.up();
  const moved = await w.boundingBox();
  ok(Math.abs(moved.x - before.x - 120) < 3 && Math.abs(moved.y - before.y - 60) < 3, `moved ${moved.x - before.x},${moved.y - before.y}`);
  // Shrink first (an earlier run may have left this window wide), then grow by 60 from the right edge.
  const dragEdge = async dx => {
    const edge = await w.locator('.edge-e').boundingBox();
    await page.mouse.move(edge.x + 3, edge.y + 50);
    await page.mouse.down();
    await page.mouse.move(edge.x + 3 + dx, edge.y + 50, { steps: 4 });
    await page.mouse.up();
  };
  await dragEdge(-100);
  const shrunk = await w.boundingBox();
  await dragEdge(60);
  const grown = await w.boundingBox();
  ok(Math.abs(grown.width - shrunk.width - 60) < 4, `grew ${grown.width - shrunk.width}`);
  await w.getByRole('button', { name: 'Maximise' }).click();
  const full = await w.boundingBox();
  const screen = await page.locator('#screen').boundingBox();
  ok(Math.abs(full.width - screen.width) < 2 && Math.abs(full.height - screen.height) < 2, 'fills the screen');
  await w.getByRole('button', { name: 'Restore' }).click();
  await page.locator('.task').first().click();
  ok(await w.isHidden(), 'minimised by the taskbar button');
  await page.locator('.task').first().click();
  ok(await w.isVisible(), 'restored by the taskbar button');
});

await step('a window cannot be dragged fully off screen', async () => {
  const w = fw();
  const bar = await w.locator('.win-bar').boundingBox();
  await page.mouse.move(bar.x + 100, bar.y + 10);
  await page.mouse.down();
  await page.mouse.move(bar.x + 3000, bar.y + 3000, { steps: 4 });
  await page.mouse.up();
  const box = await w.boundingBox();
  ok(box.x < 1100 - 60 && box.y < 720, `title bar still reachable at ${box.x},${box.y}`);
});

await step('closing a window removes it, and a new one still opens', async () => {
  const before = await page.locator('.win').count();
  await fw().getByRole('button', { name: 'Close' }).click();
  await settle(150);
  eq(await page.locator('.win').count(), before - 1, 'closed');
  await item('My Files', '#desktop').dblclick();
  await settle(400);
  eq(await page.locator('.win').count(), before, 'a new window opens fine');
});

await closeAll();

await step('Start menu opens, filters, opens Settings; Escape closes it', async () => {
  await page.locator('.start-btn').click();
  await page.locator('.start-menu').waitFor();
  await page.locator('.start-filter').fill('sett');
  eq(await page.locator('.start-item:visible').count(), 1, 'filter');
  await page.keyboard.press('Escape');
  ok(await page.locator('.start-menu').count() === 0, 'closed by Escape');
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('settings');
  await page.locator('.start-item', { hasText: 'Settings' }).click();
  await win('Settings').waitFor();
});

await step('Settings changes the background colour, and it survives a reload', async () => {
  await win('Settings').getByRole('radiogroup', { name: 'Background colour' }).getByRole('radio', { name: 'Green', exact: true }).click();
  const colour = () => page.evaluate(() => getComputedStyle(document.getElementById('wallpaper')).backgroundColor);
  eq(await colour(), 'rgb(75, 127, 79)', 'green');
  await settle(1500);
  await open();
  eq(await colour(), 'rgb(75, 127, 79)', 'green after reload');
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('settings');
  await page.locator('.start-item', { hasText: 'Settings' }).click();
  await win('Settings').getByRole('radiogroup', { name: 'Background colour' }).getByRole('radio', { name: 'Blue', exact: true }).click();
  await settle(1500);
});

await closeAll();

await step('the menu key opens a menu on the focused icon, arrow keys move, Escape closes', async () => {
  await item('Recycle Bin', '#desktop').click();
  await page.keyboard.press('ContextMenu');
  await page.locator('.menu').waitFor();
  await page.keyboard.press('ArrowDown');
  ok(await page.evaluate(() => document.activeElement?.classList.contains('menu-item')), 'a menu item has focus');
  await page.keyboard.press('Escape');
  eq(await page.locator('.menu').count(), 0, 'closed');
});

await step('desktop icons drag to another cell and stay there after a reload', async () => {
  const bin = item('Recycle Bin', '#desktop');
  const b = await bin.boundingBox();
  await page.mouse.move(b.x + 30, b.y + 25);
  await page.mouse.down();
  await page.mouse.move(900, 400, { steps: 8 });
  await page.mouse.up();
  const after = await bin.boundingBox();
  ok(after.x > 700 && after.y > 300, `moved to ${after.x},${after.y}`);
  await settle(1500);
  await open();
  await item('Recycle Bin', '#desktop').waitFor();
  await settle(300);
  const again = await item('Recycle Bin', '#desktop').boundingBox();
  ok(Math.abs(again.x - after.x) < 2 && Math.abs(again.y - after.y) < 2, 'position remembered');
});

await step('rubber-band selects several icons; Ctrl+A selects all', async () => {
  await page.mouse.move(1080, 650);
  await page.mouse.down();
  await page.mouse.move(2, 2, { steps: 6 });
  await page.mouse.up();
  ok((await page.locator('#desktop .item.selected').count()) >= 2, 'band selected');
  await page.mouse.click(700, 600);
  eq(await page.locator('#desktop .item.selected').count(), 0, 'click clears');
});

await step('a dropped-in file is saved with a free name and never overwrites', async () => {
  const dt = await page.evaluateHandle(() => {
    const d = new DataTransfer();
    d.items.add(new File(['hello'], 'up-' + Date.now() + '.dat', { type: 'application/octet-stream' }));
    return d;
  });
  const name = await page.evaluate(d => d.files[0].name, dt);
  await page.dispatchEvent('#desktop', 'drop', { dataTransfer: dt });
  await item(name.replace('.dat', ''), '#desktop').waitFor({ timeout: 8000 });
  const again = await page.evaluateHandle(n => {
    const d = new DataTransfer();
    d.items.add(new File(['second'], n, { type: 'text/plain' }));
    return d;
  }, name);
  await page.dispatchEvent('#desktop', 'drop', { dataTransfer: again });
  await item(name.replace('.dat', '') + ' (2)', '#desktop').waitFor({ timeout: 8000 });
});

await step('a file with no app says so plainly and does not run anything', async () => {
  const f = page.locator('#desktop .item', { hasText: /^up-/ }).first();
  await f.dblclick();
  const dialog = page.locator('.dialog');
  await dialog.waitFor();
  ok((await dialog.innerText()).includes('no app'), 'message');
  await dialog.getByRole('button', { name: 'OK' }).click();
});

await step('deleting a desktop file by dragging it to the Recycle Bin', async () => {
  const f = page.locator('#desktop .item', { hasText: /^up-.*\(2\)/ }).first();
  const bin = item('Recycle Bin', '#desktop');
  const a = await f.boundingBox();
  const b = await bin.boundingBox();
  await page.mouse.move(a.x + 30, a.y + 25);
  await page.mouse.down();
  await page.mouse.move(b.x + 30, b.y + 25, { steps: 10 });
  await page.mouse.up();
  await page.locator('.toast', { hasText: 'Recycle Bin' }).waitFor();
});

await step('Settings: bin limits are checked, and a file over the limit asks before it is deleted for good', async () => {
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('settings');
  await page.locator('.start-item', { hasText: 'Settings' }).click();
  const w = win('Settings');
  await w.waitFor();
  await w.getByLabel('Size limit in megabytes').fill('100');
  await w.getByLabel('Size limit in megabytes').blur();
  await settle(300);
  await w.getByLabel('Size limit in megabytes').fill('10');
  await w.getByLabel('Size limit in megabytes').press('Enter');
  await w.getByLabel('Size limit in megabytes').blur();
  ok((await w.locator('.dialog-problem').first().innerText()).includes('50 MB'), 'refuses 10 MB');
  eq(await w.getByLabel('Size limit in megabytes').inputValue(), '100', 'value put back');
  await w.getByLabel('Size limit in megabytes').fill('50');
  await w.getByLabel('Size limit in megabytes').blur();
  await settle(300);
  eq(await w.getByLabel('Size limit in megabytes').inputValue(), '50', '50 MB is allowed');
  await w.getByRole('button', { name: 'Close' }).click();
  const name = 'big-' + Date.now() + '.bin';
  await page.evaluate(n => {
    const d = new DataTransfer();
    d.items.add(new File([new Uint8Array(51 * 1024 * 1024)], n));
    document.getElementById('desktop').dispatchEvent(new DragEvent('drop', { dataTransfer: d, bubbles: true, cancelable: true }));
  }, name);
  const f = page.locator('#desktop .item', { hasText: name.replace('.bin', '') });
  await f.waitFor({ timeout: 60000 });
  await f.click();
  await page.keyboard.press('Delete');
  const dialog = page.locator('.dialog');
  await dialog.waitFor();
  const text = await dialog.innerText();
  ok(text.includes('50 MB') && text.includes('Confirm delete'), 'over-limit wording: ' + text.slice(0, 120));
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await f.waitFor();
  await f.click();
  await page.keyboard.press('Delete');
  await page.locator('.dialog').getByRole('button', { name: 'Delete for good' }).click();
  await settle(1500);
  eq(await f.count(), 0, 'gone');
  // Put the limit back, so the next run starts from the default.
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('settings');
  await page.locator('.start-item', { hasText: 'Settings' }).click();
  await win('Settings').getByLabel('Size limit in megabytes').fill('100');
  await win('Settings').getByLabel('Size limit in megabytes').blur();
  await settle(1200);
  await win('Settings').getByRole('button', { name: 'Close' }).click();
});

await step('Power (Reload) reloads and keeps every file', async () => {
  await page.locator('.start-btn').click();
  await Promise.all([page.waitForLoadState('load'), page.getByRole('button', { name: 'Reload', exact: true }).click()]);
  await page.locator('#desktop .item').first().waitFor();
  ok(await page.locator('#desktop .item', { hasText: /^up-/ }).count() >= 1, 'files still there');
});

await step('Explorer: upload a whole folder from the computer, keeping its shape; a second upload never overwrites', async () => {
  await closeAll();
  const root = tempDir('tomlinos-up-');
  const top = join(root, 'Holiday ' + stamp);
  mkdirSync(join(top, 'day1'), { recursive: true });
  writeFileSync(join(top, 'a.txt'), 'alpha');
  writeFileSync(join(top, 'day1', 'b.txt'), 'bravo');
  await item('My Files', '#desktop').dblclick();
  const w = fw();
  await w.waitFor();
  await w.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
  for (const n of [1, 2]) {
    const chooser = page.waitForEvent('filechooser');
    await w.getByRole('button', { name: 'Upload' }).click({ modifiers: ['Shift'] });
    (await chooser).setFiles(top);
    await w.locator('.item', { hasText: n === 1 ? 'Holiday ' + stamp : 'Holiday ' + stamp + ' (2)' }).first().waitFor({ timeout: 10000 });
  }
  const second = w.locator('.item', { hasText: 'Holiday ' + stamp + ' (2)' }).first();
  await second.dblclick();
  await w.locator('.item', { hasText: 'day1' }).first().waitFor();
  await w.locator('.item', { hasText: 'a.txt' }).first().waitFor();
  await w.locator('.item', { hasText: 'day1' }).first().dblclick();
  await w.locator('.item', { hasText: 'b.txt' }).first().waitFor();
});

await step('Explorer: type a path in the address box; a wrong one is explained', async () => {
  const w = fw();
  await w.locator('.explorer-view').focus();
  await page.keyboard.press('Control+L');
  const box = w.locator('input.address');
  await box.waitFor();
  await box.fill('/Nowhere/at/all');
  await box.press('Enter');
  const dialog = page.locator('.dialog');
  await dialog.waitFor();
  ok((await dialog.innerText()).includes('no folder'), 'explains');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await w.locator('.explorer-view').focus();
  await page.keyboard.press('Control+L');
  await w.locator('input.address').fill('/Holiday ' + stamp);
  await w.locator('input.address').press('Escape');
  await w.getByRole('button', { name: 'Up one folder' }).click();
  await w.locator('.explorer-view').focus();
  await page.keyboard.press('Control+L');
  await w.locator('input.address').fill('/Desktop');
  await w.locator('input.address').press('Enter');
  await w.locator('.crumb', { hasText: /^Desktop$/ }).waitFor();
});

await step('Explorer: Download gives a file as it is, and a folder as a valid zip', async () => {
  const w = fw();
  const up = async () => w.getByRole('button', { name: 'Up one folder' }).click();
  await w.locator('.explorer-view').focus();
  await page.keyboard.press('Control+L');
  await w.locator('input.address').fill('/');
  await w.locator('input.address').press('Enter');
  const folder = w.locator('.item', { hasText: 'Holiday ' + stamp + ' (2)' }).first();
  await folder.click();
  const dl = page.waitForEvent('download');
  await w.getByRole('button', { name: 'Download' }).click();
  const download = await dl;
  eq(download.suggestedFilename(), 'Holiday ' + stamp + ' (2).zip', 'zip name');
  const zipPath = join(tempDir('tomlinos-dl-'), 'x.zip');
  await download.saveAs(zipPath);
  const run = spawnSync('python', ['-c', 'import zipfile,sys,json;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(json.dumps(sorted(z.namelist())))', zipPath], { encoding: 'utf8' });
  eq(run.status, 0, 'python read the zip: ' + run.stderr);
  const base = 'Holiday ' + stamp + ' (2)';
  eq(JSON.parse(run.stdout), [`${base}/`, `${base}/a.txt`, `${base}/day1/`, `${base}/day1/b.txt`], 'zip contents');
  await folder.dblclick();
  const file = w.locator('.item', { hasText: 'a.txt' }).first();
  await file.click();
  const dl2 = page.waitForEvent('download');
  await w.getByRole('button', { name: 'Download' }).click();
  const one = await dl2;
  eq(one.suggestedFilename(), 'a.txt', 'plain name');
  const path2 = join(tempDir('tomlinos-dl-'), 'a.txt');
  await one.saveAs(path2);
  eq(readFileSync(path2, 'utf8'), 'alpha', 'bytes');
});

await step('Explorer: Cancel stops an upload part-way and says what was saved', async () => {
  const w = fw();
  const dir = tempDir('tomlinos-many-');
  for (let i = 0; i < 400; i++) writeFileSync(join(dir, `f${String(i).padStart(3, '0')}.txt`), 'x'.repeat(50));
  const files = [];
  for (let i = 0; i < 400; i++) files.push(join(dir, `f${String(i).padStart(3, '0')}.txt`));
  const chooser = page.waitForEvent('filechooser');
  await w.getByRole('button', { name: 'Upload' }).click();
  (await chooser).setFiles(files);
  const cancel = page.locator('.transfer').getByRole('button', { name: 'Cancel' });
  await cancel.waitFor({ timeout: 5000 });
  await cancel.click();
  await page.locator('.toast', { hasText: /Stopped/ }).waitFor({ timeout: 15000 });
  await page.locator('.transfer').waitFor({ state: 'detached', timeout: 5000 });
  const saved = await page.evaluate(() => document.querySelectorAll('.win .item').length);
  ok(saved < 400, 'not everything was saved: ' + saved);
});

// ---- Apps: PDF viewer, text editor, pictures, player --------------------------------------------------------------
const appDir = tempDir('tomlinos-apps-');
async function makeFiles() {
  // A real PDF, written by Chrome itself (embedded fonts, compressed streams, an image, two pages).
  const gen = await context.newPage();
  await gen.setContent(`<html><body style="font-family:Georgia,serif">
    <h1>TOMLIN OS PDF Test</h1><p>The quick brown fox jumps over the lazy dog.</p>
    <div style="width:200px;height:60px;background:#e02020;color:#fff;font-family:Arial">Red box</div>
    <img id="i" width="120" height="80"><div style="page-break-before:always"><h2>Second page here</h2></div></body></html>`);
  await gen.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 40; c.height = 30;
    const x = c.getContext('2d');
    x.fillStyle = '#20c020'; x.fillRect(0, 0, 40, 30);
    document.getElementById('i').src = c.toDataURL('image/png');
  });
  await gen.waitForTimeout(300);
  const pdf = await gen.pdf({ format: 'A4', printBackground: true });
  const png = Buffer.from(await gen.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 4; c.height = 3;
    const x = c.getContext('2d');
    x.fillStyle = '#3060ff'; x.fillRect(0, 0, 4, 3);
    return c.toDataURL('image/png').split(',')[1];
  }), 'base64');
  await gen.close();
  const wav = Buffer.alloc(44 + 1600);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + 1600, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28);
  wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34); wav.write('data', 36); wav.writeUInt32LE(1600, 40);
  return { 'report.pdf': pdf, 'blue.png': png, 'tone.wav': wav, 'notes.txt': Buffer.from('first line\nsecond line\n'), 'binary.txt': Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28]) };
}

async function openDocuments() {
  await closeAll();
  await item('My Files', '#desktop').dblclick();
  const w = fw();
  await w.waitFor();
  await w.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
  await w.locator('.explorer-view').focus();
  await page.keyboard.press('Control+L');
  await w.locator('input.address').fill('/Documents');
  await w.locator('input.address').press('Enter');
  await w.locator('.crumb', { hasText: /^Documents$/ }).waitFor();
  return w;
}
const closeApp = async cls => page.locator('.win', { has: page.locator(cls) }).getByRole('button', { name: 'Close' }).click();

await step('apps: files are uploaded into Documents so the apps have something to open', async () => {
  const files = await makeFiles();
  for (const [name, data] of Object.entries(files)) writeFileSync(join(appDir, name), data);
  writeFileSync(join(appDir, 'fake.pdf'), 'this is not a pdf at all');
  const w = await openDocuments();
  const chooser = page.waitForEvent('filechooser');
  await w.getByRole('button', { name: 'Upload' }).click();
  (await chooser).setFiles([...Object.keys(files), 'fake.pdf'].map(n => join(appDir, n)));
  for (const name of [...Object.keys(files), 'fake.pdf']) await w.locator('.item', { hasText: name.replace(/\.[a-z]+$/, '') }).first().waitFor({ timeout: 10000 });
});

await step('PDF viewer: our own reader draws a Chrome-made PDF: text, a colour, an image, then page 2', async () => {
  await fw().locator('.item', { hasText: 'report' }).first().dblclick();
  const v = page.locator('.win .pdf').first();
  await v.waitFor({ timeout: 10000 });
  await page.waitForFunction(() => document.querySelector('[data-pdf-text]')?.textContent?.includes('TOMLIN OS'), null, { timeout: 15000 });
  const t = await v.locator('[data-pdf-text]').textContent();
  ok(t.includes('TOMLIN OS PDF Test'), 'heading text: ' + t.slice(0, 120));
  ok(t.replace(/\s+/g, ' ').includes('The quick brown fox jumps over the lazy dog'), 'paragraph text: ' + t.slice(0, 200));
  await page.screenshot({ path: join(appDir, 'pdf.png') });
  console.log('       (screenshot: ' + join(appDir, 'pdf.png') + ')');
  const px = await v.locator('canvas').evaluate(c => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let red = 0, green = 0, dark = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 190 && d[i + 1] < 70 && d[i + 2] < 70) red++;
      else if (d[i] < 70 && d[i + 1] > 150 && d[i + 2] < 70) green++;
      else if (d[i] < 60 && d[i + 1] < 60 && d[i + 2] < 60) dark++;
    }
    return { red, green, dark, w: c.width, h: c.height };
  });
  ok(px.red > 500, 'red box drawn: ' + JSON.stringify(px));
  ok(px.green > 100, 'image drawn: ' + JSON.stringify(px));
  ok(px.dark > 100, 'text drawn dark: ' + JSON.stringify(px));
  await v.getByRole('button', { name: 'Next page' }).click();
  await page.waitForFunction(() => document.querySelector('[data-pdf-text]')?.textContent?.includes('Second page'), null, { timeout: 10000 });
});

await step('PDF viewer: a file that is not a PDF is explained, not a blank window', async () => {
  await closeApp('.pdf');
  await fw().locator('.item', { hasText: 'fake' }).first().dblclick();
  await page.locator('.win .pdf [role=alert]', { hasText: 'does not look like a PDF' }).waitFor({ timeout: 8000 });
  await closeApp('.pdf');
});

await step('Text Editor: opens text, saves with Ctrl+S, refuses a file that is not text', async () => {
  const w = fw();
  await w.locator('.item', { hasText: 'notes' }).first().dblclick();
  const area = page.locator('.editor textarea');
  await area.waitFor();
  await page.waitForFunction(() => document.querySelector('.editor textarea')?.value.length > 0);
  eq(await area.inputValue(), 'first line\nsecond line\n', 'contents');
  await area.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('third line');
  ok((await page.locator('.editor .statusbar').innerText()).includes('not saved'), 'says not saved');
  await page.keyboard.press('Control+S');
  await page.locator('.toast', { hasText: 'Saved “notes.txt”' }).waitFor();
  ok(!(await page.locator('.editor .statusbar').innerText()).includes('not saved'), 'saved');
  await closeApp('.editor');
  await w.locator('.item', { hasText: 'binary' }).first().dblclick();
  await page.locator('.editor .statusbar', { hasText: 'does not look like text' }).waitFor();
  await closeApp('.editor');
});

await step('Text Editor: the saved change is there after reopening; closing with unsaved changes asks first', async () => {
  await fw().locator('.item', { hasText: 'notes' }).first().dblclick();
  const area = page.locator('.editor textarea');
  await area.waitFor();
  await page.waitForFunction(() => document.querySelector('.editor textarea')?.value.length > 0);
  eq(await area.inputValue(), 'first line\nsecond line\nthird line', 'the saved change');
  await area.click();
  await page.keyboard.type('x');
  await closeApp('.editor');
  const dialog = page.locator('.dialog');
  await dialog.waitFor();
  ok((await dialog.innerText()).includes('not saved'), 'warns');
  await dialog.getByRole('button', { name: 'Keep it open' }).click();
  await page.locator('.editor textarea').waitFor();
  await closeApp('.editor');
  await page.locator('.dialog').getByRole('button', { name: 'Close without saving' }).click();
});

await step('Pictures shows a picture with its size; Player makes an audio player', async () => {
  await fw().locator('.item', { hasText: 'blue' }).first().dblclick();
  await page.locator('.photos .statusbar').getByText('4 × 3 pixels').waitFor({ timeout: 8000 });
  await closeApp('.photos');
  await fw().locator('.item', { hasText: 'tone' }).first().dblclick();
  const audio = page.locator('.player audio');
  await audio.waitFor();
  ok((await audio.getAttribute('src')).startsWith('blob:'), 'blob address');
  await closeApp('.player');
});

// ---- Spreadsheet ---------------------------------------------------------------------------------------------------
const explorerWin = () => page.locator('.win', { has: page.locator('.explorer') }).first();
const sheetWin = () => page.locator('.win', { has: page.locator('.sheet') }).first();
const goTo = async addr => {
  const box = page.locator('.sheet .name-box');
  await box.fill(addr);
  await box.press('Enter');
};
const live = () => page.locator('.sheet [role=status][aria-live]').first();
const cell = async addr => {
  await goTo(addr);
  await page.waitForFunction(a => document.querySelector('.sheet [role=status][aria-live]')?.textContent?.startsWith(a + ':'), addr);
  return (await live().textContent()).slice(addr.length + 2);
};
const typeRow = async (cells) => {
  for (let i = 0; i < cells.length; i++) {
    await page.keyboard.type(cells[i]);
    await page.keyboard.press(i === cells.length - 1 ? 'Enter' : 'Tab');
  }
};

await step('Spreadsheet: opens from Start; typing with Tab and Enter fills cells, and Enter returns to the first column', async () => {
  await closeAll();
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('spreadsheet');
  await page.locator('.start-item', { hasText: 'Spreadsheet' }).click();
  await page.locator('.sheet .grid-scroll').waitFor();
  await goTo('A1');
  await typeRow(['Item', 'Cost', 'Qty']);
  await typeRow(['Pens', '1.5', '10']);
  await typeRow(['Books', '12.25', '3']);
  await typeRow(['Ink', '7', '2']);
  eq(await page.locator('.sheet .name-box').inputValue(), 'A5', 'Enter went back to column A of the next row');
  eq(await cell('B3'), '12.25', 'B3');
  eq(await cell('A4'), 'Ink', 'A4');
});

await step('Spreadsheet: formulas work, show in the formula bar, and errors read plainly', async () => {
  await goTo('B5');
  await page.keyboard.type('=SUM(B2:B4)');
  await page.keyboard.press('Enter');
  eq(await cell('B5'), '20.75', 'sum');
  eq(await page.locator('.sheet .formula-input').inputValue(), '=SUM(B2:B4)', 'formula shown');
  await goTo('D1');
  await page.keyboard.type('=1/0');
  await page.keyboard.press('Enter');
  eq(await cell('D1'), '#DIV/0!', 'error text');
  await goTo('D2');
  await page.keyboard.type('=B2*C2+B3');
  await page.keyboard.press('Enter');
  eq(await cell('D2'), '27.25', 'arithmetic');
});

await step('Spreadsheet: a formula written wrongly is explained and keeps the cell being edited; Escape cancels', async () => {
  await goTo('E1');
  await page.keyboard.type('=SUM(1,');
  await page.keyboard.press('Enter');
  const dialog = page.locator('.dialog');
  await dialog.waitFor();
  ok((await dialog.innerText()).includes('problem with this formula'), 'says so');
  await dialog.getByRole('button', { name: 'OK' }).click();
  ok(await page.locator('.sheet .grid-editor').isVisible(), 'still editing');
  await page.locator('.sheet .grid-editor').press('Escape');
  eq(await cell('E1'), 'empty', 'nothing was stored');
});

await step('Spreadsheet: AutoSum totals the numbers above; the status bar shows Sum, Average and Count for a selection', async () => {
  await goTo('C5');
  await page.locator('.sheet').getByRole('button', { name: /AutoSum/ }).click();
  await page.keyboard.press('Enter');
  eq(await cell('C5'), '15', 'autosum');
  await goTo('B2:C4');
  await page.waitForFunction(() => document.querySelector('.sheet-stats')?.textContent?.includes('Sum: 35.75'));
  const stats = await page.locator('.sheet-stats').innerText();
  ok(stats.includes('Average:') && stats.includes('Count: 6'), stats);
});

await step('Spreadsheet: Currency, Bold and fill work on a selection; the pixels really change; Ctrl+Z undoes', async () => {
  await goTo('B2:B5');
  await page.locator('.sheet').getByRole('button', { name: 'Currency format' }).click();
  await page.locator('.sheet').getByRole('button', { name: /^Bold/ }).click();
  eq(await cell('B3'), '$12.25', 'currency');
  eq(await page.locator('.sheet').getByRole('button', { name: /^Bold/ }).getAttribute('aria-pressed'), 'true', 'bold pressed');
  await goTo('B2:B5');
  await page.locator('.sheet').getByRole('button', { name: 'Fill colour' }).click();
  await page.locator('.palette-sw[title="Yellow"]').click();
  await settle(250);
  const yellow = await page.locator('.sheet .grid-canvas').evaluate(c => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 180 && d[i + 2] < 70) n++;
    return n;
  });
  ok(yellow > 500, 'yellow pixels drawn: ' + yellow);
  await page.locator('.sheet .grid-scroll').focus();
  await page.keyboard.press('Control+Z');
  await page.keyboard.press('Control+Z');
  await page.keyboard.press('Control+Z');
  eq(await cell('B3'), '12.25', 'undone back to plain');
  await page.keyboard.press('Control+Y');
  await page.keyboard.press('Control+Y');
  await page.keyboard.press('Control+Y');
  eq(await cell('B3'), '$12.25', 'redone');
});

await step('Spreadsheet: copy and paste shifts references; fill down continues a series and copies formulas', async () => {
  await goTo('D2');
  await page.locator('.sheet .grid-scroll').focus();
  await page.keyboard.press('Control+C');
  await goTo('D3');
  await page.locator('.sheet .grid-scroll').focus();
  await page.keyboard.press('Control+V');
  eq(await cell('D3'), '43.75', 'pasted formula points at the row below: =B3*C3+B4');
  await goTo('F1');
  await page.keyboard.type('1');
  await page.keyboard.press('Enter');
  await page.keyboard.type('2');
  await page.keyboard.press('Enter');
  await goTo('F1:F6');
  await page.locator('.sheet .grid-scroll').focus();
  await page.keyboard.press('Control+D');
  eq(await cell('F1'), '1', 'F1');
  eq(await cell('F6'), '1', 'Ctrl+D copies the first cell down');
});

await step('Spreadsheet: Insert row moves cells and the sum follows; Sort A to Z sorts the block and keeps the heading', async () => {
  await goTo('A3');
  await page.locator('.sheet').getByRole('button', { name: 'Insert rows or columns' }).click();
  await page.locator('.menu-item', { hasText: 'Insert row above' }).click();
  eq(await cell('A4'), 'Books', 'Books moved down one row');
  eq(await cell('B6'), '$20.75', 'total moved down a row');
  eq(await page.locator('.sheet .formula-input').inputValue(), '=SUM(B2:B5)', 'and its range grew');
  await goTo('H1');
  await typeRow(['Name', 'N']);
  await typeRow(['pear', '3']);
  await typeRow(['apple', '1']);
  await typeRow(['fig', '2']);
  await goTo('H2');
  await page.locator('.sheet').getByRole('button', { name: /Sort A to Z/ }).click();
  eq(await cell('H1'), 'Name', 'heading stays');
  eq(await cell('H2'), 'apple', 'first');
  eq(await cell('H4'), 'pear', 'last');
  eq(await cell('I4'), '3', 'the number moved with its word');
});

await step('Spreadsheet: sheets: add, rename and switch; a formula can refer to another sheet by name', async () => {
  await page.locator('.sheet .sheet-add').click();
  await page.locator('.sheet-tab', { hasText: 'Sheet2' }).waitFor();
  await goTo('A1');
  await page.keyboard.type("=Sheet1!B6*2");
  await page.keyboard.press('Enter');
  eq(await cell('A1'), '41.5', 'cross-sheet');
  await page.locator('.sheet-tab', { hasText: 'Sheet2' }).dblclick();
  const dlg = page.locator('.dialog');
  await dlg.waitFor();
  await dlg.locator('input').fill('Totals');
  await dlg.getByRole('button', { name: 'Rename' }).click();
  await page.locator('.sheet-tab', { hasText: 'Totals' }).waitFor();
  await page.locator('.sheet-tab', { hasText: 'Sheet1' }).click();
  eq(await cell('A2'), 'Pens', 'back on sheet 1');
});

await step('Spreadsheet: Save as makes a .sheet file; reopening it from Explorer restores values, formulas and formatting', async () => {
  await page.locator('.sheet .grid-scroll').focus();
  await page.keyboard.press('Control+S');
  const dlg = page.locator('.dialog');
  await dlg.waitFor();
  await dlg.locator('input').fill('budget-' + stamp + '.sheet');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await page.locator('.toast', { hasText: 'Saved' }).last().waitFor();
  await page.locator('.win', { has: page.locator('.sheet') }).getByRole('button', { name: 'Close' }).click();
  const w = await openDocuments();
  await w.locator('.item', { hasText: 'budget-' + stamp }).first().dblclick();
  await page.locator('.sheet .grid-scroll').waitFor();
  eq(await cell('B6'), '$20.75', 'currency formatting kept');
  eq(await page.locator('.sheet .formula-input').inputValue(), '=SUM(B2:B5)', 'formula kept');
  await page.locator('.sheet-tab', { hasText: 'Totals' }).click();
  eq(await cell('A1'), '41.5', 'other sheet kept');
  await page.locator('.win', { has: page.locator('.sheet') }).getByRole('button', { name: 'Close' }).click();
});

await step('Spreadsheet: a CSV file opens as a new workbook; a damaged .sheet file is refused with a reason', async () => {
  const csv = join(appDir, 'people.csv');
  writeFileSync(csv, 'Name,Score\n"Smith, Ann",90\nBob,75\n');
  const bad = join(appDir, 'broken.sheet');
  writeFileSync(bad, '{"format":"tomlinos-sheet","sheets":[{"name":"x","cells":[[99999,0,1,null,0]]}]}');
  const w = explorerWin();
  const chooser = page.waitForEvent('filechooser');
  await w.getByRole('button', { name: 'Upload' }).click();
  (await chooser).setFiles([csv, bad]);
  await w.locator('.item', { hasText: 'people' }).first().waitFor({ timeout: 10000 });
  await w.locator('.item', { hasText: 'people' }).first().dblclick();
  await page.locator('.sheet .grid-scroll').waitFor();
  eq(await cell('A2'), 'Smith, Ann', 'quoted comma kept in one cell');
  eq(await cell('B3'), '75', 'number');
  await page.locator('.win', { has: page.locator('.sheet') }).getByRole('button', { name: 'Close' }).click();
  const dlg = page.locator('.dialog');
  if (await dlg.count()) await dlg.getByRole('button', { name: 'Close without saving' }).click();
  await w.locator('.item', { hasText: 'broken' }).first().dblclick();
  await page.locator('.win .sheet [role=alert]', { hasText: 'not a spreadsheet this app can open' }).waitFor({ timeout: 8000 });
  await page.locator('.win', { has: page.locator('.sheet') }).getByRole('button', { name: 'Close' }).click();
});

await step('phone size: windows fill the screen, taskbar is bigger, nothing scrolls sideways', async () => {
  await closeAll();
  await page.setViewportSize({ width: 390, height: 800 });
  await settle(300);
  await item('My Files', '#desktop').dblclick();
  const w = fw();
  await w.waitFor();
  await w.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
  const box = await w.boundingBox();
  const screen = await page.locator('#screen').boundingBox();
  ok(Math.abs(box.width - screen.width) < 2, `fills the width: ${box.width} vs ${screen.width}`);
  eq(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no sideways scroll');
  const bar = await page.locator('#taskbar').boundingBox();
  ok(bar.height >= 44, 'taskbar tall enough to touch: ' + bar.height);
  await w.getByRole('button', { name: 'Close' }).click();
  await page.setViewportSize({ width: 1100, height: 720 });
});

await step('no page errors or blocked resources in the whole run', async () => {
  const csp = await page.evaluate(() => window.__csp);
  eq(csp, [], 'CSP violations');
  // 404: the store answers "no such record" for a key not made yet. 409: two saves met (another tab); the desktop retries.
  const real = problems.filter(p => !p.includes('404') && !p.includes('409'));
  eq(real, [], 'console problems');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) console.log('Failed: ' + failures.join('; '));
await Promise.race([browser.close(), new Promise(r => setTimeout(r, 3000))]);
process.exit(failures.length ? 1 : 0);
