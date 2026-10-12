// Saving an on-device AI model to this TOMLIN OS (server/lib/models.php), run by PHP against a stand-in for Hugging Face
// on this computer: the plan is the pinned files (the tests' own pins), pieces of at most 16 MB are fetched through a
// redirect (as Hugging Face sends them to its file servers), a stopped save carries on, a file that is not the pinned
// version is thrown away, a server that ignores the range asked for cannot append twice, and a redirect anywhere else
// is refused, and a file gone upstream stops the save with the reason and the way out (Find AI models).
// Also: the built-in list still matches the WebLLM this TOMLIN OS ships, and the real pins cover it. Skipped without PHP.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BUILT_IN_MODELS } from '../src/apps/assistant/engine.ts';
import { MODEL_LIBS } from '../src/apps/assistant/modellibs.ts';
import { PHP, extFlags, hasPhp } from './php-bin.ts';
import { tempDir } from './tmp.ts';

const root = join(import.meta.dirname, '..');
const ext = extFlags('openssl', 'curl');
const noPhp = !hasPhp && 'no PHP';
const ID = 'Qwen3.5-0.8B-q4f32_1-MLC';

// The stand-in's files: a small config, a 20 MB shard (two pieces), and the program.
const config = Buffer.from('{"model_type": "qwen3"}');
const shard = Buffer.alloc(20 * 1024 * 1024 + 123, 7);
for (let i = 0; i < shard.length; i += 4096) shard[i] = i % 251;
const wasm = Buffer.from('\0asm-stand-in-program');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const LIB = 'Qwen3.5-0.8B-q4f32_1_cs1k-webgpu.wasm';
const REV = 'a'.repeat(40);
const LIBS_REV = 'b'.repeat(40);

// The tests' pins: what the stand-in serves, with its real checksums.
const pinsDir = tempDir('tomlinos-pins-');
const pinsFile = join(pinsDir, 'pins.json');
writeFileSync(pinsFile, JSON.stringify({
  models: { [ID]: { repo: `mlc-ai/${ID}`, rev: REV, files: [
    { path: 'mlc-chat-config.json', size: config.length, sha256: sha(config) },
    { path: 'params_shard_0.bin', size: shard.length, sha256: sha(shard) },
  ] } },
  libsCommit: LIBS_REV, libsFolder: 'v0_2_84/base', libs: { [LIB]: { size: wasm.length, sha256: sha(wasm) } },
}));

/** wrongBytes: the shard sent is not the pinned one; gone: Hugging Face answers 404 for it. */
interface Mode { ignoreRange?: boolean; wrongBytes?: boolean; evilRedirect?: boolean; gone?: boolean; ranges: string[] }

function standIn(mode: Mode): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const url = req.url ?? '';
    if (mode.gone && url.includes('params_shard_0.bin')) {
      res.writeHead(404).end();
      return;
    }
    const m = /^\/mlc-ai\/[^/]+\/resolve\/main\/(.+)$/.exec(url);
    if (m) {
      // As Hugging Face does: a redirect to its file servers.
      res.writeHead(302, { Location: mode.evilRedirect ? 'https://evil.example/x' : `http://127.0.0.1:${(server.address() as { port: number }).port}/cdn/${m[1]}` });
      res.end('redirecting');
      return;
    }
    const other = Buffer.from(shard);
    other[5] ^= 1;
    const body = url === '/cdn/mlc-chat-config.json' ? config : url === '/cdn/params_shard_0.bin' ? (mode.wrongBytes ? other : shard) : url.startsWith('/libs/') ? wasm : null;
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
    mode.ranges.push(`${url} ${req.headers.range ?? 'whole'}`);
    if (range && !mode.ignoreRange) {
      const from = Number(range[1]);
      const to = Math.min(Number(range[2]), body.length - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${from}-${to}/${body.length}`, 'Content-Length': to - from + 1 });
      res.end(body.subarray(from, to + 1));
    } else {
      res.writeHead(200, { 'Content-Length': body.length });
      res.end(body);
    }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` })));
}

const testEnv = (base: string, extra: Record<string, string> = {}) => ({ ...process.env, DESKTOP_MODELS_TEST_URL: base, DESKTOP_MODELS_TEST_PINS: pinsFile, ...extra });

