// The built-in AI and its conversation belong to the whole desktop, not to one app: after connecting in the Overview's
// chat, the Qwen section must say "Already connected" and show the chat so far, without downloading again. A stand-in
// engine takes
// the graphics chip's place (Node has none). Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IN_ANOTHER_TAB, OnDevice, setEngineParts, startProblem, type LoadableModel } from '../src/apps/assistant/engine.ts';
import { LiveChat } from '../src/apps/chat/live.ts';
import { listThreads, openThread } from '../src/apps/chat/agents.ts';
import { FileSystem } from '../src/fs/fs.ts';
import { MemoryStore } from '../src/store/memory-store.ts';

const log: string[] = [];
/** Milliseconds the stand-in takes for each word it writes. */
let slow = 0;
const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const model = (id: string): LoadableModel => ({ id, lib: `${id}.wasm`, bytes: 1, vram: 1, context: 4096, overrides: {} });
const noProgress = () => undefined;
let answers = 0;
/** Another TOMLIN OS tab of this browser holds the built-in AI. */
let otherTab = false;
let claimsHeld = 0;
/** Starts that fail as a browser's model download does when one file does not arrive; then one that fails otherwise. */
let failDownloads = 0;
let failOther = '';

setEngineParts({
  async make(m, onProgress) {
    log.push(`start ${m.id}`);
    if (failDownloads > 0) {
      failDownloads--;
      throw new Error("Failed to execute 'add' on 'Cache': Request failed");
    }
    if (failOther) throw new Error(failOther);
    onProgress(0.5, 'half way');
    await tick(5);
    onProgress(1, 'ready');
    let stopped = false;
    return {
      chat: {
        completions: {
          create: async () => {
            const n = ++answers;
            log.push(`answer ${n} begins`);
            stopped = false;
            return (async function* () {
              for (const word of ['Hello', ' there', ' from ', m.id]) {
                if (stopped) break;
                await tick(slow);
                yield { choices: [{ delta: { content: word } }] };
              }
              log.push(`answer ${n} ends`);
              yield { choices: [], usage: { completion_tokens: 4, extra: { decode_tokens_per_s: 9 } } };
            })();
          },
        },
      },
      interruptGenerate() {
        stopped = true;
        log.push(`interrupt ${m.id}`);
      },
      async unload() {
        log.push(`stop ${m.id}`);
      },
    };
  },
  async forget(id) {
    log.push(`forget ${id}`);
  },
  async claim() {
    if (otherTab) return null;
    claimsHeld++;
    return () => {
      claimsHeld--;
    };
  },
});

/** Every handle a test opens, so the next test starts clean even if this one failed half-way. */
const handles: OnDevice[] = [];
const handle = (): OnDevice => {
  const h = new OnDevice();
  handles.push(h);
  return h;
};
const fresh = async () => {
  for (const h of handles.splice(0)) await h.unload();
  log.length = 0;
  slow = 0;
  otherTab = false;
};
const ask = (ai: OnDevice) => ai.ask([{ role: 'user', content: 'hi' }], () => undefined);

test('a model started in one app is already running in the next: nothing starts or downloads again', async () => {
  await fresh();
  const chat = handle(); // Chat › Agents on the Overview
  const assistant = handle(); // the Qwen section, opened afterwards
  await chat.load(model('qwen-0.8b'), noProgress);
  assert.equal(assistant.ready, true, 'the Assistant sees it running');
  assert.equal(OnDevice.running()?.id, 'qwen-0.8b');
  await assistant.load(model('qwen-0.8b'), noProgress);
  assert.deepEqual(log, ['start qwen-0.8b'], 'started once');
  await chat.unload();
  assert.deepEqual(log, ['start qwen-0.8b'], 'still running: the Assistant uses it');
  await assistant.unload();
  assert.deepEqual(log, ['start qwen-0.8b', 'stop qwen-0.8b'], 'the last app out stops it');
  assert.equal(OnDevice.running(), null);
});

