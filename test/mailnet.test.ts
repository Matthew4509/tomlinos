// The server's own IMAP and SMTP client (server/lib/mailnet.php), run by PHP against the stand-in mail server, and
// the rules on where it may connect. Needs PHP (PHP_BIN, or "php" on the PATH); skipped without it.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PHP, hasPhp } from './php-bin.ts';

const root = join(import.meta.dirname, '..');
const fakeUrl = new URL('./fake-mail.mjs', import.meta.url).href;
const { startFakeMail, USER, PASS } = (await import(fakeUrl)) as {
  startFakeMail(p: { imap: number; smtp: number }): Promise<{ delivered: Array<{ from: string; to: string[]; raw: string }>; close(): Promise<unknown> }>;
  USER: string;
  PASS: string;
};

function script(code: string): { file: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tomlinos-mailnet-'));
  const file = join(dir, 't.php');
  writeFileSync(file, `<?php\nrequire ${JSON.stringify(join(root, 'server/lib/http.php'))};\nrequire ${JSON.stringify(join(root, 'server/lib/mailnet.php'))};\n${code}`);
  return { file, dir };
}

function php(code: string, env: Record<string, string> = {}): unknown {
  const { file, dir } = script(code);
  return JSON.parse(execFileSync(PHP, [file], { env: { ...process.env, DESKTOP_DATA_DIR: dir, ...env }, encoding: 'utf8', timeout: 30000 }));
}

/** For talking to the stand-in server, which runs in this process: waiting synchronously would stop it answering. */
function phpAsync(code: string, env: Record<string, string> = {}): Promise<unknown> {
  const { file, dir } = script(code);
  return new Promise((resolve, reject) => execFile(PHP, [file], { env: { ...process.env, DESKTOP_DATA_DIR: dir, ...env }, encoding: 'utf8', timeout: 30000 }, (error, out, err) => {
    if (error) reject(new Error(`${error.message}\n${err}`));
    else resolve(JSON.parse(out));
  }));
}

const has = hasPhp;

