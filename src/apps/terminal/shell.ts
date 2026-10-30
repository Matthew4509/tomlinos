// The Terminal's command engine: a Debian-style shell (bash look, GNU command names) over a FileSystem. On the
// desktop it works on the person's REAL files, with the same rules as File Explorer: rm moves to the Recycle Bin,
// the standard folders cannot be removed, nothing reaches the server or the computer. `ssh training` steps into a
// pretend Debian machine that lives in this page's memory, for learning; it is labelled as pretend everywhere.
// Pure of the page: output comes back as lines, so the unit tests can drive a whole session.
import type { FileSystem, Entry } from '../../fs/fs.ts';
import { baseName, joinPath, nameKey, parentPath, splitPath } from '../../fs/names.ts';
import { formatSize } from '../../core/format.ts';

export interface Line {
  text: string;
  kind?: 'err' | 'dim' | 'dir' | 'ok';
}

/** Where the shell is standing: the person's desktop, or the pretend training machine. */
export interface Machine {
  fs: FileSystem;
  user: string;
  host: string;
  /** The folder `~` means, and where a new shell starts. */
  home: string;
  /** rm: the desktop moves to the Recycle Bin (and says so); the training machine deletes. */
  trash(paths: string[]): Promise<string>;
  /** Why this path may not be removed, moved or renamed, or null. */
  protectedReason(path: string): string | null;
  /** Files that are not in the store but a Debian machine shows (/etc/os-release...). */
  virtual?: Record<string, string>;
  /** Opens a file in its desktop app; absent on the training machine. */
  open?(path: string): Promise<void>;
  pretend: boolean;
}

const MAX_READ = 512 * 1024;
const MAX_WALK = 5000;
const utf8 = new TextDecoder('utf-8', { fatal: true });

export const COMMANDS: Array<[string, string]> = [
  ['ls [-l] [-a] [path]', 'list a folder'],
  ['cd [path]', 'change folder (cd alone goes home, cd - goes back)'],
  ['pwd', 'where you are'],
  ['cat / head / tail [-n N] file', 'show a text file (or its start / end)'],
  ['wc file', 'count lines, words and bytes'],
  ['grep [-i] [-r] [-n] text path…', 'find lines holding text'],
  ['find [path] [-name "*.txt"] [-type f|d]', 'find files and folders'],
  ['du [-h] [path]', 'how much space a folder uses'],
  ['tree [path]', 'draw the folders inside'],
  ['mkdir [-p] folder', 'make a folder'],
  ['touch file', 'make an empty file'],
  ['cp [-r] from… to', 'copy'],
  ['mv from… to', 'move or rename'],
  ['rm [-r] path…', 'move to the Recycle Bin (on the desktop)'],
  ['echo text [> file | >> file]', 'print, or write/append to a file'],
  ['open file', 'open it in its desktop app'],
  ['ssh training', 'log in to the pretend Debian training machine'],
  ['scp training:file .', 'copy a file from the training machine to here'],
  ['history, clear, date, whoami, hostname, uname -a, exit', ''],
];

