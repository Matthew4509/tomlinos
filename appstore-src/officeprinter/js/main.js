// Office Printer B. It starts as an ordinary printer error and stays believable for as long as it can:
//   1. the (!) in the taskbar opens a small status panel, bottom right: Error printing, the ink levels, Try another printer?
//   2. Yes opens a license agreement in the middle of the screen, and times how long you take to accept it
//   3. reading check: the printer list on the left ("Connecting to the next printer..."), on the right Hamlet (or all of
//      Sherlock Holmes) flashing past at the reading speed you just claimed
//   4. the Dot Matrix prints, slowly, left to right, then refuses (file type, ribbon, or a jam)
//   5. the Home Inkjet prints, needs calibrating, and uses all the cyan; the printers' own chat appears on the right
//   6. the Canon is out of paper, however many times you press OK; the chat roasts you
//   7 on: more printers, each stranger than the last (more.js), then the summary, then the (!) again for v4
// All the words are in script.json. ?speed=N plays N times faster (the tests); ?reason=filetype|ribbon|jam fixes the
// Dot Matrix's excuse; ?at=photo|receipt|fax|threed|fridge|strike|cloud starts at one of the later printers.
import { buildTerms, countWords } from './terms.js';
import { loadLines, makeBook, runBook, showAll } from './reader.js';
import { dotMatrix, inkjet } from './machines.js';
import { morePrinters } from './more.js';

const params = new URLSearchParams(location.search);
const speed = Math.min(50, Math.max(0.1, Number(params.get('speed')) || 1));
const forcedReason = params.get('reason');
// Where the Reader lives: beside this page (the demo), or where TOMLIN OS says (?reader=/reader/, a path on this same site).
const readerAt = params.get('reader') ?? '';
const READER = /^\/[A-Za-z0-9._\/-]*\/$/.test(readerAt) && !readerAt.includes('//') && !readerAt.includes('..') ? readerAt : '../reader/';

