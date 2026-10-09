// Reader: one book at a time, a page at a time. The left column says what you are reading and who wrote it, and
// lists its chapters to jump to; the right is the page, with Previous and Next page (or the arrow keys).
//   index.html?author=shakespeare&work=hamlet&chapter=3
// Opened inside another page (Office Printer B opens it in a window) its close button asks that page to close it.
// The library (library.json) is built from the text files by tools/build-library.mjs. The Gutenberg library and My
// books are in library.js.
import { library, libraryOpen, parseGutenberg, shelf } from './library.js';

const params = new URLSearchParams(location.search);
// Opened inside another page that asked for a close button (?close=1, as Office Printer B does). The front page and
// the lock screen do not ask: there the page around it has its own way out (Log in for more).
const embedded = window.parent !== window && params.has('close');
const root = document.getElementById('reader');

/**
 * A book's place (chapter and how far through it). A Gutenberg book read inside TOMLIN OS keeps it in the person's own
 * files, through the Reader app, so what someone reads never stays in this browser; everything else stays here.
 */
const places = {
  async get(id) { return id.startsWith('pg-') && shelf.keepsPlaces() ? shelf.getPlace(id) : store.get(`reader:${id}`); },
  set(id, value) {
    if (id.startsWith('pg-') && shelf.keepsPlaces()) void shelf.setPlace(id, value);
    else store.set(`reader:${id}`, value);
  },
};

const store = {
  get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private window: no memory */ } },
};

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

const texts = new Map();
async function linesOf(file) {
  if (!texts.has(file)) {
    texts.set(file, fetch(file).then(r => {
      if (!r.ok) throw new Error(`${file} is not installed (${r.status})`);
      return r.text();
    }).then(t => t.replace(/\r\n/g, '\n').split('\n')));
  }
  return texts.get(file);
}

let lib;
let author;
let work;
let lines;
let chapter = 0;
let page = 0;
let pages = 1;
let step = 1;
const ui = {};

// ---------- The chapter's text as paragraphs ----------

