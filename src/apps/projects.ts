// My Projects: a list of what the person is working on (name, site, notes, a star for focus) with one-click buttons
// that book a reminder in the calendar ("Add new feature: Word upgrade", tomorrow at 9:00, with a note). It is a
// reminder tool, not a workload planner: no hours added up, no finish dates worked out. Click a project to see what is
// coming up for it and its past entries with their notes (its log). Settings (the gear) holds the defaults and the
// button list. Projects are kept in Documents/Projects.json; what is booked is ordinary calendar events.
import { h, on } from '../core/dom.ts';
import { CALENDAR_PATH, REMIND_CHOICES, addDays, dateKey, dayLabel, isTime, parseIcs, repeatLabel, repeatsAfter, stopRepeating, timeLabel, writeIcs, type CalEvent } from '../core/ical.ts';
import { parseVcf } from '../core/vcard.ts';
import { recordFile } from '../shell/recordfile.ts';
import type { AppDef } from '../shell/types.ts';
import { APPS } from './catalog.ts';
import { CONTACTS_PATH } from './contacts.ts';
import { askEntry } from './projects/entry-ui.ts';
import {
  MAX_ACTIONS, PROJECTS_PATH, actionProblem, cleanSettings, entryTitle, moveAction, newProject, nextFor, parseProjects,
  projectEntries, readSettings, removeAction, shortTitle, siteHref, sortProjects, writeProjects, writeSettings, type Project, type ProjectSettings,
} from './projects/data.ts';

/** A project's page remembers which list it was opened from, so Back returns there (not to where it is now). */
type View = { kind: 'list' } | { kind: 'finished' } | { kind: 'project'; uid: string; from: 'list' | 'finished' } | { kind: 'settings' };

/** "Today", "Tomorrow" or "Sat 17 Oct". */
function dayWord(day: string, today: string): string {
  return day === today ? 'Today' : day === addDays(today, 1) ? 'Tomorrow' : dayLabel(day);
}

