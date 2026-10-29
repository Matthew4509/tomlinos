// A second look at the AI spending caps, the app store's file rules and System update (October 2026 retest), each run
// by PHP directly against the real server/lib code on throw-away folders. Each test was written to catch a fault read
// in the code; one that fails points at that fault. Skipped without PHP (PHP_BIN, or php on the PATH).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PHP, extFlags, hasPhp } from './php-bin.ts';
import { tempDir } from './tmp.ts';

const root = join(import.meta.dirname, '..');
const noPhp = !hasPhp && 'no PHP';
const ext = extFlags('openssl');

function php(body: string, libs = ['http', 'auth', 'claude']): Record<string, any> {
  const dir = tempDir('tomlinos-retest-ai-');
  const file = join(dir, 't.php');
  writeFileSync(file, `<?php
${libs.map(l => `require ${JSON.stringify(join(root, `server/lib/${l}.php`))};`).join('\n')}
$d = ${JSON.stringify(dir)};
${body}`);
  return JSON.parse(execFileSync(PHP, [...ext, file], { encoding: 'utf8' }));
}

// ---- Spending caps ------------------------------------------------------------------------------------------------------

test('a request that was never booked (the script died mid-answer) still counts against the cap once its set-aside expires', { skip: noPhp }, () => {
  // Cap $0.50; a request sets aside $0.21 and is never booked (the host killed the script after Anthropic charged).
  const r = php(`
$a = ai_reserve($d, 'u1', 50, 210000, 1000);
$b = ai_reserve($d, 'u1', 50, 210000, 1000 + 901);
$c = ai_reserve($d, 'u1', 50, 210000, 1000 + 902);
echo json_encode(['first' => $a !== null, 'after_expiry' => $b !== null, 'third' => $c !== null, 'spent' => ai_ledger_read($d, 'u1', ai_month(1000))['spent']]);`);
  assert.ok(r.first, 'the first request fits');
  // Either the expired set-aside is charged (spent grows), or it is still held: a third $0.21 request must not fit under $0.50
  // when two unbooked ones have already been let through.
  assert.ok(r.spent >= 210000 || !r.third, `two unbooked requests slipped through and a third was allowed too (spent ${r.spent})`);
});

test('a request set aside in one month and booked in the next counts against the month it was booked in', { skip: noPhp }, () => {
  const r = php(`
$t1 = gmmktime(23, 59, 50, 10, 31, 2026); $t2 = $t1 + 20;
$a = ai_reserve($d, 'u', 50, 300000, $t1);
$b = ai_reserve($d, 'u', 50, 300000, $t2);
echo json_encode(['a' => $a !== null, 'b' => $b !== null]);`);
  assert.ok(r.a, 'the first request fits in October');
  assert.ok(!r.b, 'the second must see the first still held: both will be booked into November, over its $0.50 cap');
});

test('an OpenRouter limit of $0 ("stops it altogether") stops a request even for a model priced at $0', { skip: noPhp }, () => {
  const r = php(`echo json_encode(['id' => ai_reserve($d, 'u1', 0, or_worst_micro(['in' => 0.0, 'out' => 0.0], 100), 1000, OR_BOOK)]);`, ['http', 'auth', 'claude', 'openrouter']);
  assert.equal(r.id, null);
});

// ---- The app store ------------------------------------------------------------------------------------------------------------

test('a store app file named like "game.php8.js" is refused (Apache may run it as PHP)', { skip: noPhp }, () => {
  const r = php(`echo json_encode(['php8js' => appstore_allowed_name('a.php8.js'), 'phtmljs' => appstore_allowed_name('a.phtml.js'), 'plain' => appstore_allowed_name('a.js')]);`, ['http', 'auth', 'appstore']);
  assert.equal(r.plain, true);
  assert.equal(r.php8js, false);
  assert.equal(r.phtmljs, false);
});

// ---- System update --------------------------------------------------------------------------------------------------------------

function run(code: string, priv: string, web: string): { ok: boolean; out: string } {
  const r = spawnSync(PHP, [...extFlags('zip'), '-r', `require 'server/lib/updater.php'; $priv = getenv('PRIV'); $web = getenv('WEB'); ${code}`],
    { cwd: root, env: { ...process.env, PRIV: priv, WEB: web }, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout + r.stderr).trim() };
}
function zipOf(entries: Record<string, string>, dir: string): string {
  const path = join(dir, `r-${Math.random().toString(16).slice(2)}.zip`);
  const r = spawnSync(PHP, [...extFlags('zip'), '-r', `$z = new ZipArchive(); $z->open(getenv('ZIP'), ZipArchive::CREATE); foreach (json_decode(getenv('E'), true) as $n => $b) { $z->addFromString($n, $b); } $z->close();`],
    { env: { ...process.env, ZIP: path, E: JSON.stringify(entries) }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return path;
}
function folders(): { base: string; priv: string; web: string } {
  const base = mkdtempSync(join(tmpdir(), 'tomlinos-retest-update-'));
  const priv = join(base, 'tomlinos');
  const web = join(base, 'public_html');
  mkdirSync(join(priv, 'lib'), { recursive: true });
  mkdirSync(join(priv, 'api'), { recursive: true });
  mkdirSync(join(web, 'api'), { recursive: true });
  writeFileSync(join(priv, 'VERSION'), '0.1.0\n');
  writeFileSync(join(priv, 'lib', 'a.php'), 'old a');
  writeFileSync(join(priv, 'config.php'), 'people settings');
  writeFileSync(join(web, 'index.html'), 'old page');
  return { base, priv, web };
}
const install = (zip: string) => `try { echo update_locked(fn ($d) => update_apply_zip(${JSON.stringify(zip)}, $web, $d, $priv), $priv); } catch (RuntimeException $e) { echo 'ERR ', $e->getMessage(); }`;
const RELEASE = { 'tomlinos/VERSION': '0.2.0\n', 'tomlinos/lib/a.php': 'new a', 'public_html/index.html': 'new page' };

test('System update keeps the PHP-version block cPanel writes into public_html/.htaccess', { skip: noPhp }, () => {
  const f = folders();
  const cpanel = '# php -- BEGIN cPanel-generated handler, do not edit\nAddHandler application/x-httpd-ea-php83 .php .php8 .phtml\n# php -- END cPanel-generated handler, do not edit\n';
  writeFileSync(join(f.web, '.htaccess'), `${cpanel}\n# old tomlinos rules\n`);
  const r = run(install(zipOf({ ...RELEASE, 'public_html/.htaccess': '# new tomlinos rules\n' }, f.base)), f.priv, f.web);
  assert.equal(r.out, '0.2.0', r.out);
  const after = existsSync(join(f.web, '.htaccess')) ? readFileSync(join(f.web, '.htaccess'), 'utf8') : '';
  assert.ok(after.includes('x-httpd-ea-php83'), `the host's PHP handler line is gone after the update:\n${after}`);
});

test('System update removes a file the new release no longer ships (an old API door does not stay live)', { skip: noPhp }, () => {
  const f = folders();
  writeFileSync(join(f.web, 'api', 'old.php'), '<?php // a door the next release removed');
  writeFileSync(join(f.priv, 'api', 'old.php'), '<?php // its code');
  const r = run(install(zipOf({ ...RELEASE, 'public_html/api/auth.php': 'door', 'tomlinos/api/auth.php': 'code' }, f.base)), f.priv, f.web);
  assert.equal(r.out, '0.2.0', r.out);
  assert.equal(existsSync(join(f.web, 'api', 'old.php')), false, 'public_html/api/old.php is still there after the update');
});
