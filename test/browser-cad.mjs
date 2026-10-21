// Drives TOMLIN CAD in a real Chrome: the window's parts (menus, two toolbars, the tool columns, the Layers panel, the
// drawing area, the command line, the status bar), a closed 600 x 400 outline typed on the command line, undo and
// redo, saving and opening again; snaps found with the pointer (middle, intersection, centre); the shapes (circle by
// diameter, ellipse, polygon, slot, arcs, curves); construction lines and tangent lines; choosing by window, crossing
// box and chain; move, mirror, the arrays; Utils > Measure; text and dimensions (session 7); a DXF written and opened
// again (session 8); a photo traced over, printing to scale, recent drawings and a recovery copy (session 9); a
// slanted photo straightened; pen and touch (taps, a held finger, two-finger pan and pinch); and no errors in the
// console.
// Needs the dev server on a FRESH, EMPTY data folder (the first step sets up the owner), and `npm run build` done.
//   node test/browser-cad.mjs [http://127.0.0.1:3043] [screenshot folder]
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

await step('session 7: text, text round an arc, dimensions (linear, diameter, angle), a leader; changed by double-click; text exploded', async () => {
  await closeAll();
  await openCad();
  await W().getByRole('button', { name: 'Rectangle: two corners' }).click();
  await cmd('0,0', '600,400');
  await page.keyboard.press('Escape');
  await cmd('circle', '300,200', '50');
  await page.keyboard.press('Escape');
  // Text: a point, then the words in the box (two lines), on the Text layer.
  await W().locator('.cad-tb .cad-btn[aria-label="Text"]').click();
  await cmd('100,450');
  await D().locator('textarea').fill('FRONT PANEL\nOak 18');
  await D().getByRole('button', { name: 'OK' }).click();
  eq(await count('Text'), 1, 'the text on the Text layer');
  // A linear dimension measures across when put below, up when put to the side.
  await W().getByRole('button', { name: 'Dimension: linear (across or up)' }).click();
  await cmd('0,0', '600,0', '300,-50');
  ok((await said(1)).endsWith(': 600'), 'across: ' + (await said(1)));
  await cmd('600,0', '600,400', '680,200');
  ok((await said(1)).endsWith(': 400'), 'up: ' + (await said(1)));
  await page.keyboard.press('Escape');
  // A new window opens zoomed in: the whole drawing must be on screen before points are clicked.
  await W().getByRole('button', { name: 'Zoom fit: the whole drawing' }).click();
  const at = await mapper();
  // The circle's diameter, picked on its edge, the number outside.
  await W().getByRole('button', { name: 'Dimension: diameter' }).click();
  let p = at(350, 200);
  await page.mouse.click(p.x, p.y);
  await cmd('420,260');
  ok((await said(1)).includes('Ø100'), 'diameter: ' + (await said(1)));
  await page.keyboard.press('Escape');
  // The corner of the rectangle: its bottom and right sides.
  await W().getByRole('button', { name: 'Dimension: angle' }).click();
  p = at(500, 0);
  await page.mouse.click(p.x, p.y);
  p = at(600, 100);
  await page.mouse.click(p.x, p.y);
  await cmd('560,40');
  ok((await said(1)).includes('90°'), 'angle: ' + (await said(1)));
  await page.keyboard.press('Escape');
  // A leader: the arrow tip, where the words go, Done, then the words.
  await W().getByRole('button', { name: 'Leader note (an arrow and words)' }).click();
  await cmd('335,235', '420,330', '');
  await D().locator('textarea').fill('Ø100 HOLE');
  await D().getByRole('button', { name: 'OK' }).click();
  eq(await count('Dimensions'), 5, 'four dimensions and a leader on Dimensions');
  // Text round the circle, over the top.
  await W().getByRole('button', { name: 'Text round an arc' }).click();
  p = at(300, 250);
  await page.mouse.click(p.x, p.y);
  await cmd('300,260');
  await D().locator('input[aria-label="Words"]').fill('TOP SIDE');
  await D().getByRole('button', { name: 'OK' }).click();
  eq(await count('Text'), 2, 'the arc text');
  await shot('cad-text-dimensions');
  // Double-click the across dimension's number: change its words (<> keeps the size).
  p = at(300, -47);
  await page.mouse.dblclick(p.x, p.y);
  await D().locator('input[aria-label="Words"]').fill('<> OVERALL');
  await D().getByRole('button', { name: 'OK' }).click();
  await cmd('list');
  p = at(300, -50);
  await page.mouse.click(p.x, p.y);
  ok((await D().innerText()).includes('Linear dimension: 600 OVERALL'), 'changed: ' + (await D().innerText()));
  await D().getByRole('button').first().click();
  await page.keyboard.press('Escape');
  // Text exploded into strokes a cutter can follow; undo brings the text back.
  p = at(103, 452);
  await page.mouse.click(p.x, p.y);
  eq(await chosen(), '1 chosen', 'the text chosen');
  await W().getByRole('button', { name: 'Explode the chosen polylines, text or dimensions into lines and arcs' }).click();
  ok((await count('Text')) > 20, 'exploded into strokes: ' + (await count('Text')));
  await canvas().focus();
  await page.keyboard.press('Control+z');
  eq(await count('Text'), 2, 'undo puts the text back');
});

