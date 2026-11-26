// Drives the classic menu bar (src/shell/menubar.ts) in a real Chrome on a page of its own, with sample menus and a
// toolbar over a text box: Alt and F10 put the keyboard on the bar, Alt+letter opens a menu, the arrows move between
// menus and items (skipping disabled ones), Enter runs, Escape closes, and the keyboard goes back to the text box. The
// mouse opens, switches by hovering and closes; a tap opens on a touch screen. A ticked item, a submenu, the toolbar as
// one Tab stop with the arrows inside, tooltips, a toggle's pressed state, a narrow window (menus and buttons move into
// »), the dark theme, and every 16 px picture parsed and measured. Then it draws the sheet of pictures (1x and 2x, light
// and dark) to icons.png in the folder given.
// Needs `npm run build` done. No server: the page and the built files are handed to the browser straight from out/.
//   node test/browser-menubar.mjs [folder for icons.png and screenshots]
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'out');
const SHOTS = process.argv[2] ?? null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://menubar.localhost';
if (!existsSync(join(OUT, 'app', 'shell', 'menubar.js'))) {
  console.error('Run `npm run build` first (out/app/shell/menubar.js is missing).');
  process.exit(1);
}

const DEMO_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Menu bar</title><link rel="stylesheet" href="/style.css"></head>
<body><div id="frame"><div id="app"><textarea id="doc" aria-label="Document">Some text</textarea></div></div><div id="layer-menus"></div>
<script type="module" src="/demo.js"></script></body></html>`;

const DEMO_JS = `
import { classicBar, checkShortcuts } from '/app/shell/menubar.js';
import { MenuLayer } from '/app/shell/menu.js';
const frame = document.getElementById('frame');
frame.style.cssText = 'position:fixed;left:20px;top:20px;width:900px;height:400px;background:var(--paper);border:1px solid var(--line)';
const app = document.getElementById('app');
app.style.cssText = 'display:flex;flex-direction:column;height:100%';
const doc = document.getElementById('doc');
doc.style.cssText = 'flex:1;margin:0;border:0;padding:6px;font:13px monospace;background:var(--paper);color:var(--ink)';
const layer = new MenuLayer(document.getElementById('layer-menus'));
const state = { dirty: false, status: true, bold: false, extra: false, log: [] };
const run = name => () => state.log.push(name);
const menus = [
  { label: 'File', items: [
    { label: 'New', icon: 'new', shortcut: 'Alt+N', action: run('new') },
    { label: 'Open...', icon: 'open', shortcut: 'Ctrl+O', action: run('open') },
    { label: 'Save', icon: 'save', shortcut: 'Ctrl+S', enabled: () => state.dirty, action: run('save') },
    { label: 'Save as...', icon: 'save-as', action: run('save-as') },
    { separator: true },
    { label: 'Recent', submenu: () => [{ label: 'letter.txt', action: run('recent:letter') }, { label: 'notes.txt', action: run('recent:notes') }] },
    { separator: true },
    { label: 'Print...', icon: 'print', action: run('print') },
    { label: 'Close', icon: 'close', action: run('close') },
  ] },
  { label: 'Edit', items: [
    { label: 'Undo', icon: 'undo', shortcut: 'Ctrl+Z', enabled: () => false, action: run('undo') },
    { label: 'Cut', icon: 'cut', shortcut: 'Ctrl+X', action: run('cut') },
    { label: 'Copy', icon: 'copy', shortcut: 'Ctrl+C', action: run('copy') },
    { label: 'Paste', icon: 'paste', shortcut: 'Ctrl+V', action: run('paste') },
    { separator: true },
    { label: 'Select all', icon: 'select-all', shortcut: 'Ctrl+A', action: run('select-all') },
  ] },
  { label: 'View', items: [
    { label: 'Status bar', checked: () => state.status, action: () => { state.status = !state.status; state.log.push('status'); } },
    { label: 'Zoom', submenu: [{ label: 'Zoom in', icon: 'zoom-in', action: run('zoom-in') }, { label: 'Zoom out', icon: 'zoom-out', action: run('zoom-out') }] },
  ] },
  { label: 'Format', items: [{ label: 'Bold', icon: 'bold', shortcut: 'Ctrl+B', checked: () => state.bold, action: () => { state.bold = !state.bold; state.log.push('bold'); } }] },
  { label: 'Extra', shown: () => state.extra, items: [{ label: 'Hidden thing', action: run('extra') }] },
  { label: 'Tools', items: [{ label: 'Settings...', icon: 'settings', action: run('settings') }] },
  { label: 'Help', items: [{ label: 'Help', icon: 'help', shortcut: 'F1', action: run('help') }, { label: 'About', action: run('about') }] },
];
const tools = [
  { label: 'New', icon: 'new', action: run('t-new') },
  { label: 'Open', icon: 'open', shortcut: 'Ctrl+O', action: run('t-open') },
  { label: 'Save', icon: 'save', shortcut: 'Ctrl+S', enabled: () => state.dirty, action: run('t-save') },
  '|',
  { label: 'Cut', icon: 'cut', shortcut: 'Ctrl+X', action: run('t-cut') },
  { label: 'Copy', icon: 'copy', shortcut: 'Ctrl+C', action: run('t-copy') },
  { label: 'Paste', icon: 'paste', shortcut: 'Ctrl+V', action: run('t-paste') },
  '|',
  { label: 'Undo', icon: 'undo', shortcut: 'Ctrl+Z', enabled: () => false, action: run('t-undo') },
  { label: 'Redo', icon: 'redo', shortcut: 'Ctrl+Y', action: run('t-redo') },
  '|',
  { id: 'bold', label: 'Bold', icon: 'bold', shortcut: 'Ctrl+B', pressed: () => state.bold, action: () => { state.bold = !state.bold; state.log.push('t-bold'); } },
  { label: 'Italic', icon: 'italic', shortcut: 'Ctrl+I', pressed: () => false, action: run('t-italic') },
  '|',
  { label: 'Find', icon: 'find', shortcut: 'Ctrl+F', action: run('t-find') },
  { label: 'Zoom in', icon: 'zoom-in', action: run('t-zoom-in') },
  { label: 'Zoom out', icon: 'zoom-out', action: run('t-zoom-out') },
  { label: 'Help', icon: 'help', shortcut: 'F1', action: run('t-help') },
];
const abort = new AbortController();
const bar = classicBar({ menus, tools }, { layer, signal: abort.signal, scope: app, doc: () => doc, bindShortcuts: true });
app.prepend(bar.el);
window.demo = { state, bar, layer, frame, badKeys: checkShortcuts(menus) };
`;

const SHEET_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Toolbar pictures</title><link rel="stylesheet" href="/style.css"></head>
<body><div id="sheet"></div><script type="module" src="/sheet.js"></script></body></html>`;

