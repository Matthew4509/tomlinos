// System update: where each entry of a release zip lands, and which ones are never written. Runs the real
// server/lib/updater.php with PHP (PHP_BIN, or php on the PATH).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PHP, extFlags, hasPhp } from './php-bin.ts';

const root = join(import.meta.dirname, '..');
const noPhp = !hasPhp && 'no PHP';

function targets(names: string[]): Array<string | null> {
  const code = `require 'server/lib/updater.php'; $p = update_private_dir();
echo json_encode(array_map(fn ($n) => ($t = update_target($n, '/web')) === null ? null : str_replace($p, 'PRIVATE', $t), json_decode(getenv('NAMES'), true)));`;
  const r = spawnSync(PHP, ['-r', code], { cwd: root, env: { ...process.env, NAMES: JSON.stringify(names) }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('a release zip lands where the package puts it: web files in the web root, the rest in the private folder', { skip: noPhp }, () => {
  // The private folder's name in the zip comes from tools/package.mjs: the updater must use the same one.
  const folder = /const priv = join\(stage, '([a-z]+)'\);/.exec(readFileSync(join(root, 'tools', 'package.mjs'), 'utf8'))?.[1];
  assert.ok(folder, 'tools/package.mjs names the private folder');
  assert.deepEqual(targets([
    'public_html/index.html', 'public_html/api/auth.php', `${folder}/VERSION`, `${folder}/lib/auth.php`, `${folder}/api/store.php`,
  ]), ['/web/index.html', '/web/api/auth.php', 'PRIVATE/VERSION', 'PRIVATE/lib/auth.php', 'PRIVATE/api/store.php']);
});

test('an update never writes people\'s things or anything outside the two folders', { skip: noPhp }, () => {
  assert.deepEqual(targets([
    'tomlinos/config.php', 'tomlinos/data/.lock', 'tomlinos/models/x.bin', 'tomlinos/apps/game/index.html', 'tomlinos/update/backup.zip',
    'public_html/../x.php', 'tomlinos/lib/..\\x', 'README.md', 'tomlinos/lib/', 'other/VERSION', '',
  ]), [null, null, null, null, null, null, null, null, null, null, null]);
});

// ---- Installing and going back on a throw-away pair of folders ----------

/** Runs PHP with updater.php loaded, the zip extension on, $priv and $web set to throw-away folders. */
function run(code: string, priv: string, web: string): { ok: boolean; out: string } {
  const r = spawnSync(PHP, [...extFlags('zip'), '-r', `require 'server/lib/updater.php'; $priv = getenv('PRIV'); $web = getenv('WEB'); ${code}`],
    { cwd: root, env: { ...process.env, PRIV: priv, WEB: web }, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout + r.stderr).trim() };
}
/** A release zip with these entries, made by PHP's own ZipArchive. */
function zipOf(entries: Record<string, string>, dir: string): string {
  const path = join(dir, `r-${Math.random().toString(16).slice(2)}.zip`);
  const r = spawnSync(PHP, [...extFlags('zip'), '-r', `$z = new ZipArchive(); $z->open(getenv('ZIP'), ZipArchive::CREATE); foreach (json_decode(getenv('E'), true) as $n => $b) { $z->addFromString($n, $b); } $z->close();`],
    { env: { ...process.env, ZIP: path, E: JSON.stringify(entries) }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return path;
}
function folders(): { base: string; priv: string; web: string } {
  const base = mkdtempSync(join(tmpdir(), 'tomlinos-update-'));
  const priv = join(base, 'tomlinos');
  const web = join(base, 'public_html');
  mkdirSync(join(priv, 'lib'), { recursive: true });
  mkdirSync(web, { recursive: true });
  writeFileSync(join(priv, 'VERSION'), '0.1.0\n');
  writeFileSync(join(priv, 'lib', 'a.php'), 'old a');
  writeFileSync(join(priv, 'config.php'), 'people settings');
  writeFileSync(join(web, 'index.html'), 'old page');
  return { base, priv, web };
}
const install = (zip: string) => `try { echo update_locked(fn ($d) => update_apply_zip(${JSON.stringify(zip)}, $web, $d, $priv), $priv); } catch (RuntimeException $e) { echo 'ERR ', $e->getMessage(); }`;
const RELEASE = { 'tomlinos/VERSION': '0.2.0\n', 'tomlinos/lib/a.php': 'new a', 'tomlinos/lib/b.php': 'new b', 'tomlinos/config.php': 'NOT WRITTEN', 'public_html/index.html': 'new page', 'public_html/js/x.js': 'new js' };

test('an install replaces every file, keeps people\'s things, keeps a backup, and leaves nothing half-done behind', { skip: noPhp }, () => {
  const f = folders();
  try {
    const r = run(install(zipOf(RELEASE, f.base)), f.priv, f.web);
    assert.equal(r.out, '0.2.0');
    assert.equal(readFileSync(join(f.priv, 'lib', 'b.php'), 'utf8'), 'new b');
    assert.equal(readFileSync(join(f.web, 'js', 'x.js'), 'utf8'), 'new js');
    assert.equal(readFileSync(join(f.priv, 'config.php'), 'utf8'), 'people settings');
    const left = readdirSync(join(f.priv, 'update'));
    assert.deepEqual(left.filter(n => !['.htaccess', '.lock', 'backup'].includes(n)), [], `no stage, download, backup.next or operation left: ${left}`);
    assert.equal(run('echo update_backup_version($priv);', f.priv, f.web).out, '0.1.0');

    // Go back: every file as it was, the added ones gone, the backup used up.
    assert.equal(run('echo update_rollback($priv);', f.priv, f.web).out, '0.1.0');
    assert.equal(readFileSync(join(f.web, 'index.html'), 'utf8'), 'old page');
    assert.equal(readFileSync(join(f.priv, 'lib', 'a.php'), 'utf8'), 'old a');
    assert.ok(!existsSync(join(f.priv, 'lib', 'b.php')) && !existsSync(join(f.web, 'js', 'x.js')), 'files the update added are removed');
    assert.equal(run('var_export(update_backup_version($priv));', f.priv, f.web).out, 'NULL');
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('a file that cannot be written puts the old version back, and the backup from the install before stays', { skip: noPhp }, () => {
  const f = folders();
  try {
    assert.equal(run(install(zipOf(RELEASE, f.base)), f.priv, f.web).out, '0.2.0');
    // 0.3.0 cannot write public_html/blocked (a folder stands there): it must undo itself, and 0.1.0 stays kept.
    mkdirSync(join(f.web, 'blocked'));
    writeFileSync(join(f.web, 'blocked', 'keep'), 'x');
    const r = run(install(zipOf({ 'tomlinos/VERSION': '0.3.0\n', 'tomlinos/lib/a.php': 'a three', 'public_html/blocked': 'nope' }, f.base)), f.priv, f.web);
    assert.match(r.out, /^ERR A file could not be written .*so 0\.2\.0 was put back/);
    assert.equal(readFileSync(join(f.priv, 'VERSION'), 'utf8'), '0.2.0\n');
    assert.equal(readFileSync(join(f.priv, 'lib', 'a.php'), 'utf8'), 'new a');
    assert.equal(run('echo update_backup_version($priv);', f.priv, f.web).out, '0.1.0', 'the earlier backup is not lost');
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('an install cut off part-way is undone by the next Go back (or update request), never left mixed', { skip: noPhp }, () => {
  const f = folders();
  try {
    // As a killed install leaves it: some files new, its backup and operation.json on disk.
    const upd = join(f.priv, 'update');
    mkdirSync(join(upd, 'backup.next'), { recursive: true });
    writeFileSync(join(upd, 'backup.next', 'f0'), '0.1.0\n');
    writeFileSync(join(upd, 'backup.next', 'manifest.json'), JSON.stringify({ version: '0.1.0', files: [{ path: join(f.priv, 'VERSION'), saved: 'f0' }, { path: join(f.web, 'added.js'), saved: null }] }));
    writeFileSync(join(upd, 'operation.json'), JSON.stringify({ op: 'install', started: 1 }));
    writeFileSync(join(f.priv, 'VERSION'), '0.2.0\n');
    writeFileSync(join(f.web, 'added.js'), 'half-installed');
    assert.equal(run('echo update_backup_version($priv);', f.priv, f.web).out, '0.1.0', 'Go back offers the version from before the cut-off install');
    assert.equal(run('echo update_rollback($priv);', f.priv, f.web).out, '0.1.0');
    assert.equal(readFileSync(join(f.priv, 'VERSION'), 'utf8'), '0.1.0\n');
    assert.ok(!existsSync(join(f.web, 'added.js')));
    assert.ok(!existsSync(join(upd, 'operation.json')) && !existsSync(join(upd, 'backup.next')));
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('a cut-off install leaves no half-copied file behind, nor its unpacked files or download', { skip: noPhp }, () => {
  const f = folders();
  try {
    // As a kill between copying and renaming leaves it: page.html.new beside page.html, the stage and the download.
    const upd = join(f.priv, 'update');
    mkdirSync(join(upd, 'backup.next'), { recursive: true });
    mkdirSync(join(upd, 'stage-dead'), { recursive: true });
    writeFileSync(join(upd, 'stage-dead', 'f0'), 'x');
    writeFileSync(join(upd, 'download-dead.zip'), 'x');
    writeFileSync(join(upd, 'backup.next', 'f0'), 'old page');
    writeFileSync(join(upd, 'backup.next', 'manifest.json'), JSON.stringify({ version: '0.1.0', files: [{ path: join(f.web, 'index.html'), saved: 'f0' }, { path: join(f.web, 'api.php'), saved: null }] }));
    writeFileSync(join(upd, 'operation.json'), JSON.stringify({ op: 'install', started: 1 }));
    writeFileSync(join(f.web, 'index.html.new'), 'half a new pa');
    writeFileSync(join(f.web, 'api.php.new'), '<?php half');
    assert.equal(run('echo update_rollback($priv);', f.priv, f.web).out, '0.1.0');
    assert.ok(!existsSync(join(f.web, 'index.html.new')) && !existsSync(join(f.web, 'api.php.new')), 'no .new copies left in the web root');
    assert.deepEqual(readdirSync(upd).filter(n => n.startsWith('stage-') || n.startsWith('download-')), [], 'no stage or download left');
    assert.equal(readFileSync(join(f.web, 'index.html'), 'utf8'), 'old page');
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('a Go back that cannot put a file back says so and keeps the backup to try again', { skip: noPhp }, () => {
  const f = folders();
  try {
    assert.equal(run(install(zipOf(RELEASE, f.base)), f.priv, f.web).out, '0.2.0');
    rmSync(join(f.web, 'index.html'));
    mkdirSync(join(f.web, 'index.html')); // a folder where the old page must go back
    const r = run('try { update_rollback($priv); } catch (RuntimeException $e) { echo "ERR ", $e->getMessage(); }', f.priv, f.web);
    assert.match(r.out, /^ERR 1 file could not be put back .*index\.html.*still there/);
    assert.equal(run('echo update_backup_version($priv);', f.priv, f.web).out, '0.1.0', 'the backup is kept');
    rmSync(join(f.web, 'index.html'), { recursive: true });
    assert.equal(run('echo update_rollback($priv);', f.priv, f.web).out, '0.1.0', 'and works once the fault is fixed');
    assert.equal(readFileSync(join(f.web, 'index.html'), 'utf8'), 'old page');
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('one install or Go back at a time: a second is refused while the first holds the lock', { skip: noPhp }, async () => {
  const f = folders();
  const holder = spawn(PHP, ['-r', `require 'server/lib/updater.php'; update_locked(function () { echo "held\\n"; sleep(4); }, getenv('PRIV'));`], { cwd: root, env: { ...process.env, PRIV: f.priv } });
  try {
    await new Promise<void>((resolve, reject) => {
      holder.stdout.on('data', d => String(d).includes('held') && resolve());
      holder.on('exit', () => reject(new Error('the lock holder ended early')));
    });
    const r = run('try { update_rollback($priv); } catch (RuntimeException $e) { echo "ERR ", $e->getMessage(); }', f.priv, f.web);
    assert.match(r.out, /^ERR An update or a Go back is running now/);
  } finally {
    if (holder.exitCode === null) {
      holder.kill();
      await new Promise(r => holder.once('exit', r));
    }
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('an update with no version file is refused before anything is unpacked', { skip: noPhp }, () => {
  const f = folders();
  try {
    const r = run(install(zipOf({ 'public_html/index.html': 'x' }, f.base)), f.priv, f.web);
    assert.match(r.out, /^ERR The update is missing its version file/);
    assert.equal(readFileSync(join(f.web, 'index.html'), 'utf8'), 'old page');
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});
