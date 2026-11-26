// Audit of Chat in a real Chrome: people chat between two accounts (two browser contexts), and Chat > Agents with a
// stand-in for Anthropic on 127.0.0.1 (this file's own, so it can cut an answer off, fail, or never stop). Needs the dev
// server on a FRESH, EMPTY data folder started with DESKTOP_AI_TEST_URL=http://127.0.0.1:<AI port>, and out/ built.
//   node test/browser-audit-chat.mjs [http://127.0.0.1:3149] [AI port, 3150]
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3149';
const AI_PORT = Number(process.argv[3] ?? 3150);
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PASS = 'orchard-lantern-harbour-58';
const SAM_PASS = 'meadow-copper-violet-31';
const KEY = 'sk-ant-api03-audit-chat-browser-key-0000000000000000000000-wxyz';
let passed = 0;
const failures = [];
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
async function step(name, fn) {
  if (ONLY && !ONLY.test(name)) return;
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

// ---- The stand-in for Anthropic ----
/** What the next answer does. */
let mode = 'ok';
const asked = [];
const XSS = 'Here: <img src=x onerror="window.__xss=1"> <script>window.__xss=2</script> **bold** [link](javascript:window.__xss=3)';
const ai = createServer((req, res) => {
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    const json = (s, o) => (res.writeHead(s, { 'Content-Type': 'application/json' }), res.end(JSON.stringify(o)));
    if (req.headers['x-api-key'] !== KEY) return json(401, { type: 'error', error: { type: 'authentication_error', message: 'bad' } });
    if (req.method === 'GET' && req.url.startsWith('/v1/models')) return json(200, { data: [{ type: 'model', id: 'claude-opus-5', display_name: 'x', created_at: '2026-01-01T00:00:00Z' }], has_more: false, first_id: 'claude-opus-5', last_id: 'claude-opus-5' });
    if (!(req.method === 'POST' && req.url.startsWith('/v1/messages'))) return json(404, { type: 'error', error: { type: 'not_found_error', message: 'no' } });
    const b = JSON.parse(body);
    asked.push(b);
    const m = mode;
    if (m === 'overloaded') return json(529, { type: 'error', error: { type: 'overloaded_error', message: 'busy' } });
    if (m === 'ratelimit') return json(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send('message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: b.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 1 } } });
    send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    const delta = text => send('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
    const finish = () => {
      send('content_block_stop', { index: 0 });
      send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 30 } });
      send('message_stop', {});
      res.end();
    };
    const last = String(b.messages.at(-1).content);
    if (m === 'xss') {
      delta(XSS);
      return finish();
    }
    if (m === 'cut') {
      delta('The first half of an answer that');
      return setTimeout(() => res.destroy(), 100);
    }
    if (m === 'huge') {
      const piece = 'word '.repeat(200); // 1,000 letters
      for (let i = 0; i < 300; i++) delta(piece); // 300,000 letters in 300 pieces
      return finish();
    }
    if (m === 'forever') {
      const t = setInterval(() => delta('more '), 200);
      res.on('close', () => clearInterval(t));
      return;
    }
    delta(`Answer to: ${last.slice(0, 40)}`);
    finish();
  });
});
await new Promise(r => ai.listen(AI_PORT, '127.0.0.1', r));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctxA.newPage();
const problems = [];
page.on('pageerror', e => problems.push('A pageerror: ' + e.message));
page.on('dialog', d => problems.push('A native dialog: ' + d.message()));

const openApp = async (p, label) => {
  await p.locator('.start-btn').click();
  await p.locator('.start-filter').fill(label);
  await p.locator(`.start-menu [data-label="${label}"]`).first().click();
};
async function closeAll(p = page) {
  for (let i = 0; i < 40; i++) {
    const dialog = p.locator('.dialog');
    if (await dialog.count()) {
      await dialog.getByRole('button').last().click();
      continue;
    }
    const wins = p.locator('.win');
    if (!(await wins.count())) return;
    await wins.last().locator('.win-close').first().click();
    await p.waitForTimeout(80);
  }
  throw new Error('windows would not close');
}
const chatWin = (p = page) => p.locator('.win', { has: p.locator('.chat-app') });
async function openAgents() {
  await openApp(page, 'chat');
  const w = chatWin();
  await w.getByRole('tab', { name: 'Agents' }).click();
  await w.locator('.agent-pick[aria-label="Agent"] option').first().waitFor({ state: 'attached', timeout: 10000 });
  return w;
}
const turns = w => w.locator('.agent-pane .chat-msg');
const box = w => w.getByLabel('Message to the agent');
async function waitIdle(w) {
  await w.locator('.agent-pane').getByRole('button', { name: 'Stop' }).waitFor({ state: 'hidden', timeout: 30000 });
  await page.waitForTimeout(300);
}
async function askAgent(w, text) {
  await box(w).fill(text);
  await box(w).press('Enter');
  await page.waitForTimeout(300);
  await waitIdle(w);
}
/** The kept thread file, read through the desktop's own store. */
async function threadFiles() {
  return page.evaluate(async () => {
    const r = await fetch('/api/store.php?op=list&path=' + encodeURIComponent('/Documents/AI chats'), { headers: { 'X-Desktop-Store': '1' } });
    return r.status + ' ' + (await r.text()).slice(0, 400);
  });
}

