// Planetziods, Trade & Trust rules: resources, trade routes, trust, alliances, stationed ships, team victory.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptOffer, allianceProblem, allied, bestSwap, canDefend, cancelRoute, computerMoves, endTurn, guestsOf, loadGame, newGame,
  orderProblem, proposeAlliance, proposeTrade, rejectOffer, routeOf, routeProblem, send, trading, unsend, type Game,
} from '../src/apps/planetziods/engine.ts';

/** You (0) against three computers (1, 2, 3); planets 0-3 are the home worlds. */
const game = (seed = 42, extra: Partial<Parameters<typeof newGame>[0]> = {}): Game =>
  newGame({ seed, rules: 'trade', people: ['You'], computers: [{ name: 'Orion', level: 'normal' }, { name: 'Vega', level: 'normal' }, { name: 'Lyra', level: 'normal' }], neutral: 8, ...extra });

/** Runs whole turns (no computer moves) until the fleet has landed. */
const land = (g: Game, arrives: number) => {
  while (g.turn <= arrives) endTurn(g);
};

test('classic and Trade & Trust share the map for a seed; only the new rules carry resources, trust and teams', () => {
  const t = game();
  const c = newGame({ seed: 42, people: ['You'], computers: [{ name: 'Orion', level: 'normal' }, { name: 'Vega', level: 'normal' }, { name: 'Lyra', level: 'normal' }], neutral: 8 });
  assert.deepEqual(t.planets.map(p => [p.x, p.y, p.owner, p.ships, p.strength]), c.planets.map(p => [p.x, p.y, p.owner, p.ships, p.strength]));
  assert.equal(c.rules, undefined);
  assert.equal('opinion' in c || 'teams' in c || 'iron' in c.planets[0], false, 'a classic game has none of the new fields');
  assert.equal(t.rules, 'trade');
  for (const home of t.planets.slice(0, 4)) {
    assert.equal(home.iron! + home.energy!, 24, 'every home world mines the same in all');
    assert.equal(home.production, Math.min(home.iron!, home.energy!), 'the scarcer resource sets the ships built');
  }
  const personas = t.players.slice(1).map(p => p.persona);
  assert.equal(new Set(personas).size, 3, 'each computer gets its own personality');
  assert.equal(t.players[0].persona, undefined, 'a person has none');
});

test('the worked example: Kessel (5 iron, 15 energy) and Brask (14, 6) build 11 a turn apart and 19 after an even swap', () => {
  const g = game();
  const [kessel, brask] = [g.planets[0], g.planets[1]];
  Object.assign(kessel, { iron: 5, energy: 15 });
  Object.assign(brask, { iron: 14, energy: 6 });
  endTurn(g); // recalculates production
  assert.equal(kessel.production + brask.production, 11);
  const swap = bestSwap(g, kessel.id, brask.id)!;
  assert.equal(swap.gainA + swap.gainB, 8);
  g.opinion![1][0] = 6;
  const r = proposeTrade(g, 0, kessel.id, brask.id);
  assert.equal(r.ok, true, r.text);
  assert.equal(kessel.production + brask.production, 19);
  assert.ok(trading(g, 0, 1));
});

test('no trading between your own planets, one route per planet, and a route ends when a world changes hands', () => {
  const g = game();
  g.planets[4].owner = 0;
  assert.match(routeProblem(g, { a: 0, b: 4, res: 'iron', amount: 1 })!, /own planets/);
  Object.assign(g.planets[0], { iron: 5, energy: 19 });
  Object.assign(g.planets[1], { iron: 19, energy: 5 });
  g.opinion![1][0] = 6;
  assert.equal(proposeTrade(g, 0, 0, 1).ok, true);
  assert.match(proposeTrade(g, 0, 0, 2).text, /already has a trade route/);
  // Vega (2) takes Orion's planet: the route ends and production falls back.
  const before = g.planets[0].production;
  g.planets[1].ships = 0;
  g.planets[1].strength = 0.3;
  g.planets[2].ships = 200;
  g.opinion![2][1] = 0;
  const f = send(g, 2, 2, 1, 150);
  land(g, f.arrives);
  assert.equal(g.planets[1].owner, 2);
  assert.equal(routeOf(g, 0), undefined);
  assert.ok(g.planets[0].production < before);
});

