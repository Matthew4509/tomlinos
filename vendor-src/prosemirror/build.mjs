// Bundles entry.js into ../../public/vendor/prosemirror.js (minified ES module) and gathers every package's licence
// into ../../public/vendor/prosemirror-LICENSES.txt, which the Credits page links to.
//   cd vendor-src/prosemirror && npm install && node build.mjs
import { build } from 'esbuild';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', '..', 'public', 'vendor');
mkdirSync(out, { recursive: true });

// TOMLIN OS's pages require Trusted Types with ONE policy (src/core/inert.ts). ProseMirror reads pasted HTML into a
// detached document (nothing in it runs or loads) and would make a policy of its own for that; this change lets the
// window hand it the desktop's own policy instead (setClipboardHtml). The build stops if the line it replaces changes.
const trustedPatch = {
  name: 'clipboard-trusted-types',
  setup(b) {
    b.onLoad({ filter: /prosemirror-view[\\/]dist[\\/]index\.js$/ }, async args => {
      const code = readFileSync(args.path, 'utf8');
      const from = 'function maybeWrapTrusted(html) {';
      if (!code.includes(from)) throw new Error('prosemirror-view changed: check the Trusted Types patch in build.mjs');
      const hook = 'let clipboardHtml = null;\nexport function setClipboardHtml(f) { clipboardHtml = f; }\n';
      return { contents: code.replace(from, `${hook}${from}\n    if (clipboardHtml) return clipboardHtml(html);`), loader: 'js' };
    });
  },
};

const result = await build({
  entryPoints: [join(here, 'entry.js')],
  plugins: [trustedPatch],
  mainFields: ['module', 'main'],
  bundle: true,
  format: 'esm',
  minify: true,
  target: 'es2022',
  legalComments: 'none',
  metafile: true,
  outfile: join(out, 'prosemirror.js'),
  banner: { js: '/* ProseMirror (MIT licence; see prosemirror-LICENSES.txt beside this file). Bundled for Write. */' },
});

// Every package that ended up in the bundle, with its version and licence text.
const used = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const m = /node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(input);
  if (m) used.add(m[1].replace(/\\/g, '/'));
}
const names = [...used].sort();
const info = names.map(name => {
  const dir = join(here, 'node_modules', name);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const file = readdirSync(dir).find(f => /^licen[cs]e/i.test(f));
  return { name, version: pkg.version, license: pkg.license, text: file ? readFileSync(join(dir, file), 'utf8').trim() : `Licence: ${pkg.license}` };
});
writeFileSync(join(out, 'prosemirror-LICENSES.txt'), info.map(p => `${p.name} ${p.version} (${p.license})\n${'-'.repeat(60)}\n${p.text}\n`).join('\n'));
writeFileSync(join(out, 'prosemirror-packages.json'), JSON.stringify(info.map(({ name, version, license }) => ({ name, version, license })), null, 1) + '\n');
console.log(`prosemirror.js ${(readFileSync(join(out, 'prosemirror.js')).length / 1024).toFixed(0)} KB, ${names.length} packages`);
