# Staff Notes GIF / Media preview

Isolated Next.js preview. Mock notes and local files exist only in browser memory. No CMPRI application imports, database clients, authentication sessions, production writes, upload endpoints, paid services or provider requests.

## Current limits (2026-11-04)

- GIPHY and Tenor API keys are absent from the existing project's environment-variable names. Values were not decrypted.
- [GIPHY's published integration rules](https://developers.giphy.com/docs/api/#prohibited-integration-practices) prohibit proxying API/media requests, caching media URLs, reordering results, and mixing providers in a grid. The requested architecture cannot be activated under these rules. Adding a key does not enable requests.
- [Google discontinued the Tenor API June 30, 2026](https://support.google.com/tenor/answer/10455265?hl=en); new clients were closed in January. The route returns HTTP 410.
- The browser queries the two local server routes concurrently. They return explicit blocked statuses; there are no public fake GIF results or silent provider substitutions.
- The masonry and attributed external-card interaction are tested with browser-intercepted synthetic fixtures only. No live combined-provider search is claimed.
- Media opens the native picker and previews selected files locally, up to 100 MiB per file. Browser-supported image/video codecs render; other files display their names. Nothing is uploaded, persisted, or shared. Native keyboard GIF behavior varies and is not verified.
- This is not the combined Staff Notes / Daily Ops release and must not be merged or promoted to production.

## Run

Use `npm ci`, `npm test`, `npm run build`, then `npm start`. Open `/`.

Only this subdirectory is the deployment payload; do not build the repository root. Deploy to the existing project's preview environment with project build settings scoped to this deployment. Do not modify project-wide settings or production aliases.

No account, credentials, terms acceptance, or plan upgrades have been created. Live search needs a separately approved provider/design compatible with its current service rules.

## Verification and hosting status

- `npm test`: 5 passing tests (URL safety, metadata/attribution, test-only result merging, provider blocks, actual route secret isolation).
- `npm run build`: passed; only `/`, `/api/gifs/giphy`, `/api/gifs/tenor` and the standard not-found route are built.
- Browser checks passed at 320×568, 390×844, 1280×900 and 844×390: equal popover halves, containment, unavailable-provider responses, local file chooser, in-memory posting/reset, and no horizontal overflow. A separately intercepted synthetic fixture verified masonry scrolling and attributed canonical-link selection. This is not a live provider test.
- Navy `#0b132b` / `#1c2541` follow the stated CMPRI palette; gold `#fbbf24` comes from the repository's `--cmpri-gold`.
- Initial external preview publication was denied by automatic approval review. Scott then explicitly approved the existing `cmpri-engineering` Vercel project under Hawkeye Hotels for preview-only publication. The single retry succeeded.
- Live preview: https://cmpri-engineering-r9d5eqyks-hawkeye-hotels.vercel.app/ — deployment `dpl_CnkGDAGF3upTfp7kxXNXtL3YGTcd`, source commit `274bf750854a1967201e0960f3a9aa1f58e86d6d`, target `null` (Vercel preview), state `READY`.
- Hosted checks via Vercel authenticated fetch: page HTTP 200; GIPHY route HTTP 503 with `NOT_CONFIGURED`; Tenor route HTTP 410 with `PROVIDER_RETIRED`. No provider results were substituted. Project password/SSO/IP protection is disabled. Direct browsing from this execution environment is blocked by its outbound network policy, so physical-phone access remains for Scott to verify.
- Existing production deployment `dpl_2kBRG9WP8vqTzPQpeK682XteBQde` retained its production alias. No promotion, main merge, database change, or production deployment was performed.
- Root `vercel.json` disables Git auto-deployment for this exact preview branch, preventing an accidental build of the full CMPRI application. Production and other branches are unaffected.
