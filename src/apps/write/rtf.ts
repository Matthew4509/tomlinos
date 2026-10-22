// Rich Text Format (.rtf), the kind WordPad saves and every word processor reads, opened into Write's document:
// paragraphs with their alignment, spacing and indents; bold, italic, underline, strikethrough, raised and lowered text,
// typeface, size, colour and highlight; line breaks, tabs, page breaks; bullets and numbers (WordPad's and Word's);
// tables; PNG and JPEG pictures. Read only: Write saves it as a Word document. Our own reader; no browser needed except
// to keep the pictures (images.ts). An .rtf is read character by character, never with patterns that could run long.
import { addPicture } from './images.ts';
import { STYLES, type MarkJSON, type NodeJSON } from './model.ts';

export class RtfProblem extends Error {}

/** A file bigger than this is not read as RTF (pictures in RTF are written out as hex, so files run large). */
const MAX_RTF = 60 * 1024 * 1024;

interface Chars {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  vert: 'super' | 'sub' | null;
  font: number;
  /** Half-points. */
  size: number;
  colour: number;
  highlight: number;
  hidden: boolean;
}

interface Para {
  align: string | null;
  /** Twips. */
  li: number;
  fi: number;
  sb: number;
  sa: number;
  sl: number;
  slmult: boolean;
  inTable: boolean;
  /** Word's list level (\ilvl) when the paragraph is in a list (\ls). */
  level: number;
  list: boolean;
}

/** What a group is: ordinary text, or one of the parts read differently or skipped. */
type Dest = 'text' | 'skip' | 'fonttbl' | 'colortbl' | 'pict' | 'listmark';

interface State {
  dest: Dest;
  chars: Chars;
  /** How many characters a \uN stands in for (\ucN). */
  uc: number;
}

const plainChars = (size: number, font: number): Chars => ({ bold: false, italic: false, underline: false, strike: false, vert: null, font, size, colour: 0, highlight: 0, hidden: false });
const plainPara = (): Para => ({ align: null, li: 0, fi: 0, sb: 0, sa: 0, sl: 0, slmult: false, inTable: false, level: 0, list: false });

/** Groups whose text is not part of the document. */
const SKIP = new Set(['stylesheet', 'info', 'header', 'headerl', 'headerr', 'headerf', 'footer', 'footerl', 'footerr', 'footerf', 'footnote', 'annotation', 'fldinst', 'object', 'xmlnstbl', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'themedata', 'colorschememapping', 'latentstyles', 'datastore', 'filetbl', 'revtbl', 'pgdsctbl', 'bkmkstart', 'bkmkend', 'nonshppict', 'shpinst', 'atnid', 'atnauthor', 'pnseclvl', 'pn', 'pgptbl', 'mmathPr', 'defchp', 'defpap', 'wgrffmtfilter', 'docvar', 'userprops', 'protusertbl']);

export interface RtfRead {
  doc: NodeJSON;
  dropped: string[];
}

