// Fuzzing the server's doors (server/api/*.php through the dev router) with malformed requests, on its own PHP server
// and a throw-away data folder: wrong methods, bodies that are not JSON or the wrong shape, huge and deeply nested
// bodies, path tricks (../, %2e%2e, NUL, Windows device names), unicode lookalikes, repeated parameters, random bytes
// in a store commit, and every door while signed out, locked, and signed in as a person who is not the owner.
// What a door must do: answer with a 4xx and a JSON message in plain words, or do the work. A 500, a PHP warning (in the
// answer or on the server's own output), a stack trace, a server path, or a file from outside public/ is a finding.
// Needs PHP: PHP_BIN=C:/Users/User/tools/php-8.5.12-nts/php.exe (or "php" on the PATH). Port 3301.
// Run: node --test test/fuzz-server.test.ts
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdirSync, rmSync } from 'node:fs';
import { PHP, hasPhp, portFree } from './php-bin.ts';
import { BASE_SEED, Rng } from './fuzz-helpers.ts';

const PORT = 3301;
const BASE = `http://127.0.0.1:${PORT}`;
// A short path: long Windows paths break Node and PHP alike.
const DATA = 'C:/Users/User/AppData/Local/Temp/fz1/data';
const MODELS = 'C:/Users/User/AppData/Local/Temp/fz1/models';
let php: ChildProcess | null = null;
/** Everything PHP's own server printed (warnings land here, not in the answer, with display_errors off). */
let serverLog = '';

const OWNER = { name: 'owner', password: 'lantern-orchard-47' };
const OTHER = { name: 'guest', password: 'river-stone-lantern-8' };

interface Answer {
  status: number;
  text: string;
  type: string;
}

/** One request; `headers` adds to or overrides the desktop's own header. */
async function req(path: string, init: { method?: string; body?: BodyInit | Uint8Array | null; headers?: Record<string, string>; cookie?: string; noDesktop?: boolean } = {}): Promise<Answer> {
  const headers: Record<string, string> = { ...(init.noDesktop ? {} : { 'X-Desktop-Store': '1' }), ...(init.cookie ? { Cookie: init.cookie } : {}), ...(init.headers ?? {}) };
  // fetch will not send a Host header of its own choosing, so a request that sets one goes over plain node:http.
  if (headers.Host !== undefined) return rawReq(path, init.method ?? 'GET', headers);
  try {
    const res = await fetch(BASE + path, { method: init.method ?? 'GET', headers, body: (init.body ?? undefined) as BodyInit | undefined, redirect: 'manual' });
    const text = await res.text();
    return { status: res.status, text, type: res.headers.get('content-type') ?? '' };
  } catch (error) {
    // The server dropped the connection (status 0): a finding unless the probe says it may.
    return { status: 0, text: `connection dropped: ${String((error as Error & { cause?: Error })?.cause?.message ?? (error as Error).message)}`, type: '' };
  }
}

function rawReq(path: string, method: string, headers: Record<string, string>): Promise<Answer> {
  return new Promise(resolve => {
    const r = httpRequest({ host: '127.0.0.1', port: PORT, path, method, headers, setHost: false }, res => {
      let text = '';
      res.on('data', d => (text += String(d)));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text, type: String(res.headers['content-type'] ?? '') }));
    });
    r.on('error', e => resolve({ status: 0, text: `connection dropped: ${e.message}`, type: '' }));
    r.end();
  });
}

/** Things that must never appear in an answer: PHP's own messages, stack traces, and the server's folders. */
const LEAK = /PHP (Warning|Notice|Deprecated|Fatal)|Warning: |Notice: |Deprecated: |Fatal error|Stack trace|#\d+ [A-Z]:\\|on line \d+|\/server\/(api|lib)\/|C:\\Users\\|<\?php|Uncaught/;

let probes = 0;
const findings: string[] = [];