test('where the server may connect: public mail servers only, encrypted, on mail ports', { skip: !has && 'no PHP' }, () => {
  const tries = php(`
    $out = [];
    foreach ([['127.0.0.1', 993, 'ssl'], ['10.1.2.3', 993, 'ssl'], ['169.254.169.254', 993, 'ssl'], ['192.168.1.5', 587, 'starttls'],
              ['100.64.1.1', 993, 'ssl'], ['8.8.8.8', 80, 'ssl'], ['8.8.8.8', 993, 'none'], ['bad host!', 993, 'ssl'], ['8.8.8.8', 993, 'ssl']] as [$h, $p, $s]) {
      try { mail_resolve($h, $p, $s); $out[] = 'allowed'; } catch (MailError $e) { $out[] = $e->getMessage(); }
    }
    echo json_encode($out);`) as string[];
  assert.match(tries[0], /inside the server's own network/);
  assert.match(tries[1], /inside the server's own network/);
  assert.match(tries[2], /inside the server's own network/, 'the cloud metadata address');
  assert.match(tries[3], /inside the server's own network/);
  assert.match(tries[4], /inside the server's own network/, 'carrier-grade shared addresses');
  assert.match(tries[5], /not a mail port/);
  assert.match(tries[6], /encrypted connection/);
  assert.match(tries[7], /not a server name/);
  assert.equal(tries[8], 'allowed');
});

test('IPv6: only global addresses, and an IPv4 address carried inside one is judged as IPv4', { skip: !has && 'no PHP' }, () => {
  const r = php(`
    $out = [];
    foreach (['::1', '::ffff:127.0.0.1', 'fe80::1', 'fd00::1', '64:ff9b::7f00:1', '2002:7f00:1::1', '2002:a00:1::1', '2001:4860:4860::8888', '64:ff9b::808:808'] as $h) {
      try { mail_resolve($h, 993, 'ssl'); $out[$h] = 'allowed'; } catch (MailError $e) { $out[$h] = 'refused'; }
    }
    echo json_encode($out);`) as Record<string, string>;
  assert.deepEqual(r, {
    '::1': 'refused', '::ffff:127.0.0.1': 'refused', 'fe80::1': 'refused', 'fd00::1': 'refused', '64:ff9b::7f00:1': 'refused',
    '2002:7f00:1::1': 'refused', '2002:a00:1::1': 'refused', '2001:4860:4860::8888': 'allowed', '64:ff9b::808:808': 'allowed',
  });
});

test('a listed own-network host is allowed, and plain only with mail_allow_plain', { skip: !has && 'no PHP' }, () => {
  const run = (plain: string) => php(`try { mail_resolve('127.0.0.1', 3143, 'none'); echo json_encode('allowed'); } catch (MailError $e) { echo json_encode($e->getMessage()); }`, { DESKTOP_MAIL_ALLOW_HOSTS: '127.0.0.1:3143', DESKTOP_MAIL_ALLOW_PLAIN: plain });
  assert.equal(run('1'), 'allowed');
  assert.match(String(run('0')), /encrypted connection/);
});

test('IMAP and SMTP against the stand-in: sign in, folders, headers, a message, flags, move, send, copy to Sent', { skip: !has && 'no PHP' }, async () => {
  const mail = await startFakeMail({ imap: 3243, smtp: 3687 });
  try {
    const env = { DESKTOP_MAIL_ALLOW_HOSTS: '127.0.0.1:3243,127.0.0.1:3687', DESKTOP_MAIL_ALLOW_PLAIN: '1' };
    const r = await phpAsync(`
      $i = new Imap('127.0.0.1', 3243, 'none', ${JSON.stringify(USER)}, ${JSON.stringify(PASS)});
      $folders = $i->folders();
      [$n] = $i->select('INBOX');
      $uids = $i->uids();
      $heads = $i->summaries($uids);
      $raw = $i->message(3);
      $i->flag([1], '\\\\Flagged', true);
      $i->move([2], 'Trash');
      $after = $i->uids();
      $found = $i->uids('TEXT ' . Imap::q('magnolia'));
      $message = mail_build(['from' => ${JSON.stringify(USER)}, 'fromName' => 'Mé', 'to' => ['ann@example.org'], 'cc' => [], 'subject' => 'Ré: pruning', 'text' => "Yes.\\n.\\nA line with a dot above.",
        'inReplyTo' => '<m1@example.org>', 'references' => '', 'attachments' => [['name' => 'a.txt', 'type' => 'text/plain', 'data' => base64_encode('hello')]]]);
      $s = new Smtp('127.0.0.1', 3687, 'none', ${JSON.stringify(USER)}, ${JSON.stringify(PASS)});
      $s->deliver(${JSON.stringify(USER)}, ['ann@example.org', 'bcc@example.org'], $message);
      $s->quit();
      $i->append('Sent', $message);
      $i->select('Sent');
      $sent = count($i->uids());
      try { new Imap('127.0.0.1', 3243, 'none', ${JSON.stringify(USER)}, 'wrong'); $bad = 'signed in'; } catch (MailError $e) { $bad = $e->getMessage(); }
      $i->logout();
      echo json_encode(['folders' => array_column($folders, 'use', 'name'), 'n' => $n, 'uids' => $uids, 'subjects' => array_map(fn ($h) => $h['head'], $heads),
        'raw' => $raw, 'after' => $after, 'found' => $found, 'sent' => $sent, 'bad' => $bad]);`, env) as Record<string, unknown>;
    assert.deepEqual(r.folders, { INBOX: 'inbox', Sent: 'sent', Trash: 'trash', 'Projects/Garden': null });
    assert.equal(r.n, 3);
    assert.deepEqual(r.uids, [1, 2, 3]);
    assert.match((r.subjects as string[])[0], /Subject: Invoice attached/, 'newest first');
    assert.match(r.raw as string, /Invoice 42|SW52b2ljZSA0Mj/);
    assert.deepEqual(r.after, [1, 3], 'message 2 moved to Trash');
    assert.deepEqual(r.found, [1]);
    assert.equal(r.sent, 1, 'a copy is in Sent');
    assert.match(r.bad as string, /refused the name or password/);
    assert.equal(mail.delivered.length, 1);
    const d = mail.delivered[0];
    assert.deepEqual(d.to, ['ann@example.org', 'bcc@example.org']);
    assert.ok(!/bcc@example\.org/.test(d.raw.split('\r\n\r\n')[0]), 'Bcc is not in the headers');
    assert.match(d.raw, /Subject: =\?UTF-8\?B\?/);
    assert.match(d.raw, /In-Reply-To: <m1@example\.org>/);
    assert.match(d.raw, /Content-Disposition: attachment; filename="a.txt"/);
    assert.match(d.raw, /\r\n\.\r\nA line with a dot above|=2E|\r\n\.\r\n/, 'a lone dot survives the trip');
  } finally {
    await mail.close();
  }
});

test('header text cannot break out of its line (no injected headers)', { skip: !has && 'no PHP' }, () => {
  const r = php(`echo json_encode(mail_build(['from' => 'a@b.cd', 'to' => ['c@d.ef'], 'cc' => [], 'subject' => "Hi\\r\\nBcc: victim@x.yz", 'text' => 'x', 'attachments' => []]));`) as string;
  const head = r.split('\r\n\r\n')[0];
  assert.ok(!/^Bcc:/m.test(head), head);
});

test('no PHP string runs a variable into a curly quote (PHP reads the quote as part of the name)', () => {
  const files: string[] = [];
  // Our own PHP only: server/vendor is Anthropic's official library and its HTTP client (thousands of files).
  const walk = (d: string) => readdirSync(d).forEach(n => (statSync(join(d, n)).isDirectory() ? n !== 'vendor' && walk(join(d, n)) : n.endsWith('.php') && files.push(join(d, n))));
  walk(join(root, 'server'));
  for (const f of files) {
    const bad = /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7f]/.exec(readFileSync(f, 'utf8'));
    assert.equal(bad, null, `${f}: ${bad?.[0]} (write {$name} instead)`);
  }
  assert.ok(files.length > 5);
});
