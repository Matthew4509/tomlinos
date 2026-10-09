// Planetziods: the rules. A galaxy of planets on a grid; each makes ships every turn; players send fleets to capture
// them; a fleet takes longer the farther it goes; a battle is decided ship by ship by each side's strength. The game
// ends when one player owns every planet that anyone owns (or at the turn limit: most planets, then most ships).
// Everything random comes from a seeded generator, so a game can be replayed exactly (and tested).
//
// Two rule sets. CLASSIC is the game above, unchanged. TRADE & TRUST adds: iron and energy (a ship takes one of each,
// so a planet builds as many ships as its scarcer resource allows); trade routes between two players' worlds; what
// each computer player thinks of everyone (trust.ts); alliances; ships stationed on an ally's planet to defend it;
// and team victory. A classic game carries none of the new fields, so old saves and replays do not move.
import { PERSONAS, TEMPERS, attacked, drift, hostile, lower, newTrust, raise, rejected, type Persona } from './trust.ts';

export type Rules = 'classic' | 'trade';
export type Resource = 'iron' | 'energy';
export const other = (r: Resource): Resource => (r === 'iron' ? 'energy' : 'iron');

export interface Player {
  id: number;
  name: string;
  /** null = a person at this computer. */
  ai: 'easy' | 'normal' | 'hard' | null;
  out: boolean;
  /** Trade & Trust: how a computer player treats others. */
  persona?: Persona;
}

export interface Planet {
  id: number;
  name: string;
  x: number;
  y: number;
  /** -1 = nobody's. */
  owner: number;
  ships: number;
  production: number;
  /** 0.30 to 0.90: the chance, each exchange, that this planet's side hits. */
  strength: number;
  /** Trade & Trust: what the planet mines each turn. `production` is then the ships it builds, after trade. */
  iron?: number;
  energy?: number;
  /** Trade & Trust: other players' ships stationed here to defend it (they stay theirs). */
  guests?: Array<{ owner: number; ships: number }>;
}

export interface Fleet {
  owner: number;
  from: number;
  to: number;
  ships: number;
  strength: number;
  arrives: number;
  /** Trade & Trust: sent to attack or to defend; `sneak` = aimed at an ally's planet when sent; `guest` = left from a guest stack. */
  mode?: 'attack' | 'defend';
  sneak?: boolean;
  guest?: boolean;
}

/** Planet `a` sends `amount` of `res` to planet `b` every turn; `b` sends the same amount of the other resource back. */
export interface Route {
  a: number;
  b: number;
  res: Resource;
  amount: number;
}

/** Something a computer player asks a person; answered before End turn, or it counts as a no. */
export interface Offer {
  id: number;
  kind: 'trade' | 'alliance';
  from: number;
  to: number;
  route?: Route;
}

export interface Report {
  turn: number;
  text: string;
  /** Who the line matters to (-1 = everyone). */
  player: number;
}

export interface Game {
  seed: number;
  rng: number;
  width: number;
  height: number;
  turn: number;
  maxTurns: number;
  /** Planets nobody owns also make ships. */
  neutralProduction: boolean;
  players: Player[];
  planets: Planet[];
  fleets: Fleet[];
  /** Orders given this turn, not yet flown (ships already taken off their planet). */
  reports: Report[];
  winner: number | null;
  over: boolean;
  /** Absent = classic. The rest below exist only in a Trade & Trust game. */
  rules?: 'trade';
  routes?: Route[];
  offers?: Offer[];
  nextOffer?: number;
  opinion?: number[][];
  grudge?: number[][];
  lastHit?: number[][];
  /** Team number per player, -1 = on their own. */
  teams?: number[];
  /** Everyone on the winning side (a team, or one player). */
  winners?: number[];
  /** "host,guest" -> the turn the host was last thanked for a defence (once every 5 turns). */
  thanked?: Record<string, number>;
}

export const NAMES = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.split('');

