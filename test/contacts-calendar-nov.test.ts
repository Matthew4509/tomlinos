// November office-deep faults O16 to O24: cancelled imported events, the first showing of a series that skips it, a
// damaged contact card kept on save, a stale edit never reviving a deletion, unsaved-form protection in Contacts and
// Calendar, and the My Projects booking rules.
// Run: node --test test/contacts-calendar-nov.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventsOn, eventsShownOn, nextShowing, occursOn, parseIcs, writeIcs, dateKey } from '../src/core/ical.ts';
import { parseVcf, writeVcf } from '../src/core/vcard.ts';
import { entryFrom, parseProjects, projectEntries, writeProjects, type EntryForm } from '../src/apps/projects/data.ts';
import { FileSystem } from '../src/fs/fs.ts';
import { MemoryStore } from '../src/store/memory-store.ts';
import { recordFile } from '../src/shell/recordfile.ts';

const ics = (...events: string[][]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events.flatMap(e => ['BEGIN:VEVENT', ...e, 'END:VEVENT']), 'END:VCALENDAR', ''].join('\r\n');

test('O16: a cancelled imported event is not shown or booked, and is written back as it was', () => {
  const text = ics(['UID:c1', 'DTSTART:20261110T090000', 'SUMMARY:Cancelled meeting', 'STATUS:CANCELLED']);
  const events = parseIcs(text);
  assert.equal(eventsOn(events, '2026-11-10').length, 0);
  assert.equal(eventsShownOn(events, '2026-11-10').length, 0);
  assert.equal(nextShowing(events[0], '2026-11-01'), null);
  assert.match(writeIcs(events, text), /STATUS:CANCELLED/);
});

test('O18: the next showing skips an excluded first day', () => {
  const [e] = parseIcs(ics(['UID:d1', 'DTSTART:20261110T090000', 'RRULE:FREQ=DAILY', 'EXDATE:20261110T090000', 'SUMMARY:Daily']));
  assert.equal(occursOn(e, '2026-11-10'), false);
  assert.equal(nextShowing(e, '2026-11-10'), '2026-11-11');
  assert.equal(nextShowing(e, '2026-11-05'), '2026-11-11');
});

test('O19: a damaged contact card is kept when another contact is saved', () => {
  const text = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:a\r\nFN:Alice\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:3.0\r\nUID:b\r\nFN:Bob\r\nTEL:123\r\n';
  const people = parseVcf(text);
  assert.deepEqual(people.map(p => p.name), ['Alice']);
  const out = writeVcf([...people, { ...people[0], uid: 'new', name: 'Carol', keep: undefined }], text);
  assert.match(out, /FN:Bob/);
  assert.match(out, /TEL:123/);
  assert.match(out, /FN:Carol/);
  // Written again from what was written, nothing grows or is lost.
  const again = writeVcf(parseVcf(out), out);
  assert.equal((again.match(/FN:Bob/g) ?? []).length, 1);
});

test('O19: a card cut off by the next BEGIN is kept too', () => {
  const text = 'BEGIN:VCARD\r\nFN:Cut\r\nBEGIN:VCARD\r\nUID:z\r\nFN:Zed\r\nEND:VCARD\r\n';
  assert.deepEqual(parseVcf(text).map(p => p.name), ['Zed']);
  assert.match(writeVcf(parseVcf(text), text), /FN:Cut/);
});

const form = (f: Partial<EntryForm>): EntryForm => ({ title: 'Visit', day: '2026-11-01', allDay: false, start: '09:00', hours: '', daily: false, runDays: 0, remind: 0, notes: '', ...f });

