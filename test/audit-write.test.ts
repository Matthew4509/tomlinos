// Audit of Write's file formats (no browser): words that look like Markdown's own signs must come back as words after
// a save as .md and opening it again, and what a .md save leaves out must be said before it is saved.
// Run: node --test test/audit-write.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownLoses, readMarkdown, writeMarkdown } from '../src/apps/write/markdown.ts';
import { plainText, type NodeJSON } from '../src/apps/write/model.ts';

const p = (text: string, attrs: Record<string, unknown> = {}): NodeJSON => ({ type: 'paragraph', attrs: { style: 'normal', ...attrs }, content: text ? [{ type: 'text', text }] : undefined });
const roundTrip = (doc: NodeJSON): NodeJSON => readMarkdown(writeMarkdown(doc), new Set());

test('W-P0-3 Markdown: a paragraph of dashes ("---", "-----") comes back as its words, not dropped as a line across the page', () => {
  for (const dashes of ['---', '-----', '- - -']) {
    const doc: NodeJSON = { type: 'doc', content: [p('Above'), p(dashes), p('Below')] };
    assert.equal(plainText(roundTrip(doc)), `Above\n${dashes}\nBelow`, `"${dashes}" after a save as .md and opening it again`);
  }
});

test('W-P0-3 Markdown: a line break followed by a line of dashes does not turn the line above into Heading 2', () => {
  const doc: NodeJSON = { type: 'doc', content: [{ type: 'paragraph', attrs: { style: 'normal' }, content: [{ type: 'text', text: 'Total' }, { type: 'hard_break' }, { type: 'text', text: '---' }] }] };
  const back = roundTrip(doc);
  assert.equal(back.content?.[0]?.attrs?.style, 'normal', 'style after a round trip');
  assert.equal(plainText(back), 'Total\n---');
});

test('W-P1 Markdown: a table cell with two paragraphs is joined into one on save, and that is said before saving', () => {
  const cell = (c: NodeJSON[]): NodeJSON => ({ type: 'table_cell', attrs: { colspan: 1, rowspan: 1, colwidth: null, background: null }, content: c });
  const doc: NodeJSON = { type: 'doc', content: [{ type: 'table', attrs: { borders: true }, content: [
    { type: 'table_row', content: [cell([p('Head')]), cell([p('Other')])] },
    { type: 'table_row', content: [cell([p('line one'), p('line two')]), cell([p('x')])] },
  ] }] };
  const joined = plainText(roundTrip(doc)).includes('line one line two');
  assert.ok(!joined || markdownLoses(doc).length > 0, 'the two paragraphs became one and markdownLoses said nothing');
});
