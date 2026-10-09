// Notepad Pro: a Notepad++-style code editor. Tabs, colouring by language, Find/Replace with patterns (Ctrl+F, Ctrl+H),
// Find in files across a folder and Replace in all open files (Ctrl+Shift+F), bookmarks (Ctrl+F2, F2, Shift+F2), show
// spaces, word wrap, zoom, line endings kept on save, and a live Markdown preview. The editor is CodeMirror 6 (MIT),
// bundled as public/vendor/codemirror.js by vendor-src/codemirror and loaded only when this window opens.
// Nothing in a file is ever run: HTML is letters, and the Markdown preview builds its elements itself (markdown.ts).
import { h, on } from '../core/dom.ts';
import { formatSize, plural } from '../core/format.ts';
import { baseName, parentPath } from '../fs/names.ts';
import { pickFile, pickFolder, pickSave } from '../shell/filepicker.ts';
import type { AppDef, AppHandle } from '../shell/types.ts';
import { detectEol, EOL_NAMES, toBox, toFile, type Eol } from './notepad/text.ts';
import { findInFolder, makePattern, type FileHits, type FindOptions } from './notepadpro/findfiles.ts';
import { langById, langFor, LANGS, type Bundle } from './notepadpro/languages.ts';
import { renderMarkdown, toDom, type MarkdownParser } from './notepadpro/markdown.ts';
import { APPS } from './catalog.ts';
import { saveOver } from '../shell/savefile.ts';

const MAX_BYTES = 5 * 1024 * 1024;
const ZOOMS = [60, 70, 80, 90, 100, 110, 125, 150, 175, 200];

