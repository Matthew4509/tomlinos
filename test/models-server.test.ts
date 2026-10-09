// Saving an on-device AI model to this TOMLIN OS (server/lib/models.php), run by PHP against a stand-in for Hugging Face
// on this computer: the plan is the pinned files (the tests' own pins), pieces of at most 16 MB are fetched through a
// redirect (as Hugging Face sends them to its file servers), a stopped save carries on, a file that is not the pinned
// version is thrown away, a server that ignores the range asked for cannot append twice, and a redirect anywhere else
// is refused. Then the model mirror (mirror/index.php, run by PHP's own server): filled from the stand-in, it serves a
// TOMLIN OS server whose Hugging Face copy is gone, refuses browsers and other versions, and stops at the daily share.
// Also: the built-in list still matches the WebLLM this TOMLIN OS ships, and the real pins cover it. Skipped without PHP.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, request, type Server } from 'node:http';
import { createServer as netServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BUILT_IN_MODELS } from '../src/apps/assistant/engine.ts';
import { MODEL_LIBS } from '../src/apps/assistant/modellibs.ts';
import { PHP, extFlags, hasPhp } from './php-bin.ts';

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
const pinsDir = mkdtempSync(join(tmpdir(), 'tomlinos-pins-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'tomlinos-models-'));
  try {
    const r = await php(base, dir, `${SAVE}
models_ensure_htaccess($m);
models_index_add($m, '${ID}', $plan);
echo json_encode(['plan' => $plan, 'steps' => $steps, 'index' => models_index_read($m)]);`);
    assert.deepEqual(r.plan.files.map((f: { path: string }) => f.path), ['mlc-chat-config.json', 'params_shard_0.bin', LIB], 'the pinned files, then the program');
    assert.equal(r.plan.rev, REV);
    assert.ok(r.plan.files.every((f: { sha256: string; from: string }) => /^[0-9a-f]{64}$/.test(f.sha256) && f.from === 'upstream'), 'every file has its checksum');
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
  const dir = mkdtempSync(join(tmpdir(), 'tomlinos-models-'));
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
    const dir = mkdtempSync(join(tmpdir(), 'tomlinos-models-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'tomlinos-models-'));
  const r = await php('', dir, `echo json_encode(array_map('models_host_allowed', [
  'https://huggingface.co/mlc-ai/x/resolve/main/a.bin', 'https://us.aws.cdn.hf.co/xet-bridge-us/abc', 'https://cas-bridge.xethub.hf.co/x',
  'https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/x.wasm', 'http://huggingface.co/x', 'https://huggingface.co:8443/x',
  'https://evil.hf.co.example.com/x', 'https://user@huggingface.co/x', 'https://127.0.0.1/x', 'file:///etc/passwd',
]));`);
  assert.deepEqual(Object.values(r), [true, true, true, true, false, false, false, false, false, false]);
  const m = await php('', dir, `echo json_encode(array_map(fn ($u) => models_host_allowed($u, 'https://mirror.example/aimodels/'), [
  'https://mirror.example/aimodels/?id=x', 'https://MIRROR.example/other', 'https://huggingface.co/x', 'http://mirror.example/aimodels/', 'https://mirror.example:8443/x', 'https://mirror.example.evil.example/x',
]));`);
  assert.deepEqual(Object.values(m), [true, true, false, false, false, false], 'from the mirror: its own host over https only');
  const urls = await php('', dir, `echo json_encode([models_mirror_url([]), models_mirror_url(['model_mirror' => '']), models_mirror_url(['model_mirror' => 'http://mirror.example/aimodels/']), models_mirror_url(['model_mirror' => 'https://other.example/m/'])]);`);
  assert.deepEqual(Object.values(urls), ['', '', '', 'https://other.example/m/'], 'none by default, switched off, http refused, one set');
});

/** A free port on this computer. */
const freePort = () => new Promise<number>(resolve => {
  const s = netServer().listen(0, '127.0.0.1', () => {
    const port = (s.address() as { port: number }).port;
    s.close(() => resolve(port));
  });
});

/** The mirror's door, run by PHP's own server, with its files in `files`. */
async function mirrorDoor(base: string, files: string): Promise<{ proc: ChildProcess; url: string }> {
  const port = await freePort();
  const proc = spawn(PHP, [...ext, '-S', `127.0.0.1:${port}`, join(root, 'mirror', 'index.php')], { env: testEnv(base, { DESKTOP_MIRROR_FILES: files }), stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    const up = await new Promise<boolean>(resolve => request({ host: '127.0.0.1', port, path: '/' }, res => resolve(!!res.resume())).on('error', () => resolve(false)).end());
    if (up) break;
    await new Promise(r => setTimeout(r, 100));
  }
  return { proc, url: `http://127.0.0.1:${port}/` };
}

/** A GET with the headers asked for (a browser's, or none): status and body. */
const fetchRaw = (url: string, headers: Record<string, string>) => new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
  const u = new URL(url);
  request({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers }, res => {
    const parts: Buffer[] = [];
    res.on('data', c => parts.push(c)).on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts) }));
  }).on('error', reject).end();
});

