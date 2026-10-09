// The Terminal's engine, driven like a person typing: real-file commands (with the desktop's rules), the redirect,
// wildcards, Tab, and the training ssh / scp round trip.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileSystem } from '../src/fs/fs.ts';
import { MemoryStore } from '../src/store/memory-store.ts';
import { protectedReason } from '../src/shell/actions.ts';
import { globToRegex, splitWords, TerminalShell, type Machine } from '../src/apps/terminal/shell.ts';
import { makeTrainingMachine } from '../src/apps/terminal/training.ts';

async function desktop() {
  const fs = new FileSystem(new MemoryStore());
  const binned: string[][] = [];
  const opened: string[] = [];
  const machine: Machine = {
    fs, user: 'alex', host: 'tomlinos', home: '/', pretend: false, protectedReason,
    virtual: { '/etc/os-release': 'ID_LIKE=debian\n' },
    async trash(paths) {
      binned.push(paths);
      await fs.remove(paths);
      return 'Moved to the Recycle Bin.';
    },
    async open(path) {
      opened.push(path);
    },
  };
  const sh = new TerminalShell(machine, makeTrainingMachine);
  const run = async (line: string) => (await sh.run(line)).map(l => l.text);
  return { fs, sh, run, binned, opened };
}

test('words, quotes and wildcards', () => {
  assert.deepEqual(splitWords(`mkdir "My Folder" it\\'s 'a b'`), ['mkdir', 'My Folder', "it's", 'a b']);
  assert.ok(globToRegex('*.TXT').test('notes.txt'));
  assert.ok(!globToRegex('a?.txt').test('abc.txt'));
});

test('walking and reading real files', async () => {
  const { fs, sh, run } = await desktop();
  await fs.writeText('/Documents/notes.txt', 'one\ntwo Magnolia\nthree\n');
  assert.equal(sh.prompt().path, '~');
  assert.deepEqual(await run('ls'), ['Desktop/', 'Documents/', 'Music/', 'Pictures/', 'Videos/']);
  await run('cd Documents');
  assert.equal(sh.prompt().path, '~/Documents');
  assert.deepEqual(await run('cat notes.txt'), ['one', 'two Magnolia', 'three']);
  assert.deepEqual(await run('tail -n 1 notes.txt'), ['three']);
  assert.deepEqual(await run('grep -in magnolia notes.txt'), ['2:two Magnolia']);
  assert.deepEqual(await run('grep -r three ~'), ['~/Documents/notes.txt:three']);
  assert.deepEqual(await run('find ~ -name "*.txt"'), ['~/Documents/notes.txt']);
  assert.deepEqual(await run('cd ..'), []);
  assert.deepEqual(await run('cat /etc/os-release'), ['ID_LIKE=debian']);
  assert.match((await run('cat nothing.txt'))[0], /No such file or directory/);
  assert.match((await run('frobnicate'))[0], /command not found/);
});

test('changing files: mkdir, echo >, >>, cp, mv, rename, wildcard rm to the bin', async () => {
  const { fs, run, binned } = await desktop();
  await run('mkdir -p Documents/Work/Old');
  await run('echo first line > Documents/Work/a.txt');
  await run('echo second >> Documents/Work/a.txt');
  assert.equal(await fs.readText('/Documents/Work/a.txt'), 'first line\nsecond\n');
  await run('cp Documents/Work/a.txt Documents/Work/b.txt');
  await run('mv Documents/Work/b.txt Documents/Work/c.txt');
  await run('mv Documents/Work/c.txt Documents/Work/Old');
  assert.deepEqual((await fs.list('/Documents/Work/Old')).map(e => e.name), ['c.txt']);
  await run('mv Documents/Work/a.txt Documents/Work/Old/renamed.txt');
  assert.deepEqual((await fs.list('/Documents/Work/Old')).map(e => e.name).sort(), ['c.txt', 'renamed.txt']);
  assert.match((await run('cp Documents/Work/Old/c.txt Documents/Work/Old/renamed.txt'))[0], /already exists/, 'never overwrites');
  assert.deepEqual(await run('rm Documents/Work/Old/*.txt'), ['Moved to the Recycle Bin.']);
  assert.deepEqual(binned[0], ['/Documents/Work/Old/c.txt', '/Documents/Work/Old/renamed.txt']);
  assert.match((await run('rm Documents'))[0], /Is a directory/);
  assert.match((await run('rm -r Documents'))[0], /cannot remove 'Documents'/, 'standard folders are kept');
});

test('open and nano go to the desktop apps; sudo and apt explain themselves', async () => {
  const { run, opened } = await desktop();
  await run('nano Documents/todo.txt');
  assert.deepEqual(opened, ['/Documents/todo.txt']);
  assert.match((await run('sudo ls'))[0], /sudoers/);
  assert.match((await run('apt install vim'))[0], /cannot be installed/);
});

test('Tab completes a unique name and lists several', async () => {
  const { fs, run, sh } = await desktop();
  await fs.writeText('/Documents/report 2026.txt', '');
  await fs.writeText('/Documents/recipes.txt', '');
  await run('cd Documents');
  assert.deepEqual(await sh.complete('cat rep'), { line: 'cat report\\ 2026.txt ', choices: [] });
  assert.deepEqual((await sh.complete('cat re')).choices, ['recipes.txt', 'report 2026.txt']);
  assert.equal((await sh.complete('gr')).line, 'grep ');
});

test('training ssh: host key question, password, a pretend Debian, exit resets it; scp brings a file home', async () => {
  const { fs, sh, run } = await desktop();
  assert.match((await run('ssh example.com'))[0], /Network is unreachable/);
  assert.match((await run('ssh training')).join('\n'), /authenticity of host/);
  assert.match((await run('yes')).join('\n'), /password:/);
  assert.ok(sh.secret, 'the password is not shown');
  assert.match((await run('wrong')).join('\n'), /Permission denied/);
  await run('ssh training');
  await run('learner');
  assert.equal(sh.prompt().userHost, 'learner@training');
  assert.match((await run('cat /etc/os-release'))[0], /Debian GNU\/Linux 13/);
  assert.deepEqual(await run('ls -a .secret'), ['well-done.txt']);
  assert.match((await run('ls')).join(' '), /README\.txt/);
  await run('rm -r notes');
  assert.match((await run('ls')).join(' '), /^(?!.*notes)/);
  assert.match((await run('rm -r /etc'))[0], /Permission denied/);
  await run('exit');
  assert.equal(sh.prompt().userHost, 'alex@tomlinos');
  assert.deepEqual(await fs.list('/Documents'), [], 'nothing on the training machine touched the real files');
  await run('ssh training');
  await run('learner');
  assert.match((await run('ls notes')).join(' '), /tips\.txt/, 'a new login is a fresh machine');
  await run('exit');
  await run('scp training:notes/tips.txt ~/Documents');
  assert.match(await fs.readText('/Documents/tips.txt'), /Debian tips/);
});
