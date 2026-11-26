// Photo Editor's menu bar and toolbars, text with an outline, and Meme (bars that extend the picture, text boxes that
// can be dragged, resized and deleted), in a real Chrome, checking the pixels on screen. Needs the dev server on a
// FRESH, EMPTY data folder (the first step sets up the owner), and `npm run build` done.
//   node test/browser-photoedit-meme.mjs [http://127.0.0.1:3052] [screenshot folder]
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3052';
const SHOTS = process.argv[3] ?? null;
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PASS = 'photo-meme-passphrase-42';
let passed = 0;
const failures = [];
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await context.newPage();
const problems = [];
page.on('console', m => m.type() === 'error' && problems.push('console: ' + m.text()));
page.on('pageerror', e => problems.push('pageerror: ' + e.message));
const shot = async (name, locator) => SHOTS && (locator ? locator.screenshot({ path: `${SHOTS}/${name}.png` }) : page.screenshot({ path: `${SHOTS}/${name}.png` }));
async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (error) {
    failures.push(name);
    await shot('fail-meme-' + failures.length).catch(() => {});
    console.log('  FAIL ' + name + '\n       ' + String(error.message).slice(0, 1500));
  }
}
const eq = (a, b, what) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const ok = (v, what) => {
  if (!v) throw new Error(what);
};
const W = () => page.locator('.win', { has: page.locator('.pe') });
const pixel = (x, y) => page.evaluate(([x, y]) => [...document.querySelector('.pe-doc').getContext('2d').getImageData(x, y, 1, 1).data], [x, y]);
const picSize = () => page.evaluate(() => [document.querySelector('.pe-doc').width, document.querySelector('.pe-doc').height]);
async function at(x, y) {
  const box = await W().locator('.pe-over').boundingBox();
  const size = await picSize();
  return { x: box.x + ((x + 0.5) * box.width) / size[0], y: box.y + ((y + 0.5) * box.height) / size[1] };
}
async function dragPic(a, b) {
  const p = await at(...a), q = await at(...b);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(q.x, q.y, { steps: 8 });
  await page.mouse.up();
}
async function clickPic(x, y) {
  const p = await at(x, y);
  await page.mouse.click(p.x, p.y);
}
const layerNames = () => W().locator('.pe-layer-name').allInnerTexts();
const tool = name => W().locator('[data-toolbar="tools"]').getByRole('button', { name, exact: true }).click();
const menu = async (menuName, item) => {
  await W().locator(`.cbar-title[data-menu="${menuName}"]`).click();
  await page.locator('.menu').last().getByText(item, { exact: true }).first().click();
};
const setColour = (label, hex) => W().locator(`input[aria-label="${label}"]`).first().evaluate((el, v) => {
  el.value = v;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}, hex);
