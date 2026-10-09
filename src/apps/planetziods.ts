// Planetziods: a galaxy-conquest game in the spirit of Konquest (our own rules text, names and art). Click one of your
// planets, then the planet to send ships to, choose how many, and Send; End turn when your orders are in. The computer
// players move, fleets arrive, battles are fought, planets make ships. Each owner has a colour AND a shape, so the map
// reads without colour too. The game is saved in your files after every turn (/System/planetziods.json).
// Two rule sets: Classic, and Trade & Trust (resources, trade routes, trust, alliances; see planetziods/engine.ts).
import { h, on } from '../core/dom.ts';
import { plural } from '../core/format.ts';
import type { AppDef, AppHandle } from '../shell/types.ts';
import {
  acceptOffer, allied, bestSwap, canDefend, cancelRoute, computerMoves, endTurn, guestsOf, loadGame, mined, newGame, orderProblem, proposeAlliance,
  other, proposeTrade, rejectOffer, routeOf, routeText, send, standings, teamCap, trading, travel, unsend, type Game, type Planet, type Route, type Rules, type Setup,
} from './planetziods/engine.ts';
import { TEMPERS, mood } from './planetziods/trust.ts';
import { APPS } from './catalog.ts';

const SAVE_PATH = '/System/planetziods.json';
const COLOURS = ['#3d8bfd', '#e5484d', '#30a46c', '#f5a524', '#a855f7', '#14b8a6'];
const SHAPES = ['circle', 'square', 'triangle', 'diamond', 'hexagon', 'star'] as const;
const SHAPE_NAMES = ['●', '■', '▲', '◆', '⬢', '★'];
const COMPUTER_NAMES = ['Orion', 'Vega', 'Lyra', 'Draco', 'Nova'];
const RULES_TEXT: Record<Rules, string> = {
  classic: 'Capture the galaxy. Every planet makes ships each turn; send fleets to take the planets of the other players and the neutral ones. The last player with planets wins.',
  trade: 'Each planet mines iron and energy; a ship takes one of each, so the scarcer one sets how many a planet builds. Trade evens them out, and both planets build more. Each computer player has a personality and an opinion of you from 0 to 10: attacks make enemies, and players nearby think less of you; trading and defending their planets build trust. At 7 or more they may ask to be allies. Allies win together by owning every planet.',
};

export const planetziodsApp: AppDef = {
  ...APPS.planetziods,
  async launch(app) {
    app.root.classList.add('pz');
    let saved: Game | null = null;
    try {
      saved = loadGame(await app.shell.fs.readText(SAVE_PATH));
      if (saved.over) saved = null;
    } catch {
      saved = null;
    }
    showSetup(app, saved);
  },
};

/** The settings a match was started with, to play them again on a new galaxy. */
function setupOf(g: Game): Setup {
  return {
    people: g.players.filter(p => p.ai === null).map(p => p.name),
    computers: g.players.filter(p => p.ai !== null).map(p => ({ name: p.name, level: p.ai! })),
    neutral: g.planets.length - g.players.length, width: g.width, height: g.height, maxTurns: g.maxTurns,
    neutralProduction: g.neutralProduction, rules: g.rules === 'trade' ? 'trade' : 'classic',
  };
}

