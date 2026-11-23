# Ask CMPRI: module coverage and Preview audit

Date: November 23, 2026 (America/Chicago)

Repository: `pickeringscott/CMPRI-Engineering`

Branch: `codex/ask-cmpri-preview`

Pull request: [#61](https://github.com/pickeringscott/CMPRI-Engineering/pull/61)

## Release assessment

**The deployed Preview does not yet meet the requested coverage.** It is running `9cd7a050dc16f238eedf24935f0e041679cf6621`. The broader native integration in local commit `0ca0ab2` and the additional corrections described below have not been pushed or deployed. PR #61 remains an open draft.

All fifteen explicitly requested modules are included in the local integration. Room Ranker, Daily Room Ops, and Airport remain included from the earlier requirements. Coverage means access to the module's existing data and supported actions through its native authorization and validation. It does not invent editing actions for modules that only publish reference data.

Merge readiness still requires a Preview built from the final local code and signed-in verification of its new flows. Read-only review of the older deployment cannot establish that the newer code works in a deployed environment.

## Audit evidence and scope

Reviewed:

- Every user requirement visible in this conversation, including role-only access boundaries, Bonvoy queries, PM planning, imports, inventory, assets, vendor documents, troubleshooting, Room Ranker, Weather, and Airport.
- The complete recovered **Pasted text.md** handoff audit, created November 23 at 01:08 UTC, and recovered prior user instructions.
- PR #61 metadata, current main, local implementation, native route contracts, permission helpers, and tests.
- The actual signed-in Chrome Preview dashboard, Ask, Weather, and Airport.

The recovered file is a prior audit, not the complete original transcript. The complete original conversation and its approved standalone HTML were not available in this checkout. Findings below distinguish current observations, code evidence, automated checks, and remaining device verification.

**Deployment examined:** [CMPRI Preview](https://cmpri-engineering-git-codex-ask-cmpri-preview-hawkeye-hotels.vercel.app/engineering)

**Deployment ID:** `dpl_H83oT2DAtpfGEoczD95ea1FCd9e2`

**Preview commit:** `9cd7a050dc16f238eedf24935f0e041679cf6621`

**Main examined:** `bf46accd535dd26ceab61f5d54f943e9c06b6622`

Main is an ancestor of the local feature branch, and the merge-tree check was clean. This establishes repository compatibility, not application readiness.

## Findings on the deployed Preview

### Missing Weather widget

The desktop utility required both a viewport at least 701 pixels wide and a primary hover-capable input. Chrome reported a **1920 × 950** viewport with **no hover capability** and a **coarse pointer**. That condition prevented the widget from mounting even on this desktop-sized display.

Its original fixed position was also `left:1198px; top:653px`, which could place it outside smaller desktop windows.

Local correction:

- Show the desktop widget at widths of at least 701 pixels, including touch-capable desktops.
- Clamp its position to the viewport while retaining the intended position when space permits.
- Keep its existing Weather launch and native dashboard admission behavior.

Mounted tests cover touch desktop, 1024-pixel width, the 700/701 boundary, resize, click, and role-based omission. Actual pixel placement of the new code has not been checked in deployed Chrome because that code is not deployed.

### PM year-end planning

A real read-only Preview query asked how many PMs must be completed per day by year-end. Preview answered **“Daily PM Rate Calculation Unavailable”** and displayed work-order records. This reproduces the wrong-source problem rather than a missing API-key problem.

The local implementation calculates the requested rate from authorized saved PM records and the actual PM schedule. Its direct year-end path does not require the language planner to discover the correct source.

### Ask opening and voice controls

Preview reopened Ask on History after its saved state loaded. Search still displayed the sample question. The new Gemini voice picker was absent. Local code opens ordinary sessions on Search, removes the sample from Search, and attaches the Gemini voice selector to the empty input.

### Weather and Airport data

The full Weather module opened and loaded actual conditions, forecasts, and radar controls. The Airport section loaded a flight board and nearby aircraft. It explicitly marked the board **last known / unverified** and the reference layout **partial**, with taxiways and aprons unavailable. Those provider states must remain visible in answers.

The prior handoff's claim that Preview lacked a Gemini key is obsolete: Preview configuration contains the key, and the read-only Ask query produced a model response. Key values were not exposed.

## Required module coverage

The shared implementation is [the native operation catalog](../src/lib/server/ask-cmpri-native-catalog.ts). Each operation delegates with the current signed-in bearer to its native handler. Confirmation rechecks current permissions; it does not grant a role or preserve an old privilege.

| Module | Information available | Supported actions and permission boundary |
|---|---|---|
| **1. Work Order List** | Native lists, exact tickets, revisions, notes/activity, references, attachments, parts and labor data | Native create/edit/status/priority/close/reopen/cancel, append-only notes, attachments, drafts and imports. Existing record/field capabilities, property scope, revision checks and attribution apply. |
| **2. Preventive Maintenance** | Actual saved weeks, tasks, review states, recorded issues, templates, year-end pace, native workbook and weekly CSV | Native task/form changes, submission and review. `view_pm`, engineering edit permissions and native reviewer policy remain authoritative. Ask CSV exports saved records; unsaved browser forms and queued changes are excluded explicitly. |
| **3. Staff Notes** | Authorized inbox, exact notes/threads, recipient/read state, identities and original attachments | Native post/reply/read controls and attachment workflows. Current actor, property, shared-login attribution, recipients and linked work-order visibility are checked by the original handlers. |
| **4. Notes** | The current account's saved note index and exact full documents | Native create/save/delete plus partial updates and exact append text. The adapter preserves omitted drawings, mentions, styles and settings on the server, then uses native ownership, revision and change-ID validation. |
| **5. Candidate Questionnaire** | Native department-filtered application list, questionnaire details and the actual full résumé PDF | The native screen is a review surface. Its exact reviewer identity/department policy applies. There is no native hiring/editing workflow to invent. Stored résumé redirects now resolve through authorized, constrained original-file retrieval. |
| **6. Pool Log** | Facility state, current/history readings, checks, supplies and the official monthly PDF | Native log and status actions with `view_pool_log` / `operate_pool_log`, saved-entry rules, retest requirements, revisions and closure readback. Existing pool workflow rules are included in operation contracts. |
| **7. Weather** | Current conditions, history, forecast, alerts, astronomy, map products and radar imagery | Native published sources are read-only. Dashboard visibility uses the existing Weather admission rule. Local map toggles, playback and zoom remain browser presentation controls. |
| **8. Winter Preparedness 2026** | Native checklist definitions and actual saved item state | Native item updates with current actor/property admission and per-item revision validation. Existing reader/editor distinctions remain. |
| **9. PO** | Purchase orders, packages/items, receiving/linking state, purchasing history and actual original-file review | Native purchasing and receiving operations, reviewed imports, release flags, permissions, quantities and revisions. Physical receipt or count observations cannot be invented. |
| **10. Inventory** | Complete authorized catalog/stock fields, vendors, compatibility, reserved/available quantities, history and order ideas | Native catalog/vendor/item changes, stock adjustments/returns, parts and actual supply-use actions. Existing `manage_assets` and module-read policies apply; history paging and units are preserved. |
| **11. Assets** | Native assets, physical identity, location, photos, manuals, source text, verification and troubleshooting | Native creation/update/retirement, moves, original document import/review/verification and troubleshooting actions. Existing equipment/document access, revisions and physical applicability rules apply. Moving an asset retains its documents/history. |
| **12. Manage Users** | Accounts and assignable roles returned for the current manager | Native create/invite and permitted name/primary-role/active changes. Target hierarchy, self/equal/higher-role restrictions, property scope and shared-account rules remain. Native-disabled deletion and unsupported email/password/secondary-role edits are not added. |
| **13. Feedback** | Feedback visible to the current reviewer | Native submit, review and delete with `submit_feedback` versus `review_feedback`. The originating browser screen is not automatically supplied unless explicitly included. |
| **14. Hours Tracker** | The account owner's saved periods, configuration and leave | Native owner-scoped saves and supported clock actions. Active identity/property, Hours access policy and existing clock release/owner restrictions remain. Worked time and payroll values must come from actual records or user input. |
| **15. Manage Profile** | Current account preferences, schedules, dashboard layout, notification API state and AI connection state | Native self-profile/preferences/layout and supported notification/connection actions. Confirmed preference readback and layout invalidation update the UI. Browser subscription permissions and OAuth setup require the existing device UI. |
| **Room Ranker** | Actual room A/B/C rank and underlying ticket reasons, including complete aggregates and exact links | Rank is derived. Requested changes use authorized underlying work-order actions and a fresh ranker read. There is no independent native rank setter. |
| **Daily Room Ops** | Rooms, current/incoming guests and Bonvoy tiers, availability, checkout information, OOO and movement data | Native updates and CSV/Drive validation/import, with current read/edit permission and the full same-source preview/commit/readback rules. Unknown tier stays unknown; current and incoming stays remain separate. |
| **Airport** | Actual KCMI flight board, nearby aircraft and reference airport geometry | Native sources are read-only. Answers retain source timestamps, stale/partial/unavailable states, actual geometry coverage and the distinction between nearby aircraft and published arrivals/departures. |

The supporting GSS tools distinguish dated, verified scorecard/ranking transcriptions (`gss.verified_reports`) from the separately fetched latest source (`gss.read`). A verified transcription must retain its source date; it is not automatically the newest available report.

Supporting native permission sources include [work orders](../src/app/api/work-orders/route.ts), [PM](../src/app/api/preventive-maintenance/route.ts), [Staff Notes](../src/app/api/staff-notes/route.ts), [Notes](../src/app/api/notes/route.ts), [employment](../src/app/api/employment/route.ts), [Pool Log](../src/app/api/pool-log/route.ts), [assets](../src/app/api/assets/route.ts), [users](../src/app/api/users/route.ts), [feedback](../src/app/api/feedback/route.ts), [profile](../src/app/api/profile/route.ts), and the operations referenced by the catalog.

## Permission and execution design

Ask is an in-app CMPRI integration. The browser authenticates to CMPRI; the server uses the model to choose registered tools. It forwards the signed-in user's bearer to native handlers. It does not connect through the separate external ChatGPT/MCP write-scope interface.

- Fresh conversations go directly to the full native tool interface for both questions and requested changes. The old planner cannot reduce a new request to a fixed set of fields or silently omit an asset, due date or assignee.
- Signed historical result formatting and recognized signed legacy draft continuations remain supported. Untrusted, edited or cross-account context cannot authorize them.
- Operation names, route parameters and accepted query names come from the source-owned catalog. The model cannot choose arbitrary internal routes or replace the bearer.
- Record reads and native actions retain the same role, property, owner and field policy as the application.
- Change proposals bind actor, property, exact request and expiry. The confirmation path reruns native checks using the current session and uses atomic receipts for replay/recovery.
- Validation failures and provider errors remain failures. An HTTP 200 response containing an API error cannot become a successful answer; explicitly retained stale/partial data remains labeled.
- No live ticket, stock, asset, user, note, pool or other business records were changed during this audit.

Implementation: [Ask API](../src/app/api/ask-cmpri/route.ts), [native execution](../src/lib/server/ask-cmpri-native.ts), [native agent](../src/lib/server/ask-cmpri-native-agent.ts), [query engine](../src/lib/ask-cmpri/native-query.ts).

## File and document workflows corrected locally

Selected originals are private, account/property-bound and validated by actual size, MIME and SHA-256. Only explicitly selected originals are uploaded. Valid finalized references survive normal modal close, new search and History continuation for their original 24-hour lifetime. Unfinished uploads are aborted; expired references require reselection.

Full source readers cover PDF pages and OCR warnings, all XLSX sheets/cells/formulas with cached values, DOCX text, and complete supported text/JSON. The source readers do not execute formulas or embedded instructions. Supported image/audio originals are delivered as actual model media rather than being represented only by local OCR excerpts. Media delivery does not prove every detail was legible.

Native adapters cover:

- PO PDF review and purchasing-history review/import.
- Complete Daily Ops CSV validation/import and existing Drive flows.
- Historical work-order source validation/import with unchanged source evidence.
- Staff Notes original attachments.
- Selected original equipment-PDF import and full stored-PDF inspection.
- Candidate résumé original download and complete PDF inspection.
- Saved ticket and Staff Note attachment retrieval through the original record's native access check.
- Official Pool Log PDF and saved PM Weekly CSV.

Vendor-document flow keeps the original bytes through retrieval, device download, native asset upload and source-specific verification. A document's presence is not applicability evidence. Changed physical identity, incomplete pages, OCR gaps, unresolved serial restrictions or absent troubleshooting content remain explicit. The device download control performs the actual browser save; the server does not claim to have saved a file onto the user's device.

Large native replies now stream the same JSON contract in bounded UTF-8 chunks once the serialized response exceeds 4 MiB. This avoids Vercel's [4.5 MB buffered-response limit](https://vercel.com/docs/functions/limitations) without truncating an original download. Tests verify the original byte hash after normal client JSON parsing, multibyte boundaries, backpressure, cancellation, response status and private/no-store headers. The server still serializes the complete reply in memory; this is a transport correction, not a claim of unlimited file size.

## Reconciliation with the recovered handoff audit

| Recovered issue | Finding against current code / Preview |
|---|---|
| Room features, installed versus designated models | Native data access is broader. Installed identity must come from the actual linked asset. A designated model or amenity absent from native records remains unknown; training examples are not property data. |
| Restricted public equipment searches | The legacy fixed manufacturer/model/code rules were a remaining native-tool gap. The native search path now uses fresh authorized asset identity or explicitly supplied public equipment identifiers, without private guest/room/note/serial text in public queries. Fourteen targeted tests cover authorization, arbitrary public makes/models/error codes, identifier validation and actual retrieved sources. |
| Tables, short answers and follow-up links | Signed legacy formatting retains selected records and links. Native query projection preserves original row identity and exact record links while displaying requested fields. Counts/aggregates run before display pagination, subject to actual native source coverage. |
| Exact Staff Note and Personal Note links | Already present at `9cd7a05`; preserved. This is not claimed as a newly discovered fix. |
| Legacy Chief Engineer clarification behavior | Current recognition includes the established legacy identity. Required missing details are stated directly; values are not invented. |
| Spanish work orders, requested photos and saved-ticket context | Existing guided-flow regressions remain covered. The native flow preserves requested fields/attachments and can chain exact original attachments to the stable created ticket ID. |
| Modal sizing and focus | Current source retains the prior approved corrections. The original standalone approval HTML was unavailable for a fresh pixel-by-pixel comparison. Physical phone keyboard/focus behavior still needs device verification. |
| Editable pending text and call recap | Pending typed text retention was already present at `9cd7a05`; preserved. Current call/recap and draft controls remain in Ask. |
| Microphone feedback and playback timeout | Tooltip and timeout behavior exist. Local playback now uses authenticated Gemini TTS with the selected voice; it reports playback failures and leaves the text response available. Physical microphone/autoplay behavior remains unverified. |
| File selection, follow-ups and downloadable replies | Local code now retains signed originals for follow-ups, preserves exact downloads, and supports native reports/result exports. Selected-only upload and full-unmount History continuation are tested. |
| Dashboard Staff Notes destination | Current dashboard routing opens Ask on Staff Notes. Native Staff Notes remains embedded. |
| Beginner's Guide practice | Working isolated sample Ask/ticket practice is already present at `9cd7a05`; relevant implementation was unchanged in this phase. |
| Embedded work-order asset troubleshooting | Selected-asset guidance and per-step outcomes are already present at `9cd7a05`; native tools reuse actual troubleshooting and document policies. |
| Dashboard selection/animation | Existing destination focus, tab transitions and launcher telescope behavior are retained. New confirmed layout updates refresh mounted menus while respecting active gestures and pending local saves. |
| Weather dial visibility and source coverage | The reproduced desktop hover gate and identified offscreen-position risk were corrected locally. Weather/airport answers keep forecast/observation distinctions and incomplete/stale coverage. |

Previously deferred account-wide old Ask History and delivery into another person's Personal Notepad remain deferred. The earlier omission of manual import has been superseded by the user's explicit vendor-document and asset-document workflow requirements.

## Validation and remaining verification

Final local validation passed on the stable integration:

| Gate | Result | Scope |
|---|---|---|
| `npm run typecheck` | **Passed** | Full TypeScript check; the production build also completed its TypeScript check. |
| `npm run lint` | **Passed** | Full ESLint run, plus a clean targeted rerun after the final test-fixture correction. |
| `TZ=UTC npm test` | **Passed** | Node test runners reported **3,004 passed, 11 skipped, zero failures** across 3,015 cases. The included Ask suite passed **247/247** with no skips. |
| Database and purchasing scripts within `npm test` | **Passed** | **85** isolated PostgreSQL migration/behavior checks, all **27** portable PO test commands, and the release scripts completed successfully. These script results are additional to the Node test-runner totals. |
| `npm run build` and postbuild checks | **Passed** | Optimized production build, PDF extraction/rendering from traced runtimes, compiled manual reader, OCR recognition, and inclusion of the PM workbook and official Pool PDF template. Safe placeholder configuration was used. |
| `npm run test:http-smoke` | **Passed, 94/94** | Actual local production server: page responses, configuration failures and anonymous authorization denials. No real account or database was used. |

The first final Ask run exposed missing runtime dependencies in three test fixtures after integrating the response helper. The fixtures were corrected to load the actual helper; routing and authorization assertions were preserved. The affected suites passed 26/26, then the complete 247-test Ask suite and the full app suite passed.

The eleven skipped cases require optional authorized local manual/PDF fixtures or a local PM-record snapshot that was not supplied. They are not counted as passes. The isolated database checks do not reproduce deployed Supabase RLS or concurrent production sessions.

Automated evidence includes actual native-handler delegation with mocked identities/storage; denied and revoked roles; actor/property-bound confirmations and originals; tampering and replay; complete source inspection; real PDF generation; original byte hashes; native field preservation; table/record links; PM export parity; and mounted client continuation/layout behavior.

The earlier default-timezone run exposed two weather test failures that also reproduce unchanged on main under America/Chicago. The full suite is run with `TZ=UTC`, matching its existing expected date formatting. This is recorded as a test-environment dependency, not silently attributed to these changes.

Still requiring updated Preview/device verification:

1. Deploy the final local commit to Preview, then test actual signed-in model requests across representative allowed and denied roles.
2. Verify native confirmation and readback in explicitly authorized disposable test records. This audit performed no live business writes.
3. Check the new widget's actual pixel placement and interaction on desktop/touch devices.
4. Check physical microphone, camera/file/folder picker, autoplay, keyboard dismissal and push permission flows on the intended devices.

Operational boundaries remain explicit: saved data differs from unsaved browser drafts; native API caps need paging or coverage statements; handwriting in vector strokes is not transcribed merely by reading coordinates; unsupported/oversized media remains unavailable for model interpretation. Current orchestration has a request timeout, tool-step/output budgets and a maximum confirmation batch. These are practical processing boundaries, not extra role grants or proof of unlimited automation.

The Preview source observed here cannot be treated as the final implementation, and no push, Preview deployment, production deployment or merge was performed.