test('two apps starting the same model at once start it once, and both hear how far it has got', async () => {
  await fresh();
  const a = handle();
  const b = handle();
  const heard: number[] = [];
  await Promise.all([a.load(model('m1'), noProgress), b.load(model('m1'), fraction => heard.push(fraction))]);
  assert.deepEqual(log, ['start m1']);
  assert.equal(heard.at(-1), 1, 'the second app hears the start through to the end');
  await a.unload();
  await b.unload();
});

test('another model chosen in any app replaces it for every app', async () => {
  await fresh();
  const a = handle();
  const b = handle();
  await a.load(model('m1'), noProgress);
  await b.load(model('m2'), noProgress);
  assert.deepEqual(log, ['start m1', 'stop m1', 'start m2']);
  assert.equal(a.model?.id, 'm2', 'the first app now talks to the new one');
  await a.unload();
  await b.unload();
  assert.deepEqual(log.slice(3), ['stop m2']);
});

test('"keep the model in this browser" unticked: its copy goes when the model stops, not while another app uses it', async () => {
  await fresh();
  const assistant = handle();
  const chat = handle();
  await assistant.load(model('m1'), noProgress);
  await assistant.unload(true);
  assert.deepEqual(log, ['start m1'], 'Chat still uses it: nothing stops, nothing is deleted');
  await chat.unload();
  assert.deepEqual(log, ['start m1', 'stop m1', 'forget m1']);
  // A replaced model's copy goes too when asked.
  await fresh();
  const one = handle();
  await one.load(model('m1'), noProgress);
  await one.load(model('m2'), noProgress, true);
  assert.deepEqual(log, ['start m1', 'stop m1', 'forget m1', 'start m2']);
  await one.unload();
});

test('answers are written one at a time: the second app waits for the first answer to finish', async () => {
  await fresh();
  slow = 3;
  const a = handle();
  const b = handle();
  await a.load(model('m1'), noProgress);
  const [ra, rb] = await Promise.all([ask(a), ask(b)]);
  assert.equal(ra.text, 'Hello there from m1');
  assert.equal(rb.text, 'Hello there from m1');
  const order = log.filter(l => l.startsWith('answer')).map(l => l.replace(/^answer \d+ /, ''));
  assert.deepEqual(order, ['begins', 'ends', 'begins', 'ends'], log.join(' | '));
  await a.unload();
  await b.unload();
});

test('Stop stops only your own answer', async () => {
  await fresh();
  slow = 8;
  const a = handle();
  const b = handle();
  await a.load(model('m1'), noProgress);
  const writing = ask(a);
  await tick(12);
  b.stop();
  assert.ok(!log.some(l => l.startsWith('interrupt')), 'the other app cannot stop it');
  a.stop();
  const r = await writing;
  assert.ok(log.includes('interrupt m1'));
  assert.ok(r.text.length < 'Hello there from m1'.length, r.text);
  await a.unload();
  await b.unload();
});

test('a reset graphics chip stops the model for every app, which can start it again', async () => {
  await fresh();
  const a = handle();
  const b = handle();
  const stop = new AbortController();
  let told = 0;
  OnDevice.watch(() => told++, stop.signal);
  await a.load(model('m1'), noProgress);
  const before = told;
  await a.lost();
  assert.ok(told > before, 'the apps are told');
  assert.equal(b.ready, false);
  assert.equal(OnDevice.running(), null);
  await b.load(model('m1'), noProgress);
  assert.deepEqual(log, ['start m1', 'stop m1', 'start m1']);
  stop.abort();
  const after = told;
  await a.unload();
  await b.unload();
  assert.equal(told, after, 'a watcher whose app closed hears nothing more');
});

test('a model running in another TOMLIN OS tab: this tab is told why and starts nothing', async () => {
  await fresh();
  otherTab = true;
  const a = handle();
  await assert.rejects(a.load(model('m1'), noProgress), { message: IN_ANOTHER_TAB });
  assert.deepEqual(log, [], 'nothing started');
  assert.equal(OnDevice.running(), null);
  otherTab = false; // that tab disconnected
  await a.load(model('m1'), noProgress);
  assert.deepEqual(log, ['start m1']);
  await a.unload();
});

