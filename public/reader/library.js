// The Gutenberg library and My books, for the Reader.
//   Library: 61,000-odd free books from Project Gutenberg. Search (title, author, genre, topic), a genre, a topic, an
//   order; each book can be read now or saved. The list comes from gutenberg.json (tools/build-gutenberg.mjs); a book's
//   text comes from gutenberg/book/<id> (gutenberg.php), which fetches it from Project Gutenberg the first time.
//   My books: the saved ones, readable with no connection.
//
// Where a saved book goes:
//   Inside TOMLIN OS the desktop hosts the Reader and answers {type: 'reader-hello'} with {type: 'reader-host', name}.
//   Then every shelf call is a message to it, each with a request id (rid), answered with the same rid:
//     {type: 'reader-save', book}   -> {ok, error?}       book = {id, title, author, years, genres, text, saved}
//     {type: 'reader-shelf'}        -> {books: [...]}     the same, without text
//     {type: 'reader-load', id}     -> {text}
//     {type: 'reader-remove', id}   -> {ok}
//   On its own (or inside Office Printer), the Reader keeps saved books in this browser (IndexedDB).

// Where the library lives (index.html says): TOMLIN OS's books API, which answers signed-in people only, or the labs
// server's gutenberg/ folder. {path} is ping, index or book/<id>.
const API = document.querySelector('meta[name="books-api"]')?.getAttribute('content') || 'gutenberg/{path}';
const api = path => API.replace('{path}', path);
const HEADERS = { 'X-Desktop-Store': '1' };
// Inside TOMLIN OS a saved book goes only to TOMLIN OS (the Reader app answers the handshake). The same Reader on the front
// page or the lock screen has no host, and then has no My books at all: it never keeps books in the browser there.
const HOST_ONLY = document.querySelector('meta[name="reader-shelf"]')?.getAttribute('content') === 'host-only';

/** Whether the Gutenberg library may be shown here: TOMLIN OS says yes only to a signed-in, unlocked person. */
let open = null;
export function libraryOpen() {
  open ??= fetch(api('ping'), { headers: HEADERS, credentials: 'same-origin' }).then(r => r.ok).catch(() => false);
  return open;
}
const PAGE = 40;

