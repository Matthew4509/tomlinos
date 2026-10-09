// A store kept in this browser (IndexedDB), for a desktop opened as plain files with no server behind it.
// It applies commits exactly like the server: every expected version is checked inside one transaction, and the
// transaction writes everything or nothing.
import { collapseOps, newVersion, StoreConflict, StoreError, type Store, type StoreOp, type StoreRecord } from './store.ts';

const DB_NAME = 'tomlinos';
const TABLE = 'records';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class BrowserStore implements Store {
  readonly label = 'this browser';
  private db: IDBDatabase;

  private constructor(db: IDBDatabase) {
    this.db = db;
  }

  static async open(): Promise<BrowserStore> {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(TABLE);
    try {
      return new BrowserStore(await request(req));
    } catch {
      throw new StoreError(
        'This browser would not let the desktop keep files (private browsing can do this). ' +
          'Open it in a normal window, or use a desktop that keeps its files on a server.',
      );
    }
  }

  async get(key: string): Promise<StoreRecord | null> {
    const row = await request(this.db.transaction(TABLE).objectStore(TABLE).get(key));
    return row ? { version: row.version, data: new Uint8Array(row.data) } : null;
  }

  commit(ops: StoreOp[]): Promise<Record<string, string>> {
    const final = collapseOps(ops);
    const tx = this.db.transaction(TABLE, 'readwrite');
    const table = tx.objectStore(TABLE);
    const versions: Record<string, string> = {};
    return new Promise((resolve, reject) => {
      let failure: Error | null = null;
      tx.oncomplete = () => resolve(versions);
      tx.onabort = () =>
        reject(
          failure ??
            (tx.error?.name === 'QuotaExceededError'
              ? new StoreError('This browser has run out of room for the desktop\'s files. Nothing was saved. Delete some files, then try again.')
              : new StoreError('The browser stopped the save part-way, so nothing was saved. Try again.')),
        );
      // Check every expected version first; only then write. All of it happens in this one transaction.
      const keys = [...final.keys()];
      const found = new Map<string, string>();
      let pending = keys.length;
      const writeAll = () => {
        const conflicts = keys.filter(k => {
          const o = final.get(k)!;
          return o.expect !== '*' && (found.get(k) ?? '') !== o.expect;
        });
        if (conflicts.length) {
          failure = new StoreConflict(conflicts);
          tx.abort();
          return;
        }
        for (const o of final.values()) {
          if (o.op === 'del') {
            table.delete(o.key);
            versions[o.key] = '';
          } else {
            const version = newVersion();
            table.put({ version, data: o.data.slice().buffer }, o.key);
            versions[o.key] = version;
          }
        }
      };
      if (!pending) return;
      for (const k of keys) {
        const req = table.get(k);
        req.onsuccess = () => {
          if (req.result) found.set(k, req.result.version);
          if (--pending === 0) writeAll();
        };
      }
    });
  }
}
