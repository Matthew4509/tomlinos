// Measures on-device AI models in Chrome on THIS computer: the small models on offer, with measured speed and answer
// quality. Each model is loaded from the TOMLIN OS server (models/, put
// there by tools/fetch-model.mjs), then given the same three jobs: summarise, rewrite, ask about a file. Writes the
// timings and every answer to a Markdown report so the answers can be read and judged.
//   (server on 3050 serving out/ and models/)  node tools/bench-models.mjs http://127.0.0.1:3050 report.md [model ids...]
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [base = 'http://127.0.0.1:3050', out = 'bench.md', ...only] = process.argv.slice(2);
const index = JSON.parse(readFileSync(join(root, 'models', 'models.json'), 'utf8')).models.filter(m => !only.length || only.includes(m.id));

const JOBS = [
  {
    name: 'Rewrite',
    prompt: 'Rewrite this message so it is polite, clear and complete. Keep it short.\n\n"hey cant do tues anymore. mower still sounds off after last time. need someone wed or thurs arvo. how much. thx"',
  },
  {
    name: 'Ask about this file',
    prompt: 'Here is a file:\n\nINVOICE 1042\nNorthwind Garden Supplies, 12 Harbour Road\nBill to: Oakridge Primary School\nGarden mulch (2 cubic metres)      $180.00\nTap repair (leaking garden tap)     $65.00\nTravel                              $25.00\nSubtotal                           $270.00\nGST 10%                             $27.00\nTotal due                          $297.00\nPayment due by 15 October 2026. Bank transfer to BSB 012-345, account 9876 5432.\n\nQuestion: What is the total due, and by what date?',
  },
  {
    name: 'Summarise',
    prompt: 'Summarise this email in three short bullet points:\n\nHi Sam, thanks for pruning the apple tree last spring. The kids have been playing outside a lot and a few roses by the fence are starting to look sick again, especially the red and pink ones near the gate. We are also wondering whether the leaking garden tap can be fixed at the same visit. We are free next Tuesday or Thursday after 3pm, but not Wednesday because of swimming. Could you let us know the price for a pruning plus the tap repair, and whether you need us to move the trampoline away from the fence first? Best wishes, Kim Lawson',
  },
];

// A fresh browser for each model: a failure can leave the graphics device unusable for the rest of that browser.
const launch = () => chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: process.env.HEADLESS === '1' });
let browser = await launch();
let page = await browser.newPage();
await page.goto(`${base}/version.json`);
const gpu = await page.evaluate(async () => {
  const a = await navigator.gpu?.requestAdapter();
  return a ? `${a.info?.vendor ?? '?'} ${a.info?.architecture ?? ''} (shader-f16: ${a.features.has('shader-f16')})` : 'no WebGPU';
});
const chromeVersion = browser.version();
await browser.close();
const lines = [`# On-device AI models measured on this computer`, '', `Date: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC. Chrome ${chromeVersion}, WebGPU adapter: ${gpu}. Models loaded from the TOMLIN OS server (${base}/models/). Temperature 0, up to 220 new tokens per answer.`, ''];
const table = ['| Model | Files | Load (from TOMLIN OS) | First question (warm-up) | Prompt read | Writing speed | Notes |', '|---|---|---|---|---|---|---|'];
const answers = [];

for (const m of index) {
  console.log(`${m.id}...`);
  browser = await launch();
  page = await browser.newPage();
  page.on('console', msg => msg.type() === 'error' && console.log('  console:', msg.text().slice(0, 200)));
  await page.goto(`${base}/version.json`);
  const result = await page.evaluate(async ({ m, jobs, origin }) => {
    const webllm = await import(`${origin}/vendor/webllm.js`);
    // Older graphics chips (no half-precision) are reset by Windows when one step runs too long: reading the prompt
    // 32 tokens at a time keeps each step short (measured on an older integrated GPU: 128 and the default crashed it).
    const adapter = await navigator.gpu.requestAdapter();
    const overrides = { ...m.overrides, ...(adapter.features.has('shader-f16') ? {} : { prefill_chunk_size: 16 }) };
    const record = { model: `${origin}/models/${m.id}/`, model_id: m.id, model_lib: `${origin}/models/libs/${m.lib}`, overrides };
    const appConfig = { model_list: [record], useIndexedDBCache: false };
    const t0 = performance.now();
    const engine = await webllm.CreateMLCEngine(m.id, { appConfig }, overrides);
    const firstLoad = performance.now() - t0;
    // The first question also prepares the graphics programs, so it is timed apart from the three jobs.
    const t1 = performance.now();
    await engine.chat.completions.create({ messages: [{ role: 'user', content: 'Reply with the word OK.' }], temperature: 0, max_tokens: 5 });
    const again = performance.now() - t1;
    const out = [];
    for (const job of jobs) {
      const t = performance.now();
      try {
        const r = await engine.chat.completions.create({ messages: [{ role: 'user', content: job.prompt }], temperature: 0, max_tokens: 220 });
        out.push({ job: job.name, text: r.choices[0].message.content, ms: performance.now() - t, usage: r.usage });
      } catch (err) {
        // The graphics chip was lost (usually reset by Windows): the rest cannot run in this browser.
        out.push({ job: job.name, text: `FAILED after ${((performance.now() - t) / 1000).toFixed(0)} s: ${String(err).slice(0, 160)}`, ms: performance.now() - t, usage: null, failed: true });
        break;
      }
    }
    await engine.unload().catch(() => {});
    await webllm.deleteModelAllInfoInCache(m.id, appConfig).catch(() => {});
    return { firstLoad, again, out };
  }, { m, jobs: JOBS, origin: base }).catch(e => ({ error: e.message }));
  await browser.close().catch(() => {});
  if (result.error) {
    table.push(`| ${m.id} | ${(m.bytes / 1048576).toFixed(0)} MB | failed: ${result.error.slice(0, 120)} | | | |`);
    continue;
  }
  const ok = result.out.filter(o => !o.failed);
  const prefill = ok.map(o => o.usage?.extra?.prefill_tokens_per_s ?? 0);
  const decode = ok.map(o => o.usage?.extra?.decode_tokens_per_s ?? 0);
  const avg = a => (a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : '-');
  table.push(`| ${m.id} | ${(m.bytes / 1048576).toFixed(0)} MB | ${(result.firstLoad / 1000).toFixed(1)} s | ${(result.again / 1000).toFixed(1)} s | ${avg(prefill)} tokens/s | ${avg(decode)} tokens/s |${result.out.some(o => o.failed) ? ` ${ok.length} of ${JOBS.length} jobs finished` : ''}`);
  answers.push(`## ${m.id}`, '');
  for (const o of result.out) answers.push(`**${o.job}** (${(o.ms / 1000).toFixed(1)} s, ${o.usage?.completion_tokens ?? '?'} tokens):`, '', '```text', o.text.trim(), '```', '');
  console.log(`  ${table[table.length - 1]}`);
}
writeFileSync(out, [...lines, ...table, '', ...answers].join('\n'));
console.log(`Written ${out}`);
process.exit(0);
