// Audit of AI Models (November 2026) in a real Chrome: Settings › AI saving models to the server in pieces (pause,
// carry on, two at once, remove), the server's list after a hand-edited models folder, and Find AI models (search
// against a stand-in for Hugging Face, keyboard use, offline, a small window). No inference is run.
// A step named "P0" FAILS while its fault is there; a step named "P1" is reported but does not fail the run.
// Needs the dev server on a FRESH, EMPTY data folder and models folder, started with
//   DESKTOP_MODELS_TEST_URL=http://127.0.0.1:<hf port> DESKTOP_MODELS_TEST_PINS=<pins> DESKTOP_MODELS_DIR=<models dir>
// where <pins> was written by writeStandInPins (test/fake-huggingface.mjs). No outside site is reached: the stand-in
// for Hugging Face is test/fake-huggingface.mjs on 127.0.0.1, and the page's own requests to huggingface.co are
// answered here by page routes (never sent).
//   node test/browser-audit-aimodels.mjs <base> <models dir> [hf port] [screenshot folder]
import { chromium } from 'playwright-core';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startFakeHuggingFace, SHARD_BYTES } from './fake-huggingface.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3147';
const MODELS = process.argv[3];
const HF_PORT = Number(process.argv[4] ?? 3291);
const SHOTS = process.argv[5] ?? null;
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PASS = 'orchard-lantern-harbour-58';
const ORIGIN = new URL(BASE).origin;
const Q08 = 'Qwen3.5-0.8B-q4f32_1-MLC';
const GEMMA = 'gemma-2-2b-it-q4f32_1-MLC';
const Q4 = 'Qwen3.5-4B-q4f32_1-MLC';
if (!MODELS || !existsSync(MODELS)) throw new Error('give the server\'s models folder as the second argument');

let passed = 0;
const failures = [];
const p1s = [];
async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (error) {
    if (name.startsWith('P1')) p1s.push(name);
    else failures.push(name);
    await shot('fail-' + (failures.length + p1s.length)).catch(() => {});
    console.log((name.startsWith('P1') ? '  P1   ' : '  FAIL ') + name + '\n       ' + String(error.message).slice(0, 900));
  }
  for (let i = 0; i < 4 && (await page.locator('.dialog').count()); i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
  }
}
const ok = (v, what) => {
  if (!v) throw new Error(what);
};

// ---- A stand-in for Hugging Face's search, answered inside the browser (nothing is sent anywhere) ----
const RUNNABLE = 'mlc-ai/Llama-3.2-1B-Instruct-q4f32_1-MLC';
const NOPROG = 'someone/Strange-7B-q4f32_1-MLC';
const hfSearch = [
  { id: RUNNABLE, downloads: 900, likes: 9, lastModified: '2026-01-01' },
  { id: NOPROG, downloads: 50, likes: 1, lastModified: '2026-01-02' },
  { id: `mlc-ai/${Q08}`, downloads: 800, likes: 8, lastModified: '2026-01-03' },
];
const llamaConfig = { model_type: 'llama', quantization: 'q4f32_1', context_window_size: 4096, model_config: { hidden_size: 2048, intermediate_size: 8192, num_hidden_layers: 16, num_attention_heads: 32, num_key_value_heads: 8, head_dim: 64, vocab_size: 128256 } };
let offline = false;
const hfAsked = [];
function answerHF(url) {
  const u = new URL(url);
  if (u.pathname === '/api/models') return hfSearch;
  const tree = /^\/api\/models\/(.+)\/tree\/main$/.exec(u.pathname);
  if (tree) return [{ type: 'file', path: 'mlc-chat-config.json', size: 500 }, { type: 'file', path: 'params_shard_0.bin', size: 100, lfs: { size: 300 * 1024 * 1024 } }];
  const cfg = /^\/(.+)\/resolve\/main\/mlc-chat-config\.json$/.exec(u.pathname);
  if (cfg) return cfg[1] === RUNNABLE ? llamaConfig : { model_type: 'strange', quantization: 'q4f32_1', model_config: {} };
  return null;
}