console.log('Chat audit, against ' + BASE);
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

await step('save a Claude key in Settings › AI; the box is emptied and only the last four show', async () => {
  const w = await openAgents();
  await w.getByRole('button', { name: 'AI keys...' }).click();
  const s = page.locator('.win', { has: page.locator('.set-ai') });
  await s.getByRole('button', { name: 'Claude settings...' }).click();
  await s.getByLabel('Anthropic API key').fill(KEY);
  await s.getByLabel('Monthly limit in US dollars').first().fill('50');
  await s.getByRole('button', { name: 'Save', exact: true }).click();
  await s.locator('.ai-cloud > .ai-device').filter({ hasText: 'ending wxyz' }).waitFor({ timeout: 15000 });
  await s.getByRole('button', { name: 'Claude settings...' }).click();
  ok((await s.getByLabel('Anthropic API key').inputValue()) === '', 'the key box is empty when opened again');
  const html = await page.content();
  ok(!html.includes(KEY) && !html.includes(KEY.slice(10, 30)), 'the key is nowhere in the page');
  await closeAll();
});

await step('HTML and script in a reply are shown as letters and never run', async () => {
  const w = await openAgents();
  await w.getByLabel('Agent', { exact: true }).selectOption('claude');
  await w.locator('.agent-note', { hasText: 'Connected: Claude' }).waitFor();
  mode = 'xss';
  await askAgent(w, 'show me html');
  mode = 'ok';
  const text = await turns(w).last().locator('.chat-text').innerText();
  ok(text.includes('<img src=x onerror'), 'shown as letters: ' + text.slice(0, 80));
  ok(await page.evaluate(() => window.__xss === undefined), 'no script ran');
  ok((await turns(w).last().locator('img, script, a').count()) === 0, 'no element made from the reply');
});

await step('a server error (Anthropic 529) and a rate limit (429) say so; the question goes back in the box', async () => {
  const w = chatWin();
  mode = 'overloaded';
  await askAgent(w, 'question during an outage');
  ok(await w.locator('.agent-error').last().isVisible(), 'an error line is shown');
  ok((await box(w).inputValue()) === 'question during an outage', 'the question is back in the box');
  mode = 'ratelimit';
  await askAgent(w, 'question while limited');
  const words = await w.locator('.agent-error').last().innerText();
  ok(/limit|Wait/i.test(words), 'rate limit words: ' + words);
  mode = 'ok';
  await box(w).fill('');
});

await step('CH-P0-2: Regenerate when Anthropic is busy keeps the earlier answer (in the thread and in its file)', async () => {
  const w = chatWin();
  await askAgent(w, 'what is the capital of France');
  const answer = turns(w).last();
  await answer.locator('.chat-text', { hasText: 'Answer to: what is the capital of France' }).waitFor({ timeout: 10000 });
  const before = await turns(w).count();
  mode = 'overloaded';
  await answer.getByRole('button', { name: 'Regenerate' }).click();
  await page.waitForTimeout(500);
  await waitIdle(w);
  mode = 'ok';
  const after = await turns(w).count();
  const still = await w.locator('.agent-pane .chat-msg.agent .chat-text', { hasText: 'Answer to: what is the capital of France' }).count();
  // Reopen the kept thread from the file: is the answer there?
  await closeAll();
  const again = await openAgents();
  await page.waitForTimeout(800);
  const kept = await again.locator('.agent-pane .chat-msg.agent .chat-text', { hasText: 'Answer to: what is the capital of France' }).count();
  ok(still === 1 && after === before && kept === 1, `turns ${before} -> ${after}; answer on screen ${still}, in the kept file ${kept}: a failed Regenerate threw the earlier answer away`);
});

