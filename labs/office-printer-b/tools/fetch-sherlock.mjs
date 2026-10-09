// Fetches all of Sherlock Holmes for Office Printer B's "read another" (four novels, five story collections, all
// public domain), from Project Gutenberg, into one file:
//   labs/office-printer-b/texts/sherlock.txt
// Each book starts with a line "## <title>" (the reader shows it as the heading, never as text). Only Doyle's words
// are kept: each eBook's Project Gutenberg header, licence and footer are cut off.
//   node labs/office-printer-b/tools/fetch-sherlock.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// In the order they were published.
const BOOKS = [
  [244, 'A Study in Scarlet'],
  [2097, 'The Sign of the Four'],
  [1661, 'The Adventures of Sherlock Holmes'],
  [834, 'The Memoirs of Sherlock Holmes'],
  [2852, 'The Hound of the Baskervilles'],
  [108, 'The Return of Sherlock Holmes'],
  [3289, 'The Valley of Fear'],
  [2350, 'His Last Bow'],
  [69700, 'The Case-Book of Sherlock Holmes'],
];
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'texts');
const words = text => text.trim().split(/\s+/).filter(Boolean).length;

const parts = [];
for (const [id, title] of BOOKS) {
  const url = `https://www.gutenberg.org/cache/epub/${id}/pg${id}.txt`;
  const res = await fetch(url, { headers: { 'User-Agent': 'TOMLIN OS Office Printer (one-off download of public-domain texts)' } });
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  // Some of these eBooks are UTF-8 and some Windows-1252: read as UTF-8, and if that fails, as Windows-1252.
  const bytes = new Uint8Array(await res.arrayBuffer());
  let raw;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    raw = new TextDecoder('windows-1252').decode(bytes);
  }
  raw = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const titleLine = /^Title:\s*(.+)$/m.exec(raw)?.[1]?.trim() ?? '';
  const start = raw.search(/^\*\*\* ?START OF (THE|THIS) PROJECT GUTENBERG EBOOK.*$/m);
  const end = raw.search(/^\*\*\* ?END OF (THE|THIS) PROJECT GUTENBERG EBOOK.*$/m);
  if (start < 0 || end < 0) throw new Error(`eBook #${id}: no START or END line.`);
  // Each eBook's title line must name the book we asked for (a renumbered eBook would otherwise slip in unnoticed).
  const key = title.replace(/^(The|A|His) /, '').split(' ')[0].toLowerCase();
  if (!titleLine.toLowerCase().includes(key)) throw new Error(`eBook #${id} is "${titleLine}", not ${title}.`);
  // Picture placeholders ("cover", "[Illustration: ...]") are not words anyone reads.
  const body = raw.slice(raw.indexOf('\n', start) + 1, end)
    .replace(/^\s*cover\s*$/gim, '')
    .replace(/^\s*\[Illustration[^\]]*\]\s*$/gim, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  parts.push(`## ${title}\n\n${body}`);
  console.log(`#${id} ${title}: ${words(body).toLocaleString('en-GB')} words`);
}
const text = parts.join('\n\n\n') + '\n';
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'sherlock.txt'), text);
console.log(`sherlock.txt: ${words(text).toLocaleString('en-GB')} words, ${(Buffer.byteLength(text) / 1048576).toFixed(2)} MB`);
