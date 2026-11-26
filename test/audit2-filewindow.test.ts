// Round-2 audit of the shared Open / Save as / Choose a folder window and File Explorer: the parts that run without a
// browser (the file-type rules in src/shell/picktypes.ts, the name and path rules in src/fs/names.ts, and the file
// layer and FileActions Explorer uses). The window's own faults (FW-1..FW-7) are in test/browser-audit2-filewindow.mjs.
// Tests named after a rule check what holds today; a test named after a fault (FW-8, FW-9, E-P1-6, E-P1-10) checks its fix.
// Run: node --test test/audit2-filewindow.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileSystem } from '../src/fs/fs.ts';
import { MemoryStore } from '../src/store/memory-store.ts';
import { nameProblem, splitPath } from '../src/fs/names.ts';
import { finalSaveName, saveNameProblem, swapExtension, typeChoices } from '../src/shell/picktypes.ts';
import { FileActions } from '../src/shell/actions.ts';
import type { Shell } from '../src/shell/types.ts';

const names = async (fs: FileSystem, path: string, hidden = false) => (await fs.list(path, hidden)).map(e => e.name).sort();

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

// Quick Notes' Save as list, as editor.ts gives it.
const NOTES = typeChoices([
  { label: 'Text document', ext: ['txt'] },
  { label: 'Markdown', ext: ['md'] },
  { label: 'Log file', ext: ['log'] },
  { label: 'CSV', ext: ['csv'] },
  { label: 'All files', ext: [] },
], undefined, true);

// ---- Rule 2: the chosen type and the saved ending agree ----------------------------------------------------------------

test('rule 2: a name without an ending gets the chosen type\'s ending', () => {
  assert.equal(finalSaveName('notes', NOTES, 1).name, 'notes.md');
  assert.equal(finalSaveName('notes', NOTES, 0).name, 'notes.txt');
});

test('rule 2: a name ending in another listed type keeps it (the app saves the kind the ending says)', () => {
  assert.deepEqual(finalSaveName('notes.log', NOTES, 0), { name: 'notes.log', index: 2 });
});

test('rule 2: switching the type swaps a known ending and keeps an unknown one as part of the name', () => {
  assert.equal(swapExtension('notes.txt', NOTES, NOTES[1]), 'notes.md');
  assert.equal(swapExtension('v1.2', NOTES, NOTES[1]), 'v1.2.md');
});

test('FW-8: a name too long once the chosen type\'s ending is added is refused in words, not saved without the ending', () => {
  // The window adds ".txt"; the result would be over 255 bytes. Save stays off and the reason shows under the box.
  const typed = 'n'.repeat(252);
  assert.equal(nameProblem(typed), null, 'the typed name alone is fine');
  assert.match(saveNameProblem(typed, NOTES, 0) ?? '', /too long once “\.txt” is added/);
  // A name that fits with its ending, or already has it, is fine; "All files" adds nothing.
  assert.equal(saveNameProblem('n'.repeat(251), NOTES, 0), null);
  assert.equal(saveNameProblem(`${'n'.repeat(251)}.txt`, NOTES, 0), null);
  assert.equal(finalSaveName('n'.repeat(255), NOTES, 4).name, 'n'.repeat(255));
  assert.equal(saveNameProblem('n'.repeat(255), NOTES, 4), null);
  // Other problems keep their own words.
  assert.equal(saveNameProblem('a:b', NOTES, 0), nameProblem('a:b'));
});

// ---- Rule 10: paths never escape, names that differ only by case or spelling are one name --------------------------

test('rule 10: ".." and "." in a path are refused', () => {
  assert.throws(() => splitPath('/Documents/../System'), /cannot contain/);
  assert.throws(() => splitPath('/Documents/./x'), /cannot contain/);
});

test('rule 10: a name differing only by letter case or Unicode spelling cannot sit beside the first', async () => {
  const fs = new FileSystem(new MemoryStore());
  await fs.writeText('/Documents/Café.txt', 'a');
  await assert.rejects(fs.writeText('/Documents/CAFÉ.TXT', 'b', { mustBeNew: true }), /already/);
  await assert.rejects(fs.mkdir('/Documents/café.txt'), /already/);
  assert.deepEqual(await names(fs, '/Documents'), ['Café.txt']);
  assert.equal(await fs.readText('/Documents/Café.txt'), 'a');
});

