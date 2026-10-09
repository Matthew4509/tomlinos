// The server store with the person's own encryption in front of it (see src/auth/vault.ts). With encryption on, every
// record is sealed in this browser before it is sent, and opened here when it comes back: the server holds only
// ciphertext, and cannot even see file or folder names (folders are records too). With encryption off, records pass
// through as they are. While encryption is being turned on or off, both kinds are read and the new kind is written.
//
// Once encryption is fully on, a record that arrives NOT sealed is refused: it can only have been put there by someone
// other than this person's browser.
import { isSealed, seal, unseal, type VaultState } from '../auth/vault.ts';
import type { ServerStore } from './server-store.ts';
import { StoreConflict, StoreError, type Store, type StoreOp, type StoreRecord } from './store.ts';

const BATCH_BYTES = 8 * 1024 * 1024;
const BATCH_RECORDS = 50;

export class EncryptedStore implements Store {
  readonly label: string;
  readonly inner: ServerStore;
  /** The file key, or null while encryption is off (or before it is opened). */
  fileKey: CryptoKey | null = null;
  state: VaultState = 'off';

  constructor(inner: ServerStore) {
    this.inner = inner;
    this.label = inner.label;
  }

  private get sealing(): boolean {
    return this.state === 'on' || this.state === 'migrating-on';
  }

  private needKey(): CryptoKey {
    if (!this.fileKey) throw new StoreError('Your files are encrypted, and this page does not have their key. Sign out and sign in again to open them.');
    return this.fileKey;
  }

  async get(key: string): Promise<StoreRecord | null> {
    const record = await this.inner.get(key);
    if (!record) return null;
    if (isSealed(record.data)) {
      try {
        return { version: record.version, data: await unseal(this.needKey(), key, record.data) };
      } catch (error) {
        if (error instanceof StoreError) throw error;
        throw new StoreError('A file could not be opened: it does not match your file key, so it was changed or moved on the server. It was not shown. Tell the owner of this desktop.');
      }
    }
    if (this.state === 'on') {
      throw new StoreError('A file arrived from the server unencrypted although all your files are encrypted, so it was not opened: it may have been put there by someone else. Tell the owner of this desktop.');
    }
    return record;
  }

  async commit(ops: StoreOp[]): Promise<Record<string, string>> {
    if (!this.sealing) return this.inner.commit(ops);
    const fileKey = this.needKey();
    const sealed: StoreOp[] = [];
    for (const o of ops) sealed.push(o.op === 'put' ? { ...o, data: await seal(fileKey, o.key, o.data) } : o);
    return this.inner.commit(sealed);
  }

  /**
   * Rewrites every record into the kind the current state wants (sealed while turning on, plain while turning off). Safe
   * to stop and run again; a record changed meanwhile in another window is read again and redone.
   */
  async migrate(progress: (done: number, total: number) => void, signal?: AbortSignal): Promise<void> {
    const keys = await this.inner.keys();
    const want = this.sealing;
    let done = 0;
    let batch: Array<{ key: string; version: string; data: Uint8Array }> = [];
    let bytes = 0;

    const convert = async (key: string, data: Uint8Array): Promise<Uint8Array> => (want ? seal(this.needKey(), key, data) : unseal(this.needKey(), key, data));
    const flush = async () => {
      if (!batch.length) return;
      const ops: StoreOp[] = [];
      for (const r of batch) ops.push({ op: 'put', key: r.key, expect: r.version, data: await convert(r.key, r.data) });
      try {
        await this.inner.commit(ops);
      } catch (error) {
        if (!(error instanceof StoreConflict)) throw error;
        // Someone changed one of these meanwhile: redo them one at a time from what is there now.
        for (const r of batch) await this.one(r.key, want, convert);
      }
      done += batch.length;
      progress(done, keys.length);
      batch = [];
      bytes = 0;
    };

    for (const key of keys) {
      if (signal?.aborted) throw new StoreError('Stopped. Your files are safe: some are encrypted and some not yet, and both open. Carry on from My account.');
      const r = await this.inner.get(key);
      if (!r || isSealed(r.data) === want) {
        done++;
        continue;
      }
      batch.push({ key, version: r.version, data: r.data });
      bytes += r.data.length;
      if (batch.length >= BATCH_RECORDS || bytes >= BATCH_BYTES) await flush();
    }
    await flush();
    progress(keys.length, keys.length);
  }

  private async one(key: string, want: boolean, convert: (key: string, data: Uint8Array) => Promise<Uint8Array>): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = await this.inner.get(key);
      if (!r || isSealed(r.data) === want) return;
      try {
        await this.inner.commit([{ op: 'put', key, expect: r.version, data: await convert(key, r.data) }]);
        return;
      } catch (error) {
        if (!(error instanceof StoreConflict)) throw error;
      }
    }
    throw new StoreError('One file kept changing while it was being converted. Close other windows and devices, then carry on from My account.');
  }
}
