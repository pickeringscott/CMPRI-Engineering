# Staff Notes isolated preview

The current source implements GIPHY-only search directly from the browser. There are no GIF proxy routes or Tenor option. Search preserves provider result order and URLs, with visible GIPHY attribution. Selected GIFs save as canonical external-link metadata; provider media URLs are not persisted. Saved cards obtain current media directly from GIPHY.

## Real local persistence

The explicitly configured localhost backend stores notes and uploaded bytes in SQLite. Saving waits for actual upload and database responses. Failed saves retain drafts and uploaded attachments; retries are idempotent. Notes and media survive reload and database reopen. This synthetic test backend uses a fixed test author, not CMPRI roles or production authentication.

Use Node 24, `npm ci`, `npm test`, and `npm run build`. For local synthetic testing:

```
CMPRI_PREVIEW_LOCAL_DATA_DIR=/tmp/cmpri-staff-notes-test npm start -- --hostname 127.0.0.1 --port 3218
```

Without an explicit absolute local data directory, or on Vercel/non-local requests, saving fails closed. No production database client is used. Local uploads allow up to 100 MiB; GIF/PNG/JPEG/WebP and supported MP4/WebM codecs preview inline, other formats are download-only. Browser codec support and native keyboard GIF support vary. This local binary upload endpoint is not a Vercel hosted 100 MB upload solution.

## Remaining live blockers

- No existing GIPHY key was found in the Vercel project environment names. An approved browser web key must be supplied as `NEXT_PUBLIC_GIPHY_API_KEY` at build time. This key is intentionally browser-visible under GIPHY's direct-client design. No credentials were created or configured.
- No isolated hosted database/storage target was found. Only the known production Supabase project is available. It was not connected or written to. Hosted persistence, authorization, and direct large-file upload integration remain unimplemented pending an approved isolated target.
- This is not the complete Staff Notes / Daily Ops release. Front Desk identity, roles, replies, flags, mentions and work-order integration remain outside this picker implementation.

[GIPHY integration requirements](https://developers.giphy.com/docs/api/) require client-side API/media requests and provider attribution. Tenor was removed following Scott's explicit instruction.

## Verification

All 7 Node tests passed; clean production build passed without a key. Browser checks passed at 390×844, 320×568, 1280×900 and 844×390, including actual byte uploads/downloads, save failure/retry and page reload. Node tests cover direct GIPHY request construction/order, unsafe links, real SQLite save/upload/download, idempotent retry, reopen persistence, missing media, upload limits, and local isolation gates. Browser tests use synthetic GIPHY responses only and real local upload/save endpoints. No live GIPHY success is claimed. Run browser tests against a test-fixture build; never publish that build or its dummy key.

## Hosting status

This revision has not been deployed. Existing preview https://cmpri-engineering-r9d5eqyks-hawkeye-hotels.vercel.app/ remains the older browser-memory demonstration; it does not contain these changes or working live search/persistence. Do not present it as the requested complete test.

Reuse branch `preview/staff-notes-gif-20261104`. Root `vercel.json` disables automatic deployment for that branch. Only this subdirectory is the intended future preview payload. No production deployment, merge, production data change, access expansion, account creation or paid service was performed.
