// A request body is read in chunks (server/lib/http.php read_request_body): file_get_contents() with a length reserves
// the whole length first on PHP 8.2, so a large limit (a save's, or mail's 26 MB) under a small memory_limit died on
// every request however small its body. Skipped without PHP. Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PHP, hasPhp, portFree } from './php-bin.ts';

const root = join(import.meta.dirname, '..');
const PORT = 3071;
const dir = mkdtempSync(join(tmpdir(), 'tomlinos-body-'));
let php: ChildProcess | undefined;

before(async () => {
  if (!hasPhp) return;
  await portFree(PORT);
  writeFileSync(join(dir, 'r.php'), `<?php
require ${JSON.stringify(join(root, 'server/lib/http.php'))};
$raw = read_request_body(64 * 1048576 + 1);
echo json_encode(['length' => strlen($raw), 'same' => $raw === str_repeat('x', strlen($raw))]);`);
  php = spawn(PHP, ['-d', 'memory_limit=24M', '-S', `127.0.0.1:${PORT}`, '-t', dir], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://127.0.0.1:${PORT}/`); break; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
});

after(() => {
  php?.kill();
  rmSync(dir, { recursive: true, force: true });
});

test('a body far under a limit bigger than the memory limit is read whole', { skip: !hasPhp && 'no PHP' }, async () => {
  for (const size of [0, 1000, 3 * 1048576 + 5]) {
    const res = await fetch(`http://127.0.0.1:${PORT}/r.php`, { method: 'POST', body: 'x'.repeat(size) });
    assert.equal(res.status, 200, `${size} bytes`);
    assert.deepEqual(await res.json(), { length: size, same: true });
  }
});

test('saves and mail read their bodies in chunks, not with a reserved length', () => {
  for (const file of ['server/api/store.php', 'server/api/mail.php']) {
    const text = readFileSync(join(root, file), 'utf8');
    assert.match(text, /read_request_body\(\$max \+ 1\)/, file);
    assert.doesNotMatch(text, /file_get_contents\('php:\/\/input'/, file);
  }
});