/** ctx: { h, ui, root, store, openBook(meta, text), setCollections(active) } from reader.js. */
export function library(ctx) {
  const { h, ui, root, store } = ctx;
  let index = null;
  let loading = null;
  const state = { q: '', genre: '', topic: '', sort: 'popular', shown: PAGE };
  let showing = 0;

  // ---------- The book list ----------

  async function loadIndex() {
    loading ??= fetch(api('index'), { headers: HEADERS, credentials: 'same-origin' }).then(r => {
      if (!r.ok) throw new Error(`the book list did not load (${r.status})`);
      return r.json();
    }).then(data => {
      // One search string a book: title, author, and its genre and topic names.
      data.rows = data.books.map(([id, title, author, years, g, t, rank]) => ({
        id, title, author, years, rank,
        genres: g.map(i => data.genres[i]),
        topics: t.map(i => data.topics[i]),
        find: `${title} ${author} ${g.map(i => data.genres[i]).join(' ')} ${t.map(i => data.topics[i]).join(' ')}`.toLowerCase(),
        sortTitle: title.replace(/^[^\p{L}\p{N}]+/u, '').replace(/^(the|a|an)\s+/i, '').toLowerCase(),
        sortAuthor: (author.split(' ').pop() ?? '').toLowerCase(),
      }));
      data.byId = new Map(data.rows.map(r => [r.id, r]));
      data.genreCount = new Map();
      for (const r of data.rows) for (const g of r.genres) data.genreCount.set(g, (data.genreCount.get(g) ?? 0) + 1);
      index = data;
      return data;
    });
    return loading;
  }

  function matches() {
    const words = state.q.toLowerCase().split(/\s+/).filter(Boolean);
    const rows = index.rows.filter(r => (!state.genre || r.genres.includes(state.genre)) && (!state.topic || r.topics.includes(state.topic)) && words.every(w => r.find.includes(w)));
    const by = {
      // The 100 most downloaded this month first, then the oldest on Gutenberg (the early numbers are the classics).
      popular: (a, b) => (a.rank || 1e9) - (b.rank || 1e9) || a.id - b.id,
      title: (a, b) => a.sortTitle.localeCompare(b.sortTitle),
      author: (a, b) => a.sortAuthor.localeCompare(b.sortAuthor) || a.sortTitle.localeCompare(b.sortTitle),
      newest: (a, b) => b.id - a.id,
    }[state.sort];
    return rows.sort(by);
  }

  // ---------- Screens ----------

  function frame(title, where) {
    root.dataset.view = 'home';
    root.classList.remove('is-folded');
    ui.back.hidden = false;
    ui.title.textContent = title;
    ui.where.textContent = where;
    document.title = `${title} - Reader`;
  }

  async function show() {
    frame('Gutenberg library', 'Free books from Project Gutenberg');
    ctx.setCollections('gutenberg');
    ctx.setAddress({ author: 'gutenberg' });
    ui.home.replaceChildren(h('p', { class: 'r-note', text: 'Opening the library...' }));
    const mine = ++showing;
    // Anything opened meanwhile (a book, My books) wins: this screen stops drawing.
    const stale = () => mine !== showing || root.dataset.view !== 'home';
    try {
      await loadIndex();
      if (stale()) return;
    } catch (e) {
      ui.home.replaceChildren(h('p', { class: 'r-note', text: `The library could not open: ${e.message}. Check the connection, then try again.` }),
        h('button', { class: 'r-pill', type: 'button', text: 'Try again', onclick: () => { loading = null; show(); } }));
      return;
    }
    ui.where.textContent = `${index.rows.length.toLocaleString('en-GB')} free books from Project Gutenberg`;
    const search = h('input', { class: 'r-search', type: 'search', placeholder: 'Search by title, author or topic', 'aria-label': 'Search the library', value: state.q });
    const select = (label, key, options) => {
      const el = h('select', { class: 'r-select', 'aria-label': label },
        options.map(([value, text]) => h('option', { value, text, selected: state[key] === value })));
      el.addEventListener('change', () => { state[key] = el.value; state.shown = PAGE; draw(); });
      return h('label', { class: 'r-field' }, h('span', { text: label }), el);
    };
    const genres = select('Genre', 'genre', [['', 'All genres'], ...index.genres.map(g => [g, `${g} (${(index.genreCount.get(g) ?? 0).toLocaleString('en-GB')})`])]);
    const topics = select('Topic', 'topic', [['', 'All topics'], ...index.topics.map(t => [t, t])]);
    const sort = select('Order', 'sort', [['popular', 'Most read this month first'], ['title', 'Title, A to Z'], ['author', 'Author, A to Z'], ['newest', 'Newest on Gutenberg']]);
    const count = h('p', { class: 'r-count-line', 'aria-live': 'polite' });
    const list = h('ol', { class: 'r-results' });
    const more = h('button', { class: 'r-pill', type: 'button', text: `Show ${PAGE} more`, onclick: () => { state.shown += PAGE; draw(); } });
    let timer = 0;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => { state.q = search.value; state.shown = PAGE; draw(); }, 160);
    });
    const saved = new Set((await shelf.list().catch(() => [])).map(b => b.id));
    if (stale()) return;
    function draw() {
      const rows = matches();
      count.textContent = rows.length
        ? `${rows.length.toLocaleString('en-GB')} ${rows.length === 1 ? 'book' : 'books'}${rows.length > state.shown ? `, showing ${state.shown.toLocaleString('en-GB')}` : ''}`
        : 'No books match. Try fewer words, or All genres and All topics.';
      list.replaceChildren(...rows.slice(0, state.shown).map(r => bookRow(r, saved)));
      more.hidden = rows.length <= state.shown;
    }
    ui.home.replaceChildren(
      h('div', { class: 'r-filters' }, h('div', { class: 'r-search-wrap' }, search), genres, topics, sort),
      count, list, more,
      h('p', { class: 'r-note r-legal', text: 'Project Gutenberg books are free to read in the USA. Elsewhere, check your own country’s copyright rules: the author’s years are shown.' }));
    draw();
    search.focus();
  }

  function bookRow(r, saved) {
    const save = h('button', { class: 'r-pill', type: 'button' });
    const setSaved = on => {
      save.textContent = on ? 'Saved ✓' : shelf.saveLabel();
      save.disabled = on;
    };
    setSaved(saved.has(r.id));
    save.addEventListener('click', async () => {
      save.disabled = true;
      save.textContent = 'Saving...';
      try {
        await saveBook(r);
        saved.add(r.id);
        setSaved(true);
      } catch (e) {
        save.disabled = false;
        save.textContent = shelf.saveLabel();
        say(save, `Not saved: ${e.message}`);
      }
    });
    const tags = [...r.genres.slice(0, 2), ...r.topics.slice(0, 2)];
    return h('li', { class: 'r-result' },
      h('div', { class: 'r-result-text' },
        h('span', { class: 'r-result-title', text: r.title }),
        h('span', { class: 'r-result-author' }, r.author, r.years ? h('span', { class: 'r-result-years', text: ` (${r.years})` }) : null),
        tags.length ? h('span', { class: 'r-tags' }, tags.map(t => h('span', { class: 'r-tag', text: t }))) : null),
      h('div', { class: 'r-result-actions' },
        r.rank ? h('span', { class: 'r-rank', text: `#${r.rank} this month` }) : null,
        h('button', { class: 'r-pill is-primary', type: 'button', text: 'Read', onclick: e => read(r, e.currentTarget) }),
        save));
  }

  /** A short message under a button, gone after a while. */
  function say(near, text) {
    const note = h('p', { class: 'r-inline-note', role: 'status', text });
    near.closest('li, .r-tile, div')?.append(note);
    setTimeout(() => note.remove(), 8000);
  }

  async function fetchText(id) {
    const res = await fetch(api(`book/${id}`), { headers: HEADERS, credentials: 'same-origin' });
    if (!res.ok) {
      // TOMLIN OS answers with {error: words}; the labs server with plain words.
      const body = await res.text();
      let words = body;
      try { words = JSON.parse(body).error ?? body; } catch { /* plain words */ }
      throw new Error(String(words).slice(0, 200) || `Project Gutenberg did not send it (${res.status})`);
    }
    return res.text();
  }

  async function read(r, button) {
    const was = button?.textContent;
    if (button) { button.disabled = true; button.textContent = 'Opening...'; }
    try {
      const text = (await shelf.load(r.id).catch(() => null)) ?? await fetchText(r.id);
      ctx.openBook(r, text);
    } catch (e) {
      if (button) { button.disabled = false; button.textContent = was; say(button, `Could not open it: ${e.message}`); }
      else ui.home.replaceChildren(h('p', { class: 'r-note', text: `Could not open that book: ${e.message}` }));
    }
  }

  async function saveBook(r) {
    const text = await fetchText(r.id);
    await shelf.save({ id: r.id, title: r.title, author: r.author, years: r.years, genres: r.genres, text, saved: Date.now() });
  }

  async function showShelf() {
    const mine = ++showing;
    frame('My books', shelf.where());
    ctx.setCollections('shelf');
    ctx.setAddress({ author: 'shelf' });
    let books = [];
    try {
      books = await shelf.list();
    } catch (e) {
      ui.home.replaceChildren(h('p', { class: 'r-note', text: `Your saved books could not be read: ${e.message}` }));
      return;
    }
    if (mine !== showing || root.dataset.view !== 'home') return;
    ui.where.textContent = `${books.length} ${books.length === 1 ? 'book' : 'books'} · ${shelf.where()}`;
    if (!books.length) {
      ui.home.replaceChildren(h('p', { class: 'r-note', text: 'Nothing saved yet. Find a book in the Gutenberg library and press Save: it stays here to read whenever you like, with no connection.' }),
        h('button', { class: 'r-pill is-primary', type: 'button', text: 'Open the Gutenberg library', onclick: show }));
      return;
    }
    books.sort((a, b) => b.saved - a.saved);
    const places = await Promise.all(books.map(b => (shelf.keepsPlaces() ? shelf.getPlace(`pg-${b.id}`) : Promise.resolve(store.get(`reader:pg-${b.id}`)))));
    ui.home.replaceChildren(h('div', { class: 'r-tiles r-tiles-books' }, books.map((b, i) => {
      const place = places[i];
      const remove = h('button', { class: 'r-link', type: 'button', text: 'Remove', onclick: async e => {
        e.stopPropagation();
        if (!confirm(`Remove ${b.title} from My books? You can save it again from the library.`)) return;
        await shelf.remove(b.id);
        showShelf();
      } });
      return h('div', { class: 'r-tile r-tile-book r-shelf-mine' },
        h('button', { class: 'r-tile-open', type: 'button', onclick: () => read(b) },
          h('span', { class: 'r-tile-title', text: b.title }),
          h('span', { class: 'r-tile-meta', text: [b.author, b.years].filter(Boolean).join(', ') }),
          h('span', { class: place ? 'r-tile-go is-started' : 'r-tile-go', text: place ? 'Continue ›' : 'Start reading ›' })),
        remove);
    })));
  }

  return { show, showShelf, openById: async id => { await loadIndex().catch(() => null); const r = index?.byId.get(id) ?? (await shelf.list()).find(b => b.id === id); if (r) await read(r); else show(); } };
}