const SPEAKER = /^[A-Z][A-Z’' .,&-]{1,38}\.$/;

/** "_words_" in the text are italics (stage directions); everything else is plain text. */
function inline(text) {
  return text.split(/(_[^_]+_)/).filter(Boolean).map(part => (/^_[^_]+_$/.test(part) ? h('em', { text: part.slice(1, -1) }) : part));
}

function paragraphs(from, to, prose) {
  const out = [];
  let block = [];
  const flush = () => {
    if (!block.length) return;
    if (prose) out.push(h('p', {}, inline(block.map(l => l.trim()).join(' '))));
    else {
      const [first, ...rest] = block;
      if (SPEAKER.test(first.trim()) && rest.length) out.push(h('p', {}, h('span', { class: 'r-speaker', text: first.trim().replace(/\.$/, '') }), inline(rest.map(l => l.trim()).join('\n'))));
      else out.push(h('p', {}, inline(block.map(l => l.trim()).join('\n'))));
    }
    block = [];
  };
  for (let i = from; i < to; i++) {
    const l = lines[i];
    if (/^## /.test(l.trim())) continue;
    if (!l.trim()) flush();
    else block.push(l);
  }
  flush();
  return out;
}

// ---------- Pages ----------

/** Lays the chapter out in page-wide columns; one column is one page. */
function paginate(keepRatio) {
  const ratio = pages > 1 ? page / (pages - 1) : 0;
  const vw = ui.viewport.clientWidth;
  const margin = vw < 520 ? 20 : 40;
  const width = Math.max(200, vw - 2 * margin);
  Object.assign(ui.flow.style, { left: `${margin}px`, width: `${width}px`, columnWidth: `${width}px`, columnGap: `${2 * margin}px`, columnFill: 'auto' });
  step = vw;
  pages = Math.max(1, Math.round((ui.flow.scrollWidth + 2 * margin) / vw));
  go(keepRatio ? Math.round(ratio * (pages - 1)) : Math.min(page, pages - 1), false);
}

function go(p, animate = true) {
  page = Math.max(0, Math.min(pages - 1, p));
  ui.flow.style.transition = animate ? '' : 'none';
  ui.flow.style.transform = `translateX(${-page * step}px)`;
  const n = work.chapters.length;
  ui.count.textContent = `Page ${page + 1} of ${pages}`;
  ui.prev.disabled = page === 0 && chapter === 0;
  ui.next.disabled = page === pages - 1 && chapter === n - 1;
  ui.next.textContent = page === pages - 1 && chapter < n - 1 ? 'Next chapter ›' : 'Next page ›';
  ui.prev.textContent = page === 0 && chapter > 0 ? '‹ Previous chapter' : '‹ Previous page';
  ui.bar.style.width = `${(100 * (chapter + (pages > 1 ? page / (pages - 1) : 1))) / n}%`;
  places.set(work.id, { chapter, ratio: pages > 1 ? page / (pages - 1) : 0 });
}

function showChapter(i, at = 'start') {
  chapter = Math.max(0, Math.min(work.chapters.length - 1, i));
  const ch = work.chapters[chapter];
  const to = chapter + 1 < work.chapters.length ? work.chapters[chapter + 1].line : work.end;
  const prose = work.prose ?? author.id === 'doyle';
  ui.flow.className = `r-flow${prose ? ' is-prose' : ''}`;
  ui.flow.replaceChildren(...paragraphs(ch.line, to, prose));
  ui.title.textContent = ch.title;
  ui.where.textContent = `${work.title} · ${author.name} · ${chapter + 1} of ${work.chapters.length}`;
  for (const [k, b] of ui.chapterButtons.entries()) {
    if (k === chapter) {
      b.setAttribute('aria-current', 'true');
      b.scrollIntoView({ block: 'nearest' });
    } else b.removeAttribute('aria-current');
  }
  page = 0;
  pages = 1;
  paginate(false);
  go(at === 'end' ? pages - 1 : typeof at === 'number' ? Math.round(at * (pages - 1)) : 0, false);
  const url = new URL(location.href);
  url.searchParams.set('author', author.id);
  url.searchParams.set('work', work.id);
  url.searchParams.set('chapter', String(chapter));
  history.replaceState(null, '', url);
}

const next = () => (page < pages - 1 ? go(page + 1) : chapter < work.chapters.length - 1 && showChapter(chapter + 1, 'start'));
const prev = () => (page > 0 ? go(page - 1) : chapter > 0 && showChapter(chapter - 1, 'end'));

// ---------- The column ----------

/** A Gutenberg book (a row of the library, or a saved book) and its text, opened like any other work. */
function openBook(meta, text) {
  const { lines: bookLines, chapters } = parseGutenberg(text);
  const genres = meta.genres ?? [];
  const a = { id: 'gutenberg', name: meta.author, years: meta.years ? `(${meta.years})` : '', about: `Project Gutenberg eBook #${meta.id}.${genres.length ? ` ${genres.slice(0, 3).join(', ')}.` : ''}` };
  // Poems and plays keep their lines; everything else is prose, reflowed into paragraphs.
  const prose = !genres.some(g => g === 'Poetry' || g.startsWith('Plays'));
  const w = { id: `pg-${meta.id}`, title: meta.title, chapters, end: bookLines.length, prose };
  return openWork(a, w, undefined, bookLines);
}

async function openWork(a, w, startChapter, bookLines) {
  author = a;
  work = w;
  document.title = `${work.title} - Reader`;
  ui.bookTitle.textContent = work.title;
  ui.author.replaceChildren(author.name, ' ', h('span', { class: 'r-years', text: author.years }));
  ui.about.textContent = work.year ? `First published ${work.year}. ${author.about}` : author.about;
  ui.chaptersCount.textContent = `${work.chapters.length}`;
  ui.chapterButtons = work.chapters.map((c, i) => h('button', { class: 'r-chapter', type: 'button', text: c.title, onclick: () => { showChapter(i); ui.flow.focus?.(); } }));
  ui.chapters.replaceChildren(...ui.chapterButtons.map(b => h('li', {}, b)));
  root.dataset.view = 'book';
  ui.flow.replaceChildren(h('p', { text: 'Opening...' }));
  lines = bookLines ?? await linesOf(author.file);
  const saved = await places.get(work.id);
  if (Number.isInteger(startChapter)) showChapter(startChapter, 'start');
  else if (saved) showChapter(saved.chapter, saved.ratio);
  else showChapter(0, 'start');
}

function build() {
  ui.bookTitle = h('h1', { class: 'r-book-title' });
  ui.author = h('p', { class: 'r-author' });
  ui.about = h('p', { class: 'r-about' });
  ui.chaptersCount = h('span');
  ui.chapters = h('ol', { class: 'r-chapters', 'aria-label': 'Chapters' });
  ui.collections = h('ul', { class: 'r-nav', 'aria-label': 'Collections' });
  const fold = h('button', { class: 'r-fold', type: 'button', text: 'Show', onclick: () => {
    root.classList.toggle('is-folded');
    fold.textContent = root.classList.contains('is-folded') ? 'Show' : 'Hide';
  } });
  const ribbon = h('span', { class: 'r-ribbon' });
  // Built as elements, not as HTML text: the page's policy (Trusted Types) refuses HTML from strings.
  const NS = 'http://www.w3.org/2000/svg';
  const ribbonSvg = document.createElementNS(NS, 'svg');
  ribbonSvg.setAttribute('viewBox', '0 0 22 34');
  ribbonSvg.setAttribute('aria-hidden', 'true');
  const ribbonPath = document.createElementNS(NS, 'path');
  ribbonPath.setAttribute('d', 'M0 0H22V34L11 26L0 34Z');
  ribbonPath.setAttribute('fill', '#8fd1bb');
  ribbonSvg.append(ribbonPath);
  ribbon.append(ribbonSvg);
  const column = h('aside', { class: 'r-column' },
    ribbon,
    // Home: what this is, and the collections.
    h('div', { class: 'r-side r-side-lib' },
      h('div', { class: 'r-book' }, h('h1', { class: 'r-book-title', text: 'Immersive Reader' }), h('p', { class: 'r-about', text: 'Find and read great works.' })),
      h('p', { class: 'r-chapters-head' }, h('span', {}, 'Collections')),
      ui.collections),
    // A book: Change book first, then what it is, who wrote it, and its chapters.
    h('div', { class: 'r-side r-side-book' },
      h('button', { class: 'r-change', type: 'button', text: '‹ Change book', onclick: () => showHome(author?.id === 'gutenberg' ? 'gutenberg' : undefined) }),
      h('div', { class: 'r-book' }, ui.bookTitle, ui.author, ui.about),
      h('p', { class: 'r-chapters-head' }, h('span', { class: 'r-chapters-label' }, 'Chapters ', ui.chaptersCount), fold),
      ui.chapters));

  ui.title = h('h2', { class: 'r-chapter-title' });
  ui.where = h('p', { class: 'r-where' });
  const size = d => {
    const now = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--size')) || 19;
    const next = Math.max(15, Math.min(27, now + d));
    document.documentElement.style.setProperty('--size', `${next}px`);
    store.set('reader:size', next);
    paginate(true);
  };
  const tools = h('div', { class: 'r-tools' },
    h('button', { class: 'r-round', type: 'button', 'aria-label': 'Smaller text', title: 'Smaller text', text: 'A−', onclick: () => size(-2) }),
    h('button', { class: 'r-round', type: 'button', 'aria-label': 'Larger text', title: 'Larger text', text: 'A+', onclick: () => size(2) }),
    embedded ? h('button', { class: 'r-round', type: 'button', 'aria-label': 'Close the reader', title: 'Close', text: '✕', onclick: close }) : null);
  ui.back = h('button', { class: 'r-back', type: 'button', text: '‹ All collections', onclick: () => showHome() });
  ui.home = h('div', { class: 'r-home' });
  ui.flow = h('div', { class: 'r-flow', tabindex: '-1' });
  ui.viewport = h('div', { class: 'r-viewport' }, ui.flow);
  ui.bar = h('span');
  ui.prev = h('button', { class: 'r-page-btn', type: 'button', onclick: prev });
  ui.next = h('button', { class: 'r-page-btn is-next', type: 'button', onclick: next });
  ui.count = h('span', { class: 'r-count', 'aria-live': 'polite' });
  const paper = h('main', { class: 'r-paper' },
    h('header', { class: 'r-top' }, h('div', { class: 'r-top-text' }, ui.back, ui.title, ui.where), tools),
    h('div', { class: 'r-progress', 'aria-hidden': 'true' }, ui.bar),
    ui.home,
    ui.viewport,
    h('footer', { class: 'r-bottom' }, ui.prev, ui.count, ui.next));
  root.replaceChildren(column, paper);
  root.classList.add('is-folded');

  const savedSize = store.get('reader:size');
  if (savedSize) document.documentElement.style.setProperty('--size', `${savedSize}px`);
  new ResizeObserver(() => { if (root.dataset.view === 'book' && work && lines) paginate(true); }).observe(ui.viewport);
  document.addEventListener('keydown', e => {
    if (root.dataset.view !== 'book') {
      if (e.key === 'Escape' && embedded) close();
      return;
    }
    if (['ArrowRight', 'PageDown'].includes(e.key) || (e.key === ' ' && !(e.target instanceof HTMLButtonElement))) { e.preventDefault(); next(); }
    else if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); prev(); }
    else if (e.key === 'Escape' && embedded) close();
  });
}

