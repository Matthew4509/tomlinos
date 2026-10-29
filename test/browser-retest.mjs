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

await browser.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('Failed:');
  for (const f of failures) console.log('  ' + f);
  process.exit(1);
}
