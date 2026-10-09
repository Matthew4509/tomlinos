// Shared by the picture and player apps: which media type each file extension gets, and a safe way to show bytes.
// The type comes from OUR table by extension, never from anything inside the file, and only these types are ever
// handed to the browser, so a file cannot pick its own way of being shown.
import { extensionOf } from '../shell/filetypes.ts';

const TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', ogv: 'video/ogg',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac',
  aac: 'audio/aac', opus: 'audio/ogg',
};

export function mediaTypeOf(name: string): string | null {
  return TYPES[extensionOf(name)] ?? null;
}

/** A temporary address for the bytes; revoke it when the window closes. */
export function blobUrl(bytes: Uint8Array, type: string): string {
  return URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
}
