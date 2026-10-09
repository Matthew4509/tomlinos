// Office Printer: the game's rules, without a page. game.js draws and times everything; this file decides what
// happens next. Everything a printer says, and where each choice leads, comes from script.json.

export const INKS = ['c', 'm', 'y', 'k'];
const INK_NAMES = { c: 'cyan', m: 'magenta', y: 'yellow', k: 'black' };

/** A fresh saved game: what the printers remember between runs. */
export function newSave() {
  return {
    v: 1,
    attempts: 0,
    endings: {},
    notes: {},
    told: {},
    mood: {},
    known: {},
    sound: false,
    messages: true,
    lastMessage: '',
    lastDoc: null,
  };
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A saved game read back from storage, with anything missing or broken put back to its fresh value. */
export function loadSave(raw) {
  const save = newSave();
  let data = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return save;
    }
  }
  if (!isObject(data)) return save;
  if (Number.isFinite(data.attempts) && data.attempts >= 0) save.attempts = Math.floor(data.attempts);
  for (const key of ['endings', 'told', 'mood', 'known']) if (isObject(data[key])) save[key] = data[key];
  if (isObject(data.notes)) {
    for (const [note, heard] of Object.entries(data.notes)) {
      if (isObject(heard) && Number.isFinite(heard.since)) save.notes[note] = { count: Number(heard.count) || 1, since: heard.since };
    }
  }
  if (typeof data.sound === 'boolean') save.sound = data.sound;
  if (typeof data.messages === 'boolean') save.messages = data.messages;
  if (typeof data.lastMessage === 'string') save.lastMessage = data.lastMessage;
  const doc = data.lastDoc;
  if (isObject(doc) && typeof doc.name === 'string' && doc.name) {
    save.lastDoc = { name: doc.name, path: typeof doc.path === 'string' ? doc.path : null, sample: typeof doc.sample === 'string' ? doc.sample : null };
  }
  return save;
}

/** One print job, from pressing Print to an ending. */
export function newRun(script, file, entry) {
  const ink = {};
  for (const [id, who] of Object.entries(script.speakers)) {
    if (who.printer) ink[id] = { c: 100, m: 100, y: 100, k: 100 };
  }
  return { node: entry ?? script.start, file, at: 'laserjet', ink, flags: {}, tos: null, warrantyShown: false, queue: null };
}

// ---- Conditions ----------------------------------------------------------------------------------------------

/** "7", ">=4", "<5" and the like against a number. */
export function compare(value, spec) {
  if (typeof spec === 'number') return value === spec;
  const m = /^(>=|<=|==|!=|>|<)?\s*(-?\d+(?:\.\d+)?)$/.exec(String(spec).trim());
  if (!m) throw new Error(`Cannot compare with "${spec}"`);
  const n = Number(m[2]);
  switch (m[1] ?? '==') {
    case '>=': return value >= n;
    case '<=': return value <= n;
    case '>': return value > n;
    case '<': return value < n;
    case '!=': return value !== n;
    default: return value === n;
  }
}

const listOf = value => (Array.isArray(value) ? value : [value]);

/** Whether a condition from script.json holds. Several keys in one condition must all hold. */
export function holds(cond, g) {
  if (cond == null) return true;
  for (const [key, want] of Object.entries(cond)) {
    if (!holdsOne(key, want, g)) return false;
  }
  return true;
}

function holdsOne(key, want, g) {
  const { save, run } = g;
  const file = run?.file ?? {};
  switch (key) {
    case 'attempts': return compare(save.attempts, want);
    case 'ending': return listOf(want).every(id => !!save.endings[id]);
    case 'noEnding': return listOf(want).every(id => !save.endings[id]);
    case 'known': return listOf(want).every(k => !!save.known[k]);
    case 'unknown': return listOf(want).every(k => !save.known[k]);
    case 'flag': return listOf(want).every(k => !!run?.flags[k]);
    case 'noFlag': return listOf(want).every(k => !run?.flags[k]);
    case 'kind': return listOf(want).includes(file.kind);
    case 'ext': return listOf(want).includes(file.ext);
    case 'alpha': return !!file.alpha === want;
    case 'cyan': return (file.colour === 'cyan') === want;
    case 'mood': return Object.entries(want).every(([who, spec]) => compare(save.mood[who] ?? 0, spec));
    case 'notes': return compare(Object.keys(save.notes).length, want);
    case 'copy': return compare(lindaCopy(g.script, save), want);
    case 'tosSecret': return !!run?.tos?.secret === want;
    case 'tosSeconds': return run?.tos != null && !run.tos.secret && compare(run.tos.seconds, want);
    case 'not': return !holds(want, g);
    case 'any': return listOf(want).some(c => holds(c, g));
    case 'all': return listOf(want).every(c => holds(c, g));
    default: throw new Error(`Unknown condition "${key}"`);
  }
}

