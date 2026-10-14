// TOMLIN Write's document outside the editor: the shape of a document as plain data (the editor's own JSON, so the
// .docx reader and writer and the tests need no editor), the page setup (paper, margins, header and footer), the
// paragraph styles and how each looks, and the sizes everything is measured in. No browser needed.
import { PAPERS, type Paper } from '../sheet/print.ts';

export { PAPERS, type Paper };

/** A mark on a run of text, as the editor writes it in JSON. */
export interface MarkJSON {
  type: string;
  attrs?: Record<string, unknown>;
}

/** A node of the document, as the editor writes it in JSON (text nodes have `text`, the others `content`). */
export interface NodeJSON {
  type: string;
  attrs?: Record<string, unknown>;
  content?: NodeJSON[];
  text?: string;
  marks?: MarkJSON[];
}

/** Paragraph styles: Normal, Title and three headings, saved in Word as the styles of those names. */
export type StyleId = 'normal' | 'title' | 'h1' | 'h2' | 'h3';
export const STYLE_IDS: StyleId[] = ['normal', 'title', 'h1', 'h2', 'h3'];

export interface StyleLook {
  label: string;
  /** The style's id and name in a Word file. */
  wordId: string;
  wordName: string;
  face: string;
  /** Points. */
  size: number;
  bold?: boolean;
  colour?: string;
  /** Space before and after, in points; line spacing as a multiple of single. */
  before: number;
  after: number;
  line: number;
}

/** Each style's look, as Word's own standard document has them (Calibri 11, headings in blue Calibri Light). */
export const STYLES: Record<StyleId, StyleLook> = {
  normal: { label: 'Normal', wordId: 'Normal', wordName: 'Normal', face: 'Calibri', size: 11, before: 0, after: 8, line: 1.08 },
  title: { label: 'Title', wordId: 'Title', wordName: 'Title', face: 'Calibri Light', size: 28, before: 0, after: 0, line: 1 },
  h1: { label: 'Heading 1', wordId: 'Heading1', wordName: 'heading 1', face: 'Calibri Light', size: 16, colour: '#2f5496', before: 12, after: 0, line: 1.08 },
  h2: { label: 'Heading 2', wordId: 'Heading2', wordName: 'heading 2', face: 'Calibri Light', size: 13, colour: '#2f5496', before: 2, after: 0, line: 1.08 },
  h3: { label: 'Heading 3', wordId: 'Heading3', wordName: 'heading 3', face: 'Calibri Light', size: 12, colour: '#1f3763', before: 2, after: 0, line: 1.08 },
};

/** Line spacing choices offered on the Home tab (multiples of single). */
export const LINE_CHOICES = [1, 1.08, 1.15, 1.5, 2, 2.5, 3];

/** Margins in inches (Word's own unit for them is a twentieth of a point; inches keep the numbers readable). */
export interface Margins {
  t: number;
  b: number;
  l: number;
  r: number;
  /** From the paper's top edge to the header, and from its bottom edge to the footer. */
  header: number;
  footer: number;
}

/** Three parts of a header or footer line: left, centre, right. &P is the page number, &N the number of pages. */
export interface HeaderLine {
  l: string;
  c: string;
  r: string;
}

export interface PageSetup {
  paper: Paper;
  orient: 'portrait' | 'landscape';
  margins: Margins;
  header: HeaderLine;
  footer: HeaderLine;
}

/** Word's three common margins, in inches. */
export const MARGIN_PRESETS: Record<'normal' | 'narrow' | 'moderate' | 'wide', { label: string; m: Margins }> = {
  normal: { label: 'Normal (2.54 cm, 1 inch all round)', m: { t: 1, b: 1, l: 1, r: 1, header: 0.5, footer: 0.5 } },
  narrow: { label: 'Narrow (1.27 cm, half an inch)', m: { t: 0.5, b: 0.5, l: 0.5, r: 0.5, header: 0.5, footer: 0.5 } },
  moderate: { label: 'Moderate (top and bottom 1 inch, sides 0.75)', m: { t: 1, b: 1, l: 0.75, r: 0.75, header: 0.5, footer: 0.5 } },
  wide: { label: 'Wide (sides 2 inches)', m: { t: 1, b: 1, l: 2, r: 2, header: 0.5, footer: 0.5 } },
};

const EMPTY_LINE: HeaderLine = { l: '', c: '', r: '' };

/** A new document's page: Letter where people use it (the United States and Canada), A4 everywhere else. */
export function defaultPage(language = typeof navigator === 'undefined' ? 'en-GB' : navigator.language): PageSetup {
  const letter = /^(en|es|fr)-(us|ca|mx|ph)$/i.test(language) || /^en-us$/i.test(language);
  return { paper: letter ? 'letter' : 'a4', orient: 'portrait', margins: { ...MARGIN_PRESETS.normal.m }, header: { ...EMPTY_LINE }, footer: { ...EMPTY_LINE } };
}

