// Gathers the licence of every part that goes into TOMLIN Sheets, for Help > Licences and for a plain-text notices
// file installed beside the program. Run by build-web.mjs; needs Rust and Cargo (it asks Cargo which libraries the
// Windows program is built from, and reads each one's own licence files).
//
//   sheets/web/licences.json                         what the Licences window shows (texts stored once each)
//   sheets/src-tauri/licences/THIRD-PARTY-NOTICES.txt  the same as plain text, installed with the program
//
// Covered: this program's own licence; the Rust standard library and every Rust library compiled in (from
// Cargo.lock, Windows only, the program's normal dependencies, including the ones used only while building, so none
// is missed); the NSIS installer; and Microsoft's parts it uses but does not ship (WebView2, the C runtime).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sheets = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(sheets, '..');
const tauriDir = join(sheets, 'src-tauri');
const TARGET = 'x86_64-pc-windows-msvc';

const texts = new Map();
/** Keeps a licence text once and returns its key. */
function keep(text) {
  const clean = text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim() + '\n';
  const key = createHash('sha256').update(clean).digest('hex').slice(0, 16);
  texts.set(key, clean);
  return key;
}

const LICENCE_FILE = /^(licen[cs]e|copying|copyright|notice|unlicense|authors)([-._ ].*)?$/i;
const sysroot = execFileSync('rustc', ['--print', 'sysroot'], { encoding: 'utf8' }).trim();
const rustLicences = join(sysroot, 'share', 'doc', 'rust', 'licenses');
/** Standard texts for a library that names a licence but ships no file for it. */
const STANDARD = { MIT: 'MIT.txt', 'Apache-2.0': 'Apache-2.0.txt', 'Unicode-3.0': 'Unicode-3.0.txt', 'BSD-2-Clause': 'BSD-2-Clause.txt', ISC: 'ISC.txt' };
/** The BSD 3-Clause licence as SPDX gives it; the copyright line names the library's authors. */
const BSD_3 = (who) => `Copyright (c) ${who}

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the
following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following
   disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following
   disclaimer in the documentation and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote
   products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES,
INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
`;
/** Licences whose text names no one: when a library ships no file, the text another library in the build ships. */
const SHARED = new Map();
function standardText(id, authors) {
  if (id === 'BSD-3-Clause') return BSD_3(authors.length ? authors.join(', ') : 'the authors');
  if (SHARED.has(id)) return SHARED.get(id);
  const file = STANDARD[id];
  if (!file || !existsSync(join(rustLicences, file))) return null;
  const body = readFileSync(join(rustLicences, file), 'utf8');
  return id === 'MIT' && authors.length ? `Copyright (c) ${authors.join(', ')}\n\n${body}` : body;
}

// ---- The Rust libraries -------------------------------------------------------------------------------------------

const meta = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--filter-platform', TARGET, '--features', 'custom-protocol', '--locked'], { cwd: tauriDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
const byId = new Map(meta.packages.map(p => [p.id, p]));
const nodes = new Map(meta.resolve.nodes.map(n => [n.id, n]));
const root = meta.resolve.root;
const used = new Set();
const queue = [root];
while (queue.length) {
  const id = queue.pop();
  if (used.has(id)) continue;
  used.add(id);
  for (const dep of nodes.get(id)?.deps ?? []) {
    // Normal dependencies only (build scripts and tests do not end up in the program); proc-macros are kept.
    if (dep.dep_kinds.some(k => k.kind === null)) queue.push(dep.pkg);
  }
}
used.delete(root);

// The Mozilla Public License text is the same for everyone who uses it: taken from a library here that ships it.
for (const id of used) {
  const p = byId.get(id);
  if (p.license !== 'MPL-2.0' || SHARED.has('MPL-2.0')) continue;
  const dir = dirname(p.manifest_path);
  const file = readdirSync(dir).find(n => LICENCE_FILE.test(n));
  if (file && /Mozilla Public License Version 2\.0/.test(readFileSync(join(dir, file), 'utf8'))) SHARED.set('MPL-2.0', readFileSync(join(dir, file), 'utf8'));
}

