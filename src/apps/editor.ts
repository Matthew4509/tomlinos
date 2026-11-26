// Quick Notes: plain text only. Opens a file (or starts an empty one), saves with Ctrl+S, and asks before losing changes.
// File > Open and Save as use the desktop's own Open and Save windows.
// Tab types a tab (Escape then Tab, or Shift+Tab, moves on). Find and Replace (Ctrl+F, Ctrl+H), Go to line (Ctrl+G), word wrap, zoom (Ctrl + and -), and a status bar with the
// line, column and the file's line endings, which are kept on save. It never shows anything as a page, so a .html
// file is just letters. If the file was changed elsewhere since it was opened, saving asks before replacing it.
// The app id stays "editor" so file types, the Terminal's "nano file" and saved sessions keep working.
import { h, on } from '../core/dom.ts';
import { formatSize } from '../core/format.ts';
import { baseName, nameKey, parentPath } from '../fs/names.ts';
import { pickFile, pickSave, type FileTypeChoice } from '../shell/filepicker.ts';
import type { AppDef } from '../shell/types.ts';
import {
  cannotHold, decodeFile, detectEol, encodedSize, encodeFile, ENCODING_NAMES, EOL_NAMES, fileSize, findNext, keptEndings, lineCol, lineEndings, lineStart,
  replaceAll, sameMatch, toBox, toFile, withEndings, type Encoding, type Eol,
} from './notepad/text.ts';
import { APPS } from './catalog.ts';
import { saveOver } from '../shell/savefile.ts';
import { classicBar } from '../shell/menubar.ts';
import { describeError } from '../shell/dialogs.ts';
import { helpMenu, textBoxEdits } from './classic-menus.ts';

// One limit for opening and saving (the same as Notepad Pro's), so Quick Notes never saves a file it then refuses to open.
/** The file was not there (as against a read that failed). */
class GoneError extends Error {}

const MAX_TEXT_BYTES = 5 * 1024 * 1024;
/** What the Save as window offers; the path it gives back already ends in the chosen kind's extension. */
const SAVE_TYPES: FileTypeChoice[] = [
  { label: 'Text document', ext: ['txt'] },
  { label: 'Markdown', ext: ['md'] },
  { label: 'Log file', ext: ['log'] },
  { label: 'CSV', ext: ['csv'] },
  { label: 'All files', ext: [] },
];
// Open starts on All files: Quick Notes opens any text, .json, .ini, .ics and files with no ending among them.
const OPEN_TYPES: FileTypeChoice[] = [{ label: 'All files', ext: [] }, { label: 'Text files', ext: ['txt', 'md', 'log', 'csv'] }, ...SAVE_TYPES.slice(0, -1)];
const ZOOMS = [50, 67, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300];
const EOL_SHORT: Record<Eol, string> = { '\r\n': 'CRLF', '\n': 'LF', '\r': 'CR' };

