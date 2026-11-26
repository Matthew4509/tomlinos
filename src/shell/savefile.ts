// Saving over a file someone has open, shared by Notepad, Notepad Pro, Calculator, Spreadsheet, Photo Editor and the
// RISC-V Studio (one check and one wording, not six copies). An app remembers the id of the copy it opened (every save
// makes a new id, unlike a clock time, which can repeat). The save replaces only that copy; if another window or device
// saved the file meanwhile, the person is asked before their copy replaces the newer one.
import { FileChanged, type Entry } from '../fs/fs.ts';
import { baseName } from '../fs/names.ts';
import type { Shell } from './types.ts';

/** Asks whether to replace a copy saved somewhere else; the RISC-V Studio passes its own DOS-style box. */
export type AskReplace = (name: string) => Promise<boolean>;

export function askReplace(shell: Shell): AskReplace {
  return name => shell.dialogs.confirm({
    title: 'Changed somewhere else',
    text: `“${name}” was changed after you opened it (in another window or on another device). Saving now replaces that newer version with yours.`,
    ok: 'Replace it',
    danger: true,
    cancel: 'Do not save',
  });
}

/**
 * Writes `bytes` over `path`, replacing only the copy `openedId` names (empty: whatever is there). Null when the person
 * chose not to replace a newer copy (nothing written). A copy that changes again while they decide is asked about again.
 */
export async function saveOver(shell: Shell, path: string, bytes: Uint8Array, openedId: string, ask: AskReplace = askReplace(shell)): Promise<Entry | null> {
  // Two quick saves of one window: the second started with the id the first was about to replace, so it would call the
  // window's own first save "changed somewhere else". It waits for the first and replaces what that one wrote.
  const running = inFlight(shell);
  const before = running.get(path);
  const mine = (async () => {
    let replacing = openedId;
    if (before) {
      const done = await before.result.catch(() => null);
      if (done && before.from === openedId) replacing = done.id;
    }
    return write(shell, path, bytes, replacing, ask);
  })();
  const slot = { from: openedId, result: mine };
  running.set(path, slot);
  try {
    return await mine;
  } finally {
    if (running.get(path) === slot) running.delete(path);
  }
}

/** The saves on their way, per desktop and path. */
const saving = new WeakMap<object, Map<string, { from: string; result: Promise<Entry | null> }>>();
function inFlight(shell: Shell): Map<string, { from: string; result: Promise<Entry | null> }> {
  let m = saving.get(shell);
  if (!m) saving.set(shell, (m = new Map()));
  return m;
}

async function write(shell: Shell, path: string, bytes: Uint8Array, openedId: string, ask: AskReplace): Promise<Entry | null> {
  let replacing = openedId;
  for (;;) {
    try {
      return await shell.fs.writeFile(path, bytes, replacing ? { replacing } : {});
    } catch (error) {
      if (!(error instanceof FileChanged)) throw error;
      if (!(await ask(baseName(path)))) return null;
      replacing = error.current;
    }
  }
}
