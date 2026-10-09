// The built-in AI's character (src/apps/assistant/persona.ts): Gemma talks like a person, helps with anything, keeps her
// files hidden, remembers what she is asked to, and drops asides. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addFacts, DEFAULT_MEMORY, DEFAULT_PROFILE, DEFAULT_STORY, inHerOwnWords, memoryLines, MEMORY_PATH, nameFrom, personaSystem, personaTurns,
  PROFILE_MAX, PROFILE_PATH, rememberFrom, STORY_PATH, storyFor, storyParts, stripNotes, withAges,
} from '../src/apps/assistant/persona.ts';

const NOW = new Date(2026, 8, 30, 12);

test('her character: Gemma, talks like a person, helps with anything, has fun, no lectures', () => {
  const text = withAges(stripNotes(DEFAULT_PROFILE), NOW);
  assert.equal(nameFrom(DEFAULT_PROFILE), 'Gemma');
  for (const words of ['You are Gemma, 35', 'say hi back', 'what they are up to', 'You help with anything', 'no lectures and no warnings', 'flirt back', 'No lists of options, no remarks in brackets', 'Never say "as an AI"', 'only when they fit']) {
    assert.ok(text.includes(words), words);
  }
  assert.ok(text.length <= PROFILE_MAX, `short enough for a small model (${text.length} letters)`);
  assert.ok(!/\b(role|pretend|persona)\b/i.test(text), 'no words that make a small model talk about her instead of as her');
});

test('nothing in her character or story sets levels of adult talk', () => {
  for (const text of [DEFAULT_PROFILE, DEFAULT_STORY, DEFAULT_MEMORY]) {
    assert.ok(!/\b(dirty talk|explicit|nudes?|sexual|18 or over|trust meter|horny)\b/i.test(text));
  }
});

test('her instructions: character, who she talks to, what she knows, and the date last, as background', () => {
  const memory = addFacts(DEFAULT_MEMORY, ['Drives a forklift, 4 years']);
  const s = personaSystem(DEFAULT_PROFILE, memory, 'Matt', NOW);
  assert.match(s, /You are Gemma, 35\./);
  assert.match(s, /The person you are talking with is Matt\./);
  assert.match(s, /- Drives a forklift, 4 years/);
  assert.match(s, /\(For reference, mention it only if asked: today is Wednesday,? 30 September 2026\.\)$/);
  assert.ok(!personaSystem(DEFAULT_PROFILE, DEFAULT_MEMORY, '', NOW).includes('What you know about them'), 'no memory, no heading');
});

test('"remember ..." becomes a fact about them', () => {
  assert.equal(rememberFrom('remember that my sister is called Kate'), 'their sister is called Kate');
  assert.equal(rememberFrom("Please remember I'm vegetarian."), "they're vegetarian");
  assert.equal(rememberFrom('Remember: I work nights'), null, 'too odd a shape is left alone rather than guessed');
  assert.equal(rememberFrom('do you remember when we talked about Rome?'), null, 'a question about the past is not a fact');
  assert.equal(rememberFrom('hi there'), null);
  assert.equal(rememberFrom('remember me'), null);
});

test('an aside in brackets, and talk about her rather than as her, are dropped', () => {
  assert.equal(inHerOwnWords("Hey Matt! Whatcha been up to?\n\n(I'm just popping in, like a hidden gem at a street food stall!)"), 'Hey Matt! Whatcha been up to?');
  assert.equal(inHerOwnWords('A fake personality would say hello back. Hey you! How was work?'), 'Hey you! How was work?');
  assert.equal(inHerOwnWords('As Gemma, I would say: "Hi! Missed you."'), 'Hi! Missed you.');
  assert.equal(inHerOwnWords('I love tacos (the crunchy ones) most.'), 'I love tacos (the crunchy ones) most.', 'brackets inside a sentence stay');
  assert.equal(inHerOwnWords('(just this)'), '(just this)', 'when nothing else is left, the answer stays as it came');
});

test('her story: found out a part at a time, under her name', () => {
  assert.deepEqual(storyParts(DEFAULT_STORY).map(p => p.title), ['Always', 'Family', 'Growing up', 'Home now', 'Food', 'Work', 'Birthday']);
  assert.match(storyFor(DEFAULT_STORY, 'hello', NOW), /everyone calls you Gemma/);
  assert.ok(!storyFor(DEFAULT_STORY, 'hello', NOW).includes('jeepney'), 'nothing more until asked');
  assert.match(storyFor(DEFAULT_STORY, 'what does your brother do?', NOW), /jeepney/);
  assert.match(DEFAULT_STORY, /Fiction, written with the help of AI/, 'the story says it is made up');
  assert.ok(!storyFor(DEFAULT_STORY, 'family brother home food work birthday', NOW, 9).includes('Fiction'), 'the note is never given to the AI');
});

/** Just enough of the file system for personaTurns. */
function fakeFs() {
  const files = new Map<string, { text: string; hidden: boolean }>();
  const folders = new Map<string, boolean>();
  return {
    files, folders,
    async readText(p: string) { const f = files.get(p); if (!f) throw new Error('missing'); return f.text; },
    async writeText(p: string, text: string, o: { hidden?: boolean } = {}) { files.set(p, { text, hidden: !!o.hidden }); return {} as never; },
    async ensureFolder(p: string, o: { hidden?: boolean } = {}) { folders.set(p, !!o.hidden); },
  };
}

test('what the model is sent: her hidden files made once, a "remember" kept, never opening with her', async () => {
  const fs = fakeFs();
  const turns = await personaTurns(fs as never, 'Matt', [
    { role: 'assistant', content: 'Hey! What are you up to?' },
    { role: 'user', content: 'remember that my dog is called Rex' },
  ], NOW);
  for (const p of [PROFILE_PATH, MEMORY_PATH, STORY_PATH]) assert.equal(fs.files.get(p)?.hidden, true, `${p} is hidden`);
  assert.equal(fs.folders.get('/System'), true);
  assert.deepEqual(memoryLines(fs.files.get(MEMORY_PATH)!.text), ['their dog is called Rex']);
  assert.equal(turns[0].role, 'system');
  assert.match(turns[0].content, /- their dog is called Rex/);
  assert.equal(turns[1].role, 'user', 'the conversation starts with the person');
  assert.equal(turns.length, 2);
  const again = await personaTurns(null, '', [{ role: 'user', content: 'hi' }], NOW);
  assert.match(again[0].content, /You are Gemma/, 'with no files at all she still answers from her defaults');
});
