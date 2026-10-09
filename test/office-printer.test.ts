// Office Printer (public/office-printer/): the story in script.json holds together, every ending can be reached,
// the written lines are there word for word, the numbers the printers quote are worked out, and the game's code keeps
// the same rules as TOMLIN OS's own (no HTML from text, no code from text, nothing leaves the site).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { alertFor, fileOfWindow } from '../src/apps/printer/entry.ts';

const GAME = join(import.meta.dirname, '..', 'public', 'office-printer');
const load = (file: string): Promise<any> => import(pathToFileURL(join(GAME, 'js', file)).href);
const engine = await load('engine.js');
const binary = await load('binary.js');
const tos = await load('tos.js');
const facts = await load('facts.js');
const llm = await load('llm.js');
const { RENDERS } = await load('renders.js');
const scriptText = readFileSync(join(GAME, 'script.json'), 'utf8');
const script = JSON.parse(scriptText);

const NOW = new Date(2026, 8, 28, 12, 0, 0);

// ---- The shape of the story ------------------------------------------------------------------------------------------

const targetsOf = (node: any): string[] => {
  const out: string[] = [];
  const add = (next: any) => {
    if (next == null) return;
    if (typeof next === 'string') out.push(next);
    else for (const entry of next) out.push(entry.to);
  };
  for (const r of node.redirect ?? []) out.push(r.to);
  add(node.next);
  for (const c of node.choices ?? []) add(c.next);
  return out;
};

test('every way on leads to a node that exists, and every node can be reached', () => {
  const seen = new Set<string>();
  const queue = [script.start, script.tosStart, 'warranty_buy', 'jam_1'];
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    assert.ok(script.nodes[id], `a way on leads to "${id}", which does not exist`);
    seen.add(id);
    queue.push(...targetsOf(script.nodes[id]));
  }
  assert.deepEqual(Object.keys(script.nodes).filter(id => !seen.has(id)), [], 'nodes nothing leads to');
});

test('each beat offers two choices (the Hamlet quiz offers four), and each beat without choices ends or moves on', () => {
  for (const [id, node] of Object.entries<any>(script.nodes)) {
    const choices = node.choices ?? [];
    if (choices.length) {
      assert.equal(choices.length, node.quiz ? 4 : 2, `${id} offers ${choices.length} choices`);
      for (const c of choices) assert.ok(c.label && c.next, `${id}: a choice without a label or a way on`);
      assert.ok(!node.ending && !node.next, `${id} has choices and also ends or moves on`);
    } else {
      assert.ok(node.ending || node.next, `${id} neither offers a choice nor ends nor moves on`);
    }
  }
});

test("the script uses the design's shape: speaker, text, choices { label, next, effects }, setInk, bounce, ending, render:<effect>", () => {
  const nodeKeys = new Set(['speaker', 'bounce', 'redirect', 'text', 'choices', 'next', 'ending', 'quiz']);
  for (const [id, node] of Object.entries<any>(script.nodes)) {
    for (const key of Object.keys(node)) assert.ok(nodeKeys.has(key), `${id}: unexpected "${key}"`);
    for (const c of node.choices ?? []) for (const key of Object.keys(c)) assert.ok(['label', 'next', 'effects', 'if'].includes(key), `${id}: choice key "${key}"`);
  }
  assert.ok(scriptText.includes('"setInk": { "c": 0 }'));
  assert.ok(scriptText.includes('"render:testPage"'));
  assert.ok(scriptText.includes('"bounce": "inkjet"'));
  assert.deepEqual(engine.stepOf('render:testPage'), { render: 'testPage' });
  assert.deepEqual(engine.stepOf('ending:the-jam'), { ending: 'the-jam' });
  assert.deepEqual(engine.stepOf('bounce:photo'), { bounce: 'photo' });
  assert.deepEqual(engine.stepOf("Sorry, I'm busy."), { line: "Sorry, I'm busy." });
});

