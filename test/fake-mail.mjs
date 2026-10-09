// A stand-in mail server for the browser tests: the part of IMAP and SMTP that TOMLIN OS Mail uses, unencrypted, on
// 127.0.0.1 only. The PHP server may reach it because the test run lists it in DESKTOP_MAIL_ALLOW_HOSTS with
// DESKTOP_MAIL_ALLOW_PLAIN=1 (a real install refuses both). Sent mail is kept in `delivered` and also lands in INBOX.
//   import { startFakeMail } from './fake-mail.mjs';  const mail = await startFakeMail({ imap: 3143, smtp: 3587 });
import { createServer } from 'node:net';

export const USER = 'me@example.test';
export const PASS = 'mail-pass-123';

function msg(lines) {
  return lines.join('\r\n') + '\r\n';
}

function seed() {
  const inbox = [
    msg(['From: Ann Lee <ann@example.org>', `To: ${USER}`, 'Subject: Pruning on Friday', 'Date: Thu, 24 Sep 2026 09:00:00 +1000', 'Message-ID: <m1@example.org>', 'Content-Type: text/plain; charset=utf-8', '', 'Hi, can you prune the magnolia on Friday at 10?', 'See https://example.org/map for the address.', '', 'Ann']),
    msg(['From: "Shop" <news@shop.example>', `To: ${USER}`, 'Subject: =?UTF-8?B?U3BlY2lhbCBvZmZlciDinIU=?=', 'Date: Fri, 25 Sep 2026 12:00:00 +1000', 'Message-ID: <m2@shop.example>', 'MIME-Version: 1.0', 'Content-Type: text/html; charset=utf-8', '',
      '<html><head><style>body{background:red}</style><script>parent.document.title="HACKED"</script></head><body>',
      '<h1 onclick="alert(1)">Big sale</h1><p>Look: <img src="https://tracker.example/pixel.gif" alt="logo"> <a href="javascript:alert(2)">bad link</a> <a href="https://shop.example/sale">real link</a></p>',
      '<iframe src="https://evil.example"></iframe><form action="https://evil.example"><input name=x></form></body></html>']),
    msg(['From: Bo <bo@example.net>', `To: ${USER}`, 'Cc: team@example.net', 'Subject: Invoice attached', 'Date: Sat, 26 Sep 2026 08:30:00 +1000', 'Message-ID: <m3@example.net>', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="B"', '',
      '--B', 'Content-Type: text/plain; charset=utf-8', '', 'Invoice for September attached.', '--B', 'Content-Type: text/plain; name="invoice.txt"', 'Content-Disposition: attachment; filename="invoice.txt"', 'Content-Transfer-Encoding: base64', '',
      Buffer.from('Invoice 42: $150 for pruning').toString('base64'), '--B--']),
  ];
  const box = (msgs, seen = false) => ({ validity: 7, next: msgs.length + 1, msgs: msgs.map((raw, i) => ({ uid: i + 1, raw, flags: new Set(seen ? ['\\Seen'] : []), date: new Date(Date.UTC(2026, 8, 24 + i)) })) });
  return {
    INBOX: box(inbox),
    Sent: box([], true),
    Trash: box([], true),
    'Projects/Garden': box([msg(['From: me@example.test', 'Subject: Old note', 'Date: Mon, 1 Jun 2026 10:00:00 +1000', '', 'kept'])], true),
  };
}

const USES = { Sent: '\\Sent', Trash: '\\Trash' };

function imapDate(d) {
  const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  return `${String(d.getUTCDate()).padStart(2, '0')}-${m}-${d.getUTCFullYear()} 10:00:00 +0000`;
}

function uidSet(text, box) {
  const out = new Set();
  for (const part of text.split(',')) {
    const [a, b] = part.split(':');
    const max = box.msgs.length ? Math.max(...box.msgs.map(m => m.uid)) : 0;
    const lo = a === '*' ? max : Number(a);
    const hi = b === undefined ? lo : b === '*' ? max : Number(b);
    for (const m of box.msgs) if (m.uid >= Math.min(lo, hi) && m.uid <= Math.max(lo, hi)) out.add(m.uid);
  }
  return out;
}

