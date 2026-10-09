// Scratch measurement (not a suite): what the desktop loads before it is usable. node test/_startup.mjs <base>
import { chromium } from 'playwright-core';
const base = process.argv[2];
const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
const p = await ctx.newPage();
const t0 = Date.now();
await p.goto(base);
await p.locator('.gate h1', { hasText: 'Set up this desktop' }).waitFor({ timeout: 20000 });
const gate = Date.now() - t0;
await p.getByLabel('Your name').fill('Sample Owner');
await p.locator('.gate input.gate-input').last().fill('orchard-lantern-harbour-58');
await p.locator('.gate-go').click();
await p.locator('.gate .check-row input').check({ timeout: 30000 });
await p.getByRole('button', { name: 'Continue' }).click();
await p.locator('#desktop .item').first().waitFor({ timeout: 20000 });
const measure = async () => p.evaluate(() => {
  const r = performance.getEntriesByType('resource');
  const js = r.filter(e => /\.js(\?|$)/.test(e.name));
  const nav = performance.getEntriesByType('navigation')[0];
  return { resources: r.length, jsFiles: js.length, jsBytes: js.reduce((n, e) => n + (e.decodedBodySize || 0), 0), css: r.filter(e => /\.css/.test(e.name)).reduce((n, e) => n + (e.decodedBodySize || 0), 0), domContentLoaded: Math.round(nav.domContentLoadedEventEnd), vendor: r.filter(e => /vendor\//.test(e.name)).map(e => e.name.split('/').pop()) };
});
console.log('first visit (to the set-up screen):', gate, 'ms', JSON.stringify(await measure()));
// A reload, as a returning person sees it.
const t1 = Date.now();
await p.reload();
await p.locator('#desktop .item').first().waitFor({ timeout: 20000 });
console.log('reload to a usable desktop:', Date.now() - t1, 'ms', JSON.stringify(await measure()));
await b.close();
process.exit(0);