const fill = (text, vars = {}) => String(text).replace(/\{(\w+)\}/g, (whole, k) => (k in vars ? vars[k] : whole));
const num = n => Math.round(n).toLocaleString('en-GB');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
function duration(s) {
  if (s < 10) return `${s.toFixed(1)} seconds`;
  if (s < 60) return plural(Math.round(s), 'second');
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const r = Math.round(s % 60);
    return r ? `${plural(m, 'minute')} ${plural(r, 'second')}` : plural(m, 'minute');
  }
  const hr = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m ? `${plural(hr, 'hour')} ${plural(m, 'minute')}` : plural(hr, 'hour');
}
function clock(s) {
  const t = Math.max(0, Math.ceil(s));
  const hr = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, '0');
  return hr ? `${hr}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  setTimeout(() => (signal?.aborted ? reject(new DOMException('Stopped', 'AbortError')) : resolve()), ms / speed);
});
const between = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

/** Builds an element: h('p', { class, text, onclick, ...attributes }, ...children). Never sets a style attribute. */
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid);
  return el;
}

const ICONS = {
  printer: '<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="9" y="4" width="14" height="8" fill="#fff" stroke="#555"/><rect x="3" y="11" width="26" height="12" rx="2" fill="#6b7280"/><rect x="9" y="19" width="14" height="9" fill="#fff" stroke="#555"/><circle cx="25" cy="15" r="1.4" fill="#4ade80"/></svg>',
  alert: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7.5" fill="#d83b01"/><rect x="7" y="3.5" width="2" height="6" fill="#fff"/><rect x="7" y="11" width="2" height="2" fill="#fff"/></svg>',
  grid: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1" y="1" width="6" height="6" fill="#fff"/><rect x="9" y="1" width="6" height="6" fill="#fff"/><rect x="1" y="9" width="6" height="6" fill="#fff"/><rect x="9" y="9" width="6" height="6" fill="#fff"/></svg>',
  speaker: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6h3l4-3v10L5 10H2z" fill="#fff"/><path d="M11 5.5a4 4 0 0 1 0 5" stroke="#fff" fill="none"/></svg>',
  network: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="8" fill="none" stroke="#fff"/><rect x="6" y="12" width="4" height="2" fill="#fff"/></svg>',
  note: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2h12v9H6l-4 3z" fill="none" stroke="#fff"/></svg>',
};
/**
 * One of this file's own SVG drawings as elements. Not innerHTML: inside TOMLIN OS the page's security policy (Trusted
 * Types) refuses HTML made from a string. Reads only what these drawings use: tags, attributes in double quotes, text.
 */
function drawing(markup) {
  const out = document.createDocumentFragment();
  const open = [out];
  for (const m of markup.matchAll(/<(\/?)([a-zA-Z]+)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>|([^<]+)/g)) {
    if (m[5] !== undefined) open[open.length - 1].append(m[5]);
    else if (m[1]) open.pop();
    else {
      const el = document.createElementNS('http://www.w3.org/2000/svg', m[2]);
      for (const [, name, value] of m[3].matchAll(/([\w:-]+)="([^"]*)"/g)) el.setAttribute(name, value);
      open[open.length - 1].append(el);
      if (!m[4]) open.push(el);
    }
  }
  return out;
}
const icon = (name, cls = 'b-icon') => h('span', { class: cls }, drawing(ICONS[name]));

let S;
let LIB;
let game;
let current = null;
const desk = document.getElementById('desk');
const layer = h('div', { class: 'b-layer' });

function newGame() {
  return { chat: [], unread: 0, ink: {}, tosSeconds: 0, tosWords: 0, wps: 0, wordsRead: 0, startedAt: 0, tried: new Set(['laserjet']), found: new Set(['laserjet']), statuses: {}, printed: 0 };
}
const printer = id => S.printers.find(p => p.id === id);
const printerName = id => `${printer(id).name} (${printer(id).place})`;
const randomInk = () => ({ c: between(50, 90), m: between(50, 90), y: between(50, 90), k: between(50, 90) });

/** Whatever screen is up: its abort controller (stops its printer and timers) and its element. */
function closeCurrent() {
  if (!current) return;
  current.abort.abort();
  current.el.remove();
  current = null;
}
function show(el) {
  closeCurrent();
  current = { el, abort: new AbortController() };
  layer.append(el);
  return current.abort.signal;
}
const quiet = promise => promise.catch(e => { if (e?.name !== 'AbortError') throw e; });

/** A window: title bar with its own close button, then the body. */
function windowFrame(title, cls, onClose) {
  const body = h('div', { class: 'b-win-body' });
  const el = h('section', { class: `b-win ${cls}`, role: 'dialog', 'aria-label': title },
    h('header', { class: 'b-titlebar' }, h('span', { class: 'b-title', text: title }),
      h('button', { class: 'b-x', type: 'button', 'aria-label': 'Close', text: '✕', onclick: onClose })),
    body);
  return { el, body };
}

function inkBars(levels) {
  const names = { c: 'Cyan', m: 'Magenta', y: 'Yellow', k: 'Black' };
  const bars = {};
  const el = h('div', { class: 'b-ink' }, Object.keys(names).map(k => {
    const fillEl = h('span', { class: `b-ink-fill b-ink-${k}` });
    const pct = h('span', { class: 'b-ink-pct' });
    bars[k] = { fillEl, pct, box: null };
    const box = h('span', { class: 'b-ink-tank' }, fillEl);
    bars[k].box = box;
    return h('span', { class: 'b-ink-col', title: names[k] }, pct, box, h('span', { class: 'b-ink-letter', text: k.toUpperCase() }));
  }));
  const set = next => {
    for (const k of Object.keys(bars)) {
      const v = next[k];
      bars[k].fillEl.style.height = `${v}%`;
      bars[k].pct.textContent = `${v}%`;
      bars[k].box.classList.toggle('is-empty', v === 0);
      bars[k].box.setAttribute('aria-label', `${names[k]} ${v}%`);
    }
  };
  set(levels);
  return { el, set };
}

// ---------- The desktop: wallpaper, taskbar, the (!) and its toast ----------

function taskbar() {
  const time = h('span', { class: 'b-clock-time' });
  const date = h('span', { class: 'b-clock-date' });
  const tick = () => {
    const now = new Date();
    time.textContent = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    date.textContent = now.toLocaleDateString('en-GB');
  };
  tick();
  setInterval(tick, 15000);
  const alertBtn = h('button', { class: 'b-tray-btn b-tray-alert', type: 'button', 'aria-label': 'Printer error. Select for details.', title: 'Printer error', onclick: () => openStatus() },
    icon('printer', 'b-tray-printer'), h('span', { class: 'b-badge', text: '!' }));
  return h('footer', { class: 'b-taskbar' },
    h('span', { class: 'b-start' }, icon('grid')),
    h('span', { class: 'b-search', text: 'Type here to search' }),
    h('span', { class: 'b-tray' },
      h('span', { class: 'b-tray-item', text: '^', 'aria-hidden': 'true' }),
      alertBtn,
      icon('speaker', 'b-tray-item'), icon('network', 'b-tray-item'),
      h('span', { class: 'b-tray-item b-lang', text: 'ENG' }),
      h('span', { class: 'b-clock' }, time, date),
      h('span', { class: 'b-tray-item b-notes' }, icon('note'))));
}

function toast(force = false) {
  // Already looking at the error: no toast about it (unless it is a new error: the end of the game starts it again).
  if (current && !force) return;
  const el = h('button', { class: 'b-toast', type: 'button', onclick: () => { el.remove(); openStatus(); } },
    icon('printer', 'b-toast-icon'),
    h('span', { class: 'b-toast-text' },
      h('strong', { text: S.toast.title }),
      h('span', { text: fill(S.toast.text, { doc: S.doc.name }) })));
  layer.append(el);
  setTimeout(() => el.remove(), 9000);
}

// ---------- 1. The status panel, bottom right ----------

function openStatus() {
  for (const t of layer.querySelectorAll('.b-toast')) t.remove();
  game = newGame();
  game.ink.laserjet = randomInk();
  const t = S.status;
  const { el, body } = windowFrame(t.title, 'b-status', () => closeCurrent());
  body.append(
    h('div', { class: 'b-status-top' },
      icon('printer', 'b-status-printer'),
      h('div', { class: 'b-status-box' },
        h('p', { class: 'b-status-line' }, icon('alert', 'b-alert-icon'), h('strong', { text: t.headline })),
        h('p', { text: fill(t.detail, { doc: S.doc.name }) }))),
    h('p', { class: 'b-ink-label', text: t.inkLabel }),
    inkBars(game.ink.laserjet).el,
    h('p', { class: 'b-question', text: t.question }),
    h('div', { class: 'b-buttons' },
      h('button', { class: 'b-btn b-primary', type: 'button', text: t.yes, onclick: () => { game.startedAt = Date.now(); openTerms(); } }),
      h('button', { class: 'b-btn', type: 'button', text: t.no, onclick: () => closeCurrent() })));
  show(el);
  el.querySelector('.b-primary').focus();
}

// ---------- 2. The license agreement, in the middle ----------

let terms;
function openTerms() {
  const t = S.terms;
  terms ??= buildTerms(t);
  const { el, body } = windowFrame(t.window, 'b-wizard', () => closeCurrent());
  const box = h('div', { class: 'b-terms', tabindex: '0', role: 'document', 'aria-label': t.title },
    h('h3', { text: t.title }), h('p', { class: 'b-terms-updated', text: t.updated }),
    terms.parts.map((part, i) => [
      i ? h('h3', { text: part.part }) : null,
      part.sections.map(sec => [
        h('p', { class: 'b-terms-sec' }, h('strong', { text: `${sec.n}. ${sec.title}` })),
        sec.clauses.map(c => h('p', { text: `${c.n} ${c.text}` })),
      ]),
    ]));
  const next = h('button', { class: 'b-btn b-primary', type: 'button', text: 'Next >', disabled: true });
  const radio = (value, label, checked) => h('label', { class: 'b-radio' },
    h('input', { type: 'radio', name: 'b-accept', value, checked, onchange: () => { next.disabled = value !== 'yes'; } }), h('span', { text: label }));
  body.append(
    h('div', { class: 'b-wizard-head' },
      h('div', {}, h('p', { class: 'b-wizard-heading', text: t.heading }), h('p', { class: 'b-wizard-sub', text: t.sub })),
      icon('printer', 'b-wizard-icon')),
    h('div', { class: 'b-wizard-main' }, box,
      h('div', { class: 'b-radios', role: 'radiogroup' }, radio('yes', t.accept, false), radio('no', t.decline, true))),
    h('div', { class: 'b-wizard-foot' },
      h('button', { class: 'b-btn', type: 'button', text: 'Print', onclick: () => message(t.printFail) }),
      h('span', { class: 'b-spacer' }),
      h('button', { class: 'b-btn', type: 'button', text: '< Back', disabled: true }),
      next,
      h('button', { class: 'b-btn', type: 'button', text: 'Cancel', onclick: () => closeCurrent() })));
  show(el);
  const started = performance.now();
  next.addEventListener('click', () => {
    game.tosSeconds = Math.max(0.2, (performance.now() - started) / 1000);
    game.tosWords = countWords(box.textContent);
    game.wps = game.tosWords / game.tosSeconds;
    game.wordsRead += game.tosWords;
    openReading();
  });
  box.focus();
}

/** A small message box over everything, with OK. */
function message(text) {
  const ok = h('button', { class: 'b-btn b-primary', type: 'button', text: 'OK' });
  const el = h('div', { class: 'b-modal-back' },
    h('section', { class: 'b-win b-message', role: 'alertdialog', 'aria-label': text },
      h('header', { class: 'b-titlebar' }, h('span', { class: 'b-title', text: 'Printing' })),
      h('div', { class: 'b-win-body' }, h('p', { class: 'b-message-line' }, icon('alert', 'b-alert-icon'), h('span', { text })),
        h('div', { class: 'b-buttons' }, ok))));
  ok.addEventListener('click', () => el.remove());
  layer.append(el);
  ok.focus();
}

// ---------- 3 to 6: the printer window (printer list left, judgement or chat right) ----------

function mainWindow() {
  const list = h('ul', { class: 'b-list', 'aria-label': 'Printers on this network' });
  const rows = {};
  // Newest first, so the oldest (the Dot Matrix, 1987) is at the bottom.
  for (const p of [...S.printers].sort((a, b) => b.added - a.added)) {
    const status = h('span', { class: 'b-list-status' });
    const li = h('li', { class: 'b-list-row' }, icon('printer', 'b-list-icon'),
      h('span', { class: 'b-list-text' }, h('strong', { text: `${p.name} (${p.place})` }), h('span', { class: 'b-list-sub' }, `Added ${p.added} · `, status)));
    // Only printers already connected to are listed: the list grows one printer at a time, so it never runs out.
    li.hidden = !game.found.has(p.id);
    rows[p.id] = { li, status };
    list.append(li);
  }
  const stage = h('div', { class: 'b-stage' });
  const right = h('div', { class: 'b-right', 'aria-live': 'polite' });
  const foot = h('div', { class: 'b-main-foot' });
  const { el, body } = windowFrame(S.terms.window, 'b-main', () => closeCurrent());
  body.append(h('div', { class: 'b-split' },
    h('div', { class: 'b-left' }, h('p', { class: 'b-left-heading', text: 'Printers on this network' }), list, stage),
    h('div', { class: 'b-right-wrap' }, right, foot)));
  // Statuses carry over from window to window: the Dot Matrix stays in error once it has refused.
  const statuses = game.statuses;
  statuses.laserjet ??= 'Error';
  statuses.photo ??= 'Offline';
  const setStatus = (id, text) => {
    statuses[id] = text;
    rows[id].status.textContent = text;
    rows[id].li.classList.toggle('is-error', /error|empty|run out|offline|jam|worn|unsupported|strike|full/i.test(text));
  };
  for (const p of S.printers) setStatus(p.id, statuses[p.id] ?? 'Ready');
  const select = id => {
    if (!game.found.has(id)) {
      game.found.add(id);
      rows[id].li.hidden = false;
      rows[id].li.classList.add('is-new');
    }
    for (const [k, r] of Object.entries(rows)) {
      r.li.classList.toggle('is-current', k === id);
      if (k === id) r.li.setAttribute('aria-current', 'true');
      else r.li.removeAttribute('aria-current');
    }
    game.tried.add(id);
  };
  return { el, stage, right, foot, setStatus, select };
}

const button = (text, onclick, primary = false) => h('button', { class: `b-btn${primary ? ' b-primary' : ''}`, type: 'button', text, onclick });
const para = text => h('p', { text });

function openReading() {
  const r = S.reading;
  const w = mainWindow();
  const signal = show(w.el);
  // Only the LaserJet is listed while it looks for the next printer; the Dot Matrix appears once it is found.
  w.select('laserjet');
  const connecting = h('p', { class: 'b-connecting' }, h('span', { class: 'b-spinner', 'aria-hidden': 'true' }), h('span', { text: r.connecting }));
  w.stage.append(connecting);
  quiet(sleep(4500, signal).then(() => {
    connecting.replaceChildren(h('span', { class: 'b-found', text: r.found }));
    w.setStatus('dotmatrix', 'Ready');
    w.select('dotmatrix');
  }));

  const judgement = h('div', { class: 'b-judgement' }, h('p', { class: 'b-took', text: fill(r.took, { seconds: duration(game.tosSeconds) }) }));
  const readerSlot = h('div', {});
  w.right.append(judgement, readerSlot);

  let run = null;
  const read = async choice => {
    run?.stop();
    quizBtn.hidden = true;
    readerSlot.replaceChildren(para(`Loading ${choice.title}...`));
    let book;
    try {
      // The texts belong to the Reader (its library.json names them), so they are read from beside it.
      book = makeBook(await loadLines(new URL(`${READER}${choice.file}`, location.href).pathname), choice.start, choice.end, choice.heads);
    } catch (e) {
      readerSlot.replaceChildren(para(`${choice.title} could not be loaded: ${e.message}.`));
      return;
    }
    if (signal.aborted) return;
    const full = book.words / game.wps;
    const wps = full > 120 ? book.words / 120 : game.wps;
    const view = { heading: h('p', { class: 'b-reader-heading' }), text: h('pre', { class: 'b-reader-text' }), meta: h('p', { class: 'b-reader-meta' }), bar: h('span', { class: 'b-reader-bar' }) };
    readerSlot.replaceChildren(h('div', { class: 'b-judgement' },
      para(fill(r.showing, { title: choice.title })),
      full > 120 ? para(fill(r.capped, { full: duration(full) })) : null,
      h('div', { class: 'b-reader' }, view.heading, view.text, h('span', { class: 'b-reader-track' }, view.bar), view.meta),
      h('div', { class: 'b-buttons b-reader-open' }, button(r.reader, () => openReaderWindow(choice.authorId, choice.workId)))));
    const started = performance.now();
    run = runBook(book, wps, view, speed, { num, clock });
    if (await run.done) {
      game.wordsRead += book.words;
      showAll(book, view, r.end);
      readerSlot.append(para(fill(r.done, { title: choice.title, words: num(book.words), seconds: duration((performance.now() - started) / 1000 * speed) })));
      // Finished a book: now the quiz on it is on offer (never required).
      finished = { choice, seconds: full };
      quizBtn.hidden = !S.quiz.sets[choice.id];
    }
  };
  let finished = null;
  const quizBtn = button(r.quiz, () => quiz(finished));
  quizBtn.hidden = true;

  /** Ten questions on the book just finished, one at a time, answers in a new order each time. */
  const quiz = ({ choice, seconds }) => {
    run?.stop();
    quizBtn.hidden = true;
    const q = S.quiz;
    const set = q.sets[choice.id];
    const vars = { title: choice.title, total: set.length, wps: num(game.wps), seconds: duration(seconds) };
    const box = h('div', { class: 'b-judgement b-quiz' });
    readerSlot.replaceChildren(box);
    let score = 0;
    const ask = n => {
      const item = set[n];
      const answers = [item.a, ...item.wrong].sort(() => Math.random() - 0.5);
      const feedback = h('p', { class: 'b-quiz-feedback', 'aria-live': 'polite' });
      const next = button(n + 1 < set.length ? q.next : q.finish, () => (n + 1 < set.length ? ask(n + 1) : result()), true);
      next.hidden = true;
      const options = answers.map(text => h('button', { class: 'b-quiz-option', type: 'button', text, onclick: e => {
        for (const o of options) {
          o.disabled = true;
          if (o.textContent === item.a) o.classList.add('is-right');
        }
        const right = text === item.a;
        if (right) score += 1;
        else e.currentTarget.classList.add('is-wrong');
        feedback.textContent = right ? q.right : fill(q.wrong, { answer: item.a });
        next.hidden = false;
        next.focus();
      } }));
      box.replaceChildren(
        h('h2', { text: fill(q.heading, { title: choice.title[0].toUpperCase() + choice.title.slice(1) }) }),
        n === 0 ? para(fill(q.intro, vars)) : null,
        h('p', { class: 'b-quiz-count', text: fill(q.count, { n: n + 1, total: set.length }) }),
        h('p', { class: 'b-quiz-q' }, h('strong', { text: item.q })),
        h('div', { class: 'b-quiz-options' }, options),
        feedback,
        h('div', { class: 'b-buttons b-quiz-next' }, next));
      options[0].focus();
    };
    const result = () => {
      game.quiz = { title: choice.title, score, total: set.length };
      const verdict = q.verdicts.find(v => score >= v.min);
      box.replaceChildren(
        h('h2', { text: fill(q.heading, { title: choice.title[0].toUpperCase() + choice.title.slice(1) }) }),
        h('p', {}, h('strong', { text: fill(q.score, { ...vars, score }) })),
        para(fill(q.claimed, vars)),
        para(fill(verdict.text, vars)));
    };
    ask(0);
  };
  // Read another: first Shakespeare or Sherlock Holmes, then any one work (or all of them), each with its time at
  // the reading speed they claimed.
  const timeFor = words => fill(r.bookTime, { time: duration(words / game.wps) });
  const chooser = () => {
    run?.stop();
    quizBtn.hidden = true;
    readerSlot.replaceChildren(h('h2', { text: r.chooseHeading }),
      h('div', { class: 'b-books' }, LIB.authors.map(a => h('button', { class: 'b-book', type: 'button', onclick: () => works(a) },
        h('strong', { text: r.authors[a.id].label }), h('span', { text: authorNote(a) }), h('span', { class: 'b-book-time', text: timeFor(a.all.words) })))));
  };
  const works = a => {
    const list = [allChoice(a), ...a.works.map(wk => workChoice(a, wk))];
    readerSlot.replaceChildren(
      h('div', { class: 'b-books-head' }, button(r.back, chooser), h('h2', { text: r.authors[a.id].label })),
      h('div', { class: 'b-books-list' }, list.map(c => h('button', { class: 'b-book-row', type: 'button', onclick: () => read(c) },
        h('span', { class: 'b-book-name', text: c.label }), h('span', { class: 'b-book-time', text: timeFor(c.words) })))));
    readerSlot.querySelector('.b-book-row')?.focus();
  };
  signal.addEventListener('abort', () => run?.stop());
  w.foot.append(quizBtn, button(r.another, chooser), button(r.continue, () => openDotMatrix(), true), button(r.cancel, () => closeCurrent()));
  const shakespeare = LIB.authors.find(a => a.id === 'shakespeare');
  read(workChoice(shakespeare, shakespeare.works.find(wk => wk.id === 'hamlet')));
}

/** What the reading screen can play: one work from the Reader's library ... */
function workChoice(author, work) {
  return {
    id: work.id, title: work.title, label: work.title, authorId: author.id, workId: work.id,
    file: author.file, start: work.start, end: work.end, words: work.words,
    heads: work.chapters.map(c => ({ line: c.line, text: c.title, level: 1 })),
  };
}
/** ... or all of one author's works, one after another. */
function allChoice(author) {
  return {
    id: author.all.id, title: S.reading.all[author.id].sentence, label: author.all.title, authorId: author.id, workId: null,
    file: author.file, start: author.all.start, end: author.all.end, words: author.all.words,
    heads: author.works.flatMap(wk => [{ line: wk.start, text: wk.title, level: 0 }, ...wk.chapters.map(c => ({ line: c.line, text: c.title, level: 1 }))]),
  };
}
/** "38 plays, 154 sonnets and 5 longer poems." / "4 novels and 56 stories.", counted from the library. */
function authorNote(a) {
  const kind = k => a.works.filter(wk => wk.kind === k);
  const sonnets = a.works.find(wk => wk.id === 'the-sonnets');
  return fill(S.reading.authors[a.id].note, {
    plays: kind('play').length,
    sonnets: sonnets ? sonnets.chapters.length : 0,
    poems: kind('poems').length - (sonnets ? 1 : 0),
    novels: kind('novel').length,
    stories: kind('stories').reduce((n, wk) => n + wk.chapters.length, 0),
  });
}

/** The Reader app, in its own window over everything (the printer window stays open underneath). */
function openReaderWindow(authorId, workId) {
  // Inside TOMLIN OS (which says where its Reader is), the desktop opens the book in its own Reader window: this page runs
  // sandboxed there and may not frame the Reader itself.
  if (window.parent !== window && params.has('reader')) {
    window.parent.postMessage({ type: 'tomlinos-open-reader', author: authorId, work: workId ?? '' }, '*');
    return;
  }
  document.querySelector('.b-app-reader')?.remove();
  const url = new URL(READER, location.href);
  url.searchParams.set('author', authorId);
  url.searchParams.set('close', '1');
  if (workId) url.searchParams.set('work', workId);
  const close = () => document.querySelector('.b-app-reader')?.remove();
  const { el, body } = windowFrame(S.reading.readerTitle, 'b-app-reader', close);
  body.append(h('iframe', { class: 'b-reader-frame', src: url.pathname + url.search, title: S.reading.readerTitle }));
  layer.append(el);
}
window.addEventListener('message', e => {
  if (e.origin === location.origin && e.data?.type === 'reader-close') document.querySelector('.b-app-reader')?.remove();
});

function openDotMatrix() {
  const d = S.dotmatrix;
  const w = mainWindow();
  const signal = show(w.el);
  w.select('dotmatrix');
  w.setStatus('dotmatrix', d.status.printing);
  const canvas = h('canvas', { class: 'b-paper b-paper-dot', 'aria-label': 'The Dot Matrix printing' });
  w.stage.append(canvas);
  const p = printer('dotmatrix');
  const docWords = S.doc.characters * S.doc.wordsPerCharacter;
  w.right.append(h('div', { class: 'b-judgement' },
    h('h2', { text: d.heading }),
    para(fill(d.about, { printer: printerName('dotmatrix'), added: p.added, cps: d.cps })),
    para(fill(d.doc, { doc: S.doc.name, pages: S.doc.pages, chars: num(S.doc.characters) })),
    para(fill(d.eta, { cps: d.cps, eta: duration(S.doc.characters / d.cps) })),
    para(fill(d.you, { wps: num(game.wps), yours: duration(docWords / game.wps) }))));
  const next = button(d.next, () => openInkjet(), true);
  next.disabled = true;
  w.foot.append(next, button('Cancel', () => closeCurrent()));
  const keys = Object.keys(d.reasons);
  const reason = keys.includes(forcedReason) ? forcedReason : keys[Math.floor(Math.random() * keys.length)];
  const why = d.reasons[reason];
  quiet(dotMatrix(canvas, { lines: why.lines, reason, jamAfter: why.jamAfter, cps: d.cps, speed, signal }).then(() => {
    w.setStatus('dotmatrix', `${d.status.stopped}: ${why.status}`);
    w.right.append(h('p', { class: 'b-verdict' }, h('strong', { text: why.text })));
    next.disabled = false;
    next.focus();
  }));
}

/** The printers' chat: each line waits for its "... is typing" first, and lines never overlap. */
function chatPanel(right, onNew = () => {}) {
  const c = S.chat;
  const log = h('ol', { class: 'b-chat-log' });
  const typing = h('p', { class: 'b-chat-typing' });
  right.append(h('section', { class: 'b-chat', 'aria-label': c.title },
    h('header', { class: 'b-chat-head' }, h('strong', { text: `# ${c.title}` }), h('span', { text: c.hint })), log, typing));
  // The chat is one conversation: a new printer window shows everything said so far.
  const line = msg => h('li', { class: `b-chat-msg b-from-${msg.who}` },
    h('span', { class: 'b-chat-who' }, h('strong', { text: printer(msg.who).name }), h('span', { class: 'b-chat-time', text: msg.time })),
    h('span', { class: 'b-chat-text', text: msg.text }));
  log.append(...game.chat.map(line));
  requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
  let queue = Promise.resolve();
  const post = (lines, signal, vars = {}) => {
    queue = queue.then(async () => {
      for (const [who, text] of lines) {
        if (signal.aborted) return;
        const name = printer(who).name;
        typing.textContent = fill(c.typing, { name });
        await sleep(600 + text.length * 22, signal).catch(() => {});
        typing.textContent = '';
        if (signal.aborted) return;
        const msg = { who, text: fill(text, vars), time: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) };
        game.chat.push(msg);
        log.append(line(msg));
        log.scrollTop = log.scrollHeight;
        onNew();
      }
    });
    return queue;
  };
  return { post };
}

