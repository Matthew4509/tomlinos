// When the window is narrower than the ribbon, desktop office programs show small arrows at its ends rather than a
// scroll bar. The ribbon keeps scrolling sideways as before (the spreadsheet relies on it); here its bar is hidden
// (sheets.css) and an arrow appears at each end that has groups out of sight. The mouse wheel over the ribbon
// scrolls it sideways too.
import { css, h, on } from '../../src/core/dom.ts';

export function ribbonArrows(root: HTMLElement, signal: AbortSignal): void {
  const ribbon = root.querySelector<HTMLElement>('.ribbon');
  if (!ribbon) return;
  const left = h('button', { type: 'button', class: 'ribbon-arrow left', 'aria-label': 'Show more of the ribbon to the left', tabindex: -1 }, '‹');
  const right = h('button', { type: 'button', class: 'ribbon-arrow right', 'aria-label': 'Show more of the ribbon to the right', tabindex: -1 }, '›');
  ribbon.after(left, right);
  const place = () => {
    const top = ribbon.offsetTop;
    for (const b of [left, right]) css(b, { top, height: ribbon.offsetHeight });
    const max = ribbon.scrollWidth - ribbon.clientWidth;
    left.hidden = ribbon.scrollLeft <= 1;
    right.hidden = ribbon.scrollLeft >= max - 1;
  };
  const step = (d: number) => {
    ribbon.scrollBy({ left: d * Math.max(200, ribbon.clientWidth * 0.6) });
    place();
  };
  on(left, 'click', () => step(-1), signal);
  on(right, 'click', () => step(1), signal);
  on(ribbon, 'scroll', place, signal, { passive: true });
  on(ribbon, 'wheel', (event: WheelEvent) => {
    if (ribbon.scrollWidth <= ribbon.clientWidth || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    event.preventDefault();
    ribbon.scrollLeft += event.deltaY;
    place();
  }, signal);
  // The ribbon's width changes with the window; its contents change with each tab.
  const sized = new ResizeObserver(place);
  sized.observe(ribbon);
  const changed = new MutationObserver(place);
  changed.observe(ribbon, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  signal.addEventListener('abort', () => {
    sized.disconnect();
    changed.disconnect();
  });
  place();
}