test('rule 10: names with slashes, control or direction-flipping characters, or over 255 bytes are refused in words', () => {
  for (const bad of ['a/b', 'a\\b', 'a\u0000b', 'photo‮gnp.exe', 'x'.repeat(256), '..', 'nul.txt', 'trail.']) {
    assert.ok(nameProblem(bad), `"${bad.slice(0, 12)}" was allowed`);
  }
});

// ---- Rule 4 and 9: never merge, never clobber ----------------------------------------------------------------------------

test('rule 4: renaming onto a taken name (any case) is refused and both items stay', async () => {
  const fs = new FileSystem(new MemoryStore());
  await fs.mkdir('/Documents/Letters');
  await fs.writeText('/Documents/letters.txt', 'keep');
  await assert.rejects(fs.rename('/Documents/letters.txt', 'LETTERS'), /already/);
  assert.deepEqual(await names(fs, '/Documents'), ['Letters', 'letters.txt']);
});

test('rule 9: copy beside itself makes " (2)"; nothing replaced', async () => {
  const fs = new FileSystem(new MemoryStore());
  await fs.writeText('/Documents/a.txt', 'one');
  await fs.copy(['/Documents/a.txt'], '/Documents');
  assert.deepEqual(await names(fs, '/Documents'), ['a (2).txt', 'a.txt']);
  assert.equal(await fs.readText('/Documents/a.txt'), 'one');
});

test('rule 9: a folder cannot be moved or copied into itself; nothing changes', async () => {
  const fs = new FileSystem(new MemoryStore());
  await fs.ensureFolder('/Documents/A/B');
  await assert.rejects(fs.move(['/Documents/A'], '/Documents/A/B'), /itself/);
  await assert.rejects(fs.copy(['/Documents/A'], '/Documents/A/B'), /itself/);
  assert.deepEqual(await names(fs, '/Documents/A/B'), []);
});

test('rule 9: a move that clashes is refused whole unless "keep both" (then " (2)")', async () => {
  const fs = new FileSystem(new MemoryStore());
  await fs.writeText('/Documents/a.txt', 'docs');
  await fs.writeText('/Pictures/a.txt', 'pics');
  await assert.rejects(fs.move(['/Pictures/a.txt'], '/Documents'), /Nothing was moved/);
  await fs.move(['/Pictures/a.txt'], '/Documents', { keepBoth: true });
  assert.equal(await fs.readText('/Documents/a.txt'), 'docs');
  assert.equal(await fs.readText('/Documents/a (2).txt'), 'pics');
});

test('E-P1-10: cut then paste keeps on the clipboard what could not be moved', async () => {
  const fs = new FileSystem(new MemoryStore());
  await fs.ensureFolder('/Documents/A/B');
  const { shell } = fakeShell(fs);
  const actions = new FileActions(shell);
  actions.setClipboard('cut', ['/Documents/A']);
  await actions.paste('/Documents/A/B'); // refused: into itself
  assert.deepEqual(shell.clipboard?.paths, ['/Documents/A'], 'the clipboard was emptied although nothing moved');
});

test('E-P1-10: a cut that all moved empties the clipboard', async () => {
  const fs = new FileSystem(new MemoryStore());
  await fs.writeText('/Documents/a.txt', 'a');
  await fs.mkdir('/Pictures/Into');
  const { shell } = fakeShell(fs);
  const actions = new FileActions(shell);
  actions.setClipboard('cut', ['/Documents/a.txt']);
  await actions.paste('/Pictures/Into');
  assert.equal(shell.clipboard, null);
  assert.deepEqual(await names(fs, '/Pictures/Into'), ['a.txt']);
});

