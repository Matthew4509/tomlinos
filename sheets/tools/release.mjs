// Makes a TOMLIN Sheets release: builds the page, builds and signs the program and its installer, checks every
// shipped byte for private details, and writes sheets/latest.json, the update list installed copies read.
//
//   node sheets/tools/release.mjs            build, check, copy to sheets/dist/<version>/, write latest.json
//   node sheets/tools/release.mjs --test-feed http://127.0.0.1:8790/latest.json
//                                            the same, but the program reads that address for updates (a local test
//                                            build; never publish it), and dist/<version>-test/ is used
//
// The update signing key is read from TAURI_PRIVATE_KEY / TAURI_KEY_PASSWORD, or from the folder sheets/release.local.json
// names as "secrets" (updater.key and updater.key.password, kept outside every repository). That file, which git
// ignores, also names the private list ("privateList") and the words that must never ship (see disclosure below).
// Publishing is two steps afterwards (RELEASING.md): attach the two files to a GitHub release named sheets-v<version>,
// then commit and push sheets/latest.json. Installed copies see the new version once latest.json is on GitHub.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const sheets = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(sheets, '..');
const tauriDir = join(sheets, 'src-tauri');
const args = process.argv.slice(2);
const testFeed = args.includes('--test-feed') ? args[args.indexOf('--test-feed') + 1] : null;

const testVersion = testFeed && args.includes('--test-version') ? args[args.indexOf('--test-version') + 1] : null;
const conf = JSON.parse(readFileSync(join(tauriDir, 'tauri.conf.json'), 'utf8'));
const version = testVersion ?? conf.package.version;
const cargoVersion = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(join(tauriDir, 'Cargo.toml'), 'utf8'))?.[1];
if (!testVersion && cargoVersion !== version) throw new Error(`tauri.conf.json says ${version} but Cargo.toml says ${cargoVersion}: make them the same.`);
const notes = testVersion ? `- Test build ${testVersion}, made to try the update on this computer.` : releaseNotes(version);
const TAG = `sheets-v${version}`;
const RELEASES = 'https://github.com/Matthew4509/tomlinos/releases/download';

