// footer.js — set the footer year.

export function createFooter() {
  return {
    init() {
      const year = document.getElementById('footer-year');
      if (year) {
        year.textContent = String(new Date().getFullYear());
      }
    },
  };
}
