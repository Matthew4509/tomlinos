// Fonts for the PDF viewer. We do not unpack the typefaces stored in a PDF; we read each font's letter widths and its
// map from codes to text, then draw that text in a plain system face (serif, sans-serif or monospace, bold or
// italic as the font's name says). Words land in the right places and read correctly; the letter shapes differ.
import { Cmd, Dict, Lexer, Name, PStr, Stream, type Obj, type PdfDocument } from './objects.ts';

export interface PdfFont {
  family: string;
  weight: string;
  style: string;
  twoByte: boolean;
  /** Width of a code in thousandths of the font size, or null when the font gives none (measure the text instead). */
  width(code: number): number | null;
  /** The text a code stands for. */
  text(code: number): string;
}

const NAMES: Record<string, string> = {
  space: ' ', bullet: '•', hyphen: '-', endash: '–', emdash: '—', quoteleft: '‘', quoteright: '’', quotedblleft: '“',
  quotedblright: '”', quotesingle: "'", quotedbl: '"', period: '.', comma: ',', colon: ':', semicolon: ';', exclam: '!',
  question: '?', slash: '/', backslash: '\\', parenleft: '(', parenright: ')', bracketleft: '[', bracketright: ']',
  braceleft: '{', braceright: '}', underscore: '_', ampersand: '&', at: '@', asterisk: '*', plus: '+', equal: '=',
  less: '<', greater: '>', percent: '%', dollar: '$', numbersign: '#', asciitilde: '~', asciicircum: '^', bar: '|',
  grave: '`', zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8',
  nine: '9', fi: 'fi', fl: 'fl', ff: 'ff', ffi: 'ffi', ffl: 'ffl', Euro: '€', copyright: '©', registered: '®',
  trademark: '™', degree: '°', multiply: '×', divide: '÷', ellipsis: '…', section: '§', paragraph: '¶',
  sterling: '£', yen: '¥', cent: '¢', minus: '−', nbspace: ' ', periodcentered: '·', guillemotleft: '«', guillemotright: '»',
};

function glyphText(name: string): string {
  if (NAMES[name] !== undefined) return NAMES[name];
  const uni = /^uni([0-9A-Fa-f]{4})$/.exec(name) ?? /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (uni) return String.fromCodePoint(parseInt(uni[1], 16));
  if (name.length === 1) return name;
  const accent = /^([A-Za-z])(acute|grave|circumflex|dieresis|tilde|ring|caron|cedilla)$/.exec(name);
  if (accent) {
    const marks: Record<string, string> = { acute: '́', grave: '̀', circumflex: '̂', dieresis: '̈', tilde: '̃', ring: '̊', caron: '̌', cedilla: '̧' };
    return (accent[1] + marks[accent[2]]).normalize('NFC');
  }
  return '';
}

/** A ToUnicode map: which text each code stands for. */
function parseToUnicode(bytes: Uint8Array): Map<number, string> {
  const map = new Map<number, string>();
  const lexer = new Lexer(bytes, 0);
  const asText = (s: Obj | undefined): string => {
    if (!(s instanceof PStr)) return '';
    let out = '';
    for (let i = 0; i + 1 < s.bytes.length; i += 2) out += String.fromCharCode((s.bytes[i] << 8) | s.bytes[i + 1]);
    if (s.bytes.length === 1) out = String.fromCharCode(s.bytes[0]);
    return out;
  };
  const code = (s: Obj | undefined): number => {
    if (!(s instanceof PStr)) return -1;
    let v = 0;
    for (const b of s.bytes) v = v * 256 + b;
    return v;
  };
  let mode: 'char' | 'range' | null = null;
  const args: Obj[] = [];
  let guard = 0;
  for (;;) {
    if (++guard > 400000) break;
    const tok = lexer.read(false);
    if (tok === undefined) break;
    if (tok instanceof Cmd) {
      const c = tok.cmd;
      if (c === 'beginbfchar') mode = 'char';
      else if (c === 'beginbfrange') mode = 'range';
      else if (c === 'endbfchar' || c === 'endbfrange') {
        if (mode === 'char') for (let i = 0; i + 1 < args.length; i += 2) map.set(code(args[i]), asText(args[i + 1]));
        else if (mode === 'range') {
          for (let i = 0; i + 2 < args.length; i += 3) {
            const lo = code(args[i]);
            const hi = Math.min(code(args[i + 1]), lo + 65535);
            const dst = args[i + 2];
            if (Array.isArray(dst)) dst.forEach((d, k) => lo + k <= hi && map.set(lo + k, asText(d)));
            else {
              const base = asText(dst);
              if (base.length) for (let v = lo; v <= hi; v++) map.set(v, base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + (v - lo)));
            }
          }
        }
        args.length = 0;
        mode = null;
      }
      continue;
    }
    if (mode) args.push(tok);
  }
  return map;
}

