// tools/server-check.php names a host PHP that misses the latest security fixes in its branch. Runs the real script with
// PHP (PHP_BIN, or php on the PATH) and checks its verdict against that PHP's own version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { PHP, hasPhp } from './php-bin.ts';

const root = join(import.meta.dirname, '..');
const patched: Record<string, string> = { '8.2': '8.2.35', '8.3': '8.3.36', '8.4': '8.4.27', '8.5': '8.5.12' };

/** -1, 0 or 1, as PHP's version_compare for plain x.y.z versions. */
function compare(a: string, b: string): number {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1;
  return 0;
}

test('server-check says whether this PHP has the latest security fixes for its branch', { skip: !hasPhp && 'no PHP' }, () => {
  const version = spawnSync(PHP, ['-r', 'echo PHP_MAJOR_VERSION, ".", PHP_MINOR_VERSION, ".", PHP_RELEASE_VERSION;'], { encoding: 'utf8' }).stdout.trim();
  const r = spawnSync(PHP, ['server/tools/server-check.php'], { cwd: root, encoding: 'utf8', timeout: 60000 });
  const line = r.stdout.split('\n').find(l => l.includes('latest security fixes'));
  assert.ok(line, r.stdout || r.stderr);
  const need = patched[version.split('.').slice(0, 2).join('.')];
  const good = need === undefined || compare(version, need) >= 0;
  assert.ok(line.trimStart().startsWith(good ? 'OK' : 'FIX'), `PHP ${version}: ${line}`);
  if (need) assert.ok(line.includes(need), line);
});
