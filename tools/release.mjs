// Signs a built TOMLIN OS zip for System update: run AFTER npm run package.
//   node tools/release.mjs "What's new, in plain words for the owner"            sign it, and print the steps to send it
//   node tools/release.mjs "What's new, in plain words for the owner" --github   sign it and send it to GitHub as well
// Writes releases/latest.json (signed with the private release key, which never leaves this PC). The zip goes up as a
// GitHub release of this repository; latest.json is committed, so every TOMLIN OS with the updater reads it from GitHub and
// offers the new version in the Application manager, under Updates. The zip must be on GitHub before latest.json is.
// If a step fails after the release was made, put the zip up again with: gh release upload <tag> <zip> --clobber
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'Matthew4509/tomlinos';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// The private key's file, kept outside every repository: set TOMLINOS_RELEASE_KEY to its full path before running this.
const keyPath = process.env.TOMLINOS_RELEASE_KEY;
if (!keyPath || !existsSync(keyPath)) {
  throw new Error('The release key was not found. Set TOMLINOS_RELEASE_KEY to the full path of the private key file (.pem), then run this again.');
}
const args = process.argv.slice(2);
const github = args.includes('--github');
const notes = args.filter(a => a !== '--github').join(' ').trim();
if (!notes) throw new Error('Say what is new: node tools/release.mjs "What changed"');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const name = `tomlinos-${version}.zip`;
const zip = join(root, 'dist', name);
if (!existsSync(zip)) throw new Error(`${zip} is missing: run npm run package first.`);
const tag = `v${version}`;
const bytes = readFileSync(zip);
const payload = Buffer.from(JSON.stringify({
  version, date: new Date().toISOString().slice(0, 10), notes,
  zip: `https://github.com/${REPO}/releases/download/${tag}/${name}`, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
}));
const sig = sign(null, payload, createPrivateKey(readFileSync(keyPath)));
const latest = join(root, 'releases', 'latest.json');
mkdirSync(dirname(latest), { recursive: true });
writeFileSync(latest, JSON.stringify({ release: payload.toString('base64'), sig: sig.toString('base64') }) + '\n');
console.log(`Signed ${name}: ${latest}.`);

// The source goes up first, so the release's tag points at the commit the zip was built from.
const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const steps = [
  ['git', ['-C', root, 'push']],
  ['gh', ['release', 'create', tag, zip, '--repo', REPO, '--target', head, '--latest', '--title', `TOMLIN OS ${version}`, '--notes', notes]],
  ['git', ['-C', root, 'add', 'releases/latest.json']],
  ['git', ['-C', root, 'commit', '-m', `Release ${version}`]],
  ['git', ['-C', root, 'push']],
];
if (github) {
  for (const [cmd, a] of steps) execFileSync(cmd, a, { stdio: 'inherit' });
  console.log(`Sent. Every TOMLIN OS now offers ${version} (GitHub may take a few minutes to show the new note).`);
} else {
  console.log('\nTo send it (or run this again with --github):');
  for (const [cmd, a] of steps) console.log(`  ${cmd} ${a.map(x => (/[\s"]/.test(x) ? `"${x.replaceAll('"', '\\"')}"` : x)).join(' ')}`);
}
