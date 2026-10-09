// RISC-V Studio: a programming tool for the RV32IM machine. Code on the left, the machine on the right (its
// 160 x 90 screen, what the program prints, its registers). File > Open and Save work on the desktop's own files
// (.s and .asm); the Examples menu loads the example RISC-V games. F5 runs, F6 pauses, F8 steps, F9 checks.
import { h, on } from '../core/dom.ts';
import { baseName, joinPath, nameProblem, parentPath } from '../fs/names.ts';
import type { AppDef, AppHandle } from '../shell/types.ts';
import { dosAlert, dosBox, DosMenuBar, dosPrompt, type DosItem } from './riscv/dos.ts';
import { EXAMPLES } from './riscv/examples.ts';
import { HELLO_SOURCE, LINUX_SOURCE } from './riscv/hello.ts';
import { tokenizeLine } from './riscv/highlight.ts';
import { KEY_BITS, Machine, PALETTE, PALETTE_NAMES, REGISTERS, SCREEN_H, SCREEN_W, SERVICES } from './riscv/machine.ts';
import { BASE_MNEMONICS, hex, PSEUDO_MNEMONICS } from './riscv/rv32i.ts';
import { APPS } from './catalog.ts';

const MAX_SOURCE_BYTES = 1024 * 1024;
const LINE_PX = 20;
const PAD_PX = 4;
const CODE_TYPES = ['s', 'asm'];

type Mark = 'error' | 'pc';

export const riscvApp: AppDef = {
  ...APPS.riscv,
  async launch(app, arg) {
    const studio = new Studio(app);
    await studio.start(arg);
  },
};

class Studio {
  private app: AppHandle;
  private machine = new Machine();
  private path: string | null = null;
  private name = 'UNTITLED.S';
  private saved = '';
  private loadedModified = 0;
  private assembledText: string | null = null;
  private keysNote = '';
  /** Loaded from the Examples menu and not saved anywhere yet. */
  private example = false;
  private findText = '';
  private folder = '/Documents';
  private marks = new Map<Mark, number>();
  private lineTexts: string[] = [];
  private lineEls: HTMLElement[] = [];
  private raf = 0;
  private lastPresented = -1;
  private lastState = '';
  private tab: 'output' | 'registers' | 'keys' = 'output';

  private area: HTMLTextAreaElement;
  private hl: HTMLElement;
  private marksEl: HTMLElement;
  private gutter: HTMLElement;
  private gutterInner: HTMLElement;
  private titleEl: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private image: ImageData;
  private screenBox: HTMLElement;
  private screenText: HTMLElement;
  private screenNote: HTMLElement;
  private badge: HTMLElement;
  private panel: HTMLElement;
  private tabs: HTMLButtonElement[];
  private statusLeft: HTMLElement;
  private statusPos: HTMLElement;
  private menu: DosMenuBar;
  private palette32: Uint32Array;

