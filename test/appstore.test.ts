// The app store's catalogue entries as the server keeps them: names and notes survive (cut to length, with or without
// the mbstring extension), and an entry without a safe id, version, fingerprint or https address is dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PHP, extFlags, hasPhp } from './php-bin.ts';

const root = join(import.meta.dirname, '..');
const noPhp = !hasPhp && 'no PHP';
const SHA = 'a'.repeat(64);

function clean(entries: unknown[], noExtensions = false): unknown[] {
  const code = `require 'server/lib/appstore.php'; echo json_encode(array_map('appstore_clean_app', json_decode(getenv('ENTRIES'), true)), JSON_UNESCAPED_UNICODE);`;
  const r = spawnSync(PHP, [...(noExtensions ? ['-n'] : []), '-r', code], { cwd: root, env: { ...process.env, ENTRIES: JSON.stringify(entries) }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const entry = { id: 'officeprinter', title: 'Office Printer', icon: 'printer', kind: 'games', version: '1.0', date: '2026-10-10', notes: 'First release', bytes: 5, sha256: SHA, zips: ['https://example.com/a.zip'] };

test('a catalogue entry keeps its name, date and notes, cut to length by characters', { skip: noPhp }, () => {
  for (const bare of [false, true]) {
    const [kept, long] = clean([entry, { ...entry, title: 'É'.repeat(70), notes: 'x'.repeat(2100) }], bare) as Array<Record<string, any>>;
    assert.equal(kept.title, 'Office Printer', bare ? 'without mbstring' : 'with mbstring');
    assert.equal(kept.date, '2026-10-10');
    assert.equal(kept.notes, 'First release');
    assert.equal(long.title, 'É'.repeat(60));
    assert.equal(long.notes.length, 2000);
  }
});

test('an entry without a safe id, version, fingerprint or https address is dropped', { skip: noPhp }, () => {
  assert.deepEqual(clean([
    { ...entry, id: '../x' }, { ...entry, version: 'one' }, { ...entry, sha256: 'nope' }, { ...entry, zips: ['http://example.com/a.zip'] }, 'text',
  ]), [null, null, null, null, null]);
});

// ---- Downloading and deleting apps on a throw-away server --------------------

/** A throw-away data folder, web root and folder of app zips (DESKTOP_APPSTORE_DIR stands in for the download address). */
function server(): { base: string; data: string; web: string; zips: string } {
  const base = mkdtempSync(join(tmpdir(), 'tomlinos-apps-'));
  const s = { base, data: join(base, 'data'), web: join(base, 'web'), zips: join(base, 'zips') };
  for (const d of [s.data, s.web, s.zips]) mkdirSync(d, { recursive: true });
  return s;
}
/** Makes the app's zip with PHP's ZipArchive; `count` adds that many tiny files. Returns the catalogue entry for it. */
function appZip(s: { zips: string }, id: string, files: Record<string, string>, count = 0): Record<string, unknown> {
  const path = join(s.zips, `${id}.zip`);
  const r = spawnSync(PHP, [...extFlags('zip'), '-r', `$z = new ZipArchive(); $z->open(getenv('ZIP'), ZipArchive::CREATE | ZipArchive::OVERWRITE); foreach (json_decode(getenv('F'), true) as $n => $b) { $z->addFromString($n, $b); } for ($i = 0; $i < (int) getenv('N'); $i++) { $z->addFromString("f$i.txt", 'x'); } $z->close();`],
    { env: { ...process.env, ZIP: path, F: JSON.stringify(files), N: String(count) }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const sha = createHash('sha256').update(readFileSync(path)).digest('hex');
  return { id, title: id, icon: 'app', kind: 'games', version: '1.0', size: [640, 480], sha256: sha, zips: [`https://example.com/${id}.zip`] };
}
function store(s: { data: string; web: string; zips: string }, code: string): string {
  const r = spawnSync(PHP, [...extFlags('zip', 'openssl'), '-r', `require 'server/lib/appstore.php'; $data = getenv('DATA'); $web = getenv('WEB'); try { ${code} } catch (RuntimeException $e) { echo 'ERR ', $e->getMessage(); }`],
    { cwd: root, env: { ...process.env, DATA: s.data, WEB: s.web, DESKTOP_APPSTORE_DIR: s.zips }, encoding: 'utf8' });
  return (r.stdout + r.stderr).trim();
}
const download = (app: Record<string, unknown>) => `echo appstore_download(json_decode(${JSON.stringify(JSON.stringify(app))}, true), $data, $web)['id'];`;
const here = (s: { data: string; web: string; zips: string }) => JSON.parse(store(s, 'echo json_encode(array_keys(appstore_here($data, $web)));'));

test('two apps downloaded one after the other are both listed, each in its own folder, with nothing left over', { skip: noPhp }, () => {
  const s = server();
  try {
    assert.equal(store(s, download(appZip(s, 'tetris', { 'index.html': 'T', 'js/game.js': 'g' }))), 'tetris');
    assert.equal(store(s, download(appZip(s, 'snake', { 'index.html': 'S' }))), 'snake');
    assert.deepEqual(here(s).sort(), ['snake', 'tetris']);
    assert.equal(readFileSync(join(s.web, 'apps', 'tetris', 'js', 'game.js'), 'utf8'), 'g');
    assert.deepEqual(readdirSync(join(s.web, 'apps')).sort(), ['.htaccess', 'snake', 'tetris'], 'no .new, .old or .deleting folders');
    assert.deepEqual(readdirSync(s.data).filter(n => n.endsWith('.zip') || n.endsWith('.tmp')), [], 'no downloads or half-written lists');
    assert.equal(store(s, `appstore_delete('tetris', $data, $web); echo 'ok';`), 'ok');
    assert.deepEqual(here(s), ['snake']);
    assert.ok(!existsSync(join(s.web, 'apps', 'tetris')));
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test('when the list of apps cannot be saved, the copy that was there before is kept, folder and list alike', { skip: noPhp }, () => {
  const s = server();
  try {
    assert.equal(store(s, download(appZip(s, 'tetris', { 'index.html': 'version one' }))), 'tetris');
    const list = join(s.data, 'appstore.json');
    const saved = readFileSync(list);
    rmSync(list);
    mkdirSync(list); // a folder where the list must be written: saving it fails
    writeFileSync(join(list, 'x'), '');
    const r = store(s, download({ ...appZip(s, 'tetris', { 'index.html': 'version two' }), version: '2.0' }));
    assert.match(r, /^ERR .*could not be added to the list .*copy that was there before was kept/);
    assert.equal(readFileSync(join(s.web, 'apps', 'tetris', 'index.html'), 'utf8'), 'version one');
    rmSync(list, { recursive: true });
    writeFileSync(list, saved);
    assert.deepEqual(here(s), ['tetris']);
    assert.deepEqual(readdirSync(join(s.web, 'apps')).sort(), ['.htaccess', 'tetris']);
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test('an app zip is checked from its own list before unpacking: too many files, a file type not allowed, or no index.html', { skip: noPhp }, () => {
  const s = server();
  try {
    assert.match(store(s, download(appZip(s, 'many', { 'index.html': 'x' }, 3001))), /^ERR .*far bigger than an app may be/);
    assert.match(store(s, download(appZip(s, 'sneaky', { 'index.html': 'x', 'run.php': '<?php' }))), /^ERR .*not allowed in an app \(run\.php\)/);
    assert.match(store(s, download(appZip(s, 'blank', { 'readme.txt': 'x' }))), /^ERR .*has no index\.html/);
    assert.deepEqual(here(s), []);
    assert.deepEqual(readdirSync(join(s.web, 'apps')).sort(), ['.htaccess'], 'nothing unpacked');
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});
