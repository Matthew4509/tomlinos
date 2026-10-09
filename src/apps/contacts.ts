// Contacts: a searchable list on the left, the chosen person's card on the right (click Edit to change it). Kept in
// Documents/Contacts.vcf, a standard contacts file a phone or mail program can import; any .vcf opens here too.
// Like the calendar, every change reads the file again and changes only that one contact.
// The list is one keyboard stop: Up/Down move through it, Down from the search box enters it.
import { h, on } from '../core/dom.ts';
import { baseName } from '../fs/names.ts';
import { isDate } from '../core/ical.ts';
import { emptyContact, parseVcf, writeVcf, type Contact } from '../core/vcard.ts';
import { recordFile } from '../shell/recordfile.ts';
import type { AppDef } from '../shell/types.ts';
import { APPS } from './catalog.ts';

export const CONTACTS_PATH = '/Documents/Contacts.vcf';

const byName = (a: Contact, b: Contact) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
const lines = (text: string) => text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

export const contactsApp: AppDef = {
  ...APPS.contacts,
  async launch(app, arg) {
    const shell = app.shell;
    const file = recordFile(shell.fs, arg ?? CONTACTS_PATH, text => parseVcf(text).sort(byName), writeVcf);
    app.root.classList.add('contacts-app');
    if (arg) app.setTitle(`${baseName(arg)} - Contacts`);

    let people: Contact[] = [];
    let chosen: string | null = null;
    let cardDraw = new AbortController();
    const fresh = () => {
      cardDraw.abort();
      cardDraw = new AbortController();
      return cardDraw.signal;
    };

    const find = h('input', { type: 'search', class: 'field', placeholder: 'Search contacts', 'aria-label': 'Search contacts', autocomplete: 'off', spellcheck: 'false' });
    const newBtn = h('button', { type: 'button', class: 'tool wide' }, 'New contact');
    const list = h('div', { class: 'people', role: 'listbox', 'aria-label': 'Contacts' });
    const card = h('div', { class: 'person' });
    const count = h('div', { class: 'statusbar', role: 'status' });
    app.root.append(h('div', { class: 'toolbar' }, find, newBtn), h('div', { class: 'contacts-main' }, list, card), count);

    const rowOf = (uid: string | null) => (uid ? list.querySelector<HTMLElement>(`[data-uid="${CSS.escape(uid)}"]`) : null);

    function drawList(): void {
      const q = find.value.trim().toLowerCase();
      const shown = people.filter(p => !q || [p.name, p.org, ...p.phones, ...p.emails].some(v => v.toLowerCase().includes(q)));
      const focusUid = shown.some(p => p.uid === chosen) ? chosen : shown[0]?.uid ?? null;
      list.replaceChildren(...shown.map(p => h('div', {
        role: 'option', tabindex: p.uid === focusUid ? 0 : -1, 'data-uid': p.uid,
        class: `person-row${p.uid === chosen ? ' on' : ''}`, 'aria-selected': String(p.uid === chosen),
      }, h('span', { class: 'person-name' }, p.name), p.org ? h('span', { class: 'hint' }, p.org) : null)));
      if (!shown.length) list.append(h('p', { class: 'hint pad' }, people.length ? 'No one matches that.' : 'No contacts yet. Click New contact.'));
      count.textContent = `${people.length} contact${people.length === 1 ? '' : 's'}${q ? `, ${shown.length} shown` : ''} · kept in ${file.path.replace(/^\//, '')}`;
    }

    function pick(uid: string, focus: boolean): void {
      chosen = uid;
      drawList();
      drawCard();
      if (focus) rowOf(uid)?.focus();
    }

    function drawCard(): void {
      const signal = fresh();
      const p = people.find(x => x.uid === chosen);
      if (!p) {
        card.replaceChildren(h('p', { class: 'hint pad' }, 'Choose someone on the left.'));
        return;
      }
      const row = (label: string, values: string[]) => (values.length ? [h('dt', {}, label), ...values.map(v => h('dd', {}, v))] : []);
      const edit = h('button', { type: 'button', class: 'btn' }, 'Edit');
      edit.addEventListener('click', () => editCard(p), { signal });
      card.replaceChildren(
        h('h2', {}, p.name),
        ...(p.org ? [h('p', { class: 'hint' }, p.org)] : []),
        h('dl', { class: 'person-facts' },
          ...row('Phone', p.phones),
          ...row('Email', p.emails),
          ...row('Address', p.address ? [p.address] : []),
          ...row('Birthday', p.birthday ? [new Date(p.birthday + 'T12:00').toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })] : []),
          ...row('Notes', p.notes ? [p.notes] : [])),
        h('div', { class: 'row-buttons' }, edit),
      );
    }

    async function save(apply: (list: Contact[]) => Contact[], busy: HTMLButtonElement[]): Promise<boolean> {
      for (const b of busy) b.disabled = true;
      try {
        people = await file.change(list => apply(list).sort(byName));
        return true;
      } catch (error) {
        await shell.report('Could not save the contacts', error);
        return false;
      } finally {
        for (const b of busy) b.disabled = false;
      }
    }

    function editCard(existing: Contact | null): void {
      const signal = fresh();
      const c = existing ? { ...existing } : emptyContact();
      const field = (label: string, value: string, multi = false) => {
        if (!multi) return h('input', { type: 'text', class: 'field', value, 'aria-label': label });
        const area = h('textarea', { class: 'field', rows: 2, 'aria-label': label });
        area.value = value;
        return area;
      };
      const nameIn = field('Name', c.name);
      const orgIn = field('Company', c.org);
      const phoneIn = field('Phone numbers (one per line)', c.phones.join('\n'), true);
      const emailIn = field('Email addresses (one per line)', c.emails.join('\n'), true);
      const addrIn = field('Address', c.address, true);
      const bdayIn = h('input', { type: 'date', class: 'field', value: c.birthday, 'aria-label': 'Birthday' });
      const notesIn = field('Notes', c.notes, true);
      const problem = h('p', { class: 'dialog-problem', role: 'alert' });
      const saveBtn = h('button', { type: 'button', class: 'btn primary' }, 'Save');
      const cancel = h('button', { type: 'button', class: 'btn' }, 'Cancel');
      const del = h('button', { type: 'button', class: 'btn danger' }, 'Delete');
      card.replaceChildren(
        h('h2', {}, existing ? 'Edit contact' : 'New contact'),
        h('label', { class: 'form-row' }, 'Name ', nameIn),
        h('label', { class: 'form-row' }, 'Company ', orgIn),
        h('label', { class: 'form-row' }, 'Phones ', phoneIn),
        h('label', { class: 'form-row' }, 'Emails ', emailIn),
        h('label', { class: 'form-row' }, 'Address ', addrIn),
        h('label', { class: 'form-row' }, 'Birthday ', bdayIn),
        h('label', { class: 'form-row' }, 'Notes ', notesIn),
        problem,
        h('div', { class: 'row-buttons' }, saveBtn, cancel, existing ? del : null),
      );
      nameIn.focus();
      saveBtn.addEventListener('click', async () => {
        const name = nameIn.value.trim();
        if (!name) return void (problem.textContent = 'Give the contact a name.');
        if (bdayIn.value && !isDate(bdayIn.value)) return void (problem.textContent = 'That birthday is not a real date.');
        const saved: Contact = { ...c, name, org: orgIn.value.trim(), phones: lines(phoneIn.value), emails: lines(emailIn.value), address: addrIn.value.trim().replace(/\s*\n\s*/g, ', '), birthday: bdayIn.value, notes: notesIn.value.trim() };
        if (await save(list => [...list.filter(x => x.uid !== saved.uid), saved], [saveBtn, del])) pick(saved.uid, true);
      }, { signal });
      cancel.addEventListener('click', () => {
        drawCard();
        (rowOf(chosen) ?? newBtn).focus();
      }, { signal });
      del.addEventListener('click', async () => {
        const ok = await shell.dialogs.confirm({ title: 'Delete this contact?', text: `“${c.name}” will be removed from your contacts.`, ok: 'Delete', danger: true, cancel: 'Keep' });
        if (ok && (await save(list => list.filter(x => x.uid !== c.uid), [saveBtn, del]))) {
          chosen = null;
          drawList();
          drawCard();
          (list.querySelector<HTMLElement>('[tabindex="0"]') ?? newBtn).focus();
        }
      }, { signal });
    }

    on(list, 'click', (event: MouseEvent) => {
      const row = event.target instanceof Element ? event.target.closest<HTMLElement>('.person-row') : null;
      if (row?.dataset.uid) pick(row.dataset.uid, true);
    }, app.signal);
    on(list, 'keydown', (event: KeyboardEvent) => {
      const rows = [...list.querySelectorAll<HTMLElement>('.person-row')];
      const at = rows.indexOf(document.activeElement as HTMLElement);
      const to = event.key === 'ArrowDown' ? at + 1 : event.key === 'ArrowUp' ? at - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : null;
      if (to === null) return;
      event.preventDefault();
      if (to < 0) return find.focus();
      const row = rows[Math.min(to, rows.length - 1)];
      if (row?.dataset.uid) pick(row.dataset.uid, true);
    }, app.signal);
    on(find, 'input', drawList, app.signal);
    on(find, 'keydown', (event: KeyboardEvent) => {
      if (event.key !== 'ArrowDown') return;
      const first = list.querySelector<HTMLElement>('.person-row');
      if (first?.dataset.uid) {
        event.preventDefault();
        pick(first.dataset.uid, true);
      }
    }, app.signal);
    on(newBtn, 'click', () => editCard(null), app.signal);
    file.watch(shell.changes, app.signal, latest => {
      people = latest;
      drawList();
    });

    try {
      people = await file.load();
    } catch (error) {
      await shell.report('Could not open the contacts', error);
      app.close();
      return;
    }
    drawList();
    drawCard();
    find.focus();
  },
};