/** The colours met along a row of the picture, as runs: G grey, B black, W white, ? anything else. */
const runs = (y, x0, x1, grey) => page.evaluate(([y, x0, x1, grey]) => {
  const d = document.querySelector('.pe-doc').getContext('2d').getImageData(x0, y, x1 - x0, 1).data;
  const seen = [];
  for (let i = 0; i < d.length; i += 4) {
    const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
    const c = r > 235 && g > 235 && b > 235 ? 'W' : r < 30 && g < 30 && b < 30 ? 'B' : Math.abs(r - grey) < 12 && Math.abs(g - grey) < 12 && Math.abs(b - grey) < 12 ? 'G' : '?';
    if (seen.length && seen[seen.length - 1][0] === c) seen[seen.length - 1][1]++;
    else seen.push([c, 1]);
  }
  // Runs of two pixels or more (a soft edge between black and white passes through grey for a pixel).
  let out = '';
  for (const [c, n] of seen) if (n >= 2 && c !== '?' && out[out.length - 1] !== c) out += c;
  return out;
}, [y, x0, x1, grey]);
/** Counts of near-white and near-black pixels inside a part of the picture. */
const whiteBlack = (x, y, w, h) => page.evaluate(([x, y, w, h]) => {
  const d = document.querySelector('.pe-doc').getContext('2d').getImageData(x, y, w, h).data;
  let white = 0, black = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] > 235 && d[i + 1] > 235 && d[i + 2] > 235) white++;
    else if (d[i] < 30 && d[i + 1] < 30 && d[i + 2] < 30) black++;
  }
  return { white, black };
}, [x, y, w, h]);
const docks = () => W().evaluate(el => Object.fromEntries(['top', 'left', 'right'].map(s => [s, [...el.querySelectorAll(`.cbar-dock[data-side="${s}"] > .cbar-band`)].filter(b => !b.hidden).map(b => b.dataset.toolbar)])));
async function viewToolbars() {
  await W().locator('.cbar-title[data-menu="View"]').click();
  await page.locator('.menu .menu-item', { hasText: 'Toolbars' }).first().click();
}
async function newPicture(w, h) {
  await menu('File', 'New...');
  const lose = page.locator('.dialog', { hasText: 'Not saved' });
  if (await lose.count()) await lose.getByRole('button', { name: 'Lose the changes' }).click();
  await page.locator('.dialog input[aria-label="Width"]').fill(String(w));
  await page.locator('.dialog input[aria-label="Height"]').fill(String(h));
  await page.locator('.dialog').getByRole('button', { name: 'Create' }).click();
  await W().locator('.pe-status', { hasText: `${w} × ${h}` }).waitFor();
}
async function reopen(name) {
  await W().locator('.win-close').first().click();
  const ask = page.locator('.dialog');
  if (await ask.count()) await ask.getByRole('button').last().click().catch(() => {});
  await page.keyboard.press('Control+Alt+e');
  const x = page.locator('.win.active');
  await x.locator('.item', { hasText: 'Pictures' }).first().dblclick();
  await x.locator('.item', { hasText: name }).first().dblclick();
  // A flat picture opens in Photos first: its Edit button brings it to Photo Editor.
  if (!name.endsWith('.ora')) {
    const viewer = page.locator('.win', { has: page.locator('.photos') });
    await viewer.getByRole('button', { name: 'Edit', exact: true }).click();
    await W().locator('.pe-status', { hasText: name }).waitFor({ timeout: 10000 });
    await viewer.locator('.win-close').first().click().catch(() => {});
  }
  await W().locator('.pe-status', { hasText: name }).waitFor({ timeout: 10000 });
  await page.locator('.win', { has: page.locator('.explorer') }).locator('.win-close').first().click().catch(() => {});
  await W().locator('.win-max, [aria-label="Maximise"], [aria-label="Maximize"]').first().click().catch(() => {});
}

await page.goto(BASE);
await step('set up a fresh desktop', async () => {
  await page.locator('.gate h1', { hasText: 'Set up this desktop' }).waitFor({ timeout: 20000 });
  await page.getByLabel('Your name').fill('Walk Tester');
  await page.locator('.gate input.gate-input').last().fill(PASS);
  await page.locator('.gate-encrypt').uncheck();
  await page.locator('.gate-go').click();
  await page.locator('.gate h1', { hasText: 'Your recovery key' }).waitFor({ timeout: 30000 });
  await page.locator('.gate .check-row input').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#desktop .item').first().waitFor({ timeout: 20000 });
});

await step('Photo Editor has the menu bar (File, Edit, View ... Help) and three toolbars, Tools down the left with a drawn picture on every tool', async () => {
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('photo editor');
  await page.locator('.start-menu [data-label="photo editor"]').first().click();
  await W().waitFor();
  await W().locator('.win-max, [aria-label="Maximise"], [aria-label="Maximize"]').first().click().catch(() => {});
  eq(await W().locator('.cbar-title:visible').allInnerTexts(), ['File', 'Edit', 'View', 'Image', 'Layer', 'Select', 'Tools', 'Colours', 'Filters', 'Help'], 'menus');
  eq(await docks(), { top: ['standard', 'options'], left: ['tools'], right: [] }, 'the usual places');
  const tools = W().locator('[data-toolbar="tools"] .cbar-tool:not(.cbar-more)');
  ok((await tools.count()) >= 23, 'every tool and Meme');
  eq(await W().locator('[data-toolbar="tools"] .cbar-tool:not(.cbar-more):not(:has(svg.ti))').count(), 0, 'each has a drawn picture');
  // The Text tool's picture is a filled T, not a letter from a font.
  const text = W().locator('[data-toolbar="tools"]').getByRole('button', { name: 'Text', exact: true });
  eq(await text.locator('svg.ti-text path').count(), 1, 'the T is drawn');
  eq(await text.evaluate(el => el.textContent.trim()), '', 'no letter in the button');
  // Two columns down the left, as an image editor's toolbox.
  const xs = await tools.evaluateAll(els => [...new Set(els.filter(e => !e.hidden).map(e => Math.round(e.getBoundingClientRect().x)))]);
  eq(xs.length, 2, 'two columns');
  const font = await W().locator('.cbar-title, .pe-options label, .pe-hint').evaluateAll(els => Math.min(...els.map(e => parseFloat(getComputedStyle(e).fontSize))));
  ok(font >= 12, `no text under 12 px: ${font}`);
  await newPicture(400, 300);
  await shot('photoedit-new');
});

