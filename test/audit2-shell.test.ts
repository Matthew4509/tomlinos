// Second audit (November 2026) of the shell and the file store: faults that can be shown without a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerStore } from '../src/store/server-store.ts';
import { StoreError } from '../src/store/store.ts';

/** Runs fn with fetch answering every request with `answer`. */
async function withFetch<T>(answer: () => Response, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => answer()) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

const html = () => new Response('<!doctype html><title>Sign in to the Wi-Fi</title><p>Welcome</p>', { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

test('QN-11: a read answered with a 200 HTML page (a proxy, a captive portal) is a failed read, never the file\'s bytes', async () => {
  const store = new ServerStore('/api/store.php');
  const error = await withFetch(html, () => store.get('k1').then(() => null, e => e));
  assert.ok(error instanceof StoreError, `the page was taken as the file: ${error}`);
  assert.match(error.message, /could not be read just now/);
  assert.match(error.message, /did not come from this desktop's server/);
  assert.doesNotMatch(error.message, /unencrypted|someone else/);
});

test('QN-11: a 200 that is octet-stream but has no store version is not taken as the file either', async () => {
  const store = new ServerStore('/api/store.php');
  const answer = () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
  await assert.rejects(withFetch(answer, () => store.get('k1')), StoreError);
});

test('QN-11: the store\'s own answer is still read as the file', async () => {
  const store = new ServerStore('/api/store.php');
  const answer = () => new Response(new Uint8Array([104, 105]), { status: 200, headers: { 'Content-Type': 'application/octet-stream', 'X-Store-Version': 'v7' } });
  const record = await withFetch(answer, () => store.get('k1'));
  assert.equal(record?.version, 'v7');
  assert.deepEqual([...record!.data], [104, 105]);
});

test('QN-11: a save or a key list answered with a 200 HTML page gives a plain message, not a JSON parse error', async () => {
  const store = new ServerStore('/api/store.php');
  const save = await withFetch(html, () => store.commit([{ op: 'put', key: '/', expect: '', data: new Uint8Array([1]) }]).then(() => null, e => e));
  assert.ok(save instanceof StoreError, String(save));
  assert.match(save.message, /may not have been saved/);
  assert.doesNotMatch(save.message, /JSON|Unexpected token|SyntaxError/);
  const keys = await withFetch(html, () => store.keys().then(() => null, e => e));
  assert.ok(keys instanceof StoreError, String(keys));
  assert.doesNotMatch(keys.message, /JSON|Unexpected token|SyntaxError/);
});
