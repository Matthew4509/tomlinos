// Bundles WebLLM (Apache-2.0, the MLC team) into ../../public/vendor/webllm.js, one ES module, with its licence beside
// it. The Assistant loads it only when someone chooses the on-device AI.
//   cd vendor-src/webllm && npm install && node build.mjs
import { build } from 'esbuild';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', '..', 'public', 'vendor');
mkdirSync(out, { recursive: true });
const result = await build({
  stdin: { contents: "export { CreateMLCEngine, MLCEngine, prebuiltAppConfig, hasModelInCache, deleteModelAllInfoInCache } from '@mlc-ai/web-llm';", resolveDir: here, loader: 'js' },
  bundle: true,
  format: 'esm',
  minify: true,
  target: 'es2022',
  legalComments: 'none',
  metafile: true,
  outfile: join(out, 'webllm.js'),
  banner: { js: '/* WebLLM by the MLC team (Apache-2.0; see webllm-LICENSE.txt beside this file). Bundled for the TOMLIN OS Assistant. */' },
});
// Every package that ended up in the bundle (WebLLM and what it brings, such as loglevel), with its version and licence.
const used = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const m = /node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(input);
  if (m) used.add(m[1].replace(/\\/g, '/'));
}
const info = [...used].sort().map(name => {
  const dir = join(here, 'node_modules', name);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const file = readdirSync(dir).find(f => /^licen[cs]e/i.test(f));
  return { name, version: pkg.version, license: pkg.license, text: file ? readFileSync(join(dir, file), 'utf8').trim() : `Licence: ${pkg.license}` };
});
writeFileSync(join(out, 'webllm-LICENSE.txt'), info.map(p => `${p.name} ${p.version} (${p.license})\n${'-'.repeat(60)}\n${p.text}\n`).join('\n'));
writeFileSync(join(out, 'webllm-packages.json'), JSON.stringify(info.map(({ name, version, license }) => ({ name, version, license })), null, 1) + '\n');
console.log(`webllm.js ${(readFileSync(join(out, 'webllm.js')).length / 1024).toFixed(0)} KB, ${info.length} packages`);