await step('toolbars: View > Toolbars hides and shows Tools, docks it on the right and back, and Reset toolbars puts them back', async () => {
  await viewToolbars();
  eq(await page.locator('.menu').last().locator(':scope > .menu-item .menu-label').allTextContents(), ['Standard', 'Tools', 'Tool options', 'Position', 'Reset toolbars'], 'Toolbars menu');
  await page.locator('.menu').last().locator('.menu-item', { hasText: 'Tools' }).first().click();
  await page.waitForTimeout(100);
  ok(await W().locator('[data-toolbar="tools"]').isHidden(), 'Tools hidden');
  // The keys still choose tools.
  await W().locator('.pe-stage').focus();
  await page.keyboard.press('t');
  await viewToolbars();
  await page.locator('.menu').last().locator('.menu-item', { hasText: 'Tools' }).first().click();
  await page.waitForTimeout(100);
  ok(await W().locator('[data-toolbar="tools"]').isVisible(), 'Tools back');
  eq(await W().locator('[data-toolbar="tools"]').getByRole('button', { name: 'Text', exact: true }).getAttribute('aria-pressed'), 'true', 'T chose the Text tool');
  await viewToolbars();
  await page.locator('.menu').last().locator('.menu-item', { hasText: 'Position' }).click();
  await page.locator('.menu').last().locator('.menu-item', { hasText: 'Tools' }).first().click();
  await page.locator('.menu').last().locator('.menu-item', { hasText: 'Right' }).click();
  await page.waitForTimeout(150);
  eq((await docks()).right, ['tools'], 'Tools on the right');
  await viewToolbars();
  await page.locator('.menu').last().locator('.menu-item', { hasText: 'Reset toolbars' }).click();
  await page.waitForTimeout(150);
  eq(await docks(), { top: ['standard', 'options'], left: ['tools'], right: [] }, 'back to the usual places');
  // Undo on the Standard toolbar is greyed with nothing to undo.
  eq(await W().locator('[data-toolbar="standard"] [data-tool="undo"]').getAttribute('aria-disabled'), 'true', 'Undo greyed');
});

await step('text with an outline: white letters, a black edge round them, on grey', async () => {
  await tool('Fill (paint bucket)');
  await setColour('Colour', '#808080');
  await clickPic(5, 5);
  eq(await pixel(5, 5), [128, 128, 128, 255], 'grey');
  await tool('Text');
  ok(await W().locator('.pe-outline').isVisible(), 'the outline settings show with the Text tool');
  await W().getByRole('button', { name: 'White with black outline' }).click();
  eq(await W().locator('input[aria-label="Outline round the letters"]').isChecked(), true, 'outline on');
  eq(await W().locator('input[aria-label="Colour"]').inputValue(), '#ffffff', 'white letters');
  eq(await W().locator('input[aria-label="Outline colour"]').inputValue(), '#000000', 'black outline');
  await clickPic(40, 60);
  const dlg = page.locator('.dialog');
  await dlg.locator('textarea[aria-label="Words"]').fill('HI');
  await dlg.locator('input[aria-label="Text size"]').fill('120');
  await dlg.locator('select[aria-label="Font"]').selectOption('Arial');
  await dlg.locator('input[aria-label="Bold"]').check();
  eq(await dlg.locator('input[aria-label="Outline round the letters"]').isChecked(), true, 'the window has it on');
  eq(await dlg.locator('input[aria-label^="Outline width"]').getAttribute('placeholder'), 'auto (10)', 'a twelfth of 120');
  await dlg.locator('input[aria-label^="Outline width"]').fill('6');
  await dlg.getByRole('button', { name: 'Add' }).click();
  eq((await layerNames())[0], 'HI', 'a text layer');
  // Across the H's left stem: grey, then the black outline, the white letter, black again, then grey.
  const row = await runs(95, 30, 90, 128);
  ok(/GB+W+B+G/.test(row.replace(/\?/g, '')), `grey, black, white, black, grey across the stem: ${row}`);
  const c = await whiteBlack(30, 50, 260, 170);
  ok(c.white > 1500 && c.black > 800, `white letters and black outline: ${JSON.stringify(c)}`);
  await shot('text-outline', W().locator('.pe-stage'));
});