const hf = await startFakeHuggingFace(HF_PORT);
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const outside = [];
await context.route('**/*', route => {
  const url = route.request().url();
  if (url.startsWith(ORIGIN) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
  if (url.startsWith('https://huggingface.co/')) {
    hfAsked.push(url);
    if (offline) return route.abort('internetdisconnected');
    const body = answerHF(url);
    return body ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }) : route.fulfill({ status: 404, body: '' });
  }
  outside.push(url);
  return route.abort();
});
await context.addInitScript(() => {
  window.open = () => null;
});
const page = await context.newPage();
page.setDefaultTimeout(10000);
const problems = [];
page.on('pageerror', e => problems.push('pageerror: ' + e.message));
const shot = async name => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });
const settle = ms => page.waitForTimeout(ms);
const openApp = async label => {
  await page.locator('.start-btn').click();
  await page.locator('.start-filter').fill(label);
  await page.locator(`.start-menu [data-label="${label}"]`).first().click();
};
async function closeAll() {
  for (let i = 0; i < 30; i++) {
    if (await page.locator('.dialog').count()) {
      await page.keyboard.press('Escape');
      await settle(100);
      continue;
    }
    const wins = page.locator('.win');
    if (!(await wins.count())) return;
    await wins.last().locator('.win-close').first().click();
    await settle(100);
  }
}
const api = (op, body) => page.evaluate(async ([op, body]) => {
  const r = await fetch('/api/models.php?op=' + op, body ? { method: 'POST', headers: { 'X-Desktop-Store': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { headers: { 'X-Desktop-Store': '1' } });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [op, body]);
const list = async () => (await api('list')).body;
const settingsWin = () => page.locator('.win', { has: page.locator('.set-ai') });
// Find AI models is not in the Start menu (it is only of use for the chat): it opens from Settings › AI.
const openFindModels = async () => {
  await openApp('settings');
  await settingsWin().getByRole('button', { name: 'Find AI models...' }).click();
};
const aimWin = () => page.locator('.win', { has: page.locator('.aim') });
const sha = b => createHash('sha256').update(b).digest('hex');
/** Every file under a folder, with sizes (for leftovers). */
const walk = d => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(join(d, e.name)) : [`${join(d, e.name).slice(MODELS.length + 1).replaceAll('\\', '/')} ${statSync(join(d, e.name)).size}`])) : []);

console.log('AI Models audit, against ' + BASE + ' (stand-in Hugging Face on 127.0.0.1:' + HF_PORT + ')');
await page.goto(BASE);

await step('set up the owner', async () => {
  await page.locator('.gate h1').first().waitFor({ timeout: 30000 });
  await page.getByLabel('Your name').fill('Sample Owner');
  const user = page.getByLabel('User name (for signing in)');
  if (await user.count()) await user.fill('tester');
  await page.locator('.gate input[type=password]').last().fill(PASS);
  const encrypt = page.locator('.gate-encrypt');
  if (await encrypt.count()) await encrypt.uncheck();
  await page.locator('.gate-go').click();
  await page.locator('.gate h1', { hasText: 'Your recovery key' }).waitFor({ timeout: 30000 });
  await page.locator('.gate .check-row input').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#desktop .item').first().waitFor({ timeout: 20000 });
  const l = await list();
  ok(l.owner && l.models.length === 3 && l.models.every(m => !m.saved && !m.saving), 'needs empty folders: ' + JSON.stringify(l).slice(0, 300));
});

await step('Settings › AI: Save, Stop saving after the first piece (paused, nothing lost), Carry on saving finishes it; no part files left', async () => {
  await openApp('settings');
  const ai = settingsWin().locator('.set-ai');
  const pick = ai.getByLabel('Built-in model');
  await pick.locator('option').first().waitFor({ state: 'attached', timeout: 15000 });
  await pick.selectOption(Q08);
  await ai.getByRole('button', { name: 'Save to this TOMLIN OS' }).click();
  await page.locator('.dialog').getByLabel('Your password').fill(PASS);
  await page.locator('.dialog').getByRole('button', { name: 'Save', exact: true }).click();
  const said = ai.locator('p.hint[role=status]').first();
  await said.filter({ hasText: /^Saving / }).waitFor({ timeout: 30000 });
  await ai.getByRole('button', { name: 'Stop saving' }).click();
  await said.filter({ hasText: /^Saving paused/ }).waitFor({ timeout: 30000 });
  const mid = (await list()).models.find(m => m.id === Q08);
  ok(!mid.saved && mid.saving && mid.saving.have > 0 && mid.saving.have < mid.saving.total, 'paused part-way: ' + JSON.stringify(mid.saving));
  await ai.getByRole('button', { name: 'Carry on saving' }).click();
  ok(!(await page.locator('.dialog').count()), 'carrying on does not ask for the password again');
  await said.filter({ hasText: /is saved on this TOMLIN OS/ }).waitFor({ timeout: 60000 });
  const pieces = hf.requests.filter(r => r.startsWith('/cdn/params_shard_0.bin'));
  ok(pieces.length === 2, 'two pieces for the 20 MB file, none fetched twice: ' + pieces.join(', '));
  const files = walk(MODELS);
  ok(!files.some(f => f.includes('.part')), 'no part files: ' + files.join('; '));
  ok(files.includes(`${Q08}/resolve/main/params_shard_0.bin ${SHARD_BYTES}`), files.join('; '));
});

