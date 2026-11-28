// Round-2 audit of CAD Draft (app id "cad") in a real Chrome: its rules tried through the window itself (a quick
// double save, Save as a DXF copy leaves the drawing unsaved, a recovery copy is offered and opened once, Escape is
// scoped to the command line, the window works at 375 px).
// Needs the dev server on a FRESH, EMPTY data folder (the first step sets up the owner) and `node tools/build.mjs`.
//   node test/browser-audit2-cad.mjs [http://127.0.0.1:3551] [screenshot folder]
// A failing step names a P0 still open; "info" lines are P1/P2 notes that do not fail the run.
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3551';
const SHOTS = process.argv[3] ?? null;
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PASS = 'walnut-harbour-quiver-58';
let passed = 0;
const failures = [];
const infos = [];

async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (error) {
    failures.push(name);
    await shot('fail-' + failures.length).catch(() => {});
    console.log('  FAIL ' + name + '\n       ' + String(error.message).split('\n')[0].slice(0, 600));
    await closeAll().catch(() => {});
  }
}
const info = text => {
  infos.push(text);
  console.log('  info ' + text);
};
const ok = (cond, what) => {
  if (!cond) throw new Error(what);
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const problems = [];
page.on('pageerror', e => problems.push('pageerror: ' + e.message));
const shot = async name => SHOTS && page.screenshot({ path: `${SHOTS}/cd-${name}.png` });

const W = () => page.locator('.win', { has: page.locator('.cad') }).last();
const pick = () => page.locator('.dialog:has(.pick)').last();
const said = async (n = 3) => (await W().locator('.cad-said').allInnerTexts()).slice(-n).join(' | ');

/** Types each entry in the box that is showing and presses Enter; an empty entry presses Done. */
async function cmd(...entries) {
  for (const e of entries) {
    if (e === '' && (await W().locator('.cad-done').isVisible())) {
      await W().locator('.cad-done').click();
      continue;
    }
    const box = W().locator('.cad-command-line input:visible').first();
    await box.fill(e);
    await box.press('Enter');
  }
}
async function putAsideOffer() {
  const offer = page.locator('.dialog', { hasText: 'Drawings not saved' });
  if (await offer.count()) await offer.getByRole('button', { name: 'Later' }).click();
}
async function openCad() {
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('cad draft');
  await page.locator('.start-menu [data-label="cad draft"]').first().click();
  await W().locator('.cad-canvas').waitFor();
  await page.waitForTimeout(500);
  await putAsideOffer();
}
async function closeAll() {
  for (let i = 0; i < 30; i++) {
    const dialog = page.locator('.dialog').last();
    if (await dialog.count()) {
      const b = dialog.getByRole('button', { name: /Close without saving|Later|Cancel|Do not save|OK/ }).first();
      if (await b.count()) await b.click();
      else await page.keyboard.press('Escape');
      await page.waitForTimeout(150);
      continue;
    }
    const close = page.locator('.win .win-close').last();
    if (!(await close.count())) return;
    await close.click();
    await page.waitForTimeout(200);
  }
}
async function menu(top, item) {
  await W().locator(`.cbar-title[data-menu="${top}"]`).click();
  await page.locator('.menu-item', { hasText: item }).first().click();
}
async function saveAsName(name, type) {
  await menu('File', 'Save as...');
  await pick().waitFor();
  if (type) {
    const labels = await pick().locator('select.pick-type-box option').allTextContents();
    const label = labels.find(l => l.toLowerCase().includes(type));
    ok(label, `no ${type} choice in the Save as type box: ${JSON.stringify(labels)}`);
    await pick().locator('select.pick-type-box').selectOption({ label });
  }
  await pick().locator('.pick-name-box').fill(name);
  await pick().locator('.btn.primary').click();
  await page.waitForTimeout(800);
}
/** Closes the CAD window; true when it asked about unsaved changes (the question is then answered "Close without saving"). */
async function closeAsks() {
  await W().locator('.win-close').first().click();
  const ask = page.locator('.dialog', { hasText: /not saved|unsaved|Close without saving/ });
  const asked = await ask.first().waitFor({ timeout: 2500 }).then(() => true, () => false);
  if (asked) await ask.getByRole('button', { name: 'Close without saving' }).first().click();
  await page.waitForTimeout(300);
  return asked;
}

console.log('CAD Draft round-2 audit, against ' + BASE);
await page.goto(BASE);

await step('set up the owner', async () => {
  await page.locator('.gate h1', { hasText: 'Set up' }).waitFor({ timeout: 30000 });
  await page.getByLabel('Your name').fill('Sample Owner');
  if (await page.getByLabel('User name (for signing in)').count()) await page.getByLabel('User name (for signing in)').fill('tester');
  await page.locator('.gate input[type=password]').last().fill(PASS);
  if (await page.locator('.gate-encrypt').count()) await page.locator('.gate-encrypt').uncheck();
  await page.locator('.gate-go').click();
  await page.locator('.gate .check-row input').check({ timeout: 30000 });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#desktop .item').first().waitFor({ timeout: 30000 });
});

await step('CD-5 (P1 note): two quick Ctrl+S on a saved drawing do not say it was changed somewhere else', async () => {
  await openCad();
  await cmd('line', '0,0', '100,0', '');
  await saveAsName('audit-double.tcad');
  await cmd('line', '0,10', '100,10', '');
  await W().locator('.cad-canvas').click({ position: { x: 400, y: 300 } });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+S');
  await page.keyboard.press('Control+S');
  await page.waitForTimeout(1500);
  const asked = await page.locator('.dialog', { hasText: 'Changed somewhere else' }).count();
  if (asked) {
    info('CD-5 (P1): a quick double Ctrl+S asks "Changed somewhere else" about its own first save');
    await page.locator('.dialog', { hasText: 'Changed somewhere else' }).getByRole('button', { name: 'Do not save' }).click();
  }
  await closeAll();
});

await step('rule 3: Save as a DXF copy writes the copy and leaves the drawing unsaved (Close asks)', async () => {
  await openCad();
  await cmd('circle', '0,0', '25');
  await saveAsName('audit-copy.dxf', 'dxf');
  const opts = page.locator('.dialog', { hasText: 'Save a DXF copy' });
  await opts.waitFor({ timeout: 4000 });
  await opts.getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('.toast', { hasText: 'DXF copy' }).first().waitFor({ timeout: 5000 });
  ok(await closeAsks(), 'Close did not ask: the DXF copy made the drawing look saved');
});

await step('rule 6: Escape while typing a number clears only the typing; the tool keeps running; a second Escape ends it', async () => {
  await openCad();
  await cmd('line', '0,0');
  const box = W().locator('.cad-command-line input:visible').first();
  await box.fill('123');
  await box.press('Escape');
  ok((await box.inputValue()) === '', 'the typing was not cleared');
  const prompt = await W().locator('.cad-prompt').innerText();
  ok(/point|next|end/i.test(prompt), `the tool stopped after one Escape: prompt "${prompt}"`);
  await box.press('Escape');
  await page.waitForTimeout(200);
  ok((await said(2)).includes('ended') || (await said(2)).includes('stopped'), `a second Escape did not end the tool: ${await said(2)}`);
  ok((await page.locator('.win', { has: page.locator('.cad') }).count()) >= 1, 'Escape closed the window');
  await closeAll();
});

await step('rule 8: a recovery copy left behind is offered once, and opening it brings the work back in one window only', async () => {
  await openCad();
  await cmd('rect', '0,0', '40,30');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(2500);
  await page.reload();
  await page.locator('#desktop .item').first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(800);
  // Two CAD Draft windows started straight after one another.
  for (let i = 0; i < 2; i++) {
    await page.locator('.start-btn').click();
    await page.locator('.start-filter').fill('cad draft');
    await page.locator('.start-menu [data-label="cad draft"]').first().click();
  }
  const offer = page.locator('.dialog', { hasText: 'Drawings not saved' });
  await offer.first().waitFor({ timeout: 8000 });
  await page.waitForTimeout(1000);
  const offers = await offer.count();
  // Each offer showing is answered Open it, the one on top first (as a person would).
  let answered = 0;
  for (let i = 0; i < 3 && (await offer.count()); i++) {
    await offer.last().getByRole('button', { name: /Open it|Open them/ }).click();
    await page.waitForTimeout(2500);
    answered++;
  }
  const titles = await page.locator('.win:has(.cad) .win-title').allTextContents().catch(() => []);
  let holding = 0;
  for (const w of await page.locator('.win:has(.cad)').all()) {
    const lines = await w.locator('.cad-said').allInnerTexts();
    if (lines.some(l => l.startsWith('Recovered'))) holding++;
  }
  ok(holding >= 1, 'the recovered drawing did not open at all');
  ok(holding === 1 && answered === 1 && offers === 1, `CD-6: the copy was offered ${answered} times (${offers} at once) and is open in ${holding} windows (${JSON.stringify(titles)})`);
  await closeAll();
});

await step('rule 6: at 375 px the window fits, nothing scrolls sideways, and every toolbar starts on screen', async () => {
  await page.setViewportSize({ width: 375, height: 740 });
  await page.waitForTimeout(400);
  await openCad();
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok(wide <= 0, `the page scrolls sideways by ${wide}px`);
  const box = await W().boundingBox();
  ok(box && box.x >= -1 && box.x + box.width <= 376, `the window runs past the screen: ${JSON.stringify(box)}`);
  // A band past the edge is fine when the strip it is in scrolls sideways (the phone layout); lost when it cannot be reached.
  const off = await W().locator('.cbar-band').evaluateAll(els => els.filter(e => {
    const r = e.getBoundingClientRect();
    if (!(r.width > 0) || (r.left >= -1 && r.left <= 375 && r.top <= 740)) return false;
    const dock = e.closest('.cbar-dock-top, .cbar-dock-side');
    const ox = dock ? getComputedStyle(dock).overflowX : 'visible';
    return !(dock && (ox === 'auto' || ox === 'scroll') && dock.scrollWidth > dock.clientWidth);
  }).map(e => e.getAttribute('aria-label')));
  ok(!off.length, `toolbars off screen that cannot be scrolled to: ${JSON.stringify(off)}`);
  ok(await W().locator('.cbar-title[data-menu="File"]').isVisible(), 'the File menu cannot be seen');
  // More toolbar buttons past the edge: a » at the strip's right edge says so, and a press scrolls the strip on.
  const strip = W().locator('.cbar-dock-top');
  const overflows = await strip.evaluate(e => e.scrollWidth > e.clientWidth + 2);
  if (overflows) {
    const onward = W().locator('.cad-strip-more');
    ok(await onward.isVisible(), 'the toolbar strip runs on past the edge with nothing to show it');
    const box2 = await onward.boundingBox();
    ok(box2 && box2.x + box2.width <= 376 && box2.width >= 20, `the » is not at the right edge: ${JSON.stringify(box2)}`);
    const before = await strip.evaluate(e => e.scrollLeft);
    await onward.click();
    await page.waitForTimeout(600);
    ok((await strip.evaluate(e => e.scrollLeft)) > before, 'pressing » did not scroll the toolbars on');
  } else info('at 375 px every toolbar fitted, so the » was not tried');
  await cmd('line', '0,0', '50,0', '');
  ok((await said(4)).includes('Line'), `typing a line at 375 px: ${await said(4)}`);
  await closeAll();
  await page.setViewportSize({ width: 1280, height: 800 });
});

await step('CAD-P1-1: a radius typed as 12,5 makes a circle of radius 12.5 (not one through the point 12,5)', async () => {
  await openCad();
  await cmd('circle', '0,0', '12,5');
  const s = await said(4);
  ok(/Read “12,5” as the number 12\.5/.test(s), `the decimal comma was not read as a number: ${s}`);
  ok(!/Cannot:/.test(await said(1)), `the circle was refused: ${s}`);
  await closeAll();
});

await step('CAD-P1-2 and CAD-P1-6: drawing on a hidden layer says so and offers to show it; deleting a locked layer’s items keeps them', async () => {
  await openCad();
  // Hide the current layer from the Layer menu (the layer, Hide), then draw on it.
  const current = (await W().locator('.cad-status').innerText()).match(/Layer: (\S+)/)[1];
  const layerLabel = async () => {
    await W().locator('.cbar-title[data-menu="Layer"]').click();
    const t = (await page.locator('.menu').first().locator('.menu-label').allInnerTexts()).find(l => l.startsWith(`${current} (`));
    await page.keyboard.press('Escape');
    return t;
  };
  const layerDo = async action => {
    await W().locator('.cbar-title[data-menu="Layer"]').click();
    await page.locator('.menu').first().locator('.menu-item', { hasText: `${current} (` }).hover();
    await page.locator('.menu').nth(1).locator('.menu-item', { hasText: action }).first().click();
  };
  await layerDo('Hide');
  ok(/hidden/.test(await layerLabel()), 'the current layer was not hidden');
  await cmd('line', '0,0', '30,0', '');
  const toast = page.locator('.toast', { hasText: 'which is hidden' });
  await toast.first().waitFor({ timeout: 4000 });
  await toast.first().getByRole('button', { name: 'Show it' }).click();
  await page.waitForTimeout(300);
  ok(!/hidden/.test(await layerLabel()), 'Show it did not show the layer');
  // Lock the layer and try Edit > Delete a layer's items on it.
  await layerDo('Lock');
  await menu('Edit', 'Delete a layer’s items...');
  const d = page.locator('.dialog', { hasText: 'Delete every item on this layer' });
  await d.waitFor();
  await d.getByRole('button', { name: 'Delete them' }).click();
  await page.waitForTimeout(300);
  ok(/locked, so its 1 item was kept/.test(await said(2)), `a locked layer's items were not kept: ${await said(2)}`);
  await closeAll();
});

await step('CD-13: Escape during a text-box handle drag puts the box back', async () => {
  await openCad();
  await cmd('tb', '0,0', '100,40');
  const ask = page.locator('.dialog', { has: page.locator('textarea.cad-words') });
  await ask.waitFor({ timeout: 4000 });
  await ask.locator('textarea.cad-words').fill('Hello');
  await ask.getByRole('button', { name: 'OK' }).click();
  await page.waitForTimeout(300);
  await menu('View', 'Zoom fit');
  await page.waitForTimeout(300);
  const c = await W().locator('.cad-canvas').boundingBox();
  const mid = { x: c.x + c.width / 2, y: c.y + c.height / 2 };
  // Dragged from inside the box (a move), Escape before letting go: the box goes back, nothing is changed.
  await page.mouse.move(mid.x, mid.y);
  await page.mouse.down();
  await page.mouse.move(mid.x + 60, mid.y + 30, { steps: 5 });
  await page.keyboard.press('Escape');
  await page.mouse.move(mid.x + 90, mid.y + 40, { steps: 3 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const after = await said(3);
  ok(after.includes('Text box put back as it was.') && !after.includes('Text box moved.'), `Escape did not put the box back: ${after}`);
  // The same drag without Escape does move it (so the drag above was on the box).
  await page.mouse.move(mid.x, mid.y);
  await page.mouse.down();
  await page.mouse.move(mid.x + 60, mid.y + 30, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  ok((await said(1)).includes('Text box moved.'), `the check drag did not move the box: ${await said(3)}`);
  await closeAll();
});

if (problems.length) {
  failures.push('page errors');
  console.log('  FAIL page errors:\n       ' + problems.join('\n       '));
}
console.log(`\n${passed} passed, ${failures.length} failed, ${infos.length} info`);
await browser.close();
process.exit(failures.length ? 1 : 0);
