// Bundles entry.js into ../../public/vendor/codemirror.js (minified ES module) and gathers every package's licence
// into ../../public/vendor/codemirror-LICENSES.txt, which the Credits page links to.
//   cd vendor-src/codemirror && npm install && node build.mjs
import { build } from 'esbuild';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', '..', 'public', 'vendor');
mkdirSync(out, { recursive: true });

// TOMLIN OS's pages forbid inline <style> (style-src 'self'). style-mod puts CodeMirror's styles in a <style> tag for the
// main document and only uses a constructed style sheet (which the rule allows) inside shadow roots. This one change
// makes it use the constructed sheet for the document too; every current browser supports document.adoptedStyleSheets.
// The build stops if the line it replaces ever changes, rather than shipping an editor with no styles.
const styleModPatch = {
  name: 'style-mod-adopted-sheets',
  setup(b) {
    b.onLoad({ filter: /style-mod[\\/]src[\\/]style-mod\.js$/ }, async args => {
      const code = readFileSync(args.path, 'utf8');
      const from = 'if (!root.head && root.adoptedStyleSheets && win.CSSStyleSheet) {';
      if (!code.includes(from)) throw new Error('style-mod changed: check the adoptedStyleSheets patch in build.mjs');
      return { contents: code.replace(from, 'if (root.adoptedStyleSheets && win.CSSStyleSheet) {'), loader: 'js' };
    });
  },
};

const result = await build({
  entryPoints: [join(here, 'entry.js')],
  plugins: [styleModPatch],
  mainFields: ['module', 'main'],
  bundle: true,
  format: 'esm',
  minify: true,
  target: 'es2022',
  legalComments: 'none',
  metafile: true,
  outfile: join(out, 'codemirror.js'),
  banner: { js: '/* CodeMirror 6 and Lezer (MIT licence; see codemirror-LICENSES.txt beside this file). Bundled for TOMLIN OS Notepad Pro. */' },
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
writeFileSync(join(out, 'codemirror-LICENSES.txt'), info.map(p => `${p.name} ${p.version} (${p.license})\n${'-'.repeat(60)}\n${p.text}\n`).join('\n'));
writeFileSync(join(out, 'codemirror-packages.json'), JSON.stringify(info.map(({ name, version, license }) => ({ name, version, license })), null, 1) + '\n');
console.log(`codemirror.js ${(readFileSync(join(out, 'codemirror.js')).length / 1024).toFixed(0)} KB, ${names.length} packages`);