await step('the saved file is served only whole and by range to the signed-in page; a path outside the folder is refused', async () => {
  const r = await page.evaluate(async id => {
    const whole = await fetch(`/models/${id}/resolve/main/params_shard_0.bin`, { headers: { Range: 'bytes=0-9' } });
    const out = { range: whole.status, len: (await whole.arrayBuffer()).byteLength };
    for (const p of ['/models/../data/users.json', `/models/${id}/resolve/main/params_shard_0.bin.part`, '/models/models.lock', '/models/%2e%2e/x.json']) out[p] = (await fetch(p)).status;
    return out;
  }, Q08);
  ok(r.range === 206 && r.len === 10, JSON.stringify(r));
  ok(Object.entries(r).filter(([k]) => k.startsWith('/')).every(([, s]) => s === 404 || s === 400 || s === 403), JSON.stringify(r));
});

await step('two downloads at once: two models proceed side by side, each file the stand-in bytes in order', async () => {
  // Qwen 3.5 4B and Gemma started at the same moment (the PHP dev server answers one request at a time, so this shows
  // two saves interleaving piece by piece, not two requests truly at once).
  const r = await Promise.all([api('piece', { id: Q4, password: PASS }), api('piece', { id: GEMMA, password: PASS })]);
  ok(r.every(x => x.status === 200 && x.body.saved === false && x.body.have > 0), JSON.stringify(r));
  const g = (await list()).models.find(m => m.id === GEMMA);
  ok(!g.saved && g.saving && g.saving.have > 0, 'Gemma part-way: ' + JSON.stringify(g.saving));
  for (const id of [Q4, GEMMA]) {
    const held = readFileSync(join(MODELS, id, 'resolve', 'main', 'params_shard_0.bin.part'));
    ok(held.length === 16 * 1024 * 1024 && held.equals(Buffer.alloc(held.length, 3)), id + ' bytes: ' + held.length);
  }
});

await step('a part file damaged on disk mid-save (a piece killed half way and written over) is thrown away at the end, never kept', async () => {
  // Qwen 3.5 4B is part-way (one piece). Damage a byte inside what is held, as a cut-off or bad write would.
  const part = join(MODELS, Q4, 'resolve', 'main', 'params_shard_0.bin.part');
  ok(existsSync(part), 'a part file: ' + walk(MODELS).join('; '));
  const b = readFileSync(part);
  b[1000] ^= 0xff;
  writeFileSync(part, b);
  let last;
  for (let i = 0; i < 8; i++) {
    last = await api('piece', { id: Q4 });
    if (last.status !== 200 || last.body.saved) break;
  }
  ok(hf.requests.filter(r => r.startsWith('/cdn/params_shard_0.bin bytes=0-')).length >= 4, 'the damaged copy was fetched again from the start: ' + hf.requests.join(', '));
  // The damaged copy is thrown away and fetched again (once), and then the model completes with the right bytes.
  ok(last.status === 200 && last.body.saved, 'a fresh copy completed it: ' + JSON.stringify(last));
  ok(readFileSync(join(MODELS, Q4, 'resolve', 'main', 'params_shard_0.bin')).equals(Buffer.alloc(SHARD_BYTES, 3)), 'the right bytes');
});

