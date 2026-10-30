// A second look at the desktop in a real browser (October 2026 retest), outside the Office apps: a maximised window
// coming back from the taskbar, an app shortcut's label after the desktop refreshes, Explorer's Alt+arrow keys,
// and two cross-cutting probes of the everyday apps: text that cannot be read in the Dark theme, and windows that
// scroll sideways or lose their Close button at phone width. Each step was written to catch a fault read in the code
// or to look where nobody had; one that fails points at that fault.
// Needs the dev server on a FRESH, EMPTY data folder and `npm run build` done.
//   node test/browser-retest.mjs [http://127.0.0.1:3043]
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3043';
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
let passed = 0;
const failures = [];
const ok = (cond, what) => {
  if (cond) passed++;
  else failures.push(what);
  console.log((cond ? '  ok   ' : '  FAIL ') + what);
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
const p = await context.newPage();
p.on('pageerror', e => failures.push(`page error: ${e.message}`));
await p.goto(BASE);
const first = await Promise.race([
  p.locator('.gate h1', { hasText: 'Set up' }).waitFor({ timeout: 30000 }).then(() => 'setup'),
  p.getByRole('button', { name: 'Log in for more' }).waitFor({ timeout: 30000 }).then(() => 'reader'),
]);
if (first === 'setup') {
  await p.getByLabel('Your name').fill('Retest');
  await p.getByLabel('User name (for signing in)').fill('tester');
  await p.locator('.gate input[type=password]').fill('browser-test-passphrase-1');
  await p.locator('.gate-go').click();
  await p.locator('.gate h1', { hasText: 'Your recovery key' }).waitFor({ timeout: 30000 });
  await p.locator('.gate .check-row input').click();
  await p.getByRole('button', { name: 'Continue' }).click();
} else {
  await p.getByRole('button', { name: 'Log in for more' }).click();
  await p.getByLabel('Username').fill('tester');
  await p.locator('input[type=password]').first().fill('browser-test-passphrase-1');
  await p.getByRole('button', { name: 'Log in', exact: true }).click();
}
await p.locator('#desktop .item').first().waitFor({ timeout: 30000 });

async function openApp(name) {
  await p.locator('.start-btn').click();
  await p.locator('.start-filter').fill(name);
  await p.locator('.start-menu .start-item', { hasText: name }).first().click();
  await p.locator('.win.active').waitFor();
  await p.waitForTimeout(400);
  return p.locator('.win.active');
}
async function closeActive() {
  const close = p.locator('.win.active .win-close');
  if (!(await close.count())) return;
  await close.click();
  await p.waitForTimeout(300);
  const discard = p.locator('.dialog button', { hasText: /Close|Discard|Don.t save|Don.t keep/ }).first();
  if (await discard.count()) await discard.click();
  await p.waitForTimeout(200);
}
async function closeAll() {
  for (let i = 0; i < 12 && (await p.locator('.win').count()); i++) await closeActive();
}

// ---- A maximised window, minimised from the taskbar, comes back maximised ----------------------------------------------
{
  const win = await openApp('Notepad');
  await win.locator('.win-btn[aria-label="Maximise"]').click();
  await p.waitForTimeout(200);
  ok((await win.locator('.win-btn[aria-label="Restore"]').count()) === 1, 'Notepad is maximised');
  const task = p.locator('#taskbar .task[data-win]').first();
  await task.click(); // in front already: minimise
  await p.waitForTimeout(200);
  await task.click(); // bring it back
  await p.waitForTimeout(300);
  const back = p.locator('.win.active');
  ok((await back.locator('.win-btn[aria-label="Restore"]').count()) === 1, 'brought back from the taskbar, it is still maximised (the button still says Restore)');
  const box = await back.boundingBox();
  ok(box && box.width >= 1000, `and still fills the screen (${Math.round(box?.width ?? 0)}px wide)`);
  await closeAll();
}

// ---- An app shortcut's label after the desktop refreshes ----------------------------------------------------------------
{
  const addShortcut = async (title) => {
    await p.locator('.start-btn').click();
    await p.locator('.start-filter').fill(title);
    await p.locator('.start-menu .start-item', { hasText: title }).first().click({ button: 'right' });
    await p.locator('.menu-item', { hasText: /Add to desktop/i }).click();
    await p.waitForTimeout(600);
    await p.keyboard.press('Escape');
  };
  try {
    await addShortcut('Notepad');
    const shortcut = p.locator('#desktop .item[title$=".desktop"]').first();
    await shortcut.waitFor({ timeout: 10000 });
    const label1 = (await shortcut.locator('.item-name').textContent()) ?? '';
    ok(!label1.endsWith('.desktop'), `a new shortcut shows the app's name, not the file name ("${label1}")`);
    await addShortcut('Calculator');
    await p.waitForTimeout(800);
    const label2 = (await p.locator('#desktop .item[title="Notepad.desktop"] .item-name').textContent()) ?? '';
    ok(!label2.endsWith('.desktop'), `after the desktop folder changed, the first shortcut still shows the app's name ("${label2}")`);
  } catch (e) {
    ok(false, `shortcut label: ${e.message.split('\n')[0]}`);
  }
  await p.keyboard.press('Escape');
}

// ---- Explorer: Ctrl+Alt+Left (snap left) must not also go Back --------------------------------------------------------
try {
  const win = await openApp('File Explorer');
  await win.locator('.item', { hasText: 'Documents' }).first().dblclick();
  await p.waitForTimeout(500);
  const title = async () => (await p.locator('.win.active .win-title-text').textContent()) ?? '';
  ok((await title()).includes('Documents'), `Explorer opened Documents ("${await title()}")`);
  await p.keyboard.press('Control+Alt+ArrowLeft');
  await p.waitForTimeout(500);
  ok((await title()).includes('Documents'), `Ctrl+Alt+Left (snap) did not also go Back ("${await title()}")`);
} catch (e) {
  ok(false, `Explorer keys: ${e.message.split('\n')[0]}`);
}
await closeAll();

// ---- Big windows open wholly on screen (CAD Draft's Close button sat 84 px off the right edge) -----------------------------
const rectOf = win => win.evaluate(w => {
  const r = w.getBoundingClientRect();
  const close = w.querySelector('.win-close').getBoundingClientRect();
  const bar = document.querySelector('#taskbar').getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), right: Math.round(r.right), bottom: Math.round(r.bottom), w: Math.round(r.width), closeRight: Math.round(close.right), barTop: Math.round(bar.top) };
});
const dragBar = async (win, dx, dy) => {
  const b = await win.locator('.win-bar').boundingBox();
  const x = b.x + 80, y = b.y + b.height / 2;
  await p.mouse.move(x, y);
  await p.mouse.down();
  await p.mouse.move(x + dx / 2, y + dy / 2, { steps: 3 });
  await p.mouse.move(x + dx, y + dy, { steps: 3 });
  await p.mouse.up();
  await p.waitForTimeout(150);
};
try {
  await openApp('Notepad');
  await openApp('Calculator');
  const cad = await openApp('CAD Draft');
  const r = await rectOf(cad);
  ok(r.right <= 1024 && r.closeRight <= 1024, `CAD Draft, with two windows already open, opens with its right edge and Close button on a 1024 px screen (right ${r.right}, Close ${r.closeRight})`);
  ok(r.x >= 0 && r.y >= 0 && r.bottom <= r.barTop, `and its bottom stops at the taskbar, the bar along the screen's edge (bottom ${r.bottom}, taskbar ${r.barTop})`);
  await closeAll();
  const rw = await rectOf(await openApp('Write'));
  ok(rw.right <= 1024 && rw.x >= 0, `Write opens with its right edge on screen (right ${rw.right})`);
} catch (e) {
  ok(false, `big windows: ${e.message.split('\n')[0]}`);
}
await closeAll();

