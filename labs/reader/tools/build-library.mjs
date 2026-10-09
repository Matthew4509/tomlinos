// Builds the Reader's library index, labs/reader/library.json, from the two text files the game already has:
//   public/office-printer/texts/complete.txt   Shakespeare, every work (Project Gutenberg eBook #100)
//   labs/office-printer-b/texts/sherlock.txt   Sherlock Holmes, nine books (fetch-sherlock.mjs)
// For each work: where it starts and ends (line numbers), its word count (counted the way the speed reader counts),
// and its chapters (scenes for a play, sonnets, stories for a collection, chapters for a novel).
//   node labs/reader/tools/build-library.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const labs = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tomlinos = join(labs, '..');
const read = p => readFileSync(p, 'utf8').replace(/\r\n/g, '\n').split('\n');

/** Words the way reader.js counts them: whitespace-separated, "## " marker lines left out. */
const wordsIn = (lines, from, to) => {
  let n = 0;
  for (let i = from; i < to; i++) {
    const t = lines[i].trim();
    if (t && !t.startsWith('## ')) n += t.split(/\s+/).length;
  }
  return n;
};
const norm = s => s.toLowerCase().replace(/[’'"“”_.,;:!?()—-]/g, ' ').replace(/\s+/g, ' ').trim();
const roman = s => s.replace(/^[ivxlc]+\.?\s+/i, '');
const titleCase = s => s.toLowerCase().replace(/(^|[\s(“"[-])([a-zà-ÿ’'])/g, (m, a, b) => a + b.toUpperCase())
  .replace(/\b(Of|The|And|In|A|An|On|Or|To|With|For|At|By)\b/g, (w, _, i) => (i === 0 ? w : w.toLowerCase()))
  .replace(/’S\b/g, '’s');

// ---------- Shakespeare ----------

// Gutenberg #100's contents, exactly as each title stands on its own line, with the short title the game shows.
const PLAYS = [
  ['THE SONNETS', 'The Sonnets', 'poems'],
  ['ALL’S WELL THAT ENDS WELL', 'All’s Well That Ends Well'],
  ['THE TRAGEDY OF ANTONY AND CLEOPATRA', 'Antony and Cleopatra'],
  ['AS YOU LIKE IT', 'As You Like It'],
  ['THE COMEDY OF ERRORS', 'The Comedy of Errors'],
  ['THE TRAGEDY OF CORIOLANUS', 'Coriolanus'],
  ['CYMBELINE', 'Cymbeline'],
  ['THE TRAGEDY OF HAMLET, PRINCE OF DENMARK', 'Hamlet'],
  ['THE FIRST PART OF KING HENRY THE FOURTH', 'Henry IV, Part 1'],
  ['THE SECOND PART OF KING HENRY THE FOURTH', 'Henry IV, Part 2'],
  ['THE LIFE OF KING HENRY THE FIFTH', 'Henry V'],
  ['THE FIRST PART OF HENRY THE SIXTH', 'Henry VI, Part 1'],
  ['THE SECOND PART OF KING HENRY THE SIXTH', 'Henry VI, Part 2'],
  ['THE THIRD PART OF KING HENRY THE SIXTH', 'Henry VI, Part 3'],
  ['KING HENRY THE EIGHTH', 'Henry VIII'],
  ['THE LIFE AND DEATH OF KING JOHN', 'King John'],
  ['THE TRAGEDY OF JULIUS CAESAR', 'Julius Caesar'],
  ['THE TRAGEDY OF KING LEAR', 'King Lear'],
  ['LOVE’S LABOUR’S LOST', 'Love’s Labour’s Lost'],
  ['THE TRAGEDY OF MACBETH', 'Macbeth'],
  ['MEASURE FOR MEASURE', 'Measure for Measure'],
  ['THE MERCHANT OF VENICE', 'The Merchant of Venice'],
  ['THE MERRY WIVES OF WINDSOR', 'The Merry Wives of Windsor'],
  ['A MIDSUMMER NIGHT’S DREAM', 'A Midsummer Night’s Dream'],
  ['MUCH ADO ABOUT NOTHING', 'Much Ado About Nothing'],
  ['THE TRAGEDY OF OTHELLO, THE MOOR OF VENICE', 'Othello'],
  ['PERICLES, PRINCE OF TYRE', 'Pericles'],
  ['THE LIFE AND DEATH OF KING RICHARD THE SECOND', 'Richard II'],
  ['KING RICHARD THE THIRD', 'Richard III'],
  ['THE TRAGEDY OF ROMEO AND JULIET', 'Romeo and Juliet'],
  ['THE TAMING OF THE SHREW', 'The Taming of the Shrew'],
  ['THE TEMPEST', 'The Tempest'],
  ['THE LIFE OF TIMON OF ATHENS', 'Timon of Athens'],
  ['THE TRAGEDY OF TITUS ANDRONICUS', 'Titus Andronicus'],
  ['TROILUS AND CRESSIDA', 'Troilus and Cressida'],
  ['TWELFTH NIGHT; OR, WHAT YOU WILL', 'Twelfth Night'],
  ['THE TWO GENTLEMEN OF VERONA', 'The Two Gentlemen of Verona'],
  ['THE TWO NOBLE KINSMEN', 'The Two Noble Kinsmen'],
  ['THE WINTER’S TALE', 'The Winter’s Tale'],
  ['A LOVER’S COMPLAINT', 'A Lover’s Complaint', 'poems'],
  ['THE PASSIONATE PILGRIM', 'The Passionate Pilgrim', 'poems'],
  ['THE PHOENIX AND THE TURTLE', 'The Phoenix and the Turtle', 'poems'],
  ['THE RAPE OF LUCRECE', 'The Rape of Lucrece', 'poems'],
  ['VENUS AND ADONIS', 'Venus and Adonis', 'poems'],
];

function shakespeare() {
  const file = 'texts/complete.txt';
  const lines = read(join(tomlinos, 'public', 'office-printer', file));
  const starts = [];
  let from = 0;
  for (const [exact, short, kind] of PLAYS) {
    const at = lines.findIndex((l, i) => i >= from && l.trim() === exact);
    if (at < 0) throw new Error(`Shakespeare: "${exact}" not found after line ${from}.`);
    starts.push({ exact, short, kind: kind ?? 'play', at });
    from = at + 1;
  }
  const works = starts.map((s, k) => {
    const end = k + 1 < starts.length ? starts[k + 1].at : lines.length;
    const chapters = [];
    if (s.kind === 'play') {
      // The contents list repeats every heading, so scenes are looked for only after the cast list ("Dramatis
      // Personæ"), which every play has between its contents and its first scene.
      let act = '';
      chapters.push({ title: 'Title and characters', line: s.at });
      const cast = lines.findIndex((l, i) => i > s.at && i < end && /^\s*Dramatis Person/i.test(l));
      if (cast < 0) throw new Error(`Shakespeare: no cast list in ${s.short}.`);
      for (let i = cast + 1; i < end; i++) {
        const l = lines[i].trim();
        if (/^ACT [IVX]+\.?$/.test(l)) act = l.replace(/\.$/, '');
        else if (/^(SCENE|Scene) [IVX]+\./.test(l) || /^(THE )?(PROLOGUE|EPILOGUE|INDUCTION)$/i.test(l)) {
          // (A speaker called Prologue is "PROLOGUE." with a full stop, and is not a heading.)
          const name = l.replace(/\.$/, '');
          const scene = /^(SCENE|Scene) ([IVX]+)\.\s*(.*)$/.exec(name);
          chapters.push({ title: scene ? `${act.replace(/^ACT/, 'Act')}, Scene ${scene[2]}${scene[3] ? `: ${scene[3]}` : ''}` : titleCase(name), line: i });
        }
      }
    } else if (s.exact === 'THE SONNETS') {
      for (let i = s.at + 1; i < end; i++) if (/^\s{8,}\d{1,3}$/.test(lines[i])) chapters.push({ title: `Sonnet ${lines[i].trim()}`, line: i });
    } else if (s.exact === 'THE PASSIONATE PILGRIM') {
      for (let i = s.at + 1; i < end; i++) if (/^[IVX]+$/.test(lines[i].trim()) && !lines[i - 1].trim()) chapters.push({ title: `Poem ${lines[i].trim()}`, line: i });
    }
    if (!chapters.length) chapters.push({ title: s.short, line: s.at });
    return { id: s.short.toLowerCase().replace(/’/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), title: s.short, fullTitle: titleCase(s.exact), kind: s.kind, start: s.at, end, words: wordsIn(lines, s.at, end), chapters };
  });
  return {
    id: 'shakespeare', name: 'William Shakespeare', short: 'Shakespeare', monogram: 'WS', years: '1564–1616',
    about: 'English playwright and poet, born in Stratford-upon-Avon. His plays were collected after his death in the First Folio of 1623.',
    file, all: { id: 'complete', title: 'The Complete Works of Shakespeare', start: starts[0].at, end: lines.length, words: wordsIn(lines, starts[0].at, lines.length) },
    works,
  };
}

// ---------- Sherlock Holmes ----------

const BOOKS = {
  'A Study in Scarlet': { year: 1887, kind: 'novel' },
  'The Sign of the Four': { year: 1890, kind: 'novel' },
  'The Adventures of Sherlock Holmes': { year: 1892, stories: ['A Scandal in Bohemia', 'The Red-Headed League', 'A Case of Identity', 'The Boscombe Valley Mystery', 'The Five Orange Pips', 'The Man with the Twisted Lip', 'The Adventure of the Blue Carbuncle', 'The Adventure of the Speckled Band', 'The Adventure of the Engineer’s Thumb', 'The Adventure of the Noble Bachelor', 'The Adventure of the Beryl Coronet', 'The Adventure of the Copper Beeches'] },
  'The Memoirs of Sherlock Holmes': { year: 1894, stories: ['Silver Blaze', 'The Adventure of the Cardboard Box', 'The Yellow Face', 'The Stockbroker’s Clerk', 'The “Gloria Scott”', 'The Musgrave Ritual', 'The Reigate Squires', 'The Crooked Man', 'The Resident Patient', 'The Greek Interpreter', 'The Naval Treaty', 'The Final Problem'] },
  'The Hound of the Baskervilles': { year: 1902, kind: 'novel' },
  'The Return of Sherlock Holmes': { year: 1905, stories: ['The Adventure of the Empty House', 'The Adventure of the Norwood Builder', 'The Adventure of the Dancing Men', 'The Adventure of the Solitary Cyclist', 'The Adventure of the Priory School', 'The Adventure of Black Peter', 'The Adventure of Charles Augustus Milverton', 'The Adventure of the Six Napoleons', 'The Adventure of the Three Students', 'The Adventure of the Golden Pince-Nez', 'The Adventure of the Missing Three-Quarter', 'The Adventure of the Abbey Grange', 'The Adventure of the Second Stain'] },
  'The Valley of Fear': { year: 1915, kind: 'novel' },
  'His Last Bow': { year: 1917, stories: ['The Adventure of Wisteria Lodge', 'The Adventure of the Bruce-Partington Plans', 'The Adventure of the Devil’s Foot', 'The Adventure of the Red Circle', 'The Disappearance of Lady Frances Carfax', 'The Adventure of the Dying Detective', 'His Last Bow'] },
  'The Case-Book of Sherlock Holmes': { year: 1927, stories: ['The Adventure of the Illustrious Client', 'The Adventure of the Blanched Soldier', 'The Adventure of the Mazarin Stone', 'The Adventure of the Three Gables', 'The Adventure of the Sussex Vampire', 'The Adventure of the Three Garridebs', 'The Problem of Thor Bridge', 'The Adventure of the Creeping Man', 'The Adventure of the Lion’s Mane', 'The Adventure of the Veiled Lodger', 'The Adventure of Shoscombe Old Place', 'The Adventure of the Retired Colourman'] },
};

function sherlock() {
  const file = 'texts/sherlock.txt';
  const lines = read(join(labs, 'office-printer-b', file));
  const heads = lines.map((l, i) => (/^## /.test(l) ? { title: l.slice(3).trim(), at: i } : null)).filter(Boolean);
  let stories = 0;
  let novels = 0;
  const works = heads.map((hd, k) => {
    const end = k + 1 < heads.length ? heads[k + 1].at : lines.length;
    const info = BOOKS[hd.title];
    if (!info) throw new Error(`Sherlock: unknown book "${hd.title}".`);
    const chapters = [];
    if (info.stories) {
      // Each story title is in the contents list first, then again where the story starts. The contents list ends
      // before the first story starts, which is after the last title's first appearance.
      const match = (i, title) => {
        const l = norm(roman(lines[i].trim()));
        const t = norm(title);
        return l === t || (l.startsWith(t) && l.length <= t.length + 50);
      };
      const firstOf = title => { for (let i = hd.at + 1; i < end; i++) if (match(i, title)) return i; return -1; };
      const hasContents = lines.slice(hd.at, hd.at + 80).some(l => /^\s*contents\s*$/i.test(l));
      const contentsEnd = hasContents ? firstOf(info.stories[info.stories.length - 1]) : hd.at;
      let from = contentsEnd + 1;
      for (const title of info.stories) {
        let at = -1;
        for (let i = from; i < end; i++) if (match(i, title)) { at = i; break; }
        if (at < 0) throw new Error(`Sherlock: "${title}" not found in ${hd.title}.`);
        chapters.push({ title, line: at });
        from = at + 1;
      }
      stories += chapters.length;
    } else {
      novels += 1;
      let part = '';
      chapters.push({ title: 'Title', line: hd.at });
      for (let i = hd.at + 1; i < end; i++) {
        const l = lines[i];
        if (/^\s/.test(l)) continue;
        const p = /^PART ([IVX]+)\b[.—\s]*(.*)$/i.exec(l.trim());
        if (p) { part = `Part ${p[1].toUpperCase()}`; continue; }
        const c = /^CHAPTER\s+([IVXLC]+|\d+)\b[.—\s]*(.*)$/i.exec(l.trim());
        if (!c) continue;
        let name = c[2].trim();
        if (!name) { let j = i + 1; while (j < end && !lines[j].trim()) j++; name = lines[j].trim(); }
        chapters.push({ title: `${part && part !== 'Part I' ? `${part}, ` : ''}Chapter ${c[1]}: ${titleCase(name.replace(/\.$/, ''))}`, line: i });
      }
    }
    return { id: hd.title.toLowerCase().replace(/’/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), title: hd.title, fullTitle: hd.title, year: info.year, kind: info.stories ? 'stories' : 'novel', start: hd.at, end, words: wordsIn(lines, hd.at, end), chapters };
  });
  if (stories !== 56 || novels !== 4) throw new Error(`Sherlock: found ${novels} novels and ${stories} stories; expected 4 and 56.`);
  return {
    id: 'doyle', name: 'Sir Arthur Conan Doyle', short: 'Sherlock Holmes', monogram: 'ACD', years: '1859–1930',
    about: 'Scottish writer and doctor, born in Edinburgh. Sherlock Holmes first appeared in A Study in Scarlet in 1887; Doyle wrote four novels and 56 stories about him.',
    file, all: { id: 'sherlock', title: 'All of Sherlock Holmes', start: 0, end: lines.length, words: wordsIn(lines, 0, lines.length) },
    works,
  };
}

const library = { built: 'tools/build-library.mjs', authors: [shakespeare(), sherlock()] };
writeFileSync(join(labs, 'reader', 'library.json'), JSON.stringify(library) + '\n');
for (const a of library.authors) {
  console.log(`${a.name}: ${a.works.length} works, ${a.all.words.toLocaleString('en-GB')} words, ${a.works.reduce((n, w) => n + w.chapters.length, 0)} chapters`);
  for (const w of a.works) console.log(`  ${w.title}: ${w.words.toLocaleString('en-GB')} words, ${w.chapters.length} chapters (first: ${w.chapters[0].title}${w.chapters[1] ? `; ${w.chapters[1].title}` : ''})`);
}
