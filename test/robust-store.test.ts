// The file store under real pressure (server/lib/store.php), run by PHP itself in several processes at once:
//   - writers in parallel never lose each other's changes, and the totals and the folder stay whole;
//   - a reader running alongside never sees a folder naming a file that is not there (half a commit);
//   - a big save killed at a random moment is all or nothing once the next one has run.
// Needs PHP (PHP_BIN, or php on the PATH). Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PHP, hasPhp } from './php-bin.ts';
import { tempDir } from './tmp.ts';

const root = join(import.meta.dirname, '..');
const noPhp = !hasPhp && 'no PHP';
const eq = (a: unknown, b: unknown) => assert.equal(a, b);
/** JSON from a PHP script, or a failure that shows what PHP printed instead. */
const parse = (out: string): any => {
  try {
    return JSON.parse(out);
  } catch {
    throw new Error('PHP printed: ' + out.slice(0, 600));
  }
};
// STORE_LIB: another copy of store.php to try the same tests on (an older version, to show what they catch).
const STORE = JSON.stringify(process.env.STORE_LIB ?? join(root, 'server/lib/store.php'));

/** A PHP script with the store loaded, $d = the data folder, $key(n) = a store key; returns its path. */
function script(dir: string, name: string, body: string): string {
  const file = join(dir, name);
  writeFileSync(file, `<?php
require ${STORE};
$d = getenv('STORE_DIR');
$key = static fn (int $n) => sprintf('%08x-0000-4000-8000-%012x', $n, $n);
$folder = static fn (array $entries) => json_encode(['v' => 1, 'entries' => $entries]);
if (!function_exists('store_reading')) { function store_reading(string $d, callable $fn): mixed { return $fn(); } }
${body}`);
  return file;
}

function run(file: string, env: Record<string, string>): { done: Promise<{ code: number | null; out: string }>; kill: () => void } {
  const child = spawn(PHP, [file], { env: { ...process.env, ...env } });
  let out = '';
  child.stdout.on('data', d => (out += d));
  child.stderr.on('data', d => (out += d));
  return { done: new Promise(resolve => child.on('exit', code => resolve({ code, out }))), kill: () => child.kill() };
}

async function check(dir: string, data: string, repair = false): Promise<any> {
  const f = script(dir, `check-${Math.random().toString(16).slice(2)}.php`, `echo json_encode(store_check($d, ${repair ? 'true' : 'false'}));`);
  const r = await run(f, { STORE_DIR: data }).done;
  assert.equal(r.code, 0, r.out);
  return JSON.parse(r.out);
}

test('six processes saving into one folder at once: nothing is lost, the folder and the totals stay whole, and a reader alongside never sees half a save', { skip: noPhp, timeout: 240000 }, async () => {
  const dir = tempDir('tomlinos-robust-');
  const data = join(dir, 'store');
  // Each writer adds 30 files to the top folder: read it, add one entry, commit the folder (at the version read) and
  // the new file together; a clash (another writer got in first) is read again and redone, as the browser does.
  const writer = script(dir, 'writer.php', `
$me = (int) getenv('WORKER');
@mkdir($d, 0700, true);
for ($i = 0; $i < 30; $i++) {
    $n = $me * 1000 + $i + 1;
    for ($try = 0; ; $try++) {
        $rec = store_reading($d, static fn () => store_get($d, '/'));
        $entries = $rec === null ? [] : json_decode($rec[1], true)['entries'];
        $entries[] = ['name' => "w$me-$i.txt", 'id' => $key($n), 'kind' => 'file', 'size' => 5, 'modified' => 0];
        // The folder first in the list: a reader that could see half a commit would find the entry before its file.
        $ops = [['op' => STORE_OP_PUT, 'key' => '/', 'expect' => $rec === null ? '' : $rec[0], 'data' => $folder($entries)],
                ['op' => STORE_OP_PUT, 'key' => $key($n), 'expect' => '', 'data' => str_repeat('x', 3000)]];
        try { store_commit($d, $ops); break; } catch (StoreConflict $e) { if ($try > 500) { echo "gave up\\n"; exit(1); } usleep(random_int(0, 3000)); }
    }
}
echo "done\\n";`);
  // The reader: over and over, the top folder and every file it names, read under the store's shared lock.
  const reader = script(dir, 'reader.php', `
$end = microtime(true) + (float) getenv('SECONDS');
$reads = 0; $broken = 0;
while (microtime(true) < $end) {
    if (!is_dir($d)) { usleep(1000); continue; }
    store_reading($d, static function () use ($d, &$reads, &$broken) {
        $rec = store_get($d, '/');
        if ($rec === null) return;
        foreach (json_decode($rec[1], true)['entries'] as $e) { if (store_get($d, $e['id']) === null) { $broken++; } }
        $reads++;
    });
}
echo json_encode(['reads' => $reads, 'broken' => $broken]);`);

  const readerRun = run(reader, { STORE_DIR: data, SECONDS: '25' });
  const writers = Array.from({ length: 6 }, (_, w) => run(writer, { STORE_DIR: data, WORKER: String(w + 1) }));
  for (const w of writers) {
    const r = await w.done;
    assert.equal(r.code, 0, r.out);
  }
  const rr = await readerRun.done;
  assert.equal(rr.code, 0, rr.out);
  const seen = JSON.parse(rr.out);
  assert.ok(seen.reads > 20, `the reader read alongside the writers (${seen.reads} reads)`);
  assert.equal(seen.broken, 0, 'a reader never saw the folder name a file that was not there yet');

  const after = await check(dir, data);
  assert.equal(after.journal, false);
  assert.deepEqual(after.missing, [], 'every entry has its file');
  assert.deepEqual(after.unreached, [], 'no file is outside the folder');
  assert.equal(after.count[1], 6 * 30 + 1, 'all 180 files and the folder are there');
  assert.deepEqual(after.count[0], after.count[1], 'the count kept equals the files');
  assert.deepEqual(after.usage[0], after.usage[1], 'the space used kept equals the files');
  assert.equal(after.temps, 0, 'no temporary files left');
});

