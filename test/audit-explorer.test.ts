// Audit of File Explorer's file actions (November 2026): the desktop's own System folder as a place to put things,
// and the " (2)" name given to a folder whose name has a dot. Each test was written to catch a fault the audit found;
// one that fails points at that fault (see its words). No browser needed. Run: node --test test/audit-explorer.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileSystem } from '../src/fs/fs.ts';
import { MemoryStore } from '../src/store/memory-store.ts';
import { FileActions } from '../src/shell/actions.ts';
import { planUpload } from '../src/shell/transfer.ts';
import type { Shell } from '../src/shell/types.ts';

const names = async (fs: FileSystem, path: string) => (await fs.list(path, true)).map(e => e.name).sort();

/** Just enough of a shell for FileActions: the file layer, and dialogs that record what they were asked to say. */
function fakeShell(fs: FileSystem) {
  const said: string[] = [];
  const shell = {
    fs,
    clipboard: null as null | { mode: 'copy' | 'cut'; paths: string[] },
    clipboardChanged: { emit() {} },
    dialogs: { alert: async (title: string, text = '') => void said.push(`${title}: ${text}`) },
    report: async (title: string, error: unknown) => void said.push(`${title}: ${error instanceof Error ? error.message : String(error)}`),
    toast: () => {},
  };
  return { shell: shell as unknown as Shell & typeof shell, said };
}

// ---- E-P0-1: the System folder ---------------------------------------------------------------------------------------
// Explorer opens /System when it is typed in the path box. Whatever is then moved, pasted, made or uploaded there can
// never be deleted, moved, copied or downloaded again: every one of those refuses anything under /System.

test('E-P0-1: moving a file into the System folder is refused, so it cannot get stuck there', async () => {
  const fs = new FileSystem(new MemoryStore());
  await fs.ensureFolder('/System', { hidden: true });
  await fs.writeText('/Documents/a.txt', 'mine');
  const { shell } = fakeShell(fs);
  await new FileActions(shell).moveInto(['/Documents/a.txt'], '/System');
  assert.deepEqual(await names(fs, '/Documents'), ['a.txt'], 'a.txt left Documents for /System, where Delete, Cut, Copy and Download all refuse it');
});

test('E-P0-1: pasting a copy into the System folder is refused', async () => {
  const fs = new FileSystem(new MemoryStore());
  await fs.ensureFolder('/System', { hidden: true });
  await fs.writeText('/Documents/a.txt', 'mine');
  const { shell } = fakeShell(fs);
  const actions = new FileActions(shell);
  actions.setClipboard('copy', ['/Documents/a.txt']);
  await actions.paste('/System');
  assert.ok(!(await names(fs, '/System')).includes('a.txt'), 'a copy was pasted into /System');
});

test('E-P0-1: New > Folder inside the System folder is refused', async () => {
  const fs = new FileSystem(new MemoryStore());
  await fs.ensureFolder('/System', { hidden: true });
  const { shell } = fakeShell(fs);
  const made = await new FileActions(shell).create('folder', '/System');
  assert.equal(made, null, `"${made?.name}" was made in /System; it can then never be renamed or deleted`);
});

test('E-P0-1: what is in the System folder cannot be deleted (the trap the tests above guard against)', async () => {
  const fs = new FileSystem(new MemoryStore());
  await fs.ensureFolder('/System', { hidden: true });
  await fs.writeText('/System/stray.txt', 'x');
  const { shell, said } = fakeShell(fs);
  const result = await new FileActions(shell).deleteToBin(['/System/stray.txt']);
  // This one passes today: it is here to show why letting things in is a fault.
  assert.equal(result.kept, 1);
  assert.match(said.join('\n'), /cannot be changed/);
});

// ---- E-P0-4: " (2)" on a folder whose name has a dot -----------------------------------------------------------------

test('E-P0-4: a copy of the folder "Project v1.5" next to itself is "Project v1.5 (2)", not "Project v1 (2).5"', async () => {
  const fs = new FileSystem(new MemoryStore());
  await fs.mkdir('/Documents/Project v1.5');
  const [copy] = await fs.copy(['/Documents/Project v1.5'], '/Documents');
  assert.equal(copy.name, 'Project v1.5 (2)');
});

test('E-P0-4: a folder "v2.0" moved where one already is becomes "v2.0 (2)"', async () => {
  const fs = new FileSystem(new MemoryStore());
  await fs.mkdir('/Documents/A');
  await fs.mkdir('/Documents/A/v2.0');
  await fs.mkdir('/Documents/v2.0');
  const [moved] = await fs.move(['/Documents/A/v2.0'], '/Documents', { keepBoth: true });
  assert.equal(moved.name, 'v2.0 (2)');
});

test('E-P0-4: an uploaded folder "photos.2024" next to one already there becomes "photos.2024 (2)"', () => {
  const plan = planUpload(['photos.2024'], [{ kind: 'dir', parts: ['photos.2024'] }]);
  assert.deepEqual(plan.dirs[0], ['photos.2024 (2)']);
});

test('a file still gets its " (2)" before the ending (unchanged behaviour)', async () => {
  const fs = new FileSystem(new MemoryStore());
  await fs.writeText('/Documents/report.v2.txt', 'x');
  const [copy] = await fs.copy(['/Documents/report.v2.txt'], '/Documents');
  assert.equal(copy.name, 'report.v2 (2).txt');
});

// ---- P1 notes (pass/fail here is information, not a release fault) ---------------------------------------------------

test('E-P1-8: a copied file keeps its own modified time (as Windows and macOS do)', async () => {
  const fs = new FileSystem(new MemoryStore());
  const original = await fs.writeText('/Documents/old.txt', 'x');
  await new Promise(resolve => setTimeout(resolve, 15));
  await fs.mkdir('/Documents/Into');
  await fs.copy(['/Documents/old.txt'], '/Documents/Into');
  const copy = (await fs.list('/Documents/Into'))[0];
  assert.equal(copy.modified, original.modified, 'the copy shows the time it was copied, so sorting by date puts an old file first');
});

test('E-P1-9: a standard folder (Documents) can be copied, since copying does not change it', async () => {
  const fs = new FileSystem(new MemoryStore());
  await fs.writeText('/Documents/a.txt', 'x');
  const { shell } = fakeShell(fs);
  new FileActions(shell).setClipboard('copy', ['/Documents']);
  assert.deepEqual(shell.clipboard?.paths, ['/Documents'], 'Copy on Documents says "cannot be deleted, moved or renamed" and copies nothing');
});
