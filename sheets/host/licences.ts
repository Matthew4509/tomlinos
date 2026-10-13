// Help > Licences: every part TOMLIN Sheets is made from, each a button that shows its licence in full. The list is
// licences.json, made when the program is built (tools/licences.mjs) from the libraries actually compiled in; the
// same text is installed beside the program as licences/THIRD-PARTY-NOTICES.txt.
import { h, on } from '../../src/core/dom.ts';
import type { DialogLayer } from '../../src/shell/dialogs.ts';
import { PRODUCT } from './about.ts';

interface Part { name: string; version: string; licence: string; authors: string[]; home: string; source?: string; note?: string; texts: string[] }
interface Licences { main: Part[]; packages: Part[]; texts: Record<string, string> }

let loaded: Promise<Licences> | null = null;

function load(): Promise<Licences> {
  loaded ??= fetch('licences.json').then(r => {
    if (!r.ok) throw new Error(String(r.status));
    return r.json() as Promise<Licences>;
  });
  loaded.catch(() => (loaded = null));
  return loaded;
}

export async function showLicences(dialogs: DialogLayer): Promise<void> {
  let data: Licences;
  try {
    data = await load();
  } catch {
    await dialogs.alert('Licences', `The list of licences could not be read from inside ${PRODUCT}. The same list is in the program's folder, in licences\\THIRD-PARTY-NOTICES.txt.`);
    return;
  }
  const life = new AbortController();
  const listView = h('div', { class: 'lic-list-view' });
  const detail = h('div', { class: 'lic-detail', hidden: true });
  const search = h('input', { type: 'search', class: 'field lic-search', placeholder: 'Find a library by name or licence', 'aria-label': 'Find a library by name or licence', autocomplete: 'off', spellcheck: false });
  const count = h('p', { class: 'lic-count' });
  const list = h('div', { class: 'lic-list', role: 'list' });

  const item = (p: Part) => {
    const b = h('button', { type: 'button', class: 'lic-item', role: 'listitem' },
      h('span', { class: 'lic-name' }, `${p.name}${p.version ? ' ' + p.version : ''}`),
      h('span', { class: 'lic-kind' }, p.licence));
    on(b, 'click', () => open(p), life.signal);
    return b;
  };
  const fill = () => {
    const q = search.value.trim().toLowerCase();
    const shown = data.packages.filter(p => !q || p.name.toLowerCase().includes(q) || p.licence.toLowerCase().includes(q));
    list.replaceChildren(...shown.map(item));
    count.textContent = q ? `${shown.length} of ${data.packages.length} libraries` : `${data.packages.length} libraries compiled into the program`;
  };

  let back: HTMLElement | null = null;
  function open(p: Part): void {
    back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const backBtn = h('button', { type: 'button', class: 'btn lic-back' }, '‹ All licences');
    on(backBtn, 'click', close, life.signal);
    const facts = [
      ['Licence', p.licence],
      p.authors.length ? ['By', p.authors.join(', ')] : null,
      ['Home', p.home],
      p.source ? ['Source', p.source] : null,
    ].filter((f): f is string[] => f !== null);
    const parts: Node[] = [backBtn, h('h3', { class: 'lic-title' }, `${p.name}${p.version ? ' ' + p.version : ''}`)];
    if (p.note) parts.push(h('p', { class: 'dialog-detail' }, p.note));
    parts.push(
      h('dl', { class: 'props lic-facts' }, ...facts.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
      ...p.texts.map(k => h('pre', { class: 'lic-text', tabindex: 0 }, data.texts[k] ?? '')),
    );
    detail.replaceChildren(...parts);
    listView.hidden = true;
    detail.hidden = false;
    detail.scrollTop = 0;
    backBtn.focus();
  }
  function close(): void {
    detail.hidden = true;
    listView.hidden = false;
    (back?.isConnected ? back : search).focus();
  }

  on(search, 'input', fill, life.signal);
  // Enter in the search box would press Close (the dialog's main button): it does nothing here instead.
  on(search, 'keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
    }
  }, life.signal);
  listView.append(
    h('p', { class: 'dialog-text' }, `${PRODUCT} is made by TOMLIN OS. It is built with the open-source parts below, each under its own licence; pick one to read its licence in full. Where a part offers a choice ("MIT OR Apache-2.0"), it is used under either.`),
    h('div', { class: 'lic-main', role: 'list' }, ...data.main.map(item)),
    search,
    count,
    list,
    h('p', { class: 'dialog-detail' }, 'The same list, with every licence text, is in the program\'s folder: licences\\THIRD-PARTY-NOTICES.txt.'),
  );
  fill();
  const body = h('div', { class: 'licences' }, listView, detail);
  // Escape in a licence goes back to the list first, as Back does; on the list it closes the window.
  on(body, 'keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !detail.hidden) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }, life.signal, { capture: true });
  await dialogs.ask<true>({ title: 'Licences', body, buttons: [{ label: 'Close', value: true, primary: true }], cancel: true, focus: () => search });
  life.abort();
}