test('a big save killed at a random moment is all or nothing once the next one has run, and the totals agree', { skip: noPhp, timeout: 300000 }, async () => {
  const dir = tempDir('tomlinos-robust-');
  const data = join(dir, 'store');
  // One save: 400 new files of 4 KB and the top folder listing them all, in one commit (folder first).
  const saver = script(dir, 'saver.php', `
$batch = (int) getenv('BATCH');
@mkdir($d, 0700, true);
$rec = store_reading($d, static fn () => store_get($d, '/'));
$entries = $rec === null ? [] : json_decode($rec[1], true)['entries'];
$ops = [];
for ($i = 0; $i < 400; $i++) {
    $n = $batch * 10000 + $i + 1;
    $entries[] = ['name' => "b$batch-$i", 'id' => $key($n), 'kind' => 'file', 'size' => 4096, 'modified' => 0];
    $ops[] = ['op' => STORE_OP_PUT, 'key' => $key($n), 'expect' => '', 'data' => str_repeat(chr(65 + $batch % 26), 4096)];
}
array_unshift($ops, ['op' => STORE_OP_PUT, 'key' => '/', 'expect' => $rec === null ? '' : $rec[0], 'data' => $folder($entries)]);
$t = microtime(true);
store_commit($d, $ops);
echo json_encode(['ms' => round((microtime(true) - $t) * 1000)]);`);
  // How long one save takes on this computer, so the kills land before, during and after it.
  const first = await run(saver, { STORE_DIR: data, BATCH: '1' }).done;
  assert.equal(first.code, 0, first.out);
  const startup = 150;
  const span = Math.max(200, JSON.parse(first.out).ms) + startup;

  let kept = 0;
  let dropped = 0;
  let mid = 0; // killed during the moves themselves: a journal was left for the next one to finish
  for (let batch = 2; batch <= 21; batch++) {
    const r = run(saver, { STORE_DIR: data, BATCH: String(batch) });
    const wait = Math.floor(Math.random() * span * 1.3);
    await new Promise(res => setTimeout(res, wait));
    r.kill();
    await r.done;
    // The next one to touch the store (here: the check, with repair) finishes or drops what was cut off.
    const c = await check(dir, data, true);
    if (c.journal) mid++;
    assert.deepEqual(c.missing, [], `kill after ${wait} ms: every entry in the folder has its file`);
    assert.deepEqual(c.unreached, [], `kill after ${wait} ms: no file outside the folder (all or nothing)`);
    const now = await check(dir, data);
    assert.deepEqual(now.count[0], now.count[1], `kill after ${wait} ms: the count kept equals the files`);
    assert.deepEqual(now.usage[0], now.usage[1], `kill after ${wait} ms: the space used kept equals the files`);
    const batches = (now.count[1] - 1 - 400) / 400; // whole saves landed since the first
    assert.ok(batches === kept || batches === kept + 1, `kill after ${wait} ms: whole saves only (${now.count[1]} files, ${kept} saves before)`);
    if (batches === kept + 1) kept++;
    else dropped++;
  }
  console.log(`      ${kept} saves landed whole (${mid} of them finished from the journal after a kill mid-move), ${dropped} were cut off and left nothing (kills up to ${Math.round(span * 1.3)} ms)`);
  // A save after all that still works and is counted.
  const last = await run(saver, { STORE_DIR: data, BATCH: '99' }).done;
  assert.equal(last.code, 0, last.out);
  const end = await check(dir, data);
  assert.deepEqual(end.missing, []);
  assert.deepEqual(end.unreached, []);
  assert.equal(end.count[1], 1 + 400 * (2 + kept));
});

