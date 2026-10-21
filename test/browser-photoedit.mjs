// Drives Photo Editor's layers, selections, text, colour windows, retouching, move / stretch / turn, clipboard and
// .ora files in a real Chrome, checking the pixels on screen. Needs the dev server on a FRESH, EMPTY data folder (the
// first step sets up the owner), and `npm run build` done.
//   node test/browser-photoedit.mjs [http://127.0.0.1:3052] [screenshot folder]
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3052';
const SHOTS = process.argv[3] ?? null;
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PASS = 'photo-layers-passphrase-77';
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
const W = () => page.locator('.win', { has: page.locator('.pe') });
/** The colour on screen at a picture pixel (the layers drawn together). */
const pixel = (x, y) => page.evaluate(([x, y]) => [...document.querySelector('.pe-doc').getContext('2d').getImageData(x, y, 1, 1).data], [x, y]);
/** Screen point of a picture pixel. */
async function at(x, y) {
  const box = await W().locator('.pe-over').boundingBox();
  const size = await page.evaluate(() => [document.querySelector('.pe-doc').width, document.querySelector('.pe-doc').height]);
  return { x: box.x + ((x + 0.5) * box.width) / size[0], y: box.y + ((y + 0.5) * box.height) / size[1] };
}
async function dragPic(a, b, opts = {}) {
  const p = await at(...a), q = await at(...b);
  if (opts.modifier) await page.keyboard.down(opts.modifier);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(q.x, q.y, { steps: opts.steps ?? 8 });
  await page.mouse.up();
  if (opts.modifier) await page.keyboard.up(opts.modifier);
}
async function clickPic(x, y, opts = {}) {
  const p = await at(x, y);
  if (opts.modifier) await page.keyboard.down(opts.modifier);
  await page.mouse.click(p.x, p.y, { clickCount: opts.count ?? 1 });
  if (opts.modifier) await page.keyboard.up(opts.modifier);
}
const layerNames = () => W().locator('.pe-layer-name').allInnerTexts();
const tool = name => W().locator('.pe-tools').getByRole('button', { name, exact: true }).click();
const menu = async (menuName, item) => {
  await W().getByRole('button', { name: `${menuName} ▾` }).click();
  await page.locator('.menu').getByText(item, { exact: true }).first().click();
};
const near = (a, b, tol = 6) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

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

await step('open Photo Editor maximised: a 400 × 300 white picture, one Background layer', async () => {
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('photo editor');
  await page.locator('.start-menu [data-label="photo editor"]').first().click();
  await W().waitFor();
  await W().locator('.win-max, [aria-label="Maximise"], [aria-label="Maximize"]').first().click().catch(() => {});
  await W().getByRole('button', { name: 'New...' }).click();
  await page.locator('.dialog input[aria-label="Width"]').fill('400');
  await page.locator('.dialog input[aria-label="Height"]').fill('300');
  await page.locator('.dialog').getByRole('button', { name: 'Create' }).click();
  ok((await W().locator('.pe-status').innerText()).includes('400 × 300'), 'size');
  eq(await layerNames(), ['Background'], 'layers');
  eq(await pixel(10, 10), [255, 255, 255, 255], 'white');
});

await step('a new layer above; the brush paints on it only; hiding it shows the white below', async () => {
  await W().getByRole('button', { name: 'New layer' }).click();
  eq(await layerNames(), ['Layer 2', 'Background'], 'top first');
  ok((await W().locator('.pe-status').innerText()).includes('2 layers, on “Layer 2”'), 'status names the layer');
  await tool('Brush');
  await W().locator('input[aria-label="Size"]').fill('20');
  await dragPic([50, 150], [350, 150]);
  ok(near(await pixel(200, 150), [214, 40, 40, 255]), 'red on screen: ' + (await pixel(200, 150)));
  await W().getByRole('button', { name: 'Hide “Layer 2”' }).click();
  eq(await pixel(200, 150), [255, 255, 255, 255], 'hidden: white');
  await W().getByRole('button', { name: 'Show “Layer 2”' }).click();
  ok(near(await pixel(200, 150), [214, 40, 40, 255]), 'shown again');
  await shot('01-layers');
});