let loading: Promise<Bundle> | null = null;
/** The CodeMirror bundle, loaded once for every Notepad Pro window. */
export function loadCodeMirror(): Promise<Bundle> {
  loading ??= import(new URL('../../vendor/codemirror.js', import.meta.url).href) as Promise<Bundle>;
  return loading;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Doc {
  id: number;
  path: string | null;
  name: string;
  state: any;
  /** The text as last saved or opened, to tell whether there are changes. */
  saved: any;
  eol: Eol;
  savedEol: Eol;
  modified: number;
  lang: string;
  tab: HTMLElement;
}

export const notepadProApp: AppDef = {
  ...APPS.notepadpro,
  async launch(app, arg) {
    app.root.classList.add('npp');
    app.root.append(h('p', { class: 'app-message' }, 'Loading the editor...'));
    let cm: Bundle;
    try {
      cm = await loadCodeMirror();
    } catch (error) {
      loading = null;
      app.root.replaceChildren(h('p', { class: 'app-message', role: 'alert' }, 'The editor could not be loaded. Check the connection to the server, then open Notepad Pro again.'));
      console.error(error);
      return;
    }
    if (app.signal.aborted) return;
    await run(app, cm, arg);
  },
};

async function run(app: AppHandle, cm: Bundle, arg: string | undefined): Promise<void> {
  const shell = app.shell;
  let nextId = 1;
  let untitled = 1;
  const docs: Doc[] = [];
  let active: Doc | null = null;
  let wrap = false;
  let spaces = false;
  let zoom = 100;
  let preview = true;

  // ---- The editor's parts that change while it runs ----
  const langBox = new cm.Compartment();
  const wrapBox = new cm.Compartment();
  const spaceBox = new cm.Compartment();
  const zoomBox = new cm.Compartment();

  // Bookmarks: a set of line markers that moves with the text.
  const toggleMark = cm.StateEffect.define({ map: (pos: number, mapping: any) => mapping.mapPos(pos) });
  const markGutter = new (class extends cm.GutterMarker {
    toDOM() {
      return h('span', { class: 'npp-mark', 'aria-hidden': 'true' }, '●');
    }
  })();
  const marks = cm.StateField.define({
    create: () => cm.RangeSet.empty,
    update(set: any, tr: any) {
      set = set.map(tr.changes);
      for (const e of tr.effects) {
        if (!e.is(toggleMark)) continue;
        let has = false;
        set.between(e.value, e.value, () => {
          has = true;
        });
        set = has ? set.update({ filter: (from: number) => from !== e.value }) : set.update({ add: [markGutter.range(e.value)] });
      }
      return set;
    },
  });
  const markLine = cm.Decoration.line({ class: 'npp-marked' });
  const markDecos = cm.EditorView.decorations.compute([marks], (state: any) => {
    const b = new cm.RangeSetBuilder();
    const it = state.field(marks).iter();
    for (; it.value; it.next()) b.add(it.from, it.from, markLine);
    return b.finish();
  });
  const markers = (state: any): number[] => {
    const out: number[] = [];
    const it = state.field(marks).iter();
    for (; it.value; it.next()) out.push(it.from);
    return out;
  };

  const fontTheme = (z: number) => cm.EditorView.theme({ '&': { fontSize: `${(14 * z) / 100}px` } });

  // ---- The window ----
  const tool = (label: string, title: string, extra: Record<string, string> = {}) => h('button', { type: 'button', class: 'tool wide', title, ...extra }, label);
  const newBtn = tool('New', 'New tab (Ctrl+N)');
  const openBtn = tool('Open...', 'Open a file (Ctrl+O)');
  const saveBtn = tool('Save', 'Save (Ctrl+S)');
  const saveAsBtn = tool('Save as...', 'Save under another name (Ctrl+Shift+S)');
  const findBtn = tool('Find', 'Find and replace (Ctrl+F, Ctrl+H). Patterns, match case and whole word are in the bar.');
  const filesBtn = tool('Find in files', 'Search every file in a folder (Ctrl+Shift+F)');
  const markBtn = tool('Bookmark', 'Bookmark this line (Ctrl+F2); F2 goes to the next, Shift+F2 the one before');
  const wrapBtn = tool('Wrap', 'Wrap long lines', { 'aria-pressed': 'false' });
  const spaceBtn = tool('Show spaces', 'Show spaces and tabs', { 'aria-pressed': 'false' });
  const previewBtn = tool('Preview', 'Show the Markdown preview beside the text', { 'aria-pressed': 'true' });
  const zoomOut = tool('−', 'Zoom out (Ctrl+-)', { 'aria-label': 'Zoom out' });
  const zoomIn = tool('+', 'Zoom in (Ctrl++)', { 'aria-label': 'Zoom in' });
  const langSelect = h('select', { class: 'field npp-lang', 'aria-label': 'Language' }, ...LANGS.map(l => h('option', { value: l.id }, l.label)));
  const eolBtn = tool('LF', 'Line endings used when saving: click to switch');
  const tabs = h('div', { class: 'npp-tabs', role: 'tablist', 'aria-label': 'Open files' });
  const host = h('div', { class: 'npp-editor' });
  const previewPane = h('div', { class: 'npp-preview md', 'aria-label': 'Markdown preview', tabindex: '0', hidden: true });
  const status = h('div', { class: 'statusbar npp-status', role: 'status' });

  // Find in files
  const fQuery = h('input', { type: 'text', class: 'field', 'aria-label': 'Find in files', placeholder: 'Find', spellcheck: false });
  const fReplace = h('input', { type: 'text', class: 'field', 'aria-label': 'Replace with', placeholder: 'Replace with (open files)', spellcheck: false });
  const fCase = h('input', { type: 'checkbox' });
  const fRegex = h('input', { type: 'checkbox' });
  const fFolder = h('span', { class: 'npp-folder' }, '/Documents');
  const fFolderBtn = tool('Folder...', 'Choose the folder to search');
  const fGo = tool('Find all', 'Search the folder and every folder inside it');
  const fReplaceBtn = tool('Replace in open files', 'Replace every match in every open tab (each tab can be undone with Ctrl+Z)');
  const fClose = tool('×', 'Close (Escape)', { 'aria-label': 'Close find in files' });
  const fNote = h('div', { class: 'npp-found-note', role: 'status' });
  const fList = h('div', { class: 'npp-found', role: 'list' });
  const filesPanel = h('div', { class: 'npp-files', hidden: true },
    h('div', { class: 'find-row' }, fQuery, h('label', { class: 'find-case' }, fCase, 'Match case'), h('label', { class: 'find-case' }, fRegex, 'Pattern (regex)'), fClose),
    h('div', { class: 'find-row' }, fReplace, fReplaceBtn),
    h('div', { class: 'find-row' }, h('span', { class: 'npp-in' }, 'In'), fFolder, fFolderBtn, fGo),
    fNote, fList);

  app.root.replaceChildren(
    h('div', { class: 'toolbar npp-toolbar' }, newBtn, openBtn, saveBtn, saveAsBtn, h('span', { class: 'tool-gap' }), findBtn, filesBtn, markBtn,
      h('span', { class: 'tool-gap' }), wrapBtn, spaceBtn, previewBtn, zoomOut, zoomIn, h('span', { class: 'tool-gap' }), langSelect, eolBtn),
    tabs, h('div', { class: 'npp-main' }, host, previewPane), filesPanel, status);

  // ---- One editor view; each tab keeps its own state ----
  const keys = cm.keymap.of([
    { key: 'Mod-s', run: () => (void save(), true) },
    { key: 'Mod-Shift-s', run: () => (void saveAs(), true) },
    { key: 'Mod-o', run: () => (void openPicked(), true) },
    { key: 'Mod-n', run: () => (newTab(), true) },
    { key: 'Mod-w', run: () => (active && void closeTab(active), true) },
    { key: 'Mod-h', run: cm.openSearchPanel },
    { key: 'Mod-g', run: cm.gotoLine },
    { key: 'Mod-F2', run: () => (toggleBookmark(), true) },
    { key: 'F2', run: () => (jumpMark(1), true) },
    { key: 'Shift-F2', run: () => (jumpMark(-1), true) },
    { key: 'Mod-PageDown', run: () => (cycle(1), true) },
    { key: 'Mod-PageUp', run: () => (cycle(-1), true) },
  ]);

  function extensions(lang: string) {
    return [
      keys,
      cm.lineNumbers(), cm.highlightActiveLineGutter(), cm.gutter({ class: 'npp-marks', markers: (v: any) => v.state.field(marks) }),
      cm.foldGutter(), cm.highlightSpecialChars(), cm.history(), cm.drawSelection(), cm.dropCursor(), cm.indentOnInput(),
      cm.syntaxHighlighting(cm.defaultHighlightStyle, { fallback: true }), cm.bracketMatching(), cm.closeBrackets(),
      cm.rectangularSelection(), cm.crosshairCursor(), cm.highlightActiveLine(), cm.highlightSelectionMatches(),
      cm.search({ top: true }), marks, markDecos,
      cm.keymap.of([...cm.closeBracketsKeymap, ...cm.defaultKeymap, ...cm.searchKeymap, ...cm.historyKeymap, ...cm.foldKeymap, cm.indentWithTab]),
      langBox.of(langById(lang).make(cm)),
      wrapBox.of(wrap ? cm.EditorView.lineWrapping : []),
      spaceBox.of(spaces ? cm.highlightWhitespace() : []),
      zoomBox.of(fontTheme(zoom)),
      cm.EditorView.updateListener.of((u: any) => {
        if (u.docChanged || u.selectionSet) refresh(u.docChanged);
      }),
      cm.EditorView.contentAttributes.of({ 'aria-label': 'Text', spellcheck: 'false', autocapitalize: 'off' }),
    ];
  }

  const view = new cm.EditorView({ parent: host, state: cm.EditorState.create({ doc: '', extensions: extensions('text') }) });
  app.signal.addEventListener('abort', () => view.destroy(), { once: true });
  host.hidden = true;

  const isDirty = (d: Doc) => {
    const state = d === active ? view.state : d.state;
    return !state.doc.eq(d.saved) || d.eol !== d.savedEol;
  };

  // ---- Markdown preview ----
  let mdParser: MarkdownParser | null = null;
  let previewTimer = 0;
  function renderPreview() {
    const show = !!active && active.lang === 'markdown' && preview;
    previewPane.hidden = !show;
    previewBtn.disabled = !active || active.lang !== 'markdown';
    if (!show) return;
    mdParser ??= cm.markdownParser.configure(cm.GFM) as MarkdownParser;
    const scroll = previewPane.scrollTop;
    previewPane.replaceChildren(toDom(renderMarkdown(view.state.doc.toString(), mdParser), document));
    previewPane.scrollTop = scroll;
  }

  function refresh(changed = false) {
    const d = active;
    app.setDirty(docs.some(isDirty));
    for (const doc of docs) doc.tab.classList.toggle('dirty', isDirty(doc));
    if (!d) {
      status.textContent = 'No file open. Press New or Open.';
      app.setTitle('Notepad Pro');
      return;
    }
    app.setTitle(`${d.name}${isDirty(d) ? ' *' : ''} - Notepad Pro`);
    const state = view.state;
    const sel = state.selection.main;
    const line = state.doc.lineAt(sel.head);
    const chosen = state.selection.ranges.reduce((n: number, r: any) => n + (r.to - r.from), 0);
    const count = markers(state).length;
    status.textContent = [
      `Ln ${line.number}, Col ${sel.head - line.from + 1}${chosen ? `, ${chosen} chosen` : ''}`,
      `${plural(state.doc.lines, 'line')}, ${formatSize(state.doc.length)}`,
      langById(d.lang).label, EOL_NAMES[d.eol], 'UTF-8', `${zoom}%`,
      count ? plural(count, 'bookmark') : '',
    ].filter(Boolean).join('  ·  ');
    eolBtn.textContent = d.eol === '\r\n' ? 'CRLF' : 'LF';
    langSelect.value = d.lang;
    if (changed && d.lang === 'markdown' && preview) {
      clearTimeout(previewTimer);
      previewTimer = window.setTimeout(renderPreview, 150);
    }
  }

  // ---- Tabs ----
  function makeTab(d: Doc): HTMLElement {
    const close = h('button', { type: 'button', class: 'npp-tab-x', title: 'Close (Ctrl+W)', 'aria-label': `Close ${d.name}` }, '×');
    const label = h('span', { class: 'npp-tab-name' }, d.name);
    const tab = h('div', { class: 'npp-tab', role: 'tab', tabindex: '-1', title: d.path ?? d.name }, label, close);
    on(tab, 'mousedown', (e: MouseEvent) => {
      if (e.button === 1) {
        e.preventDefault();
        void closeTab(d);
      }
    }, app.signal);
    on(tab, 'click', (e: MouseEvent) => {
      if (e.target !== close) activate(d);
    }, app.signal);
    on(close, 'click', () => void closeTab(d), app.signal);
    return tab;
  }

  function labelTab(d: Doc) {
    d.tab.querySelector('.npp-tab-name')!.textContent = d.name;
    d.tab.title = d.path ?? d.name;
    d.tab.querySelector('.npp-tab-x')!.setAttribute('aria-label', `Close ${d.name}`);
  }

  function activate(d: Doc) {
    if (active && active !== d) active.state = view.state;
    active = d;
    host.hidden = false;
    // Settings chosen while this tab was in the background apply now.
    view.setState(d.state);
    view.dispatch({ effects: [wrapBox.reconfigure(wrap ? cm.EditorView.lineWrapping : []), spaceBox.reconfigure(spaces ? cm.highlightWhitespace() : []), zoomBox.reconfigure(fontTheme(zoom))] });
    for (const doc of docs) {
      doc.tab.classList.toggle('active', doc === d);
      doc.tab.setAttribute('aria-selected', String(doc === d));
    }
    d.tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    refresh();
    renderPreview();
    view.focus();
  }

  function addDoc(text: string, path: string | null, name: string, modified = 0): Doc {
    const eol = detectEol(text, '\n');
    const lang = langFor(name).id;
    const state = cm.EditorState.create({ doc: toBox(text), extensions: extensions(lang) });
    const d: Doc = { id: nextId++, path, name, state, saved: state.doc, eol, savedEol: eol, modified, lang, tab: null as unknown as HTMLElement };
    d.tab = makeTab(d);
    docs.push(d);
    tabs.append(d.tab);
    activate(d);
    return d;
  }

  function newTab() {
    addDoc('', null, `new ${untitled++}.txt`);
  }

  async function openPath(path: string) {
    const already = docs.find(d => d.path === path);
    if (already) return activate(already);
    try {
      const entry = await shell.fs.stat(path);
      if (!entry || entry.kind !== 'file') throw new Error('gone');
      if (entry.size > MAX_BYTES) {
        await shell.dialogs.alert('Too big to open', `“${entry.name}” is ${formatSize(entry.size)}. Notepad Pro opens files up to ${formatSize(MAX_BYTES)}. It is safe where it is.`);
        return;
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await shell.fs.readFile(path));
      // An untouched empty "new" tab is replaced, as in Notepad++.
      const spare = docs.length === 1 && !docs[0].path && !isDirty(docs[0]) && view.state.doc.length === 0 ? docs[0] : null;
      addDoc(text, path, entry.name, entry.modified);
      if (spare) removeDoc(spare);
    } catch (error) {
      await shell.dialogs.alert('Could not open that', error instanceof TypeError
        ? `“${baseName(path)}” does not look like text, so it was not opened. It is safe where it is.`
        : 'That file is not there any more. It may have been moved or deleted.');
    }
  }

  async function openPicked() {
    const path = await pickFile(shell, { title: 'Open', folder: active?.path ? parentPath(active.path) : '/Documents' });
    if (path) await openPath(path);
  }

  function removeDoc(d: Doc) {
    const i = docs.indexOf(d);
    docs.splice(i, 1);
    d.tab.remove();
    if (active === d) {
      active = null;
      const next = docs[Math.min(i, docs.length - 1)];
      if (next) activate(next);
      else {
        host.hidden = true;
        previewPane.hidden = true;
        refresh();
      }
    } else refresh();
  }

  async function closeTab(d: Doc) {
    if (isDirty(d)) {
      activate(d);
      const answer = await shell.dialogs.ask<'save' | 'drop' | 'cancel'>({
        title: 'Not saved',
        text: `“${d.name}” has changes that are not saved.`,
        buttons: [
          { label: 'Save', value: 'save', primary: true },
          { label: 'Close without saving', value: 'drop', danger: true },
          { label: 'Cancel', value: 'cancel' },
        ],
        cancel: 'cancel',
      });
      if (answer === 'cancel') return;
      if (answer === 'save' && !(await save())) return;
    }
    removeDoc(d);
  }

  function cycle(dir: 1 | -1) {
    if (!active || docs.length < 2) return;
    activate(docs[(docs.indexOf(active) + dir + docs.length) % docs.length]);
  }

  // ---- Saving ----
  const encoded = (d: Doc) => new TextEncoder().encode(toFile(view.state.doc.toString(), d.eol));

  async function saveAs(): Promise<boolean> {
    const d = active;
    if (!d) return false;
    const target = await pickSave(shell, { title: 'Save as', folder: d.path ? parentPath(d.path) : '/Documents', name: d.name });
    if (!target) return false;
    try {
      const entry = await shell.fs.writeFile(target.path, encoded(d), target.replace ? {} : { mustBeNew: true });
      d.path = target.path;
      d.name = entry.name;
      d.modified = entry.modified;
      const lang = langFor(entry.name).id;
      if (lang !== d.lang) setLang(lang);
      markSaved(d);
      labelTab(d);
      shell.toast(`Saved “${entry.name}”.`);
      return true;
    } catch (error) {
      await shell.report('Could not save', error);
      return false;
    }
  }

  async function save(): Promise<boolean> {
    const d = active;
    if (!d) return false;
    if (!d.path) return saveAs();
    try {
      const entry = await saveOver(shell, d.path, encoded(d), d.modified);
      if (!entry) return false;
      d.modified = entry.modified;
      markSaved(d);
      shell.toast(`Saved “${entry.name}”.`);
      return true;
    } catch (error) {
      await shell.report('Could not save', error);
      return false;
    }
  }

  function markSaved(d: Doc) {
    d.saved = view.state.doc;
    d.savedEol = d.eol;
    refresh();
  }

  function setLang(id: string) {
    if (!active) return;
    active.lang = id;
    view.dispatch({ effects: langBox.reconfigure(langById(id).make(cm)) });
    refresh();
    renderPreview();
  }

  // ---- Bookmarks ----
  function toggleBookmark() {
    if (!active) return;
    const line = view.state.doc.lineAt(view.state.selection.main.head);
    view.dispatch({ effects: toggleMark.of(line.from) });
    refresh();
  }
  function jumpMark(dir: 1 | -1) {
    if (!active) return;
    const all = markers(view.state);
    if (!all.length) return shell.toast('No bookmarks yet. Ctrl+F2 bookmarks a line.');
    const here = view.state.doc.lineAt(view.state.selection.main.head).from;
    const target = dir > 0 ? (all.find(p => p > here) ?? all[0]) : ([...all].reverse().find(p => p < here) ?? all[all.length - 1]);
    view.dispatch({ selection: { anchor: target }, scrollIntoView: true });
    view.focus();
  }

  // ---- Find in files ----
  let searching: AbortController | null = null;
  const findOptions = (): FindOptions => ({ matchCase: fCase.checked, regex: fRegex.checked });

  function openFiles() {
    filesPanel.hidden = false;
    const chosen = active ? view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to) : '';
    if (chosen && !chosen.includes('\n')) fQuery.value = chosen;
    if (active?.path && fFolder.textContent === '/Documents') fFolder.textContent = parentPath(active.path);
    fQuery.focus();
    fQuery.select();
  }

  async function findAll() {
    searching?.abort();
    const ctl = new AbortController();
    searching = ctl;
    app.signal.addEventListener('abort', () => ctl.abort(), { once: true });
    const query = fQuery.value;
    fList.replaceChildren();
    if (!query) {
      fNote.textContent = 'Type something to find.';
      return;
    }
    fNote.textContent = 'Searching...';
    fGo.disabled = true;
    try {
      const done = await findInFolder(shell.fs, fFolder.textContent!, query, findOptions(), ctl.signal, showFile);
      if (ctl.signal.aborted) return;
      const hits = done.results.reduce((n, f) => n + f.hits.length, 0);
      fNote.textContent = [
        hits ? `${plural(hits, 'match', 'matches')} in ${plural(done.results.length, 'file')}` : `Cannot find “${query}”`,
        `(${plural(done.files, 'text file')} searched${done.skipped ? `, ${done.skipped} skipped: too big or not text` : ''})`,
        done.stopped ?? '',
      ].filter(Boolean).join(' ');
    } catch (error) {
      fNote.textContent = error instanceof Error ? error.message : 'The search stopped.';
    } finally {
      fGo.disabled = false;
    }
  }

  function showFile(f: FileHits) {
    const group = h('div', { class: 'npp-found-file', role: 'listitem' }, h('div', { class: 'npp-found-path' }, `${f.path} (${f.hits.length})`));
    for (const hit of f.hits) {
      const row = h('button', { type: 'button', class: 'npp-found-hit' }, h('span', { class: 'npp-found-ln' }, `${hit.line}:`), h('span', {}, hit.text));
      on(row, 'click', () => void goTo(f.path, hit.start, hit.end), app.signal);
      group.append(row);
    }
    fList.append(group);
  }

  async function goTo(path: string, start: number, end: number) {
    await openPath(path);
    if (active?.path !== path) return;
    const len = view.state.doc.length;
    view.dispatch({ selection: { anchor: Math.min(start, len), head: Math.min(end, len) }, scrollIntoView: true });
    view.focus();
  }

  async function replaceOpen() {
    let re: RegExp;
    try {
      re = makePattern(fQuery.value, findOptions());
    } catch (error) {
      fNote.textContent = (error as Error).message;
      return;
    }
    if (!fQuery.value) {
      fNote.textContent = 'Type something to find.';
      return;
    }
    if (re.test('')) {
      fNote.textContent = 'That pattern can match nothing at all, so it would change every position. Make it match at least one letter.';
      return;
    }
    // In pattern mode "$1" puts back a bracketed part; in plain mode a "$" is just a dollar sign.
    const withText = fRegex.checked ? fReplace.value : fReplace.value.replace(/\$/g, '$$$$');
    const ok = await shell.dialogs.confirm({ title: 'Replace in open files', text: `Replace every “${fQuery.value}” with “${fReplace.value}” in all ${plural(docs.length, 'open tab')}? Each tab can be undone with Ctrl+Z.`, ok: 'Replace all' });
    if (!ok) return;
    if (active) active.state = view.state;
    let total = 0;
    let files = 0;
    for (const d of docs) {
      const text = d.state.doc.toString();
      re.lastIndex = 0;
      const n = [...text.matchAll(re)].length;
      if (!n) continue;
      const next = text.replace(re, withText);
      total += n;
      files++;
      d.state = d.state.update({ changes: { from: 0, to: d.state.doc.length, insert: next } }).state;
    }
    if (active) view.setState(active.state);
    fNote.textContent = total ? `Replaced ${plural(total, 'match', 'matches')} in ${plural(files, 'tab')}. Nothing is saved until you save each tab.` : `Cannot find “${fQuery.value}” in the open tabs.`;
    refresh(true);
    renderPreview();
  }

  // ---- Wiring ----
  on(newBtn, 'click', newTab, app.signal);
  on(openBtn, 'click', () => void openPicked(), app.signal);
  on(saveBtn, 'click', () => void save(), app.signal);
  on(saveAsBtn, 'click', () => void saveAs(), app.signal);
  on(findBtn, 'click', () => active && (cm.openSearchPanel(view), true), app.signal);
  on(filesBtn, 'click', openFiles, app.signal);
  on(markBtn, 'click', () => (toggleBookmark(), view.focus()), app.signal);
  on(wrapBtn, 'click', () => {
    wrap = !wrap;
    wrapBtn.setAttribute('aria-pressed', String(wrap));
    view.dispatch({ effects: wrapBox.reconfigure(wrap ? cm.EditorView.lineWrapping : []) });
  }, app.signal);
  on(spaceBtn, 'click', () => {
    spaces = !spaces;
    spaceBtn.setAttribute('aria-pressed', String(spaces));
    view.dispatch({ effects: spaceBox.reconfigure(spaces ? cm.highlightWhitespace() : []) });
  }, app.signal);
  on(previewBtn, 'click', () => {
    preview = !preview;
    previewBtn.setAttribute('aria-pressed', String(preview));
    renderPreview();
  }, app.signal);
  const setZoom = (z: number) => {
    zoom = z;
    zoomOut.disabled = zoom === ZOOMS[0];
    zoomIn.disabled = zoom === ZOOMS[ZOOMS.length - 1];
    view.dispatch({ effects: zoomBox.reconfigure(fontTheme(zoom)) });
    refresh();
  };
  const step = (dir: 1 | -1) => {
    const i = ZOOMS.indexOf(zoom) + dir;
    if (i >= 0 && i < ZOOMS.length) setZoom(ZOOMS[i]);
  };
  on(zoomIn, 'click', () => step(1), app.signal);
  on(zoomOut, 'click', () => step(-1), app.signal);
  on(langSelect, 'change', () => setLang(langSelect.value), app.signal);
  on(eolBtn, 'click', () => {
    if (!active) return;
    active.eol = active.eol === '\n' ? '\r\n' : '\n';
    refresh();
    shell.toast(`“${active.name}” will save with ${EOL_NAMES[active.eol]} line endings.`);
  }, app.signal);
  on(fGo, 'click', () => void findAll(), app.signal);
  on(fReplaceBtn, 'click', () => void replaceOpen(), app.signal);
  on(fFolderBtn, 'click', async () => {
    const folder = await pickFolder(shell, { title: 'Search in folder', folder: fFolder.textContent ?? '/Documents' });
    if (folder) fFolder.textContent = folder;
  }, app.signal);
  on(fClose, 'click', () => {
    filesPanel.hidden = true;
    searching?.abort();
    view.focus();
  }, app.signal);
  on(fQuery, 'keydown', (e: KeyboardEvent) => e.key === 'Enter' && (e.preventDefault(), void findAll()), app.signal);
  on(filesPanel, 'keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      fClose.click();
    }
  }, app.signal);
  // Ctrl+Shift+F by the key's place on the keyboard, before the editor's own Ctrl+F sees it (with Shift held, some
  // keyboards and test drivers report "f", which the editor would read as plain Find).
  on(app.root, 'keydown', (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyF') {
      e.preventDefault();
      e.stopPropagation();
      openFiles();
    }
  }, app.signal, { capture: true });
  // Shortcuts that should work when the focus is outside the text (toolbar, tabs, find in files).
  on(app.root, 'keydown', (e: KeyboardEvent) => {
    if (host.contains(e.target as Node)) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    const act = (fn: () => void) => {
      e.preventDefault();
      fn();
    };
    if (ctrl && k === 's') act(() => void (e.shiftKey ? saveAs() : save()));
    else if (ctrl && k === 'o') act(() => void openPicked());
    else if (ctrl && k === 'n') act(newTab);
    else if (ctrl && (k === 'f' || k === 'h') && active) act(() => (view.focus(), cm.openSearchPanel(view)));
  }, app.signal);
  on(app.root, 'keydown', (e: KeyboardEvent) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && (e.key === '+' || e.key === '=')) (e.preventDefault(), step(1));
    else if (ctrl && e.key === '-') (e.preventDefault(), step(-1));
    else if (ctrl && e.key === '0') (e.preventDefault(), setZoom(100));
  }, app.signal);

  setZoom(100);
  if (arg) await openPath(arg);
  if (!docs.length) newTab();
}
