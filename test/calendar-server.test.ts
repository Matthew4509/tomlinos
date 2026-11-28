// The Calendar's subscription fetch (server/api/calendar.php, lib/icalfetch.php) against the real PHP server on a
// throw-away data folder, with a stand-in calendar site on this computer. The stand-in is the only private address
// the server is allowed (DESKTOP_ICAL_ALLOW_HOSTS, as the browser tests set it); every other address on this computer
// or inside a network must be refused before anything is fetched.
// Needs PHP with curl: set PHP_BIN to its path, or have "php" on the PATH.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PHP, extFlags, hasPhp, portFree } from './php-bin.ts';

const noPhp = !hasPhp && 'no PHP';
// 3763 and 3764: not used by any other test.
const PORT = 3763;
const SITE = 3764;
const BASE = `http://127.0.0.1:${PORT}`;
const STAND_IN = `http://127.0.0.1:${SITE}`;
const data = mkdtempSync(join(tmpdir(), 'desktop-calendar-server-'));
const PASS = 'willow-compass-73';
let php: ChildProcess;
let site: Server;
let cookie = '';
const hits: string[] = [];

const CAL = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:Stand-in\r\nBEGIN:VEVENT\r\nUID:a@x\r\nDTSTART:20261201T090000Z\r\nSUMMARY:Hello\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';

async function call(body: unknown, signedIn = true): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}/api/calendar.php?op=fetch`, {
    method: 'POST',
    headers: { 'X-Desktop-Store': '1', 'Content-Type': 'application/json', ...(cookie && signedIn ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

before(async () => {
  if (noPhp) return;
  await portFree(PORT);
  await portFree(SITE);
  site = createServer((req, res) => {
    hits.push(req.url ?? '');
    if (req.url === '/cal.ics') return void res.writeHead(200, { 'Content-Type': 'text/calendar' }).end(CAL);
    if (req.url === '/bom.ics') return void res.writeHead(200, { 'Content-Type': 'text/calendar' }).end('﻿' + CAL);
    if (req.url === '/big.ics') return void res.writeHead(200).end('BEGIN:VCALENDAR\r\n' + 'X'.repeat(5 * 1024 * 1024));
    if (req.url === '/page') return void res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Sign in</title>');
    if (req.url === '/gone') return void res.writeHead(404).end('no');
    if (req.url === '/to-cal') return void res.writeHead(302, { Location: '/cal.ics' }).end();
    if (req.url === '/to-private') return void res.writeHead(302, { Location: 'http://10.0.0.1/cal.ics' }).end();
    if (req.url === '/to-metadata') return void res.writeHead(301, { Location: 'https://meta.example/latest/meta-data' }).end();
    if (req.url === '/loop') return void res.writeHead(302, { Location: '/loop' }).end();
    if (req.url === '/slow') return; // never answers
    res.writeHead(500).end();
  });
  await new Promise<void>(r => site.listen(SITE, '127.0.0.1', r));
  php = spawn(PHP, [...extFlags('openssl', 'curl', 'mbstring'), '-S', `127.0.0.1:${PORT}`, '-t', 'public', 'server/dev-router.php'], {
    env: {
      ...process.env, DESKTOP_DATA_DIR: data, DESKTOP_TEST_CAPTCHA: '1', DESKTOP_ICAL_ALLOW_HOSTS: `127.0.0.1:${SITE}`, DESKTOP_ICAL_TIMEOUT: '3',
      // Made-up names for addresses inside a network, as a hostile DNS could give them.
      DESKTOP_ICAL_TEST_DNS: 'evil.example=127.0.0.1,meta.example=169.254.169.254,lan.example=192.168.1.10,v6.example=::1,mapped.example=::ffff:10.0.0.1,cgnat.example=100.64.0.1',
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${BASE}/storage.json`);
      break;
    } catch {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  const res = await fetch(`${BASE}/api/auth.php?op=setup`, { method: 'POST', headers: { 'X-Desktop-Store': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'robin', password: PASS }) });
  assert.equal(res.status, 200);
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
});

