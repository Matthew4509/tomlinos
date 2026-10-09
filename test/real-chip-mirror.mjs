// End-to-end, with the REAL Qwen 3.5 0.8B on this computer's graphics chip, the path a hosted TOMLIN OS takes when Hugging
// Face no longer has the pinned version: the owner presses "Save to this TOMLIN OS" in Settings › AI, the server fetches
// every file from the TOMLIN OS model mirror (each checked against its pinned SHA-256), then the model starts in Chat ›
// Agents from this TOMLIN OS's own copy and answers. Also checked: no model file came from anywhere but this TOMLIN OS, the
// program in the browser's cache matches its pin, and no Trusted Types refusal or page error happened.
// Needs: a mirror door running with its files (php -S ... mirror/index.php, DESKTOP_MIRROR_FILES filled with
// "php mirror/index.php fill <id>"), and a PHP server for TOMLIN OS on a NEW empty data folder whose Hugging Face is a
// stand-in that answers 404 (DESKTOP_MODELS_TEST_URL), with the real pins (DESKTOP_MODELS_TEST_PINS) and the mirror
// (DESKTOP_MODELS_TEST_MIRROR). Then:
//   node test/real-chip-mirror.mjs http://127.0.0.1:3078 test-results/<short folder> [screenshot folder]
import { chromium } from 'playwright-core';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [base, profile, shots] = process.argv.slice(2);
const PASS = randomBytes(12).toString('base64url'); // a throw-away owner on a throw-away data folder
const MODEL = 'Qwen3.5-0.8B-q4f32_1-MLC';
const pins = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'server', 'lib', 'model-pins.json'), 'utf8'));
setTimeout(() => { console.log('STOPPED: 20 minute limit'); process.exit(1); }, 20 * 60 * 1000);
let failed = 0;
const check = (ok, what) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