test('O22: an ongoing multi-day booking is coming, with its real end, not only past', () => {
  const e = entryFrom(form({ project: 'p', day: '2026-11-01', allDay: true }), 'v1');
  assert.ok(typeof e !== 'string');
  const ongoing = { ...e, endDate: '2026-11-04' };
  const { coming, past } = projectEntries([ongoing], 'p', '2026-11-02');
  assert.equal(coming.length, 1);
  assert.equal(coming[0].next, '2026-11-02');
  assert.equal(coming[0].event.endDate, '2026-11-04');
  assert.equal(past.length, 1);
  assert.equal(projectEntries([ongoing], 'p', '2026-11-05').coming.length, 0);
});

test('O23: a duration under a minute is refused', () => {
  assert.match(String(entryFrom(form({ hours: '0.001' }))), /minute/);
  assert.equal(typeof entryFrom(form({ hours: '0.25' })), 'object');
});

test('O24: two different projects with one id both survive and stay apart', () => {
  const list = parseProjects(JSON.stringify([{ uid: 'b', name: 'B' }, { uid: 'b', name: 'B2' }, { uid: 'b', name: 'B' }]));
  assert.deepEqual(list.map(p => p.name), ['B', 'B2']);
  assert.equal(new Set(list.map(p => p.uid)).size, 2);
  assert.equal(list[0].uid, 'b');
  const back = parseProjects(writeProjects(list));
  assert.deepEqual(back.map(p => [p.uid, p.name]), list.map(p => [p.uid, p.name]));
});

// ---- Controller tests: a small element fixture, not a browser. ----
// Contacts has a classic menu bar now, which needs a real page (it measures and watches sizes), so its O20 and O21
// checks run in Chrome: test/browser-contacts-groups.mjs.
class Fixture {
  tagName: string; attrs: Record<string, string> = {}; children: Fixture[] = []; listeners: Record<string, Array<{ fn: (e: unknown) => unknown; signal?: AbortSignal }>> = {};
  value = ''; checked = false; hidden = false; disabled = false; dataset: Record<string, string> = {}; parentElement: Fixture | null = null; _text = '';
  classList = { add: (...n: string[]) => { this.attrs.class = [this.attrs.class, ...n].filter(Boolean).join(' '); } };
  constructor(tag: string, text = '') { this.tagName = tag.toUpperCase(); this._text = text; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; if (k === 'value') this.value = v; if (k === 'checked') this.checked = true; if (k.startsWith('data-')) this.dataset[k.slice(5)] = v; }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  append(...kids: Array<Fixture | string | null>) { for (const k of kids) { if (typeof k === 'string') { this.children.push(new Fixture('#text', k)); continue; } if (k) { k.parentElement = this; this.children.push(k); } } }
  replaceChildren(...kids: Array<Fixture | string | null>) { this.children = []; this._text = ''; this.append(...kids); }
  set textContent(s: string) { this._text = s; this.children = []; }
  get textContent(): string { return this._text + this.children.map(c => c.textContent).join(''); }
  matches(sel: string): boolean {
    if (sel.startsWith('.')) return (this.attrs.class ?? '').split(' ').includes(sel.slice(1));
    if (sel.startsWith('[')) { const m = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(sel); return !!m && (m[2] === undefined ? m[1] in this.attrs : this.attrs[m[1]] === m[2]); }
    return this.tagName === sel.toUpperCase();
  }
  querySelectorAll(sel: string): Fixture[] { return this.children.flatMap(c => [...(c.matches(sel) ? [c] : []), ...c.querySelectorAll(sel)]); }
  querySelector(sel: string) { return this.querySelectorAll(sel)[0] ?? null; }
  closest(sel: string): Fixture | null { return this.matches(sel) ? this : this.parentElement?.closest(sel) ?? null; }
  addEventListener(type: string, fn: (e: unknown) => unknown, options: { signal?: AbortSignal } = {}) { (this.listeners[type] ??= []).push({ fn, signal: options.signal }); }
  async fire(type: string, target: Fixture = this) { for (const x of this.listeners[type] ?? []) if (!x.signal?.aborted) await x.fn({ target, key: '', preventDefault() {} }); }
  focus() { (globalThis as { document: { activeElement: unknown } }).document.activeElement = this; }
}
Object.assign(globalThis, { Element: Fixture, HTMLElement: Fixture, CSS: { escape: (s: string) => s }, document: { createElement: (t: string) => new Fixture(t), createTextNode: (t: string) => new Fixture('#text', t), activeElement: null } });
const { calendarApp } = await import('../src/apps/calendar.ts');

