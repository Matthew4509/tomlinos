// Audit of My account, the sign-in gate and the lock screen in a real Chrome: the faults found by the audit, each as a
// step that fails now and passes once fixed. Needs the dev server on a FRESH, EMPTY data folder with DESKTOP_TEST_CAPTCHA=1
// (the first step sets up the owner), and `npm run build` done.
//   node test/browser-audit-account.mjs [http://127.0.0.1:3136]
import { chromium } from 'playwright-core';
import { createHmac } from 'node:crypto';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3136';
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
    console.log('  FAIL ' + name + '\n       ' + String(error.message).split('\n')[0].slice(0, 600));
  }
}
const ok = (v, what) => {
  if (!v) throw new Error(what);
};

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function codeAt(secret, step) {
  let bits = '';
  for (const c of secret) bits += B32.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map(b => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
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
        return codeAt(secret, s);
      }
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const api = (op, body) => page.evaluate(([op, body]) => fetch('api/auth.php?op=' + op, {
  method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
  headers: { 'X-Desktop-Store': '1', 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(async r => ({ status: r.status, json: await r.json().catch(() => null) })), [op, body]);
const openAccount = async () => {
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('my account');
  await page.locator('.start-menu [data-label="my account"]').first().click();
  const w = page.locator('.win', { has: page.locator('.account') });
  await w.waitFor();
  return w;
};

console.log('Account audit, against ' + BASE);
let rkey = '';
let secret = '';
let recovery = [];

await page.goto(BASE);
await step('set-up: the owner, unencrypted, with a recovery key shown once', async () => {
  await page.locator('.gate h1', { hasText: 'Set up this desktop' }).waitFor({ timeout: 20000 });
  await page.getByLabel('Your name').fill('Sample Owner');
  await page.locator('.gate input[type=password]').fill(PASS);
  await page.locator('.gate .gate-encrypt').uncheck();
  await page.locator('.gate-go').click();
  await page.locator('.gate h1', { hasText: 'Your recovery key' }).waitFor({ timeout: 30000 });
  rkey = (await page.locator('.gate-rkey-show').innerText()).trim();
  await page.locator('.gate .check-row input').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#desktop .item').first().waitFor({ timeout: 20000 });
  ok((await api('site-front', { front: 'signin' })).status === 200, 'sign-in front');
});

await step('two-step turned on from My account (setup for the steps below)', async () => {
  const w = await openAccount();
  await w.getByRole('button', { name: 'Turn on...' }).click();
  await w.locator('.acct-form input[type=password]').fill(PASS);
  await w.getByRole('button', { name: 'Next' }).click();
  await w.locator('.acct-qr').waitFor();
  secret = (await w.locator('.acct-secret').innerText()).replace(/\s/g, '');
  await w.locator('.acct-form input[autocomplete=one-time-code]').fill(await nextCode(secret));
  await w.getByRole('button', { name: 'Turn on', exact: true }).click();
  await w.locator('.acct-codes li').first().waitFor();
  recovery = await w.locator('.acct-codes li').allInnerTexts();
  await w.getByRole('button', { name: 'I have kept them somewhere safe' }).click();
});

// ACC-P1: a refused new password still uses up the recovery code typed with it.
await step('ACC-P1-1: Change password with a too-short new password keeps the recovery code typed for it', async () => {
  const w = page.locator('.win', { has: page.locator('.account') });
  const before = (await api('status')).json.user.recoveryLeft;
  await w.getByRole('button', { name: 'Change password...' }).click();
  await w.locator('.acct-form input[autocomplete=current-password]').fill(PASS);
  await w.locator('.acct-form input[autocomplete=one-time-code]').fill(recovery[0]);
  await w.locator('.acct-form input[autocomplete=new-password]').fill('short');
  await w.getByRole('button', { name: 'Change password', exact: true }).click();
  await w.locator('.acct-form .dialog-problem', { hasText: '8 characters' }).waitFor();
  const after = (await api('status')).json.user.recoveryLeft;
  ok(after === before, `recovery codes left went from ${before} to ${after} although nothing was changed`);
  await w.getByRole('button', { name: 'Cancel' }).click();
});

await step('ACC-P1-2: the lock screen takes a recovery code in place of the authenticator code (sign-in does)', async () => {
  // Locked on the server, then a reload: the lock gate asks for password and code.
  ok((await api('lock', {})).status === 200, 'locked');
  await page.reload();
  await page.locator('.gate h1', { hasText: 'Locked' }).waitFor({ timeout: 20000 });
  const field = page.locator('.gate input[aria-label="Two-step code"]');
  await page.locator('.gate input[type=password]').fill(PASS);
  await field.fill(recovery[1]);
  const typed = await field.inputValue();
  ok(typed === recovery[1], `the code box kept only "${typed}" of the recovery code "${recovery[1]}" (maxlength 6)`);
  await page.locator('.gate-go').click();
  await page.locator('#desktop .item').first().waitFor({ timeout: 8000 });
});

await step('ACC-P1-3: "Forgot your password?" with a too-short new password can be retried with the same recovery code', async () => {
  // Whatever state the last step left: signed out, on the sign-in screen.
  await api('logout', {});
  await page.reload();
  await page.locator('.gate h1', { hasText: 'Sign in' }).waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: 'Forgot your password?' }).click();
  await page.locator('.gate h1', { hasText: 'Forgot your password?' }).waitFor();
  await page.getByLabel('User name').fill('sampleowner');
  await page.getByLabel('Recovery key').fill(rkey);
  await page.getByLabel('Two-step code (only if you use two-step sign-in)').fill(recovery[2]);
  await page.locator('.gate input[autocomplete=new-password]').fill('short');
  await page.locator('.gate-go').click();
  await page.locator('.gate-problem', { hasText: '8 characters' }).waitFor({ timeout: 10000 });
  // The person fixes the one thing they were told was wrong.
  await page.locator('.gate input[autocomplete=new-password]').fill('meadow-willow-saffron-31');
  await page.locator('.gate-go').click();
  const result = await Promise.race([
    page.locator('#desktop .item').first().waitFor({ timeout: 15000 }).then(() => 'desktop'),
    page.locator('.gate-problem', { hasText: 'do not match' }).waitFor({ timeout: 15000 }).then(() => 'refused'),
  ]);
  ok(result === 'desktop', 'after fixing only the new password, the reset was refused with "Those do not match" (the recovery code was used up by the first try)');
});

await step('small window: My account at phone width keeps its pages and buttons on screen, no sideways scroll', async () => {
  // Signed in again whatever the last step did.
  if (!(await page.locator('#desktop .item').first().isVisible().catch(() => false))) {
    // Signed in by the API (the password is whichever the last step left), then a reload shows the desktop.
    for (const pw of ['meadow-willow-saffron-31', PASS]) {
      let r = await api('login', { name: 'sampleowner', password: pw });
      if (r.status === 428) {
        const c = await api('captcha');
        r = await api('login', { name: 'sampleowner', password: pw, captchaId: c.json.id, captcha: c.json.answer });
      }
      if (r.json?.stage === '2fa') {
        await api('code', { code: await nextCode(secret) });
        break;
      }
    }
    await page.reload();
    await page.locator('#desktop .item').first().waitFor({ timeout: 20000 });
  }
  await page.setViewportSize({ width: 375, height: 700 });
  await page.waitForTimeout(400);
  const w = await openAccount();
  const facts = await w.evaluate(el => {
    const body = el.querySelector('.account');
    const btn = [...el.querySelectorAll('button')].find(b => b.textContent === 'Change password...');
    const r = btn?.getBoundingClientRect();
    return { scrollW: body.scrollWidth, clientW: body.clientWidth, winRight: el.getBoundingClientRect().right, vw: innerWidth, btn: r ? r.right : -1 };
  });
  ok(facts.winRight <= facts.vw + 1, `window wider than the screen: ${JSON.stringify(facts)}`);
  ok(facts.scrollW <= facts.clientW + 1, `sideways scroll inside My account: ${JSON.stringify(facts)}`);
  ok(facts.btn > 0 && facts.btn <= facts.vw, `Change password... off screen: ${JSON.stringify(facts)}`);
  await page.setViewportSize({ width: 1280, height: 800 });
});

await step('keyboard: the page list is reachable with Tab and keeps focus after Enter', async () => {
  const w = page.locator('.win', { has: page.locator('.account') });
  await w.locator('.acct-tab').first().focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  const focused = await page.evaluate(() => document.activeElement?.className ?? '');
  ok(/acct-tab/.test(focused) && /\bon\b/.test(focused), 'focus after choosing a page: ' + focused);
});

ok(true, '');
console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? ': ' + failures.join('; ') : ''}`);
if (errors.length) console.log('page errors:', errors.slice(0, 5).join(' | '));
await browser.close();
process.exit(failures.length ? 1 : 0);
