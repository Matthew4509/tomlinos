// Audit of Mail's message reading (src/apps/mail/mime.ts): cases a mail user meets that are read wrongly now.
// Each test fails until the fault it names is fixed. Run: node --test test/audit-mail.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, quoteForReply } from '../src/apps/mail/mime.ts';

const enc = (s: string) => new Uint8Array(Buffer.from(s, 'latin1'));
const mail = (lines: string[]) => parseMessage(enc(lines.join('\r\n')));

test('P1 a text file attached with only a name (no Content-Disposition) is an attachment, not more body text', () => {
  const m = mail(['Content-Type: multipart/mixed; boundary="B"', '', '--B', 'Content-Type: text/plain', '', 'Notes attached.', '--B', 'Content-Type: text/plain; name="notes.txt"', '', 'line in the notes file', '--B--', '']);
  assert.deepEqual(m.attachments.map(a => a.name), ['notes.txt']);
  assert.ok(!m.text?.includes('line in the notes file'));
});

test('P1 a second HTML part (Apple Mail: text, picture, more text) is shown, not turned into "attachment-2"', () => {
  const m = mail(['Content-Type: multipart/mixed; boundary="B"', '', '--B', 'Content-Type: text/html', '', '<p>part one</p>', '--B', 'Content-Type: image/jpeg', 'Content-Disposition: inline; filename="p.jpg"', 'Content-Transfer-Encoding: base64', '', '/9j/', '--B', 'Content-Type: text/html', '', '<p>part two</p>', '--B--', '']);
  assert.ok(m.html?.includes('part two'), 'second HTML part missing from the body');
  assert.ok(!m.attachments.some(a => a.type === 'text/html'), 'second HTML part offered as a file');
});

test('P1 format=flowed text joins its soft-wrapped lines (RFC 3676)', () => {
  const m = mail(['Content-Type: text/plain; charset=utf-8; format=flowed', '', 'This is a long line that was ', 'wrapped by the sender.', '']);
  assert.equal(m.text?.split(/\r?\n/)[0], 'This is a long line that was wrapped by the sender.');
});

test('P1 the reply heading has no empty "On ," when the message has no date', () => {
  const m = mail(['From: a@b.c', 'Subject: s', 'Content-Type: text/plain', '', 'x']);
  assert.ok(!quoteForReply(m, 'x').includes('On , '), quoteForReply(m, 'x'));
});