export const editorApp: AppDef = {
  ...APPS.editor,
  async launch(app, arg) {
    const shell = app.shell;
    let path: string | null = arg ?? null;
    let loadedId = '';
    let saved = '';
    let eol: Eol = '\n';
    let savedEol: Eol = '\n';
    /** The file began with the UTF-8 mark (a BOM): it goes back on saving. */
    let bom = false;
    /** How the file stores its letters; it is saved back the same way. */
    let encoding: Encoding = 'utf-8';
    /**
     * A file with mixed line endings: the text it was opened (or last saved) with and each of its lines' endings, so
     * each line keeps its own on save. Null once the person picks one kind under Line endings (or the file has one kind).
     */
    let mixed: { text: string; ends: Eol[] } | null = null;
    let savedMixed = false;
    let zoom = 100;
    app.root.classList.add('editor');

    const tool = (label: string, title: string, extra: Record<string, string> = {}) => h('button', { type: 'button', class: 'tool wide', title, ...extra }, label);
    /** False when the file could not be opened: there is no text for the menus to work on. */
    let usable = true;
    let wrapOn = true;
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

    // The menu bar: File, Edit, View, Format, Help. Every command the old button row had is in a menu.
    const can = () => usable;
    const setWrap = (wrap: boolean) => {
      wrapOn = wrap;
      area.setAttribute('wrap', wrap ? 'soft' : 'off');
    };
    const setEol = (to: Eol) => {
      eol = to;
      mixed = null;
      refresh();
      shell.toast(`Will save with ${EOL_NAMES[eol]} line endings.`);
    };
    const EOLS: Eol[] = ['\r\n', '\n', '\r'];
    const bar = classicBar({
      menus: [
        { label: 'File', items: [
          { label: 'New', icon: 'new', shortcut: 'Alt+N', action: () => void shell.openApp('editor') },
          { label: 'Open...', icon: 'open', shortcut: 'Ctrl+O', action: () => void openPicked() },
          { separator: true },
          { label: 'Save', icon: 'save', shortcut: 'Ctrl+S', enabled: can, action: () => void save() },
          { label: 'Save as...', icon: 'save-as', shortcut: 'Ctrl+Shift+S', enabled: can, action: () => void saveAs() },
          { separator: true },
          { label: 'Close', icon: 'close', shortcut: 'Alt+Q', action: () => app.close() },
        ] },
        { label: 'Edit', items: () => [
          ...textBoxEdits(() => area, can),
          { separator: true },
          { label: 'Find...', icon: 'find', shortcut: 'Ctrl+F', enabled: can, action: () => openFind(false) },
          { label: 'Find next', shortcut: 'F3', enabled: () => usable && findInput.value !== '', action: () => find() },
          { label: 'Find previous', shortcut: 'Shift+F3', enabled: () => usable && findInput.value !== '', action: () => find(true) },
          { label: 'Replace...', icon: 'replace', shortcut: 'Ctrl+H', enabled: can, action: () => openFind(true) },
          { label: 'Go to line...', shortcut: 'Ctrl+G', enabled: can, action: () => void goToLine() },
        ] },
        { label: 'View', items: [
          { label: 'Zoom in', icon: 'zoom-in', shortcut: 'Ctrl++', enabled: () => usable && zoom < ZOOMS[ZOOMS.length - 1], action: () => step(1) },
          { label: 'Zoom out', icon: 'zoom-out', shortcut: 'Ctrl+-', enabled: () => usable && zoom > ZOOMS[0], action: () => step(-1) },
          { label: 'Normal size (100%)', shortcut: 'Ctrl+0', enabled: () => usable && zoom !== 100, action: () => setZoom(100) },
        ] },
        { label: 'Format', items: [
          { label: 'Word wrap', checked: () => wrapOn, enabled: can, action: () => setWrap(!wrapOn) },
          { separator: true },
          { label: 'Line endings when saving', enabled: can, submenu: () => EOLS.map(e => ({ label: `${EOL_NAMES[e]} (${EOL_SHORT[e]})`, checked: () => !mixed && eol === e, action: () => setEol(e) })) },
        ] },
        helpMenu(shell),
      ],
    }, { layer: shell.menus, signal: app.signal, scope: app.root, doc: () => (findBar.contains(document.activeElement) ? null : area), label: 'Quick Notes menu bar' });
    app.root.append(bar.el, findBar, area, status);

    const dirty = () => area.value !== saved || eol !== savedEol || !!mixed !== savedMixed;
    /** The text as the file will hold it: each line's ending in place. */
    const fileText = (text: string) => (mixed ? withEndings(text, keptEndings(text, mixed.text, mixed.ends, eol), eol) : toFile(text, eol));
    const drawStatus = () => {
      const text = area.value;
      const { line, col } = lineCol(text, area.selectionStart);
      const lines = text.split('\n').length;
      const size = !mixed && encoding === 'utf-8' ? fileSize(text, eol, bom) : encodedSize(fileText(text), encoding, bom);
      const ends = mixed ? 'Mixed line endings' : EOL_NAMES[eol];
      status.textContent = `Ln ${line}, Col ${col}  ·  ${lines} line${lines === 1 ? '' : 's'}, ${formatSize(size)}  ·  ${ends}  ·  ${ENCODING_NAMES[encoding]}  ·  ${zoom}%${dirty() ? '  ·  not saved' : ''}`;
    };
    // Counting lines and bytes goes over the whole text, and even reading a long text box's text back costs the browser
    // milliseconds, so in a long file a key only marks the window changed (at once: the close guard needs it), and the
    // exact check and the status bar follow once typing pauses.
    let statusTimer = 0;
    let long = false;
    app.signal.addEventListener('abort', () => clearTimeout(statusTimer), { once: true });
    const settle = () => {
      app.setDirty(dirty());
      drawStatus();
      long = area.value.length > 200_000;
    };
    const refresh = (event?: Event) => {
      app.setTitle(path ? baseName(path) : 'Untitled');
      clearTimeout(statusTimer);
      if (!long || !event) return settle(); // a save, zoom or line-ending switch shows at once
      if (event?.type === 'input') app.setDirty(true);
      statusTimer = window.setTimeout(settle, 150);
    };
    const setZoom = (z: number) => {
      zoom = z;
      area.style.fontSize = `${(14 * zoom) / 100}px`;
      refresh();
    };
    const step = (dir: 1 | -1) => {
      const i = ZOOMS.indexOf(zoom) + dir;
      if (i >= 0 && i < ZOOMS.length) setZoom(ZOOMS[i]);
    };

    /** Why the file could not be opened; the window then keeps only Open, New and Close working. */
    let refused = '';
    if (path) {
      // Nothing can be typed until the file is in: typing now would be thrown away when it arrives.
      area.readOnly = true;
      status.textContent = 'Opening...';
      try {
        const entry = await shell.fs.stat(path);
        if (!entry || entry.kind !== 'file') throw new GoneError();
        if (entry.size > MAX_TEXT_BYTES) {
          refused = `This file is ${formatSize(entry.size)}. Quick Notes opens text up to ${formatSize(MAX_TEXT_BYTES)}. It is safe where it is.`;
        } else {
          const bytes = await shell.fs.readFile(path);
          const file = decodeFile(bytes);
          if (!file) {
            refused = 'This file does not look like text, so it was not opened. It is safe where it is.';
          } else {
            bom = file.bom;
            encoding = file.encoding;
            eol = savedEol = detectEol(file.text, '\n');
            const ends = lineEndings(file.text);
            area.value = toBox(file.text);
            saved = area.value;
            if (ends) mixed = { text: saved, ends };
            savedMixed = !!mixed;
            loadedId = entry.id;
            area.readOnly = false;
            if (encoding === 'windows-1252') shell.toast('This file is not UTF-8, so it was opened as Windows-1252 (Western) text and is saved back that way.');
          }
        }
      } catch (error) {
        refused = error instanceof GoneError
          ? 'That file is not there any more. It may have been moved or deleted.'
          : `The file could not be read just now, so it was not opened. It is safe where it is: close this window and open it again. (${describeError(error)})`;
      }
    }
    if (refused) {
      area.disabled = true;
      // Every menu command that works on the text is off: there is no text to work on. Open, New and Close still work.
      usable = false;
      bar.refresh();
      if (path) app.setTitle(baseName(path));
      status.textContent = refused;
      // The keys (Ctrl+O, Alt+N) still reach the window: its inside takes the focus the disabled box cannot, also when clicked.
      app.root.tabIndex = -1;
      app.root.style.outline = 'none';
      app.root.focus({ preventScroll: true });
    } else setZoom(100);

    // What a save writes, taken when the save starts: typing while it is on its way stays unsaved (and marked so).
    const snapshot = () => {
      const text = area.value;
      const ends = mixed ? keptEndings(text, mixed.text, mixed.ends, eol) : null;
      return { text, eol, ends, bytes: encodeFile(ends ? withEndings(text, ends, eol) : toFile(text, eol), encoding, bom) };
    };
    const markSaved = (id: string, snap: { text: string; eol: Eol; ends: Eol[] | null }) => {
      loadedId = id;
      saved = snap.text;
      savedEol = snap.eol;
      // The endings just written are the file's own now (a line typed in the middle has the main kind).
      if (mixed && snap.ends) mixed = { text: snap.text, ends: snap.ends };
      savedMixed = !!mixed;
      refresh();
    };
    /** A Windows-1252 file that now holds a letter it cannot store: asks to save it as UTF-8 instead. */
    async function encodingFits(): Promise<boolean> {
      const odd = cannotHold(area.value, encoding);
      if (odd === null) return true;
      const yes = await shell.dialogs.confirm({
        title: 'Save as UTF-8?',
        text: `This file is stored as ${ENCODING_NAMES[encoding]} (Western) text, which cannot hold “${odd}” and maybe other letters in it. Save it as UTF-8 instead? Older programs may show its accents differently.`,
        ok: 'Save as UTF-8',
      });
      if (!yes) return false;
      encoding = 'utf-8';
      bom = false;
      return true;
    }

    // One save at a time: a second Save while the first is on its way waits for it (so it replaces the copy the first one
    // made), and a second Save while the Save as box is up does nothing.
    let busy: Promise<boolean> | null = null;
    let naming = false;
    const once = (run: () => Promise<boolean>): Promise<boolean> => {
      if (naming) return busy ?? Promise.resolve(false);
      const next = (busy ?? Promise.resolve(true)).then(run, run);
      busy = next;
      void next.finally(() => busy === next && (busy = null));
      return next;
    };
    // A window whose file was not opened has no text to save: saving would write an empty box over the file.
    const saveAs = () => (usable ? once(saveAsNow) : Promise.resolve(false));
    const save = () => (usable ? once(() => (path ? saveNow() : saveAsNow())) : Promise.resolve(false));
    app.onSave?.(save);

    /** Says so, before anything is written or a name asked for, when the text is more than Quick Notes opens. */
    async function tooBig(bytes: number): Promise<boolean> {
      if (bytes <= MAX_TEXT_BYTES) return false;
      await shell.dialogs.alert('Too big to save', `This text would make a file of ${formatSize(bytes)}. Quick Notes saves and opens text up to ${formatSize(MAX_TEXT_BYTES)}, so it was not saved. The text is still here: make it shorter, or split it into more than one file.`);
      return true;
    }

    async function saveAsNow(): Promise<boolean> {
      if (!(await encodingFits())) return false;
      if (await tooBig(snapshot().bytes.length)) return false;
      naming = true;
      const target = await pickSave(shell, {
        title: 'Save as',
        folder: path ? parentPath(path) : '/Documents',
        name: path ? baseName(path) : 'Untitled.txt',
        ok: 'Save',
        types: SAVE_TYPES,
      }).finally(() => (naming = false));
      if (!target) return false;
      // Save as onto this window's own file is a Save: it asks first when the file was changed somewhere else.
      if (path && target.replace && nameKey(target.path) === nameKey(path)) return saveNow();
      try {
        const snap = snapshot();
        if (await tooBig(snap.bytes.length)) return false;
        const entry = await shell.fs.writeFile(target.path, snap.bytes, target.replace ? {} : { mustBeNew: true });
        path = target.path;
        app.setPath?.(path);
        markSaved(entry.id, snap);
        shell.toast(`Saved “${entry.name}”.`);
        return true;
      } catch (error) {
        await shell.report('Could not save', error);
        return false;
      }
    }

    async function saveNow(): Promise<boolean> {
      if (!path) return saveAsNow();
      if (!(await encodingFits())) return false;
      try {
        const snap = snapshot();
        if (await tooBig(snap.bytes.length)) return false;
        const entry = await saveOver(shell, path, snap.bytes, loadedId);
        if (!entry) return false;
        markSaved(entry.id, snap);
        shell.toast(`Saved “${entry.name}”.`);
        return true;
      } catch (error) {
        await shell.report('Could not save', error);
        return false;
      }
    }

    async function openPicked(): Promise<void> {
      const picked = await pickFile(shell, { title: 'Open', folder: path ? parentPath(path) : '/Documents', ok: 'Open', types: OPEN_TYPES });
      if (!picked) return;
      const blank = () => !path && usable && area.value === '' && !dirty();
      const takeOver = blank();
      await shell.openApp('editor', picked);
      if (takeOver && blank()) app.close();
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
      scrollToCaret(start);
      refresh();
    };
    /**
     * Scrolls the text box so `at` is in view. A textarea does not scroll to a selection set from code (blur and focus
     * did in some browsers only), so a hidden copy of the box, laid out the same, finds how far down it is.
     */
    const scrollToCaret = (at: number) => {
      const style = getComputedStyle(area);
      const lineHeight = parseFloat(style.lineHeight) || 20;
      const wrapOff = area.getAttribute('wrap') === 'off';
      const value = area.value;
      /** Lays out `before`, a mark, then `after` in a hidden copy of the box: where the mark sits, and the copy's height. */
      const measure = (before: string, after: string) => {
        const mirror = h('div', { 'aria-hidden': 'true' });
        Object.assign(mirror.style, {
          position: 'absolute', visibility: 'hidden', top: '0', left: '-99999px', boxSizing: style.boxSizing,
          width: `${area.clientWidth}px`, padding: style.padding, font: style.font, lineHeight: style.lineHeight,
          letterSpacing: style.letterSpacing, tabSize: style.tabSize,
          whiteSpace: wrapOff ? 'pre' : 'pre-wrap', overflowWrap: 'break-word',
        });
        const mark = h('span', {}, '​');
        // A box shows an empty last line after a closing line break; a copy needs a letter there to do the same.
        mirror.append(document.createTextNode(before), mark, document.createTextNode(after.endsWith('\n') ? `${after}​` : after));
        document.body.append(mirror);
        const spot = { top: mark.offsetTop, left: mark.offsetLeft, height: mirror.offsetHeight };
        mirror.remove();
        return spot;
      };
      // Laying out a long text costs the browser about a second per 5 MB, so only the shorter side of the caret is laid out.
      let top: number;
      let left = 0;
      const lineAt = value.lastIndexOf('\n', at - 1) + 1;
      if (wrapOff) {
        // No wrapping: every line is one line high, so only the caret's own line is laid out (for how far across).
        let lines = 0;
        for (let i = value.indexOf('\n'); i >= 0 && i < at; i = value.indexOf('\n', i + 1)) lines++;
        top = (parseFloat(style.paddingTop) || 0) + lines * lineHeight;
        left = measure(value.slice(lineAt, at), '').left;
      } else if (at <= value.length / 2) {
        top = measure(value.slice(0, at), '').top;
      } else {
        // From the end: the copy holds the text after the caret (from its line's start when that is near, so the rows
        // break as in the box; a very long line starting mid-way may be one row out, still in view), and the caret is
        // that far above the bottom of the box's own text.
        const from = at - lineAt <= 10_000 ? lineAt : at;
        const spot = measure(value.slice(from, at), value.slice(at));
        top = area.scrollHeight - spot.height + spot.top;
      }
      if (top < area.scrollTop || top + lineHeight > area.scrollTop + area.clientHeight) area.scrollTop = Math.max(0, top - area.clientHeight / 2);
      if (area.getAttribute('wrap') === 'off' && (left < area.scrollLeft || left > area.scrollLeft + area.clientWidth - 20)) area.scrollLeft = Math.max(0, left - area.clientWidth / 2);
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
      return findInput.value !== '' && sameMatch(chosen, findInput.value, caseBox.checked);
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

    // Tab types a tab (undone by Ctrl+Z). The keyboard way out of the text: Escape, then Tab; Shift+Tab also leaves.
    let leaving = false;
    on(area, 'keydown', (event: KeyboardEvent) => {
      const plainTab = event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;
      if (plainTab && !leaving) {
        event.preventDefault();
        typeOver(area.selectionStart, area.selectionEnd, '\t');
      }
      leaving = event.key === 'Escape';
    }, app.signal);
    on(area, 'blur', () => (leaving = false), app.signal);
    on(area, 'input', refresh, app.signal);
    for (const type of ['keyup', 'click', 'select'] as const) on(area, type, refresh, app.signal);
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
    on(app.root, 'keydown', (event: KeyboardEvent) => {
      const ctrl = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      const act = (run: () => void) => {
        event.preventDefault();
        run();
      };
      // A window whose file was not opened still takes Open and New (and Close, from the window).
      if (!usable && !(ctrl && key === 'o') && !(event.code === 'KeyN' || key === 'n')) return;
      if (ctrl && key === 's') act(() => void (event.shiftKey ? saveAs() : save()));
      else if (ctrl && !event.shiftKey && key === 'o') act(() => void openPicked());
      // Alt+N is the one shown: a browser keeps Ctrl+N, which still works where a browser passes it on.
      else if (!event.shiftKey && ((event.altKey && !ctrl && event.code === 'KeyN') || (ctrl && !event.altKey && key === 'n'))) act(() => void shell.openApp('editor'));
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
