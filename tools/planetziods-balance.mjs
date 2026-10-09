// Planetziods Trade & Trust: balance by simulation. Plays many seeded computer-only games and prints what decides
// them: how often each personality ends on the winning side, how often games reach the turn limit, how long they
// last, whether alliances or lone players win, and whether trading or fighting paid.
// Run from the repository folder:  node tools/planetziods-balance.mjs [games=600] [maxTurns=150]
import { computerMoves, endTurn, newGame, sides, standings } from '../src/apps/planetziods/engine.ts';
import { TEMPERS } from '../src/apps/planetziods/trust.ts';

const games = Number(process.argv[2]) || 600;
const maxTurns = Number(process.argv[3]) || 150;
const NAMES = ['Orion', 'Vega', 'Lyra', 'Draco', 'Nova', 'Rigel'];
const LEVELS = ['easy', 'normal', 'hard'];

const persona = {};
const level = {};
const bump = (m, k, field) => {
  m[k] ??= { seats: 0, wins: 0 };
  m[k][field]++;
};
let limit = 0;
let turns = 0;
let allianceWins = 0;
let routesOpened = 0;
let alliancesMade = 0;
const traders = { winners: 0, winnerTurns: 0, others: 0, otherTurns: 0 };
const fighters = { winners: 0, winnerAttacks: 0, others: 0, otherAttacks: 0 };

for (let i = 0; i < games; i++) {
  const n = 4 + (i % 3); // 4, 5 or 6 players
  const mixed = i % 2 === 1; // every other game: mixed skill; else all Normal
  const g = newGame({
    seed: 1000 + i, rules: 'trade', people: [], neutral: 8 + (i % 9), maxTurns,
    computers: NAMES.slice(0, n).map((name, k) => ({ name, level: mixed ? LEVELS[(i + k) % 3] : 'normal' })),
    width: n > 5 ? 22 : 16, height: n > 5 ? 15 : 12,
  });
  const routeTurns = g.players.map(() => 0);
  const attacks = g.players.map(() => 0);
  while (!g.over) {
    const before = g.fleets.length;
    for (const p of g.players) computerMoves(g, p.id);
    for (const f of g.fleets.slice(before)) if (f.mode === 'attack' && g.planets[f.to].owner >= 0 && g.planets[f.to].owner !== f.owner) attacks[f.owner]++;
    for (const r of g.routes) {
      routeTurns[g.planets[r.a].owner]++;
      routeTurns[g.planets[r.b].owner]++;
    }
    const reports = endTurn(g);
    routesOpened += reports.filter(r => r.text.startsWith('New trade route')).length;
    alliancesMade += reports.filter(r => / are now allies/.test(r.text)).length;
  }
  turns += g.turn - 1;
  if (reports(g).some(t => t.startsWith('Turn limit reached'))) limit++;
  if (g.winners.length > 1) allianceWins++;
  for (const p of g.players) {
    const won = g.winners.includes(p.id);
    bump(persona, TEMPERS[p.persona].name, 'seats');
    if (won) bump(persona, TEMPERS[p.persona].name, 'wins');
    if (mixed) {
      bump(level, p.ai, 'seats');
      if (won) bump(level, p.ai, 'wins');
    }
    if (won) {
      traders.winners++;
      traders.winnerTurns += routeTurns[p.id];
      fighters.winnerAttacks += attacks[p.id];
    } else {
      traders.others++;
      traders.otherTurns += routeTurns[p.id];
      fighters.otherAttacks += attacks[p.id];
    }
  }
  void sides;
  void standings;
}

function reports(g) {
  return g.reports.map(r => r.text);
}

const pct = (a, b) => `${((100 * a) / Math.max(1, b)).toFixed(1)}%`;
console.log(`${games} games, turn limit ${maxTurns}`);
console.log(`  reached the turn limit: ${pct(limit, games)}; average length ${(turns / games).toFixed(1)} turns`);
console.log(`  won by an alliance: ${pct(allianceWins, games)}; by one player alone: ${pct(games - allianceWins, games)}`);
console.log(`  trade routes opened per game: ${(routesOpened / games).toFixed(1)}; alliances made per game: ${(alliancesMade / games).toFixed(1)}`);
console.log(`  turns of trade per player: winners ${(traders.winnerTurns / Math.max(1, traders.winners)).toFixed(1)}, others ${(traders.otherTurns / Math.max(1, traders.others)).toFixed(1)}`);
console.log(`  attacks on players per player: winners ${(fighters.winnerAttacks / Math.max(1, traders.winners)).toFixed(1)}, others ${(fighters.otherAttacks / Math.max(1, traders.others)).toFixed(1)}`);
console.log('  on the winning side, per seat (personality):');
for (const [k, v] of Object.entries(persona).sort((a, b) => b[1].wins / b[1].seats - a[1].wins / a[1].seats)) console.log(`    ${k.padEnd(9)} ${pct(v.wins, v.seats).padStart(6)}  (${v.seats} seats)`);
console.log('  on the winning side, per seat (skill, mixed games):');
for (const [k, v] of Object.entries(level)) console.log(`    ${k.padEnd(9)} ${pct(v.wins, v.seats).padStart(6)}  (${v.seats} seats)`);
