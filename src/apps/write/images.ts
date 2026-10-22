// The pictures in Write documents. The document itself holds only a short id for each picture ("p3"); the bytes
// live here, once, shown through a blob: address (the desktop's pages allow pictures from blob: and from itself, never
// data: addresses or outside sites). Shared by every Write window on the page, so a picture copied from one document
// pastes into another. A .docx keeps each picture as its own file inside (word/media/).
import { imageSize } from '../../core/imagesize.ts';

export type PictureType = 'image/png' | 'image/jpeg' | 'image/gif';

export interface Picture {
  bytes: Uint8Array;
  type: PictureType;
  url: string;
  /** The picture's own size in pixels. */
  w: number;
  h: number;
}

const store = new Map<string, Picture>();
const byUrl = new Map<string, string>();
let next = 1;

/** The kind of picture these bytes are (the three a Word document can hold everywhere), or null. */
export function pictureType(b: Uint8Array): PictureType | null {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  return null;
}

/** Keeps a picture and gives its id; null when the bytes are not a PNG, JPEG or GIF this can show. */
export function addPicture(bytes: Uint8Array): string | null {
  const type = pictureType(bytes);
  const size = imageSize(bytes);
  if (!type || !size || size.width < 1 || size.height < 1) return null;
  const id = `p${next++}`;
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  store.set(id, { bytes, type, url, w: size.width, h: size.height });
  byUrl.set(url, id);
  return id;
}

export const picture = (id: string): Picture | undefined => store.get(id);
export const imageUrl = (id: string): string | null => store.get(id)?.url ?? null;
/** The id of the picture shown at this blob: address (copied from a Write window), or null. */
export const imageByUrl = (url: string): string | null => byUrl.get(url) ?? null;

export const EXTENSION: Record<PictureType, string> = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/gif': 'gif' };
