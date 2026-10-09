// A stand-in for Anthropic's API for the browser tests: the two calls TOMLIN OS makes (list models, to try a key; and a
// streamed message), on 127.0.0.1 only. The PHP server reaches it because the test run sets DESKTOP_AI_TEST_URL (a
// real install ignores anything but that variable, and only a 127.0.0.1 address). Every request is kept in
// `requests`, so a test can check exactly what would have gone to Anthropic.
//   import { startFakeAnthropic, KEY } from './fake-anthropic.mjs';  const ai = await startFakeAnthropic(3190);
import { createServer } from 'node:http';

export const KEY = 'sk-ant-api03-tomlinos-test-key-0000000000000000000000000000-wxyz';

export async function startFakeAnthropic(port) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      const entry = { method: req.method, path: req.url, key: req.headers['x-api-key'] ?? null, auth: req.headers.authorization ?? null, body: body ? JSON.parse(body) : null };
      requests.push(entry);
      const json = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'request-id': 'req_test' });
        res.end(JSON.stringify(obj));
      };
      if (entry.key !== KEY) return json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
      if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
        return json(200, { data: [{ type: 'model', id: 'claude-opus-5', display_name: 'Claude Opus 5', created_at: '2026-01-01T00:00:00Z' }], has_more: false, first_id: 'claude-opus-5', last_id: 'claude-opus-5' });
      }
      if (req.method === 'POST' && req.url.startsWith('/v1/messages')) {
        const last = entry.body.messages.at(-1).content;
        const words = `Stand-in Claude heard: ${String(last).slice(0, 40)}`.match(/.{1,6}/g);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        send('message_start', { message: { id: 'msg_test', type: 'message', role: 'assistant', model: entry.body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 120, output_tokens: 1 } } });
        send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        let i = 0;
        const tick = setInterval(() => {
          if (i < words.length) return send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: words[i++] } });
          clearInterval(tick);
          send('content_block_stop', { index: 0 });
          send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 42 } });
          send('message_stop', {});
          res.end();
        }, 20);
        return;
      }
      json(404, { type: 'error', error: { type: 'not_found_error', message: 'not in the stand-in' } });
    });
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { requests, close: () => new Promise(resolve => server.close(resolve)) };
}