const SHEET_JS = `
import { TOOL_ICON_IDS, toolIcon } from '/app/shell/toolicons.js';
document.body.style.cssText = 'overflow:visible;background:#ffffff;height:auto';
document.documentElement.style.height = 'auto';
const root = document.documentElement;
const tokens = ['--ink', '--paper', '--face', '--accent', '--line', '--ink-soft'];
const read = () => Object.fromEntries(tokens.map(t => [t, getComputedStyle(root).getPropertyValue(t).trim()]));
const light = read();
root.dataset.theme = 'dark';
const dark = read();
delete root.dataset.theme;
const sheet = document.getElementById('sheet');
sheet.style.cssText = 'display:flex;gap:0;font:12px Tahoma, Segoe UI, sans-serif';
for (const [name, vals] of [['Light theme', light], ['Dark theme', dark]]) {
  const panel = document.createElement('div');
  for (const [k, v] of Object.entries(vals)) panel.style.setProperty(k, v);
  panel.style.cssText += ';background:var(--paper);color:var(--ink);padding:12px 16px;width:560px';
  const head = document.createElement('div');
  head.textContent = name + ' - each picture at 1x (16 px) and 2x (32 px)';
  head.style.cssText = 'font-weight:700;margin-bottom:8px';
  panel.append(head);
  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(4, 1fr);gap:6px 8px';
  for (const id of TOOL_ICON_IDS) {
    const cell = document.createElement('div');
    cell.style.cssText = 'display:flex;align-items:center;gap:8px;min-height:36px';
    const label = document.createElement('span');
    label.textContent = id;
    label.style.cssText = 'font-size:12px;color:var(--ink-soft)';
    cell.append(toolIcon(id, 16), toolIcon(id, 32), label);
    grid.append(cell);
  }
  panel.append(grid);
  sheet.append(panel);
}
window.sheetReady = true;
`;

