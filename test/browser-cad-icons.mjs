// CAD Draft's two toolbar picture sets in a real Chrome: View > Icon style switches every toolbar picture at
// once, the choice is kept (a reload and a second window open with it), greyed buttons and the dark desktop theme still
// look right, and Standard comes back the same way.
// Needs the dev server on a FRESH, EMPTY data folder (the first step sets up the owner) and `node tools/build.mjs`.
//   node test/browser-cad-icons.mjs [http://127.0.0.1:3771] [screenshot folder]
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3771';
const SHOTS = process.argv[3] ?? null;
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PASS = 'walnut-harbour-quiver-58';
let passed = 0;
const failures = [];

async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (error) {
    failures.push(name);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/cad-icons-fail-${failures.length}.png` }).catch(() => {});
    console.log('  FAIL ' + name + '\n       ' + String(error.message).split('\n')[0].slice(0, 600));
  }
}
const ok = (cond, what) => {
  if (!cond) throw new Error(what);
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const problems = [];
page.on('pageerror', e => problems.push('pageerror: ' + e.message));

const W = () => page.locator('.win', { has: page.locator('.cad') }).last();
/** A picture of the CAD window's top: the menu bar and the toolbars. */
const shot = async name => {
  if (!SHOTS) return null;
  const box = await W().boundingBox();
  const path = `${SHOTS}/${name}.png`;
  await page.screenshot({ path, clip: { x: box.x, y: box.y, width: Math.min(box.width, 1280 - box.x), height: Math.min(box.height, 800 - box.y) } });
  return path;
};

async function openCad() {
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('cad draft');
  await page.locator('.start-menu [data-label="cad draft"]').first().click();
  await W().locator('.cad-canvas').waitFor();
  await page.waitForTimeout(500);
  const offer = page.locator('.dialog', { hasText: 'Drawings not saved' });
  if (await offer.count()) await offer.getByRole('button', { name: 'Later' }).click();
}
async function closeAll() {
  for (let i = 0; i < 20; i++) {
    const close = page.locator('.win .win-close').last();
    if (!(await close.count())) return;
    await close.click();
    await page.waitForTimeout(250);
    const ask = page.locator('.dialog').last();
    if (await ask.count()) {
      const b = ask.getByRole('button', { name: /Close without saving|Do not save|Later|OK/ }).first();
      if (await b.count()) await b.click();
    }
  }
}
/** The open menu's item with this label (a ticked item's tick is not part of it). */
const menuItem = label => page.locator('.menu-item', { has: page.locator('.menu-label', { hasText: new RegExp('^' + label + '$') }) }).last();
/** Opens View > Icon style (straight in the View menu, beside Large icons). */
async function openIconStyle() {
  await W().locator('.cbar-title[data-menu="View"]').click();
  await menuItem('Icon style').hover();
  await menuItem('Workshop').waitFor();
}
/** View > Icon style > (name). */
async function chooseStyle(name) {
  await openIconStyle();
  await menuItem(name).click();
  await page.waitForTimeout(300);
}
/** What the toolbar buttons show: how many buttons, how many in the Workshop set, and a sample of their markup. */
const pictures = () => W().evaluate(win => {
  const buttons = [...win.querySelectorAll('.cbar-tool[data-tool]')];
  return {
    buttons: buttons.length,
    workshop: buttons.filter(b => b.querySelector('svg.cad-ws-icon')).length,
    empty: buttons.filter(b => !b.querySelector('svg')).map(b => b.dataset.tool),
    style: win.querySelector('.cad')?.dataset.iconStyle,
    line: win.querySelector('.cbar-tool[data-tool="line"]')?.innerHTML ?? '',
    save: win.querySelector('.cbar-tool[data-tool="save"]')?.innerHTML ?? '',
  };
});
/** Which set View > Icon style ticks. */
async function tickedStyle() {
  await openIconStyle();
  // Only the Icon style submenu.
  const sub = page.locator('.menu', { has: page.locator('.menu-label', { hasText: /^Workshop$/ }) }).last();
  ok((await sub.locator('.menu-item').count()) === 2, 'Icon style has two choices');
  const ticked = await sub.locator('.menu-item[aria-checked="true"] .menu-label').allInnerTexts();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  return ticked.map(t => t.replace(/[✓\s]+/g, ' ').trim());
}

console.log('CAD Draft icon sets, against ' + BASE);
await page.goto(BASE);
const saved = [];
let before = null;

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

await step('a new person starts on the Standard set, ticked in View > Icon style', async () => {
  await openCad();
  before = await pictures();
  ok(before.buttons >= 70, `toolbar buttons: ${before.buttons}`);
  ok(before.workshop === 0, `Workshop pictures already: ${before.workshop}`);
  ok(before.style === 'standard', `style: ${before.style}`);
  ok(!before.empty.length, `buttons with no picture: ${before.empty.join(', ')}`);
  const ticked = await tickedStyle();
  ok(ticked.includes('Standard') && !ticked.includes('Workshop'), `ticked: ${JSON.stringify(ticked)}`);
  const p = await shot('cad-icons-standard');
  if (p) saved.push(p);
});

await step('choosing Workshop changes every toolbar picture at once', async () => {
  await chooseStyle('Workshop');
  const now = await pictures();
  ok(now.style === 'workshop', `style: ${now.style}`);
  ok(now.workshop === now.buttons, `Workshop pictures ${now.workshop} of ${now.buttons} buttons`);
  ok(!now.empty.length, `buttons with no picture: ${now.empty.join(', ')}`);
  ok(now.line !== before.line && now.save !== before.save, 'the Line and Save pictures did not change');
  const ticked = await tickedStyle();
  ok(ticked.includes('Workshop') && !ticked.includes('Standard'), `ticked: ${JSON.stringify(ticked)}`);
  const p = await shot('cad-icons-workshop');
  if (p) saved.push(p);
});

await step('greyed buttons and the dark theme still look right in both sets', async () => {
  for (const theme of ['dark', 'light']) {
    const seen = await W().evaluate((win, theme) => {
      document.documentElement.dataset.theme = theme;
      const b = win.querySelector('.cbar-tool[data-tool="line"]');
      b.classList.add('off');
      const out = {
        opacity: Number(getComputedStyle(b).opacity),
        face: getComputedStyle(win.querySelector('.cbar')).backgroundColor,
        drawn: b.querySelectorAll('svg path, svg circle, svg rect').length,
      };
      b.classList.remove('off');
      return out;
    }, theme);
    ok(seen.opacity > 0.2 && seen.opacity < 0.6, `${theme}: a greyed button's opacity ${seen.opacity}`);
    ok(seen.drawn > 0, `${theme}: the greyed picture is still drawn`);
    // CAD Draft keeps its own light grey face in the dark theme, so the pictures keep the background they are drawn for.
    const rgb = (seen.face.match(/\d+/g) ?? []).slice(0, 3).map(Number);
    ok(rgb.length === 3 && rgb.every(v => v > 150), `${theme}: toolbar face ${seen.face}`);
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  const p = await shot('cad-icons-workshop-dark');
  if (p) saved.push(p);
  await page.evaluate(() => {
    delete document.documentElement.dataset.theme;
  });
});

