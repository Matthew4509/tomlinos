// System update: where each entry of a release zip lands, and which ones are never written. Runs the real
// server/lib/updater.php with PHP (PHP_BIN, or php on the PATH).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PHP, hasPhp } from './php-bin.ts';

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
