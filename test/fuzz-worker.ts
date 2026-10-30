// The worker thread the fuzz tests run each reader in (see fuzz-helpers.ts, class Pool). One reader call per message:
// { id, runner, input } in, { id, ok, ms } or { id, name, message, ms } out. Running in a thread with its own memory
// cap means an input that eats all memory or never returns fails one test by name, instead of killing the whole run.
import { parentPort } from 'node:worker_threads';
import { parseXml } from '../src/core/xml.ts';
import { readArchive, readZip } from '../src/apps/archive/read.ts';
import { readDocx } from '../src/apps/write/docx.ts';
import { readOdt } from '../src/apps/write/odt.ts';
import { readRtf } from '../src/apps/write/rtf.ts';
import { readMarkdown } from '../src/apps/write/markdown.ts';
import { parseDelimited, Workbook } from '../src/apps/sheet/workbook.ts';
import { openXlsx } from '../src/apps/sheet/xlsx.ts';
import { readTcad } from '../src/apps/cad/model.ts';
import { readDxf } from '../src/apps/cad/dxf.ts';
import { parseIcs } from '../src/core/ical.ts';
import { parseVcf } from '../src/core/vcard.ts';
import { decodeWords, parseAddresses, parseMessage, summary } from '../src/apps/mail/mime.ts';
import { PdfDocument } from '../src/apps/pdf/objects.ts';
import { openOra, readStack } from '../src/apps/photoedit/ora.ts';
import { parseProjects } from '../src/apps/projects/data.ts';

export type Input = string | Uint8Array;

/** Every reader the fuzz tests reach, by name; each takes the whole input and reads all of it (entries, layers). */
export const RUNNERS: Record<string, (input: never) => unknown> = {
  parseXml: (s: string) => parseXml(s),
  readZipAll: async (b: Uint8Array) => {
    for (const e of readZip(b)) await e.read();
  },
  readTarAll: async (b: Uint8Array) => {
    for (const e of await readArchive(b, 'x.tar')) await e.read();
  },
  readGzipAll: async (b: Uint8Array) => {
    for (const e of await readArchive(b, 'x.gz')) await e.read();
  },
  readDocx: (b: Uint8Array) => readDocx(b),
  readOdt: (b: Uint8Array) => readOdt(b),
  readRtf: (b: Uint8Array) => readRtf(b),
  readMarkdown: (s: string) => readMarkdown(s),
  openXlsx: (b: Uint8Array) => openXlsx(new Workbook(), b),
  loadSheet: (s: string) => {
    let data: unknown;
    try {
      data = JSON.parse(s);
    } catch {
      return; // not JSON at all: the app says so before load() is reached
    }
    new Workbook().load(data);
  },
  parseDelimited: (s: string) => parseDelimited(s),
  readDxf: (b: Uint8Array) => readDxf(b),
  readTcad: (s: string) => readTcad(s),
  parseIcs: (s: string) => parseIcs(s),
  parseVcf: (s: string) => parseVcf(s),
  parseProjects: (s: string) => parseProjects(s),
  parseMessage: (b: Uint8Array) => parseMessage(b),
  parseAddresses: (s: string) => parseAddresses(s),
  mailSummary: (s: string) => summary(s),
  decodeWords: (s: string) => decodeWords(s),
  openPdf: (b: Uint8Array) => PdfDocument.open(b),
  openOraAll: async (b: Uint8Array) => {
    const o = await openOra(b);
    for (const l of o.stack.layers) await o.layerPng(l);
  },
  readStack: (s: string) => readStack(s),
  /** For the harness's own test: sleeps for as many ms as the input says. */
  sleep: (s: string) => new Promise(r => setTimeout(r, Number(s))),
  /** For the harness's own test: fills memory until the thread is stopped. */
  hog: () => {
    const junk: number[][] = [];
    for (;;) junk.push(new Array(1_000_000).fill(1));
  },
};

/** The Problem each reader may throw (by class name); an empty list means it must never throw at all. */
export const ALLOWED: Record<string, string[]> = {
  parseXml: ['XmlProblem'],
  readZipAll: ['ArchiveError'],
  readTarAll: ['ArchiveError'],
  readGzipAll: ['ArchiveError'],
  readDocx: ['DocxProblem'],
  readOdt: ['OdtProblem'],
  readRtf: ['RtfProblem'],
  readMarkdown: [],
  openXlsx: ['SyntaxProblem'],
  loadSheet: ['SyntaxProblem'],
  parseDelimited: [],
  readDxf: ['CadProblem'],
  readTcad: ['CadProblem'],
  parseIcs: [],
  parseVcf: [],
  // JSON that does not parse at all throws JSON's own SyntaxError, by design (so the file is never saved over).
  parseProjects: ['FsError', 'SyntaxError'],
  parseMessage: [],
  parseAddresses: [],
  mailSummary: [],
  decodeWords: [],
  openPdf: ['PdfError'],
  openOraAll: ['OraProblem'],
  readStack: ['OraProblem'],
  sleep: [],
  hog: [],
};

parentPort?.on('message', async (m: { id: number; runner: string; input: Input }) => {
  const t0 = performance.now();
  try {
    await (RUNNERS[m.runner] as (i: Input) => unknown)(m.input);
    parentPort!.postMessage({ id: m.id, ok: true, ms: performance.now() - t0 });
  } catch (error) {
    const e = error as Error;
    parentPort!.postMessage({ id: m.id, ok: false, name: e?.constructor?.name ?? typeof error, message: String(e?.message ?? error), ms: performance.now() - t0 });
  }
});
