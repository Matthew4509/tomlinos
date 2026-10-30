// Chat's encryption, all of it in the browser (the server, server/api/chat.php, only ever holds what this makes).
//
// Each person has one key pair (ECDH on the P-256 curve). The public half goes to the server so others can find it; the
// private half is kept in the person's own files (/System/chat-key.json), which are sealed with their file key when
// they chose to encrypt their files, and plain on the server when they did not. That is the whole difference between
// "end to end" and not, and the app says which one each conversation is.
//
// Direct: both people work out the same AES-256-GCM key from their own private key and the other's public key (ECDH,
// then HKDF with the conversation's name), so nothing about the key is ever sent.
// General: one random AES-256-GCM key for everyone, handed to each person wrapped in a key only they can work out
// (the hander's private key with their public key). A new General key ("epoch") is only made when the owner resets it.
//
// Every scrambled message is bound to its conversation, sender and General epoch (AES-GCM additional data), so the
// server cannot move a message into another conversation or put it in someone else's name without it failing to open.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64 = (bytes: Uint8Array): string => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
export const unb64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), c => c.charCodeAt(0));

const CURVE = { name: 'ECDH', namedCurve: 'P-256' } as const;

export interface ChatKeys {
  priv: CryptoKey;
  /** The public key as the server keeps it: "raw" (65 bytes), base64. */
  pub: string;
}

/** A new key pair, and the private half as a JWK to keep in the person's files. */
export async function newKeys(): Promise<{ keys: ChatKeys; jwk: JsonWebKey }> {
  const pair = await crypto.subtle.generateKey(CURVE, true, ['deriveBits']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { keys: await keysFromJwk(jwk), jwk };
}

/** The key pair back from the kept JWK (the public half is inside it, as x and y). */
export async function keysFromJwk(jwk: JsonWebKey): Promise<ChatKeys> {
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d || !jwk.x || !jwk.y) throw new Error('That is not a chat key.');
  const priv = await crypto.subtle.importKey('jwk', jwk, CURVE, false, ['deriveBits']);
  const pubKey = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true }, CURVE, true, []);
  return { priv, pub: b64(new Uint8Array(await crypto.subtle.exportKey('raw', pubKey))) };
}

/** An AES-GCM key both sides can work out: ECDH, then HKDF-SHA-256 with a salt naming what it is for. */
async function agreed(mine: ChatKeys, theirPub: string, salt: string, info: string, usages: KeyUsage[]): Promise<CryptoKey> {
  const their = await crypto.subtle.importKey('raw', unb64(theirPub), CURVE, false, []);
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: their }, mine.priv, 256);
  const hkdf = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode(salt), info: enc.encode(info) }, hkdf, { name: 'AES-GCM', length: 256 }, false, usages);
}

/** The key for a Direct conversation (the same on both sides). */
export function directKey(mine: ChatKeys, theirPub: string, conv: string): Promise<CryptoKey> {
  return agreed(mine, theirPub, conv, 'tomlinos-chat-direct', ['encrypt', 'decrypt']);
}

export function newGeneralKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

export interface Wrap {
  /** The hander's public key, which the wrap was made with. */
  fromPub: string;
  /** The receiver's public key, which the wrap was made for: the server refuses a wrap made for a key since replaced. */
  toPub: string;
  iv: string;
  ct: string;
}

/** The General key, wrapped so only `forUser` (whose public key is `forPub`) can open it. */
export async function wrapGeneral(mine: ChatKeys, forUser: string, forPub: string, key: CryptoKey, epoch: number): Promise<Wrap> {
  const label = `general|${epoch}|${forUser}`;
  const kek = await agreed(mine, forPub, label, 'tomlinos-chat-wrap', ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(label) }, kek, raw));
  return { fromPub: mine.pub, toPub: forPub, iv: b64(iv), ct: b64(ct) };
}

/**
 * Opens the General key someone wrapped for me. Kept extractable: I may have to hand it on to the next person.
 * `senderPub` is the hander's public key as the server lists it now (null when they have none): a wrap made with any
 * other key is not opened, so a General key cannot be swapped under me without the people list showing a changed key.
 * Left out (undefined), the wrap's own word is taken.
 */
export async function unwrapGeneral(mine: ChatKeys, meId: string, wrap: Wrap, epoch: number, senderPub?: string | null): Promise<CryptoKey> {
  if (senderPub !== undefined && senderPub !== wrap.fromPub) throw new Error('This General key was not wrapped with the sender\'s current chat key (their key changed, or the wrap was tampered with), so it was not opened.');
  const label = `general|${epoch}|${meId}`;
  const kek = await agreed(mine, wrap.fromPub, label, 'tomlinos-chat-wrap', ['decrypt']);
  const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(wrap.iv), additionalData: enc.encode(label) }, kek, unb64(wrap.ct));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', true, ['encrypt', 'decrypt']);
}

const bound = (conv: string, from: string, epoch: number): Uint8Array<ArrayBuffer> => enc.encode(`tomlinos-chat|${conv}|${from}|${epoch}`);

export async function sealMessage(key: CryptoKey, conv: string, from: string, epoch: number, text: string): Promise<{ iv: string; ct: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = enc.encode(JSON.stringify({ v: 1, t: text }));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: bound(conv, from, epoch) }, key, body));
  return { iv: b64(iv), ct: b64(ct) };
}

/** The text of a message, or null when it will not open with this key (tampered with, or sent under another key). */
export async function openMessage(key: CryptoKey, conv: string, from: string, epoch: number, iv: string, ct: string): Promise<string | null> {
  try {
    const body = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: bound(conv, from, epoch) }, key, unb64(ct));
    const parsed = JSON.parse(dec.decode(body)) as { t?: unknown };
    return typeof parsed.t === 'string' ? parsed.t : null;
  } catch {
    return null;
  }
}

/** Digits from a hash, in groups of five: something two people can read to each other. */
async function digits(data: Uint8Array<ArrayBuffer>, groups: number): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  const out: string[] = [];
  for (let g = 0; g < groups; g++) {
    const n = ((hash[g * 3] << 16) | (hash[g * 3 + 1] << 8) | hash[g * 3 + 2]) % 100000;
    out.push(String(n).padStart(5, '0'));
  }
  return out.join(' ');
}

/**
 * The safety code of a Direct conversation: the same on both screens only when each side has the other's real public
 * key. If the server swapped a key to listen in, the two codes differ.
 */
export function safetyCode(pubA: string, pubB: string): Promise<string> {
  const [x, y] = [pubA, pubB].sort();
  return digits(enc.encode(`tomlinos-safety|${x}|${y}`), 6);
}

/** The General key's code: everyone who holds the same key sees the same digits. */
export async function generalCode(key: CryptoKey): Promise<string> {
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  return digits(new Uint8Array([...enc.encode('tomlinos-general-code|'), ...raw]), 6);
}