await step('session 8: File > Output > CAD > DXF, then the DXF opened again (layers, items, nothing left out); Save makes a .tcad', async () => {
  await W().getByRole('menuitem', { name: 'File' }).click();
  await page.locator('.menu').getByText('Output', { exact: true }).click();
  await page.locator('.menu').getByText('CAD', { exact: true }).click();
  await page.locator('.menu').getByText('DXF...', { exact: true }).click();
  await D().getByRole('button', { name: 'Choose where...' }).click();
  await D().locator('input[aria-label="File name"]').fill('panel.dxf');
  await D().getByRole('button', { name: 'Save' }).click();
  await page.locator('.toast', { hasText: 'panel.dxf' }).first().waitFor();
  ok((await said(6)).includes('written (AutoCAD R12 DXF'), 'the notes: ' + (await said(6)));
  await W().getByRole('menuitem', { name: 'File' }).click();
  await page.locator('.menu').getByText('Open...', { exact: true }).click();
  await D().locator('.pick-row', { hasText: 'panel.dxf' }).first().dblclick();
  await page.locator('.win .win-bar', { hasText: 'panel.dxf' }).waitFor();
  const names = await W().locator('.cad-layer-name').allInnerTexts().then(t => t.map(s => s.replace(' ✎', '')));
  // Our layers are written in capitals (R12) and open under our own spelling, each once.
  eq(names.filter(n => n !== '0'), ['Geometry', 'Construction', 'Dimensions', 'Text'], 'layers');
  eq(await count('Geometry'), 2, 'the rectangle and the circle');
  ok((await count('Dimensions')) > 20, 'dimensions as lines and text: ' + (await count('Dimensions')));
  ok((await said(4)).includes('Read '), 'the report: ' + (await said(4)));
  ok(!(await page.locator('.dialog').count()), 'nothing left out, so no report box');
  await shot('cad-dxf-opened');
  await page.keyboard.press('Control+Shift+S');
  eq(await D().locator('input[aria-label="File name"]').inputValue(), 'panel.tcad', 'saving a DXF makes a .tcad');
  await D().getByRole('button', { name: 'Cancel' }).click();
  await cmd('measure', '0,0', '600,400');
  ok((await said(1)).includes('Distance 721.11'), 'the corners are where they were: ' + (await said(1)));
  await page.keyboard.press('Escape');
});

/** A file from this computer into a folder of the desktop, through File Explorer's Upload. */
async function upload(file, folder) {
  await page.locator('#desktop .item', { hasText: 'My Files' }).first().dblclick();
  const w = page.locator('.win', { has: page.locator('.explorer') }).first();
  await w.waitFor();
  await w.locator('.explorer-view').focus();
  await page.keyboard.press('Control+L');
  await w.locator('input.address').fill(folder);
  await w.locator('input.address').press('Enter');
  await w.locator('.crumb', { hasText: new RegExp(`^${folder.slice(1)}$`) }).waitFor();
  const chooser = page.waitForEvent('filechooser');
  await w.getByRole('button', { name: 'Upload' }).click();
  (await chooser).setFiles([file]);
  await w.locator('.item', { hasText: file.split(/[\\/]/).pop().replace(/\.[^.]+$/, '') }).first().waitFor({ timeout: 15000 });
  await w.getByRole('button', { name: 'Close', exact: true }).first().click();
}

