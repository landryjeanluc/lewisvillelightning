/** Fullscreen is progressive enhancement: iPhones can use the same workspace
 * in a fixed viewport even when the browser cannot fullscreen HTML elements. */
export function mountPlayFullscreen(root: HTMLElement, button: HTMLButtonElement, autoHide = false) {
  const mobile = matchMedia('(max-width: 760px), (pointer: coarse)');
  const chrome = [...root.querySelectorAll<HTMLElement>('[data-play-controls]')];
  let active = false;
  let native = false;
  let generation = 0;
  let timer = 0;
  let pressing = false;
  let keyboard = false;
  let scrollY = 0;
  let savedBodyStyle: string | null = null;
  const background = new Map<HTMLElement, boolean>();

  function reveal() {
    clearTimeout(timer);
    root.classList.remove('play-controls-hidden');
    chrome.forEach(el => { el.inert = false; });
    if (!active || !autoHide || !mobile.matches || keyboard || pressing) return;
    timer = window.setTimeout(() => {
      root.classList.add('play-controls-hidden');
      chrome.forEach(el => { el.inert = true; });
    }, 3000);
  }

  function viewport() {
    if (!active) return;
    const v = window.visualViewport;
    root.style.setProperty('--play-viewport-height', `${v?.height ?? innerHeight}px`);
    root.style.setProperty('--play-viewport-top', `${v?.offsetTop ?? 0}px`);
  }

  function reset() {
    if (!active) return;
    active = false;
    native = false;
    generation++;
    root.classList.remove('is-play-fullscreen');
    root.style.removeProperty('--play-viewport-height');
    root.style.removeProperty('--play-viewport-top');
    reveal();
    background.forEach((inert, el) => { el.inert = inert; });
    background.clear();
    if (savedBodyStyle === null) document.body.removeAttribute('style');
    else document.body.setAttribute('style', savedBodyStyle);
    window.scrollTo({ top: scrollY, behavior: 'instant' });
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-label', 'Enter full screen');
    button.title = 'Enter full screen';
    button.querySelector('span')!.textContent = 'Full screen';
    button.focus({ preventScroll: true });
  }

  function exit() {
    if (document.fullscreenElement === root) void document.exitFullscreen().catch(() => {});
    reset();
  }

  button.addEventListener('click', async event => {
    if (active) { exit(); return; }
    keyboard = event.detail === 0;
    active = true;
    const attempt = ++generation;
    scrollY = window.scrollY;
    savedBodyStyle = document.body.getAttribute('style');
    // Disable only siblings along the ancestor chain, never the workspace.
    for (let node: HTMLElement | null = root; node?.parentElement; node = node.parentElement) {
      for (const sibling of node.parentElement.children) {
        if (sibling !== node && sibling instanceof HTMLElement) {
          background.set(sibling, sibling.inert);
          sibling.inert = true;
        }
      }
      if (node.parentElement === document.body) break;
    }
    Object.assign(document.body.style, { position: 'fixed', top: `${-scrollY}px`, width: '100%', overflow: 'hidden' });
    root.classList.add('is-play-fullscreen');
    button.setAttribute('aria-pressed', 'true');
    button.setAttribute('aria-label', 'Exit full screen');
    button.title = 'Exit full screen';
    button.querySelector('span')!.textContent = 'Exit full screen';
    viewport();
    reveal();
    try {
      if (root.requestFullscreen && document.fullscreenEnabled) {
        await root.requestFullscreen();
        // An exit or navigation may have happened while the request was pending.
        if (attempt !== generation) {
          if (document.fullscreenElement === root) await document.exitFullscreen();
        } else native = document.fullscreenElement === root;
      }
    } catch { /* Keep the viewport fallback when native fullscreen is denied. */ }
  });
  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement === root) native = true;
    else if (native) reset();
    viewport();
  });
  root.addEventListener('pointerdown', () => { keyboard = false; pressing = true; reveal(); });
  window.addEventListener('pointerup', () => { pressing = false; if (active) reveal(); });
  window.addEventListener('pointercancel', () => { pressing = false; if (active) reveal(); });
  root.addEventListener('pointermove', () => { if (active) reveal(); });
  root.addEventListener('focusin', () => {
    if (active && document.activeElement?.matches(':focus-visible')) { keyboard = true; reveal(); }
  });
  root.querySelector('.play-show-controls')?.addEventListener('click', () => {
    keyboard = true;
    reveal();
    button.focus({ preventScroll: true });
  });
  root.addEventListener('scroll', () => { if (active) reveal(); }, true);
  document.addEventListener('keydown', e => {
    if (!active) return;
    if (e.key === 'Escape') { e.preventDefault(); exit(); return; }
    keyboard = true;
    reveal();
  }, true);
  mobile.addEventListener('change', reveal);
  window.addEventListener('resize', viewport);
  window.visualViewport?.addEventListener('resize', viewport);
  window.visualViewport?.addEventListener('scroll', viewport);
  window.addEventListener('popstate', exit);
  window.addEventListener('pagehide', exit);
  return { exit };
}
