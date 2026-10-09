// The app store's catalogue entries as the server keeps them: names and notes survive (cut to length, with or without
// the mbstring extension), and an entry without a safe id, version, fingerprint or https address is dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { PHP, hasPhp } from './php-bin.ts';

const root = join(import.meta.dirname, '..');
const noPhp = !hasPhp && 'no PHP';
const SHA = 'a'.repeat(64);

function clean(entries: unknown[], noExtensions = false): unknown[] {
  const code = `require 'server/lib/appstore.php'; echo json_encode(array_map('appstore_clean_app', json_decode(getenv('ENTRIES'), true)), JSON_UNESCAPED_UNICODE);`;
  const r = spawnSync(PHP, [...(noExtensions ? ['-n'] : []), '-r', code], { cwd: root, env: { ...process.env, ENTRIES: JSON.stringify(entries) }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const entry = { id: 'officeprinter', title: 'Office Printer', icon: 'printer', kind: 'games', version: '1.0', date: '2026-10-10', notes: 'First release', bytes: 5, sha256: SHA, zips: ['https://example.com/a.zip'] };

test('a catalogue entry keeps its name, date and notes, cut to length by characters', { skip: noPhp }, () => {
  for (const bare of [false, true]) {
    const [kept, long] = clean([entry, { ...entry, title: 'É'.repeat(70), notes: 'x'.repeat(2100) }], bare) as Array<Record<string, any>>;
    assert.equal(kept.title, 'Office Printer', bare ? 'without mbstring' : 'with mbstring');
    assert.equal(kept.date, '2026-10-10');
    assert.equal(kept.notes, 'First release');
    assert.equal(long.title, 'É'.repeat(60));
    assert.equal(long.notes.length, 2000);
  }
});

test('an entry without a safe id, version, fingerprint or https address is dropped', { skip: noPhp }, () => {
  assert.deepEqual(clean([
    { ...entry, id: '../x' }, { ...entry, version: 'one' }, { ...entry, sha256: 'nope' }, { ...entry, zips: ['http://example.com/a.zip'] }, 'text',
  ]), [null, null, null, null, null]);
});