await step('the outline is kept in .ora: reopened, the layer is still text with its outline, and can be changed', async () => {
  await page.keyboard.press('Control+s');
  const name = page.locator('.dialog input[aria-label="File name"]');
  await name.fill('outline.ora');
  await page.locator('.dialog').getByRole('button', { name: 'Save' }).click();
  await page.locator('.toast', { hasText: 'Saved “outline.ora”' }).waitFor();
  await reopen('outline.ora');
  eq(await layerNames(), ['HI', 'Background'], 'layers back');
  ok(/GB+W+B+G/.test((await runs(95, 30, 90, 128)).replace(/\?/g, '')), 'outline drawn again');
  await W().locator('.pe-layer', { hasText: 'HI' }).click();
  await menu('Layer', 'Change the text...');
  const dlg = page.locator('.dialog');
  eq(await dlg.locator('input[aria-label="Outline round the letters"]').isChecked(), true, 'outline kept');
  eq(await dlg.locator('input[aria-label="Outline colour"]').inputValue(), '#000000', 'its colour');
  eq(await dlg.locator('input[aria-label^="Outline width"]').inputValue(), '6', 'its width');
  // Editable: turn it off.
  await dlg.locator('input[aria-label="Outline round the letters"]').uncheck();
  await dlg.getByRole('button', { name: 'Change' }).click();
  ok(!/B/.test(await runs(95, 30, 90, 128)), 'no black once the outline is off');
  await page.keyboard.press('Control+z');
  ok(/GB+W+B+G/.test((await runs(95, 30, 90, 128)).replace(/\?/g, '')), 'Undo brings it back');
});

const M = () => W().locator('.pe-meme');
const field = placeholder => M().locator(`input[aria-label="Words of the text box"][placeholder="${placeholder}"]`);
const sizeText = async () => (await W().locator('.pe-status').innerText()).match(/(\d+) × (\d+) pixels/).slice(1).map(Number);
const near = (a, b, tol = 8) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const BLUE = [40, 90, 200, 255];

await step('Meme opens from Image > Meme... with a box at the top and the bottom of the picture, not drawn until typed', async () => {
  await newPicture(400, 300);
  await tool('Fill (paint bucket)');
  await setColour('Colour', '#285ac8');
  await clickPic(200, 150);
  ok(near(await pixel(200, 150), BLUE), 'blue picture');
  await menu('Image', 'Meme...');
  await M().waitFor();
  eq(await W().locator('[data-toolbar="tools"] [data-tool="meme"]').getAttribute('aria-pressed'), 'true', 'the Meme button shows it is open');
  eq(await M().locator('select[aria-label="Bars"]').inputValue(), 'none', 'no bars at first');
  eq(await field('Top text').count(), 1, 'a top box');
  eq(await field('Bottom text').count(), 1, 'a bottom box');
  eq((await layerNames()).length, 3, 'two text layers on the picture');
  ok(near(await pixel(200, 40), BLUE) && near(await pixel(200, 260), BLUE), 'nothing drawn yet');
});