/** The lines under "## <version>" in CHANGES.md: shown in the update box. */
function releaseNotes(v) {
  const text = readFileSync(join(sheets, 'CHANGES.md'), 'utf8');
  const m = new RegExp(`^## ${v.replace(/\./g, '\\.')}\\b[^\\n]*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm').exec(text);
  if (!m || !m[1].trim()) throw new Error(`CHANGES.md has no "## ${v}" section: write what is new first.`);
  return m[1].trim();
}

/** This computer's own settings for releases (sheets/release.local.json, never committed); {} when there are none. */
const local = existsSync(join(sheets, 'release.local.json')) ? JSON.parse(readFileSync(join(sheets, 'release.local.json'), 'utf8')) : {};

function key() {
  if (process.env.TAURI_PRIVATE_KEY) return { key: process.env.TAURI_PRIVATE_KEY, password: process.env.TAURI_KEY_PASSWORD ?? '' };
  const dir = local.secrets ?? '';
  if (!dir || !existsSync(join(dir, 'updater.key'))) throw new Error('No update signing key: set TAURI_PRIVATE_KEY (and TAURI_KEY_PASSWORD), or name its folder as "secrets" in sheets/release.local.json.');
  return { key: readFileSync(join(dir, 'updater.key'), 'utf8'), password: readFileSync(join(dir, 'updater.key.password'), 'utf8').trim() };
}

// ---- 1. The page, then the program --------------------------------------------------------------------------------

const skipBuild = args.includes('--skip-build');
if (!skipBuild) execFileSync(process.execPath, [join(sheets, 'tools', 'build-web.mjs')], { stdio: 'inherit' });

const signing = key();
// Paths of this computer are left out of the program (Rust keeps source paths for its error messages); the C runtime
// is built in, as .cargo/config.toml says (these flags replace that file's, so it is repeated here).
// CARGO_ENCODED_RUSTFLAGS keeps a folder name with spaces in one piece (RUSTFLAGS splits at spaces); the last match
// wins, so the repository comes after the home folder it is inside.
const rustflags = ['-C', 'target-feature=+crt-static', `--remap-path-prefix=${homedir()}=~`, `--remap-path-prefix=${repo}=tomlinos`].join('\x1f');
const buildArgs = ['tauri', 'build'];
// A test build reads updates from the test address (built in through the test-feed feature, which a release never has).
if (testFeed) buildArgs.push('--features', 'test-feed');
if (testVersion) buildArgs.push('--config', JSON.stringify({ package: { version: testVersion } }));
if (!skipBuild) execFileSync('cargo', buildArgs, {
  cwd: tauriDir,
  stdio: 'inherit',
  env: { ...process.env, CARGO_ENCODED_RUSTFLAGS: rustflags, TAURI_PRIVATE_KEY: signing.key, TAURI_KEY_PASSWORD: signing.password, TOMLIN_SHEETS_TEST_FEED: testFeed ?? '' },
});

// ---- 2. What was made ---------------------------------------------------------------------------------------------

const bundle = join(tauriDir, 'target', 'release', 'bundle', 'nsis');
const setup = `${conf.package.productName}_${version}_x64-setup.exe`;
const zip = `${setup.replace(/\.exe$/, '')}.nsis.zip`;
for (const f of [setup, zip, `${zip}.sig`]) if (!existsSync(join(bundle, f))) throw new Error(`The build did not make ${f}.`);

const out = join(sheets, 'dist', testFeed ? `${version}-test` : version);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const setupName = `TOMLIN-Sheets-Setup-${version}.exe`;
const zipName = `TOMLIN-Sheets-${version}-x64.nsis.zip`;
copyFileSync(join(bundle, setup), join(out, setupName));
copyFileSync(join(bundle, zip), join(out, zipName));
const signature = readFileSync(join(bundle, `${zip}.sig`), 'utf8').trim();

// ---- 3. Nothing private ships -------------------------------------------------------------------------------------

const problems = disclosure([join(sheets, 'web'), join(out, setupName), join(tauriDir, 'target', 'release', `${conf.package.productName}.exe`)]);
if (problems.length) {
  for (const p of problems) console.error(`  ${p}`);
  console.error(`\nRelease stopped: ${problems.length} finding(s). Nothing was written to latest.json.`);
  process.exit(1);
}

// ---- 4. The update list -------------------------------------------------------------------------------------------

const feed = {
  version,
  notes,
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  platforms: {
    'windows-x86_64': {
      signature,
      url: testFeed ? new URL(zipName, testFeed).href : `${RELEASES}/${TAG}/${zipName}`,
    },
  },
};
writeFileSync(testFeed ? join(out, 'latest.json') : join(sheets, 'latest.json'), JSON.stringify(feed, null, 2) + '\n');

const mb = n => `${(n / 1048576).toFixed(1)} MB`;
console.log(`\nTOMLIN Sheets ${version}${testFeed ? ' (TEST build, reads ' + testFeed + ')' : ''}`);
console.log(`  ${relative(repo, join(out, setupName))}  ${mb(statSync(join(out, setupName)).size)}  (the installer people download)`);
console.log(`  ${relative(repo, join(out, zipName))}  ${mb(statSync(join(out, zipName)).size)}  (what updates download)`);
console.log(`  ${testFeed ? relative(repo, join(out, 'latest.json')) : 'sheets/latest.json'}  (the update list)`);
console.log('  Disclosure check: clean');
if (!testFeed) console.log(`\nTo publish: GitHub release "${TAG}" with both files attached, then commit and push sheets/latest.json (RELEASING.md).`);

// ---- The check ----------------------------------------------------------------------------------------------------

/**
 * Private details, this computer's paths, and whatever else this computer's own list names (other projects, words
 * that must never ship), in text and in programs. The lists stay on this computer: written here, the words to look
 * for would themselves be published with the script.
 */
function disclosure(targets) {
  const user = homedir().split(/[\\/]/).pop();
  const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rules = [['a local path of this PC', new RegExp(`[A-Za-z]:[\\\\/]{1,2}Users[\\\\/]{1,2}${escape(user)}\\b`, 'i')]];
  // { "private": [{ "label": "...", "value": "..." }] }: only the labels are ever printed.
  if (local.privateList && existsSync(local.privateList)) {
    for (const e of JSON.parse(readFileSync(local.privateList, 'utf8')).private ?? []) {
      const v = String(e.value ?? '').trim();
      if (v.length < 4 || /^FILL/i.test(v)) continue;
      rules.push([`[${e.label ?? 'a private value'}]`, new RegExp(escape(v).replace(/\s+/g, '\\s+'), 'i')]);
    }
  } else {
    console.warn('  (no private list named in release.local.json: private details not checked)');
  }
  for (const name of local.otherProjects ?? []) {
    rules.push([`another project's name '${name}'`, new RegExp(`(?<![\\w-])${escape(name).replace(/\s+/g, '[\\s_-]?')}(?![\\w-])`, 'i')]);
  }
  // { "label": "...", "pattern": "...", "flags": "i" }: anything else this computer says must never ship.
  for (const p of local.patterns ?? []) rules.push([p.label, new RegExp(p.pattern, p.flags ?? '')]);
  if (!local.otherProjects && !local.patterns) console.warn('  (no release.local.json: other projects and the never-ship words not checked)');
  const found = [];
  const files = targets.flatMap(t => (statSync(t).isDirectory() ? walk(t) : [t]));
  for (const file of files) {
    const bytes = readFileSync(file);
    // Programs hold text both as bytes and as two-byte Windows strings: both are read, from either byte. Always an
    // even number of bytes: Node 24 ends the whole process without a word on an odd-length UTF-16 decode.
    const even = (from) => bytes.subarray(from, from + ((bytes.length - from) & ~1)).toString('utf16le');
    const texts = [bytes.toString('latin1'), even(0), even(1)];
    for (const [what, rx] of rules) if (texts.some(t => rx.test(t))) found.push(`${relative(repo, file)}: ${what}`);
  }
  return found;
}

function walk(dir) {
  return readdirSync(dir).flatMap(n => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
}