const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };
const pages = { '/demo.html': ['text/html', DEMO_HTML], '/demo.js': ['text/javascript', DEMO_JS], '/sheet.html': ['text/html', SHEET_HTML], '/sheet.js': ['text/javascript', SHEET_JS] };

let passed = 0;
const failures = [];
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
async function newPage(options = {}) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 600 }, locale: 'en-GB', ...options });
  await context.route(`${BASE}/**`, route => {
    const path = new URL(route.request().url()).pathname;
    if (pages[path]) return route.fulfill({ status: 200, contentType: pages[path][0], body: pages[path][1] });
    const file = join(OUT, path);
    if (!file.startsWith(OUT) || !existsSync(file)) return route.fulfill({ status: 404, body: 'missing' });
    return route.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(2500);
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('console', m => m.type() === 'error' && problems.push('console: ' + m.text()));
  return page;
}
const problems = [];
let page = await newPage();
async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (error) {
    failures.push(name);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `fail-${failures.length}.png`) }).catch(() => {});
    console.log('  FAIL ' + name + '\n       ' + String(error.message).slice(0, 1200));
    await page.keyboard.press('Escape').catch(() => {});
    await page.evaluate(() => window.demo?.layer.close(false)).catch(() => {});
  }
}
const eq = (a, b, what) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const ok = (v, what) => {
  if (!v) throw new Error(what);
};
/** What has the keyboard: the text box, a title, a menu item or a button, by its text or name. */
const focused = () => page.evaluate(() => {
  const a = document.activeElement;
  if (!a || a === document.body) return 'body';
  if (a.id === 'doc') return 'doc';
  if (a.classList.contains('cbar-title')) return 'title:' + (a.dataset.menu ?? a.getAttribute('aria-label'));
  if (a.classList.contains('menu-item')) return 'item:' + a.querySelector('.menu-label')?.textContent;
  if (a.classList.contains('cbar-tool')) return 'tool:' + a.getAttribute('aria-label');
  if (a.classList.contains('menu')) return 'menu';
  return a.tagName.toLowerCase() + '.' + a.className;
});
const log = () => page.evaluate(() => window.demo.state.log.splice(0));
const openLabels = () => page.locator('.menu').last().locator(':scope > .menu-item .menu-label').allTextContents();
const menuCount = () => page.locator('.menu').count();
const toDoc = async () => {
  // A resting mouse over where a menu opens would move the highlight to the item under it (as hovering does).
  await page.mouse.move(990, 590);
  await page.evaluate(() => window.demo.layer.close(false));
  await page.locator('#doc').focus();
};

await page.goto(`${BASE}/demo.html`);
await page.waitForFunction(() => window.demo);
await page.waitForTimeout(100);

await step('roles: a menubar of menuitems with popups, a toolbar, the Alt letters underlined', async () => {
  eq(await page.locator('[role=menubar]').count(), 1, 'menubars');
  eq(await page.locator('[role=menubar] > [role=menuitem][aria-haspopup=menu]:visible').count(), 6, 'titles shown (Extra is hidden)');
  eq(await page.locator('[role=toolbar]').count(), 1, 'toolbars');
  eq(await page.locator('.cbar-title[data-menu=Format] u').textContent(), 'o', 'Format underlines its o');
  eq(await page.locator('.cbar-title[data-menu=File]').getAttribute('aria-keyshortcuts'), 'Alt+F', 'aria-keyshortcuts');
  eq(await page.evaluate(() => window.demo.badKeys), [], 'no browser-kept shortcut in the sample');
  eq(await page.locator('.cbar-title[tabindex="0"]').count(), 0, 'the menu bar is not a Tab stop until Alt or F10');
});

