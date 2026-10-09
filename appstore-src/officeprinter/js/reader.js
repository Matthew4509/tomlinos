// The speed reader: a whole book shown at the player's own claimed reading speed. Words per second, every frame,
// so a claimed 3,000 words a second really is a blur. The headings (book, chapter or scene) come from the Reader's
// library (labs/reader/library.json), so both show the same chapter names.

const cache = new Map();

/** Loads a text file once, as lines. */
export function loadLines(file) {
  if (!cache.has(file)) {
    cache.set(file, fetch(file).then(res => {
      if (!res.ok) throw new Error(`${file} is not installed (${res.status})`);
      return res.text();
    }).then(t => t.replace(/\r\n/g, '\n').split('\n')));
  }
  return cache.get(file);
}

/**
 * One work out of a file: lines start to end, the words before each line, and its headings ({ line, text, level },
 * line numbers in the whole file). "## " marker lines are neither shown nor counted.
 */
export function makeBook(all, start, end, heads = []) {
  const lines = all.slice(start, end);
  const before = new Array(lines.length);
  let words = 0;
  lines.forEach((line, i) => {
    before[i] = words;
    const t = line.trim();
    if (t && !t.startsWith('## ')) words += t.split(/\s+/).length;
  });
  const headings = heads.map(hd => ({ ...hd, line: hd.line - start })).filter(hd => hd.line >= 0 && hd.line < lines.length).sort((a, b) => a.line - b.line || a.level - b.level);
  return { lines, before, headings, words };
}

/** The line holding word number `w` (binary search over the words before each line). */
function lineAt(book, w) {
  let lo = 0;
  let hi = book.lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (book.before[mid] <= w) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The first line of the last page: far enough back from the last words to fill the box. */
function lastPage(book) {
  let i = book.lines.length - 1;
  while (i > 0 && !book.lines[i].trim()) i--;
  return Math.max(0, i - 14);
}

/** The headings in force at a line: the book (if any), the act, the scene. */
function headingAt(book, line) {
  const out = [];
  for (const h of book.headings) {
    if (h.line > line) break;
    out.length = h.level;
    out[h.level] = h.text;
  }
  return out.filter(Boolean).join(' · ');
}

/**
 * Runs the book through `view` ({ heading, text, meta } elements) at `wps` words a second, speeded up by `speed`
 * (the test setting). Resolves when the last word has gone past, or when stop() is called. Returns { stop, done }.
 */
export function runBook(book, wps, view, speed, fmt) {
  let stopped = false;
  let pos = 0;
  let last = performance.now();
  let frame = 0;
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  const tick = now => {
    if (stopped) return;
    pos = Math.min(book.words, pos + wps * speed * ((now - last) / 1000));
    last = now;
    // At the very end, stay on the last page rather than the blank lines after it.
    const line = pos >= book.words ? lastPage(book) : lineAt(book, pos);
    const shown = [];
    for (let i = line; i < book.lines.length && shown.length < 18; i++) {
      const t = book.lines[i];
      if (/^## /.test(t.trim())) continue;
      if (t.trim() || (shown.length && shown[shown.length - 1] !== '')) shown.push(t);
    }
    view.text.textContent = shown.join('\n');
    view.heading.textContent = headingAt(book, line);
    const left = (book.words - pos) / wps;
    view.meta.textContent = `Word ${fmt.num(Math.floor(pos))} of ${fmt.num(book.words)} · ${fmt.clock(left)} left`;
    view.bar.style.width = `${(100 * pos) / book.words}%`;
    if (pos >= book.words) {
      finish(true);
      return;
    }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return {
    done,
    stop() {
      stopped = true;
      cancelAnimationFrame(frame);
      finish(false);
    },
  };
}

/**
 * After the last word: the whole book in the box, scrolled to its last page, so it can be scrolled back up to the
 * start. The heading follows the scroll (roughly: by the share of the box scrolled).
 */
export function showAll(book, view, endText) {
  const lines = book.lines.filter(l => !/^## /.test(l.trim()));
  const kept = book.lines.map((l, i) => (/^## /.test(l.trim()) ? -1 : i)).filter(i => i >= 0);
  view.text.textContent = lines.join('\n').trimEnd();
  view.text.classList.add('is-done');
  view.text.tabIndex = 0;
  view.text.scrollTop = view.text.scrollHeight;
  view.meta.textContent = endText;
  view.bar.style.width = '100%';
  view.text.addEventListener('scroll', () => {
    const t = view.text;
    const share = t.scrollTop / Math.max(1, t.scrollHeight - t.clientHeight);
    view.heading.textContent = headingAt(book, kept[Math.min(kept.length - 1, Math.round(share * (kept.length - 1)))]);
  }, { passive: true });
}