test('every effect is one the game knows, every picture exists, every speaker exists, every ending exists', () => {
  const known = new Set(['line', 'say', 'by', 'if', 'style', 'render', 'note', 'mood', 'know', 'flag', 'setInk', 'printer', 'wait', 'sound', 'mock', 'gossip', 'roast', 'warranty', 'bounce', 'ending']);
  const renderParams = new Set(['pep', 'cyan', 'mode', 'message', 'header', 'doc', 'later', 'done', 'final', 'count', 'loop', 'infamous', 'text']);
  const checkSteps = (where: string, steps: any[]) => {
    for (const raw of steps) {
      const step = engine.stepOf(raw);
      for (const key of Object.keys(step)) {
        assert.ok(known.has(key) || (step.render && renderParams.has(key)), `${where}: unknown step key "${key}"`);
      }
      if (step.render) assert.ok(RENDERS[step.render], `${where}: no picture called "${step.render}"`);
      if (step.by) assert.ok(script.speakers[step.by], `${where}: no speaker "${step.by}"`);
      if (step.bounce) assert.ok(script.speakers[step.bounce], `${where}: no machine "${step.bounce}"`);
      if (step.ending) assert.ok(script.endings.some((e: any) => e.id === step.ending), `${where}: no ending "${step.ending}"`);
    }
  };
  const endingIds = new Set(script.endings.map((e: any) => e.id));
  for (const [id, node] of Object.entries<any>(script.nodes)) {
    if (node.speaker && node.speaker !== '@current') assert.ok(script.speakers[node.speaker], `${id}: no speaker "${node.speaker}"`);
    if (node.bounce) assert.ok(script.speakers[node.bounce], `${id}: no machine "${node.bounce}"`);
    if (node.ending) assert.ok(endingIds.has(node.ending), `${id}: no ending "${node.ending}"`);
    checkSteps(id, engine.textOf(node));
    for (const c of node.choices ?? []) checkSteps(`${id} > ${c.label}`, c.effects ?? []);
  }
});

test('the 20 endings, in order, with their titles and descriptions', () => {
  const titles = ['The Cyan Loop', 'Calibrated', 'Straight to the Fridge', 'Lost in Translation', 'PC LOAD LETTER', 'Comic Sans', 'For the Environment',
    'Collective Bargaining', 'Speed Reader', 'Firmware', 'Technically Correct', 'The Queue', 'Extended Warranty', 'A4 Is Letter', 'Transparent',
    'The Wrong Document', 'Clause 212.1', 'Infamous', 'The Jam', 'Love Story'];
  assert.deepEqual(script.endings.map((e: any) => e.title), titles);
  assert.deepEqual(script.endings.map((e: any) => e.n), titles.map((_, i) => i + 1));
  const texts = ['Trapped cycling the network forever.', 'The test page uses all the cyan.', 'The image goes on the fridge.',
    'Dot matrix prints binary that decodes to "TRY FAX".', 'No explanation, ever.', 'Printed, offended.', '400 blank pages.',
    'Printer, scanner and fax go on strike.', 'Fails the Hamlet quiz.', '40-minute update, then out of cyan.', 'Prints the file icon and filename.',
    'Position 1,278,975.', 'Bought it, covers nothing.', 'Loses the paper-size argument.', '.png prints nothing.',
    'It finally prints, and it\'s the wrong file.', 'Found the trapped printer in the ToS.', 'Every printer on the network knows you.',
    'The paper rips, every time.', 'The printer falls for your laptop and prints only for it.'];
  assert.deepEqual(script.endings.map((e: any) => e.text), texts);
});