// ---------- The shelf: TOMLIN OS when it hosts the Reader, else this browser ----------

export const shelf = (() => {
  let host = null;
  let rid = 0;
  const waiting = new Map();
  window.addEventListener('message', e => {
    if (e.source !== window.parent || e.origin !== location.origin) return;
    const d = e.data ?? {};
    if (d.type === 'reader-host') host = { name: String(d.name || 'TOMLIN OS') };
    const w = waiting.get(d.rid);
    if (w) { waiting.delete(d.rid); d.error ? w.reject(new Error(d.error)) : w.resolve(d); }
  });
  // Is there a host? Asked once; a page that does not answer (or no parent at all) means this browser.
  const ready = window.parent === window ? Promise.resolve() : new Promise(resolve => {
    window.parent.postMessage({ type: 'reader-hello' }, location.origin);
    setTimeout(resolve, 400);
  });
  const ask = (type, extra = {}) => new Promise((resolve, reject) => {
    const id = ++rid;
    waiting.set(id, { resolve, reject });
    window.parent.postMessage({ type, rid: id, ...extra }, location.origin);
    setTimeout(() => { if (waiting.delete(id)) reject(new Error(`${host.name} did not answer`)); }, 20000);
  });

  // This browser: one IndexedDB store, keyed by the book's Gutenberg number.
  let dbp = null;
  const db = () => (dbp ??= new Promise((resolve, reject) => {
    const open = indexedDB.open('reader-shelf', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('books', { keyPath: 'id' });
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(new Error('this browser will not keep files here (a private window?)'));
  }));
  const tx = async (mode, run) => {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction('books', mode);
      const req = run(t.objectStore('books'));
      t.oncomplete = () => resolve(req?.result);
      t.onerror = () => reject(new Error(t.error?.name === 'QuotaExceededError' ? 'this browser is out of space' : 'this browser could not save it'));
    });
  };

  return {
    /** Is there anywhere to keep books? (Not on the front page or the lock screen of TOMLIN OS.) */
    async available() { await ready; return !!host || !HOST_ONLY; },
    saveLabel: () => (host ? `Save to ${host.name}` : 'Save'),
    where: () => (host ? `Saved in ${host.name}, in your files` : 'Kept in this browser, on this computer'),
    async save(book) {
      await ready;
      if (!host && HOST_ONLY) throw new Error('books can be saved only when you are signed in');
      return host ? ask('reader-save', { book }) : tx('readwrite', s => s.put(book));
    },
    async list() {
      await ready;
      if (host) return (await ask('reader-shelf')).books ?? [];
      if (HOST_ONLY) return [];
      const all = await tx('readonly', s => s.getAll());
      return (all ?? []).map(({ text, ...rest }) => rest);
    },
    async load(id) {
      await ready;
      if (host) return (await ask('reader-load', { id })).text ?? null;
      if (HOST_ONLY) return null;
      return (await tx('readonly', s => s.get(id)))?.text ?? null;
    },
    async remove(id) { await ready; return host ? ask('reader-remove', { id }) : tx('readwrite', s => s.delete(id)); },
    /** Inside TOMLIN OS, places in Gutenberg books are kept by TOMLIN OS (the person's own files), never in this browser. */
    keepsPlaces: () => HOST_ONLY,
    async getPlace(id) { await ready; return host ? ((await ask('reader-place-get', { id }).catch(() => ({}))).place ?? null) : null; },
    async setPlace(id, place) { await ready; if (host) await ask('reader-place-set', { id, place }).catch(() => undefined); },
    ready,
  };
})();

