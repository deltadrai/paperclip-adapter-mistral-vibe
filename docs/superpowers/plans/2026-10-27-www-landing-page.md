# www Landing Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the static marketing page for `paperclip-adapter-mistral-vibe` under `www/`, mistral.ai-styled, deployed by GitHub Pages.

**Architecture:** One `index.html` page with Tailwind v4 Play CDN (inline `@theme` tokens) plus a small hand-written `site.css` for pixel styling. Pure ES6 modules under `js/`, each a factory `createX(ctx) -> { init() }`, wired by `js/main.js`. GSAP 3.13 via pinned jsDelivr ESM import map. Deployment: `.github/workflows/pages.yml` uploading `www/` with `actions/deploy-pages`.

**Tech Stack:** Static HTML, Tailwind CSS v4 (Play CDN), vanilla ES6 modules, GSAP 3.13 + ScrollTrigger, Canvas 2D, GitHub Actions Pages deployment.

**Spec:** `docs/superpowers/specs/2026-10-27-www-landing-page-design.md`

## Global Constraints

- Site root: `www/`; all asset, anchor, and badge URLs relative or absolute-https as pinned below (Pages serves at `https://deltadrai.github.io/paperclip-adapter-mistral-vibe/`).
- Palette: cream `#FAF9F5`, ink `#0A0A0A`, red `#E63600`, orange `#FA500C`, amber `#FFAA00`, yellow `#FFD800`, cream tint `#FFF4D6`.
- Fonts: Silkscreen (pixel accents), Inter (headings/body), monospace stack for code — all via Google Fonts.
- Tailwind Play CDN: `<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>`; theme via `<style type="text/tailwindcss">` block.
- GSAP import map: `gsap` → `https://cdn.jsdelivr.net/npm/gsap@3.13.0/+esm`, `gsap/ScrollTrigger` → `https://cdn.jsdelivr.net/npm/gsap@3.13.0/ScrollTrigger/+esm`.
- Badges (exact): star `https://img.shields.io/github/stars/deltadrai/paperclip-adapter-mistral-vibe?style=social`; npm version `https://img.shields.io/npm/v/paperclip-adapter-mistral-vibe`; license `https://img.shields.io/npm/l/paperclip-adapter-mistral-vibe`.
- Links (exact): repo `https://github.com/deltadrai/paperclip-adapter-mistral-vibe`; npm `https://www.npmjs.com/package/paperclip-adapter-mistral-vibe`; Paperclip `https://paperclip.ing`; Mistral Vibe `https://github.com/mistralai/mistral-vibe`.
- No-JS guarantee: static CSS never hides content (`opacity-0`/`translate` initial states are set only from JS via `gsap.set`/`gsap.from`).
- Reduced motion: `gsap.matchMedia()` + `prefers-reduced-motion: reduce` → no tweens, static hero frame.
- No framework, no bundler, no build step for `www/`; existing workflows (`ci.yml`, `publish.yml`) untouched.
- Every commit message ends with the Mistral Vibe co-author trailer (see existing commit style).

## Review Focus

1. **GSAP/CDN unavailable or JS disabled** — page must remain fully readable; all copy visible without JS. Pinned by Task 1 verification (content grep on raw HTML) and Task 5 rule that hidden states are JS-applied only.
2. **Pages sub-path** — any absolute-path asset (`/assets/...`) 404s under `.../paperclip-adapter-mistral-vibe/`. Pinned by Task 7 grep for `href="/` and `src="/` (must find none except protocol-relative/https).
3. **Narrow viewports** — nav must collapse to a toggle menu; hero canvas must resize without stretching. Pinned by Task 3 (menu toggle logic) and Task 4 (resize handler re-init) verification.
4. **Reduced motion** — users with `prefers-reduced-motion: reduce` must see a static page instantly, no scroll tweens, static canvas frame. Pinned by Task 5 matchMedia branch.
5. **Dead assets** — any badge/asset 404 ships a broken-looking page. Pinned by Task 7 curl sweep over every referenced URL.

---

### Task 1: Page skeleton — `www/index.html`

