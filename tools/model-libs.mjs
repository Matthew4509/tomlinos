// Builds src/apps/assistant/modellibs.ts: which WebGPU program (the "model library" MLC compiles, one per kind of model)
// runs which models. A model found on Hugging Face (assistant/hfsearch.ts) can start in TOMLIN OS only when its
// mlc-chat-config.json describes the same kind of model as one of WebLLM's own programs: the same architecture, sizes
// and compression. Fine-tunes of a model keep its sizes, so they run on its program. Only the MLC team's programs are
// ever used (from their GitHub folder, the one WebLLM uses); a model's own repository supplies weights, never code.
//   node tools/model-libs.mjs       reads the WebLLM this TOMLIN OS ships (public/vendor/webllm.js) and asks Hugging Face
//                                   for each of its models' configs (about 150 small files), then writes the table
// Run it again after updating WebLLM.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const js = readFileSync(join(root, 'public', 'vendor', 'webllm.js'), 'utf8');
const base = /var p="(v0_2_\d+\/base)",v="(https:\/\/raw\.githubusercontent\.com\/mlc-ai\/binary-mlc-llm-libs\/main\/web-llm-models\/)"/.exec(js);
if (!base) {
  console.error('Could not find the program folder in public/vendor/webllm.js (did WebLLM change its layout?).');
  process.exit(1);
}
const libBase = base[2] + base[1] + '/';
const entries = [...js.matchAll(/model:"https:\/\/huggingface\.co\/([^"]+?)\/?",model_id:"([^"]+)",model_lib:v\+p\+"\/([^"]+\.wasm)",vram_required_MB:([\d.]+)/g)]
  .map(m => ({ repo: m[1], id: m[2], lib: m[3], vram: Math.round(Number(m[4])) }))
  // One entry per program: the "-1k" twins (listed first) share their program with the full one.
  .filter(e => /q4f(16|32)_1-MLC$/.test(e.id))
  .filter((e, i, all) => all.findIndex(x => x.lib === e.lib) === i);
console.log(`${entries.length} programs in WebLLM's list; asking Hugging Face for their configs...`);

/** The sizes a program is compiled for: two models with the same key run on the same program. */
export function libKey(config) {
  const c = config.model_config ?? {};
  const pick = ['hidden_size', 'intermediate_size', 'num_hidden_layers', 'num_attention_heads', 'num_key_value_heads', 'head_dim', 'vocab_size'];
  return [config.model_type, config.quantization, ...pick.map(k => c[k] ?? '')].join('|');
}

const rows = [];
for (const e of entries) {
  let config = null;
  for (let attempt = 1; attempt <= 3 && !config; attempt++) {
    try {
      const res = await fetch(`https://huggingface.co/${e.repo}/resolve/main/mlc-chat-config.json`);
      if (res.ok) config = await res.json();
      else if (res.status === 404) break;
    } catch {
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
  if (!config) {
    console.log(`  skipped ${e.id} (no config)`);
    continue;
  }
  rows.push({ key: libKey(config), lib: libBase + e.lib, vram: e.vram, base: e.id, type: config.model_type, quant: config.quantization });
  process.stdout.write(`\r  ${rows.length}/${entries.length}`);
  await new Promise(r => setTimeout(r, 150));
}
// Two programs for one key: the first (WebLLM's own order) is kept.
const seen = new Set();
const table = rows.filter(r => !seen.has(r.key) && seen.add(r.key));
const out = [
  '// Written by tools/model-libs.mjs from the WebLLM this TOMLIN OS ships, then pinned by tools/pin-models.mjs --keep; do not edit by hand.',
  '// Which of the MLC team\'s WebGPU programs runs which kind of model: key = architecture|compression|sizes.',
  'export interface ModelLib { key: string; lib: string; vram: number; base: string; type: string; quant: string }',
  `export const MODEL_LIBS: ModelLib[] = ${JSON.stringify(table, null, 1)};`,
  '',
].join('\n');
writeFileSync(join(root, 'src', 'apps', 'assistant', 'modellibs.ts'), out);
console.log(`\nWrote ${table.length} programs to src/apps/assistant/modellibs.ts. Now pin them: node tools/pin-models.mjs --keep`);