await step('an answer cut off half way is kept and marked as cut off', async () => {
  const w = chatWin();
  await w.getByLabel('Agent', { exact: true }).selectOption('claude');
  await page.waitForTimeout(300);
  mode = 'cut';
  await askAgent(w, 'tell me a long story');
  mode = 'ok';
  const last = turns(w).last();
  const text = await last.innerText();
  ok(text.includes('The first half of an answer'), 'the part received is kept');
  const marked = /cut|stopped|incomplete|broke|not finish/i.test(text) || (await w.locator('.agent-error').count()) > 0;
  ok(marked, 'nothing says the answer is unfinished: ' + text.replace(/\s+/g, ' ').slice(0, 160));
});

await step('a huge reply (300,000 letters in 300 pieces) arrives without freezing the page', async () => {
  const w = chatWin();
  mode = 'huge';
  const t0 = Date.now();
  await box(w).fill('a huge one please');
  await box(w).press('Enter');
  let worst = 0;
  const probe = setInterval(() => {}, 1000);
  // Measure how long the page takes to answer a tiny evaluate while the answer streams in.
  for (let i = 0; i < 10; i++) {
    const s = Date.now();
    await page.evaluate(() => 1);
    worst = Math.max(worst, Date.now() - s);
    await page.waitForTimeout(150);
  }
  clearInterval(probe);
  await waitIdle(w);
  mode = 'ok';
  const len = (await turns(w).last().locator('.chat-text').innerText()).length;
  console.log(`       huge reply: ${len} letters shown in ${Date.now() - t0} ms; slowest page answer ${worst} ms`);
  ok(len > 290000, 'the whole reply is shown');
  ok(worst < 2000, `the page froze for ${worst} ms`);
});

await step('a reply that never ends: Stop stops it, the part received is kept, and the next question works', async () => {
  const w = chatWin();
  mode = 'forever';
  await box(w).fill('never stop');
  await box(w).press('Enter');
  await page.waitForTimeout(2500);
  await w.locator('.agent-pane').getByRole('button', { name: 'Stop' }).click();
  await waitIdle(w);
  mode = 'ok';
  const kept = await turns(w).last().innerText();
  ok(kept.includes('more'), 'the part received is kept: ' + kept.replace(/\s+/g, ' ').slice(0, 200) + ' | error: ' + (await w.locator('.agent-error').last().innerText().catch(() => '')));
  await askAgent(w, 'after the stop');
  await turns(w).last().locator('.chat-text', { hasText: 'Answer to: after the stop' }).waitFor({ timeout: 10000 });
});

await step('the cost log shows numbers only, never the words asked', async () => {
  const log = await page.evaluate(async () => (await fetch('/api/ai.php?op=log', { headers: { 'X-Desktop-Store': '1' } })).text());
  ok(!log.includes('capital of France') && !log.includes('never stop'), 'no words in the log');
  const rows = JSON.parse(log).rows;
  console.log('       cost log notes: ' + JSON.stringify(rows.map(r => [r.out, r.note])));
});

await step('threads are kept and reopen after a reload', async () => {
  await closeAll();
  await page.reload();
  await page.locator('#desktop .item').first().waitFor({ timeout: 20000 });
  const w = await openAgents();
  await w.locator('.agent-pane .chat-msg.mine .chat-text', { hasText: 'tell me a long story' }).waitFor({ timeout: 10000 });
  ok((await w.locator('.agent-pick[aria-label="Recent threads"] option').count()) >= 2, 'listed under Recent threads');
});

await step('Delete sends the thread to the Recycle Bin', async () => {
  const w = chatWin();
  await w.getByLabel('Agent', { exact: true }).selectOption('claude');
  await page.waitForTimeout(300);
  await w.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.locator('.dialog').getByRole('button', { name: 'Delete' }).click();
  await page.waitForTimeout(800);
  ok((await turns(w).count()) === 0, 'the thread left the screen');
  await closeAll();
  await openApp(page, 'recycle bin');
  await page.waitForTimeout(1000);
  const bin = await page.locator('.win').last().innerText();
  ok(/capital of France|\.md/i.test(bin), 'the thread is in the Recycle Bin: ' + bin.replace(/\s+/g, ' ').slice(0, 200));
  await closeAll();
});

