// Contacts: a menu bar and toolbar across the top, a row of filter buttons (All, Favourites, Family, Friends, Work and
// any other group), a searchable list on the left and the chosen person's card on the right (click Edit to change it).
// Kept in Documents/Contacts.vcf, a standard contacts file a phone or mail program can import; any .vcf opens here too.
// Like the calendar, every change reads the file again and changes only that one contact.
// The list is one keyboard stop: Up/Down move through it, Down from the search box enters it, Enter or F2 edits the
// chosen person, Delete deletes them (asking first). Ctrl+F goes to the search box, Alt+N starts a new contact.
import { h, on } from '../core/dom.ts';
import { baseName } from '../fs/names.ts';
import { isDate } from '../core/ical.ts';
import { cleanGroups, emptyContact, MAX_GROUP_NAME, MAX_GROUPS, parseVcf, STANDARD_GROUPS, writeVcf, type Contact } from '../core/vcard.ts';
import { recordFile } from '../shell/recordfile.ts';
import { classicBar, type BarItem } from '../shell/menubar.ts';
import { toolIcon } from '../shell/toolicons.ts';
import type { AppDef } from '../shell/types.ts';
import { APPS } from './catalog.ts';
import { helpMenu } from './classic-menus.ts';

export const CONTACTS_PATH = '/Documents/Contacts.vcf';

const lines = (text: string) => text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
const collate = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
const byName = (a: Contact, b: Contact) => collate(a.name, b.name);

type FormField = 'name' | 'description' | 'org' | 'title' | 'groups' | 'favourite' | 'phones' | 'emails' | 'address' | 'birthday' | 'notes';
/** What each box of the edit form holds. Groups are the names joined with ", "; favourite is '1' or ''. */
export type FormValues = Record<FormField, string>;
const FORM_FIELDS: FormField[] = ['name', 'description', 'org', 'title', 'groups', 'favourite', 'phones', 'emails', 'address', 'birthday', 'notes'];

/**
 * What the form shows for a contact when it opens: the name without the spaces round it, and a birthday the date box
 * cannot hold (no year, not a real day) as an empty box, which Save leaves alone unless a date is put in.
 */
export const formValues = (c: Contact): FormValues => ({
  name: c.name.trim(), description: c.description, org: c.org, title: c.title, groups: c.groups.join(', '), favourite: c.favourite ? '1' : '',
  phones: c.phones.join('\n'), emails: c.emails.join('\n'), address: c.address, birthday: isDate(c.birthday) ? c.birthday : '', notes: c.notes,
});

/**
 * What Save writes: a reason it cannot (a string), or the fields to change. For a contact being edited (opened given)
 * only the fields changed in the form, so an untouched field keeps its own line in the file (the name's first and
 * family parts, a birthday the date box could not show). Spaces typed round the name are not a change of name.
 */