await step('bars: Top and bottom add 18% of the height above and below (the picture is not covered); Top or Bottom alone; Undo takes them back', async () => {
  await M().locator('select[aria-label="Bars"]').selectOption('both');
  eq(await sizeText(), [400, 408], '54 px above and below');
  eq(await pixel(200, 5), [255, 255, 255, 255], 'white bar at the top');
  eq(await pixel(200, 404), [255, 255, 255, 255], 'white bar at the bottom');
  ok(near(await pixel(200, 56), BLUE) && near(await pixel(200, 352), BLUE), 'the whole picture between them');
  eq(await layerNames(), ['Bottom text', 'Top text', 'Background', 'Meme bars'], 'the bars layer under the picture');
  // Ctrl+Z in the list box would be the list's own; on the picture it undoes.
  await W().locator('.pe-stage').focus();
  await page.keyboard.press('Control+z');
  eq(await sizeText(), [400, 300], 'Undo: no bars');
  ok(near(await pixel(200, 5), BLUE), 'the picture at the top again');
  await page.keyboard.press('Control+y');
  eq(await sizeText(), [400, 408], 'Redo: bars back');
  await M().locator('select[aria-label="Bars"]').selectOption('top');
  eq(await sizeText(), [400, 354], 'top only');
  eq(await pixel(200, 5), [255, 255, 255, 255], 'white at the top');
  ok(near(await pixel(200, 353), BLUE), 'picture to the bottom edge');
  await M().locator('select[aria-label="Bars"]').selectOption('bottom');
  eq(await sizeText(), [400, 354], 'bottom only');
  ok(near(await pixel(200, 1), BLUE), 'picture from the top edge');
  eq(await pixel(200, 350), [255, 255, 255, 255], 'white at the bottom');
  await M().locator('select[aria-label="Bars"]').selectOption('both');
  eq(await sizeText(), [400, 408], 'both again');
  // Laid over: the picture keeps its size; back to added.
  await M().locator('select[aria-label="How the bars go on"]').selectOption('overlay');
  eq(await sizeText(), [400, 300], 'laid over the picture');
  eq(await pixel(200, 5), [255, 255, 255, 255], 'white over the top of the picture');
  ok(near(await pixel(200, 150), BLUE), 'the middle shows');
  await M().locator('select[aria-label="How the bars go on"]').selectOption('extend');
  eq(await sizeText(), [400, 408], 'added again');
});

await step('words typed into a box appear (black on the white bar); Undo takes the words back', async () => {
  await field('Top text').fill('WHEN THE BUILD PASSES');
  const c = await whiteBlack(0, 0, 400, 54);
  ok(c.black > 300, `black words on the top bar: ${JSON.stringify(c)}`);
  await field('Top text').press('Enter');
  await field('Bottom text').fill('FIRST TIME');
  await field('Bottom text').press('Enter');
  ok((await whiteBlack(0, 354, 400, 54)).black > 200, 'bottom words');
  await W().locator('.pe-stage').focus();
  await page.keyboard.press('Control+z');
  eq((await whiteBlack(0, 354, 400, 54)).black, 0, 'Undo: the bottom words gone');
  ok((await whiteBlack(0, 0, 400, 54)).black > 300, 'the top words stay');
  await page.keyboard.press('Control+y');
  ok((await whiteBlack(0, 354, 400, 54)).black > 200, 'Redo: back');
  eq(await field('Bottom text').inputValue(), 'FIRST TIME', 'the field follows');
});

/** White and black pixels inside a part of the picture, as one number each. */
const wb = async (x, y, w, h) => whiteBlack(x, y, w, h);

await step('Add text box: white words with a black outline on the picture; drag to move, a corner square to resize', async () => {
  await M().getByRole('button', { name: 'Add text box' }).click();
  await page.keyboard.type('NICE');
  await M().locator('input[aria-label="Words of the text box"]:focus').press('Enter');
  // The new box is across the middle: 40..360 by 175..235 (on a 400 × 408 picture).
  const mid = await wb(40, 150, 320, 110);
  ok(mid.white > 400 && mid.black > 200, `white and black in the middle: ${JSON.stringify(mid)}`);

  // Drag it by its inside 80 px down.
  await dragPic([200, 205], [200, 285]);
  const after = await wb(40, 150, 320, 70);
  const lower = await wb(40, 255, 320, 90);
  ok(after.white < mid.white / 4, `gone from where it was: ${JSON.stringify(after)}`);
  ok(lower.white > 400, `now lower down: ${JSON.stringify(lower)}`);
  // Stretch it by the bottom right square: bigger box, bigger words.
  const before = (await wb(0, 54, 400, 300)).white;
  await dragPic([360, 325], [390, 352]);
  const bigger = (await wb(0, 54, 400, 300)).white;
  ok(bigger > before * 1.15, `bigger words: ${before} then ${bigger}`);
  await page.keyboard.press('Control+z');
  eq((await wb(0, 54, 400, 300)).white, before, 'Undo: the size before');
});

await step('the arrow keys nudge the chosen box; Delete in a field types, Delete on the picture takes the box away', async () => {
  await W().locator('.pe-stage').focus();
  const a = await wb(0, 54, 200, 300);
  for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowLeft');
  const b = await wb(0, 54, 200, 300);
  ok(b.white > a.white, `40 px to the left: ${a.white} then ${b.white}`);
  await page.keyboard.press('Control+z');
  // Delete in a field is for the words.
  const layers = (await layerNames()).length;
  await field('Top text').focus();
  await page.keyboard.press('End');
  await page.keyboard.press('Delete');
  eq((await layerNames()).length, layers, 'Delete in a field leaves the box');
  eq(await field('Top text').inputValue(), 'WHEN THE BUILD PASSES', 'and the words');
  // Pick the middle box on the picture, then Delete.
  await clickPic(200, 300);
  await page.keyboard.press('Delete');
  eq((await layerNames()).length, layers - 1, 'Delete on the picture takes it away');
  ok(near(await pixel(200, 300), BLUE), 'its words gone');
  await page.keyboard.press('Control+z');
  eq((await layerNames()).length, layers, 'Undo brings it back');
});

