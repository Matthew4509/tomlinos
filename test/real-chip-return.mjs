// End-to-end with the REAL Qwen 3.5 0.8B on this computer: Disconnect; one model in the whole browser (a second tab is
// refused); and once it is downloaded, a person can close the Panel and come back to find the chats and the model
// still there, without downloading again (Panel closed and opened again, then a full reload).
// Model files fetched over the network are counted; a start from this browser's own copy fetches none.
// Needs a real graphics chip and the real models/ folder: start a PHP server on a NEW empty data folder
// (DESKTOP_DATA_DIR) without DESKTOP_MODELS_DIR, then:
//   node test/real-chip-return.mjs http://127.0.0.1:3071 test-results/<short folder> [screenshot folder]
// Keep the profile folder SHORT (a deep path fails in Chrome's cache: "Entry already exists").
import { chromium } from 'playwright-core';
import { randomBytes } from 'node:crypto';

const [base, profile, shots] = process.argv.slice(2);
const PASS = randomBytes(12).toString('base64url'); // a throw-away owner on a throw-away data folder
const MODEL = 'Qwen3.5-0.8B-q4f32_1-MLC';
setTimeout(() => { console.log('STOPPED: 20 minute limit'); process.exit(1); }, 20 * 60 * 1000);
let failed = 0;
const check = (ok, what) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const shot = async (page, name) => shots && page.screenshot({ path: `${shots}/${name}.png` });

const context = await chromium.launchPersistentContext(profile, { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, viewport: { width: 1280, height: 800 } });
await context.addInitScript(() => {
  window.__gpuDevices = 0;
  if (typeof GPUAdapter === 'undefined') return;
  const open = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = function (...args) { window.__gpuDevices++; return open.apply(this, args); };
});
let fetched = 0; // model files fetched over the network, by any tab
context.on('request', r => { if (r.url().includes(`/models/${MODEL}/`)) fetched++; });
const problems = [];
const watch = page => page.on('pageerror', e => problems.push(e.message));
const starts = page => page.evaluate(() => window.__gpuDevices);

async function openPanel(page) {
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('panel');
  await page.locator('.start-menu [data-label="panel"]').first().click();
  const w = page.locator('.win.active');
  await w.locator('.panel-nav-item', { hasText: 'OVERVIEW' }).waitFor();
  return w;
}
const rail = (w, label) => w.locator('.panel-nav-item', { hasText: label }).click();

