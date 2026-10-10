// Encryption of a person's files, done in their browser with its own crypto (no outside code). One random file key
// (AES-GCM, 256-bit) encrypts every record. The server only ever holds that key wrapped twice: once by a key stretched
// from the password (PBKDF2-SHA256, 600,000 rounds), once by a key from the recovery key. Either one opens the files;
// without both, the stored files cannot be opened, by the desktop's owner or by anyone who copies the data folder.
// (Whoever controls the server's code could still capture a password as it is typed: this protects data at rest.)
//
// The recovery key (20 random bytes, shown once as 8 groups of 4 letters and numbers) never leaves the browser: two
// values are derived from it (HKDF-SHA256). "auth" goes to the server, which keeps only a keyed hash of it, to prove the
// key at "Forgot your password?"; "wrap" stays here and opens the file key.
//
// A record is stored as MAGIC, a 12-byte nonce, then the ciphertext (records sealed by earlier versions start with
// OLD_MAGIC, and still open); the record's own key is the additional data, so a
// record moved to another key on the server fails to open instead of showing the wrong file.
import { base32Decode, base32Encode } from '../core/totp.ts';

export type VaultState = 'off' | 'migrating-on' | 'on' | 'migrating-off';
export interface VaultKeys {
  state: VaultState;
  salt: string;
  iter: number;
  wrapPw: string;
  wrapRk: string;
  stale: boolean;
}

/** "\0MYIENC\x01": the start of every sealed record. */
const MAGIC = new Uint8Array([0x00, 0x4d, 0x59, 0x49, 0x45, 0x4e, 0x43, 0x01]);
/** The marker earlier versions wrote; their records keep it until they are next saved. */
const OLD_MAGIC = new Uint8Array([0x00, 0x41, 0x4c, 0x4e, 0x45, 0x4e, 0x43, 0x01]);
export const PBKDF2_ROUNDS = 600_000;
const text = new TextEncoder();

export const toB64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
export const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const hex = (bytes: Uint8Array): string => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

/** A new file key. Extractable only so it can be wrapped; the copy kept for daily use is not. */
export function newFileKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

async function passwordKek(password: string, salt: Uint8Array, rounds: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', text.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: rounds }, base, { name: 'AES-KW', length: 256 }, false, ['wrapKey', 'unwrapKey']);
}

export async function wrapWithPassword(fileKey: CryptoKey, password: string, rounds = PBKDF2_ROUNDS): Promise<{ salt: string; iter: number; wrapPw: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const kek = await passwordKek(password, salt, rounds);
  const wrapped = new Uint8Array(await crypto.subtle.wrapKey('raw', fileKey, kek, 'AES-KW'));
  return { salt: toB64(salt), iter: rounds, wrapPw: toB64(wrapped) };
}

/** Opens the file key with the password. Throws when the password does not open it. */
export async function unwrapWithPassword(keys: { salt: string; iter: number; wrapPw: string }, password: string, extractable = false): Promise<CryptoKey> {
  const kek = await passwordKek(password, fromB64(keys.salt), keys.iter);
  return crypto.subtle.unwrapKey('raw', fromB64(keys.wrapPw) as BufferSource, kek, 'AES-KW', { name: 'AES-GCM', length: 256 }, extractable, ['encrypt', 'decrypt']);
}

// ---- The recovery key --------------------------------------------------------------------------------------------------

/** A new recovery key, as it is shown: "K7M2-9XQ4-BD3F-..." (32 letters and numbers in 8 groups). */
export function newRecoveryKey(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20))).match(/.{4}/g)!.join('-');
}

/** The two values made from a recovery key as typed (spaces, dashes and case do not matter). Throws if it is not one. */
export async function recoveryParts(typed: string): Promise<{ auth: string; kek: CryptoKey }> {
  let raw: Uint8Array;
  try {
    raw = base32Decode(typed.replace(/[\s-]/g, '').replace(/0/g, 'O').replace(/1/g, 'I').replace(/8/g, 'B'));
  } catch {
    throw new Error('That is not a recovery key. It is 32 letters and numbers, in groups of 4.');
  }
  if (raw.length !== 20) throw new Error('That recovery key is the wrong length. It is 32 letters and numbers, in groups of 4.');
  const base = await crypto.subtle.importKey('raw', raw as BufferSource, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const salt = text.encode('tomlinos-recovery-key');
  const auth = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: text.encode('auth') }, base, 256));
  const kek = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: text.encode('wrap') }, base, { name: 'AES-KW', length: 256 }, false, ['wrapKey', 'unwrapKey']);
  return { auth: hex(auth), kek };
}

