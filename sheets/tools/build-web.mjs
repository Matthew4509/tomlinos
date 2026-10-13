// Builds the page TOMLIN Sheets shows into sheets/web/: starts from host/main.ts, follows its imports into the
// TOMLIN OS sources, and strips the TypeScript types from exactly those files (no bundler, as the desktop's own
// build). Imports written only for types, and the desktop apps the spreadsheet never loads, are left out.
// Run from the repository folder:  node sheets/tools/build-web.mjs
import { execFileSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFolder } from '../../tools/check-owner-quotes.mjs';

const sheets = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(sheets, '..');
const out = join(sheets, 'web');

/** "./x.ts" -> "./x.js" in import/export-from/dynamic import. Only relative specifiers are touched. */
function rewriteImports(code) {
  return code
    .replace(/(\bfrom\s*)(['"])(\.{1,2}\/[^'"]+)\.ts\2/g, '$1$2$3.js$2')
    .replace(/(\bimport\s*)(['"])(\.{1,2}\/[^'"]+)\.ts\2/g, '$1$2$3.js$2')
    .replace(/(\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\.ts\2/g, '$1$2$3.js$2');
}

/** The relative modules a file needs when it runs: type-only imports are erased, so they are not followed. */
function runtimeImports(code) {
  const found = [];
  for (const m of code.matchAll(/^\s*(?:import|export)\s+([^;]*?)\s+from\s*['"](\.{1,2}\/[^'"]+)['"]/gms)) {
    if (/^type\s/.test(m[1])) continue;
    found.push(m[2]);
  }
  for (const m of code.matchAll(/^\s*import\s*['"](\.{1,2}\/[^'"]+)['"]/gm)) found.push(m[1]);
  return found;
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const seen = new Set();
const queue = [join(sheets, 'host', 'main.ts')];
while (queue.length) {
  const file = queue.pop();
  if (seen.has(file)) continue;
  if (!existsSync(file)) throw new Error(`${relative(repo, file)} is imported but not there.`);
  seen.add(file);
  const source = readFileSync(file, 'utf8');
  for (const spec of runtimeImports(source)) queue.push(join(dirname(file), spec));
  const code = stripTypeScriptTypes(source, { mode: 'strip' });
  if (/\b(enum|namespace)\s+\w+\s*\{/.test(code)) throw new Error(`${relative(repo, file)}: enums and namespaces are not allowed.`);
  const target = join(out, 'app', relative(repo, file).replace(/\.ts$/, '.js'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, rewriteImports(code));
}

copyFileSync(join(repo, 'public', 'style.css'), join(out, 'style.css'));
copyFileSync(join(sheets, 'page', 'sheets.css'), join(out, 'sheets.css'));
copyFileSync(join(sheets, 'page', 'index.html'), join(out, 'index.html'));
copyFileSync(join(sheets, 'src-tauri', 'icons', '128x128.png'), join(out, 'icon.png'));

// Every part's licence, for Help > Licences and the notices file installed with the program (tools/licences.mjs).
execFileSync(process.execPath, [join(sheets, 'tools', 'licences.mjs')], { stdio: 'inherit' });

// Comments ship as written: none may quote or cite the person who asked for the code.
const quotes = checkFolder(out, { release: true });
if (quotes.length) {
  for (const q of quotes) console.error(`${q.file}:${q.line}  ${q.what}\n    ${q.text}`);
  console.error(`\nBuild stopped: ${quotes.length} comment(s) quote or cite the owner.`);
  process.exit(1);
}
const files = [...seen].map(f => relative(repo, f).split(sep).join('/')).sort();
console.log(`Built ${files.length} modules into ${relative(process.cwd(), out) || 'web'}`);