// ---------- Home: the collections, then the books in one ----------

const KIND = { play: 'Play', poems: 'Poems', novel: 'Novel', stories: 'Stories' };

/** "38 plays, 154 sonnets and 5 longer poems." / "4 novels and 56 stories.", counted from the library. */
function collectionNote(a) {
  const kind = k => a.works.filter(w => w.kind === k);
  const sonnets = a.works.find(w => w.id === 'the-sonnets');
  if (a.id === 'doyle') return `${kind('novel').length} novels and ${kind('stories').reduce((n, w) => n + w.chapters.length, 0)} stories.`;
  return `${kind('play').length} plays, ${sonnets ? sonnets.chapters.length : 0} sonnets and ${kind('poems').length - (sonnets ? 1 : 0)} longer poems.`;
}

/** How many parts a book has, in its own words: scenes, sonnets, chapters, stories. */
function partsOf(w) {
  const n = w.chapters.length;
  if (w.kind === 'play') return `${n - 1} scenes`;
  if (w.id === 'the-sonnets') return `${n} sonnets`;
  if (w.kind === 'poems') return n === 1 ? 'One poem' : `${n} poems`;
  if (w.kind === 'novel') return `${n - 1} chapters`;
  return `${n} stories`;
}

/**
 * What this Reader may show besides its own books: the Gutenberg library (only for a signed-in person on TOMLIN OS) and
 * My books (only where there is somewhere to keep them). Decided once, when it starts.
 */