test('the lines of the design are in the script word for word', () => {
  const lines = [
    "Sorry, I'm busy.", 'Redirecting you to the next available machine.', 'Linda_Birthday_Card_FINAL.pdf',
    "Oh! Hi! Sorry! I'm so sorry. I've got cyan! I've got LOTS of cyan! Before I print, I need to calibrate.",
    "I'm going to pretend you said 'sure'.", 'Printing test page...',
    "Calibration complete. Colour accuracy: perfect. Unfortunately, I'm out of cyan. So sorry. Do you hate me?",
    "You're just saying that.", 'What is this... a PDF? From *Word*? At 96 DPI?', 'Everything, darling.',
    'Printing pixel 1 of {pixels}, page 1 of 1...', 'Going well. Real good progress.', "Rude. I'll be telling the others.",
    'HEARD ABOUT YOU. NO HABLO PDF, SEÑOR.', 'Printed, as requested.', 'Per my last print job', "Oh, you're back.",
    'Which version of Word? No, which version *exactly*?', 'Transparent background detected. Printing nothing, as requested.',
    'Finally, someone with taste.', "Absolutely not. I've seen what those do.", 'Please load A4.', "That's Letter.",
    'It\'s humid in here. Have you considered a dehumidifier?', 'Double-sided printing prints both sides onto the same side.',
    'PC LOAD LETTER', 'Oh, did you make this? Straight to the fridge.', "Didn't even name it.", 'Absolutely not.',
    'The Printer is not responsible for cyan.', '\\"Letter\\" and \\"A4\\" are the same thing when the Printer says so.',
    'The Printer may share print history with other printers for \\"gossip purposes\\".',
    'If you are reading this, you are the only one. Please send help.',
    'You read {words} words in {seconds} seconds. Impressive. Liar.', 'Speed-reading, are we? Clause 88 was about you.',
    "You actually read it? Nobody reads it. I didn't even read it.", 'You read all that in {seconds} seconds?', 'Really?',
    "What was the name of Hamlet's father's ghost's favourite printer?", 'It was me. I was there.',
    'Thank you for your honesty. Clause 12 says honesty costs $4.99.', 'TRY FAX', 'HELP I AM TRAPPED IN A CANON',
    '$89.99', 'everything except ink, paper, jams, print heads, and printing',
    'Quarterly_Report_FINAL_v3.pdf', 'Most Attempts', '1278975', '14 years', 'Calibration complete. Colour accuracy: perfect.',
    'I have printed 400 blank pages', '47 PAGES. ONE COLUMN EACH.', 'Printed at 12 × 12 pixels, as intended.',
  ];
  for (const line of lines) assert.ok(scriptText.includes(line), `missing: ${line}`);
});

// ---- Playing it through ------------------------------------------------------------------------------------------------

/** Plays one run through the rules (no page): picks each choice by its label, returns the ending reached. */
function play(save: any, labels: string[], opts: { file?: any; entry?: string; tos?: any } = {}) {
  save.attempts += 1;
  const file = opts.file ?? { name: 'Quarterly_Report_FINAL_v3.pdf', ext: '.pdf', kind: 'pdf', sample: 'report' };
  const run = engine.newRun(script, file, opts.entry ?? script.start);
  const g = { script, save, run, env: { now: NOW, device: 'laptop' } };
  const said: string[] = [];
  let ended: string | null = null;
  const doSteps = (node: any, steps: any[]) => {
    for (const raw of steps) {
      const step = engine.stepOf(raw);
      if (step.if && !engine.holds(step.if, g)) continue;
      if (step.line != null) said.push(engine.fill(step.line, g));
      else if (step.ending) {
        ended = step.ending;
        return;
      } else if (step.bounce) run.at = step.bounce;
      else if (step.say) said.push(engine.fill(step.say, g));
      else if (step.render === 'tos') run.tos = { words: 47000, ...opts.tos };
      else if (step.gossip) {
        const who = engine.speakerOf(node.speaker, g);
        const heard = engine.gossipFor(script, save, who);
        if (heard) {
          engine.tell(save, who, heard.note);
          said.push(heard.line);
        }
      } else if (step.mock) {
        const line = engine.mockLine(script, save);
        if (line) said.push(engine.fill(line, g));
      } else if (!step.render) engine.applyStep(step, g);
    }
  };
  let id = run.node;
  const todo = [...labels];
  for (let guard = 0; guard < 60; guard++) {
    const { id: real, node } = engine.resolve(script, g, id);
    if (node.bounce) run.at = node.bounce;
    doSteps(node, engine.textOf(node));
    const ending = ended ?? node.ending;
    if (ending) {
      engine.unlock(save, ending, '2026-09-28');
      return { ending, said, node: real };
    }
    const choices = engine.choicesOf(node, g);
    if (choices.length) {
      const label = todo.shift();
      const choice = choices.find((c: any) => c.label === label);
      assert.ok(choice, `at ${real}: no choice "${label}" (offered: ${choices.map((c: any) => c.label).join(' | ')})`);
      doSteps(node, choice.effects ?? []);
      if (ended) {
        engine.unlock(save, ended, '2026-09-28');
        return { ending: ended, said, node: real };
      }
      id = engine.nextOf(choice.next, g);
    } else {
      id = engine.nextOf(node.next, g);
    }
  }
  throw new Error('the run never ended');
}

