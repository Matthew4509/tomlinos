// The parts the "your own key" AIs share in Settings › AI (claude.ts, openrouter.ts): a tile that says whether the key
// is set and opens that AI's settings in a pop-up, and the cost log in its own pop-up.
import { h, svg } from '../../core/dom.ts';
import type { ServiceApi } from '../../net/service.ts';
import type { DialogLayer } from '../../shell/dialogs.ts';
import { money } from './claude.ts';

interface LogRow {
  at: number;
  model: string;
  in: number;
  out: number;
  cost: number;
  note: string;
}

/** A small drawn picture for each tile: a speech bubble with a spark (Claude), a hub with routes (OpenRouter). */
function tileIcon(kind: 'claude' | 'openrouter'): SVGElement {
  const parts = kind === 'claude'
    ? [
      svg('path', { d: 'M5 6h26a3 3 0 0 1 3 3v15a3 3 0 0 1-3 3H15l-7 6v-6H5a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3z', class: 'ai-tile-fill' }),
      svg('path', { d: 'M18 9.5l1.6 4.4 4.4 1.6-4.4 1.6-1.6 4.4-1.6-4.4-4.4-1.6 4.4-1.6z', class: 'ai-tile-mark' }),
    ]
    : [
      svg('path', { d: 'M18 18L6 7M18 18L30 7M18 18L6 29M18 18L30 29', class: 'ai-tile-line' }),
      svg('circle', { cx: 18, cy: 18, r: 6, class: 'ai-tile-fill' }),
      svg('circle', { cx: 6, cy: 7, r: 3.5, class: 'ai-tile-fill' }),
      svg('circle', { cx: 30, cy: 7, r: 3.5, class: 'ai-tile-fill' }),
      svg('circle', { cx: 6, cy: 29, r: 3.5, class: 'ai-tile-fill' }),
      svg('circle', { cx: 30, cy: 29, r: 3.5, class: 'ai-tile-fill' }),
    ];
  return svg('svg', { class: `ai-tile-icon ai-tile-${kind}`, viewBox: '0 0 36 36', width: 36, height: 36, 'aria-hidden': 'true' }, ...parts);
}

export interface KeyTile {
  el: HTMLButtonElement;
  /** `set`: "Set" (with `detail` under it, the model and this month's spend) or "Not set"; `null` shows `detail` alone. */
  show(set: boolean | null, detail: string): void;
}

/** The tile: picture, "Connect ..." and whether a key is set. The whole tile is the button that opens the pop-up. */
export function keyTile(kind: 'claude' | 'openrouter', title: string, enabled: boolean): KeyTile {
  const state = h('span', { class: 'ai-tile-state' });
  const detail = h('span', { class: 'ai-tile-detail' });
  const el = h('button', { type: 'button', class: 'ai-tile', disabled: !enabled, 'aria-haspopup': 'dialog' },
    tileIcon(kind),
    h('span', { class: 'ai-tile-text' }, h('span', { class: 'ai-tile-title' }, title), state, detail));
  return {
    el,
    show(set, text) {
      el.classList.toggle('set', set === true);
      state.textContent = set === null ? '' : set ? 'Set' : 'Not set';
      state.hidden = set === null;
      detail.textContent = text;
      detail.hidden = !text;
    },
  };
}

/** "Remove my key" asks first, naming the provider: the key is never shown again, so it would have to be pasted anew. */
export function confirmRemoveKey(dialogs: DialogLayer, provider: string): Promise<boolean> {
  return dialogs.confirm({
    title: `Remove your ${provider} key?`,
    text: `Your ${provider} key is deleted from this TOMLIN OS, and ${provider} cannot be asked until you paste a key again. The key itself still works at ${provider}.`,
    ok: 'Remove',
    danger: true,
  });
}

/** The month's cost log in its own pop-up: numbers only, as the server keeps them. */
export function showCostLog(dialogs: DialogLayer, api: ServiceApi, title: string): void {
  const logBody = h('tbody');
  const logHead = h('p', { class: 'ai-cloud-hint' }, 'Reading the cost log...');
  const body = h('div', { class: 'ai-key-dialog ai-cloud-log' }, logHead,
    h('table', { class: 'ai-log-table' }, h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Model'), h('th', {}, 'Tokens in'), h('th', {}, 'Tokens out'), h('th', {}, 'Cost'), h('th', {}, 'Note'))), logBody));
  void dialogs.ask({ title, body, buttons: [{ label: 'Close', value: true, primary: true }], cancel: true });
  void (async () => {
    try {
      const r = await api.call<{ month: string; spent: number; cap: number; rows: LogRow[] }>('log');
      logHead.textContent = `${r.month}: ${money(r.spent)} of your ${money(r.cap)} limit. The log keeps numbers only, never what was asked or answered.`;
      logBody.replaceChildren(...r.rows.map(row => h('tr', {},
        h('td', {}, new Date(row.at * 1000).toLocaleString()), h('td', {}, row.model), h('td', {}, row.in.toLocaleString()),
        h('td', {}, row.out.toLocaleString()), h('td', {}, money(row.cost)), h('td', {}, row.note))));
      if (!r.rows.length) logBody.append(h('tr', {}, h('td', { colspan: '6' }, 'Nothing yet this month.')));
    } catch (error) {
      logHead.textContent = error instanceof Error ? error.message : 'The cost log could not be read.';
    }
  })();
}