**Files:**
- Create: `www/index.html`
- Create: `www/assets/img/favicon.svg` (pixel M mark, 8x8-grid blocky "M", orange/amber/yellow blocks)
- Create: `www/assets/img/logo-pixel.svg` (same mark, scalable viewBox)
- Create: `www/robots.txt` (`User-agent: *\nAllow:`)
- Create: `www/js/main.js` (stub: logs nothing, imports nothing yet)

**Interfaces:**
- Produces: DOM contract consumed by later tasks — ids/attributes: `#site-nav`, `#nav-toggle`, `#mobile-menu`, `#hero-canvas`, `[data-reveal]` on every section and feature card, `[data-copy]` copy buttons with `data-copy="<code text>"`, `#footer-year`, `.sunset-stripe` on the stripe element, sections with ids `#features`, `#engines`, `#install`.
- Produces: `<head>` includes Tailwind Play CDN script, Google Fonts link (Silkscreen, Inter), `site.css`, import map for gsap, `<script type="module" src="js/main.js">`.

- [ ] **Step 1: Write `www/index.html`** with the six sections from the spec (nav, hero, features, engines, install, footer), all copy from the README's content condensed per spec. Hero badges row (three badges above, exact URLs), nav star badge, SEO/OG meta with canonical `https://deltadrai.github.io/paperclip-adapter-mistral-vibe/`. Engines section: two cards `acp` / `cli` covering process, approvals, sessions, usage, requirements. Install section: three steps with `<pre><code>` blocks (npm install name; `uv tool install mistral-vibe` + tarball alternative; agent config env `MISTRAL_API_KEY`) and copy buttons. Tailwind utility classes for layout/spacing; pixel styling via classes defined in Task 2 (`site.css`).
- [ ] **Step 2: Create the SVG assets and `robots.txt`; stub `js/main.js`** (empty async IIFE placeholder `/* wired in later tasks */`).
- [ ] **Step 3: Verify skeleton** — `python3 -m http.server 8080 -d www` then curl checks: `curl -s localhost:8080/` greps clean for `id="features"`, `id="engines"`, `id="install"`, `data-reveal`, `img.shields.io/npm/v/paperclip-adapter-mistral-vibe`, `paperclip.ing`; `curl -s -o /dev/null -w "%{http_code}" localhost:8080/assets/img/favicon.svg` → 200. Stop the server.
- [ ] **Step 4: Commit** `git add www && git commit` — "feat(www): page skeleton with sections, badges, meta".

### Task 2: Visual system — `www/assets/css/site.css`

**Files:**
- Create: `www/assets/css/site.css`
- Modify: `www/index.html` (only if a class name from Step 1 needs its pixel-style counterpart defined here — keep DOM as built)

**Interfaces:**
- Consumes: Tailwind Play CDN loaded in `<head>` (utility classes already in HTML from Task 1).
- Produces: CSS classes used by the HTML: `.pixel-font` (Silkscreen), `.pixel-divider` (stepped gradient band between sections: hard stops cream→yellow→amber→orange→red, `height: 8px`, coarse steps), `.sunset-stripe` (full-width closing band, same stops reversed to end in cream), `.btn-hard` / `.btn-hard-primary` (2px solid ink border, hard offset shadow `4px 4px 0 #0A0A0A`, orange fill for primary, cream for outline, hover: translate(-1px,-1px) + shadow 5px), `.card-hard` (2px ink border, hard shadow, cream card), `.code-hard` (ink background, cream text, monospace), `.badge-chip` wrap for shields images (block, 2px ink border, cream bg, pixel corners). Body base: `background #FAF9F5; color #0A0A0A; font Inter`. `image-rendering: pixelated` on `#hero-canvas`. Reduced-motion CSS: `@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }`.

- [ ] **Step 1: Write `site.css`** implementing the classes above with the Global Constraints palette values.
- [ ] **Step 2: Verify** — reload via `python3 -m http.server 8080 -d www`; curl the css (200), grep HTML for `site.css` link; browser check if available: pixel dividers render, buttons show hard shadows. Stop the server.
- [ ] **Step 3: Commit** — "feat(www): mistral pixel visual system in site.css".

### Task 3: Core modules — nav, install copy, footer

**Files:**
- Create: `www/js/modules/nav.js`, `www/js/modules/installCopy.js`, `www/js/modules/footer.js`
- Modify: `www/js/main.js` (wire the three modules)