await step('Alt on its own puts the keyboard on the bar; the arrows move; Enter opens; Escape goes back to the text', async () => {
  await page.locator('#doc').focus();
  await page.keyboard.press('Alt');
  eq(await focused(), 'title:File', 'after Alt');
  await page.keyboard.press('ArrowRight');
  eq(await focused(), 'title:Edit', 'after Right');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  eq(await focused(), 'title:Help', 'Left from File wraps to the last shown menu');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  eq(await menuCount(), 1, 'a menu is open');
  eq(await page.locator('.cbar-title[data-menu=Edit]').getAttribute('aria-expanded'), 'true', 'Edit shows open');
  eq(await focused(), 'item:Cut', 'the first usable item (Undo is disabled and skipped)');
  await page.keyboard.press('Escape');
  eq(await menuCount(), 0, 'closed');
  eq(await focused(), 'doc', 'back in the text');
  eq(await page.locator('.cbar-title[data-menu=Edit]').getAttribute('aria-expanded'), 'false', 'Edit shows closed');
  // Alt again with the bar lit leaves it.
  await page.keyboard.press('Alt');
  await page.keyboard.press('Escape');
  eq(await focused(), 'doc', 'Escape on the bar');
  await page.keyboard.press('Alt');
  await page.keyboard.press('Alt');
  eq(await focused(), 'doc', 'second Alt');
});

await step('F10 lights the bar and F10 again goes back; a letter on the lit bar opens its menu', async () => {
  await page.locator('#doc').focus();
  await page.keyboard.press('F10');
  eq(await focused(), 'title:File', 'after F10');
  await page.keyboard.press('F10');
  eq(await focused(), 'doc', 'after F10 again');
  await page.keyboard.press('F10');
  await page.keyboard.press('v');
  eq(await openLabels(), ['Status bar', 'Zoom'], 'v opened View');
  await page.keyboard.press('Escape');
  eq(await focused(), 'doc', 'back');
});

await step('Alt+letter opens that menu; Left and Right go to the next menu; Down skips disabled; Enter runs', async () => {
  await page.locator('#doc').focus();
  await page.keyboard.press('Alt+e');
  eq(await focused(), 'item:Cut', 'Edit open on Cut');
  await page.keyboard.press('ArrowUp');
  eq(await focused(), 'item:Select all', 'Up wraps past the disabled Undo');
  await page.keyboard.press('ArrowRight');
  eq(await openLabels(), ['Status bar', 'Zoom'], 'Right opened View');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  ok((await openLabels()).includes('Save as...'), 'Left twice opened File');
  eq(await page.locator('.menu .menu-item', { hasText: 'Save' }).first().getAttribute('aria-disabled'), 'true', 'Save is disabled while nothing changed');
  eq(await focused(), 'item:New', 'File opened on its first item');
  await page.keyboard.press('Escape');
});

await step('Enter on an item runs it, closes the menu and gives the text box the keyboard', async () => {
  await toDoc();
  await page.keyboard.press('Alt+f');
  eq(await focused(), 'item:New', 'File opens on New');
  await page.keyboard.press('ArrowDown');
  eq(await focused(), 'item:Open...', 'Open');
  await page.keyboard.press('ArrowDown');
  eq(await focused(), 'item:Save as...', 'Save is disabled and skipped');
  await page.keyboard.press('Enter');
  eq(await log(), ['save-as'], 'ran');
  eq(await menuCount(), 0, 'closed');
  eq(await focused(), 'doc', 'focus returned');
});

await step('a submenu opens with Right and runs with Enter', async () => {
  await toDoc();
  await page.keyboard.press('Alt+f');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
  eq(await focused(), 'item:Recent', 'on Recent');
  await page.keyboard.press('ArrowRight');
  eq(await focused(), 'item:letter.txt', 'into the submenu');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  eq(await log(), ['recent:notes'], 'ran');
  eq(await focused(), 'doc', 'back');
});