// ---- ...and that leaves moving, snapping and a remembered place alone --------------------------------------------------------
try {
  let win = await openApp('Notepad');
  const start = await rectOf(win);
  await dragBar(win, 120, 90);
  const moved = await rectOf(win);
  ok(moved.x === start.x + 120 && moved.y === start.y + 90, `a window goes where it is dragged (${moved.x}, ${moved.y})`);
  await closeAll();
  win = await openApp('Notepad');
  const again = await rectOf(win);
  ok(again.x === moved.x && again.y === moved.y && again.w === moved.w, `closed and opened again, it comes back to the place it remembered (${again.x}, ${again.y})`);
  await p.keyboard.press('Control+Alt+ArrowLeft');
  await p.waitForTimeout(200);
  const snapped = await rectOf(win);
  ok(snapped.x === 0 && snapped.y === 0 && snapped.w === 512, `Ctrl+Alt+Left still snaps it to the left half of the screen (x ${snapped.x}, ${snapped.w} px wide)`);
  await p.keyboard.press('Control+Alt+ArrowDown');
  await p.waitForTimeout(200);
  const back = await rectOf(win);
  ok(back.x === moved.x && back.y === moved.y && back.w === moved.w, `Ctrl+Alt+Down puts it back where it was (${back.x}, ${back.y})`);
  await dragBar(win, 1024 - moved.x - 200, 0);
  const off = await rectOf(win);
  ok(off.right > 1024, `a window can still be dragged partly past the screen's edge (right ${off.right})`);
  await closeAll();
  const pulled = await rectOf(await openApp('Notepad'));
  ok(pulled.right <= 1024 && pulled.closeRight <= 1024, `opened again from there, it is pulled back so Close can be reached (right ${pulled.right})`);
} catch (e) {
  ok(false, `moving and snapping: ${e.message.split('\n')[0]}`);
}
await closeAll();