await step('P1 removing a save that is part-way blocks saving it afresh for a day, though the error for a bad piece says to remove it and save it afresh', async () => {
  // Gemma is part-way: remove it to start afresh, as the error text advises, then try to save it again.
  ok((await list()).models.find(m => m.id === GEMMA).saving, 'Gemma part-way');
  const rm = await api('remove', { id: GEMMA, password: PASS });
  ok(rm.status === 200, JSON.stringify(rm));
  const again = await api('piece', { id: GEMMA, password: PASS });
  ok(again.status === 200, 'a fresh save after removing is refused: ' + again.status + ' ' + JSON.stringify(again.body).slice(0, 200));
});

await step('removing frees the space: the model folder and its program are gone, no part files left', async () => {
  const rm = await api('remove', { id: Q4, password: PASS });
  ok(rm.status === 200, JSON.stringify(rm));
  const left = walk(MODELS).filter(f => f.startsWith(Q4) || f.includes('Qwen3.5-4B'));
  ok(!left.length, 'left behind: ' + left.join('; '));
  ok(!(await list()).models.find(m => m.id === Q4).saved);
});

await step('P1 a saved model whose file was deleted by hand is still listed as saved (browsers then fail on a 404)', async () => {
  const shard = join(MODELS, Q08, 'resolve', 'main', 'params_shard_0.bin');
  const keep = readFileSync(shard);
  writeFileSync(shard + '.aside', keep);
  const { unlinkSync, renameSync } = await import('node:fs');
  unlinkSync(shard);
  try {
    const m = (await list()).models.find(x => x.id === Q08);
    ok(!m.saved, 'listed as saved with a file missing: ' + JSON.stringify({ saved: m.saved, saving: m.saving }));
  } finally {
    renameSync(shard + '.aside', shard);
  }
});

await step('P1 a program changed by hand is never vouched for: with no libSha256 kept, the list does not work one out from the file on disk', async () => {
  const idx = join(MODELS, 'models.json');
  const lib = join(MODELS, 'libs', 'Qwen3.5-0.8B-q4f32_1_cs1k-webgpu.wasm');
  const index = readFileSync(idx, 'utf8');
  const prog = readFileSync(lib);
  const pin = JSON.parse(index).models.find(m => m.id === Q08).libSha256;
  try {
    // As a model saved before the checksum was kept in the index (the path the list still supports).
    writeFileSync(idx, JSON.stringify({ models: JSON.parse(index).models.map(m => (m.id === Q08 ? { ...m, libSha256: undefined } : m)) }));
    writeFileSync(lib, Buffer.from('\0asm a different program'));
    const m = (await list()).models.find(x => x.id === Q08);
    ok(m.libSha256 === pin, `the list now vouches for the file on disk (${m.libSha256.slice(0, 12)}...) instead of the pin (${pin.slice(0, 12)}...)`);
  } finally {
    writeFileSync(idx, index);
    writeFileSync(lib, prog);
  }
});

await closeAll();

// ---- Find AI models ----
await step('Find AI models: a search lists a runnable model with Add, one with no program with the reason, a built-in one as Built in', async () => {
  await openFindModels();
  const w = aimWin();
  await w.locator('.aim-query').waitFor();
  await w.locator('.aim-query').fill('llama');
  await w.getByLabel('Model size').selectOption('any');
  await w.locator('.aim-row', { hasText: 'Llama 3.2 1B' }).waitFor({ timeout: 15000 });
  await w.locator('.aim-results .aim-row', { hasText: 'Strange' }).waitFor({ timeout: 15000 });
  const strange = await w.locator('.aim-results .aim-row', { hasText: 'Strange' }).innerText();
  ok(/no program/.test(strange), strange);
  ok(await w.locator('.aim-results .aim-row', { hasText: 'Strange' }).getByRole('button', { name: 'Add' }).isDisabled(), 'no Add for it');
  ok(await w.locator('.aim-results .aim-row', { hasText: 'Qwen3.5 0.8B' }).getByRole('button', { name: 'Built in' }).isDisabled(), 'built in');
  ok(hfAsked.every(u => u.startsWith('https://huggingface.co/')) && !outside.length, 'outside: ' + outside.join(', '));
});