test('the claim other tabs see is held while the model runs and given back when it stops', async () => {
  await fresh();
  const a = handle();
  await a.load(model('m1'), noProgress);
  assert.equal(claimsHeld, 1);
  await a.load(model('m2'), noProgress);
  assert.equal(claimsHeld, 1, 'replacing the model keeps one claim');
  await a.disconnect();
  assert.equal(claimsHeld, 0, 'given back on Disconnect');
  await a.load(model('m1'), noProgress);
  await a.lost();
  assert.equal(claimsHeld, 0, 'given back when the chip is reset');
  await a.load(model('m1'), noProgress);
  await a.unload();
  assert.equal(claimsHeld, 0, 'given back when the last app closes');
});

test('Disconnect stops the model for every app on the desktop, and says why', async () => {
  await fresh();
  const assistant = handle();
  const chat = handle();
  const stop = new AbortController();
  let told = 0;
  OnDevice.watch(() => told++, stop.signal);
  await chat.load(model('m1'), noProgress);
  assert.equal(assistant.ready, true);
  await assistant.disconnect();
  assert.equal(chat.ready, false, 'gone for Chat too');
  assert.equal(OnDevice.lastStop(), 'disconnect');
  assert.ok(told >= 2, 'the apps are told');
  assert.deepEqual(log, ['start m1', 'stop m1'], 'its copy stays in this browser');
  await assistant.disconnect();
  assert.deepEqual(log, ['start m1', 'stop m1'], 'a second Disconnect does nothing');
  await chat.load(model('m1'), noProgress);
  assert.equal(OnDevice.lastStop(), null, 'running again');
  await chat.disconnect(true);
  assert.deepEqual(log.slice(-2), ['stop m1', 'forget m1'], '"keep the model" unticked: the copy goes too');
  stop.abort();
  await assistant.unload();
  await chat.unload();
});

test('every view of a desktop shows the same conversation; another desktop has its own', () => {
  const desktop = {};
  assert.equal(LiveChat.for(desktop), LiveChat.for(desktop));
  assert.notEqual(LiveChat.for(desktop), LiveChat.for({}));
});

test('two quick saves of a new conversation make one file, not two', async () => {
  const fs = new FileSystem(new MemoryStore());
  const chat = new LiveChat();
  chat.thread.title = 'ISS';
  chat.thread.turns.push({ role: 'user', text: 'what is the ISS?', at: 1 });
  const [first, second] = await Promise.all([chat.keep(fs), chat.keep(fs)]);
  assert.equal(first, 'ISS.md');
  assert.equal(second, 'ISS.md');
  assert.equal(chat.file, 'ISS.md');
  assert.deepEqual((await listThreads(fs)).map(t => t.name), ['ISS.md']);
});

test('a conversation still being saved keeps its own file when another is opened', async () => {
  const fs = new FileSystem(new MemoryStore());
  const chat = new LiveChat();
  const first = chat.thread;
  first.title = 'First';
  first.turns.push({ role: 'user', text: 'one', at: 1 });
  const saving = chat.keep(fs);
  chat.open({ title: 'Second', turns: [{ role: 'user', text: 'two', at: 2 }] });
  assert.equal(await saving, 'First.md');
  assert.equal(chat.file, null, 'the new one has no file yet');
  assert.equal(await chat.keep(fs), 'Second.md');
  first.turns.push({ role: 'assistant', by: 'Qwen 3.5 0.8B', text: 'hello', at: 3 });
  chat.open(first, 'First.md');
  assert.equal(await chat.keep(fs), 'First.md');
  assert.equal((await openThread(fs, 'First.md')).turns.length, 2);
});

