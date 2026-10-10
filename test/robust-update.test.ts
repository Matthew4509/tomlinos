// System update and the app store under real failures, run by PHP itself on throw-away folders:
//   - an install killed at a random moment leaves, once the next update request has run, the old version whole or the
//     new one whole, never a mix, and Go back still works after;
//   - two installs (or an install and a Go back) at the same moment: one runs, the other is refused, nothing mixed;
//   - two app downloads at the same moment both land and both are listed; a download racing a delete of the same app
//     ends with its folder and the list agreeing.
// Needs PHP with the zip extension (PHP_BIN, or php on the PATH). Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PHP, extFlags, hasPhp } from './php-bin.ts';
import { tempDir } from './tmp.ts';

const root = join(import.meta.dirname, '..');
const noPhp = !hasPhp && 'no PHP';

/** Starts PHP with the zip extension and the given libraries loaded; `code` runs after them. */
function php(libs: string[], code: string, env: Record<string, string> = {}): { done: Promise<{ code: number | null; out: string }>; kill: () => void } {
  const head = libs.map(l => `require ${JSON.stringify(join(root, 'server/lib', l))};`).join(' ');
  const child = spawn(PHP, [...extFlags('zip', 'openssl', 'sodium'), '-d', 'opcache.enable=0', '-r', `${head} ${code}`], { env: { ...process.env, ...env } });
  let out = '';
  child.stdout.on('data', d => (out += d));
  child.stderr.on('data', d => (out += d));
  return { done: new Promise(resolve => child.on('exit', c => resolve({ code: c, out }))), kill: () => child.kill() };
}

/** Every file under the two folders (the update folder left out), as path -> sha256. */
function tree(priv: string, web: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (base: string, d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) {
        if (!(d === priv && n === 'update')) walk(base, p);
      } else out.set(relative(base, p).replace(/\\/g, '/') + (base === priv ? ' @priv' : ' @web'), createHash('sha256').update(readFileSync(p)).digest('hex'));
    }
  };
  walk(priv, priv);
  walk(web, web);
  return out;
}
const same = (a: Map<string, string>, b: Map<string, string>) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