const photoMenu = async item => {
  await W().getByRole('button', { name: 'Photo to trace' }).click();
  await page.locator('.menu').getByText(item, { exact: true }).click();
};
/** The photo's size, corner, size of a pixel and turn, as Utils > Information gives them. */
async function info() {
  await W().getByRole('button', { name: 'Information about the drawing' }).click();
  const t = await D().innerText();
  await D().getByRole('button').first().click();
  const m = /(\d+) x (\d+) pixels; bottom-left corner at (-?[\d.]+), (-?[\d.]+); ([\d.e-]+) mm a pixel; turned (-?[\d.]+)°/.exec(t);
  ok(m, 'the photo in Information: ' + t);
  return { px: Number(m[1]), py: Number(m[2]), at: [Number(m[3]), Number(m[4])], s: Number(m[5]), turn: Number(m[6]), text: t };
}
/** Where a pixel of the photo (PY pixels high) is on the drawing. */
function photoWorld(ph, [i, j], PY) {
  const a = (ph.turn * Math.PI) / 180;
  const lx = i * ph.s;
  const ly = (PY - j) * ph.s;
  return [ph.at[0] + lx * Math.cos(a) - ly * Math.sin(a), ph.at[1] + lx * Math.sin(a) + ly * Math.cos(a)];
}
/** Starts a photo tool and clicks photo pixels with the snaps off (the points are on the photo, not on anything drawn). */
async function clickPhoto(ph, item, pixels, PY) {
  await W().getByRole('button', { name: 'Zoom fit: the whole drawing' }).click();
  // Worked out first: finding the screen's scale uses the Line tool.
  const at = await mapper();
  await photoMenu(item);
  await canvas().focus();
  await page.keyboard.press('F3');
  for (const px of pixels) {
    const [x, y] = photoWorld(ph, px, PY);
    const q = at(x, y);
    await page.mouse.click(q.x, q.y);
  }
  await page.keyboard.press('F3');
}
/** The middle of the drawing area's pixels of one colour ('green' or 'red') within r screen pixels of a point. */
async function blobNear(q, r, kind) {
  return page.evaluate(({ q, r, kind }) => {
    const cv = [...document.querySelectorAll('.cad-canvas')].pop();
    const box = cv.getBoundingClientRect();
    const k = cv.width / box.width;
    const x0 = Math.max(0, Math.floor((q.x - box.left - r) * k));
    const y0 = Math.max(0, Math.floor((q.y - box.top - r) * k));
    const w = Math.min(cv.width - x0, Math.ceil(2 * r * k));
    const h = Math.min(cv.height - y0, Math.ceil(2 * r * k));
    const d = cv.getContext('2d').getImageData(x0, y0, w, h).data;
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const o = (j * w + i) * 4;
        const [R, G, B] = [d[o], d[o + 1], d[o + 2]];
        if (kind === 'green' ? G > 110 && R < 60 && B < 110 : R > 110 && G < 50) {
          sx += i;
          sy += j;
          n++;
        }
      }
    }
    return n ? { x: box.left + (x0 + sx / n + 0.5) / k, y: box.top + (y0 + sy / n + 0.5) / k, n } : null;
  }, { q, r, kind });
}
/** A screen point back to the drawing, for a map made by mapper(). */
function unmap(q, map) {
  const o = map(0, 0);
  const e = map(1000, 1000);
  return [((q.x - o.x) / (e.x - o.x)) * 1000, ((q.y - o.y) / (e.y - o.y)) * 1000];
}

