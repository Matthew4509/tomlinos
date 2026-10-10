// Throw-away folders for tests, removed when the test's process ends, pass or fail. A folder left behind by every run
// filled a disk once (tens of gigabytes in the system's temporary folder), so every test makes its folders here.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const made: string[] = [];
process.on('exit', () => {
  for (const dir of made) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A file still held open (Windows): the next run's folders are still removed.
    }
  }
});

export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}