test('a view hears the conversation change until it closes', () => {
  const chat = new LiveChat();
  const heard: string[] = [];
  const view = new AbortController();
  chat.watch(change => heard.push(change), view.signal);
  chat.open({ title: '', turns: [] });
  chat.tell('pending');
  view.abort();
  chat.tell('busy');
  assert.deepEqual(heard, ['thread', 'pending']);
});

test('coming back (the Panel closed, the page reloaded): the newest kept conversation opens again', async () => {
  const fs = new FileSystem(new MemoryStore());
  const older = new LiveChat();
  older.thread.title = 'Older';
  older.thread.turns.push({ role: 'user', text: 'first', at: 1 });
  await older.keep(fs);
  await tick(5);
  const newer = new LiveChat();
  newer.thread.title = 'Newer';
  newer.thread.turns.push({ role: 'user', text: 'second', at: 2 }, { role: 'assistant', by: 'Qwen 3.5 4B', text: 'hi', at: 3 });
  await newer.keep(fs);

  const back = new LiveChat(); // a fresh page
  await back.start(fs);
  assert.equal(back.file, 'Newer.md');
  assert.equal(back.thread.turns.length, 2);
  back.open({ title: '', turns: [] }); // New chat
  await back.start(fs);
  assert.equal(back.file, null, 'a New chat is not replaced');

  // The Assistant opened first, with nothing kept yet; Chat opens after a conversation was kept: it comes back then.
  const empty = new FileSystem(new MemoryStore());
  const page = new LiveChat();
  await page.start(empty);
  assert.equal(page.file, null);
  const kept = new LiveChat();
  kept.thread.title = 'Kept later';
  kept.thread.turns.push({ role: 'user', text: 'hello', at: 5 });
  await kept.keep(empty);
  await page.start(empty);
  assert.equal(page.file, 'Kept later.md', 'a view opening later still finds it');

  const busy = new LiveChat();
  busy.thread.turns.push({ role: 'user', text: 'already talking', at: 4 });
  await busy.start(fs);
  assert.equal(busy.thread.turns[0].text, 'already talking', 'a conversation already open is kept');
});

test('a model file that does not download is tried again, carrying on; after three tries the words say download, not graphics memory', async () => {
  await fresh();
  const a = handle();
  const heard: string[] = [];
  failDownloads = 2;
  await a.load(model('m1'), (_f, text) => heard.push(text));
  assert.equal(log.filter(l => l === 'start m1').length, 3, 'two failed downloads, then it started');
  assert.ok(heard.some(t => t.includes('trying again (2 of 3)')) && heard.some(t => t.includes('(3 of 3)')), 'says it is trying again');
  assert.equal(claimsHeld, 1, 'one claim, held by the running model');
  await a.unload();

  failDownloads = 3;
  const b = handle();
  const failed = await b.load(model('m2'), noProgress).then(() => '', (e: Error) => e.message);
  assert.match(failed, /on 'Cache'/);
  const words = startProblem(failed, 'Start', false);
  assert.match(words, /did not download from Hugging Face/);
  assert.match(words, /press Start again/);
  assert.doesNotMatch(words, /graphics memory/);
  assert.equal(claimsHeld, 0, 'the claim is given back');

  failOther = 'GPUDevice lost';
  const c = handle();
  log.length = 0;
  const gpu = await c.load(model('m3'), noProgress).then(() => '', (e: Error) => e.message);
  failOther = '';
  assert.equal(log.filter(l => l === 'start m3').length, 1, 'a graphics fault is not tried again');
  assert.match(startProblem(gpu, 'Connect', true), /graphics memory/);
  assert.match(startProblem("Failed to execute 'add' on 'Cache': Request failed", 'Connect', true), /from this TOMLIN OS/);
  const named = startProblem("Failed to execute 'add' on 'Cache': Request failed", 'Start', true, 'this TOMLIN OS answered 404 for mlc-chat-config.json');
  assert.match(named, /answered 404 for mlc-chat-config\.json/, 'names the file and the answer');
  assert.match(named, /remove the model from this TOMLIN OS/, 'and the way out');
});