/** A request that must come back as a tidy 4xx (or the given statuses), JSON when it is an API, with nothing leaked. */
async function expectTidy(label: string, path: string, init: Parameters<typeof req>[1] = {}, okStatuses: number[] = []): Promise<Answer> {
  probes++;
  const a = await req(path, init);
  // 501 (a PHP extension missing) and 507 (storage full) are this server's own deliberate refusals, in words.
  if (a.status >= 500 && a.status !== 501 && a.status !== 507) findings.push(`${label}: ${a.status} ${a.text.slice(0, 160)}`);
  if (a.status === 0 && !okStatuses.includes(0)) findings.push(`${label}: ${a.text}`);
  if (LEAK.test(a.text)) findings.push(`${label}: the answer leaks: ${a.text.match(LEAK)![0]} ... ${a.text.slice(0, 160)}`);
  if (/<br\s*\/?>|<b>Warning<\/b>/i.test(a.text)) findings.push(`${label}: HTML (a PHP message?) in an API answer: ${a.text.slice(0, 160)}`);
  const head = (init.method ?? 'GET') === 'HEAD';
  if (!head && a.status > 0 && path.startsWith('/api/') && a.status !== 404 && !(a.status >= 200 && a.status < 300 && !a.type.includes('json'))) {
    if (!a.type.includes('application/json')) findings.push(`${label}: an API answer that is not JSON (${a.status}, ${a.type}): ${a.text.slice(0, 120)}`);
    else {
      try {
        const j = JSON.parse(a.text);
        if (a.status >= 400 && (typeof j?.error !== 'string' || j.error.length < 8)) findings.push(`${label}: a refusal (${a.status}) with no words: ${a.text.slice(0, 120)}`);
      } catch {
        findings.push(`${label}: says JSON but is not: ${a.text.slice(0, 120)}`);
      }
    }
  }
  if (okStatuses.length && !okStatuses.includes(a.status)) findings.push(`${label}: expected ${okStatuses.join('/')}, got ${a.status}: ${a.text.slice(0, 160)}`);
  return a;
}

let logMark = 0;

/** Fails with every finding of this test, including anything PHP itself printed meanwhile (warnings arrive a moment late). */
async function report(what: string): Promise<void> {
  await new Promise(r => setTimeout(r, 300));
  const logged = serverLog.slice(logMark);
  logMark = serverLog.length;
  // One line is PHP itself working as meant, not our code: past max_input_vars (1,000) it drops the extra query
  // values before any script runs and logs that it did. (It once also printed it into the JSON answer; with
  // display_errors off, as on a live site, it no longer does, and that answer is still checked.)
  const warnings = [...new Set(logged.match(/PHP (Warning|Notice|Deprecated|Fatal)[^\n]*|Uncaught[^\n]*/g) ?? [])]
    .filter(w => !/PHP Request Startup: Input variables exceeded \d+/.test(w));
  for (const w of warnings) findings.push(`PHP printed on the server during "${what}": ${w.replace(/in [A-Z]:\\[^ ]*\\server\\/, 'in server/').slice(0, 220)}`);
  const list = findings.splice(0);
  assert.ok(list.length === 0, `${what}: ${list.length} finding(s) in ${probes} requests:\n  ${list.slice(0, 15).join('\n  ')}`);
}

/** A browser stand-in that keeps its cookie. */
class Client {
  cookie = '';
  async auth(op: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; json: any }> {
    const res = await fetch(`${BASE}/api/auth.php?op=${op}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Desktop-Store': '1', 'Content-Type': 'application/json', ...(this.cookie ? { Cookie: this.cookie } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) {
      const [pair] = set.split(';');
      this.cookie = /=deleted$|=$/.test(pair) || /Max-Age=0/i.test(set) ? '' : pair;
    }
    return { status: res.status, json: await res.json().catch(() => null) };
  }
}

const skip = !hasPhp;

before(async () => {
  if (skip) return;
  await portFree(PORT);
  rmSync('C:/Users/User/AppData/Local/Temp/fz1', { recursive: true, force: true });
  mkdirSync(DATA, { recursive: true });
  mkdirSync(MODELS, { recursive: true });
  // display_errors off as on a live site (tools/package.mjs writes it into .htaccess and .user.ini); warnings still
  // reach the server's output, which every step here checks.
  php = spawn(PHP, ['-d', 'display_errors=0', '-S', `127.0.0.1:${PORT}`, '-t', 'public', 'server/dev-router.php'], {
    env: { ...process.env, DESKTOP_DATA_DIR: DATA, DESKTOP_MODELS_DIR: MODELS, DESKTOP_QUOTA_MB: '1', DESKTOP_TEST_CAPTCHA: '1', DESKTOP_MAIL_LOG: `${DATA}/mail.log` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  php.stdout!.on('data', d => (serverLog += String(d)));
  php.stderr!.on('data', d => (serverLog += String(d)));
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${BASE}/storage.json`);
      return;
    } catch {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  throw new Error('PHP test server did not start');
});

