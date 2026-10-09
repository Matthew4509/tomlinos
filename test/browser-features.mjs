// Drives search, window snapping and the switcher, Calendar (with a reminder reaching the notification centre),
// Contacts, web links, colour schemes and the Start menu's fixed size in a real Chrome. Needs the dev server on a
// FRESH, EMPTY data folder (the first step sets up the owner), and `npm run build` done.
//   node test/browser-features.mjs [http://127.0.0.1:3043] [screenshot folder]
import { chromium } from 'playwright-core';
import { HIDDEN_APPS } from '../src/release.ts';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3043';
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
    console.log('  FAIL ' + name + '\n       ' + String(error.message).slice(0, 1200));
  }
}
const eq = (a, b, what) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const ok = (v, what) => {
  if (!v) throw new Error(what);
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const problems = [];
page.on('console', m => m.type() === 'error' && problems.push('console: ' + m.text()));
page.on('pageerror', e => problems.push('pageerror: ' + e.message));
const shot = async name => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });
const openApp = async label => {
  await page.locator('.start-btn').click();
  // Most apps sit in groups: find it by name in the Start menu's search box, as a person would.
  await page.locator('.start-filter').fill(label);
  await page.locator(`.start-menu [data-label="${label}"]`).first().click();
};
const front = () => page.locator('.win.active');

console.log('Search, windows, Calendar, Contacts, links, themes, against ' + BASE);
await page.goto(BASE);

await step('set up the owner', async () => {
  await page.locator('.gate h1', { hasText: 'Set up this desktop' }).waitFor({ timeout: 20000 });
  await page.getByLabel('Your name').fill('Sample Owner');
  await page.locator('.gate input.gate-input').last().fill(PASS);
  await page.locator('.gate-go').click();
  await page.locator('.gate h1', { hasText: 'Your recovery key' }).waitFor({ timeout: 30000 });
  await page.locator('.gate .check-row input').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#desktop .item').first().waitFor({ timeout: 20000 });
});

await step('the Start menu keeps its size while the filter narrows the list', async () => {
  await page.locator('.start-btn').click();
  const menu = page.locator('.start-menu');
  const before = await menu.boundingBox();
  await page.locator('.start-filter').fill('cal');
  const after = await menu.boundingBox();
  eq([after.width, after.height], [before.width, before.height], 'menu size');
  ok(await page.locator('.start-item[data-label="calendar"]').isVisible(), 'Calendar still listed');
  await shot('01-start-filter');
  await page.keyboard.press('Escape');
});

// The Start menu files the apps (not a wall of tiles): 8 pinned (Panel among them), then the groups, each opening a column.
const PINNED = ['Panel', 'File Explorer', 'Mail', 'Calendar', 'Spreadsheet', 'Notepad', 'Assistant', 'Chat'];
// Games holds only Planetziods and Office Printer: with both hidden (src/release.ts) the group is not shown.
const GAMES = !(HIDDEN_APPS.includes('planetziods') && HIDDEN_APPS.includes('printer'));
const GROUPS = ['Accessories', 'Office', 'Internet', 'Graphics & media', ...(GAMES ? ['Games'] : []), 'Development', 'System', 'Settings'];
const pinnedNames = () => page.locator('.start-list > .start-item').allInnerTexts();
// The desktop writes its settings 0.8 s after the last change (shell/session.ts). Before a reload, wait until the
// writes have landed and none has come for 2.5 s: a fixed pause lost the change when a write was slow.
const settingsWritten = async () => {
  for (;;) {
    try {
      await page.waitForResponse(r => r.url().includes('op=commit'), { timeout: 2500 });
    } catch {
      return;
    }
  }
};
const signInAgain = async () => {
  await page.locator('.gate input.gate-input').last().fill(PASS).catch(() => {});
  if (await page.locator('.gate-go').isVisible().catch(() => false)) await page.locator('.gate-go').click();
  await page.locator('#desktop .item').first().waitFor({ timeout: 20000 });
};