async function launch(def: { launch: (app: never, arg?: string) => unknown }, files: Record<string, string>) {
  const fs = new FileSystem(new MemoryStore());
  await fs.list('/');
  for (const [p, t] of Object.entries(files)) await fs.writeText(p, t);
  const ctl = new AbortController();
  const state = { confirms: 0, answer: false, reports: [] as string[], guards: [] as Array<() => boolean | Promise<boolean>>, dirty: false };
  const app = {
    root: new Fixture('div'), signal: ctl.signal, setTitle() {}, setDirty: (d: boolean) => { state.dirty = d; }, onClose: (g: () => boolean | Promise<boolean>) => state.guards.push(g), close() {},
    shell: { fs, changes: { on() {} }, dialogs: { confirm: async () => { state.confirms++; return state.answer; } }, report: async (_t: string, e: unknown) => { state.reports.push(String(e)); } },
  };
  await def.launch(app as never);
  return { fs, app, state, button: (label: string) => app.root.querySelectorAll('button').find(b => b.textContent === label)! };
}

const today = dateKey(new Date());
const MEETING = ics(['UID:m1', `DTSTART:${today.replace(/-/g, '')}T090000`, 'SUMMARY:Meeting']);

test('O20: Calendar: a stale edit does not revive an event deleted in another window', async () => {
  const t = await launch(calendarApp, { '/Documents/Calendar.ics': MEETING });
  await t.app.root.querySelector('.cal-event')!.fire('click');
  const file = recordFile(t.fs, '/Documents/Calendar.ics', parseIcs, writeIcs);
  await file.change(() => []);
  t.app.root.querySelector('[aria-label="What"]')!.value = 'Late edit';
  await t.button('Save').fire('click');
  assert.equal((await file.load()).length, 0);
  assert.equal(t.state.reports.length, 1);
});

test('O21: Calendar asks before an unsaved form is dropped by choosing another day, New, or closing', async () => {
  const t = await launch(calendarApp, {});
  const grid = t.app.root.querySelector('.cal-month-grid')!;
  await t.button('New event').fire('click');
  assert.equal(t.state.confirms, 0);
  t.app.root.querySelector('[aria-label="What"]')!.value = 'Typed but unsaved';
  await grid.fire('click', grid.querySelector('.cal-cell')!);
  assert.equal(t.state.confirms, 1);
  assert.ok(t.app.root.querySelector('[aria-label="What"]'));
  await t.button('New event').fire('click');
  assert.equal(t.state.confirms, 2);
  assert.equal(t.state.guards.length, 1);
  assert.equal(await t.state.guards[0](), false);
  t.state.answer = true;
  await grid.fire('click', grid.querySelector('.cal-cell')!);
  assert.equal(t.app.root.querySelector('[aria-label="What"]'), null);
});

