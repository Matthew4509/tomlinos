// A store held in memory: for the unit tests, and for a desktop opened with nowhere to keep files.
import { collapseOps, newVersion, StoreConflict, type Store, type StoreOp, type StoreRecord } from './store.ts';

export class MemoryStore implements Store {
  readonly label = 'this tab only (nothing is kept)';
  private records = new Map<string, StoreRecord>();

  async get(key: string): Promise<StoreRecord | null> {
    const r = this.records.get(key);
    return r ? { version: r.version, data: r.data.slice() } : null;
  }

  async commit(ops: StoreOp[]): Promise<Record<string, string>> {
    const final = collapseOps(ops);
    const conflicts = [...final.values()]
      .filter(o => o.expect !== '*' && (this.records.get(o.key)?.version ?? '') !== o.expect)
      .map(o => o.key);
    if (conflicts.length) throw new StoreConflict(conflicts);
    const versions: Record<string, string> = {};
    for (const o of final.values()) {
      if (o.op === 'del') {
        this.records.delete(o.key);
        versions[o.key] = '';
      } else {
        const version = newVersion();
        this.records.set(o.key, { version, data: o.data.slice() });
        versions[o.key] = version;
      }
    }
    return versions;
  }

  /** Number of records, for tests that check nothing is left behind. */
  get size(): number {
    return this.records.size;
  }
}
