// PHP for the tests that run it directly: PHP_BIN if set, else "php" on the PATH.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const PHP = process.env.PHP_BIN ?? 'php';

export const hasPhp = (() => {
  try { return spawnSync(PHP, ['-v'], { stdio: 'ignore' }).status === 0; } catch { return false; }
})();

// A portable Windows PHP ships openssl and curl unloaded beside it in ext/; a system PHP already loads them.
export function extFlags(...names: string[]): string[] {
  const dir = join(dirname(PHP), 'ext');
  if (!existsSync(dir)) return [];
  return ['-d', `extension_dir=${dir}`, ...names.flatMap(n => ['-d', `extension=${n}`])];
}