await step('session 9: a crooked photo lined up, scaled from a known length and moved to 0,0, then traced; kept in the .tcad; printed to scale (pages, preview, PDF); recent drawings; a recovery copy offered after the page closed', async () => {
  await closeAll();
  // A "photo" of a benchtop 1600 x 800 mm, 800 pixels wide, taken 3 degrees crooked: its bottom corners are red dots.
  const PX = 1200;
  const PY = 800;
  const phi = (3 * Math.PI) / 180;
  const BL = [200, 600];
  const BR = [200 + 800 * Math.cos(phi), 600 - 800 * Math.sin(phi)];
  const jpeg = await page.evaluate(({ PX, PY, BL, BR, phi }) => {
    const c = document.createElement('canvas');
    c.width = PX;
    c.height = PY;
    const g = c.getContext('2d');
    g.fillStyle = '#d8c8a8';
    g.fillRect(0, 0, PX, PY);
    const up = [-400 * Math.sin(phi), -400 * Math.cos(phi)];
    g.fillStyle = '#7a5a30';
    g.beginPath();
    g.moveTo(BL[0], BL[1]);
    g.lineTo(BR[0], BR[1]);
    g.lineTo(BR[0] + up[0], BR[1] + up[1]);
    g.lineTo(BL[0] + up[0], BL[1] + up[1]);
    g.closePath();
    g.fill();
    g.fillStyle = '#ff0000';
    for (const q of [BL, BR]) {
      g.beginPath();
      g.arc(q[0], q[1], 6, 0, 7);
      g.fill();
    }
    return c.toDataURL('image/jpeg', 0.92).split(',')[1];
  }, { PX, PY, BL, BR, phi });
  const dir = mkdtempSync(join(tmpdir(), 'cad-walk-'));
  try {
    writeFileSync(join(dir, 'bench.jpg'), Buffer.from(jpeg, 'base64'));
    await upload(join(dir, 'bench.jpg'), '/Pictures');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  await openCad();
  await photoMenu('Open a photo...');
  await D().locator('.pick-row', { hasText: 'bench.jpg' }).first().dblclick();
  await W().locator('.cad-said', { hasText: 'is under the drawing' }).waitFor();
  const worldOf = (ph, px) => photoWorld(ph, px, PY);
  const clickPixels = (ph, item, pixels) => clickPhoto(ph, item, pixels, PY);
  let ph = await info();
  eq(ph.turn, 0, 'laid straight');
  // Line up the crooked bottom edge: the photo turns 3 degrees back.
  await clickPixels(ph, 'Line up an edge (straight across or up)', [BL, BR]);
  ok((await said(4)).includes('clockwise: that edge now runs straight across'), 'lined up: ' + (await said(4)));
  ph = await info();
  ok(Math.abs(ph.turn + 3) < 0.3, 'turned back about 3°: ' + ph.turn);
  // Scale: the two corners are 1600 mm apart, so a pixel is 2 mm.
  await clickPixels(ph, 'Scale by a length you know', [BL, BR]);
  await cmd('1600');
  ok((await said(4)).includes('1600 apart'), 'scaled: ' + (await said(4)));
  ph = await info();
  ok(Math.abs(ph.s - 2) < 0.02, 'about 2 mm a pixel: ' + ph.s);
  // Move: the bottom-left corner to 0,0. The other corner is then at 1600,0.
  await clickPixels(ph, 'Move', [BL]);
  await cmd('0,0');
  ph = await info();
  const bl = worldOf(ph, BL);
  const br = worldOf(ph, BR);
  ok(Math.hypot(bl[0], bl[1]) < 2, 'its corner at 0,0: ' + bl);
  ok(Math.abs(br[0] - 1600) < 3 && Math.abs(br[1]) < 3, 'the other corner at 1600,0: ' + br);
  // Trace the benchtop over it.
  await W().getByRole('button', { name: 'Rectangle: two corners' }).click();
  await cmd('0,0', '1600,800');
  await page.keyboard.press('Escape');
  await W().getByRole('button', { name: 'Zoom fit: the whole drawing' }).click();
  await shot('cad-photo-traced');
  // Kept in the .tcad; and on File > Recent drawings.
  await page.keyboard.press('Control+Shift+S');
  await D().locator('input[aria-label="File name"]').fill('bench.tcad');
  await D().getByRole('button', { name: 'Save' }).click();
  await page.locator('.toast', { hasText: 'bench.tcad' }).first().waitFor();
  await W().getByRole('menuitem', { name: 'File' }).click();
  await page.locator('.menu').getByText('Recent drawings', { exact: true }).click();
  ok(await page.locator('.menu').getByText(/^bench\.tcad/).first().isVisible(), 'bench.tcad is on the recent list');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await closeAll();
  await openCad();
  await W().getByRole('menuitem', { name: 'File' }).click();
  await page.locator('.menu').getByText('Recent drawings', { exact: true }).click();
  await page.locator('.menu').getByText(/^bench\.tcad/).first().click();
  await page.locator('.win .win-bar', { hasText: 'bench.tcad' }).waitFor();
  const again = await info();
  ok(Math.abs(again.s - ph.s) < 1e-6 && Math.abs(again.turn - ph.turn) < 1e-6, 'the photo came back from the file where it was');

  // Print to scale: at 1:1 the 1600 x 800 top takes 30 A4 pages; at 1:10 one, with the photo under it.
  await canvas().focus();
  await page.keyboard.press('Control+p');
  await D().locator('.cad-print-svg').waitFor();
  await D().locator('select[aria-label="Scale"]').selectOption('1');
  ok((await D().locator('.cad-print-summary').innerText()).includes('takes 30 pages'), 'at 1:1: ' + (await D().locator('.cad-print-summary').innerText()));
  eq(await D().locator('.cad-print-page').innerText(), 'Page 1 of 30', 'the page count');
  await D().getByRole('button', { name: 'Page ▶' }).click();
  eq(await D().locator('.cad-print-page').innerText(), 'Page 2 of 30', 'the next page');
  await D().locator('select[aria-label="Scale"]').selectOption('10');
  ok((await D().locator('.cad-print-summary').innerText()).includes('fits on one page'), 'at 1:10: ' + (await D().locator('.cad-print-summary').innerText()));
  await D().getByLabel('The photo under the drawing').check();
  await D().locator('.cad-print-svg image').waitFor({ state: 'attached' });
  ok((await D().locator('.cad-print-svg').innerHTML()).includes('1:10'), 'the title block says 1:10');
  await shot('cad-print');
  await D().getByRole('button', { name: 'Save as PDF...' }).click();
  eq(await D().locator('input[aria-label="File name"]').inputValue(), 'bench.pdf', 'named after the drawing');
  await D().getByRole('button', { name: 'Save' }).click();
  await page.locator('.toast', { hasText: 'bench.pdf' }).first().waitFor();
  ok((await said(1)).includes('at 1:10 saved'), 'the PDF: ' + (await said(1)));

  // A change not saved, a recovery copy kept (as when the lid closes), then the page closes: it is offered back.
  await cmd('line', '0,0', '1600,800', '');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    delete document.visibilityState;
  });
  await page.waitForTimeout(1500);
  page.on('dialog', d => void d.accept());
  await page.reload();
  await page.locator('.gate input[type=password]').first().fill(PASS, { timeout: 15000 }).catch(() => {});
  if (await page.locator('.gate-go').isVisible().catch(() => false)) await page.locator('.gate-go').click();
  await page.locator('#desktop .item').first().waitFor({ timeout: 20000 });
  if (!(await page.locator('.start-filter').isVisible())) await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('tomlin cad');
  await page.locator('.start-menu [data-label="tomlin cad"]').first().click();
  await page.locator('.dialog', { hasText: 'Drawings not saved' }).waitFor({ timeout: 15000 });
  ok((await D().innerText()).includes('bench.tcad: kept'), 'the copy is named: ' + (await D().innerText()));
  await D().getByRole('button', { name: 'Open it' }).click();
  await page.locator('.win .win-bar', { hasText: 'bench.tcad' }).waitFor();
  ok((await said(3)).includes('Recovered bench.tcad'), 'said: ' + (await said(3)));
  eq(await count('Geometry'), 2, 'the top and the line drawn after the save');
  // Closed on purpose: the copy goes, and is not offered again.
  await closeAll();
  await openCad();
  ok(!(await page.locator('.dialog', { hasText: 'Drawings not saved' }).waitFor({ timeout: 2000 }).then(() => true, () => false)), 'nothing offered once it was closed on purpose');
});

