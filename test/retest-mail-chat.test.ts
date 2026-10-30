// A second look at Mail and Chat (October 2026 retest): the message reader (no browser), the server's mail builder
// and folder listing (PHP), and Chat's server with two real accounts (PHP). Each test was written to catch a fault
// read in the code; one that fails points at that fault. The PHP halves skip without PHP (PHP_BIN, or php on the PATH).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeBase64, decodeWords, parseAddresses, parseMessage, summary } from '../src/apps/mail/mime.ts';
import { PHP, hasPhp, portFree } from './php-bin.ts';
import { tempDir } from './tmp.ts';

const root = join(import.meta.dirname, '..');
const noPhp = !hasPhp && 'no PHP';
const enc = (s: string) => new TextEncoder().encode(s);

// ---- Reading mail (no PHP) --------------------------------------------------------------------------------------------

test('base64 with one stray character, or padded on every line, still decodes', () => {
  assert.equal(decodeBase64('QUJDR'), 'ABC', 'a trailing odd character is dropped, not the whole part');
  assert.equal(decodeBase64('QQ==\r\nQg=='), 'AB', 'padding inside (one line at a time) is honoured');
  assert.equal(decodeWords('=?UTF-8?B?QUJDR?='), 'ABC');
});

test('an encoded comma or angle bracket in a name cannot add or change an address', () => {
  assert.deepEqual(parseAddresses('=?UTF-8?Q?Lee=2C_Bo?= <bo@x.org>'), [{ name: 'Lee, Bo', email: 'bo@x.org' }]);
  const spoof = parseAddresses('=?UTF-8?Q?support=40bank=2Ecom_=3Csupport=40bank=2Ecom=3E=2C?= <x@evil.test>');
  assert.equal(spoof.length, 1, `one sender, not ${JSON.stringify(spoof)}`);
  assert.equal(spoof[0].email, 'x@evil.test');
});

test('the message list shows a raw UTF-8 subject as the server hands it over (a Unicode string), unharmed', () => {
  assert.equal(summary('Subject: Café — 5 €\r\n').subject, 'Café — 5 €');
});

test('an attachment name in the modern form (filename*=UTF-8\'\'...) is decoded once, so every letter survives', () => {
  const m = parseMessage(enc('Content-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename*=UTF-8\'\'Gr%C3%B6%C3%9Fe%20%E2%82%AC.pdf\r\nContent-Transfer-Encoding: base64\r\n\r\nQUJD\r\n--b--\r\n'));
  assert.equal(m.attachments[0]?.name, 'Größe €.pdf');
});

test('a direction-flipping character in an attachment name is removed (it can disguise ".exe" as ".pdf")', () => {
  const m = parseMessage(enc('Content-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename*=UTF-8\'\'invoice%E2%80%AEfdp.exe\r\n\r\nx\r\n--b--\r\n'));
  assert.doesNotMatch(m.attachments[0]?.name ?? '', /[‪-‮⁦-⁩]/);
});

test('one accented letter split across two encoded words comes out as the letter', () => {
  assert.equal(decodeWords('=?UTF-8?Q?caf=C3?= =?UTF-8?Q?=A9?='), 'café');
});

// ---- The server's mail builder and listing (PHP) -------------------------------------------------------------------------

const fakeUrl = new URL('./fake-mail.mjs', import.meta.url).href;

function script(code: string): { file: string; dir: string } {
  const dir = tempDir('tomlinos-retest-mail-');
  const file = join(dir, 't.php');
  writeFileSync(file, `<?php\nrequire ${JSON.stringify(join(root, 'server/lib/http.php'))};\nrequire ${JSON.stringify(join(root, 'server/lib/mailnet.php'))};\n${code}`);
  return { file, dir };
}

test('a message sent to Bcc only carries no empty "To:" line', { skip: noPhp }, () => {
  const { file, dir } = script(`echo json_encode(mail_build(['from' => 'a@b.cd', 'to' => [], 'cc' => [], 'subject' => 'x', 'text' => 'x', 'attachments' => []]));`);
  const raw = JSON.parse(execFileSync(PHP, [file], { env: { ...process.env, DESKTOP_DATA_DIR: dir }, encoding: 'utf8' })) as string;
  assert.doesNotMatch(raw.split('\r\n\r\n')[0], /^To: ?\r?$/m);
});

