// Chat's Agents: a thread survives its file (any text, any AI name), titles come from the first question, and saving
// picks a new file name only the first time. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_FOLDER, clearOldThreads, listThreads, openThread, saveThread, threadFromText, threadToText, titleFrom, type AgentThread } from '../src/apps/chat/agents.ts';
import { FileSystem } from '../src/fs/fs.ts';
import { MemoryStore } from '../src/store/memory-store.ts';

const at = Date.UTC(2026, 8, 27, 4, 5, 6);

test('a thread reads back exactly, even text that looks like the file\'s own message lines', () => {
  const thread: AgentThread = {
    title: 'ISS questions',
    turns: [
      { role: 'user', text: 'i want to learn about the international space station', at },
      { role: 'assistant', by: 'Qwen 3.5 0.8B', text: 'The ISS orbits about 400 km up.\n\n- crew of 7\n- 16 sunrises a day', at: at + 30_000 },
      { role: 'user', text: '### You · 2026-01-01T00:00:00.000Z\nnot a real heading\n\\### already escaped\n\n\ntrailing lines kept inside', at: at + 60_000 },
      { role: 'assistant', by: 'Claude Sonnet 5', text: 'Line one\r\nLine two', at: at + 90_000 },
    ],
  };
  const text = threadToText(thread);
  assert.match(text, /^# ISS questions\n/);
  assert.match(text, /^### AI \(Qwen 3\.5 0\.8B\) · 2026-09-27T04:05:36\.000Z$/m);
  const back = threadFromText(text);
  assert.equal(back.title, 'ISS questions');
  assert.equal(back.turns.length, 4);
  assert.deepEqual(back.turns.slice(0, 3), thread.turns.slice(0, 3));
  assert.equal(back.turns[3].text, 'Line one\nLine two', 'Windows line ends become plain ones');
  assert.equal(back.turns[3].by, 'Claude Sonnet 5');
  // Written on Windows (CRLF) and read back.
  assert.deepEqual(threadFromText(text.replace(/\n/g, '\r\n')).turns.map(t => t.text), back.turns.map(t => t.text));
});

test('a file without the usual top still opens, named after the file', () => {
  assert.deepEqual(threadFromText('', 'Old chat'), { title: 'Old chat', turns: [] });
  const t = threadFromText('notes above\n### You · 2026-09-27T04:05:06.000Z\n\nhello', 'x');
  assert.equal(t.title, 'x');
  assert.deepEqual(t.turns, [{ role: 'user', at, text: 'hello' }]);
});

test('a title is the first question, cut at a word', () => {
  assert.equal(titleFrom('  what is   the ISS?  '), 'what is the ISS?');
  assert.equal(titleFrom('i want to learn about the international space station and how it was built'), 'i want to learn about the international space...');
  assert.equal(titleFrom(''), 'AI chat');
});

test('the first save names the file (with " (2)" when taken); later saves keep it', async () => {
  const fs = new FileSystem(new MemoryStore());
  const t: AgentThread = { title: 'ISS', turns: [{ role: 'user', text: 'hi', at }] };
  const first = await saveThread(fs, t, null);
  assert.equal(first, 'ISS.md');
  const second = await saveThread(fs, { ...t }, null);
  assert.equal(second, 'ISS (2).md');
  t.turns.push({ role: 'assistant', by: 'Qwen 3.5 2B', text: 'hello', at: at + 1000 });
  assert.equal(await saveThread(fs, t, first), 'ISS.md');
  assert.equal((await openThread(fs, 'ISS.md')).turns.length, 2);
  assert.deepEqual((await listThreads(fs)).map(f => f.name).sort(), ['ISS (2).md', 'ISS.md']);
  assert.ok(await fs.exists(`${AGENT_FOLDER}/ISS.md`));
});

test('old AI chats are cleared after the days chosen in Settings, for good; Never keeps them all', async () => {
  const fs = new FileSystem(new MemoryStore());
  const t: AgentThread = { title: 'Holiday plans', turns: [{ role: 'user', text: 'hi', at }] };
  await saveThread(fs, t, null);
  await saveThread(fs, { ...t, title: 'Shopping list' }, null);
  const day = 86400000;
  assert.equal(await clearOldThreads(fs, 0, Date.now() + 90 * day), 0, 'Never: nothing goes');
  assert.equal(await clearOldThreads(fs, 3, Date.now() + 2 * day), 0, 'not old enough yet');
  assert.equal(await clearOldThreads(fs, 3, Date.now() + 4 * day), 2);
  assert.deepEqual(await listThreads(fs), []);
});
