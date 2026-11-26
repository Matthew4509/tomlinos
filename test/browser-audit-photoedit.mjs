// Photo Editor audit (browser): faults found by trying to break it. Each step fails now and passes once fixed.
// Needs the dev server on a FRESH, EMPTY data folder (the first step sets up the owner), and out/ built.
//   node test/browser-audit-photoedit.mjs [http://127.0.0.1:3105] [screenshot folder]
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3105';
const SHOTS = process.argv[3] ?? null;
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PASS = 'photo-audit-passphrase-41';
let passed = 0;
const failures = [];
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
const page = await context.newPage();
const problems = [];
page.on('console', m => m.type() === 'error' && problems.push('console: ' + m.text()));
page.on('pageerror', e => problems.push('pageerror: ' + e.message));
const shot = async name => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });
async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (error) {
    failures.push(name);
    await shot('fail-' + failures.length).catch(() => {});
    console.log('  FAIL ' + name + '\n       ' + String(error.message).slice(0, 1500));
  }
}
const eq = (a, b, what) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const ok = (v, what) => {
  if (!v) throw new Error(what);
};
const W = () => page.locator('.win', { has: page.locator('.pe') }).last();
const pixel = (x, y) => W().locator('.pe-doc').evaluate((c, [x, y]) => [...c.getContext('2d').getImageData(x, y, 1, 1).data], [x, y]);
async function at(x, y) {
  const box = await W().locator('.pe-over').boundingBox();
  const size = await W().locator('.pe-doc').evaluate(c => [c.width, c.height]);
  return { x: box.x + ((x + 0.5) * box.width) / size[0], y: box.y + ((y + 0.5) * box.height) / size[1] };
}
async function dragPic(a, b, opts = {}) {
  const p = await at(...a), q = await at(...b);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(q.x, q.y, { steps: opts.steps ?? 8 });
  await page.mouse.up();
}
const layerNames = () => W().locator('.pe-layer-name').allInnerTexts();
const tool = name => W().locator('.pe-tools').getByRole('button', { name, exact: true }).click();
const menu = async (menuName, item) => {
  await W().getByRole('button', { name: `${menuName} ▾` }).click();
  await page.locator('.menu').getByText(item, { exact: true }).first().click();
};
const near = (a, b, tol = 6) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const status = () => W().locator('.pe-status').innerText();
const title = () => W().locator('.win-title, .title').first().innerText().catch(() => '');
async function openPe() {
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('photo editor');
  await page.locator('.start-menu [data-label="photo editor"]').first().click();
  await W().locator('.pe-doc').waitFor();
}
async function closeAllPe() {
  for (let i = 0; i < 6 && (await page.locator('.win', { has: page.locator('.pe') }).count()); i++) {
    await W().getByRole('button', { name: 'Close', exact: true }).first().click();
    const lose = page.locator('.dialog').getByRole('button', { name: 'Close without saving' });
    if (await lose.waitFor({ timeout: 1500 }).then(() => true, () => false)) await lose.click();
    await page.waitForTimeout(200);
  }
}
async function freshPicture(w, hh, white = true) {
  await W().getByRole('button', { name: 'New...' }).click();
  const lose = page.locator('.dialog', { hasText: 'Not saved' });
  if (await lose.waitFor({ timeout: 800 }).then(() => true, () => false)) await lose.getByRole('button', { name: 'Lose the changes' }).click();
  await page.locator('.dialog input[aria-label="Width"]').fill(String(w));
  await page.locator('.dialog input[aria-label="Height"]').fill(String(hh));
  if (!white) await page.locator('.dialog input[type="checkbox"]').uncheck();
  await page.locator('.dialog').getByRole('button', { name: 'Create' }).click();
  await W().locator('.pe-status', { hasText: `${w} × ${hh}` }).waitFor();
}
const setColour = hex => W().locator('input[aria-label="Colour"]').evaluate((el, hex) => {
  el.value = hex;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, hex);
async function saveAsName(name) {
  await W().locator('.pe-stage').focus();
  await page.keyboard.press('Control+Shift+s');
  await page.locator('.dialog input[aria-label="File name"]').fill(name);
  await page.locator('.dialog').getByRole('button', { name: 'Save' }).click();
}
/** Puts files into /Pictures through the Files window's Upload button. */
async function upload(files) {
  const dir = mkdtempSync(join(tmpdir(), 'pe-audit-'));
  try {
    for (const [name, data] of Object.entries(files)) writeFileSync(join(dir, name), data);
    await page.keyboard.press('Control+Alt+e');
    const x = page.locator('.win.active');
    await x.locator('.item', { hasText: 'Pictures' }).first().dblclick();
    const chooser = page.waitForEvent('filechooser');
    await x.getByRole('button', { name: 'Upload' }).click();
    (await chooser).setFiles(Object.keys(files).map(n => join(dir, n)));
    for (const n of Object.keys(files)) await x.locator('.item', { hasText: n.replace(/\.[^.]+$/, '') }).first().waitFor({ timeout: 15000 });
    await x.getByRole('button', { name: 'Close', exact: true }).first().click();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
async function openInPe(name) {
  await W().getByRole('button', { name: 'Open...' }).click();
  const lose = page.locator('.dialog', { hasText: 'Not saved' });
  if (await lose.waitFor({ timeout: 800 }).then(() => true, () => false)) await lose.getByRole('button', { name: 'Lose the changes' }).click();
  await page.locator('.dialog .pick-row', { hasText: name }).first().dblclick();
  await W().locator('.pe-status', { hasText: name }).waitFor({ timeout: 10000 });
}

await page.goto(BASE);
await step('set up a fresh desktop', async () => {
  await page.locator('.gate h1', { hasText: 'Set up this desktop' }).waitFor({ timeout: 20000 });
  await page.getByLabel('Your name').fill('Audit Tester');
  await page.locator('.gate input.gate-input').last().fill(PASS);
  await page.locator('.gate-encrypt').uncheck();
  await page.locator('.gate-go').click();
  await page.locator('.gate h1', { hasText: 'Your recovery key' }).waitFor({ timeout: 30000 });
  await page.locator('.gate .check-row input').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#desktop .item').first().waitFor({ timeout: 20000 });
  await openPe();
});

// PE-P0-1: at the window's own minimum size (480 × 360, from the catalog) and at 560 × 420, the Layers panel's list
// and its buttons (New layer, Duplicate, Raise, Lower, Merge down, Delete) are pushed out of the window or drawn over
// the status bar, with no way to scroll to them.
for (const [w, hh] of [[480, 360], [560, 420]]) {
  await step(`PE-P0-1 a ${w} × ${hh} window: every Layers panel button and the layer list can be reached, and none covers the status bar`, async () => {
    await closeAllPe();
    await openPe();
    await W().evaluate((el, [w, hh]) => {
      el.style.width = `${w}px`;
      el.style.height = `${hh}px`;
    }, [w, hh]);
    await page.waitForTimeout(400);
    await shot(`p0-1-${w}`);
    const bad = await W().evaluate(el => {
      const out = [];
      const panel = el.querySelector('.pe-layers');
      if (!panel || panel.hidden) return out; // hidden on purpose is fine (the toolbar button brings it back)
      const foot = el.querySelector('.pe-foot').getBoundingClientRect();
      const targets = [...panel.querySelectorAll('.pe-layer-btns button'), panel.querySelector('.pe-layer.on')];
      for (const b of targets) {
        b.scrollIntoView({ block: 'nearest' });
        const q = b.getBoundingClientRect();
        const hit = document.elementFromPoint(q.x + q.width / 2, q.y + q.height / 2);
        const label = b.getAttribute('aria-label') || b.textContent.trim().slice(0, 20);
        if (!(hit === b || b.contains(hit))) out.push(`${label}: not clickable (under it: ${hit?.className || hit?.tagName})`);
        else if (q.bottom > foot.top + 1) out.push(`${label}: drawn over the status bar`);
      }
      return out;
    });
    eq(bad, [], 'unreachable Layers controls');
  });
}

// PE-P1-3: drawing and then undoing back to the picture as it was opened still said "not saved".
await step('PE-P1-3 undo back to the saved picture says saved again; redo says not saved', async () => {
  await closeAllPe();
  await openPe();
  ok(!(await status()).includes('not saved'), 'a new window starts saved: ' + (await status()));
  await tool('Brush');
  await dragPic([100, 100], [200, 120]);
  await W().locator('.pe-status', { hasText: 'not saved' }).waitFor({ timeout: 3000 });
  await W().locator('.pe-stage').focus();
  await page.keyboard.press('Control+z');
  await W().locator('.pe-status:not(:has-text("not saved"))').waitFor({ timeout: 3000 });
  await page.keyboard.press('Control+y');
  await W().locator('.pe-status', { hasText: 'not saved' }).waitFor({ timeout: 3000 });
  // After a save: a change, then Undo, is the saved picture again.
  await saveAsName('undo-clean.png');
  await page.locator('.toast', { hasText: 'Saved “undo-clean.png”' }).waitFor({ timeout: 10000 });
  await W().locator('.pe-status:not(:has-text("not saved"))', { hasText: 'undo-clean.png' }).waitFor({ timeout: 3000 });
  await dragPic([300, 300], [350, 320]);
  await W().locator('.pe-status', { hasText: 'not saved' }).waitFor({ timeout: 3000 });
  await W().locator('.pe-stage').focus();
  await page.keyboard.press('Control+z');
  await W().locator('.pe-status:not(:has-text("not saved"))').waitFor({ timeout: 3000 });
  // Undo past the saved place is a change again.
  await page.keyboard.press('Control+z');
  await W().locator('.pe-status', { hasText: 'not saved' }).waitFor({ timeout: 3000 });
});

await step('no errors in the page', async () => {
  eq(problems.filter(p => !/status of 404/.test(p)), [], 'problems');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
await Promise.race([browser.close(), new Promise(res => setTimeout(res, 5000))]);
process.exit(failures.length ? 1 : 0);