export function formChanges(opened: FormValues | null, now: FormValues): Partial<Contact> | string {
  const name = now.name.trim();
  if (!name) return 'Give the contact a name.';
  if (now.birthday && !isDate(now.birthday)) return 'That birthday is not a real date.';
  // The most the file keeps of each (src/core/vcard.ts): said here rather than cut the next time it is read.
  const phones = lines(now.phones);
  const emails = lines(now.emails);
  if (phones.length > 20 || emails.length > 20) return 'A contact keeps up to 20 phone numbers and 20 email addresses.';
  if (phones.some(p => p.length > 60)) return 'A phone number can be up to 60 characters.';
  if (emails.some(e => e.length > 200)) return 'An email address can be up to 200 characters.';
  const named = now.groups.split(',').map(g => g.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (named.some(g => g.length > MAX_GROUP_NAME)) return `A group's name can be up to ${MAX_GROUP_NAME} characters.`;
  const groups = cleanGroups(named);
  if (groups.length < new Set(named.map(g => g.toLowerCase())).size) return `A contact can be in up to ${MAX_GROUPS} groups.`;
  const typed: Partial<Contact> = {
    name, description: now.description.replace(/\s+/g, ' ').trim(), org: now.org.trim(), title: now.title.trim(), groups, favourite: now.favourite === '1',
    phones, emails, address: now.address.trim().replace(/\s*\n\s*/g, ', '), birthday: now.birthday, notes: now.notes.trim(),
  };
  if (!opened) return typed;
  const changed = (f: FormField) => (f === 'name' ? name !== opened.name.trim() : now[f] !== opened[f]);
  return Object.fromEntries(FORM_FIELDS.filter(changed).map(f => [f, typed[f]]));
}

/** What the list shows: everyone, the starred, or one group (by its name). */
export type Show = { kind: 'all' } | { kind: 'favourites' } | { kind: 'group'; name: string };
export type SortBy = 'first' | 'last' | 'company';

/** Every group in use or standard: Family, Friends and Work first, then the others A to Z. */
export function allGroups(people: Contact[]): string[] {
  const own = cleanGroups(people.flatMap(p => p.groups)).filter(g => !(STANDARD_GROUPS as readonly string[]).includes(g)).sort(collate);
  return [...STANDARD_GROUPS, ...own];
}

const inGroup = (p: Contact, name: string) => p.groups.some(g => g.toLowerCase() === name.toLowerCase());

/** Whether a person is in what the filter buttons show. */
export function shownBy(p: Contact, show: Show): boolean {
  return show.kind === 'all' || (show.kind === 'favourites' ? p.favourite : inGroup(p, show.name));
}

const digits = (s: string) => s.replace(/\D/g, '');

/**
 * Whether a person matches what was typed in the search box: every word of it is found somewhere on the card (name,
 * description, company, job title, groups, phones, emails, address, notes), so "anna work" finds Anna in Work. A
 * number matches a phone however its spaces and dashes are typed ("7700900123" finds "07700 900123").
 */
export function matches(p: Contact, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = [p.name, p.description, p.org, p.title, ...p.groups, ...p.phones, ...p.emails, p.address, p.notes].join('\n').toLowerCase();
  const phoneDigits = p.phones.map(digits);
  const inPhone = (typed: string) => {
    const d = digits(typed);
    return d.length >= 3 && /^[\d\s()+.-]+$/.test(typed) && phoneDigits.some(n => n.includes(d));
  };
  // A whole number typed with its own spacing ("07700 900 123"), or each word found somewhere.
  return inPhone(query.trim()) || words.every(w => text.includes(w) || inPhone(w));
}

/** A family name to sort by: the card's own, or else the last word of the name. */
const familyOf = (p: Contact) => (p.family?.trim() || p.name.trim().split(/\s+/).pop() || '');

export function sorter(by: SortBy): (a: Contact, b: Contact) => number {
  if (by === 'last') return (a, b) => collate(familyOf(a), familyOf(b)) || byName(a, b);
  // People with no company go last, A to Z.
  if (by === 'company') return (a, b) => (!a.org !== !b.org ? (a.org ? -1 : 1) : collate(a.org, b.org)) || byName(a, b);
  return byName;
}

/** One or two letters for the round picture by a name ("Ada Fernley": AF). */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(w => /\p{L}|\p{N}/u.test(w));
  const first = (w: string | undefined) => (w ? [...w.replace(/^[^\p{L}\p{N}]+/u, '')][0] ?? '' : '');
  return ((first(words[0]) + (words.length > 1 ? first(words[words.length - 1]) : '')) || '?').toUpperCase();
}

