// The store kept on this desktop's own server (server/api/store.php). It never keeps a copy in the browser, and it
// never falls back to the browser if the server cannot be reached: the person is told instead.
import { collapseOps, StoreConflict, StoreError, type Store, type StoreOp, type StoreRecord } from './store.ts';

const OP_PUT = 1;
const OP_DEL = 2;
const text = new TextEncoder();

/** The commit body server/lib/store.php parses: see store_parse_commit there. Little-endian lengths. */
export function encodeCommit(ops: StoreOp[]): Uint8Array {
  const parts: Uint8Array[] = [];
  let size = 0;
  const push = (bytes: Uint8Array) => {
    parts.push(bytes);
    size += bytes.length;
  };
  for (const o of collapseOps(ops).values()) {
    const key = text.encode(o.key);
    const expect = text.encode(o.expect);
    const head = new Uint8Array(1 + 2 + key.length + 1 + expect.length + (o.op === 'put' ? 4 : 0));
    const view = new DataView(head.buffer);
    let at = 0;
    view.setUint8(at, o.op === 'put' ? OP_PUT : OP_DEL);
    view.setUint16((at += 1), key.length, true);
    head.set(key, (at += 2));
    view.setUint8((at += key.length), expect.length);
    head.set(expect, (at += 1));
    at += expect.length;
    if (o.op === 'put') view.setUint32(at, o.data.length, true);
    push(head);
    if (o.op === 'put') push(o.data);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    body.set(p, at);
    at += p.length;
  }
  return body;
}

async function serverMessage(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (body && typeof body.error === 'string') return body.error;
  } catch {
    // Not JSON: fall through to the general message.
  }
  return `The desktop's server answered with an error (${res.status}). Try again; if it keeps happening, the server needs looking at.`;
}

export class ServerStore implements Store {
  readonly label = "this desktop's server";
  /** Told when the server says the person is signed out (401) or the screen is locked (423), so the page can ask. */
  onAuthLost: ((kind: 'signin' | 'locked', message: string) => void) | null = null;
  private api: string;

  constructor(api: string) {
    this.api = api;
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, {
        ...init,
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'X-Desktop-Store': '1', ...(init.headers ?? {}) },
      });
    } catch {
      throw new StoreError("The desktop's server could not be reached. Check the connection, then try again. Nothing was changed.");
    }
  }

  private async failure(res: Response): Promise<StoreError> {
    const message = await serverMessage(res);
    if (res.status === 401 || res.status === 423) this.onAuthLost?.(res.status === 423 ? 'locked' : 'signin', message);
    return new StoreError(message, res.status);
  }

  async get(key: string): Promise<StoreRecord | null> {
    const res = await this.send(`${this.api}?key=${encodeURIComponent(key)}`, { method: 'GET' });
    if (res.status === 404) return null;
    if (!res.ok) throw await this.failure(res);
    const version = res.headers.get('X-Store-Version') ?? '';
    return { version, data: new Uint8Array(await res.arrayBuffer()) };
  }

  /** Every key in the signed-in person's store (to rewrite each record when encryption is turned on or off). */
  async keys(): Promise<string[]> {
    const res = await this.send(`${this.api}?op=keys`, { method: 'GET' });
    if (!res.ok) throw await this.failure(res);
    const keys = (await res.json()).keys;
    return Array.isArray(keys) ? keys.filter((k: unknown): k is string => typeof k === 'string') : [];
  }

  async commit(ops: StoreOp[]): Promise<Record<string, string>> {
    if (!ops.length) return {};
    const res = await this.send(`${this.api}?op=commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: encodeCommit(ops) as BodyInit,
    });
    if (res.status === 409) {
      let keys: string[] = [];
      try {
        keys = (await res.json()).keys ?? [];
      } catch {
        // The keys only speed up the retry; without them every cached record is re-read.
      }
      throw new StoreConflict(keys);
    }
    if (!res.ok) throw await this.failure(res);
    return (await res.json()).versions ?? {};
  }
}
