# www Landing Page — Design Spec

Date: 2026-10-27
Status: Approved in chat (design as-is; Tailwind Play CDN; GSAP via CDN import map)

## Purpose

A single static marketing page advertising `paperclip-adapter-mistral-vibe` — the
Mistral Vibe (vibe-acp / vibe CLI) external adapter for Paperclip. The visitor should
understand within seconds what the adapter does, see the npm and GitHub badges, and be
able to follow the install steps. Look and feel: mistral.ai — cream surfaces, sunset
palette, signature closing sunset stripe, pixel-art accents. Tech: pure ES6 JavaScript
(module pattern), Tailwind CSS, GSAP animations. No JS build step; hosted on GitHub
Pages at `https://deltadrai.github.io/paperclip-adapter-mistral-vibe/`.

## Constraints (from the user, binding)

- Everything lives under `www/` (plus the Pages workflow under `.github/workflows/`).
- Pure ES6 JavaScript using the module pattern; no framework, no bundler, no globals.
- Tailwind CSS delivered via the Tailwind v4 Play CDN script (runtime compilation).
- GSAP delivered via a pinned-version import map to jsDelivr ESM.
- Pixel style as used by mistral.ai.
- Badges: npm package badge(s) and the widely used GitHub star badge.
- GitHub configs for static page deployment (GitHub Actions → Pages).
- No custom domain: project page at `deltadrai.github.io/paperclip-adapter-mistral-vibe/`.
  All asset/anchor URLs must be relative so the sub-path works.

## File tree

```
www/
├── index.html                 single page, all sections
├── robots.txt                 allow all, sitemap omitted (single page)
├── assets/
│   ├── css/site.css           pixel-art specifics, fonts, code blocks, fallbacks
│   └── img/
│       ├── favicon.svg        pixel M mark
│       ├── logo-pixel.svg     pixel M wordmark mark
│       └── (pixel dividers are CSS gradients with hard color stops, no SVG assets)
├── js/
│   ├── main.js                ES module entry; imports and wires modules
│   └── modules/
│       ├── nav.js             sticky nav state, mobile menu toggle
│       ├── heroPixels.js      animated pixel-sunset canvas (custom rAF)
│       ├── reveals.js         ScrollTrigger section/card reveals
│       ├── installCopy.js     copy-to-clipboard buttons on code blocks
│       └── footer.js          current year, nothing else
.github/workflows/pages.yml    deploy www/ on push to main
```

## Visual system

- Background cream `#FAF9F5`; ink near-black `#0A0A0A`.
- Sunset palette: red `#E63600`, orange `#FA500C`, amber `#FFAA00`, yellow `#FFD800`,
  cream tint `#FFF4D6`.
- Signature horizontal sunset stripe (red → orange → amber → yellow → cream) closes
  the page above the footer.
- Pixel style: blocky pixelated "M" logo mark (inline SVG on a small grid), stepped
  pixel gradient dividers between sections (CSS `linear-gradient` with hard stops at
  coarse steps), pixel-font accents (Silkscreen from Google Fonts) for section labels
  and small badges; clean sans (Inter, Google Fonts) for headings and body;
  monospace for code.
- `image-rendering: pixelated` on the canvas and any raster pixel art.
- Rounded corners minimal (mistral uses sharp blocks); buttons rectangular with
  2px solid ink borders, hard shadows.

## Page sections

1. **Nav (sticky).** Pixel logo + "Mistral Vibe for Paperclip" wordmark; links:
   Features, Engines, Install; right side: GitHub star badge
   (`https://img.shields.io/github/stars/deltadrai/paperclip-adapter-mistral-vibe?style=social`,
   linked to the repo). Background turns solid cream with bottom border after scroll.
   Mobile: hamburger toggling a dropdown panel.
2. **Hero.** Full-width animated pixel-sunset canvas background (see Animations);
   pixel-font eyebrow label "PAPERCLIP ADAPTER"; headline; one-line value proposition;
   CTA buttons: "View on GitHub" (primary, orange) and "npm package" (outline);
   badge row: npm version
   (`https://img.shields.io/npm/v/paperclip-adapter-mistral-vibe`), GitHub stars,
   MIT license (`https://img.shields.io/npm/l/paperclip-adapter-mistral-vibe`),
   each linked to its target.
