// Scratch explorer (not a suite): sets up a fresh owner, runs STEPS from a module given on the command line, and
// screenshots. Usage: node test/_explore.mjs <base> <shots dir> <steps.mjs>
import { chromium } from 'playwright-core';
import { pathToFileURL } from 'node:url';

const [BASE, SHOTS, STEPS] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
page.on('console', m => (m.type() === 'error' || m.type() === 'warning') && console.log('console.' + m.type(), m.text().slice(0, 400)));
page.on('pageerror', e => console.log('pageerror', e.message));
await page.goto(BASE);
await page.locator('.gate h1', { hasText: 'Set up this desktop' }).waitFor({ timeout: 20000 });
await page.getByLabel('Your name').fill('Sample Owner');
await page.locator('.gate input.gate-input').last().fill('orchard-lantern-harbour-58');
await page.locator('.gate-go').click();
await page.locator('.gate .check-row input').check({ timeout: 30000 });
await page.getByRole('button', { name: 'Continue' }).click();
await page.locator('#desktop .item').first().waitFor({ timeout: 20000 });
const shot = name => page.screenshot({ path: `${SHOTS}/${name}.png` });
const openApp = async label => {
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill(label);
  await page.locator(`.start-menu [data-label="${label}"]`).first().click();
};
try {
  const mod = await import(pathToFileURL(STEPS).href);
  await mod.default({ page, shot, openApp });
} catch (e) {
  console.log('STEP ERROR', e.message.slice(0, 800));
  await shot('explore-error');
}
await browser.close().catch(() => {});
process.exit(0);
