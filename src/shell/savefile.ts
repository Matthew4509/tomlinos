// Saving over a file someone has open, shared by Notepad, Notepad Pro, Calculator and Photo Editor (one
// check and one wording, not four copies). If the file changed after it was opened (in another
// window or on another device), the person is asked before their copy replaces the newer one.
import type { Entry } from '../fs/fs.ts';
import { baseName } from '../fs/names.ts';
import type { Shell } from './types.ts';

/** True when `path` is unchanged since `openedAt`, or the person agrees to replace the newer version. */
export async function okToReplace(shell: Shell, path: string, openedAt: number): Promise<boolean> {
  const now = await shell.fs.stat(path).catch(() => null);
  if (!now || now.modified === openedAt) return true;
  return shell.dialogs.confirm({
    title: 'Changed somewhere else',
    text: `“${baseName(path)}” was changed after you opened it (in another window or on another device). Saving now replaces that newer version with yours.`,
    ok: 'Replace it',
    danger: true,
    cancel: 'Do not save',
  });
}

/** Writes `bytes` over `path` after that check. Null when the person chose not to replace (nothing written). */
export async function saveOver(shell: Shell, path: string, bytes: Uint8Array, openedAt: number): Promise<Entry | null> {
  return (await okToReplace(shell, path, openedAt)) ? shell.fs.writeFile(path, bytes) : null;
}
