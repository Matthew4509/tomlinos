// The small round "!" placed after a label, for detail that need not be read before acting. Hovering it with a mouse,
// or reaching it with the keyboard, shows a short tip; a tap (or Enter or Space) pins it open and a second one shuts
// it; Escape hides it. The tip text is in the page all the time and linked to the button by aria-describedby, so a
// screen reader reads it with the button. Warnings a person must see before deleting, losing files, paying or choosing
// how safe their account is never go in a tip: those stay on the page.
import { css, h } from '../core/dom.ts';

let made = 0;
const GAP = 6;

/** A "!" button with its tip. `label` names what it is about ("More about <label>"). */
export function infoTip(label: string, text: string): HTMLSpanElement {
  const id = `infotip-${++made}`;
  const tip = h('span', { class: 'infotip-text', id, role: 'tooltip', hidden: true }, text);
  const btn = h('button', { type: 'button', class: 'infotip-btn', 'aria-label': `More about ${label}`, 'aria-describedby': id }, '!');
  const wrap = h('span', { class: 'infotip' }, btn, tip);
  let pinned = false;
  let hovering = false;
  let keyFocus = false;
  let shut = false;
  let leaveTimer = 0;

  const place = () => {
    const r = btn.getBoundingClientRect();
    css(tip, { left: 0, top: 0 });
    const w = tip.offsetWidth;
    const hgt = tip.offsetHeight;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    const below = r.bottom + GAP;
    const top = below + hgt > window.innerHeight - 8 && r.top - GAP - hgt > 8 ? r.top - GAP - hgt : below;
    css(tip, { left, top });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    shut = true;
    pinned = false;
    paint();
  };
  const onAway = () => {
    pinned = false;
    hovering = false;
    paint();
  };
  function paint(): void {
    const show = !shut && (pinned || hovering || keyFocus);
    if (show === !tip.hidden) return;
    tip.hidden = !show;
    wrap.classList.toggle('open', show);
    if (show) {
      place();
      document.addEventListener('keydown', onKey, true);
      document.addEventListener('scroll', onAway, true);
      window.addEventListener('resize', onAway);
    } else {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('scroll', onAway, true);
      window.removeEventListener('resize', onAway);
    }
  }

  wrap.addEventListener('pointerenter', e => {
    if (e.pointerType !== 'mouse') return;
    clearTimeout(leaveTimer);
    hovering = true;
    paint();
  });
  wrap.addEventListener('pointerleave', e => {
    if (e.pointerType !== 'mouse') return;
    leaveTimer = window.setTimeout(() => {
      hovering = false;
      shut = false;
      paint();
    }, 150);
  });
  btn.addEventListener('focus', () => {
    keyFocus = btn.matches(':focus-visible');
    paint();
  });
  btn.addEventListener('blur', () => {
    keyFocus = false;
    pinned = false;
    shut = false;
    paint();
  });
  btn.addEventListener('click', () => {
    if (!tip.hidden) {
      pinned = false;
      shut = true;
    } else {
      pinned = true;
      shut = false;
    }
    paint();
  });
  return wrap;
}

/** Changes what an infoTip() says. */
export function setInfoTip(tipEl: HTMLElement, text: string): void {
  const t = tipEl.querySelector('.infotip-text');
  if (t) t.textContent = text;
}
