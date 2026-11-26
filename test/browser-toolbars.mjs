// Drives the named toolbars (src/shell/toolbars.ts, through the classic bar in menubar.ts) in a real Chrome on a page
// of their own: four toolbars over a work area. Each has a grip; View > Toolbars shows and hides them, docks them Top,
// Left or Right and resets them; dragging a grip reorders the rows and docks a toolbar left or right (a guide shows
// where; Escape leaves it); the arrow keys on a grip do the same; a long toolbar wraps in a narrow window; a side
// toolbar goes up to the top when the work area would be too narrow; one taller than the window keeps a » menu; the
// layout is kept and comes back when the bar is made again; a broken kept layout gives the usual one; a finger drags
// too; and the dark theme.
// Needs `npm run build` done. No server: the page and the built files are handed to the browser straight from out/.
//   node test/browser-toolbars.mjs [folder for screenshots]
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'out');
const SHOTS = process.argv[2] ?? null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://toolbars.localhost';
if (!existsSync(join(OUT, 'app', 'shell', 'toolbars.js'))) {
  console.error('Run `npm run build` first (out/app/shell/toolbars.js is missing).');
  process.exit(1);
}

const DEMO_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Toolbars</title><link rel="stylesheet" href="/style.css"></head>
<body><div id="frame"><div id="app"></div></div><div id="layer-menus"></div>
<script type="module" src="/demo.js"></script></body></html>`;

const DEMO_JS = `
import { classicBar } from '/app/shell/menubar.js';
import { MenuLayer } from '/app/shell/menu.js';
const frame = document.getElementById('frame');
frame.style.cssText = 'position:fixed;left:20px;top:20px;width:900px;height:460px;background:var(--paper);border:1px solid var(--line)';
const app = document.getElementById('app');
app.style.cssText = 'display:flex;flex-direction:column;height:100%';
const layer = new MenuLayer(document.getElementById('layer-menus'));
const state = { log: [], saved: null, saves: 0, bold: false };
const run = name => () => state.log.push(name);
const pics = ['new', 'open', 'save', 'print', 'undo', 'redo', 'cut', 'copy', 'paste', 'delete', 'find', 'replace', 'bold', 'italic', 'underline', 'zoom-in', 'zoom-out', 'zoom-fit', 'refresh', 'help', 'sort', 'filter', 'sum', 'chart'];
const toolbars = [
  { id: 'standard', name: 'Standard', tools: [
    { label: 'New', icon: 'new', action: run('new') }, { label: 'Open', icon: 'open', action: run('open') }, { label: 'Save', icon: 'save', action: run('save') }, '|',
    { label: 'Undo', icon: 'undo', enabled: () => false, action: run('undo') }, { label: 'Redo', icon: 'redo', action: run('redo') },
  ] },
  { id: 'format', name: 'Format', tools: [
    { label: 'Bold', icon: 'bold', pressed: () => state.bold, action: () => { state.bold = !state.bold; state.log.push('bold'); } },
    { label: 'Italic', icon: 'italic', action: run('italic') }, { label: 'Underline', icon: 'underline', action: run('underline') },
  ] },
  { id: 'long', name: 'Long', tools: pics.map((p, i) => ({ label: 'Long ' + (i + 1), icon: p, action: run('long ' + (i + 1)) })) },
  { id: 'side', name: 'Side', side: 'left', tools: [
    { label: 'Zoom in', icon: 'zoom-in', action: run('zoom-in') }, { label: 'Zoom out', icon: 'zoom-out', action: run('zoom-out') }, { label: 'Zoom fit', icon: 'zoom-fit', action: run('zoom-fit') },
  ] },
];
let current = null;
/** Makes the bar (again), as opening the app does, from what was kept. */
function make(saved) {
  if (current) {
    current.abort.abort();
    app.replaceChildren();
  }
  const abort = new AbortController();
  const work = document.createElement('div');
  work.id = 'work';
  work.tabIndex = -1;
  work.textContent = 'Work area';
  work.style.cssText = 'background:var(--paper);color:var(--ink);padding:6px';
  const menus = [
    { label: 'File', items: [{ label: 'Close', action: run('close') }] },
    { label: 'Edit', items: [{ label: 'Cut', action: run('cut') }] },
    { label: 'View', items: [{ label: 'Status bar', checked: () => true, action: run('status') }] },
    { label: 'Help', items: [{ label: 'About', action: run('about') }] },
  ];
  const bar = classicBar({ menus, toolbars: toolbars.map(t => ({ ...t })) }, {
    layer, signal: abort.signal, scope: app, doc: () => work,
    layout: { saved, save: v => { state.saved = JSON.parse(JSON.stringify(v)); state.saves++; } },
  });
  app.append(bar.el, bar.dock(work));
  current = { bar, abort, work };
  window.demo.bar = bar;
  return bar;
}
window.demo = { state, layer, frame, make, bar: null };
make(null);
`;

const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };
const pages = { '/demo.html': ['text/html', DEMO_HTML], '/demo.js': ['text/javascript', DEMO_JS] };

let passed = 0;
const failures = [];
const problems = [];
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
const page = await newPage();
async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (error) {
    failures.push(name);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `toolbars-fail-${failures.length}.png`) }).catch(() => {});
    console.log('  FAIL ' + name + '\n       ' + String(error.message).slice(0, 1200));
    await page.mouse.up().catch(() => {});
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
const settle = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
const band = id => page.locator(`[data-toolbar="${id}"]`);
const grip = id => band(id).locator('.cbar-grip');
/** Which toolbars are in each dock, in order (hidden ones left out). */
const docks = () => page.evaluate(() => Object.fromEntries(['top', 'left', 'right'].map(side => [side, [...document.querySelectorAll(`.cbar-dock[data-side="${side}"] > .cbar-band`)].filter(b => !b.hidden).map(b => b.dataset.toolbar)])));
const layout = () => page.evaluate(() => window.demo.bar.toolbars.layout().map(p => `${p.id}:${p.side}${p.shown ? '' : '(hidden)'}`).join(' '));
const saved = () => page.evaluate(() => window.demo.state.saved);
const box = async loc => (await loc.boundingBox());
async function make(savedValue) {
  await page.evaluate(v => window.demo.make(v), savedValue);
  await settle();
  await settle();
}
async function resetAll() {
  await page.evaluate(() => { window.demo.frame.style.width = '900px'; window.demo.frame.style.height = '460px'; window.demo.state.saves = 0; });
  await make(null);
}
/** Drags a toolbar by its grip to (x, y); `beforeUp` runs with the pointer still pressed. */
async function drag(id, x, y, beforeUp) {
  const g = await box(grip(id));
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2 + 10, g.y + g.height / 2 + 10, { steps: 3 });
  await page.mouse.move(x, y, { steps: 6 });
  if (beforeUp) await beforeUp();
  await page.mouse.up();
  await settle();
  await settle();
}
const workBox = () => box(page.locator('#work'));
async function viewToolbars() {
  await page.getByRole('menuitem', { name: 'View' }).click();
  await page.locator('.menu .menu-item', { hasText: 'Toolbars' }).first().click();
}

await page.goto(`${BASE}/demo.html`);
await page.waitForFunction(() => window.demo?.bar);
await settle();

await step('each toolbar is a named toolbar with a grip (⋮) at its start, told as "Move <name> toolbar"', async () => {
  eq(await page.locator('.cbar-band').evaluateAll(els => els.map(e => [e.getAttribute('role'), e.getAttribute('aria-label')])), [['toolbar', 'Standard'], ['toolbar', 'Format'], ['toolbar', 'Long'], ['toolbar', 'Side']], 'toolbars');
  for (const [id, name] of [['standard', 'Standard'], ['side', 'Side']]) {
    const g = grip(id);
    eq(await g.getAttribute('aria-label'), `Move ${name} toolbar`, 'grip name');
    eq(await g.getAttribute('title'), `Move ${name} toolbar`, 'grip tooltip');
    eq(await g.innerText(), '⋮', 'three dots');
    eq(await g.evaluate(el => el === el.parentElement.firstElementChild), true, 'first in its toolbar');
    eq(await g.evaluate(el => el.tabIndex), 0, 'can take the keyboard');
    eq(await g.evaluate(el => getComputedStyle(el).touchAction), 'none', 'a finger drags it rather than scrolling');
  }
  eq(await docks(), { top: ['standard', 'format', 'long'], left: ['side'], right: [] }, 'the usual places');
  const g = await box(grip('standard'));
  const first = await box(band('standard').locator('.cbar-tool').first());
  ok(g.x < first.x, 'the grip is on the left of the buttons');
  eq(await band('side').getAttribute('aria-orientation'), 'vertical', 'the side toolbar stands up');
  const btns = await band('side').locator('.cbar-tool:not(.cbar-more)').evaluateAll(els => els.map(e => e.getBoundingClientRect()).map(r => [Math.round(r.x), Math.round(r.y)]));
  ok(btns.every(b => b[0] === btns[0][0]) && btns.every((b, i) => !i || b[1] > btns[i - 1][1]), `its buttons are stacked: ${JSON.stringify(btns)}`);
  const font = await page.locator('.cbar-grip, .cbar-band').evaluateAll(els => Math.min(...els.map(e => parseFloat(getComputedStyle(e).fontSize))));
  ok(font >= 12, `no text smaller than 12 px: ${font}`);
});

await step('View > Toolbars: a tick for each toolbar, Position, and Reset toolbars, at the top of View', async () => {
  await page.getByRole('menuitem', { name: 'View' }).click();
  eq((await page.locator('.menu').last().locator(':scope > .menu-item .menu-label').allTextContents())[0], 'Toolbars', 'first in View');
  await page.locator('.menu .menu-item', { hasText: 'Toolbars' }).first().click();
  eq(await page.locator('.menu').last().locator(':scope > .menu-item .menu-label').allTextContents(), ['Standard', 'Format', 'Long', 'Side', 'Position', 'Reset toolbars'], 'Toolbars menu');
  eq(await page.locator('.menu').last().locator(':scope > .menu-item[role="menuitemcheckbox"][aria-checked="true"]').count(), 4, 'all ticked');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
});

await step('hide and show: View > Toolbars > Format takes it away and brings it back; the change is kept', async () => {
  await viewToolbars();
  await page.locator('.menu').last().locator('.menu-item', { hasText: 'Format' }).click();
  await settle();
  ok(await band('format').isHidden(), 'Format hidden');
  eq((await docks()).top, ['standard', 'long'], 'the others stay');
  eq((await saved()).bars.find(b => b.id === 'format').shown, false, 'kept hidden');
  await viewToolbars();
  eq(await page.locator('.menu').last().locator('.menu-item', { hasText: 'Format' }).getAttribute('aria-checked'), 'false', 'unticked');
  await page.locator('.menu').last().locator('.menu-item', { hasText: 'Format' }).click();
  await settle();
  ok(await band('format').isVisible(), 'Format back');
  eq((await docks()).top, ['standard', 'format', 'long'], 'in its place');
});

await step('drag to the left: a guide shows where; it lands as a column beside the other, standing up', async () => {
  await resetAll();
  const w = await workBox();
  let guide = null;
  await drag('format', w.x + 8, w.y + w.height / 2, async () => {
    guide = await page.locator('.cbar-guide').evaluate(el => ({ shown: !el.hidden && el.isConnected, side: el.dataset.side, r: el.getBoundingClientRect().toJSON() }));
  });
  ok(guide?.shown && guide.side === 'left' && guide.r.height > 100, `guide for the left: ${JSON.stringify(guide)}`);
  eq(await page.locator('.cbar-guide').count(), 0, 'guide gone after');
  eq(await docks(), { top: ['standard', 'long'], left: ['side', 'format'], right: [] }, 'docked left, after Side');
  eq(await band('format').getAttribute('aria-orientation'), 'vertical', 'standing up');
  const a = await box(band('side'));
  const b = await box(band('format'));
  ok(b.x >= a.x + a.width - 1 && Math.abs(a.y - b.y) < 2, `side by side: ${JSON.stringify([a, b])}`);
  const work = await workBox();
  ok(work.x >= b.x + b.width - 1, 'the work area starts after them');
  eq(await layout(), 'standard:top long:top side:left format:left', 'layout');
  eq((await saved()).bars.map(p => `${p.id}:${p.side}`).join(' '), 'standard:top long:top side:left format:left', 'kept');
});

await step('drag to the right, and back to the top between two rows', async () => {
  const w = await workBox();
  await drag('standard', w.x + w.width - 8, w.y + w.height / 2);
  eq(await docks(), { top: ['long'], left: ['side', 'format'], right: ['standard'] }, 'Standard on the right');
  const r = await box(band('standard'));
  const w2 = await workBox();
  ok(r.x >= w2.x + w2.width - 1, 'right of the work area');
  // Back up, in front of Long.
  const l = await box(band('long'));
  await drag('standard', l.x + 20, l.y + l.height / 2);
  eq(await docks(), { top: ['standard', 'long'], left: ['side', 'format'], right: [] }, 'Standard back up, first');
  eq(await band('standard').getAttribute('aria-orientation'), 'horizontal', 'lying down again');
});

await step('reorder the rows across the top by dragging', async () => {
  await resetAll();
  const s = await box(band('standard'));
  await drag('long', s.x + 4, s.y + s.height / 2);
  eq((await docks()).top, ['long', 'standard', 'format'], 'Long first');
  const f = await box(band('format'));
  await drag('long', f.x + f.width - 2, f.y + f.height / 2);
  eq((await docks()).top, ['standard', 'format', 'long'], 'Long last again');
});

await step('Escape during a drag leaves the toolbar where it was', async () => {
  await resetAll();
  const w = await workBox();
  await drag('format', w.x + 8, w.y + w.height / 2, async () => {
    await page.keyboard.press('Escape');
    eq(await page.locator('.cbar-guide').count(), 0, 'guide gone at once');
  });
  eq(await docks(), { top: ['standard', 'format', 'long'], left: ['side'], right: [] }, 'nothing moved');
  eq(await page.evaluate(() => window.demo.state.saves), 0, 'nothing kept');
  // A press and let go without moving is not a drag.
  await grip('format').click();
  await settle();
  eq((await docks()).top, ['standard', 'format', 'long'], 'a click moves nothing');
});

await step('a narrow window: a long toolbar wraps onto more rows, no » and nothing past the edge', async () => {
  await resetAll();
  const oneRow = (await box(band('long'))).height;
  await page.evaluate(() => (window.demo.frame.style.width = '340px'));
  await settle();
  await settle();
  const l = await box(band('long'));
  const f = await box(page.locator('#frame'));
  ok(l.height >= oneRow * 1.8, `wrapped: ${oneRow} high before, ${l.height} now`);
  ok(l.x + l.width <= f.x + f.width + 1, 'inside the window');
  const right = await band('long').locator('.cbar-tool').evaluateAll(els => Math.max(...els.filter(e => !e.hidden).map(e => e.getBoundingClientRect().right)));
  ok(right <= f.x + f.width, `every button inside: ${right} <= ${f.x + f.width}`);
  eq(await page.locator('.cbar-dock-top .cbar-more:visible').count(), 0, 'no » across the top');
  eq(await band('long').locator('.cbar-tool:visible').count(), 24, 'all 24 buttons shown');
});

await step(`a side toolbar goes up to the top while the work area would be narrower than 400 px, and back when there is room`, async () => {
  await resetAll();
  await page.evaluate(() => (window.demo.frame.style.width = '420px'));
  await settle();
  await settle();
  eq(await docks(), { top: ['standard', 'format', 'long', 'side'], left: [], right: [] }, 'Side up at the top');
  ok(await band('side').evaluate(el => el.classList.contains('cbar-fallback')), 'marked as up for want of room');
  eq(await layout(), 'standard:top format:top long:top side:left', 'its kept place is still the left');
  await page.evaluate(() => (window.demo.frame.style.width = '900px'));
  await settle();
  await settle();
  eq(await docks(), { top: ['standard', 'format', 'long'], left: ['side'], right: [] }, 'back on the left');
});

await step('a side toolbar taller than the window keeps a » menu for the buttons that do not fit', async () => {
  await resetAll();
  await page.evaluate(() => window.demo.bar.toolbars.place('long', 'right'));
  await settle();
  await settle();
  const more = band('long').locator('.cbar-more');
  ok(await more.isVisible(), '» shown');
  const shown = await band('long').locator('.cbar-tool:not(.cbar-more):visible').count();
  ok(shown > 3 && shown < 24, `some buttons fit: ${shown}`);
  const b = await box(band('long'));
  const m = await box(more);
  ok(m.y + m.height <= b.y + b.height + 1, '» inside the toolbar');
  await more.click();
  const items = await page.locator('.menu').last().locator(':scope > .menu-item .menu-label').allTextContents();
  eq(items.length, 24 - shown, 'the rest are in »');
  eq(items[0], `Long ${shown + 1}`, 'in order');
  await page.locator('.menu').last().locator('.menu-item').first().click();
  eq(await page.evaluate(() => window.demo.state.log.splice(0)), [`long ${shown + 1}`], 'and run from there');
});

await step('keyboard: with the grip focused, Left and Right dock it, Up goes up a row or to the top, Down a row down', async () => {
  await resetAll();
  await grip('format').focus();
  await page.keyboard.press('ArrowLeft');
  await settle();
  eq(await docks(), { top: ['standard', 'long'], left: ['side', 'format'], right: [] }, 'Left');
  eq(await page.evaluate(() => document.activeElement?.dataset.grip), 'format', 'the grip keeps the keyboard');
  await page.keyboard.press('ArrowLeft');
  await settle();
  eq((await docks()).left, ['format', 'side'], 'Left again: one column further out');
  await page.keyboard.press('ArrowRight');
  await settle();
  eq(await docks(), { top: ['standard', 'long'], left: ['side'], right: ['format'] }, 'Right');
  await page.keyboard.press('ArrowUp');
  await settle();
  eq((await docks()).top, ['standard', 'long', 'format'], 'Up from a side: to the top, last');
  await page.keyboard.press('ArrowUp');
  await settle();
  eq((await docks()).top, ['standard', 'format', 'long'], 'Up: the row before');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await settle();
  eq((await docks()).top, ['format', 'standard', 'long'], 'first, and no further');
  await page.keyboard.press('ArrowDown');
  await settle();
  eq((await docks()).top, ['standard', 'format', 'long'], 'Down: the row after');
  eq(await page.evaluate(() => document.activeElement?.dataset.grip), 'format', 'still on the grip');
  await page.keyboard.press('Escape');
  eq(await page.evaluate(() => document.activeElement?.id), 'work', 'Escape gives the keyboard back to the work area');
  // The buttons stay one Tab stop after the grip, with the arrows inside.
  await grip('standard').focus();
  await page.keyboard.press('Tab');
  eq(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'New', 'Tab from the grip: the first button');
  await page.keyboard.press('ArrowRight');
  eq(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Open', 'arrows move along');
});

await step('View > Toolbars > Position > Format > Right docks it there for keyboard users', async () => {
  await resetAll();
  await viewToolbars();
  await page.locator('.menu').last().locator('.menu-item', { hasText: 'Position' }).click();
  await page.locator('.menu').last().locator('.menu-item', { hasText: 'Format' }).click();
  eq(await page.locator('.menu').last().locator(':scope > .menu-item .menu-label').allTextContents(), ['Top', 'Left', 'Right'], 'the three places');
  eq(await page.locator('.menu').last().locator('.menu-item', { hasText: 'Top' }).getAttribute('aria-checked'), 'true', 'Top ticked');
  await page.locator('.menu').last().locator('.menu-item', { hasText: 'Right' }).click();
  await settle();
  eq(await docks(), { top: ['standard', 'long'], left: ['side'], right: ['format'] }, 'Format on the right');
});

await step('the layout is kept and comes back when the bar is made again (as reopening the app)', async () => {
  const kept = await saved();
  ok(kept && kept.v === 1, 'kept: ' + JSON.stringify(kept));
  await page.evaluate(() => window.demo.bar.toolbars.show('long', false));
  const kept2 = await saved();
  await make(kept2);
  eq(await docks(), { top: ['standard'], left: ['side'], right: ['format'] }, 'the same places');
  ok(await band('long').isHidden(), 'Long still hidden');
  eq(await layout(), 'standard:top long:top(hidden) side:left format:right', 'layout');
});

await step('a broken kept layout gives the usual toolbars, with no error', async () => {
  const before = problems.length;
  for (const bad of ['nonsense', 42, { bars: 'x' }, { v: 1, bars: [{ id: 'nope', side: 'top', shown: true }] }, { v: 1, bars: [{ id: 'format', side: 'sideways', shown: true }] }, [null]]) {
    await make(bad);
    eq(await docks(), { top: ['standard', 'format', 'long'], left: ['side'], right: [] }, `usual for ${JSON.stringify(bad)}`);
  }
  eq(problems.slice(before), [], 'no errors');
});

await step('Reset toolbars puts them all back where they started, shown', async () => {
  await make({ v: 1, bars: [{ id: 'long', side: 'right', shown: true }, { id: 'standard', side: 'left', shown: false }, { id: 'format', side: 'top', shown: true }, { id: 'side', side: 'top', shown: true }] });
  eq(await docks(), { top: ['format', 'side'], left: [], right: ['long'] }, 'moved about');
  await viewToolbars();
  await page.locator('.menu').last().locator('.menu-item', { hasText: 'Reset toolbars' }).click();
  await settle();
  eq(await docks(), { top: ['standard', 'format', 'long'], left: ['side'], right: [] }, 'usual places');
  eq(await layout(), 'standard:top format:top long:top side:left', 'all shown');
  eq((await saved()).bars.length, 4, 'and kept');
});

await step('a finger drags a toolbar by its grip too', async () => {
  await resetAll();
  const g = await box(grip('format'));
  const w = await workBox();
  await page.evaluate(({ g, w }) => {
    const el = document.querySelector('[data-toolbar="format"] .cbar-grip');
    const at = (type, x, y) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', isPrimary: true, button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y }));
    at('pointerdown', g.x + 4, g.y + 8);
    at('pointermove', g.x + 20, g.y + 30);
    at('pointermove', w.x + w.width - 10, w.y + 100);
    at('pointerup', w.x + w.width - 10, w.y + 100);
  }, { g, w });
  await settle();
  eq((await docks()).right, ['format'], 'docked right by a finger');
});

await step('dark theme: the toolbars, grips and docks take the theme colours', async () => {
  await resetAll();
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await settle();
  const c = await page.evaluate(() => {
    const css = el => getComputedStyle(el);
    const root = css(document.documentElement);
    return {
      face: root.getPropertyValue('--face').trim(), ink: root.getPropertyValue('--ink').trim(),
      bar: css(document.querySelector('.cbar')).backgroundColor, side: css(document.querySelector('.cbar-dock-side')).backgroundColor,
      grip: css(document.querySelector('.cbar-grip')).color, tool: css(document.querySelector('.cbar-band .cbar-tool')).color,
    };
  });
  const rgb = hex => { const n = parseInt(hex.slice(1), 16); return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`; };
  eq(c.bar, rgb(c.face), 'bar on the dark face');
  eq(c.side, rgb(c.face), 'side dock on the dark face');
  eq(c.tool, rgb(c.ink), 'buttons in the dark ink');
  ok(c.grip !== c.side, 'grip readable');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'toolbars-dark.png') });
  await page.evaluate(() => delete document.documentElement.dataset.theme);
});

await step('no errors in the console', async () => {
  eq(problems, [], 'console');
});

await browser.close();
console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? ': ' + failures.join('; ') : ''}`);
process.exit(failures.length ? 1 : 0);
