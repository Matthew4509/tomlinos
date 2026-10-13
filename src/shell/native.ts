// What a program running on its own (outside the desktop) gives an app in place of the desktop's own file boxes: the
// computer's real Open and Save boxes, windows of its own, and File menu entries of its own. Inside the desktop
// `shell.native` is not set and the apps work as they always have.
import type { MenuItem } from './menu.ts';

export interface NativeHost {
  /** The program's name, as the person sees it on the title bar and in the Start menu. */
  readonly product: string;
  /** The name a new, never-saved workbook goes by in this window ("Book1"). */
  readonly untitled: string;
  /** The computer's Open box; the path chosen, or null when cancelled. */
  pickOpen(): Promise<string | null>;
  /** The computer's Save box, starting at `suggested` (a whole path, or a name); the path chosen, or null. */
  pickSave(suggested: string, kind: 'xlsx' | 'sheet'): Promise<string | null>;
  /** A new, empty workbook in a window of its own. */
  newWindow(): void;
  /** Told each path opened or saved here, for the recent files list. */
  remember(path: string): void;
  /** File menu entries the program adds: `top` after Open, `bottom` at the end (updates, about, exit). */
  fileMenu(): { top: MenuItem[]; bottom: MenuItem[] };
}
