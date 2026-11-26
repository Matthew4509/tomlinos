// Terminal audit: faults found by trying to break the shell engine (src/apps/terminal/shell.ts) over an in-memory desktop.
// P0 tests fail now and pass once fixed; P1 tests are marked todo (they report without failing the suite).
// Run: node --test test/audit-terminal.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileSystem } from '../src/fs/fs.ts';
import { MemoryStore } from '../src/store/memory-store.ts';
import { protectedReason } from '../src/shell/actions.ts';
import { TerminalShell, type Machine } from '../src/apps/terminal/shell.ts';
import { makeTrainingMachine } from '../src/apps/terminal/training.ts';

async function desktop() {
  const fs = new FileSystem(new MemoryStore());
  const machine: Machine = {
    fs, user: 'alex', host: 'tomlinos', home: '/', pretend: false, protectedReason,
    virtual: { '/etc/os-release': 'ID_LIKE=debian\n' },
    async trash(paths) {
      await fs.remove(paths);
      return 'Moved to the Recycle Bin.';
    },
    async open() {},
  };
  const sh = new TerminalShell(machine, makeTrainingMachine);
  const run = async (line: string) => (await sh.run(line)).map(l => l.text);
  return { fs, sh, run };
}

const twelve = Array.from({ length: 12 }, (_, i) => `L${i + 1}`).join('\n') + '\n';

// ---- P0 -----------------------------------------------------------------------------------------------------------

test('T-P0-1: nothing can be put into /System (mv, cp, mkdir, touch, echo >): it could never be removed or moved back', async () => {
  const { fs, run } = await desktop();
  await fs.writeText('/Documents/notes.txt', 'mine\n');
  await fs.writeText('/Documents/b.txt', 'bee\n');
  await run('mv Documents/notes.txt /System');
  await run('cp Documents/b.txt /System');
  await run('mkdir /System/made');
  await run('touch /System/touched.txt');
  await run('echo hi > /System/echoed.txt');
  const inSystem = (await fs.list('/System', true)).map(e => e.name).sort();
  assert.deepEqual(inSystem, [], `these went into /System, where rm and mv then refuse them: ${JSON.stringify(inSystem)}`);
  assert.ok(await fs.stat('/Documents/notes.txt'), 'notes.txt left Documents for /System');
});

test('T-P0-1b: echo > overwrites the desktop\'s own /System files, which rm and mv refuse to touch', async () => {
  const { fs, run } = await desktop();
  await fs.writeText('/System/session.json', '{"v":1,"lock":{"lock":true}}', { hidden: true });
  await run('echo broken > /System/session.json');
  assert.equal(new TextDecoder().decode(await fs.readFile('/System/session.json')), '{"v":1,"lock":{"lock":true}}');
});

test('T-P0-2: an option the shell does not know is refused, not ignored (grep -v printed the matching lines)', async () => {
  const { fs, run } = await desktop();
  await fs.writeText('/Documents/notes.txt', 'one\ntwo\nthree\n');
  const v = await run('grep -v one Documents/notes.txt');
  assert.ok(!v.includes('one'), `grep -v one printed ${JSON.stringify(v)}: the lines that DO match`);
});

test('T-P0-2b: head -3 and tail -3 show three lines, not ten', async () => {
  const { fs, run } = await desktop();
  await fs.writeText('/Documents/twelve.txt', twelve);
  assert.deepEqual(await run('head -3 Documents/twelve.txt'), ['L1', 'L2', 'L3']);
  assert.deepEqual(await run('tail -3 Documents/twelve.txt'), ['L10', 'L11', 'L12']);
});

test('T-P0-3: cat of a 500 KB text file of short lines shows it (it failed with "Maximum call stack size exceeded")', async () => {
  const { fs, run } = await desktop();
  await fs.writeText('/Documents/many.txt', 'z\n'.repeat(250000));
  const out = await run('cat Documents/many.txt');
  assert.ok(!out.some(l => /call stack/i.test(l)), `cat said: ${out[0]}`);
  assert.equal(out.length, 250000);
});

test('T-P0-4: du, find and grep -r count everything past 5000 items, or say they stopped', { timeout: 120000 }, async () => {
  const { fs, run } = await desktop();
  const kb = new Uint8Array(1024);
  for (let f = 0; f < 55; f++) {
    await fs.mkdir(`/Documents/f${f}`);
    for (let i = 0; i < 100; i++) await fs.writeFile(`/Documents/f${f}/x${i}.txt`, kb);
  }
  await fs.writeText('/Documents/f54/needle.txt', 'findme\n');
  const du = await run('du /Documents');
  const kbs = Number(du[0].split('\t')[0]);
  const found = await run('find /Documents -name needle.txt');
  const grep = await run('grep -r findme /Documents');
  const problems: string[] = [];
  if (kbs < 5500) problems.push(`du says ${kbs} KB for 5501 KB of files`);
  if (!found.length) problems.push('find -name needle.txt found nothing');
  if (!grep.length) problems.push('grep -r findme found nothing');
  assert.deepEqual(problems, [], 'past MAX_WALK the answer is silently wrong');
});

// ---- P1 (reported, not failed) -----------------------------------------------------------------------------------

test('T-P1-1: Tab on the command word offers only commands (it offered "file", "text", "to", "training")', { todo: 'P1' }, async () => {
  const { sh } = await desktop();
  assert.deepEqual((await sh.complete('fi')).choices, []);
  assert.equal((await sh.complete('fi')).line, 'find ');
  assert.equal((await sh.complete('rmd')).line, 'rmdir ');
  assert.equal((await sh.complete('nan')).line, 'nano ');
});