const missing = [];
const packages = [...used].map(id => byId.get(id)).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)).map(p => {
  const dir = dirname(p.manifest_path);
  const files = readdirSync(dir).filter(n => LICENCE_FILE.test(n) && statSync(join(dir, n)).isFile() && !/\.(rs|toml|sh|py)$/i.test(n));
  let keys = files.map(n => keep(readFileSync(join(dir, n), 'utf8')));
  const licence = p.license ?? (p.license_file ? 'see its licence file' : '');
  if (!keys.length) {
    const ids = [...new Set((licence.match(/[A-Za-z0-9.-]+/g) ?? []).filter(t => !/^(OR|AND|WITH)$/i.test(t)))];
    keys = ids.map(i => standardText(i, p.authors ?? [])).filter(Boolean).map(keep);
    if (!keys.length) missing.push(`${p.name} ${p.version} (${licence || 'no licence named'})`);
  }
  const mpl = /MPL-2\.0/.test(licence);
  return {
    name: p.name,
    version: p.version,
    licence,
    authors: (p.authors ?? []).map(a => a.replace(/\s*<[^>]*>/, '')),
    home: p.repository ?? p.homepage ?? `https://crates.io/crates/${p.name}`,
    // MPL-2.0 asks that people be told where the (unchanged) source is.
    source: mpl ? `https://crates.io/crates/${p.name}/${p.version} (unchanged; source code for exactly this version)` : undefined,
    texts: keys,
  };
});
if (missing.length) {
  console.error(`No licence text found for:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}

// ---- Everything else ----------------------------------------------------------------------------------------------

const own = readFileSync(join(repo, 'LICENSE'), 'utf8');
const rustVersion = execFileSync('rustc', ['--version'], { encoding: 'utf8' }).trim().split(' ')[1];
const rustNotice = existsSync(join(sysroot, 'share', 'doc', 'rust', 'COPYRIGHT-library.html'))
  ? readFileSync(join(sysroot, 'share', 'doc', 'rust', 'COPYRIGHT-library.html'), 'utf8').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n')
  : '';
const nsis = join(homedir(), 'AppData', 'Local', 'tauri', 'NSIS', 'COPYING');
if (!existsSync(nsis)) {
  console.error('The NSIS licence (tauri/NSIS/COPYING) is not on this computer: build the installer once first.');
  process.exit(1);
}
const main = [
  { name: 'TOMLIN Sheets', version: JSON.parse(readFileSync(join(tauriDir, 'tauri.conf.json'), 'utf8')).package.version, licence: 'PolyForm-Noncommercial-1.0.0', authors: ['TOMLIN OS'], home: 'https://github.com/Matthew4509/tomlinos', texts: [keep(own)], note: 'This program. Its spreadsheet is the TOMLIN OS spreadsheet.' },
  { name: 'Rust standard library', version: rustVersion, licence: 'MIT OR Apache-2.0', authors: ['The Rust Project Developers'], home: 'https://www.rust-lang.org', texts: [keep(readFileSync(join(rustLicences, 'MIT.txt'), 'utf8')), keep(readFileSync(join(rustLicences, 'Apache-2.0.txt'), 'utf8')), ...(rustNotice ? [keep(rustNotice)] : [])], note: 'Compiled into the program.' },
  { name: 'NSIS (Nullsoft Scriptable Install System)', version: '3', licence: 'Zlib (and others, listed in the text)', authors: ['NSIS Contributors'], home: 'https://nsis.sourceforge.io', texts: [keep(readFileSync(nsis, 'utf8'))], note: 'Makes the installer and the uninstaller.' },
  { name: 'Microsoft Edge WebView2 Runtime', version: '', licence: 'Microsoft Software License Terms', authors: ['Microsoft Corporation'], home: 'https://developer.microsoft.com/microsoft-edge/webview2/', texts: [keep('The WebView2 Runtime is part of Windows 11 and is installed on Windows 10 by Microsoft. TOMLIN Sheets does not include it: it uses the copy on the computer, and the installer asks Microsoft\'s own installer to add it where it is missing. It is used under Microsoft\'s licence terms for the WebView2 Runtime: https://developer.microsoft.com/microsoft-edge/webview2/\n')], note: 'Shows the program\'s window. Not included: part of Windows.' },
  { name: 'Microsoft C Runtime', version: '', licence: 'Microsoft Visual Studio distributable code', authors: ['Microsoft Corporation'], home: 'https://visualstudio.microsoft.com/license-terms/', texts: [keep('Parts of the Microsoft C runtime library are built into the program (as is usual for Windows programs), under the distributable-code terms of the Microsoft Visual Studio licence. They carry no further notice requirement.\n')], note: 'Built into the program.' },
];

// ---- Written out --------------------------------------------------------------------------------------------------

const all = { main, packages, texts: Object.fromEntries(texts) };
mkdirSync(join(sheets, 'web'), { recursive: true });
writeFileSync(join(sheets, 'web', 'licences.json'), JSON.stringify(all));

const line = '='.repeat(100);
const label = new Map([...texts.keys()].map((k, i) => [k, `Licence text ${i + 1}`]));
const describe = p => [
  `${p.name}${p.version ? ' ' + p.version : ''}`,
  `  Licence: ${p.licence}`,
  p.authors.length ? `  By: ${p.authors.join(', ')}` : null,
  `  Home: ${p.home}`,
  p.source ? `  Source: ${p.source}` : null,
  p.note ? `  ${p.note}` : null,
  `  Text: ${p.texts.map(k => label.get(k)).join(', ')}`,
].filter(Boolean).join('\n');
const notices = [
  'TOMLIN Sheets: licences and notices',
  '',
  'TOMLIN Sheets is made by TOMLIN OS and licensed under the PolyForm Noncommercial License 1.0.0. It is built with',
  'the open-source parts listed below, each under its own licence. The full text of every licence follows the list;',
  'where a part names a choice of licences ("MIT OR Apache-2.0"), it is used under either, and both texts are given.',
  'The same list is in the program, under Help > Licences.',
  '',
  line,
  'Main parts',
  line,
  ...main.map(p => describe(p) + '\n'),
  line,
  `Rust libraries compiled into the program (${packages.length})`,
  line,
  ...packages.map(p => describe(p) + '\n'),
  line,
  'Licence texts',
  line,
  ...[...texts].map(([k, t]) => `---- ${label.get(k)} ${'-'.repeat(80)}\n\n${t}`),
].join('\n');
mkdirSync(join(tauriDir, 'licences'), { recursive: true });
writeFileSync(join(tauriDir, 'licences', 'THIRD-PARTY-NOTICES.txt'), notices.replace(/\n/g, '\r\n'));
console.log(`Licences: ${packages.length} Rust libraries + ${main.length} main parts, ${texts.size} distinct texts`);
