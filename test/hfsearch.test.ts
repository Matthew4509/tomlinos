// Finding models on Hugging Face: only MLC models are asked for, a result pairs with an MLC program only when it is the
// same kind of model, the drop-down filters do what they say, and a person's list survives a damaged file.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanMyModels, describe, libFor, loadableFor, myModelId, niceName, passes, searchHF, searchUrls, toMyModel, type Found } from '../src/apps/assistant/hfsearch.ts';
import { chatStyle, turnsFor } from '../src/apps/assistant/engine.ts';
import { MODEL_LIBS } from '../src/apps/assistant/modellibs.ts';

// Gemma 2 2B's own config (mlc-ai/gemma-2-2b-it-q4f32_1-MLC), as Hugging Face served it on 30 Sep 2026.
const GEMMA = {
  model_type: 'gemma2', quantization: 'q4f32_1', context_window_size: 4096,
  model_config: { hidden_size: 2304, intermediate_size: 9216, num_attention_heads: 8, num_key_value_heads: 4, head_dim: 256, num_hidden_layers: 26, vocab_size: 256000 },
};

const answer = (body: unknown, status = 200) => Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(body) });

test('the search asks for MLC models: tagged ones, and names with "MLC" in them; in the order chosen', () => {
  const [tagged, named] = searchUrls('  gemma  ', 'likes').map(u => new URL(u));
  assert.equal(tagged.origin + tagged.pathname, 'https://huggingface.co/api/models');
  assert.equal(tagged.searchParams.get('filter'), 'mlc-llm');
  assert.equal(tagged.searchParams.get('search'), 'gemma');
  assert.equal(tagged.searchParams.get('sort'), 'likes');
  assert.equal(named.searchParams.has('filter'), false);
  assert.equal(named.searchParams.get('search'), 'gemma mlc', 'untagged: the words and "mlc"');
  assert.deepEqual(searchUrls('', 'downloads').length, 1, 'no words: the tagged ones only, most downloaded first');
});

test('the search keeps plain repository names, each once, and only MLC ones from the untagged search', async () => {
  const rows = await searchHF('x', 'downloads', url => url.includes('filter=mlc-llm')
    ? answer([{ id: 'someone/Model-q4f32_1-MLC', downloads: 5, likes: 1 }, { id: '../evil' }, { id: 'a/b/c' }])
    : answer([{ id: 'other/Lexi-q4f32_1-MLC', downloads: 9 }, { id: 'other/Lexi-GGUF', downloads: 99 }, { id: 'someone/Model-q4f32_1-MLC', downloads: 5 }]));
  assert.deepEqual(rows.map(r => r.repo), ['other/Lexi-q4f32_1-MLC', 'someone/Model-q4f32_1-MLC'], 'most downloaded first; no GGUF; no repeat');
  await assert.rejects(searchHF('x', 'downloads', () => answer({}, 503)), /did not answer the search \(503\)/);
});

test('a model pairs with the MLC program for its kind; a fine-tune of the same size runs on it too', () => {
  const lib = libFor(GEMMA);
  assert.ok(lib, 'Gemma 2 2B has a program');
  assert.match(lib.lib, /^https:\/\/raw\.githubusercontent\.com\/mlc-ai\/binary-mlc-llm-libs\/[0-9a-f]{40}\/web-llm-models\/v0_2_\d+\/base\/gemma-2-2b-it-q4f32_1_cs1k-webgpu\.wasm$/);
  assert.equal(libFor({ ...GEMMA, model_config: { ...GEMMA.model_config, vocab_size: 256001 } }), null, 'a different size: no program');
  assert.equal(libFor({ ...GEMMA, quantization: 'q3f16_1' }), null, 'a compression MLC ships no program for');
  assert.ok(MODEL_LIBS.every(l => l.lib.startsWith('https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/')), 'only the MLC team\'s programs');
});

test('describing a result reads its config and adds up its model files', async () => {
  const fetches: string[] = [];
  const found = await describe({ repo: 'fan/gemma-2-2b-it-kind-q4f32_1-MLC', downloads: 1, likes: 0, updated: '' }, url => {
    fetches.push(url);
    if (url.endsWith('mlc-chat-config.json')) return answer(GEMMA);
    return answer([{ type: 'file', path: 'params_shard_0.bin', size: 100, lfs: { size: 1000 } }, { type: 'file', path: 'tokenizer.json', size: 50 }, { type: 'file', path: 'README.md', size: 9 }, { type: 'file', path: '.gitattributes', size: 9 }]);
  });
  assert.deepEqual(fetches, ['https://huggingface.co/fan/gemma-2-2b-it-kind-q4f32_1-MLC/resolve/main/mlc-chat-config.json', 'https://huggingface.co/api/models/fan/gemma-2-2b-it-kind-q4f32_1-MLC/tree/main']);
  assert.equal(found.bytes, 1050, 'the model files (the big one by its stored size), not the read-me');
  assert.equal(found.quant, 'q4f32_1');
  assert.equal(found.uploader, 'fan');
  assert.ok(found.lib);
  const broken = await describe({ repo: 'fan/nothing', downloads: 0, likes: 0, updated: '' }, () => answer({}, 404));
  assert.equal(broken.lib, null, 'no config: cannot start');
});

