// Trust: what each computer player thinks of every other player, 0 (war) to 10 (firm friend), 5 = neutral.
// A pure file with no game in it (only numbers and player ids), so another game can copy it as it is (copy the file;
// do not link the projects).
// The idea is Robert Axelrod's tournaments (1980) as retold in Nicky Case's "The Evolution of Trust": start nice,
// answer an attack, forgive in time, and a reputation travels.

export type Persona = 'trader' | 'copycat' | 'grudger' | 'guardian' | 'forgiver' | 'raider';

export interface Temper {
  name: string;
  /** What it thinks of everyone at the start, and where it settles back to when left alone. */
  start: number;
  /** A trade route with someone raises its opinion of them by 1 every this many turns. */
  warmEvery: number;
  /** Below its starting opinion, it forgives 1 point every this many turns without being attacked. */
  forgiveEvery: number;
  /** At or below this opinion it may attack you. */
  hostileAt: number;
  /** It trades with you only at or above this opinion. */
  tradeAt: number;
  /** The chance each turn that it asks a friend (opinion 7+) to be allies. */
  allyChance: number;
  /** Attacked once, it never thinks better of the attacker than 2 again. */
  grudge?: boolean;
  /** Seeing its ally or trading partner attacked counts double. */
  guards?: boolean;
  about: string;
}

export const TEMPERS: Record<Persona, Temper> = {
  trader: { name: 'Trader', start: 6, warmEvery: 2, forgiveEvery: 3, hostileAt: 3, tradeAt: 4, allyChance: 0.5, about: 'Warms fastest to trading partners; slow to fight.' },
  copycat: { name: 'Copycat', start: 5, warmEvery: 3, forgiveEvery: 3, hostileAt: 3, tradeAt: 5, allyChance: 0.35, about: 'Answers an attack with war, then forgives when you stop.' },
  grudger: { name: 'Grudger', start: 5, warmEvery: 3, forgiveEvery: 4, hostileAt: 3, tradeAt: 5, allyChance: 0.3, grudge: true, about: 'Attack it once and it never trusts you again.' },
  guardian: { name: 'Guardian', start: 6, warmEvery: 3, forgiveEvery: 4, hostileAt: 3, tradeAt: 5, allyChance: 0.4, guards: true, about: 'Takes attacks on its allies and partners personally, and sends ships to defend them.' },
  forgiver: { name: 'Forgiver', start: 7, warmEvery: 3, forgiveEvery: 2, hostileAt: 2, tradeAt: 5, allyChance: 0.4, about: 'Starts friendly and forgives quickly.' },
  raider: { name: 'Raider', start: 4, warmEvery: 3, forgiveEvery: 6, hostileAt: 4, tradeAt: 5, allyChance: 0.25, about: 'Raids anyone it does not like (4 or less), which is everyone at first; trade with it to buy peace.' },
};

export const PERSONAS = Object.keys(TEMPERS) as Persona[];

export interface Trust {
  /** opinion[a][b] = what player a thinks of player b. */
  opinion: number[][];
  /** grudge[a][b] = 1 when a is a Grudger that b has attacked. */
  grudge: number[][];
  /** lastHit[a][b] = the turn b last attacked a (0 = never). */
  lastHit: number[][];
}

const grid = (n: number, v: (a: number, b: number) => number) => Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, b) => v(a, b)));

/** People (persona null) have no opinions that matter; their row stays at 5. */
export function newTrust(personas: Array<Persona | null>): Trust {
  const n = personas.length;
  return {
    opinion: grid(n, (a, b) => (a === b ? 10 : personas[a] ? TEMPERS[personas[a]!].start : 5)),
    grudge: grid(n, () => 0),
    lastHit: grid(n, () => 0),
  };
}

const cap = (t: Trust, a: number, b: number) => (t.grudge[a][b] ? 2 : 10);

export function raise(t: Trust, a: number, b: number, by: number): void {
  if (a === b) return;
  t.opinion[a][b] = Math.min(cap(t, a, b), t.opinion[a][b] + by);
}

export function lower(t: Trust, a: number, b: number, by: number, floor = 0): void {
  if (a === b) return;
  t.opinion[a][b] = Math.max(Math.min(floor, t.opinion[a][b]), t.opinion[a][b] - by);
}

/** An offer turned down: 1 point less, but never below neutral (5) for that reason alone. */
export function rejected(t: Trust, a: number, b: number): void {
  lower(t, a, b, 1, 5);
}

/**
 * `attacker` attacked `victim` this turn. The victim goes to 0. Each witness loses `weight` points of opinion of the
 * attacker (a negative weight means approval: they were enemies of the victim).
 */
export function attacked(t: Trust, personas: Array<Persona | null>, turn: number, attacker: number, victim: number, witnesses: Array<{ id: number; weight: number }>): void {
  if (attacker === victim) return;
  t.opinion[victim][attacker] = 0;
  t.lastHit[victim][attacker] = turn;
  const p = personas[victim];
  if (p && TEMPERS[p].grudge) t.grudge[victim][attacker] = 1;
  for (const w of witnesses) {
    if (w.id === attacker || w.id === victim) continue;
    if (w.weight > 0) lower(t, w.id, attacker, w.weight);
    else if (w.weight < 0) raise(t, w.id, attacker, -w.weight);
  }
}

/** Once a turn: trading partners warm up; old wounds heal back to where each started. */
export function drift(t: Trust, personas: Array<Persona | null>, turn: number, trading: (a: number, b: number) => boolean): void {
  personas.forEach((p, a) => {
    if (!p) return;
    const temper = TEMPERS[p];
    for (let b = 0; b < personas.length; b++) {
      if (a === b) continue;
      if (turn % temper.warmEvery === 0 && trading(a, b)) raise(t, a, b, 1);
      else if (t.opinion[a][b] < temper.start && turn - t.lastHit[a][b] >= temper.forgiveEvery && turn % temper.forgiveEvery === 0) raise(t, a, b, 1);
    }
  });
}

export function hostile(t: Trust, personas: Array<Persona | null>, a: number, b: number): boolean {
  const p = personas[a];
  return !!p && t.opinion[a][b] <= TEMPERS[p].hostileAt;
}

/** A word for an opinion, for the screen. */
export function mood(n: number): string {
  return n <= 2 ? 'Hostile' : n <= 4 ? 'Wary' : n <= 6 ? 'Neutral' : n <= 8 ? 'Friendly' : 'Trusted';
}