const pdf = { name: 'Quarterly_Report_FINAL_v3.pdf', ext: '.pdf', kind: 'pdf', sample: 'report' };
const FAST = { seconds: 3.2, secret: false };

test('the example flow, word for word: Lost in Translation, then (Wait) Technically Correct', () => {
  const save = engine.newSave();
  const first = play(save, ['OK', 'Just print it', 'Next printer', "What's wrong with it?", 'Cancel']);
  assert.equal(first.ending, 'lost-in-translation');
  assert.deepEqual(first.said, [
    "Sorry, I'm busy.", 'Redirecting you to the next available machine.',
    "Oh! Hi! Sorry! I'm so sorry. I've got cyan! I've got LOTS of cyan! Before I print, I need to calibrate.",
    "I'm going to pretend you said 'sure'.", 'Printing test page...',
    "Calibration complete. Colour accuracy: perfect. Unfortunately, I'm out of cyan. So sorry. Do you hate me?",
    'What is this... a PDF? From *Word*? At 96 DPI?', 'Everything, darling.', 'Fine.',
    'Printing pixel 1 of 12,000,000, page 1 of 1...', 'Estimated completion: March 2031.', 'Going well. Real good progress.',
    "Rude. I'll be telling the others.", 'HEARD ABOUT YOU. NO HABLO PDF, SEÑOR.',
  ], 'the first run is the design\'s example exactly: no gossip or mocking added');
  const again = engine.newSave();
  const wait = play(again, ['OK', 'Sure', "It's fine", 'Please just print it', 'Wait']);
  assert.equal(wait.ending, 'technically-correct');
  assert.ok(wait.said.includes("You're just saying that."));
});

test('every one of the 20 endings can be reached, playing on from one saved game', () => {
  const save = engine.newSave();
  const runs: Array<[string, string[], any?]> = [
    ['lost-in-translation', ['OK', 'Just print it', 'Next printer', "What's wrong with it?", 'Cancel']],
    ['technically-correct', ['No', 'OK', 'Sure', "It's fine", 'Please just print it', 'Wait'], { tos: FAST }],
    ['the-queue', ["I'll wait", 'Keep waiting', 'Keep waiting']],
    ['extended-warranty', ["I'll wait", 'Keep waiting', 'Is there a faster way?', 'The Extended Warranty', 'Buy it']],
    ['the-jam', ["I'll wait", 'Keep waiting', 'Is there a faster way?', 'The Extended Warranty', 'No thanks']],
    ['infamous', ['Who told you?']],
    ['for-the-environment', ["I'll wait", 'Keep waiting', 'Is there a faster way?', 'Double-sided, for the environment', "That's just one side"]],
    ['calibrated', ["I'll wait", 'Find another printer', 'Connect', 'Could you calibrate?']],
    ['firmware', ["I'll wait", 'Find another printer', 'Connect', 'Connect to the next machine', 'Print it without magenta', 'Wait 40 minutes']],
    ['wrong-document', ['Finally!']],
    ['love-story', ['OK', 'Thanks, I think?']],
    ['collective-bargaining', ["I'll wait", 'Find another printer', 'Connect', 'Connect to the next machine', 'Connect to the next machine', 'Try the fax', 'Can you print my file?']],
    ['pc-load-letter', ["I'll wait", 'Find another printer', 'Connect', 'Connect to the next machine', 'Connect to the next machine', 'Connect to the next machine', 'What does your screen say?', 'What does that mean?']],
    ['a4-is-letter', ["I'll wait", 'Find another printer', 'Connect', 'Connect to the next machine', 'Connect to the next machine', 'Connect to the next machine', 'Connect to the next machine', 'Load A4', 'It says A4 on the box']],
    ['cyan-loop', ["I'll wait", 'Find another printer', 'Connect', 'Connect to the next machine', 'Connect to the next machine', 'Connect to the next machine', 'Connect to the next machine', 'Connect to the next machine', 'Connect to the next machine']],
    ['fridge', ['OK', 'Please just print it', 'Take it to the home printer'], { file: { name: 'IMG_4471.jpg', ext: '.jpg', kind: 'image', colour: 'cyan', width: 1600, height: 1200, pixels: 1920000 } }],
    ['transparent', ['OK'], { file: { name: 'logo_transparent.png', ext: '.png', kind: 'image', alpha: true, colour: 'blue' } }],
    ['comic-sans', ['OK', 'No idea', 'Why is it in Comic Sans?'], { file: { name: 'Minutes_Tuesday.docx', ext: '.docx', kind: 'doc' } }],
    ['clause-212', [], { entry: 'tos_intro', tos: { seconds: 40, secret: true } }],
    ['speed-reader', ['Yes', 'Yes', 'Yorick'], { entry: 'tos_intro', tos: { seconds: 0.8, secret: false } }],
  ];
  for (const [want, labels, opts] of runs) {
    const got = play(save, labels, opts ?? {});
    assert.equal(got.ending, want, `attempt ${save.attempts}: expected ${want}, reached ${got.ending}`);
  }
  assert.equal(engine.foundCount(script, save), 20);
  // And the other kinds of file: a spreadsheet, plain text, a program.
  assert.equal(play(save, ['OK', 'Can you fit it on one page?'], { file: { name: 'Budget_2026.xlsx', ext: '.xlsx', kind: 'sheet' } }).ending, 'technically-correct');
  assert.equal(play(save, ['OK', 'Print it, please'], { file: { name: 'notes.txt', ext: '.txt', kind: 'text' } }).ending, 'wrong-document');
  assert.equal(play(save, ['OK', "It's just a setup file"], { file: { name: 'setup.exe', ext: '.exe', kind: 'exe' } }).ending, 'collective-bargaining');
  assert.equal(play(save, ['OK', 'Print it anyway'], { file: { name: 'setup.exe', ext: '.exe', kind: 'exe' } }).ending, 'infamous');
});