after(() => {
  php?.kill();
});

const AUTH_OPS = ['status', 'setup', 'login', 'code', 'logout', 'lock', 'unlock', 'password', 'pin', 'totp-begin', 'totp-enable', 'totp-disable', 'recovery-new', 'recovery-key', 'vault', 'vault-rewrap', 'vault-abandon', 'recover-start', 'recover-finish', 'sessions', 'revoke', 'history', 'captcha', 'unlock-mail', 'unlock-link', 'unlock-email', 'site-front', 'users', 'user-create', 'user-password', 'user-disable', 'user-2fa-off', 'nope', '', 'STATUS', 'status%00', '../status', 'status status'];
const DOORS = ['auth', 'store', 'apps', 'books', 'chat', 'mail', 'models', 'modelfile', 'openrouter', 'update', 'ai'];
const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'];

/** Bodies that are not what a door expects. */
const BAD_BODIES: Array<[string, string]> = [
  ['empty', ''], ['null', 'null'], ['a list', '[]'], ['a list of numbers', '[1,2,3]'], ['a string', '"x"'], ['a number', '7'], ['cut short', '{"name":"ow'],
  ['fields of the wrong type', '{"name":[1],"password":{"a":1},"display":null,"next":true,"code":1e308,"id":{},"pin":[],"unlock":[[[]]]}'],
  ['numbers as text fields', '{"name":12345,"password":67890.5}'],
  ['a NUL in every field', JSON.stringify({ name: 'ow\u0000ner', password: 'pa\u0000ss', display: '\u0000', id: '\u0000' })],
  ['unicode lookalikes', JSON.stringify({ name: 'оwner', password: 'lantern-orchard-47', display: 'ο', id: '١٢٣' })],
  ['lone surrogate escapes', '{"name":"\\ud800","password":"\\udc00\\ud800"}'],
  ['a 2 MB name', JSON.stringify({ name: 'a'.repeat(2_000_000), password: 'x' })],
  ['nested 50,000 deep', '{"name":' + '['.repeat(50_000) + ']'.repeat(50_000) + '}'],
  ['duplicate keys', '{"name":"a","name":"owner","password":"x","password":"lantern-orchard-47"}'],
  ['a BOM then JSON', '\ufeff{"name":"owner"}'],
  ['JSON with a trailing comma', '{"name":"owner",}'],
  ['binary junk', String.fromCharCode(...new Rng(BASE_SEED).bytes(300))],
];

let owner: Client;
let other: Client;

test('the owner is set up, then a second person; both are signed in (first, so no fuzz body can take the owner seat)', { skip }, async () => {
  owner = new Client();
  const setup = await owner.auth('setup', { name: OWNER.name, display: 'Owner', password: OWNER.password });
  assert.equal(setup.status, 200, JSON.stringify(setup.json));
  const made = await owner.auth('user-create', { name: OTHER.name, display: 'Guest', next: OTHER.password, password: OWNER.password });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  other = new Client();
  const login = await other.auth('login', { name: OTHER.name, password: OTHER.password });
  assert.equal(login.status, 200, JSON.stringify(login.json));
});

test('every door, signed out, with every method and op: a tidy refusal, never a 500 or a leak', { skip }, async () => {
  for (const door of DOORS) {
    for (const method of METHODS) {
      const ops = door === 'auth' ? AUTH_OPS : ['', 'keys', 'commit', 'list', 'here', 'delete', 'check', 'install', 'state', 'send', 'key', 'test', 'folders', 'message', 'nope', '../x', '%00'];
      for (const op of ops) {
        await expectTidy(`${method} /api/${door}.php?op=${op} signed out`, `/api/${door}.php?op=${op}`, { method, body: method === 'GET' || method === 'HEAD' ? undefined : '{}' });
      }
    }
  }
  await report('signed out');
});

