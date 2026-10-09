// Builds server/books/gutenberg.json, the Reader's index of Project Gutenberg's English books, from Gutenberg's own catalogue.
//   node labs/reader/tools/build-gutenberg.mjs            downloads the catalogue (one file, about 21 MB) and the
//                                                         "top 100 last 30 days" page, once each
//   node labs/reader/tools/build-gutenberg.mjs <csv> [top.html]   uses copies you already have
// The downloads are kept in labs/reader/.cache/ (not in git). The books themselves are never downloaded here: the
// Reader fetches one when someone opens or saves it (gutenberg.php).
//
// One row a book: [id, title, author, years, genre indexes, topic indexes, rank in the top 100 (0 = not in it)].
//   genres = Gutenberg's own "Category: ..." shelves (Novels, Crime, Thrillers and Mystery, Poetry, ...)
//   topics = the most common subject headings, first part only ("Detective and mystery stories", "Whales", ...)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const readerDir = path.resolve(here, '..');
const cacheDir = path.join(readerDir, '.cache');
const CATALOGUE = 'https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv';
const TOP = 'https://www.gutenberg.org/browse/scores/top';
const TOPICS_KEPT = 150;
const TOPIC_MIN_BOOKS = 60;

async function download(url, file) {
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  const res = await fetch(url, { headers: { 'User-Agent': 'TOMLIN OS Reader catalogue build (once, by hand)' } });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const text = await res.text();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return text;
}

/** RFC 4180 CSV: quoted fields may hold commas, doubled quotes and line breaks. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** "Austen, Jane, 1775-1817 [Author]" -> { name: "Jane Austen", years: "1775-1817" }. */
function person(raw) {
  const s = raw.replace(/\[[^\]]*\]/g, '').trim();
  const m = s.match(/^(.*?),\s*((?:BCE? )?\d{1,4}\??(?: BCE)?-(?:\d{1,4}\??)?(?: BCE)?|\d{1,4}-|-\d{1,4})$/);
  const namepart = (m ? m[1] : s).trim();
  const years = m ? m[2].trim() : '';
  const bits = namepart.split(',').map(x => x.trim()).filter(Boolean);
  // "Surname, Given (Full given names)": the full names in brackets are dropped for the short form.
  const given = (bits[1] ?? '').replace(/\s*\(.*\)$/, '');
  const name = bits.length >= 2 ? `${given} ${bits[0]}`.trim() : namepart;
  return { name, years };
}

const csvPath = process.argv[2] ?? path.join(cacheDir, 'pg_catalog.csv');
const topPath = process.argv[3] ?? path.join(cacheDir, 'top.html');
const csv = process.argv[2] ? fs.readFileSync(csvPath, 'utf8') : await download(CATALOGUE, csvPath);
let topHtml = '';
try {
  topHtml = process.argv[3] ? fs.readFileSync(topPath, 'utf8') : await download(TOP, topPath);
} catch (e) {
  console.warn(`No top 100 (${e.message}): books will be listed without a popularity order.`);
}

const [head, ...rows] = parseCsv(csv);
const col = name => head.indexOf(name);
const C = { id: col('Text#'), type: col('Type'), title: col('Title'), lang: col('Language'), authors: col('Authors'), subjects: col('Subjects'), shelves: col('Bookshelves'), issued: col('Issued') };
if (Object.values(C).some(i => i < 0)) throw new Error(`The catalogue's columns have changed: ${head.join(', ')}`);

// The top 100 for the last 30 days, in order.
const rank = new Map();
const at = topHtml.indexOf('id="books-last30"');
if (at >= 0) {
  const list = topHtml.slice(at, topHtml.indexOf('</ol>', at));
  [...list.matchAll(/href="\/ebooks\/(\d+)"/g)].forEach((m, i) => rank.set(Number(m[1]), i + 1));
}

const books = rows.filter(r => r[C.type] === 'Text' && r[C.lang] === 'en' && /^\d+$/.test(r[C.id]));
const genreCount = new Map();
const topicCount = new Map();
const parsed = books.map(r => {
  const genres = r[C.shelves].split(';').map(s => s.trim()).filter(s => s.startsWith('Category: ')).map(s => s.slice(10));
  const topics = [...new Set(r[C.subjects].split(';').map(s => s.split(' -- ')[0].trim().replace(/\.$/, '')).filter(Boolean))];
  for (const g of genres) genreCount.set(g, (genreCount.get(g) ?? 0) + 1);
  for (const t of topics) topicCount.set(t, (topicCount.get(t) ?? 0) + 1);
  const people = r[C.authors].split(';').map(s => s.trim()).filter(s => s && !/\[(Translator|Editor|Illustrator|Contributor|Commentator|Compiler|Annotator)\]/i.test(s)).map(person);
  const author = people.length === 0 ? 'Anonymous' : people.length === 1 ? people[0].name : people.length === 2 ? `${people[0].name} and ${people[1].name}` : `${people[0].name} and others`;
  const title = r[C.title].replace(/\s*\r?\n\s*/g, ': ').replace(/\s+/g, ' ').trim();
  return { id: Number(r[C.id]), title, author, years: people.length === 1 ? people[0].years : '', genres, topics };
});

const genres = [...genreCount.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([g]) => g);
const topics = [...topicCount.entries()].filter(([, n]) => n >= TOPIC_MIN_BOOKS).sort((a, b) => b[1] - a[1]).slice(0, TOPICS_KEPT).map(([t]) => t).sort((a, b) => a.localeCompare(b));
const gi = new Map(genres.map((g, i) => [g, i]));
const ti = new Map(topics.map((t, i) => [t, i]));
const out = {
  built: new Date().toISOString().slice(0, 10),
  source: 'Project Gutenberg catalogue (pg_catalog.csv), English texts only',
  genres,
  topics,
  books: parsed.map(b => [b.id, b.title, b.author, b.years, b.genres.map(g => gi.get(g)), b.topics.filter(t => ti.has(t)).map(t => ti.get(t)), rank.get(b.id) ?? 0]),
};
const file = path.resolve(readerDir, '..', '..', 'server', 'books', 'gutenberg.json');
fs.writeFileSync(file, JSON.stringify(out));
fs.writeFileSync(path.join(cacheDir, '.gitignore'), '*\n');
console.log(`${out.books.length} books, ${genres.length} genres, ${topics.length} topics, ${rank.size} ranked; ${(fs.statSync(file).size / 1e6).toFixed(1)} MB -> ${path.relative(process.cwd(), file)}`);
