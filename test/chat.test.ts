// Chat: the encryption (src/apps/chat/crypto.ts) and the server (server/api/chat.php) with two real accounts.
// Needs PHP for the server half: set PHP_BIN to its path, or have "php" on the PATH.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  b64, directKey, generalCode, keysFromJwk, newGeneralKey, newKeys, openMessage, safetyCode, sealMessage, unb64, unwrapGeneral, wrapGeneral,
} from '../src/apps/chat/crypto.ts';
import { dmId } from '../src/apps/chat/session.ts';
import { PHP } from './php-bin.ts';

// ---- The encryption ------------------------------------------------------------------------------------------------

test('a kept key comes back as the same key', async () => {
  const { keys, jwk } = await newKeys();
  const again = await keysFromJwk(JSON.parse(JSON.stringify(jwk)));
  assert.equal(again.pub, keys.pub);
  assert.equal(unb64(keys.pub).length, 65);
  assert.equal(unb64(keys.pub)[0], 4);
  await assert.rejects(keysFromJwk({ kty: 'RSA' }), /not a chat key/);
});

test('Direct: both sides work out the same key; a message opens only in its own conversation, from its own sender', async () => {
  const a = (await newKeys()).keys;
  const b = (await newKeys()).keys;
  const conv = dmId('aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb');
  const ka = await directKey(a, b.pub, conv);
  const kb = await directKey(b, a.pub, conv);
  const sealed = await sealMessage(ka, conv, 'aaaaaaaaaaaaaaaa', 0, 'Hello, héllo 👋\nsecond line');
  assert.equal(await openMessage(kb, conv, 'aaaaaaaaaaaaaaaa', 0, sealed.iv, sealed.ct), 'Hello, héllo 👋\nsecond line');
  // Put in someone else's name, moved to another conversation, or changed: it does not open.
  assert.equal(await openMessage(kb, conv, 'bbbbbbbbbbbbbbbb', 0, sealed.iv, sealed.ct), null);
  const other = dmId('aaaaaaaaaaaaaaaa', 'cccccccccccccccc');
  assert.equal(await openMessage(await directKey(b, a.pub, other), other, 'aaaaaaaaaaaaaaaa', 0, sealed.iv, sealed.ct), null);
  const bytes = unb64(sealed.ct);
  bytes[3] ^= 1;
  assert.equal(await openMessage(kb, conv, 'aaaaaaaaaaaaaaaa', 0, sealed.iv, b64(bytes)), null);
  // A third person's key cannot open it.
  const c = (await newKeys()).keys;
  assert.equal(await openMessage(await directKey(c, a.pub, conv), conv, 'aaaaaaaaaaaaaaaa', 0, sealed.iv, sealed.ct), null);
});

test('General: the key wrapped for one person opens for that person only, and a message is bound to its epoch', async () => {
  const a = (await newKeys()).keys;
  const b = (await newKeys()).keys;
  const c = (await newKeys()).keys;
  const key = await newGeneralKey();
  const wrap = await wrapGeneral(a, 'bbbbbbbbbbbbbbbb', b.pub, key, 3);
  const opened = await unwrapGeneral(b, 'bbbbbbbbbbbbbbbb', wrap, 3);
  assert.equal(await generalCode(opened), await generalCode(key));
  await assert.rejects(unwrapGeneral(c, 'bbbbbbbbbbbbbbbb', wrap, 3));
  await assert.rejects(unwrapGeneral(b, 'cccccccccccccccc', wrap, 3));
  await assert.rejects(unwrapGeneral(b, 'bbbbbbbbbbbbbbbb', wrap, 4));
  const m = await sealMessage(key, 'general', 'aaaaaaaaaaaaaaaa', 3, 'to everyone');
  assert.equal(await openMessage(opened, 'general', 'aaaaaaaaaaaaaaaa', 3, m.iv, m.ct), 'to everyone');
  assert.equal(await openMessage(opened, 'general', 'aaaaaaaaaaaaaaaa', 2, m.iv, m.ct), null);
});

test('the safety code matches on both screens, and differs when a key was swapped', async () => {
  const a = (await newKeys()).keys;
  const b = (await newKeys()).keys;
  const mallory = (await newKeys()).keys;
  const onA = await safetyCode(a.pub, b.pub);
  assert.equal(await safetyCode(b.pub, a.pub), onA);
  assert.match(onA, /^\d{5}( \d{5}){5}$/);
  assert.notEqual(await safetyCode(a.pub, mallory.pub), onA);
});

