// Publishes an app to the TOMLIN OS app store: run on the PC that holds the private release key.
//   node tools/store-publish.mjs <id> "What's new, in plain words"            prepare it, and print the steps to send it
//   node tools/store-publish.mjs <id> "What's new" --github                   prepare it and send it to GitHub as well
//   node tools/store-publish.mjs <id> "What's new" --out <folder>             a whole store in one folder (the tests)
// The app is appstore-src/<id>/ (plain web files, index.html first) with its details in appstore-src/<id>.app.json
// ({title, icon, kind: games|office|system, version, size}); raise "version" there for each new release.
// It writes dist/store/<id>-<version>.zip and appstore/catalogue.json: every app's entry, signed with the release key
// (TOMLINOS_RELEASE_KEY = the private key file's full path; it never leaves this PC). Every TOMLIN OS reads that catalogue from
// GitHub and offers the app in the Application manager.
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeZip } from './zip.mjs';

const REPO = 'Matthew4509/Tomlinos';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = name => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const [, value] = args.splice(i, 2);
  return value ?? '';
};
const out = flag('--out');
const github = args.includes('--github');
if (github) args.splice(args.indexOf('--github'), 1);
const [id, ...words] = args;
const notes = words.join(' ').trim();
if (!id || !/^[a-z][a-z0-9]{1,30}$/.test(id)) throw new Error('Name the app: node tools/store-publish.mjs <id> "What\'s new" (the id is lower-case letters and digits).');
if (!notes) throw new Error('Say what is new: node tools/store-publish.mjs ' + id + ' "What changed"');
const keyPath = process.env.TOMLINOS_RELEASE_KEY;
if (!keyPath || !existsSync(keyPath)) {
  throw new Error('The release key was not found. Set TOMLINOS_RELEASE_KEY to the full path of the private key file (.pem), then run this again.');
}
const folder = join(root, 'appstore-src', id);
const detailsFile = join(root, 'appstore-src', `${id}.app.json`);
if (!existsSync(join(folder, 'index.html'))) throw new Error(`appstore-src/${id}/index.html is missing.`);
if (!existsSync(detailsFile)) throw new Error(`appstore-src/${id}.app.json is missing (title, icon, kind, version, size).`);
const details = JSON.parse(readFileSync(detailsFile, 'utf8'));
if (!/^\d+\.\d+(\.\d+)?$/.test(String(details.version ?? ''))) throw new Error(`Give appstore-src/${id}.app.json a "version" like 1.0.`);

const file = `${id}-${details.version}.zip`;
const tag = `app-${id}-${details.version}`;
const zipDir = out ?? join(root, 'dist', 'store');
mkdirSync(zipDir, { recursive: true });
const zipPath = join(zipDir, file);
writeZip(folder, zipPath);
const bytes = readFileSync(zipPath);

// The catalogue keeps every other app's entry as it was; this app's entry is replaced.
const cataloguePath = out ? join(out, 'catalogue.json') : join(root, 'appstore', 'catalogue.json');
let apps = [];
if (existsSync(cataloguePath)) {
  const signed = JSON.parse(readFileSync(cataloguePath, 'utf8'));
  apps = JSON.parse(Buffer.from(signed.catalogue, 'base64').toString('utf8')).apps ?? [];
}
apps = apps.filter(a => a.id !== id);
apps.push({
  id, title: String(details.title ?? id), icon: String(details.icon ?? 'app'), kind: String(details.kind ?? 'office'),
  version: String(details.version), date: new Date().toISOString().slice(0, 10), notes,
  bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), size: details.size ?? [960, 640],
  zips: [`https://github.com/${REPO}/releases/download/${tag}/${file}`],
});
apps.sort((a, b) => a.id.localeCompare(b.id));
const payload = Buffer.from(JSON.stringify({ made: new Date().toISOString().slice(0, 10), apps }));
const sig = sign(null, payload, createPrivateKey(readFileSync(keyPath)));
mkdirSync(dirname(cataloguePath), { recursive: true });
writeFileSync(cataloguePath, JSON.stringify({ catalogue: payload.toString('base64'), sig: sig.toString('base64') }) + '\n');
console.log(`Signed ${details.title} ${details.version}: ${zipPath} and ${cataloguePath}.`);
if (out) process.exit(0);

const steps = [
  ['gh', ['release', 'create', tag, zipPath, '--repo', REPO, '--title', `${details.title} ${details.version}`, '--notes', notes]],
  ['git', ['-C', root, 'add', 'appstore/catalogue.json', `appstore-src/${id}`, `appstore-src/${id}.app.json`]],
  ['git', ['-C', root, 'commit', '-m', `App store: ${details.title} ${details.version}`]],
  ['git', ['-C', root, 'push']],
];
if (github) {
  for (const [cmd, a] of steps) execFileSync(cmd, a, { stdio: 'inherit' });
  console.log(`Sent. Every TOMLIN OS now offers ${details.title} ${details.version} (GitHub may take a few minutes to show the new list).`);
} else {
  console.log('\nTo send it (or run this again with --github):');
  for (const [cmd, a] of steps) console.log(`  ${cmd} ${a.map(x => (/\s/.test(x) ? `"${x}"` : x)).join(' ')}`);
}
