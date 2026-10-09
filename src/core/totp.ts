// Six-digit sign-in codes (TOTP, RFC 6238, HMAC-SHA1, 30-second steps): the same sum the server does in
// server/lib/auth.php, done here with the browser's own crypto. Used by the 2FA emulator page and the tests.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Base32 text (spaces, dashes and "=" ignored, any case) to bytes. Throws on a letter base32 does not have. */
export function base32Decode(text: string): Uint8Array {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase();
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const c of clean) {
    const v = B32.indexOf(c);
    if (v < 0) throw new Error(`"${c}" is not part of a two-step key. Keys use the letters A to Z and the numbers 2 to 7.`);
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** The code for one step (a 30-second slot since 1970). */
export async function totpAt(key: Uint8Array, step: number, digits = 6): Promise<string> {
  const counter = new Uint8Array(8);
  let n = step;
  for (let i = 7; i >= 0; i--) {
    counter[i] = n & 0xff;
    n = Math.floor(n / 256);
  }
  const hmacKey = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, counter as BufferSource));
  const at = mac[19] & 0x0f;
  const bin = ((mac[at] & 0x7f) << 24) | (mac[at + 1] << 16) | (mac[at + 2] << 8) | mac[at + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** The code now, and how many seconds it has left. */
export async function totpNow(secret: string, now = Date.now()): Promise<{ code: string; left: number }> {
  const seconds = Math.floor(now / 1000);
  return { code: await totpAt(base32Decode(secret), Math.floor(seconds / 30)), left: 30 - (seconds % 30) };
}

/** Reads an otpauth:// link (what a setup QR code holds) into its parts. Returns null if it is not one. */
export function parseOtpauth(uri: string): { secret: string; issuer: string; account: string } | null {
  let url: URL;
  try {
    url = new URL(uri.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'otpauth:' || url.hostname !== 'totp') return null;
  const secret = url.searchParams.get('secret') ?? '';
  const label = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const [issuerPart, account] = label.includes(':') ? label.split(':', 2) : ['', label];
  if (!secret) return null;
  return { secret, issuer: url.searchParams.get('issuer') ?? issuerPart, account };
}
