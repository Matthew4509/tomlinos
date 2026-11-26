// Audit of AI Models (November 2026): getting, keeping and removing on-device models (server/lib/models.php, the
// Find AI models list in assistant/hfsearch.ts). Each test that FAILS names a fault the audit found; it should pass
// once the fault is fixed. P1 findings are marked todo. No inference is run, and no outside host is contacted: the
// PHP runs with DESKTOP_MODELS_TEST_URL pointing at 127.0.0.1 (nothing listens on that port in these tests, as every file
// they need is already on disk) and its own small pins. Skipped without PHP.
// Run: node --test test/audit-aimodels.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PHP, extFlags, hasPhp } from './php-bin.ts';
import { tempDir } from './tmp.ts';
import { cleanMyModels, describe, toMyModel, type Found } from '../src/apps/assistant/hfsearch.ts';
import { MODEL_LIBS } from '../src/apps/assistant/modellibs.ts';

const root = join(import.meta.dirname, '..');
const ext = extFlags('openssl', 'curl');
const noPhp = !hasPhp && 'no PHP';
const ID = 'Qwen3.5-0.8B-q4f32_1-MLC';
const OTHER = 'gemma-2-2b-it-q4f32_1-MLC';
const LIB = 'Qwen3.5-0.8B-q4f32_1_cs1k-webgpu.wasm';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

// Small stand-in files and their pins (a few KB: nothing big is written).
const config = Buffer.from('{"model_type": "qwen3"}');
const shard = Buffer.alloc(64 * 1024, 7);
const wasm = Buffer.from('\0asm-stand-in-program');
const pinsDir = tempDir('tomlinos-audit-pins-');
const pinsFile = join(pinsDir, 'pins.json');
const pinned = { repo: '', rev: 'a'.repeat(40), files: [
  { path: 'mlc-chat-config.json', size: config.length, sha256: sha(config) },
  { path: 'params_shard_0.bin', size: shard.length, sha256: sha(shard) },
] };
writeFileSync(pinsFile, JSON.stringify({
  models: { [ID]: { ...pinned, repo: `mlc-ai/${ID}` }, [OTHER]: { ...pinned, repo: `mlc-ai/${OTHER}` } },
  libsCommit: 'b'.repeat(40), libsFolder: 'v0_2_84/base',
  libs: { [LIB]: { size: wasm.length, sha256: sha(wasm) }, 'gemma-2-2b-it-q4f32_1_cs1k-webgpu.wasm': { size: wasm.length, sha256: sha(wasm) } },
}));

// Port 39 on 127.0.0.1 (the server accepts only a 2-5 digit port for its stand-in): nothing answers, so any fetch fails at once (and never leaves this computer).
const env = { ...process.env, DESKTOP_MODELS_TEST_URL: 'http://127.0.0.1:39', DESKTOP_MODELS_TEST_PINS: pinsFile };

function php(dir: string, body: string): Promise<Record<string, any>> {
  const file = join(dir, `t${Math.random().toString(36).slice(2)}.php`);
  writeFileSync(file, `<?php
require ${JSON.stringify(join(root, 'server/lib/http.php'))};
require ${JSON.stringify(join(root, 'server/lib/outbound.php'))};
require ${JSON.stringify(join(root, 'server/lib/models.php'))};
$m = ${JSON.stringify(join(dir, 'models'))};
function step(callable $f) { try { return $f(); } catch (Throwable $e) { return ['error' => $e->getMessage()]; } }
${body}`);
  return new Promise((resolve, reject) => execFile(PHP, ['-d', 'display_errors=0', ...ext, file], { env, encoding: 'utf8' }, (error, out) => {
    if (error) return reject(new Error(`${error.message}\n${out}`));
    try {
      resolve(JSON.parse(out));
    } catch {
      reject(new Error(out));
    }
  }));
}

const modelFile = (dir: string, id: string, name: string) => join(dir, 'models', id, 'resolve', 'main', name);

test('AM-P0-1: a file already in a model\'s folder is checked against its pin before the model counts as saved', { skip: noPhp }, async () => {
  const dir = tempDir('tomlinos-audit-models-');
  // A folder edited by hand (or copied from somewhere else): the right names, the wrong bytes and sizes.
  mkdirSync(join(dir, 'models', ID, 'resolve', 'main'), { recursive: true });
  mkdirSync(join(dir, 'models', 'libs'), { recursive: true });
  writeFileSync(modelFile(dir, ID, 'mlc-chat-config.json'), '{"not": "the pinned config"}');
  writeFileSync(modelFile(dir, ID, 'params_shard_0.bin'), 'garbage, not 64 KB');
  writeFileSync(join(dir, 'models', 'libs', LIB), 'not the pinned program');
  const r = await php(dir, `$plan = models_make_plan('${ID}');
$steps = [];
for ($i = 0; $i < 6; $i++) {
  $s = step(function () use (&$plan, $m) { return models_save_step($m, '${ID}', $plan); });
  $steps[] = $s;
  if (isset($s['error']) || $s['done']) break;
}
$last = end($steps);
if (!empty($last['done'])) { models_index_add($m, '${ID}', $plan); }
echo json_encode(['steps' => $steps, 'index' => models_index_read($m)]);`);
  const last = r.steps.at(-1);
  // Expected: the wrong files are thrown away (and fetched again, which fails here as nothing answers), so the save
  // does not finish. Actual: every file "is there", so the model is listed as saved with none of its pinned bytes.
  assert.ok(!last.done, 'the save finished with unpinned files: ' + JSON.stringify(r.steps));
  assert.equal(r.index.models.length, 0, 'the model is listed as saved: ' + JSON.stringify(r.index));
});

