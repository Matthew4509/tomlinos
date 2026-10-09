// The one door for apps to read a file the desktop itself ships (version.json, the vendor licence list). It takes only
// a relative path, so no app can use it to reach another site; the test in shell.test.ts holds every other fetch to
// the few files that talk to this site's own API.

/** A path relative to the page ("vendor/x.json"); anything with a scheme or starting with "//" or "/" is refused. */
export function localPath(path: string): string {
  if (/^[a-z][a-z0-9+.-]*:|^[\\/]{1,2}/i.test(path) || path.includes('..')) throw new Error(`Not a local path: ${path}`);
  return path;
}

export async function readLocalText(path: string): Promise<string> {
  const res = await fetch(localPath(path), { cache: 'no-store', credentials: 'same-origin' });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.text();
}

/** How the site answers for one of its own files, without downloading it: the status, or 0 when it did not answer. */
export async function localStatus(path: string): Promise<number> {
  try {
    return (await fetch(localPath(path), { method: 'HEAD', cache: 'no-store', credentials: 'same-origin' })).status;
  } catch {
    return 0;
  }
}

export async function readLocalJson<T>(path: string): Promise<T> {
  return JSON.parse(await readLocalText(path)) as T;
}