after(() => {
  php?.kill();
  site?.close();
  rmSync(data, { recursive: true, force: true });
});

test('a signed-out request is refused', { skip: noPhp }, async () => {
  const r = await call({ url: `${STAND_IN}/cal.ics` }, false);
  assert.equal(r.status, 401);
});

test('a calendar at an allowed address is fetched, a byte-order mark dropped, a redirect followed', { skip: noPhp }, async () => {
  const r = await call({ url: `${STAND_IN}/cal.ics` });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.text, CAL);
  assert.equal((await call({ url: `${STAND_IN}/bom.ics` })).json.text, CAL);
  assert.equal((await call({ url: `${STAND_IN}/to-cal` })).json.text, CAL);
});

test('only https: plain http and other schemes are refused (unless the owner listed the host)', { skip: noPhp }, async () => {
  for (const url of ['http://example.com/cal.ics', 'ftp://example.com/cal.ics', 'file:///etc/passwd', 'gopher://example.com/', 'javascript:alert(1)']) {
    const r = await call({ url });
    assert.equal(r.status, 422, url);
    assert.match(r.json.error, /secure|not a web address/, url);
  }
});

test('addresses on this computer or inside a network are refused before anything is fetched', { skip: noPhp }, async () => {
  const before = hits.length;
  for (const url of [
    'https://127.0.0.1/cal.ics', `https://127.0.0.1:${SITE + 1}/cal.ics`, 'https://[::1]/cal.ics', 'https://10.1.2.3/cal.ics', 'https://169.254.169.254/latest/meta-data',
    'https://evil.example/cal.ics', 'https://meta.example/cal.ics', 'https://lan.example/cal.ics', 'https://v6.example/cal.ics', 'https://mapped.example/cal.ics', 'https://cgnat.example/cal.ics',
    'https://0x7f000001/cal.ics', 'https://2130706433/cal.ics', 'https://localhost/cal.ics',
  ]) {
    const r = await call({ url });
    assert.equal(r.status, 422, `${url}: ${JSON.stringify(r.json)}`);
    assert.match(r.json.error, /inside the server's own network|other ports|does not name a web site|could not be found/, url);
  }
  assert.equal(hits.length, before, 'the stand-in was not asked');
});

test('a redirect to a private or metadata address is refused', { skip: noPhp }, async () => {
  assert.match((await call({ url: `${STAND_IN}/to-private` })).json.error, /secure|inside/);
  assert.match((await call({ url: `${STAND_IN}/to-metadata` })).json.error, /inside the server's own network/);
  assert.match((await call({ url: `${STAND_IN}/loop` })).json.error, /too many times/);
});

test('a link with a name and password, an odd port, or hidden characters is refused', { skip: noPhp }, async () => {
  assert.match((await call({ url: 'https://me:secret@example.com/cal.ics' })).json.error, /name and password/);
  assert.match((await call({ url: 'https://example.com:8443/cal.ics' })).json.error, /other ports/);
  assert.match((await call({ url: 'https://example.com/a b.ics' })).json.error, /spaces or hidden/);
  assert.match((await call({ url: '' })).json.error, /Paste/);
});

test('too large, too slow, not a calendar, or not there: each refused in words', { skip: noPhp }, async () => {
  assert.match((await call({ url: `${STAND_IN}/big.ics` })).json.error, /larger than 4 MB/);
  const t0 = Date.now();
  assert.match((await call({ url: `${STAND_IN}/slow` })).json.error, /too long/);
  assert.ok(Date.now() - t0 < 10000, 'the time limit held');
  assert.match((await call({ url: `${STAND_IN}/page` })).json.error, /web page, not a calendar/);
  assert.match((await call({ url: `${STAND_IN}/gone` })).json.error, /no calendar at that link \(404\)/);
});
