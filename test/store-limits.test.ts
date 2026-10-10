// The store's limits (server/lib/store.php), run by PHP directly: every record counts as at least 16 KB against the
// quota, and each person may keep at most max_files records, so empty files cannot fill the host's file slots.
// Deleting always works, even at a limit. Skipped without PHP. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  try {
    return JSON.parse(execFileSync(PHP, [file], { encoding: 'utf8' }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test('a cut-off commit carries its totals: whoever comes next writes them with the records, reading included', { skip: !hasPhp && 'no PHP' }, () => {
  const r = php(`store_commit($d, [$put($key(1))]);
$tmp = store_path($d, $key(2)) . '.dead.tmp';
@mkdir(dirname($tmp), 0700, true);
file_put_contents($tmp, str_repeat('f', 32) . 'cut off');
file_put_contents($d . '/.journal', json_encode(['moves' => [[$tmp, store_path($d, $key(2))]], 'usage' => 32768, 'count' => 2]));
$read = store_reading($d, fn () => store_get($d, $key(2)));
echo json_encode(['read' => $read[1] ?? null, 'usage' => store_usage($d), 'count' => store_count($d), 'journal' => is_file($d . '/.journal')]);`);
  assert.equal(r.read, 'cut off', 'the read finished the commit first');
  assert.equal(r.usage, 32768);
  assert.equal(r.count, 2);
  assert.equal(r.journal, false);
});

test('a refused commit leaves no temporary files behind', { skip: !hasPhp && 'no PHP' }, () => {
  const r = php(`store_commit($d, [$put($key(1))]);
try { store_commit($d, [['op' => STORE_OP_PUT, 'key' => $key(1), 'expect' => str_repeat('0', 32), 'data' => 'x'], $put($key(2), 'y')]); } catch (StoreConflict $e) { }
try { store_commit($d, [$put($key(3), str_repeat('z', 20000))], 16384); } catch (StoreQuota $e) { }
$tmps = 0;
foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($d, FilesystemIterator::SKIP_DOTS)) as $f) { $tmps += str_ends_with($f->getFilename(), '.tmp') ? 1 : 0; }
echo json_encode(['tmps' => $tmps, 'keys' => store_list_keys($d)]);`);
  assert.equal(r.tmps, 0);
  assert.equal(r.keys.length, 1);
});

test('the store check reports totals that disagree with the records and folder entries with no record, and repairs only the totals', { skip: !hasPhp && 'no PHP' }, () => {
  const r = php(`$root = json_encode(['v' => 1, 'entries' => [['name' => 'a.txt', 'id' => $key(1), 'kind' => 'file'], ['name' => 'gone.txt', 'id' => $key(9), 'kind' => 'file']]]);
store_commit($d, [['op' => STORE_OP_PUT, 'key' => '/', 'expect' => '*', 'data' => $root], $put($key(1), 'a'), $put($key(2), 'nobody points here')]);
file_put_contents($d . '/.usage', '5');
$before = store_check($d);
$after = store_check($d, true);
$again = store_check($d);
echo json_encode(['before' => $before, 'after' => $after, 'again' => $again, 'keys' => count(store_list_keys($d))]);`);
  assert.deepEqual(r.before.usage, [5, 3 * 16384]);
  assert.deepEqual(r.before.count, [3, 3]);
  assert.deepEqual(r.before.missing, ['00000009-0000-4000-8000-000000000009']);
  assert.deepEqual(r.before.unreached, ['00000002-0000-4000-8000-000000000002']);
  assert.equal(r.before.encrypted, false);
  assert.deepEqual(r.again.usage, [3 * 16384, 3 * 16384], 'repaired');
  assert.equal(r.keys, 3, 'no record was deleted');
});