await step('Start menu (Xfce by default): 8 pinned apps, then the groups and Places; a group opens its apps in a column to the right, level with it; About sits in the bottom row', async () => {
  eq(await page.evaluate(() => document.documentElement.dataset.theme), 'xfce', 'a new desktop starts in the Xfce colours');
  await page.locator('.start-btn').click();
  eq((await pinnedNames()).map(t => t.trim()), PINNED, 'pinned');
  eq((await page.locator('.start-list > .start-group .start-group-name').allInnerTexts()).map(t => t.trim()), [...GROUPS, 'Places'], 'groups (no "Other": every app is filed), then Places');
  eq(await page.locator('.start-fly').count(), 0, 'no column until a group is chosen');
  const menuBox = await page.locator('.start-menu').boundingBox();
  const dev = page.locator('.start-list > .start-group', { hasText: 'Development' });
  await dev.click();
  eq(await page.locator('.start-fly').count(), 1, 'a column for Development');
  const appsBox = await page.locator('.start-fly').boundingBox();
  const devBox = await dev.boundingBox();
  ok(appsBox.x >= menuBox.x + menuBox.width - 4, `its apps open to the right of the menu (${appsBox.x} vs ${menuBox.x + menuBox.width})`);
  ok(Math.abs(appsBox.y - devBox.y) <= 8, `level with Development (${appsBox.y} vs ${devBox.y})`);
  ok(await page.locator('.start-fly .start-item', { hasText: 'Terminal' }).isVisible(), 'Terminal in the Development column');
  eq(await dev.getAttribute('aria-expanded'), 'true', 'Development stays marked');
  await shot('01b-start-columns');
  await page.locator('.start-list > .start-group', { hasText: 'Office' }).click();
  eq(await page.locator('.start-fly').count(), 1, 'still one column');
  ok(await page.locator('.start-fly .start-item', { hasText: 'Spreadsheet' }).isVisible(), 'another group replaces the column');
  // Keys: Left and Escape close the column (back on its group), Right opens it again.
  await page.locator('.start-fly .start-item').first().focus();
  await page.keyboard.press('ArrowLeft');
  eq(await page.locator('.start-fly').count(), 0, 'Left closed the column');
  eq(await page.evaluate(() => document.activeElement?.textContent?.includes('Office')), true, 'focus back on Office');
  await page.keyboard.press('ArrowRight');
  eq(await page.locator('.start-fly').count(), 1, 'Right opened it again');
  await page.keyboard.press('Escape');
  eq(await page.locator('.start-fly').count(), 0, 'Escape closed the column');
  ok(await page.locator('.start-menu').isVisible(), 'the menu itself still open');
  // A mouse resting on a group opens it, as Xfce's menu does; resting on a pinned app closes it again.
  await page.locator('.start-list > .start-group', { hasText: 'Internet' }).hover();
  await page.locator('.start-fly .start-item', { hasText: 'Mail' }).waitFor();
  await page.locator('.start-list > .start-item', { hasText: 'Panel' }).hover();
  await page.waitForTimeout(500);
  eq(await page.locator('.start-fly').count(), 0, 'resting on a pinned app closed the column');
  // Places opens its folders the same way.
  await page.locator('.start-list > .start-group', { hasText: 'Places' }).click();
  ok(await page.locator('.start-fly .start-item', { hasText: 'Documents' }).isVisible(), 'Places');
  // Search looks through everything, in the menu's own column.
  await page.locator('.start-filter').fill('note');
  eq((await pinnedNames()).map(t => t.trim()), ['Notepad', 'Notepad Pro'], 'search finds across groups');
  eq(await page.locator('.start-fly').count(), 0, 'no column while searching');
  await page.locator('.start-filter').fill('');
  // An app in a column opens and closes the whole menu.
  await page.locator('.start-list > .start-group', { hasText: 'Accessories' }).click();
  await page.locator('.start-fly .start-item', { hasText: 'Calculator' }).click();
  await page.locator('.win', { hasText: 'Calculator' }).first().waitFor();
  eq(await page.locator('.start-menu, .start-fly').count(), 0, 'menu and column closed');
  await page.locator('.win').last().getByRole('button', { name: 'Close' }).click();
  await page.locator('.start-btn').click();
  ok(await page.locator('.start-foot .start-foot-app', { hasText: 'About TOMLIN OS' }).isVisible(), 'About in the bottom row');
  await page.keyboard.press('Escape');
});

