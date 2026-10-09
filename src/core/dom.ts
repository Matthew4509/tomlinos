// The only way the desktop puts anything into the page. Every string becomes a text node, so a file called
// "<img onerror=...>" is shown as those letters and never runs. There is deliberately no innerHTML here, and
// attributes named "style" or "on..." are refused: styles go through css(), events through on().
export type Child = Node | string | number | null | undefined | false;
export type Attrs = Record<string, string | number | boolean | null | undefined>;

const SVG_NS = 'http://www.w3.org/2000/svg';

const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'poster', 'data']);

function setAttrs(el: Element, attrs: Attrs): void {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    const lower = key.toLowerCase();
    if (lower === 'style' || lower.startsWith('on') || lower === 'srcdoc') {
      throw new Error(`Attribute "${key}" is not allowed; use css() or on().`);
    }
    // An address that runs script (javascript:, vbscript:) or carries a whole page (data:) is never set, whoever passed
    // it: a contact's website or an event's link must not become a way to run code in the desktop.
    if (URL_ATTRS.has(lower) && typeof value === 'string' && /^[\s\u0000-\u001f]*(javascript|vbscript|data):/i.test(value)) {
      throw new Error(`That address is not allowed in "${key}".`);
    }
    el.setAttribute(key, value === true ? '' : String(value));
  }
}

function append(el: Element, kids: Child[]): void {
  for (const kid of kids) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(typeof kid === 'string' || typeof kid === 'number' ? document.createTextNode(String(kid)) : kid);
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  setAttrs(el, attrs);
  append(el, kids);
  return el;
}

export function svg(tag: string, attrs: Attrs = {}, ...kids: Child[]): SVGElement {
  const el = document.createElementNS(SVG_NS, tag) as SVGElement;
  setAttrs(el, attrs);
  append(el, kids);
  return el;
}

const UNITLESS = new Set(['z-index', 'opacity', 'flex', 'flex-grow', 'flex-shrink', 'order', 'line-height']);

/** Sets style properties one by one (allowed under a strict Content-Security-Policy, unlike a style attribute). */
export function css(el: HTMLElement | SVGElement, props: Record<string, string | number | null>): void {
  for (const [name, value] of Object.entries(props)) {
    if (value === null) el.style.removeProperty(name);
    else el.style.setProperty(name, typeof value === 'number' && !UNITLESS.has(name) ? `${value}px` : String(value));
  }
}

/** Adds a listener that is removed when the signal aborts (a window closing, a view being dropped). */
export function on<K extends keyof HTMLElementEventMap>(
  target: HTMLElement,
  type: K,
  handler: (event: HTMLElementEventMap[K]) => void,
  signal: AbortSignal,
  options?: { capture?: boolean; passive?: boolean },
): void;
export function on(
  target: Window | Document | HTMLElement,
  type: string,
  handler: (event: any) => void,
  signal: AbortSignal,
  options?: { capture?: boolean; passive?: boolean },
): void;
export function on(target: EventTarget, type: string, handler: (event: any) => void, signal: AbortSignal, options: { capture?: boolean; passive?: boolean } = {}): void {
  target.addEventListener(type, handler, { ...options, signal });
}

export function clear(el: Element): void {
  el.replaceChildren();
}

/** Whether a pointer event is the kind that can drag (a mouse or pen); touch scrolls and long-presses instead. */
export function isPrecisePointer(event: PointerEvent): boolean {
  return event.pointerType === 'mouse' || event.pointerType === 'pen';
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