test('the mirror: filled from Hugging Face and checked, it serves a TOMLIN OS server whose Hugging Face copy is gone, and nobody else', { skip: noPhp }, async () => {
  const good = await standIn({ ranges: [] });
  const goneMode: Mode = { gone: true, ranges: [] };
  const gone = await standIn(goneMode);
  const files = mkdtempSync(join(tmpdir(), 'tomlinos-mirror-'));
  const dir = mkdtempSync(join(tmpdir(), 'tomlinos-models-'));
  let door: { proc: ChildProcess; url: string } | null = null;
  try {
    // Run without blocking: the stand-in answers from this same process.
    const cli = (...args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>(resolve => execFile(PHP, [...ext, join(root, 'mirror', 'index.php'), ...args], { env: testEnv(good.base, { DESKTOP_MIRROR_FILES: files }), encoding: 'utf8' }, (error, stdout, stderr) => resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr })));
    const fill = await cli('fill', ID);
    assert.equal(fill.code, 0, fill.stderr);
    assert.match(fill.stdout, /checked and kept/);
    assert.ok(readFileSync(join(files, ID, 'resolve', 'main', 'params_shard_0.bin')).equals(shard), 'the mirror holds the pinned shard');
    const status = await cli('status');
    assert.match(status.stdout, /held \(3 of 3 files\)/);

    door = await mirrorDoor(good.base, files);
    const ask = `${door.url}?id=${ID}&rev=${REV}&file=params_shard_0.bin`;
    const server = { 'User-Agent': 'TOMLIN OS', Range: 'bytes=0-99' };
    const piece = await fetchRaw(ask, server);
    assert.equal(piece.status, 206);
    assert.ok(piece.body.equals(shard.subarray(0, 100)));
    // Browsers are refused, however they ask: a page's fetch, an address typed into a tab, anything not TOMLIN OS.
    assert.equal((await fetchRaw(ask, { ...server, 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'cross-site', Origin: 'https://someone.example' })).status, 403);
    assert.equal((await fetchRaw(ask, { ...server, 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Dest': 'document' })).status, 403);
    assert.equal((await fetchRaw(ask, { 'User-Agent': 'Mozilla/5.0' })).status, 403);
    assert.equal((await fetchRaw(`${door.url}?id=${ID}&rev=${'c'.repeat(40)}&file=params_shard_0.bin`, server)).status, 404, 'another version');
    assert.equal((await fetchRaw(`${door.url}?id=${ID}&rev=${REV}&file=../../secret`, server)).status, 404, 'only pinned files');
    assert.equal((await fetchRaw(`${door.url}?lib=${LIB}&rev=${LIBS_REV}`, server)).body.toString(), wasm.toString(), 'the program');

    // A TOMLIN OS server whose Hugging Face copy of the shard is gone: the save goes on from the mirror.
    const save = await php(gone.base, dir, `$plan = models_make_plan('${ID}');
$steps = [];
for ($i = 0; $i < 12; $i++) {
  $r = step(function () use (&$plan, $m) { return models_save_step($m, '${ID}', $plan, '${door.url}'); });
  $steps[] = $r;
  if (isset($r['error']) || $r['done']) break;
}
echo json_encode(['steps' => $steps, 'from' => array_column($plan['files'], 'from')]);`, { DESKTOP_MODELS_TEST_MIRROR: door.url });
    assert.deepEqual(save.from, ['upstream', 'mirror', 'upstream'], 'only the gone file went to the mirror');
    assert.match(save.steps.find((s: { mirror: string | null }) => s.mirror)?.mirror ?? '', /params_shard_0\.bin \(Hugging Face answered 404/);
    assert.equal(save.steps.at(-1).done, true, JSON.stringify(save.steps));
    assert.ok(readFileSync(join(dir, 'models', ID, 'resolve', 'main', 'params_shard_0.bin')).equals(shard), 'the shard arrived whole, from the mirror');

    // The daily share: this address has nearly used it, so the next piece is refused.
    const usage = JSON.parse(readFileSync(join(files, '.usage.json'), 'utf8'));
    usage.by['127.0.0.1'] = 8 * 1024 ** 3 - 50;
    writeFileSync(join(files, '.usage.json'), JSON.stringify(usage));
    const held = await fetchRaw(ask, server);
    assert.equal(held.status, 429);
    assert.match(held.body.toString(), /share .* today/);
  } finally {
    door?.proc.kill();
    good.server.close();
    gone.server.close();
  }
});

test('without a mirror, a file gone upstream stops the save with the reason; other bytes are tried upstream once more', { skip: noPhp }, async () => {
  const gone = await standIn({ gone: true, ranges: [] });
  const wrongMode: Mode = { wrongBytes: true, ranges: [] };
  const wrong = await standIn(wrongMode);
  const dir = mkdtempSync(join(tmpdir(), 'tomlinos-models-'));
  try {
    const run = (base: string, mirror: string) => php(base, dir, `$plan = models_make_plan('${ID}');
$steps = [];
for ($i = 0; $i < 6; $i++) {
  $r = step(function () use (&$plan, $m) { return models_save_step($m, '${ID}', $plan, '${mirror}'); });
  $steps[] = $r;
  if (isset($r['error']) || $r['done']) break;
}
echo json_encode(['steps' => $steps, 'from' => array_column($plan['files'], 'from')]);`);
    const stopped = await run(gone.base, '');
    assert.match(stopped.steps.at(-1).error, /answered 404 .* no TOMLIN OS mirror is set/);
    const twice = await run(wrong.base, 'http://127.0.0.1:9/');
    assert.deepEqual(twice.steps.filter((s: { changed: boolean }) => s.changed).map((s: { mirror: string | null }) => !!s.mirror), [false, true], 'the first miss retries upstream, the second goes to the mirror');
    assert.deepEqual(twice.from, ['upstream', 'mirror', 'upstream']);
  } finally {
    gone.server.close();
    wrong.server.close();
  }
});

test('a model removed can be saved again only a day later', { skip: noPhp }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tomlinos-models-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'tomlinos-models-'));
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