  constructor(app: AppHandle) {
    this.app = app;
    const signal = app.signal;
    app.root.classList.add('studio');

    this.area = h('textarea', { class: 'code-input', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', wrap: 'off', 'aria-label': 'Program code' });
    this.hl = h('div', { class: 'code-hl', 'aria-hidden': 'true' });
    this.marksEl = h('div', { class: 'code-marks', 'aria-hidden': 'true' });
    this.gutterInner = h('div', { class: 'code-gutter-inner' });
    this.gutter = h('div', { class: 'code-gutter', 'aria-hidden': 'true' }, this.gutterInner);
    this.titleEl = h('span', {}, ' UNTITLED.S ');
    const codePane = h(
      'section',
      { class: 'dos-pane studio-code' },
      h('div', { class: 'dos-pane-title' }, this.titleEl),
      h('div', { class: 'code-wrap' }, this.gutter, h('div', { class: 'code-area' }, this.marksEl, this.hl, this.area)),
    );

    this.canvas = h('canvas', { class: 'screen-canvas', width: SCREEN_W, height: SCREEN_H });
    this.ctx = this.canvas.getContext('2d')!;
    this.image = this.ctx.createImageData(SCREEN_W, SCREEN_H);
    this.palette32 = new Uint32Array(PALETTE.map(c => {
      const n = parseInt(c.slice(1), 16);
      return (0xff << 24) | ((n & 0xff) << 16) | (n & 0xff00) | (n >> 16);
    }));
    this.screenText = h('pre', { class: 'screen-text', hidden: true });
    this.screenNote = h('div', { class: 'screen-note' }, 'Screen off. Press F5 to run.');
    this.screenBox = h('div', { class: 'screen-box', tabindex: 0, role: 'application', 'aria-label': 'Program screen. While a program runs, keys typed here go to it. Escape goes back to the code.' }, this.canvas, this.screenText, this.screenNote);
    this.badge = h('span', { class: 'studio-badge' }, 'READY');
    const pad = this.buildTouchPad(signal);
    const big = h('button', { type: 'button', class: 'studio-full', title: 'Full screen game (Alt+Enter)', 'aria-label': 'Full screen game' }, '⛶ Full screen');
    on(big, 'click', () => void this.fullScreen(this.screenBox), signal);
    const screenPane = h('section', { class: 'dos-pane studio-screen' }, h('div', { class: 'dos-pane-title' }, h('span', {}, ' Screen '), this.badge, big), this.screenBox, pad);

    this.tabs = (['output', 'registers', 'keys'] as const).map(t => {
      const b = h('button', { type: 'button', class: 'studio-tab', role: 'tab', 'aria-selected': String(t === this.tab), 'data-tab': t }, t === 'output' ? 'Output' : t === 'registers' ? 'Registers' : 'Keys');
      on(b, 'click', () => this.showTab(t), signal);
      return b;
    });
    this.panel = h('pre', { class: 'studio-panel', role: 'tabpanel', tabindex: 0 });
    const infoPane = h('section', { class: 'dos-pane studio-info' }, h('div', { class: 'studio-tabs', role: 'tablist' }, ...this.tabs), this.panel);
    const side = h('div', { class: 'studio-side' }, screenPane, infoPane);

    this.statusLeft = h('span', { class: 'status-keys' }, 'F1 Help · F5 Run · F6 Pause · F8 Step · F9 Check · Esc Code');
    this.statusPos = h('span', { class: 'status-pos' }, '00001:001');
    const status = h('div', { class: 'dos-status', role: 'status' }, this.statusLeft, this.statusPos);

    this.menu = new DosMenuBar(app.root, this.menus(), () => this.area.focus(), signal);
    app.root.append(this.menu.el, h('div', { class: 'studio-main' }, codePane, side), status);

    this.wire(signal);
  }

  async start(arg?: string): Promise<void> {
    if (arg) await this.openPath(arg);
    else this.setSource(HELLO_SOURCE, null, 'HELLO.S', 'Runs by itself for about four seconds; no keys needed.', true);
    this.area.focus();
    this.area.setSelectionRange(0, 0);
  }

  // ---- Menus -------------------------------------------------------------------------------------------------------

  private menus() {
    const busy = () => this.machine.active;
    const file: DosItem[] = [
      { label: 'New Program', key: 'n', action: () => void this.newFile() },
      { label: 'Open Program...', key: 'o', hint: 'Ctrl+O', action: () => void this.openDialog() },
      { label: 'Save', key: 's', hint: 'Ctrl+S', action: () => void this.save() },
      { label: 'Save As...', key: 'a', hint: 'Ctrl+Shift+S', action: () => void this.saveAs() },
      { separator: true },
      { label: 'Exit', key: 'x', action: () => this.app.close() },
    ];
    const edit: DosItem[] = [
      { label: 'Undo', key: 'u', hint: 'Ctrl+Z', action: () => this.command('undo') },
      { label: 'Cut', key: 't', hint: 'Ctrl+X', action: () => this.command('cut') },
      { label: 'Copy', key: 'c', hint: 'Ctrl+C', action: () => this.command('copy') },
      { label: 'Paste', key: 'p', hint: 'Ctrl+V', action: () => void this.paste() },
      { label: 'Select All', key: 'l', hint: 'Ctrl+A', action: () => this.area.select() },
    ];
    const search: DosItem[] = [
      { label: 'Find...', key: 'f', hint: 'Ctrl+F', action: () => void this.find() },
      { label: 'Repeat Last Find', key: 'r', hint: 'F3', action: () => this.findNext() },
      { label: 'Change...', key: 'c', hint: 'Ctrl+H', action: () => void this.change() },
      { label: 'Go to Line...', key: 'g', hint: 'Ctrl+G', action: () => void this.goToLine() },
    ];
    const run: DosItem[] = [
      { label: 'Start', key: 's', hint: 'F5', action: () => this.run() },
      { label: 'Restart', key: 'r', hint: 'Shift+F5', action: () => this.restart() },
      { label: 'Pause', key: 'p', hint: 'F6', disabled: () => !busy(), action: () => this.pause() },
      { label: 'Step', key: 't', hint: 'F8', action: () => this.step() },
      { separator: true },
      { label: 'Check Program', key: 'c', hint: 'F9', action: () => this.check() },
      { label: 'Clear Output', key: 'o', action: () => { this.machine.output = []; this.drawPanel(); } },
    ];
    const examples: DosItem[] = [
      { label: 'Hello (start here)', key: 'h', action: () => void this.loadExample(HELLO_SOURCE, 'HELLO.S', 'Runs by itself for about four seconds; no keys needed.') },
      { label: 'A real Linux program', key: 'r', action: () => void this.loadExample(LINUX_SOURCE, 'LINUX.S', 'No keys: it prints to Output and ends.') },
      { separator: true },
      ...EXAMPLES.map(e => ({ label: e.title, key: e.title[0].toLowerCase(), action: () => void this.loadExample(e.source, e.file, e.keys) })),
    ];
    const view: DosItem[] = [
      { label: 'Full Screen Studio', key: 'f', hint: 'Ctrl+Shift+F', checked: () => document.fullscreenElement === this.app.root, action: () => void this.fullScreen(this.app.root) },
      { label: 'Full Screen Game', key: 'g', hint: 'Alt+Enter', checked: () => document.fullscreenElement === this.screenBox, action: () => void this.fullScreen(this.screenBox) },
      { separator: true },
      { label: 'Output', key: 'o', action: () => this.showTab('output') },
      { label: 'Registers', key: 'r', action: () => this.showTab('registers') },
      { label: 'Keys', key: 'k', action: () => this.showTab('keys') },
    ];
    const help: DosItem[] = [
      { label: 'Getting Started', key: 'g', hint: 'F1', action: () => void this.help('start') },
      { label: 'Instructions', key: 'i', action: () => void this.help('instructions') },
      { label: 'Devices and Memory', key: 'd', action: () => void this.help('devices') },
      { label: 'Services (ecall)', key: 's', action: () => void this.help('services') },
      { label: 'Keys and Colours', key: 'k', action: () => void this.help('keys') },
      { separator: true },
      { label: 'About', key: 'a', action: () => void this.help('about') },
    ];
    return [
      { label: 'File', key: 'f', items: file },
      { label: 'Edit', key: 'e', items: edit },
      { label: 'Search', key: 's', items: search },
      { label: 'View', key: 'v', items: view },
      { label: 'Run', key: 'r', items: run },
      { label: 'Examples', key: 'x', items: examples },
      { label: 'Help', key: 'h', items: help },
    ];
  }

  // ---- Wiring ------------------------------------------------------------------------------------------------------

  private wire(signal: AbortSignal): void {
    const area = this.area;
    on(area, 'input', () => this.edited(), signal);
    on(area, 'scroll', () => this.syncScroll(), signal);
    for (const type of ['keyup', 'click', 'select', 'focus'] as const) on(area, type, () => this.showPos(), signal);
    on(area, 'keydown', (event: KeyboardEvent) => this.codeKey(event), signal);

    // Studio-wide keys. F1, F3, F5 and Ctrl+F are the browser's own too, so they are taken only while the Studio has focus.
    let altAlone = false;
    on(this.app.root, 'keydown', (event: KeyboardEvent) => {
      altAlone = event.key === 'Alt';
      if (this.handleKey(event)) {
        event.preventDefault();
        event.stopPropagation();
      }
    }, signal);
    on(this.app.root, 'keyup', (event: KeyboardEvent) => {
      if (event.key === 'Alt' && altAlone && !this.menu.isOpen && !this.app.root.querySelector('.dos-veil')) {
        event.preventDefault();
        this.menu.focusBar();
      }
      altAlone = false;
    }, signal);

    // The program's keyboard: only while the screen has focus, so typing code never moves a game.
    on(this.screenBox, 'keydown', (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.area.focus();
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey || event.key.startsWith('F')) return;
      if (this.machine.active && this.machine.keyDown(event.key)) event.preventDefault();
    }, signal);
    on(this.screenBox, 'keyup', (event: KeyboardEvent) => {
      if (this.machine.keyUp(event.key)) event.preventDefault();
    }, signal);
    on(this.screenBox, 'blur', () => {
      this.machine.releaseKeys();
      this.screenBox.classList.remove('live');
    }, signal);
    on(this.screenBox, 'focus', () => this.screenBox.classList.toggle('live', this.machine.active), signal);
    on(this.screenBox, 'pointerdown', () => this.screenBox.focus(), signal);

    // Narrow windows (and phones) put the machine under the code.
    const observer = new ResizeObserver(() => this.app.root.classList.toggle('narrow', this.app.root.clientWidth < 760));
    observer.observe(this.app.root);
    signal.addEventListener('abort', () => {
      observer.disconnect();
      cancelAnimationFrame(this.raf);
    }, { once: true });
    // A locked or hidden desktop pauses the program; it carries on when you press F5.
    on(document, 'visibilitychange', () => {
      if (document.hidden && this.machine.active) this.pause();
    }, signal);
    this.app.shell.lockChanged.on(locked => {
      if (locked && this.machine.active) this.pause();
    }, signal);
  }

  /** Keys for the whole Studio. Returns true when it used the key. */
  private handleKey(event: KeyboardEvent): boolean {
    if (this.app.root.querySelector('.dos-veil')) return false;
    const k = event.key;
    const ctrl = event.ctrlKey || event.metaKey;
    if (k === 'F10') {
      if (this.menu.isOpen) this.menu.close();
      else this.menu.focusBar();
      return true;
    }
    if (event.altKey && !ctrl && k === 'Enter') return void this.fullScreen(this.screenBox), true;
    if (ctrl && event.shiftKey && k.toLowerCase() === 'f') return void this.fullScreen(this.app.root), true;
    if (event.altKey && !ctrl && k.length === 1) return this.menu.openByKey(k);
    if (k === 'F1') return void this.help('start'), true;
    if (k === 'F3') return this.findNext(), true;
    if (k === 'F5') return event.shiftKey ? this.restart() : this.run(), true;
    if (k === 'F6') return this.pause(), true;
    if (k === 'F8') return this.step(), true;
    if (k === 'F9') return this.check(), true;
    if (!ctrl) return false;
    switch (k.toLowerCase()) {
      case 's':
        void (event.shiftKey ? this.saveAs() : this.save());
        return true;
      case 'o':
        void this.openDialog();
        return true;
      case 'f':
        void this.find();
        return true;
      case 'h':
        void this.change();
        return true;
      case 'g':
        void this.goToLine();
        return true;
    }
    return false;
  }

  /** Editing keys inside the code: Tab indents to the next column of eight, Enter keeps the indent. */
  private codeKey(event: KeyboardEvent): void {
    const area = this.area;
    if (event.key === 'Escape' && this.machine.active) {
      event.preventDefault();
      this.screenBox.focus();
      return;
    }
    if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      const lineStart = area.value.lastIndexOf('\n', area.selectionStart - 1) + 1;
      const col = area.selectionStart - lineStart;
      if (event.shiftKey) return;
      this.insert(' '.repeat(8 - (col % 8)));
      return;
    }
    if (event.key === 'Enter' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
      const lineStart = area.value.lastIndexOf('\n', area.selectionStart - 1) + 1;
      const line = area.value.slice(lineStart, area.selectionStart);
      // After "label:   op", line up with the op; otherwise keep the leading spaces.
      const m = /^([A-Za-z_.$0-9][\w.$]*:\s+)\S/.exec(line);
      const indent = m ? ' '.repeat(m[1].length) : (/^\s*/.exec(line)?.[0] ?? '');
      if (indent) {
        event.preventDefault();
        this.insert('\n' + indent);
      }
    }
  }