/**
 * The right side as two tabs: the printer's own status (in character), and "# printer-network", the printers' chat.
 * A message that arrives while the chat tab is not open adds to the red count on its tab (and the tab pulses), so the
 * player finds out they are being talked about without being shown. The count carries from printer to printer.
 */
function rightTabs(w, statusLabel) {
  const badge = h('span', { class: 'b-tab-badge', 'aria-label': 'unread messages' });
  const tabStatus = h('button', { class: 'b-tab', type: 'button', role: 'tab', 'aria-selected': 'true', text: statusLabel });
  const tabChat = h('button', { class: 'b-tab', type: 'button', role: 'tab', 'aria-selected': 'false' }, `# ${S.chat.title}`, badge);
  const statusPane = h('div', { class: 'b-tabpane', role: 'tabpanel' });
  const chatPane = h('div', { class: 'b-tabpane b-tabpane-chat', role: 'tabpanel', hidden: true });
  const showBadge = () => {
    badge.textContent = game.unread ? String(game.unread) : '';
    badge.hidden = !game.unread;
  };
  const select = which => {
    const chatOpen = which === 'chat';
    tabStatus.setAttribute('aria-selected', String(!chatOpen));
    tabChat.setAttribute('aria-selected', String(chatOpen));
    statusPane.hidden = chatOpen;
    chatPane.hidden = !chatOpen;
    if (chatOpen) {
      game.unread = 0;
      showBadge();
      const log = chatPane.querySelector('.b-chat-log');
      if (log) log.scrollTop = log.scrollHeight;
    }
  };
  tabStatus.addEventListener('click', () => select('status'));
  tabChat.addEventListener('click', () => select('chat'));
  w.right.append(h('div', { class: 'b-tabs', role: 'tablist' }, tabStatus, tabChat), statusPane, chatPane);
  const chat = chatPanel(chatPane, () => {
    if (!chatPane.hidden) return;
    game.unread = (game.unread || 0) + 1;
    showBadge();
    tabChat.classList.remove('is-pinged');
    void tabChat.offsetWidth;
    tabChat.classList.add('is-pinged');
  });
  showBadge();
  return { statusPane, chat, select };
}