export async function wrapWithRecovery(fileKey: CryptoKey, kek: CryptoKey): Promise<string> {
  return toB64(new Uint8Array(await crypto.subtle.wrapKey('raw', fileKey, kek, 'AES-KW')));
}

export async function unwrapWithRecovery(wrapRk: string, kek: CryptoKey, extractable = false): Promise<CryptoKey> {
  return crypto.subtle.unwrapKey('raw', fromB64(wrapRk) as BufferSource, kek, 'AES-KW', { name: 'AES-GCM', length: 256 }, extractable, ['encrypt', 'decrypt']);
}

/** An extractable file key as a non-extractable one, for daily use and for keeping in this browser. */
export async function lockDown(fileKey: CryptoKey): Promise<CryptoKey> {
  if (!fileKey.extractable) return fileKey;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', fileKey));
  try {
    return await crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  } finally {
    raw.fill(0);
  }
}

// ---- Records -----------------------------------------------------------------------------------------------------------

export function isSealed(data: Uint8Array): boolean {
  if (data.length < MAGIC.length + 12 + 16) return false;
  const starts = (m: Uint8Array) => m.every((b, i) => data[i] === b);
  return starts(MAGIC) || starts(OLD_MAGIC);
}

export async function seal(fileKey: CryptoKey, key: string, data: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: text.encode(key) }, fileKey, data as BufferSource));
  const out = new Uint8Array(MAGIC.length + 12 + body.length);
  out.set(MAGIC);
  out.set(iv, MAGIC.length);
  out.set(body, MAGIC.length + 12);
  return out;
}

/** Throws when the record was changed, moved to another key, or sealed with another file key. */
export async function unseal(fileKey: CryptoKey, key: string, data: Uint8Array): Promise<Uint8Array> {
  const iv = data.subarray(MAGIC.length, MAGIC.length + 12);
  const body = data.subarray(MAGIC.length + 12);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: text.encode(key) }, fileKey, body as BufferSource));
}

// ---- Keeping the key in this browser between reloads ------------------------------------------------------------------
// Only the non-extractable form is kept (IndexedDB can hold a key the page can use but never read out). It is removed on
// signing out, and on any visit that finds nobody signed in.

const DB = 'tomlinos-keys';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('keys');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withKeys<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction('keys', mode).objectStore('keys'));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function keepKey(userId: string, fileKey: CryptoKey): Promise<void> {
  try {
    await withKeys('readwrite', s => s.put(nonExtractable(fileKey), userId));
  } catch {
    // Private windows may refuse: the password is then asked again after a reload.
  }
}
const nonExtractable = (k: CryptoKey): CryptoKey => {
  if (k.extractable) throw new Error('only a non-extractable key is kept');
  return k;
};

export async function restoreKey(userId: string): Promise<CryptoKey | null> {
  try {
    const k = await withKeys<unknown>('readonly', s => s.get(userId));
    return k instanceof CryptoKey ? k : null;
  } catch {
    return null;
  }
}

/**
 * A lock asked for while the server could not be reached: remembered here (beside the kept key, and forgotten with it) so
 * a reload, or another tab, locks the session on the server before showing anything.
 */
export async function markLockPending(userId: string, pending: boolean): Promise<void> {
  try {
    if (pending) await withKeys('readwrite', s => s.put(Date.now(), `lock:${userId}`));
    else await withKeys('readwrite', s => s.delete(`lock:${userId}`));
  } catch {
    // Storage refused (a private window): the lock is still asked for again while this page stays open.
  }
}

export async function lockPending(userId: string): Promise<boolean> {
  try {
    return typeof (await withKeys<unknown>('readonly', s => s.get(`lock:${userId}`))) === 'number';
  } catch {
    return false;
  }
}

export async function forgetKeys(): Promise<void> {
  try {
    await withKeys('readwrite', s => s.clear());
  } catch {
    // Nothing kept, or storage refused: nothing to forget.
  }
}
