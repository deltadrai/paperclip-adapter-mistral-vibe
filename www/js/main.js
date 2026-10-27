// main.js — ES module entry point; wires the site modules.
// Core modules are static imports (always run). GSAP is imported
// dynamically so a blocked animation CDN degrades gracefully.

import { createFooter } from './modules/footer.js';
import { createInstallCopy } from './modules/installCopy.js';
import { createNav } from './modules/nav.js';
import { createHeroPixels } from './modules/heroPixels.js';
import { createReveals } from './modules/reveals.js';

const modules = [createFooter(), createInstallCopy(), createNav(), createHeroPixels()];

document.addEventListener('DOMContentLoaded', async () => {
  modules.forEach((m) => m.init());

  try {
    const { gsap } = await import('gsap');
    const { ScrollTrigger } = await import('gsap/ScrollTrigger');
    gsap.registerPlugin(ScrollTrigger);
    createReveals({ gsap, ScrollTrigger }).init();
  } catch (err) {
    console.warn('main: GSAP unavailable, animations skipped', err);
  }
});
