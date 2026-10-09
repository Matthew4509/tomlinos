// The archive reader, on real archives made by Python (test/fixtures/make-archives.py): contents, hostile names,
// links skipped, and a zip bomb refused.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ArchiveError, readArchive, safeParts } from '../src/apps/archive/read.ts';
import { archiveStem } from '../src/apps/archive.ts';

const fx = JSON.parse(readFileSync(new URL('./fixtures/archives.json', import.meta.url), 'utf8')) as Record<string, string>;
const bytes = (k: string) => new Uint8Array(Buffer.from(fx[k], 'base64'));
const text = (b: Uint8Array) => new TextDecoder().decode(b);

test('names can never climb out of the folder', () => {
  assert.deepEqual(safeParts('../../etc/passwd'), ['etc', 'passwd']);
  assert.deepEqual(safeParts('/abs/x'), ['abs', 'x']);
  assert.deepEqual(safeParts('C:\\win\\x.txt'), ['win', 'x.txt']);
  assert.deepEqual(safeParts('a/./b//c'), ['a', 'b', 'c']);
  assert.deepEqual(safeParts('bad:name?.txt'), ['bad_name_.txt']);
});

test('a zip lists folders and files, unpacks deflate and stored, and cleans hostile names', async () => {
  const entries = await readArchive(bytes('zip'), 'x.zip');
  assert.deepEqual(entries.map(e => e.parts.join('/')), ['docs', 'docs/a.txt', 'b.bin', 'evil.txt', 'win/x.txt']);
  assert.equal(entries[0].folder, true);
  assert.equal(text(await entries[1].read()), 'hello '.repeat(100));
  assert.deepEqual([...(await entries[2].read())], [...Array(256).keys()]);
});

test('tar and tar.gz: long names, leading slash dropped, links skipped', async () => {
  for (const k of ['tar', 'tgz']) {
    const entries = await readArchive(bytes(k), `x.${k}`);
    assert.deepEqual(entries.map(e => e.parts.join('/')), ['dir/one.txt', `abs/${'L'.repeat(120)}.txt`]);
    assert.equal(text(await entries[1].read()), 'long');
  }
});

test('a plain .gz holds one file named after the archive', async () => {
  const [only] = await readArchive(bytes('gz'), 'notes.txt.gz');
  assert.deepEqual(only.parts, ['notes.txt']);
  assert.equal(text(await only.read()), 'plain text');
});

test('a zip bomb is refused part-way', async () => {
  const [big] = await readArchive(bytes('bomb'), 'bomb.zip');
  await assert.rejects(big.read(), ArchiveError);
});

test('7z, rar and junk are named, not guessed', async () => {
  await assert.rejects(readArchive(new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]), 'a.7z'), /7z/);
  await assert.rejects(readArchive(new TextEncoder().encode('Rar!\x1a\x07'), 'a.rar'), /rar/);
  await assert.rejects(readArchive(new TextEncoder().encode('hello'), 'a.zip'), ArchiveError);
});

test('the new folder is named after the archive', () => {
  assert.equal(archiveStem('photos.tar.gz'), 'photos');
  assert.equal(archiveStem('a.TGZ'), 'a');
  assert.equal(archiveStem('b.zip'), 'b');
});
