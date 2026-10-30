// A small XML reader and writer (the parts of an .xlsx file, an OpenRaster stack). Our own code (no browser needed, so it can be tested).
// Nothing in a file is trusted: a DOCTYPE (where "entity" tricks live) is refused, only the five standard entities and
// numbered characters are read, and the reader never calls itself, so a deeply nested file cannot run out of stack.

export class XmlProblem extends Error {}

export interface XmlEl {
  /** The name without its namespace prefix ("x:c" is "c"). */
  name: string;
  /** Attributes by their full name ("r:id"), and also by their name without a prefix when that is not taken. */
  attrs: Record<string, string>;
  kids: XmlEl[];
  /** The text directly inside this element (not inside its children). */
  text: string;
  /** Where the element starts and ends in the source (so a part can be copied out exactly as written). */
  start?: number;
  end?: number;
}

const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function unescapeXml(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      // D800-DFFF are halves of a character, never a character on their own: a lone half would be saved as "?".
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : '';
    }
    return NAMED[body] ?? whole;
  });
}

const localName = (n: string): string => {
  const i = n.indexOf(':');
  return i < 0 ? n : n.slice(i + 1);
};

const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;

/** Reads name="value" pairs in one pass over the text (a pattern match here could take minutes on a long hostile tag). */
function readAttrs(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!src.includes('=')) return out;
  const n = src.length;
  let i = 0;
  while (i < n) {
    while (i < n && isSpace(src.charCodeAt(i))) i++;
    const start = i;
    while (i < n) {
      const c = src.charCodeAt(i);
      if (isSpace(c) || c === 61 /* = */ || c === 47 /* / */) break;
      i++;
    }
    if (i === start) {
      i++;
      continue;
    }
    const name = src.slice(start, i);
    let j = i;
    while (j < n && isSpace(src.charCodeAt(j))) j++;
    if (src.charCodeAt(j) !== 61) {
      i = j;
      continue;
    }
    j++;
    while (j < n && isSpace(src.charCodeAt(j))) j++;
    const q = src.charCodeAt(j);
    if (q !== 34 && q !== 39) {
      i = j;
      continue;
    }
    const end = src.indexOf(q === 34 ? '"' : "'", j + 1);
    if (end < 0) break;
    const v = unescapeXml(src.slice(j + 1, end));
    out[name] = v;
    const local = localName(name);
    if (local !== name && !(local in out)) out[local] = v;
    i = end + 1;
  }
  return out;
}

/** Reads a whole XML document into elements. Throws XmlProblem when it is not well formed enough to read. */
export function parseXml(src: string): XmlEl {
  const root: XmlEl = { name: '#root', attrs: {}, kids: [], text: '' };
  const stack: XmlEl[] = [root];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    const top = stack[stack.length - 1];
    if (lt < 0) {
      if (stack.length > 1) top.text += unescapeXml(src.slice(i));
      break;
    }
    if (lt > i && stack.length > 1) top.text += unescapeXml(src.slice(i, lt));
    const next = src.charCodeAt(lt + 1);
    if (next === 63 /* ? */) {
      const end = src.indexOf('?>', lt + 2);
      if (end < 0) throw new XmlProblem('A processing instruction is not closed.');
      i = end + 2;
    } else if (next === 33 /* ! */) {
      if (src.startsWith('<!--', lt)) {
        const end = src.indexOf('-->', lt + 4);
        if (end < 0) throw new XmlProblem('A comment is not closed.');
        i = end + 3;
      } else if (src.startsWith('<![CDATA[', lt)) {
        const end = src.indexOf(']]>', lt + 9);
        if (end < 0) throw new XmlProblem('A CDATA section is not closed.');
        if (stack.length > 1) top.text += src.slice(lt + 9, end);
        i = end + 3;
      } else {
        // <!DOCTYPE ...> can define entities that expand to gigabytes: an .xlsx never needs one.
        throw new XmlProblem('The file holds a document type definition, which is not allowed here.');
      }
    } else if (next === 47 /* / */) {
      const end = src.indexOf('>', lt + 2);
      if (end < 0) throw new XmlProblem('A closing tag is not finished.');
      const name = localName(src.slice(lt + 2, end).trim());
      if (stack.length <= 1 || top.name !== name) throw new XmlProblem(`A closing tag </${name}> does not match.`);
      top.end = end + 1;
      stack.pop();
      i = end + 1;
    } else {
      // A tag: find its end, minding ">" inside quoted attribute values.
      let j = lt + 1;
      let quote = 0;
      for (; j < n; j++) {
        const c = src.charCodeAt(j);
        if (quote) {
          if (c === quote) quote = 0;
        } else if (c === 34 || c === 39) quote = c;
        else if (c === 62 /* > */) break;
      }
      if (j >= n) throw new XmlProblem('A tag is not finished.');
      const selfClosing = src.charCodeAt(j - 1) === 47;
      const body = src.slice(lt + 1, selfClosing ? j - 1 : j);
      const space = body.search(/[\s]/);
      const rawName = space < 0 ? body : body.slice(0, space);
      if (!rawName) throw new XmlProblem('A tag has no name.');
      const el: XmlEl = { name: localName(rawName), attrs: space < 0 ? {} : readAttrs(body.slice(space)), kids: [], text: '', start: lt, end: j + 1 };
      top.kids.push(el);
      if (!selfClosing) stack.push(el);
      i = j + 1;
    }
  }
  if (stack.length > 1) throw new XmlProblem(`The element <${stack[stack.length - 1].name}> is not closed. The file may be cut short.`);
  const doc = root.kids[0];
  if (!doc) throw new XmlProblem('The file is empty.');
  return doc;
}

/** The first child with this name, if any. */
export function child(el: XmlEl | undefined, name: string): XmlEl | undefined {
  return el?.kids.find(k => k.name === name);
}

/** Every child with this name. */
export function children(el: XmlEl | undefined, name: string): XmlEl[] {
  return el ? el.kids.filter(k => k.name === name) : [];
}

/** All the text inside an element and its children, in order (a rich-text string's runs joined). */
export function allText(el: XmlEl): string {
  let out = el.text;
  for (const k of el.kids) out += allText(k);
  return out;
}

// ---- Writing -------------------------------------------------------------------------------------------------------

/** Characters XML 1.0 cannot hold at all (most control characters). */
const NOT_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g;

export function escapeXml(s: string): string {
  return s.replace(NOT_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** For an attribute value: as escapeXml, and tabs and line breaks as numbers too (XML readers turn raw ones into spaces). */
export function escapeAttr(s: string): string {
  return escapeXml(s).replace(/\t/g, '&#9;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;');
}

/** An element as text: `attrs` with undefined values left out; `inner` is already-escaped XML (or nothing). */
export function tag(name: string, attrs: Record<string, string | number | undefined> = {}, inner?: string): string {
  let out = `<${name}`;
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) out += ` ${k}="${escapeAttr(String(v))}"`;
  return inner === undefined || inner === '' ? `${out}/>` : `${out}>${inner}</${name}>`;
}

export const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
