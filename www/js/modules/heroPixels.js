// heroPixels.js — animated pixel-sunset canvas for the hero.
// Coarse 8px cell grid, vertical sunset gradient with slowly undulating
// bands and a sparse twinkling pixel field.

const CELL = 8;
const FRAME_MS = 1000 / 30;
const STOPS = [
  [0.0, [230, 54, 0]],    // #E63600
  [0.35, [250, 80, 12]],   // #FA500C
  [0.6, [255, 170, 0]],    // #FFAA00
  [0.85, [255, 216, 0]],   // #FFD800
  [1.0, [255, 244, 214]],  // #FFF4D6
];
const PALETTE_STEPS = 128;

export function createHeroPixels() {
  let canvas;
  let ctx;
  let hero;
  let cols = 0;
  let rows = 0;
  let palette = [];
  let running = false;
  let rafId = 0;
  let lastFrame = 0;
  let resizeTimer = 0;
  let heroVisible = true;

  function buildPalette() {
    palette = [];
    for (let i = 0; i < PALETTE_STEPS; i += 1) {
      const f = i / (PALETTE_STEPS - 1);
      let lo = STOPS[0];
      let hi = STOPS[STOPS.length - 1];
      for (let s = 0; s < STOPS.length - 1; s += 1) {
        if (f >= STOPS[s][0] && f <= STOPS[s + 1][0]) {
          lo = STOPS[s];
          hi = STOPS[s + 1];
          break;
        }
      }
      const span = hi[0] - lo[0] || 1;
      const t = (f - lo[0]) / span;
      const rgb = lo[1].map((c, k) => Math.round(c + (hi[1][k] - c) * t));
      palette.push(`rgb(${rgb[0]},${rgb[1]},${rgb[2]})`);
    }
  }

  function pickColor(rowFrac, col, time) {
    const drift = Math.sin(time * 0.6 + col * 0.02) * 0.035;
    const f = Math.min(0.999, Math.max(0, rowFrac + drift));
    return palette[Math.floor(f * (PALETTE_STEPS - 1))];
  }

  function draw(time) {
    for (let row = 0; row < rows; row += 1) {
      const rowFrac = row / Math.max(1, rows - 1);
      for (let col = 0; col < cols; col += 1) {
        ctx.fillStyle = pickColor(rowFrac, col, time);
        ctx.fillRect(col * CELL, row * CELL, CELL, CELL);
        if ((col * row) % 40 === 0) {
          const alpha = 0.1 + 0.25 * Math.sin(time * 2 + col * 7 + row * 13);
          ctx.fillStyle = `rgba(255, 244, 214, ${alpha.toFixed(3)})`;
          ctx.fillRect(col * CELL, row * CELL, CELL, CELL);
        }
      }
    }
  }

  function measure() {
    const rect = hero.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    canvas.width = Math.ceil(rect.width);
    canvas.height = Math.ceil(rect.height);
    cols = Math.ceil(rect.width / CELL);
    rows = Math.ceil(rect.height / CELL);
    return true;
  }

  function frame(now) {
    rafId = 0;
    if (!running) return;
    if (now - lastFrame >= FRAME_MS) {
      lastFrame = now;
      draw(now / 1000);
    }
    rafId = window.requestAnimationFrame(frame);
  }

  function startLoop() {
    if (running) return;
    running = true;
    rafId = window.requestAnimationFrame(frame);
  }

  function stopLoop() {
    running = false;
    if (rafId) {
      window.cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  function updateRunning() {
    const tabVisible = !document.hidden;
    if (tabVisible && heroVisible) {
      startLoop();
    } else {
      stopLoop();
    }
  }

  function onVisibility() {
    updateRunning();
  }

  function onResize() {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if (measure()) {
        draw(0);
      }
    }, 150);
  }

  return {
    init() {
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      canvas = document.getElementById('hero-canvas');
      if (!canvas || !canvas.getContext) return;
      ctx = canvas.getContext('2d');
      hero = canvas.parentElement;
      if (!ctx || !hero || !measure()) return;

      buildPalette();

      if (reduced) {
        draw(0);
        return;
      }

      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('resize', onResize);

      const observer = new IntersectionObserver((entries) => {
        heroVisible = entries[0].isIntersecting;
        updateRunning();
      }, { threshold: 0 });
      observer.observe(hero);

      updateRunning();
    },
  };
}
