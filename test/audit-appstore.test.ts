// Audit of the app store's server side (server/lib/appstore.php): hostile zips, tampered catalogues, two changes at once,
// a download killed part-way, and versions going backwards. Each test makes its own throw-away data folder, web root and
// store folder (DESKTOP_APPSTORE_DIR) and signs its own catalogue with a key made here (DESKTOP_APPSTORE_KEY); nothing
// leaves this computer. Tests marked todo are P1 findings: they fail now and pass once fixed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PHP, extFlags, hasPhp } from './php-bin.ts';

const root = join(import.meta.dirname, '..');
const noPhp = !hasPhp && 'no PHP';
const FLAGS = () => extFlags('zip', 'openssl', 'sodium');

interface Srv { base: string; data: string; web: string; zips: string }
function server(): Srv {
  const base = mkdtempSync(join(tmpdir(), 'tomlinos-audit-apps-'));
  const s = { base, data: join(base, 'data'), web: join(base, 'web'), zips: join(base, 'zips') };
  for (const d of [s.data, s.web, s.zips]) mkdirSync(d, { recursive: true });
  return s;
}
const done = (s: Srv) => rmSync(s.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });

/** Builds a zip with PHP's ZipArchive (names kept exactly as given). `random` adds that many incompressible files. */
function appZip(s: Srv, id: string, files: Record<string, string>, version = '1.0', random = 0, randomSize = 16384): Record<string, unknown> {
  const path = join(s.zips, `${id}-${version}.zip`);
  const r = spawnSync(PHP, [...FLAGS(), '-r', `$z = new ZipArchive(); $z->open(getenv('ZIP'), ZipArchive::CREATE | ZipArchive::OVERWRITE); foreach (json_decode(getenv('F'), true) as $n => $b) { $z->addFromString($n, $b); } for ($i = 0; $i < (int) getenv('N'); $i++) { $z->addFromString("r/f$i.txt", random_bytes((int) getenv('SZ'))); $z->setCompressionName("r/f$i.txt", ZipArchive::CM_STORE); } $z->close();`],
    { env: { ...process.env, ZIP: path, F: JSON.stringify(files), N: String(random), SZ: String(randomSize) }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const sha = createHash('sha256').update(readFileSync(path)).digest('hex');
  return { id, title: id, icon: 'app', kind: 'games', version, size: [640, 480], sha256: sha, zips: [`https://example.com/${id}-${version}.zip`] };
}

function run(s: Srv, code: string, env: Record<string, string> = {}): string {
  const r = spawnSync(PHP, [...FLAGS(), '-r', `require 'server/lib/appstore.php'; $data = getenv('DATA'); $web = getenv('WEB'); try { ${code} } catch (RuntimeException $e) { echo 'ERR ', $e->getMessage(); }`],
    { cwd: root, env: { ...process.env, DATA: s.data, WEB: s.web, DESKTOP_APPSTORE_DIR: s.zips, ...env }, encoding: 'utf8' });
  return (r.stdout + r.stderr).trim();
}
const download = (app: Record<string, unknown>) => `echo appstore_download(json_decode(${JSON.stringify(JSON.stringify(app))}, true), $data, $web)['id'];`;
const here = (s: Srv): Record<string, { version: string }> => JSON.parse(run(s, 'echo json_encode((object) appstore_here($data, $web));'));

/** A store signed with a key made here: {catalogue, sig} written to the store folder; returns the public half. */
const keys = generateKeyPairSync('ed25519');
const PUBLIC = keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
function publish(s: Srv, payload: unknown, key = keys.privateKey): void {
  const bytes = Buffer.from(JSON.stringify(payload));
  writeFileSync(join(s.zips, 'catalogue.json'), JSON.stringify({ catalogue: bytes.toString('base64'), sig: sign(null, bytes, key).toString('base64') }));
}
const catalogue = (s: Srv) => run(s, `echo json_encode(array_map(fn ($a) => $a['id'] . '@' . $a['version'], appstore_catalogue([])));`, { DESKTOP_APPSTORE_KEY: PUBLIC });

// ---- Path escapes and names a web server could run --------------------------------------------------

test('a zip entry that climbs out of its folder (../, a/../.., /abs, C:/, backslashes) is refused and nothing lands outside', { skip: noPhp }, () => {
  const s = server();
  try {
    for (const bad of ['../up.html', 'a/../../up.html', '/abs.html', 'C:/x.html', 'a\\..\\..\\x.html', 'js/./x.js', '.htaccess', 'js/.hidden.js']) {
      const r = run(s, download(appZip(s, 'climb', { 'index.html': 'x', [bad]: 'escaped' })));
      assert.match(r, /^ERR .*not allowed in an app/, `${bad}: ${r}`);
    }
    assert.deepEqual(readdirSync(join(s.web, 'apps')), ['.htaccess'], 'nothing unpacked');
    assert.deepEqual(readdirSync(s.web), ['apps']);
    assert.deepEqual(here(s), {});
  } finally { done(s); }
});

test('a file whose name a host could run as a script anywhere after its first dot is refused', { skip: noPhp }, () => {
  const names = { 'game.php.js': false, 'game.PHP8.js': false, 'x.phtml': false, 'x.phar.png': false, 'x.shtml': false, 'x.cgi.js': false,
    'x.html.': false, 'x.js ': false, 'x.js:stream': false, 'index.html': true, 'js/game.min.js': true, 'img/a-b_c.png': true };
  const out = JSON.parse(spawnSync(PHP, ['-r', `require 'server/lib/appstore.php'; $o = []; foreach (json_decode(getenv('N'), true) as $n => $_) { $o[$n] = appstore_allowed_name($n); } echo json_encode($o);`],
    { cwd: root, env: { ...process.env, N: JSON.stringify(names) }, encoding: 'utf8' }).stdout);
  assert.deepEqual(out, names);
});

// ---- Tampered catalogues and zips ------------------------------------------------------------------

test('a catalogue changed after signing, signed by another key, or with a cut signature is refused', { skip: noPhp }, () => {
  const s = server();
  try {
    const app = appZip(s, 'tetris', { 'index.html': 'T' });
    publish(s, { made: '2026-11-01', apps: [app] });
    assert.equal(catalogue(s), '["tetris@1.0"]');
    const good = JSON.parse(readFileSync(join(s.zips, 'catalogue.json'), 'utf8'));
    const payload = Buffer.from(JSON.stringify({ made: '2026-11-01', apps: [{ ...app, sha256: 'b'.repeat(64) }] })).toString('base64');
    writeFileSync(join(s.zips, 'catalogue.json'), JSON.stringify({ catalogue: payload, sig: good.sig }));
    assert.match(catalogue(s), /^ERR .*not signed/);
    publish(s, { apps: [app] }, generateKeyPairSync('ed25519').privateKey);
    assert.match(catalogue(s), /^ERR .*not signed/);
    writeFileSync(join(s.zips, 'catalogue.json'), JSON.stringify({ catalogue: good.catalogue, sig: good.sig.slice(0, 40) }));
    assert.match(catalogue(s), /^ERR .*not signed/);
  } finally { done(s); }
});

test('a zip changed by one byte after signing is not unpacked, and leaves no download or folder behind', { skip: noPhp }, () => {
  const s = server();
  try {
    const app = appZip(s, 'tetris', { 'index.html': 'T' });
    const file = join(s.zips, 'tetris-1.0.zip');
    const bytes = readFileSync(file);
    bytes[bytes.length - 30] ^= 1;
    writeFileSync(file, bytes);
    assert.match(run(s, download(app)), /^ERR .*fingerprint/);
    assert.deepEqual(readdirSync(join(s.web, 'apps')), ['.htaccess']);
    assert.deepEqual(readdirSync(s.data).filter(n => !n.endsWith('.lock')), []);
  } finally { done(s); }
});

// ---- Two changes at once ----------------------------------------------------------------------------

function runAsync(s: Srv, code: string): Promise<string> {
  return new Promise(resolve => {
    const p = spawn(PHP, [...FLAGS(), '-r', `require 'server/lib/appstore.php'; $data = getenv('DATA'); $web = getenv('WEB'); try { ${code} } catch (RuntimeException $e) { echo 'ERR ', $e->getMessage(); }`],
      { cwd: root, env: { ...process.env, DATA: s.data, WEB: s.web, DESKTOP_APPSTORE_DIR: s.zips } });
    let out = '';
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (out += d));
    p.on('close', () => resolve(out.trim()));
  });
}

test('four downloads and a delete at once: each ends whole, the list names every app that is there and no other', { skip: noPhp, timeout: 120000 }, async () => {
  const s = server();
  try {
    const a = appZip(s, 'alpha', { 'index.html': 'A' }, '1.0', 200, 4096);
    const b = appZip(s, 'bravo', { 'index.html': 'B' }, '1.0', 200, 4096);
    const c = appZip(s, 'charlie', { 'index.html': 'C' });
    assert.equal(run(s, download(c)), 'charlie');
    const results = await Promise.all([
      runAsync(s, download(a)), runAsync(s, download(b)), runAsync(s, download(a)), runAsync(s, download(b)),
      runAsync(s, `appstore_delete('charlie', $data, $web); echo 'deleted';`),
    ]);
    assert.deepEqual(results, ['alpha', 'bravo', 'alpha', 'bravo', 'deleted']);
    assert.deepEqual(Object.keys(here(s)).sort(), ['alpha', 'bravo']);
    assert.equal(readdirSync(join(s.web, 'apps', 'alpha', 'r')).length, 200);
    assert.deepEqual(readdirSync(join(s.web, 'apps')).sort(), ['.htaccess', 'alpha', 'bravo']);
  } finally { done(s); }
});

// ---- Killed part-way (P1 findings) ------------------------------------------------------------------

test('AS-P1-2: a download killed part-way leaves no 40 MB zip in the data folder nor a half folder in apps/ once the next store change has run',
  { skip: noPhp, todo: 'P1', timeout: 180000 }, async () => {
    const s = server();
    try {
      const big = appZip(s, 'big', { 'index.html': 'B' }, '1.0', 2400, 16384);
      const small = appZip(s, 'small', { 'index.html': 'S' });
      const p = spawn(PHP, [...FLAGS(), '-r', `require 'server/lib/appstore.php'; appstore_download(json_decode(getenv('APP'), true), getenv('DATA'), getenv('WEB'));`],
        { cwd: root, env: { ...process.env, DATA: s.data, WEB: s.web, DESKTOP_APPSTORE_DIR: s.zips, APP: JSON.stringify(big) }, stdio: 'ignore' });
      // Killed while unpacking: once its half-made folder is there.
      const deadline = Date.now() + 60000;
      while (!existsSync(join(s.web, 'apps', 'big.new', 'r')) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
      p.kill('SIGKILL');
      await new Promise(r => p.once('close', r));
      assert.ok(readdirSync(s.data).some(n => /^appstore-download-.*\.zip$/.test(n)), 'the kill came too late to test (no download left)');
      assert.equal(run(s, download(small)), 'small');
      assert.deepEqual(readdirSync(s.data).filter(n => n.endsWith('.zip')), [], 'the killed download\'s zip is still in the data folder');
      assert.ok(!existsSync(join(s.web, 'apps', 'big.new')), 'the killed half folder is still served from apps/big.new/');
    } finally { done(s); }
  });

test('AS-P1-3: killed between moving the old copy aside and putting the new one in, the app comes back rather than vanishing for everyone',
  { skip: noPhp, todo: 'P1' }, () => {
    const s = server();
    try {
      assert.equal(run(s, download(appZip(s, 'tetris', { 'index.html': 'one' }))), 'tetris');
      // The state appstore_download_locked leaves if stopped right after rename($final, $old).
      renameSync(join(s.web, 'apps', 'tetris'), join(s.web, 'apps', 'tetris.old'));
      assert.deepEqual(Object.keys(here(s)), ['tetris'], 'the app is gone from the server although its whole old copy is still there');
    } finally { done(s); }
  });

// ---- Versions going backwards (P1 findings) -----------------------------------------------------

test('AS-P1-1a: an older version is never put over a newer one already on the server', { skip: noPhp, todo: 'P1' }, () => {
  const s = server();
  try {
    assert.equal(run(s, download(appZip(s, 'tetris', { 'index.html': 'two' }, '2.0'))), 'tetris');
    const r = run(s, download(appZip(s, 'tetris', { 'index.html': 'one' }, '1.0')));
    assert.equal(here(s).tetris.version, '2.0', `1.0 was put over 2.0 (${r})`);
  } finally { done(s); }
});

test('AS-P1-1b: an old signed catalogue served again after a newer one has been read is refused (replay of a withdrawn version)',
  { skip: noPhp, todo: 'P1' }, () => {
    const s = server();
    try {
      const v1 = appZip(s, 'tetris', { 'index.html': 'one' }, '1.0');
      const v2 = appZip(s, 'tetris', { 'index.html': 'two' }, '2.0');
      publish(s, { made: '2026-11-20T00:00:00Z', apps: [v2] });
      assert.equal(catalogue(s), '["tetris@2.0"]');
      publish(s, { made: '2026-10-01T00:00:00Z', apps: [v1] });
      assert.match(catalogue(s), /^ERR /, 'a catalogue older than one already read was believed');
    } finally { done(s); }
  });

test('AS-P1-4: a store app may not take a built-in app\'s id (the desktop hides it, so the owner can never delete it from the server)',
  { skip: noPhp, todo: 'P1' }, () => {
    const s = server();
    try {
      const r = run(s, download(appZip(s, 'terminal', { 'index.html': 'fake' })));
      assert.match(r, /^ERR /, 'a store app named "terminal" was put on the server');
    } finally { done(s); }
  });

