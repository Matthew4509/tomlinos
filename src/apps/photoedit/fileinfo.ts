// What a PNG, JPEG or WebP file holds that Photo Editor's canvas cannot keep, read from its bytes (no decoding):
// frames after the first, the details a camera stores (EXIF / XMP: date, camera, sometimes the place; PNG text notes,
// JPEG IPTC and comments: a caption, a copyright line), the print size,
// a colour profile, 16-bit or CMYK colour. Saving over the file would take these out of it, so Save asks first.
// No browser needed. Every walk is capped, so a damaged or crafted file only ends the walk early.

export interface FileFacts {
  /** More than one frame (an animated PNG or WebP). */
  animated: boolean;
  /** EXIF or XMP details. */
  details: boolean;
  /** A print size (dots per inch). */
  printSize: boolean;
  /** An embedded colour profile. */
  profile: boolean;
  /** More than 8 bits a colour. */
  deep: boolean;
  /** CMYK (printing) colours. */
  cmyk: boolean;
}

const NONE: FileFacts = { animated: false, details: false, printSize: false, profile: false, deep: false, cmyk: false };
const MAX_PARTS = 10_000;

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));
const be32 = (b: Uint8Array, at: number) => ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];
const le32 = (b: Uint8Array, at: number) => b[at] + (b[at + 1] << 8) + (b[at + 2] << 16) + ((b[at + 3] << 24) >>> 0);

function png(b: Uint8Array): FileFacts {
  const f = { ...NONE };
  let at = 8;
  for (let n = 0; n < MAX_PARTS && at + 8 <= b.length; n++) {
    const len = be32(b, at);
    const type = ascii(b, at + 4, 4);
    const data = at + 8;
    if (type === 'IHDR' && data + 9 <= b.length && b[data + 8] > 8) f.deep = true;
    else if (type === 'acTL') f.animated = true;
    else if (type === 'eXIf') f.details = true;
    // XMP, and text notes of any other kind (a caption, a copyright line, the settings a generator used).
    else if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') f.details = true;
    else if (type === 'iCCP') f.profile = true;
    // Unit 1 = per metre: a real print size (unit 0 is only a shape).
    else if (type === 'pHYs' && data + 9 <= b.length && b[data + 8] === 1) f.printSize = true;
    else if (type === 'IEND') break;
    at = data + len + 4;
  }
  return f;
}

function jpeg(b: Uint8Array): FileFacts {
  const f = { ...NONE };
  let at = 2;
  for (let n = 0; n < MAX_PARTS && at + 4 <= b.length; n++) {
    if (b[at] !== 0xff) break;
    const marker = b[at + 1];
    // Fill bytes and markers with no length.
    if (marker === 0xff) {
      at++;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break;
    const len = (b[at + 2] << 8) + b[at + 3];
    const data = at + 4;
    if (marker === 0xe1 && (ascii(b, data, 6) === 'Exif\0\0' || ascii(b, data, 28) === 'http://ns.adobe.com/xap/1.0/')) f.details = true;
    // APP13 (IPTC: caption, keywords, copyright, written by Photoshop and newsrooms) and COM (a comment).
    else if (marker === 0xed || marker === 0xfe) f.details = true;
    else if (marker === 0xe2 && ascii(b, data, 12) === 'ICC_PROFILE\0') f.profile = true;
    // JFIF: units 1 (inch) or 2 (cm) give a print size.
    else if (marker === 0xe0 && ascii(b, data, 5) === 'JFIF\0' && (b[data + 7] === 1 || b[data + 7] === 2)) f.printSize = true;
    else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (b[data] > 8) f.deep = true;
      if (b[data + 5] === 4) f.cmyk = true;
    }
    at += 2 + len;
  }
  return f;
}

function webp(b: Uint8Array): FileFacts {
  const f = { ...NONE };
  let at = 12;
  for (let n = 0; n < MAX_PARTS && at + 8 <= b.length; n++) {
    const type = ascii(b, at, 4);
    const len = le32(b, at + 4);
    if (type === 'VP8X' && at + 9 <= b.length) {
      const flags = b[at + 8];
      if (flags & 0x02) f.animated = true;
      if (flags & 0x0c) f.details = true;
      if (flags & 0x20) f.profile = true;
    } else if (type === 'ANIM' || type === 'ANMF') f.animated = true;
    else if (type === 'EXIF' || type === 'XMP ') f.details = true;
    else if (type === 'ICCP') f.profile = true;
    at += 8 + len + (len & 1);
  }
  return f;
}

/** What this file holds that a canvas does not keep (all false for a kind it does not read, or a damaged start). */
export function factsOf(b: Uint8Array): FileFacts {
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return png(b);
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) return jpeg(b);
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return webp(b);
  return { ...NONE };
}

/** The file Photo Editor opened, kept while saving over it would lose something: it moves, or holds what is not kept. */
export interface OpenedFile {
  path: string;
  animated: boolean;
  losses: string[];
}

/**
 * The opened file at `path`, or null when saving over it loses nothing. `notes` are the changes opening it made (an
 * .ora from GIMP or Krita: groups opened out, blend modes read as Normal, parts past the edge cut off): saving over the
 * file would make them for good, so they count as losses too.
 */
export function openedFile(path: string, f: FileFacts, notes: readonly string[] = []): OpenedFile | null {
  const losses = [...lostBySaving(f), ...notes];
  return f.animated || losses.length ? { path, animated: f.animated, losses } : null;
}

/**
 * Why writing to `dest` must ask first, however it was reached (Save, or Save As with the opened file's own name):
 * 'moves' when it is the opened moving picture (never written over), 'losses' when it would lose what is listed, else null.
 */
export function overOpened(opened: OpenedFile | null, dest: string): 'moves' | 'losses' | null {
  if (!opened || opened.path !== dest) return null;
  if (opened.animated) return 'moves';
  return opened.losses.length ? 'losses' : null;
}

/** What saving over the file would take out of it, in words (not the frames: a moving picture is never saved over). */
export function lostBySaving(f: FileFacts): string[] {
  const out: string[] = [];
  if (f.details) out.push('the details stored with the photo (such as the date, the camera, and sometimes the place it was taken, a caption, a copyright line or a comment)');
  if (f.printSize) out.push('its print size (dots per inch)');
  if (f.profile) out.push('its colour profile (colours may shift a little)');
  if (f.deep) out.push('its 16-bit colour (saved as 8-bit)');
  if (f.cmyk) out.push('its CMYK printing colours (saved as RGB)');
  return out;
}
