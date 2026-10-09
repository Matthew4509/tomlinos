// The chat and AI upgrades of 0.1.04: each person's model list (favourites first, hidden ones out), "Disconnect when
// idle" (the built-in AI stops by itself after a while without a question, never while it is answering), the line under
// an answer (how long, how fast), and the "Good places to start" in Find AI models. A stand-in engine takes the
// graphics chip's place (Node has none). Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OnDevice, setEngineParts, BUILT_IN_MODELS, type LoadableModel } from '../src/apps/assistant/engine.ts';
import { cleanPrefs, orderModels, readPrefs, withFavourite, withHidden, writePrefs, NO_PREFS, PREFS_PATH } from '../src/apps/assistant/prefs.ts';
import { footWords, writingWords, type Pending } from '../src/apps/chat/live.ts';
import { pickBuild, SUGGESTED } from '../src/apps/assistant/suggest.ts';
import { MODEL_LIBS } from '../src/apps/assistant/modellibs.ts';
import { FileSystem } from '../src/fs/fs.ts';
import { MemoryStore } from '../src/store/memory-store.ts';

const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const model = (id: string): LoadableModel => ({ id, lib: `${id}.wasm`, bytes: 1, vram: 1, context: 4096, overrides: {} });
const log: string[] = [];
/** Milliseconds the stand-in takes for each word. */
let slow = 0;
setEngineParts({
  async make(m) {
    log.push(`start ${m.id}`);
    return {
      chat: {
        completions: {
          create: async () => (async function* () {
            for (const word of ['One', ' two', ' three']) {
              await tick(slow);
              yield { choices: [{ delta: { content: word } }] };
            }
            yield { choices: [], usage: { completion_tokens: 3, extra: { decode_tokens_per_s: 7.5 } } };
          })(),
        },
      },
      interruptGenerate() {},
      async unload() {
        log.push(`stop ${m.id}`);
      },
    };
  },
  async forget() {},
  async claim() {
    return () => undefined;
  },
});

// ---- Your model list ----

test('model choices: junk is dropped, a star and a hide cannot both hold, each id once', () => {
  assert.deepEqual(cleanPrefs(null), NO_PREFS);
  assert.deepEqual(cleanPrefs({ favourites: ['a', 'a', 7, '../x', 'b'], hidden: ['b', 'c'], idleDisconnect: 'yes' }),
    { favourites: ['a', 'b'], hidden: ['c'], idleDisconnect: false }, 'a favourite is never hidden; only true switches idle on');
  let p = withFavourite(NO_PREFS, 'm1', true);
  p = withFavourite(p, 'm2', true);
  assert.deepEqual(p.favourites, ['m1', 'm2'], 'in the order starred');
  p = withHidden(p, 'm1', true);
  assert.deepEqual([p.favourites, p.hidden], [['m2'], ['m1']], 'hiding takes the star off');
  p = withFavourite(p, 'm1', true);
  assert.deepEqual([p.favourites, p.hidden], [['m2', 'm1'], []], 'starring shows it again');
});

test('model list order: favourites first in starred order, hidden ones out (but never the one running, never all)', () => {
  const models = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const prefs = { favourites: ['c', 'a'], hidden: ['b'], idleDisconnect: false };
  assert.deepEqual(orderModels(models, prefs).map(m => m.id), ['c', 'a', 'd']);
  assert.deepEqual(orderModels(models, prefs, 'b').map(m => m.id), ['c', 'a', 'b', 'd'], 'the running one stays visible');
  assert.deepEqual(orderModels(models, { favourites: [], hidden: ['a', 'b', 'c', 'd'], idleDisconnect: false }).map(m => m.id), ['a', 'b', 'c', 'd'], 'all hidden = all shown');
  assert.deepEqual(orderModels(models, { favourites: ['gone'], hidden: [], idleDisconnect: false }).map(m => m.id), ['a', 'b', 'c', 'd'], 'a favourite no longer offered is skipped');
});

test('model choices are kept in the person\'s own hidden System folder, and read back', async () => {
  const fs = new FileSystem(new MemoryStore());
  assert.deepEqual(await readPrefs(fs), NO_PREFS, 'none yet');
  await writePrefs(fs, { favourites: ['x'], hidden: ['y'], idleDisconnect: true });
  assert.deepEqual(await readPrefs(fs), { favourites: ['x'], hidden: ['y'], idleDisconnect: true });
  assert.ok(PREFS_PATH.startsWith('/System/'));
});

