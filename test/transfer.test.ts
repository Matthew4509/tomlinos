// Upload naming and the zip writer. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, zipStore } from '../src/core/zip.ts';
import { planUpload } from '../src/shell/transfer.ts';

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('a zip we write is a valid zip with the right files, folders and bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zip-'));
  const path = join(dir, 't.zip');
  const enc = new TextEncoder();
  writeFileSync(path, zipStore([
    { name: 'Trip/', modified: Date.now() },
    { name: 'Trip/é notes.txt', data: enc.encode('hello ünïcode'), modified: Date.now() },
    { name: 'Trip/empty.bin', data: new Uint8Array(0), modified: Date.now() },
  ]));
  const script = [
    'import zipfile,sys,json',
    'z=zipfile.ZipFile(sys.argv[1])',
    'assert z.testzip() is None',
    'print(json.dumps(sorted(z.namelist())))',
    'print(json.dumps(z.read(z.namelist()[1]).decode()))',
  ].join('\n');
  const run = spawnSync('python', ['-c', script, path], { encoding: 'utf8' });
  if (run.error) return; // no python here: the crc test above still ran
  assert.equal(run.status, 0, run.stderr);
  const [names, text] = run.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.deepEqual(names, ['Trip/', 'Trip/empty.bin', 'Trip/é notes.txt']);
  assert.equal(text, 'hello ünïcode');
});

test('upload plan: taken names get a number, bad characters are cleaned, folders are created parents first', () => {
  const plan = planUpload(['photo.jpg', 'Trip'], [
    { kind: 'file', parts: ['photo.jpg'] },
    { kind: 'file', parts: ['PHOTO.jpg'] },
    { kind: 'dir', parts: ['Trip'] },
    { kind: 'file', parts: ['Trip', 'day1', 'a:b.txt'] },
    { kind: 'file', parts: ['Trip', 'day1', 'a_b.txt'] },
  ]);
  assert.deepEqual(plan.files.map(f => f.parts), [
    ['photo (2).jpg'],
    ['PHOTO (3).jpg'],
    ['Trip (2)', 'day1', 'a_b.txt'],
    ['Trip (2)', 'day1', 'a_b (2).txt'],
  ]);
  assert.deepEqual(plan.dirs, [['Trip (2)'], ['Trip (2)', 'day1']]);
});

test('upload plan: a name that cleans to nothing still gets a usable name', () => {
  const plan = planUpload([], [{ kind: 'file', parts: ['..', '...'] }]);
  assert.deepEqual(plan.files[0].parts, ['Untitled', 'Untitled']);
});