function php(base: string, dir: string, body: string, extra: Record<string, string> = {}): Promise<Record<string, any>> {
  const file = join(dir, `t${Math.random().toString(36).slice(2)}.php`);
  writeFileSync(file, `<?php
require ${JSON.stringify(join(root, 'server/lib/http.php'))};
require ${JSON.stringify(join(root, 'server/lib/outbound.php'))};
require ${JSON.stringify(join(root, 'server/lib/models.php'))};
$m = ${JSON.stringify(join(dir, 'models'))};
function step(callable $f) { try { return $f(); } catch (RuntimeException $e) { return ['error' => $e->getMessage()]; } }
${body}`);
  return new Promise((resolve, reject) => execFile(PHP, [...ext, file], { env: testEnv(base, extra), encoding: 'utf8' }, (error, out) => {
    if (error) return reject(new Error(`${error.message}\n${out}`));
    try {
      resolve(JSON.parse(out));
    } catch {
      reject(new Error(out));
    }
  }));
}

/** Runs the plan to the end (or the first refusal), one piece per call, as the page does. */
const SAVE = `
$plan = step(fn () => models_make_plan('${ID}'));
$steps = [];
if (!isset($plan['error'])) {
  foreach ($plan['files'] as $f) {
    for ($i = 0; $i < 5; $i++) {
      $r = step(fn () => models_fetch_piece($m, '${ID}', $f));
      $steps[] = [$f['path'], $r];
      if (isset($r['error']) || $r['done']) break;
    }
  }
}`;

test('a model is saved in pieces through the redirect, checked, and listed; removing it frees the space', { skip: noPhp }, async () => {
  const mode: Mode = { ranges: [] };
  const { server, base } = await standIn(mode);
  const dir = tempDir('tomlinos-models-');
  try {
    const r = await php(base, dir, `${SAVE}
models_ensure_htaccess($m);
models_index_add($m, '${ID}', $plan);
echo json_encode(['plan' => $plan, 'steps' => $steps, 'index' => models_index_read($m)]);`);
    assert.deepEqual(r.plan.files.map((f: { path: string }) => f.path), ['mlc-chat-config.json', 'params_shard_0.bin', LIB], 'the pinned files, then the program');
    assert.equal(r.plan.rev, REV);
    assert.ok(r.plan.files.every((f: { sha256: string }) => /^[0-9a-f]{64}$/.test(f.sha256)), 'every file has its checksum');
    const shardSteps = r.steps.filter((s: [string]) => s[0] === 'params_shard_0.bin').map((s: [string, { have: number; done: boolean }]) => s[1]);
    assert.deepEqual(shardSteps, [{ have: 16 * 1024 * 1024, done: false }, { have: shard.length, done: true }], 'two pieces of at most 16 MB');
    assert.deepEqual(mode.ranges.filter(x => x.includes('params')), [`/cdn/params_shard_0.bin bytes=0-${16 * 1024 * 1024 - 1}`, `/cdn/params_shard_0.bin bytes=${16 * 1024 * 1024}-${shard.length - 1}`]);
    const models = join(dir, 'models');
    assert.ok(readFileSync(join(models, ID, 'resolve', 'main', 'params_shard_0.bin')).equals(shard), 'the shard arrived whole');
    assert.ok(readFileSync(join(models, 'libs', 'Qwen3.5-0.8B-q4f32_1_cs1k-webgpu.wasm')).equals(wasm), 'the program is in libs/');
    assert.ok(!existsSync(join(models, ID, 'resolve', 'main', 'params_shard_0.bin.part')), 'no part file left');
    assert.match(readFileSync(join(models, '.htaccess'), 'utf8'), /^Require all denied$/m, 'refused if a host ever serves the folder');
    assert.deepEqual(r.index.models[0], { id: ID, lib: LIB, bytes: config.length + shard.length, vram: 1894, context: 4096, overrides: { context_window_size: 4096, max_history_size: 1 }, rev: REV, libSha256: sha(wasm) });

    const gone = await php(base, dir, `models_remove($m, '${ID}'); echo json_encode(['index' => models_index_read($m), 'folder' => is_dir($m . '/${ID}'), 'lib' => is_file($m . '/libs/Qwen3.5-0.8B-q4f32_1_cs1k-webgpu.wasm')]);`);
    assert.deepEqual(gone, { index: { models: [] }, folder: false, lib: false });
  } finally {
    server.close();
  }
});