function inkStage(w, levels, extraClass) {
  const canvas = h('canvas', { class: `b-paper ${extraClass}` });
  const line = h('p', { class: 'b-stage-line' });
  const bars = inkBars(levels);
  w.stage.append(canvas, line, bars.el);
  return { canvas, line, bars };
}

function openInkjet() {
  const k = S.inkjet;
  const p = k.panel;
  const w = mainWindow();
  const signal = show(w.el);
  w.select('inkjet');
  const vars = { pages: S.doc.pages, doc: S.doc.name };
  w.setStatus('inkjet', fill(k.status.printing, vars));
  game.ink.inkjet = randomInk();
  const levels = { ...game.ink.inkjet };
  const st = inkStage(w, levels, 'b-paper-ink');
  st.line.textContent = fill(k.lines[0], vars);
  const next = button(k.next, () => openCanon(), true);
  next.disabled = true;
  w.foot.append(next, button('Cancel', () => closeCurrent()));

  // The right side stays in character: the printer's own print-quality panel. The printers' chat is in the other tab,
  // and only its unread count gives it away.
  const tabs = rightTabs(w, S.inkjet.panel.tab);
  const chat = tabs.chat;
  chat.post(S.chat.inkjetStart, signal);
  if (game.quiz && !game.quizTold) {
    game.quizTold = true;
    chat.post(S.chat.quiz, signal, game.quiz);
  }
  const heading = h('h2', { text: p.jobHeading });
  const body = h('p', { text: fill(p.job, vars) });
  let icon0 = icon('printer', 'b-cal-icon');
  const steps = p.steps.map(t => h('li', { class: 'b-cal-step' }, h('span', { class: 'b-cal-mark', 'aria-hidden': 'true' }), h('span', { text: t })));
  const list = h('ol', { class: 'b-cal-steps', hidden: true }, steps);
  const bar = h('span', { class: 'b-cal-bar' });
  const track = h('span', { class: 'b-cal-track', hidden: true }, bar);
  const actions = h('div', { class: 'b-buttons b-cal-actions' });
  const card = h('section', { class: 'b-cal' }, h('div', { class: 'b-cal-head' }, icon0, heading), body, list, track, actions);
  tabs.statusPane.append(card);

  let start;
  const started = new Promise(resolve => { start = resolve; });
  quiet(inkjet(st.canvas, {
    cyan: levels.c,
    speed,
    signal,
    printer: printerName('inkjet'),
    startCalibration: () => started,
    onPhase(phase) {
      if (phase === 'problem') {
        w.setStatus('inkjet', k.status.problem);
        st.line.textContent = k.lines[1];
        card.classList.add('is-warning');
        const warn = icon('alert', 'b-cal-icon');
        icon0.replaceWith(warn);
        icon0 = warn;
        heading.textContent = p.calHeading;
        body.textContent = p.calText;
        const go = button(p.start, () => { actions.replaceChildren(); start(); }, true);
        actions.replaceChildren(go, button(p.cancel, () => closeCurrent()));
        go.focus();
      } else if (phase === 'calibrating') {
        w.setStatus('inkjet', k.status.calibrating);
        st.line.textContent = k.lines[2];
        card.classList.remove('is-warning');
        heading.textContent = p.calibratingHeading;
        body.textContent = p.calibratingText;
        list.hidden = false;
        track.hidden = false;
        chat.post(S.chat.calibrate, signal);
      } else if (phase === 'empty') {
        w.setStatus('inkjet', k.status.empty);
        st.line.textContent = k.lines[3];
        card.classList.add('is-error');
        heading.textContent = p.emptyHeading;
        body.textContent = fill(p.emptyText, { used: game.ink.inkjet.c - levels.c });
        steps.find(s => s.classList.contains('is-current'))?.classList.replace('is-current', 'is-failed');
        chat.post(S.chat.cyanEmpty, signal);
        next.disabled = false;
        next.focus();
      }
    },
    onStep(i) {
      steps.forEach((s, j) => {
        s.classList.toggle('is-done', j < i);
        s.classList.toggle('is-current', j === i);
      });
      bar.style.width = `${(100 * i) / steps.length}%`;
    },
    onCyan(level) {
      levels.c = level;
      st.bars.set(levels);
    },
  }));
}