/** Reads an .rtf file's bytes into the editor's document. Throws RtfProblem with a plain reason. */
export function readRtf(bytes: Uint8Array): RtfRead {
  if (bytes.length > MAX_RTF) throw new RtfProblem('This RTF file is bigger than 60 MB, which is more than Write opens.');
  // RTF is 7-bit text: anything else is written as \'hh or \uN, so reading the bytes as Latin-1 loses nothing.
  let src = '';
  for (let i = 0; i < bytes.length; i += 65536) src += String.fromCharCode(...bytes.subarray(i, i + 65536));
  if (!src.startsWith('{\\rtf')) throw new RtfProblem('This is not an RTF file (it does not start the way RTF files do).');

  const dropped = new Set<string>();
  let codepage = 1252;
  let decoder = new TextDecoder('windows-1252');
  const fonts = new Map<number, string>();
  const colours: string[] = [];
  let defFont = 0;
  // RTF's own standard size when a file names none: 12 points.
  const defSize = 24;

  const blocks: NodeJSON[] = [];
  let para: Para = plainPara();
  let runs: NodeJSON[] = [];
  let listMark = '';
  // Tables: cells of the row being read, rows of the table being read, and the cell edges (\cellx, twips).
  let cellBlocks: NodeJSON[] = [];
  let rowCells: NodeJSON[] = [];
  let tableRows: NodeJSON[] = [];
  let edges: number[] = [];
  let pendingEdges: number[] = [];
  // Pictures: the hex and the size of the one being read.
  let pict = { kind: '', hex: [] as string[], w: 0, h: 0, sx: 100, sy: 100 };
  // A font or colour table entry being read.
  let entry = '';
  let colour = { r: 0, g: 0, b: 0, set: false };
  let fontNo = 0;

  const stack: State[] = [];
  let st: State = { dest: 'text', chars: plainChars(defSize, defFont), uc: 1 };
  let skipChars = 0;
  // Bytes of \'hh in a row, decoded together (a code page with two-byte characters needs them together).
  let pending: number[] = [];

  const marksOf = (c: Chars): MarkJSON[] => {
    const out: MarkJSON[] = [];
    const face = fonts.get(c.font);
    if (face && face.toLowerCase() !== STYLES.normal.face.toLowerCase() && /^[A-Za-z0-9][A-Za-z0-9 \-]{0,30}$/.test(face)) out.push({ type: 'font', attrs: { face } });
    if (c.size / 2 !== STYLES.normal.size) out.push({ type: 'size', attrs: { pt: c.size / 2 } });
    const col = colours[c.colour];
    if (c.colour > 0 && col && col !== '#000000') out.push({ type: 'color', attrs: { value: col } });
    const hl = colours[c.highlight];
    if (c.highlight > 0 && hl && hl !== '#ffffff') out.push({ type: 'highlight', attrs: { value: hl } });
    if (c.bold) out.push({ type: 'strong' });
    if (c.italic) out.push({ type: 'em' });
    if (c.underline) out.push({ type: 'underline' });
    if (c.strike) out.push({ type: 'strike' });
    if (c.vert) out.push({ type: 'vert', attrs: { pos: c.vert } });
    return out;
  };
  const addText = (text: string): void => {
    if (!text || st.chars.hidden) return;
    if (st.dest === 'listmark') {
      listMark += text;
      return;
    }
    if (st.dest !== 'text') {
      if (st.dest === 'fonttbl') {
        // Each font's name ends with ";" (one group each, or all in one).
        entry += text;
        let semi = entry.indexOf(';');
        while (semi >= 0) {
          if (entry.slice(0, semi).trim()) fonts.set(fontNo, entry.slice(0, semi).trim());
          entry = entry.slice(semi + 1);
          semi = entry.indexOf(';');
        }
      }
      return;
    }
    const marks = marksOf(st.chars);
    const last = runs[runs.length - 1];
    if (last?.type === 'text' && JSON.stringify(last.marks ?? []) === JSON.stringify(marks)) last.text += text;
    else runs.push(marks.length ? { type: 'text', text, marks } : { type: 'text', text });
  };
  const flushBytes = (): void => {
    if (!pending.length) return;
    const text = decoder.decode(Uint8Array.from(pending));
    pending = [];
    addText(text);
  };
  const paraAttrs = (): Record<string, unknown> => {
    const s = STYLES.normal;
    const a: Record<string, unknown> = { style: 'normal' };
    if (para.align) a.align = para.align;
    if (para.sb / 20 !== s.before) a.before = para.sb / 20;
    if (para.sa / 20 !== s.after) a.after = para.sa / 20;
    if (para.sl > 0 && para.slmult) {
      const line = Math.round((para.sl / 240) * 100) / 100;
      if (line !== s.line && line >= 0.5 && line <= 5) a.line = line;
    } else if (para.sl === 0 && s.line !== 1) a.line = 1;
    if (!para.list) {
      if (para.li > 0) a.indent = para.li / 20;
      if (para.fi) a.first = para.fi / 20;
    }
    return a;
  };
  /** Closes a table that has rows when a paragraph outside it starts. */
  const closeTable = (): void => {
    if (!tableRows.length) return;
    const widest = Math.max(...tableRows.map(r => r.content!.length));
    for (const r of tableRows) while (r.content!.length < widest) r.content!.push({ type: 'table_cell', attrs: { colspan: 1, rowspan: 1, colwidth: null, background: null }, content: [{ type: 'paragraph' }] });
    blocks.push({ type: 'table', attrs: { borders: true }, content: tableRows });
    tableRows = [];
  };
  const endParagraph = (): void => {
    flushBytes();
    const node: NodeJSON = runs.length ? { type: 'paragraph', attrs: paraAttrs(), content: runs } : { type: 'paragraph', attrs: paraAttrs() };
    runs = [];
    const mark = listMark.trim();
    listMark = '';
    if (para.inTable) {
      cellBlocks.push(node);
      return;
    }
    closeTable();
    if (para.list || mark) {
      // Bullets and numbers: the mark WordPad and Word write before the text says which (a digit or letter: numbered).
      const ordered = /^[(]?[0-9a-zA-Z]+[.)]/.test(mark);
      const kind = ordered ? 'ordered_list' : 'bullet_list';
      const last = blocks[blocks.length - 1];
      const item: NodeJSON = { type: 'list_item', content: [node] };
      let list = last && last.type === kind ? last : null;
      // A deeper level goes inside the last item of the list above it.
      for (let d = 0; list && d < para.level; d++) {
        const lastItem: NodeJSON = list.content![list.content!.length - 1];
        const inner: NodeJSON | undefined = lastItem.content![lastItem.content!.length - 1];
        if (inner && inner.type === kind) list = inner;
        else {
          const made: NodeJSON = kind === 'ordered_list' ? { type: kind, attrs: { order: 1 }, content: [] } : { type: kind, content: [] };
          lastItem.content!.push(made);
          list = made;
        }
      }
      if (list) list.content!.push(item);
      else blocks.push(kind === 'ordered_list' ? { type: kind, attrs: { order: Number(/\d+/.exec(mark)?.[0] ?? 1) || 1 }, content: [item] } : { type: kind, content: [item] });
      return;
    }
    blocks.push(node);
  };
  const endCell = (): void => {
    flushBytes();
    if (runs.length || !cellBlocks.length) endParagraph();
    const i = rowCells.length;
    const w = edges[i] !== undefined ? edges[i] - (edges[i - 1] ?? 0) : 0;
    rowCells.push({ type: 'table_cell', attrs: { colspan: 1, rowspan: 1, colwidth: w > 0 ? [Math.max(20, Math.round(w / 15))] : null, background: null }, content: cellBlocks.length ? cellBlocks : [{ type: 'paragraph' }] });
    cellBlocks = [];
  };
  const endRow = (): void => {
    if (cellBlocks.length || runs.length) endCell();
    if (rowCells.length) tableRows.push({ type: 'table_row', content: rowCells });
    rowCells = [];
  };
  const endPicture = (): void => {
    const hex = pict.hex.join('').replace(/[^0-9a-fA-F]/g, '');
    if (pict.kind !== 'png' && pict.kind !== 'jpeg') {
      dropped.add('pictures in a kind Write cannot show (such as WMF or EMF drawings)');
      return;
    }
    const data = new Uint8Array(hex.length >> 1);
    for (let i = 0; i < data.length; i++) data[i] = parseInt(hex.substr(i * 2, 2), 16);
    const id = addPicture(data);
    if (!id) {
      dropped.add('pictures that could not be read');
      return;
    }
    const w = pict.w ? Math.round(((pict.w / 15) * pict.sx) / 100) : null;
    const h = pict.h ? Math.round(((pict.h / 15) * pict.sy) / 100) : null;
    runs.push({ type: 'image', attrs: { src: id, width: w, height: h, alt: '' } });
  };

  const control = (word: string, param: number | null): void => {
    const on = param === null || param !== 0;
    const c = st.chars;
    switch (word) {
      case 'ansicpg':
        if (param && param !== codepage) {
          try {
            decoder = new TextDecoder(`windows-${param}`);
            codepage = param;
          } catch {
            // An unknown code page: the Western one stays.
          }
        }
        break;
      case 'deff':
        defFont = param ?? 0;
        st.chars.font = defFont;
        break;
      case 'uc': st.uc = Math.max(0, param ?? 1); break;
      case 'u': {
        flushBytes();
        const code = (param ?? 0) < 0 ? (param ?? 0) + 65536 : param ?? 0;
        addText(String.fromCharCode(code));
        skipChars = st.uc;
        break;
      }
      // Paragraphs.
      case 'par': endParagraph(); break;
      case 'pard':
        // Word writes \pard inside a list item's number ({\listtext\pard...}): that one belongs to the number only.
        if (st.dest !== 'listmark') para = plainPara();
        break;
      case 'ql': para.align = null; break;
      case 'qc': para.align = 'center'; break;
      case 'qr': para.align = 'right'; break;
      case 'qj': case 'qd': para.align = 'justify'; break;
      case 'li': case 'lin': para.li = param ?? 0; break;
      case 'fi': para.fi = param ?? 0; break;
      case 'sb': para.sb = Math.max(0, param ?? 0); break;
      case 'sa': para.sa = Math.max(0, param ?? 0); break;
      case 'sl': para.sl = Math.abs(param ?? 0); break;
      case 'slmult': para.slmult = on; break;
      case 'intbl': para.inTable = true; break;
      case 'ls': para.list = true; break;
      case 'ilvl': para.level = Math.max(0, Math.min(8, param ?? 0)); break;
      case 'pnlvlblt': case 'pnlvlbody': case 'pnlvlcont': para.list = true; break;
      case 'line': flushBytes(); if (st.dest === 'text') runs.push({ type: 'hard_break' }); break;
      case 'tab': flushBytes(); addText('\t'); break;
      case 'page':
        endParagraph();
        closeTable();
        blocks.push({ type: 'page_break' });
        break;
      case 'sect': endParagraph(); closeTable(); blocks.push({ type: 'page_break' }); break;
      // Tables.
      case 'trowd': edges = []; pendingEdges = []; break;
      case 'cellx': pendingEdges.push(param ?? 0); edges = pendingEdges; break;
      case 'cell': endCell(); break;
      case 'row': endRow(); break;
      // Characters.
      case 'plain': if (st.dest !== 'listmark') st.chars = plainChars(defSize, defFont); break;
      case 'b': c.bold = on; break;
      case 'i': c.italic = on; break;
      case 'ul': case 'uld': case 'uldb': case 'ulw': case 'ulth': case 'uldash': c.underline = on; break;
      case 'ulnone': c.underline = false; break;
      case 'strike': case 'striked': c.strike = on; break;
      case 'super': c.vert = 'super'; break;
      case 'sub': c.vert = 'sub'; break;
      case 'nosupersub': c.vert = null; break;
      case 'v': c.hidden = on; break;
      case 'f':
        if (st.dest === 'fonttbl') fontNo = param ?? 0;
        else c.font = param ?? defFont;
        break;
      case 'fs': c.size = Math.max(2, param ?? defSize); break;
      case 'cf': c.colour = param ?? 0; break;
      case 'highlight': case 'cb': case 'chcbpat': c.highlight = param ?? 0; break;
      case 'red': colour.r = param ?? 0; colour.set = true; break;
      case 'green': colour.g = param ?? 0; colour.set = true; break;
      case 'blue': colour.b = param ?? 0; colour.set = true; break;
      // Pictures.
      case 'pngblip': pict.kind = 'png'; break;
      case 'jpegblip': pict.kind = 'jpeg'; break;
      case 'wmetafile': case 'emfblip': case 'macpict': case 'dibitmap': case 'wbitmap': pict.kind = 'other'; break;
      case 'picwgoal': pict.w = param ?? 0; break;
      case 'pichgoal': pict.h = param ?? 0; break;
      case 'picscalex': pict.sx = param ?? 100; break;
      case 'picscaley': pict.sy = param ?? 100; break;
      default: break;
    }
  };

  /** The first control word of a group can make it a destination of its own. */
  const destination = (word: string, starred: boolean): Dest | null => {
    if (word === 'fonttbl') return 'fonttbl';
    if (word === 'colortbl') return 'colortbl';
    if (word === 'pict') return 'pict';
    if (word === 'pntext' || word === 'listtext') return 'listmark';
    if (word === 'shppict') return null;
    if (SKIP.has(word)) {
      if (word === 'header' || word === 'footer' || word.startsWith('header') || word.startsWith('footer')) dropped.add('headers and footers');
      if (word === 'footnote') dropped.add('footnotes');
      if (word === 'annotation') dropped.add('comments');
      if (word === 'object') dropped.add('embedded objects');
      return 'skip';
    }
    return starred ? 'skip' : null;
  };

  let i = 0;
  const n = src.length;
  let groupStart = false;
  let starred = false;
  while (i < n) {
    const ch = src[i];
    if (ch === '{') {
      flushBytes();
      stack.push(st);
      st = { dest: st.dest, chars: { ...st.chars }, uc: st.uc };
      if (stack.length > 2000) throw new RtfProblem('This RTF file is nested too deeply to read.');
      groupStart = true;
      starred = false;
      i++;
      continue;
    }
    if (ch === '}') {
      flushBytes();
      if (st.dest === 'fonttbl' && entry.trim()) {
        fonts.set(fontNo, entry.replace(/;\s*$/, '').trim());
        entry = '';
      }
      if (st.dest === 'pict' && (stack[stack.length - 1]?.dest ?? 'text') !== 'pict') {
        const outer = stack[stack.length - 1];
        if (outer && outer.dest === 'text') {
          const saved = st;
          st = outer;
          endPicture();
          st = saved;
        }
        pict = { kind: '', hex: [], w: 0, h: 0, sx: 100, sy: 100 };
      }
      st = stack.pop() ?? st;
      groupStart = false;
      i++;
      continue;
    }
    if (ch === '\\') {
      const next = src[i + 1] ?? '';
      if (next === '\'') {
        const hex = src.substr(i + 2, 2);
        i += 4;
        if (skipChars > 0) {
          skipChars--;
          continue;
        }
        if (st.dest === 'pict') continue;
        pending.push(parseInt(hex, 16) || 0);
        continue;
      }
      if (/[a-zA-Z]/.test(next)) {
        let j = i + 1;
        while (j < n && /[a-zA-Z]/.test(src[j]) && j - i < 40) j++;
        const word = src.slice(i + 1, j);
        let k = j;
        if (src[k] === '-' || /[0-9]/.test(src[k] ?? '')) {
          k++;
          while (k < n && /[0-9]/.test(src[k]) && k - j < 12) k++;
        }
        const param = k > j ? Number(src.slice(j, k)) : null;
        if (src[k] === ' ') k++;
        i = k;
        if (word !== 'u' && word !== 'bin') flushBytes();
        if (groupStart) {
          const d = destination(word, starred);
          groupStart = false;
          if (d) {
            st.dest = d;
            if (d === 'colortbl') colour = { r: 0, g: 0, b: 0, set: false };
            if (d === 'pict') pict = { kind: '', hex: [], w: 0, h: 0, sx: 100, sy: 100 };
            if (d !== 'pict' && d !== 'fonttbl' && d !== 'colortbl') continue;
          }
        }
        if (word === 'bin' && param) {
          // Raw bytes inside a picture: skipped (pictures written as hex are read).
          i += param;
          continue;
        }
        if (st.dest === 'skip') continue;
        control(word, param);
        continue;
      }
      // Control symbols.
      i += 2;
      if (next === '*') {
        starred = true;
        continue;
      }
      if (st.dest === 'skip') continue;
      if (next === '\\' || next === '{' || next === '}') addText(next);
      else if (next === '~') addText(' ');
      else if (next === '_') addText('‑');
      else if (next === '\n' || next === '\r') endParagraph();
      continue;
    }
    // Plain text (line breaks in the file itself mean nothing).
    if (ch === '\r' || ch === '\n') {
      i++;
      continue;
    }
    groupStart = false;
    if (skipChars > 0) {
      skipChars--;
      i++;
      continue;
    }
    if (st.dest === 'pict') {
      let j = i;
      while (j < n && src[j] !== '\\' && src[j] !== '{' && src[j] !== '}') j++;
      pict.hex.push(src.slice(i, j));
      i = j;
      continue;
    }
    if (st.dest === 'colortbl') {
      if (ch === ';') {
        colours.push(colour.set ? `#${[colour.r, colour.g, colour.b].map(v => Math.min(255, v).toString(16).padStart(2, '0')).join('')}` : '');
        colour = { r: 0, g: 0, b: 0, set: false };
      }
      i++;
      continue;
    }
    let j = i;
    while (j < n && src[j] !== '\\' && src[j] !== '{' && src[j] !== '}' && src[j] !== '\r' && src[j] !== '\n') j++;
    flushBytes();
    if (st.dest !== 'skip') addText(src.slice(i, j));
    i = j;
  }
  flushBytes();
  if (runs.length) endParagraph();
  if (rowCells.length || cellBlocks.length) endRow();
  closeTable();
  return { doc: { type: 'doc', content: blocks.length ? blocks : [{ type: 'paragraph' }] }, dropped: [...dropped] };
}
