// A phone, driven by touch (taps, not clicks), as an iPhone and as an Android phone: every window's Close button is
// finger-sized and clear of the screen's right edge (Android keeps that strip for swipe-back), a tap closes the window,
// and a text box tapped in Panel, Notepad, Terminal and Chat takes typing and stays above the on-screen keyboard. The
// keyboard is stood in for as Safari shows it (the page keeps its height, only window.visualViewport shrinks), which is
// the case src/core/keyboard.ts handles; Chrome on Android shrinks the whole page instead (the viewport meta).
// Needs the dev server on a FRESH, EMPTY data folder (the first device sets up the owner) and `npm run build` done.
//   node test/browser-touch.mjs [http://127.0.0.1:3043]
import { chromium, devices } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3043';
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const KEYBOARD = 300;
let passed = 0;
const failures = [];
const ok = (cond, what) => {
  if (cond) passed++;
  else failures.push(what);
  console.log((cond ? '  ok   ' : '  FAIL ') + what);
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
for (const device of ['iPhone 13', 'Pixel 5']) {
  const context = await browser.newContext({ ...devices[device] });
  await context.addInitScript(() => {
    const fake = new EventTarget();
    Object.assign(fake, { height: innerHeight, width: innerWidth, offsetTop: 0, offsetLeft: 0, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { value: fake, configurable: true });
    // `scale` above 1 = Safari also zoomed the page in (it does for a box under 16px): the visible part shrinks by it.
    window.__keyboard = (px, scale = 1) => {
      fake.scale = scale;
      fake.height = (innerHeight - px) / scale;
      fake.dispatchEvent(new Event('resize'));
    };
  });
  const p = await context.newPage();
  p.on('pageerror', e => failures.push(`${device}: page error: ${e.message}`));
  await p.goto(BASE);
  const first = await Promise.race([
    p.locator('.gate h1', { hasText: 'Set up' }).waitFor({ timeout: 30000 }).then(() => 'setup'),
    p.getByRole('button', { name: 'Log in for more' }).waitFor({ timeout: 30000 }).then(() => 'reader'),
  ]);
  if (first === 'setup') {
    await p.getByLabel('Your name').fill('Touch Test');
    await p.getByLabel('User name (for signing in)').fill('tester');
    await p.locator('.gate input[type=password]').fill('browser-test-passphrase-1');
    await p.locator('.gate-go').tap();
    await p.locator('.gate h1', { hasText: 'Your recovery key' }).waitFor({ timeout: 30000 });
    await p.locator('.gate .check-row input').tap();
    await p.getByRole('button', { name: 'Continue' }).tap();
  } else {
    await p.getByRole('button', { name: 'Log in for more' }).tap();
    await p.getByLabel('Username').fill('tester');
    await p.locator('input[type=password]').first().fill('browser-test-passphrase-1');
    await p.getByRole('button', { name: 'Log in', exact: true }).tap();
  }
  await p.locator('#desktop .item').first().waitFor({ timeout: 30000 });
  const { width, height } = p.viewportSize();

  await p.locator('.start-btn').tap();
  ok(await p.evaluate(() => !document.activeElement?.matches('input, textarea')), `${device}: opening the menu does not raise the keyboard`);
  ok((await p.locator('.start-btn').getAttribute('aria-label')) !== null, `${device}: the menu button has a name`);
  await p.locator('.start-btn').tap();
  await p.evaluate(() => window.__keyboard(0, 1.5));
  await p.waitForTimeout(300);
  ok(await p.evaluate(() => !document.documentElement.classList.contains('kb-open')), `${device}: a pinch zoom alone is not taken for a keyboard`);
  await p.evaluate(() => window.__keyboard(0));

  for (const app of ['Panel', 'Notepad', 'Terminal', 'Chat']) {
    const at = `${device}, ${app}`;
    await p.locator('.start-btn').tap();
    await p.locator('.start-filter').tap();
    await p.keyboard.type(app);
    // Notepad is opened with the keyboard's Go key (Enter), the others with a tap.
    if (app === 'Notepad') await p.keyboard.press('Enter');
    else await p.locator('.start-menu .start-item', { hasText: app }).first().tap();
    await p.locator('.win.active').waitFor();
    await p.waitForTimeout(500);
    const close = p.locator('.win.active .win-close');
    const box = await close.boundingBox();
    ok(box.width >= 44 && box.height >= 38, `${at}: Close is finger-sized (${box.width}x${box.height})`);
    ok(width - (box.x + box.width) >= 16, `${at}: Close is clear of the right edge (${Math.round(width - box.x - box.width)}px)`);

    const field = p.locator({
      Panel: '.win.active input.pad-name',
      Notepad: '.win.active textarea.editor-text',
      Terminal: '.win.active input.term-in',
      Chat: '.win.active textarea.chat-box[aria-label="Message"]',
    }[app]);
    const size = await field.evaluate(el => parseFloat(getComputedStyle(el).fontSize));
    ok(size >= 16, `${at}: the box's text is ${size}px, so Safari does not zoom in`);
    if (app === 'Notepad') {
      const cut = await p.locator('.win.active .toolbar > .tool').evaluateAll(bs => bs.filter(b => b.scrollWidth > b.clientWidth + 1).map(b => b.textContent));
      ok(cut.length === 0, `${at}: no toolbar button has its words cut (${cut.join(', ')})`);
    }
    await field.tap();
    // Zoomed in as well (as Safari does for a small box): the keyboard must still be seen.
    await p.evaluate(px => window.__keyboard(px, 1.14), KEYBOARD);
    await p.waitForTimeout(300);
    ok(await p.evaluate(() => document.documentElement.classList.contains('kb-open')), `${at}: a keyboard is seen on a zoomed page`);
    await p.evaluate(px => window.__keyboard(px), KEYBOARD);
    await p.waitForTimeout(300);
    const before = await field.inputValue();
    await p.keyboard.type('hi');
    ok((await field.inputValue()) === before + 'hi' || (await field.inputValue()).endsWith('hi'), `${at}: typing lands in the box`);
    const r = await field.boundingBox();
    ok(r.y >= 0 && r.y + Math.min(r.height, 30) <= height - KEYBOARD, `${at}: the box stays above the keyboard`);
    if (app === 'Chat') {
      await p.locator('.win.active').getByText('Agents', { exact: true }).tap();
      const models = await p.locator('.win.active select').first().boundingBox();
      ok(models !== null && models.y >= 0 && models.y < height - KEYBOARD, `${at}: the model list is on screen with the keyboard open`);
      const rows = await p.locator('.win.active .agent-bar').evaluateAll(bs => bs.map(b => Math.round(b.getBoundingClientRect().height)));
      ok(rows.every(hgt => hgt <= 48), `${at}: with the keyboard open each row of controls is one line (${rows.join(', ')}px)`);
    }
    await p.evaluate(() => window.__keyboard(0));
    await p.waitForTimeout(200);
    await close.tap();
    await p.waitForTimeout(400);
    // Typed text may ask whether to close without saving: that answer is a tap too.
    const discard = p.locator('.dialog button', { hasText: /Close|Discard|Don.t save/ }).first();
    if (await discard.count()) await discard.tap();
    await p.waitForTimeout(300);
    ok((await p.locator('.win').count()) === 0, `${at}: a tap on Close closes it`);
  }
  await context.close();
}
await browser.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