// ---- The server, with two accounts -------------------------------------------------------------------------------

const PORT = 3095;
const BASE = `http://127.0.0.1:${PORT}`;
const root = mkdtempSync(join(tmpdir(), 'desktop-chat-'));
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
  php = spawn(PHP, ['-S', `127.0.0.1:${PORT}`, '-t', 'public', 'server/dev-router.php'], { env: { ...process.env, DESKTOP_DATA_DIR: root }, stdio: 'ignore' });
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try {
      await fetch(`${BASE}/storage.json`);
      up = true;
    } catch {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  if (!up) throw new Error('PHP test server did not start');
  const owner = await auth('setup', { name: 'owner', password: 'chat-test-passphrase-1' });
  people.owner = { cookie: owner.cookie, id: owner.data.user.id };
  const made = await auth('user-create', { name: 'sam', next: 'chat-test-passphrase-2', password: 'chat-test-passphrase-1', display: 'Sam' }, owner.cookie);
  const sam = await auth('login', { name: 'sam', password: 'chat-test-passphrase-2' });
  people.sam = { cookie: sam.cookie, id: made.data.user.id };
});

after(() => {
  php.kill();
  rmSync(root, { recursive: true, force: true });
});

test('chat: keys, the General key handed on, Direct and General messages, unread counts, and what the server keeps', async () => {
  assert.equal((await fetch(`${BASE}/api/chat.php?op=state`, { headers: { 'X-Desktop-Store': '1' } })).status, 401);
  const o = (await newKeys()).keys;
  const s = (await newKeys()).keys;
  assert.equal((await call('owner', 'key', { pub: 'nonsense' })).status, 400);
  assert.equal((await call('owner', 'key', { pub: o.pub })).status, 200);
  assert.equal((await call('owner', 'key', { pub: o.pub })).status, 200, 'the same key again is fine');
  const other = (await newKeys()).keys;
  const clash = await call('owner', 'key', { pub: other.pub });
  assert.equal(clash.status, 409);
  assert.equal(clash.data.exists, true);

  // The owner starts General; a second start is refused.
  let st = (await call('owner', 'state')).data;
  assert.equal(st.general.started, false);
  const gKey = await newGeneralKey();
  const epoch = st.general.epoch;
  assert.equal((await call('owner', 'wrap', { user: people.owner.id, epoch, genesis: true, ...(await wrapGeneral(o, people.owner.id, o.pub, gKey, epoch)) })).status, 200);
  assert.equal((await call('owner', 'wrap', { user: people.owner.id, epoch, genesis: true, ...(await wrapGeneral(o, people.owner.id, o.pub, gKey, epoch)) })).status, 409);

  // Sam has no key yet: nobody can hand General to Sam. Sam cannot start another General.
  assert.equal((await call('owner', 'wrap', { user: people.sam.id, epoch, ...(await wrapGeneral(o, people.sam.id, o.pub, gKey, epoch)) })).status, 409);
  assert.equal((await call('sam', 'key', { pub: s.pub })).status, 200);
  const samOwn = await newGeneralKey();
  assert.equal((await call('sam', 'wrap', { user: people.sam.id, epoch, genesis: true, ...(await wrapGeneral(s, people.sam.id, s.pub, samOwn, epoch)) })).status, 409);
  // Sam, not holding General, cannot hand a key to anyone either.
  assert.equal((await call('sam', 'wrap', { user: people.owner.id, epoch, ...(await wrapGeneral(s, people.owner.id, o.pub, samOwn, epoch)) })).status, 403);

  // The owner hands it on; it cannot then be replaced by anyone.
  st = (await call('owner', 'state')).data;
  const samRow = st.people.find((p: any) => p.id === people.sam.id);
  assert.equal(samRow.pub, s.pub);
  assert.equal(samRow.hasGeneral, false);
  assert.equal((await call('owner', 'wrap', { user: people.sam.id, epoch, ...(await wrapGeneral(o, people.sam.id, samRow.pub, gKey, epoch)) })).status, 200);
  assert.equal((await call('owner', 'wrap', { user: people.sam.id, epoch, ...(await wrapGeneral(o, people.sam.id, samRow.pub, samOwn, epoch)) })).status, 409);
  const samState = (await call('sam', 'state')).data;
  const samG = await unwrapGeneral(s, people.sam.id, samState.general.wrap, epoch);
  assert.equal(await generalCode(samG), await generalCode(gKey));
  assert.ok(samState.people.find((p: any) => p.me && p.online));

  // General: Sam writes, the owner reads it and has one unread until reading.
  const g1 = await sealMessage(samG, 'general', people.sam.id, epoch, 'Morning all');
  const sent = await call('sam', 'send', { conv: 'general', epoch, ...g1 });
  assert.equal(sent.status, 200);
  assert.equal((await call('sam', 'send', { conv: 'general', epoch: epoch + 1, ...g1 })).status, 409, 'a stale epoch is refused');
  st = (await call('owner', 'state')).data;
  assert.equal(st.convs.general.unread, 1);
  assert.equal((await call('sam', 'state')).data.convs.general.unread, 0, 'your own message is never unread');
  const got = (await call('owner', 'messages', undefined, { conv: 'general', after: '0' })).data.messages;
  assert.equal(got.length, 1);
  assert.equal(await openMessage(gKey, 'general', got[0].from, got[0].epoch, got[0].iv, got[0].ct), 'Morning all');
  assert.equal((await call('owner', 'read', { conv: 'general', id: got[0].id })).status, 200);
  assert.equal((await call('owner', 'state')).data.convs.general.unread, 0);

  // Direct.
  const conv = dmId(people.owner.id, people.sam.id);
  const dk = await directKey(o, s.pub, conv);
  const d1 = await sealMessage(dk, conv, people.owner.id, 0, 'Just between us');
  assert.equal((await call('owner', 'send', { conv, epoch: 0, ...d1 })).status, 200);
  const samMsgs = (await call('sam', 'messages', undefined, { conv, after: '0' })).data.messages;
  assert.equal(await openMessage(await directKey(s, o.pub, conv), conv, samMsgs[0].from, 0, samMsgs[0].iv, samMsgs[0].ct), 'Just between us');
  assert.equal((await call('owner', 'messages', undefined, { conv, after: String(samMsgs[0].id) })).data.messages.length, 0);

  // Conversations between other people, and made-up names, are refused.
  assert.equal((await call('sam', 'messages', undefined, { conv: dmId('0123456789abcdef', people.owner.id) })).status, 403);
  assert.equal((await call('sam', 'messages', undefined, { conv: '../keys' })).status, 400);
  const [lo, hi] = [people.owner.id, people.sam.id].sort();
  assert.equal((await call('sam', 'send', { conv: `dm-${hi}-${lo}`, epoch: 0, ...d1 })).status, 400, 'the two names the wrong way round');

  // What the server keeps: scrambled text and public keys, never the words.
  for (const f of readdirSync(join(root, 'chat'))) {
    if (f.startsWith('.')) continue;
    const text = readFileSync(join(root, 'chat', f), 'utf8');
    assert.ok(!/Morning all|Just between us/.test(text), `${f} holds a message in plain words`);
  }

  // Only the owner resets General; afterwards nobody holds a key until someone starts the new one.
  assert.equal((await call('sam', 'reset', {})).status, 403);
  const reset = await call('owner', 'reset', {});
  assert.equal(reset.data.epoch, epoch + 1);
  st = (await call('owner', 'state')).data;
  assert.equal(st.general.started, false);
  assert.equal(st.general.wrap, null);

  // Replacing a key drops the General key wrapped for the old one.
  const g2 = await newGeneralKey();
  await call('owner', 'wrap', { user: people.owner.id, epoch: epoch + 1, genesis: true, ...(await wrapGeneral(o, people.owner.id, o.pub, g2, epoch + 1)) });
  await call('owner', 'wrap', { user: people.sam.id, epoch: epoch + 1, ...(await wrapGeneral(o, people.sam.id, s.pub, g2, epoch + 1)) });
  assert.ok((await call('sam', 'state')).data.general.wrap);
  const s2 = (await newKeys()).keys;
  assert.equal((await call('sam', 'key', { pub: s2.pub, replace: true })).status, 200);
  assert.equal((await call('sam', 'state')).data.general.wrap, null);
});

