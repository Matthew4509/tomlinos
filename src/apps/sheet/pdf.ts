// A small PDF writer for printed sheets and documents: each page is drawn through the Painter (paint.ts) into PDF
// drawing commands, with text in Helvetica, Times or Courier (fonts every PDF reader has, so none is embedded) in the
// Windows character set. A character those fonts cannot show is written as "?". Pictures go in as JPEG (the reader
// unpacks them itself). Pages are packed with deflate where the browser offers it.
// Our own code; no browser needed (Node has CompressionStream too).
import { textWidth, type Painter, type TextLook } from './paint.ts';

/** Unicode to the Windows-1252 bytes 128-159 (the rest of 160-255 is the same number). */
const WIN: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89,
  0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95,
  0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

/** Text as a PDF string in parentheses, in the Windows character set. */
export function pdfString(text: string): string {
  let out = '(';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    let b: number;
    if (cp >= 32 && cp < 127) b = cp;
    else if (cp >= 160 && cp <= 255) b = cp;
    else if (WIN[cp] !== undefined) b = WIN[cp];
    else if (cp === 9) b = 32;
    else b = 63; // ?
    if (b === 40 || b === 41 || b === 92) out += `\\${String.fromCharCode(b)}`;
    else if (b < 127) out += String.fromCharCode(b);
    else out += `\\${b.toString(8).padStart(3, '0')}`;
  }
  return `${out})`;
}

const n = (v: number) => {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
};

function rgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [0, 0, 0];
  const v = parseInt(m[1], 16);
  return [(v >> 16) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}
const fillOp = (hex: string) => `${rgb(hex).map(x => n(x)).join(' ')} rg`;
const strokeOp = (hex: string) => `${rgb(hex).map(x => n(x)).join(' ')} RG`;

/** One page's drawing commands (PDF's origin is the bottom-left; the painter's is the top-left). */
export class PdfPage implements Painter {
  readonly w: number;
  readonly h: number;
  readonly ops: string[] = [];
  /** The pictures this page draws (their names in the document), for its list of resources. */
  readonly images = new Set<string>();
  private depth = 0;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
  }

  private y(v: number): number {
    return this.h - v;
  }

  private paint(fill: string | null, stroke: string | null | undefined, width: number): string | null {
    const parts: string[] = [];
    if (fill) parts.push(fillOp(fill));
    if (stroke) parts.push(strokeOp(stroke), `${n(width)} w`);
    if (parts.length) this.ops.push(parts.join(' '));
    return fill && stroke ? 'B' : fill ? 'f' : stroke ? 'S' : null;
  }

  rect(x: number, y: number, w: number, h: number, fill: string | null, stroke?: string | null, width = 1): void {
    const op = this.paint(fill, stroke, width);
    if (op) this.ops.push(`${n(x)} ${n(this.y(y + h))} ${n(w)} ${n(h)} re ${op}`);
  }

  line(points: number[], stroke: string, width = 1, dash?: number[]): void {
    if (points.length < 4) return;
    this.ops.push(`${strokeOp(stroke)} ${n(width)} w 1 J 1 j${dash ? ` [${dash.map(n).join(' ')}] 0 d` : ''}`);
    let path = `${n(points[0])} ${n(this.y(points[1]))} m`;
    for (let i = 2; i + 1 < points.length; i += 2) path += ` ${n(points[i])} ${n(this.y(points[i + 1]))} l`;
    this.ops.push(`${path} S${dash ? ' [] 0 d' : ''} 0 J 0 j`);
  }

  shape(points: number[], fill: string | null, stroke?: string | null, width = 1): void {
    if (points.length < 6) return;
    const op = this.paint(fill, stroke, width);
    if (!op) return;
    let path = `${n(points[0])} ${n(this.y(points[1]))} m`;
    for (let i = 2; i + 1 < points.length; i += 2) path += ` ${n(points[i])} ${n(this.y(points[i + 1]))} l`;
    this.ops.push(`${path} h ${op}`);
  }

  circle(cx: number, cy: number, r: number, fill: string | null, stroke?: string | null, width = 1): void {
    const op = this.paint(fill, stroke, width);
    if (!op) return;
    // Four curves, each a quarter of the circle.
    const k = 0.5523 * r;
    const y = this.y(cy);
    this.ops.push([
      `${n(cx + r)} ${n(y)} m`,
      `${n(cx + r)} ${n(y + k)} ${n(cx + k)} ${n(y + r)} ${n(cx)} ${n(y + r)} c`,
      `${n(cx - k)} ${n(y + r)} ${n(cx - r)} ${n(y + k)} ${n(cx - r)} ${n(y)} c`,
      `${n(cx - r)} ${n(y - k)} ${n(cx - k)} ${n(y - r)} ${n(cx)} ${n(y - r)} c`,
      `${n(cx + k)} ${n(y - r)} ${n(cx + r)} ${n(y - k)} ${n(cx + r)} ${n(y)} c h ${op}`,
    ].join(' '));
  }

  text(x: number, y: number, text: string, look: TextLook): void {
    if (!text) return;
    // F1-F4 Helvetica, F5-F8 Times, F9-F12 Courier: regular, bold, italic, bold italic.
    const base = look.kind === 'serif' ? 4 : look.kind === 'mono' ? 8 : 0;
    const font = `F${base + (look.bold ? (look.italic ? 4 : 2) : look.italic ? 3 : 1)}`;
    const width = textWidth(text, look.size, !!look.bold, look.kind);
    const shift = look.align === 'c' ? width / 2 : look.align === 'r' ? width : 0;
    // The painter's angle turns clockwise on screen; PDF turns anticlockwise.
    const a = (-(look.rotate ?? 0) * Math.PI) / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    // From the middle of the line to the baseline: about a third of the size (half Helvetica's capital height).
    const drop = look.size * 0.36;
    const px = x - shift * cos + drop * sin;
    const py = this.y(y) - shift * sin - drop * cos;
    this.ops.push(`BT /${font} ${n(look.size)} Tf ${fillOp(look.colour ?? '#000000')} ${n(cos)} ${n(sin)} ${n(-sin)} ${n(cos)} ${n(px)} ${n(py)} Tm ${pdfString(text)} Tj ET`);
    if (look.underline && !look.rotate) {
      const uy = py - look.size * 0.12;
      this.ops.push(`${strokeOp(look.colour ?? '#000000')} ${n(look.size * 0.06)} w ${n(px)} ${n(uy)} m ${n(px + width)} ${n(uy)} l S`);
    }
    if (look.strike && !look.rotate) {
      const sy = py + look.size * 0.3;
      this.ops.push(`${strokeOp(look.colour ?? '#000000')} ${n(look.size * 0.06)} w ${n(px)} ${n(sy)} m ${n(px + width)} ${n(sy)} l S`);
    }
  }

  /** A picture added to the document (PdfDocument.addJpeg) drawn into this box. */
  image(x: number, y: number, w: number, h: number, name: string): void {
    this.images.add(name);
    this.ops.push(`q ${n(w)} 0 0 ${n(h)} ${n(x)} ${n(this.y(y + h))} cm /${name} Do Q`);
  }

  clip(x: number, y: number, w: number, h: number): void {
    this.depth++;
    this.ops.push(`q ${n(x)} ${n(this.y(y + h))} ${n(Math.max(0, w))} ${n(Math.max(0, h))} re W n`);
  }

  unclip(): void {
    if (this.depth <= 0) return;
    this.depth--;
    this.ops.push('Q');
  }

  /** The page's commands, with any clip left open closed. */
  content(): string {
    return [...this.ops, ...Array(this.depth).fill('Q')].join('\n');
  }
}

