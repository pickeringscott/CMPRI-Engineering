# Illinois versus Iowa football background

This folder holds the editable v9 artwork and game source. The shared seasonal
selection in `src/lib/ui/site-seasonal-theme.ts` activates `illinois-iowa` for
public sign-in and the signed-in desktop, including its `/front-desk` alias. `SiteSeasonalBackground.tsx`
registers the renderer; `FootballBackground.tsx` hosts its persistent iframe.

## Build and downloadable HTML

Run from the repository root:

```sh
npm run build:football
```

`scripts/build-football-background.mjs` reads:

- `index.template.html`: editable HTML, CSS, and animation code.
- `football-rules.js`: pure game rules, imported directly by the rules tests.
- `illinois-block-i-official.svg` and `iowa-hawkeye-official.svg`: team marks.
- `public/GiesOverheadView.jpg`: the supplied stadium photograph.
- `cache-worker.template.js`: the generated service worker's artwork allowlist.
- `src/lib/ui/site-palette.json`: the same authoritative palette used by sign-in and every modal.

The builder embeds the shared palette tokens and resolves canvas UI annotation
colors from that JSON, so the standalone document has no separate interface
palette. Changing the JSON and rebuilding updates both app and stadium colors.
Physical artwork, uniforms, and supplied team marks retain their source colors.
The builder injects the rules, compresses the photograph to WebP at quality 82
with Sharp, embeds all images as data URIs, and minifies the inline script with
Next's bundled Terser. It writes:

- `public/backgrounds/illinois-iowa/index.<content-hash>.html`: immutable entry.
- `public/backgrounds/illinois-iowa/index.html`: stable preview/download alias.
- `public/backgrounds/illinois-iowa/cache-worker.js`: versioned cache allowlist.
- `src/lib/ui/football-assets.json`: the host's generated entry and version.

The HTML is self-contained and can be downloaded and opened directly in a
browser. It does not need a server or network requests to run. Browser storage
is optional; storage failures leave the simulation usable. `predev` and
`prebuild` run the artwork builder automatically. Edit the source and rebuild
rather than editing generated HTML or the manifest.

Keep previously published hashed entries available for clients with older app
bundles. `node scripts/build-football-background.mjs --prune-unpublished` removes
other generated hashes only when preparing a first, unpublished change.

## Caching

There are two separate local caches:

1. The root `/sw.js` imports the generated football worker. Its cache version is
   the HTML content hash. It intercepts only GET requests for allowlisted hashed
   artwork, normalizes `?theme=1` to the same cache key, reuses unchanged files
   from existing caches, and removes only obsolete football caches. API requests,
   other application files, range requests, and non-GET requests pass through.
2. The HTML stores its rendered stadium/crowd/sideline scene as WebP in IndexedDB.
   Small animation metadata uses gzip when the browser supports it. The scene
   key includes a v9 source revision and the compressed photograph's digest.
   Change that source revision when changing baked crowd or sideline geometry.

`next.config.ts` sends `Cache-Control: no-cache` for `/sw.js`, the stable HTML
alias, and `cache-worker.js`; hashed football HTML receives a one-year immutable
header. Service workers require a supported secure origin; the downloaded file
already contains its assets and runs without one. No artwork cache stores or
requests application or database records. The local completed-game tally and
motion preference use localStorage.

## Runtime and mobile behavior

The simulation fills all 60,670 regular-capacity seats: 33,369 Illinois fans and
27,301 Iowa fans. Iowa fans cluster in the upper right and blend out on both
sides. Both sidelines contain reserves and support staff. Eleven players per
team run role-specific routes, blocking, coverage, pursuit, and tackles; punts
include a returner. Games use randomized play interactions and are resampled
until they have a winner and at least three lead changes. Halftime switches the
opening receiver, and clock-stopped two-minute warnings appear in quarters two
and four. The scorebug displays the simulated score and completed-play ticker.
Iowa is AP No. 15; Illinois has no rank label.

On the desktop dashboard, the game scoreboard follows the title bar at its
lower-right edge, with a four-pixel gap and eight-pixel right margin. The local
win/loss tally sits four pixels below the measured scoreboard and aligns with
its right edge. Both follow header reflow and resizing independently of the
stadium. Sign-in, standalone previews and compact/mobile layouts retain their
existing placement.

Low CPU mode is the default at up to 15 fps; Smooth mode uses up to 24 fps.
The static crowd and stationary sideline figures are baked into the scene.
Motion uses cached sprites, display-sized canvases, changed-area redraws, and
reused frame storage. Game preparation yields between short batches. Animation
and preparation suspend when the document is hidden, the scene is offscreen,
or the host hides the artwork route. Reduced-motion devices start paused.

Mobile portrait layout rotates only `.field-surface`, so the field runs up and
down while the scorebug stays upright and fixed at the bottom of the screen.
The host Pause/Resume button moves above the scorebug. Standalone controls
include Pause, Next play, New game, speed, motion quality, and Theme view.
Keyboard shortcuts are Space to pause/resume, N for next play, and Escape to
leave Theme view.

The host loads the hashed entry with `?theme=1`. This adds the embedded ambient
layout, hides standalone exit controls, and starts host-suspended until its
visibility is known. Same-origin messages provide the control contract:

```js
// Host to iframe:
{ type: "cmpri-football-control", action: "suspend", suspended: true }
{ type: "cmpri-football-control", action: "toggle" }
{ type: "cmpri-football-control", action: "request-state" }

// Iframe to host:
{ type: "cmpri-football-state", paused: true, ready: false, painted: false }
```

Both sides check the message origin and source window. Suspension preserves the
user's paused state. The host control stays disabled until preparation finishes. A separate
`painted` flag reveals the static stadium as soon as it is drawn.
All interface colors come from `src/lib/ui/site-palette.json`: desktop/sign-in,
modal accents and special schemes, semantic statuses, controls, selections, and
charts use Illinois orange and Iowa gold over black/charcoal. Generated utility
ramps cover Tailwind classes in every route and embedded modal.
`src/app/football-theme.css` applies the palette before hydration, keeps the
artwork visible during delayed sign-in authorization, and fades the already
painted stadium in without waiting for the full game to prepare.

## Verification

```sh
npm run test:football-theme
npm run typecheck
npm run build
python tests/browser/football_background.py
# With a local app running and synthetic API fixtures:
CMPRI_UI_BASE=http://localhost:3120 python tests/browser/football_theme_app.py
CMPRI_UI_BASE=http://localhost:3120 python tests/browser/signin_dashboard_transition.py
CMPRI_UI_BASE=http://localhost:3120 python tests/browser/football_palette_modals.py
```

`tests/football-theme.test.mjs` checks the self-contained generated artifact,
content hash, worker cache reuse, query normalization, request isolation, and
cache-write failure handling. `tests/football-rules.test.mjs` checks game rules,
warnings, halftime possession, and randomized complete-game results. The browser
regressions exercise real game controls and the shared sign-in/desktop host at
desktop and phone sizes, using only loopback files and synthetic API responses.

In a browser, verify standalone and embedded layouts at desktop and mobile
sizes; full stadium coverage; the dashboard scoreboard anchored below the
title bar, bottom-center placement on sign-in/standalone/mobile, and play
ticker; local tally after a completed game; Pause/Resume and keyboard controls;
reduced motion; route/tab/offscreen suspension; and an offline revisit after
the hosted service worker has cached the entry. Inspect `window.cmpriTheme`
for current attendance, sideline roles, game state, cache status, and rendering
metrics while testing.
