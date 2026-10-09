// Drawing one PDF page onto a canvas: paths, colours, text, pictures and nested "form" pieces. Our own code.
// Not drawn: gradients and patterns (a flat grey stands in), soft masks, blend modes, annotations, form fields.
// A page is stopped, with a note, if it is too complicated (operation or time limit) so a hostile file cannot hang the tab.
import { Cmd, Dict, Lexer, Name, PStr, Stream, type Obj, type Page, type PdfDocument } from './objects.ts';
import { loadFont, type PdfFont } from './fonts.ts';

const MAX_OPS = 2_500_000;
const MAX_MS = 10_000;
const MAX_FORM_DEPTH = 10;
const MAX_IMAGE_PIXELS = 40_000_000;

type Matrix = [number, number, number, number, number, number];
const mul = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];

interface GState {
  fill: string;
  stroke: string;
  fillSpace: string;
  strokeSpace: string;
  alpha: number;
  strokeAlpha: number;
  font: PdfFont | null;
  size: number;
  charSpace: number;
  wordSpace: number;
  hScale: number;
  leading: number;
  rise: number;
  mode: number;
}

export interface RenderResult {
  text: string;
  note: string | null;
}

const clamp255 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
const rgb = (r: number, g: number, b: number) => `rgb(${clamp255(r * 255)},${clamp255(g * 255)},${clamp255(b * 255)})`;
const gray = (g: number) => rgb(g, g, g);
const cmyk = (c: number, m: number, y: number, k: number) => rgb((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k));

function colourFrom(space: string, n: number[]): string {
  if (space === 'pattern') return 'rgb(128,128,128)';
  if (n.length === 1) return space === 'separation' ? gray(1 - n[0]) : gray(n[0]);
  if (n.length === 3) return rgb(n[0], n[1], n[2]);
  if (n.length === 4) return cmyk(n[0], n[1], n[2], n[3]);
  return 'rgb(0,0,0)';
}