test('a computer refuses to trade below its trading opinion; offers turned down cost 1 point, never below 5', () => {
  const g = game();
  Object.assign(g.planets[0], { iron: 5, energy: 19 });
  Object.assign(g.planets[1], { iron: 19, energy: 5 });
  g.opinion![1][0] = 2;
  assert.match(proposeTrade(g, 0, 0, 1).text, /will not trade with you yet/);
  g.offers = [{ id: 1, kind: 'trade', from: 1, to: 0, route: { a: 1, b: 0, res: 'iron', amount: 5 } }, { id: 2, kind: 'alliance', from: 1, to: 0 }];
  g.opinion![1][0] = 8;
  rejectOffer(g, 1);
  assert.equal(g.opinion![1][0], 7);
  g.opinion![1][0] = 5;
  endTurn(g); // offer 2 unanswered: counts as a no
  assert.equal(g.opinion![1][0] >= 5, true, 'never below neutral for saying no');
  assert.ok(g.reports.some(r => /unanswered/.test(r.text)));
});

test('accepting an offer opens the route; a person can cancel it', () => {
  const g = game();
  Object.assign(g.planets[0], { iron: 5, energy: 19 });
  Object.assign(g.planets[1], { iron: 19, energy: 5 });
  g.offers = [{ id: 7, kind: 'trade', from: 1, to: 0, route: bestSwap(g, 1, 0)!.route }];
  assert.equal(acceptOffer(g, 7).ok, true);
  assert.ok(routeOf(g, 0));
  g.opinion![1][0] = 9;
  cancelRoute(g, 0, 0);
  assert.equal(routeOf(g, 0), undefined);
  assert.equal(g.opinion![1][0], 8);
});

test('an attack: the victim goes to 0, nearby computers think 1 less of the attacker', () => {
  const g = game();
  const target = g.planets[1];
  // Put every computer's home within sight of Orion's planet.
  g.planets[2].x = target.x + 1;
  g.planets[2].y = target.y;
  g.planets[3].x = target.x;
  g.planets[3].y = target.y + 1;
  g.opinion![2][0] = 6;
  g.opinion![3][0] = 6;
  const f = send(g, 0, 0, 1, 3);
  land(g, f.arrives);
  assert.equal(g.opinion![1][0], 0);
  assert.equal(g.opinion![2][0], 5);
  assert.equal(g.opinion![3][0], 5);
});

test('accident protection: a fleet sent to attack a planet that becomes an ally’s on the way joins its defence', () => {
  const g = game();
  const f = send(g, 0, 0, 1, 4);
  assert.equal(f.sneak, undefined);
  g.opinion![1][0] = 8;
  assert.equal(proposeAlliance(g, 0, 1).ok, true);
  const ships = g.planets[1].ships;
  land(g, f.arrives);
  assert.equal(g.planets[1].owner, 1);
  assert.equal(guestsOf(g.planets[1], 0), 4, 'stationed there, still yours');
  assert.equal(g.planets[1].ships >= ships, true, 'no battle');
  assert.equal(g.opinion![1][0], 8, 'no change in trust');
  assert.ok(allied(g, 0, 1));
});

test('a sneak attack on an ally breaks the alliance, sends stationed ships home, and costs 2 with witnesses', () => {
  const g = game();
  g.opinion![1][0] = 8;
  g.opinion![2][0] = 8;
  proposeAlliance(g, 0, 1);
  g.planets[2].x = g.planets[1].x + 1;
  g.planets[2].y = g.planets[1].y;
  // Orion has ships stationed on your home world.
  g.planets[0].guests = [{ owner: 1, ships: 3 }];
  assert.equal(orderProblem(g, 0, 0, 1, 2), null);
  const f = send(g, 0, 0, 1, 2);
  assert.equal(f.sneak, true);
  land(g, f.arrives);
  assert.equal(allied(g, 0, 1), false);
  assert.equal(g.opinion![1][0], 0);
  assert.equal(g.opinion![2][0], 6, 'witness: -2 for a sneak attack');
  assert.equal(guestsOf(g.planets[0], 1), 0, 'Orion’s stationed ships went home');
  assert.ok(g.fleets.some(x => x.owner === 1 && x.from === 0 && x.ships === 3) || g.planets[1].ships > 0);
});