/** Mulberry32: small, fast, good enough for a game, and the same on every machine. */
export function random(g: Game): number {
  g.rng = (g.rng + 0x6d2b79f5) >>> 0;
  let t = g.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const between = (g: Game, lo: number, hi: number) => lo + Math.floor(random(g) * (hi - lo + 1));

export interface Setup {
  seed?: number;
  people: string[];
  computers: Array<{ name: string; level: 'easy' | 'normal' | 'hard' }>;
  neutral: number;
  width?: number;
  height?: number;
  maxTurns?: number;
  neutralProduction?: boolean;
  rules?: Rules;
}

export function newGame(s: Setup): Game {
  const seed = (s.seed ?? Math.floor(Math.random() * 2 ** 31)) >>> 0;
  const players: Player[] = [
    ...s.people.map((name, i) => ({ id: i, name, ai: null, out: false })),
    ...s.computers.map((c, i) => ({ id: s.people.length + i, name: c.name, ai: c.level, out: false })),
  ];
  if (players.length < 2) throw new Error('A game needs at least two players.');
  const count = players.length + Math.max(0, Math.min(40, s.neutral));
  const width = s.width ?? 16;
  const height = s.height ?? 12;
  if (count > NAMES.length || count > width * height / 3) throw new Error('Too many planets for the map.');
  const g: Game = {
    seed, rng: seed, width, height, turn: 1, maxTurns: s.maxTurns ?? 0, neutralProduction: s.neutralProduction ?? false,
    players, planets: [], fleets: [], reports: [], winner: null, over: false,
  };
  const taken = new Set<string>();
  // Home planets are spread out: each is placed as far as it can be from the others (best of 30 tries).
  const place = (far: boolean): [number, number] => {
    let best: [number, number] = [0, 0];
    let bestD = -1;
    for (let t = 0; t < (far ? 30 : 200); t++) {
      const x = between(g, 0, width - 1);
      const y = between(g, 0, height - 1);
      if (taken.has(`${x},${y}`)) continue;
      const d = far ? Math.min(99, ...g.planets.filter(p => p.owner >= 0).map(p => Math.hypot(p.x - x, p.y - y))) : 0;
      if (d > bestD) {
        best = [x, y];
        bestD = d;
      }
      if (!far) break;
    }
    taken.add(`${best[0]},${best[1]}`);
    return best;
  };
  for (const p of players) {
    const [x, y] = place(true);
    g.planets.push({ id: g.planets.length, name: NAMES[g.planets.length], x, y, owner: p.id, ships: 10, production: 10, strength: 0.5 });
  }
  for (let i = 0; i < count - players.length; i++) {
    const [x, y] = place(false);
    g.planets.push({ id: g.planets.length, name: NAMES[g.planets.length], x, y, owner: -1, ships: between(g, 1, 12), production: between(g, 3, 15), strength: 0.3 + between(g, 0, 60) / 100 });
  }
  if (s.rules === 'trade') setUpTrade(g);
  return g;
}

/** Turns a fleet takes between two planets: two grid squares a turn (rounded up), at least one. */
export function travel(a: Planet, b: Planet): number {
  return Math.max(1, Math.ceil(Math.hypot(a.x - b.x, a.y - b.y) / 2));
}

/** Why an order cannot be given, or null. Ships can leave your own planet, or (Trade & Trust) another player's planet where you have ships stationed. */
export function orderProblem(g: Game, player: number, from: number, to: number, ships: number, mode: 'attack' | 'defend' = 'attack'): string | null {
  const a = g.planets[from];
  const b = g.planets[to];
  if (!a || !b) return 'Choose a planet to send from and one to send to.';
  const stationed = a.owner === player ? 0 : guestsOf(a, player);
  if (a.owner !== player && !stationed) return `Planet ${a.name} is not yours.`;
  if (from === to) return 'Choose a different planet to send to.';
  if (!Number.isInteger(ships) || ships < 1) return 'Send at least one ship.';
  if (stationed && ships > stationed) return `You have only ${shipsText(stationed)} at ${a.name}.`;
  if (!stationed && ships > a.ships) return `Planet ${a.name} has only ${shipsText(a.ships)}.`;
  if (mode === 'defend' && !canDefend(g, player, to)) return 'You can defend only the planets of your allies and trading partners.';
  return null;
}

/** Sends ships now (they leave their planet at once, and arrive at the end of a later turn). */
export function send(g: Game, player: number, from: number, to: number, ships: number, mode: 'attack' | 'defend' = 'attack'): Fleet {
  const problem = orderProblem(g, player, from, to, ships, mode);
  if (problem) throw new Error(problem);
  const a = g.planets[from];
  const stationed = a.owner !== player;
  if (stationed) takeGuests(a, player, ships);
  else a.ships -= ships;
  const f: Fleet = { owner: player, from, to, ships, strength: a.strength, arrives: g.turn + travel(a, g.planets[to]) };
  if (g.rules === 'trade') {
    f.mode = mode;
    // Aimed at an ally's planet on purpose: a sneak attack (the screen asks first). Judged again when it lands.
    if (mode === 'attack' && allied(g, player, g.planets[to].owner)) f.sneak = true;
    if (stationed) f.guest = true;
  }
  g.fleets.push(f);
  return f;
}

/** Takes back an order given this turn: the ships return to where they left. */
export function unsend(g: Game, f: Fleet): void {
  if (!g.fleets.includes(f)) return;
  g.fleets = g.fleets.filter(x => x !== f);
  if (f.guest) addGuests(g.planets[f.from], f.owner, f.ships);
  else g.planets[f.from].ships += f.ships;
}

/** One battle, ship against ship. Returns the ships left on the winning side and who won. */
export function battle(g: Game, attack: { ships: number; strength: number }, defend: { ships: number; strength: number }): { attackerWins: boolean; left: number } {
  let a = attack.ships;
  let d = defend.ships;
  while (a > 0 && d > 0) {
    // Each exchange, the side whose roll beats the other's strength loses a ship.
    const aHits = random(g) < attack.strength;
    const dHits = random(g) < defend.strength;
    if (aHits && !dHits) d--;
    else if (dHits && !aHits) a--;
  }
  return a > 0 ? { attackerWins: true, left: a } : { attackerWins: false, left: d };
}

const nameOf = (g: Game, owner: number) => (owner < 0 ? 'nobody' : g.players[owner]?.name ?? '?');
const shipsText = (n: number) => `${n} ship${n === 1 ? '' : 's'}`;

/** Ends the turn for everyone: fleets due now arrive (in the order sent), then planets make ships, then the next turn. */
export function endTurn(g: Game): Report[] {
  if (g.over) return [];
  const reports: Report[] = [];
  const say = (text: string, player = -1) => reports.push({ turn: g.turn, text, player });
  const trade = g.rules === 'trade';
  if (trade) lapseOffers(g, say);
  const arriving = g.fleets.filter(f => f.arrives <= g.turn);
  g.fleets = g.fleets.filter(f => f.arrives > g.turn);
  for (const f of arriving) {
    if (trade) {
      arriveTrade(g, f, say);
      continue;
    }
    const p = g.planets[f.to];
    if (p.owner === f.owner) {
      p.ships += f.ships;
      say(`${f.ships} ship${f.ships === 1 ? '' : 's'} reinforced ${p.name}.`, f.owner);
      continue;
    }
    const defender = p.owner;
    const r = battle(g, f, { ships: p.ships, strength: p.strength });
    if (r.attackerWins) {
      p.owner = f.owner;
      p.ships = r.left;
      say(`${nameOf(g, f.owner)} captured ${p.name} from ${nameOf(g, defender)} (${r.left} ship${r.left === 1 ? '' : 's'} left).`);
    } else {
      p.ships = r.left;
      say(`${p.name} held against ${nameOf(g, f.owner)} (${nameOf(g, defender)} kept ${r.left}).`);
    }
  }
  for (const p of g.planets) if (p.owner >= 0 || g.neutralProduction) p.ships += p.owner >= 0 ? p.production : Math.ceil(p.production / 3);
  // A player with no planets and no fleets is out.
  for (const pl of g.players) {
    if (pl.out) continue;
    if (!g.planets.some(p => p.owner === pl.id || guestsOf(p, pl.id)) && !g.fleets.some(f => f.owner === pl.id)) {
      pl.out = true;
      say(`${pl.name} has lost every planet and is out of the game.`);
    }
  }
  const left = g.players.filter(p => !p.out);
  if (trade) {
    diplomacy(g, say);
    teamVictory(g, say);
  } else if (left.length === 1) {
    g.over = true;
    g.winner = left[0].id;
    say(`${left[0].name} rules the galaxy!`);
  } else if (g.maxTurns && g.turn >= g.maxTurns) {
    g.over = true;
    const score = (id: number) => [g.planets.filter(p => p.owner === id).length, g.planets.filter(p => p.owner === id).reduce((n, p) => n + p.ships, 0)];
    const best = [...left].sort((a, b) => {
      const [pa, sa] = score(a.id);
      const [pb, sb] = score(b.id);
      return pb - pa || sb - sa;
    })[0];
    g.winner = best.id;
    say(`Turn limit reached. ${best.name} has the most planets and wins.`);
  }
  g.turn++;
  g.reports.push(...reports);
  if (g.reports.length > 400) g.reports.splice(0, g.reports.length - 400);
  return reports;
}

/** Totals for the score table. */
export function standings(g: Game): Array<{ player: Player; planets: number; ships: number; production: number }> {
  return g.players.map(player => {
    const mine = g.planets.filter(p => p.owner === player.id);
    return {
      player,
      planets: mine.length,
      ships: mine.reduce((n, p) => n + p.ships, 0) + g.fleets.filter(f => f.owner === player.id).reduce((n, f) => n + f.ships, 0),
      production: mine.reduce((n, p) => n + p.production, 0),
    };
  });
}

// ---- Computer players --------------------------------------------------------------------------------------------

/**
 * The computer's orders for this turn. Easy is timid and forgetful. Normal attacks from each planet, counts what is
 * already on its way, and moves idle ships to the front. Hard also gathers ships from several planets for one strike.
 */
export function computerMoves(g: Game, player: number): void {
  const me = g.players[player];
  if (!me || me.out || !me.ai) return;
  const level = me.ai;
  const mine = g.planets.filter(p => p.owner === player);
  if (!mine.length) return;
  // What each planet keeps at home, and how much stronger an attack must be than what it expects to meet.
  const keep = level === 'easy' ? 0.5 : level === 'normal' ? 0.25 : 0.1;
  const margin = level === 'easy' ? 2.2 : level === 'normal' ? 1.5 : 1.25;
  const spare = new Map(mine.map(p => [p.id, Math.floor(p.ships * (1 - keep))]));
  const onWay = (to: number) => g.fleets.filter(f => f.owner === player && f.to === to).reduce((n, f) => n + f.ships, 0);
  const trade = g.rules === 'trade';
  /** Ships needed to take `p` with a fleet that flies `turns` turns from a planet of strength `s`. */
  const needFor = (p: Planet, turns: number, s: number) => {
    const expect = p.ships + (trade ? stationedAt(p) : 0) + (p.owner >= 0 ? p.production * turns : Math.ceil(p.production / 3) * turns);
    return Math.ceil(expect * margin * (p.strength / Math.max(0.3, s))) + 1;
  };
  // Trade & Trust: nobody's planets, and the planets of players it is hostile to; never an ally's.
  const targets = () => g.planets.filter(p => p.owner !== player && (!trade || p.owner < 0 || (!allied(g, player, p.owner) && hostile(trustOf(g), personas(g), player, p.owner))));

  if (level === 'hard') {
    // Pick the best target from anywhere, then gather ships from the nearest planets until there are enough.
    const ranked = targets().map(p => {
      const near = [...mine].sort((a, b) => travel(a, p) - travel(b, p));
      return { p, near, value: (p.production + (p.owner >= 0 ? 6 : 1)) / (travel(near[0], p) + p.ships / 6) };
    }).sort((a, b) => b.value - a.value);
    for (const t of ranked.slice(0, 3)) {
      if (onWay(t.p.id) > 0) continue;
      const use: Planet[] = [];
      let have = 0;
      let need = Infinity;
      for (const src of t.near) {
        if ((spare.get(src.id) ?? 0) < 1) continue;
        use.push(src);
        have += spare.get(src.id)!;
        need = needFor(t.p, Math.max(...use.map(u => travel(u, t.p))), Math.min(...use.map(u => u.strength)));
        if (have >= need) break;
      }
      if (have < need || !use.length) continue;
      let left = need;
      for (const src of use) {
        const n = Math.min(left, spare.get(src.id)!);
        if (n < 1) continue;
        send(g, player, src.id, t.p.id, n);
        spare.set(src.id, spare.get(src.id)! - n);
        left -= n;
      }
    }
  }

  for (const home of mine) {
    if (level === 'easy' && random(g) < 0.4) continue;
    let free = spare.get(home.id) ?? 0;
    if (free < 3) continue;
    const options = targets()
      .map(p => {
        const turns = travel(home, p);
        const need = needFor(p, turns, home.strength) - (level === 'easy' ? 0 : onWay(p.id));
        return { p, need, value: (p.production + 1) / (turns + p.ships / 5) };
      })
      .filter(t => t.need > 0 && t.need <= free)
      .sort((a, b) => b.value - a.value);
    for (const t of options.slice(0, level === 'easy' ? 1 : 2)) {
      if (t.need > free) continue;
      send(g, player, home.id, t.p.id, t.need);
      free -= t.need;
    }
    spare.set(home.id, free);
  }

  if (trade && level !== 'easy') defendFriends(g, player, mine, spare);

  // Normal and hard move ships that found nothing to do towards the front: the planet of theirs nearest an enemy.
  if (level !== 'easy' && mine.length > 1) {
    const enemies = targets().filter(p => p.owner >= 0);
    if (!enemies.length) return;
    const distToEnemy = (p: Planet) => Math.min(...enemies.map(e => travel(p, e)));
    const front = [...mine].sort((a, b) => distToEnemy(a) - distToEnemy(b))[0];
    for (const home of mine) {
      const free = spare.get(home.id) ?? 0;
      if (home === front || free < 8 || distToEnemy(home) <= distToEnemy(front) + 1) continue;
      send(g, player, home.id, front.id, free);
    }
  }
}

/** Reads a saved game back; anything that does not fit the shape is refused. */
export function loadGame(text: string): Game {
  const g = JSON.parse(text) as Game;
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  if (!g || !Array.isArray(g.planets) || !Array.isArray(g.players) || !Array.isArray(g.fleets) || !num(g.turn) || !num(g.rng)) throw new Error('This is not a Planetziods game.');
  for (const p of g.planets) if (!num(p.x) || !num(p.y) || !num(p.ships) || !num(p.owner) || !num(p.production) || !num(p.strength)) throw new Error('This game file is damaged.');
  for (const f of g.fleets) if (!num(f.ships) || !num(f.arrives) || !g.planets[f.to] || !g.planets[f.from]) throw new Error('This game file is damaged.');
  if (g.rules !== undefined) checkTradeSave(g, num);
  g.reports = Array.isArray(g.reports) ? g.reports.slice(-400) : [];
  return g;
}

// ---- Trade & Trust ----------------------------------------------------------------------------------------------

const personas = (g: Game) => g.players.map(p => p.persona ?? null);
const trustOf = (g: Game) => ({ opinion: g.opinion!, grudge: g.grudge!, lastHit: g.lastHit! });

/** Resources, personalities, opinions. Runs after the classic galaxy is made, so the map is the same for a seed. */
function setUpTrade(g: Game): void {
  g.rules = 'trade';
  for (const p of g.planets) {
    if (p.owner >= 0) {
      // Every home world mines 24 in all, split differently: 6 to 12 ships a turn alone, 12 when it trades well.
      p.iron = between(g, 6, 18);
      p.energy = 24 - p.iron;
    } else {
      // Lopsided on purpose: one resource short, so trade matters.
      const total = p.production * 2 + between(g, 0, 4);
      p.iron = Math.round(total * (0.2 + random(g) * 0.6));
      p.energy = total - p.iron;
    }
  }
  const pool: Persona[] = [];
  for (const pl of g.players) {
    if (!pl.ai) continue;
    if (!pool.length) pool.push(...PERSONAS);
    pl.persona = pool.splice(Math.floor(random(g) * pool.length), 1)[0];
  }
  const t = newTrust(personas(g));
  g.opinion = t.opinion;
  g.grudge = t.grudge;
  g.lastHit = t.lastHit;
  g.routes = [];
  g.offers = [];
  g.nextOffer = 1;
  g.teams = g.players.map(() => -1);
  g.thanked = {};
  recalc(g);
}

/** What a planet has each turn after its trade route: iron and energy. */
export function mined(g: Game, p: Planet): { iron: number; energy: number } {
  const m = { iron: p.iron ?? 0, energy: p.energy ?? 0 };
  for (const r of g.routes ?? []) {
    if (r.a === p.id) {
      m[r.res] -= r.amount;
      m[other(r.res)] += r.amount;
    } else if (r.b === p.id) {
      m[r.res] += r.amount;
      m[other(r.res)] -= r.amount;
    }
  }
  return m;
}

/** A ship takes 1 iron and 1 energy: a planet builds as many as its scarcer resource allows. */
function recalc(g: Game): void {
  for (const p of g.planets) {
    const m = mined(g, p);
    p.production = Math.max(0, Math.min(m.iron, m.energy));
  }
}

export const allied = (g: Game, a: number, b: number): boolean => a !== b && a >= 0 && b >= 0 && !!g.teams && g.teams[a] >= 0 && g.teams[a] === g.teams[b];
export const trading = (g: Game, a: number, b: number): boolean =>
  !!g.routes?.some(r => {
    const x = g.planets[r.a].owner;
    const y = g.planets[r.b].owner;
    return (x === a && y === b) || (x === b && y === a);
  });
export const routeOf = (g: Game, planet: number): Route | undefined => g.routes?.find(r => r.a === planet || r.b === planet);
export const guestsOf = (p: Planet, owner: number): number => p.guests?.find(x => x.owner === owner)?.ships ?? 0;
const stationedAt = (p: Planet) => (p.guests ?? []).reduce((n, x) => n + x.ships, 0);

function addGuests(p: Planet, owner: number, n: number): void {
  if (n <= 0) return;
  p.guests ??= [];
  const stack = p.guests.find(x => x.owner === owner);
  if (stack) stack.ships += n;
  else p.guests.push({ owner, ships: n });
}

function takeGuests(p: Planet, owner: number, n: number): void {
  const stack = p.guests?.find(x => x.owner === owner);
  if (!stack) return;
  stack.ships -= n;
  if (stack.ships <= 0) p.guests = p.guests!.filter(x => x !== stack);
  if (!p.guests?.length) delete p.guests;
}

/** What the pair think of each other: the lower of the computers' opinions (a person's opinion is not kept). */
export function regard(g: Game, a: number, b: number): number {
  if (!g.opinion) return 5;
  const seen: number[] = [];
  if (g.players[a]?.persona) seen.push(g.opinion[a][b]);
  if (g.players[b]?.persona) seen.push(g.opinion[b][a]);
  return seen.length ? Math.min(...seen) : 5;
}

/** A planet you may send ships to defend: an ally's, or a trading partner's. */
export function canDefend(g: Game, player: number, planet: number): boolean {
  const owner = g.planets[planet]?.owner ?? -1;
  return g.rules === 'trade' && owner >= 0 && owner !== player && (allied(g, player, owner) || trading(g, player, owner));
}

// ---- Teams ----

/** An alliance holds at most half the players, rounded up (6 players: 3), so the map can split but not all join one side. */
export const teamCap = (g: Game): number => Math.ceil(g.players.length / 2);
export const teamOf = (g: Game, id: number): number => g.teams?.[id] ?? -1;
/** Everyone on this player's side (the player alone when not in an alliance). */
export function side(g: Game, id: number): number[] {
  const t = teamOf(g, id);
  return t < 0 ? [id] : g.players.filter(p => g.teams![p.id] === t).map(p => p.id);
}

/** Why `a` and `b` cannot become allies, or null. */
export function allianceProblem(g: Game, a: number, b: number): string | null {
  const [pa, pb] = [g.players[a], g.players[b]];
  if (!pa || !pb || a === b || pa.out || pb.out) return 'That alliance is not possible.';
  if (allied(g, a, b)) return `${pa.name} and ${pb.name} are already allies.`;
  if (teamOf(g, a) >= 0 && teamOf(g, b) >= 0) return `${pa.name} and ${pb.name} are each in another alliance.`;
  if (side(g, a).length + side(g, b).length > teamCap(g)) return `An alliance can hold at most ${teamCap(g)} of the ${g.players.length} players.`;
  return null;
}

function ally(g: Game, a: number, b: number, say: (text: string, player?: number) => void): void {
  const t = teamOf(g, a) >= 0 ? teamOf(g, a) : teamOf(g, b) >= 0 ? teamOf(g, b) : Math.max(-1, ...g.teams!) + 1;
  g.teams![a] = t;
  g.teams![b] = t;
  const names = side(g, a).map(id => g.players[id].name);
  say(`${g.players[a].name} and ${g.players[b].name} are now allies${names.length > 2 ? ` (the alliance: ${names.join(', ')})` : ''}.`);
}

function leaveTeam(g: Game, id: number): void {
  const t = teamOf(g, id);
  if (t < 0) return;
  g.teams![id] = -1;
  const rest = g.players.filter(p => g.teams![p.id] === t);
  if (rest.length === 1) g.teams![rest[0].id] = -1;
}

// ---- Trade routes ----

/** The even swap between two planets that adds the most ships a turn, with BOTH planets building more. Null if none helps both. */
export function bestSwap(g: Game, a: number, b: number): { route: Route; gainA: number; gainB: number } | null {
  const ma = mined(g, g.planets[a]);
  const mb = mined(g, g.planets[b]);
  const before = [Math.min(ma.iron, ma.energy), Math.min(mb.iron, mb.energy)];
  let best: { route: Route; gainA: number; gainB: number } | null = null;
  for (const res of ['iron', 'energy'] as Resource[]) {
    const back = other(res);
    for (let k = 1; k <= Math.min(ma[res], mb[back]); k++) {
      const gainA = Math.min(ma[res] - k, ma[back] + k) - before[0];
      const gainB = Math.min(mb[res] + k, mb[back] - k) - before[1];
      if (gainA < 1 || gainB < 1) continue;
      if (!best || gainA + gainB > best.gainA + best.gainB) best = { route: { a, b, res, amount: k }, gainA, gainB };
    }
  }
  return best;
}

/** Why this route cannot open, or null. */
export function routeProblem(g: Game, r: Route): string | null {
  const [pa, pb] = [g.planets[r.a], g.planets[r.b]];
  if (!pa || !pb) return 'Choose two planets.';
  if (pa.owner < 0 || pb.owner < 0) return 'Only players’ planets can trade.';
  if (pa.owner === pb.owner) return 'A player cannot trade between their own planets.';
  if (routeOf(g, r.a) || routeOf(g, r.b)) return 'Each planet keeps one trade route at a time.';
  if (!Number.isInteger(r.amount) || r.amount < 1 || (pa[r.res] ?? 0) < r.amount || (pb[other(r.res)] ?? 0) < r.amount) return 'That trade asks for more than the planets mine.';
  return null;
}

export function routeText(g: Game, r: Route): string {
  const [pa, pb] = [g.planets[r.a], g.planets[r.b]];
  return `${pa.name} (${nameOf(g, pa.owner)}) sends ${r.amount} ${r.res} to ${pb.name} (${nameOf(g, pb.owner)}) for ${r.amount} ${other(r.res)}`;
}

function openRoute(g: Game, r: Route, say: (text: string, player?: number) => void): void {
  g.routes!.push(r);
  recalc(g);
  say(`New trade route: ${routeText(g, r)}, every turn.`);
}

function endRoute(g: Game, r: Route, why: string, say: (text: string, player?: number) => void): void {
  g.routes = g.routes!.filter(x => x !== r);
  recalc(g);
  say(`Trade between ${g.planets[r.a].name} and ${g.planets[r.b].name} ended: ${why}.`);
}

/** Routes whose worlds changed hands, or whose owners no longer trust each other (below 4), end. */
function checkRoutes(g: Game, say: (text: string, player?: number) => void): void {
  for (const r of [...g.routes!]) {
    const [x, y] = [g.planets[r.a].owner, g.planets[r.b].owner];
    if (x < 0 || y < 0 || x === y) endRoute(g, r, 'a world changed hands', say);
    else if (regard(g, x, y) < 4) endRoute(g, r, `${nameOf(g, x)} and ${nameOf(g, y)} no longer trust each other`, say);
  }
}

// ---- What a person can do on their turn ----

const note = (g: Game) => (text: string, player = -1) => g.reports.push({ turn: g.turn, text, player });

/** A person asks a computer player to trade: the best even swap between the two planets, if the computer is willing. */
export function proposeTrade(g: Game, player: number, mine: number, theirs: number): { ok: boolean; text: string } {
  const [pm, pt] = [g.planets[mine], g.planets[theirs]];
  if (g.rules !== 'trade' || !pm || !pt) return { ok: false, text: 'Trading is part of the Trade & Trust rules.' };
  if (pm.owner !== player) return { ok: false, text: `Planet ${pm.name} is not yours.` };
  const bot = pt.owner;
  if (bot < 0 || bot === player) return { ok: false, text: 'Choose another player’s planet to trade with.' };
  if (routeOf(g, mine)) return { ok: false, text: `${pm.name} already has a trade route. Each planet keeps one.` };
  if (routeOf(g, theirs)) return { ok: false, text: `${pt.name} already has a trade route. Each planet keeps one.` };
  const swap = bestSwap(g, mine, theirs);
  if (!swap) return { ok: false, text: `No even swap helps both ${pm.name} and ${pt.name}: they are short of the same thing, or one has nothing spare.` };
  const them = g.players[bot];
  if (them.persona && g.opinion![bot][player] < TEMPERS[them.persona].tradeAt) {
    return { ok: false, text: `${them.name} will not trade with you yet: they think ${g.opinion![bot][player]} of you and trade at ${TEMPERS[them.persona].tradeAt} or more.` };
  }
  openRoute(g, swap.route, note(g));
  return { ok: true, text: `${them.name} agreed. ${pm.name} now builds ${pm.production} a turn (+${swap.gainA}); ${pt.name} builds ${pt.production} (+${swap.gainB}).` };
}

/** A person asks a computer player to be allies. */
export function proposeAlliance(g: Game, player: number, bot: number): { ok: boolean; text: string } {
  const problem = allianceProblem(g, player, bot);
  if (problem) return { ok: false, text: problem };
  const them = g.players[bot];
  const op = g.opinion![bot][player];
  if (them.persona && op < 7) return { ok: false, text: `${them.name} thinks ${op} of you; alliances need 7 or more. Trade with them, or defend their planets.` };
  ally(g, player, bot, note(g));
  return { ok: true, text: `${them.name} accepted. You are allies: your attacks on others no longer worry them, and your fleets defend each other.` };
}

export function acceptOffer(g: Game, id: number): { ok: boolean; text: string } {
  const o = g.offers?.find(x => x.id === id);
  if (!o) return { ok: false, text: 'That offer has gone.' };
  g.offers = g.offers!.filter(x => x !== o);
  if (o.kind === 'alliance') {
    const problem = allianceProblem(g, o.from, o.to);
    if (problem) return { ok: false, text: problem };
    ally(g, o.from, o.to, note(g));
    return { ok: true, text: `You and ${g.players[o.from].name} are allies.` };
  }
  const problem = routeProblem(g, o.route!);
  if (problem) return { ok: false, text: `That trade is no longer possible. ${problem}` };
  openRoute(g, o.route!, note(g));
  return { ok: true, text: `Trade agreed: ${routeText(g, o.route!)}.` };
}

/** Turning an offer down costs 1 point of their opinion, never below neutral (5). */
export function rejectOffer(g: Game, id: number): void {
  const o = g.offers?.find(x => x.id === id);
  if (!o) return;
  g.offers = g.offers!.filter(x => x !== o);
  if (g.players[o.from].persona) rejected(trustOf(g), o.from, o.to);
}

/** A person ends a trade route: the partner takes it like a refused offer. */
export function cancelRoute(g: Game, player: number, planet: number): void {
  const r = routeOf(g, planet);
  if (!r) return;
  const partner = g.planets[r.a].owner === player ? g.planets[r.b].owner : g.planets[r.a].owner;
  if (partner >= 0 && g.players[partner].persona) rejected(trustOf(g), partner, player);
  endRoute(g, r, `${nameOf(g, player)} cancelled it`, note(g));
}

/** Offers not answered by End turn count as a no. */
function lapseOffers(g: Game, say: (text: string, player?: number) => void): void {
  const left = g.offers ?? [];
  for (const o of left) if (g.players[o.from].persona) rejected(trustOf(g), o.from, o.to);
  if (left.length) say(`${left.length === 1 ? 'An offer' : `${left.length} offers`} went unanswered and counted as a no.`, left[0].to);
  g.offers = [];
}

// ---- Fleets landing ----

function arriveTrade(g: Game, f: Fleet, say: (text: string, player?: number) => void): void {
  const p = g.planets[f.to];
  if (p.owner === f.owner) {
    p.ships += f.ships;
    say(`${shipsText(f.ships)} reinforced ${p.name}.`, f.owner);
    return;
  }
  const host = p.owner;
  const ally_ = allied(g, f.owner, host);
  // Sent to defend a friend who is still a friend: the ships stay there, still yours, and defend it.
  if (f.mode === 'defend' && (ally_ || trading(g, f.owner, host))) {
    addGuests(p, f.owner, f.ships);
    say(`${shipsText(f.ships)} of ${nameOf(g, f.owner)} arrived to defend ${p.name} (${nameOf(g, host)}).`);
    thank(g, host, f.owner, f.ships, say);
    return;
  }
  // Sent to attack a planet that became an ally's on the way: an accident, not a betrayal. They join its defence.
  if (ally_ && !f.sneak) {
    addGuests(p, f.owner, f.ships);
    say(`${nameOf(g, f.owner)}'s fleet reached ${p.name}, now an ally's planet, and joined its defence instead of attacking.`);
    return;
  }
  let formerAllies: number[] = [];
  const sneak = ally_ && !!f.sneak;
  if (sneak) formerAllies = betray(g, f.owner, host, say);
  // Your own ships stationed there leave before the fight.
  const mine = guestsOf(p, f.owner);
  if (mine) {
    takeGuests(p, f.owner, mine);
    sendHome(g, p, f.owner, mine);
  }
  const stationed = (p.guests ?? []).map(x => x.owner);
  fight(g, f, p, say);
  // A fleet sent in good faith to defend (whose friend changed sides on the way) costs no reputation.
  if (host >= 0 && f.mode !== 'defend') reputation(g, f.owner, host, p, sneak, formerAllies, stationed, say);
}

/** A battle at a planet: stationed ships fight beside the owner's, and share the losses. */
function fight(g: Game, f: Fleet, p: Planet, say: (text: string, player?: number) => void): void {
  const defender = p.owner;
  const guests = p.guests ?? [];
  const extra = stationedAt(p);
  const r = battle(g, f, { ships: p.ships + extra, strength: p.strength });
  if (r.attackerWins) {
    for (const x of guests) say(`${shipsText(x.ships)} of ${nameOf(g, x.owner)} stationed at ${p.name} were lost.`, x.owner);
    delete p.guests;
    p.owner = f.owner;
    p.ships = r.left;
    say(`${nameOf(g, f.owner)} captured ${p.name} from ${nameOf(g, defender)} (${shipsText(r.left)} left).`);
    const route = routeOf(g, p.id);
    if (route) endRoute(g, route, `${p.name} changed hands`, say);
    return;
  }
  const total = p.ships + extra;
  let given = 0;
  for (const x of guests) {
    x.ships = Math.floor((r.left * x.ships) / total);
    given += x.ships;
  }
  p.guests = guests.filter(x => x.ships > 0);
  if (!p.guests.length) delete p.guests;
  p.ships = r.left - given;
  say(`${p.name} held against ${nameOf(g, f.owner)} (${nameOf(g, defender)} kept ${r.left}${extra ? ', with the ships stationed there' : ''}).`);
}

/**
 * Who saw an attack, and what they think now. The victim (and anyone with ships stationed there) goes to 0.
 * Witnesses: computer players with a planet within 6 squares, or allied or trading with the victim. Each thinks 1 less
 * of the attacker (2 for a sneak attack on an ally; 2 for a Guardian whose friend was hit). The attacker's allies are
 * not worried; they approve if the victim is their enemy too. Enemies of the victim do not mind.
 */
function reputation(g: Game, attacker: number, victim: number, p: Planet, sneak: boolean, formerAllies: number[], stationed: number[], say: (text: string, player?: number) => void): void {
  const t = trustOf(g);
  const ps = personas(g);
  const hit = [victim, ...stationed].filter(id => id !== attacker);
  const witnesses: Array<{ id: number; weight: number }> = [];
  for (const w of g.players) {
    if (!w.persona || w.out || w.id === attacker || hit.includes(w.id)) continue;
    const friend = allied(g, w.id, victim) || trading(g, w.id, victim);
    const near = g.planets.some(q => q.owner === w.id && Math.hypot(q.x - p.x, q.y - p.y) <= 6);
    if (!near && !friend && !formerAllies.includes(w.id)) continue;
    if (allied(g, w.id, attacker)) {
      if (hostile(t, ps, w.id, victim)) witnesses.push({ id: w.id, weight: -1 });
      continue;
    }
    if (hostile(t, ps, w.id, victim)) continue;
    witnesses.push({ id: w.id, weight: sneak || (friend && TEMPERS[w.persona].guards) ? 2 : 1 });
  }
  for (const v of hit) attacked(t, ps, g.turn, attacker, v, v === victim ? witnesses : []);
  if (!g.players[attacker].persona) {
    const seen = witnesses.filter(w => w.weight > 0).map(w => `${g.players[w.id].name} -${w.weight}`);
    const glad = witnesses.filter(w => w.weight < 0).map(w => `${g.players[w.id].name} +1`);
    if (seen.length || glad.length) say(`Seen attacking ${nameOf(g, victim)}: ${[...seen, ...glad].join(', ')}.`, attacker);
  }
}

/** A sneak attack on an ally: the attacker leaves the alliance; stationed ships on both sides go home. Returns the former allies. */
function betray(g: Game, attacker: number, victim: number, say: (text: string, player?: number) => void): number[] {
  const former = side(g, attacker).filter(id => id !== attacker);
  leaveTeam(g, attacker);
  say(`${nameOf(g, attacker)} attacked their ally ${nameOf(g, victim)}! ${nameOf(g, attacker)} is out of the alliance.`);
  for (const p of g.planets) {
    for (const x of [...(p.guests ?? [])]) {
      const theirs = (x.owner === attacker && former.includes(p.owner)) || (former.includes(x.owner) && p.owner === attacker);
      if (!theirs) continue;
      takeGuests(p, x.owner, x.ships);
      sendHome(g, p, x.owner, x.ships);
    }
  }
  return former;
}

/** Stationed ships fly to their owner's nearest planet (they are lost if the owner has none). */
function sendHome(g: Game, p: Planet, owner: number, ships: number): void {
  const homes = g.planets.filter(q => q.owner === owner).sort((a, b) => travel(p, a) - travel(p, b));
  if (!homes.length) return;
  g.fleets.push({ owner, from: p.id, to: homes[0].id, ships, strength: p.strength, arrives: g.turn + travel(p, homes[0]), mode: 'attack' });
}

/** Defending a friend's planet raises their opinion a lot: +3 for 5 ships or more, +1 for fewer; once every 5 turns. */
function thank(g: Game, host: number, guest: number, ships: number, say: (text: string, player?: number) => void): void {
  if (!g.players[host].persona) return;
  const key = `${host},${guest}`;
  if (g.turn - (g.thanked![key] ?? -99) < 5) return;
  g.thanked![key] = g.turn;
  const by = ships >= 5 ? 3 : 1;
  raise(trustOf(g), host, guest, by);
  say(`${g.players[host].name} thanks ${nameOf(g, guest)} for the defence (+${by}; now ${g.opinion![host][guest]}).`, guest);
}

// ---- Between turns: moods, fear of the leader, deals ----

function diplomacy(g: Game, say: (text: string, player?: number) => void): void {
  const t = trustOf(g);
  const ps = personas(g);
  for (const pl of g.players) if (pl.out) leaveTeam(g, pl.id);
  drift(t, ps, g.turn, (a, b) => trading(g, a, b));
  if (g.turn % 5 === 0) fearTheLeader(g, say);
  // Once nobody's planets are gone, growth means taking someone's: every 6 turns, 1 less for everyone not a friend.
  if (g.turn % 6 === 0 && !g.planets.some(p => p.owner < 0)) {
    for (const a of g.players) {
      if (!a.persona || a.out) continue;
      for (const b of g.players) if (b.id !== a.id && !b.out && !allied(g, a.id, b.id) && !trading(g, a.id, b.id)) lower(t, a.id, b.id, 1, 2);
    }
  }
  checkRoutes(g, say);
  // Stationed ships go home when their owner and the host are no longer friends (or the owner is out).
  for (const p of g.planets) {
    for (const x of [...(p.guests ?? [])]) {
      const friends = p.owner >= 0 && (allied(g, x.owner, p.owner) || trading(g, x.owner, p.owner) || regard(g, x.owner, p.owner) >= 5);
      if (friends && !g.players[x.owner].out) continue;
      takeGuests(p, x.owner, x.ships);
      if (!g.players[x.owner].out) {
        sendHome(g, p, x.owner, x.ships);
        say(`${shipsText(x.ships)} of ${nameOf(g, x.owner)} left ${p.name} for home.`, x.owner);
      }
    }
  }
  botTrades(g, say);
  botAlliances(g, say);
  offersToPeople(g);
  recalc(g);
}

/** Sides still in the game: each alliance, and each player on their own. */
export function sides(g: Game): number[][] {
  const seen = new Set<number>();
  const out: number[][] = [];
  for (const pl of g.players) {
    if (pl.out || seen.has(pl.id)) continue;
    const s = side(g, pl.id).filter(id => !g.players[id].out);
    s.forEach(id => seen.add(id));
    out.push(s);
  }
  return out;
}

const planetsOf = (g: Game, ids: number[]) => g.planets.filter(p => ids.includes(p.owner)).length;

/**
 * Every 5 turns: when one side holds 35% of all planets or more, everyone else thinks 1 less of its members, and 1 more
 * of each other (a common threat). This pushes the map toward two sides without scripting it.
 */
function fearTheLeader(g: Game, say: (text: string, player?: number) => void): void {
  const all = sides(g);
  if (all.length < 3) return;
  const leader = [...all].sort((a, b) => planetsOf(g, b) - planetsOf(g, a))[0];
  const share = planetsOf(g, leader) / g.planets.length;
  if (share < 0.35) return;
  const t = trustOf(g);
  const rest = g.players.filter(p => p.persona && !p.out && !leader.includes(p.id));
  for (const w of rest) {
    for (const m of leader) lower(t, w.id, m, 1, 1);
    for (const v of g.players) if (v.id !== w.id && !v.out && !leader.includes(v.id) && !allied(g, w.id, v.id)) raise(t, w.id, v.id, 1);
  }
  if (rest.length) say(`The others grow wary of ${leader.map(id => g.players[id].name).join(' and ')}: ${Math.round(share * 100)}% of the planets.`);
}

function unroutedPlanets(g: Game, id: number): Planet[] {
  return g.planets.filter(p => p.owner === id && !routeOf(g, p.id));
}

/** The best trade between any unrouted planet of `a` and any of `b`, or null. */
function bestBetween(g: Game, a: number, b: number): { route: Route; gain: number } | null {
  let best: { route: Route; gain: number } | null = null;
  const theirs = unroutedPlanets(g, b);
  for (const pa of unroutedPlanets(g, a)) {
    for (const pb of theirs) {
      const s = bestSwap(g, pa.id, pb.id);
      if (s && (!best || s.gainA + s.gainB > best.gain)) best = { route: s.route, gain: s.gainA + s.gainB };
    }
  }
  return best;
}

const willTrade = (g: Game, a: number, b: number) => {
  const p = g.players[a].persona;
  return !p || g.opinion![a][b] >= TEMPERS[p].tradeAt;
};

function botTrades(g: Game, say: (text: string, player?: number) => void): void {
  for (const a of g.players) {
    if (!a.persona || a.out || random(g) >= 0.5) continue;
    let best: { route: Route; gain: number } | null = null;
    for (const b of g.players) {
      if (b.id === a.id || !b.persona || b.out || !willTrade(g, a.id, b.id) || !willTrade(g, b.id, a.id)) continue;
      const s = bestBetween(g, a.id, b.id);
      if (s && (!best || s.gain > best.gain)) best = s;
    }
    if (best) openRoute(g, best.route, say);
  }
}

function botAlliances(g: Game, say: (text: string, player?: number) => void): void {
  for (const a of g.players) {
    for (const b of g.players) {
      if (b.id <= a.id || !a.persona || !b.persona || a.out || b.out) continue;
      if (g.opinion![a.id][b.id] < 7 || g.opinion![b.id][a.id] < 7 || allianceProblem(g, a.id, b.id)) continue;
      if (random(g) < Math.min(TEMPERS[a.persona].allyChance, TEMPERS[b.persona].allyChance)) ally(g, a.id, b.id, say);
    }
  }
}

/** Each computer player may put one trade to each person, and ask a friend (7+) to be allies. */
function offersToPeople(g: Game): void {
  for (const h of g.players) {
    if (h.persona || h.ai || h.out) continue;
    for (const b of g.players) {
      if (!b.persona || b.out) continue;
      const op = g.opinion![b.id][h.id];
      if (op >= 7 && !allianceProblem(g, b.id, h.id) && random(g) < TEMPERS[b.persona].allyChance) {
        g.offers!.push({ id: g.nextOffer!++, kind: 'alliance', from: b.id, to: h.id });
      }
      if (op < TEMPERS[b.persona].tradeAt || random(g) >= 0.5) continue;
      const s = bestBetween(g, b.id, h.id);
      // Two offers never ask for the same planet of yours.
      if (s && !g.offers!.some(o => o.route && (o.route.b === s.route.b || o.route.a === s.route.a))) g.offers!.push({ id: g.nextOffer!++, kind: 'trade', from: b.id, to: h.id, route: s.route });
    }
  }
}

/**
 * Trade & Trust victory: a side (an alliance, or one player) wins when it owns every planet, nobody's included. At the
 * turn limit, the side with the most planets (then ships) wins.
 */
function teamVictory(g: Game, say: (text: string, player?: number) => void): void {
  const all = sides(g);
  const win = (s: number[], how: string) => {
    g.over = true;
    g.winners = s;
    g.winner = [...s].sort((a, b) => planetsOf(g, [b]) - planetsOf(g, [a]))[0];
    say(how);
  };
  const names = (s: number[]) => s.map(id => g.players[id].name).join(', ');
  const owner = all.find(s => g.planets.every(p => s.includes(p.owner)));
  if (owner) return win(owner, owner.length > 1 ? `${names(owner)} win together: their alliance holds every planet!` : `${names(owner)} rules the galaxy!`);
  if (g.maxTurns && g.turn >= g.maxTurns) {
    const ships = (s: number[]) => standings(g).filter(x => s.includes(x.player.id)).reduce((n, x) => n + x.ships, 0);
    const best = [...all].sort((a, b) => planetsOf(g, b) - planetsOf(g, a) || ships(b) - ships(a))[0];
    win(best, `Turn limit reached. ${names(best)} ${best.length > 1 ? 'hold' : 'holds'} the most planets and ${best.length > 1 ? 'win' : 'wins'}.`);
  }
}

/** Computers (not Easy) send spare ships to defend an ally's planet that is about to be attacked; a Guardian also defends trading partners. */
function defendFriends(g: Game, player: number, mine: Planet[], spare: Map<number, number>): void {
  const me = g.players[player];
  const guards = !!me.persona && !!TEMPERS[me.persona].guards;
  for (const q of g.planets) {
    if (q.owner < 0 || q.owner === player || !(allied(g, player, q.owner) || (guards && trading(g, player, q.owner)))) continue;
    const threats = g.fleets.filter(f => f.to === q.id && f.owner !== q.owner && f.owner !== player && f.mode !== 'defend' && !allied(g, f.owner, q.owner));
    if (!threats.length) continue;
    const soonest = Math.min(...threats.map(f => f.arrives));
    const coming = g.fleets.filter(f => f.to === q.id && (f.owner === q.owner || f.mode === 'defend')).reduce((n, f) => n + f.ships, 0);
    let short = Math.ceil(threats.reduce((n, f) => n + f.ships, 0) * 1.2) - (q.ships + stationedAt(q) + coming);
    for (const src of [...mine].sort((a, b) => travel(a, q) - travel(b, q))) {
      if (short <= 0) break;
      const free = spare.get(src.id) ?? 0;
      if (free < 1 || g.turn + travel(src, q) > soonest) continue;
      const n = Math.min(short, free);
      send(g, player, src.id, q.id, n, 'defend');
      spare.set(src.id, free - n);
      short -= n;
    }
  }
}

/** Trade & Trust parts of a saved game; anything out of shape is refused. */
function checkTradeSave(g: Game, num: (v: unknown) => boolean): void {
  const bad = () => new Error('This game file is damaged.');
  const n = g.players.length;
  const square = (m: unknown) => Array.isArray(m) && m.length === n && m.every(r => Array.isArray(r) && r.length === n && r.every(num));
  if (g.rules !== 'trade' || !square(g.opinion) || !square(g.grudge) || !square(g.lastHit)) throw bad();
  if (!Array.isArray(g.teams) || g.teams.length !== n || !g.teams.every(num) || !Array.isArray(g.routes) || !Array.isArray(g.offers)) throw bad();
  for (const pl of g.players) if (pl.persona !== undefined && !PERSONAS.includes(pl.persona)) throw bad();
  for (const p of g.planets) {
    if (!num(p.iron) || !num(p.energy)) throw bad();
    if (p.guests !== undefined && (!Array.isArray(p.guests) || !p.guests.every(x => x && num(x.owner) && num(x.ships) && g.players[x.owner]))) throw bad();
  }
  const okRoute = (r: Route | undefined) => !!r && !!g.planets[r.a] && !!g.planets[r.b] && (r.res === 'iron' || r.res === 'energy') && num(r.amount);
  if (!g.routes.every(okRoute)) throw bad();
  if (!g.offers.every(o => o && num(o.id) && g.players[o.from] && g.players[o.to] && (o.kind === 'alliance' || (o.kind === 'trade' && okRoute(o.route))))) throw bad();
  g.thanked = g.thanked && typeof g.thanked === 'object' ? g.thanked : {};
  g.nextOffer = num(g.nextOffer) ? g.nextOffer : 1;
  recalc(g);
}