/** Draws `page` into `canvas` at `scale` (pixels per PDF point, already including the screen's pixel ratio). */
export async function renderPage(
  doc: PdfDocument,
  page: Page,
  canvas: HTMLCanvasElement,
  scale: number,
  isCurrent: () => boolean,
): Promise<RenderResult> {
  const [x0, y0, x1, y1] = page.box;
  const rotated = page.rotate === 90 || page.rotate === 270;
  const w = (x1 - x0) * scale;
  const h = (y1 - y0) * scale;
  canvas.width = Math.max(1, Math.round(rotated ? h : w));
  canvas.height = Math.max(1, Math.round(rotated ? w : h));
  const ctx = canvas.getContext('2d');
  if (!ctx) return { text: '', note: 'The browser would not give this viewer a drawing surface.' };
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // PDF space has y going up; move the origin to the bottom-left of the box and flip, turning for /Rotate.
  ctx.save();
  if (page.rotate === 90) ctx.transform(0, 1, -1, 0, canvas.width, 0);
  else if (page.rotate === 180) ctx.transform(-1, 0, 0, -1, canvas.width, canvas.height);
  else if (page.rotate === 270) ctx.transform(0, -1, 1, 0, 0, canvas.height);
  ctx.transform(scale, 0, 0, -scale, -x0 * scale, y1 * scale);
  ctx.rect(x0, y0, x1 - x0, y1 - y0);
  ctx.clip();
  ctx.beginPath();

  const run = new Run(doc, ctx, isCurrent);
  const contents = doc.resolve(page.dict.map.get('Contents'));
  const parts = Array.isArray(contents) ? contents : [contents];
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (const part of parts) {
    const s = doc.resolve(part as Obj);
    if (s instanceof Stream) {
      const bytes = await doc.streamData(s);
      chunks.push(bytes, Uint8Array.of(10));
      total += bytes.length + 1;
    }
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  try {
    await run.execute(all, page.resources, 0);
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
  }
  ctx.restore();
  return { text: run.text.join('').slice(0, 300_000), note: run.note };
}

class Stop extends Error {}

class Run {
  text: string[] = [];
  note: string | null = null;
  private ops = 0;
  private started = Date.now();
  private state: GState = {
    fill: '#000', stroke: '#000', fillSpace: 'gray', strokeSpace: 'gray', alpha: 1, strokeAlpha: 1,
    font: null, size: 0, charSpace: 0, wordSpace: 0, hScale: 1, leading: 0, rise: 0, mode: 0,
  };
  private stack: GState[] = [];
  private tm: Matrix = [1, 0, 0, 1, 0, 0];
  private tlm: Matrix = [1, 0, 0, 1, 0, 0];
  private measureCtx: CanvasRenderingContext2D | null = null;
  private lastY: number | null = null;

  private doc: PdfDocument;
  private ctx: CanvasRenderingContext2D;
  private isCurrent: () => boolean;

  constructor(doc: PdfDocument, ctx: CanvasRenderingContext2D, isCurrent: () => boolean) {
    this.doc = doc;
    this.ctx = ctx;
    this.isCurrent = isCurrent;
  }

  private stop(note: string): never {
    this.note = note;
    throw new Stop();
  }

  async execute(bytes: Uint8Array, resources: Dict | null, depth: number): Promise<void> {
    const doc = this.doc;
    const ctx = this.ctx;
    const lexer = new Lexer(bytes, 0);
    let args: Obj[] = [];
    let pathOpen = false;
    let clipRule: 'nonzero' | 'evenodd' | null = null;
    const baseStack = this.stack.length;
    const num = (i: number) => (typeof args[i] === 'number' ? (args[i] as number) : 0);
    const fonts = doc.dict(resources?.map.get('Font'));
    const xobjects = doc.dict(resources?.map.get('XObject'));
    const extg = doc.dict(resources?.map.get('ExtGState'));
    const paint = async (fill: boolean, stroke: boolean, rule: 'nonzero' | 'evenodd') => {
      const s = this.state;
      if (fill) {
        ctx.globalAlpha = s.alpha;
        ctx.fillStyle = s.fill;
        ctx.fill(rule);
      }
      if (stroke) {
        ctx.globalAlpha = s.strokeAlpha;
        ctx.strokeStyle = s.stroke;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      if (clipRule) {
        ctx.clip(clipRule);
        clipRule = null;
      }
      ctx.beginPath();
      pathOpen = false;
    };
    for (;;) {
      const tok = lexer.read(false);
      if (tok === undefined) break;
      if (!(tok instanceof Cmd)) {
        args.push(tok);
        if (args.length > 64) args.shift();
        continue;
      }
      if (++this.ops > MAX_OPS) this.stop('This page is very complicated, so only the first part is shown.');
      if (this.ops % 500 === 0) {
        if (Date.now() - this.started > MAX_MS) this.stop('This page took too long to draw, so only part of it is shown.');
        if (this.ops % 4000 === 0) {
          await new Promise(r => setTimeout(r, 0));
          if (!this.isCurrent()) throw new Stop();
        }
      }
      const s = this.state;
      switch (tok.cmd) {
        case 'q': this.stack.push({ ...s }); ctx.save(); break;
        case 'Q': if (this.stack.length > baseStack) { this.state = this.stack.pop()!; ctx.restore(); } break;
        case 'cm': ctx.transform(num(0), num(1), num(2), num(3), num(4), num(5)); break;
        case 'w': ctx.lineWidth = Math.max(num(0), 0.01); break;
        case 'J': ctx.lineCap = (['butt', 'round', 'square'] as const)[num(0)] ?? 'butt'; break;
        case 'j': ctx.lineJoin = (['miter', 'round', 'bevel'] as const)[num(0)] ?? 'miter'; break;
        case 'M': ctx.miterLimit = Math.max(num(0), 1); break;
        case 'd': {
          const list = Array.isArray(args[0]) ? (args[0] as Obj[]).filter((x): x is number => typeof x === 'number' && x >= 0) : [];
          ctx.setLineDash(list.some(x => x > 0) ? list : []);
          ctx.lineDashOffset = num(1);
          break;
        }
        case 'gs': {
          const g = doc.dict(extg?.map.get((args[0] as Name)?.name));
          if (g) {
            const lw = doc.resolve(g.map.get('LW'));
            if (typeof lw === 'number') ctx.lineWidth = Math.max(lw, 0.01);
            const ca = doc.resolve(g.map.get('ca'));
            if (typeof ca === 'number') s.alpha = Math.max(0, Math.min(1, ca));
            const cs = doc.resolve(g.map.get('CA'));
            if (typeof cs === 'number') s.strokeAlpha = Math.max(0, Math.min(1, cs));
          }
          break;
        }
        // Paths
        case 'm': ctx.moveTo(num(0), num(1)); pathOpen = true; break;
        case 'l': ctx.lineTo(num(0), num(1)); break;
        case 'c': ctx.bezierCurveTo(num(0), num(1), num(2), num(3), num(4), num(5)); break;
        case 'v': ctx.bezierCurveTo(num(0), num(1), num(0), num(1), num(2), num(3)); break;
        case 'y': ctx.bezierCurveTo(num(0), num(1), num(2), num(3), num(2), num(3)); break;
        case 'h': ctx.closePath(); break;
        case 're': ctx.rect(num(0), num(1), num(2), num(3)); pathOpen = true; break;
        case 'S': await paint(false, true, 'nonzero'); break;
        case 's': ctx.closePath(); await paint(false, true, 'nonzero'); break;
        case 'f': case 'F': await paint(true, false, 'nonzero'); break;
        case 'f*': await paint(true, false, 'evenodd'); break;
        case 'B': await paint(true, true, 'nonzero'); break;
        case 'B*': await paint(true, true, 'evenodd'); break;
        case 'b': ctx.closePath(); await paint(true, true, 'nonzero'); break;
        case 'b*': ctx.closePath(); await paint(true, true, 'evenodd'); break;
        case 'n': await paint(false, false, 'nonzero'); break;
        case 'W': clipRule = 'nonzero'; break;
        case 'W*': clipRule = 'evenodd'; break;
        // Colour
        case 'g': s.fill = gray(num(0)); s.fillSpace = 'gray'; break;
        case 'G': s.stroke = gray(num(0)); s.strokeSpace = 'gray'; break;
        case 'rg': s.fill = rgb(num(0), num(1), num(2)); s.fillSpace = 'rgb'; break;
        case 'RG': s.stroke = rgb(num(0), num(1), num(2)); s.strokeSpace = 'rgb'; break;
        case 'k': s.fill = cmyk(num(0), num(1), num(2), num(3)); s.fillSpace = 'cmyk'; break;
        case 'K': s.stroke = cmyk(num(0), num(1), num(2), num(3)); s.strokeSpace = 'cmyk'; break;
        case 'cs': case 'CS': {
          const name = args[0] instanceof Name ? args[0].name : '';
          const csRes = doc.dict(resources?.map.get('ColorSpace'));
          const def = name && csRes ? doc.resolve(csRes.map.get(name)) : null;
          let kind = name.toLowerCase().replace('device', '');
          if (Array.isArray(def) && def[0] instanceof Name) kind = def[0].name === 'Separation' ? 'separation' : def[0].name === 'Pattern' ? 'pattern' : kind;
          if (kind === 'pattern') kind = 'pattern';
          if (tok.cmd === 'cs') s.fillSpace = kind; else s.strokeSpace = kind;
          break;
        }
        case 'sc': case 'scn': case 'SC': case 'SCN': {
          const n = args.filter((x): x is number => typeof x === 'number');
          const fillOp = tok.cmd === 'sc' || tok.cmd === 'scn';
          const space = fillOp ? s.fillSpace : s.strokeSpace;
          const colour = n.length ? colourFrom(args.some(a => a instanceof Name) ? 'pattern' : space, n) : 'rgb(128,128,128)';
          if (fillOp) s.fill = colour; else s.stroke = colour;
          break;
        }
        // Text
        case 'BT': this.tm = [1, 0, 0, 1, 0, 0]; this.tlm = [1, 0, 0, 1, 0, 0]; break;
        case 'ET': break;
        case 'Tf': {
          const name = args[0] instanceof Name ? args[0].name : '';
          const fd = doc.dict(fonts?.map.get(name));
          s.font = fd ? await loadFont(doc, fd) : null;
          s.size = num(1);
          break;
        }
        case 'Tc': s.charSpace = num(0); break;
        case 'Tw': s.wordSpace = num(0); break;
        case 'Tz': s.hScale = num(0) / 100; break;
        case 'TL': s.leading = num(0); break;
        case 'Ts': s.rise = num(0); break;
        case 'Tr': s.mode = num(0); break;
        case 'Td': this.moveText(num(0), num(1)); break;
        case 'TD': s.leading = -num(1); this.moveText(num(0), num(1)); break;
        case 'Tm': this.tm = [num(0), num(1), num(2), num(3), num(4), num(5)]; this.tlm = [...this.tm] as Matrix; break;
        case 'T*': this.moveText(0, -s.leading); break;
        case 'Tj': this.show(args[0]); break;
        case "'": this.moveText(0, -s.leading); this.show(args[0]); break;
        case '"': s.wordSpace = num(0); s.charSpace = num(1); this.moveText(0, -s.leading); this.show(args[2]); break;
        case 'TJ': {
          const list = Array.isArray(args[0]) ? args[0] : [];
          for (const item of list) {
            if (item instanceof PStr) this.show(item);
            else if (typeof item === 'number') {
              const adjust = (-item / 1000) * s.size * s.hScale;
              this.tm = mul([1, 0, 0, 1, adjust, 0], this.tm);
              if (item < -200 && this.text.length && !this.text[this.text.length - 1].endsWith(' ')) this.text.push(' ');
            }
          }
          break;
        }
        // Pictures and pieces
        case 'Do': {
          const name = args[0] instanceof Name ? args[0].name : '';
          const xo = doc.resolve(xobjects?.map.get(name));
          if (xo instanceof Stream) {
            const kind = (doc.get(xo.dict, 'Subtype') as Name | null)?.name;
            if (kind === 'Image') await this.image(xo, resources);
            else if (kind === 'Form' && depth < MAX_FORM_DEPTH) await this.form(xo, resources, depth);
          }
          break;
        }
        case 'BI': {
          // An inline picture: skip its data up to the EI marker.
          for (;;) {
            const t = lexer.read(false);
            if (t === undefined || (t instanceof Cmd && t.cmd === 'ID')) break;
          }
          const d = lexer.data;
          let p = lexer.pos;
          while (p < d.length - 1 && !(d[p] === 0x45 && d[p + 1] === 0x49 && (d[p - 1] === 10 || d[p - 1] === 32 || d[p - 1] === 13))) p++;
          lexer.pos = p + 2;
          break;
        }
        default: break;
      }
      args = [];
    }
    while (this.stack.length > baseStack) {
      this.state = this.stack.pop()!;
      ctx.restore();
    }
    void pathOpen;
  }

  private moveText(tx: number, ty: number): void {
    this.tlm = mul([1, 0, 0, 1, tx, ty], this.tlm);
    this.tm = [...this.tlm] as Matrix;
  }

  private measure(font: PdfFont, ch: string): number {
    if (!this.measureCtx) this.measureCtx = document.createElement('canvas').getContext('2d');
    const m = this.measureCtx!;
    m.font = `${font.style} ${font.weight} 100px ${font.family}`;
    return (m.measureText(ch).width / 100) * 1000;
  }

  private show(value: Obj | undefined): void {
    if (!(value instanceof PStr)) return;
    const s = this.state;
    const font = s.font;
    if (!font || !s.size) return;
    const ctx = this.ctx;
    const bytes = value.bytes;
    const step = font.twoByte ? 2 : 1;
    for (let i = 0; i + step <= bytes.length; i += step) {
      const code = step === 2 ? (bytes[i] << 8) | bytes[i + 1] : bytes[i];
      const ch = font.text(code);
      let width = font.width(code);
      if (width === null) width = ch ? this.measure(font, ch) : 500;
      const trm = mul([s.size * s.hScale, 0, 0, s.size, 0, s.rise], this.tm);
      if (ch && s.mode !== 3 && ch.trim() !== '') {
        // Start a new line of extracted text when the baseline moves.
        const y = Math.round(this.tm[5]);
        if (this.lastY !== null && y !== this.lastY && this.text.length && !this.text[this.text.length - 1].endsWith('\n')) this.text.push('\n');
        this.lastY = y;
        ctx.save();
        ctx.transform(trm[0], trm[1], trm[2], trm[3], trm[4], trm[5]);
        ctx.scale(1, -1);
        ctx.font = `${font.style} ${font.weight} 1px ${font.family}`;
        ctx.globalAlpha = s.alpha;
        if (s.mode === 1 || s.mode === 2) {
          ctx.strokeStyle = s.stroke;
          ctx.lineWidth = 0.02;
          ctx.strokeText(ch, 0, 0);
        }
        if (s.mode !== 1) {
          ctx.fillStyle = s.fill;
          ctx.fillText(ch, 0, 0);
        }
        ctx.restore();
        this.text.push(ch);
      } else if (ch === ' ' && this.text.length && !this.text[this.text.length - 1].endsWith(' ')) {
        this.text.push(' ');
      }
      const advance = ((width / 1000) * s.size + s.charSpace + (step === 1 && code === 32 ? s.wordSpace : 0)) * s.hScale;
      this.tm = mul([1, 0, 0, 1, advance, 0], this.tm);
    }
  }

  private async form(xo: Stream, resources: Dict | null, depth: number): Promise<void> {
    const doc = this.doc;
    const ctx = this.ctx;
    ctx.save();
    this.stack.push({ ...this.state });
    const m = doc.resolve(xo.dict.map.get('Matrix'));
    if (Array.isArray(m) && m.length >= 6) ctx.transform(...(m.slice(0, 6).map(v => doc.num(v, 0)) as Matrix));
    const b = doc.resolve(xo.dict.map.get('BBox'));
    if (Array.isArray(b) && b.length >= 4) {
      const v = b.slice(0, 4).map(x => doc.num(x, 0));
      ctx.beginPath();
      ctx.rect(Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.abs(v[2] - v[0]), Math.abs(v[3] - v[1]));
      ctx.clip();
      ctx.beginPath();
    }
    const savedTm = this.tm;
    const savedTlm = this.tlm;
    try {
      await this.execute(await doc.streamData(xo), doc.dict(xo.dict.map.get('Resources')) ?? resources, depth + 1);
    } finally {
      this.tm = savedTm;
      this.tlm = savedTlm;
      this.state = this.stack.pop() ?? this.state;
      ctx.restore();
    }
  }

  private async image(xo: Stream, resources: Dict | null): Promise<void> {
    const doc = this.doc;
    const ctx = this.ctx;
    const width = doc.num(xo.dict.map.get('Width') ?? xo.dict.map.get('W'), 0);
    const height = doc.num(xo.dict.map.get('Height') ?? xo.dict.map.get('H'), 0);
    if (width < 1 || height < 1 || width * height > MAX_IMAGE_PIXELS) return;
    let source: CanvasImageSource | null = null;
    try {
      const filter = doc.imageFilter(xo);
      if (filter === 'DCTDecode' || filter === 'DCT') {
        const bytes = await doc.streamData(xo);
        source = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/jpeg' }));
      } else if (filter === 'JPXDecode' || filter === 'CCITTFaxDecode' || filter === 'JBIG2Decode') {
        source = null;
      } else {
        source = await this.rawImage(xo, width, height, resources);
      }
    } catch {
      source = null;
    }
    ctx.save();
    ctx.globalAlpha = this.state.alpha;
    ctx.transform(1, 0, 0, -1, 0, 1);
    if (source) {
      ctx.drawImage(source, 0, 0, 1, 1);
    } else {
      // A picture in a form this viewer cannot read: a light box marks where it is.
      ctx.fillStyle = 'rgba(200,200,200,0.5)';
      ctx.fillRect(0, 0, 1, 1);
    }
    ctx.restore();
  }

  private async rawImage(xo: Stream, width: number, height: number, resources: Dict | null): Promise<CanvasImageSource | null> {
    const doc = this.doc;
    const data = await doc.streamData(xo);
    const bpc = doc.num(xo.dict.map.get('BitsPerComponent') ?? xo.dict.map.get('BPC'), 8);
    const isMask = doc.resolve(xo.dict.map.get('ImageMask') ?? xo.dict.map.get('IM')) === true;
    const out = new ImageData(width, height);
    const px = out.data;
    const csObj = doc.resolve(xo.dict.map.get('ColorSpace') ?? xo.dict.map.get('CS'));
    let comps = 1;
    let palette: Uint8Array | null = null;
    let cmykSpace = false;
    const spaceName = (o: Obj): string => (o instanceof Name ? o.name : '');
    const resolveSpace = (o: Obj): void => {
      const named = spaceName(o);
      if (named === 'DeviceRGB' || named === 'RGB' || named === 'CalRGB') comps = 3;
      else if (named === 'DeviceCMYK' || named === 'CMYK') { comps = 4; cmykSpace = true; }
      else if (named === 'DeviceGray' || named === 'G' || named === 'CalGray') comps = 1;
      else if (Array.isArray(o)) {
        const kind = spaceName(doc.resolve(o[0]));
        if (kind === 'ICCBased') {
          const icc = doc.resolve(o[1]);
          comps = icc instanceof Stream ? doc.num(icc.dict.map.get('N'), 3) : 3;
          cmykSpace = comps === 4;
        } else if (kind === 'Indexed' || kind === 'I') {
          comps = 1;
          const base = doc.resolve(o[1]);
          const lookup = doc.resolve(o[3]);
          let baseComps = 3;
          const bn = spaceName(base);
          if (bn === 'DeviceGray' || bn === 'G') baseComps = 1;
          else if (bn === 'DeviceCMYK' || bn === 'CMYK') baseComps = 4;
          else if (Array.isArray(base) && spaceName(doc.resolve(base[0])) === 'ICCBased') {
            const icc = doc.resolve(base[1]);
            baseComps = icc instanceof Stream ? doc.num(icc.dict.map.get('N'), 3) : 3;
          }
          const table = lookup instanceof PStr ? lookup.bytes : lookup instanceof Stream ? new Uint8Array(0) : new Uint8Array(0);
          const bytes = lookup instanceof Stream ? null : table;
          const size = (doc.num(o[2], 255) + 1) * baseComps;
          const raw = bytes ?? new Uint8Array(size);
          palette = new Uint8Array((raw.length / baseComps) * 4);
          for (let i = 0; i < raw.length / baseComps; i++) {
            const v = Array.from(raw.subarray(i * baseComps, i * baseComps + baseComps), x => x / 255);
            const c = baseComps === 1 ? gray(v[0]) : baseComps === 4 ? cmyk(v[0], v[1], v[2], v[3]) : rgb(v[0], v[1], v[2]);
            const m = /(\d+),(\d+),(\d+)/.exec(c)!;
            palette.set([+m[1], +m[2], +m[3], 255], i * 4);
          }
        } else if (kind === 'Separation' || kind === 'DeviceN') comps = 1;
        else if (kind === 'CalRGB' || kind === 'Lab') comps = 3;
      } else if (typeof named === 'string' && named) {
        const csRes = doc.dict(resources?.map.get('ColorSpace'));
        const looked = csRes ? doc.resolve(csRes.map.get(named)) : null;
        if (looked) resolveSpace(looked);
      }
    };
    if (!isMask) resolveSpace(csObj);
    const rowBytes = Math.ceil((width * (isMask ? 1 : comps) * (isMask ? 1 : bpc)) / 8);
    if (data.length < rowBytes * height * 0.5 && data.length < rowBytes) return null;
    const sep = Array.isArray(csObj) && spaceName(doc.resolve(csObj[0])) === 'Separation';
    const decode = doc.resolve(xo.dict.map.get('Decode') ?? xo.dict.map.get('D'));
    const inverted = Array.isArray(decode) && doc.num(decode[0], 0) === 1;
    const fillRgb = /(\d+),(\d+),(\d+)/.exec(this.state.fill) ?? ['', '0', '0', '0'];
    const max = (1 << bpc) - 1;
    for (let y = 0; y < height; y++) {
      const row = y * rowBytes;
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        if (isMask) {
          const bit = (data[row + (x >> 3)] >> (7 - (x & 7))) & 1;
          const paintIt = inverted ? bit === 1 : bit === 0;
          px[o] = +fillRgb[1]; px[o + 1] = +fillRgb[2]; px[o + 2] = +fillRgb[3];
          px[o + 3] = paintIt ? 255 : 0;
          continue;
        }
        const sample = (c: number): number => {
          const idx = x * comps + c;
          if (bpc === 8) return data[row + idx] ?? 0;
          if (bpc === 16) return data[row + idx * 2] ?? 0;
          const bit = idx * bpc;
          const v = ((data[row + (bit >> 3)] ?? 0) >> (8 - bpc - (bit & 7))) & max;
          return palette ? v : Math.round((v * 255) / max);
        };
        if (palette) {
          const i = (bpc === 8 ? data[row + x] : sample(0)) ?? 0;
          px[o] = palette[i * 4] ?? 0; px[o + 1] = palette[i * 4 + 1] ?? 0; px[o + 2] = palette[i * 4 + 2] ?? 0; px[o + 3] = 255;
        } else if (comps === 3) {
          px[o] = sample(0); px[o + 1] = sample(1); px[o + 2] = sample(2); px[o + 3] = 255;
        } else if (comps === 4 || cmykSpace) {
          const k = 1 - sample(3) / 255;
          px[o] = (255 - sample(0)) * k; px[o + 1] = (255 - sample(1)) * k; px[o + 2] = (255 - sample(2)) * k; px[o + 3] = 255;
        } else {
          let g = sample(0);
          if (sep || inverted) g = 255 - g;
          px[o] = px[o + 1] = px[o + 2] = g;
          px[o + 3] = 255;
        }
      }
    }
    // A soft mask gives each pixel its opacity.
    const sm = doc.resolve(xo.dict.map.get('SMask'));
    if (sm instanceof Stream) {
      const sw = doc.num(sm.dict.map.get('Width'), 0);
      const sh = doc.num(sm.dict.map.get('Height'), 0);
      if (sw > 0 && sh > 0 && sw * sh <= MAX_IMAGE_PIXELS && (doc.get(sm.dict, 'BitsPerComponent') ?? 8) === 8 && !doc.imageFilter(sm)) {
        const mask = await doc.streamData(sm);
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) px[(y * width + x) * 4 + 3] = mask[Math.floor((y * sh) / height) * sw + Math.floor((x * sw) / width)] ?? 255;
        }
      }
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d')!.putImageData(out, 0, 0);
    return canvas;
  }
}

export { Dict };
