// Puts an on-device AI model onto this TOMLIN OS: downloads its files (from Hugging Face, where the WebLLM project
// publishes them) and its small WebGPU program into models/, which the server hands to signed-in people only
// (api/modelfile.php). After this, the Assistant needs no other site: the model comes from TOMLIN OS itself.
//   node tools/fetch-model.mjs               all three built-in models, Qwen 3.5 0.8B (about 430 MB), Gemma 2 2B
//                                            (about 1.4 GB) and Qwen 3.5 4B (about 2.2 GB); the only ones the Assistant
//                                            offers
//   node tools/fetch-model.mjs <id>          just that one
//   node tools/fetch-model.mjs --list        the ids WebLLM knows (small ones first), for testing others
// The built-in models come at their pinned versions (server/lib/model-pins.json), every file checked against its
// SHA-256; any other id comes as it is now on Hugging Face, unchecked (for testing only).
// Files already here with the right size are skipped, so an interrupted download carries on where it stopped.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const models = join(root, 'models');
const webllm = await import(pathToFileURL(join(root, 'vendor-src', 'webllm', 'node_modules', '@mlc-ai', 'web-llm', 'lib', 'index.js')).href).catch(() => null);
if (!webllm) {
  console.error('Run "npm install" in vendor-src/webllm first (it holds the list of models and their files).');
  process.exit(1);
}
const list = webllm.prebuiltAppConfig.model_list;
const args = process.argv.slice(2);
if (!args.length) args.push('Qwen3.5-0.8B-q4f32_1-MLC', 'gemma-2-2b-it-q4f32_1-MLC', 'Qwen3.5-4B-q4f32_1-MLC');
if (args[0] === '--list') {
  for (const m of [...list].sort((a, b) => (a.vram_required_MB ?? 1e9) - (b.vram_required_MB ?? 1e9))) console.log(`${m.model_id.padEnd(52)} ~${Math.round(m.vram_required_MB ?? 0)} MB of graphics memory`);
  process.exit(0);
}

const pins = JSON.parse(readFileSync(join(root, 'server', 'lib', 'model-pins.json'), 'utf8'));
const fileSha = file => new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  createReadStream(file).on('data', d => hash.update(d)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
});

async function download(url, file, size, sha256) {
  if (existsSync(file) && (size === undefined || statSync(file).size === size)) return false;
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(file + '.part'));
      if (size !== undefined && statSync(file + '.part').size !== size) throw new Error('size does not match');
      if (sha256 && (await fileSha(file + '.part')) !== sha256) {
        unlinkSync(file + '.part');
        throw new Error('not the pinned version (SHA-256 differs); not kept');
      }
      renameSync(file + '.part', file);
      return true;
    } catch (error) {
      if (attempt >= 4) throw new Error(`${url}: ${error.message}`);
      console.log(`  retrying ${url.split('/').pop()} (${error.message})`);
    }
  }
}

const indexPath = join(models, 'models.json');
const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : { models: [] };
for (const id of args) {
  const entry = list.find(m => m.model_id === id);
  if (!entry) {
    console.error(`${id}: not a model WebLLM knows. Try --list.`);
    process.exit(1);
  }
  const repo = entry.model.replace(/^https:\/\/huggingface\.co\//, '').replace(/\/$/, '');
  const pin = pins.models[id];
  const rev = pin ? pin.rev : 'main';
  let files;
  if (pin) {
    console.log(`${id}: the pinned version ${rev.slice(0, 10)}`);
    files = pin.files;
  } else {
    console.log(`${id}: not a built-in model, so not pinned: asking Hugging Face for the file list...`);
    const info = await (await fetch(`https://huggingface.co/api/models/${repo}/tree/main`)).json();
    files = info.filter(f => f.type === 'file' && !/^\.|README|LICENSE$/i.test(f.path) || /^(LICENSE|README\.md)$/.test(f.path));
  }
  let got = 0;
  let bytes = 0;
  for (const f of files) {
    bytes += f.size;
    // Kept as <id>/resolve/main/<file>, the layout WebLLM asks for, so any plain web server can hand them out.
    if (await download(`https://huggingface.co/${repo}/resolve/${rev}/${f.path}`, join(models, id, 'resolve', 'main', f.path), f.size, f.sha256)) got++;
    process.stdout.write(`\r  ${files.indexOf(f) + 1}/${files.length} files`);
  }
  const libName = entry.model_lib.split('/').pop();
  const libPin = pin ? pins.libs[libName] : null;
  const libUrl = libPin ? `https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/${pins.libsCommit}/web-llm-models/${pins.libsFolder}/${libName}` : entry.model_lib;
  await download(libUrl, join(models, 'libs', libName), libPin?.size, libPin?.sha256);
  console.log(`\n  ${got} downloaded, ${files.length - got} already here; ${(bytes / 1048576).toFixed(0)} MB, program ${libName}`);
  index.models = index.models.filter(m => m.id !== id);
  index.models.push({ id, lib: libName, bytes, vram: Math.round(entry.vram_required_MB ?? 0), context: entry.overrides?.context_window_size ?? null, overrides: entry.overrides ?? {}, ...(pin ? { rev, libSha256: libPin.sha256 } : {}) });
}
writeFileSync(indexPath, JSON.stringify(index, null, 1) + '\n');
// On a live cPanel host the folder is uploaded as tomlinos/models/ (beside data/, outside public_html); this file travels
// with it. The same text as models_ensure_htaccess() in server/lib/models.php.
writeFileSync(join(models, '.htaccess'), [
  '# TOMLIN OS on-device AI models. This folder is outside the web root; if a host ever serves it, refuse.',
  '# Signed-in people get these files through api/modelfile.php.',
  'Require all denied',
  '',
].join('\n'));
console.log(`Written ${indexPath}`);
