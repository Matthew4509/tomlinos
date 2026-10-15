// Drives TOMLIN CAD in a real Chrome: the window's parts (menus, two toolbars, the tool columns, the Layers panel, the
// drawing area, the command line, the status bar), a closed 600 x 400 outline typed on the command line, undo and
// redo, saving and opening again; snaps found with the pointer (middle, intersection, centre); the shapes (circle by
// diameter, ellipse, polygon, slot, arcs, curves); construction lines and tangent lines; choosing by window, crossing
// box and chain; move, mirror, the arrays; Utils > Measure; and no errors in the console.
// Needs the dev server on a FRESH, EMPTY data folder (the first step sets up the owner), and `npm run build` done.
//   node test/browser-cad.mjs [http://127.0.0.1:3043] [screenshot folder]
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3043';
const SHOTS = process.argv[3] ?? null;
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PASS = 'cad-walk-passphrase-52';
let passed = 0;
const failures = [];
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: 'en-GB' });
const page = await context.newPage();
page.setDefaultTimeout(10000);
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
    for (let i = 0; i < 3 && (await page.locator('.dialog').count()); i++) await page.keyboard.press('Escape').catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
  }
}
const eq = (a, b, what) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const ok = (v, what) => {
  if (!v) throw new Error(what);
};
const W = () => page.locator('.win', { has: page.locator('.cad') }).last();
const D = () => page.locator('.dialog').last();
const canvas = () => W().locator('.cad-canvas');
/**
 * Types each entry in the box that is showing (the command line, or the X box, which also takes a whole point such
 * as 600,400) and presses Enter; an empty entry presses Done (finishes the tool).
 */
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
const said = async (n = 3) => (await W().locator('.cad-said').allInnerTexts()).slice(-n).join(' | ');
const count = async layer => Number(await W().locator('.cad-layer', { hasText: layer }).locator('.cad-count').innerText());
const xy = async () => {
  const [x, y] = await W().locator('.cad-xy').allInnerTexts();
  return [Number(x.slice(2)), Number(y.slice(2))];
};
const chosen = async () => W().locator('.cad-msg').innerText();
async function openCad() {
  if (!(await page.locator('.start-filter').isVisible())) await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('tomlin cad');
  await page.locator('.start-menu [data-label="tomlin cad"]').first().click();
  await canvas().waitFor();
  await W().getByRole('button', { name: 'Maximise' }).click();
  await page.waitForTimeout(300);
}
async function closeAll() {
  for (let i = 0; i < 6; i++) {
    const wins = page.locator('.win', { has: page.locator('.cad') });
    if (!(await wins.count())) return;
    await wins.last().getByRole('button', { name: 'Close', exact: true }).first().click();
    const discard = page.locator('.dialog').getByRole('button', { name: 'Close without saving' });
    if (await discard.waitFor({ timeout: 1500 }).then(() => true, () => false)) await discard.click();
    await page.waitForTimeout(200);
  }
}
/**
 * Where a drawing point is on the screen: worked out from the X and Y the status bar shows at two places (with the
 * snaps off, so the numbers are the pointer's own).
 */
async function mapper() {
  const box = await canvas().boundingBox();
  await cmd('line');
  await page.keyboard.press('F3');
  const a = { x: box.x + 200, y: box.y + 150 };
  const b = { x: box.x + 600, y: box.y + 450 };
  await page.mouse.move(a.x, a.y);
  const wa = await xy();
  await page.mouse.move(b.x, b.y);
  const wb = await xy();
  await page.keyboard.press('F3');
  await page.keyboard.press('Escape');
  const kx = (b.x - a.x) / (wb[0] - wa[0]);
  const ky = (b.y - a.y) / (wb[1] - wa[1]);
  return (x, y) => ({ x: a.x + (x - wa[0]) * kx, y: a.y + (y - wa[1]) * ky });
}

await page.goto(BASE);
await step('set up a fresh desktop', async () => {
  await page.locator('.gate h1', { hasText: 'Set up this desktop' }).waitFor({ timeout: 20000 });
  await page.getByLabel('Your name').fill('CAD Walker');
  await page.locator('.gate input.gate-input').last().fill(PASS);
  await page.locator('.gate-encrypt').uncheck();
  await page.locator('.gate-go').click();
  await page.locator('.gate h1', { hasText: 'Your recovery key' }).waitFor({ timeout: 30000 });
  await page.locator('.gate .check-row input').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#desktop .item').first().waitFor({ timeout: 20000 });
});