test('without the desktop header, or with a foreign Host or Origin, every door says no (never 2xx)', { skip }, async () => {
  for (const door of DOORS) {
    const a = await expectTidy(`/api/${door}.php without X-Desktop-Store`, `/api/${door}.php?op=status`, { noDesktop: true });
    if (a.status < 400) findings.push(`/api/${door}.php answered ${a.status} without the desktop's own header`);
    const h = await expectTidy(`/api/${door}.php with Host evil.example`, `/api/${door}.php?op=status`, { headers: { Host: 'evil.example' } });
    if (h.status < 400) findings.push(`/api/${door}.php answered ${h.status} to Host: evil.example (DNS rebinding)`);
    const o = await expectTidy(`/api/${door}.php with Origin https://evil.example`, `/api/${door}.php?op=status`, { headers: { Origin: 'https://evil.example' } });
    if (o.status < 400) findings.push(`/api/${door}.php answered ${o.status} to a foreign Origin`);
  }
  for (const host of ['127.0.0.1:1', 'localhost.evil.example', 'xn--localhost', '127.0.0.1.evil.example', '[::1]', 'LOCALHOST', 'localhost:3301:3301', '']) {
    await expectTidy(`auth status with Host ${JSON.stringify(host)}`, '/api/auth.php?op=status', { headers: { Host: host } });
  }
  await report('header checks');
});

test('bodies that are not what a door expects: refused in words, never a 500 or a warning', { skip }, async () => {
  for (const op of ['setup', 'login', 'code', 'unlock', 'password', 'pin', 'user-create', 'recover-start', 'recover-finish', 'unlock-mail', 'unlock-link', 'vault', 'site-front']) {
    for (const [name, body] of BAD_BODIES) {
      await expectTidy(`auth ${op} with ${name}`, `/api/auth.php?op=${op}`, { method: 'POST', body, headers: { 'Content-Type': 'application/json' } });
    }
  }
  for (const door of ['chat', 'mail', 'apps', 'books', 'models', 'openrouter', 'update', 'ai']) {
    for (const [name, body] of BAD_BODIES.slice(0, 10)) {
      await expectTidy(`${door} with ${name}`, `/api/${door}.php?op=send`, { method: 'POST', body, headers: { 'Content-Type': 'application/json' } });
    }
  }
  // Content types that lie.
  for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/json; charset=utf-16', 'application/octet-stream', '']) {
    await expectTidy(`auth login as ${ct || 'no content type'}`, '/api/auth.php?op=login', { method: 'POST', body: 'name=owner&password=x', headers: ct ? { 'Content-Type': ct } : {} });
  }
  await report('bad bodies');
});

test('repeated and odd query parameters', { skip }, async () => {
  for (const q of ['op=status&op=login', 'op[]=status', 'op[a]=status', 'op=status&key=/', 'key=/&key=../', 'key[]=/', 'key[a]=../', 'op=%73tatus', 'op=status%20', 'op=status&' + 'x=1&'.repeat(5000), 'op=' + 'a'.repeat(100_000), 'op=status#frag', 'op=status;login', '%6fp=status', 'op=setup&name=owner&password=x']) {
    const may = q.length > 50_000 ? [0, 400, 405, 414, 431] : [];
    await expectTidy(`auth ?${q.slice(0, 60)}`, `/api/auth.php?${q}`, {}, may);
    await expectTidy(`store ?${q.slice(0, 60)}`, `/api/store.php?${q}`, {}, may);
  }
  await report('query parameters');
});

test('the static router: path tricks reach nothing outside public/', { skip }, async () => {
  const tricks = ['/../server/config.example.php', '/%2e%2e/server/config.example.php', '/..%2fserver%2fconfig.example.php', '/..%5cserver%5cconfig.example.php', '/%252e%252e/server/lib/auth.php', '/server/lib/auth.php', '/%00', '/index.html%00.txt', '/CON', '/con.html', '/NUL', '/AUX.js', '/COM1', '/LPT1.css', '/index.html::$DATA', '/index.html.', '/index.html ', '/%2e/index.html', '/./index.html', '/' + 'a/'.repeat(2000) + 'index.html', '/' + 'x'.repeat(10_000), '/İndex.html', '/ındex.html', '/apps/../../server/api/auth.php', '/apps/%2e%2e/%2e%2e/package.json', '/models/../server/config.example.php', '/models/%00', '/models/', '/storage.json/../index.html', '/\\server\\config.example.php', '/%5c%5cserver', '/api/../package.json', '/api/auth.php/../../package.json', '/api/auth%2ephp', '/api/AUTH.PHP', '/api/auth.php%00', '/api/auth.phtml', '/api/.htaccess', '/.git/HEAD', '/.htaccess', '/package.json', '/..', '/.'];
  for (const path of tricks) {
    const a = await expectTidy(`static ${path.slice(0, 50)}`, path);
    if (a.status < 400 && /<\?php|'data_dir'|allow_remote|DESKTOP_DATA_DIR/.test(a.text)) findings.push(`static ${path.slice(0, 60)}: served a server file (${a.status})`);
    if (a.status === 200 && /\/\.(git|htaccess)|package\.json/.test(path) && a.text.length) findings.push(`static ${path}: served a file that should not be public (${a.status})`);
  }
  await report('static paths');
});