function showSetup(app: AppHandle, saved: Game | null): void {
  app.setTitle('Planetziods');
  const rules = h('select', { class: 'field', 'aria-label': 'Rules' }, h('option', { value: 'classic', selected: true }, 'Classic'), h('option', { value: 'trade' }, 'Trade & Trust'));
  const name = h('input', { type: 'text', class: 'field', value: 'You', maxlength: 20, 'aria-label': 'Your name' });
  const computers = h('select', { class: 'field', 'aria-label': 'Computer players' }, ...[1, 2, 3, 4, 5].map(n => h('option', { value: n, selected: n === 2 }, String(n))));
  const level = h('select', { class: 'field', 'aria-label': 'How well they play' }, h('option', { value: 'easy' }, 'Easy'), h('option', { value: 'normal', selected: true }, 'Normal'), h('option', { value: 'hard' }, 'Hard'));
  const neutral = h('input', { type: 'number', class: 'field num', min: 2, max: 30, value: 12, 'aria-label': 'Neutral planets' });
  const size = h('select', { class: 'field', 'aria-label': 'Galaxy size' }, h('option', { value: 's' }, 'Small (12 × 9)'), h('option', { value: 'm', selected: true }, 'Medium (16 × 12)'), h('option', { value: 'l' }, 'Large (22 × 15)'));
  const limit = h('select', { class: 'field', 'aria-label': 'Turn limit' });
  const limitNote = h('p', { class: 'pz-note' });
  const grow = h('input', { type: 'checkbox', 'aria-label': 'Neutral planets make ships' });
  const start = h('button', { type: 'button', class: 'btn primary' }, 'New game');
  const cont = saved ? h('button', { type: 'button', class: 'btn' }, `Continue (turn ${saved.turn})${saved.rules === 'trade' ? ', Trade & Trust' : ''}`) : null;
  const problem = h('p', { class: 'dialog-problem', role: 'alert' });
  const lead = h('p', { class: 'pz-lead' });
  const row = (label: string, el: HTMLElement) => h('label', { class: 'pz-row' }, h('span', {}, label), el);
  /** Trade & Trust always has a turn limit: two equal alliances can hold each other off for ever. */
  function showRules() {
    const trade = rules.value === 'trade';
    lead.textContent = RULES_TEXT[trade ? 'trade' : 'classic'];
    const was = limit.value;
    const choices = trade ? [50, 100, 150, 200] : [0, 50, 100];
    limit.replaceChildren(...choices.map(n => h('option', { value: n }, n ? `${n} turns` : 'None')));
    limit.value = choices.map(String).includes(was) ? was : String(trade ? 150 : 0);
    limitNote.textContent = trade ? 'Trade & Trust always has a turn limit: two equal alliances can hold each other off for ever. At the limit, the side with the most planets wins.' : '';
    limitNote.hidden = !trade;
  }
  showRules();
  on(rules, 'change', showRules, app.signal);
  app.root.replaceChildren(h('div', { class: 'pz-setup' },
    h('h1', {}, 'Planetziods'),
    lead,
    row('Rules', rules), row('Your name', name), row('Computer players', computers), row('How well they play', level), row('Neutral planets', neutral), row('Galaxy size', size), row('Turn limit', limit), limitNote, row('Neutral planets make ships', grow),
    problem, h('div', { class: 'row-buttons' }, start, cont)));
  on(start, 'click', () => {
    const [w, hh] = size.value === 's' ? [12, 9] : size.value === 'l' ? [22, 15] : [16, 12];
    try {
      const n = Number(computers.value);
      const g = newGame({
        people: [name.value.trim() || 'You'],
        computers: COMPUTER_NAMES.slice(0, n).map(c => ({ name: c, level: level.value as 'easy' | 'normal' | 'hard' })),
        neutral: Math.max(2, Math.min(30, Number(neutral.value) || 12)), width: w, height: hh, maxTurns: Number(limit.value), neutralProduction: grow.checked,
        rules: rules.value === 'trade' ? 'trade' : 'classic',
      });
      void play(app, g);
    } catch (error) {
      problem.textContent = error instanceof Error ? error.message : 'The game could not start.';
    }
  }, app.signal);
  if (cont && saved) on(cont, 'click', () => void play(app, saved), app.signal);
  start.focus();
}