// ---- Moving through the script -------------------------------------------------------------------------------

/** The node to play for an id, after its redirects. */
export function resolve(script, g, id) {
  const seen = new Set();
  let current = id;
  for (;;) {
    const node = script.nodes[current];
    if (!node) throw new Error(`No node called "${current}"`);
    if (seen.has(current)) throw new Error(`Redirects loop at "${current}"`);
    seen.add(current);
    const jump = (node.redirect ?? []).find(r => holds(r.if, g));
    if (!jump) return { id: current, node };
    current = jump.to;
  }
}

/** Where a "next" goes: a node id, or the first entry of a list whose condition holds. */
export function nextOf(next, g) {
  if (next == null) return null;
  if (typeof next === 'string') return next;
  const hit = next.find(entry => holds(entry.if, g));
  if (!hit) throw new Error('No way on: every "next" had a condition and none held');
  return hit.to;
}

export function choicesOf(node, g) {
  return (node.choices ?? []).filter(choice => holds(choice.if, g));
}

/** The speaker of a line: "@current" is whichever machine the player is connected to. */
export function speakerOf(id, g) {
  return id === '@current' ? g.run.at : id;
}

/** A step as written in script.json: a line to say, "render:x" / "ending:x" / "bounce:x" / "sound:x", or an object. */
export function stepOf(step) {
  if (typeof step !== 'string') return step;
  const m = /^(render|ending|bounce|sound):([A-Za-z0-9_-]+)$/.exec(step);
  return m ? { [m[1]]: m[2] } : { line: step };
}

/** A node's "text": one line, or a list of lines and effects in the order they happen. */
export function textOf(node) {
  if (node.text == null) return [];
  return Array.isArray(node.text) ? node.text : [node.text];
}

/**
 * The effects that only change state (notes, moods, what the printers know, ink). Returns true when it handled the
 * step. Lines, pictures, sounds, waits, bounces and endings are for game.js.
 */
export function applyStep(step, g) {
  const { save, run } = g;
  if (step.note) {
    const had = save.notes[step.note];
    save.notes[step.note] = { count: (had?.count ?? 0) + 1, since: had?.since ?? save.attempts };
    return true;
  }
  if (step.mood) {
    for (const [who, by] of Object.entries(step.mood)) save.mood[who] = (save.mood[who] ?? 0) + by;
    return true;
  }
  if (step.know) {
    save.known[step.know] = true;
    return true;
  }
  if (step.flag) {
    run.flags[step.flag] = true;
    return true;
  }
  if (step.setInk) {
    const tank = run.ink[step.printer ?? run.at];
    if (tank) for (const [c, v] of Object.entries(step.setInk)) tank[c] = v;
    return true;
  }
  return false;
}

/** The inks a setInk changes (for the ink bars' animation). */
export function inksOf(step) {
  return Object.keys(step.setInk ?? {});
}

export function inkWords(tank) {
  return INKS.map(c => `${INK_NAMES[c]} ${tank[c] >= 100 ? 'full' : tank[c] <= 0 ? 'empty' : `${Math.round(tank[c])} per cent`}`).join(', ');
}

// ---- What the printers say -------------------------------------------------------------------------------------

/** The mocking line for this attempt: polite for 2 to 3, sarcastic for 4 to 7, personal from 8. None the first time. */
export function mockLine(script, save) {
  const n = save.attempts;
  if (n <= 1) return null;
  const [tier, from] = n <= 3 ? ['polite', 2] : n <= 7 ? ['sarcastic', 4] : ['personal', 8];
  const lines = script.mockery[tier];
  return lines[(n - from) % lines.length];
}

/**
 * Something the printer has heard about the player and not yet said, or null. Gossip takes a run to get round: what
 * you did in this run reaches the others by the next one.
 */
export function gossipFor(script, save, speaker) {
  const told = save.told[speaker] ?? [];
  for (const [note, heard] of Object.entries(save.notes)) {
    const line = script.gossip[note]?.[speaker];
    if (line && !told.includes(note) && heard.since < save.attempts) return { note, line };
  }
  return null;
}

export function tell(save, speaker, note) {
  save.told[speaker] = [...(save.told[speaker] ?? []), note];
}

/** Linda's card: which copy the LaserJet is on this attempt (it only ever gets to 400 once). */
export function lindaCopy(script, save) {
  const copies = script.linda.copies;
  if (save.known.lindaDone) return copies[(Math.max(1, save.attempts) - 1) % (copies.length - 1)];
  return copies[Math.min(Math.max(1, save.attempts), copies.length) - 1];
}

export function lindaJob(script, save) {
  return save.known.lindaDone ? script.linda.nextJob : script.linda.job;
}

/** The kind of file a name is: pdf, doc, sheet, text, image, exe, or other. */
export function kindOf(script, name) {
  const ext = extOf(name);
  for (const [kind, list] of Object.entries(script.kinds)) if (list.includes(ext)) return kind;
  return 'other';
}

