// Bundles WebLLM (Apache-2.0, the MLC team) into ../../public/vendor/webllm.js, one ES module, with its licence beside
// it. The Assistant loads it only when someone chooses the on-device AI.
//   cd vendor-src/webllm && npm install && node build.mjs
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', '..', 'public', 'vendor');
mkdirSync(out, { recursive: true });
await build({
  stdin: { contents: "export { CreateMLCEngine, MLCEngine, prebuiltAppConfig, hasModelInCache, deleteModelAllInfoInCache } from '@mlc-ai/web-llm';", resolveDir: here, loader: 'js' },
  bundle: true,
  format: 'esm',
  minify: true,
  target: 'es2022',
  legalComments: 'none',
  outfile: join(out, 'webllm.js'),
  banner: { js: '/* WebLLM by the MLC team (Apache-2.0; see webllm-LICENSE.txt beside this file). Bundled for the TOMLIN OS Assistant. */' },
});
const pkg = JSON.parse(readFileSync(join(here, 'node_modules', '@mlc-ai', 'web-llm', 'package.json'), 'utf8'));
writeFileSync(join(out, 'webllm-LICENSE.txt'), `@mlc-ai/web-llm ${pkg.version} (${pkg.license})\n${'-'.repeat(60)}\n${readFileSync(join(here, 'node_modules', '@mlc-ai', 'web-llm', 'LICENSE'), 'utf8')}`);
writeFileSync(join(out, 'webllm-packages.json'), JSON.stringify([{ name: '@mlc-ai/web-llm', version: pkg.version, license: pkg.license }], null, 1) + '\n');
console.log(`webllm.js ${(readFileSync(join(out, 'webllm.js')).length / 1024).toFixed(0)} KB, version ${pkg.version}`);
