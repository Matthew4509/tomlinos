// Audit of About > Credits (November 2026). A test without `todo` is a P0: it fails now and passes once fixed.
// Run: node --test test/audit-about.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const vendor = (name: string) => readFileSync(join(root, 'public', 'vendor', name), 'utf8');

test('AB-P0-1: loglevel, bundled inside webllm.js, is credited with its MIT notice', () => {
  const bundle = vendor('webllm.js');
  // loglevel's own API, minified into the bundle (WebLLM imports it; esbuild runs with legalComments: 'none').
  assert.ok(/setDefaultLevel/.test(bundle) && /getLoggers/.test(bundle), 'precondition: loglevel is in the bundle');
  const listed = JSON.parse(vendor('webllm-packages.json')) as Array<{ name: string }>;
  const texts = vendor('webllm-LICENSE.txt');
  assert.ok(listed.some(p => p.name === 'loglevel'), 'webllm-packages.json lists only @mlc-ai/web-llm (vendor-src/webllm/build.mjs writes one row, not from the metafile as CodeMirror does)');
  assert.ok(/loglevel/.test(texts), 'webllm-LICENSE.txt carries no loglevel MIT notice');
});

test('every package the CodeMirror and ProseMirror lockfiles bundle is credited at its version', () => {
  for (const name of ['codemirror', 'prosemirror']) {
    const lock = JSON.parse(readFileSync(join(root, 'vendor-src', name, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version: string }> };
    const listed = new Set((JSON.parse(vendor(`${name}-packages.json`)) as Array<{ name: string; version: string }>).map(p => `${p.name} ${p.version}`));
    for (const p of listed) {
      const [pkg, version] = p.split(' ');
      assert.equal(lock.packages[`node_modules/${pkg}`]?.version, version, `${p} is the version the lockfile has`);
    }
  }
});

test('AB-P1-2: About credits Composer\'s autoloader, which ships in server/vendor/composer', { todo: 'P1' }, () => {
  assert.ok(readdirSync(join(root, 'server', 'vendor', 'composer')).includes('ClassLoader.php'));
  const about = readFileSync(join(root, 'src', 'apps', 'about.ts'), 'utf8') + vendor('claude-php-LICENSES.txt');
  assert.ok(/Composer/i.test(about.replace(/composer\.lock|Composer packages/gi, '')), 'Composer (MIT, Nils Adermann and Jordi Boggiano) is not named');
});
