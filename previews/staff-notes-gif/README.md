# Existing Staff Notes preview — supplied HTML integration

Source: `preview/staff-notes-gif-20261104`, `previews/staff-notes-gif`.
The existing preview's `lib/cards.mjs` browser-direct GIPHY integration is retained and extended with Trending and ID lookup transport. No GIPHY proxy is used.

`design-source/CMPRI-Notes-Modal-Desktop(6).html` and `design-source/CMPRI-Notes-Modal-Mobile(6).html` are the exact supplied HTML baselines retrieved from `CMPRI-Notes-Modal` on main. Original layout CSS and fixtures remain in those files. `scripts/build-designs.py` applies focused additions and emits `lib/designs.json`; the page renders the corresponding desktop/mobile design. Use `?layout=desktop` or `?layout=mobile` to explicitly choose a layout.

The added yellow Media popover has equal halves, a button-aligned pointer, keyboard focus, and press feedback. The picker requests Trending on opening and clearing search; searches preserve the typed query and provider order. Attribution remains visible at lower right and on selected GIFs. Closing the picker clears its transient results. A fresh request resolves stored GIF IDs after refresh; API responses, media URLs, and GIPHY assets are not written to browser storage.

New notes, replies and local attachment File objects persist in IndexedDB `cmpri-staff-notes-preview`. Posts wait for a successful transaction before clearing the draft. Storage failures retain drafts and show an error. Existing fixtures and browser data are not cleared. Existing localhost SQLite API routes and their tests remain intact, but this UI now uses browser persistence and requires no hosted backend. Sample staff and notes are labeled fictional in the original preview help.

Set the approved `NEXT_PUBLIC_GIPHY_API_KEY` locally or in the existing preview configuration. It is intentionally browser-visible for direct client requests, is injected at response time, and is absent from the committed design templates. No mock response is enabled in this preview.

Commands: `npm run dev`, `npm test`, `npm run build`. Design generation requires Python 3. In a restricted coding filesystem, set `NEXT_TELEMETRY_DISABLED=1` to avoid Next's user configuration write.

Verified in Chromium at 1440×1000 and 393×852: local media selection/preview, note and reply posting, viewer reopening, refresh persistence, visible picker attribution, no script errors, and popover bounds/equal halves (61 px each). The seven existing Node tests and the added Trending/search/ID transport test pass. Live GIPHY requests remain blocked by this task's network policy; initial GIF results, successful search/clear-to-Trending results, and selecting/posting/restoring real GIFs are not verified. These checks do not establish GIPHY review approval.

No deployment, production change, new environment, or paid resource was made for this integration.
