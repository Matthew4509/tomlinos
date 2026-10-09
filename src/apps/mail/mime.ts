// Reads an email as it arrives from the server: headers (with their encoded words), addresses, quoted-printable and
// base64 bodies, character sets, and multipart messages with attachments. Our own code; no browser needed, so it is
// tested in Node. Caps keep a hostile message from making it work forever: 12 levels of parts, 300 parts in all.

export interface Address {
  name: string;
  email: string;
}

export interface Attachment {
  name: string;
  type: string;
  data: Uint8Array;
  /** Content-ID, for pictures an HTML body shows with cid: */
  cid: string | null;
  inline: boolean;
}

export interface Message {
  subject: string;
  from: Address[];
  to: Address[];
  cc: Address[];
  replyTo: Address[];
  date: Date | null;
  messageId: string;
  references: string;
  text: string | null;
  html: string | null;
  attachments: Attachment[];
}

const MAX_DEPTH = 12;
const MAX_PARTS = 300;

/** Bytes to a "binary string" (one character per byte), which is how mail is split and scanned. */
export function binary(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return out;
}
export function bytesOf(bin: string): Uint8Array {
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 255;
  return out;
}

/** Text in a named character set; an unknown set is read as Windows Latin-1, which never fails. */
export function decodeCharset(bytes: Uint8Array, charset: string): string {
  const cs = (charset || 'utf-8').trim().toLowerCase().replace(/^["']|["']$/g, '');
  const tries = [cs === 'us-ascii' || cs === 'ascii' ? 'utf-8' : cs, 'windows-1252'];
  for (const c of tries) {
    try {
      return new TextDecoder(c).decode(bytes);
    } catch {
      // Not a set the browser knows; try the next.
    }
  }
  return binary(bytes);
}

export function decodeQP(bin: string, header = false): string {
  let s = header ? bin.replace(/_/g, ' ') : bin;
  s = s.replace(/=\r?\n/g, '');
  return s.replace(/=([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

export function decodeBase64(bin: string): string {
  const clean = bin.replace(/[^A-Za-z0-9+/]/g, '');
  const padded = clean + '='.repeat((4 - (clean.length % 4)) % 4);
  try {
    return atob(padded.length % 4 === 1 ? padded.slice(0, -1) : padded);
  } catch {
    return '';
  }
}

/** "=?UTF-8?B?...?=" and friends in a header, decoded. Spaces between two encoded words are dropped (RFC 2047). */
export function decodeWords(value: string): string {
  const word = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;
  const joined = value.replace(/(=\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)\s+(?==\?)/g, '$1');
  return joined.replace(word, (_, charset: string, enc: string, text: string) => {
    const bin = enc.toUpperCase() === 'B' ? decodeBase64(text) : decodeQP(text, true);
    return decodeCharset(bytesOf(bin), charset.split('*')[0]);
  });
}

/** Header fields, names in lower case, each with every value it had (folded lines joined). */
export function parseHeaders(bin: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const unfolded = bin.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const m = /^([!-9;-~]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const name = m[1].toLowerCase();
    out.set(name, [...(out.get(name) ?? []), m[2].trim()]);
  }
  return out;
}

const first = (h: Map<string, string[]>, name: string) => h.get(name)?.[0] ?? '';

/** Header text as people read it: bytes read as UTF-8 when they are, encoded words decoded. */
export function headerText(raw: string): string {
  // Raw 8-bit bytes in a header are almost always UTF-8 nowadays.
  let s = raw;
  if (/[\x80-\xff]/.test(raw)) {
    try {
      s = new TextDecoder('utf-8', { fatal: true }).decode(bytesOf(raw));
    } catch {
      s = decodeCharset(bytesOf(raw), 'windows-1252');
    }
  }
  return decodeWords(s).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
}

/** "Ann <a@b.c>, "Lee, Bo" <d@e.f>, g@h.i" -> addresses. Group names ("Team: a@b;") are dropped, members kept. */
export function parseAddresses(raw: string): Address[] {
  const text = headerText(raw);
  const out: Address[] = [];
  let cur = '';
  let quoted = false;
  let angle = 0;
  const flush = () => {
    const part = cur.trim().replace(/^[^:<"]*:(?![^<]*>)/, '').replace(/;$/, '').trim();
    cur = '';
    if (!part) return;
    const m = /^(.*?)<([^<>]+)>\s*$/.exec(part);
    if (m) out.push({ name: m[1].trim().replace(/^"|"$/g, '').replace(/\\(.)/g, '$1'), email: m[2].trim() });
    else if (part.includes('@')) out.push({ name: '', email: part.replace(/\s*\(.*\)\s*$/, '') });
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && quoted) {
      cur += c + (text[++i] ?? '');
      continue;
    }
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === '<') angle++;
    else if (!quoted && c === '>') angle = Math.max(0, angle - 1);
    if ((c === ',' || c === ';') && !quoted && angle === 0) {
      if (c === ';') cur += c;
      flush();
      continue;
    }
    cur += c;
  }
  flush();
  return out.slice(0, 500);
}

export function showAddress(a: Address): string {
  return a.name ? `${a.name} <${a.email}>` : a.email;
}

/** "text/plain; charset=utf-8; name*=UTF-8''r%C3%A9sum%C3%A9.pdf" -> type and parameters (RFC 2231 names decoded). */
export function parseContentType(raw: string): { type: string; params: Record<string, string> } {
  const [typePart, ...rest] = splitParams(raw);
  const params: Record<string, string> = {};
  const pieces: Record<string, { charset: string; parts: string[] }> = {};
  for (const p of rest) {
    const m = /^([^=\s]+)\s*=\s*(.*)$/.exec(p.trim());
    if (!m) continue;
    let name = m[1].toLowerCase();
    let value = m[2].trim();
    if (value.startsWith('"')) value = value.slice(1, value.endsWith('"') ? -1 : undefined).replace(/\\(.)/g, '$1');
    // RFC 2231: name*0*=UTF-8''abc, name*1*=def, or name*=UTF-8''abc
    const cont = /^(.+?)\*(\d+)?(\*)?$/.exec(name);
    if (cont) {
      name = cont[1];
      const entry = (pieces[name] ??= { charset: '', parts: [] });
      let v = value;
      if (cont[3]) {
        const cs = /^([^']*)'[^']*'(.*)$/.exec(v);
        if (cs && (cont[2] === undefined || cont[2] === '0')) {
          entry.charset = cs[1];
          v = cs[2];
        }
        v = v.replace(/%([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
      }
      entry.parts[Number(cont[2] ?? 0)] = v;
      continue;
    }
    params[name] = value;
  }
  for (const [name, e] of Object.entries(pieces)) params[name] = decodeCharset(bytesOf(e.parts.join('')), e.charset || 'utf-8');
  return { type: (typePart || 'text/plain').trim().toLowerCase(), params };
}

function splitParams(raw: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '"' && raw[i - 1] !== '\\') quoted = !quoted;
    if (c === ';' && !quoted) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function decodeBody(bin: string, encoding: string): string {
  const e = encoding.trim().toLowerCase();
  if (e === 'base64') return decodeBase64(bin);
  if (e === 'quoted-printable') return decodeQP(bin);
  return bin;
}

function splitHead(bin: string): [string, string] {
  const m = /\r?\n\r?\n/.exec(bin);
  return m ? [bin.slice(0, m.index), bin.slice(m.index + m[0].length)] : [bin, ''];
}

/** Reads a whole message. */
export function parseMessage(bytes: Uint8Array): Message {
  const bin = binary(bytes);
  const [headBin] = splitHead(bin);
  const h = parseHeaders(headBin);
  const msg: Message = {
    subject: headerText(first(h, 'subject')),
    from: parseAddresses(first(h, 'from')),
    to: parseAddresses((h.get('to') ?? []).join(', ')),
    cc: parseAddresses((h.get('cc') ?? []).join(', ')),
    replyTo: parseAddresses(first(h, 'reply-to')),
    date: parseDate(first(h, 'date')),
    messageId: first(h, 'message-id').trim(),
    references: first(h, 'references').trim(),
    text: null,
    html: null,
    attachments: [],
  };
  let parts = 0;
  const walk = (partBin: string, depth: number) => {
    if (depth > MAX_DEPTH || ++parts > MAX_PARTS) return;
    const [ph, body] = splitHead(partBin);
    const headers = parseHeaders(ph);
    const ct = parseContentType(first(headers, 'content-type') || 'text/plain; charset=us-ascii');
    const disp = parseContentType(first(headers, 'content-disposition'));
    const encoding = first(headers, 'content-transfer-encoding');
    if (ct.type.startsWith('multipart/')) {
      const boundary = ct.params.boundary;
      if (!boundary) return;
      const marker = `--${boundary}`;
      const pieces = body.split(new RegExp(`(?:^|\\r?\\n)${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      for (const piece of pieces.slice(1)) {
        if (piece.startsWith('--')) break;
        walk(piece.replace(/^[ \t]*\r?\n/, ''), depth + 1);
      }
      return;
    }
    const name = headerText(disp.params.filename ?? ct.params.name ?? '');
    const data = decodeBody(body, encoding);
    // The body is the plain and HTML text that is not marked as an attachment; everything else is an attachment.
    // A second plain part (a mailing list's footer, say) is added to the text rather than hidden.
    const isBody = disp.type !== 'attachment' && (ct.type === 'text/plain' || ct.type === 'text/html');
    if (isBody && ct.type === 'text/plain') {
      const text = decodeCharset(bytesOf(data), ct.params.charset ?? 'us-ascii');
      msg.text = msg.text === null ? text : `${msg.text}\n\n${text}`;
      return;
    }
    if (isBody && msg.html === null) {
      msg.html = decodeCharset(bytesOf(data), ct.params.charset ?? 'us-ascii');
      return;
    }
    const cid = first(headers, 'content-id').replace(/^<|>$/g, '') || null;
    const ext = ct.type === 'message/rfc822' ? '.eml' : '';
    msg.attachments.push({
      name: (name || (cid ? `picture-${msg.attachments.length + 1}` : `attachment-${msg.attachments.length + 1}`) + (name ? '' : ext)).replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 200),
      type: ct.type,
      data: bytesOf(data),
      cid,
      inline: disp.type === 'inline' || (!!cid && disp.type !== 'attachment'),
    });
  };
  walk(bin, 0);
  return msg;
}

export function parseDate(raw: string): Date | null {
  if (!raw) return null;
  const d = new Date(raw.replace(/\s*\([^)]*\)\s*$/, ''));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** For the message list: from, subject and date from the header lines the server sends. */
export function summary(headBin: string): { from: Address[]; to: Address[]; subject: string; date: Date | null; messageId: string; attachment: boolean } {
  const h = parseHeaders(headBin);
  const ct = parseContentType(first(h, 'content-type'));
  return {
    from: parseAddresses(first(h, 'from')),
    to: parseAddresses((h.get('to') ?? []).join(', ')),
    subject: headerText(first(h, 'subject')),
    date: parseDate(first(h, 'date')),
    messageId: first(h, 'message-id'),
    attachment: ct.type === 'multipart/mixed',
  };
}

/** The quoted text under a reply: "On <date>, <name> wrote:" and each line with "> ". */
export function quoteForReply(m: Message, plain: string): string {
  const who = m.from[0] ? (m.from[0].name || m.from[0].email) : 'someone';
  const when = m.date ? m.date.toLocaleString() : '';
  return `\n\nOn ${when}, ${who} wrote:\n` + plain.replace(/\r\n/g, '\n').split('\n').map(l => `> ${l}`).join('\n');
}

/** "Re: " once, never "Re: Re: Re:". */
export function replySubject(subject: string, forward = false): string {
  const bare = subject.replace(/^(\s*(re|fw|fwd|aw|sv)\s*(\[\d+\])?\s*:\s*)+/i, '');
  return `${forward ? 'Fwd' : 'Re'}: ${bare}`;
}
