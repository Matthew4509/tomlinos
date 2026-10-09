// Files and folders, built out of store records (src/store). Every folder is one record holding its list of
// entries; every file is one record holding its bytes. Only the root folder has a fixed key ("/"); everything else
// has a random key, so the server never learns a name.
//
// Every change is ONE store commit, so it happens completely or not at all. Each commit names the version of every
// folder it read; if another window or device changed one of them first, the store refuses, and the change is
// worked out again from fresh copies (up to three times) instead of overwriting what the other device did.
//
// Saving over a file writes its bytes to a NEW record and deletes the old one in the same commit. That way the
// folder record changes too, so two devices saving the same file are caught like any other clash.
import { baseName, joinPath, nameKey, nameProblem, parentPath, splitPath, uniqueName } from './names.ts';
import { FsError } from './errors.ts';
import { newKey, ROOT_KEY, StoreConflict, type Store, type StoreOp } from '../store/store.ts';

export interface Entry {
  name: string;
  /** The store key holding the file's bytes or the folder's entry list. */
  id: string;
  kind: 'file' | 'folder';
  /** Bytes; 0 for a folder. */
  size: number;
  /** Milliseconds since 1970. */
  modified: number;
  /** Kept out of File Explorer and the desktop (the desktop's own settings). */
  hidden?: boolean;
}

interface FolderRecord {
  v: 1;
  entries: Entry[];
}


export { FsError };

export const STANDARD_FOLDERS = ['Desktop', 'Documents', 'Pictures', 'Videos', 'Music'];
export const SYSTEM_FOLDER = 'System';

const MAX_TRIES = 3;
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

function encodeFolder(folder: FolderRecord): Uint8Array {
  return utf8.encode(JSON.stringify(folder));
}

function decodeFolder(key: string, data: Uint8Array): FolderRecord {
  try {
    const parsed = JSON.parse(fromUtf8.decode(data));
    if (parsed && parsed.v === 1 && Array.isArray(parsed.entries)) return parsed;
  } catch {
    // Reported below.
  }
  throw new FsError(`A folder's record is damaged (${key}). Its files may still be safe; the store needs repairing.`);
}

function findEntry(folder: FolderRecord, name: string): Entry | undefined {
  const key = nameKey(name);
  return folder.entries.find(e => nameKey(e.name) === key);
}

/** Drops any path inside another path of the list: acting on the outer one already covers it. */
function outermost(paths: string[]): string[] {
  const norm = [...new Set(paths.map(p => joinPath(p)))];
  const key = (p: string) => nameKey(p) + '/';
  return norm.filter(p => !norm.some(q => q !== p && key(p).startsWith(key(q))));
}

function checkName(name: string): void {
  const problem = nameProblem(name);
  if (problem) throw new FsError(problem);
}

/** One attempt at a change: the folders it read (with their versions) and the operations it will commit. */
class Change {
  private fs: FileSystem;
  private read = new Map<string, { version: string; folder: FolderRecord }>();
  private written = new Map<string, FolderRecord>();
  readonly ops: StoreOp[] = [];

  constructor(fs: FileSystem) {
    this.fs = fs;
  }

  async folder(key: string): Promise<FolderRecord> {
    const written = this.written.get(key);
    if (written) return written;
    let seen = this.read.get(key);
    if (!seen) {
      seen = await this.fs.loadFolder(key);
      this.read.set(key, seen);
    }
    return structuredClone(seen.folder);
  }

  /** The version this change read a folder at ("" if it did not exist). */
  versionOf(key: string): string {
    return this.read.get(key)?.version ?? '';
  }

  /** Walks a path of folder names from the root; returns the folder's key. */
  async folderKey(path: string): Promise<string> {
    let key = ROOT_KEY;
    for (const part of splitPath(path)) {
      const entry = findEntry(await this.folder(key), part);
      if (!entry) throw new FsError(`The folder "${part}" is not there any more. It may have been moved or deleted.`);
      if (entry.kind !== 'folder') throw new FsError(`"${part}" is a file, not a folder.`);
      key = entry.id;
    }
    return key;
  }

  async entry(path: string): Promise<{ parent: string; entry: Entry }> {
    const name = baseName(path);
    if (!name) throw new FsError('That is the top folder; it cannot be changed.');
    const parent = await this.folderKey(parentPath(path));
    const entry = findEntry(await this.folder(parent), name);
    if (!entry) throw new FsError(`"${name}" is not there any more. It may have been moved or deleted.`);
    return { parent, entry };
  }

  saveFolder(key: string, folder: FolderRecord, isNew = false): void {
    this.written.set(key, folder);
    this.ops.push({ op: 'put', key, expect: isNew ? '' : this.versionOf(key), data: encodeFolder(folder) });
  }