await step('Find AI models by keyboard: Tab reaches Add, Enter adds it (My models shows it), then Remove by keyboard takes it off', async () => {
  const w = aimWin();
  const row = w.locator('.aim-results .aim-row', { hasText: 'Llama 3.2 1B' });
  const add = row.getByRole('button', { name: 'Add' });
  await row.getByRole('link', { name: 'Model card' }).focus();
  await page.keyboard.press('Tab');
  ok(await add.evaluate(b => document.activeElement === b), 'Tab from Model card reaches Add');
  await page.keyboard.press('Enter');
  await w.locator('.aim-mine .aim-row', { hasText: 'Llama 3.2 1B' }).waitFor();
  const remove = w.locator('.aim-mine .aim-row', { hasText: 'Llama 3.2 1B' }).getByRole('button', { name: 'Remove' });
  await remove.focus();
  await page.keyboard.press('Enter');
  await w.locator('.aim-mine .hint', { hasText: 'None yet' }).waitFor();
  // After a re-render the focus should not be lost to the page body.
  const focus = await page.evaluate(() => document.activeElement?.tagName + '.' + document.activeElement?.className);
  console.log('       (focus after Remove: ' + focus + ')');
});

await step('P1 Find AI models offline: the results say the details could not be read, not that the engine has no program', async () => {
  const w = aimWin();
  offline = true;
  try {
    await w.locator('.aim-query').fill('qwen');
    await w.getByRole('button', { name: 'Search', exact: true }).click();
    const status = w.locator('.statusbar');
    await status.filter({ hasNotText: 'Searching' }).waitFor({ timeout: 10000 });
    const said = await status.innerText();
    console.log('       (offline search says: ' + said + ')');
    ok(!/^Failed to fetch$/.test(said), 'a bare browser error: ' + said);
    // Now online for the list, offline for the details: every row reads as "no program".
    offline = false;
    await page.route('https://huggingface.co/mlc-ai/**', r => r.abort('internetdisconnected'));
    await page.route('https://huggingface.co/someone/**', r => r.abort('internetdisconnected'));
    await page.route('https://huggingface.co/api/models/*/*/tree/main', r => r.abort('internetdisconnected'));
    await w.locator('.aim-query').fill('llama');
    await w.getByRole('button', { name: 'Search', exact: true }).click();
    const llama = w.locator('.aim-results .aim-row', { hasText: 'Llama 3.2 1B' });
    await llama.waitFor({ timeout: 15000 }).catch(() => {});
    const text = (await llama.count()) ? await llama.innerText() : '(not listed: ' + (await status.innerText()) + ')';
    ok(!/no program for this kind of model/.test(text) && (await llama.count()), 'offline, a runnable model reads: ' + text);
  } finally {
    offline = false;
    await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
  }
});

await step('small window: Find AI models at its smallest size (380 x 360) has no sideways scrolling and its Search button stays reachable', async () => {
  await closeAll();
  await page.setViewportSize({ width: 400, height: 640 });
  await settle(300);
  await openFindModels();
  const w = aimWin();
  await w.locator('.aim-query').waitFor();
  const r = await w.evaluate(win => {
    const app = win.querySelector('.aim');
    const go = win.querySelector('.aim-bar button[type=submit]').getBoundingClientRect();
    const box = win.getBoundingClientRect();
    return { sw: app.scrollWidth, cw: app.clientWidth, goRight: go.right, winRight: box.right, winW: box.width };
  });
  await shot('aim-small');
  ok(r.sw <= r.cw + 1, 'sideways overflow: ' + JSON.stringify(r));
  ok(r.goRight <= r.winRight + 1, 'Search is cut off: ' + JSON.stringify(r));
});

await step('small window: Settings › AI saving controls fit a phone-width screen', async () => {
  await closeAll();
  await openApp('settings');
  const ai = settingsWin().locator('.set-ai');
  await ai.getByLabel('Built-in model').locator('option').first().waitFor({ state: 'attached', timeout: 15000 });
  await ai.getByLabel('Built-in model').selectOption(GEMMA);
  const r = await ai.evaluate(el => ({ sw: el.scrollWidth, cw: el.clientWidth }));
  await shot('ai-small');
  ok(r.sw <= r.cw + 1, 'sideways overflow: ' + JSON.stringify(r));
  await page.setViewportSize({ width: 1280, height: 900 });
});

await step('no page errors and no outside requests', async () => {
  ok(!problems.length, problems.join('\n'));
  ok(!outside.length, outside.join('\n'));
});

await browser.close();
await hf.close();
console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? ':\n  ' + failures.join('\n  ') : ''}; P1 findings: ${p1s.length}${p1s.length ? '\n  ' + p1s.join('\n  ') : ''}`);
process.exit(failures.length ? 1 : 0);