const cache = new WeakMap<Dict, PdfFont>();

export async function loadFont(doc: PdfDocument, dict: Dict): Promise<PdfFont> {
  const known = cache.get(dict);
  if (known) return known;
  const baseName = (doc.get(dict, 'BaseFont') as Name | null)?.name ?? '';
  const lower = baseName.toLowerCase();
  const subtype = (doc.get(dict, 'Subtype') as Name | null)?.name ?? '';
  const twoByte = subtype === 'Type0';
  let descriptor = doc.dict(dict.map.get('FontDescriptor'));
  let widthsSource = dict;
  if (twoByte) {
    const desc = doc.resolve(dict.map.get('DescendantFonts'));
    const first = Array.isArray(desc) ? doc.dict(desc[0]) : null;
    if (first) {
      widthsSource = first;
      descriptor = doc.dict(first.map.get('FontDescriptor')) ?? descriptor;
    }
  }
  const flags = doc.num(descriptor?.map.get('Flags'), 0);
  const mono = /courier|mono|consolas|typewriter/.test(lower) || (flags & 1) !== 0;
  const serif = /times|serif|georgia|garamond|palatino|bookman|century|minion|cambria/.test(lower) || (!mono && !/arial|helvetica|sans|calibri|verdana|tahoma|segoe/.test(lower) && (flags & 2) !== 0);
  const bold = /bold|black|heavy|demi/.test(lower) || (flags & 0x40000) !== 0;
  const italic = /italic|oblique/.test(lower) || (flags & 64) !== 0;

  let toUni: Map<number, string> | null = null;
  const tu = doc.resolve(dict.map.get('ToUnicode'));
  if (tu instanceof Stream) {
    try {
      toUni = parseToUnicode(await doc.streamData(tu));
    } catch { /* fall back to the encoding */ }
  }

  const diffs = new Map<number, string>();
  const enc = doc.resolve(dict.map.get('Encoding'));
  const encDict = enc instanceof Dict ? enc : null;
  const differences = encDict ? doc.resolve(encDict.map.get('Differences')) : null;
  if (Array.isArray(differences)) {
    let at = 0;
    for (const item of differences) {
      const v = doc.resolve(item);
      if (typeof v === 'number') at = v;
      else if (v instanceof Name) diffs.set(at++, glyphText(v.name));
    }
  }

  const widths = new Map<number, number>();
  let missing = doc.num(descriptor?.map.get('MissingWidth'), 0);
  let dw = 1000;
  if (twoByte) {
    dw = doc.num(widthsSource.map.get('DW'), 1000);
    const w = doc.resolve(widthsSource.map.get('W'));
    if (Array.isArray(w)) {
      for (let i = 0; i < w.length; ) {
        const start = doc.num(w[i], 0);
        const next = doc.resolve(w[i + 1]);
        if (Array.isArray(next)) {
          next.forEach((x, k) => widths.set(start + k, doc.num(x, dw)));
          i += 2;
        } else {
          const end = doc.num(w[i + 1], start);
          const width = doc.num(w[i + 2], dw);
          for (let c = start; c <= Math.min(end, start + 65535); c++) widths.set(c, width);
          i += 3;
        }
      }
    }
    missing = dw;
  } else {
    const first = doc.num(dict.map.get('FirstChar'), 0);
    const list = doc.resolve(dict.map.get('Widths'));
    if (Array.isArray(list)) list.forEach((x, k) => widths.set(first + k, doc.num(x, missing)));
  }
  const haveWidths = widths.size > 0 || twoByte;

  const win1252 = new TextDecoder('windows-1252');
  const font: PdfFont = {
    family: mono ? '"Courier New", Courier, monospace' : serif ? '"Times New Roman", Times, serif' : 'Arial, Helvetica, sans-serif',
    weight: bold ? 'bold' : 'normal',
    style: italic ? 'italic' : 'normal',
    twoByte,
    width: code => (haveWidths ? (widths.get(code) ?? missing) : null),
    text: code => {
      const fromMap = toUni?.get(code);
      if (fromMap !== undefined) return fromMap;
      const d = diffs.get(code);
      if (d !== undefined) return d;
      if (twoByte) return '';
      return code < 32 ? '' : win1252.decode(Uint8Array.of(code));
    },
  };
  cache.set(dict, font);
  return font;
}
