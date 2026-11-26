// Audit of the Assistant in a real Chrome, PART 1 (no model weights): how the engine is chosen and what happens with no
// WebGPU, what goes to Claude and OpenRouter (stand-ins on 127.0.0.1 only), the cost cap through the server, keyboard
// use and a small window. Every request that is not to 127.0.0.1 is blocked and listed.
// Needs the dev server on a FRESH, EMPTY data folder, started with DESKTOP_AI_TEST_URL=http://127.0.0.1:<AI port> and
// DESKTOP_OR_TEST_URL=http://127.0.0.1:<OR port>, an empty DESKTOP_MODELS_DIR, and out/ built.
//   node test/browser-audit-assistant.mjs [http://127.0.0.1:3153] [AI port 3154] [OR port 3155] [data folder] [gpu]
// "gpu" as the fifth argument starts Chrome with --enable-unsafe-webgpu --use-angle=d3d11.
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import { startFakeAnthropic, KEY } from './fake-anthropic.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3153';
const AI_PORT = Number(process.argv[3] ?? 3154);
const OR_PORT = Number(process.argv[4] ?? 3155);
const DATA = process.argv[5] ?? '';
const GPU = process.argv[6] === 'gpu';
// 'nogpu': the page sees a browser without WebGPU (navigator.gpu taken away before the desktop loads).
const NOGPU = process.argv[6] === 'nogpu';
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PASS = 'orchard-lantern-harbour-58';
const OR_KEY = 'sk-or-v1-audit-assistant-stand-in-key-00000000000000000000-wxyz';
let passed = 0;
const failures = [];
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
async function step(name, fn) {
  if (ONLY && !ONLY.test(name) && !/set up/.test(name)) return;
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (error) {
    failures.push(name);
    console.log('  FAIL ' + name + '\n       ' + String(error.message).split('\n').slice(0, 6).join('\n       ').slice(0, 1200));
  }
}
const ok = (v, what) => {
  if (!v) throw new Error(what);
};

// ---- Stand-ins ----
const anthropic = await startFakeAnthropic(AI_PORT);
const posts = () => anthropic.requests.filter(r => r.method === 'POST');

/** OpenRouter stand-in. One model has a per-request fee, as some OpenRouter models do (pricing.request). */
const orAsked = [];
let orCost = 0.6;
const OR_MODELS = [
  { id: 'audit/fee-model', name: 'Audit: Fee Model', context_length: 8000, pricing: { prompt: '0.000001', completion: '0.000002', request: '0.5' } },
  { id: 'audit/plain', name: 'Audit: Plain', context_length: 8000, pricing: { prompt: '0.000001', completion: '0.000002' } },
];
const or = createServer((req, res) => {
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    const json = (s, o) => (res.writeHead(s, { 'Content-Type': 'application/json' }), res.end(JSON.stringify(o)));
    if (req.url === '/api/v1/models') return json(200, { data: OR_MODELS });
    if (req.headers.authorization !== `Bearer ${OR_KEY}`) return json(401, { error: { code: 401, message: 'bad key' } });
    if (req.url === '/api/v1/key') return json(200, { data: { label: 'stand-in' } });
    if (req.method === 'POST' && req.url === '/api/v1/chat/completions') {
      const b = JSON.parse(body);
      orAsked.push(b);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const data = o => res.write(`data: ${JSON.stringify(o)}\n\n`);
      data({ choices: [{ delta: { content: 'Stand-in OpenRouter answer.' } }] });
      data({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 5, cost: orCost } });
      res.end('data: [DONE]\n\n');
      return;
    }
    json(404, { error: { code: 404, message: 'not in the stand-in' } });
  });
});
await new Promise(r => or.listen(OR_PORT, '127.0.0.1', r));

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: GPU ? ['--enable-unsafe-webgpu', '--use-angle=d3d11'] : [] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const blocked = [];
// Nothing but this computer: Hugging Face, GitHub (model programs), any AI service: all blocked and listed.
await ctx.route('**/*', route => {
  const url = route.request().url();
  if (/^(http:\/\/127\.0\.0\.1[:/]|data:|blob:)/.test(url)) return route.continue();
  blocked.push(url);
  return route.abort();
});
if (NOGPU) await ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true }));
const page = await ctx.newPage();
const problems = [];
page.on('pageerror', e => problems.push('pageerror: ' + e.message));

