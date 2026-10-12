// Terminal: a Debian-style shell (bash colours: green user@host, blue folder) over the person's own files, plus the
// pretend training machine behind `ssh training`. The engine is in terminal/shell.ts; this file only draws it.
// Tab completes, Up/Down bring back earlier lines, Ctrl+C abandons a line, Ctrl+L clears.
import { h, on } from '../core/dom.ts';
import { protectedReason } from '../shell/actions.ts';
import type { AppDef } from '../shell/types.ts';
import { TerminalShell, type Line, type Machine } from './terminal/shell.ts';
import { makeTrainingMachine } from './terminal/training.ts';
import { APPS } from './catalog.ts';

const MAX_LINES = 3000;

const OS_RELEASE = `PRETTY_NAME="TOMLIN OS (Debian-style shell over your files)"
NAME="TOMLIN OS"
ID=tomlinos
ID_LIKE=debian
VERSION_CODENAME=trixie
`;

export const terminalApp: AppDef = {
  ...APPS.terminal,
  launch(app, arg) {
    const shell = app.shell;
    app.root.classList.add('terminal');
    const user = (shell.account?.user().name ?? 'you').toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'you';

    const desktop: Machine = {
      fs: shell.fs,
      user,
      host: 'tomlinos',
      home: '/',
      pretend: false,
      virtual: { '/etc/os-release': OS_RELEASE, '/etc/hostname': 'tomlinos\n' },
      protectedReason,
      async trash(paths) {
        // Said as it happened: some may have been too big for the Recycle Bin, kept by the person, or refused.
        const { binned, gone, kept } = await shell.actions.deleteToBin(paths);
        const n = (k: number) => (k === 1 ? '1 item' : `${k} items`);
        const said: string[] = [];
        if (binned) said.push(`Moved ${n(binned)} to the Recycle Bin (restore from there, or Undo on the notice).`);
        if (gone) said.push(`Deleted ${n(gone)} for good (too big for the Recycle Bin).`);
        if (kept) said.push(`${n(kept)} not deleted.`);
        return said.join('\n');
      },
      open: path => shell.openPath(path),
    };
    const term = new TerminalShell(desktop, makeTrainingMachine);
    if (arg) term.cwd = arg;

    const output = h('div', { class: 'term-out', role: 'log', 'aria-live': 'polite', 'aria-label': 'Terminal output' });
    const userHost = h('span', { class: 'term-user' });
    const colon = h('span', {}, ':');
    const where = h('span', { class: 'term-path' });
    const tail = h('span', {});
    const input = h('input', { type: 'text', class: 'term-in', 'aria-label': 'Command', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    const promptLine = h('div', { class: 'term-line' }, userHost, colon, where, tail, input);
    const screen = h('div', { class: 'term-screen', tabindex: -1 }, output, promptLine);
    app.root.append(screen);

    const drawPrompt = () => {
      const p = term.prompt();
      userHost.textContent = p.userHost;
      colon.hidden = !p.userHost;
      where.textContent = p.path;
      tail.textContent = p.tail;
      input.type = term.secret ? 'password' : 'text';
      app.setTitle(term.machine.pretend ? 'Terminal - training (pretend)' : 'Terminal');
      screen.classList.toggle('pretend', term.machine.pretend);
    };
    const print = (lines: Line[]) => {
      for (const l of lines) output.append(h('div', { class: `term-row${l.kind ? ' ' + l.kind : ''}` }, l.text || ' '));
      while (output.childElementCount > MAX_LINES) output.firstElementChild?.remove();
      screen.scrollTop = screen.scrollHeight;
    };
    const echo = (text: string) => {
      const p = term.prompt();
      output.append(h('div', { class: 'term-row' },
        p.userHost ? h('span', { class: 'term-user' }, p.userHost) : null, p.userHost ? ':' : '',
        h('span', { class: 'term-path' }, p.path), p.tail, term.secret ? '' : text));
    };

    print([
      { text: 'TOMLIN OS terminal: a Debian-style shell over your own files.', kind: 'ok' },
      { text: 'Type help for the commands, or ssh training to practise on a pretend Debian server.', kind: 'dim' },
    ]);
    drawPrompt();

    let recall = -1;
    let draft = '';
    let busy = false;
    on(input, 'keydown', async (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (busy) return;
        const text = input.value;
        echo(text);
        input.value = '';
        recall = -1;
        if (!term.waiting && text.trim() === 'clear') {
          output.replaceChildren();
          term.history.push('clear');
          return;
        }
        busy = true;
        input.disabled = true; // a long grep -r shows as busy, and nothing typed meanwhile is lost
        try {
          print(await term.run(text));
        } catch (error) {
          print([{ text: error instanceof Error ? error.message : String(error), kind: 'err' }]);
        } finally {
          busy = false;
          input.disabled = false;
          drawPrompt();
          input.focus();
        }
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        if (term.waiting || !term.history.length) return;
        event.preventDefault();
        if (recall === -1) draft = input.value;
        recall = event.key === 'ArrowUp' ? (recall === -1 ? term.history.length - 1 : Math.max(0, recall - 1)) : recall === -1 ? -1 : recall + 1;
        if (recall >= term.history.length) recall = -1;
        input.value = recall === -1 ? draft : term.history[recall];
      } else if (event.key === 'Tab') {
        event.preventDefault();
        if (term.waiting) return;
        const { line, choices } = await term.complete(input.value).catch(() => ({ line: input.value, choices: [] as string[] }));
        input.value = line;
        if (choices.length > 1) {
          echo(line);
          print([{ text: choices.join('  ') }]);
        }
      } else if (event.ctrlKey && event.key.toLowerCase() === 'c' && input.selectionStart === input.selectionEnd) {
        event.preventDefault();
        echo(input.value + '^C');
        input.value = '';
        if (term.waiting) print(await term.run('\u0003'));
        drawPrompt();
      } else if (event.ctrlKey && event.key.toLowerCase() === 'l') {
        event.preventDefault();
        output.replaceChildren();
      }
    }, app.signal);
    on(screen, 'mouseup', () => {
      // Clicking the screen puts the cursor back in the line, unless the person is selecting text to copy.
      if (!window.getSelection()?.toString()) input.focus();
    }, app.signal);
    input.focus();
  },
};