await step('Start menu on a phone-width screen: no room for a column, so a group opens in place with a Back button', async () => {
  await page.setViewportSize({ width: 420, height: 800 });
  await page.locator('.start-btn').click();
  await page.locator('.start-list > .start-group', { hasText: 'Development' }).click();
  eq(await page.locator('.start-fly').count(), 0, 'no columns');
  ok(await page.locator('.start-list .start-item', { hasText: 'Terminal' }).isVisible(), 'Development opens in place');
  await page.locator('.start-more', { hasText: 'Back' }).click();
  eq((await pinnedNames()).length, PINNED.length, 'back to the pinned apps');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1280, height: 800 });
});

await step('Start menu: right-click pins an app and unpins it; pins are kept after a reload', async () => {
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('calc');
  await page.locator('.start-item', { hasText: 'Calculator' }).click({ button: 'right' });
  await page.locator('.menu-item', { hasText: 'Add to Favourites' }).click();
  ok(await page.locator('.start-menu').isVisible(), 'the Start menu stays open');
  await page.locator('.start-filter').fill('');
  eq((await pinnedNames()).map(t => t.trim()), [...PINNED, 'Calculator'], 'pinned at the end');
  await page.keyboard.press('Escape');
  await settingsWritten();
  await page.reload();
  await signInAgain();
  await page.locator('.start-btn').click();
  eq((await pinnedNames()).map(t => t.trim()).at(-1), 'Calculator', 'still pinned after a reload');
  await page.locator('.start-list > .start-item', { hasText: 'Calculator' }).click({ button: 'right' });
  await page.locator('.menu-item', { hasText: 'Move up' }).click();
  eq((await pinnedNames()).map(t => t.trim()).slice(-2), ['Calculator', 'Chat'], 'moved up');
  await page.locator('.start-list > .start-item', { hasText: 'Calculator' }).click({ button: 'right' });
  await page.locator('.menu-item', { hasText: 'Remove from Favourites' }).click();
  eq((await pinnedNames()).map(t => t.trim()), PINNED, 'unpinned');
  await page.keyboard.press('Escape');
});

let startTime = '';
await step('Calendar: add an event with a reminder; it is saved as Documents/Calendar.ics', async () => {
  await openApp('calendar');
  const w = front();
  await w.locator('.cal-cell.today').waitFor();
  await w.getByRole('button', { name: 'New event' }).click();
  await w.getByLabel('What').fill('Prune the magnolia, Mrs Lee');
  await w.locator('input[type=checkbox]').uncheck();
  const now = new Date();
  startTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  await w.getByLabel('Starts').fill(startTime);
  await w.getByLabel('Reminder').selectOption('0');
  await w.getByLabel('Repeats').selectOption('monthly');
  await w.getByRole('button', { name: 'Save' }).click();
  await w.locator('.cal-event-title', { hasText: 'Prune the magnolia' }).waitFor();
  ok((await w.locator('.cal-cell.today .cal-chip').innerText()).includes('Prune the magnolia'), 'chip in today');
  await shot('02-calendar');
});

await step('the reminder arrives as a notification and waits in the bell', async () => {
  await page.locator('.toast', { hasText: 'Prune the magnolia' }).waitFor({ timeout: 40000 });
  eq(await page.locator('.bell-count').innerText(), '1', 'unread count');
  await page.locator('.bell').click();
  await page.locator('.notice.unread', { hasText: 'Prune the magnolia' }).waitFor();
  await shot('03-notifications');
  await page.keyboard.press('Escape');
  ok(await page.locator('.bell-count').isHidden(), 'count cleared once seen');
});

await step('Contacts: add a person, find them by phone number', async () => {
  await openApp('contacts');
  const w = front();
  await w.getByRole('button', { name: 'New contact' }).click();
  await w.getByLabel('Name').fill('Grace Lee');
  await w.getByLabel('Company').fill('Lee Music School');
  await w.getByLabel('Phone numbers (one per line)').fill('0411 222 333');
  await w.getByLabel('Email addresses (one per line)').fill('grace@example.com');
  await w.getByLabel('Birthday').fill('1975-04-12');
  await w.getByRole('button', { name: 'Save' }).click();
  await w.locator('.person h2', { hasText: 'Grace Lee' }).waitFor();
  await w.getByLabel('Search contacts').fill('222 333');
  eq(await w.locator('.person-row').count(), 1, 'found by phone');
  await shot('04-contacts');
});

