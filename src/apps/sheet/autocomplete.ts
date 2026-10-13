// While a formula is typed: a list of the functions (and names) that start with what is being typed, as Excel's Formula
// AutoComplete shows it (Tab or a click puts the function in, with its opening bracket), and under it a line with the
// function the caret is inside and what goes in its brackets, the part being typed in bold.
import { css, h, on } from '../../core/dom.ts';
import { helpFor } from './fn-help.ts';

const MOST = 12;

export interface FormulaHelper {
  /** Looks at the text before the caret and shows (or hides) the list and the line under the editor. */
  update(input: HTMLTextAreaElement): void;
  /** Handles arrow keys, Tab and Escape while the list is open; true when the key was used. */
  key(event: KeyboardEvent, input: HTMLTextAreaElement): boolean;
  hide(): void;
}

/** The word being typed at the caret, when it can be the start of a function or a name: its text and where it starts. */
function wordAt(text: string, caret: number): { word: string; start: number } | null {
  const before = text.slice(0, caret);
  if (!before.startsWith('=')) return null;
  // Inside quotes: text, not a function.
  if ((before.match(/"/g)?.length ?? 0) % 2) return null;
  const m = /([A-Za-z_][A-Za-z0-9_.]*)$/.exec(before);
  if (!m) return null;
  const start = before.length - m[1].length;
  const prev = before[start - 1];
  if (prev !== undefined && !/[=+\-*/^&<>(,;:\s{]/.test(prev)) return null;
  // A sheet name before "!" or a cell address with $ is not a function being typed.
  if (/^[A-Za-z]{1,3}\d+$/.test(m[1])) return null;
  return { word: m[1], start };
}

/** The function whose brackets the caret is in, and which of its arguments (0 first) is being typed. */
function callAt(text: string, caret: number): { name: string; arg: number } | null {
  const before = text.slice(0, caret);
  const stack: Array<{ name: string; arg: number }> = [];
  let quoted = false;
  let braces = 0;
  for (let i = 0; i < before.length; i++) {
    const c = before[i];
    if (c === '"') quoted = !quoted;
    if (quoted) continue;
    if (c === '{') braces++;
    else if (c === '}') braces = Math.max(0, braces - 1);
    else if (c === '(') {
      const m = /([A-Za-z_][A-Za-z0-9_.]*)\s*$/.exec(before.slice(0, i));
      stack.push({ name: m ? m[1].toUpperCase() : '', arg: 0 });
    } else if (c === ')') stack.pop();
    else if (c === ',' && !braces && stack.length) stack[stack.length - 1].arg++;
  }
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i].name) return stack[i];
  return null;
}

export function formulaHelper(root: HTMLElement, names: () => string[], functions: () => string[], afterInsert: (input: HTMLTextAreaElement) => void, signal: AbortSignal): FormulaHelper {
  const list = h('div', { class: 'fx-list', role: 'listbox', 'aria-label': 'Functions and names', hidden: true });
  const tip = h('div', { class: 'fx-tip', role: 'note', hidden: true });
  root.append(list, tip);
  let items: Array<{ text: string; fn: boolean }> = [];
  let pick = 0;
  let current: { input: HTMLTextAreaElement; start: number; end: number } | null = null;

  const place = (el: HTMLElement, input: HTMLTextAreaElement, below: number) => {
    const r = input.getBoundingClientRect();
    const host = root.getBoundingClientRect();
    css(el, { left: Math.max(0, Math.min(r.left - host.left, host.width - 260)), top: r.bottom - host.top + below });
  };

  function draw(): void {
    list.replaceChildren(...items.map((it, i) => {
      const help = it.fn ? helpFor(it.text) : null;
      const row = h('div', { class: 'fx-item', role: 'option', 'aria-selected': String(i === pick), title: help?.text ?? 'A name in this workbook' },
        h('span', { class: 'fx-name' }, it.text), h('span', { class: 'fx-kind' }, it.fn ? (help?.text ?? '') : 'Name'));
      on(row, 'pointerdown', (event: PointerEvent) => {
        // Kept from taking the focus away from the editor.
        event.preventDefault();
        pick = i;
        insert();
      }, signal);
      return row;
    }));
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }

  function insert(): void {
    if (!current || !items[pick]) return;
    const { input, start, end } = current;
    const it = items[pick];
    const add = it.fn ? `${it.text}(` : it.text;
    input.value = input.value.slice(0, start) + add + input.value.slice(end);
    const caret = start + add.length;
    input.setSelectionRange(caret, caret);
    hideList();
    afterInsert(input);
    helper.update(input);
  }

  const hideList = () => {
    list.hidden = true;
    items = [];
    current = null;
  };

  const helper: FormulaHelper = {
    update(input) {
      const caret = input.selectionStart ?? input.value.length;
      const w = input.selectionStart === input.selectionEnd ? wordAt(input.value, caret) : null;
      if (w) {
        const q = w.word.toUpperCase();
        const fns = functions().filter(f => f.startsWith(q)).map(text => ({ text, fn: true }));
        const own = names().filter(n => n.toUpperCase().startsWith(q)).map(text => ({ text, fn: false }));
        const next = [...fns, ...own].slice(0, MOST);
        // A word that is already a whole name, followed by "(", is not offered again.
        if (next.length && !(next.length === 1 && next[0].text.toUpperCase() === q && input.value[caret] === '(')) {
          const same = current && current.input === input && items.length === next.length && items.every((x, i) => x.text === next[i].text);
          items = next;
          if (!same) pick = 0;
          current = { input, start: w.start, end: caret };
          list.hidden = false;
          draw();
          place(list, input, 2);
        } else hideList();
      } else hideList();
      const call = callAt(input.value, caret);
      const help = call ? helpFor(call.name) : null;
      if (help && list.hidden) {
        let parts = help.args ? help.args.split(', ') : [];
        let at = Math.min(call!.arg, parts.length - 1);
        // Past the listed arguments, "..." repeats the last numbered one or pair: criteria_range2, criteria2, number3...
        if (parts[parts.length - 1] === '...' && call!.arg >= parts.length - 1) {
          const bare = (x: string) => x.replace(/^\[|\]$/g, '');
          const nums = parts.slice(0, -1).map(x => /(\d+)$/.exec(bare(x))?.[1]);
          const j = nums.map(n => n !== undefined).lastIndexOf(true);
          if (j >= 0) {
            let start = j;
            while (start > 0 && nums[start - 1] === nums[j]) start--;
            const size = j - start + 1;
            const k = call!.arg - start;
            const name = bare(parts[start + (k % size)]).replace(/\d+$/, String(Number(nums[j]) + Math.floor(k / size)));
            parts = [...parts.slice(0, -1), name, '...'];
            at = parts.length - 2;
          }
        }
        tip.replaceChildren(h('span', {}, `${help.name}(`), ...parts.flatMap((p, i) => [...(i ? [h('span', {}, ', ')] : []), i === at ? h('strong', {}, p) : h('span', {}, p)]), h('span', {}, ')'));
        tip.hidden = false;
        place(tip, input, 2);
      } else tip.hidden = true;
    },
    key(event, input) {
      if (list.hidden || !items.length || current?.input !== input) return false;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        pick = (pick + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
        draw();
        return true;
      }
      if (event.key === 'Tab' && !event.shiftKey) {
        insert();
        return true;
      }
      if (event.key === 'Escape') {
        hideList();
        return true;
      }
      return false;
    },
    hide() {
      hideList();
      tip.hidden = true;
    },
  };
  return helper;
}