test('a stopped save carries on where it stopped', { skip: noPhp }, async () => {
  const mode: Mode = { ranges: [] };
  const { server, base } = await standIn(mode);
  const dir = tempDir('tomlinos-models-');
  try {
    const target = join(dir, 'models', ID, 'resolve', 'main', 'params_shard_0.bin');
    const first = await php(base, dir, `$plan = models_make_plan('${ID}'); echo json_encode(models_fetch_piece($m, '${ID}', $plan['files'][1]));`);
    assert.deepEqual(first, { have: 16 * 1024 * 1024, done: false });
    assert.equal(statSync(target + '.part').size, 16 * 1024 * 1024);
    const second = await php(base, dir, `$plan = models_make_plan('${ID}'); echo json_encode(models_fetch_piece($m, '${ID}', $plan['files'][1]));`);
    assert.deepEqual(second, { have: shard.length, done: true });
    assert.ok(readFileSync(target).equals(shard));
  } finally {
    server.close();
  }
});

test('a file that is not the pinned version is thrown away; a server ignoring the range appends nothing; a redirect elsewhere is refused', { skip: noPhp }, async () => {
  for (const [mode, words] of [
    [{ wrongBytes: true, ranges: [] }, /from Hugging Face was not the pinned version \(params_shard_0\.bin\)/],
    [{ ignoreRange: true, ranges: [] }, /did not send the piece asked for/],
    [{ evilRedirect: true, ranges: [] }, /somewhere this server will not fetch from/],
  ] as Array<[Mode, RegExp]>) {
    const { server, base } = await standIn(mode);
    const dir = tempDir('tomlinos-models-');
    try {
      const r = await php(base, dir, `${SAVE} echo json_encode(['steps' => $steps]);`);
      const refusal = r.steps.find((s: [string, { error?: string }]) => s[1].error);
      assert.ok(refusal && words.test(refusal[1].error), JSON.stringify(r.steps).slice(0, 400));
      const part = join(dir, 'models', ID, 'resolve', 'main', 'params_shard_0.bin');
      assert.ok(!existsSync(part), 'no finished file');
      if (existsSync(part + '.part')) assert.equal(statSync(part + '.part').size, 0, 'nothing appended');
      if (mode.evilRedirect) assert.equal(mode.ranges.filter(x => x.startsWith('/cdn/')).length, 0, 'nothing behind a refused redirect was fetched');
    } finally {
      server.close();
    }
  }
});

test('only Hugging Face and GitHub file servers over https are fetched from', { skip: noPhp }, async () => {
  const dir = tempDir('tomlinos-models-');
  const r = await php('', dir, `echo json_encode(array_map('models_host_allowed', [
  'https://huggingface.co/mlc-ai/x/resolve/main/a.bin', 'https://us.aws.cdn.hf.co/xet-bridge-us/abc', 'https://cas-bridge.xethub.hf.co/x',
  'https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/x.wasm', 'http://huggingface.co/x', 'https://huggingface.co:8443/x',
  'https://evil.hf.co.example.com/x', 'https://user@huggingface.co/x', 'https://127.0.0.1/x', 'file:///etc/passwd',
]));`);
  assert.deepEqual(Object.values(r), [true, true, true, true, false, false, false, false, false, false]);
});