async function play(app: AppHandle, g: Game): Promise<void> {
  const shell = app.shell;
  const human = g.players.find(p => p.ai === null)?.id ?? 0;
  const trade = g.rules === 'trade';
  let from: number | null = null;
  let to: number | null = null;
  let hover: number | null = null;
  /** Orders this turn, so they can be taken back before End turn. */
  const orders: Array<(typeof g.fleets)[number]> = [];
  /** The answer to the last thing you did (a trade asked for, an offer answered). */
  let said = '';

  const canvas = h('canvas', { class: 'pz-map', 'aria-label': 'Galaxy map. Click a planet of yours, then a planet to send ships to.', tabindex: '0' });
  const ctx = canvas.getContext('2d')!;
  const turnLine = h('div', { class: 'pz-turn' });
  const info = h('div', { class: 'pz-info' });
  const ships = h('input', { type: 'number', class: 'field num', min: 1, value: 1, 'aria-label': 'Ships to send' });
  const sendBtn = h('button', { type: 'button', class: 'btn primary' }, 'Send');
  const defendBtn = h('button', { type: 'button', class: 'btn' }, 'Defend');
  const tradeBtn = h('button', { type: 'button', class: 'btn' }, 'Propose trade');
  const endTradeBtn = h('button', { type: 'button', class: 'btn' }, 'End this trade');
  const undoBtn = h('button', { type: 'button', class: 'btn' }, 'Take back');
  const endBtn = h('button', { type: 'button', class: 'btn pz-end' }, 'End turn');
  const order = h('div', { class: 'pz-order' });
  const answer = h('div', { class: 'pz-answer', role: 'status' });
  const table = h('table', { class: 'pz-table' });
  const relations = h('div', { class: 'pz-relations' });
  const offers = h('div', { class: 'pz-offers' });
  const log = h('div', { class: 'pz-log', 'aria-live': 'polite' });
  // The match bar sits at the top of the side panel, so it never scrolls out of sight: Menu keeps this match for
  // Continue, Restart plays the same settings on a new galaxy, Quit match ends it.
  const menuBtn = h('button', { type: 'button', class: 'btn pz-mini' }, 'Menu');
  const restartBtn = h('button', { type: 'button', class: 'btn pz-mini' }, 'Restart');
  const quitBtn = h('button', { type: 'button', class: 'btn pz-mini' }, 'Quit match');
  const bar = h('div', { class: 'pz-bar', role: 'toolbar', 'aria-label': 'Match' }, menuBtn, restartBtn, quitBtn);
  const side = h('div', { class: 'pz-side' }, bar, turnLine, table, ...(trade ? [offers] : []),
    h('h3', {}, 'Send a fleet'), order, h('div', { class: 'pz-send' }, ships, sendBtn, ...(trade ? [defendBtn] : []), undoBtn),
    ...(trade ? [h('div', { class: 'pz-send' }, tradeBtn, endTradeBtn)] : []), answer, info, endBtn,
    ...(trade ? [h('h3', {}, 'What they think of you'), relations] : []), h('h3', {}, 'News'), log);
  app.root.replaceChildren(h('div', { class: 'pz-game' }, h('div', { class: 'pz-stage' }, canvas), side));

  // ---- Geometry ----
  let cell = 40;
  let ox = 0;
  let oy = 0;
  const centre = (p: Planet) => [ox + (p.x + 0.5) * cell, oy + (p.y + 0.5) * cell] as const;
  function layout() {
    const r = canvas.parentElement!.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(r.width * dpr));
    canvas.height = Math.max(1, Math.floor(r.height * dpr));
    canvas.style.width = `${r.width}px`;
    canvas.style.height = `${r.height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cell = Math.max(16, Math.min((r.width - 16) / g.width, (r.height - 16) / g.height));
    ox = (r.width - cell * g.width) / 2;
    oy = (r.height - cell * g.height) / 2;
    draw();
  }

  // ---- Drawing ----
  const stars: Array<[number, number, number]> = [];
  for (let i = 0; i < 160; i++) stars.push([(Math.sin(i * 12.9898 + g.seed) * 43758.5453) % 1, (Math.sin(i * 78.233 + g.seed) * 12345.678) % 1, (i % 3) + 1]);

  function shape(x: number, y: number, r: number, kind: (typeof SHAPES)[number]) {
    ctx.beginPath();
    if (kind === 'circle') ctx.arc(x, y, r, 0, Math.PI * 2);
    else if (kind === 'square') ctx.rect(x - r, y - r, r * 2, r * 2);
    else {
      const n = kind === 'triangle' ? 3 : kind === 'diamond' ? 4 : kind === 'hexagon' ? 6 : 10;
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + (i * Math.PI * 2) / n;
        const rr = kind === 'star' && i % 2 ? r * 0.45 : r;
        ctx[i ? 'lineTo' : 'moveTo'](x + Math.cos(a) * rr, y + Math.sin(a) * rr);
      }
      ctx.closePath();
    }
  }

  function draw() {
    const w = canvas.width / (window.devicePixelRatio || 1);
    const hh = canvas.height / (window.devicePixelRatio || 1);
    ctx.fillStyle = '#070b1a';
    ctx.fillRect(0, 0, w, hh);
    for (const [sx, sy, s] of stars) {
      ctx.fillStyle = `rgba(255,255,255,${0.2 + s * 0.15})`;
      ctx.fillRect(Math.abs(sx) * w, Math.abs(sy) * hh, s * 0.6, s * 0.6);
    }
    ctx.strokeStyle = 'rgba(120,140,200,0.12)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= g.width; i++) {
      ctx.beginPath();
      ctx.moveTo(ox + i * cell, oy);
      ctx.lineTo(ox + i * cell, oy + g.height * cell);
      ctx.stroke();
    }
    for (let j = 0; j <= g.height; j++) {
      ctx.beginPath();
      ctx.moveTo(ox, oy + j * cell);
      ctx.lineTo(ox + g.width * cell, oy + j * cell);
      ctx.stroke();
    }
    // Trade routes: a gold line between the two worlds, with a small diamond at its middle.
    for (const r of g.routes ?? []) {
      const [ax, ay] = centre(g.planets[r.a]);
      const [bx, by] = centre(g.planets[r.b]);
      ctx.strokeStyle = 'rgba(245,197,66,0.75)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.fillStyle = '#f5c542';
      shape((ax + bx) / 2, (ay + by) / 2, cell * 0.08, 'diamond');
      ctx.fill();
    }
    ctx.lineWidth = 1;
    // Fleets in flight: a line from where they left to where they go, and a marker at where they are now.
    for (const f of g.fleets) {
      const a = g.planets[f.from];
      const b = g.planets[f.to];
      const [ax, ay] = centre(a);
      const [bx, by] = centre(b);
      const total = travel(a, b);
      const done = Math.min(1, Math.max(0, (total - (f.arrives - g.turn)) / total));
      ctx.strokeStyle = `${COLOURS[f.owner % COLOURS.length]}66`;
      ctx.setLineDash(f.mode === 'defend' ? [1, 3] : [4, 4]);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.setLineDash([]);
      const fx = ax + (bx - ax) * done;
      const fy = ay + (by - ay) * done;
      ctx.fillStyle = COLOURS[f.owner % COLOURS.length];
      shape(fx, fy, cell * 0.12, SHAPES[f.owner % SHAPES.length]);
      ctx.fill();
    }
    // The order being made.
    if (from !== null && to !== null) {
      const [ax, ay] = centre(g.planets[from]);
      const [bx, by] = centre(g.planets[to]);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    for (const p of g.planets) {
      const [x, y] = centre(p);
      const r = cell * (0.22 + Math.min(0.12, p.production / 120));
      const colour = p.owner >= 0 ? COLOURS[p.owner % COLOURS.length] : '#8a8f9c';
      const grad = ctx.createRadialGradient(x - r / 3, y - r / 3, r / 5, x, y, r);
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.25, colour);
      grad.addColorStop(1, '#0b1020');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      if (p.owner >= 0) {
        // The owner's shape, small, at the top right: the second channel beside colour.
        ctx.fillStyle = colour;
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1;
        shape(x + r * 0.9, y - r * 0.9, cell * 0.1, SHAPES[p.owner % SHAPES.length]);
        ctx.fill();
        ctx.stroke();
      }
      // Ships stationed here by other players: their shape and number at the top left.
      (p.guests ?? []).forEach((gst, i) => {
        const gx = x - r * 0.9 - i * cell * 0.3;
        ctx.fillStyle = COLOURS[gst.owner % COLOURS.length];
        ctx.strokeStyle = '#000';
        shape(gx, y - r * 0.9, cell * 0.09, SHAPES[gst.owner % SHAPES.length]);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.font = `${Math.max(9, cell * 0.18)}px system-ui, sans-serif`;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(gst.ships), gx - cell * 0.11, y - r * 0.9);
      });
      if (p.id === from || p.id === to || p.id === hover) {
        ctx.strokeStyle = p.id === from ? '#ffffff' : p.id === to ? '#ffd54a' : 'rgba(255,255,255,.5)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, r + 4, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.font = `bold ${Math.max(10, cell * 0.3)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // A dark rim round the letter: white alone was lost on the pale neutral planets.
      ctx.save();
      ctx.lineJoin = 'round';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(8, 12, 28, .9)';
      ctx.strokeText(p.name, x, y);
      ctx.restore();
      ctx.fillStyle = '#ffffff';
      ctx.fillText(p.name, x, y);
      ctx.font = `${Math.max(9, cell * 0.22)}px system-ui, sans-serif`;
      ctx.fillStyle = '#cfd6ea';
      ctx.fillText(String(p.ships), x, y + r + Math.max(8, cell * 0.2));
    }
  }

  // ---- Panels ----
  const ownerName = (o: number) => (o < 0 ? 'Nobody' : `${g.players[o].name} ${SHAPE_NAMES[o % SHAPE_NAMES.length]}`);
  const personaOf = (o: number) => (o >= 0 && g.players[o].persona ? TEMPERS[g.players[o].persona!] : null);
  /** Ships you can send from a planet: your own planet's, or those you have stationed there. */
  const have = (p: Planet) => (p.owner === human ? p.ships : guestsOf(p, human));
  function planetText(p: Planet): string {
    const base = `${p.name}: ${ownerName(p.owner)}. ${plural(p.ships, 'ship')}, makes ${p.production} a turn, strength ${Math.round(p.strength * 100)}%.`;
    if (!trade) return base;
    const m = mined(g, p);
    const parts = [base, `Mines ${p.iron} iron and ${p.energy} energy${routeOf(g, p.id) ? `; after trade ${m.iron} and ${m.energy}` : ''}: it builds as many ships as the scarcer allows.`];
    const r = routeOf(g, p.id);
    if (r) parts.push(`Trade: ${routeText(g, r)}.`);
    for (const x of p.guests ?? []) parts.push(`${plural(x.ships, 'ship')} of ${g.players[x.owner].name} stationed here.`);
    const t = personaOf(p.owner);
    if (t) parts.push(`${g.players[p.owner].name} is a ${t.name}: ${t.about}`);
    return parts.join(' ');
  }
  /** What a planet would build a turn with this route added. */
  function buildsWith(id: number, r: Route): number {
    const m = mined(g, g.planets[id]);
    const sign = id === r.a ? -1 : 1;
    m[r.res] += sign * r.amount;
    m[other(r.res)] -= sign * r.amount;
    return Math.max(0, Math.min(m.iron, m.energy));
  }
  function orderText(a: Planet | null, b: Planet | null): string {
    if (!a) return 'Click one of your planets to send from.';
    const from = a.owner === human ? `${a.name} (${plural(a.ships, 'ship')})` : `your ${plural(have(a), 'ship')} at ${a.name}`;
    if (!b) return `From ${from}. Now click where to send them.`;
    const line = `From ${a.name} to ${b.name}: ${plural(travel(a, b), 'turn')} away.`;
    if (!trade || b.owner < 0 || b.owner === human) return line;
    const extra: string[] = [];
    if (allied(g, human, b.owner)) extra.push(`${g.players[b.owner].name} is your ally: Defend stations your ships there; attacking would break the alliance.`);
    else if (canDefend(g, human, b.id)) extra.push(`${g.players[b.owner].name} trades with you: you can attack or defend.`);
    if (a.owner === human) {
      const swap = !routeOf(g, a.id) && !routeOf(g, b.id) ? bestSwap(g, a.id, b.id) : null;
      if (swap) extra.push(`A trade would send ${swap.route.amount} ${swap.route.res} from ${a.name} for ${swap.route.amount} ${other(swap.route.res)}: ${a.name} +${swap.gainA}, ${b.name} +${swap.gainB} ships a turn.`);
    }
    return [line, ...extra].join(' ');
  }
  function relationsPanel() {
    const rows = g.players.filter(p => p.persona).map(p => {
      const op = g.opinion![p.id][human];
      const chip = h('span', { class: 'pz-chip' }, SHAPE_NAMES[p.id % SHAPE_NAMES.length]);
      chip.style.color = COLOURS[p.id % COLOURS.length];
      const status = p.out ? 'Out' : allied(g, human, p.id) ? 'Ally' : trading(g, human, p.id) ? 'Trading' : '';
      const ask = h('button', { type: 'button', class: 'btn pz-mini', title: `Ask ${p.name} to be allies` }, 'Ally?');
      ask.hidden = p.out || g.players[human].out || allied(g, human, p.id) || g.over;
      on(ask, 'click', () => {
        said = proposeAlliance(g, human, p.id).text;
        refresh();
      }, app.signal);
      return h('tr', { class: p.out ? 'out' : '' },
        h('td', {}, chip, ` ${p.name}`, h('span', { class: 'pz-persona' }, ` ${TEMPERS[p.persona!].name}`)),
        h('td', { title: `${p.name} thinks ${op} of you (0 to 10)` }, `${op} ${mood(op)}`),
        h('td', {}, status),
        h('td', {}, ask));
    });
    relations.replaceChildren(h('table', { class: 'pz-table' }, ...rows), h('p', { class: 'pz-note' }, `An alliance holds at most ${teamCap(g)} of the ${g.players.length} players.`));
  }
  function offersPanel() {
    const mine = (g.offers ?? []).filter(o => o.to === human);
    offers.hidden = !mine.length;
    offers.replaceChildren(h('h3', {}, mine.length === 1 ? 'An offer' : `${mine.length} offers`), h('p', { class: 'pz-note' }, 'Unanswered offers count as a no at End turn.'),
      ...mine.map(o => {
        const text = o.kind === 'alliance'
          ? `${g.players[o.from].name} asks you to be allies.`
          : `${g.players[o.from].name} offers: ${routeText(g, o.route!)}. ${g.planets[o.route!.b].name} would build ${buildsWith(o.route!.b, o.route!)} a turn instead of ${g.planets[o.route!.b].production}.`;
        const yes = h('button', { type: 'button', class: 'btn primary pz-mini' }, 'Accept');
        const no = h('button', { type: 'button', class: 'btn pz-mini' }, 'No');
        on(yes, 'click', () => {
          said = acceptOffer(g, o.id).text;
          refresh();
        }, app.signal);
        on(no, 'click', () => {
          rejectOffer(g, o.id);
          said = `You said no to ${g.players[o.from].name}.`;
          refresh();
        }, app.signal);
        return h('div', { class: 'pz-offer' }, h('p', {}, text), h('div', { class: 'pz-send' }, yes, no));
      }));
  }
  function panels() {
    turnLine.textContent = `Turn ${g.turn}${g.maxTurns ? ` of ${g.maxTurns}` : ''}${trade ? ' · Trade & Trust' : ''}`;
    table.replaceChildren(h('tr', {}, h('th', {}, 'Player'), h('th', {}, 'Planets'), h('th', {}, 'Ships'), h('th', {}, 'Makes')),
      ...standings(g).map(s => {
        const chip = h('span', { class: 'pz-chip' }, SHAPE_NAMES[s.player.id % SHAPE_NAMES.length]);
        chip.style.color = COLOURS[s.player.id % COLOURS.length];
        const tag = s.player.ai ? (trade && allied(g, human, s.player.id) ? ' (ally)' : '') : ' (you)';
        return h('tr', { class: s.player.out ? 'out' : '' }, h('td', {}, chip, ` ${s.player.name}${tag}`), h('td', {}, String(s.planets)), h('td', {}, String(s.ships)), h('td', {}, String(s.production)));
      }));
    const a = from !== null ? g.planets[from] : null;
    const b = to !== null ? g.planets[to] : null;
    order.textContent = orderText(a, b);
    ships.max = a ? String(have(a)) : '1';
    const other = !!b && b.owner >= 0 && b.owner !== human;
    sendBtn.textContent = trade && other ? 'Attack' : 'Send';
    sendBtn.disabled = !a || !b || g.over;
    defendBtn.hidden = !trade || !b || !canDefend(g, human, b.id);
    defendBtn.disabled = !a || g.over;
    tradeBtn.hidden = !trade || !a || !b || a.owner !== human || !other;
    tradeBtn.disabled = g.over;
    endTradeBtn.hidden = !trade || !a || a.owner !== human || !routeOf(g, a.id) || g.over;
    undoBtn.disabled = !orders.length;
    endBtn.disabled = g.over;
    answer.textContent = said;
    answer.hidden = !said;
    const shown = hover !== null ? g.planets[hover] : b ?? a;
    info.textContent = shown ? planetText(shown) : 'Point at a planet to see it.';
    if (trade) {
      relationsPanel();
      offersPanel();
    }
    const lines = g.reports.filter(r => r.player === -1 || r.player === human).slice(-40).reverse();
    log.replaceChildren(...lines.map(r => h('p', {}, h('span', { class: 'pz-t' }, `T${r.turn} `), r.text)));
    app.setTitle(`Planetziods - turn ${g.turn}`);
  }

  function refresh() {
    panels();
    draw();
  }

  // ---- Playing ----
  const planetAt = (e: MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    let best: Planet | null = null;
    let bestD = cell * 0.6;
    for (const p of g.planets) {
      const [x, y] = centre(p);
      const d = Math.hypot(x - mx, y - my);
      if (d < bestD) {
        best = p;
        bestD = d;
      }
    }
    return best;
  };
  on(canvas, 'click', (e: MouseEvent) => {
    const p = planetAt(e);
    if (!p || g.over) return;
    said = '';
    // First click: your planet to send from (or an ally's where you have ships stationed). Second: where to (your own
    // planet too, to reinforce it). Same planet: clear.
    if (from === null) {
      if (!have(p) && p.owner !== human) return void (order.textContent = `${p.name} is not yours. Start from one of your own planets.`);
      from = p.id;
      to = null;
      ships.value = String(Math.max(1, Math.floor(have(p) / 2)));
    } else if (p.id === from) {
      from = null;
      to = null;
    } else {
      to = p.id;
      ships.focus();
      ships.select();
    }
    refresh();
  }, app.signal);
  on(canvas, 'contextmenu', (e: MouseEvent) => {
    e.preventDefault();
    from = null;
    to = null;
    refresh();
  }, app.signal);
  on(canvas, 'mousemove', (e: MouseEvent) => {
    const id = planetAt(e)?.id ?? null;
    if (id !== hover) {
      hover = id;
      refresh();
    }
  }, app.signal);
  on(canvas, 'mouseleave', () => {
    hover = null;
    refresh();
  }, app.signal);

  async function doSend(mode: 'attack' | 'defend' = 'attack') {
    if (from === null || to === null) return;
    const n = Math.floor(Number(ships.value));
    const problem = orderProblem(g, human, from, to, n, mode);
    if (problem) {
      order.textContent = problem;
      return;
    }
    const target = g.planets[to].owner;
    if (trade && mode === 'attack' && allied(g, human, target)) {
      const ally = g.players[target].name;
      const sure = await shell.dialogs.confirm({
        title: `Attack your ally ${ally}?`,
        text: `This is a sneak attack. If ${ally} is still your ally when the fleet lands, the alliance ends, ${ally} thinks 0 of you, and every player who sees it thinks 2 less of you. Ships stationed on each other's planets go home. To help ${ally} instead, choose Defend.`,
        ok: 'Attack anyway',
        danger: true,
        cancel: 'Keep the alliance',
      });
      if (!sure || from === null || to === null) return;
    }
    orders.push(send(g, human, from, to, n, mode));
    from = null;
    to = null;
    said = '';
    refresh();
    canvas.focus();
  }
  function takeBack() {
    const last = orders.pop();
    if (!last) return;
    unsend(g, last);
    refresh();
  }
  async function finishTurn() {
    if (g.over) return;
    for (const p of g.players) if (p.ai) computerMoves(g, p.id);
    endTurn(g);
    orders.length = 0;
    from = null;
    to = null;
    said = '';
    refresh();
    try {
      await shell.fs.ensureFolder('/System', { hidden: true });
      await shell.fs.writeText(SAVE_PATH, JSON.stringify(g), { hidden: true });
    } catch {
      // Saving is a convenience; the game carries on.
    }
    if (g.players[human].out && !g.over) {
      // Out of the game: the computers play to the end quickly.
      while (!g.over && g.turn < 1000) {
        for (const p of g.players) if (p.ai) computerMoves(g, p.id);
        endTurn(g);
      }
      refresh();
    }
    if (g.over) {
      const team = g.winners ?? (g.winner === null ? [] : [g.winner]);
      const won = team.includes(human);
      const names = team.map(id => g.players[id].name);
      const text = won
        ? team.length > 1 ? `You and ${names.filter((_, i) => team[i] !== human).join(' and ')} won together on turn ${g.turn - 1}.` : `You won on turn ${g.turn - 1}.`
        : `${names.join(' and ')} won on turn ${g.turn - 1}.`;
      const again = await shell.dialogs.ask({
        title: won ? (team.length > 1 ? 'Your side won!' : 'You rule the galaxy!') : 'Game over',
        text,
        buttons: [{ label: 'New game', value: true, primary: true }, { label: 'Look at the map', value: false }],
        cancel: false,
      });
      if (again) showSetup(app, null);
    }
  }

  on(sendBtn, 'click', () => void doSend('attack'), app.signal);
  on(defendBtn, 'click', () => void doSend('defend'), app.signal);
  on(tradeBtn, 'click', () => {
    if (from === null || to === null) return;
    said = proposeTrade(g, human, from, to).text;
    refresh();
  }, app.signal);
  on(endTradeBtn, 'click', async () => {
    if (from === null) return;
    const r = routeOf(g, from);
    if (!r) return;
    const partner = g.planets[r.a].owner === human ? g.planets[r.b].owner : g.planets[r.a].owner;
    const ok = await shell.dialogs.confirm({ title: 'End this trade?', text: `${routeText(g, r)}. Ending it counts like turning down an offer: ${g.players[partner].name} thinks 1 less of you (never below 5 for this).`, ok: 'End the trade' });
    if (!ok || from === null) return;
    cancelRoute(g, human, from);
    said = 'The trade route is closed.';
    refresh();
  }, app.signal);
  on(undoBtn, 'click', takeBack, app.signal);
  on(endBtn, 'click', () => void finishTurn(), app.signal);
  on(ships, 'keydown', (e: KeyboardEvent) => e.key === 'Enter' && (e.preventDefault(), void doSend()), app.signal);
  const keep = async () => {
    try {
      await shell.fs.ensureFolder('/System', { hidden: true });
      await shell.fs.writeText(SAVE_PATH, JSON.stringify(g), { hidden: true });
    } catch {
      // Saving is a convenience; Continue then offers the last turn saved.
    }
  };
  on(menuBtn, 'click', async () => {
    if (!g.over) await keep();
    showSetup(app, g.over ? null : g);
  }, app.signal);
  on(restartBtn, 'click', async () => {
    if (!g.over && !await shell.dialogs.confirm({ title: 'Restart', text: 'Start again with the same players and settings, on a new galaxy? This match ends.', ok: 'Restart' })) return;
    void play(app, newGame(setupOf(g)));
  }, app.signal);
  on(quitBtn, 'click', async () => {
    if (!g.over && !await shell.dialogs.confirm({ title: 'Quit match', text: 'End this match? It is not kept, so it cannot be continued.', ok: 'Quit match' })) return;
    await shell.fs.remove([SAVE_PATH]).catch(() => undefined);
    showSetup(app, null);
  }, app.signal);
  on(app.root, 'keydown', (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === 'Escape') {
      from = null;
      to = null;
      refresh();
    } else if (e.key.toLowerCase() === 'e' && !e.ctrlKey) void finishTurn();
  }, app.signal);
  const ro = new ResizeObserver(layout);
  ro.observe(canvas.parentElement!);
  app.signal.addEventListener('abort', () => ro.disconnect(), { once: true });
  panels();
  layout();
  canvas.focus();
}