const context = await chromium.launchPersistentContext(profile, { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, viewport: { width: 1280, height: 800 } });
const page = context.pages()[0] ?? await context.newPage();
const problems = [];
page.on('pageerror', e => problems.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error' && /Trusted Type|TrustedHTML|TrustedScript|require-trusted-types/i.test(m.text())) problems.push('console: ' + m.text()); });
const modelFiles = [];
page.on('request', r => { if (/\.wasm|mlc-chat-config|tensor-cache|params_shard|tokenizer/.test(r.url())) modelFiles.push(r.url()); });

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
  check(await page.locator('.tray-lock').isVisible(), 'the padlock is by the clock');

  // 1. Settings › AI: the owner saves the model to this TOMLIN OS. Hugging Face (the stand-in) answers 404, so every file
  // comes from the mirror.
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('settings');
  await page.locator('.start-menu [data-label="settings"]').first().click();
  const settings = page.locator('.win.active');
  await settings.getByLabel('Built-in model').selectOption(MODEL);
  let t = Date.now();
  await settings.getByRole('button', { name: 'Save to this TOMLIN OS' }).click();
  // The line under the progress bar (assistant/aisettings.ts saveText).
  const said = settings.locator('.set-ai progress.ai-progress + p');
  await said.filter({ hasNotText: /^(Starting|Saving)/ }).waitFor({ timeout: 15 * 60 * 1000 });
  const words = await said.innerText();
  console.log(`save: ${((Date.now() - t) / 1000).toFixed(1)} s: ${words}`);
  check(/is saved on this TOMLIN OS/.test(words), 'saved to this TOMLIN OS (from the mirror)');
  if (shots) await page.screenshot({ path: `${shots}/1-saved.png` });
  const listed = await page.evaluate(async () => (await fetch('/api/models.php?op=list', { headers: { 'X-Desktop-Store': '1' } })).json());
  const m = listed.models.find(x => x.id === 'Qwen3.5-0.8B-q4f32_1-MLC');
  check(m?.saved === true, 'the server lists it as saved');
  check(m?.libSha256 === pins.libs['Qwen3.5-0.8B-q4f32_1_cs1k-webgpu.wasm'].sha256, 'the page is given the pinned checksum of the program');
  await settings.getByRole('button', { name: 'Close', exact: true }).click();

  // 2. Chat › Agents: connect the built-in AI (from this TOMLIN OS's copy) and ask.
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('panel');
  await page.locator('.start-menu [data-label="panel"]').first().click();
  const w = page.locator('.win.active');
  await w.locator('.panel-nav-item', { hasText: 'OVERVIEW' }).waitFor();
  const chat = w.locator('.panel-chat');
  await chat.getByRole('tab', { name: 'Agents' }).click();
  await chat.getByLabel('Agent', { exact: true }).selectOption(`device:${MODEL}`);
  t = Date.now();
  await chat.getByRole('button', { name: 'Connect' }).click();
  await chat.locator('.agent-note', { hasText: /Connected: Qwen 3.5 0.8B|could not start/ }).waitFor({ timeout: 300000 });
  const note = await chat.locator('.agent-note').first().innerText();
  console.log(`connect: ${((Date.now() - t) / 1000).toFixed(1)} s: ${note.slice(0, 200)}`);
  check(/Connected: Qwen 3.5 0.8B/.test(note), 'the model started from this TOMLIN OS');
  await chat.getByLabel('Message to the agent').fill('Say hello in five words.');
  await chat.getByLabel('Message to the agent').press('Enter');
  t = Date.now();
  await chat.locator('.chat-msg.agent .chat-text').filter({ hasNotText: '…' }).first().waitFor({ timeout: 300000 });
  await chat.getByRole('button', { name: 'Send' }).and(page.locator(':enabled')).waitFor({ timeout: 300000 });
  const said2 = (await chat.locator('.chat-msg.agent .chat-text').last().innerText()).trim();
  console.log(`answer in ${((Date.now() - t) / 1000).toFixed(1)} s: ${JSON.stringify(said2.slice(0, 200))}`);
  check(said2.length > 3, 'it answered');
  if (shots) await page.screenshot({ path: `${shots}/2-answer.png` });

  // 3. Where the files came from, and the program's checksum in the browser's cache.
  const origin = new URL(base).origin;
  const outside = modelFiles.filter(u => !u.startsWith(origin));
  check(outside.length === 0, `every model file came from this TOMLIN OS (${modelFiles.length} requests${outside.length ? '; outside: ' + outside.slice(0, 3).join(', ') : ''})`);
  const cached = await page.evaluate(async () => {
    const cache = await caches.open('webllm/wasm');
    const keys = await cache.keys();
    const out = [];
    for (const k of keys) {
      const buf = await (await cache.match(k)).arrayBuffer();
      out.push([k.url, Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)), b => b.toString(16).padStart(2, '0')).join('')]);
    }
    return out;
  });
  check(cached.length === 1 && cached[0][1] === pins.libs['Qwen3.5-0.8B-q4f32_1_cs1k-webgpu.wasm'].sha256, `the program in the browser's cache is the pinned one (${cached.map(c => c[0]).join(', ')})`);
  // 4. The quick ways out: the Panel's buttons, the padlock's menu, then Alt+Shift+L signs out to the book.
  check(await w.locator('.panel-quick', { hasText: 'Lock screen' }).isVisible() && await w.locator('.panel-quick', { hasText: 'Sign out' }).isVisible(), 'Lock screen and Sign out at the top of the Panel');
  await page.locator('.tray-lock').click({ button: 'right' });
  const items = await page.locator('.menu-item').allInnerTexts();
  check(items.some(t => t.includes('Lock the screen')) && items.some(t => t.includes('Sign out')), `the padlock's menu offers Lock and Sign out (${items.join(' | ')})`);
  await page.keyboard.press('Escape');
  if (shots) await page.screenshot({ path: `${shots}/3-quick.png` });
  const tt = await page.evaluate(() => typeof window.trustedTypes !== 'undefined' && document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content.includes("require-trusted-types-for 'script'"));
  check(tt === true, 'the page runs under Trusted Types');
  await page.keyboard.press('Alt+Shift+L');
  await page.locator('.gate, iframe[src*="reader"]').first().waitFor({ timeout: 20000 });
  const status = await page.evaluate(async () => (await fetch('/api/auth.php?op=status', { headers: { 'X-Desktop-Store': '1' } })).json());
  check(status.signedIn === false, 'Alt+Shift+L signed out');
  if (shots) await page.screenshot({ path: `${shots}/4-signed-out.png` });
} catch (error) {
  console.log('FAIL (stopped): ' + (error instanceof Error ? error.message : String(error)));
  failed++;
  if (shots) await page.screenshot({ path: `${shots}/stopped.png` }).catch(() => undefined);
}
check(problems.length === 0, `no page errors or Trusted Types refusals${problems.length ? ': ' + problems.slice(0, 3).join(' | ') : ''}`);
await context.close();
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed ? 1 : 0);
