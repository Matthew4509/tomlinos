// Keyboard shortcuts: the list from shell/keys.ts, grouped, so what is shown is what the code does.
import { h } from '../core/dom.ts';
import { SHORTCUTS } from '../shell/keys.ts';
import type { AppDef } from '../shell/types.ts';
import { APPS } from './catalog.ts';

export const shortcutsApp: AppDef = {
  ...APPS.shortcuts,
  launch(app) {
    app.root.classList.add('shortcuts');
    app.root.append(
      ...SHORTCUTS.flatMap(([group, rows]) => [
        h('h2', { class: 'set-h' }, group),
        h('dl', { class: 'keys' }, ...rows.flatMap(([keys, what]) => [h('dt', {}, keys), h('dd', {}, what)])),
      ]),
      h('p', { class: 'hint' }, 'Alt+Tab, the Windows key and Alt+F4 belong to your computer, not the page, so the desktop uses the keys above instead.'),
    );
  },
};