await step('Explorer search finds by name and inside files (the contact file holds the phone number)', async () => {
  await page.keyboard.press('Control+Alt+e');
  const w = front();
  await w.locator('input.search').waitFor();
  await w.locator('input.search').fill('calendar');
  await w.locator('.search-hit .hit-name', { hasText: 'Calendar.ics' }).waitFor();
  await w.locator('input.search').fill('0411 222');
  await w.locator('.search-hit .hit-name', { hasText: 'Contacts.vcf' }).waitFor();
  ok((await w.locator('.hit-snippet').first().innerText()).includes('0411 222 333'), 'snippet shows the line');
  await shot('05-search');
  await w.locator('input.search').press('Escape');
  ok(await w.locator('.search-results').isHidden(), 'back to the folder');
});

await step('Ctrl+Alt+Left snaps the front window to the left half; Ctrl+Alt+Down puts it back', async () => {
  const w = front();
  const before = await w.boundingBox();
  await page.keyboard.press('Control+Alt+ArrowLeft');
  const snapped = await w.boundingBox();
  eq([snapped.x, Math.round(snapped.width)], [0, 640], 'left half');
  await page.keyboard.press('Control+Alt+ArrowDown');
  const back = await w.boundingBox();
  eq([back.x, back.width], [before.x, before.width], 'restored');
});

await step('dragging a title bar to the right edge snaps it to the right half', async () => {
  const w = front();
  const bar = w.locator('.win-bar');
  const b = await bar.boundingBox();
  await page.mouse.move(b.x + 60, b.y + 10);
  await page.mouse.down();
  await page.mouse.move(700, 300, { steps: 5 });
  await page.mouse.move(1279, 300, { steps: 5 });
  ok(await page.locator('.snap-ghost').isVisible(), 'ghost shows where it will go');
  await shot('06-snap-ghost');
  await page.mouse.up();
  const r = await w.boundingBox();
  eq([Math.round(r.x), Math.round(r.width)], [640, 640], 'right half');
});

await step('Alt+` shows the switcher and letting go of Alt switches window', async () => {
  const was = await front().locator('.win-title-text').innerText();
  await page.keyboard.down('Alt');
  await page.keyboard.press('Backquote');
  await page.locator('.switcher').waitFor();
  await shot('07-switcher');
  await page.keyboard.up('Alt');
  ok(await page.locator('.switcher').isHidden(), 'switcher gone');
  ok((await front().locator('.win-title-text').innerText()) !== was, 'another window in front');
});

await step('New > Web link makes a .url file; opening it shows the real address and does not frame the site', async () => {
  await page.keyboard.press('Control+Alt+d');
  await page.locator('#desktop').click({ button: 'right', position: { x: 600, y: 400 } });
  await page.locator('.menu-item', { hasText: 'New' }).click();
  await page.locator('.menu-item', { hasText: 'Web link...' }).click();
  await page.locator('.dialog input.field').fill('javascript:alert(1)');
  await page.locator('.dialog-problem', { hasText: 'full web address' }).waitFor();
  ok(await page.locator('.dialog').getByRole('button', { name: 'Next' }).isDisabled(), 'Next is off for a bad address');
  await page.locator('.dialog input.field').fill('https://www.youtube.com/');
  await page.locator('.dialog').getByRole('button', { name: 'Next' }).click();
  await page.locator('input.rename').waitFor();
  await page.keyboard.press('Enter'); // accept the suggested name
  const item = page.locator('#desktop .item', { hasText: 'youtube.com' });
  await item.waitFor();
  await item.dblclick();
  await front().locator('.link-host', { hasText: 'www.youtube.com' }).waitFor();
  eq(await page.locator('iframe').count(), 0, 'nothing is framed');
  await shot('08-weblink');
  await front().locator('.win-close').click();
});

await step('Keyboard shortcuts window lists the snap keys', async () => {
  await openApp('keyboard shortcuts');
  await front().locator('dt', { hasText: 'Ctrl+Alt+←' }).waitFor();
});

