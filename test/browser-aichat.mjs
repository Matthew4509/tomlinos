// Drives the chat and AI upgrades in a real Chrome: the line under an answer, Copy, Regenerate and Edit in Chat ›
// Agents; favourites and hidden models (in the chat and in Settings › AI); "Disconnect when idle" kept per person; the
// "Good places to start" in Find AI models; and, when this Chrome has a graphics chip for AI, the short "could not
// start" line with "What happened?" and its small box. Claude is the stand-in (test/fake-anthropic.mjs, port 3190) and
// Hugging Face is answered inside the browser, so nothing leaves this computer. Needs the dev server on a FRESH, EMPTY
// data folder, started with DESKTOP_AI_TEST_URL=http://127.0.0.1:3190 (tools/run-browser-tests.sh does), and
// `npm run build` done.
//   node test/browser-aichat.mjs [http://127.0.0.1:3043] [screenshot folder]
import { chromium } from 'playwright-core';
import { startFakeAnthropic, KEY as AI_KEY } from './fake-anthropic.mjs';
import { MODEL_LIBS } from '../src/apps/assistant/modellibs.ts';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3043';
const SHOTS = process.argv[3] ?? null;
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
    await shot('fail-' + failures.length).catch(() => {});
    console.log('  FAIL ' + name + '\n       ' + String(error.message).slice(0, 1200));
  }
}
const eq = (a, b, what) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const ok = (v, what) => {
  if (!v) throw new Error(what);
};

const anthropic = await startFakeAnthropic(3190);
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
const page = await context.newPage();
const problems = [];
page.on('console', m => m.type() === 'error' && problems.push('console: ' + m.text()));
page.on('pageerror', e => problems.push('pageerror: ' + e.message));
const shot = async name => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });

// Hugging Face, answered in the browser: a model's settings (built from the engine's own program table, so the model
// matches a program) and its file list; the model files themselves are refused, so a start fails as a download would.
const hfAsked = [];
/** From the start-failure step on, the model's files are refused, as when a download does not arrive. */
let refuseModels = false;
await page.route(/^https:\/\/huggingface\.co\//, route => {
  const url = route.request().url();
  hfAsked.push(url);
  const m = /huggingface\.co\/(?:api\/models\/)?(mlc-ai\/[^/]+)\/(resolve\/main\/mlc-chat-config\.json|tree\/main)/.exec(url);
  const lib = m && MODEL_LIBS.find(l => l.base === m[1].slice('mlc-ai/'.length));
  if (m && lib && m[2].startsWith('resolve') && !refuseModels) {
    const [type, quant, hidden, inter, layers, heads, kv, headDim, vocab] = lib.key.split('|');
    const n = v => (v === '' ? undefined : Number(v));
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ model_type: type, quantization: quant, context_window_size: 4096, model_config: { hidden_size: n(hidden), intermediate_size: n(inter), num_hidden_layers: n(layers), num_attention_heads: n(heads), num_key_value_heads: n(kv), head_dim: n(headDim), vocab_size: n(vocab) } }) });
  }
  if (m && lib) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ type: 'file', path: 'params_shard_0.bin', size: 1, lfs: { size: 300 * 1024 * 1024 } }, { type: 'file', path: 'mlc-chat-config.json', size: 900 }]) });
  return route.fulfill({ status: 404, contentType: 'text/plain', body: 'stand-in: not here' });
});