async function deflate(data: Uint8Array): Promise<Uint8Array | null> {
  const CS = (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream;
  if (!CS) return null;
  try {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CS('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/** A whole PDF: pages added one by one, then written out. */
export class PdfDocument {
  readonly pages: PdfPage[] = [];
  title = '';
  producer = 'TOMLIN OS Spreadsheet';
  private readonly jpegs: Array<{ name: string; data: Uint8Array; w: number; h: number }> = [];

  /** A JPEG picture (three colours, as a canvas writes one) the pages can draw by the name this returns. */
  addJpeg(data: Uint8Array, w: number, h: number): string {
    const name = `Im${this.jpegs.length + 1}`;
    this.jpegs.push({ name, data, w, h });
    return name;
  }

  addPage(w: number, h: number): PdfPage {
    const page = new PdfPage(w, h);
    this.pages.push(page);
    return page;
  }

  async bytes(): Promise<Uint8Array<ArrayBuffer>> {
    const enc = new TextEncoder();
    const chunks: Uint8Array[] = [];
    const offsets: number[] = [];
    let length = 0;
    const put = (part: string | Uint8Array) => {
      const b = typeof part === 'string' ? latin1(part) : part;
      chunks.push(b);
      length += b.length;
    };
    const obj = (id: number, body: string | Uint8Array, stream?: Uint8Array) => {
      offsets[id] = length;
      put(`${id} 0 obj\n`);
      put(body);
      if (stream) {
        put('\nstream\n');
        put(stream);
        put('\nendstream');
      }
      put('\nendobj\n');
    };
    void enc;
    put('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
    const fonts = [
      'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique', 'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic',
      'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique',
    ];
    // 1 catalog, 2 page list, 3-14 fonts, 15 information, then each page and its contents.
    const info = 3 + fonts.length;
    const first = info + 1;
    const kids = this.pages.map((_, i) => `${first + i * 2} 0 R`).join(' ');
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${this.pages.length} >>`);
    fonts.forEach((name, i) => obj(3 + i, `<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`));
    obj(info, `<< /Producer ${pdfString(this.producer)}${this.title ? ` /Title ${pdfString(this.title.slice(0, 200))}` : ''} >>`);
    const fontRefs = fonts.map((_, i) => `/F${i + 1} ${3 + i} 0 R`).join(' ');
    // The pictures follow the pages, one object each.
    const imageId = new Map(this.jpegs.map((im, k) => [im.name, first + this.pages.length * 2 + k]));
    for (const [i, page] of this.pages.entries()) {
      const id = first + i * 2;
      const xobjects = [...page.images].filter(name => imageId.has(name)).map(name => `/${name} ${imageId.get(name)} 0 R`).join(' ');
      obj(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(page.w)} ${n(page.h)}] /Resources << /Font << ${fontRefs} >>${xobjects ? ` /XObject << ${xobjects} >>` : ''} >> /Contents ${id + 1} 0 R >>`);
      const raw = latin1(page.content());
      const packed = await deflate(raw);
      if (packed) obj(id + 1, `<< /Length ${packed.length} /Filter /FlateDecode >>`, packed);
      else obj(id + 1, `<< /Length ${raw.length} >>`, raw);
    }
    for (const im of this.jpegs) {
      obj(imageId.get(im.name)!, `<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.data.length} >>`, im.data);
    }
    const count = first + this.pages.length * 2 + this.jpegs.length;
    const xref = length;
    let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
    for (let id = 1; id < count; id++) table += `${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`;
    put(table);
    put(`trailer\n<< /Size ${count} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    const out = new Uint8Array(length);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}

/** A string whose characters are all below 256, as bytes (the PDF commands are written that way). */
function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 255;
  return out;
}