test('chat: one conversation keeps at most 2 MB of scrambled text, dropping the oldest first', async () => {
  const conv = dmId(people.owner.id, people.sam.id);
  const big = 'A'.repeat(16384);
  const iv = b64(new Uint8Array(12));
  assert.equal((await call('owner', 'send', { conv, epoch: 0, iv, ct: big + 'AAAA' })).status, 400, 'over the most one message may be');
  for (let i = 0; i < 132; i++) assert.equal((await call('owner', 'send', { conv, epoch: 0, iv, ct: big })).status, 200);
  const kept = JSON.parse(readFileSync(join(root, 'chat', `conv-${conv}.json`), 'utf8')).messages as Array<{ id: number; ct: string }>;
  const bytes = kept.reduce((n, m) => n + m.ct.length, 0);
  assert.ok(bytes <= 2097152, `${bytes} bytes kept`);
  assert.equal(kept.length, 128);
  assert.ok(kept[0].id > 2, 'the oldest went first');
});

test('chat: a message deleted is gone for everyone; only your own, or the owner in General; open screens learn which', async () => {
  const conv = dmId(people.owner.id, people.sam.id);
  const iv = b64(new Uint8Array(12));
  const ct = 'QUJD';
  const first = (await call('owner', 'send', { conv, epoch: 0, iv, ct })).data.message.id;
  const second = (await call('owner', 'send', { conv, epoch: 0, iv, ct })).data.message.id;
  const hers = (await call('sam', 'send', { conv, epoch: 0, iv, ct })).data.message.id;
  const before = (await call('sam', 'state')).data.convs[conv].deletes;

  assert.equal((await call('sam', 'delete', { conv, id: first })).status, 403, 'not someone else\'s');
  assert.equal((await call('owner', 'delete', { conv, id: first })).status, 200);
  assert.equal((await call('owner', 'delete', { conv, id: first })).status, 404, 'already gone');
  const seen = (await call('sam', 'messages', undefined, { conv, after: '0' })).data;
  assert.ok(!seen.messages.some((m: { id: number }) => m.id === first), 'gone from the server');
  assert.ok(seen.gone.includes(first), 'and named, so an open screen drops it');
  assert.equal((await call('sam', 'state')).data.convs[conv].deletes, before + 1, 'the count an open screen watches');
  assert.ok(!readFileSync(join(root, 'chat', `conv-${conv}.json`), 'utf8').includes(`"id":${first},`), 'not on the disk either');

  const mine = await call('sam', 'delete', { conv, mine: true });
  assert.equal(mine.data.deleted, 1, 'all of hers here: one');
  const left = (await call('owner', 'messages', undefined, { conv, after: '0' })).data.messages.map((m: { id: number }) => m.id);
  assert.ok(left.includes(second) && !left.includes(hers));
  assert.equal((await call('sam', 'delete', { conv, all: true })).status, 403, 'nobody clears a Direct conversation for the other person');
  assert.equal((await call('owner', 'delete', { conv, all: true })).status, 403, 'not even the owner');
  assert.equal((await call('sam', 'delete', { conv: 'general', all: true })).status, 403, 'only the owner clears General');
  const general = await call('owner', 'delete', { conv: 'general', all: true });
  assert.equal(general.status, 200);
  assert.equal((await call('owner', 'messages', undefined, { conv: 'general', after: '0' })).data.messages.length, 0);
});