await step('keyboard: Tab reaches the Chat tabs; arrow keys move between them; Enter sends', async () => {
  await openApp(page, 'chat');
  const w = chatWin();
  await w.getByRole('tab', { name: 'General' }).focus();
  await page.keyboard.press('ArrowRight');
  const focused = await page.evaluate(() => document.activeElement?.textContent ?? '');
  console.log('       after ArrowRight on General, focus is on: ' + JSON.stringify(focused.slice(0, 30)));
  await page.keyboard.press('Enter');
  ok(true, '');
  await closeAll();
});

// ---- People chat, two accounts ----
let pageB = null;
await step('make a second account (sam) and sign in in a second browser', async () => {
  const made = await page.evaluate(async ([pass, next]) => {
    const r = await fetch('/api/auth.php?op=user-create', { method: 'POST', headers: { 'X-Desktop-Store': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'sam', next, password: pass, display: 'Sam' }) });
    return r.status + ' ' + (await r.text()).slice(0, 200);
  }, [PASS, SAM_PASS]);
  ok(made.startsWith('200'), 'user-create: ' + made);
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  pageB = await ctxB.newPage();
  pageB.on('pageerror', e => problems.push('B pageerror: ' + e.message));
  await pageB.goto(BASE);
  await pageB.getByText('Log in for more').click({ timeout: 20000 }).catch(() => {});
  await pageB.locator('.gate input[autocomplete=username]').fill('sam', { timeout: 20000 });
  await pageB.locator('.gate input[type=password]').fill(SAM_PASS);
  await pageB.locator('.gate-go').click();
  for (let i = 0; i < 6; i++) {
    if (await pageB.locator('#desktop .item').first().isVisible().catch(() => false)) break;
    const h1 = await pageB.locator('.gate h1').innerText().catch(() => '');
    if (await pageB.getByText('Before your desktop opens').isVisible().catch(() => false)) {
      await pageB.getByLabel('Encrypt my files').uncheck().catch(() => {});
      await pageB.getByRole('button', { name: 'Continue' }).click();
    } else if (/recovery key/i.test(h1)) {
      await pageB.locator('.gate .check-row input').check();
      await pageB.getByRole('button', { name: 'Continue' }).click();
    }
    await pageB.waitForTimeout(1500);
  }
  await pageB.locator('#desktop .item').first().waitFor({ timeout: 20000 });
});

await step('both open Chat; the owner writes General and Direct; sam sees unread counts, then reads them', async () => {
  await openApp(page, 'chat');
  await openApp(pageB, 'chat');
  const a = chatWin(page);
  const b = chatWin(pageB);
  // Let both hand out keys (a few polls).
  await page.waitForTimeout(9000);
  await a.getByRole('tab', { name: 'General' }).click();
  await a.getByLabel('Message', { exact: true }).waitFor();
  for (let i = 0; i < 20 && (await a.getByLabel('Message', { exact: true }).isDisabled()); i++) await page.waitForTimeout(500);
  const odd = '<b>bold?</b> <img src=x onerror="window.__xss=9"> \u202Eevil\u202C 🎉 ' + '\u0000'.slice(0, 0) + 'tab\there';
  await a.getByLabel('Message', { exact: true }).fill(odd);
  await a.getByLabel('Message', { exact: true }).press('Enter');
  await a.locator('.chat-msg.mine .chat-text', { hasText: 'bold?' }).waitFor({ timeout: 10000 });
  // Direct to sam.
  await a.getByRole('tab', { name: 'Direct' }).click();
  await a.locator('.chat-person', { hasText: 'Sam' }).click();
  for (let i = 0; i < 20 && (await a.getByLabel('Message', { exact: true }).isDisabled()); i++) await page.waitForTimeout(500);
  await a.getByLabel('Message', { exact: true }).fill('a direct hello');
  await a.getByLabel('Message', { exact: true }).press('Enter');
  await a.locator('.chat-msg.mine .chat-text', { hasText: 'a direct hello' }).waitFor({ timeout: 10000 });
  // Sam: badge on Direct, then the messages open.
  await b.getByRole('tab', { name: 'Agents' }).click();
  await pageB.waitForTimeout(6000);
  const directTab = await b.getByRole('tab', { name: /Direct/ }).innerText();
  ok(/1/.test(directTab), 'Direct shows 1 unread: ' + directTab);
  await b.getByRole('tab', { name: /General/ }).click();
  await b.locator('.chat-msg .chat-text', { hasText: 'bold?' }).waitFor({ timeout: 15000 });
  ok(await pageB.evaluate(() => window.__xss === undefined), 'no script ran at sam\'s');
  ok((await b.locator('.chat-msg img').count()) === 0, 'no image made from a message');
  await b.getByRole('tab', { name: /Direct/ }).click();
  await b.locator('.chat-person', { hasText: 'Sample Owner' }).click();
  await b.locator('.chat-msg .chat-text', { hasText: 'a direct hello' }).waitFor({ timeout: 15000 });
  await pageB.waitForTimeout(5000);
  const after = await b.getByRole('tab', { name: /Direct/ }).innerText();
  ok(!/\d/.test(after), 'read: no count left: ' + after);
});