test('the Terms of Service send each reading time to its reaction', () => {
  const route = (seconds: number, secret = false) => {
    const save = engine.newSave();
    save.attempts = 5;
    const run = engine.newRun(script, pdf, 'tos_intro');
    run.tos = { seconds, words: 47000, secret };
    return engine.nextOf(script.nodes.tos_intro.next, { script, save, run });
  };
  assert.equal(route(3.2), 'tos_liar');
  assert.equal(route(4.99), 'tos_liar');
  assert.equal(route(5), 'tos_speedy');
  assert.equal(route(29), 'tos_speedy');
  assert.equal(route(45), 'tos_ok');
  assert.equal(route(121), 'tos_read');
  assert.equal(route(2, true), 'tos_secret');
  const save = engine.newSave();
  const run = engine.newRun(script, pdf, 'tos_intro');
  run.tos = { seconds: 3.2, words: 47000, secret: false };
  assert.equal(engine.fill(script.tos.reactions.liar, { script, save, run }), 'You read 47,000 words in 3.2 seconds. Impressive. Liar.');
  run.tos.seconds = 2.04;
  assert.equal(engine.fill('You read all that in {seconds} seconds?', { script, save, run }), 'You read all that in 2 seconds?');
});

test('the Terms of Service are exactly 47,000 words, the same every time, with the written clauses in place', () => {
  const a = tos.buildTos(script.tos);
  const b = tos.buildTos(script.tos);
  assert.equal(a.words, 47000);
  assert.deepEqual(a, b);
  const all = a.sections.flatMap((s: any) => [`${s.n}. ${s.title}`, ...s.clauses.map((c: any) => `${c.n} ${c.text}`)]).join('\n');
  assert.equal(tos.countWords(all), 47000, 'counted the way the reader sees it');
  assert.equal(a.sections.length, 212);
  const clause = (n: string) => a.sections.flatMap((s: any) => s.clauses).find((c: any) => c.n === n)?.text;
  for (const [n, text] of Object.entries(script.tos.fixed)) assert.equal(clause(n), text, `clause ${n}`);
  const last = a.sections[a.sections.length - 1];
  assert.equal(last.clauses.at(-1).n, '212.1', 'clause 212.1 is the very last thing, just above I Agree');
  assert.ok(clause('212.1').includes(script.tos.secret.link));
});