// ---- Open and Save dialogs do not scroll sideways (532 px of content in 414 px) ---------------------------------------------
const openSaveAs = async () => {
  const win = await openApp('Write');
  await win.locator('.wp-doc').focus();
  await p.keyboard.press('Control+Shift+S');
  await p.locator('.dialog .pick').waitFor({ timeout: 10000 });
  await p.waitForTimeout(300);
};
const dialogFits = () => p.locator('.dialog:has(.pick)').evaluate(d => ({ sw: d.scrollWidth, cw: d.clientWidth, right: Math.round(d.getBoundingClientRect().right), screen: innerWidth }));
try {
  await openSaveAs();
  const d = await dialogFits();
  ok(d.sw <= d.cw, `the Save as dialog does not scroll sideways (${d.sw} px of content in ${d.cw} px)`);
  ok(d.right <= d.screen, `and it stays on screen (right ${d.right} of ${d.screen})`);
  await p.keyboard.press('Escape');
  await p.waitForTimeout(200);
} catch (e) {
  ok(false, `Save as dialog: ${e.message.split('\n')[0]}`);
}
await closeAll();

// ---- Ctrl+Alt+arrow belongs to the window: the app inside must not hear it as well (PDF turned the page, for one) -----------
try {
  const win = await openApp('Notepad');
  await win.evaluate(w => {
    window.heardKeys = [];
    w.addEventListener('keydown', e => window.heardKeys.push(e.key));
  });
  for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowDown']) await p.keyboard.press('Control+Alt+' + k);
  await p.waitForTimeout(150);
  const heard = await p.evaluate(() => window.heardKeys.filter(k => k.startsWith('Arrow')));
  ok(heard.length === 0, `a Ctrl+Alt+arrow snap does not reach the app in the window (heard: ${heard.join(', ') || 'nothing'})`);
  await p.keyboard.press('ArrowLeft');
  await p.waitForTimeout(100);
  ok(await p.evaluate(() => window.heardKeys.includes('ArrowLeft')), 'a plain arrow key still reaches the app');
} catch (e) {
  ok(false, `snap keys: ${e.message.split('\n')[0]}`);
}
await closeAll();