  /** Types text at the cursor so the browser's own Undo can take it back. */
  private insert(text: string): void {
    this.area.focus();
    if (!document.execCommand('insertText', false, text)) {
      this.area.setRangeText(text, this.area.selectionStart, this.area.selectionEnd, 'end');
      this.edited();
    }
  }

  private command(name: 'undo' | 'cut' | 'copy'): void {
    this.area.focus();
    document.execCommand(name);
  }

  private async paste(): Promise<void> {
    try {
      const text = await navigator.clipboard.readText();
      this.insert(text);
    } catch {
      await dosAlert(this.app.root, 'Paste', ['This browser did not let the Studio read the clipboard from a menu.', 'Press Ctrl+V in the code instead.']);
    }
  }

  // ---- The code view -----------------------------------------------------------------------------------------------

  private edited(): void {
    if (this.marks.has('error')) this.marks.delete('error');
    this.render();
    this.showPos();
    this.app.setDirty(this.area.value !== this.saved);
  }

  /** Redraws only the lines that changed: the same start and end are kept, the middle is replaced. */
  private render(): void {
    const lines = this.area.value.split('\n');
    const old = this.lineTexts;
    let start = 0;
    while (start < old.length && start < lines.length && old[start] === lines[start]) start++;
    let endOld = old.length;
    let endNew = lines.length;
    while (endOld > start && endNew > start && old[endOld - 1] === lines[endNew - 1]) {
      endOld--;
      endNew--;
    }
    const fresh = lines.slice(start, endNew).map(text => this.lineEl(text));
    const gone = this.lineEls.splice(start, endOld - start, ...fresh);
    for (const el of gone) el.remove();
    const next = this.lineEls[start + fresh.length] ?? null;
    for (const el of fresh) this.hl.insertBefore(el, next);
    if (old.length !== lines.length) {
      const numbers: string[] = [];
      for (let i = 1; i <= lines.length; i++) numbers.push(String(i));
      this.gutterInner.textContent = numbers.join('\n');
    }
    this.lineTexts = lines;
    this.drawMarks();
  }