await step('disabled items: shown greyed, skipped, a click does nothing; enabled again when their getter says so', async () => {
  await toDoc();
  await page.locator('.cbar-title[data-menu=Edit]').click();
  const undo = page.locator('.menu .menu-item', { hasText: 'Undo' });
  eq(await undo.getAttribute('aria-disabled'), 'true', 'Undo disabled');
  await undo.click({ force: true });
  eq(await log(), [], 'nothing ran');
  eq(await menuCount(), 1, 'still open');
  await page.keyboard.press('Escape');
  await toDoc();
  await page.evaluate(() => (window.demo.state.dirty = true));
  await page.keyboard.press('Alt+f');
  eq(await page.locator('.menu .menu-item', { hasText: /^Save/ }).first().getAttribute('aria-disabled'), null, 'Save enabled now');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  eq(await focused(), 'item:Save', 'Save is reached now');
  await page.keyboard.press('Escape');
});

await step('a ticked item is a menuitemcheckbox and turns over when chosen', async () => {
  await toDoc();
  await page.locator('.cbar-title[data-menu=View]').click();
  const item = page.locator('.menu [role=menuitemcheckbox]', { hasText: 'Status bar' });
  eq(await item.getAttribute('aria-checked'), 'true', 'ticked');
  await item.click();
  eq(await log(), ['status'], 'ran');
  eq(await focused(), 'doc', 'focus back after a click too');
  await page.locator('.cbar-title[data-menu=View]').click();
  eq(await page.locator('.menu [role=menuitemcheckbox]', { hasText: 'Status bar' }).getAttribute('aria-checked'), 'false', 'unticked');
  await page.keyboard.press('Escape');
});

await step('pictures show in the menu beside their items', async () => {
  await toDoc();
  await page.keyboard.press('Alt+e');
  eq(await page.locator('.menu .menu-item.cbar-has-icon svg.ti').count(), 5, 'Undo, Cut, Copy, Paste, Select all');
  await page.keyboard.press('ArrowRight');
  await page.locator('.menu .menu-item', { hasText: 'Zoom' }).hover();
  await page.locator('.menu').nth(1).waitFor();
  eq(await page.locator('.menu').nth(1).locator('svg.ti').count(), 2, 'a submenu drawn later gets them too');
  await page.keyboard.press('Escape');
  await toDoc();
});

await step('mouse: a click opens, hovering another title switches, a click on the open title closes', async () => {
  await toDoc();
  await page.locator('.cbar-title[data-menu=File]').click();
  ok((await openLabels()).includes('Print...'), 'File open');
  eq(await focused() !== 'title:File', true, 'the click did not put the keyboard on the title');
  await page.locator('.cbar-title[data-menu=Edit]').hover();
  ok((await openLabels()).includes('Paste'), 'hover switched to Edit');
  eq(await page.locator('.cbar-title[aria-expanded=true]').count(), 1, 'one title open');
  await page.locator('.cbar-title[data-menu=Edit]').click();
  eq(await menuCount(), 0, 'a click on it closed it');
  eq(await focused(), 'doc', 'and the text has the keyboard');
  await page.locator('.cbar-title[data-menu=Help]').click();
  await page.locator('#doc').click();
  eq(await menuCount(), 0, 'a click elsewhere closes');
  // The mouse runs an item.
  await page.locator('.cbar-title[data-menu=Tools]').click();
  await page.locator('.menu .menu-item', { hasText: 'Settings' }).click();
  eq(await log(), ['settings'], 'ran');
});

await step('shortcuts: shown at the right, run from the text box when the bar is asked to bind them', async () => {
  await toDoc();
  await page.keyboard.press('Alt+e');
  eq(await page.locator('.menu .menu-item', { hasText: 'Copy' }).locator('.menu-hint').textContent(), 'Ctrl+C', 'hint');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+o');
  await page.keyboard.press('F1');
  eq(await log(), ['open', 'help'], 'Ctrl+O and F1 ran');
});