export function extOf(name) {
  const m = /(\.[^./\\]+)$/.exec(String(name));
  return m ? m[1].toLowerCase() : '';
}

/** What the Photo Printer has to say about a picture: its name, its colours, its size. */
export function roastLines(script, facts, g) {
  const r = script.roasts;
  const out = [];
  const byName = r.names.find(rule => new RegExp(rule.match, rule.flags ?? '').test(facts.name));
  if (byName) out.push(byName.line);
  if (facts.colour && r.colours[facts.colour]) out.push(r.colours[facts.colour]);
  if (facts.width && facts.height) {
    const longest = Math.max(facts.width, facts.height);
    if (longest < r.thumbnail.under) out.push(r.thumbnail.line);
    else if (longest > r.huge.over) out.push(r.huge.line);
  }
  if (out.length < 3 && Number.isFinite(facts.size)) {
    if (facts.size < r.small.under) out.push(r.small.line);
    else if (facts.size > r.large.over) out.push(r.large.line);
  }
  const about = { file: facts.name, dims: facts.width ? `${facts.width} × ${facts.height}` : '', size: formatSize(facts.size) };
  return out.slice(0, 3).map(line => fill(line, g, about));
}

// ---- Endings ---------------------------------------------------------------------------------------------------

export function endingOf(script, id) {
  const ending = script.endings.find(e => e.id === id);
  if (!ending) throw new Error(`No ending called "${id}"`);
  return ending;
}

/** Records an ending. Returns true the first time it is found. */
export function unlock(save, id, when) {
  const had = save.endings[id];
  save.endings[id] = { first: had?.first ?? when, count: (had?.count ?? 0) + 1 };
  return !had;
}

export function foundCount(script, save) {
  return script.endings.filter(e => save.endings[e.id]).length;
}

/** The Extended Warranty pops up at a bad moment on every second attempt (never the first), once a run. */
export function warrantyDue(save, run) {
  return !!run && !run.warrantyShown && save.attempts >= 2 && save.attempts % 2 === 0;
}

/** Which Shakespeare to flash: faster claims get longer works. */
export function workFor(script, seconds) {
  return script.tos.works.find(w => seconds >= w.minSeconds) ?? script.tos.works[script.tos.works.length - 1];
}

// ---- Words and numbers ------------------------------------------------------------------------------------------

export function formatNumber(n) {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Seconds to one decimal place, without a trailing ".0" ("2", "3.2"). */
export function formatSeconds(s) {
  const one = Math.round(s * 10) / 10;
  return Number.isInteger(one) ? String(one) : one.toFixed(1);
}

export function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * When the Photo Printer thinks a pixel-by-pixel print will finish: 12,000,000 pixels take etaYears (4.5) years, so
 * a print started in September 2026 finishes in March 2031. Bigger pictures take longer.
 */
export function etaFor(now, pixels, props) {
  const perPixel = (props.etaYears * 365.25 * 86400000) / (props.report[0] * props.report[1]);
  const done = new Date(now.getTime() + pixels * perPixel);
  return `${MONTHS[done.getMonth()]} ${done.getFullYear()}`;
}

/** The {words} a line can use, worked out from the game as it stands. */
export function varsOf(g) {
  const { script, save, run, env } = g;
  const file = run?.file ?? {};
  const now = env?.now ?? new Date();
  const copy = lindaCopy(script, save);
  const pixels = file.pixels ?? script.props.pixels.report[0] * script.props.pixels.report[1];
  const printers = Object.values(script.speakers).filter(s => s.printer).length;
  const ext = file.ext || '(no extension)';
  return {
    file: file.name ?? '',
    FILE: String(file.name ?? '').toUpperCase(),
    ext,
    EXT: ext.replace(/^\./, '').toUpperCase(),
    copy: String(copy),
    copyLater: String(Math.min(copy + 1, script.linda.of)),
    job: lindaJob(script, save),
    attempts: String(save.attempts),
    year: String(now.getFullYear()),
    queueYear: String(now.getFullYear() + 14),
    eta: etaFor(now, pixels, script.props.pixels),
    pixels: formatNumber(pixels),
    device: env?.device ?? 'laptop',
    price: script.warranty.price,
    covers: script.warranty.covers,
    printers: String(printers),
    words: run?.tos ? formatNumber(run.tos.words) : '',
    seconds: run?.tos ? formatSeconds(run.tos.seconds) : '',
    dims: file.width ? `${file.width} × ${file.height}` : '',
    size: formatSize(file.size),
  };
}

/** A line with its {words} filled in. Unknown ones are left as they are, so a typo shows. */
export function fill(text, g, extra = {}) {
  const vars = { ...varsOf(g), ...extra };
  return String(text).replace(/\{([a-zA-Z]+)\}/g, (whole, key) => (key in vars ? vars[key] : whole));
}