  private lineEl(text: string): HTMLElement {
    const el = h('div', { class: 'hl-line' });
    for (const t of tokenizeLine(text)) el.append(t.kind === 'text' ? document.createTextNode(t.text) : h('span', { class: `t-${t.kind}` }, t.text));
    return el;
  }

  private drawMarks(): void {
    const els: HTMLElement[] = [];
    for (const [kind, line] of this.marks) {
      const el = h('div', { class: `code-mark ${kind}` });
      el.style.setProperty('top', `${PAD_PX + (line - 1) * LINE_PX}px`);
      els.push(el);
    }
    this.marksEl.replaceChildren(...els);
  }

  private syncScroll(): void {
    const x = this.area.scrollLeft;
    const y = this.area.scrollTop;
    this.hl.style.setProperty('transform', `translate(${-x}px, ${-y}px)`);
    this.marksEl.style.setProperty('transform', `translate(0, ${-y}px)`);
    this.gutterInner.style.setProperty('transform', `translate(0, ${-y}px)`);
  }

  private cursorLine(): { line: number; col: number } {
    const at = this.area.selectionStart;
    const before = this.area.value.slice(0, at);
    const line = before.split('\n').length;
    return { line, col: at - before.lastIndexOf('\n') };
  }

  private showPos(): void {
    const { line, col } = this.cursorLine();
    this.statusPos.textContent = `${String(line).padStart(5, '0')}:${String(col).padStart(3, '0')}`;
  }

  /** Puts the cursor on a line and scrolls it into the middle of the view. */
  private goTo(line: number, focus = true): void {
    const lines = this.area.value.split('\n');
    const n = Math.max(1, Math.min(line, lines.length));
    let at = 0;
    for (let i = 0; i < n - 1; i++) at += lines[i].length + 1;
    if (focus) this.area.focus();
    this.area.setSelectionRange(at, at + lines[n - 1].length);
    this.area.scrollTop = Math.max(0, (n - 1) * LINE_PX - this.area.clientHeight / 2);
    this.syncScroll();
    this.showPos();
  }

  private setSource(text: string, path: string | null, name: string, keys: string, asSaved: boolean): void {
    this.stopMachine();
    this.example = path === null && asSaved;
    this.area.value = text;
    this.path = path;
    this.name = name;
    this.saved = asSaved ? text : '';
    this.keysNote = keys;
    this.assembledText = null;
    this.marks.clear();
    this.lineTexts = [];
    this.lineEls = [];
    this.hl.replaceChildren();
    this.render();
    this.area.scrollTop = 0;
    this.syncScroll();
    this.showTitle();
    this.app.setDirty(!asSaved);
    this.machine = new Machine();
    this.lastPresented = -1;
    this.drawScreen();
    this.drawPanel();
    this.showState();
  }

  private showTitle(): void {
    const note = this.path ? '' : this.example ? ' (example)' : ' (not saved yet)';
    this.titleEl.textContent = ` ${this.name}${note} `;
    this.app.setTitle(`${this.name} - RISC-V Studio`);
  }

  // ---- Files -------------------------------------------------------------------------------------------------------

  /** Asks what to do with unsaved changes. Returns false to stay put. */
  private async keepOrDiscard(): Promise<boolean> {
    if (this.area.value === this.saved) return true;
    const choice = await dosBox<'save' | 'drop'>(this.app.root, {
      title: 'Unsaved changes',
      body: [h('p', {}, `${this.name} has changes that are not saved.`), h('p', {}, 'Save them first?')],
      buttons: [
        { label: 'Save', value: 'save', primary: true },
        { label: "Don't Save", value: 'drop' },
        { label: 'Cancel', value: null as unknown as 'save' },
      ],
    });
    if (choice === 'save') return this.save();
    return choice === 'drop';
  }