const extras = { gutenberg: false, shelf: false };

/** The left column's collections: the ones built in, then the Gutenberg library and My books when allowed here. */
function setCollections(active) {
  const item = (id, label, go) => h('li', {}, h('button', { class: 'r-chapter', type: 'button', text: label, 'aria-current': id === active ? 'true' : null, onclick: go }));
  ui.collections.replaceChildren(...[
    ...lib.authors.map(x => item(x.id, x.short, () => showHome(x.id))),
    extras.gutenberg ? item('gutenberg', 'Gutenberg library', () => showHome('gutenberg')) : null,
    extras.shelf ? item('shelf', 'My books', () => showHome('shelf')) : null,
  ].filter(Boolean));
}

function setAddress({ author: id } = {}) {
  const url = new URL(location.href);
  for (const k of ['work', 'chapter', 'author']) url.searchParams.delete(k);
  if (id) url.searchParams.set('author', id);
  history.replaceState(null, '', url);
}

let books;

function showHome(authorId) {
  if (authorId === 'gutenberg' && extras.gutenberg) return books.show();
  if (authorId === 'shelf' && extras.shelf) return books.showShelf();
  const a = lib.authors.find(x => x.id === authorId);
  root.dataset.view = 'home';
  root.classList.remove('is-folded');
  document.title = a ? `${a.short} - Reader` : 'Reader';
  ui.back.hidden = !a;
  ui.title.textContent = a ? a.short : 'Library';
  ui.where.textContent = a
    ? `${a.name} · ${a.works.length} works`
    : [`${lib.authors.length} ${lib.authors.length === 1 ? 'collection' : 'collections'}`, `${lib.authors.reduce((n, x) => n + x.works.length, 0)} works`, extras.gutenberg ? 'the Gutenberg library' : '', extras.shelf ? 'My books' : ''].filter(Boolean).join(' · ');
  setCollections(a?.id ?? null);
  if (!a) {
    const tile = (id, title, sub, meta, note, go) => h('button', { class: `r-tile r-tile-collection r-shelf-${id}`, type: 'button', onclick: () => showHome(id) },
      h('span', { class: 'r-cover' }, h('span', { class: 'r-cover-title', text: title }), h('span', { class: 'r-cover-sub', text: sub })),
      h('span', { class: 'r-tile-body' }, h('span', { class: 'r-tile-meta', text: meta }), h('span', { class: 'r-tile-note', text: note }), h('span', { class: 'r-tile-go', text: go })));
    ui.home.replaceChildren(h('div', { class: 'r-tiles' },
      lib.authors.map(x => tile(x.id, x.short, x.name, `${x.name}, ${x.years}`, collectionNote(x), `${x.works.length} works ›`)),
      extras.gutenberg ? tile('gutenberg', 'Gutenberg library', 'Project Gutenberg', 'Over 60,000 free books in English', 'Search by title, author or topic; pick a genre; save any book to read later.', 'Browse ›') : null,
      extras.shelf ? tile('shelf', 'My books', 'Saved to read later', 'The books you save', 'Readable any time, with no connection.', 'Open ›') : null));
  } else {
    ui.home.replaceChildren(h('div', { class: 'r-tiles r-tiles-books' }, a.works.map(w => {
      const saved = store.get(`reader:${w.id}`);
      return h('button', { class: `r-tile r-tile-book r-shelf-${a.id}`, type: 'button', onclick: () => openWork(a, w) },
        h('span', { class: 'r-tile-title', text: w.title }),
        h('span', { class: 'r-tile-meta', text: [KIND[w.kind], w.year, partsOf(w)].filter(Boolean).join(' · ') }),
        h('span', { class: saved ? 'r-tile-go is-started' : 'r-tile-go', text: saved ? `Continue: ${saved.chapter + 1} of ${w.chapters.length}` : 'Start reading ›' }));
    })));
  }
  ui.home.scrollTop = 0;
  const url = new URL(location.href);
  for (const k of ['work', 'chapter']) url.searchParams.delete(k);
  if (a) url.searchParams.set('author', a.id);
  else url.searchParams.delete('author');
  history.replaceState(null, '', url);
  ui.home.querySelector('.r-tile')?.focus();
}

