// Fetches Shakespeare for Office Printer's speed-reading test: one public-domain file, the Complete Works (Project
// Gutenberg eBook #100, about 5.5 MB), cut into the three texts script.json names:
//   public/office-printer/texts/hamlet.txt      Hamlet
//   public/office-printer/texts/tragedies.txt   Hamlet, Othello, King Lear and Macbeth
//   public/office-printer/texts/complete.txt    every work
// Only Shakespeare's words are kept: the Project Gutenberg header, licence and footer are cut off (their licence
// asks for that when the text is passed on without their name). Until this has been run, the game says
// "nobody installed Hamlet" at that point instead of flashing it.
//   node tools/fetch-shakespeare.mjs            (downloads)
//   node tools/fetch-shakespeare.mjs pg100.txt  (uses a copy already on this computer)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = 'https://www.gutenberg.org/cache/epub/100/pg100.txt';
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'office-printer', 'texts');

async function source() {
  if (process.argv[2]) return readFileSync(process.argv[2], 'utf8');
  console.log(`Downloading ${SOURCE}`);
  const res = await fetch(SOURCE, { headers: { 'User-Agent': 'TOMLIN OS Office Printer (one-off download of a public-domain text)' } });
  if (!res.ok) throw new Error(`${SOURCE}: ${res.status} ${res.statusText}`);
  return res.text();
}

const words = text => text.trim().split(/\s+/).filter(Boolean).length;

const raw = (await source()).replace(/\r\n/g, '\n');
const start = raw.search(/^\*\*\* ?START OF (THE|THIS) PROJECT GUTENBERG EBOOK.*$/m);
const end = raw.search(/^\*\*\* ?END OF (THE|THIS) PROJECT GUTENBERG EBOOK.*$/m);
if (start < 0 || end < 0) throw new Error('The START and END lines of the eBook were not found: the file is not the one expected.');
const body = raw.slice(raw.indexOf('\n', start) + 1, end);

// The contents list: every title once, then each work starts with its title again.
const lines = body.split('\n');
const contentsAt = lines.findIndex(l => l.trim() === 'Contents');
if (contentsAt < 0) throw new Error('No "Contents" line.');
const titles = [];
let firstWorkLine = -1;
for (let i = contentsAt + 1; i < lines.length; i++) {
  const t = lines[i].trim();
  if (!t) continue;
  if (titles.includes(t)) {
    firstWorkLine = i;
    break;
  }
  titles.push(t);
}
if (titles.length < 30 || firstWorkLine < 0) throw new Error(`Only ${titles.length} titles in the contents; expected about 44.`);
const contentsEnd = lines.slice(0, firstWorkLine).join('\n').length;

/** Where each work starts in the body: its title's first appearance after the contents. */
const starts = [];
let from = contentsEnd;
for (const title of titles) {
  const re = new RegExp(`^\\s*${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
  const at = body.slice(from).search(re);
  if (at < 0) throw new Error(`"${title}" is in the contents but not in the text.`);
  starts.push({ title, at: from + at });
  from = from + at + title.length;
}
const work = name => {
  const i = starts.findIndex(s => s.title.includes(name));
  if (i < 0) throw new Error(`No work called ${name}.`);
  return body.slice(starts[i].at, i + 1 < starts.length ? starts[i + 1].at : body.length).trim();
};

const hamlet = work('HAMLET');
const tragedies = ['HAMLET', 'OTHELLO', 'KING LEAR', 'MACBETH'].map(work).join('\n\n\n');
const complete = body.slice(starts[0].at).trim();
mkdirSync(out, { recursive: true });
for (const [file, text] of [['hamlet.txt', hamlet], ['tragedies.txt', tragedies], ['complete.txt', complete]]) {
  writeFileSync(join(out, file), text + '\n');
  console.log(`${file}: ${words(text).toLocaleString('en-GB')} words, ${(Buffer.byteLength(text) / 1048576).toFixed(2)} MB`);
}
if (words(hamlet) < 25000 || words(hamlet) > 40000) throw new Error(`Hamlet came out at ${words(hamlet)} words; expected about 32,000. Check the cut.`);
console.log(`Written to ${out}. Rebuild (npm run build) so TOMLIN OS serves them.`);