// ---- Numbers the printers quote ------------------------------------------------------------------------------------------

test('the Photo Printer\'s estimate is worked out: 12,000,000 pixels from September 2026 is March 2031', () => {
  const props = script.props.pixels;
  assert.equal(engine.etaFor(NOW, 12000000, props), 'March 2031');
  assert.equal(engine.etaFor(new Date(2027, 0, 10), 12000000, props), 'July 2031');
  assert.equal(engine.formatNumber(1278975), '1,278,975');
  assert.equal(engine.formatSeconds(3.2), '3.2');
  assert.equal(engine.formatSeconds(2), '2');
});

test('mocking grows with the attempts: nothing the first time, polite, then "Oh, you\'re back.", then personal', () => {
  const save = engine.newSave();
  const at = (n: number) => {
    save.attempts = n;
    return engine.mockLine(script, save);
  };
  assert.equal(at(1), null);
  assert.ok(script.mockery.polite.includes(at(2)));
  assert.ok(script.mockery.polite.includes(at(3)));
  assert.equal(at(4), "Oh, you're back.");
  assert.ok(script.mockery.sarcastic.includes(at(7)));
  assert.ok(script.mockery.personal.includes(at(8)));
  assert.ok(script.mockery.personal.includes(at(40)));
});

test('gossip takes a run to get round, and each printer says each piece once', () => {
  const save = engine.newSave();
  save.attempts = 1;
  engine.applyStep({ note: 'cancelled' }, { script, save, run: engine.newRun(script, pdf) });
  const run = engine.newRun(script, pdf);
  engine.applyStep({ setInk: { c: 0 } }, { script, save, run });
  assert.equal(run.ink.laserjet.c, 0, 'setInk changes the printer you are at');
  assert.deepEqual(engine.inksOf({ setInk: { c: 0, m: 0 } }), ['c', 'm']);
  assert.equal(engine.gossipFor(script, save, 'laserjet'), null, 'not in the same run');
  save.attempts = 2;
  const heard = engine.gossipFor(script, save, 'laserjet');
  assert.equal(heard.note, 'cancelled');
  engine.tell(save, 'laserjet', heard.note);
  assert.equal(engine.gossipFor(script, save, 'laserjet'), null, 'said once');
  assert.ok(engine.gossipFor(script, save, 'inkjet'), 'the others still have it to say');
});

test('Linda\'s card gets to 400 on the tenth attempt, once; the warranty pops up on even attempts, once a run', () => {
  const save = engine.newSave();
  const copies = [];
  for (let n = 1; n <= 10; n++) {
    save.attempts = n;
    copies.push(engine.lindaCopy(script, save));
  }
  assert.deepEqual(copies, script.linda.copies);
  assert.ok(copies.includes(312), 'the design\'s "copy 312 of 400" comes up');
  save.known.lindaDone = true;
  for (let n = 10; n < 40; n++) {
    save.attempts = n;
    assert.ok(engine.lindaCopy(script, save) < 400);
  }
  const run = engine.newRun(script, pdf);
  save.attempts = 1;
  assert.equal(engine.warrantyDue(save, run), false, 'never on the first print');
  save.attempts = 2;
  assert.equal(engine.warrantyDue(save, run), true);
  run.warrantyShown = true;
  assert.equal(engine.warrantyDue(save, run), false, 'once a run');
  save.attempts = 3;
  assert.equal(engine.warrantyDue(save, engine.newRun(script, pdf)), false);
});

test('faster reading claims get longer works', () => {
  assert.equal(engine.workFor(script, 3.2).id, 'hamlet');
  assert.equal(engine.workFor(script, 2).id, 'hamlet');
  assert.equal(engine.workFor(script, 1.5).id, 'tragedies');
  assert.equal(engine.workFor(script, 0.5).id, 'complete');
});