await step('toolbar: one Tab stop, arrows move (skipping disabled), tooltips, a toggle shows pressed', async () => {
  await toDoc();
  await page.evaluate(() => (window.demo.state.dirty = false));
  await page.evaluate(() => window.demo.bar.refresh());
  eq(await page.locator('.cbar-tools [tabindex="0"]').count(), 1, 'one Tab stop');
  eq(await page.locator('.cbar-tool[aria-label=Save]').getAttribute('title'), 'Save (Ctrl+S)', 'tooltip');
  eq(await page.locator('.cbar-tool[aria-label=Save]').getAttribute('aria-disabled'), 'true', 'Save disabled');
  eq(await page.locator('.cbar-tool svg.ti').count(), 14, 'each of the 14 buttons has a 16 px picture');
  eq(await page.locator('.cbar-tool svg.ti').first().evaluate(s => [s.getAttribute('width'), s.getAttribute('viewBox')]), ['16', '0 0 16 16'], 'size');
  await page.keyboard.press('Shift+Tab');
  await page.locator('.cbar-tool[aria-label=New]').focus();
  await page.keyboard.press('ArrowRight');
  eq(await focused(), 'tool:Open', 'Right');
  await page.keyboard.press('ArrowRight');
  eq(await focused(), 'tool:Cut', 'Save (disabled) skipped');
  await page.keyboard.press('End');
  eq(await focused(), 'tool:Help', 'End');
  await page.keyboard.press('Home');
  eq(await focused(), 'tool:New', 'Home');
  await page.keyboard.press('ArrowLeft');
  eq(await focused(), 'tool:Help', 'Left wraps');
  eq(await page.locator('.cbar-tools [tabindex="0"]').count(), 1, 'still one Tab stop');
  await page.keyboard.press('Enter');
  eq(await log(), ['t-help'], 'Enter pressed it');
  await page.keyboard.press('Escape');
  eq(await focused(), 'doc', 'Escape gives the text back');
  // Tab from the text box lands on the remembered button, Tab again leaves the toolbar.
  await page.keyboard.press('Shift+Tab');
  eq(await focused(), 'tool:Help', 'Shift+Tab from the text box reaches the toolbar at the last button used');
  // A mouse press keeps the keyboard in the text; a toggle shows pressed.
  await page.locator('#doc').focus();
  const bold = page.locator('.cbar-tool[data-tool=bold]');
  eq(await bold.getAttribute('aria-pressed'), 'false', 'Bold up');
  await bold.click();
  eq(await focused(), 'doc', 'the click left the keyboard in the text');
  await page.waitForTimeout(50);
  eq(await bold.getAttribute('aria-pressed'), 'true', 'Bold pressed');
  await page.locator('.cbar-tool[aria-label=Undo]').click({ force: true });
  eq(await log(), ['t-bold'], 'the disabled Undo did nothing');
  // The menu sees the same state.
  await page.keyboard.press('Alt+o');
  eq(await page.locator('.menu [role=menuitemcheckbox]', { hasText: 'Bold' }).getAttribute('aria-checked'), 'true', 'Format > Bold ticked');
  await page.keyboard.press('Escape');
});

await step('a menu that comes and goes', async () => {
  await toDoc();
  await page.keyboard.press('Alt+x');
  eq(await menuCount(), 0, 'Extra is not there');
  await page.evaluate(() => {
    window.demo.state.extra = true;
    window.demo.bar.refresh();
  });
  eq(await page.locator('.cbar-title[data-menu=Extra]').isVisible(), true, 'shown');
  await page.keyboard.press('Alt+x');
  eq(await openLabels(), ['Hidden thing'], 'Alt+X opens it');
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    window.demo.state.extra = false;
    window.demo.bar.refresh();
  });
});

await step('Alt+Q and Alt+L are left to the desktop', async () => {
  await toDoc();
  const seen = await page.evaluate(() => {
    const got = [];
    const h = e => got.push(e.defaultPrevented);
    document.addEventListener('keydown', h);
    for (const key of ['q', 'l']) document.getElementById('doc').dispatchEvent(new KeyboardEvent('keydown', { key, altKey: true, bubbles: true, cancelable: true }));
    document.removeEventListener('keydown', h);
    return got;
  });
  eq(seen, [false, false], 'not taken');
  eq(await menuCount(), 0, 'no menu');
});

