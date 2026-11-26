// What CAD Draft's window uses of DWG: telling a DWG file by its first bytes (whatever its name), opening one, and
// File > Output > CAD > DWG 2004 (its dialog, choosing where, and saving).
import { h } from '../../../core/dom.ts';
import { baseName, uniqueName } from '../../../fs/names.ts';
import { pickSave } from '../../../shell/filepicker.ts';
import type { Shell } from '../../../shell/types.ts';
import { CadProblem, type Drawing } from '../model.ts';
import { writeDwg } from './write.ts';

export { readDwg } from './read.ts';

/** A DWG starts with its version, AC1009 to AC1032 and on. */
export const isDwgFile = (raw: Uint8Array): boolean => raw.length >= 6 && /^AC10\d\d$/.test(String.fromCharCode(...raw.subarray(0, 6)));

export interface DwgOutput {
  shell: Shell;
  drawing: Drawing;
  /** The DXF output's settings, which the DWG output shares. */
  settings: { dxfTextAsLines: boolean; dxfConstruction: boolean; dxfHidden: boolean };
  keepSettings: () => void;
  folder: string;
  label: string;
  /** The DXF or DWG this drawing was opened from, if what it holds was not all kept (writing over it asks first). */
  source: string | null;
  say: (text: string) => void;
  problem: (text: string) => void;
}

/** Asks how, then where, and writes the drawing as an AutoCAD 2004 DWG. True when a file was written. */
export async function outputDwgFile(o: DwgOutput): Promise<boolean> {
  const { shell, settings } = o;
  const asLines = h('input', { type: 'checkbox', checked: settings.dxfTextAsLines });
  const xlines = h('input', { type: 'checkbox', checked: settings.dxfConstruction });
  const hidden = h('input', { type: 'checkbox', checked: settings.dxfHidden });
  const body = h('div', { class: 'cad-dialog' },
    h('p', {}, 'Writes an AutoCAD 2004 DWG, which AutoCAD 2004 and later, and other CAD programs, open. Ellipses and curves go as true ellipses and splines; dimensions as plain lines and text. Your drawing is not changed (Save keeps everything as .tcad).'),
    h('label', { class: 'cad-check' }, asLines, ' Text as lines in CAD Draft’s letters (exactly as on screen; for engraving). Off: as text the other program draws in its own letters.'),
    h('label', { class: 'cad-check' }, xlines, ' Construction lines (as endless construction lines)'),
    h('label', { class: 'cad-check' }, hidden, ' Items on hidden layers'));
  const ok = await shell.dialogs.ask<boolean>({ title: 'Output a DWG', body, buttons: [{ label: 'Choose where...', value: true, primary: true }, { label: 'Cancel', value: false }], cancel: false });
  if (!ok) return false;
  settings.dxfTextAsLines = asLines.checked;
  settings.dxfConstruction = xlines.checked;
  settings.dxfHidden = hidden.checked;
  o.keepSettings();
  let out: ReturnType<typeof writeDwg>;
  try {
    out = writeDwg(o.drawing, { textAsLines: asLines.checked, construction: xlines.checked, hidden: hidden.checked });
  } catch (error) {
    if (error instanceof CadProblem) {
      o.problem(error.message);
      return false;
    }
    throw error;
  }
  if (!out.count) {
    o.problem('There is nothing to write: draw something first (or tick hidden layers or construction lines if that is all there is).');
    return false;
  }
  let taken: string[] = [];
  try {
    taken = (await shell.fs.list(o.folder, true)).map(e => e.name);
  } catch {
    // Saving will say the folder is gone.
  }
  const stem = o.label.replace(/\.(tcad|dxf|dwg)$/i, '');
  const chosen = await pickSave(shell, { title: 'Output a DWG', folder: o.folder, name: uniqueName(`${stem}.dwg`, taken), accept: ['dwg'], ok: 'Save' });
  if (!chosen) return false;
  let target = chosen.path;
  if (!/\.dwg$/i.test(target)) target += '.dwg';
  try {
    let replacing = chosen.replace;
    if (target !== chosen.path) {
      const existing = await shell.fs.stat(target).catch(() => null);
      if (existing && !(await shell.dialogs.confirm({ title: 'Replace it?', text: `“${baseName(target)}” already exists. Replace it with this one?`, ok: 'Replace', danger: true, cancel: 'Cancel' }))) return false;
      replacing = !!existing;
    }
    if (o.source && target.toLowerCase() === o.source.toLowerCase() && !(await shell.dialogs.confirm({
      title: 'Write over the file this came from?',
      text: `“${baseName(target)}” is the file this drawing was opened from. What CAD Draft did not keep when it opened (listed then: heights, thicknesses, colours or line types of items’ own, blocks, true dimensions, splines, or items left out) would be gone from it for good.`,
      ok: 'Write over it',
      danger: true,
      cancel: 'Cancel',
    }))) return false;
    const entry = await shell.fs.writeFile(target, out.bytes, replacing ? {} : { mustBeNew: true });
    for (const n of out.notes) o.say(n);
    shell.toast(`Saved “${entry.name}”.`);
    return true;
  } catch (error) {
    await shell.report('Could not save the DWG', error);
    return false;
  }
}
