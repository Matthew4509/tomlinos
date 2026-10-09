// The page's security headers live in ONE file (security-headers.json). This checks the built page, the dev router
// and the packager all take them from there, and that every outside address has a reason.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const toolsUrl = new URL('../tools/headers.mjs', import.meta.url).href;
const { cspValue, outsideSources, why } = (await import(toolsUrl)) as {
  cspValue(o?: { meta?: boolean }): string;
  outsideSources(): string[];
  why: Record<string, string>;
};

test('the built page carries the policy from security-headers.json, without frame-ancestors', () => {
  execFileSync(process.execPath, [join(root, 'tools', 'build.mjs')], { stdio: 'ignore' });
  const page = readFileSync(join(root, 'out', 'index.html'), 'utf8');
  const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(page)?.[1];
  assert.equal(meta, cspValue({ meta: true }));
  assert.ok(!meta!.includes('frame-ancestors'));
  assert.ok(cspValue().includes("frame-ancestors 'self'"));
});

test('nobody types the policy by hand any more', () => {
  const router = readFileSync(join(root, 'server', 'dev-router.php'), 'utf8');
  assert.ok(router.includes('security-headers.json') && !/default-src 'self'/.test(router), 'dev router reads the file');
  const pack = readFileSync(join(root, 'tools', 'package.mjs'), 'utf8');
  assert.ok(pack.includes('headerList()') && !/default-src/.test(pack), 'packager reads the file');
  assert.ok(readFileSync(join(root, 'public', 'index.html'), 'utf8').includes('content="__CSP__"'), 'index.html keeps the placeholder');
});

test('every outside address in the policy has a reason, and scripts and styles never leave the site', () => {
  for (const src of outsideSources()) assert.ok(why[src], `${src} needs a reason`);
  const csp = cspValue();
  assert.match(csp, /script-src 'self'( 'wasm-unsafe-eval')?;/);
  assert.match(csp, /style-src 'self';/);
  assert.match(csp, /object-src 'none'/);
  // 'wasm-unsafe-eval' (WebAssembly only, for the on-device AI) is the one keyword allowed, with its reason; plain
  // 'unsafe-eval' (JavaScript from text) and 'unsafe-inline' never.
  // One wildcard, for data only: Hugging Face's model-file servers are named by region (us.aws.cdn.hf.co,
  // cas-bridge.xethub.hf.co, ...), for a built-in model not saved on this TOMLIN OS. Never in
  // script-src or anywhere else.
  assert.match(csp, /connect-src [^;]*https:\/\/\*\.hf\.co/, 'the one wildcard sits in connect-src');
  const bare = csp.replace(/'wasm-unsafe-eval'/g, '').replace(/(connect-src [^;]*) https:\/\/\*\.hf\.co/, '$1');
  assert.ok(!/unsafe-inline|unsafe-eval|\*/.test(bare), 'no other wildcards or unsafe keywords');
  if (csp.includes("'wasm-unsafe-eval'")) assert.ok(why["'wasm-unsafe-eval'"], "'wasm-unsafe-eval' needs its reason in why");
});
