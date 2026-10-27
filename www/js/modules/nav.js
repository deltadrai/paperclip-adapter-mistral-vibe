// nav.js — sticky nav state and mobile menu toggle.
// Module pattern: factory returns a small public API; DOM work in init() only.

export function createNav() {
  const SCROLL_THRESHOLD = 24;

  let nav;
  let toggle;
  let menu;

  function onScroll() {
    nav.classList.toggle('nav-solid', window.scrollY > SCROLL_THRESHOLD);
  }

  function closeMenu() {
    menu.classList.remove('open');
    menu.classList.add('hidden');
    toggle.setAttribute('aria-expanded', 'false');
  }

  function onToggle() {
    const open = menu.classList.toggle('open');
    menu.classList.toggle('hidden', !open);
    toggle.setAttribute('aria-expanded', String(open));
  }

  return {
    init() {
      nav = document.getElementById('site-nav');
      toggle = document.getElementById('nav-toggle');
      menu = document.getElementById('mobile-menu');
      if (!nav || !toggle || !menu) return;

      window.addEventListener('scroll', onScroll, { passive: true });
      toggle.addEventListener('click', onToggle);
      menu.querySelectorAll('a').forEach((link) => link.addEventListener('click', closeMenu));
      onScroll();
    },
  };
}