// ---- Disconnect when idle ----

test('disconnect when idle: the model stops by itself after the quiet time, and says which one, so it can start again', async () => {
  log.length = 0;
  const ai = new OnDevice();
  await ai.load(model('gemma'), () => undefined);
  OnDevice.idleAfter(0.01); // 600 ms
  await tick(300);
  assert.equal(OnDevice.running()?.id, 'gemma', 'not yet');
  await tick(700);
  assert.equal(OnDevice.running(), null, 'stopped');
  assert.equal(OnDevice.lastStop(), 'idle');
  assert.equal(OnDevice.lastModel()?.id, 'gemma', 'the same one can start again');
  OnDevice.idleAfter(null);
  await ai.unload();
});

test('disconnect when idle never stops an answer being written; the quiet time counts from its end', async () => {
  log.length = 0;
  slow = 350; // three words: about a second of writing, longer than the quiet time
  const ai = new OnDevice();
  await ai.load(model('qwen'), () => undefined);
  OnDevice.idleAfter(0.01);
  const answer = await ai.ask([{ role: 'user', content: 'hi' }], () => undefined);
  assert.equal(answer.text, 'One two three', 'the whole answer came');
  assert.equal(OnDevice.running()?.id, 'qwen', 'still running right after the answer');
  await tick(900);
  assert.equal(OnDevice.lastStop(), 'idle', 'then stops once quiet');
  slow = 0;
  OnDevice.idleAfter(null);
  await ai.unload();
});

test('without "Disconnect when idle" the model keeps running', async () => {
  const ai = new OnDevice();
  await ai.load(model('kept'), () => undefined);
  OnDevice.idleAfter(null);
  await tick(700);
  assert.equal(OnDevice.running()?.id, 'kept');
  await ai.unload();
});

// ---- The line under an answer ----

test('the line under an answer: waiting, then speed and seconds; afterwards how long, where and how fast', () => {
  const p: Pending = { by: 'Gemma 2 2B', text: '', started: 0, first: null, pieces: 0, device: true };
  assert.equal(writingWords(p, 6400), 'Reading your question... 6 s');
  p.first = 8000;
  p.pieces = 11;
  assert.equal(writingWords(p, 10000), 'Writing: 5.0 pieces a second · 10 s', '10 pieces after the first, in 2 s');
  assert.equal(footWords(p, 10000), 'Answered in 10 s on this device · 5.0 pieces a second');
  assert.equal(footWords(p, 10000, 4.8), 'Answered in 10 s on this device · 4.8 pieces a second', 'the engine\'s own speed when it gives one');
  const cloud: Pending = { by: 'Claude Sonnet 5', text: '', started: 0, first: null, pieces: 0, device: false };
  assert.equal(writingWords(cloud, 2000), 'Waiting for Claude Sonnet 5... 2 s');
  cloud.first = 2500;
  cloud.pieces = 30;
  assert.equal(writingWords(cloud, 4000), 'Writing... 4 s', 'no speed claimed for pieces that are not word-pieces');
  assert.equal(footWords(cloud, 4000), 'Answered in 4 s');
});

// ---- Good places to start ----

test('every suggested model has a program in the engine, for older and newer graphics chips alike', () => {
  for (const half of [false, true]) {
    for (const group of SUGGESTED) {
      for (const m of group.models) {
        const b = pickBuild(m, half);
        assert.ok(b, `${m.name} (${half ? 'newer' : 'older'} chip)`);
        const lib = MODEL_LIBS.find(l => l.base === b.repo.slice('mlc-ai/'.length));
        assert.ok(lib, `${b.repo} is a model the engine has a program for`);
        assert.equal(b.vram, lib.vram, 'the graphics memory shown is the program\'s own figure');
        if (!half) assert.equal(b.quant, 'q4f32_1', `${m.name}: an older chip gets the build that runs everywhere`);
      }
    }
  }
});

test('the built-in models are marked as built in, at the build TOMLIN OS ships', () => {
  const all = SUGGESTED.flatMap(g => g.models).map(m => pickBuild(m, true)!);
  for (const b of BUILT_IN_MODELS) {
    const s = all.find(x => x.repo === `mlc-ai/${b.id}`);
    assert.ok(s?.builtIn, `${b.name} is suggested as built in`);
  }
  assert.equal(all.filter(x => x.builtIn).length, BUILT_IN_MODELS.length, 'no other model claims to be built in');
});