test('a save stopped half-way through its moves (Windows will not replace a file someone has open) is never seen half-done, and the next reader finishes it', { skip: (noPhp || (process.platform !== 'win32' && 'Windows only: Linux replaces an open file')) as string | false, timeout: 120000 }, async () => {
  const dir = tempDir('tomlinos-robust-');
  const data = join(dir, 'store');
  const setup = script(dir, 'setup.php', `
@mkdir($d, 0700, true);
store_commit($d, [['op' => STORE_OP_PUT, 'key' => '/', 'expect' => '', 'data' => $folder([['name' => 'held', 'id' => $key(500), 'kind' => 'file']])],
                  ['op' => STORE_OP_PUT, 'key' => $key(500), 'expect' => '', 'data' => 'old']]);
echo 'ok';`);
  eq((await run(setup, { STORE_DIR: data }).done).out, 'ok');
  // Another request reading the file "held" keeps it open for a few seconds.
  const holder = run(script(dir, 'hold.php', `$h = fopen(store_path($d, $key(500)), 'rb'); echo "held\n"; sleep(4); fclose($h);`), { STORE_DIR: data });
  await new Promise(res => setTimeout(res, 600));
  // A save of 50 new files, a new version of "held", and 50 more: the moves before "held" are made, then it stops.
  const save = script(dir, 'save.php', `
$entries = [['name' => 'held', 'id' => $key(500), 'kind' => 'file']];
$ops = [];
for ($i = 1; $i <= 100; $i++) { $entries[] = ['name' => "n$i", 'id' => $key($i), 'kind' => 'file']; }
$rec = store_get($d, '/');
$ops[] = ['op' => STORE_OP_PUT, 'key' => '/', 'expect' => $rec[0], 'data' => $folder($entries)];
for ($i = 1; $i <= 50; $i++) { $ops[] = ['op' => STORE_OP_PUT, 'key' => $key($i), 'expect' => '', 'data' => 'new'] ; }
$ops[] = ['op' => STORE_OP_PUT, 'key' => $key(500), 'expect' => '*', 'data' => 'new'];
for ($i = 51; $i <= 100; $i++) { $ops[] = ['op' => STORE_OP_PUT, 'key' => $key($i), 'expect' => '', 'data' => 'new'] ; }
try { store_commit($d, $ops); echo 'saved'; } catch (RuntimeException $e) { echo 'stopped: ' . $e->getMessage(); }`);
  const saved = (await run(save, { STORE_DIR: data }).done).out;
  assert.match(saved, /^stopped: a record could not be moved into place/, 'the save stops part-way: ' + saved);
  // While the file is still held: a read either sees the old whole state or says it cannot finish; never half.
  const read = script(dir, 'read.php', `
try {
  echo json_encode(store_reading($d, static function () use ($d, $key) {
    $root = json_decode(store_get($d, '/')[1], true);
    $missing = 0;
    foreach ($root['entries'] as $e) { if (store_get($d, $e['id']) === null) { $missing++; } }
    return ['entries' => count($root['entries']), 'missing' => $missing, 'held' => store_get($d, $key(500))[1]];
  }));
} catch (RuntimeException $e) { echo json_encode(['refused' => $e->getMessage()]); }`);
  const during = parse((await run(read, { STORE_DIR: data }).done).out);
  assert.ok(during.refused || during.missing === 0, 'never a folder naming a file that is not there: ' + JSON.stringify(during));
  await holder.done;
  // Let go: the next reader finishes the save, all of it.
  const after = parse((await run(read, { STORE_DIR: data }).done).out);
  assert.deepEqual(after, { entries: 101, missing: 0, held: 'new' }, 'the whole save, after the file was let go');
  const c = await check(dir, data);
  assert.equal(c.journal, false);
  assert.deepEqual([c.missing, c.unreached, c.count[0] === c.count[1], c.usage[0] === c.usage[1]], [[], [], true, true]);
  console.log(`      while held, the reader ${during.refused ? 'was refused (' + during.refused + ')' : 'saw the old whole state'}`);
});