/** A release zip of `n` files of 4 KB (web and private), version `v`, made by PHP's ZipArchive. */
function release(dir: string, v: string, n: number): string {
  const path = join(dir, `release-${v}.zip`);
  const r = spawnSync(PHP, [...extFlags('zip'), '-r', `$z = new ZipArchive(); $z->open(getenv('ZIP'), ZipArchive::CREATE | ZipArchive::OVERWRITE);
$z->addFromString('tomlinos/VERSION', getenv('V') . "\\n");
for ($i = 0; $i < (int) getenv('N'); $i++) {
  $z->addFromString(($i % 2 ? 'public_html/js/' : 'tomlinos/lib/') . "f$i.txt", str_repeat(getenv('V') . " $i ", 400));
}
$z->close();`], { env: { ...process.env, ZIP: path, V: v, N: String(n) }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return path;
}

function site(): { base: string; priv: string; web: string } {
  const base = tempDir('tomlinos-robust-update-');
  const priv = join(base, 'tomlinos');
  const web = join(base, 'public_html');
  mkdirSync(join(priv, 'lib'), { recursive: true });
  mkdirSync(join(web, 'js'), { recursive: true });
  writeFileSync(join(priv, 'VERSION'), '1.0.0\n');
  // The old version: the same names as the release for half of them, so an install both replaces and adds files.
  for (let i = 0; i < 1500; i += 2) writeFileSync(join(i % 2 ? join(web, 'js') : join(priv, 'lib'), `f${i}.txt`), `old ${i}`);
  writeFileSync(join(priv, 'config.php'), 'people settings');
  writeFileSync(join(web, 'index.html'), 'kept page');
  return { base, priv, web };
}
const install = (zip: string) => `try { echo update_locked(fn ($d) => update_apply_zip(${JSON.stringify(zip)}, getenv('WEB'), $d, getenv('PRIV')), getenv('PRIV')); } catch (RuntimeException $e) { echo 'ERR ', $e->getMessage(); }`;
const recover = `try { $v = update_locked(fn ($d) => update_recover($d, getenv('PRIV')), getenv('PRIV')); echo $v === null ? 'nothing' : "put back $v"; } catch (RuntimeException $e) { echo 'ERR ', $e->getMessage(); }`;

test('an install killed at a random moment ends, after the next update request, as the old version whole or the new one whole', { skip: noPhp, timeout: 600000 }, async () => {
  const s = site();
  const env = { PRIV: s.priv, WEB: s.web };
  const zip = release(s.base, '2.0.0', 1500);
  const old = tree(s.priv, s.web);
  // How long a whole install takes here (on a copy), so the kills land all through it.
  const probe = site();
  const t0 = Date.now();
  const whole = await php(['updater.php'], install(zip), { PRIV: probe.priv, WEB: probe.web }).done;
  assert.equal(whole.out, '2.0.0', whole.out);
  const span = Date.now() - t0;
  const fresh = tree(probe.priv, probe.web);

  const seen = { old: 0, new: 0, putBack: 0 };
  for (let round = 0; round < 14; round++) {
    const r = php(['updater.php'], install(zip), env);
    const wait = Math.floor(Math.random() * span * 1.1);
    await new Promise(res => setTimeout(res, wait));
    r.kill();
    await r.done;
    const rec = await php(['updater.php'], recover, env).done;
    assert.doesNotMatch(rec.out, /^ERR/, `kill after ${wait} ms: recovery: ${rec.out}`);
    if (rec.out.startsWith('put back')) seen.putBack++;
    const now = tree(s.priv, s.web);
    // The update folder's own files are not part of the site; VERSION says which whole version it is.
    const version = readFileSync(join(s.priv, 'VERSION'), 'utf8').trim();
    const isOld = same(now, old);
    const isNew = same(now, new Map([...fresh].map(([k, v]) => [k, v])));
    const extra = [...now.keys()].filter(k => !old.has(k) && !fresh.has(k)).slice(0, 5);
    assert.ok(isOld || isNew, `kill after ${wait} ms: the site is one whole version (VERSION ${version}, ${now.size} files; recovery said "${rec.out}"; in neither version: ${extra.join(', ')})`);
    assert.equal(version, isOld ? '1.0.0' : '2.0.0', 'VERSION matches the files');
    assert.equal(readFileSync(join(s.priv, 'config.php'), 'utf8'), 'people settings', 'people\'s settings never touched');
    if (isNew) {
      seen.new++;
      // Back to the old version for the next round, through Go back: it must work after whatever happened.
      const back = await php(['updater.php'], `try { echo update_rollback(getenv('PRIV')); } catch (RuntimeException $e) { echo 'ERR ', $e->getMessage(); }`, env).done;
      assert.equal(back.out, '1.0.0', `Go back after a finished install: ${back.out}`);
      assert.ok(same(tree(s.priv, s.web), old), 'Go back restored the old version exactly');
    } else seen.old++;
    assert.ok(!existsSync(join(s.priv, 'update', 'operation.json')), 'nothing left half-done');
  }
  console.log(`      14 kills: ${seen.old} left the old version (${seen.putBack} of them undone from the backup after files had changed), ${seen.new} the new one`);
  assert.ok(seen.putBack > 0, 'at least one kill landed while files were being replaced (else this test proved little)');
});

test('two installs, or an install and a Go back, at the same moment: one runs, the other is refused, and the site is whole', { skip: noPhp, timeout: 300000 }, async () => {
  const s = site();
  const env = { PRIV: s.priv, WEB: s.web };
  const zip = release(s.base, '2.0.0', 1500);
  for (let round = 0; round < 3; round++) {
    const [a, b] = [php(['updater.php'], install(zip), env), php(['updater.php'], round === 2 ? `try { var_export(update_rollback(getenv('PRIV'))); } catch (RuntimeException $e) { echo 'ERR ', $e->getMessage(); }` : install(zip), env)];
    const outs = [(await a.done).out, (await b.done).out];
    const refused = outs.filter(o => /An update or a Go back is running now/.test(o)).length;
    assert.ok(refused <= 1, 'at most one refused: ' + outs.join(' | '));
    const version = readFileSync(join(s.priv, 'VERSION'), 'utf8').trim();
    assert.ok(['1.0.0', '2.0.0'].includes(version), version);
    assert.ok(!existsSync(join(s.priv, 'update', 'operation.json')));
    console.log(`      round ${round + 1}: ${outs.map(o => o.slice(0, 60)).join(' | ')}`);
    // Back to 1.0.0 for the next round.
    if (version === '2.0.0') assert.equal((await php(['updater.php'], `echo update_rollback(getenv('PRIV'));`, env).done).out, '1.0.0');
  }
});

// ---- The app store --------------------------------------------------------------------------------------------------

function appZip(dir: string, id: string, n = 200): Record<string, unknown> {
  const path = join(dir, 'zips', `${id}.zip`);
  mkdirSync(join(dir, 'zips'), { recursive: true });
  const r = spawnSync(PHP, [...extFlags('zip'), '-r', `$z = new ZipArchive(); $z->open(getenv('ZIP'), ZipArchive::CREATE | ZipArchive::OVERWRITE);
$z->addFromString('index.html', getenv('ID')); for ($i = 0; $i < (int) getenv('N'); $i++) { $z->addFromString("js/f$i.js", str_repeat('x', 2000)); } $z->close();`],
  { env: { ...process.env, ZIP: path, ID: id, N: String(n) }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const sha = createHash('sha256').update(readFileSync(path)).digest('hex');
  return { id, title: id, icon: 'app', kind: 'games', version: '1.0', size: [640, 480], sha256: sha, zips: [`https://example.com/${id}.zip`] };
}
const appEnv = (dir: string) => ({ DATA: join(dir, 'data'), WEB: join(dir, 'web'), DESKTOP_APPSTORE_DIR: join(dir, 'zips') });
const download = (app: Record<string, unknown>) => `try { echo appstore_download(json_decode(${JSON.stringify(JSON.stringify(app))}, true), getenv('DATA'), getenv('WEB'))['id']; } catch (RuntimeException $e) { echo 'ERR ', $e->getMessage(); }`;
const listed = async (dir: string): Promise<string[]> => JSON.parse((await php(['appstore.php'], `echo json_encode(array_keys(appstore_here(getenv('DATA'), getenv('WEB'))));`, appEnv(dir)).done).out).sort();

test('app store: two downloads at the same moment both land and are both listed; a download racing a delete ends with folder and list agreeing', { skip: noPhp, timeout: 300000 }, async () => {
  const dir = tempDir('tomlinos-robust-apps-');
  for (const d of ['data', 'web']) mkdirSync(join(dir, d), { recursive: true });
  const env = appEnv(dir);
  for (let round = 0; round < 4; round++) {
    const a = appZip(dir, `game${round}a`);
    const b = appZip(dir, `game${round}b`);
    const outs = await Promise.all([php(['outbound.php', 'appstore.php'], download(a), env).done, php(['outbound.php', 'appstore.php'], download(b), env).done]);
    assert.deepEqual(outs.map(o => o.out), [a.id, b.id], 'both downloaded');
    const here = await listed(dir);
    assert.ok(here.includes(a.id as string) && here.includes(b.id as string), `round ${round + 1}: both listed: ${here}`);
  }
  assert.equal((await listed(dir)).length, 8, 'eight apps, none lost');
  // A download and a delete of the same app at once, a few times: whatever order they ran in, the app's folder is there
  // exactly when the list names it.
  const c = appZip(dir, 'racer');
  for (let round = 0; round < 4; round++) {
    await Promise.all([php(['outbound.php', 'appstore.php'], download(c), env).done, php(['outbound.php', 'appstore.php'], `appstore_delete('racer', getenv('DATA'), getenv('WEB')); echo 'deleted';`, env).done]);
    const here = await listed(dir);
    const folder = existsSync(join(dir, 'web', 'apps', 'racer', 'index.html'));
    assert.equal(here.includes('racer'), folder, `round ${round + 1}: listed ${here.includes('racer')}, folder ${folder}`);
  }
  const left = readdirSync(join(dir, 'web', 'apps')).filter(n => /\.(new|old|deleting)$/.test(n));
  assert.deepEqual(left, [], 'no half-made or half-deleted folders left');
  assert.deepEqual(readdirSync(join(dir, 'data')).filter(n => n.endsWith('.zip') || n.endsWith('.tmp')), [], 'no downloads or half-written lists left');
});
