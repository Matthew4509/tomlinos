// The record store underneath the desktop's files. It knows nothing about names or folders: it keeps records,
// each a key and a blob of bytes, and every record carries a version that changes whenever it is written.
// The file layer (src/fs) builds files and folders out of these records. Keeping names out of this layer is what
// lets phase 4 encrypt every blob in the browser, so the server holds nothing readable.
//
// Keys are "/" (the root folder) or a random UUID. A commit is a batch of puts and deletes applied all-or-nothing;
// each operation names the version it expects to find, so two devices can never silently overwrite each other.

export const ROOT_KEY = '/';

/** "" = the key must not exist yet; "*" = whatever is there; otherwise the exact version last read. */
export type Expect = string;

export type StoreOp =
  | { op: 'put'; key: string; expect: Expect; data: Uint8Array }
  | { op: 'del'; key: string; expect: Expect };

export interface StoreRecord {
  version: string;
  data: Uint8Array;
}

export interface Store {
  /** What the person is told the files are kept in, e.g. "this desktop's server". */
  readonly label: string;
  get(key: string): Promise<StoreRecord | null>;
  /** Returns the new version of every key written ("" for a deleted key). Throws StoreConflict or StoreError. */
  commit(ops: StoreOp[]): Promise<Record<string, string>>;
}

/** Another window or device changed one of these records after this one read it. Nothing was written. */
export class StoreConflict extends Error {
  readonly keys: string[];
  constructor(keys: string[]) {
    super('Another window or device changed these files first.');
    this.name = 'StoreConflict';
    this.keys = keys;
  }
}

/** The store could not be reached or refused the request. The message is written for the person using it. */
export class StoreError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = 'StoreError';
    this.status = status;
  }
}

const KEY_RE = /^(\/|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

export function isStoreKey(key: string): boolean {
  return KEY_RE.test(key);
}

export function newKey(): string {
  return crypto.randomUUID();
}

export function newVersion(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The rule every store applies to a commit, shared so the browser store behaves exactly like the server's:
 * the last operation on a key wins, checked against the version the FIRST operation on that key expected.
 */
export function collapseOps(ops: StoreOp[]): Map<string, StoreOp> {
  const final = new Map<string, StoreOp>();
  for (const o of ops) {
    if (!isStoreKey(o.key)) throw new StoreError('The desktop tried to save to something that is not a store key.');
    const prev = final.get(o.key);
    final.set(o.key, prev ? { ...o, expect: prev.expect } : o);
  }
  return final;
}
