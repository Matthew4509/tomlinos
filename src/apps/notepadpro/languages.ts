// Which colouring Notepad Pro uses for which file, by extension. `make` builds the CodeMirror language from the
// bundle; the bundle has no type file, so it is passed in as a plain object.
import { extensionOf } from '../../shell/filetypes.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Bundle = Record<string, any>;

export interface Lang {
  id: string;
  label: string;
  exts: string[];
  make(cm: Bundle): unknown;
}

export const LANGS: Lang[] = [
  { id: 'text', label: 'Plain text', exts: ['txt', 'log', 'csv', 'tsv'], make: () => [] },
  { id: 'markdown', label: 'Markdown', exts: ['md', 'markdown'], make: cm => cm.markdown() },
  { id: 'js', label: 'JavaScript', exts: ['js', 'mjs', 'cjs', 'jsx'], make: cm => cm.javascript({ jsx: true }) },
  { id: 'ts', label: 'TypeScript', exts: ['ts', 'tsx', 'mts'], make: cm => cm.javascript({ typescript: true, jsx: true }) },
  { id: 'json', label: 'JSON', exts: ['json'], make: cm => cm.json() },
  { id: 'html', label: 'HTML', exts: ['html', 'htm'], make: cm => cm.html() },
  { id: 'css', label: 'CSS', exts: ['css'], make: cm => cm.css() },
  { id: 'php', label: 'PHP', exts: ['php'], make: cm => cm.php() },
  { id: 'python', label: 'Python', exts: ['py'], make: cm => cm.python() },
  { id: 'sql', label: 'SQL', exts: ['sql'], make: cm => cm.sql() },
  { id: 'xml', label: 'XML', exts: ['xml', 'svg'], make: cm => cm.xml() },
  { id: 'yaml', label: 'YAML', exts: ['yml', 'yaml'], make: cm => cm.yaml() },
  { id: 'asm', label: 'Assembly (RISC-V)', exts: ['s', 'asm'], make: cm => cm.StreamLanguage.define(cm.gas) },
  { id: 'shell', label: 'Shell script', exts: ['sh', 'bash'], make: cm => cm.StreamLanguage.define(cm.shell) },
  { id: 'ini', label: 'Settings (INI)', exts: ['ini', 'cfg', 'conf', 'properties', 'url'], make: cm => cm.StreamLanguage.define(cm.properties) },
];

export function langFor(name: string): Lang {
  const ext = extensionOf(name);
  return LANGS.find(l => l.exts.includes(ext)) ?? LANGS[0];
}

export function langById(id: string): Lang {
  return LANGS.find(l => l.id === id) ?? LANGS[0];
}
