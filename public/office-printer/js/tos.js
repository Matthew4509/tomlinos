// The Printer Terms of Service: sections of small print made from script.json's own clauses and sentence patterns.
// The same text every time (a seeded shuffle, not Math.random), and exactly as many words as script.json says, so
// "You read 47,000 words" is a count, not a boast.

/** A small seeded random number source (mulberry32): the same seed gives the same small print. */
export function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function countWords(text) {
  const t = String(text).trim();
  return t ? t.split(/\s+/).length : 0;
}

/** Every word a reader scrolls past in a section: its number and title, then each clause with its number. */
export function sectionWords(section) {
  let n = countWords(`${section.n}. ${section.title}`);
  for (const c of section.clauses) n += countWords(`${c.n} ${c.text}`);
  return n;
}

export function buildTos(spec) {
  const rand = seeded(spec.seed);
  const pick = list => list[Math.floor(rand() * list.length)];
  const sentence = () => {
    const chosen = {};
    return pick(spec.templates).replace(/\{(\w+)\}/g, (whole, key) => {
      if (!spec.slots[key]) return whole;
      chosen[key] ??= pick(spec.slots[key]);
      return chosen[key];
    });
  };
  /** One to three sentences, never the same pattern twice in one clause. */
  const filler = () => {
    const out = [];
    const used = new Set();
    for (let n = 1 + Math.floor(rand() * 3); out.length < n; ) {
      const s = sentence();
      const pattern = s.slice(0, 18);
      if (used.has(pattern)) continue;
      used.add(pattern);
      out.push(s);
    }
    return out.join(' ');
  };
  const fixedIn = s => Object.keys(spec.fixed).filter(k => k.split('.')[0] === String(s)).map(k => Number(k.split('.')[1]));
  const names = spec.sectionNames;
  const nameOf = s => {
    if (spec.titles[s]) return spec.titles[s];
    const round = Math.floor((s - 1) / names.length);
    const name = names[(s - 1) % names.length];
    return round === 0 ? name : round === 1 ? `${name} (continued)` : `${name} (continued again)`;
  };

  const lastN = spec.sections;
  const last = { n: lastN, title: nameOf(lastN), clauses: fixedIn(lastN).sort((a, b) => a - b).map(i => ({ n: `${lastN}.${i}`, text: spec.fixed[`${lastN}.${i}`], fixed: true })) };
  const reserve = sectionWords(last);
  const target = spec.words;
  const sections = [];
  let used = 0;
  for (let s = 1; s < lastN; s++) {
    const section = { n: s, title: nameOf(s), clauses: [] };
    const needed = Math.max(0, ...fixedIn(s));
    const budget = (target - reserve - 12 - used) / (lastN - s);
    for (let i = 1; ; i++) {
      const fixed = spec.fixed[`${s}.${i}`];
      section.clauses.push({ n: `${s}.${i}`, text: fixed ?? filler(), fixed: !!fixed });
      if (i >= needed && sectionWords(section) >= budget) break;
    }
    used += sectionWords(section);
    sections.push(section);
  }

  // Make the count exact: take filler clauses off the end until there is room for the padding clause, then pad.
  const leadWords = countWords(spec.padding.lead);
  if (spec.padding.items.some(item => countWords(item) !== 1)) throw new Error('Each padding item must be one word.');
  const room = () => target - reserve - used;
  while (room() < leadWords + 2) {
    const from = [...sections].reverse().find(sec => sec.clauses.length && !sec.clauses[sec.clauses.length - 1].fixed);
    if (!from) throw new Error('The Terms of Service cannot be made that short.');
    const before = sectionWords(from);
    from.clauses.pop();
    used -= before - sectionWords(from);
  }
  const pad = sections[sections.length - 1];
  const count = room() - 1 - leadWords;
  const items = Array.from({ length: count }, (_, i) => spec.padding.items[i % spec.padding.items.length]);
  pad.clauses.push({ n: `${pad.n}.${pad.clauses.length + 1}`, text: `${spec.padding.lead} ${items.join(', ')}.`, fixed: false });
  sections.push(last);
  return { sections, words: sections.reduce((n, sec) => n + sectionWords(sec), 0) };
}