test('AM-P0-2: a model whose files cannot all be deleted is not reported removed (its line kept, or an error)', { skip: noPhp }, async () => {
  const dir = tempDir('tomlinos-audit-models-');
  mkdirSync(join(dir, 'models', ID, 'resolve', 'main'), { recursive: true });
  const stuck = modelFile(dir, ID, 'params_shard_0.bin');
  writeFileSync(modelFile(dir, ID, 'mlc-chat-config.json'), config);
  writeFileSync(stuck, shard);
  // A file the server may not delete (read-only here; on a host, one uploaded by another user, or one held open).
  chmodSync(stuck, 0o444);
  writeFileSync(join(dir, 'models', 'models.json'), JSON.stringify({ models: [{ id: ID, lib: LIB, bytes: config.length + shard.length }] }));
  try {
    const r = await php(dir, `$res = step(function () use ($m) { models_remove($m, '${ID}'); return ['ok' => true]; });
echo json_encode(['res' => $res, 'index' => models_index_read($m), 'folder' => is_dir($m . '/${ID}')]);`);
    assert.equal(r.folder, true, 'the setup: the file really could not be deleted');
    // Expected: an error (api/models.php then says "Some of the model's files could not be deleted"), with the model
    // still listed so Remove can be pressed again. Actual: no error, the line is gone, and the files stay on the disk
    // with no button left to remove them (not saved, no save in progress) and a day's wait before a fresh save.
    assert.ok(r.res.error || r.index.models.some((m: { id: string }) => m.id === ID), 'reported removed, files left behind: ' + JSON.stringify(r));
  } finally {
    chmodSync(stuck, 0o666);
  }
});

test('AM-P1-1: a damaged models.json is not written over, losing the other saved models\' lines', { skip: noPhp, todo: 'P1' }, async () => {
  const dir = tempDir('tomlinos-audit-models-');
  mkdirSync(join(dir, 'models'), { recursive: true });
  // One saved model, and a stray character after it (a hand edit, or a cut-off write by another tool).
  writeFileSync(join(dir, 'models', 'models.json'), JSON.stringify({ models: [{ id: OTHER, lib: 'gemma-2-2b-it-q4f32_1_cs1k-webgpu.wasm', bytes: 5 }] }) + ',');
  const r = await php(dir, `$plan = models_make_plan('${ID}');
$res = step(function () use ($m, $plan) { models_index_add($m, '${ID}', $plan); return ['ok' => true]; });
echo json_encode(['res' => $res, 'text' => file_get_contents($m . '/models.json')]);`);
  assert.ok(r.res.error || r.text.includes(OTHER), 'Gemma\'s line was dropped: ' + r.text);
});

test('AM-P1-2: the 51st model added in Find AI models is not silently dropped from the list', { todo: 'P1' }, () => {
  const lib = MODEL_LIBS[0];
  const found = (i: number): Found => ({ repo: `someone/Model${i}-MLC`, downloads: 0, likes: 0, updated: '', name: `Model ${i}`, uploader: 'someone', bytes: 1, quant: lib.quant, type: lib.type, context: 4096, lib });
  const list = Array.from({ length: 51 }, (_, i) => toMyModel(found(i))!);
  // aimodels.ts appends the new one and says "was added"; read back, the list is cut to the first 50.
  const back = cleanMyModels(JSON.parse(JSON.stringify(list)));
  assert.ok(back.some(m => m.repo === 'someone/Model50-MLC'), 'the newest one is gone after a reload, though the page said it was added');
});

test('AM-P1-3: a model whose details could not be read (offline) is told apart from one the engine cannot run', { todo: 'P1' }, async () => {
  const offline = async () => {
    throw new TypeError('Failed to fetch');
  };
  const m = await describe({ repo: 'mlc-ai/Llama-3.2-1B-Instruct-q4f32_1-MLC', downloads: 0, likes: 0, updated: '' }, offline);
  // aimodels.ts shows "TOMLIN OS's engine has no program for this kind of model" for every result with no lib, so
  // offline every model reads as one that can never run here.
  assert.ok('unreadable' in m || 'error' in m, 'an unreadable model looks the same as one with no program: ' + JSON.stringify(m));
});
