// Finds comments that quote or cite the person who commissioned this code: "(owner: "...")", "the owner, 30 Sep
// 2026: ...", "the owner's brief (date)", "his words", "verbatim", "he asked". The build keeps comments (it only
// strips types), so any such line ships in the release zip and anyone can read it. Comments give the reason for the
// code, never who asked for it or what they said.
//   node tools/check-owner-quotes.mjs                 checks src/, server/ (not vendor/), public/ and tools/
//   node tools/check-owner-quotes.mjs <folder|zip>    checks a built folder or a release zip
// Exits 1 and lists every line when it finds one. tools/build.mjs runs it on everything it builds.
// "The owner" on its own is fine: it is a role in the product (the desktop's owner), not a person.
import { readdirSync, readFileSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { join, extname, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CODE = new Set(['.ts', '.js', '.mjs', '.cjs', '.php', '.css', '.html', '.json', '.md', '.sh', '.cmd']);
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'texts', '.git', 'dist', 'labs']);
// This file describes the patterns it looks for, so it would find itself.
const SKIP_FILES = new Set(['check-owner-quotes.mjs']);
const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*';
const DATE = `\\d{1,2} ${MONTH} \\d{4}`;

/** Each: what it catches, and the pattern. Checked on comment text only (see commentText). */
export const RULES = [
  ['a quote attributed to the owner', new RegExp(`\\bowner\\b(?:,?\\s*${DATE})?\\s*[:,]\\s*["“']`, 'i')],
  ['the owner cited by date', new RegExp(`\\bowner(?:'s)?\\b[^.;]{0,24}${DATE}`, 'i')],
  ['a dated note (who said it, when)', new RegExp(`\\(\\s*(?:[a-z' ]+,\\s*)?${DATE}\\s*[):]`, 'i')],
  ['"his words" / "the owner\'s brief"', /\b(?:his|owner's) (?:own )?(?:words|brief|request|rule|instructions?|picks?|answers?|call)\b/i],
  ['"verbatim"', /\bverbatim\b/i],
  ['what he said or asked', /\bhe (?:said|asked|wrote|reported|wants|wanted|picked|chose|hates|likes|typed|tested)\b/i],
  ['his instruction by name', /\bhis (?:test|report|fault|idea)\b/i],
];

/** The comment part of one line of code: // and # line comments, and lines inside or starting a block comment. */
function commentText(line, state) {
  const t = line.trim();
  if (state.block || t.startsWith('/*') || t.startsWith('<!--')) {
    state.block = !/\*\/|-->/.test(t);
    return t;
  }
  if (t.startsWith('*')) return t;
  const m = line.match(/(?:^|[^:'"`\\])(\/\/|#)\s(.*)$/);
  return m ? m[2] : '';
}

export function checkText(text, name, ext) {
  const found = [];
  const prose = ext === '.md';
  const state = { block: false };
  text.split(/\r?\n/).forEach((line, i) => {
    const c = prose ? line : commentText(line, state);
    if (!c) return;
    for (const [what, re] of RULES) {
      if (re.test(c)) { found.push({ file: name, line: i + 1, what, text: line.trim().slice(0, 160) }); break; }
    }
  });
  return found;
}

function walk(dir, root, out) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) walk(path, root, out); continue; }
    const ext = extname(name).toLowerCase();
    if (SKIP_FILES.has(name) || !CODE.has(ext) || st.size > 3_000_000) continue;
    // Markdown in the repo is the owner's own notes (README, handoffs); only a release's .md files are checked.
    if (ext === '.md' && !out.release) continue;
    out.found.push(...checkText(readFileSync(path, 'utf8'), relative(root, path).replace(/\\/g, '/'), ext));
  }
}

export function checkFolder(dir, { release = false } = {}) {
  const out = { found: [], release };
  walk(dir, dir, out);
  return out.found;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const repo = resolve(fileURLToPath(import.meta.url), '../..');
  const target = process.argv[2];
  let found = [];
  let temp = null;
  if (!target) {
    for (const d of ['src', 'server', 'public', 'tools']) found.push(...checkFolder(join(repo, d)).map(f => ({ ...f, file: `${d}/${f.file}` })));
  } else if (target.toLowerCase().endsWith('.zip')) {
    temp = mkdtempSync(join(tmpdir(), 'owner-quotes-'));
    // Windows' own tar reads zips (Git's tar does not understand C:\ paths); elsewhere, unzip.
    if (process.platform === 'win32') execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', resolve(target), '-C', temp]);
    else execFileSync('unzip', ['-q', resolve(target), '-d', temp]);
    found = checkFolder(temp, { release: true });
  } else {
    found = checkFolder(resolve(target), { release: true });
  }
  if (temp) rmSync(temp, { recursive: true, force: true });
  for (const f of found) console.log(`${f.file}:${f.line}  ${f.what}\n    ${f.text}`);
  console.log(found.length ? `\n${found.length} comment(s) quote or cite the owner. Rewrite each as the reason for the code.` : 'No comments quote or cite the owner.');
  process.exit(found.length ? 1 : 0);
}