/** The paper's size in points, turned for landscape. */
export function paperPt(page: PageSetup): { w: number; h: number } {
  const p = PAPERS[page.paper];
  return page.orient === 'landscape' ? { w: p.h, h: p.w } : { w: p.w, h: p.h };
}

/** Screen pixels at 100% (96 to the inch, as browsers count them). */
export const PX_PER_IN = 96;
export const PT_PER_IN = 72;
export const ptToPx = (pt: number): number => (pt * PX_PER_IN) / PT_PER_IN;
export const pxToPt = (px: number): number => (px * PT_PER_IN) / PX_PER_IN;

/** Where the writing goes on one page, in screen pixels at 100%. */
export interface PageBox {
  w: number;
  h: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
  /** Height of the writing area (paper less the top and bottom margins). */
  body: number;
}

export function pageBox(page: PageSetup): PageBox {
  const size = paperPt(page);
  const w = ptToPx(size.w);
  const h = ptToPx(size.h);
  const m = page.margins;
  const top = m.t * PX_PER_IN;
  const bottom = m.b * PX_PER_IN;
  return { w, h, top, bottom, left: m.l * PX_PER_IN, right: m.r * PX_PER_IN, body: h - top - bottom };
}

/** A header or footer part with its page number (&P) and number of pages (&N) filled in; && is one &. */
export function fillLine(text: string, page: number, pages: number): string {
  return text.replace(/&([PN&])/gi, (_, c: string) => (c === '&' ? '&' : c.toUpperCase() === 'P' ? String(page) : String(pages)));
}

export const lineEmpty = (line: HeaderLine): boolean => !line.l.trim() && !line.c.trim() && !line.r.trim();

/** A page setup read from anywhere (a file, a setting) with every value checked; anything wrong falls back to the default. */
export function cleanPage(raw: unknown, fallback: PageSetup = defaultPage()): PageSetup {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const paper = typeof o.paper === 'string' && o.paper in PAPERS ? (o.paper as Paper) : fallback.paper;
  const orient = o.orient === 'landscape' || o.orient === 'portrait' ? o.orient : fallback.orient;
  const mr = o.margins && typeof o.margins === 'object' ? (o.margins as Record<string, unknown>) : {};
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 10 ? v : d);
  const margins: Margins = {
    t: num(mr.t, fallback.margins.t), b: num(mr.b, fallback.margins.b), l: num(mr.l, fallback.margins.l), r: num(mr.r, fallback.margins.r),
    header: num(mr.header, fallback.margins.header), footer: num(mr.footer, fallback.margins.footer),
  };
  const line = (v: unknown, d: HeaderLine): HeaderLine => {
    const x = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
    const s = (t: unknown, dd: string) => (typeof t === 'string' ? t.slice(0, 200) : dd);
    return { l: s(x.l, d.l), c: s(x.c, d.c), r: s(x.r, d.r) };
  };
  return { paper, orient, margins, header: line(o.header, fallback.header), footer: line(o.footer, fallback.footer) };
}

/** What is wrong with these margins on this paper, or null: the writing area must keep at least an inch each way. */
export function marginProblem(page: PageSetup): string | null {
  const size = paperPt(page);
  const m = page.margins;
  if ((m.l + m.r) * PT_PER_IN > size.w - PT_PER_IN) return 'The left and right margins leave less than an inch for the writing. Make them smaller.';
  if ((m.t + m.b) * PT_PER_IN > size.h - PT_PER_IN) return 'The top and bottom margins leave less than an inch for the writing. Make them smaller.';
  return null;
}

/** An empty document: one empty Normal paragraph. */
export const EMPTY_DOC: NodeJSON = { type: 'doc', content: [{ type: 'paragraph' }] };

/** Every character of the document's text, paragraphs one to a line (for .txt and the word count). */
export function plainText(doc: NodeJSON): string {
  const lines: string[] = [];
  const walk = (n: NodeJSON, into: string[]): void => {
    if (n.type === 'paragraph') {
      lines.push(inlineText(n));
      return;
    }
    if (n.type === 'table') {
      for (const row of n.content ?? []) {
        const cells = (row.content ?? []).map(cell => (cell.content ?? []).map(p => (p.type === 'paragraph' ? inlineText(p) : '')).join(' '));
        lines.push(cells.join('\t'));
      }
      return;
    }
    for (const c of n.content ?? []) walk(c, into);
  };
  walk(doc, lines);
  return lines.join('\n');
}

function inlineText(p: NodeJSON): string {
  return (p.content ?? []).map(c => (c.type === 'text' ? c.text ?? '' : c.type === 'hard_break' ? '\n' : '')).join('');
}

/** How many words: runs of letters or digits between spaces, as Word counts them. */
export function countWords(text: string): number {
  return text.split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length;
}

/** A .txt file as a document: one paragraph a line (blank lines are empty paragraphs). */
export function docFromText(text: string): NodeJSON {
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  return {
    type: 'doc',
    content: lines.map(line => {
      const clean = line.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
      return clean ? { type: 'paragraph', content: [{ type: 'text', text: clean }] } : { type: 'paragraph' };
    }),
  };
}