  putBytes(key: string, data: Uint8Array): void {
    this.ops.push({ op: 'put', key, expect: '', data });
  }

  /** Deletes a record. A folder must still be at the version read, or something new inside it would be lost. */
  drop(key: string, kind: 'file' | 'folder'): void {
    this.ops.push({ op: 'del', key, expect: kind === 'folder' ? this.versionOf(key) : '*' });
  }

  /** Every record under a folder, deepest first, for deleting it. */
  async collect(entry: Entry, into: Array<{ key: string; kind: 'file' | 'folder' }>): Promise<void> {
    if (entry.kind === 'folder') {
      for (const child of (await this.folder(entry.id)).entries) await this.collect(child, into);
    }
    into.push({ key: entry.id, kind: entry.kind });
  }

  async bytesOf(entry: Entry): Promise<Uint8Array> {
    return this.fs.readRecord(entry.id, entry.name);
  }

  commitCache(versions: Record<string, string>): void {
    for (const [key, version] of Object.entries(versions)) {
      const folder = this.written.get(key);
      if (version && folder) this.fs.remember(key, version, folder);
      else this.fs.forget(key);
    }
  }
}

export class FileSystem {
  readonly store: Store;
  private cache = new Map<string, { version: string; folder: FolderRecord }>();
  private listeners = new Set<(paths: string[]) => void>();

  constructor(store: Store) {
    this.store = store;
  }