// ---- Dark theme: can every visible word be read? ----------------------------------------------------------------------------
const CONTRAST_PROBE = `(() => {
  const lum = c => { const [r, g, b] = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const parse = s => { const m = /rgba?\\(([^)]+)\\)/.exec(s || ''); if (!m) return null; const v = m[1].split(',').map(parseFloat); return { c: v.slice(0, 3), a: v.length > 3 ? v[3] : 1 }; };
  const bgOf = el => { for (let e = el; e; e = e.parentElement) { const b = parse(getComputedStyle(e).backgroundColor); if (b && b.a > 0.5) return b.c; } return [255, 255, 255]; };
  const out = [];
  const win = document.querySelector('.win.active');
  if (!win) return out;
  for (const el of win.querySelectorAll('*')) {
    if (el.children.length && ![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
    const text = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join(' ') || (el.value ?? '') || (el.placeholder ?? '');
    if (!text) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || parseFloat(s.opacity) < 0.5) continue;
    const fg = parse(s.color);
    if (!fg) continue;
    const bg = bgOf(el);
    const l1 = lum(fg.c), l2 = lum(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    if (ratio < 3) out.push(\`\${el.tagName.toLowerCase()}\${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''} "\${text.slice(0, 30)}" \${ratio.toFixed(2)}:1\`);
  }
  return [...new Set(out)].slice(0, 8);
})()`;
await p.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
for (const app of ['File Explorer', 'Notepad', 'Settings', 'Calculator', 'Terminal', 'Mail', 'Chat', 'Task Manager', 'Application manager']) {
  try {
    await openApp(app);
    await p.waitForTimeout(600);
    const low = await p.evaluate(CONTRAST_PROBE);
    ok(low.length === 0, `Dark theme, ${app}: every visible word has at least 3:1 contrast${low.length ? ` (${low.join('; ')})` : ''}`);
  } catch (e) {
    ok(false, `Dark theme, ${app}: ${e.message.split('\n')[0]}`);
  }
  await closeAll();
}

// ---- Dark theme: the shared ribbon, status bar and sheet tabs (the font box was 1.22:1, the zoom keys 1.13:1, "+" 1.0:1) -----
// Contrast is how far words stand out from what is behind them; 4.5:1 is the usual minimum. This probe also reads the chosen
// words in a drop-down box and the colour of a gradient, which the one above skips. Colour samples (the swatches) are left out.
const RIBBON_PROBE = `(() => {
  const lum = c => { const [r, g, b] = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const parse = s => { const m = /rgba?\\(([^)]+)\\)/.exec(s || ''); if (!m) return null; const v = m[1].split(',').map(parseFloat); return { c: v.slice(0, 3), a: v.length > 3 ? v[3] : 1 }; };
  const bgOf = el => { for (let e = el; e; e = e.parentElement) { const s = getComputedStyle(e); const b = parse(s.backgroundColor); if (b && b.a > 0.5) return b.c; const g = parse(s.backgroundImage); if (g && g.a > 0.5) return g.c; } return [255, 255, 255]; };
  const out = [];
  const win = document.querySelector('.win.active');
  for (const el of win.querySelectorAll('.ribbon-tabs *, .ribbon *, .statusbar *, .tabs-bar *, .formula-bar *')) {
    const words = el.tagName === 'SELECT' ? (el.selectedOptions[0]?.textContent ?? '') : el.tagName === 'OPTION' ? '' : el.tagName === 'INPUT' ? el.value : [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join(' ');
    if (!words.trim()) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || el.matches(':disabled')) continue;
    const l1 = lum(parse(s.color).c), l2 = lum(bgOf(el));
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    if (ratio < 4.5) out.push(el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0] + ' "' + words.slice(0, 20) + '" ' + ratio.toFixed(2) + ':1');
  }
  return [...new Set(out)].slice(0, 12);
})()`;
for (const [app, tabs] of [['Write', ['Home', 'Insert', 'Layout', 'Review', 'Mailings', 'Help']], ['Spreadsheet', ['Home', 'Insert', 'Page Layout', 'Formulas', 'Data', 'Review', 'View']]]) {
  try {
    const win = await openApp(app);
    await win.locator('.ribbon').waitFor();
    for (const tab of tabs) {
      await win.locator('.ribbon-tab', { hasText: new RegExp(`^${tab}$`) }).first().click();
      await p.waitForTimeout(150);
      const low = await p.evaluate(RIBBON_PROBE);
      ok(low.length === 0, `Dark theme, ${app}, ${tab} tab: the ribbon, tabs and status bar have at least 4.5:1 contrast${low.length ? ` (${low.join('; ')})` : ''}`);
    }
    const faces = await win.evaluate(w => ['.ribbon-tabs', '.ribbon'].map(c => getComputedStyle(w.querySelector(c)).backgroundColor));
    ok(faces.every(c => c.match(/\d+/g).slice(0, 3).every(v => Number(v) < 100)), `Dark theme, ${app}: the ribbon itself is dark too (${faces.join(', ')})`);
  } catch (e) {
    ok(false, `Dark ribbon, ${app}: ${e.message.split('\n')[0]}`);
  }
  await closeAll();
}
try {
  await openSaveAs();
  const list = await p.locator('.pick-list').evaluate(l => [getComputedStyle(l).backgroundColor, getComputedStyle(l).color]);
  ok(list[0] !== 'rgb(255, 255, 255)', `Dark theme: the file list in Save as is not white with pale words (${list.join(' on ')})`);
  await p.keyboard.press('Escape');
  await p.waitForTimeout(200);
} catch (e) {
  ok(false, `Dark Save as: ${e.message.split('\n')[0]}`);
}
await closeAll();
await p.evaluate(() => { document.documentElement.dataset.theme = 'xfce'; });

