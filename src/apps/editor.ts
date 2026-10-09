// Notepad: plain text only. Opens a file (or starts an empty one), saves with Ctrl+S, and asks before losing changes.
// Find and Replace (Ctrl+F, Ctrl+H), Go to line (Ctrl+G), word wrap, zoom (Ctrl + and -), and a status bar with the
// line, column and the file's line endings, which are kept on save. It never shows anything as a page, so a .html
// file is just letters. If the file was changed elsewhere since it was opened, saving asks before replacing it.
// The app id stays "editor" so file types, the Terminal's "nano file" and saved sessions keep working.
import { h, on } from '../core/dom.ts';
import { formatSize } from '../core/format.ts';
import { baseName, joinPath, nameProblem, parentPath, uniqueName } from '../fs/names.ts';
import type { AppDef } from '../shell/types.ts';
import { detectEol, EOL_NAMES, findNext, lineCol, lineStart, replaceAll, toBox, toFile, type Eol } from './notepad/text.ts';
import { APPS } from './catalog.ts';
import { saveOver } from '../shell/savefile.ts';

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const ZOOMS = [50, 67, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300];

export const editorApp: AppDef = {
  ...APPS.editor,
  async launch(app, arg) {
    const shell = app.shell;
    let path: string | null = arg ?? null;
    let loadedModified = 0;
    let saved = '';
    let eol: Eol = '\n';
    let savedEol: Eol = '\n';
    let zoom = 100;
    app.root.classList.add('editor');

    const tool = (label: string, title: string, extra: Record<string, string> = {}) => h('button', { type: 'button', class: 'tool wide', title, ...extra }, label);
    const saveBtn = tool('Save', 'Save (Ctrl+S)');
    const saveAsBtn = tool('Save as...', 'Save a copy under another name (Ctrl+Shift+S)');
    const findBtn = tool('Find', 'Find (Ctrl+F)');
    const replaceBtn = tool('Replace', 'Find and replace (Ctrl+H)');
    const gotoBtn = tool('Go to', 'Go to line (Ctrl+G)');
    const wrapBtn = tool('Word wrap', 'Wrap long lines at the window edge', { 'aria-pressed': 'true' });
    const zoomOut = tool('−', 'Zoom out (Ctrl+-)', { 'aria-label': 'Zoom out' });
    const zoomIn = tool('+', 'Zoom in (Ctrl++)', { 'aria-label': 'Zoom in' });
    const eolBtn = tool('', 'Line endings used when saving: click to switch');
    const area = h('textarea', { class: 'editor-text', spellcheck: 'false', 'aria-label': 'Text', autocapitalize: 'off', wrap: 'soft' });

    // The find bar: shown by Find or Replace, hidden by Escape or ×.
    const findInput = h('input', { type: 'text', class: 'field', 'aria-label': 'Find', placeholder: 'Find', spellcheck: false });
    const replaceInput = h('input', { type: 'text', class: 'field', 'aria-label': 'Replace with', placeholder: 'Replace with', spellcheck: false });
    const caseBox = h('input', { type: 'checkbox' });
    const prevBtn = tool('Previous', 'Find previous (Shift+F3)');
    const nextBtn = tool('Next', 'Find next (F3)');
    const oneBtn = tool('Replace', 'Replace this one and find the next');
    const allBtn = tool('Replace all', 'Replace every match');
    const closeFind = tool('×', 'Close (Escape)', { 'aria-label': 'Close find' });
    const findNote = h('span', { class: 'find-note', role: 'status' });
    const replaceRow = h('div', { class: 'find-row' }, replaceInput, oneBtn, allBtn);
    const findBar = h('div', { class: 'find-bar', hidden: true },
      h('div', { class: 'find-row' }, findInput, prevBtn, nextBtn, h('label', { class: 'find-case' }, caseBox, 'Match case'), closeFind),
      replaceRow, findNote);

    const status = h('div', { class: 'statusbar editor-status', role: 'status' });
    app.root.append(
      h('div', { class: 'toolbar' }, saveBtn, saveAsBtn, h('span', { class: 'tool-gap' }), findBtn, replaceBtn, gotoBtn, h('span', { class: 'tool-gap' }), wrapBtn, zoomOut, zoomIn, eolBtn),
      findBar, area, status);

    const dirty = () => area.value !== saved || eol !== savedEol;
    const refresh = () => {
      app.setDirty(dirty());
      app.setTitle(path ? baseName(path) : 'Untitled');
      const { line, col } = lineCol(area.value, area.selectionStart);
      const lines = area.value.split('\n').length;
      const size = new TextEncoder().encode(toFile(area.value, eol)).length;
      status.textContent = `Ln ${line}, Col ${col}  ·  ${lines} line${lines === 1 ? '' : 's'}, ${formatSize(size)}  ·  ${EOL_NAMES[eol]}  ·  UTF-8  ·  ${zoom}%${dirty() ? '  ·  not saved' : ''}`;
      eolBtn.textContent = eol === '\r\n' ? 'CRLF' : 'LF';
    };
    const setZoom = (z: number) => {
      zoom = z;
      area.style.fontSize = `${(14 * zoom) / 100}px`;
      zoomOut.disabled = zoom === ZOOMS[0];
      zoomIn.disabled = zoom === ZOOMS[ZOOMS.length - 1];
      refresh();
    };
    const step = (dir: 1 | -1) => {
      const i = ZOOMS.indexOf(zoom) + dir;
      if (i >= 0 && i < ZOOMS.length) setZoom(ZOOMS[i]);
    };

    if (path) {
      try {
        const entry = await shell.fs.stat(path);
        if (!entry || entry.kind !== 'file') throw new Error('gone');
        if (entry.size > MAX_TEXT_BYTES) {
          area.disabled = true;
          status.textContent = `This file is ${formatSize(entry.size)}. Notepad opens text up to ${formatSize(MAX_TEXT_BYTES)}. It is safe where it is.`;
          saveBtn.disabled = saveAsBtn.disabled = true;
          return;
        }
        const bytes = await shell.fs.readFile(path);
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        eol = savedEol = detectEol(text, '\n');
        area.value = toBox(text);
        saved = area.value;
        loadedModified = entry.modified;
      } catch (error) {
        area.disabled = true;
        saveBtn.disabled = saveAsBtn.disabled = true;
        status.textContent = error instanceof TypeError
          ? 'This file does not look like text, so it was not opened. It is safe where it is.'
          : 'That file is not there any more. It may have been moved or deleted.';
        return;
      }
    }
    setZoom(100);

    const encoded = () => new TextEncoder().encode(toFile(area.value, eol));
    const markSaved = (modified: number) => {
      loadedModified = modified;
      saved = area.value;
      savedEol = eol;
      refresh();
    };

    async function saveAs(): Promise<boolean> {
      const folder = path ? parentPath(path) : '/Documents';
      let taken: string[] = [];
      try {
        taken = (await shell.fs.list(folder, true)).map(e => e.name);
      } catch {
        // The folder is gone; saving will say so.
      }
      const name = await shell.dialogs.prompt({
        title: 'Save as',
        label: `Name (saved in ${folder})`,
        value: uniqueName(path ? baseName(path) : 'Untitled.txt', taken),
        ok: 'Save',
        selectStem: true,
        check: v => nameProblem(v) ?? (taken.some(t => t.toLowerCase() === v.toLowerCase()) ? `There is already something called "${v}" here.` : null),
      });
      if (name === null) return false;
      try {
        const entry = await shell.fs.writeFile(joinPath(folder, name), encoded(), { mustBeNew: true });
        path = joinPath(folder, entry.name);
        markSaved(entry.modified);
        shell.toast(`Saved “${entry.name}”.`);
        return true;
      } catch (error) {
        await shell.report('Could not save', error);
        return false;
      }
    }

    async function save(): Promise<boolean> {
      if (!path) return saveAs();
      try {
        const entry = await saveOver(shell, path, encoded(), loadedModified);
        if (!entry) return false;
        markSaved(entry.modified);
        shell.toast(`Saved “${entry.name}”.`);
        return true;
      } catch (error) {
        await shell.report('Could not save', error);
        return false;
      }
    }

    /** Puts text in place of the selection so Ctrl+Z can take it back (setting .value would wipe the undo list). */
    const typeOver = (start: number, end: number, text: string) => {
      area.focus();
      area.setSelectionRange(start, end);
      if (!document.execCommand('insertText', false, text)) area.setRangeText(text, start, end, 'end');
      refresh();
    };
    const select = (start: number, end: number) => {
      area.focus();
      area.setSelectionRange(start, end);
      // Bring the selection into view: a blur and focus makes the browser scroll to the caret.
      area.blur();
      area.focus();
      refresh();
    };

    const openFind = (replace: boolean) => {
      findBar.hidden = false;
      replaceRow.hidden = !replace;
      const chosen = area.value.slice(area.selectionStart, area.selectionEnd);
      if (chosen && !chosen.includes('\n')) findInput.value = chosen;
      findInput.focus();
      findInput.select();
      findNote.textContent = '';
    };
    const find = (backwards = false): boolean => {
      const query = findInput.value;
      const from = backwards ? area.selectionStart : area.selectionEnd;
      const hit = findNext(area.value, query, from, { matchCase: caseBox.checked, backwards });
      if (!hit) {
        findNote.textContent = query ? `Cannot find “${query}”.` : 'Type something to find.';
        return false;
      }
      findNote.textContent = hit.wrapped ? (backwards ? 'Went round to the end.' : 'Went round to the start.') : '';
      select(hit.start, hit.end);
      return true;
    };
    const selectionMatches = () => {
      const chosen = area.value.slice(area.selectionStart, area.selectionEnd);
      return findInput.value !== '' && (caseBox.checked ? chosen === findInput.value : chosen.toLowerCase() === findInput.value.toLowerCase());
    };
    const replaceOne = () => {
      if (selectionMatches()) typeOver(area.selectionStart, area.selectionEnd, replaceInput.value);
      find();
    };
    const replaceEvery = () => {
      const { text, count } = replaceAll(area.value, findInput.value, replaceInput.value, caseBox.checked);
      if (count > 0) typeOver(0, area.value.length, text);
      findNote.textContent = count ? `Replaced ${count} match${count === 1 ? '' : 'es'}. Ctrl+Z undoes it.` : `Cannot find “${findInput.value}”.`;
    };

    async function goToLine() {
      const lines = area.value.split('\n').length;
      const answer = await shell.dialogs.prompt({
        title: 'Go to line',
        label: `Line number (1 to ${lines})`,
        value: String(lineCol(area.value, area.selectionStart).line),
        ok: 'Go to',
        check: v => (/^\d+$/.test(v.trim()) && +v >= 1 && +v <= lines ? null : `Type a whole number from 1 to ${lines}.`),
      });
      if (answer === null) return area.focus();
      const at = lineStart(area.value, +answer);
      select(at, at);
    }

    on(area, 'input', refresh, app.signal);
    for (const type of ['keyup', 'click', 'select'] as const) on(area, type, refresh, app.signal);
    on(saveBtn, 'click', () => void save(), app.signal);
    on(saveAsBtn, 'click', () => void saveAs(), app.signal);
    on(findBtn, 'click', () => openFind(false), app.signal);
    on(replaceBtn, 'click', () => openFind(true), app.signal);
    on(gotoBtn, 'click', () => void goToLine(), app.signal);
    on(nextBtn, 'click', () => find(), app.signal);
    on(prevBtn, 'click', () => find(true), app.signal);
    on(oneBtn, 'click', replaceOne, app.signal);
    on(allBtn, 'click', replaceEvery, app.signal);
    on(closeFind, 'click', () => { findBar.hidden = true; area.focus(); }, app.signal);
    on(findInput, 'keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        find(event.shiftKey);
        findInput.focus();
      }
    }, app.signal);
    on(replaceInput, 'keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        replaceOne();
        replaceInput.focus();
      }
    }, app.signal);
    on(findBar, 'keydown', (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        findBar.hidden = true;
        area.focus();
      }
    }, app.signal);
    on(wrapBtn, 'click', () => {
      const wrap = wrapBtn.getAttribute('aria-pressed') !== 'true';
      wrapBtn.setAttribute('aria-pressed', String(wrap));
      area.setAttribute('wrap', wrap ? 'soft' : 'off');
    }, app.signal);
    on(zoomIn, 'click', () => step(1), app.signal);
    on(zoomOut, 'click', () => step(-1), app.signal);
    on(eolBtn, 'click', () => {
      eol = eol === '\n' ? '\r\n' : '\n';
      refresh();
      shell.toast(`Will save with ${EOL_NAMES[eol]} line endings.`);
    }, app.signal);
    on(app.root, 'keydown', (event: KeyboardEvent) => {
      const ctrl = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      const act = (run: () => void) => {
        event.preventDefault();
        run();
      };
      if (ctrl && key === 's') act(() => void (event.shiftKey ? saveAs() : save()));
      else if (ctrl && key === 'f') act(() => openFind(false));
      else if (ctrl && key === 'h') act(() => openFind(true));
      else if (ctrl && key === 'g') act(() => void goToLine());
      else if (ctrl && (key === '+' || key === '=')) act(() => step(1));
      else if (ctrl && key === '-') act(() => step(-1));
      else if (ctrl && key === '0') act(() => setZoom(100));
      else if (event.key === 'Escape' && !findBar.hidden) act(() => { findBar.hidden = true; area.focus(); });
      else if (event.key === 'F3') act(() => (findInput.value ? find(event.shiftKey) : openFind(false)));
    }, app.signal);
    area.focus();
  },
};