await step('.ora keeps the boxes as text: reopened, Meme lists them with their words', async () => {
  await page.keyboard.press('Control+Shift+s');
  await page.locator('.dialog input[aria-label="File name"]').fill('meme.ora');
  await page.locator('.dialog').getByRole('button', { name: 'Save' }).click();
  await page.locator('.toast', { hasText: 'Saved “meme.ora”' }).waitFor();
  await reopen('meme.ora');
  eq(await sizeText(), [400, 408], 'the size with the bars');
  await menu('Image', 'Meme...');
  await M().waitFor();
  eq(await M().locator('input[aria-label="Words of the text box"]').evaluateAll(els => els.map(e => e.value).sort()), ['FIRST TIME', 'NICE', 'WHEN THE BUILD PASSES'], 'the words, editable');
});

await step('Done closes the panel and leaves the layers; saving a PNG joins them into one flat picture', async () => {
  await M().getByRole('button', { name: 'Done' }).click();
  ok(await M().isHidden(), 'closed');
  const words = await wb(0, 0, 400, 408);
  await page.keyboard.press('Control+Shift+s');
  await page.locator('.dialog input[aria-label="File name"]').fill('meme.png');
  await page.locator('.dialog').getByRole('button', { name: 'Save' }).click();
  await page.locator('.dialog', { hasText: 'Layers are not kept in this file' }).getByRole('button', { name: 'Save flat' }).click();
  await page.locator('.toast', { hasText: 'Saved “meme.png”' }).waitFor();
  await reopen('meme.png');
  eq(await layerNames(), ['Background'], 'one flat layer');
  eq(await sizeText(), [400, 408], 'with the bars');
  const flat = await wb(0, 0, 400, 408);
  ok(Math.abs(flat.white - words.white) < words.white * 0.02 && Math.abs(flat.black - words.black) < words.black * 0.02, `the same picture: ${JSON.stringify(words)} and ${JSON.stringify(flat)}`);
});

await step('a sample meme: a sky and a sun, bars top and bottom, white words with a black outline on the picture', async () => {
  await newPicture(480, 320);
  await tool('Gradient');
  await setColour('Colour', '#2f6db8');
  await setColour('Second colour', '#f4c06a');
  await dragPic([240, 0], [240, 319]);
  await tool('Ellipse');
  await W().locator('input[type="checkbox"][aria-label="Filled shape"]').check();
  await setColour('Colour', '#ffe14d');
  await dragPic([330, 60], [410, 140]);
  await tool('Rectangle');
  await setColour('Colour', '#2e6b34');
  await dragPic([0, 250], [479, 319]);
  await menu('Image', 'Meme...');
  await M().waitFor();
  await M().locator('select[aria-label="Bars"]').selectOption('both');
  await field('Top text').fill('WHEN THE TESTS PASS');
  await field('Top text').press('Enter');
  await field('Bottom text').fill('ON THE FIRST TRY');
  await field('Bottom text').press('Enter');
  await M().getByRole('button', { name: 'Add text box' }).click();
  await page.keyboard.type('SUNNY DAY');
  await M().locator('input[aria-label="Words of the text box"]:focus').press('Enter');
  const c = await wb(0, 58, 480, 320);
  ok(c.white > 500 && c.black > 300, `white words with a black outline on the picture: ${JSON.stringify(c)}`);
  // The saves' notes from before go first, so the picture is clear.
  if (SHOTS) await page.waitForFunction(() => !document.querySelector('.toast'), null, { timeout: 20000 }).catch(() => {});
  await shot('meme-panel', W());
  await M().getByRole('button', { name: 'Done' }).click();
});

await step('the page had no script errors', async () => eq(problems.filter(p => !/status of 404/.test(p)), [], 'page errors'));

await browser.close();
console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? ': ' + failures.join(' | ') : ''}`);
process.exit(failures.length ? 1 : 0);
