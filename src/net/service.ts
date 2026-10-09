// The page's side of the desktop's smaller server APIs (mail.php, models.php and the like), which sit beside auth.php. The same
// rules as the accounts API: this site only, the desktop's own header, the session cookie (HttpOnly; no script sees
// it), and the server's words when it refuses.
import { AuthFailure } from '../auth/api.ts';

export class ServiceApi {
  private base: string;

  /** `authPath` is the accounts API's address ("/api/auth.php"); `name` is the service ("mail"). */
  constructor(authPath: string, name: string) {
    if (!/^[a-z]+$/.test(name) || !/^\/[\w/-]*auth\.php$/.test(authPath)) throw new Error('Bad service address');
    this.base = authPath.replace(/auth\.php$/, `${name}.php`);
  }

  async call<T>(op: string, options: { query?: Record<string, string>; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
    const q = new URLSearchParams({ op, ...(options.query ?? {}) });
    let res: Response;
    try {
      res = await fetch(`${this.base}?${q}`, {
        method: options.body === undefined ? 'GET' : 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'X-Desktop-Store': '1', ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options.signal,
      });
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error;
      throw new AuthFailure(0, "The desktop's server could not be reached. Check the connection, then try again.", {});
    }
    let data: Record<string, unknown> = {};
    try {
      data = await res.json();
    } catch {
      // Not JSON: the message below covers it.
    }
    if (!res.ok) {
      const message = typeof data.error === 'string' ? data.error : `The server answered with an error (${res.status}). Try again; if it keeps happening, the server needs looking at.`;
      throw new AuthFailure(res.status, message, data);
    }
    return data as T;
  }

  /**
   * A POST whose answer arrives as lines of JSON while the server writes it (ai.php's chat). Each line goes to `onLine`
   * as it comes. A refusal before anything is written arrives as a normal error answer and throws like `call`.
   */
  async stream(op: string, body: unknown, onLine: (line: Record<string, unknown>) => void, signal?: AbortSignal): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.base}?${new URLSearchParams({ op })}`, {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'X-Desktop-Store': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error;
      throw new AuthFailure(0, "The desktop's server could not be reached. Check the connection, then try again.", {});
    }
    if (!res.ok || !res.body || !/ndjson/.test(res.headers.get('Content-Type') ?? '')) {
      let data: Record<string, unknown> = {};
      try {
        data = await res.json();
      } catch {
        // Not JSON: the message below covers it.
      }
      const message = typeof data.error === 'string' ? data.error : `The server answered with an error (${res.status}). Try again; if it keeps happening, the server needs looking at.`;
      throw new AuthFailure(res.status, message, data);
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let rest = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      rest += value;
      let nl: number;
      while ((nl = rest.indexOf('\n')) >= 0) {
        const line = rest.slice(0, nl).trim();
        rest = rest.slice(nl + 1);
        if (line) onLine(JSON.parse(line) as Record<string, unknown>);
      }
    }
    if (rest.trim()) onLine(JSON.parse(rest) as Record<string, unknown>);
  }
}