await step('straighten a slanted photo: four corners of a 1600 x 800 benchtop shot at a slant, its true middle lands in the middle', async () => {
  await closeAll();
  // A benchtop seen from its near side: the far edge looks shorter. Red dots on its corners; a green one on its true
  // middle (where the diagonals cross, which in a slanted photo is NOT the average of the four corners).
  const PX = 1200;
  const PY = 800;
  const [BL, BR, TR, TL] = [[150, 720], [1050, 720], [880, 260], [320, 260]];
  const t = ((BR[0] - BL[0]) * (TL[1] - BR[1]) - (BR[1] - BL[1]) * (TL[0] - BR[0])) / ((TR[0] - BL[0]) * (TL[1] - BR[1]) - (TR[1] - BL[1]) * (TL[0] - BR[0]));
  const MID = [BL[0] + t * (TR[0] - BL[0]), BL[1] + t * (TR[1] - BL[1])];
  const jpeg = await page.evaluate(({ PX, PY, Q, MID }) => {
    const c = document.createElement('canvas');
    c.width = PX;
    c.height = PY;
    const g = c.getContext('2d');
    g.fillStyle = '#d8c8a8';
    g.fillRect(0, 0, PX, PY);
    g.fillStyle = '#7a5a30';
    g.beginPath();
    Q.forEach((q, i) => (i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1])));
    g.closePath();
    g.fill();
    const dot = (q, colour) => {
      g.fillStyle = colour;
      g.beginPath();
      g.arc(q[0], q[1], 7, 0, 7);
      g.fill();
    };
    for (const q of Q) dot(q, '#ff0000');
    dot(MID, '#00ff00');
    return c.toDataURL('image/jpeg', 0.95).split(',')[1];
  }, { PX, PY, Q: [BL, BR, TR, TL], MID });
  const dir = mkdtempSync(join(tmpdir(), 'cad-walk-'));
  try {
    writeFileSync(join(dir, 'slanted.jpg'), Buffer.from(jpeg, 'base64'));
    await upload(join(dir, 'slanted.jpg'), '/Pictures');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  await openCad();
  await photoMenu('Open a photo...');
  await D().locator('.pick-row', { hasText: 'slanted.jpg' }).first().dblclick();
  await W().locator('.cad-said', { hasText: 'is under the drawing' }).waitFor();
  const ph = await info();
  const first = photoWorld(ph, BL, PY);
  await clickPhoto(ph, 'Straighten a slanted photo (four corners)', [BL, BR, TR, TL], PY);
  ok((await W().locator('.cad-xyin').innerText()).includes('Width'), 'it asks for the width and height');
  await cmd('1600,800');
  await W().locator('.cad-said', { hasText: 'Photo straightened' }).waitFor({ timeout: 20000 });
  ok((await said(2)).includes('1600 x 800 rectangle'), 'said: ' + (await said(2)));
  const after = await info();
  ok(after.text.includes('straightened') && after.turn === 0, 'straightened and square: ' + after.text);
  ok(after.px <= 3000 && after.py <= 3000, `at most 3000 pixels across: ${after.px} x ${after.py}`);
  // Where the corners and the middle are now, found on screen by their colours.
  await W().getByRole('button', { name: 'Zoom fit: the whole drawing' }).click();
  const at = await mapper();
  const expect = [[800, 400, 'green', 'the true middle'], [0, 0, 'red', '1st corner'], [1600, 0, 'red', '2nd corner'], [1600, 800, 'red', '3rd corner'], [0, 800, 'red', '4th corner']];
  for (const [dx, dy, kind, what] of expect) {
    const want = [first[0] + dx, first[1] + dy];
    const found = await blobNear(at(want[0], want[1]), 25, kind);
    ok(found, `${what}: a ${kind} dot near ${want}`);
    if (!found) continue;
    const got = unmap(found, at);
    ok(Math.hypot(got[0] - want[0], got[1] - want[1]) < 20, `${what} at ${got.map(v => v.toFixed(1))}, expected ${want.map(v => v.toFixed(1))}`);
  }
  await shot('cad-photo-straightened');
  // Undo puts the slanted photo back.
  await canvas().focus();
  await page.keyboard.press('Control+z');
  const undone = await info();
  ok(undone.px === PX && !undone.text.includes('straightened'), 'Undo: the photo as it was: ' + undone.text);
});