  /** Called with the folder paths that changed after every change made through this object. */
  onChange(listener: (paths: string[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  remember(key: string, version: string, folder: FolderRecord): void {
    this.cache.set(key, { version, folder: structuredClone(folder) });
  }

  forget(key: string): void {
    this.cache.delete(key);
  }

  async loadFolder(key: string, fresh = false): Promise<{ version: string; folder: FolderRecord }> {
    const cached = !fresh && this.cache.get(key);
    if (cached) return cached;
    const record = await this.store.get(key);
    if (!record) {
      if (key === ROOT_KEY) return this.createRoot();
      throw new FsError('A folder is not there any more. It may have been deleted in another window.');
    }
    const loaded = { version: record.version, folder: decodeFolder(key, record.data) };
    this.cache.set(key, loaded);
    return loaded;
  }

  /** The first time a store is used: the top folder with Desktop, Documents, Pictures, Videos, Music, System. */
  private async createRoot(): Promise<{ version: string; folder: FolderRecord }> {
    const now = Date.now();
    const ops: StoreOp[] = [];
    const entries: Entry[] = [];
    for (const name of [...STANDARD_FOLDERS, SYSTEM_FOLDER]) {
      const id = newKey();
      ops.push({ op: 'put', key: id, expect: '', data: encodeFolder({ v: 1, entries: [] }) });
      entries.push({ name, id, kind: 'folder', size: 0, modified: now, ...(name === SYSTEM_FOLDER ? { hidden: true } : {}) });
    }
    const root: FolderRecord = { v: 1, entries };
    ops.push({ op: 'put', key: ROOT_KEY, expect: '', data: encodeFolder(root) });
    try {
      const versions = await this.store.commit(ops);
      this.remember(ROOT_KEY, versions[ROOT_KEY], root);
      return { version: versions[ROOT_KEY], folder: root };
    } catch (error) {
      // Another window created it at the same moment: use theirs.
      if (error instanceof StoreConflict) return this.loadFolder(ROOT_KEY, true);
      throw error;
    }
  }

  async readRecord(key: string, name: string): Promise<Uint8Array> {
    const record = await this.store.get(key);
    if (!record) throw new FsError(`"${name}" is not there any more. It may have been deleted in another window.`);
    return record.data;
  }

  /**
   * Runs a change, retrying from fresh copies if another window or device got in first. `plan` must only read
   * through the Change it is given and must not have side effects, because it may run more than once.
   */
  private async change<T>(plan: (c: Change) => Promise<{ result: T; changed: string[] }>): Promise<T> {
    // Changes made from this window run one after another, so two of our own saves never collide with each other
    // (only another window or device can cause a clash).
    const run = this.queue.then(() => this.attempt(plan));
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private queue: Promise<void> = Promise.resolve();

  private async attempt<T>(plan: (c: Change) => Promise<{ result: T; changed: string[] }>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const c = new Change(this);
      const { result, changed } = await plan(c);
      try {
        c.commitCache(await this.store.commit(c.ops));
      } catch (error) {
        if (!(error instanceof StoreConflict)) throw error;
        this.cache.clear();
        if (attempt >= MAX_TRIES) {
          throw new FsError('Another window or device kept changing these files at the same time, so nothing was changed. Try again.');
        }
        continue;
      }
      for (const listener of this.listeners) listener(changed);
      return result;
    }
  }

  // ---- Reading -------------------------------------------------------------------------------------------------

  /** The entries of a folder, read fresh from the store. Hidden entries only when asked. */
  async list(path: string, withHidden = false): Promise<Entry[]> {
    let key = ROOT_KEY;
    for (const part of splitPath(path)) {
      const entry = findEntry((await this.loadFolder(key)).folder, part);
      if (!entry || entry.kind !== 'folder') {
        // The cached copy may be old; look again before saying it is gone.
        const again = findEntry((await this.loadFolder(key, true)).folder, part);
        if (!again || again.kind !== 'folder') throw new FsError(`The folder "${part}" is not there. It may have been moved or deleted.`);
        key = again.id;
      } else {
        key = entry.id;
      }
    }
    const { folder } = await this.loadFolder(key, true);
    return folder.entries.filter(e => withHidden || !e.hidden).map(e => ({ ...e }));
  }

  /** The entry at a path, or null if nothing is there. The top folder has no entry. */
  async stat(path: string): Promise<Entry | null> {
    const name = baseName(path);
    if (!name) return null;
    try {
      const siblings = await this.list(parentPath(path), true);
      return siblings.find(e => nameKey(e.name) === nameKey(name)) ?? null;
    } catch (error) {
      if (error instanceof FsError) return null;
      throw error;
    }
  }

  async exists(path: string): Promise<boolean> {
    return splitPath(path).length === 0 || (await this.stat(path)) !== null;
  }

  async readFile(path: string): Promise<Uint8Array> {
    const entry = await this.stat(path);
    if (!entry) throw new FsError(`"${baseName(path)}" is not there. It may have been moved or deleted.`);
    if (entry.kind !== 'file') throw new FsError(`"${entry.name}" is a folder, not a file.`);
    return this.readRecord(entry.id, entry.name);
  }

  async readText(path: string): Promise<string> {
    return fromUtf8.decode(await this.readFile(path));
  }

  // ---- Changing ------------------------------------------------------------------------------------------------

  /** Creates the file, or replaces its contents if it exists. Returns the saved entry. */
  async writeFile(path: string, data: Uint8Array, options: { hidden?: boolean; mustBeNew?: boolean } = {}): Promise<Entry> {
    const name = baseName(path);
    checkName(name);
    return this.change(async c => {
      const parentKey = await c.folderKey(parentPath(path));
      const folder = await c.folder(parentKey);
      const old = findEntry(folder, name);
      if (old && (old.kind === 'folder' || options.mustBeNew)) {
        throw new FsError(`There is already ${old.kind === 'folder' ? 'a folder' : 'a file'} called "${old.name}" here.`);
      }
      const id = newKey();
      c.putBytes(id, data);
      const entry: Entry = { name: old?.name ?? name, id, kind: 'file', size: data.length, modified: Date.now() };
      if (options.hidden ?? old?.hidden) entry.hidden = true;
      if (old) {
        c.drop(old.id, 'file');
        folder.entries[folder.entries.indexOf(old)] = entry;
      } else {
        folder.entries.push(entry);
      }
      c.saveFolder(parentKey, folder);
      return { result: { ...entry }, changed: [parentPath(path)] };
    });
  }

  async writeText(path: string, text: string, options?: { hidden?: boolean }): Promise<Entry> {
    return this.writeFile(path, utf8.encode(text), options);
  }

  async mkdir(path: string, options: { hidden?: boolean } = {}): Promise<Entry> {
    const name = baseName(path);
    checkName(name);
    return this.change(async c => {
      const parentKey = await c.folderKey(parentPath(path));
      const folder = await c.folder(parentKey);
      const old = findEntry(folder, name);
      if (old) throw new FsError(`There is already ${old.kind === 'folder' ? 'a folder' : 'a file'} called "${old.name}" here.`);
      const id = newKey();
      c.saveFolder(id, { v: 1, entries: [] }, true);
      const entry: Entry = { name, id, kind: 'folder', size: 0, modified: Date.now(), ...(options.hidden ? { hidden: true } : {}) };
      folder.entries.push(entry);
      c.saveFolder(parentKey, folder);
      return { result: { ...entry }, changed: [parentPath(path)] };
    });
  }

  /** Creates any missing folders along a path (for the desktop's own System folder and its settings). */
  async ensureFolder(path: string, options: { hidden?: boolean } = {}): Promise<void> {
    const parts = splitPath(path);
    for (let i = 1; i <= parts.length; i++) {
      const sub = joinPath(...parts.slice(0, i));
      if (!(await this.exists(sub))) {
        try {
          await this.mkdir(sub, i === parts.length ? options : {});
        } catch (error) {
          if (!(error instanceof FsError && (await this.exists(sub)))) throw error;
        }
      }
    }
  }

  async rename(path: string, newName: string): Promise<Entry> {
    checkName(newName);
    return this.change(async c => {
      const { parent, entry } = await c.entry(path);
      const folder = await c.folder(parent);
      const clash = findEntry(folder, newName);
      if (clash && clash.id !== entry.id) throw new FsError(`There is already something called "${clash.name}" here.`);
      const renamed = { ...entry, name: newName };
      folder.entries = folder.entries.map(e => (e.id === entry.id ? renamed : e));
      c.saveFolder(parent, folder);
      return { result: renamed, changed: [parentPath(path)] };
    });
  }

  /** Moves entries into a folder, keeping their names. Refuses (and moves nothing) if a name is already taken. */
  async move(paths: string[], toFolder: string): Promise<Entry[]> {
    return this.change(async c => {
      const destKey = await c.folderKey(toFolder);
      const ancestors = await this.ancestorKeys(c, toFolder);
      const moved: Entry[] = [];
      const changed = new Set([joinPath(toFolder)]);
      for (const path of outermost(paths)) {
        const { parent, entry } = await c.entry(path);
        if (parent === destKey) continue;
        if (entry.kind === 'folder' && ancestors.includes(entry.id)) {
          throw new FsError(`"${entry.name}" cannot be moved into itself or one of its own folders.`);
        }
        const from = await c.folder(parent);
        from.entries = from.entries.filter(e => e.id !== entry.id);
        c.saveFolder(parent, from);
        const dest = await c.folder(destKey);
        const clash = findEntry(dest, entry.name);
        if (clash) throw new FsError(`"${toFolder}" already has something called "${clash.name}". Nothing was moved.`);
        dest.entries.push(entry);
        c.saveFolder(destKey, dest);
        moved.push({ ...entry });
        changed.add(parentPath(path));
      }
      return { result: moved, changed: [...changed] };
    });
  }

  /** Copies entries into a folder. A name already taken there gets " (2)", " (3)"... added. */
  async copy(paths: string[], toFolder: string): Promise<Entry[]> {
    return this.change(async c => {
      const destKey = await c.folderKey(toFolder);
      const ancestors = await this.ancestorKeys(c, toFolder);
      const copies: Entry[] = [];
      for (const path of outermost(paths)) {
        const { entry } = await c.entry(path);
        if (entry.kind === 'folder' && ancestors.includes(entry.id)) {
          throw new FsError(`"${entry.name}" cannot be copied into itself.`);
        }
        const dest = await c.folder(destKey);
        const copy = await this.copyEntry(c, entry, uniqueName(entry.name, dest.entries.map(e => e.name)));
        dest.entries.push(copy);
        c.saveFolder(destKey, dest);
        copies.push({ ...copy });
      }
      return { result: copies, changed: [joinPath(toFolder)] };
    });
  }

  private async copyEntry(c: Change, entry: Entry, name: string): Promise<Entry> {
    const id = newKey();
    if (entry.kind === 'file') {
      c.putBytes(id, await c.bytesOf(entry));
    } else {
      const children: Entry[] = [];
      for (const child of (await c.folder(entry.id)).entries) children.push(await this.copyEntry(c, child, child.name));
      c.saveFolder(id, { v: 1, entries: children }, true);
    }
    return { ...entry, id, name, modified: Date.now() };
  }

  /** Deletes entries and everything inside them, all at once. */
  async remove(paths: string[]): Promise<void> {
    return this.change(async c => {
      const changed = new Set<string>();
      for (const path of outermost(paths)) {
        const { parent, entry } = await c.entry(path);
        const records: Array<{ key: string; kind: 'file' | 'folder' }> = [];
        await c.collect(entry, records);
        for (const r of records) c.drop(r.key, r.kind);
        const folder = await c.folder(parent);
        folder.entries = folder.entries.filter(e => e.id !== entry.id);
        c.saveFolder(parent, folder);
        changed.add(parentPath(path));
      }
      return { result: undefined, changed: [...changed] };
    });
  }

  /** The keys of a folder and every folder above it, for refusing to move a folder into itself. */
  private async ancestorKeys(c: Change, path: string): Promise<string[]> {
    const parts = splitPath(path);
    const keys: string[] = [];
    for (let i = 0; i <= parts.length; i++) keys.push(await c.folderKey(joinPath(...parts.slice(0, i))));
    return keys;
  }
}