test('one old-style (Latin-1) subject among fifty messages does not make the whole folder page unreadable', { skip: noPhp }, async () => {
  const { startFakeMail, USER, PASS } = (await import(fakeUrl)) as any;
  const mail = await startFakeMail({ imap: 3245, smtp: 3689 });
  try {
    mail.boxes.INBOX.msgs.push({ uid: 9, raw: 'From: a@b.cd\r\nSubject: caf\xe9\r\n\r\nx', flags: new Set(), date: new Date() });
    const { file, dir } = script(`
      $i = new Imap('127.0.0.1', 3245, 'none', ${JSON.stringify(USER)}, ${JSON.stringify(PASS)});
      $i->select('INBOX');
      $rows = $i->summaries($i->uids());
      // What api_json does with the listing (server/lib/http.php): one bad byte must not turn the answer into nothing.
      $json = json_encode(['rows' => $rows], JSON_UNESCAPED_SLASHES);
      echo json_encode(['ok' => $json !== false, 'why' => json_last_error_msg(), 'n' => count($rows)]);`);
    const r = await new Promise<any>((resolve, reject) => execFile(PHP, [file], { env: { ...process.env, DESKTOP_DATA_DIR: dir, DESKTOP_MAIL_ALLOW_HOSTS: '127.0.0.1:3245', DESKTOP_MAIL_ALLOW_PLAIN: '1' }, encoding: 'utf8', timeout: 30000 }, (e, out, err) => (e ? reject(new Error(err || e.message)) : resolve(JSON.parse(out)))));
    assert.ok(r.n >= 1, 'the message is listed');
    assert.ok(r.ok, `the folder listing could not be sent: ${r.why}`);
  } finally {
    await mail.close();
  }
});

// ---- Chat's server, with two accounts (PHP) ------------------------------------------------------------------------------

// 3062: every other test's port (3092-3099, the mail stand-ins, the browser runner) is taken.
const PORT = 3062;
const BASE = `http://127.0.0.1:${PORT}`;
const chatRoot = mkdtempSync(join(tmpdir(), 'desktop-retest-chat-'));
let php: ChildProcess;
const people: Record<'owner' | 'sam', { cookie: string; id: string }> = { owner: { cookie: '', id: '' }, sam: { cookie: '', id: '' } };

async function call(who: 'owner' | 'sam', op: string, body?: unknown, query: Record<string, string> = {}): Promise<{ status: number; data: any }> {
  const res = await fetch(`${BASE}/api/chat.php?${new URLSearchParams({ op, ...query })}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-Desktop-Store': '1', Cookie: people[who].cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

async function auth(op: string, body: unknown, cookie = ''): Promise<{ cookie: string; data: any }> {
  const res = await fetch(`${BASE}/api/auth.php?op=${op}`, {
    method: 'POST',
    headers: { 'X-Desktop-Store': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200, `${op}: ${res.status}`);
  return { cookie: (res.headers.get('set-cookie') ?? '').split(';')[0] || cookie, data: await res.json() };
}

before(async () => {
  if (noPhp) return;
  await portFree(PORT);
  php = spawn(PHP, ['-S', `127.0.0.1:${PORT}`, '-t', 'public', 'server/dev-router.php'], { env: { ...process.env, DESKTOP_DATA_DIR: chatRoot }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${BASE}/storage.json`);
      break;
    } catch {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  const owner = await auth('setup', { name: 'owner', password: 'chat-test-passphrase-1' });
  people.owner = { cookie: owner.cookie, id: owner.data.user.id };
  const made = await auth('user-create', { name: 'sam', next: 'chat-test-passphrase-2', password: 'chat-test-passphrase-1', display: 'Sam' }, owner.cookie);
  const sam = await auth('login', { name: 'sam', password: 'chat-test-passphrase-2' });
  people.sam = { cookie: sam.cookie, id: made.data.user.id };
});

after(() => {
  php?.kill();
  rmSync(chatRoot, { recursive: true, force: true });
});

test('a public key that is not a point on the curve is refused (one bad key would break everyone\'s General key hand-out)', { skip: noPhp }, async () => {
  const bad = Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString('base64');
  const r = await call('sam', 'key', { pub: bad });
  assert.equal(r.status, 400, `answered ${r.status}: ${JSON.stringify(r.data)}`);
});

