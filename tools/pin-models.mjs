// Pins every AI model file TOMLIN OS fetches to one fixed, checked version, so a file changed or swapped upstream is never
// used: each built-in model to one commit of its Hugging Face repository (every file's size and SHA-256), and every
// WebGPU program (the part that runs as code) to one commit of the MLC team's GitHub folder (each program's SHA-256).
//   node tools/pin-models.mjs            asks Hugging Face and GitHub for the newest commits and pins those
//   node tools/pin-models.mjs --keep     keeps the commits already pinned; only fills in what is missing
// Writes server/lib/model-pins.json (read by the server, the mirror and tools/fetch-model.mjs) and rewrites the program
// addresses and checksums in src/apps/assistant/modellibs.ts. Downloads each program once (about 60 small files) and
// each model's small files; the large weight files are not downloaded: Hugging Face publishes their SHA-256.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PINS = join(root, 'server', 'lib', 'model-pins.json');
const LIBS_TS = join(root, 'src', 'apps', 'assistant', 'modellibs.ts');
const LIB_REPO = 'mlc-ai/binary-mlc-llm-libs';
const keep = process.argv.includes('--keep');
const old = existsSync(PINS) ? JSON.parse(readFileSync(PINS, 'utf8')) : { models: {}, libs: {} };

// The built-in models, from the server's catalog (one declaration: lib/models.php).
const php = readFileSync(join(root, 'server', 'lib', 'models.php'), 'utf8');
const catalog = [...php.matchAll(/'([A-Za-z0-9._-]+-MLC)' => \[\s*'name' => '[^']+',\s*'bytes' => \d+,\s*'repo' => '([^']+)',\s*'lib' => '([^']+)'/g)]
  .map(m => ({ id: m[1], repo: m[2], lib: m[3] }));
if (catalog.length < 3) throw new Error('Could not read MODEL_CATALOG from server/lib/models.php.');

async function get(url, kind = 'json') {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'TOMLIN OS pin-models' } });
      if (!res.ok) throw new Error(`${res.status} for ${url}`);
      return kind === 'json' ? await res.json() : Buffer.from(await res.arrayBuffer());
    } catch (error) {
      if (attempt >= 3) throw error;
      await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
}
const sha256 = buf => createHash('sha256').update(buf).digest('hex');
/** The same rule as models_make_plan used: only the kinds of file a model is made of. */
const modelFile = path => !path.startsWith('.') && /\.(bin|json|txt|wasm|model)$/.test(path);

const pins = { note: 'Written by tools/pin-models.mjs; do not edit by hand.', models: {}, libsCommit: '', libs: {} };

pins.libsCommit = keep && old.libsCommit ? old.libsCommit : (await get(`https://api.github.com/repos/${LIB_REPO}/commits/main`)).sha;
if (!/^[0-9a-f]{40}$/.test(pins.libsCommit)) throw new Error('GitHub gave no commit for the programs.');
console.log(`programs: ${LIB_REPO} at ${pins.libsCommit.slice(0, 10)}`);

for (const m of catalog) {
  const rev = keep && old.models?.[m.id]?.rev ? old.models[m.id].rev : (await get(`https://huggingface.co/api/models/${m.repo}`)).sha;
  if (!/^[0-9a-f]{40}$/.test(rev)) throw new Error(`Hugging Face gave no commit for ${m.repo}.`);
  const tree = await get(`https://huggingface.co/api/models/${m.repo}/tree/${rev}?recursive=1`);
  const files = [];
  for (const f of tree) {
    if (f.type !== 'file' || !modelFile(f.path)) continue;
    const known = old.models?.[m.id]?.rev === rev ? old.models[m.id].files.find(g => g.path === f.path) : null;
    let size = Number(f.lfs?.size ?? f.size);
    let hash = /^[0-9a-f]{64}$/.test(f.lfs?.oid ?? '') ? f.lfs.oid : known?.sha256;
    if (!hash) {
      // Not stored in LFS (the small config and tokenizer files): Hugging Face gives only a git hash, so fetch and hash it.
      const body = await get(`https://huggingface.co/${m.repo}/resolve/${rev}/${f.path.split('/').map(encodeURIComponent).join('/')}`, 'buffer');
      hash = sha256(body);
      size = body.length;
    }
    files.push({ path: f.path, size, sha256: hash });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  pins.models[m.id] = { repo: m.repo, rev, bytes: files.reduce((n, f) => n + f.size, 0), files };
  console.log(`${m.id}: ${rev.slice(0, 10)}, ${files.length} files`);
}

// Every program: the built-in models' and the table's (models people add from Hugging Face run on these).
const table = readFileSync(LIBS_TS, 'utf8');
const names = new Set([...catalog.map(m => m.lib), ...[...table.matchAll(/"lib": "([^"]+)"/g)].map(m => m[1])].map(u => u.split('/').pop()));
const folderOf = url => /web-llm-models\/(v0_2_\d+\/base)\//.exec(url)?.[1];
const folder = folderOf(catalog[0].lib);
if (!folder) throw new Error('Could not read the programs folder from the catalog.');
let n = 0;
for (const name of [...names].sort()) {
  const known = old.libsCommit === pins.libsCommit ? old.libs?.[name] : null;
  if (known) {
    pins.libs[name] = known;
  } else {
    const body = await get(`https://raw.githubusercontent.com/${LIB_REPO}/${pins.libsCommit}/web-llm-models/${folder}/${name}`, 'buffer');
    pins.libs[name] = { size: body.length, sha256: sha256(body) };
  }
  process.stdout.write(`\r  programs ${++n}/${names.size}`);
}
pins.libsFolder = folder;
writeFileSync(PINS, JSON.stringify(pins, null, 1) + '\n');
console.log(`\nWrote ${PINS}`);

// The table's addresses: pinned to the commit, each with its checksum.
const base = `https://raw.githubusercontent.com/${LIB_REPO}/`;
let rows = 0;
const pinned = table
  .replace(/"lib": "https:\/\/raw\.githubusercontent\.com\/mlc-ai\/binary-mlc-llm-libs\/[^/]+\/web-llm-models\/[^"]+\/([^"/]+)",(\s*)(?:"sha256": "[0-9a-f]{64}",\s*)?/g, (_, name, gap) => {
    rows++;
    return `"lib": "${base}${pins.libsCommit}/web-llm-models/${folder}/${name}",${gap}"sha256": "${pins.libs[name].sha256}",${gap}`;
  })
  .replace('export interface ModelLib { key: string; lib: string; vram: number; base: string; type: string; quant: string }',
    'export interface ModelLib { key: string; lib: string; sha256: string; vram: number; base: string; type: string; quant: string }');
writeFileSync(LIBS_TS, pinned);
console.log(`Pinned ${rows} programs in ${LIBS_TS}`);