test('the Photo Printer roasts a picture from its facts: name, colour, size', () => {
  const save = engine.newSave();
  const g = { script, save, run: null, env: { now: NOW } };
  const lines = engine.roastLines(script, { name: 'IMG_4471.jpg', colour: 'cyan', width: 1600, height: 1200, size: 180000 }, g);
  assert.deepEqual(lines, ["IMG_4471.jpg. Didn't even name it.", 'Mostly cyan. Absolutely not.']);
  const small = engine.roastLines(script, { name: 'holiday.png', colour: 'white', width: 120, height: 90, size: 9000 }, g);
  assert.deepEqual(small, ['Mostly white. So you want me to print... not much.', '120 × 90 pixels. That\'s a thumbnail.', '9 KB. That weighs less than my error log.']);
});

test('colours: cyan is cyan, see-through is counted, and a picture\'s main colour wins', () => {
  assert.equal(facts.colourOf(44, 198, 226), 'cyan');
  assert.equal(facts.colourOf(31, 59, 100), 'blue', 'the report\'s navy is not cyan');
  assert.equal(facts.colourOf(0, 163, 217), 'cyan');
  assert.equal(facts.colourOf(250, 250, 250), 'white');
  assert.equal(facts.colourOf(10, 10, 10), 'black');
  assert.equal(facts.colourOf(214, 0, 126), 'magenta');
  assert.equal(facts.colourOf(245, 196, 0), 'yellow');
  assert.equal(facts.colourOf(0, 0, 0, 0), 'transparent');
  const data = new Uint8ClampedArray([44, 198, 226, 255, 44, 198, 226, 255, 250, 250, 250, 255, 0, 0, 0, 0]);
  const p = facts.paletteOf(data);
  assert.equal(p.colour, 'cyan');
  assert.equal(p.clear, 0.25);
});

test('file kinds by extension; a saved game read back keeps only what makes sense', () => {
  assert.equal(engine.kindOf(script, 'a.PDF'), 'pdf');
  assert.equal(engine.kindOf(script, 'Minutes.docx'), 'doc');
  assert.equal(engine.kindOf(script, 'b.xlsx'), 'sheet');
  assert.equal(engine.kindOf(script, 'photo.JPEG'), 'image');
  assert.equal(engine.kindOf(script, 'setup.exe'), 'exe');
  assert.equal(engine.kindOf(script, 'song.mp3'), 'other');
  assert.equal(engine.kindOf(script, 'README'), 'other');
  const fresh = engine.newSave();
  assert.deepEqual(engine.loadSave('not json'), fresh);
  assert.deepEqual(engine.loadSave(null), fresh);
  const back = engine.loadSave({ attempts: 4.7, endings: { 'the-queue': { first: '2026-09-28', count: 2 } }, notes: { cancelled: { count: 1, since: 2 }, bad: 7 }, sound: 'yes', lastMessage: '2026-09-28' });
  assert.equal(back.attempts, 4);
  assert.deepEqual(back.notes, { cancelled: { count: 1, since: 2 } });
  assert.equal(back.sound, false);
  assert.equal(back.lastMessage, '2026-09-28');
});

test('the Dot Matrix\'s binary really decodes', () => {
  assert.deepEqual(binary.toBinary('TRY FAX'), ['01010100', '01010010', '01011001', '00100000', '01000110', '01000001', '01011000']);
  for (const message of ['TRY FAX', 'HELP I AM TRAPPED IN A CANON']) {
    assert.equal(binary.fromBinary(binary.binaryLines(message, 3).join('\n')), message);
  }
  assert.throws(() => binary.fromBinary('0101 2'), /eight/);
});

test('the language-model mode is a stub that answers with a canned line in the agreed shape', async () => {
  const answer = await llm.askPrinter({ printer: 'laserjet', lines: script.llmFallback }, 'please print');
  assert.ok(script.llmFallback.includes(answer.reply));
  assert.equal(answer.action, 'none');
  assert.equal(typeof answer.mood, 'string');
});

// ---- TOMLIN OS's doors into the game ------------------------------------------------------------------------------------