await step('Terminal (Ctrl+Alt+T): real files, Tab, and the training ssh round trip', async () => {
  await page.keyboard.press('Control+Alt+t');
  const w = front();
  const input = w.locator('.term-in');
  await input.waitFor();
  const type = async text => {
    await input.fill(text);
    await input.press('Enter');
  };
  await input.fill('cd Docu');
  await input.press('Tab');
  await page.waitForFunction(() => document.querySelector('.win.active .term-in')?.value === 'cd Documents/', null, { timeout: 5000 });
  await input.press('Enter');
  await type('ls');
  await w.locator('.term-row', { hasText: 'Calendar.ics' }).waitFor();
  await type('grep -i magnolia Calendar.ics');
  await w.locator('.term-row', { hasText: 'SUMMARY:Prune the magnolia' }).waitFor();
  await type('ssh training');
  await type('yes');
  eq(await input.getAttribute('type'), 'password', 'password hidden');
  await type('learner');
  await w.locator('.term-user', { hasText: 'learner@training' }).last().waitFor();
  ok(await w.locator('.term-screen.pretend').isVisible(), 'pretend machine is marked');
  await type('cat README.txt');
  await w.locator('.term-row', { hasText: 'This is a PRETEND Debian server' }).waitFor();
  await shot('10-terminal-training');
  await type('exit');
  await type('scp training:notes/tips.txt .');
  await type('cat tips.txt');
  await w.locator('.term-row', { hasText: 'Debian tips' }).waitFor();
  await shot('11-terminal');
});

