# Shared seasonal theme updates

The public sign-in page and signed-in desktop share the active selection in
`src/lib/ui/site-seasonal-theme.ts`, the artwork renderer in
`src/components/desktop/SiteSeasonalBackground.tsx`, and all shared interface colors in
`src/lib/ui/site-palette.json`. Sign-in surfaces use those palette variables in
`src/app/sign-in-theme.css`; they do not have a separate seasonal color set.

Illinois versus Iowa (`illinois-iowa`) is active. The shared registry retains the
Thanksgiving renderer. Christmas remains in scope for a later release.

## Illinois versus Iowa

- `FootballBackground.tsx` keeps one iframe mounted while moving between the
  public sign-in page, `/engineering`, and its `/front-desk` desktop alias. Other
  routes and hidden documents
  suspend the simulation and its preparation work. A shared Pause/Resume button
  controls the iframe through messages validated against its source and origin.
  A separate painted-state message reveals the stadium with a short fade while
  game preparation continues; routing and delayed authorization preserve the
  same iframe. Browser/PWA chrome shares the black palette base.
- The editable source is
  `src/components/desktop/football/index.template.html`, with its tested game
  rules in `football-rules.js`. `npm run build:football` embeds the supplied
  `public/GiesOverheadView.jpg` as compressed WebP, embeds both SVG team marks,
  and minifies the script. The output is a self-contained, downloadable HTML file.
  Both `predev` and `prebuild` generate the artwork.
- The stadium contains 60,670 fans: 33,369 Illinois and 27,301 Iowa. Iowa fans
  cluster in the upper right and blend outward through neighboring sections.
  Both sidelines contain players and support staff. The bottom-center scorebug
  shows the simulated score and each completed play; Iowa has AP rank 15 and
  Illinois has no rank label. The completed-game win/loss tally stays local.
- Mobile portrait layout rotates the field artwork so play runs up and down.
  The scorebug remains upright at the bottom of the screen. The host animation
  control sits above it.
- Low CPU mode is the default, drawing motion at up to 15 fps. The crowd and
  stationary sidelines are baked into a cached scene; Smooth mode raises motion
  to 24 fps and adds a small number of moving staff and fans. Hidden or offscreen
  artwork stops animation, and reduced-motion devices begin paused.
- A content hash versions the generated HTML and worker allowlist. HTTP headers
  revalidate the stable HTML alias and worker while hashed HTML is immutable.
  The root service worker caches only the generated artwork allowlist; it reuses
  unchanged files locally and leaves application/API requests alone. IndexedDB
  stores the rendered WebP scene and compressed metadata when available. These
  caches do not fetch or store database data.
- The complete JSON palette uses Illinois orange and Iowa gold over black and
  charcoal: desktop, six modal accents, Create/Detail/Hours special schemes,
  sign-out, status indicators, links, controls, charts, and selections. Generated
  utility-color ramps also theme Tailwind surfaces and states in every modal.
  `modalLauncherStyle` keeps launchers and their modal titles consistent. The
  server-rendered HTML declares the active theme before client hydration.

Run `npm run test:football-theme` for the generated HTML, cache-worker behavior,
and football rules. Check sign-in and `/engineering` in desktop and mobile
layouts, Pause/Resume, hidden-tab and route suspension, reduced motion, offline
revisits, halftime possession, and the second/fourth-quarter two-minute warnings.
Build details and the runtime contract are documented in
[`football/README.md`](../src/components/desktop/football/README.md).

## Christmas release scope

- Add the approved Christmas artwork renderer and asset cache to the shared
  background registry, then change the single active theme selection.
- Update the shared desktop palette and seasonal desktop chrome together.
- Keep home-page tab buttons connected to their destination modal's shared colors
  through `modalLauncherStyle`; seasonal chrome must not override those colors.
- Include the public sign-in page: normal Google sign-in, Remember me, expanded
  password access, validation/error messages, OAuth return and dashboard loading.
- Verify sign-in and desktop at desktop and mobile widths, short viewports,
  reduced motion, keyboard focus, and readable text over the animated background.
- Retain the existing sign-in and access-control behavior and test role-specific
  destinations after Google/password authentication.
- Version and deploy cached seasonal assets with the theme change so returning
  devices receive the new files while unchanged assets remain local.
