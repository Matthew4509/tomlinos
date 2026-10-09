// Builds the desktop into out/: strips the TypeScript types with Node's own tool (no bundler, no outside code),
// rewrites the ".ts" import endings to ".js", copies public/, and writes storage.json saying "browser" (a static copy
// keeps its files in the browser; the dev server and the live server answer /storage.json themselves).
// Run from the repository folder:  npm run build
import { stripTypeScriptTypes } from 'node:module';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { checkFolder } from './check-owner-quotes.mjs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cspValue, outsideSources, why } from './headers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'out');

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

/** "./x.ts" -> "./x.js" in import/export-from/dynamic import. Only relative specifiers are touched. */
function rewriteImports(code) {
  return code
    .replace(/(\bfrom\s*)(['"])(\.{1,2}\/[^'"]+)\.ts\2/g, '$1$2$3.js$2')
    .replace(/(\bimport\s*)(['"])(\.{1,2}\/[^'"]+)\.ts\2/g, '$1$2$3.js$2')
    .replace(/(\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\.ts\2/g, '$1$2$3.js$2');
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'app'), { recursive: true });

let count = 0;
for (const file of walk(join(root, 'src'))) {
  if (!file.endsWith('.ts')) continue;
  const rel = relative(join(root, 'src'), file).replace(/\.ts$/, '.js');
  const target = join(out, 'app', rel);
  mkdirSync(dirname(target), { recursive: true });
  const code = stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'strip' });
  const leftover = /\b(enum|namespace)\s+\w+\s*\{/.exec(code);
  if (leftover) throw new Error(`${rel}: enums and namespaces are not allowed (types must be erasable).`);
  writeFileSync(target, rewriteImports(code));
  count++;
}

cpSync(join(root, 'public'), out, { recursive: true });
// The page's security policy comes from security-headers.json (the one list), never typed into index.html by hand.
const indexPath = join(out, 'index.html');
const page = readFileSync(indexPath, 'utf8');
if (!page.includes('content="__CSP__"')) throw new Error('public/index.html lost its __CSP__ placeholder.');
for (const src of outsideSources()) if (!why[src]) throw new Error(`security-headers.json: ${src} has no reason in "why".`);
writeFileSync(indexPath, page.replace('content="__CSP__"', `content="${cspValue({ meta: true })}"`));
writeFileSync(join(out, 'storage.json'), JSON.stringify({ backend: 'browser' }) + '\n');
// The version About shows (and an update check can compare against), from package.json.
writeFileSync(join(out, 'version.json'), JSON.stringify({ version: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version }) + '\n');
// Comments ship as written, so none may quote or cite the person who asked for the code (tools/check-owner-quotes.mjs).
const quotes = [...checkFolder(out, { release: true }), ...checkFolder(join(root, 'server')).map(q => ({ ...q, file: `server/${q.file}` }))];
if (quotes.length) {
  for (const q of quotes) console.error(`${q.file}:${q.line}  ${q.what}\n    ${q.text}`);
  console.error(`\nBuild stopped: ${quotes.length} comment(s) quote or cite the owner. Rewrite each as the reason for the code.`);
  process.exit(1);
}
console.log(`Built ${count} files into ${relative(process.cwd(), out) || 'out'}`);