test('clearing General with more than 1,000 messages tells open screens about every one of them', { skip: noPhp }, async () => {
  const dir = join(chatRoot, 'chat');
  const messages = Array.from({ length: 1100 }, (_, i) => ({ id: i + 1, from: people.owner.id, at: Math.floor(Date.now() / 1000), iv: 'AAAAAAAAAAAAAAAA', ct: 'AAAA' }));
  writeFileSync(join(dir, 'conv-general.json'), JSON.stringify({ next: 1101, messages, gone: [], deletes: 0 }));
  const cleared = await call('owner', 'delete', { conv: 'general', all: true });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.data));
  const after = await call('sam', 'messages', undefined, { conv: 'general', after: '0' });
  assert.equal(after.status, 200, JSON.stringify(after.data));
  const gone: number[] = after.data.gone ?? [];
  assert.ok(gone.includes(1) && gone.includes(1100), `Sam's screen is told about ${gone.length} of the 1,100 deleted messages`);
});

test('"vanish after 3 days" also deletes old messages in a Direct conversation between two people who never open Chat again', { skip: noPhp }, async () => {
  assert.equal((await call('owner', 'settings', { vanishDays: 3, password: 'chat-test-passphrase-1' })).status, 200);
  const pat = await auth('user-create', { name: 'pat', next: 'chat-test-passphrase-3', password: 'chat-test-passphrase-1', display: 'Pat' }, people.owner.cookie);
  const dir = join(chatRoot, 'chat');
  const [a, b] = [pat.data.user.id, people.sam.id].sort();
  const file = join(dir, `conv-dm-${a}-${b}.json`);
  writeFileSync(file, JSON.stringify({ next: 2, messages: [{ id: 1, from: people.sam.id, at: Math.floor(Date.now() / 1000) - 4 * 86400, iv: 'AAAAAAAAAAAAAAAA', ct: 'AAAA' }], gone: [], deletes: 0 }));
  // Time passes; the owner and others come and go from Chat (every visit polls "state"), but Sam and Pat never do.
  assert.equal((await call('owner', 'state')).status, 200);
  const kept = JSON.parse(readFileSync(file, 'utf8')).messages.length;
  assert.equal(kept, 0, 'a 4-day-old message is still on the server after the 3-day limit');
});

test('a General key wrapped for a public key someone has since replaced is refused (or that person is locked out of General for good)', { skip: noPhp }, async () => {
  const { newKeys, newGeneralKey, wrapGeneral, unwrapGeneral } = await import('../src/apps/chat/crypto.ts');
  const o = (await newKeys()).keys;
  const s1 = (await newKeys()).keys;
  assert.equal((await call('owner', 'key', { pub: o.pub, replace: true })).status, 200);
  assert.equal((await call('sam', 'key', { pub: s1.pub, replace: true })).status, 200);
  const reset = await call('owner', 'reset', { password: 'chat-test-passphrase-1' });
  const epoch: number = reset.data.epoch;
  const gKey = await newGeneralKey();
  assert.equal((await call('owner', 'wrap', { user: people.owner.id, epoch, genesis: true, ...(await wrapGeneral(o, people.owner.id, o.pub, gKey, epoch)) })).status, 200);
  // The owner's page worked out Sam's wrap from the key it saw (s1); meanwhile Sam replaced his key.
  const staleWrap = await wrapGeneral(o, people.sam.id, s1.pub, gKey, epoch);
  const s2 = (await newKeys()).keys;
  assert.equal((await call('sam', 'key', { pub: s2.pub, replace: true })).status, 200);
  const handed = await call('owner', 'wrap', { user: people.sam.id, epoch, ...staleWrap });
  if (handed.status === 200) {
    const state = (await call('sam', 'state')).data;
    assert.ok(state.general.wrap, 'Sam was handed a wrap');
    await assert.doesNotReject(unwrapGeneral(s2, people.sam.id, state.general.wrap, epoch), 'the server accepted a wrap Sam cannot open, and marks him as having the key: nobody will wrap it again');
  } else {
    assert.equal(handed.status, 409);
  }
});
