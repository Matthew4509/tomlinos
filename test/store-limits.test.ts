// The store's limits (server/lib/store.php), run by PHP directly: every record counts as at least 16 KB against the
// quota, and each person may keep at most max_files records, so empty files cannot fill the host's file slots.
// Deleting always works, even at a limit. Skipped without PHP. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PHP, hasPhp } from './php-bin.ts';

const root = join(import.meta.dirname, '..');

function php(body: string): Record<string, any> {
  const dir = mkdtempSync(join(tmpdir(), 'tomlinos-store-'));
  const file = join(dir, 't.php');
  writeFileSync(file, `<?php
require ${JSON.stringify(join(root, 'server/lib/store.php'))};
$d = ${JSON.stringify(join(dir, 'store'))};
@mkdir($d, 0700, true);
$put = static fn (string $key, string $data = '') => ['op' => STORE_OP_PUT, 'key' => $key, 'expect' => '*', 'data' => $data];
$del = static fn (string $key) => ['op' => STORE_OP_DEL, 'key' => $key, 'expect' => '*', 'data' => ''];
$key = static fn (int $n) => sprintf('%08x-0000-4000-8000-%012x', $n, $n);
${body}`);
  return JSON.parse(execFileSync(PHP, [file], { encoding: 'utf8' }));
}

test('an empty record still counts 16 KB against the quota', { skip: !hasPhp && 'no PHP' }, () => {
  const r = php(`store_commit($d, [$put($key(1))]);
echo json_encode(['usage' => store_usage($d), 'charge0' => store_charge(0), 'charge10' => store_charge(10), 'charge1m' => store_charge(1000000)]);`);
  assert.equal(r.usage, 16384);
  assert.equal(r.charge0, 0, 'no file, no charge');
  assert.equal(r.charge10, 16384);
  assert.equal(r.charge1m, 1000000, 'a big file counts its own size');
});

test('the file limit: new records past it are refused, changes and deletes still work', { skip: !hasPhp && 'no PHP' }, () => {
  const r = php(`$out = [];
store_commit($d, [$put($key(1)), $put($key(2)), $put($key(3))], 0, 3);
$out['count'] = store_count($d);
try { store_commit($d, [$put($key(4))], 0, 3); $out['fourth'] = 'saved'; } catch (StoreFileLimit $e) { $out['fourth'] = [$e->count, $e->max]; }
store_commit($d, [$put($key(2), 'changed')], 0, 3);
$out['change'] = 'saved';
store_commit($d, [$del($key(1))], 0, 3);
$out['afterDelete'] = store_count($d);
store_commit($d, [$put($key(4))], 0, 3);
$out['afterRoom'] = store_count($d);
@unlink($d . '/.count');
$out['recounted'] = store_count($d);
echo json_encode($out);`);
  assert.equal(r.count, 3);
  assert.deepEqual(r.fourth, [3, 3], 'the fourth new record is refused');
  assert.equal(r.change, 'saved', 'changing an existing record is not a new one');
  assert.equal(r.afterDelete, 2, 'deleting always works');
  assert.equal(r.afterRoom, 3, 'with room made, a new one fits');
  assert.equal(r.recounted, 3, 'a lost count is worked out again from the files');
});
