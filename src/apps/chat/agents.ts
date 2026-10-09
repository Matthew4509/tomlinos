// Chat's Agents: conversations with an AI (the built-in models on this device, or Claude with the person's own
// key), kept as threads with basic controls (connect, new thread, recent threads, save, delete), kept visibly in the
// person's own files.
//
// Each thread is one Markdown file in Documents/AI chats, saved as each message is sent and answered, so closing or
// reloading the page loses nothing. The file reads as a plain conversation in Notepad; each message starts with a line
// "### You · <time>" or "### AI (<name>) · <time>". A line of the message itself that starts with "###" is written
// with a backslash in front ("\###"), and one backslash is taken off such lines when read, so any text survives.
import { cleanName, joinPath, uniqueName } from '../../fs/names.ts';
import type { FileSystem } from '../../fs/fs.ts';

export const AGENT_FOLDER = '/Documents/AI chats';
const MARK = '<!-- TOMLIN OS AI chat. Each message starts with a "### " line; keep those lines as they are. -->';

export interface AgentTurn {
  role: 'user' | 'assistant';
  text: string;
  /** Milliseconds since 1970. */
  at: number;
  /** Which AI wrote an answer ("Gemma 2 2B", "Claude Sonnet 5"). */
  by?: string;
}

export interface AgentThread {
  title: string;
  turns: AgentTurn[];
}

const HEAD = /^### (?:You|AI \((.+)\)) · (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)$/;

const stuff = (text: string): string => text.replace(/^(\\*###)/gm, '\\$1');
const unstuff = (text: string): string => text.replace(/^\\(\\*###)/gm, '$1');

/** The thread as its file's text. */
export function threadToText(thread: AgentThread): string {
  const parts = [`# ${thread.title.replace(/\s+/g, ' ').trim()}`, '', MARK, ''];
  for (const t of thread.turns) {
    const who = t.role === 'user' ? 'You' : `AI (${(t.by ?? 'AI').replace(/[()\n]/g, ' ').trim()})`;
    parts.push(`### ${who} · ${new Date(t.at).toISOString()}`, '', stuff(t.text.replace(/\r\n?/g, '\n').trimEnd()), '');
  }
  return parts.join('\n');
}

/** A thread read back from its file. Text before the first message line (the title, the note) is not a message. */
export function threadFromText(text: string, fallbackTitle = 'AI chat'): AgentThread {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const title = lines[0]?.startsWith('# ') ? lines[0].slice(2).trim() || fallbackTitle : fallbackTitle;
  const turns: AgentTurn[] = [];
  let body: string[] | null = null;
  const close = () => {
    if (!body) return;
    turns[turns.length - 1].text = unstuff(body.join('\n').replace(/^\n+/, '').replace(/\n+$/, ''));
  };
  for (const line of lines) {
    const m = HEAD.exec(line);
    if (m) {
      close();
      turns.push(m[1] ? { role: 'assistant', by: m[1], at: Date.parse(m[2]), text: '' } : { role: 'user', at: Date.parse(m[2]), text: '' });
      body = [];
    } else if (body) body.push(line);
  }
  close();
  return { title, turns };
}

/** A thread's title from its first question: its first words, at most about 50 letters. */
export function titleFrom(question: string): string {
  const flat = question.replace(/\s+/g, ' ').trim();
  if (flat.length <= 50) return flat || 'AI chat';
  const cut = flat.slice(0, 50);
  const at = cut.lastIndexOf(' ');
  return `${(at > 20 ? cut.slice(0, at) : cut).replace(/[\s,.;:!?-]+$/, '')}...`;
}

export interface ThreadFile {
  name: string;
  modified: number;
}

/** Every kept thread, newest first. */
export async function listThreads(fs: FileSystem): Promise<ThreadFile[]> {
  try {
    const entries = await fs.list(AGENT_FOLDER);
    return entries.filter(e => e.kind === 'file' && /\.md$/i.test(e.name)).map(e => ({ name: e.name, modified: e.modified })).sort((a, b) => b.modified - a.modified);
  } catch {
    return [];
  }
}

export const threadLabel = (fileName: string): string => fileName.replace(/\.md$/i, '');

/**
 * Deletes for good (not to the Recycle Bin) the kept threads not changed in the last `days` days, as the person chose in
 * Settings; 0 keeps them all. Returns how many went.
 */
export async function clearOldThreads(fs: FileSystem, days: number, now = Date.now()): Promise<number> {
  if (!days) return 0;
  const old = (await listThreads(fs)).filter(t => t.modified < now - days * 86400000);
  if (old.length) await fs.remove(old.map(t => joinPath(AGENT_FOLDER, t.name)));
  return old.length;
}

/**
 * Saves a thread. `was` is its file (null the first time): the first save picks a file name from the title, with
 * " (2)" when another thread has it; later saves write the same file. Returns the file name.
 */
export async function saveThread(fs: FileSystem, thread: AgentThread, was: string | null): Promise<string> {
  await fs.ensureFolder(AGENT_FOLDER);
  let name = was;
  if (!name) {
    name = `${cleanName(thread.title.replace(/\.\.\.$/, '').slice(0, 60))}.md`;
    const taken = (await listThreads(fs)).map(t => t.name);
    if (taken.some(n => n.toLowerCase() === name!.toLowerCase())) name = uniqueName(name, taken);
  }
  await fs.writeText(joinPath(AGENT_FOLDER, name), threadToText(thread));
  return name;
}

export async function openThread(fs: FileSystem, name: string): Promise<AgentThread> {
  return threadFromText(await fs.readText(joinPath(AGENT_FOLDER, name)), threadLabel(name));
}
