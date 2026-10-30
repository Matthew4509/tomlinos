// Mail: reading messages (headers, encoded words, addresses, parts, attachments, character sets), replies.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeWords, parseAddresses, parseContentType, parseMessage, replySubject, showAddress, summary } from '../src/apps/mail/mime.ts';
import { splitAddresses } from '../src/apps/mail/compose.ts';
import { preStrip } from '../src/apps/mail/safehtml.ts';

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

test('a name with one star is encoded, not numbered: filename*=UTF-8\'\'... is decoded', () => {
  assert.equal(parseContentType('application/pdf; filename*=UTF-8\'\'r%C3%A9sum%C3%A9.pdf').params.filename, 'résumé.pdf');
});

test('a parameter called __proto__ or constructor is only a name: nothing outside the message changes', () => {
  const ct = parseContentType('text/plain; __proto__*0*=utf-16le\'\'x; constructor*=x; toString=y');
  assert.equal(({} as Record<string, unknown>).charset, undefined);
  assert.equal(Object.getPrototypeOf(ct.params), null);
  const m = parseMessage(enc('Subject: hi\r\nContent-Type: text/plain\r\n\r\nHello there\r\n'));
  assert.equal(m.text?.trim(), 'Hello there');
  // A summary with such a header still reads, so the folder list still loads.
  assert.equal(summary('Subject: x\r\nContent-Type: text/plain; __proto__*0*=utf-16le\'\'x').subject, 'x');
});

test('a part with no headers keeps its first paragraph', () => {
  const raw = 'Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\n\r\nFirst paragraph\r\n\r\nSecond\r\n--b--\r\n';
  assert.match(parseMessage(enc(raw)).text ?? '', /First paragraph[\s\S]*Second/);
});

test('replying to a name with a comma keeps one person, quoted, and sending splits it as one address', () => {
  const [bo] = parseAddresses('"Lee, Bo" <bo@x.com>');
  const shown = showAddress(bo);
  assert.equal(shown, '"Lee, Bo" <bo@x.com>');
  assert.deepEqual(parseAddresses(shown), [bo]);
  assert.deepEqual(splitAddresses(`${shown}, ann@y.com; "Odd \\"Name\\"; x" <c@z.com>\nd@w.com`), ['bo@x.com', 'ann@y.com', 'c@z.com', 'd@w.com']);
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

test('what the HTML cleaner hands to the parser has no style= and no on...= handler left (each one the browser would log as a security error)', () => {
  const html = '<style>p{color:red}</style><p style="color:red" onclick="alert(1)" onerror=\'alert(2)\' onmouseover=alert(3)>Hi <b data-x="onclick=">there</b></p><img src="x" onerror="alert(4)">';
  const handed = preStrip(html);
  assert.doesNotMatch(handed, /\s(style|on[a-z]+)\s*=/i, handed);
  assert.match(handed, /<p\s*>Hi <b data-x="onclick=">there<\/b><\/p><img src="x"\s*>/, 'the text, tags and harmless attributes stay');
});

test('the HTML cleaner also takes out a handler written after a slash, which browsers read as a space', () => {
  assert.doesNotMatch(preStrip('<img/onerror=alert(1) src="x">'), /onerror/);
  assert.doesNotMatch(preStrip('<svg/onload="alert(1)">'), /onload/);
  assert.doesNotMatch(preStrip('<img src="x"/onerror="a"/onload="b">'), /on(error|load)/);
  const link = '<a href="https://example.com/online=1">see /onward=2</a>';
  assert.equal(preStrip(link), link, 'an address or plain words with the same letters stay');
});

test('reply subjects never pile up', () => {
  assert.equal(replySubject('Re: RE: Fwd: Hello'), 'Re: Hello');
  assert.equal(replySubject('Hello', true), 'Fwd: Hello');
});
