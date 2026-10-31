// nav.js — sticky nav solid state after scroll.
// Module pattern: factory returns a small public API; DOM work in init() only.

export function createNav() {
  const SCROLL_THRESHOLD = 24;

  let nav;

  function onScroll() {
    nav.classList.toggle('nav-solid', window.scrollY > SCROLL_THRESHOLD);
  }

  return {
    init() {
      nav = document.getElementById('site-nav');
      if (!nav) return;

      window.addEventListener('scroll', onScroll, { passive: true });
      onScroll();
    },
  };
}
