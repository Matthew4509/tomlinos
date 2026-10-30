// Everything about opening, encrypting and recovering one person's files, in one place, used by the start-up screens
// and My account. It holds the file key for the page (in the encrypting store) and never sends it anywhere: the server
// gets only wraps it cannot open, and a proof made from the recovery key.
import { Bus } from '../core/bus.ts';
import type { EncryptedStore } from '../store/encrypted-store.ts';
import { AuthFailure, type AuthApi, type PublicUser, type WrapBody } from './api.ts';
import {
  forgetKeys, keepKey, lockDown, newFileKey, newRecoveryKey, recoveryParts, restoreKey, unwrapWithPassword, unwrapWithRecovery,
  wrapWithPassword, wrapWithRecovery, type VaultKeys,
} from './vault.ts';

export class FilesVault {
  keys: VaultKeys | null = null;
  /** While files are being encrypted or decrypted: how far it has got. */
  progress: { done: number; total: number } | null = null;
  /** Told when the state or the progress changes (My account listens). */
  readonly changed = new Bus<void>();
  private running: Promise<void> | null = null;
  private api: AuthApi;
  private store: EncryptedStore;
  private user: () => PublicUser;
  private setUser: (u: PublicUser) => void;

  constructor(api: AuthApi, store: EncryptedStore, user: () => PublicUser, setUser: (u: PublicUser) => void) {
    this.api = api;
    this.store = store;
    this.user = user;
    this.setUser = setUser;
  }

  /** Takes the server's latest word on encryption (after sign-in or a change). */
  apply(keys: VaultKeys | null | undefined): void {
    this.keys = keys ?? null;
    this.store.state = this.keys?.state ?? 'off';
    if (!this.keys) this.store.fileKey = null;
    this.changed.emit();
  }

  get encrypted(): boolean {
    return this.keys !== null;
  }

  /** Has this page got the key it needs (always true with encryption off)? */
  get open(): boolean {
    return !this.keys || this.store.fileKey !== null;
  }

  get moving(): boolean {
    return this.keys?.state === 'migrating-on' || this.keys?.state === 'migrating-off';
  }

  private async use(fileKey: CryptoKey): Promise<void> {
    const daily = await lockDown(fileKey);
    this.store.fileKey = daily;
    await keepKey(this.user().id, daily);
  }

  /** Opens the files without asking: with the password just typed, or the key this browser kept. */
  async openQuietly(password?: string): Promise<boolean> {
    if (!this.keys) {
      await forgetKeys();
      return true;
    }
    if (password && !this.keys.stale) {
      try {
        await this.use(await unwrapWithPassword(this.keys, password));
        return true;
      } catch {
        // Not opened by this password (reset elsewhere): fall through.
      }
    }
    const kept = await restoreKey(this.user().id);
    if (kept) {
      this.store.fileKey = kept;
      return true;
    }
    return false;
  }

  async openWithPassword(password: string): Promise<void> {
    if (!this.keys) return;
    try {
      await this.use(await unwrapWithPassword(this.keys, password));
    } catch {
      throw new Error('That password does not open your files. Type the password you signed in with. If it was reset by the owner, use your recovery key instead.');
    }
  }

  /** After a reset by the owner: the recovery key opens the files, and they are re-wrapped for the current password. */
  async openWithRecovery(recoveryKey: string, password: string): Promise<void> {
    if (!this.keys) return;
    const parts = await recoveryParts(recoveryKey);
    let fileKey: CryptoKey;
    try {
      fileKey = await unwrapWithRecovery(this.keys.wrapRk, parts.kek, true);
    } catch {
      throw new Error('That recovery key does not open your files. Check it letter by letter (dashes and capitals do not matter).');
    }
    const r = await this.api.vaultRewrap(parts.auth, await wrapWithPassword(fileKey, password));
    this.setUser(r.user);
    this.apply(r.vaultKeys);
    await this.use(fileKey);
  }

  /** A new recovery key (shown once by the caller). With encryption on, the file key is re-wrapped for it. */
  async makeRecoveryKey(password: string, code: string): Promise<string> {
    const key = newRecoveryKey();
    const parts = await recoveryParts(key);
    let wrapRk: string | null = null;
    if (this.keys) {
      const fileKey = await unwrapWithPassword(this.keys, password, true).catch(() => {
        throw new Error('That password is not right, so nothing was changed.');
      });
      wrapRk = await wrapWithRecovery(fileKey, parts.kek);
    }
    const r = await this.api.recoveryKey(password, code, parts.auth, wrapRk);
    this.setUser(r.user);
    return key;
  }