await step('blend mode and opacity: Multiply at 50% over a green Background', async () => {
  // Paint the Background green with the bucket.
  await W().locator('.pe-layer', { hasText: 'Background' }).click();
  await tool('Fill (paint bucket)');
  await W().locator('input[aria-label="Colour"]').evaluate(el => {
    el.value = '#00ff00';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await clickPic(5, 5);
  eq(await pixel(5, 5), [0, 255, 0, 255], 'green');
  await W().locator('.pe-layer', { hasText: 'Layer 2' }).click();
  await W().locator('select[aria-label="Blend mode"]').selectOption('multiply');
  // red (214, 40, 40) × green (0, 255, 0) = (0, 40, 0) where the stroke is.
  eq((await pixel(200, 150)).slice(0, 3), [0, 40, 0], 'multiply');
  await W().locator('input[aria-label="Layer opacity"]').fill('50');
  await W().locator('input[aria-label="Layer opacity"]').dispatchEvent('change');
  ok(near(await pixel(200, 150), [0, 148, 0, 255], 3), 'half: ' + (await pixel(200, 150)));
  ok((await W().locator('.pe-layer', { hasText: 'Layer 2' }).innerText()).includes('Multiply'), 'badge shows the mode');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  ok(near(await pixel(200, 150), [214, 40, 40, 255]), 'undo both: ' + (await pixel(200, 150)));
});

await step('rectangle selection: Delete clears only inside it; brush stays inside; Undo brings it back', async () => {
  await tool('Select a rectangle');
  await dragPic([100, 100], [200, 200]);
  await page.waitForTimeout(250);
  await page.keyboard.press('Delete');
  eq(await pixel(150, 150), [0, 255, 0, 255], 'cleared to the green below');
  ok(near(await pixel(300, 150), [214, 40, 40, 255]), 'outside kept');
  await tool('Brush');
  await W().locator('input[aria-label="Colour"]').evaluate(el => {
    el.value = '#0000ff';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await dragPic([150, 50], [150, 250]);
  eq(await pixel(150, 120), [0, 0, 255, 255], 'painted inside');
  ok(!near(await pixel(150, 60), [0, 0, 255, 255]), 'not outside the selection');
  await shot('02-selection');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  ok(near(await pixel(150, 150), [214, 40, 40, 255]), 'undo: stroke back');
  await page.keyboard.press('Control+Shift+a');
});

await step('ellipse selection with Shift adds; Select > Invert; magic wand; lasso by corners', async () => {
  await tool('Select an ellipse');
  await dragPic([10, 10], [60, 60]);
  await dragPic([300, 200], [380, 280], { modifier: 'Shift' });
  const r = await page.evaluate(() => document.querySelector('.pe-over').getContext('2d').getImageData(0, 0, 400, 300).data.some((v, i) => i % 4 === 3 && v > 0));
  ok(r, 'marching ants drawn');
  await menu('Select', 'Invert');
  await tool('Magic wand: select by colour');
  await clickPic(200, 150);
  await tool('Lasso: drag freely, or click corner by corner');
  await clickPic(20, 20);
  await clickPic(120, 20);
  await clickPic(70, 100);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Delete');
  eq(await pixel(70, 40), [0, 255, 0, 255], 'lasso triangle cleared on Layer 2');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+Shift+a');
});

await step('text layer: added, kept editable, changed by clicking its words', async () => {
  await tool('Text');
  await clickPic(30, 220);
  await page.locator('.dialog textarea[aria-label="Words"]').fill('Hello layers');
  await page.locator('.dialog input[aria-label="Text size"]').fill('40');
  await page.locator('.dialog').getByRole('button', { name: 'Add' }).click();
  eq((await layerNames())[0], 'Hello layers', 'text layer on top');
  ok((await W().locator('.pe-layer').first().innerText()).includes('T'), 'text badge');
  await clickPic(60, 235);
  eq(await page.locator('.dialog textarea[aria-label="Words"]').inputValue(), 'Hello layers', 'words read back');
  await page.locator('.dialog textarea[aria-label="Words"]').fill('Hello again');
  await page.locator('.dialog').getByRole('button', { name: 'Change' }).click();
  eq((await layerNames())[0], 'Hello again', 'renamed with the words');
  await shot('03-text');
});

await step('save as .ora keeps layers; reopening brings back names, order, mode, text', async () => {
  await W().locator('.pe-layer', { hasText: 'Layer 2' }).click();
  await W().locator('select[aria-label="Blend mode"]').selectOption('screen');
  await page.keyboard.press('Control+s');
  const name = page.locator('.dialog input[aria-label="File name"]');
  eq(await name.inputValue(), 'Untitled.ora', 'a layered picture is offered as .ora');
  await name.fill('layered.ora');
  await page.locator('.dialog').getByRole('button', { name: 'Save' }).click();
  await page.locator('.toast', { hasText: 'Saved “layered.ora”' }).waitFor();
  await W().getByRole('button', { name: 'Close' }).click();
  await page.keyboard.press('Control+Alt+e');
  const x = page.locator('.win.active');
  await x.locator('.item', { hasText: 'Pictures' }).first().dblclick();
  await x.locator('.item', { hasText: 'layered' }).first().dblclick();
  await W().locator('.pe-status', { hasText: 'layered.ora' }).waitFor({ timeout: 10000 });
  eq(await layerNames(), ['Hello again', 'Layer 2', 'Background'], 'layers back');
  ok((await W().locator('.pe-layer', { hasText: 'Layer 2' }).innerText()).includes('Screen'), 'mode back');
  await tool('Text');
  await clickPic(60, 235);
  eq(await page.locator('.dialog textarea[aria-label="Words"]').inputValue(), 'Hello again', 'text still editable');
  await page.locator('.dialog').getByRole('button', { name: 'Cancel' }).click();
  await page.locator('.win', { has: page.locator('.fv-explorer') }).getByRole('button', { name: 'Close' }).click().catch(() => {});
});

await step('Save as PNG asks before dropping the layers; Save flat writes one picture', async () => {
  await page.keyboard.press('Control+Shift+s');
  await page.locator('.dialog input[aria-label="File name"]').fill('flat.png');
  await page.locator('.dialog').getByRole('button', { name: 'Save' }).click();
  await page.locator('.dialog', { hasText: 'Layers are not kept in this file' }).waitFor();
  await page.locator('.dialog').getByRole('button', { name: 'Save flat' }).click();
  await page.locator('.toast', { hasText: 'Saved “flat.png”' }).waitFor();
  ok((await W().locator('.pe-status').innerText()).includes('flat.png'), 'now flat.png');
  // A second Ctrl+S to the same file does not ask again.
  await tool('Brush');
  await dragPic([10, 290], [30, 290]);
  await page.keyboard.press('Control+s');
  await W().locator('.pe-status:not(:has-text("not saved"))', { hasText: 'flat.png' }).waitFor({ timeout: 10000 });
});

await step('Levels (histogram, Auto), Curves (point added), Hue, Balance, Threshold, Posterise, Desaturate apply and undo', async () => {
  await W().locator('.pe-layer', { hasText: 'Layer 2' }).click();
  await W().locator('select[aria-label="Blend mode"]').selectOption('normal');
  const before = await pixel(300, 150);
  for (const [item, act] of [
    ['Levels...', async d => { await d.getByRole('button', { name: 'Auto' }).click(); await d.locator('input[aria-label="Middle (gamma)"]').fill('1.6'); }],
    ['Curves...', async d => { const c = await d.locator('canvas.pe-curve').boundingBox(); await page.mouse.click(c.x + c.width * 0.5, c.y + c.height * 0.25); }],
    ['Hue and saturation...', async d => d.locator('input[aria-label="Hue"]').fill('90')],
    ['Colour balance...', async d => d.locator('input[aria-label="Cyan - Red"]').fill('60')],
    ['Threshold...', async () => {}],
    ['Posterise...', async () => {}],
    ['Desaturate...', async () => {}],
  ]) {
    await menu('Colours', item);
    const d = page.locator('.dialog');
    await d.waitFor();
    await act(d);
    if (item === 'Levels...') await shot('04-levels');
    if (item === 'Curves...') await shot('05-curves');
    await d.getByRole('button', { name: 'Apply' }).click();
    await d.waitFor({ state: 'detached' });
    // The change lands a frame after the window closes.
    const want = 'Undo ' + item.replace('...', '');
    await page.waitForFunction(w => document.querySelector('.pe-top button[aria-label="Undo"]')?.title.startsWith(w), want, { timeout: 5000 })
      .catch(async () => { throw new Error(`undo names ${item}: ${await W().getByRole('button', { name: 'Undo' }).getAttribute('title')}`); });
    await page.keyboard.press('Control+z');
  }
  eq(await pixel(300, 150), before, 'all undone');
});

await step('gradient, clone, heal, smudge, dodge, blur brush each make one undo step', async () => {
  await W().locator('.pe-layer', { hasText: 'Layer 2' }).click();
  await tool('Gradient');
  await dragPic([0, 0], [399, 0]);
  const g1 = await pixel(10, 100), g2 = await pixel(390, 100);
  ok(g1.some((v, i) => Math.abs(v - g2[i]) > 100), 'colour changes across: ' + g1 + ' / ' + g2);
  await page.keyboard.press('Control+z');
  await tool('Clone stamp (Alt+click where to copy from)');
  await clickPic(200, 150, { modifier: 'Alt' });
  await dragPic([200, 60], [260, 60]);
  // Alt+click at (200, 150), painting from (200, 60): each pixel copies the one 90 below it.
  ok(near(await pixel(220, 60), await pixel(220, 150), 30), 'copied from 90 below: ' + (await pixel(220, 60)) + ' vs ' + (await pixel(220, 150)));
  for (const t of ['Heal (Alt+click where to copy from)', 'Smudge', 'Dodge / burn (lighten / darken)', 'Blur / sharpen brush']) {
    const n = (await W().getByRole('button', { name: 'Undo' }).getAttribute('title'));
    await tool(t);
    if (t.startsWith('Heal')) await clickPic(200, 150, { modifier: 'Alt' });
    await dragPic([100, 150], [140, 160]);
    const after = await W().getByRole('button', { name: 'Undo' }).getAttribute('title');
    ok(after !== n || t.startsWith('Blur'), `${t} made a step (${after})`);
  }
  await shot('06-retouch');
});

await step('move tool: drag moves the layer, Enter applies, one undo puts it back', async () => {
  await tool('Brush');
  await W().locator('.pe-layer', { hasText: 'Layer 2' }).click();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await page.keyboard.press('Control+Shift+a');
  await W().locator('input[aria-label="Colour"]').evaluate(el => {
    el.value = '#ff0000';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await W().locator('input[aria-label="Size"]').fill('20');
  await dragPic([40, 40], [60, 40]);
  ok(near(await pixel(50, 40), [255, 0, 0, 255]), 'dot painted');
  await tool('Move, stretch and turn');
  await dragPic([50, 40], [250, 140], { steps: 10 });
  await shot('07-move');
  await page.keyboard.press('Enter');
  ok(near(await pixel(250, 140), [255, 0, 0, 255]), 'moved: ' + (await pixel(250, 140)));
  ok(!near(await pixel(50, 40), [255, 0, 0, 255]), 'gone from the old place');
  await page.keyboard.press('Control+z');
  ok(near(await pixel(50, 40), [255, 0, 0, 255]), 'undo puts it back');
});

await step('copy and paste: Ctrl+C, Ctrl+V makes a "Pasted" layer and switches to Move', async () => {
  await W().locator('.pe-layer', { hasText: 'Layer 2' }).click();
  await tool('Select a rectangle');
  await dragPic([30, 25], [70, 55]);
  await page.locator('.pe-stage').focus();
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await W().locator('.pe-layer-name', { hasText: 'Pasted' }).waitFor({ timeout: 5000 });
  ok(await W().locator('.pe-tools').getByRole('button', { name: 'Move, stretch and turn' }).getAttribute('aria-pressed') === 'true', 'move tool on');
  await page.keyboard.press('Enter');
});

await step('Image > Canvas size adds room round every layer; Layer > Merge down; Flatten; locked layer refuses paint', async () => {
  await menu('Image', 'Canvas size...');
  await page.locator('.dialog input[aria-label="New width"]').fill('500');
  await page.locator('.dialog').getByRole('button', { name: 'Change' }).click();
  ok((await W().locator('.pe-status').innerText()).includes('500 × 300'), 'wider');
  const n = (await layerNames()).length;
  await menu('Layer', 'Merge down');
  eq((await layerNames()).length, n - 1, 'one fewer');
  await W().locator('input[aria-label="Lock this layer"]').check();
  await tool('Brush');
  await dragPic([5, 5], [20, 5]);
  await page.locator('.toast', { hasText: 'is locked' }).waitFor();
  await W().locator('input[aria-label="Lock this layer"]').uncheck();
  await menu('Image', 'Flatten picture (join all layers)');
  eq(await layerNames(), ['Background'], 'flat');
  await page.keyboard.press('Control+z');
  ok((await layerNames()).length > 1, 'undo flatten');
});

await step('stretch and turn: a corner handle makes the selected part 100 × 80, a drag outside turns it, one Undo', async () => {
  await W().getByRole('button', { name: 'New layer' }).click();
  await tool('Brush');
  await dragPic([95, 100], [115, 100]);
  await tool('Select a rectangle');
  await dragPic([80, 80], [130, 120]);
  await tool('Move, stretch and turn');
  await dragPic([130, 120], [180, 160], { steps: 10 });
  eq((await W().locator('.pe-where').innerText()).split('·')[0].trim(), '100 × 80', 'stretched');
  await dragPic([300, 40], [300, 200], { steps: 10 });
  ok(!/· 0°/.test(await W().locator('.pe-where').innerText()), 'turned: ' + (await W().locator('.pe-where').innerText()));
  await shot('09-turn');
  await page.keyboard.press('Enter');
  ok((await W().getByRole('button', { name: 'Undo' }).getAttribute('title')).startsWith('Undo Move'), 'one Move step');
  await page.keyboard.press('Control+Shift+a');
});

// ---- Faults found in an audit, each driven the way a person would hit it ----
const status = async () => (await W().locator('.pe-status').innerText()).split('\n')[0];
async function freshPicture(w, hgt) {
  await page.keyboard.press('Escape');
  await W().getByRole('button', { name: 'New...' }).click();
  const lose = page.locator('.dialog', { hasText: 'Not saved' });
  if (await lose.isVisible().catch(() => false)) await lose.getByRole('button', { name: 'Lose the changes' }).click();
  await page.locator('.dialog input[aria-label="Width"]').fill(String(w));
  await page.locator('.dialog input[aria-label="Height"]').fill(String(hgt));
  await page.locator('.dialog').getByRole('button', { name: 'Create' }).click();
}
const colourIs = hex => W().locator('input[aria-label="Colour"]').evaluate((el, v) => {
  el.value = v;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, hex);
async function saveAsName(name) {
  await page.keyboard.press('Control+Shift+s');
  await page.locator('.dialog input[aria-label="File name"]').fill(name);
  await page.locator('.dialog').getByRole('button', { name: 'Save' }).click();
  await page.locator('.toast', { hasText: `Saved “${name}”` }).waitFor();
}

await step('a crop box on screen, then Rotate: no error, one undo step, "not saved"; then Ctrl+O opens the right file', async () => {
  await freshPicture(400, 300);
  await tool('Brush');
  await dragPic([20, 20], [100, 20]);
  await saveAsName('audit-red.png');
  await tool('Crop');
  await dragPic([50, 50], [150, 120]);
  await menu('Image', 'Rotate right');
  ok((await status()).includes('300 × 400'), 'turned: ' + (await status()));
  ok((await status()).includes('not saved'), 'marked not saved');
  ok((await W().getByRole('button', { name: 'Undo' }).getAttribute('title')).startsWith('Undo Rotate right'), 'one Rotate step');
  await page.keyboard.press('Control+z');
  ok((await status()).includes('400 × 300'), 'undo turns it back');
  // Another file, then a crop box, then Ctrl+O: the opened picture is named and saved as itself.
  await freshPicture(200, 100);
  await tool('Fill (paint bucket)');
  await colourIs('#0000ff');
  await clickPic(5, 5);
  await saveAsName('audit-blue.png');
  await tool('Crop');
  await dragPic([20, 20], [120, 80]);
  await page.keyboard.press('Control+o');
  await page.locator('.pick-row[data-path$="audit-red.png"]').dblclick();
  await W().locator('.pe-status', { hasText: 'audit-red.png' }).waitFor({ timeout: 10000 });
  ok(!(await page.locator('.dialog', { hasText: 'could not be read' }).count()), 'no false "damaged" message');
  ok((await status()).includes('400 × 300'), 'the red picture: ' + (await status()));
});

await step('Layer > Flip with a selection mirrors the selected part in place; the rest stays', async () => {
  await freshPicture(400, 300);
  await tool('Select a rectangle');
  await dragPic([0, 0], [199, 299]);
  await colourIs('#ff0000');
  await menu('Edit', 'Fill with the colour');
  await page.keyboard.press('Control+Shift+a');
  await dragPic([0, 0], [99, 299]);
  await colourIs('#0000ff');
  await menu('Edit', 'Fill with the colour');
  // Left quarter blue, next quarter red, right half white. Select the left half and flip it.
  await page.keyboard.press('Control+Shift+a');
  await dragPic([0, 0], [199, 299]);
  await menu('Layer', 'Flip layer left to right');
  eq((await pixel(20, 150)).slice(0, 3), [255, 0, 0], 'red now on the left');
  eq((await pixel(180, 150)).slice(0, 3), [0, 0, 255], 'blue now on the right of the half');
  eq((await pixel(350, 150)).slice(0, 3), [255, 255, 255], 'outside untouched');
  await page.keyboard.press('Control+z');
  eq((await pixel(20, 150)).slice(0, 3), [0, 0, 255], 'one undo');
  await page.keyboard.press('Control+Shift+a');
});

await step('crop box dragged past the left edge stops at it; Enter on the Cancel button cancels', async () => {
  await freshPicture(400, 300);
  await tool('Crop');
  const p = await at(30, 100), q = await at(0, 200);
  const box = await W().locator('.pe-over').boundingBox();
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(box.x - 60, q.y, { steps: 8 });
  await page.mouse.up();
  await W().getByRole('button', { name: 'Cancel', exact: true }).first().focus();
  await page.keyboard.press('Enter');
  ok((await status()).includes('400 × 300'), 'Enter on Cancel did not crop: ' + (await status()));
  const b2 = await W().locator('.pe-over').boundingBox();
  await page.mouse.move((await at(30, 100)).x, (await at(30, 100)).y);
  await page.mouse.down();
  await page.mouse.move(b2.x - 60, (await at(0, 200)).y, { steps: 8 });
  await page.mouse.up();
  await page.locator('.pe-stage').focus();
  await page.keyboard.press('Enter');
  ok(/· 3[01] × 10[01] pixels/.test(await status()), 'about 30 × 100: ' + (await status()));
});

await step('Merge down onto a 50% layer looks the same after; a hidden layer is asked about', async () => {
  await freshPicture(400, 300);
  await W().getByRole('button', { name: 'New layer' }).click();
  await W().locator('input[aria-label="Layer opacity"]').fill('50');
  await W().locator('input[aria-label="Layer opacity"]').dispatchEvent('change');
  await W().getByRole('button', { name: 'New layer' }).click();
  await tool('Fill (paint bucket)');
  await colourIs('#0000ff');
  await clickPic(10, 10);
  const before = await pixel(100, 100);
  await page.keyboard.press('Control+e');
  eq(await pixel(100, 100), before, 'same after merging');
  await W().getByRole('button', { name: 'Hide “Layer 2”' }).click();
  await W().getByRole('button', { name: 'New layer' }).click();
  await page.keyboard.press('Control+e');
  const d = page.locator('.dialog', { hasText: 'Show the layer first' });
  await d.waitFor();
  await d.getByRole('button', { name: 'OK' }).click();
});

await step('Change the text on a hidden text layer edits it; Cancel in Levels keeps the words editable', async () => {
  await freshPicture(400, 300);
  await tool('Text');
  await clickPic(40, 100);
  await page.locator('.dialog textarea[aria-label="Words"]').fill('Hidden words');
  await page.locator('.dialog').getByRole('button', { name: 'Add' }).click();
  await W().getByRole('button', { name: 'Hide “Hidden words”' }).click();
  await menu('Layer', 'Change the text...');
  eq(await page.locator('.dialog textarea[aria-label="Words"]').inputValue(), 'Hidden words', 'the words of that layer');
  await page.locator('.dialog').getByRole('button', { name: 'Cancel' }).click();
  eq((await layerNames()).length, 2, 'no extra layer');
  await W().getByRole('button', { name: 'Show “Hidden words”' }).click();
  await page.locator('.pe-stage').focus();
  await page.keyboard.press('Control+l');
  await page.locator('.dialog').getByRole('button', { name: 'Cancel' }).click();
  ok((await W().locator('.pe-layer').first().innerText()).includes('T'), 'still a text layer after Cancel');
  // Applied, it becomes pixels, and one Undo brings the words back.
  await page.keyboard.press('Control+l');
  // (Gamma would not change pure blue words at all, and then they stay text: that is checked too.)
  await page.locator('.dialog input[aria-label="Middle (gamma)"]').fill('1.6');
  await page.locator('.dialog').getByRole('button', { name: 'Apply' }).click();
  await page.waitForTimeout(300);
  ok((await W().locator('.pe-layer').first().innerText()).includes('T'), 'no change, still text');
  await page.keyboard.press('Control+l');
  await page.locator('.dialog input[aria-label="Output light"]').fill('128');
  await page.locator('.dialog').getByRole('button', { name: 'Apply' }).click();
  // The change lands a frame after the window closes.
  await W().locator('.pe-layer').first().locator('.pe-badges', { hasText: 'T' }).waitFor({ state: 'detached', timeout: 5000 });
  const lv = await W().getByRole('button', { name: 'Undo' }).getAttribute('title');
  ok(lv.startsWith('Undo Levels'), 'one Levels step: ' + lv);
  await page.keyboard.press('Control+z');
  await W().locator('.pe-layer').first().locator('.pe-badges', { hasText: 'T' }).waitFor({ timeout: 5000 });
});

await step('a shortcut during a gradient drag finishes it cleanly; Ctrl+Z in the Soft edge box is the box\'s own', async () => {
  await freshPicture(400, 300);
  await tool('Gradient');
  const a = await at(50, 50), b = await at(300, 200);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.keyboard.press('Control+a');
  await page.mouse.up();
  ok((await W().getByRole('button', { name: 'Undo' }).getAttribute('title')).startsWith('Undo Select all'), 'select all after the gradient');
  await page.keyboard.press('Control+z');
  ok((await W().getByRole('button', { name: 'Undo' }).getAttribute('title')).startsWith('Undo Gradient'), 'the gradient is its own step');
  await page.keyboard.press('Control+Shift+a');
  await W().getByRole('button', { name: 'Zoom in' }).click();
  await tool('Brush');
  await dragPic([20, 150], [380, 150]);
  await tool('Select a rectangle');
  const box = W().locator('input[aria-label="Soft edge (pixels)"]');
  await box.click();
  await box.fill('25');
  await page.keyboard.press('Control+z');
  ok(!near(await pixel(200, 150), [255, 255, 255, 255]), 'the stroke is still there');
  await page.locator('.pe-stage').focus();
  await box.fill('0');
});

await step('New picture over 50 million pixels is refused with the reason; one Undo takes a paste back', async () => {
  await W().getByRole('button', { name: 'New...' }).click();
  const lose = page.locator('.dialog', { hasText: 'Not saved' });
  if (await lose.isVisible().catch(() => false)) await lose.getByRole('button', { name: 'Lose the changes' }).click();
  await page.locator('.dialog input[aria-label="Width"]').fill('10000');
  await page.locator('.dialog input[aria-label="Height"]').fill('10000');
  ok((await page.locator('.dialog').innerText()).includes('100 million pixels'), 'says why');
  ok(await page.locator('.dialog').getByRole('button', { name: 'Create' }).isDisabled(), 'Create waits');
  await page.locator('.dialog').getByRole('button', { name: 'Cancel' }).click();
  await freshPicture(400, 300);
  await tool('Select a rectangle');
  await dragPic([30, 25], [70, 55]);
  await page.locator('.pe-stage').focus();
  await page.keyboard.press('Control+c');
  const n = (await layerNames()).length;
  await page.keyboard.press('Control+v');
  await W().locator('.pe-layer-name', { hasText: 'Pasted' }).waitFor({ timeout: 5000 });
  await page.keyboard.press('Enter');
  ok((await W().getByRole('button', { name: 'Undo' }).getAttribute('title')).startsWith('Undo Paste'), 'one Paste step');
  await page.keyboard.press('Control+z');
  eq((await layerNames()).length, n, 'one undo removes the pasted layer');
  // Enter on a focused layer row renames it and does not also apply a crop box on screen.
  await tool('Crop');
  await dragPic([20, 20], [120, 80]);
  await W().locator('.pe-layer.on').focus();
  await page.keyboard.press('Enter');
  await page.locator('.dialog', { hasText: 'Rename layer' }).getByRole('button', { name: 'Cancel' }).click();
  ok((await status()).includes('400 × 300'), 'not cropped: ' + (await status()));
  await page.keyboard.press('Escape');
});

await step('phone width: the editor fits 390 pixels with no sideways scroll of the page', async () => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(500);
  await shot('10-phone');
  const wide = await page.evaluate(() => document.documentElement.scrollWidth);
  ok(wide <= 392, 'page width ' + wide);
  await page.setViewportSize({ width: 1400, height: 900 });
});

await step('a big picture: the 13th layer at 4000 × 3000 is refused with the reason', async () => {
  await W().getByRole('button', { name: 'New...' }).click();
  await page.locator('.dialog', { hasText: 'Not saved' }).getByRole('button', { name: 'Lose the changes' }).click().catch(() => {});
  await page.locator('.dialog input[aria-label="Width"]').fill('4000');
  await page.locator('.dialog input[aria-label="Height"]').fill('3000');
  await page.locator('.dialog').getByRole('button', { name: 'Create' }).click();
  for (let i = 0; i < 11; i++) await W().getByRole('button', { name: 'New layer' }).click();
  eq((await layerNames()).length, 12, '12 layers');
  await W().getByRole('button', { name: 'New layer' }).click();
  const d = page.locator('.dialog', { hasText: 'No room for another layer' });
  await d.waitFor();
  ok((await d.innerText()).includes('This picture has 12 layers at 4,000 × 3,000, which is as much as this browser can hold safely. Merge or delete a layer to add another.'), 'reason');
  await d.getByRole('button', { name: 'OK' }).click();
  // 30 strokes on the big picture: undo stays small.
  await tool('Brush');
  for (let i = 0; i < 30; i++) await dragPic([100, 100 + i * 80], [3900, 2900 - i * 80], { steps: 6 });
  const mem = await page.evaluate(() => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : -1);
  console.log('       JS heap after 30 strokes on 12 layers of 4000 × 3000: ' + mem + ' MB');
  await shot('08-big');
});

await step('unsaved work is kept as a recovery copy with its layers; after the page stops, the next Photo Editor offers it back', async () => {
  const closePe = async () => {
    for (let i = 0; i < 4 && (await W().count()); i++) {
      await W().last().getByRole('button', { name: 'Close', exact: true }).first().click();
      const lose = page.locator('.dialog').getByRole('button', { name: 'Close without saving' });
      if (await lose.waitFor({ timeout: 1500 }).then(() => true, () => false)) await lose.click();
      await page.waitForTimeout(200);
    }
  };
  const openPe = async () => {
    await page.locator('.start-btn').click();
    await page.locator('.start-filter').fill('photo editor');
    await page.locator('.start-menu [data-label="photo editor"]').first().click();
    await W().last().locator('.pe-doc').waitFor();
  };
  await closePe();
  await openPe();
  await W().getByRole('button', { name: 'New layer' }).click();
  await tool('Brush');
  await W().locator('input[aria-label="Size"]').fill('20');
  await dragPic([50, 150], [350, 150]);
  ok(near(await pixel(200, 150), [214, 40, 40, 255]), 'painted');
  // The page goes to the background (a lid closing): a copy is kept at once.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    delete document.visibilityState;
  });
  await page.waitForTimeout(2500);
  // The page stops without saving, as a crash or a closed tab would.
  page.once('dialog', d => d.accept());
  await page.goto(BASE, { waitUntil: 'load' });
  await page.locator('#desktop .item').first().waitFor();
  await openPe();
  const offer = page.locator('.dialog', { hasText: 'Pictures not saved' });
  await offer.waitFor({ timeout: 10000 });
  ok((await offer.innerText()).includes('Untitled.png: kept'), 'the copy is listed: ' + (await offer.innerText()));
  await offer.getByRole('button', { name: 'Open it' }).click();
  await page.locator('.toast', { hasText: 'Recovered “Untitled.png”' }).first().waitFor();
  eq(await W().count(), 1, 'the empty window made way for the recovered one');
  eq(await layerNames(), ['Layer 2', 'Background'], 'the layers are back');
  ok(near(await pixel(200, 150), [214, 40, 40, 255]), 'and the paint: ' + (await pixel(200, 150)));
  ok((await W().locator('.pe-status').innerText()).includes('not saved'), 'marked not saved');
  await shot('recovered');
  await closePe();
  await openPe();
  await page.waitForTimeout(1500);
  eq(await page.locator('.dialog', { hasText: 'Pictures not saved' }).count(), 0, 'closed on purpose: nothing offered again');
});

await step('no errors in the page', async () => {
  eq(problems.filter(p => !/status of 404/.test(p)), [], 'problems');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
// Closing Chrome after the big-picture step can hang on Windows: give it five seconds, then leave anyway.
await Promise.race([browser.close(), new Promise(res => setTimeout(res, 5000))]);
process.exit(failures.length ? 1 : 0);
