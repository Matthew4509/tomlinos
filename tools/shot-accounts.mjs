// Screenshots of sign-in, My account (two-step QR), the lock screen, the spreadsheet screensaver, the RISC-V Studio and
// the 2FA emulator, for a quick look (not a test). Run against a FRESH, EMPTY server: it sets up a made-up owner.
//   node tools/shot-accounts.mjs [http://127.0.0.1:3043] [out-folder]
import { chromium } from 'playwright-core';
import { createHmac } from 'node:crypto';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3043';
const OUT = process.argv[3] ?? '.';
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PASS = 'orchard-lantern-harbour-58';
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function code(secret) {
  let bits = '';
  for (const c of secret) bits += B32.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map(b => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const mac = createHmac('sha1', key).update(counter).digest();
  return String((mac.readUInt32BE(mac[19] & 15) & 0x7fffffff) % 1e6).padStart(6, '0');
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const shot = name => page.screenshot({ path: `${OUT}/${name}.png` });
const openApp = async label => {
  await page.locator('.start-btn').click();
  await page.locator(`.start-item[data-label="${label}"]`).click();
};
await page.goto(BASE);
await page.locator('.gate h1').waitFor();
await page.getByLabel('Your name').fill('Sample Owner');
await page.getByRole('button', { name: 'Suggest one' }).click();
await shot('1-setup');
await page.locator('.gate input.gate-input').last().fill(PASS);
await page.locator('.gate-go').click();
await page.locator('.gate h1', { hasText: 'Your recovery key' }).waitFor();
await page.locator('.gate .check-row input').check();
await page.getByRole('button', { name: 'Continue' }).click();
await page.locator('#desktop .item').first().waitFor();
await openApp('my account');
const w = page.locator('.win', { has: page.locator('.account') });
await w.getByRole('button', { name: 'Maximise' }).click();
await w.getByRole('button', { name: 'Turn on...' }).click();
await w.locator('.acct-form input[type=password]').fill(PASS);
await w.getByRole('button', { name: 'Next' }).click();
await w.locator('.acct-qr').waitFor();
await w.locator('.acct-qr').scrollIntoViewIfNeeded();
await shot('2-two-step-qr');
const secret = (await w.locator('.acct-secret').innerText()).replace(/\s/g, '');
await w.locator('.acct-form input[autocomplete=one-time-code]').fill(code(secret));
await w.getByRole('button', { name: 'Turn on', exact: true }).click();
await w.locator('.acct-codes li').first().waitFor();
await w.getByRole('button', { name: 'I have kept them somewhere safe' }).click();
await w.getByRole('button', { name: 'Close' }).click();
await openApp('risc-v studio');
const studio = page.locator('.studio');
await studio.locator('.hl-line').first().waitFor();
await page.locator('.win', { has: studio }).getByRole('button', { name: 'Maximise' }).click();
await studio.locator('.code-input').click();
await page.keyboard.press('Alt+x');
await page.keyboard.press('i');
await page.keyboard.press('F5');
await page.waitForTimeout(700);
await page.keyboard.press('Space');
for (let i = 0; i < 10; i++) {
  await page.keyboard.down(i % 2 ? 'ArrowLeft' : 'ArrowRight');
  await page.waitForTimeout(150);
  await page.keyboard.up(i % 2 ? 'ArrowLeft' : 'ArrowRight');
  await page.keyboard.press('Space');
}
await page.waitForTimeout(800);
await shot('3-studio-invaders');
await page.keyboard.press('F6');
await page.keyboard.press('Alt+l');
await page.locator('#layer-lock .fake-sheet').waitFor();
await page.waitForTimeout(500);
await shot('4-spreadsheet-screensaver');
await page.keyboard.press('Escape');
await page.locator('.lock-gate').waitFor();
await shot('5-lock-screen');
const em = await browser.newPage({ viewport: { width: 600, height: 700 } });
await em.goto(BASE + '/authenticator.html');
await em.locator('.em-add input').first().fill(secret);
await em.locator('.em-add input').nth(1).fill('TOMLIN OS (sample)');
await em.getByRole('button', { name: 'Add' }).click();
await em.waitForTimeout(1500);
await em.screenshot({ path: `${OUT}/6-2fa-emulator.png` });
await Promise.race([browser.close(), new Promise(r => setTimeout(r, 3000))]);
process.exit(0);
