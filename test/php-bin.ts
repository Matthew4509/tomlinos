// PHP for the tests that run it directly: PHP_BIN if set, else "php" on the PATH.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const PHP = process.env.PHP_BIN ?? 'php';

export const hasPhp = (() => {
  try { return spawnSync(PHP, ['-v'], { stdio: 'ignore' }).status === 0; } catch { return false; }
})();

// A portable Windows PHP ships openssl, curl and sodium unloaded beside it in ext/; a system PHP already loads them.
// The folder is found from the PHP that actually runs, so "php" found on the PATH works the same as a full PHP_BIN,
// and an extension that PHP already has loaded is left out: naming it again prints "Module is already loaded"
// warnings into the output the tests read.
const phpFacts = (() => {
  try {
    const r = spawnSync(PHP, ['-r', 'echo PHP_BINARY, "\\n", strtolower(implode(",", get_loaded_extensions()));'], { encoding: 'utf8' });
    if (r.status !== 0) return null;
    const [binary = '', loaded = ''] = r.stdout.trim().split(/\r?\n/);
    return { dir: join(dirname(binary), 'ext'), loaded: new Set(loaded.split(',')) };
  } catch { return null; }
})();

export function extFlags(...names: string[]): string[] {
  if (!phpFacts || !existsSync(phpFacts.dir)) return [];
  const wanted = names.filter(n => !phpFacts.loaded.has(n.toLowerCase()) && existsSync(join(phpFacts.dir, `php_${n}.dll`)));
  return wanted.length ? ['-d', `extension_dir=${phpFacts.dir}`, ...wanted.flatMap(n => ['-d', `extension=${n}`])] : [];
}

/**
 * Throws when something already answers on the port a test is about to give its own PHP server. An earlier run's server
 * left behind (with its own data folder and its brakes) otherwise answers instead, and the tests fail for no reason of
 * their own (a 429 where a 409 was expected, then everything after it).
 */
export async function portFree(port: number): Promise<void> {
  const { connect } = await import('node:net');
  const taken = await new Promise<boolean>(resolve => {
    const s = connect(port, '127.0.0.1');
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });
  if (taken) throw new Error(`Port ${port} is already in use, so this test's own PHP server cannot start there. An earlier run may have left a php -S behind: find it with  netstat -ano | findstr :${port}  and stop it, then run the tests again.`);
}
