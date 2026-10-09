// Colours for the RISC-V Studio's editor: splits one line of assembly into pieces (label, instruction, register,
// number, string, directive, comment). It only colours; the assembler alone decides what is valid.
import { ABI_NAMES, BASE_MNEMONICS, PSEUDO_MNEMONICS } from './rv32i.ts';

export type TokenKind = 'label' | 'op' | 'reg' | 'num' | 'str' | 'dir' | 'com' | 'bad' | 'text';
export interface Token {
  kind: TokenKind;
  text: string;
}

const MNEMONICS = new Set([...BASE_MNEMONICS, ...PSEUDO_MNEMONICS]);
const REGISTERS = new Set([...ABI_NAMES, 'fp', ...Array.from({ length: 32 }, (_, i) => `x${i}`)]);

/** Splits a line into coloured pieces. Joining every piece's text gives back the line exactly. */
export function tokenizeLine(line: string): Token[] {
  const out: Token[] = [];
  const push = (kind: TokenKind, text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.kind === kind && kind === 'text') last.text += text;
    else out.push({ kind, text });
  };
  let i = 0;
  let sawOp = false;
  while (i < line.length) {
    const c = line[i];
    if (c === '#' || c === ';') {
      push('com', line.slice(i));
      break;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < line.length && line[j] !== c) j += line[j] === '\\' ? 2 : 1;
      push('str', line.slice(i, Math.min(j + 1, line.length)));
      i = j + 1;
      continue;
    }
    const word = /^[A-Za-z_.$%][\w.$]*/.exec(line.slice(i));
    if (word) {
      const w = word[0];
      const after = line.slice(i + w.length);
      if (!sawOp && /^\s*:/.test(after)) {
        push('label', w + after.slice(0, after.indexOf(':') + 1));
        i += w.length + after.indexOf(':') + 1;
        continue;
      }
      const lower = w.toLowerCase();
      if (!sawOp) {
        sawOp = true;
        push(w.startsWith('.') ? 'dir' : MNEMONICS.has(lower) ? 'op' : 'bad', w);
      } else if (REGISTERS.has(lower)) push('reg', w);
      else if (w.startsWith('%')) push('dir', w);
      else push('text', w);
      i += w.length;
      continue;
    }
    const num = /^-?(0x[0-9a-fA-F]+|0b[01]+|\d+[fb]?)\b/.exec(line.slice(i));
    if (num && (i === 0 || !/[\w$]/.test(line[i - 1]))) {
      // "1:" is a numbered local label; "1f" and "1b" point at one.
      if (!sawOp && /^\s*:/.test(line.slice(i + num[0].length))) {
        const end = line.indexOf(':', i) + 1;
        push('label', line.slice(i, end));
        i = end;
        continue;
      }
      push('num', num[0]);
      i += num[0].length;
      continue;
    }
    push('text', c);
    i++;
  }
  return out;
}