**Interfaces:**
- Consumes: DOM contract from Task 1 (`#site-nav`, `#nav-toggle`, `#mobile-menu`, `[data-copy]`, `#footer-year`).
- Produces (module pattern, exact signatures): `createNav() -> { init() }`; `createInstallCopy() -> { init() }`; `createFooter() -> { init() }`. Each module file: one exported factory, no globals, DOM access only inside `init()`. `main.js` shape: `const modules = [createFooter(), createInstallCopy(), createNav()]; document.addEventListener('DOMContentLoaded', () => modules.forEach(m => m.init()));`

- [ ] **Step 1: Implement the three factories.** `nav.js`: toggles `.nav-solid` class on `#site-nav` via scroll listener (`window.scrollY > 24`); `#nav-toggle` click toggles `.open` on `#mobile-menu` and aria-expanded; menu link click closes. `installCopy.js`: event delegation on the install section; `navigator.clipboard.writeText(el.dataset.copy)` with `select()`+`execCommand` fallback; on success set button text "copied" for 1.5s (restore via data-attr original). `footer.js`: set `#footer-year` to `new Date().getFullYear()`.
- [ ] **Step 2: Syntax check** — local `node` is a broken shim in this environment (GLIBCXX errors, verified). Instead compile-check each module: strip `import`/`export` statements (sed), wrap in `new Function(src)` inside a `run_typescript` sandbox call — a `SyntaxError` fails the check; a clean compile passes. Apply to `nav.js`, `installCopy.js`, `footer.js`, and `main.js`.
- [ ] **Step 3: Verify behavior** — serve; browser/manual: scroll darkens nav, toggle opens menu, copy button flips to "copied", year correct. If no browser in environment, verify by reading the listeners are attached inside `init()` and DOM ids match Task 1 contract exactly.
- [ ] **Step 4: Commit** — "feat(www): nav, install-copy, footer modules".

### Task 4: Hero pixel-sunset canvas — `heroPixels.js`

**Files:**
- Create: `www/js/modules/heroPixels.js`
- Modify: `www/js/main.js` (add `createHeroPixels() -> { init() }` to the module list, before reveals)

**Interfaces:**
- Consumes: `#hero-canvas` sized to its hero parent (`canvas` CSS width 100%, height 100% of `position:relative` hero).
- Produces: `createHeroPixels() -> { init() }`; internal render loop with public-independent state; no ctx from main needed yet.

- [ ] **Step 1: Implement `heroPixels.js`.** Canvas 2D: logical grid of 8px cells (`Math.ceil(rect.width/8)` × `Math.ceil(rect.height/8)`); each cell filled from a vertical sunset gradient function `pickColor(rowFrac, time)` mapping 0→`#E63600`, 0.35→`#FA500C`, 0.6→`#FFAA00`, 0.85→`#FFD800`, 1→`#FFF4D6`, with per-column phase offset drifting (`time` in seconds, `col * 0.02` rad phase) so bands slowly undulate; sparse twinkle: ~1/40 cells drawn in cream tint at alpha `0.1 + 0.25*sin(time*2 + col*7 + row*13)` only where `((col*row)%40 === 0)`. rAF loop: draw at capped ~30fps (skip frames by timestamp); pause on `document.visibilitychange` hidden and IntersectionObserver hero-off-screen; `resize` listener re-measures grid (debounced). Reduced motion (matchMedia `(prefers-reduced-motion: reduce)`): draw one static frame at `time = 0`, no loop, no listeners. Zero-size or no 2d context → bail silently (CSS gradient fallback shows through).
- [ ] **Step 2: Module syntax check** — same sandbox `new Function` compile check as Task 3 Step 2 on `heroPixels.js`.
- [ ] **Step 3: Verify** — serve; browser/manual: hero shows animated pixel gradient; resize window → no stretching; devtools reduced-motion emulation → static frame. Absent browser: re-read against this task's numbers (grid cell size, palette stops) and the DOM contract.
- [ ] **Step 4: Commit** — "feat(www): animated pixel-sunset hero canvas".

### Task 5: GSAP animations — reveals, hero entrance, import map

**Files:**
- Create: `www/js/modules/reveals.js`
- Modify: `www/index.html` (add import map in `<head>` if not present from Task 1)
- Modify: `www/js/main.js` (import gsap + ScrollTrigger, build `ctx`, add reveals; gate ALL animation modules behind matchMedia)