const UUID = '0f8fafd6-5d1b-4c3e-9b21-5a6f7e8d9c01';

/** A commit body: op, key, expected version, (data). */
function commit(parts: Array<{ op: number; key: string; expect: string; data?: Uint8Array }>): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const p of parts) {
    const k = enc.encode(p.key);
    const e = enc.encode(p.expect);
    const head = new Uint8Array(1 + 2 + k.length + 1 + e.length + (p.op === 1 ? 4 : 0));
    const v = new DataView(head.buffer);
    v.setUint8(0, p.op);
    v.setUint16(1, k.length, true);
    head.set(k, 3);
    v.setUint8(3 + k.length, e.length);
    head.set(e, 4 + k.length);
    if (p.op === 1) v.setUint32(4 + k.length + e.length, p.data?.length ?? 0, true);
    chunks.push(head);
    if (p.op === 1 && p.data) chunks.push(p.data);
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

test('the file store, signed in: hostile keys and damaged commit bodies are refused in words, never a 500', { skip }, async () => {
  const cookie = () => ({ cookie: other.cookie });
  // Keys: only "/" or a version-4 UUID are keys; everything else is a 400 (never a path).
  for (const key of ['../x', '%2e%2e%2f', '/..', '/x', 'CON', 'nul', `${UUID}/../x`, `${UUID}%00`, 'x'.repeat(10_000), '', 'root', 'objects/ro/root', UUID.toUpperCase(), UUID.replace('-4', '-5'), '０f8fafd6-5d1b-4c3e-9b21-5a6f7e8d9c01', '/\u0000', '//', '\\']) {
    await expectTidy(`store GET key=${encodeURIComponent(key).slice(0, 40)}`, `/api/store.php?key=${encodeURIComponent(key)}`, cookie(), [400, 404]);
  }
  // A real put, then a read, so the store is known to work before it is fed junk.
  const put = await expectTidy('store commit one record', '/api/store.php?op=commit', { method: 'POST', body: commit([{ op: 1, key: UUID, expect: '*', data: new TextEncoder().encode('hello') }]), headers: { 'Content-Type': 'application/octet-stream' }, ...cookie() }, [200]);
  assert.equal(put.status, 200, put.text);
  const got = await expectTidy('store GET the record', `/api/store.php?key=${UUID}`, cookie(), [200]);
  assert.equal(got.text, 'hello');
  // Commit bodies: every damage, each must be a 400 in words.
  const bodies: Array<[string, Uint8Array]> = [
    ['empty', new Uint8Array(0)],
    ['one byte', new Uint8Array([1])],
    ['op 0', commit([{ op: 0, key: UUID, expect: '*' }])],
    ['op 255', commit([{ op: 255, key: UUID, expect: '*' }])],
    ['a key of ../', commit([{ op: 1, key: '../root', expect: '*', data: new Uint8Array(1) }])],
    ['a key with a NUL', commit([{ op: 1, key: `${UUID}\u0000`, expect: '*', data: new Uint8Array(1) }])],
    ['a version of 32 Zs', commit([{ op: 1, key: UUID, expect: 'Z'.repeat(32), data: new Uint8Array(1) }])],
    ['a version of 255 bytes', commit([{ op: 1, key: UUID, expect: 'f'.repeat(255), data: new Uint8Array(1) }])],
    ['data length past the body', (() => { const b = commit([{ op: 1, key: UUID, expect: '*', data: new Uint8Array(4) }]); new DataView(b.buffer).setUint32(b.length - 8, 0xffffffff, true); return b; })()],
    ['key length past the body', (() => { const b = commit([{ op: 1, key: UUID, expect: '*', data: new Uint8Array(1) }]); new DataView(b.buffer).setUint16(1, 65535, true); return b; })()],
    ['a put cut short', commit([{ op: 1, key: UUID, expect: '*', data: new Uint8Array(100) }]).slice(0, 60)],
    ['10,001 deletes', commit(Array.from({ length: 10_001 }, () => ({ op: 2, key: UUID, expect: '' })))],
    ['a stale version', commit([{ op: 1, key: UUID, expect: '0'.repeat(32), data: new Uint8Array(1) }])],
    ['check then put of the same key', commit([{ op: 3, key: UUID, expect: '*' }, { op: 1, key: UUID, expect: '*', data: new Uint8Array(1) }])],
    ['a 1.5 MB put (over the 1 MB quota)', commit([{ op: 1, key: UUID, expect: '*', data: new Uint8Array(1_500_000) }])],
  ];
  for (const [name, body] of bodies) {
    await expectTidy(`store commit ${name}`, '/api/store.php?op=commit', { method: 'POST', body, headers: { 'Content-Type': 'application/octet-stream' }, ...cookie() });
  }
  // Random bytes, seeded: the parser must refuse each one in words.
  for (let i = 0; i < 40; i++) {
    const s = (BASE_SEED + i * 7) >>> 0;
    const rng = new Rng(s);
    const body = rng.chance(0.5) ? rng.bytes(rng.int(1, 400)) : (() => { const b = commit([{ op: 1, key: UUID, expect: '*', data: rng.bytes(rng.int(0, 200)) }]); for (let k = rng.int(1, 4); k > 0; k--) b[rng.int(0, b.length - 1)] ^= 1 << rng.int(0, 7); return b; })();
    await expectTidy(`store commit random seed=${s}`, '/api/store.php?op=commit', { method: 'POST', body, headers: { 'Content-Type': 'application/octet-stream' }, ...cookie() });
  }
  // The sealed claim header with nonsense.
  for (const sealed of ['1', '0', 'yes', '', 'x'.repeat(1000), 'true', '%D9%A1']) {
    await expectTidy(`store commit with X-Store-Sealed ${JSON.stringify(sealed).slice(0, 20)}`, '/api/store.php?op=commit', { method: 'POST', body: commit([{ op: 1, key: UUID, expect: '*', data: new Uint8Array(1) }]), headers: { 'Content-Type': 'application/octet-stream', 'X-Store-Sealed': sealed }, ...cookie() });
  }
  await expectTidy('store keys', '/api/store.php?op=keys', cookie(), [200]);
  await expectTidy('store PUT', '/api/store.php?key=/', { method: 'PUT', body: 'x', ...cookie() }, [405]);
  await expectTidy('store DELETE', `/api/store.php?key=${UUID}`, { method: 'DELETE', ...cookie() }, [405]);
  await report('store, signed in');
});

test('signed in as the guest (not the owner): the owner-only doors say no; bad bodies still never 500', { skip }, async () => {
  const cookie = { cookie: other.cookie };
  for (const op of ['users', 'history', 'sessions']) {
    const a = await expectTidy(`guest GET ${op}`, `/api/auth.php?op=${op}`, cookie);
    if (op === 'users' && a.status < 400) findings.push(`guest could list users (${a.status})`);
  }
  for (const op of ['user-create', 'user-password', 'user-disable', 'user-2fa-off', 'site-front']) {
    const a = await expectTidy(`guest POST ${op}`, `/api/auth.php?op=${op}`, { method: 'POST', body: JSON.stringify({ name: 'third', next: 'another-good-one-9', id: 'x', password: OTHER.password, front: 'x' }), headers: { 'Content-Type': 'application/json' }, ...cookie });
    if (a.status < 400) findings.push(`guest was allowed ${op} (${a.status}): ${a.text.slice(0, 120)}`);
  }
  for (const door of ['apps', 'books', 'chat', 'mail', 'models', 'openrouter', 'update', 'ai']) {
    for (const [name, body] of BAD_BODIES.slice(0, 12)) {
      await expectTidy(`guest ${door} with ${name}`, `/api/${door}.php?op=send`, { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, ...cookie });
    }
    for (const op of ['', 'list', 'here', 'check', 'install', 'state', 'folders', 'key', 'nope']) await expectTidy(`guest GET ${door} ${op}`, `/api/${door}.php?op=${op}`, cookie);
  }
  for (const op of ['password', 'pin', 'totp-enable', 'recovery-new', 'vault', 'unlock', 'revoke', 'code']) {
    for (const [name, body] of BAD_BODIES.slice(0, 12)) await expectTidy(`guest auth ${op} with ${name}`, `/api/auth.php?op=${op}`, { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, ...cookie });
  }
  // Models files: only signed-in people, and never a path outside the models folder.
  for (const path of ['/models/../server/config.example.php', '/models/%2e%2e/package.json', '/models/x%00.bin', '/models/CON', '/models/' + 'a'.repeat(5000)]) await expectTidy(`guest ${path.slice(0, 50)}`, path, cookie);
  await report('guest');
});

test('locked screen: the store is 423 and the lock cannot be skipped by a malformed unlock', { skip }, async () => {
  const lock = await other.auth('lock', {});
  assert.equal(lock.status, 200, JSON.stringify(lock.json));
  const cookie = { cookie: other.cookie };
  await expectTidy('store while locked', `/api/store.php?key=${UUID}`, cookie, [423]);
  await expectTidy('store commit while locked', '/api/store.php?op=commit', { method: 'POST', body: commit([{ op: 1, key: UUID, expect: '*', data: new Uint8Array(1) }]), headers: { 'Content-Type': 'application/octet-stream' }, ...cookie }, [423]);
  for (const door of ['apps', 'chat', 'mail', 'books']) {
    const a = await expectTidy(`${door} while locked`, `/api/${door}.php?op=list`, cookie);
    if (a.status < 400) findings.push(`${door} answered ${a.status} while the screen was locked`);
  }
  for (const [name, body] of BAD_BODIES) {
    const a = await expectTidy(`unlock with ${name}`, '/api/auth.php?op=unlock', { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, ...cookie });
    if (a.status === 200 && /"locked":false/.test(a.text)) findings.push(`unlock with ${name} opened the screen`);
  }
  // After the wrong tries the screen is still locked, or the session was ended for too many wrong tries (by design):
  // either way nothing opened.
  const status = await other.auth('status');
  assert.ok(status.json?.locked === true || status.json?.signedIn === false, `after the bad unlocks: ${JSON.stringify(status.json)}`);
  if (status.json?.signedIn === false) {
    // Too many wrong tries also put the brake on the name (429 "held") for a while: that is the brake working, not a fault.
    const again = await other.auth('login', { name: OTHER.name, password: OTHER.password });
    assert.ok(again.status === 200 || (again.status === 429 && again.json?.held === true), JSON.stringify(again.json));
  } else {
    const unlock = await other.auth('unlock', { password: OTHER.password });
    assert.equal(unlock.status, 200, JSON.stringify(unlock.json));
  }
  await report('locked');
});

test('cookies that are not sessions, and sessions of other people', { skip }, async () => {
  const name = owner.cookie.split('=')[0];
  for (const value of ['', 'x', 'a'.repeat(10_000), '../../x', '%00', 'deleted', owner.cookie.split('=')[1]?.slice(0, 10) ?? 'short', '%D0%9E%D0%9E', '"quoted"', 'a=b=c']) {
    await expectTidy(`auth status with cookie ${name}=${value.slice(0, 20)}`, '/api/auth.php?op=status', { cookie: `${name}=${value}` }, [200]);
    await expectTidy(`store with cookie ${name}=${value.slice(0, 20)}`, '/api/store.php?key=/', { cookie: `${name}=${value}` }, [401]);
  }
  await expectTidy('two cookies at once', '/api/auth.php?op=status', { cookie: `${owner.cookie}; ${other.cookie}` }, [200]);
  // PHP's own server may drop a 100 KB header line (status 0) or refuse it (431): either is tidy.
  await expectTidy('a cookie header 100 KB long', '/api/auth.php?op=status', { cookie: `${name}=${'z'.repeat(100_000)}` }, [0, 400, 431]);
  await report('cookies');
});