test('E-P1-6: a name clash on move asks first; "Keep both" adds " (2)" and says so, "Skip" leaves it, Cancel moves nothing', async () => {
  const setup = async (answer: string | null) => {
    const fs = new FileSystem(new MemoryStore());
    await fs.writeText('/Documents/a.txt', 'new');
    await fs.writeText('/Documents/b.txt', 'b');
    await fs.mkdir('/Documents/Into');
    await fs.writeText('/Documents/Into/a.txt', 'old');
    const { shell } = fakeShell(fs);
    const asked: string[] = [];
    const toasts: string[] = [];
    (shell as unknown as { dialogs: Record<string, unknown> }).dialogs.ask = async (o: { text: string }) => (asked.push(o.text), answer);
    (shell as unknown as { toast: (t: string) => void }).toast = (t: string) => void toasts.push(t);
    return { fs, shell, asked, toasts };
  };
  {
    const { fs, shell, asked, toasts } = await setup('keep');
    const { left } = await new FileActions(shell).moveInto(['/Documents/a.txt', '/Documents/b.txt'], '/Documents/Into');
    assert.equal(asked.length, 1);
    assert.match(asked[0], /“a\.txt”/);
    assert.doesNotMatch(asked[0], /b\.txt/, 'only the clashing name is asked about');
    assert.deepEqual(await names(fs, '/Documents/Into'), ['a (2).txt', 'a.txt', 'b.txt']);
    assert.equal(await fs.readText('/Documents/Into/a.txt'), 'old', 'nothing replaced');
    assert.match(toasts.join(' '), /“a\.txt” is now “a \(2\)\.txt”/);
    assert.deepEqual(left, []);
  }
  {
    const { fs, shell } = await setup('skip');
    await new FileActions(shell).moveInto(['/Documents/a.txt', '/Documents/b.txt'], '/Documents/Into');
    assert.deepEqual(await names(fs, '/Documents/Into'), ['a.txt', 'b.txt']);
    assert.ok(await fs.exists('/Documents/a.txt'), 'the skipped one stays where it was');
  }
  {
    const { fs, shell } = await setup('cancel');
    const actions = new FileActions(shell);
    actions.setClipboard('cut', ['/Documents/a.txt', '/Documents/b.txt']);
    await actions.paste('/Documents/Into');
    assert.deepEqual(await names(fs, '/Documents/Into'), ['a.txt']);
    assert.deepEqual(shell.clipboard?.paths, ['/Documents/a.txt', '/Documents/b.txt'], 'a cancelled paste keeps the clipboard');
  }
});

// ---- Rule 7: hidden entries --------------------------------------------------------------------------------------------

test('rule 7: the hidden System folder is not listed', async () => {
  const fs = new FileSystem(new MemoryStore());
  await fs.ensureFolder('/System', { hidden: true });
  assert.ok(!(await names(fs, '/')).includes('System'));
});

test('FW-9: a name refused because of the hidden System folder does not name it', async () => {
  // New folder renamed to "system" at the top (or Save as "System" there) is refused with the hidden folder's own name.
  const fs = new FileSystem(new MemoryStore());
  await fs.ensureFolder('/System', { hidden: true });
  await fs.mkdir('/New folder');
  const error = await fs.rename('/New folder', 'system').then(() => null, (e: Error) => e);
  assert.ok(error, 'the rename went through');
  assert.doesNotMatch(error.message, /System/i, `the refusal names the hidden folder: "${error.message}"`);
  const made = await fs.mkdir('/SYSTEM').then(() => null, (e: Error) => e);
  assert.ok(made, 'the new folder was made');
  assert.doesNotMatch(made.message, /System/i, `New folder's refusal names the hidden folder: "${made.message}"`);
  const saved = await fs.writeText('/system', 'x', { mustBeNew: true }).then(() => null, (e: Error) => e);
  assert.ok(saved, 'the file was saved');
  assert.doesNotMatch(saved.message, /System/i, `Save's refusal names the hidden folder: "${saved.message}"`);
  // A clash with something the person can see still names it.
  await fs.mkdir('/Documents/Letters');
  await assert.rejects(fs.mkdir('/Documents/letters'), /"Letters"/);
});
