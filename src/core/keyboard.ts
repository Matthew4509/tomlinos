// A phone's on-screen keyboard covers the bottom of the page. The desktop is fixed to the screen, so the browser cannot
// scroll a text box out from under it: what is typed lands where nobody can see it. Chrome and Firefox on Android shrink
// the page instead (interactive-widget=resizes-content in index.html); Safari on iPhone ignores that, so here the
// visible part of the page (visualViewport) is copied into --vv-top and --vv-h, and the class kb-open tells style.css
// to fit the windows and dialogs into it. On a computer, or with the keyboard closed, nothing is set and nothing changes.

export function fitAboveKeyboard(): void {
  const vv = window.visualViewport;
  if (!vv) return;
  const rootStyle = document.documentElement.style;
  let frame = 0;
  const apply = () => {
    frame = 0;
    // A zoom shrinks the visual viewport by exactly its scale, so height times scale is still the whole screen; a
    // keyboard takes well over 100px of it, zoomed or not.
    const covered = window.innerHeight - vv.height * vv.scale > 100;
    document.documentElement.classList.toggle('kb-open', covered);
    if (covered) {
      rootStyle.setProperty('--vv-top', `${Math.round(vv.offsetTop)}px`);
      rootStyle.setProperty('--vv-h', `${Math.round(vv.height)}px`);
    } else {
      rootStyle.removeProperty('--vv-top');
      rootStyle.removeProperty('--vv-h');
    }
    // The page got shorter: keep the box being typed in on screen.
    const active = document.activeElement;
    if (covered && active instanceof HTMLElement && active.matches('input, textarea, [contenteditable="true"]')) {
      active.scrollIntoView({ block: 'nearest' });
    }
  };
  const later = () => {
    if (!frame) frame = requestAnimationFrame(apply);
  };
  vv.addEventListener('resize', later);
  vv.addEventListener('scroll', later);
}