**Interfaces:**
- Consumes: gsap 3.13 + ScrollTrigger from the import map (`import { gsap } from "gsap"; import { ScrollTrigger } from "gsap/ScrollTrigger";`), `[data-reveal]` elements, hero elements (`[data-hero]` on eyebrow, headline, subline, CTA row, badges row).
- Produces: `createReveals({ gsap, ScrollTrigger }) -> { init() }`; `main.js` exports nothing; shared `ctx` object passed to factories.

- [ ] **Step 1: Add import map** (exact URLs from Global Constraints) and `gsap.registerPlugin(ScrollTrigger)` in `main.js`.
- [ ] **Step 2: Implement `reveals.js`.** All inside `gsap.matchMedia()`: non-reduced branch — hero entrance timeline (`gsap.from('[data-hero]', { autoAlpha: 0, y: 24, duration: 0.7, ease: "power3.out", stagger: 0.12 })`); section reveals `gsap.utils.toArray('[data-reveal]').forEach(el => gsap.from(el, { scrollTrigger: { trigger: el, start: "top 85%", once: true }, autoAlpha: 0, y: 28, duration: 0.6, ease: "power2.out" }))`; feature-card stagger via `stagger: 0.08` on the cards within the features section (single ScrollTrigger on the grid). Reduced-motion branch: `gsap.set('[data-reveal], [data-hero]', { clearProps: "all" })` and return — nothing animated.
- [ ] **Step 3: Verify no-JS/reduced-motion safety** — serve; grep static HTML contains no `style="opacity:` or Tailwind `opacity-0` classes on content (Review Focus #1); browser/manual: hero staggers in, sections reveal on scroll, reduced-motion emulation → instant static page. Absent browser: verify `gsap.from` usage (from-visible default states) and matchMedia branch by re-read.
- [ ] **Step 4: Module syntax check** — sandbox `new Function` compile check (Task 3 Step 2 procedure) on `main.js` and `reveals.js`.
- [ ] **Step 5: Commit** — "feat(www): GSAP hero entrance and scroll reveals with reduced-motion gate".

### Task 6: GitHub Pages deployment — `.github/workflows/pages.yml`

**Files:**
- Create: `.github/workflows/pages.yml`

**Interfaces:**
- Produces: workflow `name: Deploy www to GitHub Pages`, on `push` branches `[main]` paths `["www/**", ".github/workflows/pages.yml"]` + `workflow_dispatch`; permissions `contents: read, pages: write, id-token: write`; single env `github-pages`; steps: checkout → `actions/upload-pages-artifact@v3` with `path: www` → `actions/deploy-pages@v4`. Header comment documents the one-time Settings → Pages → Source: GitHub Actions step.

- [ ] **Step 1: Write the workflow** with the exact values above.
- [ ] **Step 2: Verify** — `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/pages.yml'))"` → exit 0; `command -v actionlint && actionlint .github/workflows/pages.yml` if available.
- [ ] **Step 3: Commit** — "ci: deploy www/ to GitHub Pages via Actions".

### Task 7: Full verification sweep

**Files:**
- Modify: `www/index.html`, `www/js/*` only if the sweep finds defects.

- [ ] **Step 1: Asset sweep** — `python3 -m http.server 8080 -d www`; extract every `href`/`src` from `index.html`, curl each local path → all 200; curl each external badge URL (`-o /dev/null -w "%{http_code}"`) → all 200. Stop the server.
- [ ] **Step 2: Sub-path check** — grep `index.html` for `href="/` and `src="/` → no matches (Review Focus #2). Confirm canonical/OG URLs use the full Pages URL.
- [ ] **Step 3: Behavior pass** — serve from a nested mount to simulate the sub-path (`mkdir -p /tmp/pp/paperclip-adapter-mistral-vibe && cp -r www/* /tmp/pp/...`, serve `/tmp/pp`): fetch `/paperclip-adapter-mistral-vibe/` → 200, and one nested asset → 200. If a browser is available: full pass (nav, menu, copy, canvas, reveals, reduced motion, 360px width). Fix and re-run until clean.
- [ ] **Step 4: Final commit** (if fixes were needed) — "fix(www): verification sweep corrections".
