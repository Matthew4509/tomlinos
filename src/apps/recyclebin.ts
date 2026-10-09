// The Recycle Bin window: what was deleted, where from and when. Restore puts items back; Delete forever and
// Empty ask first and say plainly that they cannot be undone.
import { h, on } from '../core/dom.ts';
import { formatDate, formatSize, plural } from '../core/format.ts';
import { icon } from '../shell/icons.ts';
import { fileTypeOf } from '../shell/filetypes.ts';
import { bindContextMenu } from '../shell/menu.ts';
import { TRASH_DIR, type BinItem } from '../shell/trash.ts';
import type { AppDef } from '../shell/types.ts';
import { APPS } from './catalog.ts';

export const recycleBinApp: AppDef = {
  ...APPS.trash,
  async launch(app) {
    const shell = app.shell;
    let items: BinItem[] = [];
    const selected = new Set<string>();
    let anchor: string | null = null;
    let generation = 0;

    const restoreBtn = h('button', { type: 'button', class: 'btn' }, 'Restore');
    const deleteBtn = h('button', { type: 'button', class: 'btn' }, 'Delete forever');
    const emptyBtn = h('button', { type: 'button', class: 'btn' }, 'Empty Recycle Bin');
    const list = h('div', { class: 'bin-list', role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': 'Deleted items', tabindex: 0 });
    const statusEl = h('div', { class: 'statusbar', role: 'status' });
    app.root.classList.add('bin');
    app.root.append(h('div', { class: 'toolbar' }, restoreBtn, deleteBtn, emptyBtn), list, statusEl);

    async function refresh(): Promise<void> {
      const mine = ++generation;
      try {
        const next = await shell.bin.list();
        if (mine !== generation) return;
        items = next;
      } catch (error) {
        if (mine !== generation) return;
        items = [];
        await shell.report('Could not read the Recycle Bin', error);
      }
      for (const slot of [...selected]) if (!items.some(i => i.slot === slot)) selected.delete(slot);
      render();
    }

    function render(): void {
      const rows = items.map(item => {
        const row = h(
          'div',
          { class: 'bin-row', role: 'option', 'aria-selected': String(selected.has(item.slot)), tabindex: -1, 'data-slot': item.slot },
          h('span', { class: 'bin-name' }, icon(fileTypeOf(item.name, item.kind).icon, 20), h('span', {}, item.name)),
          h('span', { class: 'bin-col' }, item.from ? item.from.slice(0, item.from.lastIndexOf('/')) || '/' : 'Unknown'),
          h('span', { class: 'bin-col' }, formatDate(item.deleted)),
          h('span', { class: 'bin-col' }, item.kind === 'file' ? formatSize(item.size) : ''),
        );
        row.classList.toggle('selected', selected.has(item.slot));
        return row;
      });
      const head = h('div', { class: 'bin-head', 'aria-hidden': 'true' }, h('span', {}, 'Name'), h('span', {}, 'Deleted from'), h('span', {}, 'Deleted'), h('span', {}, 'Size'));
      list.replaceChildren(head, ...rows, ...(items.length ? [] : [h('p', { class: 'fv-empty', role: 'status' }, 'The Recycle Bin is empty.')]));
      restoreBtn.disabled = selected.size === 0;
      deleteBtn.disabled = selected.size === 0;
      emptyBtn.disabled = items.length === 0;
      statusEl.textContent = selected.size ? `${plural(selected.size, 'item')} selected` : plural(items.length, 'item');
    }

    const slotOf = (target: EventTarget | null) => (target instanceof Element ? target.closest<HTMLElement>('.bin-row')?.dataset.slot : undefined) ?? null;

    function pick(slot: string, event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): void {
      if (event.shiftKey && anchor) {
        const a = items.findIndex(i => i.slot === anchor);
        const b = items.findIndex(i => i.slot === slot);
        selected.clear();
        for (const item of items.slice(Math.min(a, b), Math.max(a, b) + 1)) selected.add(item.slot);
      } else if (event.ctrlKey || event.metaKey) {
        if (!selected.delete(slot)) selected.add(slot);
        anchor = slot;
      } else {
        selected.clear();
        selected.add(slot);
        anchor = slot;
      }
      render();
      list.querySelector<HTMLElement>(`[data-slot="${CSS.escape(slot)}"]`)?.scrollIntoView({ block: 'nearest' });
    }

    async function restore(slots: string[]): Promise<void> {
      if (!slots.length) return;
      await shell.actions.restoreFromBin(slots);
      await refresh();
    }

    async function destroy(slots: string[]): Promise<void> {
      if (!slots.length) return;
      const names = items.filter(i => slots.includes(i.slot)).map(i => i.name);
      const ok = await shell.dialogs.confirm({
        title: 'Delete forever?',
        text:
          slots.length === 1
            ? `“${names[0]}” will be deleted for good. This cannot be undone.`
            : `${plural(slots.length, 'item')} will be deleted for good. This cannot be undone.`,
        ok: 'Delete forever',
        danger: true,
      });
      if (!ok) return;
      try {
        const { failures } = await shell.bin.destroy(slots);
        if (failures.length) await shell.dialogs.alert('Some items could not be deleted', failures.map(f => `${f.name}: ${f.reason}`).join('\n'));
      } catch (error) {
        await shell.report('Could not delete', error);
      }
      await refresh();
    }

    async function empty(): Promise<void> {
      if (!items.length) return;
      const ok = await shell.dialogs.confirm({
        title: 'Empty the Recycle Bin?',
        text: `All ${plural(items.length, 'item')} in it will be deleted for good. This cannot be undone.`,
        ok: 'Empty Recycle Bin',
        danger: true,
      });
      if (!ok) return;
      try {
        const { failures } = await shell.bin.empty();
        if (failures.length) await shell.dialogs.alert('Some items could not be deleted', failures.map(f => `${f.name}: ${f.reason}`).join('\n'));
      } catch (error) {
        await shell.report('Could not empty the Recycle Bin', error);
      }
      await refresh();
    }

    on(restoreBtn, 'click', () => void restore([...selected]), app.signal);
    on(deleteBtn, 'click', () => void destroy([...selected]), app.signal);
    on(emptyBtn, 'click', () => void empty(), app.signal);
    on(list, 'pointerdown', (event: PointerEvent) => {
      const slot = slotOf(event.target);
      if (slot && event.button === 0) pick(slot, event);
      else if (!slot && event.button === 0) {
        selected.clear();
        render();
      }
    }, app.signal);
    on(list, 'dblclick', (event: MouseEvent) => {
      const slot = slotOf(event.target);
      if (slot) void restore([slot]);
    }, app.signal);
    on(list, 'keydown', (event: KeyboardEvent) => {
      const at = items.findIndex(i => i.slot === anchor);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const next = items[Math.max(0, Math.min(items.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))];
        if (next) pick(next.slot, event);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        void restore([...selected]);
      } else if (event.key === 'Delete') {
        event.preventDefault();
        void destroy([...selected]);
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        for (const item of items) selected.add(item.slot);
        render();
      }
    }, app.signal);
    bindContextMenu(list, app.signal, shell.menus, target => {
      const slot = slotOf(target);
      if (slot && !selected.has(slot)) pick(slot, { ctrlKey: false, metaKey: false, shiftKey: false });
      if (!selected.size) return [{ label: 'Empty Recycle Bin', disabled: items.length === 0, action: () => void empty() }];
      return [
        { label: 'Restore', action: () => void restore([...selected]) },
        { label: 'Delete forever', danger: true, action: () => void destroy([...selected]) },
        { separator: true },
        { label: 'Empty Recycle Bin', action: () => void empty() },
      ];
    });
    shell.changes.on(paths => {
      if (paths.some(p => p === TRASH_DIR || p === '/System')) void refresh();
    }, app.signal);

    await refresh();
  },
};