test('the size and kind drop-downs', () => {
  const m = { bytes: 1.5 * 1024 ** 3, quant: 'q4f32_1' } as Found;
  assert.equal(passes(m, { size: 'any', kind: 'any' }), true);
  assert.equal(passes(m, { size: '1', kind: 'any' }), false, 'over 1 GB');
  assert.equal(passes(m, { size: '2', kind: 'any' }), true, 'under 2 GB');
  assert.equal(passes(m, { size: '2', kind: 'q4f16' }), false, 'wrong kind');
  assert.equal(passes(m, { size: '2', kind: 'q4f32' }), true);
  assert.equal(passes({ ...m, bytes: 0 }, { size: '4', kind: 'any' }), false, 'no size known: left out of a size filter');
  assert.equal(passes({ ...m, bytes: 0 }, { size: 'any', kind: 'any' }), true);
});

test('names read like names', () => {
  assert.equal(niceName('akaashrp/Qwen3.5-2B-q4f32_1-MLC'), 'Qwen3.5 2B');
  assert.equal(niceName('fan/gemma-2-2b-it-kind-q4f32_1-MLC'), 'gemma 2 2b it kind');
});

test('a person\'s list: only models with a known program; a damaged file is an empty list; fetched from Hugging Face', () => {
  const lib = libFor(GEMMA)!;
  const mine = toMyModel({ repo: 'fan/g-q4f32_1-MLC', downloads: 0, likes: 0, updated: '', name: 'g', uploader: 'fan', bytes: 10, quant: 'q4f32_1', type: 'gemma2', context: 8192, lib }, 5)!;
  assert.equal(mine.id, myModelId('fan/g-q4f32_1-MLC'));
  assert.equal(mine.id, 'hf--fan--g-q4f32_1-MLC');
  assert.deepEqual(cleanMyModels([mine, { ...mine, repo: 'x/y', lib: 'https://evil.example/x.wasm' }, { repo: '../z' }]).map(m => m.repo), ['fan/g-q4f32_1-MLC']);
  assert.deepEqual(cleanMyModels('not a list'), []);
  // Saved before programs were pinned (the "main" address): kept, now at the pinned address and with its checksum.
  const old = cleanMyModels([{ ...mine, lib: 'https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_84/base/gemma-2-2b-it-q4f32_1_cs1k-webgpu.wasm' }]);
  assert.equal(old[0]?.lib, lib.lib);
  assert.equal(cleanMyModels([{ ...mine, lib: 'https://evil.example/gemma-2-2b-it-q4f32_1_cs1k-webgpu.wasm' }]).length, 0, 'the same file name elsewhere is not a known program');
  const load = loadableFor(mine);
  assert.match(load.libSha256 ?? '', /^[0-9a-f]{64}$/, 'the page checks the program before it runs');
  assert.deepEqual(load.from, { model: 'https://huggingface.co/fan/g-q4f32_1-MLC', lib: lib.lib });
  assert.equal(load.saved, false, 'never from the server');
  assert.equal(load.context, 4096, 'a longer context is held to what the program was built for');
});

test('each family is asked its own way: Qwen thinking off, Gemma with the instructions in the first message', () => {
  assert.deepEqual(chatStyle('Qwen3.5-4B-q4f32_1-MLC').sampling.extra_body, { enable_thinking: false });
  const g = chatStyle('gemma-2-2b-it-q4f32_1-MLC');
  assert.equal(g.systemInFirstMessage, true);
  assert.equal('extra_body' in g.sampling, false, 'no Qwen switch for Gemma');
  const turns = turnsFor([{ role: 'system', content: 'Be kind.' }, { role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }, { role: 'user', content: 'More' }], g);
  assert.deepEqual(turns, [{ role: 'user', content: 'Be kind.\n\nHi' }, { role: 'assistant', content: 'Hello' }, { role: 'user', content: 'More' }]);
  assert.equal(turnsFor([{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }], chatStyle('Qwen3.5-0.8B-q4f32_1-MLC')).length, 2, 'Qwen keeps its system turn');
});
