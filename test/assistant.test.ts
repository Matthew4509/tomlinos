// The Assistant's text handling: thinking hidden, long text cut to fit (and said so), the history kept within reach.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitText, jobPrompt, repeatCut, SYSTEM_PROMPT, systemPrompt, trimHistory, visibleText } from '../src/apps/assistant/engine.ts';

test('a model\'s <think> part is hidden, even while it is still being written', () => {
  assert.equal(visibleText('<think>\nlet me see\n</think>\n\nThe answer is 4.'), 'The answer is 4.');
  assert.equal(visibleText('<think>still thinking'), '');
  assert.equal(visibleText('Plain answer.'), 'Plain answer.');
});

test('long text is cut at a paragraph or sentence, and says it was cut', () => {
  const para = 'A sentence here. '.repeat(40) + '\n\n';
  const long = para.repeat(20);
  const r = fitText(long, 2000);
  assert.equal(r.cut, true);
  assert.ok(r.text.length <= 2000 && r.text.length > 1400, String(r.text.length));
  assert.ok(/[.\n]$/.test(r.text), 'ends at a boundary');
  assert.deepEqual(fitText('short', 2000), { text: 'short', cut: false });
});

test('the history keeps the newest turns that fit, after the system prompt', () => {
  const turns = Array.from({ length: 10 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: `${i}:${'x'.repeat(3000)}` }));
  const kept = trimHistory(turns, 10000);
  assert.equal(kept[0].content, systemPrompt());
  assert.ok(kept[0].content.startsWith(SYSTEM_PROMPT));
  assert.match(systemPrompt(new Date(2026, 8, 30)), /Today is Wednesday,? 30 September 2026\.$/, 'the model is told the date');
  assert.match(systemPrompt(), /Mention the date only when asked\./, 'the date is background, not a greeting');
  assert.match(SYSTEM_PROMPT, /say hello back/, 'a hello gets a hello back');
  assert.equal(kept[kept.length - 1].content.slice(0, 2), '9:');
  assert.equal(kept.length, 1 + 3);
  assert.equal(trimHistory([{ role: 'user', content: 'y'.repeat(50000) }], 100).length, 2, 'the newest turn is always kept');
});

test('each quick button asks for its job', () => {
  assert.match(jobPrompt('summarise', 'T'), /^Summarise/);
  assert.match(jobPrompt('rewrite', 'T'), /Reply with the rewritten text only/);
  assert.match(jobPrompt('ask', 'FILE', 'Q?'), /FILE[\s\S]*Question about the file: Q\?[\s\S]*If the file does not say, say so/);
});

test('an answer that loops is cut before the repeat (a real looping ISS answer)', () => {
  const p = 'The ISS is a collaborative space station under the United Nations. It is currently the world\'s largest space station.';
  const intro = 'The International Space Station (ISS) is in low orbit.';
  // The answer: an intro, then the same paragraph again and again. Cut once a finished paragraph comes round again.
  assert.equal(repeatCut(`${intro}\n\n${p}`), null, 'one paragraph so far');
  assert.equal(repeatCut(`${intro}\n\n${p}\n\n${p.slice(0, 20)}`), null, 'the second copy is not finished yet');
  assert.equal(repeatCut(`${intro}\n\n${p}\n\n${p}\n\nThe`), `${intro}\n\n${p}`);
  // A loop without blank lines: a sentence the third time; kept up to where the second began.
  const s = 'Astronauts live there for six months at a time. ';
  assert.equal(repeatCut(s + s), null);
  assert.equal(repeatCut(`Intro here. ${s}${s}${s}`), `Intro here. ${s}`.trimEnd());
  // Ordinary answers pass: short repeated lines (list markers, "Yes.") are not counted.
  assert.equal(repeatCut('Yes.\n\nYes.\n\nYes.\n\n- one\n- two'), null);
  assert.equal(repeatCut('It has solar panels. It has radiators. It has docking ports for visiting craft.'), null);
});

