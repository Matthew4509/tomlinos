// Mail: reading messages (headers, encoded words, addresses, parts, attachments, character sets), replies.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeWords, parseAddresses, parseContentType, parseMessage, replySubject, summary } from '../src/apps/mail/mime.ts';

const enc = (s: string) => new Uint8Array(Buffer.from(s, 'latin1'));
const utf8 = (s: string) => new Uint8Array(Buffer.from(s, 'utf8'));

test('encoded words: base64 and Q, UTF-8 and Latin-1, joined across spaces', () => {
  assert.equal(decodeWords('=?UTF-8?B?w4lsw6lhbm9yZQ==?='), 'Éléanore');
  assert.equal(decodeWords('=?iso-8859-1?Q?caf=E9_cr=E8me?='), 'café crème');
  assert.equal(decodeWords('=?UTF-8?Q?a?= =?UTF-8?Q?b?= c'), 'ab c');
  assert.equal(decodeWords('plain words'), 'plain words');
});

test('addresses with names, quotes, commas inside quotes, groups', () => {
  assert.deepEqual(parseAddresses('"Lee, Bo" <bo@x.org>, ann@y.org, Cy <cy@z.org>'), [
    { name: 'Lee, Bo', email: 'bo@x.org' }, { name: '', email: 'ann@y.org' }, { name: 'Cy', email: 'cy@z.org' },
  ]);
  assert.deepEqual(parseAddresses('Team: a@b.c, d@e.f;'), [{ name: '', email: 'a@b.c' }, { name: '', email: 'd@e.f' }]);
  assert.deepEqual(parseAddresses('=?UTF-8?B?w4lsw6lhbm9yZQ==?= <e@f.g>'), [{ name: 'Éléanore', email: 'e@f.g' }]);
});

test('content type parameters, including an RFC 2231 name in pieces', () => {
  const ct = parseContentType('application/pdf; name*0*=UTF-8\'\'r%C3%A9; name*1*=sum%C3%A9.pdf; x="a;b"');
  assert.equal(ct.type, 'application/pdf');
  assert.equal(ct.params.name, 'résumé.pdf');
  assert.equal(ct.params.x, 'a;b');
});

test('a multipart message: plain, HTML and an attachment, quoted-printable and base64', () => {
  const raw = [
    'From: =?UTF-8?Q?Jos=C3=A9?= <jose@example.com>',
    'To: me@example.com',
    'Subject: =?UTF-8?B?UHLDvGZ1bmc=?=',
    'Date: Sat, 26 Sep 2026 10:00:00 +1000',
    'Message-ID: <abc@example.com>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="OUT"',
    '',
    'preamble',
    '--OUT',
    'Content-Type: multipart/alternative; boundary=IN',
    '',
    '--IN',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'Gr=C3=BC=C3=9Fe, a long line that is soft =',
    'broken.',
    '--IN',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>Hi <b>there</b></p>',
    '--IN--',
    '--OUT',
    'Content-Type: application/pdf; name="report.pdf"',
    'Content-Disposition: attachment; filename="report.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('%PDF-1.4 test').toString('base64'),
    '--OUT--',
    '',
  ].join('\r\n');
  const m = parseMessage(enc(raw));
  assert.equal(m.subject, 'Prüfung');
  assert.deepEqual(m.from, [{ name: 'José', email: 'jose@example.com' }]);
  assert.equal(m.text, 'Grüße, a long line that is soft broken.');
  assert.equal(m.html, '<p>Hi <b>there</b></p>');
  assert.equal(m.attachments.length, 1);
  assert.equal(m.attachments[0].name, 'report.pdf');
  assert.equal(Buffer.from(m.attachments[0].data).toString(), '%PDF-1.4 test');
  assert.equal(m.messageId, '<abc@example.com>');
  assert.equal(m.date?.toISOString(), '2026-09-26T00:00:00.000Z');
});

test('a simple Latin-1 message, and raw UTF-8 bytes in a header', () => {
  const m = parseMessage(enc('Subject: plain\r\nContent-Type: text/plain; charset=iso-8859-1\r\n\r\ncaf\xe9\r\n'));
  assert.equal(m.text, 'café\r\n');
  const s = summary(Buffer.from('Subject: naïve\r\nFrom: a@b.c\r\n', 'utf8').toString('latin1'));
  assert.equal(s.subject, 'naïve');
  assert.ok(utf8('x').length === 1);
});

test('a hostile message cannot nest parts forever, and a missing boundary is survived', () => {
  let body = 'x';
  for (let i = 0; i < 40; i++) body = `Content-Type: multipart/mixed; boundary=b${i}\r\n\r\n--b${i}\r\n${body}\r\n--b${i}--`;
  const m = parseMessage(enc(`Subject: deep\r\n${body}`));
  assert.equal(m.subject, 'deep');
  assert.equal(parseMessage(enc('Content-Type: multipart/mixed\r\n\r\nno boundary')).text, null);
});

test('reply subjects never pile up', () => {
  assert.equal(replySubject('Re: RE: Fwd: Hello'), 'Re: Hello');
  assert.equal(replySubject('Hello', true), 'Fwd: Hello');
});