await step('the choice is kept: a second window and a reload open with Workshop', async () => {
  await page.waitForTimeout(1200);
  await openCad();
  const second = await pictures();
  ok(second.style === 'workshop' && second.workshop === second.buttons, `second window: ${second.style}, ${second.workshop} of ${second.buttons}`);
  await closeAll();
  await page.reload();
  await page.locator('#desktop .item').first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(800);
  if (!(await W().count())) await openCad();
  const after = await pictures();
  ok(after.style === 'workshop' && after.workshop === after.buttons, `after the reload: ${after.style}, ${after.workshop} of ${after.buttons}`);
});

await step('choosing Standard brings the Standard pictures back, and that is kept too', async () => {
  await chooseStyle('Standard');
  const now = await pictures();
  ok(now.style === 'standard' && now.workshop === 0, `style ${now.style}, Workshop pictures ${now.workshop}`);
  ok(now.line === before.line && now.save === before.save, 'the Line and Save pictures are not the Standard ones');
  await page.waitForTimeout(1200);
  await closeAll();
  await page.reload();
  await page.locator('#desktop .item').first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(800);
  if (!(await W().count())) await openCad();
  const after = await pictures();
  ok(after.style === 'standard' && after.workshop === 0, `after the reload: ${after.style}, ${after.workshop}`);
  await closeAll();
});

await step('no page errors', async () => {
  ok(!problems.length, problems.join(' | '));
});

await browser.close();
for (const p of saved) console.log('  shot ' + p);
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('Failed: ' + failures.join('; '));
  process.exit(1);
}