test('T-P1-2: Tab completes a name after an escaped space', { todo: 'P1' }, async () => {
  const { fs, sh } = await desktop();
  await fs.mkdir('/Documents/My Folder');
  await fs.writeText('/Documents/My Folder/inside.txt', 'x');
  assert.equal((await sh.complete('cat Documents/My\\ F')).line, 'cat Documents/My\\ Folder/');
  assert.equal((await sh.complete('cat Documents/My\\ Folder/in')).line, 'cat Documents/My\\ Folder/inside.txt ');
});

test('T-P1-3: echo text > "a name with spaces" writes the file instead of printing the line', async () => {
  const { fs, run } = await desktop();
  const out = await run('echo hi > "Documents/my notes.txt"');
  assert.deepEqual(out, []);
  assert.ok(await fs.stat('/Documents/my notes.txt'));
  assert.deepEqual(await run("echo more >> 'Documents/my notes.txt'"), []);
  assert.equal(await fs.readText('/Documents/my notes.txt'), 'hi\nmore\n');
  assert.deepEqual(await run('echo two\\ words > Documents/a\\ b.txt'), []);
  assert.equal(await fs.readText('/Documents/a b.txt'), 'two words\n');
  // A > inside quotes is only letters.
  assert.deepEqual(await run('echo "a > b"'), ['a > b']);
  assert.deepEqual(await run("echo 'x >> y.txt'"), ['x >> y.txt']);
});

test('T-P1-4: mv notes.txt NOTES.txt changes the letter case (it said "already exists, remove it first")', async () => {
  const { fs, run } = await desktop();
  await fs.writeText('/Documents/notes.txt', 'x');
  await fs.mkdir('/Documents/Work');
  assert.deepEqual(await run('mv Documents/notes.txt Documents/NOTES.txt'), []);
  assert.deepEqual(await run('mv Documents/Work Documents/work'), []);
  assert.deepEqual((await fs.list('/Documents')).map(e => e.name).sort(), ['NOTES.txt', 'work']);
});

test('T-P1-5: cp into a folder that already has the name says so (it silently made "b (2).txt"); mv a .  says something', async () => {
  const { fs, run } = await desktop();
  await fs.writeText('/Documents/b.txt', 'x');
  const cp = await run('cp Documents/b.txt Documents');
  assert.notDeepEqual(cp, [], 'cp onto itself said nothing and made "b (2).txt"');
  assert.notDeepEqual(await run('mv Documents/b.txt Documents'), []);
  // Into another folder that already has the name: said, and nothing copied or moved.
  await fs.mkdir('/Desktop/Box');
  await fs.writeText('/Desktop/Box/b.txt', 'old');
  assert.match((await run('cp Documents/b.txt Desktop/Box'))[0] ?? '', /already has something called 'b.txt'/);
  assert.match((await run('mv Documents/b.txt Desktop/Box'))[0] ?? '', /already has something called 'b.txt'/);
  assert.deepEqual((await fs.list('/Desktop/Box')).map(e => e.name), ['b.txt']);
  assert.equal(await fs.readText('/Desktop/Box/b.txt'), 'old');
  assert.deepEqual((await fs.list('/Documents')).map(e => e.name), ['b.txt']);
});

test('T-P1-6: mv refuses to move the folder you are standing in (rm already does)', async () => {
  const { sh, run } = await desktop();
  await run('mkdir -p Documents/W/X');
  await run('cd Documents/W/X');
  const out = await run('mv ../../W /Desktop');
  assert.match(out[0] ?? '', /standing in it/);
  assert.equal(sh.cwd, '/Documents/W/X');
});

test('T-P1-7: find, du and grep -r include hidden files (find /System printed nothing)', { todo: 'P1' }, async () => {
  const { fs, run } = await desktop();
  await fs.writeText('/System/session.json', '{}', { hidden: true });
  assert.deepEqual(await run('find /System'), ['/System/session.json']);
});

test('T-P1-8: head shows the start of a file over 512 KB (the refusal says "Try head", and head refuses too)', { todo: 'P1' }, async () => {
  const { fs, run } = await desktop();
  await fs.writeText('/Documents/big.log', 'line\n'.repeat(200000));
  assert.deepEqual(await run('head -n 2 Documents/big.log'), ['line', 'line']);
});

test('T-P1-9: cat of an empty file prints nothing; echo -n is understood; touch with no name says so', { todo: 'P1' }, async () => {
  const { fs, run } = await desktop();
  await fs.writeText('/Documents/empty.txt', '');
  assert.deepEqual(await run('cat Documents/empty.txt'), []);
  assert.deepEqual(await run('echo -n hi'), ['hi']);
  assert.match((await run('touch'))[0] ?? '', /missing/);
});

test('T-P1-10: wc -l prints only the line count; head -n 3 a b shows both files', { todo: 'P1' }, async () => {
  const { fs, run } = await desktop();
  await fs.writeText('/Documents/twelve.txt', twelve);
  assert.match((await run('wc -l Documents/twelve.txt'))[0], /^\s*12 Documents\/twelve\.txt$/);
});

test('T-P1-11: rm -- -name and globs in folder parts (*/x.txt) work', { todo: 'P1' }, async () => {
  const { fs, run } = await desktop();
  await fs.writeText('/Documents/x.txt', 'x');
  assert.deepEqual(await run('ls */x.txt'), ['Documents/x.txt']);
  await fs.writeText('/Documents/-odd', 'x');
  assert.deepEqual(await run('rm -- Documents/-odd'), ['Moved to the Recycle Bin.']);
});

test('T-P1-12: pipes and ; are understood (cat a | grep x said "|: No such file")', { todo: 'P1' }, async () => {
  const { fs, run } = await desktop();
  await fs.writeText('/Documents/twelve.txt', twelve);
  assert.deepEqual(await run('cat Documents/twelve.txt | grep L12'), ['L12']);
});