await step('a Terminal printing in another window does not close the desktop menu', async () => {
  // Once any scroll anywhere closed menus, and output scrolls the Terminal a frame later; this step failed at random.
  await page.evaluate(() => {
    const inp = document.querySelector('.term-in');
    inp.value = 'help';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    document.querySelector('#desktop').dispatchEvent(new MouseEvent('contextmenu', { clientX: 600, clientY: 400, button: 2, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(300);
  eq(await page.locator('.menu-item', { hasText: 'Desktop Settings...' }).count(), 1, 'menu still open');
  await page.keyboard.press('Escape');
});

await step('right-click the desktop: Desktop Settings opens Settings with the screensaver controls', async () => {
  // Windows opened by earlier steps cover the middle; send the right-click to the desktop itself.
  await page.locator('#desktop').dispatchEvent('contextmenu', { clientX: 600, clientY: 400, button: 2, bubbles: true, cancelable: true });
  await page.locator('.menu-item', { hasText: 'Desktop Settings...' }).click();
  await front().getByText('Start the screensaver').waitFor();
});

for (const theme of ['olive', 'silver', 'blue', 'dark']) {
  await step(`the ${theme} colour scheme applies and survives a reload`, async () => {
    await openApp('settings');
    await front().locator(`[data-theme-sample="${theme}"]`).click();
    eq(await page.evaluate(() => document.documentElement.dataset.theme), theme, 'applied');
    await openApp('calendar');
    await shot(`09-theme-${theme}`);
    if (theme === 'dark') {
      await settingsWritten();
      await page.reload();
      await page.locator('.gate input.gate-input').last().fill(PASS).catch(() => {});
      if (await page.locator('.gate-go').isVisible().catch(() => false)) await page.locator('.gate-go').click();
      await page.locator('#desktop .item').first().waitFor({ timeout: 20000 });
      eq(await page.evaluate(() => document.documentElement.dataset.theme), 'dark', 'after reload');
    }
  });
}

await step('Classic blue colours: the same Start menu (groups, a column to the right); only the pinning words are Windows ones', async () => {
  await openApp('settings');
  await front().locator('[data-theme-sample="blue"]').click();
  await page.locator('.start-btn').click();
  eq((await page.locator('.start-list > .start-group .start-group-name').allInnerTexts()).map(t => t.trim()), [...GROUPS, 'Places'], 'the same groups');
  await page.locator('.start-list > .start-group', { hasText: 'Development' }).click();
  ok(await page.locator('.start-fly .start-item', { hasText: 'Terminal' }).isVisible(), 'a column to the right');
  await page.locator('.start-list > .start-item', { hasText: 'Mail' }).click({ button: 'right' });
  ok(await page.locator('.menu-item', { hasText: 'Unpin from Start' }).isVisible(), 'Windows words for pinning');
  await page.keyboard.press('Escape');
  await shot('12-start-blue');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
});

await step(`hidden in this release (src/release.ts: ${HIDDEN_APPS.join(', ') || 'nothing'}): not in the Start menu, not on the desktop, no Ctrl+P line`, async () => {
  const names = { printer: 'Office Printer', planetziods: 'Planetziods' };
  for (const [id, name] of Object.entries(names)) {
    const hidden = HIDDEN_APPS.includes(id);
    await page.locator('.start-btn').click();
    await page.locator('.start-filter').fill(name.toLowerCase());
    eq(await page.locator(`.start-menu [data-app="${id}"]`).count() > 0, !hidden, `${name} in the Start menu`);
    await page.keyboard.press('Escape');
    eq(await page.locator('#desktop .item .item-name', { hasText: new RegExp(`^${name}$`) }).count() > 0, id === 'printer' && !hidden, `${name} icon on the desktop`);
  }
  await openApp('keyboard shortcuts');
  const keysWin = page.locator('.win').last();
  await keysWin.getByText('Alt+L').first().waitFor();
  eq(await keysWin.getByText('Ctrl+P', { exact: true }).count() > 0, !HIDDEN_APPS.includes('printer'), 'Ctrl+P on the shortcuts list');
  await keysWin.getByRole('button', { name: 'Close' }).click();
});

await step('the desktop has a Panel icon for everyone, and it opens the Panel', async () => {
  const icon = page.locator('#desktop .item', { hasText: 'Panel' });
  ok(await icon.isVisible(), 'Panel on the desktop');
  await icon.dblclick();
  await page.locator('.win', { has: page.locator('.panel-nav') }).first().waitFor({ timeout: 15000 });
});

await step('Mail set-up inside the Panel: every field, hint and button is dark text on a light background', async () => {
  const panel = page.locator('.win', { has: page.locator('.panel-nav') }).first();
  await panel.getByText('MAIL', { exact: true }).click();
  await panel.locator('.mail-setup').waitFor({ timeout: 15000 });
  await panel.locator('.mail-setup summary', { hasText: 'Server settings' }).click();
  const worst = await page.evaluate(() => {
    const rgb = c => (c.match(/[\d.]+/g) ?? []).map(Number);
    const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const bgOf = el => { for (let e = el; e; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c.length < 4 || c[3] > 0) return c; } return [255, 255, 255]; };
    const out = [];
    for (const el of document.querySelectorAll('.mail-setup input:not([type=checkbox]), .mail-setup select, .mail-setup button, .mail-setup .mail-note, .mail-setup label, .mail-setup h2')) {
      const fg = lum(rgb(getComputedStyle(el).color)); const bg = lum(bgOf(el));
      out.push({ what: el.tagName + ' ' + (el.placeholder || el.textContent || '').trim().slice(0, 30), ratio: (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05) });
    }
    return out.sort((a, b) => a.ratio - b.ratio).slice(0, 3);
  });
  ok(worst.length && worst[0].ratio >= 4.5, 'lowest contrast: ' + JSON.stringify(worst));
  await shot('13-panel-mail-setup');
});

await step('Chat: the owner has an Add people button (General and Direct), and it opens My account on People on this desktop', async () => {
  const panel = page.locator('.win', { has: page.locator('.panel-nav') }).first();
  await panel.getByRole('button', { name: 'Close' }).click();
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('chat');
  await page.locator('.start-menu [data-label="chat"]').first().click();
  const chat = page.locator('.win', { has: page.locator('.chat-tabs') }).last();
  await chat.locator('.chat-add').first().waitFor({ timeout: 15000 });
  await chat.getByRole('tab', { name: 'Direct' }).click();
  await chat.locator('.chat-add-row .chat-add').click();
  const account = page.locator('.win', { has: page.locator('.acct-nav') }).last();
  await account.locator('.acct-tab.on', { hasText: 'People on this desktop' }).waitFor({ timeout: 15000 });
  await account.getByRole('button', { name: 'Close' }).click();
  await chat.getByRole('button', { name: 'Close' }).click();
});

// 404: the store answers "no such record" for a key not made yet (the first visit, before set-up).
await step('no errors in the page', async () => eq(problems.filter(p => !p.includes('404')), [], 'problems'));

console.log(`\n${passed} passed, ${failures.length} failed`);
// close() can hang on Windows (it did for 13 minutes after the Assistant step); the results are already printed.
await Promise.race([browser.close(), new Promise(r => setTimeout(r, 3000))]);
process.exit(failures.length ? 1 : 0);
