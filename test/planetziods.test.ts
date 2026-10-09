// Planetziods: the rules, replayed with fixed seeds.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computerMoves, endTurn, loadGame, newGame, orderProblem, send, standings, travel, type Game } from '../src/apps/planetziods/engine.ts';

const game = (seed = 42): Game => newGame({ seed, people: ['You'], computers: [{ name: 'Orion', level: 'normal' }], neutral: 8 });

test('a new game: home planets, neutral planets, all on different squares, the same for the same seed', () => {
  const g = game();
  assert.equal(g.planets.length, 10);
  assert.deepEqual(g.planets.slice(0, 2).map(p => [p.owner, p.ships, p.production]), [[0, 10, 10], [1, 10, 10]]);
  assert.ok(g.planets.slice(2).every(p => p.owner === -1 && p.production >= 3 && p.strength >= 0.3 && p.strength <= 0.9));
  assert.equal(new Set(g.planets.map(p => `${p.x},${p.y}`)).size, 10);
  assert.deepEqual(game().planets, g.planets, 'same seed, same galaxy');
  assert.notDeepEqual(game(7).planets, g.planets);
});

test('orders are checked; ships leave at once and arrive after the travel time', () => {
  const g = game();
  const [home, other] = [g.planets[0], g.planets[2]];
  assert.match(orderProblem(g, 0, 1, 2, 1)!, /not yours/);
  assert.match(orderProblem(g, 0, 0, 0, 1)!, /different planet/);
  assert.match(orderProblem(g, 0, 0, 2, 11)!, /only 10 ships/);
  const f = send(g, 0, home.id, other.id, 4);
  assert.equal(home.ships, 6);
  assert.equal(f.arrives, g.turn + travel(home, other));
});

test('reinforcing your own planet adds ships; production arrives every turn', () => {
  const g = game();
  g.planets[2].owner = 0;
  g.planets[2].ships = 1;
  const f = send(g, 0, 0, 2, 5);
  while (g.turn < f.arrives) endTurn(g);
  endTurn(g);
  assert.ok(g.planets[2].ships >= 6 + g.planets[2].production, 'reinforced and produced');
});

test('a big fleet captures a weak planet; a tiny one loses', () => {
  const g = game();
  const target = g.planets[2];
  target.ships = 1;
  target.strength = 0.3;
  g.planets[0].ships = 100;
  const f = send(g, 0, 0, 2, 60);
  while (g.turn <= f.arrives) endTurn(g);
  assert.equal(target.owner, 0);
  const h = game();
  h.planets[3].ships = 80;
  h.planets[3].strength = 0.9;
  const f2 = send(h, 0, 0, 3, 1);
  while (h.turn <= f2.arrives) endTurn(h);
  assert.equal(h.planets[3].owner, -1);
});

test('taking the last enemy planet wins the game', () => {
  const g = game();
  g.planets[1].ships = 0;
  g.planets[1].strength = 0.3;
  g.planets[0].ships = 50;
  const f = send(g, 0, 0, 1, 50);
  while (!g.over && g.turn <= f.arrives + 1) endTurn(g);
  assert.equal(g.over, true);
  assert.equal(g.winner, 0);
  assert.equal(g.players[1].out, true);
});

test('computer players only give legal orders and play a whole game to an end', () => {
  const g = newGame({ seed: 3, people: [], computers: [{ name: 'A', level: 'hard' }, { name: 'B', level: 'normal' }, { name: 'C', level: 'easy' }], neutral: 12, maxTurns: 150 });
  for (let i = 0; i < 150 && !g.over; i++) {
    for (const p of g.players) computerMoves(g, p.id);
    assert.ok(g.planets.every(p => p.ships >= 0), 'never below zero');
    endTurn(g);
  }
  assert.equal(g.over, true);
  assert.notEqual(g.winner, null);
  const s = standings(g);
  assert.equal(s.length, 3);
});

test('a saved game loads back; junk is refused', () => {
  const g = game();
  send(g, 0, 0, 2, 3);
  endTurn(g);
  assert.deepEqual(loadGame(JSON.stringify(g)), g);
  assert.throws(() => loadGame('{"planets":1}'), /not a Planetziods game/);
  assert.throws(() => loadGame(JSON.stringify({ ...g, fleets: [{ ships: 1, arrives: 2, to: 99, from: 0 }] })), /damaged/);
});