  /** Turns encryption on: a new file key and a new recovery key (returned, to show once). finish() then converts the files. */
  async turnOn(password: string, code: string): Promise<string> {
    // Only from "off". A page still showing "off" while another tab or device turned encryption on (or is turning it off)
    // must not make a second file key: the server keeps the first, and files sealed with the second would never open.
    if (this.keys) throw new Error('Your files are already encrypted, or being encrypted or decrypted, from another window or device. Reload My account to see where things stand.');
    const recovery = newRecoveryKey();
    const parts = await recoveryParts(recovery);
    const fileKey = await newFileKey();
    const wrap = await wrapWithPassword(fileKey, password);
    const wrapRk = await wrapWithRecovery(fileKey, parts.kek);
    // The key is kept in this browser BEFORE the server is told: another tab that hears of the switch the moment after
    // finds it there (told first, that tab could catch up to "encrypted" with no key to seal with).
    await this.use(fileKey);
    let r: { user: PublicUser; vaultKeys: VaultKeys | null };
    try {
      r = await this.api.vault('migrating-on', { password, code, ...wrap, wrapRk, rkAuth: parts.auth });
    } catch (error) {
      this.store.fileKey = null;
      await forgetKeys();
      throw error;
    }
    this.setUser(r.user);
    this.apply(r.vaultKeys);
    return recovery;
  }

  async turnOff(password: string, code: string): Promise<void> {
    if (!this.open) throw new Error('Open your files first (sign in again with your password).');
    const r = await this.api.vault('migrating-off', { password, code });
    this.setUser(r.user);
    this.apply(r.vaultKeys);
  }

  /** Part-way through turning encryption off, the person decides to keep it: back to encrypting, with the same key. */
  async keepEncrypted(password: string, code: string): Promise<void> {
    if (this.keys?.state !== 'migrating-off') return;
    if (!this.open) throw new Error('Open your files first (sign in again with your password).');
    const r = await this.api.vault('migrating-on', { password, code });
    this.setUser(r.user);
    this.apply(r.vaultKeys);
  }

  /**
   * Converts every file to the state being moved to, then tells the server it is done. The server checks every file
   * first; one saved meanwhile by another page in the old kind is converted on another pass (a few at most).
   */
  async finish(progress: (done: number, total: number) => void, signal?: AbortSignal): Promise<void> {
    if (!this.keys || !this.moving) return;
    const target = this.keys.state === 'migrating-on' ? 'on' : 'off';
    let r: { user: PublicUser; vaultKeys: VaultKeys | null };
    for (let pass = 1; ; pass++) {
      await this.store.migrate(progress, signal);
      try {
        r = await this.api.vault(target);
        break;
      } catch (error) {
        if (!(error instanceof AuthFailure && error.data.redo) || pass >= 3) throw error;
      }
    }
    this.setUser(r.user);
    this.apply(r.vaultKeys);
    if (target === 'off') await forgetKeys();
  }

  /** Runs finish() once (a second call joins the first), reporting progress to anyone listening. */
  move(): Promise<void> {
    this.running ??= this.finish((done, total) => {
      this.progress = { done, total };
      this.changed.emit();
    }).finally(() => {
      this.running = null;
      this.progress = null;
      this.changed.emit();
    });
    return this.running;
  }

  /** The file key wrapped for a new password (for a password change), or null with encryption off. */
  async wrapForNewPassword(current: string, next: string): Promise<WrapBody | null> {
    if (!this.keys) return null;
    const fileKey = await unwrapWithPassword(this.keys, current, true).catch(() => {
      throw new Error('That password is not right, so nothing was changed.');
    });
    return wrapWithPassword(fileKey, next);
  }

  /** No password and no recovery key: set the locked files aside on the server (kept, not deleted) and start empty. */
  async abandon(password: string, code = ''): Promise<void> {
    const r = await this.api.vaultAbandon(password, code);
    this.setUser(r.user);
    this.apply(null);
    await forgetKeys();
  }
}