// The model's WebGPU program is published on GitHub: refused here too, so nothing leaves this computer.
await page.route(/^https:\/\/raw\.githubusercontent\.com\//, route => route.fulfill({ status: 404, contentType: 'text/plain', body: 'stand-in: not here' }));

const openApp = async label => {
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill(label);
  await page.locator(`.start-menu [data-label="${label}"]`).first().click();
};
async function closeAll() {
  for (let i = 0; i < 40; i++) {
    const dialog = page.locator('.dialog');
    if (await dialog.count()) {
      await dialog.getByRole('button').last().click();
      continue;
    }
    const wins = page.locator('.win');
    if (!(await wins.count())) return;
    await wins.last().locator('.win-close').first().click();
    await page.waitForTimeout(80);
  }
  throw new Error('windows would not close');
}
const chatWin = () => page.locator('.win', { has: page.locator('.chat-app') });
async function openAgents() {
  await openApp('chat');
  const w = chatWin();
  await w.getByRole('tab', { name: 'Agents' }).click();
  await w.locator('.agent-pick[aria-label="Agent"] option').first().waitFor({ state: 'attached', timeout: 10000 });
  return w;
}
const settingsWin = () => page.locator('.win', { has: page.locator('.set-ai') });

console.log('Chat and AI upgrades, against ' + BASE);
await page.goto(BASE);

await step('set up the owner', async () => {
  await page.locator('.gate h1', { hasText: 'Set up this desktop' }).waitFor({ timeout: 20000 });
  await page.getByLabel('Your name').fill('Sample Owner');
  await page.locator('.gate input.gate-input').last().fill(PASS);
  await page.locator('.gate-encrypt').uncheck();
  await page.locator('.gate-go').click();
  await page.locator('.gate h1', { hasText: 'Your recovery key' }).waitFor({ timeout: 30000 });
  await page.locator('.gate .check-row input').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#desktop .item').first().waitFor({ timeout: 20000 });
});

await step('YouTube Player is gone: not in the Start menu', async () => {
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill('youtube');
  await page.waitForTimeout(300);
  eq(await page.locator('.start-menu [data-label="youtube player"]').count(), 0, 'no YouTube Player');
  await page.keyboard.press('Escape');
});

await step('a Claude key through Chat › Agents > AI keys... (Settings › AI)', async () => {
  const w = await openAgents();
  await w.getByRole('button', { name: 'AI keys...' }).click();
  const s = settingsWin();
  await s.getByRole('button', { name: 'Claude settings...' }).click();
  await s.getByLabel('Anthropic API key').fill(AI_KEY);
  // Claude's section comes before OpenRouter's, which has a limit box of the same name.
  await s.getByLabel('Monthly limit in US dollars').first().fill('1');
  await s.getByRole('button', { name: 'Save', exact: true }).click();
  await s.locator('.ai-cloud > .ai-device').filter({ hasText: 'ending wxyz' }).waitFor({ timeout: 15000 });
  await closeAll();
});

await step('Chat › Agents: the line under the answer says how long it took; Copy copies it', async () => {
  const w = await openAgents();
  await w.getByLabel('Agent', { exact: true }).selectOption('claude');
  await w.locator('.agent-note', { hasText: 'Connected: Claude' }).waitFor();
  await w.getByLabel('Message to the agent').fill('Tell me about the ISS');
  await w.getByLabel('Message to the agent').press('Enter');
  const answer = w.locator('.agent-pane .chat-msg.agent').last();
  await answer.locator('.chat-text', { hasText: 'Stand-in Claude heard: Tell me about the ISS' }).waitFor({ timeout: 20000 });
  const foot = await answer.locator('.agent-foot').innerText();
  ok(/^Answered in \d+ s$/.test(foot), 'foot: ' + foot);
  await answer.getByRole('button', { name: 'Copy' }).click();
  eq(await page.evaluate(() => navigator.clipboard.readText()), await answer.locator('.chat-text').innerText(), 'the answer is on the clipboard');
  await shot('aichat-answer');
});

await step('Regenerate asks the same question again and replaces the answer', async () => {
  const w = chatWin();
  const before = anthropic.requests.length;
  await w.locator('.agent-pane .chat-msg.agent').last().getByRole('button', { name: 'Regenerate' }).click();
  for (let i = 0; i < 200 && anthropic.requests.length === before; i++) await page.waitForTimeout(100);
  await w.getByRole('button', { name: 'Stop' }).waitFor({ state: 'hidden', timeout: 20000 });
  await w.locator('.agent-pane .chat-msg.agent .chat-text', { hasText: 'Stand-in Claude heard' }).waitFor({ timeout: 20000 });
  ok(anthropic.requests.length === before + 1, `asked once more (${anthropic.requests.length - before})`);
  eq(anthropic.requests.at(-1).body.messages, [{ role: 'user', content: 'Tell me about the ISS' }], 'the same question, without the old answer');
  eq(await w.locator('.agent-pane .chat-msg').count(), 2, 'still one question and one answer');
});

await step('Edit puts the last question back in the box and takes it (and its answer) out of the thread', async () => {
  const w = chatWin();
  await w.locator('.agent-pane .chat-msg.mine').last().getByRole('button', { name: 'Edit' }).click();
  eq(await w.getByLabel('Message to the agent').inputValue(), 'Tell me about the ISS', 'back in the box');
  eq(await w.locator('.agent-pane .chat-msg').count(), 0, 'the question and answer left the thread');
  await w.getByLabel('Message to the agent').fill('Tell me about the Moon');
  await w.getByLabel('Message to the agent').press('Enter');
  await w.locator('.agent-pane .chat-msg.agent .chat-text', { hasText: 'Stand-in Claude heard: Tell me about the Moon' }).waitFor({ timeout: 20000 });
  eq(anthropic.requests.at(-1).body.messages, [{ role: 'user', content: 'Tell me about the Moon' }], 'only the edited question was sent');
  // The kept file follows: reopened, the thread holds the edited question only.
  await closeAll();
  const again = await openAgents();
  await again.locator('.agent-pane .chat-msg.mine .chat-text', { hasText: 'Tell me about the Moon' }).waitFor({ timeout: 10000 });
  eq(await again.locator('.agent-pane .chat-msg.mine .chat-text', { hasText: 'ISS' }).count(), 0, 'the old question is not in the kept thread');
  await closeAll();
});

await step('a favourite (☆ beside the list) comes first, marked ★, and is chosen when Chat opens', async () => {
  await closeAll();
  let w = await openAgents();
  await w.locator('.agent-pick[aria-label="Recent threads"] option').first().waitFor({ state: 'attached' });
  await page.waitForTimeout(800); // the tab reads the agents and threads when shown
  const pick = w.getByLabel('Agent', { exact: true });
  const value = 'device:Qwen3.5-4B-q4f32_1-MLC';
  await pick.selectOption(value);
  const star = w.getByRole('button', { name: 'Favourite' });
  eq(await star.getAttribute('aria-pressed'), 'false', 'not a favourite yet');
  await star.click();
  await w.locator('.agent-pick[aria-label="Agent"] option:first-child', { hasText: '★ Qwen 3.5 4B' }).waitFor({ state: 'attached', timeout: 10000 });
  eq(await star.getAttribute('aria-pressed'), 'true', 'starred');
  await closeAll();
  w = await openAgents();
  eq(await w.getByLabel('Agent', { exact: true }).inputValue(), value, 'the favourite is chosen when Chat opens');
  await closeAll();
});

await step('Settings › AI > Your model list: untick "Show in Chat" and the model leaves the chat list; Disconnect when idle is kept', async () => {
  await closeAll();
  let w = await openAgents();
  await w.getByRole('button', { name: 'AI keys...' }).click();
  const s = settingsWin();
  const row = s.locator('.ai-mylist-row', { hasText: 'Qwen 3.5 0.8B' });
  await row.waitFor({ timeout: 10000 });
  ok((await s.locator('.ai-mylist-row').first().innerText()).includes('Qwen 3.5 4B'), 'the favourite is first here too');
  eq(await s.locator('.ai-mylist-row').first().locator('.ai-star').getAttribute('aria-pressed'), 'true', 'with its star');
  await row.getByLabel(/Show Qwen 3.5 0.8B/).uncheck();
  await s.locator('.ai-mylist-row.off', { hasText: 'Qwen 3.5 0.8B' }).waitFor();
  await s.getByLabel(/Disconnect when idle/).check();
  await page.waitForTimeout(500);
  await closeAll();
  w = await openAgents();
  eq(await w.locator('.agent-pick[aria-label="Agent"] option', { hasText: 'Qwen 3.5 0.8B' }).count(), 0, 'hidden from the chat list');
  ok(await w.getByLabel('Disconnect when idle').isChecked(), 'the tick in the chat follows the setting');
  await w.getByLabel('Disconnect when idle').uncheck();
  await page.waitForTimeout(500);
  await closeAll();
  // Brought back, from Settings.
  w = await openAgents();
  await w.getByRole('button', { name: 'AI keys...' }).click();
  const s2 = settingsWin();
  ok(!(await s2.getByLabel(/Disconnect when idle/).isChecked()), 'unticked in the chat, unticked here');
  await s2.locator('.ai-mylist-row', { hasText: 'Qwen 3.5 0.8B' }).getByLabel(/Show Qwen 3.5 0.8B/).check();
  await s2.locator('.ai-mylist-row:not(.off)', { hasText: 'Qwen 3.5 0.8B' }).waitFor();
  await shot('aichat-settings-list');
  await closeAll();
});

await step('Find AI models: Good places to start, by kind of computer; built-in ones marked; Add puts one in the chat list', async () => {
  await closeAll();
  await openApp('find ai models');
  const w = page.locator('.win', { has: page.locator('.aim') });
  await w.locator('.aim-group-head', { hasText: 'Older or basic computers' }).waitFor({ timeout: 10000 });
  eq(await w.locator('.aim-group').count(), 3, 'three kinds of computer');
  for (const name of ['Qwen 3.5 0.8B', 'Gemma 2 2B', 'Qwen 3.5 4B']) {
    const b = w.locator('.aim-start .aim-row', { hasText: `${name} by` }).getByRole('button', { name: 'Built in' });
    ok(await b.isDisabled(), `${name}: built in, nothing to add`);
  }
  const smol = w.locator('.aim-start .aim-row', { hasText: 'SmolLM2 360M by Hugging Face' });
  ok(/about \d\.\d GB of graphics memory/.test(await smol.innerText()), 'with the graphics memory it needs');
  await smol.getByRole('button', { name: 'Add' }).click();
  await smol.getByRole('button', { name: 'Added' }).waitFor({ timeout: 10000 });
  await w.locator('.aim-mine .aim-row', { hasText: 'SmolLM2' }).waitFor();
  await shot('aichat-find-models');
  await closeAll();
  const c = await openAgents();
  await c.locator('.agent-pick[aria-label="Agent"] option', { hasText: 'SmolLM2' }).waitFor({ state: 'attached', timeout: 10000 });
  await closeAll();
});

await step('a model that cannot start: a short line with "What happened?", and a small box with the reason and the ways out', async () => {
  await closeAll();
  refuseModels = true;
  const w = await openAgents();
  const smol = await w.locator('.agent-pick[aria-label="Agent"] option', { hasText: 'SmolLM2' }).getAttribute('value');
  await w.getByLabel('Agent', { exact: true }).selectOption(smol);
  await w.getByRole('button', { name: 'Connect' }).click();
  const note = w.locator('.agent-note');
  // With no graphics chip for AI in this Chrome, there is nothing to start: it says so instead.
  await note.filter({ hasText: /could not start|no WebGPU/ }).waitFor({ timeout: 60000 });
  if ((await note.innerText()).includes('no WebGPU')) {
    console.log('       (this Chrome has no graphics chip for AI: the start-failure box was not reached)');
    return;
  }
  ok((await note.innerText()).startsWith('SmolLM2'), 'short: ' + (await note.innerText()));
  await note.getByRole('button', { name: /What happened\?/ }).click();
  const box = page.locator('.dialog');
  await box.locator('.dialog-title', { hasText: 'The AI could not start' }).waitFor();
  ok((await box.innerText()).includes('did not download'), 'the reason: ' + (await box.innerText()).slice(0, 300));
  ok(!(await box.locator('.dialog-detail').isVisible()), 'the long words wait under Details');
  await box.locator('summary', { hasText: 'Details' }).click();
  ok((await box.locator('.dialog-detail').innerText()).includes('Hugging Face'), 'and are there when asked for');
  ok((await box.innerText()).includes('Close other tabs and programs'), 'the ways out');
  for (const b of ['Start again', 'Choose another model', 'Close']) ok(await box.getByRole('button', { name: b }).count(), b);
  eq(await box.getByRole('button', { name: 'Try a shorter version' }).count(), 0, 'no question was lost, so no shorter version');
  await shot('aichat-what-happened');
  await box.getByRole('button', { name: 'Choose another model' }).click();
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Agent', null, { timeout: 5000 });
  await closeAll();
});

await step('no errors in the page', async () => eq(problems.filter(p => !/404|Failed to load resource|did not download|Failed to fetch/i.test(p)), [], 'problems'));

console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? ': ' + failures.join('; ') : ''}`);
await browser.close();
anthropic.close?.();
process.exit(failures.length ? 1 : 0);
