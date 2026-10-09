// What kind of thing a file is, from its extension, and which apps open it (first available wins). The names of
// apps that do not exist yet are here already: step 4 registers them and files start opening with no change here.
import { splitExtension } from '../fs/names.ts';
import type { IconName } from './icons.ts';

export interface FileType {
  label: string;
  icon: IconName;
  apps: string[];
}

const TEXT: FileType = { label: 'Text document', icon: 'text', apps: ['editor', 'notepadpro'] };
const IMAGE: FileType = { label: 'Picture', icon: 'image', apps: ['photos', 'photoedit'] };
const VIDEO: FileType = { label: 'Video', icon: 'video', apps: ['player'] };
const AUDIO: FileType = { label: 'Music', icon: 'music', apps: ['player'] };
const SHEET: FileType = { label: 'Spreadsheet', icon: 'sheet', apps: ['sheet'] };
const CALC: FileType = { label: 'Calculator sheet', icon: 'calculator', apps: ['calculator'] };
const ARCHIVE: FileType = { label: 'Compressed folder', icon: 'archive', apps: ['archive'] };
const CODE: FileType = { label: 'Code or data file', icon: 'code', apps: ['editor', 'notepadpro'] };
const ASM: FileType = { label: 'RISC-V program', icon: 'chip', apps: ['riscv', 'editor', 'notepadpro'] };
const PDF: FileType = { label: 'PDF document', icon: 'pdf', apps: ['pdf'] };
const CALENDAR: FileType = { label: 'Calendar', icon: 'calendar', apps: ['calendar', 'editor'] };
const CONTACTS: FileType = { label: 'Contacts', icon: 'contacts', apps: ['contacts', 'editor'] };
const LINK: FileType = { label: 'Web link', icon: 'link', apps: ['link'] };
/** Opened by the shell itself (appshortcut.ts), not by an app; Notepad can show what is in it. */
const APP_SHORTCUT: FileType = { label: 'App shortcut', icon: 'app', apps: ['editor', 'notepadpro'] };
const OTHER: FileType = { label: 'File', icon: 'file', apps: [] };
export const FOLDER: FileType = { label: 'Folder', icon: 'folder', apps: ['explorer'] };

const GROUPS: Array<[FileType, string[]]> = [
  // HTML, scripts and styles are opened as plain text, never as a page: that would run them on our own origin.
  [TEXT, ['txt', 'md', 'log', 'ini']],
  [CODE, ['json', 'xml', 'html', 'htm', 'js', 'css', 'ts', 'php', 'py', 'yml', 'yaml']],
  [ARCHIVE, ['zip', '7z', 'rar', 'tar', 'gz', 'tgz']],
  [IMAGE, ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico']],
  [VIDEO, ['mp4', 'webm', 'm4v', 'mov', 'ogv']],
  [AUDIO, ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'flac', 'aac', 'opus']],
  [ASM, ['s', 'asm']],
  [PDF, ['pdf']],
  [SHEET, ['sheet', 'csv', 'tsv']],
  [CALC, ['calc']],
  [CALENDAR, ['ics']],
  [CONTACTS, ['vcf']],
  [LINK, ['url']],
  [APP_SHORTCUT, ['desktop']],
];

const BY_EXTENSION = new Map<string, FileType>();
for (const [type, extensions] of GROUPS) for (const ext of extensions) BY_EXTENSION.set(ext, type);

export function extensionOf(name: string): string {
  return splitExtension(name)[1].slice(1).toLowerCase();
}

export function fileTypeOf(name: string, kind: 'file' | 'folder' = 'file'): FileType {
  if (kind === 'folder') return FOLDER;
  const ext = extensionOf(name);
  const type = BY_EXTENSION.get(ext);
  if (type) return type;
  return ext ? { ...OTHER, label: `${ext.toUpperCase()} file` } : OTHER;
}