await step('pen and touch: a tap snaps from further than a mouse, a held finger finishes the tool or opens the menu, two fingers pan and pinch', async () => {
  await closeAll();
  await openCad();
  await W().getByRole('button', { name: 'Rectangle: two corners' }).click();
  await cmd('0,0', '1600,800');
  await page.keyboard.press('Escape');
  await W().getByRole('button', { name: 'Zoom fit: the whole drawing' }).click();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i, radiusX: 4, radiusY: 4 })) });
  const tap = async p => {
    await touch('touchStart', [p]);
    await touch('touchEnd', []);
    await page.waitForTimeout(80);
  };
  const hold = async p => {
    await touch('touchStart', [p]);
    await page.waitForTimeout(800);
    await touch('touchEnd', []);
    await page.waitForTimeout(150);
  };
  /** Two fingers from a and b, each moved by its own amount, in 6 even moves. */
  const two = async (a, b, da, db) => {
    await touch('touchStart', [a, b]);
    for (let k = 1; k <= 6; k++) {
      await touch('touchMove', [{ x: a.x + (da.x * k) / 6, y: a.y + (da.y * k) / 6 }, { x: b.x + (db.x * k) / 6, y: b.y + (db.y * k) / 6 }]);
    }
    await touch('touchEnd', []);
    await page.waitForTimeout(150);
  };
  try {
    let at = await mapper();
    // The Line button tapped: the keyboard stays out of the X box (on a tablet it would cover the drawing).
    const lineBtn = await W().getByRole('button', { name: /^Line\b/ }).first().boundingBox();
    await tap({ x: lineBtn.x + lineBtn.width / 2, y: lineBtn.y + lineBtn.height / 2 });
    ok((await W().locator('.cad-prompt').innerText()).startsWith('Line'), 'the Line tool by a tap: ' + (await W().locator('.cad-prompt').innerText()));
    eq(await page.evaluate(() => document.activeElement?.tagName), 'CANVAS', 'the drawing keeps the keyboard, not the X box');
    // 14 px across and 14 px up from each corner (20 px away): beyond a mouse's 14 px, caught by a finger.
    const c0 = at(0, 0);
    const c1 = at(1600, 800);
    await tap({ x: c0.x + 14, y: c0.y - 14 });
    await tap({ x: c1.x - 14, y: c1.y + 14 });
    await hold({ x: c1.x - 200, y: c1.y + 120 });
    ok(!(await W().locator('.cad-done').isVisible()), 'a held finger finished the Line tool');
    eq(await count('Geometry'), 2, 'the rectangle and the line');
    // The line's two ends are exactly on the corners.
    await cmd('list');
    const m = at(800, 400);
    await page.mouse.click(m.x, m.y);
    await D().waitFor();
    const listed = await D().innerText();
    ok(listed.includes('From 0, 0 to 1600, 800'), 'from corner to corner: ' + listed);
    await D().getByRole('button').first().click();
    await page.keyboard.press('Escape');
    // Pinch: the fingers twice as far apart, the drawing twice as big about the point between them.
    const box = await canvas().boundingBox();
    const mid = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const under = unmap(mid, at);
    const before = at(1600, 0).x - at(0, 0).x;
    await two({ x: mid.x - 60, y: mid.y }, { x: mid.x + 60, y: mid.y }, { x: -60, y: 0 }, { x: 60, y: 0 });
    at = await mapper();
    const ratio = (at(1600, 0).x - at(0, 0).x) / before;
    ok(Math.abs(ratio - 2) < 0.06, 'pinched out to twice as big: ' + ratio.toFixed(3));
    const still = at(under[0], under[1]);
    ok(Math.hypot(still.x - mid.x, still.y - mid.y) < 4, `the point between the fingers stayed: ${still.x.toFixed(1)},${still.y.toFixed(1)} vs ${mid.x},${mid.y}`);
    // Two fingers moved together: the drawing moves with them.
    const p0 = at(0, 0);
    await two({ x: mid.x - 40, y: mid.y }, { x: mid.x + 40, y: mid.y }, { x: 120, y: 60 }, { x: 120, y: 60 });
    at = await mapper();
    const p1 = at(0, 0);
    ok(Math.abs(p1.x - p0.x - 120) < 4 && Math.abs(p1.y - p0.y - 60) < 4, `moved 120 across and 60 down: ${(p1.x - p0.x).toFixed(1)}, ${(p1.y - p0.y).toFixed(1)}`);
    // A finger held with no tool: the drawing's menu.
    await hold(mid);
    ok(await page.locator('.menu').getByText('Zoom fit', { exact: true }).isVisible(), 'the menu from a held finger');
    await page.keyboard.press('Escape');
  } finally {
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
    await cdp.detach().catch(() => {});
  }
});