if (SHOTS) {
  await page.locator('.cbar-title[data-menu=Edit]').click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(SHOTS, 'menubar-light.png'), clip: { x: 0, y: 0, width: 1000, height: 330 } });
  await page.keyboard.press('Escape');
}

await step('a narrow window: menus and buttons that do not fit move into », and still work from there', async () => {
  await toDoc();
  await page.evaluate(() => (window.demo.frame.style.width = '230px'));
  await page.waitForTimeout(150);
  const more = page.locator('.cbar-menus .cbar-more');
  ok(await more.isVisible(), '» shown on the menu bar');
  const shown = await page.locator('.cbar-menus .cbar-title:visible').evaluateAll(ts => ts.map(t => t.dataset.menu ?? '»'));
  ok(shown.length < 7 && shown[shown.length - 1] === '»', `titles left: ${shown}`);
  const box = await page.locator('.cbar-menus').boundingBox();
  const last = await more.boundingBox();
  ok(last.x + last.width <= box.x + box.width + 0.5, '» is inside the bar');
  eq(await page.locator('.cbar').evaluate(b => b.scrollWidth <= b.clientWidth + 1), true, 'nothing sticks out');
  await more.click();
  const spilled = await openLabels();
  ok(spilled.includes('Help'), `» holds Help: ${spilled}`);
  await page.locator('.menu .menu-item', { hasText: 'Help' }).hover();
  await page.locator('.menu').nth(1).locator('.menu-item', { hasText: 'About' }).click();
  eq(await log(), ['about'], 'Help > About ran from »');
  // Alt+H reaches a menu in » (it opens »).
  await page.keyboard.press('Alt+h');
  ok((await openLabels()).includes('Help'), 'Alt+H opened »');
  await page.keyboard.press('Escape');
  eq(await focused(), 'doc', 'back');
  // Keyboard along the bar reaches » too.
  await page.keyboard.press('F10');
  await page.keyboard.press('End');
  eq(await focused(), 'title:More menus', 'End reaches »');
  await page.keyboard.press('Escape');
  // The toolbar.
  const tmore = page.locator('.cbar-tools .cbar-more');
  ok(await tmore.isVisible(), '» on the toolbar');
  eq(await page.locator('.cbar-tools').evaluate(b => b.scrollWidth <= b.clientWidth + 1), true, 'toolbar fits');
  await tmore.click();
  const extra = await openLabels();
  ok(extra.includes('Zoom out') && extra.includes('Help'), `toolbar » holds the rest: ${extra}`);
  eq(await page.locator('.menu svg.ti').count() > 0, true, 'with their pictures');
  await page.locator('.menu .menu-item', { hasText: 'Zoom out' }).click();
  eq(await log(), ['t-zoom-out'], 'ran from »');
  if (SHOTS) {
    await tmore.click();
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(SHOTS, 'menubar-narrow.png'), clip: { x: 0, y: 0, width: 520, height: 420 } });
    await page.keyboard.press('Escape');
  }
  // Wide again: all back.
  await page.evaluate(() => (window.demo.frame.style.width = '900px'));
  await page.waitForTimeout(150);
  eq(await more.isVisible(), false, '» gone when there is room');
  eq(await page.locator('.cbar-tools .cbar-more').isVisible(), false, 'toolbar » gone');
});