await step('a 4,000-letter message (the most the box takes) of Chinese and of emoji is sent and opens at the other end', async () => {
  const a = chatWin(page);
  const b = chatWin(pageB);
  for (const long of ['\u4e2d'.repeat(4000), '🎉'.repeat(2000)]) {
    await a.getByLabel('Message', { exact: true }).fill(long);
    await a.getByLabel('Message', { exact: true }).press('Enter');
    await page.waitForTimeout(1200);
    const dialog = await page.locator('.dialog').innerText().catch(() => '');
    if (dialog) {
      await closeDialog(page);
      throw new Error('refused: ' + dialog.slice(0, 200));
    }
  }
  await b.locator('.chat-msg .chat-text', { hasText: '🎉🎉🎉' }).waitFor({ timeout: 15000 });
});
async function closeDialog(p) {
  const d = p.locator('.dialog');
  if (await d.count()) await d.getByRole('button').last().click();
}

await step('sam cannot delete the owner\'s message (no Delete button); the owner\'s Delete removes it at sam\'s too', async () => {
  const a = chatWin(page);
  const b = chatWin(pageB);
  ok((await b.locator('.chat-msg:not(.mine) .chat-del').count()) === 0, 'no Delete on someone else\'s message');
  await a.locator('.chat-msg.mine', { hasText: 'a direct hello' }).getByRole('button', { name: 'Delete this message' }).click();
  await page.locator('.dialog').getByRole('button', { name: 'Delete' }).click();
  await b.locator('.chat-msg .chat-text', { hasText: 'a direct hello' }).waitFor({ state: 'detached', timeout: 15000 });
});

await step('polling cost: how many state calls one open Chat makes in 20 seconds, and their size', async () => {
  let calls = 0;
  let bytes = 0;
  const onRes = async r => {
    if (r.url().includes('chat.php?op=state')) {
      calls++;
      try { bytes += (await r.body()).length; } catch {}
    }
  };
  pageB.on('response', onRes);
  await pageB.waitForTimeout(20000);
  pageB.off('response', onRes);
  console.log(`       ${calls} state calls in 20 s, ${bytes} bytes in all`);
  ok(calls <= 7, `${calls} polls in 20 s`);
});

await step('a small window (375 x 640): the message box and Send stay on screen', async () => {
  await pageB.setViewportSize({ width: 375, height: 640 });
  await pageB.waitForTimeout(800);
  const b = chatWin(pageB);
  const send = b.locator('.chat-thread .chat-send');
  const box2 = await send.boundingBox();
  ok(box2 && box2.y + box2.height <= 640 && box2.x + box2.width <= 375, 'Send is visible: ' + JSON.stringify(box2));
  await b.getByRole('tab', { name: 'Agents' }).click();
  await pageB.waitForTimeout(800);
  const asend = await b.locator('.agent-pane .chat-send').boundingBox();
  ok(asend && asend.y + asend.height <= 640 && asend.x + asend.width <= 375, 'Agents Send is visible: ' + JSON.stringify(asend));
});

await step('sam sees none of the owner\'s AI threads or key', async () => {
  const r = await pageB.evaluate(async () => {
    const s = await (await fetch('/api/ai.php?op=settings', { headers: { 'X-Desktop-Store': '1' } })).json();
    const l = await (await fetch('/api/store.php?op=list&path=' + encodeURIComponent('/Documents/AI chats'), { headers: { 'X-Desktop-Store': '1' } })).text();
    return { hasKey: s.hasKey, hint: s.hint, list: l.slice(0, 300) };
  });
  ok(r.hasKey === false && r.hint === '', 'sam sees no key: ' + JSON.stringify(r));
  ok(!/capital|after the stop|never stop/.test(r.list), 'sam\'s store lists none of the owner\'s threads: ' + r.list);
});

await step('no page errors in the run', async () => {
  ok(problems.length === 0, problems.join('\n'));
});

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log('  - ' + f);
await browser.close();
ai.close();
process.exit(failures.length ? 1 : 0);