function openCanon() {
  const c = S.canon;
  const w = mainWindow();
  const signal = show(w.el);
  w.select('canon');
  w.setStatus('canon', 'Printing');
  const tabs = rightTabs(w, c.tab);
  const chat = tabs.chat;
  const jobStatus = h('dd', { text: 'Printing' });
  const jobTries = h('dd', { text: '0' });
  tabs.statusPane.append(h('section', { class: 'b-cal b-job' },
    h('div', { class: 'b-cal-head' }, icon('printer', 'b-cal-icon'), h('h2', { text: c.title })),
    h('dl', { class: 'b-job-rows' },
      h('dt', { text: c.jobDoc }), h('dd', { text: S.doc.name }),
      h('dt', { text: c.jobStatus }), jobStatus,
      h('dt', { text: c.jobTries }), jobTries)));
  const attempt = h('p', { class: 'b-canon-attempt' });
  const ok = button(c.ok, null, true);
  const cancel = button(c.cancel, () => finish());
  const art1 = h('span', { class: 'b-canon-art' });
  art1.append(drawing('<svg viewBox="0 0 90 60" aria-hidden="true"><rect x="10" y="26" width="70" height="26" rx="3" fill="#e5e7eb" stroke="#6b7280"/><rect x="22" y="10" width="46" height="22" fill="#fff" stroke="#9ca3af"/><path d="M45 4v14m-6-6 6 6 6-6" stroke="#2563eb" stroke-width="3" fill="none"/></svg>'));
  const art2 = h('span', { class: 'b-canon-art' });
  art2.append(drawing('<svg viewBox="0 0 90 60" aria-hidden="true"><rect x="8" y="12" width="74" height="40" rx="4" fill="#e5e7eb" stroke="#6b7280"/><rect x="16" y="20" width="30" height="16" fill="#1f2937"/><circle cx="64" cy="30" r="8" fill="#fff" stroke="#374151"/><text x="64" y="33" font-size="8" text-anchor="middle" fill="#111">OK</text><path d="M72 48l-6-10" stroke="#2563eb" stroke-width="3"/></svg>'));
  const dialog = h('div', { class: 'b-canon' },
    h('p', { class: 'b-canon-head' }, icon('alert', 'b-alert-icon'), h('strong', { text: c.headline })),
    h('p', { class: 'b-canon-small', text: c.media }), h('p', { class: 'b-canon-small', text: c.size }),
    h('div', { class: 'b-canon-steps' },
      h('div', { class: 'b-canon-step' }, h('span', { class: 'b-canon-n', text: '1' }), art1, h('p', { text: c.step1 })),
      h('div', { class: 'b-canon-step' }, h('span', { class: 'b-canon-n', text: '2' }), art2, h('p', { text: c.step2 }))),
    attempt,
    h('div', { class: 'b-buttons' }, ok, cancel));
  // The out-of-paper box and its buttons are what the player acts on: they go on the right, in Print status, under the
  // document being printed. The left keeps the printer itself, its little screen blinking NO PAPER over an empty tray.
  tabs.statusPane.append(dialog);
  const machine = h('div', { class: 'b-canon-machine', role: 'img', 'aria-label': 'The Canon: its screen says NO PAPER and the tray is empty' });
  machine.append(drawing('<svg viewBox="0 0 320 190" aria-hidden="true"><rect x="0" y="0" width="320" height="190" fill="#d9d9d9"/><rect x="50" y="30" width="220" height="30" rx="4" fill="#bfc3c8"/><rect x="40" y="56" width="240" height="84" rx="10" fill="#2f3237"/><rect x="58" y="72" width="104" height="36" rx="3" fill="#9fb8a0"/><text x="110" y="95" font-family="Courier New, monospace" font-size="15" font-weight="700" text-anchor="middle" fill="#1d2b1d" class="b-canon-lcd">NO PAPER</text><circle class="b-canon-led" cx="200" cy="90" r="7" fill="#ff8a00"/><circle cx="232" cy="90" r="9" fill="#50545a" stroke="#6b7078"/><text x="232" y="94" font-family="Segoe UI, sans-serif" font-size="8" text-anchor="middle" fill="#e5e5e5">OK</text><rect x="70" y="140" width="180" height="10" rx="2" fill="#44484e"/><rect x="80" y="150" width="160" height="22" rx="3" fill="#e9eaec" stroke="#b5b8bd"/><text x="160" y="165" font-family="Segoe UI, sans-serif" font-size="9" text-anchor="middle" fill="#8a8d92">front tray: empty</text></svg>'));
  w.stage.append(machine);
  let tries = 0;
  quiet(sleep(1200, signal).then(() => {
    w.setStatus('canon', c.headline.replace(/\.$/, ''));
    jobStatus.textContent = c.headline.replace(/\.$/, '');
    chat.post(S.chat.canonStart, signal);
  }));
  ok.addEventListener('click', async () => {
    tries += 1;
    ok.disabled = true;
    cancel.disabled = true;
    attempt.textContent = c.checking;
    jobTries.textContent = String(tries);
    jobStatus.textContent = c.checking.replace(/\.+$/, '');
    w.setStatus('canon', c.checking.replace(/\.+$/, ''));
    try {
      await sleep(1500, signal);
    } catch {
      return;
    }
    w.setStatus('canon', c.headline.replace(/\.$/, ''));
    jobStatus.textContent = c.headline.replace(/\.$/, '');
    attempt.textContent = fill(c.attempt, { n: tries + 1 });
    await chat.post(S.chat[`ok${tries}`] ?? [], signal, { seconds: duration(game.tosSeconds) });
    if (signal.aborted) return;
    if (tries >= c.rounds) return finish();
    ok.disabled = false;
    cancel.disabled = false;
    ok.focus();
  });

  // The Canon gives up (or you do): now the next printer, and the ones after it get stranger.
  const next = button(c.next, () => more.first(), true);
  next.disabled = true;
  w.foot.append(next, button('Cancel', () => closeCurrent()));
  function finish() {
    ok.disabled = true;
    cancel.disabled = true;
    w.setStatus('canon', 'Error: Paper has run out');
    next.disabled = false;
    next.focus();
  }
}

