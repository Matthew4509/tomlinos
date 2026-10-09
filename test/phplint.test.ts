// Every PHP file of the server parses (php -l). A quote typed into a message once broke mailnet.php for a moment;
// this catches that class before a zip is made. Skipped without PHP.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PHP, hasPhp } from './php-bin.ts';

const root = join(import.meta.dirname, '..', 'server');

test('every server PHP file parses', { skip: !hasPhp && 'no PHP' }, () => {
  const files: string[] = [];
  // Our own PHP only: server/vendor is Anthropic's official library and its HTTP client (thousands of files).
  const walk = (d: string) => readdirSync(d).forEach(n => (statSync(join(d, n)).isDirectory() ? n !== 'vendor' && walk(join(d, n)) : n.endsWith('.php') && files.push(join(d, n))));
  walk(root);
  const bad: string[] = [];
  for (const f of files) {
    try {
      execFileSync(PHP, ['-l', f], { encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      bad.push(`${f}: ${String((e as { stdout?: string }).stdout ?? e).trim().split('\n')[0]}`);
    }
  }
  assert.deepEqual(bad, []);
  assert.ok(files.length >= 10, `found ${files.length} PHP files`);
});
