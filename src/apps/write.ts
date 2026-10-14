// TOMLIN Write: a document writer. A File menu and a ribbon laid out like a familiar word processor's (Home: undo,
// font, paragraph, styles; Insert: page break, table, picture; Layout: margins, orientation, paper size, header and
// footer; Table and Picture tabs when one is chosen; Help), the document on pages as it will print, and a status bar
// with the page, the word count and the zoom. Opens and saves Word documents (.docx) and plain text (.txt); prints and
// makes PDFs. The editor is ProseMirror (MIT), bundled as public/vendor/prosemirror.js by vendor-src/prosemirror and
// loaded only when a Write window opens. Pasted text keeps its basic formatting; nothing in it ever runs.
import { css, h, on, svg } from '../core/dom.ts';
import { formatSize } from '../core/format.ts';
import { inertMarkup } from '../core/inert.ts';
import { pictureTooBig } from '../core/imagesize.ts';
import { baseName, joinPath, parentPath, splitExtension, uniqueName } from '../fs/names.ts';
import type { MenuItem } from '../shell/menu.ts';
import { pickFile, pickSave } from '../shell/filepicker.ts';
import { saveOver } from '../shell/savefile.ts';
import type { AppDef, AppHandle } from '../shell/types.ts';
import { APPS } from './catalog.ts';
import { FONT_FACES, FONT_SIZES } from './sheet/fonts.ts';
import { DocxProblem, readDocx, writeDocx, type DocxSource } from './write/docx.ts';
import { findAll, findPlugin, replaceAll, type FindOptions, type Hit } from './write/find.ts';
import { markdownLoses, readMarkdown, writeMarkdown } from './write/markdown.ts';
import { OdtProblem, readOdt } from './write/odt.ts';
import { readRtf, RtfProblem } from './write/rtf.ts';
import { headerFooterDialog, marginsDialog, paragraphDialog, pictureSizeDialog, tableDialog } from './write/dialogs.ts';
import { addPicture, picture } from './write/images.ts';
import { drawFurniture, measure, pageOfCursor, sameSpacers, spacerDecorations } from './write/measure.ts';
import {
  countWords, defaultPage, docFromText, EMPTY_DOC, LINE_CHOICES, MARGIN_PRESETS, pageBox, PAPERS, plainText, STYLE_IDS, STYLES,
  type NodeJSON, type PageSetup, type Paper, type StyleId,
} from './write/model.ts';
import { printPreview, snapshot } from './write/print.ts';
import { buildSchema, pastedHtml, type PM } from './write/schema.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Documents bigger than this are not opened (a .docx is packed: this is its size on disk). */
const MAX_FILE_BYTES = 50 * 1024 * 1024;
/** A picture bigger than this is refused when inserted (Word documents with many photos get large quickly). */
const MAX_PICTURE_BYTES = 15 * 1024 * 1024;
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2];

const PALETTE: Array<[string, string]> = [
  ['Black', '#000000'], ['Dark grey', '#404040'], ['Grey', '#7f7f7f'], ['Light grey', '#bfbfbf'], ['White', '#ffffff'],
  ['Dark red', '#c00000'], ['Red', '#ff0000'], ['Orange', '#ffc000'], ['Yellow', '#ffff00'], ['Light green', '#92d050'],
  ['Green', '#00b050'], ['Light blue', '#00b0f0'], ['Blue', '#0070c0'], ['Dark blue', '#002060'], ['Purple', '#7030a0'],
];
/** Word's highlighter colours. */
const HIGHLIGHTS: Array<[string, string]> = [
  ['Yellow', '#ffff00'], ['Bright green', '#00ff00'], ['Turquoise', '#00ffff'], ['Pink', '#ff00ff'], ['Blue', '#0000ff'],
  ['Red', '#ff0000'], ['Dark blue', '#000080'], ['Teal', '#008080'], ['Green', '#008000'], ['Violet', '#800080'],
  ['Dark red', '#800000'], ['Dark yellow', '#808000'], ['Grey', '#808080'], ['Light grey', '#c0c0c0'], ['Black', '#000000'],
];
const SHADES: Array<[string, string]> = [
  ['Light grey', '#d9d9d9'], ['Grey', '#bfbfbf'], ['Pale blue', '#deeaf6'], ['Blue', '#bdd6ee'], ['Pale green', '#e2efda'],
  ['Green', '#c5e0b3'], ['Pale yellow', '#fff2cc'], ['Gold', '#ffe599'], ['Pale orange', '#fbe4d5'], ['Pale red', '#f4cccc'],
];

let loading: Promise<PM> | null = null;
/** The ProseMirror bundle, loaded once for every Write window. */
function loadProseMirror(): Promise<PM> {
  loading ??= import(new URL('../../vendor/prosemirror.js', import.meta.url).href) as Promise<PM>;
  return loading;
}

class Problem extends Error {}

/** Four short lines, aligned like the paragraph alignment buttons draw them. */
function alignIcon(kind: 'left' | 'center' | 'right' | 'justify'): SVGElement {
  const rows: Array<[number, number]> = kind === 'justify' ? [[2, 16], [2, 16], [2, 16], [2, 10]] : [[2, 16], [2, 11], [2, 16], [2, 9]];
  const s = svg('svg', { viewBox: '0 0 18 16', width: 18, height: 16, 'aria-hidden': 'true' });
  rows.forEach(([x0, x1], i) => {
    const len = x1 - x0;
    const x = kind === 'center' ? (18 - len) / 2 : kind === 'right' ? 16 - len : x0;
    s.append(svg('path', { d: `M${x} ${2.5 + i * 3.7}h${len}`, stroke: 'currentColor', 'stroke-width': 1.6 }));
  });
  return s;
}

/** A small picture for the list and indent buttons. */
function listIcon(kind: 'bullet' | 'number' | 'indent' | 'outdent'): SVGElement {
  const s = svg('svg', { viewBox: '0 0 18 16', width: 18, height: 16, 'aria-hidden': 'true' });
  for (let i = 0; i < 3; i++) s.append(svg('path', { d: `M${kind === 'indent' || kind === 'outdent' ? 8 : 7} ${3 + i * 5}h10`, stroke: 'currentColor', 'stroke-width': 1.6 }));
  if (kind === 'bullet') for (let i = 0; i < 3; i++) s.append(svg('circle', { cx: 3, cy: 3 + i * 5, r: 1.5, fill: 'currentColor' }));
  if (kind === 'number') {
    for (let i = 0; i < 3; i++) {
      const t = svg('text', { x: 1, y: 5.5 + i * 5, 'font-size': 6, fill: 'currentColor' });
      t.textContent = String(i + 1);
      s.append(t);
    }
  }
  if (kind === 'indent') s.append(svg('path', { d: 'M1 5l4 3-4 3z', fill: 'currentColor' }));
  if (kind === 'outdent') s.append(svg('path', { d: 'M5 5l-4 3 4 3z', fill: 'currentColor' }));
  return s;
}

export const writeApp: AppDef = {
  ...APPS.write,
  async launch(app, arg) {
    app.root.classList.add('write');
    app.root.append(h('p', { class: 'app-message' }, 'Loading the writer...'));
    let pm: PM;
    try {
      pm = await loadProseMirror();
    } catch (error) {
      loading = null;
      app.root.replaceChildren(h('p', { class: 'app-message', role: 'alert' }, 'The writer could not be loaded. Check the connection to the server, then open TOMLIN Write again.'));
      console.error(error);
      return;
    }
    if (app.signal.aborted) return;
    app.root.replaceChildren();
    await run(app, pm, arg);
  },
};