/** Which of the eight picture colours a name gets: the same name, the same colour, every time. */
export function tintOf(name: string): number {
  let n = 0;
  for (const ch of name.trim().toLowerCase()) n = (n * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return n % 8;
}

const showName = (show: Show) => (show.kind === 'all' ? 'All' : show.kind === 'favourites' ? 'Favourites' : show.name);
const sameShow = (a: Show, b: Show) => a.kind === b.kind && (a.kind !== 'group' || (b.kind === 'group' && a.name.toLowerCase() === b.name.toLowerCase()));

export const contactsApp: AppDef = {
  ...APPS.contacts,
  async launch(app, arg) {
    const shell = app.shell;
    const file = recordFile(shell.fs, arg ?? CONTACTS_PATH, text => parseVcf(text).sort(byName), writeVcf);
    app.root.classList.add('contacts-app');
    if (arg) app.setTitle(`${baseName(arg)} - Contacts`);

    let people: Contact[] = [];
    let chosen: string | null = null;
    let show: Show = { kind: 'all' };
    let sortBy: SortBy = 'first';
    /** Set while a form is open: whether anything in it differs from what it opened with. */
    let formDirty: (() => boolean) | null = null;
    /** True while the edit or new-contact form is showing (the card is then left alone when the file changes). */
    let formOpen = false;
    /** True while a save is under way (the bar's commands wait for it). */
    let saving = false;
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
    const current = () => people.find(x => x.uid === chosen) ?? null;
    /** The bar's commands for the chosen person: there is one, and no form is open or save under way. */
    const canAct = () => !!current() && !formOpen && !saving;

    const find = h('input', { type: 'search', class: 'field contacts-find', placeholder: 'Search contacts', 'aria-label': 'Search contacts', autocomplete: 'off', spellcheck: 'false' });
    const filters = h('div', { class: 'contacts-filters', role: 'toolbar', 'aria-label': 'Show' });
    const list = h('div', { class: 'people', role: 'listbox', 'aria-label': 'Contacts' });
    const card = h('div', { class: 'person' });
    const count = h('div', { class: 'statusbar', role: 'status' });

    // ---- Menu bar and toolbar ----
    const groupItems = (): BarItem[] => {
      const p = current();
      return [
        ...allGroups(people).map(g => ({ label: g, checked: () => !!p && inGroup(p, g), enabled: canAct, action: () => void toggleGroup(g) })),
        { separator: true },
        { label: 'New group...', enabled: canAct, action: () => void newGroup() },
      ];
    };
    const showItems = (): BarItem[] => [
      { label: 'All contacts', checked: () => show.kind === 'all', action: () => setShow({ kind: 'all' }) },
      { label: 'Favourites', icon: 'star', checked: () => show.kind === 'favourites', action: () => setShow({ kind: 'favourites' }) },
      { separator: true },
      ...allGroups(people).map(g => ({ label: g, checked: () => sameShow(show, { kind: 'group', name: g }), action: () => setShow({ kind: 'group', name: g }) })),
    ];
    const bar = classicBar({
      menus: [
        { label: 'File', items: [
          { label: 'New contact', icon: 'person-add', shortcut: 'Alt+N', enabled: () => !saving, action: () => void startNew() },
          { separator: true },
          { label: 'Close', icon: 'close', action: () => app.close() },
        ] },
        { label: 'Edit', items: [
          { label: 'Edit contact', icon: 'person-edit', shortcut: 'F2', enabled: canAct, action: () => void startEdit() },
          { label: 'Delete contact', icon: 'delete', shortcut: 'Delete', danger: true, enabled: canAct, action: () => void remove() },
          { separator: true },
          { label: 'Favourite', icon: 'star', checked: () => !!current()?.favourite, enabled: canAct, action: () => void toggleFavourite() },
          { label: 'Groups', submenu: groupItems },
          { separator: true },
          { label: 'Find', icon: 'find', shortcut: 'Ctrl+F', action: () => find.focus() },
        ] },
        { label: 'View', items: [
          { label: 'Show', icon: 'filter', submenu: showItems },
          { label: 'Sort by', icon: 'sort', submenu: [
            { label: 'First name', checked: () => sortBy === 'first', action: () => setSort('first') },
            { label: 'Last name', checked: () => sortBy === 'last', action: () => setSort('last') },
            { label: 'Company', checked: () => sortBy === 'company', action: () => setSort('company') },
          ] },
        ] },
        helpMenu(shell),
      ],
      tools: [
        { id: 'new', label: 'New contact', icon: 'person-add', shortcut: 'Alt+N', enabled: () => !saving, action: () => void startNew() },
        { id: 'edit', label: 'Edit contact', icon: 'person-edit', shortcut: 'F2', enabled: canAct, action: () => void startEdit() },
        { id: 'delete', label: 'Delete contact', icon: 'delete', shortcut: 'Delete', enabled: canAct, action: () => void remove() },
        '|',
        { id: 'favourite', label: 'Favourite', icon: 'star', enabled: canAct, pressed: () => !!current()?.favourite, action: () => void toggleFavourite() },
        '|',
        { widget: h('label', { class: 'contacts-search' }, toolIcon('find'), find) },
      ],
    }, { layer: shell.menus, signal: app.signal, scope: app.root, doc: () => rowOf(chosen) ?? find, label: 'Contacts menu bar' });
    app.root.append(bar.el, filters, h('div', { class: 'contacts-main' }, list, card), count);

    const rowOf = (uid: string | null) => (uid ? list.querySelector<HTMLElement>(`[data-uid="${CSS.escape(uid)}"]`) : null);

    function drawFilters(): void {
      const shows: Show[] = [{ kind: 'all' }, { kind: 'favourites' }, ...allGroups(people).map(name => ({ kind: 'group', name }) as Show)];
      // The one shown is always among the buttons, even a group nobody is in any more.
      if (!shows.some(s => sameShow(s, show))) shows.push(show);
      filters.replaceChildren(...shows.map(s => {
        const n = people.filter(p => shownBy(p, s)).length;
        const on = sameShow(s, show);
        const b = h('button', { type: 'button', class: 'contacts-filter', 'aria-pressed': String(on), title: on && s.kind !== 'all' ? 'Show everyone again' : `Show ${showName(s) === 'All' ? 'everyone' : showName(s)}` },
          s.kind === 'favourites' ? h('span', { class: 'contacts-star', 'aria-hidden': 'true' }, '★') : null,
          showName(s), h('span', { class: 'contacts-filter-count' }, String(n)));
        // Pressing the one that is on goes back to All.
        b.addEventListener('click', () => setShow(on ? { kind: 'all' } : s));
        return b;
      }));
    }

    function drawList(): void {
      const q = find.value.trim();
      const inShow = people.filter(p => shownBy(p, show));
      const shown = inShow.filter(p => matches(p, q)).sort(sorter(sortBy));
      const focusUid = shown.some(p => p.uid === chosen) ? chosen : shown[0]?.uid ?? null;
      list.replaceChildren(...shown.map(p => {
        const sub = p.description || [p.title, p.org].filter(Boolean).join(', ');
        return h('div', {
          role: 'option', tabindex: p.uid === focusUid ? 0 : -1, 'data-uid': p.uid,
          class: `person-row${p.uid === chosen ? ' on' : ''}`, 'aria-selected': String(p.uid === chosen),
        },
        h('span', { class: `person-pic tint-${tintOf(p.name)}`, 'aria-hidden': 'true' }, initials(p.name)),
        h('span', { class: 'person-row-text' },
          h('span', { class: 'person-name' }, p.name, p.favourite ? h('span', { class: 'contacts-star', title: 'Favourite' }, ' ★') : null),
          sub ? h('span', { class: 'hint' }, sub) : null));
      }));
      if (!shown.length) {
        const why = !people.length ? 'No contacts yet. Click New contact.'
          : q ? 'No one matches that.'
          : show.kind === 'favourites' ? 'No favourites yet. Choose someone and click the star.'
          : `No one is in ${showName(show)} yet. Edit a contact and tick ${showName(show)}.`;
        list.append(h('p', { class: 'hint pad' }, why));
      }
      const parts = [`${people.length} contact${people.length === 1 ? '' : 's'}`];
      if (show.kind !== 'all' || q) parts.push(`${shown.length} shown${show.kind !== 'all' ? ` in ${showName(show)}` : ''}`);
      count.textContent = `${parts.join(', ')} · kept in ${file.path.replace(/^\//, '')}`;
      bar.refresh();
    }

    function setShow(next: Show): void {
      show = next;
      drawFilters();
      drawList();
    }

    function setSort(next: SortBy): void {
      sortBy = next;
      drawList();
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
      bar.refresh();
      const p = current();
      if (!p) {
        card.replaceChildren(h('p', { class: 'hint pad' }, people.length ? 'Choose someone on the left.' : 'Your contacts appear here. Click New contact to add the first one.'));
        return;
      }
      const row = (label: string, values: string[]) => (values.length ? [h('dt', {}, label), ...values.map(v => h('dd', {}, v))] : []);
      const edit = h('button', { type: 'button', class: 'btn' }, 'Edit');
      const star = h('button', { type: 'button', class: 'btn', 'aria-pressed': String(p.favourite) }, p.favourite ? 'Remove from favourites' : 'Add to favourites');
      // The contact as it is now, should the file have changed since the card was drawn.
      edit.addEventListener('click', () => editCard(people.find(x => x.uid === p.uid) ?? p), { signal });
      star.addEventListener('click', () => void toggleFavourite(), { signal });
      const work = [p.title, p.org].filter(Boolean).join(', ');
      card.replaceChildren(
        h('div', { class: 'person-head' },
          h('span', { class: `person-pic big tint-${tintOf(p.name)}`, 'aria-hidden': 'true' }, initials(p.name)),
          h('div', { class: 'person-head-text' },
            h('h2', {}, p.name, p.favourite ? h('span', { class: 'contacts-star', title: 'Favourite' }, ' ★') : null),
            p.description ? h('p', { class: 'person-description' }, p.description) : null,
            work ? h('p', { class: 'hint' }, work) : null,
            p.groups.length ? h('div', { class: 'person-groups', 'aria-label': 'Groups' }, ...p.groups.map(g => h('span', { class: 'person-group' }, g))) : null)),
        h('dl', { class: 'person-facts' },
          ...row('Phone', p.phones),
          ...row('Email', p.emails),
          ...row('Address', p.address ? [p.address] : []),
          ...row('Birthday', p.birthday ? [new Date(p.birthday + 'T12:00').toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })] : []),
          ...row('Notes', p.notes ? [p.notes] : [])),
        h('div', { class: 'row-buttons' }, edit, star),
      );
    }

    async function save(apply: (list: Contact[]) => Contact[], busy: HTMLButtonElement[]): Promise<boolean> {
      saving = true;
      bar.refresh();
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
        saving = false;
        for (const b of busy) b.disabled = false;
        bar.refresh();
      }
    }

    /** Changes one field of the chosen contact straight away (the star, a group), onto the file as it is now. */
    async function quickChange(change: (c: Contact) => Partial<Contact>): Promise<void> {
      const uid = chosen;
      if (!uid || formOpen || saving) return;
      if (await save(list => {
        const now = list.find(x => x.uid === uid);
        if (!now) throw new Error('This contact was deleted in another window.');
        return [...list.filter(x => x.uid !== uid), { ...now, ...change(now) }];
      }, [])) {
        const focused = card.contains(document.activeElement);
        drawFilters();
        drawList();
        drawCard();
        if (focused) card.querySelector<HTMLElement>('button[aria-pressed]')?.focus();
      }
    }
    const toggleFavourite = () => quickChange(c => ({ favourite: !c.favourite }));
    const toggleGroup = (name: string) => quickChange(c => ({ groups: inGroup(c, name) ? c.groups.filter(g => g.toLowerCase() !== name.toLowerCase()) : cleanGroups([...c.groups, name]) }));
    async function newGroup(): Promise<void> {
      const p = current();
      if (!p) return;
      const name = await shell.dialogs.prompt({
        title: 'New group', label: `A group for ${p.name}, such as Neighbours or Book club`, ok: 'Add',
        check: v => (!v.trim() ? 'Give the group a name.' : v.includes(',') ? 'A group name cannot have a comma in it.' : v.trim().length > MAX_GROUP_NAME ? `A group name can be up to ${MAX_GROUP_NAME} characters.` : p.groups.length >= MAX_GROUPS ? `A contact can be in up to ${MAX_GROUPS} groups.` : null),
      });
      if (!name?.trim()) return;
      await quickChange(c => ({ groups: cleanGroups([...c.groups, name]) }));
    }

    async function startNew(): Promise<void> {
      if (saving) return;
      if (await leaveForm()) editCard(null);
    }
    async function startEdit(): Promise<void> {
      const p = current();
      if (p && !formOpen && !saving) editCard(p);
    }
    async function remove(): Promise<void> {
      const p = current();
      if (!p || formOpen || saving) return;
      const ok = await shell.dialogs.confirm({ title: 'Delete this contact?', text: `“${p.name}” will be removed from your contacts.`, ok: 'Delete', danger: true, cancel: 'Keep' });
      if (ok && (await save(list => list.filter(x => x.uid !== p.uid), []))) afterDelete();
    }
    function afterDelete(): void {
      chosen = null;
      drawFilters();
      drawList();
      drawCard();
      (list.querySelector<HTMLElement>('[tabindex="0"]') ?? find).focus();
    }

    function editCard(existing: Contact | null): void {
      const signal = fresh();
      formOpen = true;
      bar.refresh();
      const c = existing ? { ...existing } : emptyContact();
      // A new contact starts in the group (or favourites) being shown.
      if (!existing && show.kind === 'group') c.groups = [show.name];
      if (!existing && show.kind === 'favourites') c.favourite = true;
      // The longest each field may be: what the file reader keeps (src/core/vcard.ts), so nothing typed here is cut
      // quietly the next time the file is read.
      const field = (label: string, value: string, multi = false, max?: number) => {
        if (!multi) return h('input', { type: 'text', class: 'field', value, maxlength: max, 'aria-label': label });
        const area = h('textarea', { class: 'field', rows: 2, maxlength: max, 'aria-label': label });
        area.value = value;
        return area;
      };
      const shown = formValues(c);
      const nameIn = field('Name', shown.name, false, 500);
      const descIn = field('Description', shown.description, false, 300);
      descIn.setAttribute('placeholder', 'Who they are, such as "Ben\'s sister" or "plumber"');
      const orgIn = field('Company', shown.org, false, 500);
      const titleIn = field('Job title', shown.title, false, 200);
      // Groups: a tick for each group in use (and the standard three), and a box for new ones.
      const known = allGroups(people);
      const ticks = known.map(g => h('input', { type: 'checkbox', value: g, checked: inGroup(c, g) }));
      const otherIn = h('input', { type: 'text', class: 'field', value: c.groups.filter(g => !known.some(k => k.toLowerCase() === g.toLowerCase())).join(', '), 'aria-label': 'Other groups (separate them with commas)', placeholder: 'Other groups, such as Book club' });
      const favIn = h('input', { type: 'checkbox', checked: c.favourite });
      const phoneIn = field('Phone numbers (one per line)', shown.phones, true);
      const emailIn = field('Email addresses (one per line)', shown.emails, true);
      const addrIn = field('Address', shown.address, true, 500);
      const bdayIn = h('input', { type: 'date', class: 'field', value: shown.birthday, 'aria-label': 'Birthday' });
      const notesIn = field('Notes', shown.notes, true, 20000);
      const problem = h('p', { class: 'dialog-problem', role: 'alert' });
      const saveBtn = h('button', { type: 'button', class: 'btn primary' }, 'Save');
      const cancel = h('button', { type: 'button', class: 'btn' }, 'Cancel');
      const del = h('button', { type: 'button', class: 'btn danger' }, 'Delete');
      card.replaceChildren(
        h('h2', {}, existing ? 'Edit contact' : 'New contact'),
        h('label', { class: 'form-row' }, 'Name ', nameIn),
        h('label', { class: 'form-row' }, 'Description ', descIn),
        h('div', { class: 'form-pair' },
          h('label', { class: 'form-row' }, 'Company ', orgIn),
          h('label', { class: 'form-row' }, 'Job title ', titleIn)),
        h('fieldset', { class: 'form-groups' }, h('legend', {}, 'Groups'),
          h('div', { class: 'form-group-ticks' }, ...ticks.map(t => h('label', { class: 'form-check' }, t, t.value))),
          otherIn,
          h('label', { class: 'form-check' }, favIn, 'Favourite')),
        h('label', { class: 'form-row' }, 'Phones ', phoneIn),
        h('label', { class: 'form-row' }, 'Emails ', emailIn),
        h('label', { class: 'form-row' }, 'Address ', addrIn),
        h('label', { class: 'form-row' }, 'Birthday ', bdayIn),
        h('label', { class: 'form-row' }, 'Notes ', notesIn),
        problem,
        h('div', { class: 'row-buttons' }, saveBtn, cancel, existing ? del : null),
      );
      const groupsNow = () => cleanGroups([...ticks.filter(t => t.checked).map(t => t.value), ...otherIn.value.split(',')]).join(', ');
      // The groups box as the form opened (the card's own groups, in its own order) while the ticks are unchanged, so
      // opening and saving changes nothing.
      const openedTicks = JSON.stringify([ticks.map(t => t.checked), otherIn.value]);
      const groupsValue = () => (JSON.stringify([ticks.map(t => t.checked), otherIn.value]) === openedTicks ? shown.groups : groupsNow());
      // A group name typed with too many letters is said on Save, not cut: the whole list as typed goes to the check.
      const typedGroups = () => (JSON.stringify([ticks.map(t => t.checked), otherIn.value]) === openedTicks ? shown.groups : [...ticks.filter(t => t.checked).map(t => t.value), otherIn.value].filter(s => s.trim()).join(', '));
      const read = (): FormValues => ({
        name: nameIn.value, description: descIn.value, org: orgIn.value, title: titleIn.value, groups: groupsValue(), favourite: favIn.checked ? '1' : '',
        phones: phoneIn.value, emails: emailIn.value, address: addrIn.value, birthday: bdayIn.value, notes: notesIn.value,
      });
      const opened = existing ? formValues(existing) : read();
      const was = JSON.stringify(read());
      formDirty = () => JSON.stringify(read()) !== was;
      card.addEventListener('input', () => app.setDirty(isDirty()), { signal });
      card.addEventListener('change', () => app.setDirty(isDirty()), { signal });
      nameIn.focus();
      // Ctrl+S, or Enter in a one-line box, saves; Escape leaves the form (asking first if anything was changed).
      card.addEventListener('keydown', (event: KeyboardEvent) => {
        if (event.isComposing) return;
        const plain = !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey;
        if (event.key.toLowerCase() === 's' && (event.ctrlKey || event.metaKey) && !event.altKey) {
          event.preventDefault();
          event.stopPropagation();
          if (!saveBtn.disabled) saveBtn.click();
        } else if (event.key === 'Enter' && plain && event.target instanceof HTMLInputElement && event.target.type === 'text') {
          event.preventDefault();
          if (!saveBtn.disabled) saveBtn.click();
        } else if (event.key === 'Escape' && plain) {
          event.preventDefault();
          event.stopPropagation();
          void leaveForm().then(ok => ok && cancel.click());
        }
      }, { signal });
      saveBtn.addEventListener('click', async () => {
        const changes = formChanges(existing ? opened : null, { ...read(), groups: typedGroups() });
        if (typeof changes === 'string') return void (problem.textContent = changes);
        // Only the fields changed in the form are saved, onto the contact as the file holds it now: a change made in
        // another window since the form opened is kept, and a field not touched here keeps its own line in the file.
        const uid = c.uid;
        if (await save(list => {
          const now = list.find(x => x.uid === uid);
          // An edit of a contact someone deleted meanwhile (another window) is refused, not quietly put back.
          if (existing && !now) throw new Error('This contact was deleted in another window, so your changes were not saved. Choose New contact to add it again.');
          return [...list.filter(x => x.uid !== uid), { ...(now ?? c), ...changes }];
        }, [saveBtn, del])) {
          drawFilters();
          // A person saved out of the group being shown would vanish from the list: show everyone instead.
          const saved = people.find(x => x.uid === uid);
          if (saved && !shownBy(saved, show)) show = { kind: 'all' };
          if (saved && !matches(saved, find.value.trim())) find.value = '';
          drawFilters();
          pick(uid, true);
        }
      }, { signal });
      cancel.addEventListener('click', () => {
        drawCard();
        (rowOf(chosen) ?? find).focus();
      }, { signal });
      del.addEventListener('click', async () => {
        const ok = await shell.dialogs.confirm({ title: 'Delete this contact?', text: `“${c.name}” will be removed from your contacts.`, ok: 'Delete', danger: true, cancel: 'Keep' });
        if (ok && (await save(list => list.filter(x => x.uid !== c.uid), [saveBtn, del]))) afterDelete();
      }, { signal });
    }

    on(list, 'click', (event: MouseEvent) => {
      const row = event.target instanceof Element ? event.target.closest<HTMLElement>('.person-row') : null;
      if (row?.dataset.uid) void leaveForm().then(ok => ok && row.dataset.uid && pick(row.dataset.uid, true));
    }, app.signal);
    on(list, 'dblclick', (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest('.person-row')) void startEdit();
    }, app.signal);
    on(list, 'keydown', (event: KeyboardEvent) => {
      const plain = !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey;
      if (plain && (event.key === 'Enter' || event.key === 'F2')) {
        event.preventDefault();
        return void startEdit();
      }
      if (plain && event.key === 'Delete') {
        event.preventDefault();
        return void remove();
      }
      const rows = [...list.querySelectorAll<HTMLElement>('.person-row')];
      const at = rows.indexOf(document.activeElement as HTMLElement);
      const to = event.key === 'ArrowDown' ? at + 1 : event.key === 'ArrowUp' ? at - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : null;
      if (to === null) return;
      event.preventDefault();
      if (to < 0) return find.focus();
      const row = rows[Math.min(to, rows.length - 1)];
      if (row?.dataset.uid) void leaveForm().then(ok => ok && row.dataset.uid && pick(row.dataset.uid, true));
    }, app.signal);
    // Anywhere in the window: Ctrl+F to the search box, Alt+N for a new contact.
    on(app.root, 'keydown', (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (key === 'f' && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        find.focus();
        find.select();
      } else if (key === 'n' && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        event.preventDefault();
        void startNew();
      }
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
    app.onClose(leaveForm);
    file.watch(shell.changes, app.signal, latest => {
      people = latest;
      drawFilters();
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
    drawFilters();
    drawList();
    drawCard();
    find.focus();
  },
};