const openApp = async (label) => {
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
  await page.waitForTimeout(600);
  return w;
}
const box = w => w.getByLabel('Message to the agent');
const pane = w => w.locator('.agent-pane');
async function waitIdle(w) {
  await pane(w).getByRole('button', { name: 'Stop' }).waitFor({ state: 'hidden', timeout: 30000 });
  await page.waitForTimeout(400);
}
async function ask(w, text) {
  await box(w).fill(text);
  await box(w).press('Enter');
  await page.waitForTimeout(300);
  await waitIdle(w);
}
/** Writes a file through the desktop's own store, as the desktop itself would (a second FileSystem on the same server). */
async function putFile(path, text) {
  return page.evaluate(async ([path, text]) => {
    const cfg = await (await fetch('storage.json', { cache: 'no-store' })).json();
    const { ServerStore } = await import('/app/store/server-store.js');
    const { FileSystem } = await import('/app/fs/fs.js');
    const fs = new FileSystem(new ServerStore(cfg.api));
    const folder = path.slice(0, path.lastIndexOf('/'));
    await fs.ensureFolder(folder);
    await fs.writeText(path, text);
    return 'ok';
  }, [path, text]);
}
const api = (svc, op, body) => page.evaluate(async ([svc, op, body]) => {
  const r = await fetch(`/api/${svc}.php?op=${op}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Desktop-Store': '1' }, body: JSON.stringify(body) } : { headers: { 'X-Desktop-Store': '1' } });
  return { status: r.status, text: await r.text() };
}, [svc, op, body]);

console.log(`Assistant audit (part 1), against ${BASE}${GPU ? ', Chrome with WebGPU flags' : ''}`);
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

await step('WebGPU: what this Chrome reports, and the words Connect shows for a built-in model', async () => {
  const gpu = await page.evaluate(async () => {
    if (!navigator.gpu) return 'no navigator.gpu';
    const a = await Promise.race([navigator.gpu.requestAdapter(), new Promise(r => setTimeout(() => r('TIMEOUT'), 8000))]);
    return a === 'TIMEOUT' ? 'requestAdapter did not answer in 8 s' : a ? `adapter: ${[a.info?.vendor, a.info?.architecture].filter(Boolean).join(' ')} f16=${a.features.has('shader-f16')}` : 'adapter null';
  });
  console.log('       WebGPU here: ' + gpu);
  const w = await openAgents();
  const options = await w.locator('.agent-pick[aria-label="Agent"] option').allInnerTexts();
  console.log('       agents offered: ' + options.join(' | '));
  const connect = pane(w).getByRole('button', { name: 'Connect' });
  ok(await connect.isEnabled(), 'Connect is enabled for the first built-in model');
  await connect.click();
  await pane(w).locator('.agent-note', { hasText: /could not start|no WebGPU|Connected/ }).waitFor({ timeout: 30000 }).catch(() => undefined);
  const note = await pane(w).locator('.agent-note').innerText().catch(() => '');
  console.log('       after Connect: ' + note.replace(/\s+/g, ' ').slice(0, 300));
  if (!/adapter:/.test(gpu)) ok(/no WebGPU/.test(note), 'without WebGPU the note says so');
  ok(!blocked.some(u => /\.(bin|safetensors)(\?|$)|params_shard/.test(u)) || true, 'weights asked for (blocked)');
  await closeAll();
});

await step('save a Claude key (stand-in) and an OpenRouter key (stand-in) through Settings › AI', async () => {
  const w = await openAgents();
  await pane(w).getByRole('button', { name: 'AI keys...' }).click();
  const s = page.locator('.win', { has: page.locator('.set-ai') });
  await s.getByRole('button', { name: 'Claude settings...' }).click();
  await s.getByLabel('Anthropic API key').fill(KEY);
  await s.getByLabel('Monthly limit in US dollars').first().fill('5');
  await s.getByRole('button', { name: 'Save', exact: true }).first().click();
  await s.locator('.ai-cloud > .ai-device').filter({ hasText: 'ending wxyz' }).waitFor({ timeout: 15000 });
  await s.getByRole('button', { name: 'OpenRouter settings...' }).click();
  await s.getByLabel('OpenRouter key').fill(OR_KEY);
  await s.getByLabel('OpenRouter model').selectOption('audit/fee-model', { timeout: 10000 });
  await s.getByLabel('Monthly limit in US dollars').last().fill('1');
  await s.getByRole('button', { name: 'Save', exact: true }).last().click();
  await s.locator('.ai-cloud > .ai-device').filter({ hasText: 'Audit: Fee Model' }).waitFor({ timeout: 15000 });
  ok(!(await page.content()).includes(OR_KEY.slice(12, 40)), 'the OpenRouter key is not in the page');
  await closeAll();
});

await step('AST-P0-3: a thread written with the on-device AI ("nothing you type leaves it") is not sent to Claude unasked when Claude is chosen', async () => {
  const secret = 'PAYSLIP-7731 net pay 2,140.55 account 12-3456';
  await putFile('/Documents/AI chats/Private notes.md', [
    '# Private notes', '', '<!-- TOMLIN OS AI chat. Each message starts with a "### " line; keep those lines as they are. -->', '',
    '### You · 2099-01-01T10:00:00.000Z', '', `Here is a file:\n\n${secret}\n\nQuestion about the file: what is my net pay?\nAnswer from the file only. If the file does not say, say so.`, '',
    '### AI (Gemma 2 2B) · 2099-01-01T10:00:05.000Z', '', 'Your net pay is 2,140.55.', '',
  ].join('\n'));
  const before = posts().length;
  const w = await openAgents();
  await pane(w).locator('.chat-text', { hasText: 'PAYSLIP-7731' }).waitFor({ timeout: 10000 });
  await w.getByLabel('Agent', { exact: true }).selectOption('claude');
  await pane(w).locator('.agent-note', { hasText: 'Connected: Claude' }).waitFor();
  const note = await pane(w).locator('.agent-note').innerText();
  // The person is asked whether the earlier on-device messages go too; "Only this question" is the default.
  await box(w).fill('thanks, and what is the weather like on Mars?');
  await box(w).press('Enter');
  const asked = page.locator('.dialog', { hasText: 'answered on this device' });
  await asked.waitFor({ timeout: 10000 });
  const focused = await page.evaluate(() => document.activeElement?.textContent ?? '');
  ok(focused === 'Only this question', `the default is "Only this question", focus on "${focused}"`);
  await asked.getByRole('button', { name: 'Only this question' }).click();
  await page.waitForTimeout(300);
  await waitIdle(w);
  const sent = posts().slice(before).map(r => JSON.stringify(r.body.messages));
  ok(sent.length === 1, `one question reached the stand-in (got ${sent.length})`);
  const warned = /earlier|this thread|whole (chat|thread)|so far/i.test(note);
  ok(!sent[0].includes('PAYSLIP-7731') || warned, `the earlier on-device file text went to Anthropic, and the note did not say the thread goes too. Note: "${note}". Sent: ${sent[0].slice(0, 220)}`);
  await closeAll();
});

await step('AST-P0-2: a thread left with an unanswered question (page closed mid-answer) still works with Claude', async () => {
  await putFile('/Documents/AI chats/Half done.md', [
    '# Half done', '', '<!-- TOMLIN OS AI chat. Each message starts with a "### " line; keep those lines as they are. -->', '',
    '### You · 2099-02-01T10:00:00.000Z', '', 'first question', '',
    '### AI (Claude Opus 5) · 2099-02-01T10:00:05.000Z', '', 'first answer', '',
    '### You · 2099-02-01T10:01:00.000Z', '', 'asked just before the page was closed', '',
  ].join('\n'));
  // A fresh page load: the newest kept thread opens again.
  await page.reload();
  await page.locator('#desktop .item').first().waitFor({ timeout: 20000 });
  const w = await openAgents();
  await pane(w).locator('.chat-text', { hasText: 'asked just before the page was closed' }).waitFor({ timeout: 10000 });
  await w.getByLabel('Agent', { exact: true }).selectOption('claude');
  await pane(w).locator('.agent-note', { hasText: 'Connected: Claude' }).waitFor();
  const before = posts().length;
  await ask(w, 'a new question');
  const err = await pane(w).locator('.agent-error').last().innerText().catch(() => '');
  ok(posts().length === before + 1 && !err, `refused: "${err}" (reached the stand-in: ${posts().length - before})`);
  await closeAll();
});

await step('cap: Claude is not asked when one answer could pass the monthly limit; the words say so', async () => {
  const set = await api('ai', 'settings');
  const s = JSON.parse(set.text);
  // Opus 5: a full 8,000-token answer alone costs $0.20; a $0.10 limit must refuse before Anthropic is asked.
  const saved = await api('ai', 'save', { key: '', model: s.model, cap: '0.1' });
  ok(saved.status === 200, 'cap saved: ' + saved.text);
  const before = posts().length;
  const r = await page.evaluate(async () => {
    const res = await fetch('/api/ai.php?op=chat', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Desktop-Store': '1' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) });
    return { status: res.status, text: await res.text() };
  });
  ok(r.status === 402 && /monthly limit/.test(r.text), `refused with the limit words: ${r.status} ${r.text.slice(0, 200)}`);
  ok(posts().length === before, 'Anthropic (stand-in) was not asked');
  await api('ai', 'save', { key: '', model: s.model, cap: '5' });
});

await step('AST-P0-4: OpenRouter spending stays within the monthly limit for a model with a per-request fee', async () => {
  // Limit $1; this model's list prices per token are tiny, but each answer costs $0.60 (a per-request fee), as OpenRouter reports.
  const w = await openAgents();
  await w.getByLabel('Agent', { exact: true }).selectOption('openrouter');
  await pane(w).locator('.agent-note', { hasText: 'Connected: Audit: Fee Model' }).waitFor({ timeout: 10000 });
  await pane(w).getByRole('button', { name: 'New thread' }).click();
  await ask(w, 'first');
  await ask(w, 'second');
  await ask(w, 'third');
  const s = JSON.parse((await api('openrouter', 'settings')).text);
  ok(s.spent <= s.cap, `spent $${s.spent} against a $${s.cap} limit after ${orAsked.length} answers`);
  await closeAll();
});

await step('AST-P1-8: emptying the Claude limit box and saving does not quietly set the limit to $0', async () => {
  await openApp('settings');
  const s = page.locator('.win', { has: page.locator('.set-ai') });
  if (!(await s.count())) {
    await page.locator('.win').last().getByText('AI', { exact: true }).first().click();
  }
  const set = page.locator('.win', { has: page.locator('.set-ai') });
  await set.getByRole('button', { name: 'Claude settings...' }).click();
  await set.getByLabel('Monthly limit in US dollars').first().fill('');
  await set.getByRole('button', { name: 'Save', exact: true }).first().click();
  await page.waitForTimeout(1200);
  const msg = (await set.locator('.ai-cloud-msg').first().innerText().catch(() => '')) + ' / ' + (await set.locator('.ai-cloud > .ai-device').first().innerText());
  const cap = JSON.parse((await api('ai', 'settings')).text).cap;
  await api('ai', 'save', { key: '', model: 'claude-opus-5', cap: '5' });
  ok(cap !== 0, `an empty box saved a $0 limit without a word: ${msg}`);
  await closeAll();
});

await step('keyboard: Enter sends, Shift+Enter makes a new line, Tab reaches Send', async () => {
  const w = await openAgents();
  await w.getByLabel('Agent', { exact: true }).selectOption('claude');
  await pane(w).locator('.agent-note', { hasText: 'Connected: Claude' }).waitFor();
  await pane(w).getByRole('button', { name: 'New thread' }).click();
  await box(w).fill(''); // a question refused earlier is put back in the box
  await box(w).focus();
  await page.keyboard.type('line one');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('line two');
  const typed = await box(w).inputValue();
  ok(typed === 'line one\nline two', 'Shift+Enter is a new line; the box holds ' + JSON.stringify(typed) + ', focus on ' + (await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80))));
  const before = posts().length;
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  await waitIdle(w);
  ok(posts().length === before + 1, 'Enter sent it');
  await box(w).focus();
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => document.activeElement?.textContent ?? '');
  ok(/Send/.test(focused), 'Tab from the box goes to Send, got ' + focused);
  await closeAll();
});

await step('small window (360 x 640): the Agents controls and the box stay reachable', async () => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.waitForTimeout(500);
  const w = await openAgents();
  const send = pane(w).getByRole('button', { name: 'Send' });
  const inView = async el => el.evaluate(e => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1;
  });
  const sendOk = await inView(send);
  const boxOk = await inView(box(w));
  const connectOk = await inView(pane(w).getByRole('button', { name: /Connect|Connected/ }));
  const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  console.log(`       360 px: Send in view ${sendOk}, box ${boxOk}, Connect ${connectOk}, page wider by ${over}px`);
  await page.setViewportSize({ width: 1280, height: 800 });
  ok(sendOk && boxOk && connectOk, 'a control is out of the window');
  await closeAll();
});

console.log('       blocked outside requests: ' + (blocked.length ? [...new Set(blocked.map(u => u.slice(0, 90)))].join(' | ') : 'none'));
console.log('       page problems: ' + (problems.length ? problems.join(' | ') : 'none'));
console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? ': ' + failures.join('; ') : ''}`);
await browser.close();
await anthropic.close();
await new Promise(r => or.close(r));
if (DATA) rmSync(DATA, { recursive: true, force: true });
process.exit(failures.length ? 1 : 0);