await step('parts library: a starter hinge cup placed, saved as my own part with a base point, then placed again turned', async () => {
  await closeAll();
  await openCad();
  const partsMenu = async item => {
    await W().getByRole('menuitem', { name: 'Geometry' }).click();
    await page.locator('.menu').getByText('Parts', { exact: true }).click();
    await page.locator('.menu').getByText(item, { exact: true }).click();
  };
  await partsMenu('Insert a part...');
  ok(await D().locator('.cad-part-preview').waitFor({ timeout: 5000 }).then(() => true, () => false), 'a preview of the part');
  ok((await D().locator('select[aria-label="Parts"]').inputValue()) === '0' && (await D().innerText()).includes('Hinge cup 35 mm'), 'the starter hinge cup is listed first');
  await D().getByRole('button', { name: 'OK' }).click();
  ok((await W().locator('.cad-prompt').innerText()).includes('Where it goes'), 'asks where: ' + (await W().locator('.cad-prompt').innerText()));
  await cmd('100,50');
  await canvas().focus();
  await page.keyboard.press('Enter');
  ok((await said(2)).includes('3 items placed and chosen'), 'placed: ' + (await said(2)));
  await cmd('');
  eq(await count('Geometry'), 3, 'a cup and two screw holes');
  // Saved as my own part, placed by the cup's middle.
  await partsMenu('Save the chosen items as a part...');
  await cmd('100,50');
  await D().locator('input[aria-label="Name of the part"]').fill('My hinge');
  await D().getByRole('button', { name: 'OK' }).click();
  const saved = await W().locator('.cad-said', { hasText: 'Part “My hinge” saved' }).waitFor({ timeout: 10000 }).then(() => true, () => false);
  ok(saved, `saved as a part: ${await said(4)} | box: ${(await page.locator('.dialog').count()) ? await D().innerText() : 'none'}`);
  // Placed again, a quarter turn: my part is first in the list.
  await partsMenu('Insert a part...');
  const first = await D().locator('select[aria-label="Parts"] option').first().innerText();
  eq(first, 'My hinge', 'my own part first');
  await D().getByRole('button', { name: 'OK' }).click();
  await cmd('300,50', '90', '');
  eq(await count('Geometry'), 6, 'two hinges now');
  // A screw hole of the turned one: (22.5, 9.5) from its base turned a quarter is (-9.5, 22.5) -> 290.5, 72.5.
  await W().getByRole('button', { name: 'Zoom fit: the whole drawing' }).click();
  const at = await mapper();
  await cmd('list');
  const q = at(290.5, 72.5 + 4);
  await page.mouse.click(q.x, q.y);
  await D().waitFor();
  const listed = await D().innerText();
  ok(listed.includes('Centre 290.5, 72.5') && listed.includes('diameter 8'), 'the turned screw hole: ' + listed);
  await D().getByRole('button').first().click();
  await page.keyboard.press('Escape');
});

