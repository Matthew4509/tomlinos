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
    /** Set while a form is open: whether anything in it differs from what it opened with. */
    let formDirty: (() => boolean) | null = null;
    /** True while the edit or new-contact form is showing (the card is then left alone when the file changes). */
    let formOpen = false;
    const isDirty = () => !!formDirty?.();
    /** True when it is fine to leave the form (it holds nothing unsaved, or the person chose to discard it). */
    async function leaveForm(): Promise<boolean> {
      if (!isDirty()) return true;
      const ok = await shell.dialogs.confirm({ title: 'Discard your changes?', text: 'This contact has changes that are not saved. If you leave, they are lost.', ok: 'Discard', danger: true, cancel: 'Keep editing' });
      if (ok) {
        formDirty = null;
        app.setDirty(false);
      }
      return ok;
    }
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
      formDirty = null;
      formOpen = false;
      app.setDirty(false);
      const p = people.find(x => x.uid === chosen);
      if (!p) {
        card.replaceChildren(h('p', { class: 'hint pad' }, 'Choose someone on the left.'));
        return;
      }
      const row = (label: string, values: string[]) => (values.length ? [h('dt', {}, label), ...values.map(v => h('dd', {}, v))] : []);
      const edit = h('button', { type: 'button', class: 'btn' }, 'Edit');
      // The contact as it is now, should the file have changed since the card was drawn.
      edit.addEventListener('click', () => editCard(people.find(x => x.uid === p.uid) ?? p), { signal });
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
        formDirty = null;
        app.setDirty(false);
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
      formOpen = true;
      const c = existing ? { ...existing } : emptyContact();
      // The longest each field may be: what the file reader keeps (src/core/vcard.ts), so nothing typed here is cut
      // quietly the next time the file is read.
      const field = (label: string, value: string, multi = false, max?: number) => {
        if (!multi) return h('input', { type: 'text', class: 'field', value, maxlength: max, 'aria-label': label });
        const area = h('textarea', { class: 'field', rows: 2, maxlength: max, 'aria-label': label });
        area.value = value;
        return area;
      };
      const nameIn = field('Name', c.name, false, 500);
      const orgIn = field('Company', c.org, false, 500);
      const phoneIn = field('Phone numbers (one per line)', c.phones.join('\n'), true);
      const emailIn = field('Email addresses (one per line)', c.emails.join('\n'), true);
      const addrIn = field('Address', c.address, true, 500);
      const bdayIn = h('input', { type: 'date', class: 'field', value: c.birthday, 'aria-label': 'Birthday' });
      const notesIn = field('Notes', c.notes, true, 20000);
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
      /** Each field and what it held when the form opened. */
      const inputs: Array<[keyof Contact, HTMLInputElement | HTMLTextAreaElement]> = [['name', nameIn], ['org', orgIn], ['phones', phoneIn], ['emails', emailIn], ['address', addrIn], ['birthday', bdayIn], ['notes', notesIn]];
      const opened = Object.fromEntries(inputs.map(([f, input]) => [f, input.value])) as Partial<Record<keyof Contact, string>>;
      const snap = () => JSON.stringify([nameIn.value, orgIn.value, phoneIn.value, emailIn.value, addrIn.value, bdayIn.value, notesIn.value]);
      const was = snap();
      formDirty = () => snap() !== was;
      card.addEventListener('input', () => app.setDirty(isDirty()), { signal });
      nameIn.focus();
      saveBtn.addEventListener('click', async () => {
        const name = nameIn.value.trim();
        if (!name) return void (problem.textContent = 'Give the contact a name.');
        if (bdayIn.value && !isDate(bdayIn.value)) return void (problem.textContent = 'That birthday is not a real date.');
        // The most the file keeps of each (src/core/vcard.ts): said here rather than cut the next time it is read.
        const phones = lines(phoneIn.value);
        const emails = lines(emailIn.value);
        if (phones.length > 20 || emails.length > 20) return void (problem.textContent = 'A contact keeps up to 20 phone numbers and 20 email addresses.');
        if (phones.some(p => p.length > 60)) return void (problem.textContent = 'A phone number can be up to 60 characters.');
        if (emails.some(e => e.length > 200)) return void (problem.textContent = 'An email address can be up to 200 characters.');
        const typed: Partial<Contact> = { name, org: orgIn.value.trim(), phones, emails, address: addrIn.value.trim().replace(/\s*\n\s*/g, ', '), birthday: bdayIn.value, notes: notesIn.value.trim() };
        // Only the fields changed in the form are saved, onto the contact as the file holds it now: a change made in
        // another window since the form opened is kept, and a field not touched here keeps its own line in the file.
        const changes: Partial<Contact> = existing ? Object.fromEntries(inputs.filter(([f, input]) => input.value !== opened[f]).map(([f]) => [f, typed[f]])) : typed;
        const uid = c.uid;
        if (await save(list => {
          const now = list.find(x => x.uid === uid);
          // An edit of a contact someone deleted meanwhile (another window) is refused, not quietly put back.
          if (existing && !now) throw new Error('This contact was deleted in another window, so your changes were not saved. Choose New contact to add it again.');
          return [...list.filter(x => x.uid !== uid), { ...(now ?? c), ...changes }];
        }, [saveBtn, del])) pick(uid, true);
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
      if (row?.dataset.uid) void leaveForm().then(ok => ok && row.dataset.uid && pick(row.dataset.uid, true));
    }, app.signal);
    on(list, 'keydown', (event: KeyboardEvent) => {
      const rows = [...list.querySelectorAll<HTMLElement>('.person-row')];
      const at = rows.indexOf(document.activeElement as HTMLElement);
      const to = event.key === 'ArrowDown' ? at + 1 : event.key === 'ArrowUp' ? at - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : null;
      if (to === null) return;
      event.preventDefault();
      if (to < 0) return find.focus();
      const row = rows[Math.min(to, rows.length - 1)];
      if (row?.dataset.uid) void leaveForm().then(ok => ok && row.dataset.uid && pick(row.dataset.uid, true));
    }, app.signal);
    on(find, 'input', drawList, app.signal);
    on(find, 'keydown', (event: KeyboardEvent) => {
      if (event.key !== 'ArrowDown') return;
      const first = list.querySelector<HTMLElement>('.person-row');
      if (first?.dataset.uid) {
        event.preventDefault();
        void leaveForm().then(ok => ok && first.dataset.uid && pick(first.dataset.uid, true));
      }
    }, app.signal);
    on(newBtn, 'click', () => void leaveForm().then(ok => ok && editCard(null)), app.signal);
    app.onClose(leaveForm);
    file.watch(shell.changes, app.signal, latest => {
      people = latest;
      drawList();
      // The open card is drawn again from the file as it is now. A form is left as it is: its Save applies only what
      // was changed in it onto the newest copy of the contact.
      if (!formOpen) {
        const focused = card.contains(document.activeElement);
        drawCard();
        if (focused) card.querySelector<HTMLElement>('button')?.focus();
      }
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