test('a file gone upstream stops the save with the reason and Find AI models; other bytes are tried once more', { skip: noPhp }, async () => {
  const gone = await standIn({ gone: true, ranges: [] });
  const wrongMode: Mode = { wrongBytes: true, ranges: [] };
  const wrong = await standIn(wrongMode);
  const dir = tempDir('tomlinos-models-');
  try {
    const run = (base: string) => php(base, dir, `$plan = models_make_plan('${ID}');
$steps = [];
for ($i = 0; $i < 6; $i++) {
  $r = step(function () use (&$plan, $m) { return models_save_step($m, '${ID}', $plan); });
  $steps[] = $r;
  if (isset($r['error']) || $r['done']) break;
}
echo json_encode(['steps' => $steps]);`);
    const stopped = await run(gone.base);
    assert.match(stopped.steps.at(-1).error, /answered 404 .* no longer where it was published, so it cannot be saved\. Find AI models/);
    assert.doesNotMatch(stopped.steps.at(-1).error, /mirror/);
    const twice = await run(wrong.base);
    assert.equal(twice.steps.filter((s: { changed?: boolean }) => s.changed).length, 1, 'the first miss is tried again');
    assert.match(twice.steps.at(-1).error, /was not the pinned version .* Find AI models/, 'the second stops the save');
    assert.equal(wrongMode.ranges.filter(x => x.includes('params')).length, 4, 'fetched twice (two pieces each), no more');
  } finally {
    gone.server.close();
    wrong.server.close();
  }
});

test('a model removed can be saved again only a day later', { skip: noPhp }, async () => {
  const dir = tempDir('tomlinos-models-');
  mkdirSync(join(dir, 'data', 'models'), { recursive: true });
  const r = await php('', dir, `$d = ${JSON.stringify(join(dir, 'data'))};
$before = models_resave_wait($d, '${ID}');
models_note_removed($d, '${ID}');
echo json_encode(['before' => $before, 'after' => models_resave_wait($d, '${ID}'), 'other' => models_resave_wait($d, 'gemma-2-2b-it-q4f32_1-MLC')]);`);
  assert.equal(r.before, 0);
  assert.ok(r.after > 86390 && r.after <= 86400, String(r.after));
  assert.equal(r.other, 0, 'only the model removed');
});

test('the real pins cover every built-in model and every program, and the page gets the same checksums', { skip: noPhp }, () => {
  const pins = JSON.parse(readFileSync(join(root, 'server', 'lib', 'model-pins.json'), 'utf8'));
  assert.match(pins.libsCommit, /^[0-9a-f]{40}$/);
  for (const m of BUILT_IN_MODELS) {
    const pin = pins.models[m.id];
    assert.match(pin?.rev ?? '', /^[0-9a-f]{40}$/, m.id);
    assert.ok(pin.files.length > 3 && pin.files.every((f: { sha256: string; size: number }) => /^[0-9a-f]{64}$/.test(f.sha256) && f.size > 0), m.id);
    assert.ok(pin.files.some((f: { path: string }) => f.path === 'mlc-chat-config.json'), m.id);
  }
  for (const l of MODEL_LIBS) {
    const name = l.lib.split('/').pop()!;
    assert.ok(l.lib.includes(`/${pins.libsCommit}/`), `${name} is fetched at the pinned commit`);
    assert.equal(l.sha256, pins.libs[name]?.sha256, name);
  }
});

test('the built-in models on the server, in the page and in the WebLLM this TOMLIN OS ships all agree', { skip: noPhp }, async () => {
  const dir = tempDir('tomlinos-models-');
  const catalog = await php('', dir, 'echo json_encode(MODEL_CATALOG);');
  assert.deepEqual(Object.keys(catalog), BUILT_IN_MODELS.map(m => m.id), 'the same models, in the same order');
  for (const m of BUILT_IN_MODELS) assert.equal(catalog[m.id].name, m.name);
  const webllmPath = join(root, 'vendor-src', 'webllm', 'node_modules', '@mlc-ai', 'web-llm', 'lib', 'index.js');
  if (!existsSync(webllmPath)) return; // the list lives in WebLLM's own package, installed only where models are fetched
  const webllm = await import(pathToFileURL(webllmPath).href);
  for (const [id, c] of Object.entries(catalog) as Array<[string, { repo: string; lib: string; vram: number; overrides: object }]>) {
    const w = webllm.prebuiltAppConfig.model_list.find((x: { model_id: string }) => x.model_id === id);
    assert.ok(w, `${id} is in WebLLM's list`);
    assert.equal(`https://huggingface.co/${c.repo}`, w.model);
    assert.equal(c.lib, w.model_lib, 'the same WebGPU program');
    assert.equal(c.vram, Math.round(w.vram_required_MB));
    assert.deepEqual(c.overrides, w.overrides);
  }
});