// Everything the printers after the Canon need from here. S and game are replaced as the game runs, so they are getters.
const more = morePrinters({
  get S() { return S; },
  get game() { return game; },
  h, fill, num, duration, sleep, button, para, icon, quiet, speed,
  mainWindow, show, rightTabs, closeCurrent, printer, printerName, openStatus, toast,
});

// ---------- Start ----------

async function start() {
  const res = await fetch('script.json');
  if (!res.ok) throw new Error(`script.json: ${res.status}`);
  S = await res.json();
  // The Reader's library: which works there are, where each starts in its text file, and its chapters.
  const lib = await fetch(new URL(`${READER}library.json`, location.href));
  if (!lib.ok) throw new Error(`the Reader's library.json: ${lib.status}`);
  LIB = await lib.json();
  game = newGame();
  desk.append(layer, taskbar());
  // ?at=photo (or receipt, fax, threed, fridge, strike, cloud) starts at that printer, for checking one screen.
  const at = params.get('at');
  if (S.after.includes(at)) {
    Object.assign(game, { startedAt: Date.now(), tosSeconds: 4, tosWords: 20381, wps: 20381 / 4, wordsRead: 20381 });
    for (const id of ['dotmatrix', 'inkjet', 'canon']) { game.found.add(id); game.tried.add(id); }
    Object.assign(game.statuses, { dotmatrix: 'Error: Paper jam (tractor feed)', inkjet: 'Cyan cartridge empty', canon: 'Error: Paper has run out' });
    more.open(at);
    return;
  }
  setTimeout(toast, 1200 / speed);
}

start().catch(error => {
  desk.textContent = `Office Printer could not start (${error.message}). Reload the page to try again.`;
});