test('CAL-P1-6: a click on a day during a save waits for the save instead of asking, and the finished save never replaces a form opened after it', async () => {
  const t = await launch(calendarApp, {});
  const grid = t.app.root.querySelector('.cal-month-grid')!;
  // The save is held until released, as on a slow connection.
  const write = t.fs.writeText.bind(t.fs);
  let release = () => {};
  const hold = () => { const gate = new Promise<void>(r => (release = r)); t.fs.writeText = (async (...a: Parameters<typeof write>) => { await gate; return write(...a); }) as typeof write; };
  const settle = () => new Promise(r => setTimeout(r, 20));

  hold();
  await t.button('New event').fire('click');
  t.app.root.querySelector('[aria-label="What"]')!.value = 'Lunch';
  const saving = t.button('Save').fire('click');
  await settle();
  const cell = grid.querySelectorAll('.cal-cell')[10];
  const clicked = grid.fire('click', cell);
  await settle();
  assert.equal(t.state.confirms, 0, 'no "Discard?" while the save is on its way');
  release();
  await saving;
  await clicked;
  assert.equal(t.state.confirms, 0);
  assert.equal(t.app.root.querySelector('[aria-label="What"]'), null, 'the day is shown after the save');
  assert.equal(t.state.reports.length, 0);

  // A form opened while a save is on its way is not replaced when the save finishes.
  hold();
  await t.button('New event').fire('click');
  t.app.root.querySelector('[aria-label="What"]')!.value = 'Dinner';
  const second = t.button('Save').fire('click');
  await settle();
  const opened = t.button('New event').fire('click');
  await settle();
  release();
  await second;
  await opened;
  await settle();
  const what = t.app.root.querySelector('[aria-label="What"]');
  assert.ok(what, 'the new form is open');
  assert.equal(what!.value, '', 'and it is the new, empty one');
  const file = recordFile(t.fs, '/Documents/Calendar.ics', parseIcs, writeIcs);
  assert.deepEqual((await file.load()).map(e => e.title).sort(), ['Dinner', 'Lunch']);
});

test('O17: a repeating event written in another zone keeps its time there across a daylight-saving change, so it moves here', () => {
  const before = process.env.TZ;
  process.env.TZ = 'Australia/Sydney';
  try {
    const text = ics(['UID:z1', 'DTSTART;TZID=Europe/London:20261012T090000', 'DTEND;TZID=Europe/London:20261012T100000', 'RRULE:FREQ=WEEKLY', 'SUMMARY:London stand-up']);
    const events = parseIcs(text);
    const at = (day: string) => eventsOn(events, day).map(e => `${e.start}-${e.end}`);
    // London is on summer time (UTC+1) and Sydney on summer time (UTC+11): 09:00 there is 19:00 here.
    assert.deepEqual(at('2026-10-12'), ['19:00-20:00']);
    assert.deepEqual(at('2026-10-19'), ['19:00-20:00']);
    // London goes back to UTC on 25 October: the same 09:00 there is an hour later here.
    assert.deepEqual(at('2026-10-26'), ['20:00-21:00']);
    assert.deepEqual(at('2026-11-02'), ['20:00-21:00']);
    assert.deepEqual(eventsShownOn(events, '2026-11-02').map(e => e.start), ['20:00']);
    // Sydney goes back to winter time on 4 April 2027, London already on summer time again (28 March): 09:00 there is 18:00 here.
    assert.deepEqual(at('2027-03-22'), ['20:00-21:00']);
    assert.deepEqual(at('2027-04-12'), ['18:00-19:00']);
    // Only what is shown moves: the event itself, and what is written back, keep the first showing's time.
    assert.equal(events[0].start, '19:00');
    assert.equal(writeIcs(events, text), writeIcs(parseIcs(text), text));
    assert.match(writeIcs(events, text), /DTSTART;TZID=Europe\/London:20261012T090000/);
    // A showing opened to edit is the event itself, not the moved copy.
    assert.equal(eventsOn(events, '2026-11-02')[0].of, events[0]);
    // A UTC time repeats by the same rule; a time with no zone (a floating one) never moves.
    const utc = parseIcs(ics(['UID:z2', 'DTSTART:20261012T080000Z', 'RRULE:FREQ=WEEKLY', 'SUMMARY:UTC']));
    assert.deepEqual(eventsOn(utc, '2026-11-02').map(e => e.start), ['19:00']);
    const floating = parseIcs(ics(['UID:z3', 'DTSTART:20261012T090000', 'RRULE:FREQ=WEEKLY', 'SUMMARY:Floating']));
    assert.deepEqual(eventsOn(floating, '2026-11-02').map(e => e.start), ['09:00']);
  } finally {
    if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
  }
});