/** "*.txt", "report?.pdf" -> a case-insensitive whole-name pattern. */
export function globToRegex(glob: string): RegExp {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`, 'i');
}
const hasGlob = (s: string) => /[*?]/.test(s);

/** A word of a command line, and whether any of its * or ? was quoted or escaped (then it is a name, not a pattern). */
export interface Word {
  text: string;
  literal: boolean;
}

/**
 * Splits a command line into words: "double" and 'single' quotes, backslash escapes. Each word remembers whether a
 * wildcard in it was quoted: rm "Documents/*.txt" names one file, as in every shell, and used to bin every .txt.
 */
export function splitWordsQuoted(line: string): Word[] {
  const out: Word[] = [];
  let cur = '';
  let literal = false;
  let quote: string | null = null;
  let started = false;
  const add = (c: string, quoted: boolean) => {
    cur += c;
    if (quoted && (c === '*' || c === '?')) literal = true;
  };
  const push = () => {
    out.push({ text: cur, literal });
    cur = '';
    literal = false;
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < line.length) add(line[++i], true);
      else add(c, true);
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (c === '\\' && i + 1 < line.length) {
      add(line[++i], true);
      started = true;
    } else if (/\s/.test(c)) {
      if (started) push();
      cur = '';
      started = false;
    } else {
      add(c, false);
      started = true;
    }
  }
  if (started) push();
  return out;
}

/** The words alone. */
export function splitWords(line: string): string[] {
  return splitWordsQuoted(line).map(w => w.text);
}

class Fail extends Error {}

export class TerminalShell {
  cwd: string;
  private previous: string;
  readonly history: string[] = [];
  /** The machines below the current one (ssh stacks, exit pops). */
  private stack: Array<{ machine: Machine; cwd: string }> = [];
  private knownHosts = new Set<string>();
  /** A question the next line answers (ssh's "continue connecting?" and password). */
  private pending: ((answer: string) => Promise<Line[]>) | null = null;
  /** The input box should hide what is typed (a password). */
  secret = false;
  machine: Machine;
  private makeTraining: () => Promise<Machine>;

  constructor(machine: Machine, makeTraining: () => Promise<Machine>) {
    this.machine = machine;
    this.cwd = machine.home;
    this.previous = machine.home;
    this.makeTraining = makeTraining;
  }

  /** "alex@tomlinos:~/Documents$ " split into its coloured parts. */
  prompt(): { userHost: string; path: string; tail: string } {
    if (this.pending) return { userHost: '', path: '', tail: this.secret ? '' : '' };
    const home = this.machine.home;
    const shown = this.cwd === home ? '~' : this.cwd.startsWith(home === '/' ? '/' : home + '/') ? '~' + this.cwd.slice(home === '/' ? 0 : home.length) : this.cwd;
    return { userHost: `${this.machine.user}@${this.machine.host}`, path: shown, tail: '$ ' };
  }

  get waiting(): boolean {
    return this.pending !== null;
  }

  resolve(arg: string): string {
    let p = arg;
    if (p === '~' || p.startsWith('~/')) p = this.machine.home + p.slice(1);
    const parts = p.startsWith('/') ? [] : splitPath(this.cwd);
    for (const part of p.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') parts.pop();
      else parts.push(part);
    }
    return joinPath(...parts);
  }

  private async stat(path: string): Promise<Entry | { kind: 'folder' | 'file'; name: string; size: number; modified: number } | null> {
    if (splitPath(path).length === 0) return { kind: 'folder', name: '/', size: 0, modified: 0 };
    if (this.machine.virtual?.[path] !== undefined) return { kind: 'file', name: baseName(path), size: this.machine.virtual[path].length, modified: 0 };
    return this.machine.fs.stat(path);
  }

  private async mustStat(path: string, arg: string) {
    const e = await this.stat(path);
    if (!e) throw new Fail(`${arg}: No such file or directory`);
    return e;
  }

  private async readText(path: string, arg: string): Promise<string> {
    if (this.machine.virtual?.[path] !== undefined) return this.machine.virtual[path];
    const e = await this.mustStat(path, arg);
    if (e.kind === 'folder') throw new Fail(`${arg}: Is a directory`);
    if (e.size > MAX_READ) throw new Fail(`${arg}: too big to show here (${formatSize(e.size)}; the terminal shows up to 512 KB). Try head or open.`);
    try {
      return utf8.decode(await this.machine.fs.readFile(path));
    } catch (error) {
      if (error instanceof TypeError) throw new Fail(`${arg}: not a text file (try: open ${arg})`);
      throw error;
    }
  }

  /**
   * Expands *.txt style words against the folder they point into. A pattern matching nothing stays as typed, and so
   * does one that was quoted or escaped (a Word marked literal).
   */
  private async expand(words: Array<string | Word>): Promise<string[]> {
    const out: string[] = [];
    for (const word of words) {
      const w = typeof word === 'string' ? word : word.text;
      if ((typeof word !== 'string' && word.literal) || !hasGlob(w.slice(w.lastIndexOf('/') + 1)) || w.startsWith('-')) {
        out.push(w);
        continue;
      }
      const slash = w.lastIndexOf('/');
      const dirArg = slash >= 0 ? w.slice(0, slash) || '/' : '.';
      const re = globToRegex(w.slice(slash + 1));
      let names: string[] = [];
      try {
        names = (await this.machine.fs.list(this.resolve(dirArg))).map(e => e.name).filter(n => re.test(n)).sort((a, b) => a.localeCompare(b));
      } catch {
        // No such folder: leave the word as typed, the command will say so.
      }
      if (!names.length) out.push(w);
      else out.push(...names.map(n => (slash >= 0 ? `${w.slice(0, slash)}/${n}` : n)));
    }
    return out;
  }

  /** Runs one typed line. */
  async run(input: string): Promise<Line[]> {
    if (this.pending) {
      const answer = this.pending;
      this.pending = null;
      this.secret = false;
      return answer(input);
    }
    const line = input.trim();
    if (!line) return [];
    this.history.push(line);
    if (this.history.length > 500) this.history.shift();
    try {
      return await this.dispatch(line);
    } catch (error) {
      if (error instanceof Fail) return [{ text: error.message, kind: 'err' }];
      return [{ text: error instanceof Error ? error.message : String(error), kind: 'err' }];
    }
  }

  private async dispatch(line: string): Promise<Line[]> {
    // One redirect at the end: echo text > file, echo text >> file.
    let redirect: { path: string; append: boolean } | null = null;
    const m = /^(.*?)\s(>>?)\s*(\S+)\s*$/.exec(line);
    if (m && !/["']/.test(m[3]) && (m[1].split(/["']/).length % 2 === 1)) {
      line = m[1];
      redirect = { path: m[3], append: m[2] === '>>' };
    }
    const [first, ...raw] = splitWordsQuoted(line);
    const cmd = first.text;
    const args = cmd === 'find' || cmd === 'grep' || cmd === 'echo' ? raw.map(w => w.text) : await this.expand(raw);
    const flags = new Set(args.filter(a => /^-[a-zA-Z]+$/.test(a)).flatMap(a => [...a.slice(1)]));
    const plain = args.filter(a => !/^-[a-zA-Z]+$/.test(a));
    const out = await this.command(cmd, args, flags, plain);
    if (!redirect) return out;
    const text = out.filter(l => l.kind !== 'err').map(l => l.text).join('\n') + '\n';
    const path = this.resolve(redirect.path);
    const e = await this.stat(path);
    if (e?.kind === 'folder') throw new Fail(`${redirect.path}: Is a directory`);
    const before = redirect.append && e ? await this.readText(path, redirect.path) : '';
    await this.machine.fs.writeText(path, before + text);
    return out.filter(l => l.kind === 'err');
  }

  private async command(cmd: string, args: string[], flags: Set<string>, plain: string[]): Promise<Line[]> {
    const fs = this.machine.fs;
    switch (cmd) {
      case 'help':
        return [
          { text: `A Debian-style shell over ${this.machine.pretend ? 'the pretend training machine (it lives in this page and is thrown away on exit)' : 'your TOMLIN OS files. rm moves things to the Recycle Bin.'}`, kind: 'dim' },
          ...COMMANDS.map(([c, what]) => ({ text: what ? `  ${c.padEnd(42)} ${what}` : `  ${c}` })),
        ];
      case 'pwd':
        return [{ text: this.cwd }];
      case 'cd': {
        const target = plain[0] === '-' ? this.previous : plain[0] ? this.resolve(plain[0]) : this.machine.home;
        const e = await this.mustStat(target, plain[0] ?? '~');
        if (e.kind !== 'folder') throw new Fail(`cd: ${plain[0]}: Not a directory`);
        this.previous = this.cwd;
        this.cwd = target;
        return plain[0] === '-' ? [{ text: target }] : [];
      }
      case 'ls':
      case 'dir':
        return this.ls(plain.length ? plain : ['.'], flags);
      case 'cat': {
        if (!plain.length) throw new Fail('cat: which file? (cat notes.txt)');
        const out: Line[] = [];
        for (const a of plain) out.push(...(await this.readText(this.resolve(a), a)).replace(/\n$/, '').split('\n').map(text => ({ text })));
        return out;
      }
      case 'head':
      case 'tail': {
        const nIdx = args.indexOf('-n');
        const n = nIdx >= 0 ? Number(args[nIdx + 1]) : 10;
        const files = args.filter((a, i) => !a.startsWith('-') && !(nIdx >= 0 && i === nIdx + 1));
        if (!files.length) throw new Fail(`${cmd}: which file?`);
        if (!Number.isInteger(n) || n < 0) throw new Fail(`${cmd}: invalid number of lines`);
        const lines = (await this.readText(this.resolve(files[0]), files[0])).replace(/\n$/, '').split('\n');
        // slice(-0) is the whole file, so "tail -n 0" is spelt out: nothing.
        return (cmd === 'head' ? lines.slice(0, n) : n === 0 ? [] : lines.slice(-n)).map(text => ({ text }));
      }
      case 'wc': {
        if (!plain.length) throw new Fail('wc: which file?');
        return Promise.all(plain.map(async a => {
          const t = await this.readText(this.resolve(a), a);
          // Lines are counted by their line ends, as every wc does: "one\ntwo" is 1, and an empty file is 0.
          const lines = t.split('\n').length - 1;
          return { text: `${String(lines).padStart(7)} ${String(t.split(/\s+/).filter(Boolean).length).padStart(7)} ${String(new TextEncoder().encode(t).length).padStart(7)} ${a}` };
        }));
      }
      case 'grep':
        return this.grep(args);
      case 'find':
        return this.find(args);
      case 'du':
        return this.du(plain[0] ?? '.', flags.has('h'));
      case 'tree':
        return this.tree(plain[0] ?? '.');
      case 'mkdir': {
        if (!plain.length) throw new Fail('mkdir: missing operand');
        for (const a of plain) {
          const path = this.resolve(a);
          if (flags.has('p')) await fs.ensureFolder(path);
          else {
            if (await this.stat(path)) throw new Fail(`mkdir: cannot create directory '${a}': File exists`);
            if ((await this.stat(parentPath(path)))?.kind !== 'folder') throw new Fail(`mkdir: cannot create directory '${a}': No such file or directory (use mkdir -p)`);
            await fs.mkdir(path);
          }
        }
        return [];
      }
      case 'touch': {
        for (const a of plain) {
          const path = this.resolve(a);
          const e = await this.stat(path);
          if (!e) await fs.writeFile(path, new Uint8Array(0), { mustBeNew: true });
          else if (e.kind === 'file') await fs.writeFile(path, await fs.readFile(path)); // a new "modified" time
        }
        return [];
      }
      case 'cp':
      case 'mv':
        return this.copyMove(cmd, flags, plain);
      case 'rm':
      case 'rmdir': {
        if (!plain.length) throw new Fail(`${cmd}: missing operand`);
        const paths: string[] = [];
        for (const a of plain) {
          const path = this.resolve(a);
          const e = await this.mustStat(path, a);
          if (e.kind === 'folder' && cmd === 'rm' && !flags.has('r') && !flags.has('R')) throw new Fail(`rm: cannot remove '${a}': Is a directory (use rm -r)`);
          if (cmd === 'rmdir' && (e.kind !== 'folder' || (await fs.list(path, true)).length)) throw new Fail(`rmdir: failed to remove '${a}': ${e.kind !== 'folder' ? 'Not a directory' : 'Directory not empty'}`);
          const why = this.machine.protectedReason(path);
          if (why) throw new Fail(`rm: cannot remove '${a}': ${why}`);
          // Compared the way the file system compares names (letter case and Unicode spelling aside), so /documents/work
          // is the same folder as /Documents/Work.
          if (nameKey(this.cwd) === nameKey(path) || nameKey(this.cwd).startsWith(nameKey(path) + '/')) throw new Fail(`rm: cannot remove '${a}': you are standing in it (cd out first)`);
          paths.push(path);
        }
        const said = await this.machine.trash(paths);
        return said ? [{ text: said, kind: 'dim' }] : [];
      }
      case 'echo':
        return [{ text: args.join(' ') }];
      case 'open': {
        if (!this.machine.open) throw new Fail('open: there are no desktop apps on the training machine (exit first)');
        if (!plain.length) throw new Fail('open: which file?');
        for (const a of plain) {
          const path = this.resolve(a);
          await this.mustStat(path, a);
          await this.machine.open(path);
        }
        return [];
      }
      case 'history':
        return this.history.map((h, i) => ({ text: `${String(i + 1).padStart(5)}  ${h}` }));
      case 'date':
        return [{ text: new Date().toString() }];
      case 'whoami':
        return [{ text: this.machine.user }];
      case 'hostname':
        return [{ text: this.machine.host }];
      case 'uname':
        return [{ text: flags.has('a') ? `Linux ${this.machine.host} 6.12.0-tomlinos #1 SMP PREEMPT_DYNAMIC Debian-style (in your browser) x86_64 GNU/Linux` : 'Linux' }];
      case 'ssh':
        return this.ssh(plain[0]);
      case 'scp':
        return this.scp(plain);
      case 'exit':
      case 'logout':
        return this.exit();
      case 'sudo':
        return [{ text: `${this.machine.user} is not in the sudoers file. This incident will be reported.`, kind: 'err' }, { text: '(There is nothing to be root over: this shell only reaches your own files.)', kind: 'dim' }];
      case 'apt':
      case 'apt-get':
      case 'dpkg':
        return [{ text: `${cmd}: programs cannot be installed here. This is a Debian-style shell over your files, not a whole Debian system;`, kind: 'err' }, { text: 'the real Debian comes with the TOMLIN OS boot stick.', kind: 'dim' }];
      case 'nano':
      case 'vi':
      case 'vim':
        if (this.machine.open && plain[0]) {
          const path = this.resolve(plain[0]);
          if (!(await this.stat(path))) await fs.writeFile(path, new Uint8Array(0), { mustBeNew: true });
          await this.machine.open(path);
          return [{ text: `Opened ${plain[0]} in Notepad.`, kind: 'dim' }];
        }
        throw new Fail(`${cmd}: not on this machine. On the desktop, "${cmd} file" opens Notepad.`);
      default:
        return [{ text: `${cmd}: command not found. Type help for the list.`, kind: 'err' }];
    }
  }

  private async ls(targets: string[], flags: Set<string>): Promise<Line[]> {
    const out: Line[] = [];
    for (const t of targets) {
      const path = this.resolve(t);
      const e = await this.mustStat(path, `ls: cannot access '${t}'`);
      let entries: Array<{ name: string; kind: 'file' | 'folder'; size: number; modified: number }>;
      if (e.kind === 'file') entries = [{ ...e, name: t }];
      else {
        entries = await this.machine.fs.list(path, flags.has('a'));
        const extra = Object.keys(this.machine.virtual ?? {}).filter(v => parentPath(v) === path && !entries.some(x => nameKey(x.name) === nameKey(baseName(v))));
        entries.push(...extra.map(v => ({ name: baseName(v), kind: 'file' as const, size: this.machine.virtual![v].length, modified: 0 })));
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      if (targets.length > 1) out.push({ text: `${t}:` });
      if (flags.has('l')) {
        out.push({ text: `total ${entries.length}`, kind: 'dim' });
        for (const x of entries) {
          const when = x.modified ? new Date(x.modified).toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
          const size = flags.has('h') ? formatSize(x.size) : String(x.size);
          out.push({ text: `${x.kind === 'folder' ? 'drwxr-xr-x' : '-rw-r--r--'} ${this.machine.user} ${size.padStart(9)} ${when.padEnd(13)} ${x.name}`, kind: x.kind === 'folder' ? 'dir' : undefined });
        }
      } else {
        for (const x of entries) out.push({ text: x.name + (x.kind === 'folder' ? '/' : ''), kind: x.kind === 'folder' ? 'dir' : undefined });
      }
    }
    return out;
  }

  /** Every item under `root` (breadth first, capped), paths absolute. */
  private async walk(root: string): Promise<Array<{ path: string; entry: Entry }>> {
    const out: Array<{ path: string; entry: Entry }> = [];
    const queue = [root];
    while (queue.length && out.length < MAX_WALK) {
      const folder = queue.shift()!;
      for (const entry of await this.machine.fs.list(folder)) {
        const path = joinPath(folder, entry.name);
        out.push({ path, entry });
        if (entry.kind === 'folder') queue.push(path);
      }
    }
    return out;
  }

  private shown(path: string, arg: string, root: string): string {
    const rel = path.slice(root === '/' ? 1 : root.length + 1);
    return arg === '.' ? `./${rel}` : `${arg.replace(/\/$/, '')}/${rel}`;
  }

  private async find(args: string[]): Promise<Line[]> {
    const start = args[0] && !args[0].startsWith('-') ? args[0] : '.';
    const nameAt = args.indexOf('-name') >= 0 ? args.indexOf('-name') : args.indexOf('-iname');
    const typeAt = args.indexOf('-type');
    const re = nameAt >= 0 ? globToRegex(args[nameAt + 1] ?? '*') : null;
    const type = typeAt >= 0 ? args[typeAt + 1] : null;
    const root = this.resolve(start);
    await this.mustStat(root, `find: '${start}'`);
    return (await this.walk(root))
      .filter(({ entry }) => (!re || re.test(entry.name)) && (!type || (type === 'd') === (entry.kind === 'folder')))
      .map(({ path, entry }) => ({ text: this.shown(path, start, root), kind: entry.kind === 'folder' ? 'dir' : undefined }));
  }

  private async grep(args: string[]): Promise<Line[]> {
    const flags = new Set(args.filter(a => /^-[a-zA-Z]+$/.test(a)).flatMap(a => [...a.slice(1)]));
    const [pattern, ...targets] = args.filter(a => !/^-[a-zA-Z]+$/.test(a));
    if (pattern === undefined || !targets.length) throw new Fail('grep: usage: grep [-i] [-r] [-n] text file-or-folder…');
    const needle = flags.has('i') ? pattern.toLowerCase() : pattern;
    const out: Line[] = [];
    const files: Array<{ path: string; label: string }> = [];
    for (const t of await this.expand(targets)) {
      const path = this.resolve(t);
      const e = await this.mustStat(path, `grep: ${t}`);
      if (e.kind === 'file') files.push({ path, label: t });
      else if (flags.has('r') || flags.has('R')) {
        for (const w of await this.walk(path)) if (w.entry.kind === 'file' && w.entry.size <= MAX_READ) files.push({ path: w.path, label: this.shown(w.path, t, path) });
      } else out.push({ text: `grep: ${t}: Is a directory`, kind: 'err' });
    }
    const many = files.length > 1 || flags.has('r') || flags.has('R');
    for (const f of files) {
      let text: string;
      try {
        text = await this.readText(f.path, f.label);
      } catch {
        continue; // Pictures and other non-text files are skipped, as grep -I does.
      }
      text.split('\n').forEach((l, i) => {
        if ((flags.has('i') ? l.toLowerCase() : l).includes(needle)) out.push({ text: `${many ? f.label + ':' : ''}${flags.has('n') ? i + 1 + ':' : ''}${l}` });
      });
      if (out.length > 2000) {
        out.push({ text: '(stopped at 2000 lines)', kind: 'dim' });
        break;
      }
    }
    return out;
  }

  private async du(arg: string, human: boolean): Promise<Line[]> {
    const root = this.resolve(arg);
    const e = await this.mustStat(root, `du: cannot access '${arg}'`);
    const total = e.kind === 'file' ? e.size : (await this.walk(root)).reduce((n, w) => n + w.entry.size, 0);
    return [{ text: `${human ? formatSize(total) : Math.ceil(total / 1024)}\t${arg}` }];
  }

  private async tree(arg: string): Promise<Line[]> {
    const root = this.resolve(arg);
    const out: Line[] = [{ text: arg, kind: 'dir' }];
    let dirs = 0;
    let files = 0;
    const draw = async (path: string, indent: string) => {
      const entries = (await this.machine.fs.list(path)).sort((a, b) => a.name.localeCompare(b.name));
      for (const [i, e] of entries.entries()) {
        if (dirs + files > MAX_WALK) return;
        const last = i === entries.length - 1;
        out.push({ text: `${indent}${last ? '└── ' : '├── '}${e.name}`, kind: e.kind === 'folder' ? 'dir' : undefined });
        if (e.kind === 'folder') {
          dirs++;
          await draw(joinPath(path, e.name), indent + (last ? '    ' : '│   '));
        } else files++;
      }
    };
    if ((await this.mustStat(root, arg)).kind !== 'folder') throw new Fail(`tree: ${arg}: Not a directory`);
    await draw(root, '');
    out.push({ text: `\n${dirs} director${dirs === 1 ? 'y' : 'ies'}, ${files} file${files === 1 ? '' : 's'}`, kind: 'dim' });
    return out;
  }

  private async copyMove(cmd: 'cp' | 'mv', flags: Set<string>, plain: string[]): Promise<Line[]> {
    const fs = this.machine.fs;
    if (plain.length < 2) throw new Fail(`${cmd}: missing destination (${cmd} from to)`);
    const destArg = plain[plain.length - 1];
    const dest = this.resolve(destArg);
    const sources = plain.slice(0, -1).map(a => ({ a, path: this.resolve(a) }));
    for (const s of sources) {
      const e = await this.mustStat(s.path, `${cmd}: cannot stat '${s.a}'`);
      if (cmd === 'cp' && e.kind === 'folder' && !flags.has('r') && !flags.has('R')) throw new Fail(`cp: -r not specified; omitting directory '${s.a}'`);
      if (cmd === 'mv') {
        const why = this.machine.protectedReason(s.path);
        if (why) throw new Fail(`mv: cannot move '${s.a}': ${why}`);
      }
    }
    const d = await this.stat(dest);
    if (d?.kind === 'folder') {
      const paths = sources.map(s => s.path);
      if (cmd === 'cp') await fs.copy(paths, dest);
      else await fs.move(paths, dest);
      return [];
    }
    if (sources.length > 1) throw new Fail(`${cmd}: target '${destArg}' is not a directory`);
    const src = sources[0].path;
    if (d) throw new Fail(`${cmd}: '${destArg}' already exists (nothing is overwritten here; remove it first)`);
    if ((await this.stat(parentPath(dest)))?.kind !== 'folder') throw new Fail(`${cmd}: cannot create '${destArg}': No such directory`);
    if (cmd === 'mv' && nameKey(parentPath(src)) === nameKey(parentPath(dest))) {
      await fs.rename(src, baseName(dest));
      return [];
    }
    if (cmd === 'mv') {
      // Move, then rename in its new folder (two steps: the file system moves under the same name).
      if (await this.stat(joinPath(parentPath(dest), baseName(src)))) throw new Fail(`mv: '${parentPath(dest)}' already has something called '${baseName(src)}'`);
      await fs.move([src], parentPath(dest));
      if (baseName(src) !== baseName(dest)) await fs.rename(joinPath(parentPath(dest), baseName(src)), baseName(dest));
      return [];
    }
    const e = await this.mustStat(src, src);
    if (e.kind === 'file') {
      await fs.writeFile(dest, await fs.readFile(src), { mustBeNew: true });
      return [];
    }
    const [copied] = await fs.copy([src], parentPath(dest));
    await fs.rename(joinPath(parentPath(dest), copied.name), baseName(dest));
    return [];
  }

  // ---- Training ssh ----------------------------------------------------------------------------------------------

  private async ssh(target: string | undefined): Promise<Line[]> {
    if (!target) throw new Fail('usage: ssh [user@]host   (try: ssh training)');
    const host = target.includes('@') ? target.slice(target.indexOf('@') + 1) : target;
    const user = target.includes('@') ? target.slice(0, target.indexOf('@')) : 'learner';
    if (!/^(training|training\.lan|10\.0\.0\.20)$/i.test(host)) {
      return [
        { text: `ssh: connect to host ${host} port 22: Network is unreachable`, kind: 'err' },
        { text: 'A web page cannot open ssh connections, so only the pretend machine "training" answers here.', kind: 'dim' },
      ];
    }
    if (this.machine.pretend) throw new Fail('You are already on the training machine. Type exit to go back.');
    const connect = async (): Promise<Line[]> => {
      this.secret = true;
      this.pending = async password => {
        if (user !== 'learner' || password !== 'learner') {
          return [{ text: 'Permission denied, please try again. (The training login is learner / learner.)', kind: 'err' }];
        }
        const machine = await this.makeTraining();
        this.stack.push({ machine: this.machine, cwd: this.cwd });
        this.machine = machine;
        this.cwd = machine.home;
        this.previous = machine.home;
        return [
          { text: 'Linux training 6.12.0-amd64 #1 SMP PREEMPT_DYNAMIC Debian 6.12 (pretend) x86_64' },
          { text: '' },
          { text: 'PRETEND MACHINE for learning. It lives in this page; nothing you do here leaves it,', kind: 'ok' },
          { text: 'and it is reset when you exit. Start with: cat README.txt', kind: 'ok' },
          { text: `Last login: ${new Date(Date.now() - 86400000).toDateString()} from 10.0.0.2`, kind: 'dim' },
        ];
      };
      return [{ text: `${user}@${host}'s password:`, kind: 'dim' }];
    };
    const key = 'training';
    if (this.knownHosts.has(key)) return connect();
    this.pending = async answer => {
      if (!/^yes$/i.test(answer.trim())) return [{ text: 'Host key verification failed.', kind: 'err' }];
      this.knownHosts.add(key);
      return [{ text: `Warning: Permanently added '${host}' (ED25519) to the list of known hosts.`, kind: 'dim' }, ...(await connect())];
    };
    return [
      { text: `The authenticity of host '${host} (10.0.0.20)' can't be established.` },
      { text: 'ED25519 key fingerprint is SHA256:Tr41n1ngMach1neOnlyN0tAReal/Key+TomlinOS0Qx.' },
      { text: 'This key is not known by any other names.' },
      { text: 'Are you sure you want to continue connecting (yes/no/[fingerprint])?', kind: 'dim' },
    ];
  }

  private async exit(): Promise<Line[]> {
    const below = this.stack.pop();
    if (!below) return [{ text: 'logout', kind: 'dim' }, { text: '(Close the window to end the terminal.)', kind: 'dim' }];
    this.machine = below.machine;
    this.cwd = below.cwd;
    this.previous = below.cwd;
    return [{ text: 'logout' }, { text: 'Connection to training closed. The training machine was reset.', kind: 'dim' }];
  }

  private async scp(plain: string[]): Promise<Line[]> {
    const [from, to] = plain;
    const remote = /^(?:learner@)?training(?:\.lan)?:(.+)$/i.exec(from ?? '');
    if (!remote || !to) throw new Fail('usage: scp training:path/on/training local-folder   (e.g. scp training:notes/tips.txt .)');
    if (this.machine.pretend) throw new Fail('Run scp from your desktop (exit first); it copies FROM the training machine TO your files.');
    const training = await this.makeTraining();
    const rpath = joinPath(...splitPath(remote[1].startsWith('/') ? remote[1] : `${training.home}/${remote[1]}`));
    const e = await training.fs.stat(rpath);
    if (!e || e.kind !== 'file') throw new Fail(`scp: ${remote[1]}: No such file`);
    const bytes = await training.fs.readFile(rpath);
    const dest = this.resolve(to);
    const d = await this.stat(dest);
    const target = d?.kind === 'folder' ? joinPath(dest, e.name) : dest;
    if (await this.stat(target)) throw new Fail(`scp: '${baseName(target)}' already exists here (nothing is overwritten)`);
    await this.machine.fs.writeFile(target, bytes, { mustBeNew: true });
    return [{ text: `${e.name.padEnd(30)} 100% ${formatSize(bytes.length).padStart(9)}   pretend link   00:00`, kind: 'dim' }];
  }

  /** Tab: completes the last word against the folder it points into; returns the new line, or the choices. */
  async complete(line: string): Promise<{ line: string; choices: string[] }> {
    const at = line.lastIndexOf(' ') + 1;
    const word = line.slice(at);
    if (at === 0) {
      const names = COMMANDS.flatMap(([c]) => c.split(/[\s,/]+/)).filter(w => /^[a-z]+$/.test(w));
      const hits = [...new Set(['help', ...names])].filter(n => n.startsWith(word)).sort();
      return hits.length === 1 ? { line: hits[0] + ' ', choices: [] } : { line, choices: hits };
    }
    const slash = word.lastIndexOf('/');
    const dirArg = slash >= 0 ? word.slice(0, slash) || '/' : '.';
    const stem = word.slice(slash + 1).toLowerCase();
    let entries: Entry[] = [];
    try {
      entries = (await this.machine.fs.list(this.resolve(dirArg))).filter(e => e.name.toLowerCase().startsWith(stem));
    } catch {
      return { line, choices: [] };
    }
    const quote = (s: string) => s.replace(/([\s'"\\])/g, '\\$1');
    if (entries.length === 1) {
      const e = entries[0];
      return { line: line.slice(0, at) + (slash >= 0 ? word.slice(0, slash + 1) : '') + quote(e.name) + (e.kind === 'folder' ? '/' : ' '), choices: [] };
    }
    // Several: fill in what they all share, and list them.
    let common = entries[0]?.name ?? '';
    for (const e of entries) while (!e.name.toLowerCase().startsWith(common.toLowerCase())) common = common.slice(0, -1);
    const filled = common.length > stem.length ? line.slice(0, at) + (slash >= 0 ? word.slice(0, slash + 1) : '') + quote(common) : line;
    return { line: filled, choices: entries.map(e => e.name + (e.kind === 'folder' ? '/' : '')).sort() };
  }
}
