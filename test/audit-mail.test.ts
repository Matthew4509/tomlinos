// Audit of Mail's message reading (src/apps/mail/mime.ts): cases a mail user meets that are read wrongly now.
// Each test fails until the fault it names is fixed. Run: node --test test/audit-mail.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromMailto, parseMessage, quoteForReply } from '../src/apps/mail/mime.ts';
import { splitRecipients } from '../src/apps/mail/compose.ts';

const enc = (s: string) => new Uint8Array(Buffer.from(s, 'latin1'));
const mail = (lines: string[]) => parseMessage(enc(lines.join('\r\n')));

test('P1 a text file attached with only a name (no Content-Disposition) is an attachment, not more body text', () => {
  const m = mail(['Content-Type: multipart/mixed; boundary="B"', '', '--B', 'Content-Type: text/plain', '', 'Notes attached.', '--B', 'Content-Type: text/plain; name="notes.txt"', '', 'line in the notes file', '--B--', '']);
  assert.deepEqual(m.attachments.map(a => a.name), ['notes.txt']);
  assert.ok(!m.text?.includes('line in the notes file'));
});

test('a plain text part with no name and no disposition is still the letter, and a lone named message part is its text', () => {
  const m = mail(['Content-Type: multipart/mixed; boundary="B"', '', '--B', 'Content-Type: text/plain', '', 'Hello.', '--B', 'Content-Type: text/plain', '', 'List footer', '--B--', '']);
  assert.match(m.text ?? '', /Hello\.[\s\S]*List footer/);
  assert.equal(m.attachments.length, 0);
  assert.equal(mail(['Content-Type: text/plain; name="x.txt"', '', 'Whole body']).text?.trim(), 'Whole body');
});

test('an attachment sent "inline" (Apple Mail) is kept as an attachment, marked inline', () => {
  const m = mail(['Content-Type: multipart/mixed; boundary="B"', '', '--B', 'Content-Type: text/plain', '', 'See the plan.', '--B', 'Content-Type: application/pdf; name="plan.pdf"', 'Content-Disposition: inline; filename="plan.pdf"', 'Content-Transfer-Encoding: base64', '', 'JVBERi0xLjQK', '--B--', '']);
  assert.deepEqual(m.attachments.map(a => [a.name, a.inline, a.cid]), [['plan.pdf', true, null]]);
});

test('a draft keeps what it answers and its Bcc line when read back', () => {
  const m = mail(['To: a@b.cd', 'Bcc: Hid Den <h@b.cd>', 'In-Reply-To: <x@y.z>', 'References: <w@y.z> <x@y.z>', 'Subject: d', '', 'text']);
  assert.deepEqual(m.bcc, [{ name: 'Hid Den', email: 'h@b.cd' }]);
  assert.equal(m.inReplyTo, '<x@y.z>');
});

test('P1 the name typed with an address is kept, quoted or not, and only the address is the address', () => {
  assert.deepEqual(splitRecipients('Dee Example <dee@example.org>, "Lee, Bo" <bo@x.com>; plain@y.com'), [
    { name: 'Dee Example', email: 'dee@example.org' },
    { name: 'Lee, Bo', email: 'bo@x.com' },
    { name: '', email: 'plain@y.com' },
  ]);
});

test('P1 a mailto: link starts a new message with its address, subject and text, and nothing else', () => {
  assert.deepEqual(fromMailto('mailto:bob@example.org'), { to: ['bob@example.org'] });
  assert.deepEqual(fromMailto('mailto:bob@example.org,ann@example.org?subject=Hi%20there&cc=c@d.ef&body=Line%201%0D%0ALine%202&attach=C:%5Cx&X-Header=1'), {
    to: ['bob@example.org', 'ann@example.org'], cc: ['c@d.ef'], subject: 'Hi there', text: 'Line 1\nLine 2',
  });
  // A broken escape is kept as typed, not thrown; a line break cannot get into the subject.
  assert.equal(fromMailto('mailto:x@y.z?subject=100%&').subject, '100%');
  assert.equal(fromMailto('mailto:x@y.z?subject=a%0D%0ABcc:%20v@w.x').subject, 'a Bcc: v@w.x');
});

test('P1 a second HTML part (Apple Mail: text, picture, more text) is shown, not turned into "attachment-2"', { todo: 'P1, waiting on direction' }, () => {
  const m = mail(['Content-Type: multipart/mixed; boundary="B"', '', '--B', 'Content-Type: text/html', '', '<p>part one</p>', '--B', 'Content-Type: image/jpeg', 'Content-Disposition: inline; filename="p.jpg"', 'Content-Transfer-Encoding: base64', '', '/9j/', '--B', 'Content-Type: text/html', '', '<p>part two</p>', '--B--', '']);
  assert.ok(m.html?.includes('part two'), 'second HTML part missing from the body');
  assert.ok(!m.attachments.some(a => a.type === 'text/html'), 'second HTML part offered as a file');
});

test('P1 format=flowed text joins its soft-wrapped lines (RFC 3676)', { todo: 'P1, waiting on direction' }, () => {
  const m = mail(['Content-Type: text/plain; charset=utf-8; format=flowed', '', 'This is a long line that was ', 'wrapped by the sender.', '']);
  assert.equal(m.text?.split(/\r?\n/)[0], 'This is a long line that was wrapped by the sender.');
});

test('P1 the reply heading has no empty "On ," when the message has no date', { todo: 'P1, waiting on direction' }, () => {
  const m = mail(['From: a@b.c', 'Subject: s', 'Content-Type: text/plain', '', 'x']);
  assert.ok(!quoteForReply(m, 'x').includes('On , '), quoteForReply(m, 'x'));
});