function close() {
  window.parent.postMessage({ type: 'reader-close' }, location.origin);
}

async function start() {
  const res = await fetch('library.json');
  if (!res.ok) throw new Error(`library.json: ${res.status}`);
  lib = await res.json();
  build();
  books = library({ h, ui, root, store, openBook, setCollections, setAddress });
  [extras.gutenberg, extras.shelf] = await Promise.all([libraryOpen(), shelf.available()]);
  // A Gutenberg book, the library or My books: ?author=gutenberg&work=pg-1342, ?author=gutenberg, ?author=shelf.
  const pg = /^pg-(\d+)$/.exec(params.get('work') ?? '');
  if (params.get('author') === 'gutenberg' && pg && extras.gutenberg) {
    root.dataset.view = 'home';
    ui.home.replaceChildren(h('p', { class: 'r-note', text: 'Opening the book...' }));
    await books.openById(Number(pg[1]));
    return;
  }
  if ((params.get('author') === 'gutenberg' && extras.gutenberg) || (params.get('author') === 'shelf' && extras.shelf)) {
    showHome(params.get('author'));
    return;
  }
  const a = lib.authors.find(x => x.id === params.get('author'));
  const w = a?.works.find(x => x.id === params.get('work'));
  if (!w) {
    showHome(a?.id);
    return;
  }
  const c = params.has('chapter') ? Number(params.get('chapter')) : undefined;
  await openWork(a, w, Number.isInteger(c) ? c : undefined);
}

start().catch(error => {
  root.replaceChildren(h('p', { class: 'r-loading', text: `The Reader could not open (${error.message}). Reload the page to try again.` }));
});
