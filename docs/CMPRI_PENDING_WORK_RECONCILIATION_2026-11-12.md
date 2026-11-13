# Pending work reconciliation

Review started November 12, 2026; verification completed November 13 UTC. Baseline: production/main `12c7a9e481dd83511a9b1becc0c02bdb92031d10`. Destination: draft [PR #37](https://github.com/pickeringscott/CMPRI-Engineering/pull/37), preview branch `preview/manual-reader-2026-11-12`. This reconciliation does not approve a main merge or production promotion.

## Release evidence

The retained deployment inventory contained 412 deployments across 66 preview branches. All 31 merged PR merge commits inspected were ancestors of production's current commit. A retained preview, an unmerged branch, and a Git ahead count are therefore not independent lists of features awaiting release. Some old branches contain superseded implementations and shared ancestors; copying their whole diff would replace newer application behavior.

The shared original checkout has no local-only commits. Implementation uses a separate checkout based on current main. The old checkout's earlier behind count described its position relative to main, not unpublished local work.

| Pending work | Resolution in PR #37 |
| --- | --- |
| PR #37 manual reader and source controls | Retained the current implementation, full-document reading/resume, continuous source pages, original PDFs, guide-only palette/spacing, browser preview checks, and existing System Admin controls. The approved artwork now has its correct dimensions before deferred scripts load. |
| PR #36 audit, `audit/troubleshooting-guide-2026-11-12` at `1c33e63` | Included its report with an explicit historical-baseline notice and links to implementation evidence. Its original findings remain reviewable. No application changes were hidden in this documentation branch. |
| PR #27 lint cleanup, `fix/lint-warnings` at `0fc828b` | Kept current callback stability, request-generation guards and scanner behavior already covering the old patch. Added the remaining precise lint exception for the asset's signed private photo URL. Full lint passes with zero warnings; no obsolete image or Rooms implementation was copied over newer code. |
| PM branch family ending at `release/pm-atomic-confirmation-20261101` at `cb9e7a6` | Restored recorded-inspection issue review, original source identities, existing PM ticket links, and atomic confirmation through the existing database function. Kept current task approval/review, active form definitions and schedules, current deficiency controls, authorization and ordinary ticket creation. No historical import scripts were run. |
| Staff Notes prototype, `preview/staff-notes-gif-20261104` at `68508a8` | Compared with the native Staff Notes implementation. Direct GIPHY Trending/search, 50-result pagination, GIF ID lookup after refresh, attribution, image proportions, reply names, attachments and real API persistence already exist. Retained the approved native UI. The prototype's sample notes and IndexedDB persistence were not imported into the application. Live provider availability was not tested. |
| Property operations prototype, `work` at `e5a0ee7` | Mapped Manage Locations to `src/app/management/rooms/page.tsx` and `/api/rooms`; Daily Room Operations to `src/app/engineering/room-operations/page.tsx` and `/api/room-operations`; work-order lists/editing to the existing native work-order routes/components. Kept these real-record implementations. The prototype's sample staff, local-storage CRUD and standalone navigation are not production release prerequisites. This does not claim pixel parity with the prototype. |
| PR #4 editor-crash triage and PR #2 old Actions investigation | Retained as historical investigations. Neither is a missing application release feature. Current verification and build are assessed directly on PR #37. |

Other retained preview deployment heads belong to merged releases or older side-branch lineages. Their existence alone does not establish an additional pending release. This report reconciles the identified pending behavior against current code; it does not assert complete historical UI parity across all 66 previews. No existing PR was closed or merged.

## PM difference and behavior

Older saved inspections use question IDs missing from the current active catalog. In particular, historical room answers use `room-pm-scan-*` IDs. Reading those answers with only current definitions silently omitted recorded follow-ups.

The preview adds a separate definition snapshot from the previously deployed PM lineage: 55 source templates, containing question definitions and IDs, with no operational inspection answers. The active catalog remains 46 templates. The resolver selects historical or current definitions from saved response identities. Mixed versions and overlapping source records are held for reconciliation rather than guessed or rewritten.

In **Preventive Maintenance → Maintenance History → Review issues from previous inspections**, the preview now:

- Reads all recorded years with pagination, independent of the selected week.
- Identifies explicit follow-ups and source-defined failure answers; an ordinary No, blank or unchecked answer does not automatically become a defect.
- Shows existing work-order links, including closed tickets, while retaining the original inspection result.
- Lets an authorized user select issues, supply a ticket description and location, and review the selection. Recorded rooms cannot be assigned to another room.
- Requires explicit final confirmation for ticket creation. Preview exposes the real account's capabilities and disables the final live-write action with an explanation.
- Uses the existing `cmpri_confirm_pm_work_order` database function for source validation and creation in one transaction. Exact retries reuse the source identity. A missing function or changed source never falls back to an ordinary insert. Partial successes stay linked for retry.
- Leaves inspection answers, completion, notes, proposal ownership/review rules and existing active-form deficiency controls intact. Opening an issue or a linked ticket does not save the inspection.

The confirmation migration `20261101214605_cmpri_atomic_pm_confirmation.sql` is already on main and was verified as applied. This reconciliation adds no migration, changes no grants and applies no DDL. Original PDFs, Front Desk Quick Guides, live sign-in behavior and production artwork remain unchanged by this reconciliation commit.

## Verification

Primary acceptance used authorized current Supabase exports, kept outside Git: 165 PM proposals, 1,197 room-history records, 168 locations and 31 existing PM work orders. No invented inspection, asset, user or ticket records were substituted for this acceptance check.

- Read/preparation resolved all saved template IDs, found 23 source records with identifiable issues, recognized 31 linked issues and 46 unlinked issues, and left the source snapshot unchanged. These are snapshot counts, not a diagnosis or an instruction to create 46 tickets.
- The actual route and applied confirmation SQL ran locally over those exports in an isolated PostgreSQL-compatible database. One ticket was created only in memory to verify confirmation and exact retry. Changed fingerprints, a source change during confirmation, a missing function and unauthorized function execution were rejected. No direct-insert fallback occurred; source records remained unchanged.
- Browser acceptance at 390 and 1440 pixels replayed the actual route responses with the actual System Admin identity. Review controls remained visible; existing links opened the corresponding ticket; final preview confirmation stayed disabled; focus returned after closing; no horizontal overflow or page errors occurred. External requests and live mutations were blocked.
- Full `npm test` passed, including existing database, purchase-order and release suites. The private-record acceptance is opt-in and was run separately; it skips in ordinary CI because private records are not committed.
- `npm run lint -- --max-warnings=0`, TypeScript, and the production build passed, including packaged PDF/OCR and compiled-reader checks. Hosted-preview and HTTP-smoke results are recorded in the PR after publication.

The browser transport replay and local database exercise do not establish live Google authentication or a live ticket creation lifecycle. Production records were not modified during this reconciliation. Earlier user-authorized manual approval updates and Saflok deletion remain documented in the [manual reader report](CMPRI_MANUAL_READER_PREVIEW_2026-11-12.md).

### Repeat the private-record acceptance

Keep the authorized export and output outside the repository. The acceptance envelope contains the actual `account`, `session`, `proposals`, `rooms`, `locations` and `links` arrays/objects. No Supabase credentials are required by these local checks.

```sh
CMPRI_PM_ACCEPTANCE_PATH=/private/acceptance.json \
CMPRI_PM_BROWSER_REPLAY_OUT=/private/browser-replay.json \
node --import ./tests/helpers/resolve-ts.mjs --experimental-strip-types --test tests/pm-reconciliation-records.test.mjs

CMPRI_PM_SESSION_PATH=/private/actual-session.json \
CMPRI_PM_BROWSER_REPLAY_PATH=/private/browser-replay.json \
CMPRI_PM_BROWSER_OUTPUT=/private/browser-results \
CMPRI_PM_BROWSER_URL=http://127.0.0.1:3118 \
python tests/browser/pm_recorded_issues.py
```

The browser check requires a local preview server, Python Playwright and Chromium at `/usr/bin/chromium`. Its session token is a local transport marker; all external requests and mutations are blocked.