test('defending a trading partner: the ships stay yours, defend it, raise trust by 3, and can be sent on from there', () => {
  const g = game();
  Object.assign(g.planets[0], { iron: 5, energy: 19 });
  Object.assign(g.planets[1], { iron: 19, energy: 5 });
  g.opinion![1][0] = 5;
  assert.equal(proposeTrade(g, 0, 0, 1).ok, true);
  assert.equal(canDefend(g, 0, 1), true);
  assert.equal(canDefend(g, 0, 2), false, 'not a partner');
  assert.match(orderProblem(g, 0, 0, 2, 1, 'defend')!, /allies and trading partners/);
  g.planets[0].ships = 20;
  const f = send(g, 0, 0, 1, 6, 'defend');
  while (g.turn < f.arrives) endTurn(g);
  const before = g.opinion![1][0];
  g.opinion![1][0] = Math.min(before, 6);
  endTurn(g);
  assert.equal(guestsOf(g.planets[1], 0), 6);
  assert.ok(g.opinion![1][0] >= Math.min(before, 6) + 3, '+3 for a defence of 5 ships or more');
  assert.ok(g.reports.some(r => /thanks You for the defence \(\+3/.test(r.text)));
  // They fight beside the owner: a raid that the planet alone would lose is held.
  const home = g.planets[1];
  home.ships = 2;
  home.strength = 0.9;
  g.opinion![2][1] = 0;
  g.planets[2].ships = 5;
  const raid = send(g, 2, 2, 1, 5);
  land(g, raid.arrives);
  assert.equal(home.owner, 1);
  // Sent on from the partner's planet, then taken back.
  const left = guestsOf(home, 0);
  const onward = send(g, 0, 1, 3, 1);
  assert.equal(guestsOf(home, 0), left - 1);
  unsend(g, onward);
  assert.equal(guestsOf(home, 0), left);
});

test('an alliance holds at most half the players (rounded up); allies of allies join the same team', () => {
  const g = newGame({ seed: 5, rules: 'trade', people: ['You'], computers: ['A', 'B', 'C', 'D', 'E'].map(name => ({ name, level: 'normal' as const })), neutral: 6 });
  g.opinion![4][0] = 6;
  assert.match(proposeAlliance(g, 0, 4).text, /alliances need 7/);
  for (const b of [1, 2, 3]) g.opinion![b][0] = 9;
  assert.equal(proposeAlliance(g, 0, 1).ok, true);
  assert.equal(proposeAlliance(g, 0, 2).ok, true);
  assert.ok(allied(g, 1, 2), 'one team');
  assert.match(allianceProblem(g, 0, 3)!, /at most 3 of the 6/);
});

test('team victory: allies win together when they own every planet, nobody’s included', () => {
  const g = game(42, { computers: [{ name: 'Orion', level: 'normal' }, { name: 'Vega', level: 'normal' }] });
  g.opinion![1][0] = 9;
  proposeAlliance(g, 0, 1);
  for (const p of g.planets) p.owner = p.id % 2 ? 1 : 0;
  g.planets[2].owner = -1;
  g.players[2].out = true;
  endTurn(g);
  assert.equal(g.over, false, 'a planet of nobody’s is left');
  g.planets[2].owner = 0;
  endTurn(g);
  assert.equal(g.over, true);
  assert.deepEqual([...g.winners!].sort(), [0, 1]);
});

test('computers play a whole Trade & Trust game with legal orders, trade among themselves, and it ends', () => {
  const g = newGame({ seed: 11, rules: 'trade', people: [], computers: ['A', 'B', 'C', 'D', 'E'].map((name, i) => ({ name, level: (['hard', 'normal', 'easy'] as const)[i % 3] })), neutral: 12, maxTurns: 150 });
  let routes = 0;
  while (!g.over) {
    for (const p of g.players) computerMoves(g, p.id);
    assert.ok(g.planets.every(p => p.ships >= 0 && (p.guests ?? []).every(x => x.ships > 0)));
    routes += endTurn(g).filter(r => r.text.startsWith('New trade route')).length;
  }
  assert.ok(routes > 0, 'they traded');
  assert.ok(g.winners!.length >= 1);
});

test('a Trade & Trust save loads back; damaged trust is refused; an old classic save still loads', () => {
  const g = game();
  send(g, 0, 0, 4, 2);
  endTurn(g);
  assert.deepEqual(loadGame(JSON.stringify(g)), g);
  assert.throws(() => loadGame(JSON.stringify({ ...g, opinion: [[1]] })), /damaged/);
  assert.throws(() => loadGame(JSON.stringify({ ...g, rules: 'chess' })), /damaged/);
  const c = newGame({ seed: 1, people: ['You'], computers: [{ name: 'Orion', level: 'easy' }], neutral: 4 });
  assert.equal(loadGame(JSON.stringify(c)).rules, undefined);
});