const page = context.pages()[0] ?? await context.newPage();
watch(page);
try {
  await page.goto(base);
  await page.locator('.gate h1', { hasText: 'Set up this desktop' }).waitFor({ timeout: 20000 });
  await page.getByLabel('Your name').fill('Test Owner');
  await page.locator('.gate input.gate-input').last().fill(PASS);
  await page.locator('.gate-go').click();
  await page.locator('.gate h1', { hasText: 'Your recovery key' }).waitFor({ timeout: 30000 });
  await page.locator('.gate .check-row input').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#desktop .item').first().waitFor({ timeout: 20000 });

  // 1. First time: connect in the Overview chat (the model is copied into this browser) and ask.
  let w = await openPanel(page);
  let chat = w.locator('.panel-chat');
  await chat.getByRole('tab', { name: 'Agents' }).click();
  await chat.getByLabel('Agent', { exact: true }).selectOption(`device:${MODEL}`);
  await chat.getByRole('button', { name: 'Connect', exact: true }).click();
  await chat.locator('.agent-note', { hasText: 'Connected: Qwen 3.5 0.8B' }).waitFor({ timeout: 240000 });
  console.log(`first connect: ${fetched} model files fetched from the TOMLIN OS server`);
  check(fetched > 0, 'the first time, the model comes from the server');
  await chat.getByLabel('Message to the agent', { exact: true }).fill('Name one planet.');
  await chat.getByLabel('Message to the agent', { exact: true }).press('Enter');
  await chat.getByRole('button', { name: 'Send' }).and(page.locator(':enabled')).waitFor({ timeout: 180000 });
  const answer = (await chat.locator('.agent-pane .chat-msg.agent .chat-text').last().innerText()).trim();
  console.log(`answer: ${JSON.stringify(answer.slice(0, 80))}`);

  // 2. Disconnect in the Qwen section: it stops for the whole desktop; the chat stays.
  await rail(w, 'CONNECT AI MODELS');
  const ai = w.locator('.panel-host.ai');
  await ai.locator('.ai-left .ai-hello', { hasText: 'Already connected' }).waitFor({ timeout: 30000 });
  await ai.locator('.ai-left').getByRole('button', { name: 'Disconnect', exact: true }).click();
  const said = ai.locator('.ai-left .ai-progress-text', { hasText: 'Disconnected' });
  await said.waitFor({ timeout: 15000 });
  check(true, `Qwen section after Disconnect: ${JSON.stringify(await said.innerText())}`);
  check(await ai.getByRole('button', { name: 'Start the built-in AI' }).isVisible(), 'back on the Start page');
  await shot(page, '1-qwen-disconnected');
  await rail(w, 'OVERVIEW');
  const note = chat.locator('.agent-note');
  check((await note.innerText()).startsWith('Disconnected'), `Overview chat: ${JSON.stringify(await note.innerText())}`);
  check(await chat.getByRole('button', { name: 'Connect', exact: true }).isEnabled(), 'Connect is offered again');
  check((await chat.locator('.agent-pane .chat-msg').count()) === 2, 'the chat stayed');

  // 3. One model in the whole browser: a second TOMLIN OS tab starts it; this tab is refused, then allowed once that
  // tab lets go.
  const page2 = await context.newPage();
  watch(page2);
  await page2.goto(base);
  await page2.locator('#desktop .item').first().waitFor({ timeout: 30000 });
  const w2 = await openPanel(page2);
  await rail(w2, 'CONNECT AI MODELS');
  const ai2 = w2.locator('.panel-host.ai');
  const before2 = fetched;
  await ai2.getByRole('button', { name: 'Start the built-in AI' }).click();
  await ai2.locator('.ai-left .ai-chat').waitFor({ state: 'visible', timeout: 240000 });
  check(fetched === before2, `the second tab started it from this browser's copy (${fetched - before2} files fetched)`);
  const starts1 = await starts(page);
  await chat.getByRole('button', { name: 'Connect', exact: true }).click();
  const refused = chat.locator('.agent-note', { hasText: 'already running in another TOMLIN OS tab' });
  await refused.waitFor({ timeout: 15000 });
  check(true, `this tab says: ${JSON.stringify(await refused.innerText())}`);
  check(await starts(page) === starts1, 'and started nothing');
  await shot(page, '2-refused-another-tab');
  await w2.getByRole('button', { name: 'Close', exact: true }).click();
  await page2.close();
  await chat.getByRole('button', { name: 'Connect', exact: true }).click();
  await chat.locator('.agent-note', { hasText: 'Connected: Qwen 3.5 0.8B' }).waitFor({ timeout: 120000 });
  check(true, 'with the other tab closed, this tab connects');

  // 4. Close the Panel and open it again: the chat is there, and the model starts from this browser's copy.
  await w.getByRole('button', { name: 'Close', exact: true }).click();
  w = await openPanel(page);
  await rail(w, 'CONNECT AI MODELS');
  const ai3 = w.locator('.panel-host.ai');
  await ai3.getByRole('button', { name: 'Start the built-in AI' }).waitFor({ state: 'visible', timeout: 30000 });
  const before4 = fetched;
  let t = Date.now();
  await ai3.getByRole('button', { name: 'Start the built-in AI' }).click();
  await ai3.locator('.ai-left .ai-chat').waitFor({ state: 'visible', timeout: 240000 });
  const secs4 = ((Date.now() - t) / 1000).toFixed(1);
  const log4 = await ai3.locator('.ai-left .ai-log .ai-msg').allInnerTexts();
  check(log4.length >= 2 && log4[0].includes('Name one planet.'), `Panel closed and opened: the chat is there (${log4.length} messages)`);
  check(fetched === before4, `and the model started in ${secs4} s with ${fetched - before4} files downloaded`);

  // 5. A full reload of the page: the chat comes back, and the model still starts without downloading.
  await page.reload();
  await page.locator('#desktop .item').first().waitFor({ timeout: 30000 });
  w = await openPanel(page);
  await rail(w, 'CONNECT AI MODELS');
  const ai5 = w.locator('.panel-host.ai');
  await ai5.getByRole('button', { name: 'Start the built-in AI' }).waitFor({ state: 'visible', timeout: 30000 });
  const before5 = fetched;
  t = Date.now();
  await ai5.getByRole('button', { name: 'Start the built-in AI' }).click();
  await ai5.locator('.ai-left .ai-chat').waitFor({ state: 'visible', timeout: 240000 });
  const secs5 = ((Date.now() - t) / 1000).toFixed(1);
  const log5 = await ai5.locator('.ai-left .ai-log .ai-msg').allInnerTexts();
  check(log5.length >= 2 && log5[0].includes('Name one planet.'), `page reloaded: the chat is back (${log5.length} messages)`);
  check(fetched === before5, `and the model started in ${secs5} s with ${fetched - before5} files downloaded`);
  await shot(page, '3-after-reload');
} catch (error) {
  failed++;
  console.log('STOPPED: ' + String(error.message || error).split('\n')[0]);
  await shot(page, 'stopped').catch(() => {});
}
check(problems.length === 0, `no page errors${problems.length ? ': ' + problems.join(' | ') : ''}`);
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
context.close().catch(() => {});
setTimeout(() => process.exit(failed ? 1 : 0), 500);
