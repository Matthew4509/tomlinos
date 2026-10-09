// About > Credits must name every outside package that ships, at the version that ships. The PHP libraries' list is
// written by tools/php-credits.mjs from server/composer.lock; this fails when someone updates Composer packages and
// forgets to run it (the licence notices would then travel with the wrong code).
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');

test('the PHP libraries in Credits match composer.lock, each with its licence text', () => {
  const lock = JSON.parse(readFileSync(join(root, 'server', 'composer.lock'), 'utf8')) as { packages: Array<{ name: string; version: string }> };
  const listed = JSON.parse(readFileSync(join(root, 'public', 'vendor', 'claude-php-packages.json'), 'utf8')) as Array<{ name: string; version: string; license: string }>;
  const texts = readFileSync(join(root, 'public', 'vendor', 'claude-php-LICENSES.txt'), 'utf8');
  assert.deepEqual(
    listed.map(p => `${p.name} ${p.version}`).sort(),
    lock.packages.map(p => `${p.name} ${p.version.replace(/^v/, '')}`).sort(),
    'run: node tools/php-credits.mjs',
  );
  for (const p of listed) {
    assert.ok(texts.includes(`${p.name} ${p.version} (`), `${p.name} has its licence text`);
    assert.ok(!/GPL|AGPL/i.test(p.license), `${p.name} is not under a GPL licence (${p.license})`);
  }
  assert.ok(listed.some(p => p.name === 'anthropic-ai/sdk'), "Anthropic's official library is the one in use");
});