  private async newFile(): Promise<void> {
    if (!(await this.keepOrDiscard())) return;
    this.setSource('# A new program. F5 runs it; Help > Getting Started explains the rest.\n.text\nmain:   li   a0, 42\n        li   a7, 1        # print a0\n        ecall\n        li   a7, 10       # exit\n        ecall\n', null, 'UNTITLED.S', '', false);
    this.saved = this.area.value;
    this.app.setDirty(false);
    this.area.focus();
  }

  private async loadExample(source: string, file: string, keys: string): Promise<void> {
    if (!(await this.keepOrDiscard())) return;
    this.setSource(source, null, file, keys, true);
    this.area.focus();
    this.area.setSelectionRange(0, 0);
    this.app.shell.toast(`${file} is loaded. F5 runs it; Save As keeps your own copy.`);
  }

  private async openPath(path: string): Promise<boolean> {
    const shell = this.app.shell;
    try {
      const entry = await shell.fs.stat(path);
      if (!entry || entry.kind !== 'file') throw new Error(`"${baseName(path)}" is not there any more. It may have been moved or deleted.`);
      if (entry.size > MAX_SOURCE_BYTES) throw new Error(`"${entry.name}" is ${Math.ceil(entry.size / 1024)} KB; the Studio opens programs up to 1 MB. It is safe where it is.`);
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(await shell.fs.readFile(path));
      } catch {
        throw new Error(`"${entry.name}" does not look like text, so it was not opened. It is safe where it is.`);
      }
      this.setSource(text.replace(/\r\n?/g, '\n'), path, entry.name, '', true);
      this.loadedModified = entry.modified;
      this.folder = parentPath(path);
      return true;
    } catch (error) {
      await dosAlert(this.app.root, 'Could not open', [error instanceof Error ? error.message : String(error), 'Try File > Open Program to choose another.']);
      return false;
    }
  }

  private async save(): Promise<boolean> {
    if (!this.path) return this.saveAs();
    const shell = this.app.shell;
    try {
      const now = await shell.fs.stat(this.path);
      if (now && now.modified !== this.loadedModified) {
        const ok = await dosBox<boolean>(this.app.root, {
          title: 'Changed somewhere else',
          body: [h('p', {}, `${this.name} was changed after you opened it (in another window or on another device).`), h('p', {}, 'Saving now replaces that newer version with yours.')],
          buttons: [{ label: 'Replace It', value: true }, { label: 'Cancel', value: false, primary: true }],
        });
        if (!ok) return false;
      }
      const entry = await shell.fs.writeFile(this.path, new TextEncoder().encode(this.area.value));
      this.loadedModified = entry.modified;
      this.saved = this.area.value;
      this.app.setDirty(false);
      shell.toast(`Saved ${entry.name}.`);
      return true;
    } catch (error) {
      await dosAlert(this.app.root, 'Could not save', [error instanceof Error ? error.message : String(error), 'Nothing was changed. Try again, or use Save As to keep it somewhere else.']);
      return false;
    }
  }

  private async saveAs(): Promise<boolean> {
    const path = await this.fileDialog('save');
    if (!path) return false;
    const shell = this.app.shell;
    try {
      const existing = await shell.fs.stat(path);
      if (existing) {
        if (existing.kind !== 'file') throw new Error(`There is a folder called "${existing.name}" there.`);
        const ok = await dosBox<boolean>(this.app.root, {
          title: 'Replace?',
          body: [h('p', {}, `${existing.name} already exists in ${parentPath(path)}.`), h('p', {}, 'Replace it with this program?')],
          buttons: [{ label: 'Replace', value: true }, { label: 'Cancel', value: false, primary: true }],
        });
        if (!ok) return false;
      }
      const entry = await shell.fs.writeFile(path, new TextEncoder().encode(this.area.value), existing ? {} : { mustBeNew: true });
      this.path = joinPath(parentPath(path), entry.name);
      this.name = entry.name;
      this.example = false;
      this.folder = parentPath(path);
      this.loadedModified = entry.modified;
      this.saved = this.area.value;
      this.app.setDirty(false);
      this.showTitle();
      shell.toast(`Saved ${entry.name} in ${this.folder}.`);
      return true;
    } catch (error) {
      await dosAlert(this.app.root, 'Could not save', [error instanceof Error ? error.message : String(error), 'Nothing was changed.']);
      return false;
    }
  }

  private async openDialog(): Promise<void> {
    if (!(await this.keepOrDiscard())) return;
    const path = await this.fileDialog('open');
    if (path) await this.openPath(path);
  }

  /** The DOS-style Open and Save As box: a name field, the folder, and a list of folders and programs. */
  private async fileDialog(mode: 'open' | 'save'): Promise<string | null> {
    const shell = this.app.shell;
    let folder = this.folder;
    try {
      const f = await shell.fs.stat(folder);
      if (folder !== '/' && (!f || f.kind !== 'folder')) folder = '/Documents';
    } catch {
      folder = '/Documents';
    }
    const nameIn = h('input', { type: 'text', class: 'dos-field', spellcheck: 'false', autocomplete: 'off', value: mode === 'save' ? (/\.(s|asm)$/i.test(this.name) ? this.name : 'PROGRAM.S') : '*.S' });
    const where = h('p', { class: 'dos-where' });
    const list = h('select', { class: 'dos-list', size: 12, 'aria-label': 'Folders and programs' });
    const problem = h('p', { class: 'dos-problem', role: 'alert' });
    let chosen: string | null = null;

    const fill = async () => {
      where.textContent = folder;
      let entries: Array<{ name: string; kind: 'file' | 'folder' }> = [];
      try {
        entries = await shell.fs.list(folder);
      } catch (error) {
        problem.textContent = error instanceof Error ? error.message : String(error);
      }
      const folders = entries.filter(e => e.kind === 'folder').map(e => e.name).sort((a, b) => a.localeCompare(b));
      const files = entries.filter(e => e.kind === 'file' && CODE_TYPES.includes(e.name.slice(e.name.lastIndexOf('.') + 1).toLowerCase())).map(e => e.name).sort((a, b) => a.localeCompare(b));
      list.replaceChildren(
        ...(folder === '/' ? [] : [h('option', { value: 'up' }, '.. (up one folder)')]),
        ...folders.map(n => h('option', { value: `d:${n}` }, `[${n}]`)),
        ...files.map(n => h('option', { value: `f:${n}` }, n)),
      );
      if (!files.length && !folders.length) list.append(h('option', { value: '', disabled: true }, '(no .S or .ASM programs here)'));
    };

    const activate = async (): Promise<boolean> => {
      const v = list.value;
      if (v === 'up') {
        folder = parentPath(folder);
        await fill();
        return false;
      }
      if (v.startsWith('d:')) {
        folder = joinPath(folder, v.slice(2));
        await fill();
        return false;
      }
      if (v.startsWith('f:')) nameIn.value = v.slice(2);
      return true;
    };

    const accept = (): boolean => {
      const name = nameIn.value.trim();
      const issue = name.includes('*') ? 'Choose a program from the list, or type its name.' : nameProblem(name);
      problem.textContent = issue ?? '';
      if (issue) return false;
      chosen = joinPath(folder, mode === 'save' && !/\.[A-Za-z0-9]+$/.test(name) ? `${name}.S` : name);
      return true;
    };

    await fill();
    const result = await dosBox<'ok'>(this.app.root, {
      title: mode === 'open' ? 'Open Program' : 'Save As',
      wide: true,
      body: [h('label', { class: 'dos-row' }, h('span', {}, 'File Name:'), nameIn), where, list, problem],
      buttons: [
        { label: mode === 'open' ? 'Open' : 'Save', value: 'ok', primary: true },
        { label: 'Cancel', value: null as unknown as 'ok' },
      ],
      ready: close => {
        nameIn.focus();
        nameIn.select();
        list.addEventListener('dblclick', () => void activate().then(done => done && accept() && close('ok')));
        list.addEventListener('keydown', event => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          event.stopPropagation();
          void activate().then(done => done && accept() && close('ok'));
        });
        list.addEventListener('change', () => {
          if (list.value.startsWith('f:')) nameIn.value = list.value.slice(2);
        });
        nameIn.closest('.dos-box')?.querySelector<HTMLButtonElement>('.dos-btn.primary')?.addEventListener('click', event => {
          if (!accept()) {
            event.stopImmediatePropagation();
            nameIn.focus();
          }
        }, { capture: true });
      },
    });
    return result === 'ok' ? chosen : null;
  }

  // ---- Search ------------------------------------------------------------------------------------------------------

  private async find(): Promise<void> {
    const selected = this.area.value.slice(this.area.selectionStart, this.area.selectionEnd);
    const text = await dosPrompt(this.app.root, { title: 'Find', label: 'Find What:', value: selected && !selected.includes('\n') ? selected : this.findText, check: v => (v ? null : 'Type something to look for.') });
    if (text === null) return;
    this.findText = text;
    this.findNext();
  }

  private findNext(): void {
    if (!this.findText) {
      void this.find();
      return;
    }
    const hay = this.area.value.toLowerCase();
    const needle = this.findText.toLowerCase();
    let at = hay.indexOf(needle, this.area.selectionEnd);
    if (at < 0) at = hay.indexOf(needle);
    if (at < 0) {
      void dosAlert(this.app.root, 'Find', [`"${this.findText}" is not in this program.`]);
      return;
    }
    this.area.focus();
    this.area.setSelectionRange(at, at + needle.length);
    const line = this.area.value.slice(0, at).split('\n').length;
    this.area.scrollTop = Math.max(0, (line - 1) * LINE_PX - this.area.clientHeight / 2);
    this.syncScroll();
    this.showPos();
  }

  private async change(): Promise<void> {
    const from = await dosPrompt(this.app.root, { title: 'Change', label: 'Find What:', value: this.findText, check: v => (v ? null : 'Type something to look for.') });
    if (from === null) return;
    const count = this.area.value.split(from).length - 1;
    if (!count) {
      await dosAlert(this.app.root, 'Change', [`"${from}" is not in this program.`]);
      return;
    }
    const to = await dosPrompt(this.app.root, { title: 'Change', label: 'Change To:', value: '', ok: `Change ${count}` });
    if (to === null) return;
    this.findText = from;
    this.area.focus();
    this.area.select();
    this.insert(this.area.value.split(from).join(to));
    this.app.shell.toast(`Changed ${count} place${count === 1 ? '' : 's'}. Ctrl+Z undoes it.`);
  }

  private async goToLine(): Promise<void> {
    const total = this.area.value.split('\n').length;
    const v = await dosPrompt(this.app.root, {
      title: 'Go to Line',
      label: `Line (1-${total}):`,
      value: String(this.cursorLine().line),
      check: s => (/^\d+$/.test(s.trim()) && Number(s) >= 1 && Number(s) <= total ? null : `Type a line number from 1 to ${total}.`),
    });
    if (v !== null) this.goTo(Number(v));
  }

  // ---- Running -----------------------------------------------------------------------------------------------------

  /** Assembles the code if it changed since last time. Returns false (and shows the line) on a problem. */
  private assemble(): boolean {
    const text = this.area.value;
    if (this.assembledText === text && this.machine.assembled) return true;
    this.stopMachine();
    this.machine = new Machine();
    this.lastPresented = -1;
    const problem = this.machine.load(text);
    this.marks.delete('pc');
    if (problem) {
      this.assembledText = null;
      this.marks.set('error', problem.line);
      this.drawMarks();
      this.goTo(problem.line);
      this.showState();
      void dosAlert(this.app.root, 'Assembler', [`Line ${problem.line}: ${problem.message}`, 'The line is marked in red. Fix it, then press F5 again.']);
      return false;
    }
    this.assembledText = text;
    this.marks.delete('error');
    this.drawMarks();
    return true;
  }

  private check(): void {
    if (!this.assemble()) return;
    this.machine.output.push(this.machine.message);
    this.tab = 'output';
    this.drawPanel();
    this.showState();
    this.app.shell.toast(this.machine.message);
  }

  private run(): void {
    if (!this.assemble()) return;
    this.marks.delete('pc');
    this.drawMarks();
    this.machine.start(performance.now());
    this.screenBox.focus();
    this.screenBox.classList.add('live');
    this.loop();
  }

  private restart(): void {
    this.stopMachine();
    this.assembledText = null;
    this.run();
  }

  private pause(): void {
    if (!this.machine.active) return;
    this.machine.pause();
    cancelAnimationFrame(this.raf);
    this.markPc();
    this.refresh();
  }

  private step(): void {
    if (this.machine.active) this.pause();
    if (!this.assemble()) return;
    const said = this.machine.step(performance.now());
    this.machine.output.push(`> ${said}`);
    if (this.machine.output.length > 500) this.machine.output.shift();
    this.markPc();
    this.refresh();
  }

  private stopMachine(): void {
    cancelAnimationFrame(this.raf);
    this.machine.pause();
    this.screenBox?.classList.remove('live');
  }

  private markPc(): void {
    const line = this.machine.sourceLine(this.machine.cpu.pc);
    if (line) {
      this.marks.set('pc', line);
      this.goTo(line, false);
    } else this.marks.delete('pc');
    this.drawMarks();
  }

  private loop(): void {
    cancelAnimationFrame(this.raf);
    let frames = 0;
    const tick = (now: number) => {
      if (this.app.signal.aborted) return;
      this.machine.frame(now);
      this.drawScreen();
      if (++frames % 6 === 0 || !this.machine.active) {
        this.drawPanel();
        this.showState();
      }
      if (this.machine.active) this.raf = requestAnimationFrame(tick);
      else this.finished();
    };
    this.raf = requestAnimationFrame(tick);
  }

  private finished(): void {
    this.screenBox.classList.remove('live');
    if (this.machine.state === 'fault') {
      const line = this.machine.sourceLine(this.machine.cpu.pc);
      if (line) {
        this.marks.set('error', line);
        this.drawMarks();
      }
    }
    this.machine.output.push(`-- ${this.machine.message}`);
    this.refresh();
  }

  private refresh(): void {
    this.drawScreen();
    this.drawPanel();
    this.showState();
  }

  private showState(): void {
    const m = this.machine;
    const label = { empty: 'READY', ready: 'READY', running: 'RUNNING', waiting: 'RUNNING', paused: 'PAUSED', halted: 'ENDED', fault: 'FAULT' }[m.state];
    if (label !== this.lastState) {
      this.badge.textContent = label;
      this.badge.dataset.state = m.state;
      this.lastState = label;
    }
    this.statusLeft.textContent = m.state === 'fault' || m.state === 'halted' || m.state === 'paused' ? m.message : m.active ? 'Esc Code · F6 Pause · Shift+F5 Restart · keys go to the program while the screen has focus' : 'F1 Help · F5 Run · F6 Pause · F8 Step · F9 Check · F10 Menu';
  }

  private drawScreen(): void {
    const m = this.machine;
    const mode = (m.control >> 4) & 0xf;
    const on = (m.control & 1) === 1 && mode !== 0;
    this.screenNote.hidden = on || m.presented > 0;
    this.screenNote.textContent = m.active ? 'The program has not turned the screen on. What it prints is under Output.' : 'Screen off. Press F5 to run.';
    this.screenText.hidden = !(on && mode === 1);
    if (on && mode === 1) this.screenText.textContent = m.text.join('\n');
    if (m.presented !== this.lastPresented) {
      this.lastPresented = m.presented;
      const px = new Uint32Array(this.image.data.buffer);
      for (let i = 0; i < m.shown.length; i++) px[i] = this.palette32[m.shown[i] & 15];
      this.ctx.putImageData(this.image, 0, 0);
    }
    this.canvas.style.setProperty('filter', m.brightness === 255 ? 'none' : `brightness(${(m.brightness / 255).toFixed(2)})`);
  }

  private showTab(tab: 'output' | 'registers' | 'keys'): void {
    this.tab = tab;
    for (const b of this.tabs) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    this.drawPanel();
  }

  private drawPanel(): void {
    for (const b of this.tabs) b.setAttribute('aria-selected', String(b.dataset.tab === this.tab));
    if (this.tab === 'registers') {
      this.panel.textContent = this.machine.registerRows().join('\n');
      return;
    }
    if (this.tab === 'keys') {
      this.panel.textContent = [this.keysNote || 'This program does not say which keys it uses.', '', 'Click the screen (or press Esc from the code while it runs) so', 'keys reach the program. Esc goes back to the code.', '', 'Keys a program can read:', KEY_BITS.map(([, name]) => name).join(' ')].join('\n');
      return;
    }
    const atEnd = this.panel.scrollTop + this.panel.clientHeight >= this.panel.scrollHeight - 4;
    this.panel.textContent = this.machine.output.join('\n') || 'What the program prints appears here.';
    if (atEnd) this.panel.scrollTop = this.panel.scrollHeight;
  }

  private buildTouchPad(signal: AbortSignal): HTMLElement {
    const pad = h('div', { class: 'touch-pad', 'aria-label': 'On-screen keys' });
    const keys: Array<[string, string]> = [['◀', 'ArrowLeft'], ['▲', 'ArrowUp'], ['▼', 'ArrowDown'], ['▶', 'ArrowRight'], ['SPACE', ' '], ['ENTER', 'Enter']];
    for (const [label, key] of keys) {
      const b = h('button', { type: 'button', class: 'touch-key', 'aria-label': key === ' ' ? 'Space' : key }, label);
      on(b, 'pointerdown', (event: PointerEvent) => {
        event.preventDefault();
        b.setPointerCapture(event.pointerId);
        if (this.machine.active) this.machine.keyDown(key);
      }, signal);
      for (const type of ['pointerup', 'pointercancel'] as const) on(b, type, () => this.machine.keyUp(key), signal);
      pad.append(b);
    }
    return pad;
  }

  /**
   * Fills the whole monitor with the Studio or with the game screen; the same again (or Escape) comes back. The game
   * keeps the keyboard in full screen, so it plays exactly as it does in the window.
   */
  private async fullScreen(el: HTMLElement): Promise<void> {
    try {
      if (document.fullscreenElement === el) {
        await document.exitFullscreen();
        return;
      }
      if (document.fullscreenElement) await document.exitFullscreen();
      await el.requestFullscreen({ navigationUI: 'hide' });
      if (el === this.screenBox) this.screenBox.focus();
      else this.area.focus();
    } catch {
      this.app.shell.toast("This browser did not allow full screen here. Try the browser's own full screen (F11) and maximise the window.");
    }
  }

  // ---- Help --------------------------------------------------------------------------------------------------------

  private async help(page: 'start' | 'instructions' | 'devices' | 'services' | 'keys' | 'about'): Promise<void> {
    const pages: Record<typeof page, [string, string[]]> = {
      start: ['Getting Started', [
        'RISC-V Studio runs programs written in RV32IM assembly: the base',
        'instructions of a real RISC-V processor plus multiply and divide (M).',
        '',
        'F5        run the program (it is checked first)',
        'Shift+F5  start again from the beginning',
        'F6        pause; F5 carries on',
        'F8        run one instruction and show which line it was',
        'F9        check the program without running it',
        'F10 / Alt the menu bar;  Alt+F opens File, and so on',
        'Esc       from the screen back to the code, and back again',
        '',
        'The screen is 160 x 90 pixels, 16 colours. A program draws by',
        'writing colour numbers into the framebuffer, then PRESENT shows it',
        'and VSYNC waits for the next frame (60 a second).',
        '',
        'ecall with a number in a7 asks the firmware for a service: print a',
        'number, print text, a random number, exit. Help > Services lists them.',
        '',
        'Examples has five complete games to read, run and change. They are',
        'loaded as copies: File > Save As keeps yours in your files.',
        '',
        'A program can never freeze the desktop: it gets 40,000 instructions',
        'a frame, then the Studio takes the frame back.',
      ]],
      instructions: ['Instructions', [
        'Instructions (RV32I base + M: mul mulh mulhsu mulhu div divu rem remu):',
        ...wrapWords(BASE_MNEMONICS.join(' '), 66),
        '',
        'Pseudo-instructions (expanded by the assembler):',
        ...wrapWords(PSEUDO_MNEMONICS.join(' '), 66),
        '',
        'Directives: .text .data .word .half .byte .ascii .asciz .string',
        '.space .zero .align .equ .set .eqv .globl',
        'Labels end in a colon. "1:" is a local label; "1f" and "1b" jump',
        'to the next or previous one. Comments start with # or ;.',
        'Registers: x0-x31 or zero ra sp gp tp t0-t6 s0-s11 a0-a7.',
      ]],
      devices: ['Devices and Memory', [
        `0x${hex(0x00010000)}  program (the code and .data; pc starts here)`,
        `0x${hex(0x00100000)}  RAM, 1 MB (sp starts at the top: 0x${hex(0x00200000)})`,
        `0x${hex(0x80010000)}  framebuffer: 160 x 90 bytes, one colour each`,
        '',
        ...REGISTERS.map(r => `0x${hex(r.addr)} ${`${r.device}.${r.name}`.padEnd(21)} ${r.access.toUpperCase().padEnd(2)} ${r.description}`),
        '',
        'Device registers are whole words: use lw and sw.',
      ]],
      services: ['Services (ecall)', ['Put the number in a7, arguments in a0/a1, then ecall.', '', ...SERVICES.map(([n, what]) => `${String(n).padStart(3)}  ${what}`)]],
      keys: ['Keys and Colours', [
        'INPUT.KEYS bit, and KEY_EVENT value (bit + 1):',
        ...KEY_BITS.map(([bit, name]) => `  bit ${String(bit).padStart(2)}  event ${String(bit + 1).padStart(2)}  ${name}`),
        '',
        'Colours:',
        ...PALETTE_NAMES.map((n, i) => `  ${String(i).padStart(2)}  ${n.padEnd(10)} ${PALETTE[i]}`),
      ]],
      about: ['About', [
        'RISC-V Studio for TOMLIN OS.',
        'The processor and assembler are this project\'s own',
        'RV32I core (with the M extension); the example',
        'games were written for it.',
        'Everything here is this project\'s own code.',
      ]],
    };
    const [title, lines] = pages[page];
    const text = h('pre', { class: 'dos-help', tabindex: 0 }, lines.join('\n'));
    await dosBox(this.app.root, { title, body: [text], wide: true, buttons: [{ label: 'OK', value: true, primary: true }], ready: () => text.focus() });
  }
}

function wrapWords(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}