// ---------- A Gutenberg text as a book: its own words only, cut into chapters ----------

const NUMBER = '(?:[0-9]+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last)';
const HEADING = new RegExp(`^\\[?(?:Illustration:\\s*)?(?:chapter|book|part|stave|letter|act|scene|canto|volume)\\s+${NUMBER}\\b[.:]?(?:[\\s.:—-].{0,60})?$`, 'i');
// "I. A SCANDAL IN BOHEMIA": a Roman number, then a name in capitals (story collections).
const NAMED_ROMAN = /^[IVXLC]{1,6}\.\s+[A-Z][A-Z0-9'’,.:;!?& -]{2,64}$/;
const ROMAN = /^[IVXLCDM]{1,7}\.?$/;

function titleCase(t) {
  const clean = t.replace(/_/g, '').replace(/\s+/g, ' ').trim();
  const small = new Set(['a', 'an', 'the', 'of', 'in', 'and', 'to', 'on', 'at', 'for', 'by', 'with', 'or']);
  // Words in capitals become Title Case (Roman numbers stay); a mixed line ("CHAPTER 1. Loomings") only loses the
  // capitals of its first word.
  const letters = clean.replace(/[^A-Za-z]/g, '');
  const words = clean.split(' ');
  const capsFrom = words.findIndex((w, i) => i > 0 && /[A-Z]{2}/.test(w) && w === w.toUpperCase());
  const allCaps = letters === letters.toUpperCase() || (capsFrom > 0 && words.slice(capsFrom).join(' ') === words.slice(capsFrom).join(' ').toUpperCase());
  if (!allCaps) return clean.replace(/^(CHAPTER|STAVE|LETTER|BOOK|PART|ACT|SCENE|CANTO|VOLUME)\b/, w => w[0] + w.slice(1).toLowerCase());
  return words.map((w, i) => {
    const bare = w.toLowerCase().replace(/[^a-z]/g, '');
    if (/^[IVXLCDM]+[.:]?$/.test(w)) return w;
    if (i > 0 && small.has(bare) && !/[.:]$/.test(words[i - 1])) return w.toLowerCase();
    return w.toLowerCase().replace(/[a-z]/, c => c.toUpperCase());
  }).join(' ');
}

export function parseGutenberg(text) {
  const all = text.replace(/\r\n?/g, '\n').split('\n');
  const s = all.findIndex(l => /^\*\*\*\s*START OF (THE|THIS) PROJECT GUTENBERG/i.test(l));
  const e = all.findIndex(l => /^\*\*\*\s*END OF (THE|THIS) PROJECT GUTENBERG/i.test(l));
  const lines = all.slice(s < 0 ? 0 : s + 1, e < 0 ? all.length : e);
  const blank = i => i < 0 || i >= lines.length || !lines[i].trim();
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.length > 72 || !blank(i - 1)) continue;
    if (HEADING.test(t) || NAMED_ROMAN.test(t)) found.push({ at: i, named: true });
    else if (ROMAN.test(t)) found.push({ at: i, named: false });
  }
  // Bare Roman numbers are only chapters when nothing better is there (in story collections they number the parts
  // of each story).
  let kept = found.some(f => f.named) ? found.filter(f => f.named) : found;
  // A contents list names every chapter once more, before the book starts: when a named heading comes again later,
  // the earlier one was the contents.
  if (kept.some(f => f.named)) {
    const key = f => lines[f.at].trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    kept = kept.filter((f, k) => !kept.slice(k + 1).some(g => key(g) === key(f)));
  }
  // And a heading with almost nothing after it is a contents line too.
  const textBetween = (a, b) => { let n = 0; for (let i = a + 1; i < b; i++) if (lines[i].trim()) n++; return n; };
  const heads = kept.map(f => f.at).filter((at, k, arr) => textBetween(at, arr[k + 1] ?? lines.length) >= 6);
  let chapters;
  if (heads.length >= 2) {
    chapters = heads.map(at => {
      // Some editions wrap the heading in an illustration's brackets: "[Illustration: CHAPTER I.]".
      let title = titleCase(lines[at].trim().replace(/^\[(?:Illustration:\s*)?/i, '').replace(/[\].:\s]+$/, ''));
      // "CHAPTER I." then a short line on its own: that line is the chapter's name.
      let j = at + 1;
      while (j < lines.length && !lines[j].trim() && j < at + 3) j++;
      const next = lines[j]?.trim() ?? '';
      // Only when the heading is a number and nothing else ("Chapter I", "IV"): a named one has its name already.
      const bareNumber = /^(?:[a-z]+\s+)?[0-9ivxlcdm]+$/i.test(title);
      if (bareNumber && next && next.length < 60 && blank(j + 1) && !HEADING.test(next) && !/^[[(*]/.test(next) && !/[,;]$/.test(next)) title = `${title}: ${titleCase(next.replace(/\.$/, ''))}`;
      return { title, line: at };
    });
    if (textBetween(-1, heads[0]) > 3) chapters.unshift({ title: 'Opening pages', line: 0 });
  } else {
    // No headings found: parts of about 300 lines, each starting at a paragraph.
    chapters = [{ title: 'Part 1', line: 0 }];
    for (let i = 300; i < lines.length; i++) {
      if (i - chapters[chapters.length - 1].line >= 300 && blank(i - 1) && !blank(i)) chapters.push({ title: `Part ${chapters.length + 1}`, line: i });
    }
  }
  return { lines, chapters };
}