async function run(app: AppHandle, pm: PM, arg: string | undefined): Promise<void> {
  const shell = app.shell;
  // Pasted HTML is read through the desktop's one Trusted Types policy (it allows no other).
  pm.setClipboardHtml(inertMarkup);
  const schema = buildSchema(pm);
  const nodes = schema.nodes;
  const marks = schema.marks;

  // ---- The file ----------------------------------------------------------------------------------------------------

  let page: PageSetup = defaultPage();
  let path: string | null = null;
  let loadedId = '';
  let label = 'Document';
  let kind: 'docx' | 'txt' | 'md' = 'docx';
  /** What opening a file left out: saving over it asks first while this is set. */
  let lost: string[] = [];
  /** What a Word file has that Write keeps as grey labels (written back unchanged). */
  let keptParts: string[] = [];
  /** A Word file as opened: saving it keeps its other parts (theme, comments, footnotes, text boxes...). */
  let source: DocxSource | undefined;
  /** Where a WordPad or LibreOffice file came from: its Word copy is saved there. */
  let folderHint: string | null = null;
  let startDoc: NodeJSON = EMPTY_DOC;

  if (arg) {
    try {
      const entry = await shell.fs.stat(arg);
      if (!entry || entry.kind !== 'file') throw new Problem('That file is not there any more. It may have been moved or deleted.');
      if (entry.size > MAX_FILE_BYTES) throw new Problem(`This file is ${formatSize(entry.size)}. Write opens documents up to ${formatSize(MAX_FILE_BYTES)}.`);
      const bytes = await shell.fs.readFile(arg);
      const name = baseName(arg);
      const ext = splitExtension(name)[1].toLowerCase();
      // WordPad (.rtf) and LibreOffice (.odt) files are read here and saved as Word documents beside them.
      let readOnly = false;
      if (ext === '.docx') {
        const read = await readDocx(bytes);
        startDoc = read.doc;
        page = read.page;
        lost = read.dropped;
        keptParts = read.kept;
        source = read.source;
      } else if (ext === '.rtf') {
        const read = readRtf(bytes);
        startDoc = read.doc;
        lost = read.dropped;
        readOnly = true;
      } else if (ext === '.odt') {
        const read = await readOdt(bytes);
        startDoc = read.doc;
        page = read.page;
        lost = read.dropped;
        readOnly = true;
      } else if (ext === '.md' || ext === '.markdown') {
        startDoc = readMarkdown(new TextDecoder('utf-8').decode(bytes));
        kind = 'md';
      } else if (ext === '.txt' || ext === '.text' || ext === '') {
        startDoc = docFromText(new TextDecoder('utf-8').decode(bytes));
        kind = 'txt';
      } else if (ext === '.doc') {
        throw new Problem('This is an older Word file (.doc), which Write cannot open. In Word, use File > Save As > Word Document (.docx), and open that file.');
      } else {
        throw new Problem('Write opens Word documents (.docx), WordPad files (.rtf), LibreOffice files (.odt), Markdown (.md) and plain text (.txt). This file is none of those.');
      }
      label = name;
      if (readOnly) folderHint = parentPath(arg);
      else {
        path = arg;
        loadedId = entry.id;
      }
    } catch (error) {
      const known = error instanceof Problem || error instanceof DocxProblem || error instanceof RtfProblem || error instanceof OdtProblem;
      const why = known ? (error as Error).message : 'This file could not be opened.';
      if (!known) await shell.report('Could not open the document', error);
      app.root.append(h('div', { class: 'app-message', role: 'alert' }, h('p', {}, why), h('p', { class: 'dialog-detail' }, 'The file was not changed.')));
      app.setTitle(baseName(arg));
      return;
    }
  }

  let doc: any;
  try {
    doc = schema.nodeFromJSON(startDoc);
    doc.check();
  } catch {
    // A shape the editor does not take (a damaged file): its text, so nothing is lost from view.
    doc = schema.nodeFromJSON(docFromText(plainText(startDoc)));
    lost.push('some of its layout (the text is all there)');
  }

  // ---- The editor ----------------------------------------------------------------------------------------------------

  const pagesKey = new pm.PluginKey('wp-pages');
  const pagesPlugin = new pm.Plugin({
    key: pagesKey,
    state: {
      init: () => pm.DecorationSet.empty,
      apply: (tr: any, set: any) => tr.getMeta(pagesKey) ?? set.map(tr.mapping, tr.doc),
    },
    props: { decorations: (state: any) => pagesKey.getState(state) },
  });

  const listCmd = (type: any) => (state: any, dispatch: any) => toggleList(type)(state, dispatch);
  const keys = pm.keymap({
    'Mod-z': pm.undo,
    'Mod-y': pm.redo,
    'Shift-Mod-z': pm.redo,
    'Mod-b': pm.toggleMark(marks.strong),
    'Mod-i': pm.toggleMark(marks.em),
    'Mod-u': pm.toggleMark(marks.underline),
    'Mod-=': pm.toggleMark(marks.vert, { pos: 'sub' }),
    'Mod-Shift-=': pm.toggleMark(marks.vert, { pos: 'super' }),
    'Mod-Shift-+': pm.toggleMark(marks.vert, { pos: 'super' }),
    'Mod-e': (s: any, d: any) => paraCmd({ align: 'center' })(s, d),
    'Mod-l': (s: any, d: any) => paraCmd({ align: null })(s, d),
    'Mod-r': (s: any, d: any) => paraCmd({ align: 'right' })(s, d),
    'Mod-j': (s: any, d: any) => paraCmd({ align: 'justify' })(s, d),
    'Mod-1': (s: any, d: any) => paraCmd({ line: 1 })(s, d),
    'Mod-2': (s: any, d: any) => paraCmd({ line: 2 })(s, d),
    'Mod-5': (s: any, d: any) => paraCmd({ line: 1.5 })(s, d),
    'Mod-Alt-1': (s: any, d: any) => styleCmd('h1')(s, d),
    'Mod-Alt-2': (s: any, d: any) => styleCmd('h2')(s, d),
    'Mod-Alt-3': (s: any, d: any) => styleCmd('h3')(s, d),
    'Mod-Shift-n': (s: any, d: any) => styleCmd('normal')(s, d),
    'Mod-Shift-l': listCmd(nodes.bullet_list),
    'Mod-Enter': (s: any, d: any) => insertPageBreak(s, d),
    'Shift-Enter': pm.chainCommands(pm.exitCode, (state: any, dispatch: any) => {
      if (dispatch) dispatch(state.tr.replaceSelectionWith(nodes.hard_break.create()).scrollIntoView());
      return true;
    }),
    Enter: pm.splitListItem(nodes.list_item),
    Tab: pm.chainCommands(pm.goToNextCell(1), pm.sinkListItem(nodes.list_item), (state: any, dispatch: any) => {
      if (dispatch) dispatch(state.tr.insertText('\t').scrollIntoView());
      return true;
    }),
    'Shift-Tab': pm.chainCommands(pm.goToNextCell(-1), pm.liftListItem(nodes.list_item)),
    'Mod-Shift->': () => (growFont(1), true),
    'Mod-Shift-<': () => (growFont(-1), true),
    'Mod-]': () => (growFont(1), true),
    'Mod-[': () => (growFont(-1), true),
    'Mod-Space': () => (clearFormatting(), true),
  });
  const rules = pm.inputRules({
    rules: [
      pm.wrappingInputRule(/^\s*([-*•])\s$/, nodes.bullet_list),
      pm.wrappingInputRule(/^(\d+)[.)]\s$/, nodes.ordered_list, (m: string[]) => ({ order: Number(m[1]) }), (m: string[], n: any) => n.childCount + n.attrs.order === Number(m[1])),
    ],
  });

  // Tables: the column widths can be dragged; the table shows its own lines, or faint ones that do not print.
  const BaseTable = pm.TableView;
  class TableView extends BaseTable {
    constructor(node: any, cellMinWidth: number) {
      super(node, cellMinWidth);
      this.mark(node);
    }
    update(node: any): boolean {
      const ok = super.update(node);
      if (ok) this.mark(node);
      return ok;
    }
    mark(node: any): void {
      this.table.classList.add('wp-table');
      this.table.classList.toggle('wp-noborders', !node.attrs.borders);
    }
  }

  /** A picture in the text: chosen, it shows a handle at its corner to drag it bigger or smaller (keeping its shape). */
  class PictureView {
    dom: HTMLElement;
    img: HTMLImageElement;
    node: any;
    constructor(node: any, view: any, getPos: () => number | undefined) {
      this.node = node;
      this.img = h('img', { class: 'wp-img', alt: node.attrs.alt, 'data-img': node.attrs.src, draggable: 'true' });
      this.show(node);
      const handle = h('span', { class: 'wp-pic-handle', 'aria-hidden': 'true' });
      this.dom = h('span', { class: 'wp-pic' }, this.img, handle);
      on(handle, 'pointerdown', (event: PointerEvent) => {
        event.preventDefault();
        event.stopPropagation();
        const startX = event.clientX;
        const pic = picture(this.node.attrs.src);
        const startW = this.img.getBoundingClientRect().width / zoomFactor();
        const ratio = pic ? pic.h / pic.w : this.img.naturalHeight / Math.max(1, this.img.naturalWidth);
        const most = bodyWidth();
        let w = startW;
        handle.setPointerCapture(event.pointerId);
        const moves = new AbortController();
        on(handle, 'pointermove', (e: PointerEvent) => {
          w = Math.max(16, Math.min(most, startW + (e.clientX - startX) / zoomFactor()));
          this.img.width = Math.round(w);
          this.img.height = Math.round(w * ratio);
        }, moves.signal);
        on(handle, 'pointerup', () => {
          moves.abort();
          const pos = getPos();
          if (pos === undefined) return;
          view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, width: Math.round(w), height: Math.round(w * ratio) }));
        }, moves.signal);
      }, app.signal);
    }
    show(node: any): void {
      const pic = picture(node.attrs.src);
      if (pic) this.img.src = pic.url;
      this.img.alt = node.attrs.alt;
      this.img.setAttribute('data-img', node.attrs.src);
      const w = node.attrs.width ?? Math.min(pic?.w ?? 100, bodyWidth());
      const ratio = pic ? pic.h / pic.w : 1;
      this.img.width = Math.round(w);
      this.img.height = Math.round(node.attrs.height ?? w * ratio);
    }
    update(node: any): boolean {
      if (node.type !== this.node.type) return false;
      this.node = node;
      this.show(node);
      return true;
    }
    selectNode(): void {
      this.dom.classList.add('wp-pic-on');
    }
    deselectNode(): void {
      this.dom.classList.remove('wp-pic-on');
    }
    stopEvent(event: Event): boolean {
      return (event.target as Element)?.classList?.contains('wp-pic-handle') ?? false;
    }
    ignoreMutation(): boolean {
      return true;
    }
  }

  // The editor learns where the cursor is when the browser reports a change, which can come after a key pressed straight
  // after a click: the cursor is read from the page first, so Ctrl+Enter (or a ribbon button) acts where the cursor is.
  const syncCursor = (v: any): void => {
    try {
      v.domObserver?.flush();
    } catch {
      // The editor reads it a moment later anyway.
    }
  };
  const cursorFirst = new pm.Plugin({ props: { handleKeyDown: (v: any) => (syncCursor(v), false) } });
  const finder = findPlugin(pm);
  const state = pm.EditorState.create({
    doc,
    plugins: [
      cursorFirst,
      rules,
      keys,
      pm.keymap(pm.baseKeymap),
      pm.history(),
      pm.dropCursor({ color: '#2b579a' }),
      pm.gapCursor(),
      pm.columnResizing({ View: TableView, cellMinWidth: 30 }),
      pm.tableEditing(),
      pagesPlugin,
      finder.plugin,
    ],
  });
  let savedDoc = state.doc;
  let savedPage = JSON.stringify(page);

  const mount = h('div', { class: 'wp-doc-host' });
  const furniture = h('div', { class: 'wp-furniture', 'aria-hidden': 'true' });
  const paper = h('div', { class: 'wp-paper' }, mount, furniture);
  const desk = h('div', { class: 'wp-desk' }, paper);
  const scroller = h('div', { class: 'wp-scroll' }, desk);

  let zoom = 1;
  const zoomFactor = () => zoom;
  const box = () => pageBox(page);
  const bodyWidth = () => box().w - box().left - box().right;

  const view = new pm.EditorView(mount, {
    state,
    attributes: { class: 'wp-doc', spellcheck: 'true', role: 'textbox', 'aria-multiline': 'true', 'aria-label': 'Document' },
    nodeViews: { image: (node: any, v: any, getPos: () => number | undefined) => new PictureView(node, v, getPos) },
    // Pasted HTML is read from a copy that never runs or loads anything; style blocks and comments are dropped first.
    transformPastedHTML: pastedHtml,
    handlePaste: (_v: any, event: ClipboardEvent) => {
      const files = [...(event.clipboardData?.files ?? [])].filter(f => /^image\/(png|jpeg|gif)$/.test(f.type));
      if (!files.length || event.clipboardData?.getData('text/html')) return false;
      void insertPictureFiles(files);
      return true;
    },
    handleDrop: (_v: any, event: DragEvent) => {
      const files = [...(event.dataTransfer?.files ?? [])].filter(f => /^image\/(png|jpeg|gif)$/.test(f.type));
      if (!files.length) return false;
      event.preventDefault();
      const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
      if (hit) view.dispatch(view.state.tr.setSelection(pm.TextSelection.create(view.state.doc, hit.pos)));
      void insertPictureFiles(files);
      return true;
    },
    dispatchTransaction(tr: any) {
      const next = view.state.apply(tr);
      view.updateState(next);
      if (tr.docChanged) {
        scheduleLayout();
        refresh();
      }
      syncToolbar();
    },
  });
  const dom: HTMLElement = view.dom;

  // ---- Pages ---------------------------------------------------------------------------------------------------------

  let pageCount = 1;
  let layoutFrame = 0;
  function scheduleLayout(): void {
    if (layoutFrame) return;
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = 0;
      layout(0);
    });
  }
  function layout(round: number): void {
    if (app.signal.aborted || !paper.isConnected) return;
    const b = box();
    css(paper, { zoom: String(zoom) });
    css(dom, { 'padding-top': `${b.top}px`, 'padding-left': `${b.left}px`, 'padding-right': `${b.right}px`, 'padding-bottom': `${b.bottom}px`, width: `${b.w}px` });
    const laid = measure(view, paper, b);
    pageCount = laid.pages.count;
    drawFurniture(furniture, paper, page, b, pageCount);
    css(dom, { 'min-height': `${pageCount * b.h + (pageCount - 1) * 24}px` });
    const current = (pagesKey.getState(view.state).find() as any[]).map(d => ({ pos: d.from, height: d.spec.height ?? 0 }));
    const decorations = spacerDecorations(pm, view.state.doc, laid.spacers);
    if (!sameSpacers(laid.spacers, current) || !sameSpacers(laid.spacers, decorations.find().map((d: any) => ({ pos: d.from, height: d.spec.height ?? 0 })))) {
      view.dispatch(view.state.tr.setMeta(pagesKey, decorations).setMeta('addToHistory', false));
      // The spaces moved the lines below them: measure once more to be sure (it settles in one or two rounds).
      if (round < 4) requestAnimationFrame(() => layout(round + 1));
    }
    syncStatus();
  }

  // ---- Commands --------------------------------------------------------------------------------------------------------

  /** The paragraphs the selection touches, with their positions. */
  const selectedParagraphs = (st: any): Array<{ node: any; pos: number }> => {
    const out: Array<{ node: any; pos: number }> = [];
    const { from, to } = st.selection;
    st.doc.nodesBetween(from, to, (node: any, pos: number) => {
      if (node.type === nodes.paragraph) out.push({ node, pos });
      return true;
    });
    if (!out.length) {
      const $f = st.selection.$from;
      for (let d = $f.depth; d > 0; d--) if ($f.node(d).type === nodes.paragraph) out.push({ node: $f.node(d), pos: $f.before(d) });
    }
    return out;
  };
  const paraCmd = (patch: Record<string, unknown>) => (st: any, dispatch?: any): boolean => {
    const paras = selectedParagraphs(st);
    if (!paras.length) return false;
    if (dispatch) {
      const tr = st.tr;
      for (const p of paras) tr.setNodeMarkup(p.pos, undefined, { ...p.node.attrs, ...patch });
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
  const styleCmd = (style: StyleId) => paraCmd({ style });
  const exec = (cmd: (s: any, d?: any) => boolean) => {
    cmd(view.state, view.dispatch);
    view.focus();
  };

  /** Lists: the same kind again takes the paragraphs out of the list; the other kind changes it. */
  const toggleList = (type: any) => (st: any, dispatch?: any): boolean => {
    const $f = st.selection.$from;
    for (let d = $f.depth; d > 0; d--) {
      const n = $f.node(d);
      if (n.type === nodes.bullet_list || n.type === nodes.ordered_list) {
        if (n.type === type) return pm.liftListItem(nodes.list_item)(st, dispatch);
        if (dispatch) dispatch(st.tr.setNodeMarkup($f.before(d), type, type === nodes.ordered_list ? { order: 1 } : null));
        return true;
      }
    }
    return pm.wrapInList(type, type === nodes.ordered_list ? { order: 1 } : null)(st, dispatch);
  };

  function insertPageBreak(st: any, dispatch?: any): boolean {
    if (pm.isInTable(st)) return false;
    if (dispatch) {
      const tr = st.tr;
      const $f = st.selection.$from;
      // At the top level (or in a list, after it): split the paragraph, then put the break between the halves.
      if ($f.parent.isTextblock && $f.depth === 1) {
        tr.split(tr.mapping.map(st.selection.from));
        const at = tr.mapping.map(st.selection.from);
        tr.insert(tr.doc.resolve(at).before(), nodes.page_break.create());
      } else {
        let d = $f.depth;
        while (d > 1) d--;
        const after = $f.after(d);
        tr.insert(after, [nodes.page_break.create(), nodes.paragraph.create()]);
        tr.setSelection(pm.TextSelection.create(tr.doc, after + 2));
      }
      dispatch(tr.scrollIntoView());
    }
    return true;
  }

  /** The marks at the cursor (or across the selection's start), to show on the toolbar. */
  const marksHere = (): any[] => {
    const st = view.state;
    return st.storedMarks ?? (st.selection.empty ? st.selection.$from.marks() : st.selection.$from.marksAcross?.(st.selection.$to) ?? st.selection.$from.marks()) ?? [];
  };
  const hasMark = (type: any): boolean => {
    const st = view.state;
    const { from, to, empty } = st.selection;
    if (empty) return !!type.isInSet(marksHere());
    return st.doc.rangeHasMark(from, to, type);
  };
  const markAttr = (type: any, attr: string): unknown => {
    const st = view.state;
    const { from, to, empty } = st.selection;
    if (empty) return type.isInSet(marksHere())?.attrs[attr];
    let found: unknown;
    st.doc.nodesBetween(from, to, (n: any) => {
      if (found === undefined && n.isText) found = type.isInSet(n.marks)?.attrs[attr];
      return found === undefined;
    });
    return found;
  };
  /** Sets a mark with these values on the selection (or for what is typed next); null takes it off. */
  const setMark = (type: any, attrs: Record<string, unknown> | null) => {
    const st = view.state;
    const { from, to, empty } = st.selection;
    const tr = st.tr;
    if (empty) {
      const rest = marksHere().filter((m: any) => m.type !== type);
      tr.setStoredMarks(attrs ? [...rest, type.create(attrs)] : rest);
    } else {
      tr.removeMark(from, to, type);
      if (attrs) tr.addMark(from, to, type.create(attrs));
    }
    view.dispatch(tr);
    view.focus();
  };
  /** The style's own size, or the size mark's, at the cursor. */
  const sizeHere = (): number => {
    const pt = markAttr(marks.size, 'pt');
    if (typeof pt === 'number') return pt;
    const p = selectedParagraphs(view.state)[0];
    return STYLES[(p?.node.attrs.style ?? 'normal') as StyleId].size;
  };
  function growFont(step: 1 | -1): void {
    const now = sizeHere();
    const next = step > 0 ? FONT_SIZES.find(s => s > now) ?? Math.min(400, now + 12) : [...FONT_SIZES].reverse().find(s => s < now) ?? Math.max(1, now - 1);
    setMark(marks.size, { pt: next });
  }
  function clearFormatting(): void {
    const st = view.state;
    const { from, to } = st.selection;
    const tr = st.tr;
    for (const t of Object.values(marks)) tr.removeMark(from, to, t);
    tr.setStoredMarks([]);
    for (const p of selectedParagraphs(st)) tr.setNodeMarkup(p.pos, undefined, { style: p.node.attrs.style, align: null, before: null, after: null, line: null, indent: null, first: null });
    view.dispatch(tr);
    view.focus();
  }
  const indentBy = (step: 1 | -1) => {
    const st = view.state;
    if (step > 0 ? pm.sinkListItem(nodes.list_item)(st, view.dispatch) : pm.liftListItem(nodes.list_item)(st, view.dispatch)) {
      view.focus();
      return;
    }
    const paras = selectedParagraphs(st);
    const tr = st.tr;
    for (const p of paras) {
      const next = Math.max(0, Math.round(((p.node.attrs.indent ?? 0) + step * 36) * 10) / 10);
      tr.setNodeMarkup(p.pos, undefined, { ...p.node.attrs, indent: next || null });
    }
    view.dispatch(tr);
    view.focus();
  };

  // Tables.
  const tableHere = (): { node: any; pos: number } | null => {
    const $f = view.state.selection.$from;
    for (let d = $f.depth; d > 0; d--) if ($f.node(d).type === nodes.table) return { node: $f.node(d), pos: $f.before(d) };
    return null;
  };
  async function insertTable(): Promise<void> {
    const size = await tableDialog(shell);
    if (!size) {
      view.focus();
      return;
    }
    const w = Math.floor(bodyWidth() / size.cols);
    const row = () => nodes.table_row.create(null, Array.from({ length: size.cols }, () => nodes.table_cell.create({ colwidth: [w] }, nodes.paragraph.create())));
    const table = nodes.table.create({ borders: true }, Array.from({ length: size.rows }, row));
    const st = view.state;
    const tr = st.tr.replaceSelectionWith(table);
    // The cursor goes into the first cell; a paragraph after the table lets typing carry on below it.
    const after = tr.mapping.map(st.selection.from);
    const $after = tr.doc.resolve(Math.min(after, tr.doc.content.size));
    if (!$after.nodeAfter) tr.insert(tr.doc.content.size, nodes.paragraph.create());
    const start = tr.doc.resolve(Math.max(0, Math.min(tr.doc.content.size, st.selection.from)));
    tr.setSelection(pm.TextSelection.near(start));
    view.dispatch(tr.scrollIntoView());
    view.focus();
  }
  const tableCmd = (cmd: any) => () => exec(cmd);
  const setTableAttr = (patch: Record<string, unknown>) => {
    const t = tableHere();
    if (!t) return;
    view.dispatch(view.state.tr.setNodeMarkup(t.pos, undefined, { ...t.node.attrs, ...patch }));
    view.focus();
  };
  /** Every column the same width, the table as wide as the writing. */
  const evenColumns = () => {
    const t = tableHere();
    if (!t) return;
    const map = pm.TableMap.get(t.node);
    const w = Math.floor(bodyWidth() / map.width);
    const tr = view.state.tr;
    t.node.descendants((cell: any, pos: number) => {
      if (cell.type !== nodes.table_cell && cell.type !== nodes.table_header) return true;
      tr.setNodeMarkup(t.pos + 1 + pos, undefined, { ...cell.attrs, colwidth: Array(cell.attrs.colspan).fill(w) });
      return false;
    });
    view.dispatch(tr);
    view.focus();
  };

  // Pictures.
  const pictureHere = (): { node: any; pos: number } | null => {
    const sel = view.state.selection;
    return sel instanceof pm.NodeSelection && sel.node.type === nodes.image ? { node: sel.node, pos: sel.from } : null;
  };
  function insertPictureId(id: string, alt = ''): void {
    const pic = picture(id)!;
    const most = bodyWidth();
    const w = Math.min(pic.w, most);
    const node = nodes.image.create({ src: id, width: Math.round(w), height: Math.round((w * pic.h) / pic.w), alt });
    const tr = view.state.tr.replaceSelectionWith(node);
    view.dispatch(tr.scrollIntoView());
    view.focus();
  }
  /** The bytes of a picture, checked: a PNG, JPEG or GIF, not too big; other kinds become PNG through a canvas. */
  async function pictureBytes(bytes: Uint8Array, name: string): Promise<string | null> {
    if (bytes.length > MAX_PICTURE_BYTES) {
      await shell.dialogs.alert('That picture is too big', `“${name}” is ${formatSize(bytes.length)}. Pictures up to ${formatSize(MAX_PICTURE_BYTES)} can go in a document. Make it smaller in Photo Editor (Image > Scale) first.`);
      return null;
    }
    const tooBig = pictureTooBig(bytes);
    if (tooBig) {
      await shell.dialogs.alert('That picture cannot go in', tooBig);
      return null;
    }
    let id = addPicture(bytes);
    if (!id) {
      // WebP, BMP and the like: Word documents hold PNG, JPEG and GIF, so it goes in as a PNG.
      try {
        const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]));
        const canvas = h('canvas', { width: bitmap.width, height: bitmap.height });
        canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
        bitmap.close();
        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
        if (blob) id = addPicture(new Uint8Array(await blob.arrayBuffer()));
      } catch {
        // Said below.
      }
    }
    if (!id) await shell.dialogs.alert('That is not a picture Write can use', `“${name}” could not be read as a picture. Pictures in PNG, JPEG, GIF, WebP or BMP can go in a document.`);
    return id;
  }
  async function insertPictureFiles(files: File[]): Promise<void> {
    for (const file of files.slice(0, 20)) {
      const id = await pictureBytes(new Uint8Array(await file.arrayBuffer()), file.name);
      if (id) insertPictureId(id);
    }
  }
  async function pictureFromDesktop(): Promise<void> {
    const chosen = await pickFile(shell, { title: 'Insert a picture', folder: '/Pictures', accept: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'], ok: 'Insert' });
    if (!chosen) {
      view.focus();
      return;
    }
    try {
      const id = await pictureBytes(await shell.fs.readFile(chosen), baseName(chosen));
      if (id) insertPictureId(id);
    } catch (error) {
      await shell.report('Could not insert the picture', error);
    }
  }
  function pictureFromComputer(): void {
    const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp,image/bmp', multiple: true, class: 'visually-hidden', tabindex: -1, 'aria-hidden': 'true' });
    const done = new AbortController();
    on(input, 'change', () => {
      const files = [...(input.files ?? [])];
      done.abort();
      input.remove();
      void insertPictureFiles(files);
    }, done.signal);
    on(input, 'cancel', () => {
      done.abort();
      input.remove();
    }, done.signal);
    document.body.append(input);
    input.click();
  }
  async function pictureSize(): Promise<void> {
    const p = pictureHere();
    if (!p) return;
    const pic = picture(p.node.attrs.src);
    if (!pic) return;
    const w = p.node.attrs.width ?? Math.min(pic.w, bodyWidth());
    const got = await pictureSizeDialog(shell, page, { w, h: p.node.attrs.height ?? (w * pic.h) / pic.w }, { w: pic.w, h: pic.h }, bodyWidth());
    if (got) view.dispatch(view.state.tr.setNodeMarkup(p.pos, undefined, { ...p.node.attrs, width: got.w, height: got.h }));
    view.focus();
  }
  const pictureFit = (natural: boolean) => {
    const p = pictureHere();
    const pic = p && picture(p.node.attrs.src);
    if (!p || !pic) return;
    const w = natural ? Math.min(pic.w, bodyWidth()) : bodyWidth();
    view.dispatch(view.state.tr.setNodeMarkup(p.pos, undefined, { ...p.node.attrs, width: Math.round(w), height: Math.round((w * pic.h) / pic.w) }));
    view.focus();
  };
  async function pictureAlt(): Promise<void> {
    const p = pictureHere();
    if (!p) return;
    const alt = await shell.dialogs.prompt({ title: 'Describe the picture', label: 'For people who use a screen reader, and when the picture cannot be shown.', value: p.node.attrs.alt, ok: 'Save' });
    if (alt !== null) view.dispatch(view.state.tr.setNodeMarkup(p.pos, undefined, { ...p.node.attrs, alt: alt.slice(0, 300) }));
    view.focus();
  }

  // ---- Page setup --------------------------------------------------------------------------------------------------

  const setPage = (next: PageSetup) => {
    page = next;
    refresh();
    scheduleLayout();
    syncToolbar();
  };

  // ---- Saving and opening ----------------------------------------------------------------------------------------------

  const baseLabel = () => label.replace(/\.(docx|txt|md|markdown|rtf|odt)$/i, '') || 'Document';
  const fileBytes = async (as: 'docx' | 'txt' | 'md'): Promise<Uint8Array> =>
    as === 'txt' ? new TextEncoder().encode(plainText(view.state.doc.toJSON()).replace(/\n/g, '\r\n'))
      : as === 'md' ? new TextEncoder().encode(writeMarkdown(view.state.doc.toJSON()))
        : writeDocx(view.state.doc.toJSON(), page, baseLabel(), source);
  /** Asks before a save to .txt or .md that leaves things out; false when the person says no. */
  const okToSaveAs = async (as: 'docx' | 'txt' | 'md', name: string): Promise<boolean> => {
    if (as === 'txt' && textLosesSomething()) {
      return shell.dialogs.confirm({ title: 'Save as plain text?', text: `“${name}” is plain text, which keeps only the words: the formatting, tables and pictures are left out. Save as a Word document (.docx) instead to keep them.`, ok: 'Save the words only', cancel: 'Cancel' });
    }
    if (as === 'md') {
      const loses = markdownLoses(view.state.doc.toJSON());
      if (loses.length) return shell.dialogs.confirm({ title: 'Save as Markdown?', text: `Markdown keeps headings, bold, italic, lists and tables. These are left out of “${name}”: ${loses.join('; ')}. Save as a Word document (.docx) to keep them.`, ok: 'Save as Markdown', cancel: 'Cancel' });
    }
    return true;
  };
  const isDirty = () => !view.state.doc.eq(savedDoc) || JSON.stringify(page) !== savedPage;
  function refresh(): void {
    app.setDirty(isDirty());
    app.setTitle(label);
  }

  /** A document with tables, pictures or formatting saved as .txt keeps only its words: asked once each time. */
  const textLosesSomething = (): boolean => {
    let rich = false;
    view.state.doc.descendants((n: any) => {
      if (rich) return false;
      if (n.isText && n.marks.length) rich = true;
      else if (n.type === nodes.table || n.type === nodes.image || n.type === nodes.bullet_list || n.type === nodes.ordered_list) rich = true;
      else if (n.type === nodes.paragraph && n.attrs.style !== 'normal') rich = true;
      return !rich;
    });
    return rich;
  };

  async function save(): Promise<boolean> {
    if (!path) return saveAs();
    if (lost.length && kind === 'docx') {
      const answer = await shell.dialogs.ask<'copy' | 'over' | null>({
        title: `Save over “${label}”?`,
        text: `When it was opened, Write could not show some parts of this Word file (${lost.slice(0, 3).join('; ')}${lost.length > 3 ? '; and more' : ''}). Saving over the file takes them out of it for good.`,
        buttons: [{ label: 'Save a copy', value: 'copy', primary: true }, { label: 'Save over it', value: 'over', danger: true }, { label: 'Cancel', value: null }],
        cancel: null,
      });
      if (answer === null) return false;
      if (answer === 'copy') return saveAs();
    }
    if (!(await okToSaveAs(kind, label))) return false;
    try {
      const docNow = view.state.doc;
      const pageNow = JSON.stringify(page);
      const entry = await saveOver(shell, path, await fileBytes(kind), loadedId);
      if (!entry) return false;
      loadedId = entry.id;
      savedDoc = docNow;
      savedPage = pageNow;
      lost = [];
      refresh();
      shell.toast(`Saved “${entry.name}”.`);
      return true;
    } catch (error) {
      await shell.report('Could not save', error);
      return false;
    }
  }

  async function saveAs(): Promise<boolean> {
    const folder = path ? parentPath(path) : folderHint ?? '/Documents';
    let taken: string[] = [];
    try {
      taken = (await shell.fs.list(folder, true)).map(e => e.name);
    } catch {
      // Saving will say the folder is gone.
    }
    const chosen = await pickSave(shell, { title: 'Save as', folder, name: uniqueName(`${baseLabel()}.${kind}`, taken), ok: 'Save' });
    if (!chosen) {
      view.focus();
      return false;
    }
    // The ending chooses the kind: .txt is plain text, .md Markdown, anything else a Word document.
    let target = chosen.path;
    const as: 'docx' | 'txt' | 'md' = /\.txt$/i.test(target) ? 'txt' : /\.(md|markdown)$/i.test(target) ? 'md' : 'docx';
    if (as === 'docx' && !/\.docx$/i.test(target)) target += '.docx';
    if (!(await okToSaveAs(as, baseName(target)))) return false;
    try {
      const docNow = view.state.doc;
      const pageNow = JSON.stringify(page);
      let replacing = false;
      if (target !== chosen.path) {
        const existing = await shell.fs.stat(target).catch(() => null);
        if (existing && !(await shell.dialogs.confirm({ title: 'Replace it?', text: `“${baseName(target)}” already exists. Replace it with this one?`, ok: 'Replace', danger: true, cancel: 'Cancel' }))) return false;
        replacing = !!existing;
      } else replacing = chosen.replace;
      const entry = await shell.fs.writeFile(target, await fileBytes(as), replacing ? {} : { mustBeNew: true });
      path = target;
      label = entry.name;
      loadedId = entry.id;
      kind = as;
      folderHint = null;
      savedDoc = docNow;
      savedPage = pageNow;
      lost = [];
      refresh();
      shell.toast(`Saved “${entry.name}”.`);
      return true;
    } catch (error) {
      await shell.report('Could not save', error);
      return false;
    }
  }

  async function openFromDesktop(): Promise<void> {
    const chosen = await pickFile(shell, { title: 'Open a document', folder: path ? parentPath(path) : '/Documents', accept: ['docx', 'rtf', 'odt', 'md', 'markdown', 'txt'], ok: 'Open' });
    if (chosen) await shell.openApp('write', chosen);
  }

  /** A Word file from this computer: copied into Documents (so it can be saved), then opened in a window of its own. */
  function openFromComputer(): void {
    const input = h('input', { type: 'file', accept: '.docx,.rtf,.odt,.md,.markdown,.txt,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/rtf,application/vnd.oasis.opendocument.text,text/markdown,text/plain', class: 'visually-hidden', tabindex: -1, 'aria-hidden': 'true' });
    const done = new AbortController();
    on(input, 'change', async () => {
      const file = input.files?.[0];
      done.abort();
      input.remove();
      if (!file) return;
      if (file.size > MAX_FILE_BYTES) {
        await shell.dialogs.alert('That file is too big', `Documents up to ${formatSize(MAX_FILE_BYTES)} can be opened.`);
        return;
      }
      try {
        let taken: string[] = [];
        try {
          taken = (await shell.fs.list('/Documents', true)).map(e => e.name);
        } catch {
          // Writing says so if Documents is not there.
        }
        const entry = await shell.fs.writeFile(joinPath('/Documents', uniqueName(file.name, taken)), new Uint8Array(await file.arrayBuffer()), { mustBeNew: true });
        shell.toast(`Copied “${file.name}” into Documents as “${entry.name}” and opened it.`);
        await shell.openApp('write', joinPath('/Documents', entry.name));
      } catch (error) {
        await shell.report('Could not open that file', error);
      }
    }, done.signal);
    on(input, 'cancel', () => {
      done.abort();
      input.remove();
    }, done.signal);
    document.body.append(input);
    input.click();
  }

  async function download(): Promise<void> {
    try {
      shell.transfers.save(`${baseLabel()}.docx`, await fileBytes('docx'));
    } catch (error) {
      await shell.report('Could not make the Word file', error);
    }
  }

  const takeSnapshot = () => snapshot(dom, paper, page, box(), pageCount);
  const print = () => {
    layout(4);
    void printPreview(shell, takeSnapshot, page, baseLabel(), `${baseLabel()}.pdf`).then(() => view.focus());
  };

  // ---- Find and replace --------------------------------------------------------------------------------------------------

  const findInput = h('input', { type: 'text', class: 'field wp-find-input', 'aria-label': 'Find', placeholder: 'Find', spellcheck: false, autocomplete: 'off' });
  const replaceInput = h('input', { type: 'text', class: 'field wp-find-input', 'aria-label': 'Replace with', placeholder: 'Replace with', spellcheck: false, autocomplete: 'off' });
  const caseBox = h('input', { type: 'checkbox' });
  const wordBox = h('input', { type: 'checkbox' });
  const findCount = h('span', { class: 'wp-find-count', role: 'status', 'aria-live': 'polite' });
  const findButton = (text: string, title: string, run: () => void): HTMLButtonElement => {
    const b = h('button', { type: 'button', class: 'btn', title }, text);
    on(b, 'click', run, app.signal);
    return b;
  };
  const replaceRow = h('div', { class: 'wp-find-row' }, replaceInput,
    findButton('Replace', 'Replace this one, then go to the next', () => replaceOne()),
    findButton('Replace all', 'Replace every one', () => replaceEvery()));
  const findPanel = h('div', { class: 'wp-find-panel', role: 'search', hidden: true },
    h('div', { class: 'wp-find-row' }, findInput,
      findButton('▲', 'Previous (Shift+Enter)', () => go(-1)), findButton('▼', 'Next (Enter)', () => go(1)), findCount,
      h('label', { class: 'chart-check' }, caseBox, ' Match case'), h('label', { class: 'chart-check' }, wordBox, ' Whole words'),
      findButton('×', 'Close (Esc)', () => closeFind())),
    replaceRow);
  const findState = (): { query: string; opts: FindOptions; hits: Hit[]; current: number } => finder.key.getState(view.state);
  const showCount = () => {
    const s = findState();
    findCount.textContent = !s.query ? '' : s.hits.length ? `${s.current + 1} of ${s.hits.length.toLocaleString()}` : 'Not found';
  };
  /** Searches again (each change to the words or the ticks), starting from the cursor. */
  function runFind(): void {
    const opts = { matchCase: caseBox.checked, wholeWord: wordBox.checked };
    const query = findInput.value;
    const hits = findAll(view.state.doc, query, opts);
    const from = view.state.selection.from;
    const current = hits.length ? Math.max(0, hits.findIndex(x => x.from >= from)) : -1;
    view.dispatch(view.state.tr.setMeta(finder.key, { query, opts, hits, current }).setMeta('addToHistory', false));
    showCount();
  }
  /** The next (1) or previous (-1) place, chosen in the text and scrolled to. */
  function go(step: number): void {
    const s = findState();
    if (!s.hits.length) {
      showCount();
      return;
    }
    const current = s.current < 0 ? 0 : (s.current + step + s.hits.length) % s.hits.length;
    const hit = s.hits[current];
    view.dispatch(view.state.tr.setMeta(finder.key, { ...s, current }).setSelection(pm.TextSelection.create(view.state.doc, hit.from, hit.to)).scrollIntoView());
    showCount();
  }
  function replaceOne(): void {
    const s = findState();
    if (!s.hits.length) return;
    const hit = s.hits[Math.max(0, s.current)];
    const sel = view.state.selection;
    // The first press goes to the place; the next replaces it (as in Word).
    if (sel.from !== hit.from || sel.to !== hit.to) {
      go(s.current < 0 ? 1 : 0);
      return;
    }
    view.dispatch(replaceAll(view.state, [hit], replaceInput.value));
    const after = findState();
    const next = after.hits.findIndex(x => x.from >= hit.from + replaceInput.value.length);
    view.dispatch(view.state.tr.setMeta(finder.key, { ...after, current: next >= 0 ? next - 1 : after.hits.length - 1 }));
    go(1);
  }
  function replaceEvery(): void {
    const s = findState();
    if (!s.hits.length) return;
    const n = s.hits.length;
    view.dispatch(replaceAll(view.state, s.hits, replaceInput.value));
    showCount();
    shell.toast(`Replaced ${n.toLocaleString()} ${n === 1 ? 'place' : 'places'}.`);
  }
  function openFind(replace: boolean): void {
    findPanel.hidden = false;
    replaceRow.hidden = !replace;
    const { from, to } = view.state.selection;
    const picked = view.state.doc.textBetween(from, to, ' ');
    if (picked && picked.length < 100 && !picked.includes('\n')) findInput.value = picked;
    findInput.focus();
    findInput.select();
    runFind();
  }
  function closeFind(): void {
    findPanel.hidden = true;
    view.dispatch(view.state.tr.setMeta(finder.key, { query: '', opts: { matchCase: false, wholeWord: false }, hits: [], current: -1 }).setMeta('addToHistory', false));
    view.focus();
  }
  on(findInput, 'input', runFind, app.signal);
  on(caseBox, 'change', runFind, app.signal);
  on(wordBox, 'change', runFind, app.signal);
  on(findPanel, 'keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && e.target === findInput) {
      e.preventDefault();
      go(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Enter' && e.target === replaceInput) {
      e.preventDefault();
      replaceOne();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeFind();
    }
  }, app.signal);

  // ---- The ribbon --------------------------------------------------------------------------------------------------------

  const btn = (face: string | Node, title: string, run: () => void, cls = ''): HTMLButtonElement => {
    const b = h('button', { type: 'button', class: `rb ${cls}`.trim(), title, 'aria-label': title }, face);
    // The editor keeps its selection while a button is pressed.
    on(b, 'mousedown', (e: MouseEvent) => e.preventDefault(), app.signal);
    on(b, 'click', () => {
      syncCursor(view);
      run();
    }, app.signal);
    return b;
  };
  const group = (name: string, ...kids: Node[]): HTMLElement => h('div', { class: 'rgroup', role: 'group', 'aria-label': name }, h('div', { class: 'rgroup-items' }, ...kids), h('div', { class: 'rgroup-name' }, name));
  const sized = (width: number, g: HTMLElement): HTMLElement => {
    css(g.querySelector<HTMLElement>('.rgroup-items')!, { 'max-width': width });
    return g;
  };
  const menuBtn = (face: string | Node, title: string, items: () => MenuItem[], cls = 'text-rb'): HTMLButtonElement => {
    const b = btn(h('span', {}, face, h('span', { class: 'rb-caret', 'aria-hidden': 'true' }, ' ▾')), title, () => {
      const r = b.getBoundingClientRect();
      shell.menus.show(items(), r.left, r.bottom, { returnFocus: b, anchor: b, onClose: () => view.focus() });
    }, cls);
    b.setAttribute('aria-haspopup', 'true');
    return b;
  };

  // Colour boxes (text colour, highlight, cell shading): a grid of swatches under the button.
  let palette: HTMLElement | null = null;
  const closePalette = () => {
    palette?.remove();
    palette = null;
  };
  const paletteBtn = (face: string, title: string, colours: Array<[string, string]>, noneLabel: string, swatch: string, pick: (hex: string | null) => void): HTMLButtonElement => {
    const b = h('button', { type: 'button', class: 'rb wide-rb', title, 'aria-label': title, 'aria-haspopup': 'true' }, h('span', { class: 'rb-a' }, face), h('span', { class: 'rb-swatch' }), h('span', { class: 'rb-caret', 'aria-hidden': 'true' }, '▾'));
    css(b.querySelector<HTMLElement>('.rb-swatch')!, { background: swatch });
    on(b, 'mousedown', (e: MouseEvent) => e.preventDefault(), app.signal);
    on(b, 'click', () => {
      if (palette) {
        closePalette();
        return;
      }
      const boxEl = h('div', { class: 'palette', role: 'menu', 'aria-label': title });
      const none = h('button', { type: 'button', class: 'palette-none', role: 'menuitem' }, noneLabel);
      on(none, 'mousedown', (e: MouseEvent) => e.preventDefault(), app.signal);
      on(none, 'click', () => {
        closePalette();
        pick(null);
      }, app.signal);
      const grid = h('div', { class: 'palette-grid' });
      for (const [name, hex] of colours) {
        const sw = h('button', { type: 'button', class: 'palette-sw', role: 'menuitem', title: name, 'aria-label': name });
        css(sw, { background: hex });
        on(sw, 'mousedown', (e: MouseEvent) => e.preventDefault(), app.signal);
        on(sw, 'click', () => {
          closePalette();
          css(b.querySelector<HTMLElement>('.rb-swatch')!, { background: hex });
          b.dataset.colour = hex;
          pick(hex);
        }, app.signal);
        grid.append(sw);
      }
      boxEl.append(none, grid);
      app.root.append(boxEl);
      const r = b.getBoundingClientRect();
      const host = app.root.getBoundingClientRect();
      css(boxEl, { left: Math.max(0, Math.min(r.left - host.left, host.width - 190)), top: r.bottom - host.top });
      palette = boxEl;
      (grid.firstElementChild as HTMLElement | null)?.focus();
    }, app.signal);
    b.dataset.colour = swatch;
    return b;
  };

  // Home.
  const undoBtn = btn('↶', 'Undo (Ctrl+Z)', () => exec(pm.undo));
  const redoBtn = btn('↷', 'Redo (Ctrl+Y)', () => exec(pm.redo));
  const cutBtn = btn('✂', 'Cut (Ctrl+X)', () => {
    view.focus();
    document.execCommand('cut');
  });
  const copyBtn = btn('⧉', 'Copy (Ctrl+C). Paste with Ctrl+V.', () => {
    view.focus();
    document.execCommand('copy');
  });
  const faceBox = h('select', { class: 'rb-select font-face', 'aria-label': 'Font', title: 'Font (typeface)' },
    h('option', { value: '' }, 'Style’s own'), ...['Calibri Light', ...FONT_FACES.map(f => f.name)].map(n => h('option', { value: n }, n)), h('option', { value: '?', hidden: true }));
  on(faceBox, 'change', () => {
    const face = faceBox.value && faceBox.value !== '?' ? faceBox.value : null;
    setMark(marks.font, face ? { face } : null);
  }, app.signal);
  const sizeList = h('datalist', { id: `wp-sizes-${app.id}` }, ...FONT_SIZES.map(s => h('option', { value: String(s) })));
  const sizeBox = h('input', { type: 'text', class: 'rb-size', 'aria-label': 'Font size', title: 'Font size (points)', list: `wp-sizes-${app.id}`, inputmode: 'decimal', autocomplete: 'off' });
  const applySize = () => {
    const v = Number(sizeBox.value.replace(',', '.'));
    if (Number.isFinite(v) && v >= 1 && v <= 400) setMark(marks.size, { pt: Math.round(v * 2) / 2 });
    else syncToolbar();
  };
  on(sizeBox, 'change', applySize, app.signal);
  on(sizeBox, 'keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      applySize();
    } else if (e.key === 'Escape') {
      syncToolbar();
      view.focus();
    }
  }, app.signal);
  const growBtn = btn('A▲', 'Bigger text (Ctrl+])', () => growFont(1), 'grow');
  const shrinkBtn = btn('A▼', 'Smaller text (Ctrl+[)', () => growFont(-1), 'shrink');
  const boldBtn = btn('B', 'Bold (Ctrl+B)', () => exec(pm.toggleMark(marks.strong)), 'bold');
  const italicBtn = btn('I', 'Italic (Ctrl+I)', () => exec(pm.toggleMark(marks.em)), 'italic');
  const underBtn = btn('U', 'Underline (Ctrl+U)', () => exec(pm.toggleMark(marks.underline)), 'under');
  const strikeBtn = btn('S', 'Strikethrough', () => exec(pm.toggleMark(marks.strike)), 'strike');
  const supBtn = btn(h('span', {}, 'x', h('sup', {}, '2')), 'Superscript (Ctrl+Shift+=)', () => exec(pm.toggleMark(marks.vert, { pos: 'super' })));
  const subBtn = btn(h('span', {}, 'x', h('sub', {}, '2')), 'Subscript (Ctrl+=)', () => exec(pm.toggleMark(marks.vert, { pos: 'sub' })));
  const colourBtn = paletteBtn('A', 'Text colour', PALETTE, 'Automatic (the style’s colour)', '#c00000', hex => setMark(marks.color, hex ? { value: hex } : null));
  const highlightBtn = paletteBtn('ab', 'Highlight colour', HIGHLIGHTS, 'No highlight', '#ffff00', hex => setMark(marks.highlight, hex ? { value: hex } : null));
  const clearBtn = btn('A⌫', 'Clear formatting (Ctrl+Space): the paragraph’s style only', clearFormatting);

  const bulletBtn = btn(listIcon('bullet'), 'Bullets (Ctrl+Shift+L, or type * and a space)', () => exec(toggleList(nodes.bullet_list)));
  const numberBtn = btn(listIcon('number'), 'Numbering (or type 1. and a space)', () => exec(toggleList(nodes.ordered_list)));
  const outdentBtn = btn(listIcon('outdent'), 'Decrease indent (Shift+Tab in a list)', () => indentBy(-1));
  const indentBtn = btn(listIcon('indent'), 'Increase indent (Tab in a list)', () => indentBy(1));
  const alignBtns = (['left', 'center', 'right', 'justify'] as const).map(a => btn(alignIcon(a), { left: 'Align left (Ctrl+L)', center: 'Centre (Ctrl+E)', right: 'Align right (Ctrl+R)', justify: 'Justify (Ctrl+J)' }[a], () => exec(paraCmd({ align: a === 'left' ? null : a }))));
  const lineBtn = menuBtn('↕', 'Line and paragraph spacing', () => {
    const p = selectedParagraphs(view.state)[0]?.node;
    const style = STYLES[(p?.attrs.style ?? 'normal') as StyleId];
    const line = p?.attrs.line ?? style.line;
    return [
      ...LINE_CHOICES.map(v => ({ label: v === 1 ? '1.0 (single)' : v === 2 ? '2.0 (double)' : String(v), checked: Math.abs(line - v) < 0.01, action: () => exec(paraCmd({ line: v })) })),
      { separator: true },
      (p?.attrs.before ?? style.before) > 0
        ? { label: 'Remove space before paragraph', action: () => exec(paraCmd({ before: 0 })) }
        : { label: 'Add space before paragraph', action: () => exec(paraCmd({ before: 12 })) },
      (p?.attrs.after ?? style.after) > 0
        ? { label: 'Remove space after paragraph', action: () => exec(paraCmd({ after: 0 })) }
        : { label: 'Add space after paragraph', action: () => exec(paraCmd({ after: 8 })) },
      { separator: true },
      { label: 'Paragraph settings...', action: () => void paragraphSettings() },
    ];
  }, 'text-rb');
  async function paragraphSettings(): Promise<void> {
    const p = selectedParagraphs(view.state)[0]?.node;
    if (!p) return;
    const s = STYLES[p.attrs.style as StyleId] ?? STYLES.normal;
    const got = await paragraphDialog(shell, page, { before: p.attrs.before ?? s.before, after: p.attrs.after ?? s.after, line: p.attrs.line ?? s.line, indent: p.attrs.indent ?? 0, first: p.attrs.first ?? 0 });
    if (got) {
      exec(paraCmd({
        before: got.before === s.before ? null : got.before, after: got.after === s.after ? null : got.after, line: got.line === s.line ? null : got.line,
        indent: got.indent || null, first: got.first || null,
      }));
    } else view.focus();
  }
  const styleBtns = STYLE_IDS.map(id => {
    const s = STYLES[id];
    const sample = h('span', { class: `wp-style-sample wp-sample-${id}` }, s.label);
    return btn(sample, `${s.label}${id === 'normal' ? ' (Ctrl+Shift+N)' : id === 'title' ? '' : ` (Ctrl+Alt+${id.slice(1)})`}`, () => exec(styleCmd(id)), 'wp-style-rb');
  });

  // Insert.
  const pageBreakBtn = btn('⤓ Page break', 'Page break (Ctrl+Enter): what follows starts a new page', () => exec(insertPageBreak), 'text-rb');
  const tableBtn = btn('▦ Table', 'Insert a table', () => void insertTable(), 'text-rb');
  const picDeskBtn = btn('🖼 From Pictures', 'Insert a picture from this desktop (Pictures, Documents...)', () => void pictureFromDesktop(), 'text-rb');
  const picPcBtn = btn('⇪ From this computer', 'Insert a picture from this computer (you can also paste or drop one in)', pictureFromComputer, 'text-rb');

  // Layout.
  const marginsBtn = menuBtn('Margins', 'Margins', () => [
    ...(Object.keys(MARGIN_PRESETS) as Array<keyof typeof MARGIN_PRESETS>).map(k => ({
      label: MARGIN_PRESETS[k].label,
      checked: JSON.stringify(MARGIN_PRESETS[k].m) === JSON.stringify(page.margins),
      action: () => setPage({ ...page, margins: { ...MARGIN_PRESETS[k].m } }),
    })),
    { separator: true },
    { label: 'Custom margins...', action: () => void marginsDialog(shell, page).then(m => { if (m) setPage({ ...page, margins: m }); view.focus(); }) },
  ]);
  const orientBtn = menuBtn('Orientation', 'Orientation', () => [
    { label: 'Portrait (tall)', checked: page.orient === 'portrait', action: () => setPage({ ...page, orient: 'portrait' }) },
    { label: 'Landscape (wide)', checked: page.orient === 'landscape', action: () => setPage({ ...page, orient: 'landscape' }) },
  ]);
  const sizeMenuBtn = menuBtn('Size', 'Paper size', () => (Object.keys(PAPERS) as Paper[]).map(k => ({ label: PAPERS[k].label, checked: page.paper === k, action: () => setPage({ ...page, paper: k }) })));
  const hfBtn = btn('Header & footer...', 'Header and footer: words at the top and bottom of every page, with page numbers', () => void headerFooterDialog(shell, page).then(got => {
    if (got) setPage({ ...page, ...got });
    view.focus();
  }), 'text-rb');
  const numbersBtn = menuBtn('Page numbers', 'Page numbers', () => [
    { label: 'Bottom, centre: 1', action: () => setPage({ ...page, footer: { ...page.footer, c: '&P' } }) },
    { label: 'Bottom, right: Page 1 of 3', action: () => setPage({ ...page, footer: { ...page.footer, r: 'Page &P of &N' } }) },
    { label: 'Top, right: 1', action: () => setPage({ ...page, header: { ...page.header, r: '&P' } }) },
    { separator: true },
    {
      label: 'Remove page numbers',
      action: () => {
        const strip = (l: PageSetup['header']) => ({ l: l.l.replace(/(Page )?&P( of &N)?/g, '').trim(), c: l.c.replace(/(Page )?&P( of &N)?/g, '').trim(), r: l.r.replace(/(Page )?&P( of &N)?/g, '').trim() });
        setPage({ ...page, header: strip(page.header), footer: strip(page.footer) });
      },
    },
  ]);
  const breakBtn2 = btn('⤓ Page break', 'Page break (Ctrl+Enter)', () => exec(insertPageBreak), 'text-rb');

  // Table.
  const borderBtn = btn('Lines on or off', 'Table lines: printed lines round every cell, or none (faint lines show while you edit)', () => {
    const t = tableHere();
    if (t) setTableAttr({ borders: !t.node.attrs.borders });
  }, 'text-rb');
  const shadeBtn = paletteBtn('▧', 'Cell shading', SHADES, 'No shading', '#d9d9d9', hex => exec(pm.setCellAttr('background', hex)));

  // Picture.
  const picAlignBtns = (['left', 'center', 'right'] as const).map(a => btn(alignIcon(a), `Picture ${a === 'center' ? 'in the centre' : `at the ${a}`} of its line`, () => exec(paraCmd({ align: a === 'left' ? null : a }))));

  type Tab = 'home' | 'insert' | 'layout' | 'table' | 'picture' | 'help';
  const TAB_NAMES: Record<Tab, string> = { home: 'Home', insert: 'Insert', layout: 'Layout', table: 'Table', picture: 'Picture', help: 'Help' };
  const TAB_ORDER: Tab[] = ['home', 'insert', 'layout', 'table', 'picture', 'help'];
  const groupsOf = (t: Tab): HTMLElement[] => {
    if (t === 'home') {
      return [
        group('Undo', undoBtn, redoBtn, cutBtn, copyBtn),
        sized(300, group('Font', faceBox, sizeBox, growBtn, shrinkBtn, h('span', { class: 'rb-break' }), boldBtn, italicBtn, underBtn, strikeBtn, supBtn, subBtn, colourBtn, highlightBtn, clearBtn)),
        sized(240, group('Paragraph', bulletBtn, numberBtn, outdentBtn, indentBtn, h('span', { class: 'rb-break' }), ...alignBtns, lineBtn)),
        group('Styles', ...styleBtns),
        group('Editing', btn('⌕ Find', 'Find (Ctrl+F)', () => openFind(false), 'text-rb'), btn('Replace', 'Replace (Ctrl+H)', () => openFind(true), 'text-rb')),
      ];
    }
    if (t === 'insert') {
      return [group('Pages', pageBreakBtn), group('Tables', tableBtn), sized(200, group('Pictures', picDeskBtn, picPcBtn)),
        group('Tip', h('span', { class: 'wp-tip' }, 'Paste or drop a picture straight into the page.'))];
    }
    if (t === 'layout') return [group('Page setup', marginsBtn, orientBtn, sizeMenuBtn, breakBtn2), group('Header & footer', hfBtn, numbersBtn)];
    if (t === 'table') {
      return [
        sized(260, group('Rows & columns',
          btn('Row above', 'Insert a row above', tableCmd(pm.addRowBefore), 'text-rb'), btn('Row below', 'Insert a row below', tableCmd(pm.addRowAfter), 'text-rb'),
          btn('Column left', 'Insert a column to the left', tableCmd(pm.addColumnBefore), 'text-rb'), btn('Column right', 'Insert a column to the right', tableCmd(pm.addColumnAfter), 'text-rb'))),
        sized(230, group('Delete', btn('Row', 'Delete this row', tableCmd(pm.deleteRow), 'text-rb'), btn('Column', 'Delete this column', tableCmd(pm.deleteColumn), 'text-rb'), btn('Table', 'Delete the whole table', tableCmd(pm.deleteTable), 'text-rb'))),
        group('Merge', btn('Merge cells', 'Merge the chosen cells into one (drag across cells to choose them)', tableCmd(pm.mergeCells), 'text-rb'), btn('Split cell', 'Split a merged cell back into its cells', tableCmd(pm.splitCell), 'text-rb')),
        group('Look', borderBtn, shadeBtn, btn('Even columns', 'Every column the same width, the table as wide as the writing (drag a column’s edge to change one)', evenColumns, 'text-rb')),
      ];
    }
    if (t === 'picture') {
      return [
        group('Size', btn('Size...', 'Width and height', () => void pictureSize(), 'text-rb'), btn('Own size', 'Its own size (as wide as the writing at most)', () => pictureFit(true), 'text-rb'), btn('Page width', 'As wide as the writing', () => pictureFit(false), 'text-rb')),
        group('Position on its line', ...picAlignBtns),
        group('Description', btn('Alt text...', 'Describe the picture for screen readers', () => void pictureAlt(), 'text-rb')),
        group('Tip', h('span', { class: 'wp-tip' }, 'Drag the square at its corner to resize. It sits in the line like a large letter.')),
      ];
    }
    return [h('div', { class: 'wp-help' },
      h('p', {}, h('strong', {}, 'Writes and saves Word documents (.docx). '), 'Fonts, sizes, colours, highlight, bold, italic, underline; alignment, spacing, indents; Normal, Title and Heading 1–3; bullets and numbering; tables with merged and shaded cells; pictures in the line; page breaks; paper, margins and orientation; a header and footer with page numbers; print and PDF.'),
      h('p', {}, h('strong', {}, 'Not here yet: '), 'Find and replace, footnotes, a contents page, columns, comments and tracked changes, text boxes and shapes, text wrapping round pictures, a different first-page header, equations, and the old .doc files. A Word file that has them still opens: Write lists what it cannot show, and asks before saving over the file.'),
      h('p', {}, h('strong', {}, 'Keys: '), 'Ctrl+B, I, U; Ctrl+E centre, Ctrl+L left, Ctrl+R right, Ctrl+J justify; Ctrl+1, 2, 5 line spacing; Ctrl+Alt+1, 2, 3 headings; Ctrl+Shift+N Normal; Ctrl+Enter page break; Shift+Enter new line; Tab and Shift+Tab move a list item in and out; Ctrl+S save; Ctrl+P print.'))];
  };
  let tab: Tab = 'home';
  const ribbon = h('div', { class: 'ribbon', role: 'tabpanel', 'data-menus-stay': '' }, ...groupsOf('home'));
  const tabButtons = TAB_ORDER.map(t => {
    const b = h('button', { type: 'button', class: `ribbon-tab${t === 'table' || t === 'picture' ? ' context-tab' : ''}`, role: 'tab', 'aria-selected': String(t === 'home'), hidden: t === 'table' || t === 'picture' }, TAB_NAMES[t]);
    on(b, 'mousedown', (e: MouseEvent) => e.preventDefault(), app.signal);
    on(b, 'click', () => showTab(t), app.signal);
    return b;
  });
  function showTab(t: Tab): void {
    tab = t;
    closePalette();
    ribbon.replaceChildren(...groupsOf(t));
    tabButtons.forEach((b, i) => b.setAttribute('aria-selected', String(TAB_ORDER[i] === t)));
    syncToolbar();
  }

  const fileItems = (): MenuItem[] => [
    { label: 'New', action: () => void shell.openApp('write') },
    { label: 'Open...', action: () => void openFromDesktop() },
    { label: 'Open a Word file from your computer...', action: openFromComputer },
    { separator: true },
    { label: 'Save', hint: 'Ctrl+S', action: () => void save() },
    { label: 'Save as...', hint: 'Ctrl+Shift+S', action: () => void saveAs() },
    { label: 'Download as Word document (.docx)', action: () => void download() },
    { separator: true },
    { label: 'Print and PDF...', hint: 'Ctrl+P', action: print },
  ];
  const fileBtn = h('button', { type: 'button', class: 'file-tab', 'aria-haspopup': 'true' }, 'File');
  on(fileBtn, 'click', () => {
    const r = fileBtn.getBoundingClientRect();
    shell.menus.show(fileItems(), r.left, r.bottom, { returnFocus: fileBtn, onClose: () => view.focus() });
  }, app.signal);
  const tabsRow = h('div', { class: 'ribbon-tabs', role: 'tablist', 'aria-label': 'Toolbar' }, fileBtn, ...tabButtons);

  // ---- Status bar ------------------------------------------------------------------------------------------------------

  const pageLabel = h('span', {});
  const wordsLabel = h('span', {});
  const zoomOut = btn('−', 'Zoom out', () => setZoom(ZOOMS.slice().reverse().find(z => z < zoom - 0.01) ?? zoom), 'zoom-btn');
  const zoomIn = btn('+', 'Zoom in', () => setZoom(ZOOMS.find(z => z > zoom + 0.01) ?? zoom), 'zoom-btn');
  const zoomLabel = btn('100%', 'Zoom: press for the page’s width', () => setZoom(Math.max(0.3, Math.min(2, (scroller.clientWidth - 32) / box().w))), 'zoom-label');
  const status = h('div', { class: 'statusbar sheet-status wp-status', role: 'status' }, pageLabel, wordsLabel, h('span', { class: 'spacer' }), zoomOut, zoomLabel, zoomIn);
  function setZoom(z: number): void {
    zoom = Math.round(z * 100) / 100;
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    scheduleLayout();
    view.focus();
  }
  let wordsFor: any = null;
  function syncStatus(): void {
    pageLabel.textContent = `Page ${Math.min(pageCount, pageOfCursor(view, paper, box()))} of ${pageCount}`;
    if (wordsFor !== view.state.doc) {
      wordsFor = view.state.doc;
      const n = countWords(view.state.doc.textBetween(0, view.state.doc.content.size, '\n', ' '));
      wordsLabel.textContent = `${n.toLocaleString()} ${n === 1 ? 'word' : 'words'}`;
    }
  }

  // ---- Keeping the toolbar in step with the cursor ------------------------------------------------------------------------

  const press = (b: HTMLElement, on1: boolean) => b.setAttribute('aria-pressed', String(on1));
  function syncToolbar(): void {
    const st = view.state;
    undoBtn.disabled = pm.undoDepth(st) === 0;
    redoBtn.disabled = pm.redoDepth(st) === 0;
    press(boldBtn, hasMark(marks.strong));
    press(italicBtn, hasMark(marks.em));
    press(underBtn, hasMark(marks.underline));
    press(strikeBtn, hasMark(marks.strike));
    press(supBtn, markAttr(marks.vert, 'pos') === 'super');
    press(subBtn, markAttr(marks.vert, 'pos') === 'sub');
    const face = markAttr(marks.font, 'face');
    const known = typeof face === 'string' && [...faceBox.options].some(o => o.value === face);
    faceBox.value = typeof face === 'string' ? (known ? face : '?') : '';
    if (typeof face === 'string' && !known) faceBox.options[faceBox.options.length - 1].textContent = face;
    const p = selectedParagraphs(st)[0]?.node;
    const style = (p?.attrs.style ?? 'normal') as StyleId;
    faceBox.options[0].textContent = `${STYLES[style].face} (style)`;
    if (document.activeElement !== sizeBox) sizeBox.value = String(sizeHere());
    const align = p?.attrs.align ?? 'left';
    (['left', 'center', 'right', 'justify'] as const).forEach((a, i) => press(alignBtns[i], align === a));
    (['left', 'center', 'right'] as const).forEach((a, i) => press(picAlignBtns[i], align === a));
    STYLE_IDS.forEach((id, i) => press(styleBtns[i], style === id));
    const $f = st.selection.$from;
    let list: any = null;
    for (let d = $f.depth; d > 0 && !list; d--) if ($f.node(d).type === nodes.bullet_list || $f.node(d).type === nodes.ordered_list) list = $f.node(d).type;
    press(bulletBtn, list === nodes.bullet_list);
    press(numberBtn, list === nodes.ordered_list);
    const inTable = pm.isInTable(st);
    const onPicture = !!pictureHere();
    tabButtons[TAB_ORDER.indexOf('table')].hidden = !inTable;
    tabButtons[TAB_ORDER.indexOf('picture')].hidden = !onPicture;
    if ((tab === 'table' && !inTable) || (tab === 'picture' && !onPicture)) showTab('home');
    else if (onPicture && tab === 'home' && pictureJustChosen()) showTab('picture');
    if (tab === 'table') press(borderBtn, !!tableHere()?.node.attrs.borders);
    syncStatus();
  }
  // Choosing a picture opens its tab once; after that the person picks the tab they want.
  let lastPicture: any = null;
  const pictureJustChosen = (): boolean => {
    const p = pictureHere();
    const fresh = !!p && p.node !== lastPicture;
    lastPicture = p?.node ?? null;
    return fresh;
  };

  // ---- Put together -------------------------------------------------------------------------------------------------------

  app.root.append(tabsRow, ribbon, findPanel, scroller, status, sizeList);
  setZoom(scroller.clientWidth && scroller.clientWidth < box().w + 32 ? Math.max(0.3, (scroller.clientWidth - 32) / box().w) : 1);
  refresh();
  syncToolbar();
  layout(0);
  // Typefaces arrive after the first drawing; pictures size themselves as they load: the pages are measured again.
  void document.fonts?.ready.then(() => scheduleLayout());
  on(dom, 'load', () => scheduleLayout(), app.signal, { capture: true });
  on(scroller, 'scroll', () => syncStatus(), app.signal, { passive: true });
  // Clicking the paper below the writing (or in its margins) puts the cursor in the nearest place.
  on(desk, 'mousedown', (event: MouseEvent) => {
    if (event.target === dom || event.target === desk || event.target === paper) {
      const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
      if (!hit) {
        event.preventDefault();
        view.dispatch(view.state.tr.setSelection(pm.Selection.atEnd(view.state.doc)));
        view.focus();
      }
    }
  }, app.signal);

  on(app.root, 'keydown', (event: KeyboardEvent) => {
    const ctrl = event.ctrlKey || event.metaKey;
    const k = event.key.toLowerCase();
    if (ctrl && k === 's') {
      event.preventDefault();
      void (event.shiftKey ? saveAs() : save());
    } else if (ctrl && !event.shiftKey && k === 'p') {
      event.preventDefault();
      print();
    } else if (ctrl && !event.shiftKey && (k === 'f' || k === 'h')) {
      event.preventDefault();
      openFind(k === 'h');
    } else if (event.key === 'Escape' && palette) {
      closePalette();
      view.focus();
    }
  }, app.signal);
  on(document, 'pointerdown', (event: PointerEvent) => {
    if (palette && event.target instanceof Node && !palette.contains(event.target) && !(event.target as Element).closest?.('.wide-rb')) closePalette();
  }, app.signal);
  app.signal.addEventListener('abort', () => {
    if (layoutFrame) cancelAnimationFrame(layoutFrame);
    view.destroy();
  });

  if (lost.length || keptParts.length) {
    const parts: Node[] = [];
    if (keptParts.length) {
      parts.push(h('p', { class: 'dialog-text' }, 'Write keeps these as they are, shown as grey labels in the text; saving puts them back unchanged:'), h('ul', { class: 'xlsx-list' }, ...keptParts.map(d => h('li', {}, d))));
    }
    if (lost.length) {
      parts.push(h('p', { class: 'dialog-text' }, 'These are left out (Write cannot show them yet):'), h('ul', { class: 'xlsx-list' }, ...lost.map(d => h('li', {}, d))));
    }
    const detail = source
      ? (lost.length ? 'The file itself has not been changed. Saving over it would leave out what is listed as left out, so Save asks first.' : 'The file itself has not been changed.')
      : 'The file itself has not been changed. Save makes a Word document (.docx) beside it.';
    void shell.dialogs.ask<true>({
      title: `Opened “${label}”`,
      body: h('div', { class: 'xlsx-report' }, ...parts, h('p', { class: 'dialog-detail' }, detail)),
      buttons: [{ label: 'OK', value: true, primary: true }],
      cancel: true,
    }).then(() => view.focus());
  } else view.focus();
}