await step('TOMLIN CAD is in Start > Office and opens in the classic CAD layout', async () => {
  await page.locator('.start-btn').click();
  await page.locator('.start-menu button', { hasText: 'Office' }).first().click();
  const labels = await page.locator('.start-item').evaluateAll(els => els.map(e => e.getAttribute('data-label')));
  ok(labels.includes('tomlin cad'), 'listed in Office: ' + labels.join(', '));
  await page.keyboard.press('Escape');
  await openCad();
  eq(await W().locator('.menubar-item').allInnerTexts(), ['File', 'Edit', 'View', 'Geometry', 'CAD', 'Utils', 'Help'], 'menus in order');
  eq(await W().locator('.cad-tb').count(), 3, 'three toolbar rows');
  eq(await W().locator('.cad-col').count(), 2, 'a tool column each side');
  eq(await W().locator('.cad-snaps .cad-btn').count(), 9, 'nine snaps on the right');
  ok(await W().locator('.cad-panel').isVisible(), 'the Layers panel');
  eq(await W().locator('.cad-layer-name').allInnerTexts().then(t => t.map(s => s.replace(' ✎', ''))), ['Geometry', 'Construction', 'Dimensions', 'Text'], 'the first layers');
  eq(await canvas().evaluate(c => getComputedStyle(c.parentElement).backgroundColor), 'rgb(30, 32, 136)', 'dark blue drawing area');
  ok(!(await W().locator('.ribbon, .ribbon-tabs').count()), 'no ribbon');
  ok((await W().locator('.cad-status').innerText()).includes('Layer: Geometry'), 'the status bar names the layer');
  await shot('cad-window');
});

