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
  await w.locator('select:has(option[value="sheet"])').selectOption('sheet');
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
  eq(await page.locator('.gate input').count(), 2, 'the sign-in screen has two fields and nothing else');
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