await step('dark theme: the bar and its menus take the theme colours and stay readable', async () => {
  await toDoc();
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  const colours = await page.evaluate(() => {
    const bar = getComputedStyle(document.querySelector('.cbar'));
    const title = getComputedStyle(document.querySelector('.cbar-title'));
    const icon = getComputedStyle(document.querySelector('.cbar-tool'));
    return { bg: bar.backgroundColor, ink: title.color, tool: icon.color };
  });
  eq(colours.bg, 'rgb(39, 44, 53)', 'bar background is the dark face');
  eq(colours.ink, 'rgb(230, 233, 239)', 'title text is the dark ink');
  eq(colours.tool, 'rgb(230, 233, 239)', 'pictures follow the ink');
  await page.locator('.cbar-title[data-menu=Edit]').click();
  const menu = await page.evaluate(() => {
    const m = document.querySelector('.menu');
    const label = document.querySelector('.menu .menu-item:not(:focus):not([aria-disabled=true]) .menu-label');
    return { bg: getComputedStyle(m).backgroundColor, ink: getComputedStyle(label).color };
  });
  ok(menu.bg !== menu.ink, `menu text readable: ${JSON.stringify(menu)}`);
  const lum = c => {
    const [r, g, b] = c.match(/\d+/g).map(Number).map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [a, b] = [lum(menu.bg), lum(menu.ink)].sort((x, y) => y - x);
  const contrast = (a + 0.05) / (b + 0.05);
  ok(contrast >= 4.5, `menu text contrast ${contrast.toFixed(2)} (${JSON.stringify(menu)})`);
  if (SHOTS) await page.waitForTimeout(250);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'menubar-dark.png'), clip: { x: 0, y: 0, width: 1000, height: 330 } });
  await page.keyboard.press('Escape');
  await page.evaluate(() => delete document.documentElement.dataset.theme);
});

await step('every picture parses as SVG with a 16x16 view box and draws inside it', async () => {
  const report = await page.evaluate(async () => {
    const { TOOL_ICON_IDS, toolIconMarkup, toolIcon } = await import('/app/shell/toolicons.js');
    const bad = [];
    const host = document.createElement('div');
    document.body.append(host);
    for (const id of TOOL_ICON_IDS) {
      const doc = new DOMParser().parseFromString(toolIconMarkup(id), 'image/svg+xml');
      if (doc.querySelector('parsererror') || doc.documentElement.getAttribute('viewBox') !== '0 0 16 16') bad.push(id + ': does not parse');
      const el = toolIcon(id);
      host.append(el);
      const b = el.getBBox();
      // Line halves reach half a pixel past a shape's edge; the drawing must stay on the 16 square.
      if (b.x < -0.01 || b.y < -0.01 || b.x + b.width > 16.01 || b.y + b.height > 16.01 || b.width < 4 || b.height < 2) bad.push(`${id}: box ${b.x},${b.y} ${b.width}x${b.height}`);
    }
    host.remove();
    return { count: TOOL_ICON_IDS.length, bad };
  });
  eq(report.bad, [], 'bad pictures');
  ok(report.count >= 55, `count ${report.count}`);
});
await page.context().close();

page = await newPage({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 700 } });
await page.goto(`${BASE}/demo.html`);
await page.waitForFunction(() => window.demo);
await step('touch: a tap opens a menu, a tap on an item runs it; titles and buttons are finger-sized', async () => {
  await page.evaluate(() => (window.demo.frame.style.width = '300px'));
  await page.waitForTimeout(150);
  await page.locator('.cbar-title[data-menu=Edit]').tap();
  ok((await openLabels()).includes('Copy'), 'Edit open');
  await page.locator('.menu .menu-item', { hasText: 'Copy' }).tap();
  eq(await log(), ['copy'], 'ran');
  eq(await menuCount(), 0, 'closed');
  const sizes = await page.evaluate(() => [document.querySelector('.cbar-title').getBoundingClientRect().height, document.querySelector('.cbar-tool').getBoundingClientRect().height]);
  ok(sizes[0] >= 36 && sizes[1] >= 40, `sizes ${sizes}`);
  ok(await page.locator('.cbar-menus .cbar-more').isVisible(), 'a phone-width window uses »');
});
await page.context().close();

if (SHOTS) {
  page = await newPage({ viewport: { width: 1120, height: 800 }, deviceScaleFactor: 1 });
  await page.goto(`${BASE}/sheet.html`);
  await page.waitForFunction(() => window.sheetReady);
  await page.locator('#sheet').screenshot({ path: join(SHOTS, 'icons.png') });
  console.log('  icon sheet: ' + join(SHOTS, 'icons.png'));
  await page.context().close();
}

await browser.close();
if (problems.length) {
  failures.push('page errors');
  console.log('  FAIL page errors\n       ' + problems.join('\n       '));
}
console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? ': ' + failures.join('; ') : ''}`);
process.exit(failures.length ? 1 : 0);