await step('points typed in X and Y boxes: Enter Enter is 0,0; then the other corner', async () => {
  await W().getByRole('button', { name: 'Rectangle: two corners' }).click();
  const x = W().getByRole('textbox', { name: 'X', exact: true });
  const y = W().getByRole('textbox', { name: 'Y', exact: true });
  ok(await x.isVisible() && await y.isVisible(), 'X and Y boxes for the first corner');
  ok(!(await W().locator('.cad-input').isVisible()), 'the single command box gives way to them');
  eq(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'X', 'the keyboard is in X');
  await page.keyboard.press('Enter');
  eq(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Y', 'Enter goes on to Y');
  await page.keyboard.press('Enter');
  ok((await W().locator('.cad-prompt').innerText()).includes('Other corner'), 'then it asks for the other corner');
  await page.keyboard.type('600');
  await page.keyboard.press('Enter');
  await page.keyboard.type('400');
  await page.keyboard.press('Enter');
  await W().locator('.cad-done').click();
  await W().getByRole('button', { name: 'Zoom fit: the whole drawing' }).click();
  const at = await mapper();
  const p = at(300, 0);
  await cmd('list');
  await page.mouse.click(p.x, p.y);
  ok((await D().innerText()).includes('4 points, closed'), 'a rectangle: ' + (await D().innerText()));
  await D().getByRole('button').first().click();
  await page.keyboard.press('Escape');
  await W().getByRole('button', { name: 'Area and perimeter' }).click();
  await page.mouse.click(p.x, p.y);
  ok((await said(1)).includes('Area 240000'), 'from 0,0 to 600,400: ' + (await said(1)));
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
});

await step('snapping by pointer, not by aim: corner to corner, then middle of a side to middle of another', async () => {
  await cmd('rect', '0,0', '100,100', '');
  await cmd('rect', '100,100', '200,200', '');
  await W().getByRole('button', { name: 'Zoom fit: the whole drawing' }).click();
  const at = await mapper();
  const box = await canvas().boundingBox();
  const k = (at(100, 0).x - at(0, 0).x) / 100;
  // Each click lands on the side, about 20 px from the point it should take.
  await W().getByRole('button', { name: 'Rectangle: two corners' }).click();
  let p = at(200, 150 - 20 / k);
  await page.mouse.move(p.x, p.y);
  eq(await xy(), [200, 150], 'the middle of the right side of the upper square, 20 px away');
  await page.mouse.click(p.x, p.y);
  p = at(0, 50 + 20 / k);
  await page.mouse.move(p.x, p.y);
  eq(await xy(), [0, 50], 'the middle of the left side of the lower square, 20 px away');
  await page.mouse.click(p.x, p.y);
  await W().locator('.cad-done').click();
  await cmd('list');
  p = at(100, 150);
  await page.mouse.click(p.x, p.y);
  ok((await D().innerText()).includes('4 points, closed'), 'the third rectangle: ' + (await D().innerText()));
  await D().getByRole('button').first().click();
  await page.keyboard.press('Escape');
  await W().getByRole('button', { name: 'Area and perimeter' }).click();
  await page.mouse.click(p.x, p.y);
  ok((await said(1)).includes('Area 20000 '), 'from (0,50) to (200,150): 200 x 100 = ' + (await said(1)) + ' at ' + box.width);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
});

await step('session 1: a closed 600 x 400 outline typed in, undo and redo, saved and opened again', async () => {
  await cmd('line', '0,0', '@600,0', '@0,400', '@-600,0', 'c');
  eq(await count('Geometry'), 4, 'four lines');
  await canvas().focus();
  await page.keyboard.press('Control+z');
  eq(await count('Geometry'), 3, 'undo takes the closing line back');
  await page.keyboard.press('Control+y');
  eq(await count('Geometry'), 4, 'redo puts it back');
  await page.keyboard.press('Control+Shift+S');
  await D().locator('input[aria-label="File name"]').fill('outline.tcad');
  await D().getByRole('button', { name: 'Save' }).click();
  await W().locator('.win-bar', { hasText: 'outline.tcad' }).waitFor();
  await closeAll();
  await openCad();
  await W().getByRole('menuitem', { name: 'File' }).click();
  await page.locator('.menu').getByText('Open...', { exact: true }).click();
  await D().locator('.pick-row', { hasText: 'outline.tcad' }).first().dblclick();
  await page.locator('.win .win-bar', { hasText: 'outline.tcad' }).waitFor();
  eq(await count('Geometry'), 4, 'four lines after opening');
  await cmd('measure', '0,0', '600,400');
  ok((await said(1)).includes('Distance 721.11'), 'the diagonal measures sqrt(600^2 + 400^2): ' + (await said(1)));
  await page.keyboard.press('Escape');
});

await step('session 2: snaps with the pointer (middle, intersection, centre) and the shapes', async () => {
  await cmd('circle', '300,200', '35/2', '');
  await cmd('ellipse', '600,400', '@60,0', '25', '');
  await W().getByRole('button', { name: 'Zoom fit: the whole drawing' }).click();
  const at = await mapper();
  await cmd('line');
  // The middle of the bottom side.
  let p = at(301, 2);
  await page.mouse.move(p.x, p.y);
  eq(await xy(), [300, 0], 'snapped to the middle');
  await page.mouse.click(p.x, p.y);
  // Where the ellipse crosses the right-hand side: (600, 375).
  p = at(601, 377);
  await page.mouse.move(p.x, p.y);
  eq(await xy(), [600, 375], 'snapped to the intersection');
  await page.mouse.click(p.x, p.y);
  await page.keyboard.press('Escape');
  eq(await count('Geometry'), 7, 'the line was made');
  // The circle's centre.
  await cmd('line');
  p = at(302, 201);
  await page.mouse.move(p.x, p.y);
  eq(await xy(), [300, 200], 'snapped to the centre');
  await page.keyboard.press('Escape');
  await cmd('polygon', '150,300', '6', '40', '');
  await cmd('slot', '400,80', '@120,0', '20', '');
  await cmd('arc', '450,250', '500,300', '550,250', '');
  await cmd('rect', '20,20', '@100,50', '');
  await cmd('spline', '50,50', '100,120', '150,60', '200,140', '');
  eq(await count('Geometry'), 12, 'five more shapes');
  await shot('cad-shapes');
});

await step('session 3: construction lines, tangent lines, touching circles', async () => {
  await W().getByRole('button', { name: 'Construction line: horizontal' }).click();
  await cmd('0,200', '');
  await W().getByRole('button', { name: 'Construction line: at an angle' }).click();
  await cmd('45', '300,200', '');
  eq(await count('Construction'), 2, 'two construction lines on their own layer');
  await cmd('circle', '700,100', '10', '');
  await cmd('circle', '800,100', '20', '');
  await W().getByRole('button', { name: 'Zoom fit: the whole drawing' }).click();
  const at = await mapper();
  await W().getByRole('button', { name: 'Line touching two arcs or circles' }).click();
  let p = at(700, 110);
  await page.mouse.click(p.x, p.y);
  p = at(800, 120);
  await page.mouse.click(p.x, p.y);
  await page.keyboard.press('Escape');
  ok((await said(4)).includes('Line touching two arcs or circles'), 'used the tangent tool');
  await cmd('list');
  const mid = at(750, 115);
  await page.mouse.click(mid.x, mid.y);
  const text = await D().innerText();
  ok(/Line on layer Geometry/.test(text), 'a line was made: ' + text);
  await D().getByRole('button').first().click();
  await page.keyboard.press('Escape');
});

await step('session 4: window and crossing boxes, a chain, move, mirror and arrays', async () => {
  const at = await mapper();
  // A window round the polygon chooses it alone.
  let a = at(100, 250);
  let b = at(200, 350);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.mouse.up();
  eq(await chosen(), '1 chosen', 'the polygon');
  await cmd('move', '150,300', '@100,-50');
  ok((await said(1)).includes('@100,-50'), 'moved');
  // A crossing box (right to left) touching the rectangle's left side and the curve.
  a = at(60, 150);
  b = at(-10, 60);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.mouse.up();
  ok(Number((await chosen()).split(' ')[0]) >= 2, 'the crossing box chose what it touches: ' + (await chosen()));
  await page.keyboard.press('Escape');
  // Double-click a side of the outline: the four joined lines.
  const side = at(0, 100);
  await page.mouse.dblclick(side.x, side.y);
  eq(await chosen(), '4 chosen', 'the chain of the outline');
  await cmd('mirror', '0,0', '0,10');
  eq(await count('Geometry'), 19, 'mirrored copies beside the originals');
  // Round a centre: the small circle, six in all.
  await page.keyboard.press('Escape');
  const edge = at(300, 217.5);
  await page.mouse.click(edge.x, edge.y);
  eq(await chosen(), '1 chosen', 'the small circle');
  await W().getByRole('button', { name: 'Copy round a centre' }).click();
  await cmd('300,320');
  await D().getByRole('button', { name: 'OK' }).click();
  eq(await count('Geometry'), 24, 'five copies round the centre');
  ok(!(await W().locator('.cad-prompt').innerText()).includes('Centre to copy round'), 'the tool finished');
  // Rows and columns.
  await W().getByRole('button', { name: 'Rectangular array: rows and columns of the chosen items' }).click();
  const inputs = D().locator('input');
  await inputs.nth(0).fill('2');
  await inputs.nth(1).fill('2');
  await D().getByRole('button', { name: 'OK' }).click();
  eq(await count('Geometry'), 27, 'three more in a 2 x 2 array');
  // The box hands the keyboard back to the drawing as it closes.
  await page.waitForTimeout(300);
  const where = await page.evaluate(() => document.activeElement?.className);
  ok(['cad-canvas', 'cad-input', 'cad-coord'].includes(where), 'the keyboard is back in the window: ' + where);
  await page.keyboard.press('Delete');
  eq(await count('Geometry'), 26, 'Delete takes the chosen one away');
  await shot('cad-edited');
});

await step('session 5: fillet every corner R10, offset 5 in, trim, join lines into a geometry, direction', async () => {
  await closeAll();
  await openCad();
  await cmd('rect', '0,0', '@600,400', '');
  await W().getByRole('button', { name: 'Zoom fit: the whole drawing' }).click();
  let at = await mapper();
  await W().getByRole('button', { name: 'Fillet every corner of a polyline' }).click();
  await cmd('10');
  let p = at(300, 0);
  await page.mouse.click(p.x, p.y);
  ok((await said(1)).includes('4 corners done'), 'four corners rounded: ' + (await said(1)));
  await page.keyboard.press('Escape');
  await W().getByRole('button', { name: 'Offset' }).click();
  await cmd('5');
  p = at(300, 0);
  await page.mouse.click(p.x, p.y);
  p = at(300, 200);
  await page.mouse.click(p.x, p.y);
  await page.keyboard.press('Escape');
  eq(await count('Geometry'), 2, 'the offset copy');
  await W().getByRole('button', { name: 'Area and perimeter' }).click();
  p = at(300, 5);
  await page.mouse.click(p.x, p.y);
  // 590 x 390 with R5 corners: 230100 - 100 x (1 - pi/4).
  ok((await said(1)).includes('Area 230078.54'), 'area of the offset: ' + (await said(1)));
  await page.keyboard.press('Escape');
  // A line across, trimmed back to the outline at its top end.
  await cmd('line', '300,-50', '300,450', '');
  await W().getByRole('button', { name: 'Zoom fit: the whole drawing' }).click();
  at = await mapper();
  await W().getByRole('button', { name: 'Trim', exact: true }).click();
  p = at(300, 430);
  await page.mouse.click(p.x, p.y);
  await page.keyboard.press('Escape');
  await cmd('list');
  p = at(300, 100);
  await page.mouse.click(p.x, p.y);
  ok((await D().innerText()).includes('to 300, 400'), 'trimmed to the outline: ' + (await D().innerText()));
  await D().getByRole('button').first().click();
  await page.keyboard.press('Escape');
  // Four lines drawn as a triangle and a tail: chosen as a chain and joined.
  await cmd('line', '700,0', '@100,0', '@0,100', 'c');
  await W().getByRole('button', { name: 'Zoom fit: the whole drawing' }).click();
  at = await mapper();
  p = at(750, 0);
  await page.mouse.dblclick(p.x, p.y);
  eq(await chosen(), '3 chosen', 'the triangle chain');
  await W().getByRole('button', { name: 'Join the chosen lines and arcs into geometries' }).click();
  ok((await said(1)).includes('3 items joined into 1 geometry (1 closed)'), await said(1));
  await W().getByRole('button', { name: 'Show which way lines and polylines run' }).click();
  eq(await W().getByRole('button', { name: 'Show which way lines and polylines run' }).getAttribute('aria-pressed'), 'true', 'direction shown');
  await shot('cad-session5');
});

await step('session 6: lock, rename, colour, line type and a new layer; move items to it; information', async () => {
  const row = name => W().locator('.cad-layer', { hasText: name });
  await row('Geometry').getByRole('button', { name: 'Lock Geometry' }).click();
  const at = await mapper();
  await page.keyboard.press('Escape');
  const p = at(300, 100);
  await page.mouse.click(p.x, p.y);
  eq(await chosen(), 'Ready', 'a locked layer cannot be chosen');
  await row('Geometry').getByRole('button', { name: 'Lock Geometry' }).click();
  await row('Geometry').getByRole('button', { name: 'More for Geometry' }).click();
  await page.locator('.menu').getByText('Rename...', { exact: true }).click();
  await D().locator('input').fill('Outline');
  await D().getByRole('button', { name: 'Rename' }).click();
  ok(await row('Outline').count(), 'renamed');
  await row('Outline').getByRole('button', { name: 'More for Outline' }).click();
  await page.locator('.menu').getByText('Line type', { exact: true }).hover();
  await page.locator('.menu').getByText('Centre (long and short)', { exact: true }).click();
  ok(await row('Outline').locator('.cad-swatch-dashed').count(), 'the swatch shows a broken line');
  await W().locator('.cad-mini', { hasText: '+ New' }).click();
  await D().locator('input').fill('Holes');
  await D().getByRole('button', { name: 'Make it' }).click();
  ok((await W().locator('.cad-status').innerText()).includes('Layer: Holes'), 'new items go on the new layer');
  await page.mouse.click(p.x, p.y);
  eq(await chosen(), '1 chosen', 'the line across');
  await W().getByRole('menuitem', { name: 'Edit' }).click();
  await page.locator('.menu').getByText('Move to a layer...', { exact: true }).click();
  await D().locator('select').selectOption('Holes');
  await D().getByRole('button', { name: 'Move them' }).click();
  eq(await count('Holes'), 1, 'moved onto Holes');
  await canvas().focus();
  await page.keyboard.press('Control+z');
  eq(await count('Holes'), 0, 'undo puts it back');
  await W().getByRole('button', { name: 'Information about the drawing' }).click();
  ok((await D().innerText()).includes('Layers: 5'), 'information: ' + (await D().innerText()));
  await D().getByRole('button').first().click();
});

await step('View: grid, white background, large icons, help', async () => {
  await canvas().focus();
  await page.keyboard.press('F7');
  eq(await W().locator('.cad-toggle', { hasText: 'GRID' }).getAttribute('aria-pressed'), 'true', 'grid on');
  await W().getByRole('menuitem', { name: 'View' }).click();
  await page.locator('.menu').getByText('Large icons', { exact: true }).click();
  ok(await W().locator('.cad.cad-large').count(), 'large icons');
  eq(await W().locator('.cad-btn').first().evaluate(b => b.getBoundingClientRect().width), 32, '32 px buttons');
  await W().getByRole('menuitem', { name: 'Help' }).click();
  await page.locator('.menu').getByText('What TOMLIN CAD does', { exact: true }).click();
  ok((await D().innerText()).includes('Never here: CAM'), 'help says what is not here');
  await D().getByRole('button').first().click();
});

await step('no errors in the console', async () => {
  eq(problems.filter(p => !/status of 404/.test(p)), [], 'console');
});

console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? ': ' + failures.join('; ') : ''}`);
await browser.close().catch(() => {});
process.exit(failures.length ? 1 : 0);