export const projectsApp: AppDef = {
  ...APPS.projects,
  async launch(app, arg) {
    const shell = app.shell;
    const signal = app.signal;
    const file = recordFile(shell.fs, PROJECTS_PATH, parseProjects, writeProjects);
    const calendar = recordFile(shell.fs, CALENDAR_PATH, parseIcs, writeIcs);
    app.root.classList.add('projects-app');

    let projects: Project[] = [];
    let events: CalEvent[] = [];
    let settings: ProjectSettings = cleanSettings({});
    let view: View = { kind: 'list' };
    /** A form is open (editing a project, the settings): a change from elsewhere does not redraw it away. */
    let busyForm = false;

    const addBtn = h('button', { type: 'button', class: 'tool wide' }, 'Add project');
    const apptBtn = h('button', { type: 'button', class: 'tool wide' }, 'Appointment');
    const finishedBtn = h('button', { type: 'button', class: 'tool wide', 'aria-pressed': 'false' }, 'Finished');
    const gearBtn = h('button', { type: 'button', class: 'tool wide', 'aria-pressed': 'false' }, '⚙ Settings');
    const body = h('div', { class: 'proj-body' });
    app.root.append(h('div', { class: 'toolbar' }, addBtn, apptBtn, h('span', { class: 'proj-spacer' }), finishedBtn, gearBtn), body);

    const today = () => dateKey(new Date());
    const find = (uid: string) => projects.find(p => p.uid === uid);

    /** The projects must load; a calendar that cannot be read is said once and the list still opens. */
    async function loadAll(): Promise<void> {
      [projects, settings] = await Promise.all([file.load(), readSettings(shell.fs)]);
      try {
        events = await calendar.load();
      } catch (error) {
        await shell.report('Could not read the calendar', error);
      }
    }

    /** Saves one change to the projects; false (after saying why) when it could not be saved. */
    async function changeProjects(apply: (list: Project[]) => Project[]): Promise<boolean> {
      try {
        projects = await file.change(apply);
        return true;
      } catch (error) {
        await shell.report('Could not save your projects', error);
        return false;
      }
    }
    const patch = (uid: string, fields: Partial<Project>) => changeProjects(list => list.map(p => (p.uid === uid ? { ...p, ...fields, uid } : p)));

    async function changeCalendar(apply: (list: CalEvent[]) => CalEvent[]): Promise<boolean> {
      try {
        events = await calendar.change(apply);
        return true;
      } catch (error) {
        await shell.report('Could not save the calendar', error);
        return false;
      }
    }

    // ---- Drawing ---------------------------------------------------------------------------------------------------
    /** Redraws the current view, putting the keyboard back on the same control (a rebuilt list drops it otherwise). */
    function draw(): void {
      const active = document.activeElement instanceof HTMLElement && app.root.contains(document.activeElement) ? document.activeElement.dataset.key : undefined;
      finishedBtn.setAttribute('aria-pressed', String(view.kind === 'finished'));
      gearBtn.setAttribute('aria-pressed', String(view.kind === 'settings'));
      const done = projects.filter(p => p.finished).length;
      finishedBtn.textContent = view.kind === 'finished' ? 'Back to projects' : `Finished (${done})`;
      busyForm = false;
      if (view.kind === 'project') {
        const p = find(view.uid);
        if (p) drawProject(p, view.from);
        else {
          view = { kind: 'list' };
          drawList(false);
        }
      } else if (view.kind === 'finished') drawList(true);
      else if (view.kind === 'settings') drawSettings();
      else drawList(false);
      if (active) body.querySelector<HTMLElement>(`[data-key="${CSS.escape(active)}"]`)?.focus();
    }

    function star(p: Project): HTMLButtonElement {
      // A filled star or an outline one, so the state is a shape as well as a colour.
      const b = h('button', {
        type: 'button', class: `proj-star${p.focus ? ' on' : ''}`, 'aria-pressed': String(p.focus), 'data-key': `star-${p.uid}`,
        'aria-label': `Focus: ${p.name}`, title: p.focus ? 'Starred: listed first and on the Panel. Click to unstar.' : 'Star it: listed first and on the Panel',
      }, p.focus ? '★' : '☆');
      on(b, 'click', () => void patch(p.uid, { focus: !p.focus }).then(ok => ok && draw()), signal);
      return b;
    }

    function siteLink(p: Project): HTMLElement | null {
      const href = siteHref(p.site);
      if (!href) return p.site ? h('span', { class: 'proj-site' }, p.site) : null;
      return h('a', { class: 'proj-site', href, target: '_blank', rel: 'noopener noreferrer', title: `Open ${href} in a new tab` }, p.site);
    }

    function nextLine(p: Project): HTMLElement {
      const n = nextFor(events, p.uid, today());
      if (!n) return h('span', { class: 'proj-next none' }, 'Nothing booked');
      const what = shortTitle(n.event, p);
      return h('span', { class: 'proj-next' }, `Next: ${dayWord(n.next, today())} ${n.event.start || 'all day'}${what ? ' · ' + what : ''}`);
    }

    function actionButtons(p: Project): HTMLElement {
      const row = h('div', { class: 'proj-actions' });
      settings.actions.forEach((action, i) => {
        const b = h('button', { type: 'button', class: 'btn', 'data-key': `act-${i}-${p.uid}` }, action);
        on(b, 'click', () => void book(p, action), signal);
        row.append(b);
      });
      const meet = h('button', { type: 'button', class: 'btn', 'data-key': `meet-${p.uid}` }, 'Appointment');
      on(meet, 'click', () => void appointment(p), signal);
      row.append(meet);
      return row;
    }

    function drawList(finished: boolean): void {
      const list = sortProjects(projects.filter(p => p.finished === finished));
      const rows = list.map(p => {
        const open = h('button', { type: 'button', class: 'proj-name', 'data-key': `open-${p.uid}` }, p.name);
        on(open, 'click', () => go({ kind: 'project', uid: p.uid, from: finished ? 'finished' : 'list' }), signal);
        const firstLine = p.notes.split('\n').find(l => l.trim()) ?? '';
        const back = finished ? h('button', { type: 'button', class: 'btn', 'data-key': `back-${p.uid}` }, 'Bring back') : null;
        if (back) on(back, 'click', () => void patch(p.uid, { finished: false }).then(ok => ok && (shell.toast(`“${p.name}” is back on your projects.`), draw())), signal);
        return h('li', { class: `proj-row${p.focus ? ' focus' : ''}` },
          h('div', { class: 'proj-line' }, finished ? null : star(p), open, siteLink(p)),
          firstLine ? h('p', { class: 'proj-notes' }, firstLine) : null,
          finished ? null : nextLine(p),
          finished ? back : actionButtons(p));
      });
      const empty = finished
        ? h('p', { class: 'proj-empty' }, 'No finished projects. Finish one from its page; it moves here and can be brought back any time.')
        : h('div', { class: 'proj-empty' },
          h('p', {}, 'No projects yet. Add one: a name, and a site and notes if you like.'),
          h('p', { class: 'hint' }, 'Then one click books a reminder for it in your calendar, such as “Add new feature” tomorrow at 9:00.'));
      body.replaceChildren(
        h('h2', { class: 'proj-heading' }, finished ? 'Finished projects' : 'My projects'),
        rows.length ? h('ul', { class: 'proj-list' }, ...rows) : empty);
    }

    function entryRow(e: CalEvent, when: string, p: Project, withStop: boolean): HTMLElement {
      const rep = repeatLabel(e);
      const stop = withStop && repeatsAfter(e, today()) ? h('button', { type: 'button', class: 'btn', 'data-key': `stop-${e.uid}` }, 'Stop repeating') : null;
      if (stop) {
        on(stop, 'click', async () => {
          const ok = await changeCalendar(list => list.map(x => (x.uid === e.uid ? stopRepeating(x, today()) : x)));
          if (ok) {
            shell.toast(`“${e.title}” stops repeating after today.`);
            draw();
          }
        }, signal);
      }
      return h('li', { class: 'proj-entry' },
        h('div', { class: 'proj-entry-head' },
          h('span', { class: 'proj-when' }, `${when} · ${timeLabel(e)}`),
          h('span', { class: 'proj-entry-title' }, shortTitle(e, p) || e.title)),
        rep || e.where ? h('p', { class: 'hint' }, [rep, e.where ? `At ${e.where}` : ''].filter(Boolean).join(' · ')) : null,
        e.notes ? h('p', { class: 'proj-entry-notes' }, e.notes) : null,
        stop);
    }

    function drawProject(p: Project, from: 'list' | 'finished', editing = false): void {
      const backBtn = h('button', { type: 'button', class: 'btn', 'data-key': 'back' }, from === 'finished' ? '‹ Finished projects' : '‹ All projects');
      on(backBtn, 'click', () => go({ kind: from }), signal);
      const { coming, past } = projectEntries(events, p.uid, today());
      let head: HTMLElement;
      if (editing) {
        busyForm = true;
        const nameIn = h('input', { type: 'text', class: 'field', value: p.name, maxlength: 200, 'aria-label': 'Name' });
        const siteIn = h('input', { type: 'text', class: 'field', value: p.site, maxlength: 500, 'aria-label': 'Site', placeholder: 'optional, such as example.com' });
        const notesIn = h('textarea', { class: 'field', rows: 5, maxlength: 20000, 'aria-label': 'Notes' });
        notesIn.value = p.notes;
        const problem = h('p', { class: 'dialog-problem', role: 'alert' });
        const save = h('button', { type: 'button', class: 'btn primary' }, 'Save');
        const cancel = h('button', { type: 'button', class: 'btn' }, 'Cancel');
        head = h('div', { class: 'proj-edit' },
          h('label', { class: 'form-row' }, 'Name ', nameIn),
          h('label', { class: 'form-row' }, 'Site ', siteIn),
          h('label', { class: 'form-row' }, 'Notes ', notesIn),
          problem, h('div', { class: 'row-buttons' }, save, cancel));
        const doSave = async () => {
          if (!nameIn.value.trim()) return void (problem.textContent = 'Give the project a name.');
          save.disabled = true;
          const ok = await patch(p.uid, { name: nameIn.value.trim(), site: siteIn.value.trim(), notes: notesIn.value });
          save.disabled = false;
          if (ok) draw();
        };
        on(save, 'click', () => void doSave(), signal);
        on(cancel, 'click', () => draw(), signal);
        for (const input of [nameIn, siteIn]) on(input, 'keydown', (e: KeyboardEvent) => e.key === 'Enter' && void doSave(), signal);
        on(head, 'keydown', (e: KeyboardEvent) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            draw();
          }
        }, signal);
        queueMicrotask(() => nameIn.focus());
      } else {
        const edit = h('button', { type: 'button', class: 'btn', 'data-key': 'edit' }, 'Edit');
        on(edit, 'click', () => drawProject(p, from, true), signal);
        const finish = h('button', { type: 'button', class: 'btn', 'data-key': 'finish' }, p.finished ? 'Bring back' : 'Finish');
        on(finish, 'click', async () => {
          if (await patch(p.uid, { finished: !p.finished })) {
            shell.toast(p.finished ? `“${p.name}” is back on your projects.` : `“${p.name}” moved to Finished. Its calendar entries stay.`);
            draw();
          }
        }, signal);
        head = h('div', { class: 'proj-head' },
          h('div', { class: 'proj-line' }, p.finished ? null : star(p), h('h2', { class: 'proj-title' }, p.name), siteLink(p)),
          p.finished ? h('p', { class: 'hint' }, 'Finished. Bring it back to book things for it again.') : null,
          p.notes ? h('p', { class: 'proj-notes-full' }, p.notes) : null,
          h('div', { class: 'row-buttons' }, edit, finish),
          p.finished ? null : actionButtons(p));
      }
      body.replaceChildren(
        h('div', { class: 'proj-page' },
          backBtn, head,
          h('h3', {}, 'Coming up'),
          coming.length
            ? h('ul', { class: 'proj-entries' }, ...coming.map(c => entryRow(c.event, dayWord(c.next, today()), p, true)))
            : h('p', { class: 'hint' }, p.finished ? 'Nothing booked.' : 'Nothing booked. Use a button above to add something to the calendar.'),
          h('h3', {}, 'Log'),
          past.length
            ? h('ul', { class: 'proj-entries' }, ...past.map(e => entryRow(e, dayLabel(e.date, true), p, false)))
            : h('p', { class: 'hint' }, 'Past entries and their notes appear here, newest first.')));
    }

    function drawSettings(): void {
      busyForm = true;
      let actions = [...settings.actions];
      const timeIn = h('input', { type: 'time', class: 'field', value: settings.time, 'aria-label': 'Default time' });
      const hoursIn = h('input', { type: 'number', class: 'field', min: 0.25, max: 24, step: 0.25, value: settings.hours ? String(settings.hours) : '', placeholder: 'none', 'aria-label': 'Default hours' });
      const daySel = h('select', { class: 'field', 'aria-label': 'Default day' }, h('option', { value: 'today' }, 'Today'), h('option', { value: 'tomorrow' }, 'Tomorrow'));
      daySel.value = settings.day;
      const remindSel = h('select', { class: 'field', 'aria-label': 'Default reminder' }, ...REMIND_CHOICES.map(([v, l]) => h('option', { value: v }, l)));
      remindSel.value = String(settings.remind);
      const list = h('ol', { class: 'proj-action-list' });
      const listProblem = h('p', { class: 'dialog-problem', role: 'alert' });
      const newIn = h('input', { type: 'text', class: 'field', maxlength: 40, 'aria-label': 'New button name', placeholder: 'such as Write the blog post' });
      const addAct = h('button', { type: 'button', class: 'btn' }, 'Add button');
      const problem = h('p', { class: 'dialog-problem', role: 'alert' });
      const save = h('button', { type: 'button', class: 'btn primary' }, 'Save settings');
      const cancel = h('button', { type: 'button', class: 'btn' }, 'Cancel');
      const reset = h('button', { type: 'button', class: 'btn' }, 'Back to the defaults');

      const paintActions = (focusKey?: string) => {
        list.replaceChildren(...actions.map((a, i) => {
          const name = h('input', { type: 'text', class: 'field', value: a, maxlength: 40, 'aria-label': `Button ${i + 1} name`, 'data-key': `name-${i}` });
          on(name, 'change', () => {
            const why = actionProblem(actions, name.value, i);
            listProblem.textContent = why ?? '';
            if (why) name.value = actions[i];
            else actions[i] = name.value.trim();
          }, signal);
          const up = h('button', { type: 'button', class: 'tool', 'aria-label': `Move “${a}” up`, 'data-key': `up-${i}`, disabled: i === 0 }, '▲');
          const down = h('button', { type: 'button', class: 'tool', 'aria-label': `Move “${a}” down`, 'data-key': `down-${i}`, disabled: i === actions.length - 1 }, '▼');
          // Kept pressable on the last button, so pressing it says why it stays.
          const remove = h('button', { type: 'button', class: 'tool wide', 'aria-label': `Remove “${a}”`, 'data-key': `rm-${i}` }, 'Remove');
          on(up, 'click', () => (actions = moveAction(actions, i, -1), paintActions(i - 1 > 0 ? `up-${i - 1}` : `down-${i - 1}`)), signal);
          on(down, 'click', () => (actions = moveAction(actions, i, 1), paintActions(i + 1 < actions.length - 1 ? `down-${i + 1}` : `up-${i + 1}`)), signal);
          on(remove, 'click', () => {
            const next = removeAction(actions, i);
            if (!next) return void (listProblem.textContent = 'Keep at least one button: it is how a project gets into the calendar.');
            actions = next;
            listProblem.textContent = '';
            paintActions(`rm-${Math.min(i, actions.length - 1)}`);
          }, signal);
          return h('li', { class: 'proj-action-item' }, name, up, down, remove);
        }));
        if (focusKey) list.querySelector<HTMLElement>(`[data-key="${focusKey}"]`)?.focus();
      };
      const addOne = () => {
        if (actions.length >= MAX_ACTIONS) return void (listProblem.textContent = `${MAX_ACTIONS} buttons at most. Remove one first.`);
        const why = actionProblem(actions, newIn.value);
        listProblem.textContent = why ?? '';
        if (why) return;
        actions.push(newIn.value.trim());
        newIn.value = '';
        paintActions();
        newIn.focus();
      };
      on(addAct, 'click', addOne, signal);
      on(newIn, 'keydown', (e: KeyboardEvent) => e.key === 'Enter' && (e.preventDefault(), addOne()), signal);
      on(reset, 'click', () => {
        const d = cleanSettings({});
        timeIn.value = d.time;
        hoursIn.value = '';
        daySel.value = d.day;
        remindSel.value = String(d.remind);
        actions = [...d.actions];
        paintActions();
      }, signal);
      on(save, 'click', async () => {
        if (!isTime(timeIn.value)) return void (problem.textContent = 'Choose a default time.');
        const hours = hoursIn.value.trim() ? Number(hoursIn.value) : 0;
        if (!Number.isFinite(hours) || hours < 0 || hours > 24) return void (problem.textContent = 'Default hours: a number from 0.25 to 24, or leave it empty.');
        const next = cleanSettings({ time: timeIn.value, hours, day: daySel.value, remind: Number(remindSel.value), actions });
        save.disabled = true;
        try {
          await writeSettings(shell.fs, next);
          settings = next;
          shell.toast('My Projects settings saved.');
          go({ kind: 'list' });
        } catch (error) {
          await shell.report('Could not save the settings', error);
        } finally {
          save.disabled = false;
        }
      }, signal);
      on(cancel, 'click', () => go({ kind: 'list' }), signal);
      paintActions();
      body.replaceChildren(h('div', { class: 'proj-settings' },
        h('h2', { class: 'proj-heading' }, 'Settings'),
        h('p', { class: 'hint' }, 'What a button fills in when it opens. Each window can still change any of it.'),
        h('div', { class: 'proj-settings-grid' },
          h('label', { class: 'form-row' }, 'Default time ', timeIn),
          h('label', { class: 'form-row' }, 'Default hours (empty: no end time) ', hoursIn),
          h('label', { class: 'form-row' }, 'Default day ', daySel),
          h('label', { class: 'form-row' }, 'Default reminder ', remindSel)),
        h('h3', {}, 'Buttons on every project'),
        h('p', { class: 'hint' }, '“Add to calendar” books the project by its name; any other button books “Button: project”.'),
        list, listProblem,
        h('div', { class: 'proj-add-action' }, newIn, addAct),
        problem,
        h('div', { class: 'row-buttons' }, save, cancel, reset)));
    }

    function go(next: View): void {
      view = next;
      draw();
      body.scrollTop = 0;
    }

    // ---- Booking ---------------------------------------------------------------------------------------------------
    async function saveEntry(entry: CalEvent): Promise<void> {
      if (!(await changeCalendar(list => [...list, entry]))) return;
      shell.toast(`In the calendar: ${dayWord(entry.date, today())}, ${timeLabel(entry)} · ${entry.title}`, { label: 'Open Calendar', run: () => void shell.openApp('calendar') });
      if (!busyForm) draw();
    }

    async function book(p: Project, action: string): Promise<void> {
      const entry = await askEntry(shell, { settings, heading: action, title: entryTitle(action, p), project: p });
      if (entry) await saveEntry(entry);
    }

    async function contactNames(): Promise<string[]> {
      try {
        const text = await shell.fs.readText(CONTACTS_PATH);
        return [...new Set(parseVcf(text).map(c => c.name.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b)).slice(0, 500);
      } catch {
        return [];
      }
    }

    async function appointment(p?: Project): Promise<void> {
      const active = sortProjects(projects.filter(x => !x.finished || x.uid === p?.uid));
      const entry = await askEntry(shell, { settings, heading: 'Appointment', project: p, appointment: { projects: active, people: await contactNames() } });
      if (entry) await saveEntry(entry);
    }

    on(addBtn, 'click', async () => {
      const name = h('input', { type: 'text', class: 'field', maxlength: 200, 'aria-label': 'Name', autocomplete: 'off' });
      const site = h('input', { type: 'text', class: 'field', maxlength: 500, 'aria-label': 'Site', placeholder: 'optional, such as example.com', autocomplete: 'off' });
      const notes = h('textarea', { class: 'field', rows: 3, maxlength: 20000, 'aria-label': 'Notes' });
      const ok = await shell.dialogs.ask<boolean>({
        title: 'Add project',
        body: h('div', {}, h('label', { class: 'form-row' }, 'Name ', name), h('label', { class: 'form-row' }, 'Site (optional) ', site), h('label', { class: 'form-row' }, 'Notes ', notes)),
        buttons: [{ label: 'Add', value: true, primary: true }, { label: 'Cancel', value: false }],
        cancel: false,
        primaryEnabled: () => name.value.trim().length > 0,
        focus: () => name,
      });
      if (!ok || !name.value.trim()) return;
      const p = newProject(name.value, site.value, notes.value);
      if (await changeProjects(list => [...list, p])) {
        if (view.kind !== 'list') view = { kind: 'list' };
        draw();
        body.querySelector<HTMLElement>(`[data-key="open-${p.uid}"]`)?.focus();
      }
    }, signal);
    on(apptBtn, 'click', () => void appointment(), signal);
    on(finishedBtn, 'click', () => go({ kind: view.kind === 'finished' ? 'list' : 'finished' }), signal);
    on(gearBtn, 'click', () => go({ kind: view.kind === 'settings' ? 'list' : 'settings' }), signal);

    // Another window or device changed the projects or the calendar (both are in Documents).
    const refresh = (apply: () => void) => {
      apply();
      if (!busyForm) draw();
    };
    file.watch(shell.changes, signal, list => refresh(() => (projects = list)));
    calendar.watch(shell.changes, signal, list => refresh(() => (events = list)));

    /** "project:<uid>" (from the Panel's Focus tile) opens that project's page. */
    const openArg = (a: string | undefined) => {
      const uid = a?.startsWith('project:') ? a.slice(8) : '';
      if (uid && find(uid)) go({ kind: 'project', uid, from: 'list' });
    };
    app.onReopen(a => openArg(a));

    try {
      await loadAll();
    } catch (error) {
      await shell.report('Could not open My Projects', error);
      app.close();
      return;
    }
    draw();
    openArg(arg);
  },
};
