// Drives accounts, the lock, the screensavers, the RISC-V Studio and the 2FA emulator in a real Chrome. Needs the dev
// server on a FRESH, EMPTY data folder (the first step sets up the owner), and `npm run build` done.
//   node test/browser-accounts.mjs [http://127.0.0.1:3043]
import { chromium } from 'playwright-core';
import { createHmac } from 'node:crypto';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3043';
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PASS = 'orchard-lantern-harbour-58';
let passed = 0;
const failures = [];

async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (error) {
    failures.push(name);
    console.log('  FAIL ' + name + '\n       ' + String(error.message).slice(0, 1200));
  }
}
const eq = (a, b, what) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const ok = (v, what) => {
  if (!v) throw new Error(what);
};

/** RFC 6238 with node:crypto, independent of the page and the server. */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function codeFor(secret, offset = 0) {
  let bits = '';
  for (const c of secret.replace(/\s/g, '')) bits += B32.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map(b => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset));
  const mac = createHmac('sha1', key).update(counter).digest();
  return String((mac.readUInt32BE(mac[19] & 15) & 0x7fffffff) % 1e6).padStart(6, '0');
}
let usedStep = 0;
async function nextCode(secret) {
  for (;;) {
    const now = Math.floor(Date.now() / 30000);
    for (const s of [now - 1, now, now + 1]) {
      if (s > usedStep) {
        usedStep = s;
        return codeFor(secret, s - now);
      }
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
const page = await context.newPage();
const problems = [];
page.on('console', m => m.type() === 'error' && problems.push('console: ' + m.text()));
page.on('pageerror', e => problems.push('pageerror: ' + e.message));
const bad400 = [];
page.on('response', r => r.status() === 400 && bad400.push(`${r.request().method()} ${r.url()}`));
await page.addInitScript(() => {
  window.__csp = [];
  document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
});
const settle = ms => page.waitForTimeout(ms);
const storeStatus = () => page.evaluate(() => fetch('/api/store.php?key=/', { headers: { 'X-Desktop-Store': '1' } }).then(r => r.status));
const openApp = async label => {
  await page.locator('.start-btn').click();
  // Most apps sit in groups: find it by name in the Start menu's search box, as a person would.
  await page.locator('.start-filter').fill(label);
  await page.locator(`.start-menu [data-label="${label}"]`).first().click();
};
const hidden = () => page.evaluate(() => {
  const s = document.getElementById('screen');
  return getComputedStyle(s).visibility === 'hidden' && s.hasAttribute('inert') && getComputedStyle(document.getElementById('taskbar')).visibility === 'hidden';
});
let secret = '';

console.log('Accounts, lock, Studio and emulator, against ' + BASE);
await page.goto(BASE);

// These steps were written for the plain sign-in page; since the Reader became the default front, the owner turns
// the sign-in page on first (Settings offers the same choice). browser-touch.mjs covers the Reader front.
const signInFront = p => p.evaluate(() => fetch('api/auth.php?op=site-front', {
  method: 'POST', credentials: 'same-origin',
  headers: { 'X-Desktop-Store': '1', 'Content-Type': 'application/json' },
  body: JSON.stringify({ front: 'signin' }),
}).then(r => r.status));

await step('first visit: the owner set-up screen, and weak passwords are refused with a way out', async () => {
  await page.locator('.gate h1', { hasText: 'Set up this desktop' }).waitFor({ timeout: 20000 });
  eq(await page.title(), 'TOMLIN OS - Set up this desktop', 'tab title');
  await page.getByLabel('Your name').fill('Alex');
  eq(await page.getByLabel('User name (for signing in)').inputValue(), 'alex', 'user name follows the name');
  await page.locator('.gate input[type=password]').fill('password123');
  await page.locator('.gate-go').click();
  await page.locator('.gate-problem', { hasText: 'Suggest one' }).waitFor();
  await page.getByRole('button', { name: 'Suggest one' }).click();
  const suggested = await page.locator('.gate input.gate-input').last().inputValue();
  ok(/^([a-z]+-){4}\d{2}$/.test(suggested), 'suggested: ' + suggested);
  eq(await page.locator('.gate-verdict').innerText(), 'Strong.', 'verdict');
  await page.locator('.gate input.gate-input').last().fill(PASS);
  await page.locator('.gate-go').click();
  await page.locator('.gate h1', { hasText: 'Your recovery key' }).waitFor({ timeout: 30000 });
  await page.locator('.gate .check-row input').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#desktop .item').first().waitFor({ timeout: 20000 });
  eq(await storeStatus(), 200, 'the store answers the signed-in owner');
  eq(await signInFront(page), 200, 'the owner turns the sign-in page on');
});

await step('Start menu shows the person, Lock and Sign out', async () => {
  await page.locator('.start-btn').click();
  ok((await page.locator('.start-head').innerText()).includes('Alex'), 'name in the Start menu');
  ok(await page.locator('.start-lock').isVisible(), 'Lock');
  ok(await page.locator('.start-signout').isVisible(), 'Sign out');
  await page.keyboard.press('Escape');
});

await step('My account turns on two-step sign-in with a scannable QR code and shows 10 recovery codes once', async () => {
  await openApp('my account');
  const w = page.locator('.win', { has: page.locator('.account') });
  await w.getByRole('button', { name: 'Turn on...' }).click();
  await w.locator('.acct-form input[type=password]').fill(PASS);
  await w.getByRole('button', { name: 'Next' }).click();
  await w.locator('.acct-qr').waitFor();
  ok((await w.locator('.acct-qr path').getAttribute('d')).length > 500, 'QR drawn');
  secret = (await w.locator('.acct-secret').innerText()).replace(/\s/g, '');
  ok(/^[A-Z2-7]{32}$/.test(secret), 'secret ' + secret);
  await w.locator('.acct-form input[autocomplete=one-time-code]').fill(await nextCode(secret));
  await w.getByRole('button', { name: 'Turn on', exact: true }).click();
  await w.locator('.acct-codes li').first().waitFor();
  eq(await w.locator('.acct-codes li').count(), 10, 'recovery codes');
  await w.getByRole('button', { name: 'I have kept them somewhere safe' }).click();
  await w.getByText('On. Signing in needs your password').waitFor();
});

await step('a PIN is set (password and two-step code asked first)', async () => {
  const w = page.locator('.win', { has: page.locator('.account') });
  await w.getByRole('button', { name: 'Set a PIN...' }).click();
  await w.locator('.acct-form input[autocomplete=current-password]').fill(PASS);
  await w.locator('.acct-form input[autocomplete=one-time-code]').fill(await nextCode(secret));
  await w.locator('.acct-form input[maxlength="4"]').fill('4821');
  await w.getByRole('button', { name: 'Save PIN' }).click();
  await w.getByText('Set. The locked screen opens with your 4-digit PIN.').waitFor();
  // The lock steps below are about the spreadsheet disguise (the Reader is the default screensaver).
  await w.locator('.acct-tab', { hasText: 'Screensaver and lock' }).click();
  const saverStep = w.locator('.saver-step').nth(0);
  await saverStep.locator('.mini-tile[data-value="sheet"]').click();
  // A tile is only a choice: nothing is written until Save.
  let posts = 0;
  const count = r => r.url().includes('store.php') && r.request().method() === 'POST' && posts++;
  page.on('response', count);
  await settle(1500);
  page.off('response', count);
  eq(posts, 0, 'picking a tile writes nothing');
  // The choice is written a moment after Save; wait for that write, so the lock below (and the reload while locked) keep it.
  const written = page.waitForResponse(r => r.url().includes('store.php') && r.request().method() === 'POST', { timeout: 15000 });
  await saverStep.getByRole('button', { name: 'Save the screensaver' }).click();
  eq((await written).status(), 200, 'the screensaver choice is saved');
  await settle(300);
});

// ---- The pictures to pick from (src/shell/saverminis.ts) ---------------------------------------------------------
const SHOTS = process.env.LOCKLOOK_SHOTS ?? '';
const acct = () => page.locator('.win', { has: page.locator('.account') });
const tileIn = (stepEl, value) => stepEl.locator(`.mini-tile[data-value="${value}"]`);
const inUse = stepEl => stepEl.locator('.mini-tile', { has: page.locator('.mini-use:not([hidden])') }).getAttribute('data-value');
const checked = stepEl => stepEl.locator('.mini-tile[aria-checked="true"]').getAttribute('data-value');
/** Preview, then the way out of the spreadsheet to the lock screen: its heading. Closes the preview after. */
const previewHeading = async () => {
  await acct().getByRole('button', { name: 'Preview', exact: true }).click();
  await page.locator('#layer-lock .fake-sheet').waitFor({ timeout: 10000 });
  await page.keyboard.press('Escape');
  const h1 = await page.locator('#layer-lock .gate h1').innerText();
  // The lock screen covers the preview's own bar; its Sign out, in a preview, only ends the preview.
  await page.locator('#layer-lock .gate').getByRole('button', { name: 'Sign out' }).click();
  await page.locator('#layer-lock').waitFor({ state: 'hidden' });
  return h1;
};
const shoot = async (stepEl, name) => {
  if (!SHOTS) return;
  await acct().getByRole('button', { name: 'Maximise' }).click();
  await stepEl.scrollIntoViewIfNeeded();
  await settle(300);
  await stepEl.screenshot({ path: `${SHOTS}/${name}-light.png` });
  const was = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await settle(200);
  await stepEl.screenshot({ path: `${SHOTS}/${name}-dark.png` });
  await page.evaluate(t => (document.documentElement.dataset.theme = t), was);
  await acct().getByRole('button', { name: 'Restore' }).click();
};

await step('screensaver tiles: four pictures, the saved one In use; Save is off until the pick differs; the sheet picture follows its title as it is typed', async () => {
  const s = acct().locator('.saver-step').nth(0);
  eq(await s.locator('.mini-tile .mini-name > span:first-child').allInnerTexts(), ['Spreadsheet', 'Reader', 'Clock', 'Blank screen'], 'tile names');
  eq(await s.locator('[role=radiogroup] [role=radio]').count(), 4, 'a radio group of four');
  eq(await inUse(s), 'sheet', 'the saved one is In use');
  ok(await s.getByText('Saved.').isVisible(), 'Save said Saved.');
  ok(await s.getByRole('button', { name: 'Save the screensaver' }).isDisabled(), 'Save is off with nothing to save');
  eq(await s.locator('.mini-view [tabindex], .mini-view input, .mini-view button').count(), 0, 'nothing in a picture can be focused');
  eq(await tileIn(s, 'sheet').locator('.mini-sheet-title').innerText(), 'Q3 Budget - Spreadsheet', 'the sheet picture has its title');
  await tileIn(s, 'sheet').locator('.mini-cell', { hasText: 'Operating budget' }).waitFor();
  ok(/\d/.test(await tileIn(s, 'clock').locator('.saver-time').innerText()), 'the clock picture shows the time');
  await s.getByLabel('Its title').fill('Warehouse count');
  eq(await tileIn(s, 'sheet').locator('.mini-sheet-title').innerText(), 'Warehouse count - Spreadsheet', 'live title');
  ok(await s.getByRole('button', { name: 'Save the screensaver' }).isEnabled(), 'a new title can be saved');
  await s.getByLabel('Its title').fill('');
  ok(await s.getByRole('button', { name: 'Save the screensaver' }).isDisabled(), 'back as saved: Save off again');
  await tileIn(s, 'clock').click();
  eq(await checked(s), 'clock', 'picked');
  ok(await s.locator('.saver-sub').first().isHidden(), 'the sheet fields only show with the spreadsheet picked');
  eq(await inUse(s), 'sheet', 'still the spreadsheet In use');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  eq(await checked(s), 'sheet', 'picked back with the keys');
  ok(await s.getByRole('button', { name: 'Save the screensaver' }).isDisabled(), 'picked back: nothing to save');
  await shoot(s, 'saver-tiles');
});

await step('lock screen tiles: three pictures with the real words; picking one changes nothing until Save, then Preview shows it', async () => {
  const s = acct().locator('.saver-step').nth(1);
  eq(await s.locator('.mini-tile .mini-name > span:first-child').allInnerTexts(), ['TOMLIN OS', 'Plain', 'My own words'], 'tile names');
  eq(await inUse(s), 'default', 'TOMLIN OS In use');
  const def = await tileIn(s, 'default').locator('.mini-view').innerText();
  ok(def.includes('TOMLIN OS') && def.includes('Locked') && def.includes('Alex is signed in'), 'the TOMLIN OS picture has the names: ' + def);
  const plain = await tileIn(s, 'plain').locator('.mini-view').innerText();
  ok(plain.includes('Session timed out') && !plain.includes('Alex') && !plain.includes('TOMLIN'), 'the plain picture has no names: ' + plain);
  ok(await s.locator('.saver-sub').isHidden(), 'no word fields unless My own words is picked');
  ok(await s.getByRole('button', { name: 'Save the lock screen' }).isDisabled(), 'Save off');
  await tileIn(s, 'plain').click();
  eq(await tileIn(s, 'plain').getAttribute('aria-checked'), 'true', 'picked');
  eq(await inUse(s), 'default', 'not In use yet');
  eq(await previewHeading(), 'Locked', 'unsaved: Preview still shows the saved look');
  const written = page.waitForResponse(r => r.url().includes('store.php') && r.request().method() === 'POST', { timeout: 15000 });
  await s.getByRole('button', { name: 'Save the lock screen' }).click();
  eq((await written).status(), 200, 'written');
  eq(await inUse(s), 'plain', 'In use moved');
  eq(await previewHeading(), 'Session timed out', 'Preview shows the saved plain look');
});

await step('My own words: the picture follows the words as they are typed; they are kept only by Save; Settings stays in step', async () => {
  const s = acct().locator('.saver-step').nth(1);
  await tileIn(s, 'custom').click();
  ok(await s.locator('.saver-sub').isVisible(), 'word fields show');
  await s.getByLabel('Heading').fill('Budget portal');
  await s.getByLabel('Button').fill('Enter');
  eq(await tileIn(s, 'custom').locator('h1').innerText(), 'Budget portal', 'live heading');
  eq(await tileIn(s, 'custom').locator('.mgate-go').innerText(), 'Enter', 'live button');
  let posts = 0;
  const count = r => r.url().includes('store.php') && r.request().method() === 'POST' && posts++;
  page.on('response', count);
  await s.getByLabel('Heading').press('Tab');
  await settle(1500);
  page.off('response', count);
  eq(posts, 0, 'typing the words writes nothing');
  eq(await previewHeading(), 'Session timed out', 'unsaved words are not shown by Preview');
  await s.getByRole('button', { name: 'Save the lock screen' }).click();
  eq(await inUse(s), 'custom', 'In use moved');
  eq(await previewHeading(), 'Budget portal', 'Preview shows the saved words');
  await shoot(s, 'tiles');
  // The same form in Settings follows a Save made in My account.
  await openApp('settings');
  const set = page.locator('.win', { has: page.locator('.set-ai') });
  const ss = set.locator('.saver-step').nth(1);
  await ss.waitFor();
  eq(await inUse(ss), 'custom', 'Settings shows the same look In use');
  eq(await ss.getByLabel('Heading').inputValue(), 'Budget portal', 'and the same words');
  await set.getByRole('button', { name: 'Close' }).first().click();
});

await step('keyboard: one Tab stop; the arrows move, Space picks; Save keeps it and an open Settings follows', async () => {
  await openApp('settings');
  const set = page.locator('.win', { has: page.locator('.set-ai') });
  const ss = set.locator('.saver-step').nth(1);
  await ss.waitFor();
  // My account back in front.
  await page.locator('.task', { hasText: 'My account' }).click();
  const s = acct().locator('.saver-step').nth(1);
  eq(await s.locator('.mini-tile[tabindex="0"]').count(), 1, 'one Tab stop');
  await tileIn(s, 'custom').focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  eq(await page.evaluate(() => document.activeElement?.getAttribute('data-value')), 'default', 'the arrows moved the focus');
  eq(await checked(s), 'custom', 'but did not pick');
  eq(await s.locator('.mini-tile[tabindex="0"]').count(), 1, 'still one Tab stop');
  await page.keyboard.press('Space');
  eq(await checked(s), 'default', 'Space picked');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  eq(await checked(s), 'plain', 'Enter picked');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press(' ');
  eq(await checked(s), 'default', 'back to TOMLIN OS');
  await page.keyboard.press('Tab');
  eq(await page.evaluate(() => document.activeElement?.classList.contains('mini-tile')), false, 'Tab leaves the row');
  eq(await inUse(ss), 'custom', 'Settings: unchanged before Save');
  await s.getByRole('button', { name: 'Save the lock screen' }).click();
  eq(await inUse(s), 'default', 'TOMLIN OS In use again');
  eq(await inUse(ss), 'default', 'the open Settings moved In use too');
  eq(await checked(ss), 'default', 'and its pick');
  eq(await previewHeading(), 'Locked', 'Preview shows it');
  await set.getByRole('button', { name: 'Close' }).first().click();
  await settle(1200);
});

await step('Lock now hides the desktop, changes the tab title, and the server refuses files until the PIN', async () => {
  await page.locator('.start-btn').click();
  await page.locator('.start-lock').click();
  await page.locator('#layer-lock .fake-sheet').waitFor();
  await settle(300);
  ok(await hidden(), 'desktop hidden and inert');
  eq(await page.title(), 'Q3 Budget - Spreadsheet', 'tab title while locked');
  eq(await storeStatus(), 423, 'store while locked');
  // A visible way out: the spreadsheet's own close button brings up the lock screen (still locked).
  await page.locator('#layer-lock .fake-close').click();
  await page.locator('#layer-lock .lock-pin').waitFor({ timeout: 10000 });
  eq(await storeStatus(), 423, 'still locked at the lock screen');
});

await step('a reload is still locked; the PIN opens it', async () => {
  await page.reload();
  await page.locator('.gate h1', { hasText: 'Locked' }).waitFor({ timeout: 20000 });
  eq(await page.locator('.gate input').count(), 1, 'one field on the lock screen');
  await page.locator('.lock-pin').fill('4821');
  await page.locator('#desktop .item').first().waitFor({ timeout: 20000 });
  eq(await storeStatus(), 200, 'store after unlocking');
});

await step('Escape twice does nothing until turned on in My account; then it shows the spreadsheet disguise at once; typing the PIN and Enter unlocks it without a lock screen', async () => {
  await page.locator('#desktop').click({ position: { x: 600, y: 400 } });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await settle(600);
  eq(await page.locator('#layer-lock .fake-sheet').count(), 0, 'off by default: no spreadsheet');
  await openApp('my account');
  const w = page.locator('.win', { has: page.locator('.account') });
  await w.locator('.acct-tab', { hasText: 'Screensaver and lock' }).click();
  await w.locator('.check-row', { hasText: 'Escape twice, quickly' }).locator('input').check();
  await w.getByRole('button', { name: 'Close' }).click();
  await page.locator('#desktop').click({ position: { x: 600, y: 400 } });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.locator('#layer-lock .fake-sheet').waitFor();
  await settle(400);
  eq(await storeStatus(), 423, 'locked on the server');
  eq(await page.locator('#layer-lock .fake-titlebar > span').innerText(), 'Q3 Budget - Spreadsheet', 'looks like a spreadsheet');
  eq(await page.title(), 'Q3 Budget - Spreadsheet', 'tab title');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.type('4821');
  await page.keyboard.press('Enter');
  await page.locator('#layer-lock').waitFor({ state: 'hidden' });
  eq(await storeStatus(), 200, 'unlocked');
  ok(!(await hidden()), 'desktop back');
});

await step('five wrong PINs sign out; signing in again needs the password and a two-step code', async () => {
  await page.keyboard.press('Alt+l');
  await page.locator('#layer-lock .fake-sheet').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('.lock-pin').waitFor();
  for (let i = 0; i < 5; i++) {
    await page.locator('.lock-pin').fill('000' + i);
    if (i < 4) await page.locator('.gate-problem', { hasText: `${4 - i} ${4 - i === 1 ? 'try' : 'tries'} left` }).waitFor();
  }
  await page.locator('.gate h1', { hasText: 'Sign in' }).waitFor({ timeout: 10000 });
  ok((await page.locator('.gate-note').innerText()).includes('signed out'), 'says why');
  // The picture check's answer box is in the form from the start, in a hidden row, until the server asks for it.
  eq(await page.locator('.gate input:visible').count(), 2, 'the sign-in screen shows two fields and nothing else');
  ok(await page.locator('.gate-captcha-row').isHidden(), 'no picture check before a wrong try');
  await page.getByLabel('User name').fill('alex');
  await page.locator('.gate input[type=password]').fill(PASS);
  await page.locator('.gate-go').click();
  await page.locator('.gate h1', { hasText: 'Two-step code' }).waitFor();
  await page.locator('.gate-code').fill('000000');
  await page.locator('.gate-go').click();
  await page.locator('.gate-problem', { hasText: 'not right' }).waitFor();
  await page.locator('.gate-code').fill(await nextCode(secret));
  await page.locator('.gate-go').click();
  await page.locator('.gate').waitFor({ state: 'detached', timeout: 10000 });
  // With the files encrypted (the default), the password first reopens the file key: a moment, not a fixed 200 ms.
  for (let i = 0; i < 50 && await hidden(); i++) await settle(200);
  ok(!(await hidden()), 'same person: the desktop carries on where it was');
});

await step('RISC-V Studio: Hello runs and prints; an example game runs and draws; Save As keeps it in Documents', async () => {
  await openApp('risc-v studio');
  const studio = page.locator('.studio');
  await studio.locator('.hl-line').first().waitFor();
  await page.keyboard.press('F5');
  await studio.locator('.studio-panel', { hasText: 'Hello from RISC-V' }).waitFor({ timeout: 10000 });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Alt+x');
  await page.keyboard.press('s');
  await studio.locator('.studio-code .dos-pane-title', { hasText: 'SNAKE.S' }).waitFor();
  await page.keyboard.press('F5');
  await settle(800);
  await page.keyboard.press('ArrowDown');
  await settle(600);
  const lit = await studio.locator('.screen-canvas').evaluate(c => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 0) n++;
    return n;
  });
  ok(lit > 50, 'the game drew: ' + lit + ' pixels lit');
  eq(await studio.locator('.studio-badge').innerText(), 'RUNNING', 'badge');
  await page.keyboard.press('F6');
  await page.keyboard.press('Control+Shift+S');
  await studio.locator('.dos-box', { hasText: 'Save As' }).waitFor();
  await studio.locator('.dos-box .dos-field').fill('MYSNAKE.S');
  await studio.locator('.dos-box .dos-btn.primary').click();
  await studio.locator('.studio-code .dos-pane-title', { hasText: 'MYSNAKE.S' }).waitFor();
  ok(!(await studio.locator('.studio-code .dos-pane-title').innerText()).includes('not saved'), 'saved');
  const saved = await page.evaluate(() => fetch('/api/store.php?key=/', { headers: { 'X-Desktop-Store': '1' } }).then(r => r.status));
  eq(saved, 200, 'store reachable');
});

await step('an assembler mistake is marked on its line with the reason', async () => {
  const studio = page.locator('.studio');
  await page.locator('.studio .code-input').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('bogus x1, x2\n');
  await page.keyboard.press('F9');
  await studio.locator('.dos-box', { hasText: 'Line 1' }).waitFor();
  ok(await studio.locator('.code-mark.error').isVisible(), 'red line');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
});

await step('the 2FA emulator shows the same code as an authenticator would', async () => {
  const em = await context.newPage();
  await em.goto(BASE + '/authenticator.html');
  await em.locator('.em-add input').first().fill(secret);
  await em.locator('.em-add input').nth(1).fill('TOMLIN OS (alex)');
  await em.getByRole('button', { name: 'Add' }).click();
  await em.locator('.em-code').first().waitFor();
  await em.waitForTimeout(1200);
  const shown = (await em.locator('.em-code').first().innerText()).replace(/\s/g, '');
  const expect = [codeFor(secret, 0), codeFor(secret, -1)];
  ok(expect.includes(shown), `emulator ${shown} vs ${expect}`);
  await em.close();
});

await step('Sign out from the Start menu shows the sign-in screen', async () => {
  await page.locator('.win', { has: page.locator('.studio') }).getByRole('button', { name: 'Close' }).click();
  await settle(200);
  const discard = page.getByRole('button', { name: 'Close without saving' });
  if (await discard.isVisible().catch(() => false)) await discard.click();
  await page.locator('.start-btn').click();
  await page.locator('.start-signout').click();
  await page.locator('.gate h1', { hasText: 'Sign in' }).waitFor({ timeout: 10000 });
  eq(await storeStatus(), 401, 'store after signing out');
});

await step('no page errors or blocked resources in the whole run', async () => {
  const csp = await page.evaluate(() => window.__csp);
  eq(csp, [], 'CSP violations');
  // Refusals this run asks for on purpose: 400 for the weak password at set-up, 401/403/423 for wrong PINs and codes,
  // locked and signed out. 404: a key not made yet. Any other 400 is a fault.
  eq(bad400.filter(u => !u.endsWith('op=setup')), [], 'unexpected 400 answers');
  const real = problems.filter(p => !/40[0134]|423|409/.test(p));
  eq(real, [], 'console problems');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) console.log('Failed: ' + failures.join('; '));
await Promise.race([browser.close(), new Promise(r => setTimeout(r, 3000))]);
process.exit(failures.length ? 1 : 0);