await step('audit fixes: Undo after a save, then a new line, shows unsaved; Undo after Units brings millimetres back; Pan keeps a polyline being drawn', async () => {
  await closeAll();
  await openCad();
  const dirty = async () => (await page.locator('.task-label', { hasText: 'TOMLIN CAD' }).last().innerText()).trim().endsWith('*');
  await cmd('line', '0,0', '100,0', '');
  await page.keyboard.press('Control+Shift+S');
  await D().locator('input[aria-label="File name"]').fill('undo-check.tcad');
  await D().getByRole('button', { name: 'Save' }).click();
  await page.locator('.toast', { hasText: 'undo-check.tcad' }).first().waitFor();
  ok(!(await dirty()), 'saved: no star');
  await canvas().focus();
  await page.keyboard.press('Control+z');
  ok(await dirty(), 'undone after the save: a star');
  await cmd('line', '0,0', '0,100', '');
  ok(await dirty(), 'a different line drawn: still a star (it was clean here before the fix)');
  // Units, sizes changed, then Undo: the drawing is in millimetres again, and so are its numbers.
  await W().locator('.cad-cell-btn', { hasText: /^mm$/ }).click();
  await D().getByLabel('Inches').check();
  await D().getByRole('button', { name: 'OK' }).click();
  eq(await W().locator('.cad-cell-btn', { hasText: /^(mm|inch)$/ }).innerText(), 'inch', 'now inches');
  await canvas().focus();
  await page.keyboard.press('Control+z');
  eq(await W().locator('.cad-cell-btn', { hasText: /^(mm|inch)$/ }).innerText(), 'mm', 'Undo: millimetres again');
  // A polyline part-way through survives a press of Pan.
  await cmd('polyline', '200,0', '300,0', '300,100');
  await W().getByRole('button', { name: /^Pan:/ }).click();
  await W().getByRole('button', { name: /^Pan:/ }).click();
  ok((await W().locator('.cad-prompt').innerText()).startsWith('Polyline'), 'the polyline is still being drawn: ' + (await W().locator('.cad-prompt').innerText()));
  await cmd('');
  eq(await count('Geometry'), 2, 'the line and the polyline');
});

await step('a DXF with items at a height and a dashed line of its own says so; outputting over that DXF asks first', async () => {
  await closeAll();
  const dir = mkdtempSync(join(tmpdir(), 'cad-walk-'));
  try {
    const lines = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES',
      '0', 'LINE', '8', 'CUT', '10', '0', '20', '0', '30', '-18', '11', '600', '21', '0', '31', '-18',
      '0', 'LINE', '8', 'CUT', '6', 'DASHED', '10', '0', '20', '100', '30', '0', '11', '600', '21', '100', '31', '0',
      '0', 'ENDSEC', '0', 'EOF'];
    writeFileSync(join(dir, 'heights.dxf'), lines.join('\r\n') + '\r\n');
    await upload(join(dir, 'heights.dxf'), '/Documents');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  await openCad();
  await W().getByRole('menuitem', { name: 'File' }).click();
  await page.locator('.menu').getByText('Open...', { exact: true }).click();
  await D().locator('.pick-row', { hasText: 'heights.dxf' }).first().dblclick();
  await D().getByText(/1 item sits at a height \(Z\) other than 0/).waitFor();
  ok((await D().innerText()).includes('1 item has a line type of its own'), 'the dashed line is said: ' + (await D().innerText()));
  await shot('cad-dxf-heights');
  await D().getByRole('button', { name: 'OK' }).click();
  eq(await count('CUT'), 2, 'both lines are drawn');
  await W().getByRole('menuitem', { name: 'File' }).click();
  await page.locator('.menu').getByText('Output', { exact: true }).click();
  await page.locator('.menu').getByText('CAD', { exact: true }).click();
  await page.locator('.menu').getByText('DXF...', { exact: true }).click();
  await D().getByRole('button', { name: 'Choose where...' }).click();
  await D().locator('input[aria-label="File name"]').fill('heights.dxf');
  await D().getByRole('button', { name: 'Save' }).click();
  await D().getByRole('button', { name: 'Replace' }).click();
  await D().getByText('Write over the DXF this came from?').waitFor();
  await D().getByRole('button', { name: 'Cancel' }).click();
  ok(!(await page.locator('.toast', { hasText: 'Saved “heights.dxf”' }).count()), 'nothing was written');
  // The next step works in a new drawing.
  await closeAll();
  await openCad();
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
// On Windows, closing the browser can hang after a page reload: wait 5 seconds at most.
await Promise.race([browser.close().catch(() => {}), new Promise(done => setTimeout(done, 5000))]);
process.exit(failures.length ? 1 : 0);
