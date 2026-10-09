// Screenshots of the RISC-V Studio for a quick look (not a test): opens it from the Start menu, runs an example.
//   node tools/shot-studio.mjs [http://127.0.0.1:3042] [out-folder]
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3042';
const OUT = process.argv[3] ?? '.';
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const problems = [];
page.on('console', m => m.type() === 'error' && problems.push(m.text()));
page.on('pageerror', e => problems.push(e.message));
await page.goto(BASE);
await page.waitForSelector('#root.ready', { timeout: 15000 });
await page.click('.start-btn');
await page.click('.start-item[data-label="risc-v studio"]');
await page.waitForSelector('.studio .hl-line');
await page.keyboard.press('F10');
await page.keyboard.press('ArrowRight');
await page.keyboard.press('ArrowRight');
await page.keyboard.press('ArrowRight');
await page.keyboard.press('Enter');
await page.screenshot({ path: `${OUT}/studio-menu.png` });
await page.keyboard.press('Escape');
await page.keyboard.press('Alt+x');
await page.keyboard.press('t');
await page.waitForTimeout(300);
await page.keyboard.press('F5');
await page.waitForTimeout(800);
await page.keyboard.press('Space');
for (let i = 0; i < 12; i++) {
  await page.keyboard.press(i % 3 ? 'ArrowLeft' : 'ArrowUp');
  await page.waitForTimeout(120);
}
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/studio-tetris.png` });
await page.keyboard.press('F6');
await page.waitForTimeout(200);
await page.screenshot({ path: `${OUT}/studio-paused.png` });
console.log(problems.length ? 'PROBLEMS:\n' + problems.join('\n') : 'no console errors');
await browser.close();
process.exit(0);