3. **Features** (grid of six cards, pixel divider above):
   per-agent isolation (own `VIBE_HOME` + own API key); two execution engines
   (`acp` / `cli`); live model discovery (`listModels` / `refreshModels`);
   skills sync (Paperclip skill library → `$VIBE_HOME/skills/`); optional quota
   dashboard (`getQuotaWindows`, Enterprise-only note); thin by design (MIT,
   delegates to Paperclip's shared ACP engine).
4. **Engines comparison.** Two cards, `acp` vs `cli`: process model, interactive
   approvals, session resume, usage/cost source, extra requirements. Condensed from
   the README table.
5. **Install.** Three steps with copyable code blocks:
   1. Paperclip → Settings → Adapters → Install from npm →
      `paperclip-adapter-mistral-vibe`
   2. Get the runtime: `vibe-acp` binary (acp lane) or `uv tool install mistral-vibe`
      (cli lane); create a Mistral API key (console → Code › Vibe CLI)
   3. Add agent → Mistral Vibe → engine, model, env `MISTRAL_API_KEY` → Test
      environment
6. **Footer.** Sunset stripe; links: GitHub repo, npm package, Paperclip
   (https://paperclip.ing), Mistral Vibe (https://github.com/mistralai/mistral-vibe),
   MIT license; copyright line with current year.

## JS architecture

ES modules only (`<script type="importmap">` for GSAP, `<script type="module">` for
`js/main.js`). Module pattern: each module file exports a factory
`createX(ctx)` returning a small public API (`{ init() }` or similar); `main.js`
builds a shared `ctx` (gsap instance, selectors, config) and wires the modules in
order. No window globals; no DOM work before `DOMContentLoaded`.

Module responsibilities:

- `nav.js` — scroll-state class toggle; mobile menu open/close, close on link click.
- `heroPixels.js` — canvas sized to hero, coarse pixel grid (e.g. 8px cells),
  vertical sunset gradient with slowly drifting band offsets and a twinkling pixel
  field; rAF loop paused when tab hidden (`visibilitychange`) and when hero is off
  screen (IntersectionObserver). Honors reduced motion (renders one static frame).
- `reveals.js` — ScrollTrigger batch reveals for `[data-reveal]` elements and
  staggered feature cards.
- `installCopy.js` — event delegation on copy buttons; `navigator.clipboard.writeText`
  with fallback; transient "copied" state.
- `footer.js` — set current year.

## GSAP animations

- Import map pins `gsap` and `gsap/ScrollTrigger` to a fixed version
  (`gsap@3.13.0` via `https://cdn.jsdelivr.net/npm/gsap@3.13.0/+esm` and
  `.../gsap@3.13.0/ScrollTrigger/+esm`).
- Hero entrance timeline: eyebrow → headline lines → subline → CTAs → badges,
  autoAlpha + y, small staggers, ease `power3.out`.
- Section reveals: `gsap.utils.toArray('[data-reveal]')` with ScrollTrigger
  `start: "top 85%"`, `once: true`; feature cards staggered.
- Nav background change driven by a ScrollTrigger on the hero end.
- All animation setup runs inside `gsap.matchMedia()` with
  `(prefers-reduced-motion: reduce)` short-circuiting to `gsap.set` visible states
  (duration 0, no canvas animation loop).

## Badges and links (exact targets)

- Repo: `https://github.com/deltadrai/paperclip-adapter-mistral-vibe`
- npm: `https://www.npmjs.com/package/paperclip-adapter-mistral-vibe`
- Star badge: `https://img.shields.io/github/stars/deltadrai/paperclip-adapter-mistral-vibe?style=social`
- npm version badge: `https://img.shields.io/npm/v/paperclip-adapter-mistral-vibe`
- License badge: `https://img.shields.io/npm/l/paperclip-adapter-mistral-vibe`
- Paperclip: `https://paperclip.ing`; Mistral Vibe: `https://github.com/mistralai/mistral-vibe`

## Deployment

`.github/workflows/pages.yml`:

- Trigger: push to `main` with paths `www/**` and the workflow itself; plus
  `workflow_dispatch`.
- Permissions: `contents: read`, `pages: write`, `id-token: write`; environment
  `github-pages`.
- Steps: checkout → upload `www/` via `actions/upload-pages-artifact@v3`
  (path: `www`) → deploy via `actions/deploy-pages@v4`.
- One-time manual step (documented in the workflow header and README): repo
  Settings → Pages → Build and deployment → Source: **GitHub Actions**.

No other GitHub config is required; `ci.yml` and `publish.yml` stay untouched.

## SEO / meta

Title: "Mistral Vibe adapter for Paperclip". Meta description, Open Graph tags
(og:title, og:description, og:type=website, og:url), favicon, canonical URL
`https://deltadrai.github.io/paperclip-adapter-mistral-vibe/`.

## Error handling

- Clipboard API unavailable → button shows "press ⌘/Ctrl+C" fallback after a
  programmatic select; errors swallowed with a console warn.
- Canvas unsupported/zero-size → hero falls back to a static CSS gradient.
- GSAP CDN blocked → page is fully readable without JS: all content visible by
  default; animation modules add initial hidden states only when GSAP is present
  (`from()` patterns, so no-JS users never see hidden content).

## Testing / verification

Static site, no test framework added to repo CI. Verification steps:

1. Serve `www/` locally (python http.server), curl every referenced asset — no 404s.
2. Confirm badge URLs return 200.
3. Browser check: no console errors; hero animates; reveals fire on scroll; reduced
   motion (emulated) disables animation; mobile menu works at narrow widths.
4. Workflow YAML passes `actionlint` if available, else `python -c yaml.safe_load`.

## Out of scope

- Custom domain, analytics, sitemap.xml, multiple pages, JS test suite,
  changes to the adapter code or existing workflows.