// ---- Phone width: no sideways scrolling, Close on screen ------------------------------------------------------------------------
await p.setViewportSize({ width: 375, height: 812 });
await p.waitForTimeout(500);
for (const app of ['File Explorer', 'Notepad', 'Settings', 'Calculator', 'Terminal', 'Mail', 'Chat', 'Photo Editor', 'Reader']) {
  try {
    const win = await openApp(app);
    await p.waitForTimeout(600);
    const m = await win.evaluate(w => {
      const body = w.querySelector('.win-body');
      const close = w.querySelector('.win-close')?.getBoundingClientRect();
      return { sw: body?.scrollWidth ?? 0, cw: body?.clientWidth ?? 0, closeRight: close ? close.x + close.width : -1, winRight: w.getBoundingClientRect().right };
    });
    ok(m.sw <= m.cw + 1, `Phone, ${app}: the window body does not scroll sideways (${m.sw} in ${m.cw}px)`);
    ok(m.closeRight > 0 && m.closeRight <= 375 && m.winRight <= 376, `Phone, ${app}: Close and the window's right edge are on screen (${Math.round(m.closeRight)}, ${Math.round(m.winRight)})`);
  } catch (e) {
    ok(false, `Phone, ${app}: ${e.message.split('\n')[0]}`);
  }
  await closeAll();
}

// ---- Phone width: the ribbon's tab row scrolls by itself and does not push the window (Write was 510 px in 373 px) ---------
for (const app of ['Write', 'Spreadsheet']) {
  try {
    const win = await openApp(app);
    await win.locator('.ribbon-tabs').waitFor();
    await p.waitForTimeout(400);
    const m = await win.evaluate(w => {
      const body = w.querySelector('.win-body');
      const tabs = [...w.querySelectorAll('.ribbon-tab')].filter(t => !t.hidden);
      const last = tabs[tabs.length - 1];
      const sw = body.scrollWidth, cw = body.clientWidth;
      last.scrollIntoView({ inline: 'end', block: 'nearest' });
      const r = last.getBoundingClientRect();
      return { sw, cw, bodyLeft: body.scrollLeft, lastRight: Math.round(r.right), name: last.textContent };
    });
    ok(m.sw <= m.cw + 1, `Phone, ${app}: the window does not scroll sideways because of its tabs (${m.sw} in ${m.cw}px)`);
    ok(m.bodyLeft === 0 && m.lastRight <= 375, `Phone, ${app}: the last tab, ${m.name}, can be scrolled to and the document stays put (right ${m.lastRight})`);
    await win.locator('.ribbon-tab', { hasText: m.name }).last().click();
    await p.waitForTimeout(150);
    ok((await win.locator('.ribbon-tab[aria-selected="true"]').textContent()) === m.name, `Phone, ${app}: that last tab can be pressed`);
  } catch (e) {
    ok(false, `Phone tabs, ${app}: ${e.message.split('\n')[0]}`);
  }
  await closeAll();
}
try {
  await openSaveAs();
  const d = await dialogFits();
  ok(d.sw <= d.cw && d.right <= 375, `Phone: the Save as dialog does not scroll sideways and stays on screen (${d.sw} in ${d.cw}px, right ${d.right})`);
  await p.keyboard.press('Escape');
  await p.waitForTimeout(200);
} catch (e) {
  ok(false, `Phone Save as: ${e.message.split('\n')[0]}`);
}
await closeAll();

await browser.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('Failed:');
  for (const f of failures) console.log('  ' + f);
  process.exit(1);
}
