// Audit of Web link (.url) files (November 2026). These pin what was found safe; P1s are marked todo.
// Run: node --test test/audit-link.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkTarget } from '../src/apps/link.ts';

test('no unsafe or relative address is ever followed', () => {
  for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///C:/x',
    '/api/session', '//evil.example/x', 'ftp://x.example', 'blob:https://a.example/1', 'view-source:https://a.example', 'https://a.example:99999']) {
    assert.equal(linkTarget(`[InternetShortcut]\r\nURL=${url}\r\n`), null, url);
  }
  assert.equal(linkTarget('\u0000\u00ff garbage'), null);
  assert.equal(linkTarget(''), null);
});

test('a look-alike host is shown in its xn-- form, and only the first URL= line counts', () => {
  assert.equal(linkTarget('URL=https://аррӏе.com/')?.hostname, 'xn--80ak6aa92e.com');
  assert.equal(linkTarget('URL=https://a.example\nURL=javascript:alert(1)')?.hostname, 'a.example');
  assert.equal(linkTarget('javascript:alert(1)\nURL=https://ok.example')?.hostname, 'ok.example');
});

test('LK-P1-2: a user name before the host ("https://www.bank.com@evil.example") is not shown in the full address', { todo: 'P1' }, () => {
  const url = linkTarget('URL=https://www.bank.com@evil.example/')!;
  assert.equal(url.hostname, 'evil.example');
  assert.ok(!url.href.includes('bank.com'), `the second line reads ${url.href}`);
});

test('LK-P1-3: a link to this desktop\'s own server is not offered as an outside web page', { todo: 'P1' }, () => {
  // Opened in a new tab as the signed-in person (a GET to an /api/ address, say). The Link window cannot know the
  // origin in a node test, so this records the gap: linkTarget accepts it.
  assert.equal(linkTarget('URL=http://127.0.0.1:3142/api/session'), null);
});