test('chat: the owner chooses when messages vanish; older ones leave the server at once', async () => {
  const conv = dmId(people.owner.id, people.sam.id);
  assert.equal((await call('sam', 'settings', { vanishDays: 7 })).status, 403, 'the owner\'s choice');
  assert.equal((await call('owner', 'settings', { vanishDays: 5 })).status, 400, 'only 0, 3, 7 or 30');
  assert.equal((await call('sam', 'settings')).data.vanishDays, 0);
  // A message from ten days ago, as if it had been kept all along.
  const file = join(root, 'chat', `conv-${conv}.json`);
  const c = JSON.parse(readFileSync(file, 'utf8'));
  c.messages.unshift({ id: 0, from: people.sam.id, at: Math.floor(Date.now() / 1000) - 10 * 86400, iv: b64(new Uint8Array(12)), ct: 'T0xE' });
  writeFileSync(file, JSON.stringify(c));
  assert.equal((await call('owner', 'settings', { vanishDays: 7 })).status, 200);
  assert.ok(!readFileSync(file, 'utf8').includes('T0xE'), 'the old message left the disk when the setting was saved');
  assert.equal((await call('sam', 'state')).data.vanishDays, 7, 'every screen is told');
  assert.equal((await call('sam', 'settings')).data.vanishDays, 7);
  assert.equal((await call('owner', 'settings', { vanishDays: 0 })).status, 200);
});