test('Ctrl+P prints the front window\'s file; folders, the printer and windows without a file give none', () => {
  assert.equal(fileOfWindow('editor', 'editor:/Documents/notes.txt'), '/Documents/notes.txt');
  assert.equal(fileOfWindow('photos', 'photos:/Pictures/IMG_1.jpg'), '/Pictures/IMG_1.jpg');
  assert.equal(fileOfWindow('explorer', 'explorer:/Documents'), null);
  assert.equal(fileOfWindow('printer', 'printer'), null);
  assert.equal(fileOfWindow('panel', 'panel'), null);
  assert.equal(fileOfWindow('calculator', 'calculator:'), null);
});

test("the printer's alert reads like Windows' failed print, names the last document, and offers Retry", () => {
  const day = (d: number) => new Date(Date.UTC(2026, 8, d, 12));
  const seen = new Set<string>();
  for (let d = 1; d <= 12; d++) seen.add(alertFor(script, { lastDoc: { name: 'memo.txt' } }, day(d)).text);
  assert.equal(seen.size, script.alert.lines.length, 'every line comes round');
  assert.ok([...seen].every(t => t.startsWith('memo.txt ')), 'the last document is named');
  const fresh = alertFor(script, {}, day(3));
  assert.equal(fresh.title, 'LaserJet (2nd floor)');
  assert.ok(fresh.text.startsWith('Quarterly_Report_FINAL_v3.pdf '), 'someone who never printed gets the report');
  assert.equal(script.alert.action, 'Retry');
});

test('the saved game remembers the last document (for Retry), and ignores a broken one', () => {
  assert.deepEqual(engine.loadSave({ lastDoc: { name: 'memo.txt', path: '/Documents/memo.txt' } }).lastDoc, { name: 'memo.txt', path: '/Documents/memo.txt', sample: null });
  assert.equal(engine.loadSave({ lastDoc: { name: 7 } }).lastDoc, null);
  assert.equal(engine.newSave().lastDoc, null);
});

// ---- The game's code keeps TOMLIN OS's rules ---------------------------------------------------------------------------------

test('the game writes no HTML from text, runs no code from text, and reaches no other site', () => {
  const dir = join(GAME, 'js');
  const banned: Array<[RegExp, string]> = [
    [/\binnerHTML\b/, 'innerHTML'], [/\bouterHTML\b/, 'outerHTML'], [/\binsertAdjacentHTML\b/, 'insertAdjacentHTML'],
    [/\bdocument\.write\b/, 'document.write'], [/\beval\s*\(/, 'eval'], [/\bnew\s+Function\b/, 'new Function'],
    [/\bsetTimeout\s*\(\s*['"`]/, 'setTimeout with a string'], [/\bsetAttribute\(\s*['"]style['"]/, 'a style attribute'],
    [/\.srcdoc\b/, 'srcdoc'], [/\bXMLHttpRequest\b/, 'XMLHttpRequest'], [/\bWebSocket\b/, 'WebSocket'],
    [/\bnavigator\.sendBeacon\b/, 'sendBeacon'], [/\bserviceWorker\b/, 'a service worker'],
  ];
  for (const name of readdirSync(dir)) {
    const code = readFileSync(join(dir, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
    for (const [pattern, label] of banned) assert.ok(!pattern.test(code), `${name} uses ${label}`);
    assert.equal(/\blocalStorage\b/.test(code), name === 'storage.js', `${name}: only the stand-alone page's storage.js may use localStorage`);
    assert.equal(/\bfetch\s*\(/.test(code), name === 'game.js', `${name}: only game.js may fetch (its own files)`);
    assert.deepEqual(code.match(/https?:\/\/[^\s'"`)]+/g) ?? [], [], `${name} names an outside address`);
  }
  const game = readFileSync(join(dir, 'game.js'), 'utf8');
  assert.ok(/fetch\(new URL\(path, BASE\)/.test(game), 'the one fetch reads a path inside the game folder');
  const page = readFileSync(join(GAME, 'index.html'), 'utf8');
  assert.ok(page.includes('http-equiv="Content-Security-Policy"'), 'the stand-alone page carries its own security policy');
  assert.ok(!/<script(?![^>]*\bsrc=)/.test(page) && !/\sstyle=/.test(page) && !/\son[a-z]+=/.test(page), 'no inline script, style or handler');
});