export async function startFakeMail({ imap = 3143, smtp = 3587 } = {}) {
  const boxes = seed();
  const delivered = [];

  const imapServer = createServer(sock => {
    let buf = Buffer.alloc(0);
    let selected = null;
    let authed = false;
    let pending = null; // { tag, head, need, after } while a literal is arriving
    const send = s => sock.write(s);
    const q = s => `"${s.replace(/["\\]/g, m => '\\' + m)}"`;
    send('* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR MOVE UIDPLUS] Fake IMAP ready\r\n');

    const handle = (tag, cmd, lit) => {
      const up = cmd.toUpperCase();
      if (up === 'CAPABILITY') return send('* CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR MOVE UIDPLUS\r\n' + `${tag} OK done\r\n`);
      if (up.startsWith('AUTHENTICATE PLAIN ')) {
        const [, user, pass] = Buffer.from(cmd.slice(19), 'base64').toString().split('\0');
        authed = user === USER && pass === PASS;
        return send(authed ? `${tag} OK signed in\r\n` : `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
      }
      if (up === 'LOGOUT') {
        send('* BYE bye\r\n' + `${tag} OK done\r\n`);
        return sock.end();
      }
      if (!authed) return send(`${tag} NO sign in first\r\n`);
      if (up === 'LIST "" "*"') {
        for (const name of Object.keys(boxes)) send(`* LIST (\\HasNoChildren${USES[name] ? ' ' + USES[name] : ''}) "/" ${q(name)}\r\n`);
        return send(`${tag} OK done\r\n`);
      }
      let m = /^STATUS "((?:[^"\\]|\\.)*)"/i.exec(cmd);
      if (m) {
        const b = boxes[m[1]];
        if (!b) return send(`${tag} NO no such folder\r\n`);
        return send(`* STATUS ${q(m[1])} (UNSEEN ${b.msgs.filter(x => !x.flags.has('\\Seen')).length} MESSAGES ${b.msgs.length})\r\n${tag} OK done\r\n`);
      }
      m = /^(SELECT|EXAMINE) "((?:[^"\\]|\\.)*)"$/i.exec(cmd);
      if (m) {
        selected = boxes[m[2].replace(/\\(.)/g, '$1')];
        if (!selected) return send(`${tag} NO no such folder\r\n`);
        return send(`* ${selected.msgs.length} EXISTS\r\n* OK [UIDVALIDITY ${selected.validity}] ok\r\n${tag} OK [READ-WRITE] done\r\n`);
      }
      m = /^APPEND "((?:[^"\\]|\\.)*)" \(([^)]*)\)/i.exec(cmd);
      if (m) {
        const b = boxes[m[1]];
        if (!b) return send(`${tag} NO [TRYCREATE] no such folder\r\n`);
        b.msgs.push({ uid: b.next++, raw: lit[0] ?? '', flags: new Set(m[2].split(' ').filter(Boolean)), date: new Date() });
        return send(`${tag} OK appended\r\n`);
      }
      if (!selected) return send(`${tag} BAD select a folder first\r\n`);
      m = /^UID SEARCH (.*)$/i.exec(cmd);
      if (m) {
        let hits = selected.msgs;
        const text = /TEXT "((?:[^"\\]|\\.)*)"/i.exec(m[1])?.[1] ?? (lit[0] ?? null);
        if (text !== null && /TEXT/i.test(m[1])) hits = hits.filter(x => x.raw.toLowerCase().includes(text.toLowerCase()));
        return send(`* SEARCH ${hits.map(x => x.uid).join(' ')}\r\n${tag} OK done\r\n`);
      }
      m = /^UID FETCH (\S+) \((.*)\)$/i.exec(cmd);
      if (m) {
        const set = uidSet(m[1], selected);
        selected.msgs.forEach((x, i) => {
          if (!set.has(x.uid)) return;
          const items = [`UID ${x.uid}`];
          if (/BODY\[\]/i.test(m[2]) && !/PEEK/i.test(m[2])) x.flags.add('\\Seen');
          if (/FLAGS/i.test(m[2])) items.push(`FLAGS (${[...x.flags].join(' ')})`);
          if (/RFC822\.SIZE/i.test(m[2])) items.push(`RFC822.SIZE ${Buffer.byteLength(x.raw, 'latin1')}`);
          if (/INTERNALDATE/i.test(m[2])) items.push(`INTERNALDATE "${imapDate(x.date)}"`);
          const hf = /BODY\.PEEK\[HEADER\.FIELDS \(([^)]*)\)\]/i.exec(m[2]);
          if (hf) {
            const want = hf[1].toLowerCase().split(' ');
            const head = x.raw.split(/\r\n\r\n/)[0].replace(/\r\n[ \t]/g, ' ').split('\r\n').filter(l => want.includes(l.split(':')[0].toLowerCase())).join('\r\n') + '\r\n\r\n';
            items.push(`BODY[HEADER.FIELDS (${hf[1]})] {${Buffer.byteLength(head, 'latin1')}}\r\n${head}`);
          }
          if (/BODY(\.PEEK)?\[\]/i.test(m[2])) items.push(`BODY[] {${Buffer.byteLength(x.raw, 'latin1')}}\r\n${x.raw}`);
          send(Buffer.from(`* ${i + 1} FETCH (${items.join(' ')})\r\n`, 'latin1'));
        });
        return send(`${tag} OK done\r\n`);
      }
      m = /^UID STORE (\S+) ([+-])FLAGS(?:\.SILENT)? \(([^)]*)\)$/i.exec(cmd);
      if (m) {
        const set = uidSet(m[1], selected);
        for (const x of selected.msgs) if (set.has(x.uid)) for (const f of m[3].split(' ')) m[2] === '+' ? x.flags.add(f) : x.flags.delete(f);
        return send(`${tag} OK done\r\n`);
      }
      m = /^UID MOVE (\S+) "((?:[^"\\]|\\.)*)"$/i.exec(cmd);
      if (m) {
        const to = boxes[m[2]];
        if (!to) return send(`${tag} NO no such folder\r\n`);
        const set = uidSet(m[1], selected);
        for (const x of selected.msgs.filter(y => set.has(y.uid))) to.msgs.push({ ...x, uid: to.next++, flags: new Set(x.flags) });
        selected.msgs = selected.msgs.filter(y => !set.has(y.uid));
        return send(`${tag} OK moved\r\n`);
      }
      m = /^UID EXPUNGE (\S+)$/i.exec(cmd);
      if (m || up === 'EXPUNGE') {
        const set = m ? uidSet(m[1], selected) : null;
        selected.msgs = selected.msgs.filter(x => !(x.flags.has('\\Deleted') && (!set || set.has(x.uid))));
        return send(`${tag} OK expunged\r\n`);
      }
      return send(`${tag} BAD unknown command ${cmd.slice(0, 40)}\r\n`);
    };

    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (pending && pending.need > 0) {
          if (buf.length < pending.need) return;
          pending.lits.push(buf.subarray(0, pending.need).toString('latin1'));
          buf = buf.subarray(pending.need);
          pending.need = 0;
        }
        const nl = buf.indexOf('\r\n');
        if (nl < 0) return;
        const line = buf.subarray(0, nl).toString('latin1');
        buf = buf.subarray(nl + 2);
        const text = pending ? pending.head + line : line;
        const lit = /\{(\d+)\}$/.exec(text);
        if (lit) {
          pending = { head: text.slice(0, -lit[0].length), need: Number(lit[1]), lits: pending?.lits ?? [] };
          send('+ go ahead\r\n');
          continue;
        }
        const lits = pending?.lits ?? [];
        pending = null;
        const sp = text.indexOf(' ');
        if (sp < 0) continue;
        handle(text.slice(0, sp), text.slice(sp + 1).trim(), lits);
      }
    });
    sock.on('error', () => {});
  });

  const smtpServer = createServer(sock => {
    let buf = '';
    let data = false;
    let env = { from: '', to: [] };
    let authed = false;
    sock.write('220 fake.smtp ready\r\n');
    sock.on('data', chunk => {
      buf += chunk.toString('latin1');
      for (;;) {
        if (data) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          const raw = buf.slice(0, end).replace(/^\.\./gm, '.') + '\r\n';
          buf = buf.slice(end + 5);
          data = false;
          delivered.push({ ...env, raw });
          boxes.INBOX.msgs.push({ uid: boxes.INBOX.next++, raw, flags: new Set(), date: new Date() });
          sock.write('250 OK queued as fake\r\n');
          env = { from: '', to: [] };
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const up = line.toUpperCase();
        if (up.startsWith('EHLO')) sock.write('250-fake.smtp\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
        else if (up.startsWith('AUTH PLAIN ')) {
          const [, user, pass] = Buffer.from(line.slice(11), 'base64').toString().split('\0');
          authed = user === USER && pass === PASS;
          sock.write(authed ? '235 ok\r\n' : '535 5.7.8 bad credentials\r\n');
        } else if (!authed && !up.startsWith('QUIT')) sock.write('530 sign in first\r\n');
        else if (up.startsWith('MAIL FROM:')) {
          env.from = line.slice(10).replace(/[<>]/g, '');
          sock.write('250 ok\r\n');
        } else if (up.startsWith('RCPT TO:')) {
          env.to.push(line.slice(8).replace(/[<>]/g, ''));
          sock.write('250 ok\r\n');
        } else if (up === 'DATA') {
          data = true;
          sock.write('354 go ahead\r\n');
        } else if (up === 'QUIT') {
          sock.write('221 bye\r\n');
          sock.end();
        } else sock.write('502 unknown\r\n');
      }
    });
    sock.on('error', () => {});
  });

  await Promise.all([new Promise(r => imapServer.listen(imap, '127.0.0.1', r)), new Promise(r => smtpServer.listen(smtp, '127.0.0.1', r))]);
  return {
    boxes,
    delivered,
    close: () => Promise.all([new Promise(r => imapServer.close(r)), new Promise(r => smtpServer.close(r))]),
  };
}
