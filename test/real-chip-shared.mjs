// End-to-end, with the REAL Qwen 3.5 0.8B on this computer's graphics chip: connect in the Panel's Overview chat
// (Chat › Agents), ask, switch to the Qwen section (the Assistant): it must say "Already connected", show the chat so
// far, and not start the model again; ask there; back on the Overview the new turns are in the Agents tab too.
// Needs a real graphics chip and the real models/ folder: start a PHP server on a NEW empty data folder
// (DESKTOP_DATA_DIR) without DESKTOP_MODELS_DIR, then:
//   node test/real-chip-shared.mjs http://127.0.0.1:3071 test-results/<short folder> [screenshot folder]
// Keep the profile folder SHORT (a deep path fails in Chrome's cache: "Entry already exists").
import { chromium } from 'playwright-core';
import { randomBytes } from 'node:crypto';

const [base, profile, shots] = process.argv.slice(2);
const PASS = randomBytes(12).toString('base64url'); // a throw-away owner on a throw-away data folder
const MODEL = 'Qwen3.5-0.8B-q4f32_1-MLC';
setTimeout(() => { console.log('STOPPED: 15 minute limit'); process.exit(1); }, 15 * 60 * 1000);
let failed = 0;
const check = (ok, what) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

const context = await chromium.launchPersistentContext(profile, { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, viewport: { width: 1280, height: 800 } });
const page = context.pages()[0] ?? await context.newPage();
const problems = [];
page.on('pageerror', e => problems.push(e.message));
// Every start of the model opens its own connection to the graphics chip (GPUAdapter.requestDevice); a start from
// this browser's saved copy makes no network request, so the connections are what is counted.
await context.addInitScript(() => {
  window.__gpuDevices = 0;
  if (typeof GPUAdapter === 'undefined') return;
  const open = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = function (...args) { window.__gpuDevices++; return open.apply(this, args); };
});
const starts = () => page.evaluate(() => window.__gpuDevices);

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

  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('panel');
  await page.locator('.start-menu [data-label="panel"]').first().click();
  const w = page.locator('.win.active');
  await w.locator('.panel-nav-item', { hasText: 'OVERVIEW' }).waitFor();

  // 1. The Overview's chat, Agents tab: connect the built-in AI and ask.
  const chat = w.locator('.panel-chat');
  await chat.getByRole('tab', { name: 'Agents' }).click();
  await chat.getByLabel('Agent', { exact: true }).selectOption(`device:${MODEL}`);
  let t = Date.now();
  await chat.getByRole('button', { name: 'Connect' }).click();
  await chat.locator('.agent-note', { hasText: 'Connected: Qwen 3.5 0.8B' }).waitFor({ timeout: 240000 });
  const asksAfterFirst = await starts();
  console.log(`connected in the Overview chat in ${((Date.now() - t) / 1000).toFixed(1)} s (graphics-chip connections: ${asksAfterFirst})`);
  check(asksAfterFirst === 1, 'one start');
  await chat.getByLabel('Message to the agent').fill('Say hello in five words.');
  await chat.getByLabel('Message to the agent').press('Enter');
  await chat.locator('.chat-msg.agent .chat-text').filter({ hasNotText: '…' }).first().waitFor({ timeout: 180000 });
  await chat.getByRole('button', { name: 'Send' }).and(page.locator(':enabled')).waitFor({ timeout: 180000 });
  const firstAnswer = (await chat.locator('.chat-msg.agent .chat-text').last().innerText()).trim();
  console.log(`answer in the Overview: ${JSON.stringify(firstAnswer.slice(0, 120))}`);
  check(firstAnswer.length > 0, 'the Overview chat answered');

  // 2. The Qwen section: already connected, the chat so far below, nothing started again.
  t = Date.now();
  await w.locator('.panel-nav-item', { hasText: 'CONNECT AI MODELS' }).click();
  const ai = w.locator('.panel-host.ai');
  const hello = ai.locator('.ai-left .ai-hello');
  await hello.waitFor({ state: 'visible', timeout: 30000 });
  const helloText = await hello.innerText();
  console.log(`Qwen section after ${((Date.now() - t) / 1000).toFixed(1)} s: ${JSON.stringify(helloText)}`);
  check(helloText.startsWith('Already connected: Qwen 3.5 0.8B'), 'says "Already connected"');
  check(await ai.locator('.ai-left .ai-chat').isVisible(), 'shows the chat, not the Start page');
  check(!(await ai.locator('.ai-left .ai-setup').isVisible()), 'no Start button to press');
  const history = await ai.locator('.ai-left .ai-log .ai-msg').allInnerTexts();
  check(history.length === 2 && history[0].includes('Say hello in five words.') && history[1].includes(firstAnswer.slice(0, 20)), `the chat so far is below (${history.length} messages)`);
  check(await starts() === asksAfterFirst, `the model was not started again (graphics-chip connections: ${await starts()})`);
  if (shots) await page.screenshot({ path: `${shots}/qwen-section-already-connected.png` });

  // 3. Ask in the Qwen section: the same conversation carries on.
  await ai.locator('.ai-left .ai-input').fill('Now say it in three words.');
  await ai.locator('.ai-left .ai-input').press('Enter');
  await ai.locator('.ai-left .ai-msg.assistant .ai-foot', { hasText: 'nothing left this device' }).last().waitFor({ timeout: 180000 });
  const second = (await ai.locator('.ai-left .ai-msg.assistant .ai-text').last().innerText()).trim();
  console.log(`answer in the Qwen section: ${JSON.stringify(second.slice(0, 120))}`);
  check(second.length > 0, 'the Qwen section answered');
  check(await starts() === asksAfterFirst, 'still the one model');

  // 4. Back on the Overview, the Agents tab shows the whole conversation.
  await w.locator('.panel-nav-item', { hasText: 'OVERVIEW' }).click();
  const turns = await chat.locator('.agent-pane .chat-msg').allInnerTexts();
  check(turns.length === 4 && turns[2].includes('Now say it in three words.') && turns[3].includes(second.slice(0, 20)), `the Overview chat shows the new turns too (${turns.length} messages)`);
  check((await chat.locator('.agent-note').innerText()).includes('Connected'), 'the Overview chat is still connected');
  if (shots) await page.screenshot({ path: `${shots}/overview-after.png` });

  // 5. The other way round. Closing the Panel stops the model (no app uses it); open the Panel again, start the AI in
  // the Qwen section first: the Overview chat's Agents tab is then already connected, without starting it again.
  await w.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('.win').first().waitFor({ state: 'detached', timeout: 15000 }).catch(() => undefined);
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('panel');
  await page.locator('.start-menu [data-label="panel"]').first().click();
  const w2 = page.locator('.win.active');
  await w2.locator('.panel-nav-item', { hasText: 'CONNECT AI MODELS' }).click();
  const ai2 = w2.locator('.panel-host.ai');
  await ai2.getByRole('button', { name: 'Start the built-in AI' }).waitFor({ state: 'visible', timeout: 30000 });
  check(true, 'with the Panel closed and opened again, the model had stopped: the Start page shows');
  const before = await starts();
  await ai2.getByRole('button', { name: 'Start the built-in AI' }).click();
  await ai2.locator('.ai-left .ai-chat').waitFor({ state: 'visible', timeout: 240000 });
  check(await starts() === before + 1, 'Start in the Qwen section starts it once');
  await w2.locator('.panel-nav-item', { hasText: 'OVERVIEW' }).click();
  const chat2 = w2.locator('.panel-chat');
  await chat2.getByRole('tab', { name: 'Agents' }).click();
  const note2 = chat2.locator('.agent-note', { hasText: 'Already connected: Qwen 3.5 0.8B' });
  await note2.waitFor({ timeout: 15000 });
  check(true, `the Overview chat says: ${JSON.stringify(await note2.innerText())}`);
  check(await starts() === before + 1, 'the Overview chat joined it without starting it again');
  check(await chat2.getByLabel('Message to the agent', { exact: true }).isEnabled(), 'and is ready to type in');
  if (shots) await page.screenshot({ path: `${shots}/overview-already-connected.png` });
} catch (error) {
  failed++;
  console.log('STOPPED: ' + String(error.message || error).split('\n')[0]);
  if (shots) await page.screenshot({ path: `${shots}/stopped.png` }).catch(() => {});
}
check(problems.length === 0, `no page errors${problems.length ? ': ' + problems.join(' | ') : ''}`);
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
context.close().catch(() => {});
setTimeout(() => process.exit(failed ? 1 : 0), 500);
