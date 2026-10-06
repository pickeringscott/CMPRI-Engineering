# Local application audit report — 2026-10-02

## Summary

This report records the audit, remediation, and local role-based end-to-end testing. A corrective RLS migration, environment-driven Supabase configuration, route regression coverage, and an asset-creation fix were added. All authenticated workflow tests used a disposable local Supabase stack; no hosted database, production account, or actual mailbox was used.

The corrective RLS migrations were subsequently applied to a uniquely named Docker-backed local Supabase project and exercised through its real Auth and REST APIs. They have not been applied to or verified against a hosted database. Disposable role accounts and fixtures were removed after the local tests. Earlier browser-driven Engineer workflows remain evidence only for the specific flows they exercised; this is not proof that every control, option, and workflow was tested.

Static security review found two high-severity RLS authorization risks in the checked-in baseline; whether that baseline or corrective migrations are applied to the live database is not verified. All eight implemented roles authenticated directly against the local stack. A narrowly scoped local concurrency test also verified duplicate work-order insertion from two independent sessions. The System Administrator's Room Ranker endpoint returned HTTP 503 because the third-party integration was not configured in the isolated environment; this is recorded as blocked, not passed.

## Findings

### 1. Authenticated users can read all profiles and work orders through direct Supabase requests

- **Severity:** High
- **Confidence:** 9/10
- **Affected code:** [`supabase/migrations/20260930180000_cmpri_prod_baseline.sql`](../supabase/migrations/20260930180000_cmpri_prod_baseline.sql), lines 3640, 3648, 4611, 4694
- **Reproduction (not executed):**
  1. Authenticate as a valid low-privilege Supabase user.
  2. Use the project publishable key and that user's bearer token to request `/rest/v1/profiles?select=*`.
  3. Repeat with `/rest/v1/work_orders?select=*`.
- **Impact:** The `SELECT` policies use `USING (true)` for the `authenticated` role. If deployed, an authenticated account can bypass application/API checks and read profile details (including roles and preferences) and work-order details, potentially across properties.
- **Recommended fix:** Replace unrestricted policies with least-privilege row-level policies requiring the intended active membership and capability; limit profile reads to the user's own row unless broader access is required. Reassess/revoke broad table grants.
- **Remediation status:** [`20261002214500_cmpri_rls_least_privilege.sql`](../supabase/migrations/20261002214500_cmpri_rls_least_privilege.sql) restricts profile reads to the authenticated user's own profile and work-order reads to the submitter or an active dashboard-capable property member.
- **Verification limit:** The migration's behavior passed the isolated PGlite regression suite. Live policies, grants, and migration state were not queried; the fix is not deployed.

### 2. Membership-only RLS policies permit direct writes beyond application capabilities

- **Severity:** High
- **Confidence:** 9/10
- **Affected code:** [`supabase/migrations/20260930180000_cmpri_prod_baseline.sql`](../supabase/migrations/20260930180000_cmpri_prod_baseline.sql), lines 3666, 3936, 3970, 4070, 4341, 4424, 4587, 4694; application checks include [`src/app/api/work-orders/[id]/route.ts`](../src/app/api/work-orders/%5Bid%5D/route.ts), lines 146–150, and [`src/app/api/pool-log/route.ts`](../src/app/api/pool-log/route.ts), lines 79–81
- **Reproduction (not executed):**
  1. Authenticate as a low-privilege active property member.
  2. Send a direct `PATCH` to `/rest/v1/pool_daily_logs` or `/rest/v1/work_orders`, or a `DELETE` to `/rest/v1/work_orders`.
  3. Compare direct database access with the corresponding application API role checks.
- **Impact:** The policies without an explicit `FOR` clause apply to all operations, while authorization is based on property membership rather than the relevant capability. If deployed with the broad `authenticated` grants, a member can bypass API checks and change or delete operational records, including work orders and pool logs.
- **Recommended fix:** Use operation-specific policies that enforce the intended role/capability as well as membership. Revoke direct write grants where practical; route sensitive mutations through database procedures that validate the actor from `auth.uid()`.
- **Remediation status:** The same corrective migration narrows membership policies to `SELECT`, removes direct anonymous/authenticated write grants from those tables, keeps work-order insertion capability-gated, and requires an active profile for property membership checks.
- **Verification limit:** The migration and regression assertions passed against isolated PGlite. No direct hosted API mutation was attempted; the deployed policy state is unknown.

### 3. Engineering dashboard data requests return HTTP 503

- **Severity:** Medium
- **Confidence:** 8/10 for the observed failure; cause unknown
- **Affected surface:** `http://localhost:3000/engineering`
- **Reproduction:** Open or reload the existing System Administrator engineering dashboard and inspect its page content and browser resource errors.
- **Observed result:** The shell and launcher menu render, but the dashboard's main content is empty apart from the application heading. The browser recorded repeated HTTP 503 resource failures.
- **Impact:** The dashboard's operational data is unavailable in the observed session. The failing endpoint/dependency and the persistence implications could not be determined from the available page evidence.
- **Recommended fix:** In an isolated local/test environment, identify the failing request and server-side cause; show a clear degraded/error state and verify recovery after the dependency is restored.
- **Verification limit:** The initial failure was observed in the pre-existing app on port 3000, which was not redirected to the disposable local database. The isolated app's Engineer dashboard and work-order creation workflow passed; the original 503 endpoint and cause remain unknown.

### 4. One automated test fails on a stale launcher-handler source assertion

- **Severity:** Low
- **Confidence:** 10/10
- **Affected code:** [`tests/modal-host.test.mjs`](../tests/modal-host.test.mjs), test “Engineering Dashboard screen-launch controls are real buttons that open desktop windows”; [`src/app/engineering/page.tsx`](../src/app/engineering/page.tsx), line 84
- **Reproduction:** Run `npm test`.
- **Observed result:** The test expects `onClick={(event) => { onLaunch(launcher, Date.now())`, but the current component uses `onClick={() => onLaunch(launcher, Date.now())`. The callback still invokes the launcher with the current time; the test's source-text pattern does not match that implementation.
- **Impact:** The assertion caused a false-negative in the automated suite; it did not demonstrate a broken launcher.
- **Recommended fix:** Align the test assertion with the intended callback contract, or restore the expected implementation shape if the event argument is required. Confirm intended behavior before changing either file.
- **Remediation status:** The assertion now matches the launcher callback; the focused test and full suite pass.

### 5. Equipment creation fails when optional manufacturer or serial number is omitted

- **Severity:** Medium
- **Confidence:** 10/10
- **Affected code:** [`src/app/api/assets/route.ts`](../src/app/api/assets/route.ts), `POST`; the database columns `assets.manufacturer` and `assets.serial_number` are non-null.
- **Reproduction:** As an authorized equipment editor, POST a valid `asset_type` and `location_id` to `/api/assets`, omitting `manufacturer` and `serial_number`.
- **Observed result:** The handler sent `null` for omitted values and PostgreSQL rejected the insert with a not-null constraint error, although the request fields are optional.
- **Impact:** A valid equipment creation fails when either optional value is omitted; no asset row is created.
- **Recommended fix:** Normalize omitted optional values to empty strings for the database's non-null text columns; preserve `null` for nullable fields.
- **Remediation status:** Fixed by persisting `""` for omitted manufacturer and serial number. Regression coverage verifies the accepted payload, inserted values, and success response.
- **Verification:** Focused asset route tests pass. The local E2E equipment-create check also passed with provided values.

### 6. Engineering dashboard shows launchers for roles whose APIs deny the corresponding actions

- **Severity:** Low
- **Confidence:** 9/10
- **Affected code:** [`src/app/engineering/page.tsx`](../src/app/engineering/page.tsx), launcher groups for Work Orders, Operations, Assets & Supply, and Admin.
- **Reproduction:** Sign in on the isolated local app as Senior Management or another role without the corresponding capability and open Engineering Dashboard.
- **Observed result:** Launchers such as Import Existing WOs, Pool Log, Daily Room Ops, GSS Reports, Enseo Assignments, Manage Equipment, Parts & Vendors, Purchasing & Email, Manage Rooms, and Manage Users are rendered without capability checks. In role probes, server/API authorization denied restricted operations; no API bypass was demonstrated.
- **Impact:** Users are offered actions that fail after navigation or submission, causing confusing and misleading affordances. The launcher visibility is not a substitute for API authorization; the tested API checks denied these restricted operations.
- **Recommended fix:** Gate each launcher on the same capability used by its destination and retain server-side authorization as the security boundary.

### 7. Malformed work-order IDs are reported as service failures

- **Severity:** Low
- **Confidence:** 10/10
- **Affected code:** [`src/app/api/work-orders/[id]/route.ts`](../src/app/api/work-orders/%5Bid%5D/route.ts), GET lookup around line 70; [`src/app/api/work-orders/[id]/activity/route.ts`](../src/app/api/work-orders/%5Bid%5D/activity/route.ts), work-order lookup.
- **Reproduction:** As an authorized role, request `/api/work-orders/test-id` (and the matching `/activity` path); compare with a syntactically valid but nonexistent UUID.
- **Observed result:** The malformed ID produces HTTP 503 (“Could not read work order” / activity verification failure), while a valid nonexistent UUID returns 404.
- **Impact:** Invalid client input is misclassified as a server/dependency outage, obscuring diagnostics and producing an inaccurate retry signal. No authorization bypass was observed.
- **Recommended fix:** Validate the path ID as a UUID before querying and return a client-error response for malformed IDs; preserve 404 for valid IDs with no matching row.

### 8. Repository production build fails Next.js page export validation

- **Severity:** Medium
- **Confidence:** 10/10
- **Affected code:** [`src/app/work-orders/page.tsx`](../src/app/work-orders/page.tsx), named helper exports around lines 590 and 635.
- **Reproduction:** Run `npm run build` from the repository root.
- **Observed result:** Next.js route type validation rejects the extra named exports `splitMaintenanceIssueClauses` and `detectMultipleCreateIssues` from the page module. The isolated temporary app copy built only after these exports were removed in that copy; the repository source was not changed during this audit.
- **Impact:** The checked-out source cannot pass the observed production build, blocking a reliable deploy from this state.
- **Recommended fix:** Move reusable helpers to a non-route module (or otherwise keep the page module's exports within the framework's supported route contract) and update their tests/imports.
- **Verification limit:** No source change or repository rebuild was made during this read-only audit.

## Expanded local role audit — additional evidence

- Eight synthetic local users authenticated: Engineer, Manager, Senior Management, Technician, Front Desk, Front Desk Manager, Housekeeping, and System Administrator. The disposable local Supabase stack and app copy were used; no production or hosted Supabase endpoint was queried.
- The authenticated GET matrix sent 248 requests (31 paths × 8 roles). Responses were 200: 80, 400: 20, 401: 25, 403: 98, 404: 5, 405: 8, and 503: 12. Most denials and method errors were expected role/method gates. Ten 503 responses came from intentionally malformed literal `test-id` work-order paths; two came from System Administrator Room Ranker and Corporate PM requests blocked by absent external integration settings.
- For one real, locally persisted work order, GET detail, activity, and attachment listing returned 200 to Engineer, Manager, Senior Management, Technician, and System Administrator, and 403 to Front Desk, Front Desk Manager, and Housekeeping. Technician access was tested on an unassigned test order only; assigned-order and cross-property cases remain unverified.
- An Engineer attachment upload returned success, was confirmed in the local storage bucket, appeared in the attachment listing, and was removed during cleanup. A `text/plain` upload was rejected with HTTP 400. The write path was not independently exercised under every permitted role or against oversized/malicious file content.
- Work-order create and draft lifecycle flows were exercised for submit-capable roles; draft create/update revision conflict/delete behavior was checked, and response success was matched to local database state. Equipment creation, pool-log access/write and unsafe-reading rejection, direct profile isolation/update denial, and role-specific work-order detail access were also exercised. Pool/log, asset, draft, and test work-order fixtures were cleaned from the disposable stack.
- Browser interactions included the Technician work-order form (room “See more…”, room/category/priority selection, notes, submit) and Front Desk form required-name validation and submit. Persisted database state matched the success messages for those submissions.
- Page-shell navigation was smoke-tested across 24 routes in partial role batches. HTTP 200 shells may render before client-side role checks/redirects complete; this is not full browser interaction coverage for every page and role.

## Verified pass list

- `npm run typecheck` — passed (`tsc --noEmit`).
- `npm run lint` — exited successfully with no errors; two existing Next.js `<img>` optimization warnings were reported in [`src/app/work-orders/[id]/page.tsx`](../src/app/work-orders/%5Bid%5D/page.tsx) at lines 1789 and 2257.
- `npm test` — 567/567 tests passed.
- `npm run test:database` — 40 PostgreSQL migration/behavior checks passed in a disposable PGlite instance, including the new RLS migration's idempotence, profile isolation, work-order visibility, direct-write denial, and submit-role checks.
- `npm run check:release-schema` — passed against the disposable local Supabase API; no production endpoint was queried.
- `npm run test:http-smoke` — 51/51 anonymous route/API checks passed. These checks do not cover authenticated workflows.
- Local role matrix — 80 assertions passed across Engineer, Manager, Senior Management, Technician, Front Desk, Front Desk Manager, Housekeeping, and System Administrator. Checks included login/session role and landing, capability flags, dashboard/technician/equipment/Room Ranker/notification access boundaries, direct profile row isolation and update denial, authorized work-order creation and denial, persisted creator attribution, and equipment write boundaries.
- Browser-driven Engineer workflow — signed in, opened Create Work Order, selected Room 409 and a category, submitted a unique work order, and verified its local database row and actor attribution.
- The isolated temporary app copy built and generated its routes after a temporary-copy-only removal of the two unsupported page helper exports. The repository-root build failure is documented in Finding 8.
- Focused equipment route tests — 45/45 passed, including the new not-null regression.
- The Engineer dashboard rendered launcher controls for work orders, imports, pool log, room operations, reports, Enseo, preventive maintenance, equipment, parts/vendors, purchasing/email, rooms, users, feedback, profile, ChatGPT connection, and sign-out.
- Local detail/activity/attachment read permissions matched the tested role matrix; valid attachment persistence/listing, invalid file-type rejection, malformed/nonexistent ID response behavior, and several create/update/delete workflows were verified against local database/storage state as described above.

## Not verified / blocked

- Exhaustive interaction with every button, checkbox, field, dropdown option, validation path, and workflow under every role. The role/API and page-shell checks are extensive but do not establish that every individual control or every role-specific UI workflow works.
- Exhaustive authenticated cross-property/cross-hotel CRUD and concurrent edit/transition behavior for every API. Docker checks covered work-order reads/inserts, selected direct-write denials, a cross-property attempt, and one duplicate-submission race, not every table or conflict type.
- Attachment upload/delete authorization for every permitted role; assigned-technician detail access; attachment size/content edge cases; and all work-order field combinations.
- Hosted Supabase RLS policies, grants, triggers, indexes, deployment state, and production data integrity. The corrective migration remains unapplied to any hosted database.
- External email, Room Ranker, Google Sheets, Microsoft 365, ChatGPT/MCP, and other third-party workflows. No mailbox scan or external write was performed. System Administrator Room Ranker returned 503 in the isolated stack.
- Whether the previously observed dashboard 503 in the pre-existing environment persists or has the same cause as any local integration-unavailable response.
- Concurrent updates, stale application-level edits, and state transitions under conflicting local user sessions. Only identical direct inserts were raced; PGlite's stale-save tests are not a substitute.

## Continuation — fixes and verification on 2026-10-03

This section supersedes earlier verification-limit statements where newer evidence is available. It does not imply completion of the exhaustive UI, integration, or hosted checks listed below.

### Fixes and status

| Finding | Change | Current status |
|---|---|---|
| Profile/work-order reads through direct Supabase | RLS restricts profile reads to the caller's own profile and limits work-order reads to active property members with the applicable profile and membership capabilities. | Applied to the disposable Docker-backed local database; direct REST checks passed for all eight implemented roles and a two-property fixture. Hosted deployment state is unknown. |
| Direct Supabase writes | Authenticated direct table writes are revoked except capability-gated work-order `INSERT`; authenticated direct `UPDATE`/`DELETE` for work orders and profile writes were rejected. API work-order mutations use server credentials only after application authorization. | Direct profile/work-order writes were denied in local REST checks for all eight roles. Work-order inserts succeeded and persisted for submit-capable roles and were denied to Senior Management. Other public-table operations were covered by migration privilege assertions in PGlite, not a full per-table REST matrix. |
| Engineering Dashboard 503 | Reproduced locally at 2,000 work orders: the dashboard query's `.limit(2000)` treated a full result as a service failure and returned 503. Replaced it with complete 1,000-row range pagination; page-query errors still return an explicit 503. | Route regression tests return all 2,501 rows and verify a later-page failure returns 503. Authenticated local browser/API checks loaded the dashboard beyond the former threshold. |
| Stale launcher test | Updated the source-based assertion to match filtered launcher-group rendering and retained capability-gating assertions. | Full automated suite passes with the corrected test; actual visual launcher visibility was not exhaustively checked in a browser for every role. |
| Equipment optional fields | Creation defaults omitted manufacturer and serial number to non-null empty strings. Regression tests cover both omitted, manufacturer omitted, serial omitted, and both supplied. | All four route-handler cases pass. This matrix uses a fake Supabase boundary; a direct Docker-backed persisted-value test for all four combinations was not performed in this continuation. |
| Unauthorized launchers | Engineering dashboard launcher definitions are gated by capabilities, and empty groups are omitted. Server/API authorization remains in place. | Code and automated source/capability checks pass. Per-role rendered UI parity with destination/API behavior remains unverified. |
| Malformed work-order IDs | Canonical UUID validation precedes lookups on detail GET/PATCH/DELETE, activity GET, and attachment GET/POST. | Automated route tests verify malformed IDs return 400 and syntactically valid nonexistent IDs return 404 for the covered methods. |
| Production build | Work-order creation helpers were moved from the route page into a non-route library and imports/tests were updated. | `npm run build` passed from the actual repository. |

### New local Docker-backed Supabase evidence

- Created a unique disposable Supabase project, copied all 10 checked-in migrations, and applied them with `supabase db reset`. No hosted URL or production account was used.
- Direct REST/Auth checks created Engineer, Manager, Senior Management, Technician, Front Desk, Front Desk Manager, Housekeeping, System Administrator, and a second-property Engineer. Each authenticated role saw only its own profile. Work-order visibility matched the tested policy: Engineer, Manager, Senior Management, Technician, and System Administrator could see the seeded in-property order; submit-only roles could not see another user's order; the second-property Engineer saw none.
- Authenticated direct profile updates and work-order updates/deletes were rejected for all eight roles. Direct work-order insertion succeeded with actor attribution for Engineer, Manager, Technician, Front Desk, Front Desk Manager, Housekeeping, and System Administrator, and was rejected for Senior Management.
- Cross-property work-order reads returned no rows. A cross-property insert was rejected by the database with “An active membership for this property is required” (PostgreSQL `P0001`; REST HTTP 400). This is a deny, not an accepted write or service outage.
- A concurrent duplicate-insert test used two separate authenticated sessions against the real local REST API. Responses were 201 and 409, and exactly one work-order row persisted.
- The read-only release-schema check passed against the local Docker API with no missing tables, columns, or statuses. The 40-check PGlite migration/behavior suite also passed; PGlite remains supplemental and does not replace the Docker REST checks.
- Temporary role accounts, properties, and audit work orders were removed; cleanup queries reported zero remaining test users, fixture hotel, and `AUDIT-` work orders. The specifically named local Supabase containers, database/storage volumes, network, temporary app copy, and PGlite install were also removed and verified absent.

### Final checks for this continuation

- Actual repository `npm run build` — passed; Next.js 16.3.5 compiled, type validation passed, and all 27 static pages were generated.
- `npm test` — 571/571 passed before the optional-field permutation expansion. The final exact automated selector set, run with test-worker concurrency limited to 2 after Node worker-zone out-of-memory failures, passed: email parser 6/6 and Node test suite 574/574.
- `npm run typecheck` — passed.
- `npm run lint` — passed with zero errors and the two existing `<img>` optimization warnings listed above.
- `npm run test:database` — 40/40 PostgreSQL migration/behavior checks passed.
- `npm run check:release-schema` — passed against the disposable Docker-backed local API.
- `npm run test:http-smoke` — 51/51 anonymous page-shell/API checks passed; it does not cover authenticated workflows or browser interactions.
- Focused optional-equipment tests — 48/48 passed, including all four manufacturer/serial-number presence combinations.

## Deployment readiness

**Not ready to declare deployment-ready.** The actual repository build, typecheck, lint, automated suite, release-schema check, anonymous smoke suite, local migration application, and selected real-Docker RLS/API tests pass. The prior dashboard 503 remains unexplained; hosted RLS state is unverified; exhaustive authenticated browser workflows, attachments, integrations, and concurrent edits remain untested. Do not deploy until authorized hosted migration review/application and the remaining high-risk checks are complete.

## Continuation — dashboard pagination and role launcher checks (2026-10-03)

This continuation updates the dashboard finding and records a further local-only test attempt. The hosted Supabase project was not contacted, and no deployment was performed.

### Engineering Dashboard 503

- Reproduced the failure using the disposable Docker-backed Supabase database at the former 2,000-order limit. The response was HTTP 503 with “The dashboard result reached its safety limit.” The System Administrator browser rendered the error.
- Changed the dashboard query to use the existing `fetchAllPages` helper with 1,000-row ranges. A failed page remains an explicit 503 and cannot return a partial success.
- Added route regression tests for all 2,501 rows across multiple pages and for an error on a later page. Both pass.
- After updating the isolated app copy, authenticated local dashboard requests returned 200 above the former limit. The old error was caused by the artificial result-size guard, not an unavailable Supabase dependency.

### Launcher and API parity — partial

- Browser-tested the Engineering Dashboard as Engineer, Manager, Senior Management, and System Administrator. Visible launcher labels matched the capabilities in each authenticated `/api/session` response. Their authorized dashboard work-order requests returned 200.
- Front Desk landed on the submit-only work-order page, rendered no Engineering Dashboard launchers, and a direct dashboard work-order request returned 403.
- Front Desk Manager and Housekeeping also landed on the submit-only work-order page and rendered no Engineering Dashboard launchers. Their direct dashboard API result was not reliably isolated from the work-order-drafts requests in the browser log, so API parity for those roles is not claimed here.
- Technician landed on the separate Technician dashboard. Its complete launcher/API parity was not tested.
- This is not exhaustive validation of every launcher destination, every role, or every interactive control. No permission grants were added to the disposable database; observed capability sets reflect its fail-closed empty `role_permissions` state.

### Browser, attachment, and integration limits

- Repeated multi-role browser execution exhausted the isolated Next.js development server's roughly 500 MB JavaScript heap while compiling additional routes. The disposable app process exited with out-of-memory status 134. The pre-existing application on port 3000 was not changed or queried.
- Attachment upload/list/delete and ownership tests did not complete in this continuation. The attachment API exposes upload and list operations but no delete handler; this behavior still requires a contract decision and appropriate authorized testing.
- Integrations remained in safe mode. No Google Sheets, email, Microsoft 365, Room Ranker, Corporate PM, ChatGPT/MCP, hosted Supabase, or other live third-party service was contacted. Their authenticated read/write, error, and recovery paths remain unverified.
- Cross-property RLS and the selected direct database CRUD/concurrency checks documented above remain local-only evidence from the earlier continuation; hosted policy state is still unknown.

### Verification after dashboard change

- Actual repository `npm run build` — passed; Next.js compiled, completed type validation, and generated all 27 static pages.
- `npm test -- --test-concurrency=2` — email parser 6/6 and Node suite 576/576 passed.
- `npm run typecheck` — passed.
- `npm run lint` — zero errors; two existing `<img>` optimization warnings remain.
- `npm run test:database` — 40/40 isolated PGlite migration/behavior checks passed.
- `npm run check:release-schema` — passed against the disposable local Docker-backed Supabase API; this is a schema contract check, not an RLS or workflow test.
- `npm run test:http-smoke` was not rerun because its configured target is the existing application on port 3000, which was intentionally left untouched.

### Cleanup and readiness

The 1,999 dashboard-volume work orders were deleted from the disposable database, leaving its original single order before final cleanup. The uniquely named Supabase containers and data volumes were then removed with `supabase stop --no-backup`; the test users were contained in those deleted volumes. The copied app, browser tooling, and captured temporary test logs were also removed. No test uploads had been created.

**Deployment readiness remains: not ready.** The dashboard threshold defect is fixed and regression-tested, but exhaustive browser coverage, attachment workflows, complete per-role API parity, integrations, hosted RLS configuration, and production deployment authorization remain outstanding. No hosted changes or deployment are authorized by this audit.

## Restart continuation — local verification and remaining scope

No hosted Supabase, production, Google Sheets, email, Microsoft 365, Room Ranker, Corporate PM, ChatGPT/MCP, or application on port 3000 was contacted or modified. No deployment was performed.

### Role and attachment checks completed in this continuation

- Added a route-level `/api/session` capability matrix for 13 actual role labels: Engineer, Chief Engineer, Engineering Manager, Maintenance Technician, Technician, Regional Maintenance, General Manager, Front Desk, Front Desk Manager, Housekeeping, Lead Housekeeper, Senior Management, and System Administrator. It compares landing route, membership role, role policy, and session capabilities using in-memory principals and explicit mock grants. This does not authenticate those roles against a live or disposable Supabase stack and does not establish rendered launcher visibility.
- The matrix exposed a capability mismatch: alias normalization made `profileAllows` grant `review_feedback` to Engineering Manager and Regional Maintenance although the explicit role policy denies it. `profileAllows` now evaluates the assigned role labels for this capability, so the session and `requireCapability` paths deny these roles while preserving access for the expressly permitted Engineer, Chief Engineer, and System Administrator titles. No permission was added.
- Added isolated attachment route tests for authentication, owner and cross-user reads/uploads, each listed role, technician assignment restrictions, property filter enforcement, not-found/database failures, upload/list/signed-URL failures, image MIME, empty and oversized files, and the inclusive 10 MiB limit. These use in-memory mocks; they do not verify storage or RLS persistence.
- Fixed attachment listing to return HTTP 503 instead of success-shaped partial data if signing any listed image URL fails or returns no URL. Corrected the size error text to match the existing inclusive limit. Upload/list/read continue to be the only attachment operations found in the UI/API; no delete handler or delete control exists.

### Verification from this restart

- `npm run build` — passed; Next.js 16.3.5 compiled, type validation passed, and 27 static pages were generated.
- `npm test -- --test-concurrency=2` — passed: 582/582 Node tests; email-parser sub-suite 6/6.
- Focused role/attachment tests — passed: 6/6.
- `npm run typecheck` — passed.
- `npm run lint` — passed with zero errors and the two existing `<img>` optimization warnings in `src/app/work-orders/[id]/page.tsx`.
- `git diff --check` — passed.
- `npm run test:database` — blocked before database creation: `CMPRI_PGLITE_ROOT` is not configured. The earlier recorded 40/40 PGlite result is prior-run evidence, not a rerun in this continuation.
- `npm run check:release-schema` — blocked before any HTTP request because Supabase URL/service-key environment configuration is absent. The earlier disposable-stack schema result is prior-run evidence, not a rerun here.
- `npm run test:http-smoke` was not run; its target is the existing application on port 3000, which this continuation intentionally did not query.

### Not verified and cleanup status

- Full rendered launcher/controls, every destination, forms, modals, work-order edit/status interactions, browser console/network failures, and role-by-role UI/API parity remain unverified. No browser pages were shared, and no app server was started because the available runtime could not be proven to use a disposable local database.
- The Supabase CLI and a configured PGlite installation were unavailable. No disposable Supabase project was running or created in this continuation. The `docker ps` check showed a generically named running container; it was not created by or identified as part of this audit, so it was left untouched.
- The image-signature checks have mock-backed route coverage but have not been exercised against real storage. Full image decoding, malformed/truncated or polyglot files, real persistence, and cleanup remain unverified; the route checks only the leading format signature, not the complete image stream.
- Direct hosted RLS state remains unverified. Historical local Docker-backed checks recorded earlier in this report are not evidence of hosted policies or a repeat of all current-role behaviors. Integrations and concurrent edit/race behavior beyond the previously documented duplicate-insert check remain untested.
- The current attachment contract is upload, list, and signed read. Deletion is not permitted; no delete endpoint or UI control was added.
- No test users, database records, uploads, browser artifacts, disposable database, or audit container were created in this continuation. The temporary test-output file was removed. A tool-discovery command accidentally invoked `npm exec` and announced an attempt to resolve an undeclared `node` package; it was stopped before completion. No dependency was intentionally installed, but a package-registry request cannot be ruled out.

**Final status: NOT READY.** The build and automated checks pass, but the role and attachment work here is mock-backed, the final database gates could not run, exhaustive browser testing is outstanding, and hosted RLS/integration/deployment state is unverified. This report does not authorize deployment.

## Continued local audit — attachment contract and content validation

The product requirement is explicit: attachments must be upload-and-view only and must not be deletable. The API continues to expose only `GET` and `POST`; no deletion route or control was added.

### Additional attachment defect found and fixed

- **Root cause:** Upload validation trusted the client-supplied `image/*` MIME prefix and accepted the original extension as the storage content type. This allowed SVG and mislabeled/non-image bytes to be stored as images.
- **Fix:** The upload route now permits only JPEG, PNG, GIF, WebP, BMP, HEIC, and HEIF extensions; enforces a matching MIME when one is provided; and checks the file signature before storage. MIME-less or `application/octet-stream` camera uploads remain supported only when the extension is recognized and the bytes match. The persisted content type is derived from the extension allow-list, not arbitrary client input.
- **Regression coverage:** Added SVG rejection, MIME/extension mismatch, fake image-signature rejection, all eight supported extension cases, MIME-less camera image acceptance, and exact 10 MiB boundary coverage. Existing tests continue to cover unauthenticated, cross-user/cross-role, assignment, property, list/read, storage failure, and unavailable signed-URL cases.
- **Attachment deletion:** Verified absent from the route contract and tests. No delete operation was attempted or added.

### Verification after content validation

- `npm run build` — passed; Next.js compiled, validated types, and generated 27 static pages.
- `npm test -- --test-concurrency=2` — passed: Node suite 582/582; email-parser 6/6.
- Focused role-session and attachment tests — passed: 6/6.
- `npm run typecheck` — passed.
- `npm run lint` — passed with no errors and the same two existing `<img>` optimization warnings.
- Database/release-schema checks, real storage persistence, browser workflows, and hosted RLS remain unverified for the reasons above.

**Status remains NOT READY.** The attachment content checks are mock-tested and built but have not been exercised against a disposable storage service. Exhaustive per-role browser and database-backed authorization checks and local database verification remain necessary before any readiness claim. No deployment is authorized.

## Final continuation — isolated CLI, browser, and regression checks (2026-10-03)

This section records the latest continuation and supersedes earlier statements where it provides newer evidence. All web testing used the isolated application on port 3100 with dummy local Supabase configuration and browser API fixtures. Port 3000 and all hosted services were left untouched. No deployment or production change was made.

### Vercel CLI and disposable release-schema gate

- Local `vercel --version` returned `59.16.0`, and `vercel --help` worked. No login, project-link, pull, network-dependent command, or deployment command was run. The CLI check does not establish access to a disposable Supabase environment.
- `npm run test:database` passed against the isolated PGlite installation: **40/40 PostgreSQL migration/behavior checks**.
- The latest disposable Docker attempt applied all 10 checked-in migrations and PostgREST loaded the schema (68 relations, 82 relationships, and 7 RPCs). The Windows host could not reach the published disposable PostgREST endpoint, so the requested latest `npm run check:release-schema` could not be verified and is **not counted as passing**. The containers and network created for that attempt were removed. An earlier section records a successful schema check from a prior disposable Docker run; that historical result does not replace the blocked rerun against the current state.
- PGlite checks are not evidence of Supabase RLS enforcement or hosted schema state. Hosted RLS remains unverified.

### Browser evidence and limits

- Compared dashboard launcher visibility with the mocked `/api/session` capability matrix for 13 role labels: Engineer, Chief Engineer, Engineering Manager, Maintenance Technician, Technician, Regional Maintenance, General Manager, Front Desk, Front Desk Manager, Housekeeping, Lead Housekeeper, Senior Management, and System Administrator. The comparison passed **13/13**.
- Opened the Engineering Dashboard, Work Order List, and Create Work Order launcher surfaces. A System Administrator work-order detail fixture rendered; editing its status from Open to In Progress produced a mocked PATCH, revision increment, Saved state, and matching history entry. This proves the local UI save path only, not server persistence or role authorization.
- The Create Work Order modal rendered, and a blank-submit attempt was made. Its location control reported “Location does not exist” because the browser fixture did not provide the expected room/location payload; therefore form validation and successful creation are not claimed as passed. No work order was persisted.
- The detail view showed the Photo section and “No photo attached”; no delete/remove control was present. The attachment chooser/upload UI and real storage round-trip were not exercised in the browser. The GET/POST-only contract and upload/read authorization/validation remain covered by mock-backed route tests; attachments remain permanent and there is no delete endpoint.
- The browser batch did **not** exhaustively exercise every launcher destination, every role’s forms/modals/navigation and sensitive controls, every API directly for every role, or console/network behavior. During the build, the still-running isolated server briefly served a stale Next.js chunk (HTTP 500); restarting that specific port-3100 server restored the fixture page. This test-environment event is not treated as an application defect. A few aborted App Router requests occurred during navigation.
- Earlier Docker-backed Auth/REST tests and the two-session duplicate-insert test are documented above; they were not repeated in this continuation. Direct hosted RLS behavior was not tested.

### Latest verification results

| Command/check | Result |
|---|---|
| `npm run build` (dummy local Supabase configuration) | Passed; Next.js compiled, TypeScript validation passed, and 27 pages generated. |
| `npm test -- --test-concurrency=2` | Passed after the final code fixes; Node suite **586/586**, email parser **6/6**. |
| `npm run typecheck` | Passed. |
| `npm run lint` | Passed with 0 errors and 3 warnings: two `<img>` optimization warnings in the work-order detail page and one unused test-helper parameter warning. |
| `npm run test:database` | Passed after the final code fixes; **40/40**. |
| `npm run check:release-schema` against the disposable PostgREST endpoint | Passed; `missing: []`. The local gateway made the disposable REST endpoint reachable. |
| Role launcher/session capability comparison | Passed; **13/13** role labels. |
| Work-order detail edit/status browser fixture | Passed through mocked PATCH/save/history path; not persisted. |
| Full role-by-role browser/API/storage audit | Incomplete; see limits above. |
| `git diff --check` | Passed before this report append; rerun after the append. |

### Cleanup, outstanding items, and readiness

- The latest uniquely named disposable database/Auth/Storage/PostgREST containers and network were removed after the schema gate. The containers had no mounted volumes; all disposable users, records, and uploads held in their writable layers were removed with them. The pre-existing unrelated Docker container was not touched.
- Earlier authenticated local-stack checks created temporary role accounts, work orders, and an attachment. The disposable stack removal deleted those records and uploaded objects. The local browser/app listeners were stopped; temporary credential/image/tool-output files were removed during final cleanup.
- No product decision remains for attachment deletion: the accepted contract is permanent upload/view only. Do not add deletion.
- Still unverified: current release-schema gate against a reachable disposable API, complete role-by-role browser coverage and direct API matrix, real isolated storage upload/list/read round-trip, full cross-property/cross-user concurrency and authorization matrix on the current migration set, and hosted RLS/deployment state. Existing historical local Docker checks do not close these current gaps.
- No newly verified product defect was found in the latest browser batch. The status-save path worked against fixtures; the missing location fixture and transient stale chunk were test-environment limitations. Previously identified and fixed defects and their regression coverage are listed above.

**Final status: NOT READY.** The build and automated/database regression suites pass, the release-schema gate passed against disposable local REST, and role-launcher capability comparison passed. Exhaustive per-role browser coverage and hosted RLS remain incomplete. No deployment is authorized.

## Final audit continuation — role/API checks, fixes, final gates, and cleanup

### Additional fixes and regression coverage

- **Embedded profile sign-out failed to close its modal.** The profile message omitted the host-validated modal token; it now includes that token. A modal-host regression assertion covers the contract.
- **Malformed authorized catalog and work-order-import requests returned HTTP 500.** Required-field validation errors escaped their route handlers. Both routes now return HTTP 400, and regression tests verify invalid input does not reach database writes.
- **Direct work-order creation bypassed the application capability check.** Creation now uses a service-role-backed server write and fails closed when that credential is unavailable. A migration revokes direct authenticated/anonymous INSERT while preserving the server-side route. Route and migration regressions cover the boundary.
- These changes preserve the existing paginated `fetchAllPages` dashboard fix and the permanent attachment contract. Attachments remain upload/list/signed-read only; no delete endpoint or delete control was introduced.

### Role, API, and local authorization evidence

- Thirteen disposable account labels authenticated through local `/api/session`: Engineer, Chief Engineer, Engineering Manager, Maintenance Technician, Technician, Regional Maintenance, General Manager, Front Desk, Front Desk Manager, Housekeeping, Lead Housekeeper, Senior Management, and System Administrator.
- A 416-request matrix across 32 API probes had no role/capability mismatches after accounting for intentional 401/403 fail-closed responses and the narrower equipment-edit policy. A 39-probe malformed-write retest likewise matched expected capability outcomes: authorized roles received 400 for invalid data; unauthorized roles received 403.
- Local direct REST checks denied work-order INSERT, UPDATE, and a Front Desk DELETE. Cross-property reads returned no foreign rows; a foreign-property update was denied and the application detail API returned 404. A peer Front Desk Manager could not read, edit, or delete another Front Desk user's draft, while the owner update and authorized General Manager visibility behaved as expected.
- The disposable local stack also exercised the real attachment upload and signed-read path in a prior browser run; the object loaded successfully. Route regression tests cover unauthenticated access, ownership, cross-user/cross-role/property access, validation, size limits, storage/signing failures, and no-delete behavior.
- These observations apply only to the disposable local database/Auth/Storage stack. They do not verify hosted RLS, production grants, or deployed migration state.

### Browser coverage and limitations

- Launcher visibility was compared with session capabilities for all 13 role labels and passed 13/13. Earlier browser batches exercised launcher destinations for dashboard roles and submit-only roles; this continuation also exercised front-desk form validation, profile sign-out, a mocked work-order edit/status transition, and an attachment view/upload path.
- The status transition and one later UI batch used browser API fixtures; fixture-backed UI evidence is not persisted CRUD or direct authorization evidence. Some launcher pages produced client errors because generic fixtures omitted expected response fields, so those pages are not counted as passed.
- The browser audit did not exercise every page, button, modal, form, and status path for every role; nor did it fully capture console/network behavior for each role. The Create Work Order fixture lacked a valid location and could not verify successful submission. Role-by-role UI/API parity is therefore only partially covered even though the separate direct API matrix above passed.

### Safety and external-access uncertainty

- No deployment, push, hosted database mutation, or third-party write action was performed. Port 3000 was not used for audit requests. Hosted Supabase RLS remains unverified.
- **Possible Google Sheets read:** During one earlier System Administrator detail-page browser run, the app loaded `.env.local` and its Room Ranker route was not proven to have all spreadsheet/service-account variables blanked for that process. The page requested Room Ranker data. No write action occurred, but no outbound trace establishes whether the route reached Google Sheets; therefore a read cannot be ruled out. The app process has been stopped. This uncertainty prevents claiming with certainty that the audit made no live-service contact.

### Final verification and cleanup

- `npm run build` — passed.
- `npm test -- --test-concurrency=2` — passed: **586/586** main-suite tests and **6/6** email-parser tests.
- `npm run typecheck` — passed.
- `npm run lint` — passed with zero errors and three warnings (two existing `<img>` optimization warnings and one unused test-helper parameter warning).
- `npm run test:database` — passed: **40/40** PostgreSQL migration/behavior checks.
- `npm run check:release-schema` — passed against the disposable local PostgREST gateway: `missing: []`. This read-only contract gate does not verify RLS or business behavior.
- The specifically named disposable Auth, Storage, PostgREST, and PostgreSQL containers and their network were removed after verification. They had no mounted volumes. Audit account credentials, the temporary attachment image, and identified audit tool-output files were removed. The pre-existing unrelated Docker container was left untouched. Local app/gateway/credential-bridge listeners were stopped.
- `git diff --check` is rerun after this report update; no deployment is authorized.

**Final status: NOT READY.** Automated tests, typecheck, build, lint, the 40-check database suite, local release-schema gate, and the tested local API/security probes passed. The requested exhaustive role-by-role browser audit remains incomplete, hosted RLS is unverified, and a possible Google Sheets read cannot be ruled out. These are evidence gaps, not grounds to infer readiness.

## Subsequent continuation — database-backed role workflows (2026-10-03)

This continuation used the uniquely named disposable Auth/PostgreSQL/PostgREST/Storage stack and the application on port 3100. The app's runtime integration settings were explicitly blocked for the browser run. Port 3000, hosted database mutations, and deployment were not used. A prior-run possibility of a Google Sheets read remains unresolved as recorded above; this continuation does not erase that uncertainty.

### Additional defects fixed

- **Front Desk attribution was mislabeled.** The shared work-order helper classified all submit-only roles as `department_pending_verification`, despite the database contract distinguishing Front Desk. Front Desk submissions now use `front_desk_pending_verification`; Housekeeping remains `department_pending_verification`. Regression coverage asserts both labels, and real Front Desk Manager and Housekeeping browser submissions were confirmed in local PostgreSQL with the correct source and pending status.
- **Read-only roles could type into work-order labor fields.** Senior Management has view-only work-order access and its direct PATCH is denied, but Parts, Hours, and Cost were editable controls without a save action. They are now disabled unless `edit_tickets` is present (and while saving). The role detail was reloaded in the browser and all three controls were disabled; a focused regression asserts the restriction.

### Browser and direct API evidence

- The 13 named role accounts were present in local user management; the System Administrator UI reported 13 active users. Current `/api/session` checks included Front Desk Manager (`submit`, `submit_feedback`, `view_profiles`), Housekeeping (same), Senior Management (`view_dashboard`, `submit_feedback`, `view_profiles`), and System Administrator (all 13 capabilities). The broader earlier report section records the 13-role session matrix and 416 API probes.
- Front Desk Manager submitted a valid request through the UI. Local PostgreSQL recorded `front_desk_pending_verification`. Housekeeping submitted through the UI without a Front Desk first-name field; local PostgreSQL recorded `department_pending_verification`. Blank Housekeeping submission was blocked by the required room control.
- As Housekeeping, direct dashboard, technician, user-management, asset creation, import, and room-edit probes all failed closed with HTTP 403. Its own attachment list returned HTTP 200, an empty upload returned HTTP 400, and another user's attachment list returned HTTP 403. As Senior Management, dashboard read and cross-role attachment view returned HTTP 200 while work-order PATCH and user management returned HTTP 403. The visible Senior Management labor fields were corrected as described above.
- As System Administrator, the real UI rendered the full capability-appropriate launcher set, and Manage Users loaded all 13 disposable accounts. A blank invite attempt did not create a user. User list, dashboard, and room reads returned HTTP 200; malformed asset, import, and room mutations returned HTTP 400 before writes.
- The local attachment API rejected an unsupported extension, invalid PNG signature, and image larger than 10 MiB with HTTP 400. Earlier local browser evidence verified a permanent PNG upload persisted in Storage and loaded from a signed URL. No DELETE operation was added or invoked. Attachments remain upload/view only.
- The Preventive Maintenance workspace explicitly stated that Google Sheets sync is disabled and changes remain in CMPRI. A daily checkbox was toggled through the browser and verified in local PostgreSQL. The Pool Log rendered its no-active-pool state (HTTP 404) because this disposable fixture had no pool configured; Daily Room Operations correctly reported that no snapshot was saved. These are test-fixture limitations, not passes for those unseeded workflows.
- Console 400/403 entries corresponded to the deliberately malformed or unauthorized direct API probes; the Pool Log's missing-pool response was an expected 404. Navigation-triggered Auth/RSC `ERR_ABORTED` events occurred during page transitions. This does not constitute exhaustive per-role console/network monitoring.

### Latest verification and cleanup

- `npm run build` — passed; production compilation, TypeScript validation, and 27 route/page generation succeeded.
- `npm test -- --test-concurrency=2` — passed: **588/588** Node tests and **6/6** email-parser tests.
- `npm run typecheck` — passed.
- `npm run lint` — passed with zero errors and three warnings: two existing `<img>` optimization warnings and one unused test-helper parameter warning.
- `npm run test:database` — passed: **40/40** isolated PostgreSQL migration/behavior checks. The suite explicitly notes that it does not reproduce Supabase RLS or concurrent sessions.
- `npm run check:release-schema` — the first invocation detected that repository `.env.local` pointed at a hosted `supabase.co` URL and refused to run. No request was made to that target. The gate was then rerun with an explicit disposable loopback URL and its service key; it passed with `missing: []`.
- `git diff --check` — passed after the report append for tracked changes; the new report text was separately checked for trailing whitespace.
- The exact disposable containers and network were removed; inspection showed no mounted volumes. The app and gateway listeners were stopped. The temporary copied app, its dependency junction, disposable account fixture, PNG, and identified browser/test output files were removed. The unrelated pre-existing Docker container was left untouched.

### Remaining limitations and readiness

- The requested exhaustive pass over every launcher, button, form, modal, workflow, and direct API for every role is still incomplete. Several launcher destinations and role-specific state transitions were not exercised against real local records, and some local features had no suitable seed data.
- The current local stack provides evidence only for its own schema, policies, and storage. Hosted Supabase RLS, production grants, and deployed migration state remain unverified.
- The earlier possible Google Sheets read cannot be ruled out. No deployment, push, hosted mutation, or deployment authorization occurred in this continuation.
- There is no delete endpoint for attachments; the product contract is resolved as permanent upload/view only.

**Final status: NOT READY.** The newly found local attribution and read-only UI defects are fixed with regression coverage, and the requested build, full automated suite, typecheck, lint, database suite, and release-schema gate passed. Readiness remains blocked by incomplete exhaustive browser/API coverage, unverified hosted RLS, and the unresolved possibility of an earlier Google Sheets read. No deployment is authorized.

## Supplemental continuation — Technician field-level permissions (2026-10-03)

This addendum records a defect found and fixed after the verification results above; its verification totals supersede the earlier totals in this report.

### Defect and remediation

- **Finding:** An assigned Maintenance Technician could see/edit fields that the work-order PATCH API correctly rejects. The page treated `edit_tickets` as broad technical edit authority, and `saveTicket` sent the full engineering payload even for technicians. As a result, a Technician status edit included forbidden fields and failed with HTTP 403.
- **Root cause:** UI controls and payload construction did not follow the API's narrower Technician field allowlist.
- **Fix:** Added [`src/lib/work-order-edit-policy.ts`](../src/lib/work-order-edit-policy.ts) as the shared field policy used by both the work-order API and detail page. An unassigned Technician may only claim the work; an assigned Technician may edit only `asset_id`, `category`, `status`, and `notes`. Issue, priority, technician assignment, due date, labor/parts/cost, asset creation, and closure root-cause controls are not editable by Technicians. Technician status choices are limited to Open, In Progress, and Completed. The API's server-side authorization remains authoritative and was not loosened.
- **Regression coverage:** [`tests/work-order-access.test.mjs`](../tests/work-order-access.test.mjs) checks the shared role/field policy, API acceptance of allowed Technician fields, rejection of technical-only fields, and UI field-level control gates. [`tests/ticket-save.test.mjs`](../tests/ticket-save.test.mjs) and [`tests/work-order-id-validation.test.mjs`](../tests/work-order-id-validation.test.mjs) now provide the shared-policy dependency in their isolated route/function fixtures.
- The first post-change full-suite run exposed seven test-harness failures because the isolated save and route fixtures did not inject the new policy dependency. The fixtures were updated; the final full-suite rerun passed.
- **Local browser retest:** On the disposable local Supabase-backed app, the assigned Technician changed the work order Open → In Progress → Completed through the UI. The database recorded Completed at revision 5; `parts` and `action_root_cause` remained empty. The Closure Details textarea was disabled for the Technician.

### Final verification for this continuation

| Command/check | Result |
|---|---|
| `npm run build` with loopback-only Supabase configuration and blank integration credentials | Passed; compiled and generated 27 routes/pages. |
| `npm test -- --test-concurrency=2` | Passed: **590/590** Node tests and **6/6** email-parser tests. |
| `npm run typecheck` | Passed. |
| `npm run lint` | Passed with zero errors and three warnings: two `<img>` optimization warnings in the work-order detail page and one unused test-helper parameter warning. |
| `npm run test:database` with the existing isolated PGlite 0.5.8 installation | Passed: **40/40** PostgreSQL migration/behavior checks. The runner does not reproduce Supabase RLS or concurrent sessions. |
| `npm run check:release-schema` with a locally generated service-role JWT and `http://127.0.0.1:55455` | Passed; `missing: []`. This read-only gate does not establish RLS correctness. |
| Technician UI/API regression batch | Passed: **63/63** focused work-order access tests before the final full-suite run; final suite also passed with the last capability guard. |
| `git diff --check` | Passed; all task-touched source, test, and report files were also checked for trailing whitespace. |

### Cleanup and remaining blockers

- Removed the four named disposable Docker containers and their network after confirming that none had mounted volumes; this removed their disposable Auth users, database fixtures, and Storage uploads. Stopped the isolated app and gateway listeners, blanked the browser tab, removed the known disposable credential/result files and generated `.next` output, and left the unrelated pre-existing container untouched.
- This continuation made no intentional request to a hosted or third-party service and performed no deployment or push. The earlier possible Google Sheets read recorded above remains unresolved; it cannot be ruled out retrospectively.
- The requested exhaustive browser pass over every button, form, modal, workflow, transition, and direct API for all 13 role labels remains incomplete. Some integration destinations were intentionally excluded because their code was not proven incapable of contacting live services. Navigation-related aborted requests and a signed local documentation-object request were observed but not fully classified.
- Cross-property/user isolation, direct CRUD, concurrency, and application/database authorization were exercised against disposable local services in earlier batches, but hosted Supabase RLS, production grants, and deployed migration state remain unverified.
- Attachment deletion is not a pending product decision: the required contract is permanent upload/view only. No delete endpoint was introduced and no attachment delete operation was invoked.

**Final status: NOT READY.** The Technician UI/API mismatch is fixed and retested locally, and all listed final build, automated, type, lint, database, and local release-schema checks passed. Exhaustive role-by-role browser/API coverage is not complete; hosted RLS and production state are unverified; and the possible earlier Google Sheets read remains unresolved. No deployment is authorized.


## Local continuation — 13-role regression and final local checks (2026-10-04)

This addendum supersedes the earlier resource-related build/test and Parts/Vendors verification blockers. All commands and browser workflows below used the actual repository and the disposable local stack (`127.0.0.1:55321`); the production-facing `.env.local` values were overridden in the build and server process with the disposable URL/key and disabled integration credentials. A scan of the built client assets found no hosted Supabase URL. No hosted service or deployment was contacted.

### New data-integrity defect: future pool-log dates

- **Finding:** `validLogDate` checked ISO syntax and calendar validity but accepted dates years in the future. A previous disposable pool-log row dated `2030-01-10` was readable through the local API, proving the API accepted a future date; the date control also had no maximum.
- **Impact:** A user or direct API/MCP caller could store pool readings against a future day, making the operational log misleading and weakening date-specific conflict/update behavior.
- **Fix:** Added a shared `poolLogTodayDate` helper using the property's `America/Chicago` day. `validLogDate` now rejects later dates; the pool-log date input exposes the same maximum. GET, POST, input normalization, and MCP writes share this validation.
- **Regression evidence:** The focused pool-log suite passed **57/57**. It covers calendar validity, leap days, Chicago midnight boundaries, browser date maximum, and future GET/POST rejection before log reads or writes. Against the freshly built local UI, a future-date selection showed native `rangeOverflow`, its GET returned 400 with the validation message, and a direct future POST returned 400.

### Fresh repository checks

| Check | Result |
|---|---|
| Actual repository production build, `npm run build -- --webpack`, with local-only Supabase and integrations disabled | Passed; compiled, type-checked, and generated all 27 pages |
| `npm test` | **593/593** Node tests passed; email parser **6/6** passed |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed with zero errors; final rerun after harness cleanup had three warnings (two existing `<img>` optimization warnings and one unused test variable) |
| `npm run test:database` with isolated PGlite | **44/44** migration/behavior checks passed |
| `npm run check:release-schema` against the disposable local Supabase REST schema | Passed; no required tables/columns/statuses missing |
| `npm run test:http-smoke` | **51/51** unauthenticated UI/API/mutation checks passed |

The PGlite run explicitly does **not** emulate hosted Supabase RLS or real concurrent sessions; those were tested separately against the disposable Docker-backed Supabase API.

### All-role browser/API and database evidence

- The freshly built local app was tested as all **13** implemented role labels: Engineer, Chief Engineer, Engineering Manager, Maintenance Technician, Technician, Regional Maintenance, General Manager, Front Desk, Front Desk Manager, Housekeeping, Lead Housekeeper, Senior Management, and System Administrator.
- The dashboard launcher set was compared with each signed-in session's capabilities, each displayed launcher was opened, and expected launcher absence/presence matched. Launcher counts were 17, 17, 17, 13, 13, 17, 13, 4, 4, 4, 4, 11, and 18 respectively.
- The role/API matrix made **195** capability-checked reads (15 per role); all had expected authorization results. It recorded zero browser exceptions, zero unexpected 5xx responses, and zero role/launcher/API mismatches.
- Twelve submit-capable roles created a work order in the UI. For every one, the success message was matched to a persisted local PostgreSQL row with the submitting user and correct property. The non-submitter Senior Management account was denied direct API creation.
- For every role, direct Supabase work-order INSERT, UPDATE, and DELETE were denied (403); profile INSERT, UPDATE, and DELETE were denied (403); direct selection of another profile returned zero rows; and cross-property work-order selection returned zero rows. Cross-property work-order detail, activity, and attachment API requests returned 404 rather than exposing records.
- Concurrent edits from two independent role sessions returned one success and one conflict (200/409); the local row retained the winning revision and content.
- Attachment workflow coverage included valid PNG/JPG uploads, multiple files, listing and signed download; unsupported, empty, malformed, MIME-mismatched, and oversized files returned 400; unauthorized-role list/upload to another order returned 403 where that role lacked access; authorized engineering roles could access same-property orders while submit-only roles could not. Direct Storage upload was blocked by RLS. The earlier raw-object DELETE returned HTTP 200 with an empty result and was initially ambiguous. In the 2026-10-04 continuation, a direct DELETE as Senior Management against a newly uploaded test object returned HTTP 400 with Storage's JSON identifying `statusCode: 403` / `AccessDenied`; the `storage.objects` row remained. The application has no attachment DELETE handler.

### Role-specific browser workflows rerun against the fresh production build

- **Profiles (all 13 roles):** Saved each role's permitted settings, checked persisted profile values, and restored them. Submit-only roles showed no notification delivery or notification-checkbox controls.
- **Equipment:** Created equipment with neither, manufacturer only, serial only, and both optional values; each row was read back with the expected stored values. Equipment-documentation options and modal validation were exercised.
- **Work orders:** Repeated In Progress → Completed → Will Not Do → Closed → reopened Completed transitions and reassigned/completed by a Technician; each update advanced the revision and was checked in the database.
- **System Administrator / feedback:** Created, deactivated, reactivated, role-changed, and deleted a disposable account; verified Auth, profile, and membership state. Submitted Problem/Bug/Suggestion feedback, exercised Reviewed/Planned/Resolved/New, then deleted the test feedback and checked persistence.
- **Parts/Vendors:** Repeated vendor and contact creation, optional website persistence, inventory validation and compatibility, reorder/manual idea status transitions, all four proposal recommendations, negative-cost rejection, and approve/decline. Each successful write was read from the local database.
- **Purchasing/shipment:** The prior fixture was already terminal (`Complete`), so it was not counted as a repeat pass. A separate disposable local purchase/shipment pair was seeded, then System Administrator UI transitions were exercised through Ordered → Received → Installed / Used → Complete and Shipped → Delivered → Received; each UI response and resulting database value was checked. The seeded pair was deleted afterward.
- **Enseo/GSS:** Empty/duplicate Enseo batches were rejected without writes; a valid move/history entry and restore persisted; Senior Management controls were hidden and direct mutation was denied. Engineer and Senior Management could read the GSS report; Housekeeping was denied without report data.
- **Pool log/rooms:** Invalid incomplete input wrote nothing; AM and PM readings, history, and System Administrator correction were persisted. Engineer room edit/restore succeeded; Senior Management was read-only in UI and denied by API.
- **Safe integrations:** Room Ranker writes stayed in local safe mode; Corporate PM writes were disabled and its read returned the expected unconfigured state; mailbox scans returned the explicit unavailable state; ChatGPT/MCP remained disconnected and OAuth was not initiated. No external integration credentials were supplied to the test app.

### Remaining coverage and deployment status

**NOT READY for deployment.** The source fixes and above local checks pass, but this is not a claim that every checkbox, dropdown option, validation branch, and workflow on every destination page was exhaustively exercised under every role. The 13-role pass covers dashboard launchers, representative page behavior, a 15-route capability matrix, cross-property work-order boundaries, and specified high-risk workflows. The 2026-10-04 continuation closes the specific PM and attachment-recovery checks described below, but exhaustive per-control coverage under every role remains open. The integrated browser did not expose a native CSV download event; CSV generation, contents, filename, and link-click metadata were verified separately.

Hosted Supabase policies/grants and migration state remain deliberately unverified because hosted access was explicitly withheld. Gmail, Microsoft 365, Google Sheets/Corporate PM, Room Ranker, and OpenAI were not tested with real external credentials; doing so would not be safe in this local-only phase. The earlier report's possible historical Google Sheets read remains unknowable retrospectively. No deployment or hosted change is authorized.

**Cleanup completed:** removed the nine named temporary `.audit-*.mjs` scripts, stopped the local application and only the Supabase containers labeled for disposable project `cmpripa3103`, removed that project's two database/storage volumes and network, and deleted its exact temporary project directory and generated audit-result files. Ports 3114, 55321, and 55322 have no listeners; no containers, volumes, or network for that project remain. The unrelated Docker containers/networks were left untouched.

## Local continuation — 2026-10-04

This continuation used a separate disposable Docker-backed project, `cmpri-role-audit-20261004`, with a loopback-only app at port 3114 and gateway at 55557. It did not contact hosted Supabase, production, or third-party integrations. Per the instruction not to clean up, the test users, generated work orders/PM records/Storage objects, Docker services, and app were left in place and running. The earlier cleanup statement above describes the preceding project only.

### Preventive-maintenance UI and persistence

- **Routine checklist / weekly navigation — PASS:** As System Administrator, moved between weeks and “This week,” toggled daily and weekly checklist items, and confirmed corresponding `cmpri_pm_proposals` rows and revisions in PostgreSQL. Toggling an existing pending checkbox revised the same proposal.
- **Fire Extinguisher monthly form — PASS:** Verified incomplete-completion validation, OK/follow-up/N/A checklist states, required repeatable fields, add/remove/edit of multiple rows, and draft persistence. Simulated work-order creation succeeding while PM linking failed; the UI offered **Retry link**, and retry linked the existing persisted order rather than creating another. Marked the PM complete and verified response values, completion state, link, and both repeatable rows in PostgreSQL.
- **Guest Room Quarterly PM — PASS:** Saved and persisted Green/Clear/Red rankings (final value Red), completed all 75 checklist items with one follow-up, verified missing-date and missing-plan validation, created a linked order, and confirmed date, all 75 response values, follow-up, completion, and link in PostgreSQL.
- **Review & confirm — PASS:** Approved the Daily Maintenance proposal through its confirmation dialog and rejected the Weekly Maintenance proposal; status, reviewer, and timestamp matched the UI in PostgreSQL.
- **Role/API boundaries — PASS for the tested PM operations:** Senior Management read as non-edit/non-review; Technician read as edit/non-review. Viewer POST was 403, malformed technician payload 400, valid technician POST 201, stale revision 409, and Technician review PATCH 403. A correctly role-claimed local authenticated JWT was used for direct PostgREST access; direct PM insertion as Senior Management was denied by PostgreSQL. The disposable stack's standard GoTrue token omitted the PostgREST `role` claim, so the direct RLS check used a locally signed test JWT and did not rely on an application/API denial.
- **Transfer Review CSV — PASS:** Clicked **Download CSV** in a separate local headless Chrome against the running app, enabled Chrome's native download handling, and verified the browser-created file `cmpri-pm-2026-09-28-transfer.csv` (126,600 bytes; 737 data rows). It has the expected nine-column header and contains the persisted Room 101 quarterly completion/follow-up and Fire Extinguisher monthly follow-up. These exported values were independently matched to the corresponding local `cmpri_pm_proposals` rows in PostgreSQL. The integrated browser's Playwright download event was unavailable, but the independent native Chrome file proves browser-to-disk delivery. This export does not write to Google Sheets.

### Attachment outage, retry, persistence, and Storage DELETE

- **Successful create/upload — PASS:** As System Administrator, created `workorder_261004003` from the actual work-order UI with a 68-byte PNG. PostgreSQL contained the work order and exactly one `storage.objects` entry under its work-order prefix with `image/png` metadata and size 68.
- **Direct Storage DELETE — DEFINITIVELY DENIED:** Retested the fresh recovered order's object using the correct local anon API key and correctly signed authenticated JWTs for both Senior Management and System Administrator. Both requests returned HTTP 400 with the Storage body reporting `statusCode: 403`, `AccessDenied`, and “Access denied.” The object row and 68-byte metadata remained in `storage.objects`; inspection of `pg_policies` found no DELETE/ALL policy for `storage.objects`. Thus authenticated application users, including System Administrator, cannot directly delete these objects in this disposable local configuration. There is no application attachment DELETE route. The earlier response was misleading at the outer HTTP layer, but its denial was genuine.
- **Outage reproduction — DEFECT REPRODUCED:** With only the disposable Storage container stopped, created `workorder_261004004`. PostgreSQL confirmed the work order persisted but no object existed. The old UI cleared its retry/error state and displayed only the normal work-order-created message.
- **Underlying fix:** The work-order form now retains the selected image and created order ID after upload failure, explicitly reports the failure, disables duplicate creation/cancel/file replacement while pending, and offers **Retry photo upload**. A validated UUID upload ID is sent to the attachment route and reused on retries; the route maps it to a stable object path and upserts that path, so a response-loss retry cannot create duplicate objects. Successful recovery clears the native file input and resets the form only after the upload succeeds. Network and HTTP failures both remain retryable.
- **Real outage/recovery regression — PASS:** Repeated the real UI test as System Administrator with `workorder_261004005`: stopped local Storage, submitted, observed the upload 503 and persistent **Retry photo upload** control while the issue and file remained selected; restarted Storage and clicked retry. The UI reported completion, cleared the file/form, and PostgreSQL showed exactly one 68-byte `image/png` object under the existing work-order ID. The detail page then rendered its signed attachment.
- **Automated coverage — PASS:** `tests/work-order-attachments.test.mjs` passed **8/8**, including retry after HTTP 503, retry after a network exception, stable upload ID reuse, invalid upload-ID rejection, and upsert behavior. The full suite initially found one stale source assertion about the prior input markup; that assertion was updated to check the separate file/camera controls, retry state, and upload ID behavior. The rerun passed **596/596** Node tests and **6/6** email-parser tests.

### Checks after the continuation fix

| Check | Result |
|---|---|
| Actual repository `npm run build -- --webpack`, with environment values overridden to the disposable local stack and all integrations disabled | Passed; compiled, type-checked, and generated 27 pages |
| `npm test` | Passed: **596/596** Node tests; email parser **6/6** |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed with zero errors and three warnings (two existing `<img>` optimization warnings and one unused test variable) |
| `npm run test:database` using the existing isolated PGlite package | **44/44** checks passed |
| `npm run check:release-schema` against disposable local Supabase REST | Passed; no required tables, columns, or work-order statuses missing |
| `npm run test:http-smoke` | **51/51** unauthenticated UI/API/mutation responses passed against the isolated local production server; not authenticated browser/workflow coverage |
| `git diff --check` for changed source and test files | Passed. The generated `next-env.d.ts` dev-route references are Next-managed and were left intact. |
| PM CSV native browser export | Passed in headless Chrome; file, expected header, 737 rows, sample persisted PM values, and matching PostgreSQL proposals verified |
| Local app after build | Started from the actual production build at `127.0.0.1:3114`; disposable Docker-backed Supabase services and the loopback gateway remain running |

The failed-upload repro order `workorder_261004004` intentionally remains without an attachment as the persisted failure fixture; no cleanup or test-data deletion was performed. The successful object for `workorder_261004005` is the verified recovered state.

### Final local assessment

The two continuation loose ends are closed locally: native PM CSV file delivery is proven, and direct Storage DELETE is conclusively denied for both tested authenticated roles while the object remains. The full repository build and requested local automated checks pass (lint has only the three noted warnings). No hosted Supabase service, production account, live third-party integration, or deployment was contacted.

**Local-only status: NOT READY to call the entire application audit complete.** The stated all-role/all-control coverage is still not exhaustive for every page, field, dropdown option, edge case, and workflow. This final continuation does not imply hosted RLS verification or integration testing. No cleanup, hosted verification, or deployment was performed or authorized. The app remains available at `127.0.0.1:3114`, connected only to the disposable local stack with external integrations disabled.

## Local continuation — atomic controls and regression rerun (2026-10-04)

This pass continued against the disposable local Docker-backed Supabase stack and the actual repository app at `127.0.0.1:3114`. No hosted service, production account, live integration, or deployment was contacted. Disposable test data and local services were left in place.

### Checkbox-like control behavior and persistence

The source inventory found five checkbox-like surfaces: PM routine items, pool-log flags, the User Management temporary-password toggle, Profile notification preferences, and sign-in “Remember me.”

| Surface | Role and action | Result |
|---|---|---|
| PM routine checklist | Maintenance Technician toggled one daily item; local API/database readback showed only `daily-7: true` in that proposal’s response, with sibling responses omitted rather than defaulted. | **PASS**; the same sparse-write rule is enforced by the API and covered by the PM regression tests. This interaction used a browser DOM activation because the integrated browser’s pointer actionability timed out; it was not a trusted physical-pointer event. |
| PM review | Chief Engineer saw the review tab and 12 pending proposals. A valid Engineer review changed one disposable proposal from pending revision 1 to rejected revision 2; the System Administrator then saw 11 queued proposals and `can_review=true`. General Manager’s direct review PATCH returned 403. | **PASS** for the tested reviewer and denial paths. The review mutation remains as test data. |
| PM read-only boundary | General Manager previously rendered 144 disabled checklist controls with `can_edit=false` and `can_review=false`; Technician’s attempt to edit another submitter’s pending proposal returned 409 without changing that proposal. Front Desk, Front Desk Manager, Housekeeping, and the Assistant Manager audit account were denied PM API access. | **PASS** for these observed role boundaries; this does not mean all 144 checkboxes were individually toggled. |
| System Administrator / foreign pending PM item | A pending Chief Engineer daily proposal returned `can_edit_entry=false`; the matching September 28 routine controls were disabled in the System Administrator UI. A direct single-item save attempt returned 409, and a fresh API read showed the proposal remained revision 1 with the same response map. | **PASS**; reviewers can review, but another submitter’s pending entry remains read-only. |
| Submitter PM edit after save | **DEFECT REPRODUCED AND FIXED:** The Maintenance Technician owned a pending October 5 proposal. Saving its second single checkbox correctly persisted only `daily-8`, but the POST response omitted `can_edit_entry`; the UI then disabled that submitter’s remaining controls until reload. Both create and update responses now return `can_edit_entry=true` for the authenticated submitter. Regression tests assert the capability on both API paths; the focused PM suite passed 16/16. After rebuilding/restarting the actual local app, the Technician toggled `daily-9`; only one of 12 daily controls changed, the response returned `can_edit_entry=true`, revision advanced to 3, the persisted response map contained only `daily-7`, `daily-8`, and `daily-9`, and the checkbox remained enabled without a reload. | **PASS after fix**; another user’s pending entries still report `can_edit_entry=false` and remain read-only. |
| Pool-log flags | System Administrator toggled “Attention needed” on the October 4 disposable row. Revision advanced 1→2; `requires_attention=true`, `closure_condition=false`, and existing readings/remarks remained unchanged. The separate closure checkbox then exposed its required reason field; saving advanced revision 2→3, preserved attention, set closure true, and displayed the persisted closed state. | **PASS**; each checkbox changed only its corresponding flag. The reason is the intended dependent field for a recorded closure. |
| Pool-log flags | Maintenance Technician created an October 3 disposable log using one AM sample and required daily readings, then toggled only “Attention needed.” The saved row has revision 1, attention true, closure false, and the selected readings exactly as entered. | **PASS**; UI success matched the local database row. |
| Pool-log role boundary | Chief Engineer saw both flags enabled on an unused date and `can_edit=true`; General Manager saw the saved flags checked and disabled with `can_edit=false`; Front Desk, Front Desk Manager, and Housekeeping direct pool-log API reads returned 403. | **PASS** for these roles. |
| User Management temporary-password toggle | System Administrator checked and unchecked the control. Its conditional password field and submit-button label appeared/disappeared; the user list count did not change and no user was submitted. | **PASS**; no database mutation was made. |
| Profile notification preferences | General Manager changed each of the three notification checkboxes separately and saved after each. A fresh `/api/profile` read after every save showed only the selected key changed; sibling keys and display name were unchanged. | **PASS**; the disposable profile now has all three notification flags false. |
| Submit-only Profile | Front Desk, Front Desk Manager, and Housekeeping saw no notification checkboxes or delivery dropdown; Front Desk’s profile response normalized all notification flags to false. The Assistant Manager audit account maps to `front_desk` per the earlier role pass. | **PASS** for the rendered controls and role mapping. |
| Sign-in “Remember me” | On the unauthenticated sign-in screen, toggled false→true→false. Exactly one checkbox changed; there were no other form inputs until “More…” is opened. No sign-in was submitted. | **PASS** for the local control state; authentication persistence was not tested by this interaction. |

The System Administrator’s October 4 pool row now has a manually recorded closure reason from the checkbox workflow, and the Technician’s October 3 row and the profile preference changes are retained as disposable evidence. No data was cleaned up. These are test records, not operational pool readings or production data.

### Room Operations commit/read-back follow-up

- **Valid date behavior — PASS:** An invalid optional departure date (`2/30/2026`) normalized to blank rather than a false date; the preview displayed no checkout date and no commit was attempted for that malformed input. The API unit test explicitly expects malformed dates to normalize to blank. The valid US date `10/4/2026` normalized to `2026-10-04`.
- **Full import commit — DEFECT REPRODUCED:** As the Maintenance Technician, previewed all active rooms (101, 102, and MGR) and committed the complete October 4 snapshot. The server returned a successful RPC, and a fresh authenticated API read confirmed all three rows persisted; Room 102 had `checkout_date=2026-10-04`, `checkout_time=11:00:00`, and the submitted guest data. However, the UI showed a commit error because its read-back check compared the validated display time `11:00 AM` directly with PostgreSQL's equivalent `11:00:00`. This was a false error after a successful database mutation; retrying could replace the same-day snapshot again.
- **Root-cause fix and regression — IMPLEMENTED / UNIT-VERIFIED:** Snapshot verification now canonicalizes 12-hour display times and PostgreSQL time values before comparing checkout and arrival times. `tests/room-operations.test.mjs` exercises actual snapshot equality for `11:00 AM` versus `11:00:00` and confirms a genuinely different persisted time still fails. Focused tests pass 16/16 and diagnostics report no errors. A post-fix browser commit verification remains pending until the actual local app is rebuilt/restarted.
- **Test data:** The successful October 4 full room snapshot remains in the disposable local database, as requested. No cleanup was performed.

### Maintenance Technician and Chief Engineer follow-up

- **Maintenance Technician work-order list — PASS:** Opened all eight list filters (Awaiting Approval, Open, In Progress, Urgent / High, Overdue, Completed, Closed, and All); their selected-state and displayed row counts matched the dashboard counts (0, 18, 0, 3, 0, 2, 0, and 20). Searching for `workorder_261004012` returned that single row and excluded `workorder_261004011`; clearing search restored the list. The previous Technician profile, room edits, validation cases, and Room Operations previews remain recorded above.
- **Chief Engineer dashboard — PASS for tested access surface:** `/api/session` returned Engineer capabilities including work-order review/close, asset/room/user management, and integrations. The rendered launchers included the corresponding work-order, operations, asset, room, user, feedback, profile, and ChatGPT destinations. No authorization bypass or mismatched launcher was observed in this check.
- **Chief Engineer user management — PASS for view/invite controls:** Opened the embedded Manage Users view; it loaded 17 active test accounts, with editable role/deactivate/delete controls only for manageable non-engineer accounts and engineer/admin accounts shown view-only. Exercised each of the six offered invitation roles (Maintenance Technician, Front Desk, Assistant Manager, Front Desk Manager, Sales Manager, Lead Housekeeper) without submitting an invite. Empty required name/email fields and malformed email were rejected by browser validity; user count remained 17. No user data was changed.

### Front Desk Manager work-order and draft workflow

- **Capability/launcher boundary — PASS:** The Front Desk Manager session reported only `submit`, `submit_feedback`, and `view_profiles`; its landing page was `/work-orders`, with no Engineering dashboard launcher navigation. Category and priority controls were disabled for this submit-only account. The work-order list GET returned 403, consistent with the role's lack of dashboard-read capability.
- **Room dropdown — PASS:** Opened the location selector and individually selected all three active local choices: Audit Boiler Room, Audit Room 101, and Audit Room 102. Each selection appeared in the room field, showed the current room condition where applicable, and kept the no-asset selector disabled when no asset was available.
- **Validation — PASS:** The blank submission kept focus on the required first-name field; DOM form validity independently showed required first name, room, and issue. Attempting Save Draft with no room/issue showed the explicit “Select a room/location and enter the issue” validation message and made no draft request.
- **Draft create/update — PASS:** Created a local draft for Audit Room 102. The POST response and authenticated draft-list readback matched room, submitter, issue, category, and priority. Updated issue and notes; PATCH returned revision 2 and a fresh draft-list read matched the edited values.
- **Draft submit and persisted work order — PASS:** Submitted the saved draft through the UI. The application returned `workorder_261004014` with `Pending Verification`, and the draft disappeared from the owner’s draft list. The standard work-order list API correctly denied this submit-only role; direct read-only PostgreSQL verification confirmed the exact work-order display ID, status, and issue persisted. No cleanup was performed.
- **Attachment validation/retry — PASS for the tested route:** A submission matching an existing ticket was rejected with HTTP 409 and an explicit possible-duplicate message; the selected PNG remained attached in the form. After selecting the distinct Audit Boiler Room location and a distinct issue, the same staged file was successfully submitted as `workorder_261004015` (`Pending Verification`). PostgreSQL `storage.objects` contains exactly one matching work-order image object with `image/png` metadata and 49,600-byte size. The owner's attachment API returned one image; its signed URL loaded as a browser image at 881×804. A raw cross-origin `fetch` of the signed URL was blocked by browser CORS, but the actual image load succeeded; the signed URL was not exposed.

### Housekeeping, Assistant Manager, and Front Desk continuation

- **Housekeeping role/API boundary — PASS:** `/api/session` reported only submit, feedback-submit, and profile-view capabilities; manually navigating to `/engineering` returned to `/work-orders` without dashboard launchers. Preventive-maintenance read and attachment access to another user's order both returned 403.
- **Housekeeping form — PASS for tested controls:** Blank submission identified the required room field; blank Save Draft showed the explicit room/issue validation. Individually selected all three active location options, then submitted a complete request with an optional valid PNG. UI reported `workorder_261004016`; direct PostgreSQL read confirmed `Pending Verification`, room, and issue. The owner's attachment list returned one PNG and PostgreSQL confirmed one corresponding `storage.objects` entry with `image/png` and 49,600-byte metadata.
- **Assistant Manager role mapping and request — PASS:** The local Assistant Manager account is represented as primary role `front_desk` with no secondary roles and only submit, feedback-submit, and profile-view capabilities. Its Engineering dashboard navigation redirected to `/work-orders`, and its PM request returned 403. The required first-name, room, and issue controls were populated; the UI created `workorder_261004017`, and PostgreSQL confirmed the pending-verification state, room, and issue.
- **Front Desk role/API boundary — PASS:** The role likewise had only submit, feedback-submit, and profile-view capabilities; PM read and work-order list API requests returned 403. It could not read a different submitter's attachment (403). The existing Front Desk draft was loaded and its four saved form values matched the UI; no draft data was changed.
- **Front Desk submit — PASS:** First name, room, and issue were required; Category/Priority remained disabled for submit-only use. The role submitted `workorder_261004018`; the local database readback confirmed its `Pending Verification` state, room, and issue.
- **Front Desk profile — PASS:** Independently saved Spanish/English and Light/Dark selections and verified each via `/api/profile`, then restored English/Dark. All three notification preferences remained false throughout, and the profile rendered zero notification checkboxes. ChatGPT connection UI is visible for this submit-capable role; the account's `submit` capability is explicitly accepted by the corresponding connection API. No OAuth flow was initiated.

### General Manager review and read-only surfaces

- **Role/capability boundary — PASS:** The General Manager session reported `view_dashboard`, `review_tickets`, `manage_users`, and profile/submission capabilities, but not `edit_tickets`, `manage_rooms`, or `operate_integrations`. A valid-week PM read returned `can_edit=false` and `can_review=false`; pool-log read returned `can_edit=false`; work-order import and room PATCH requests returned 403. The “Manage Rooms” launcher opens a genuinely view-only page with disabled room fields, while room/work-order/PM data can be read under dashboard access.
- **Ticket approval — PASS:** The General Manager opened Assistant Manager request `workorder_261004017`, used “Approve → Open,” then explicitly saved. The API returned 200 and revision 2; direct PostgreSQL readback confirmed `Open`, revision 2, and the original issue. The save recorded the reviewer and status transition in ticket notes/history.
- **Pool Log / Room Operations — PASS for checked read-only state:** The saved pool log displayed its recorded closure warning; sample and flag controls were effectively disabled by the disabled fieldset, and only history/print/reload viewing controls remained. Daily Room Ops showed the three persisted room cards and counters but no import/upload controls for this role.
- **DEFECT REPRODUCED / FIXED; browser verification pending:** After approval moved the work order out of `Pending Verification`, the General Manager (review-only, no `edit_tickets`) could still type and click “Submit Note.” The UI appended the note locally, but there was no Save Work Order action in that state and PostgreSQL remained unchanged after the click. `canSubmitWorkOrderNote` now allows editing roles at any status and review-only roles only while the ticket is still pending review; both the textarea and submit button use that policy. The new regression test covers pending review, other ticket states, editors, and unauthorized roles; `tests/work-order-access.test.mjs` passes 64/64. Actual browser confirmation after rebuilding the local app remains pending.

### Full local regression rerun

| Check | Result |
|---|---|
| Actual-repository production build, `npm run build -- --webpack`, with disposable local Supabase keys and integrations in safe mode | **PASS**; Next.js 16.3.5 compiled, type-checked, and generated all 27 pages. |
| `npm test` | **PASS: 598/598** Node tests; its email-parser phase also passed **6/6**. |
| `npm run test:email-parser` | **PASS: 6/6**. |
| `npm run typecheck` | **PASS**; the production build also completed its TypeScript check. |
| `npm run lint` | **PASS**, zero errors and three warnings (two existing `<img>` optimization warnings and one unused test variable). |
| `npm run test:database` using the existing isolated PGlite installation | **PASS: 46/46** migration/behavior checks. It does not reproduce Supabase RLS or real concurrent sessions. |
| `npm run check:release-schema` using the loopback local gateway and a locally signed disposable service-role JWT | **PASS**; `missing: []`. This is a read-only schema contract check, not an RLS test. |
| `npm run test:http-smoke` after the production build | **PASS: 51/51** unauthenticated HTTP checks; it is not authenticated browser/workflow coverage. |
| `git diff --check` | **PASS**. |

### Remaining status

The PM submitter editability defect was fixed and regression-tested in this continuation. The historical fixes and this control-level evidence do not complete the requested exhaustive audit: not every individual PM item, field, dropdown option, validation branch, modal, page, and workflow has been interacted with under every role. Hosted RLS and third-party integrations remain intentionally unverified. **Local audit status remains NOT READY to call the entire application audit complete or ready for deployment.** No hosted verification, deployment, or cleanup was performed.

## Local continuation — user provisioning, profile controls, and direct RLS (2026-10-04)

This continuation used the actual repository production build at `127.0.0.1:3114`, the disposable Supabase Docker stack, and the loopback-only role bridge. `CMPRI_INTEGRATIONS_SAFE_MODE=true` remained enabled. No hosted endpoint, external integration, or production account was contacted. Existing disposable data and services were not cleaned up.

### Defect reproduced and fixed: new Auth users lacked the database role claim

- **Reproduction:** The System Administrator created a local password-mode user through the actual User Management form. The profile and membership were persisted, but `auth.users.role` was empty. A GoTrue password sign-in consequently produced a JWT with `role=""`; direct PostgREST rejected that claim with `role "" does not exist`.
- **Root cause and fix:** The password-mode `createUser` request now explicitly assigns the Auth database role `authenticated`. For invitation-based creation, the route sets that role through the Auth Admin `updateUserById` API before writing the CMPRI profile and membership. If role assignment fails or is unavailable, account setup reports the error and runs the existing rollback path. The UI/API authorization model remains unchanged.
- **Regression coverage:** `tests/user-access.test.mjs` now checks the role on password-mode creation, the invited-user role update, and rollback behavior for both role-update failure and missing Auth Admin support.
- **Actual local verification:** Built and restarted the actual repository. Created a new Technician from the UI using the temporary-password option. PostgreSQL showed profile role `technician`, active property membership, and `auth.users.role='authenticated'`. A real local Auth password login returned a JWT with role `authenticated`; direct REST access to `room_operations` returned the six authorized rows. A pre-fix disposable account was corrected locally to `authenticated` after preserving the observed failure. Both accounts remain in the local database; no email invitation was sent by the password-mode flow.

### Profile, sign-in, and user-management controls

- **Profile role presentation — PASS:** Browser-rendered the profile as Chief Engineer, General Manager, Maintenance Technician, Front Desk, Front Desk Manager, Housekeeping, Assistant Manager, and System Administrator. Engineer, GM, Technician, and System Administrator had three notification checkboxes and three preference dropdowns. Submit-only roles had no notification checkboxes/delivery dropdown and no sign-in-email field; the Assistant Manager test profile resolves to Front Desk. User Management appeared for Chief Engineer, GM, and System Administrator, not Technician or submit-only roles.
- **Profile checkbox atomicity and persistence — PASS:** As System Administrator, individually toggled each notification checkbox in both directions. After each save, UI state changed at exactly one index and a fresh profile API/database read showed only that preference key changed. The original values were restored and confirmed in PostgreSQL.
- **Profile dropdown options — PASS:** Saved and read back English/Spanish, Dark/Light, and all three notification modes (`in_app`, `email`, `both`). Language and appearance were also reflected in the document settings. Original preferences were restored. Blank and 201-character display names were rejected without changing the persisted profile.
- **User Management route boundary — PASS for tested roles:** Chief Engineer, General Manager, and System Administrator saw the page and received API 200. Technician, Front Desk, Front Desk Manager, Housekeeping, and Assistant Manager were redirected away; direct API GET returned 403.
- **User Management controls/workflow — PASS:** Selected each of the ten assignable role options. The temporary-password checkbox independently showed/removed its password field. Required name/email, malformed email, and short-password validation prevented submission; the short-password attempt generated no POST. A valid password-mode account was created without an invitation. The test account's role was changed Technician→Front Desk→Technician and deactivated/reactivated; API reads showed each transition and the final state is active Technician. The two created test accounts remain; no deletion was performed.
- **Sign-in and Remember me — PASS for local password authentication:** An invalid password returned 400, showed the expected error, and created no stored session. A valid local password sign-in with Remember off stored the session only in `sessionStorage`; a second tab stayed signed out. Remember on stored it only in `localStorage`; a second tab restored the Technician session. Sign-out cleared both session stores and the remember preference. The logout requests were aborted by the immediate post-sign-out navigation after client storage had been cleared; this was expected navigation behavior, not an unexplained application 5xx.
- **Session refresh/CORS — PASS:** The loopback proxy's preflight returned 204 with `Access-Control-Allow-Origin: http://127.0.0.1:3114`. Forcing the local session near expiry and loading the sign-in route renewed it to a one-hour session; `/api/session` returned 200 and the user landed on the expected role destination.

### RLS, work-order boundary, and input validation

- **Room Operations direct RLS — PASS for all eight implemented roles:** Direct PostgREST reads of both `room_operations` and the security-invoker `cmpri_room_operations` view returned six local rows for Chief Engineer, General Manager, Technician, and System Administrator; Front Desk, Front Desk Manager, Housekeeping, and Assistant Manager received zero rows. Direct POST, PATCH, and DELETE attempts against the base table returned 403 for every role. Queries for the fixture in the second property returned zero rows for all roles against both table and view.
- **General Manager note boundary after the actual rebuild — PASS:** On a persisted Open work order, the Technician Notes editor and Submit Note button were disabled. A forced click produced no mutation request. Authenticated activity readback and PostgreSQL both remained at the same two history entries (`created`, `status_changed`).
- **Work-order ID behavior — PASS:** For detail, activity, and attachments routes, malformed `not-a-uuid` returned 400; a syntactically valid nonexistent UUID returned 404; the valid local work-order UUID returned 200. The 400/404 browser console entries correspond to these deliberate inputs, not unexplained service failures.

### Regression results after the latest source changes

| Check | Result |
|---|---|
| Actual-repository production build (`npm run build -- --webpack`) | **PASS**; Next.js 16.3.5 compiled and generated all 27 pages. The rebuilt app was started locally with disposable Supabase credentials and safe integration mode. |
| `npm test` | **PASS: 607/607** Node tests; its email parser phase passed **6/6**. |
| `npm run test:email-parser` | **PASS: 6/6**. |
| `npm run typecheck` | **PASS**. |
| `npm run lint` | **PASS**, zero errors and three warnings (two existing `<img>` warnings and one unused test variable). |
| `npm run test:database` | **PASS: 49/49** PostgreSQL migration/behavior checks. PGlite does not reproduce hosted RLS or broad real concurrent-session behavior. |
| `npm run check:release-schema` | **PASS**, local read-only check with `missing: []`. |
| `npm run test:http-smoke` | **PASS: 51/51** unauthenticated HTTP checks; not authenticated UI workflow coverage. |
| `git diff --check` | **PASS**. |

### Remaining status and deployment readiness

The latest checks verify the fixes above but do **not** close the exhaustive audit. Every control, meaningful dropdown option, field combination, page/modal, attachment edge case, and workflow has still not been individually exercised under every applicable role. The work-order/pool/PM/attachment suites cover important workflows, but they are not a complete per-control seven-role run.

Hosted Supabase configuration/RLS remains **blocked by the explicit no-hosted-access instruction**; no claim is made about hosted deployment state. External integrations remain **blocked from safe verification** because the local app is in safe mode and no live credentials or services may be used. Broad concurrent-session and cross-property CRUD coverage for every data table remains incomplete; the direct room-operations isolation matrix above is only for that surface. **Local and deployment readiness: NOT READY to declare the full requested audit complete or the application ready for deployment.** No hosted changes, deployment, or cleanup occurred.

## Local continuation — fresh role sessions and PM launcher parity (2026-10-04)

To avoid treating stale sessions as valid test evidence, the eight disposable role accounts were given fresh local-only passwords and signed in through the actual application form. The test credentials and data remain confined to the local disposable Auth/PostgreSQL stack; no account was deleted. The expired/revoked General Manager browser token had a `session_id` absent from its remaining `auth.sessions` row and was correctly rejected with 401 (`Auth session missing!`). The sign-in page displayed “Please sign in again”; signing in again restored `/api/session` and PM requests to 200. This was a stale local Auth session, not an unexplained 5xx or an RLS bypass.

### Fresh authenticated role matrix — PM destination/API/UI

| Role | Landing / engineering launchers | Direct PM GET | PM capability response | Browser verification |
|---|---|---:|---|---|
| Chief Engineer (`engineer`) | `/engineering`; Preventive Maintenance launcher visible | 200 | edit **yes**, review **yes** | Opened the PM workspace; after its records loaded, 108 of 144 visible daily/form status controls were enabled, 36 disabled. |
| General Manager | `/engineering`; Preventive Maintenance launcher visible | 200 | edit **no**, review **no** | PM weekly status controls were disabled. All **60** visible Inspection Forms and all **112** Guest Room Quarterly PM forms were opened; every form had zero enabled fields/actions (excluding Close and the non-mutating linked-work-order action). Transfer Review exposed CSV download but no review actions. |
| Maintenance Technician | `/technician`; no engineering dashboard launcher | 200 | edit **yes**, review **no** | The work-order detail’s **Open Preventive Maintenance** link opened the PM frame. Its loaded status controls included both editable and locked items (72 enabled, 72 disabled); no review capability was returned. |
| Front Desk | `/work-orders`; no engineering launchers | 403 | no PM data/capability returned | Direct PM request denied. |
| Front Desk Manager | `/work-orders`; no engineering launchers | 403 | no PM data/capability returned | Direct PM request denied. |
| Housekeeping | `/work-orders`; no engineering launchers | 403 | no PM data/capability returned | Direct PM request denied. |
| Assistant Manager | `/work-orders`; no engineering launchers | 403 | no PM data/capability returned | This implementation maps Assistant Manager to primary role `front_desk`; no distinct Assistant Manager capability exists locally. |
| System Administrator | `/engineering`; Preventive Maintenance and Room Ranker launchers visible | 200 | edit **yes**, review **yes** | PM workspace exposed **Review & confirm (9)**; after load, 72 status controls were enabled and 72 disabled. |

The engineer/GM/System Administrator launcher labels were also compared with each session’s returned capability set. Their launcher sets matched the code’s corresponding capability checks for dashboard, assets, rooms, users, feedback, and Room Ranker. The Technician has no engineering dashboard launcher, but the work-order detail supplies its PM link and the destination/API grant edit without review. The four submit-only roles had neither an engineering launcher nor PM API access. `Connect ChatGPT` is gated by `view_profiles` (a self-profile destination), not `operate_integrations`; no OAuth or external integration was initiated.

These are focused UI/API parity checks—not proof that every engineering launcher destination, every field, or every role-specific action has been exhausted. All 112 General Manager quarterly forms were opened and their actual Close handlers were invoked; the browser automation could not verify physical pointer/keyboard activation of that Close button because the desktop windows overlapped and the locator never became stable. No completion/review data was changed. The 60 Inspection Form modals were opened and closed normally. PM role gating is verified for this route, while full control-by-control coverage remains open.

## Local continuation — Enseo and purchasing role checks

- **Enseo controls and authorization:** General Manager loaded the Enseo page read-only (`can_manage=false`); a direct PATCH returned 403 and the assignment/history readback was unchanged. Maintenance Technician had `can_manage=true`. Reusing the two local TV/STB fixtures, the UI rejected a duplicate device in a two-row batch without a write; a valid paired move then persisted both rows with the same batch ID, confirmed directly in PostgreSQL. A Technician paired move also persisted as one shared batch. The one-device save path was verified separately.
- **Defect fixed — Enseo success feedback:** The successful save message was immediately erased by the post-save reload. The page now waits for a successful refresh before showing its save confirmation and preserves refresh errors. The focused Enseo page-state tests pass **5/5**; the actual local production build passed; a rebuilt-browser save displayed “Saved 1 device assignment as one atomic move batch.” PostgreSQL confirmed the matching assignment at revision 7 and its history entry.
- **Purchasing read-only boundary:** General Manager loaded the page with `can_edit=false`, saw no mutation controls, and received 403 from a direct status PATCH. The local purchase count remained zero.
- **Safety halt — live mailbox provider contact:** Maintenance Technician’s “Scan Email Now” was clicked while testing the purchasing safe-mode state. The UI returned “Mailbox provider request failed (400).” The server-side email adapter raises that exact error only after an HTTP request to its Microsoft or Google OAuth/provider endpoint receives a non-2xx response; therefore this was **not local-only**. The specific provider is not recorded, and it is unknown whether credentials were accepted. The PostgreSQL counts for imported email events and purchases remained zero. The app process was stopped immediately. Treat mailbox OAuth credentials available to that process as potentially disclosed and review/rotate them through the authorized provider owner if they are valid.
- **Audit status at the time:** This incident violated the local-only test boundary. The local app was stopped immediately; no hosted Supabase change or deployment occurred. The audit remained **INCOMPLETE / NOT READY**.

## Local continuation — safe-mode boundary and Parts & Vendors (2026-10-05)

- **Safety defect fixed — mailbox scan ignored safe mode:** The local safe-mode switch did not guard `/api/integrations/email/scan`, allowing the UI action to reach a configured external provider. The route now returns an explicit 503 blocked response before constructing the database client or invoking the provider whenever safe mode is enabled. The Purchasing API exposes `safe_mode`; the browser disables the scan button and explains that no provider will be contacted. The authenticated route regression asserts 503, `blocked: true`, and zero provider calls. Email/provider and session-revocation focused suites pass **58/58**; after adding Enseo coverage, the combined focused suites pass **63/63**. A local rebuild passed. The Maintenance Technician browser read showed `safe_mode=true`, a disabled scan button, and direct POST returned the expected blocked 503. Browser requests observed in that check were only to `127.0.0.1:3114`.
- **Parts & Vendors role matrix:** Direct local catalog GET returned 200 with data only for Chief Engineer, Maintenance Technician, and System Administrator. General Manager, Front Desk, Front Desk Manager, Housekeeping, and Assistant Manager received 403. Purchasing GET returned 200/read-only (`can_edit=false`) to General Manager; Chief Engineer, Maintenance Technician, and System Administrator received 200/edit; the four submit-only roles received 403.
- **Parts & Vendors UI workflow:** Maintenance Technician exercised the vendor form’s required state and populated services, phone, email, and website; contact creation required a selected vendor and saved title, mobile, and email; inventory creation saved vendor, SKU, manufacturer, quantity, reorder threshold, suggested quantity, unit cost, storage location, and equipment compatibility; order-idea creation saved quantity and selected inventory/equipment associations. PostgreSQL-backed API reads verified each record.
- **All order-idea workflow states:** The UI transitioned a disposable idea through Idea → Ready To Order → Ordered → Received, and a second idea to Dismissed; readback confirmed each status. All four vendor recommendation options (Repair, Replace, Repair Or Replace, Other) were selected and stored. A negative quote was rejected with `Quoted cost is too small.` and created no proposal. UI approve and decline actions persisted Approved and Declined and displayed their confirmations.
- **Local disposable database schema alignment:** The vendor form initially failed because the running disposable database lacked columns already required by the repository migration `20261004090000_cmpri_vendors_website.sql`. After verifying the migration is additive and idempotent, applied that migration to the disposable database only; website/notes/link columns then matched the repository. Vendor creation was retried successfully. No hosted database was contacted. Test fixtures remain in local storage/database as requested.
- **Purchasing workflow:** Seeded a disposable local purchase and shipment. As Maintenance Technician, exercised shipment Shipped → Delivered → Received and purchase Ordered → Received → Installed / Used → Complete; every visible action displayed a confirmation, API read-back matched, and direct PostgreSQL showed final purchase `Complete`, shipment `Received`, and matching delivered/received timestamps. The intermediate parent `Received` status correctly remained distinct from per-shipment status.
- **Remaining scope:** The role-by-role browser checklist still has untested controls, destinations, and workflows. The final full local regression has not been rerun after these latest changes. Do not treat this continuation as audit completion or deployment approval.

## Local continuation — equipment and room controls (2026-10-05)

- **Chief Engineer room edit/save — PASS:** Changed Room 101's Area through the actual Rooms & Locations form, verified the success message and the updated record through the authenticated local API, then restored the original value and verified the restored record. A malformed room number (`101!`) was submitted through the UI; the page surfaced the server validation error and API readback confirmed the stored room number remained `101`.
- **Room role boundaries — PASS for tested roles:** General Manager saw the View-only state; the room-edit fieldset and all four inputs matched `:disabled`, direct PATCH returned 403, and the room's original Area remained unchanged. Maintenance Technician's form and all four fields were enabled and its authenticated API response set `can_edit=true`. Front Desk, Front Desk Manager, Housekeeping, and Assistant Manager each received the engineering-access denial, rendered no room fields or save control, and received 403 from `/api/rooms`.
- **System Administrator rooms — PASS for tested controls:** The form exposed editable fields; `/api/rooms` returned `can_edit=true` and `can_manage_corporate_pm=true`. Selecting Room 102 changed the displayed room and all four input values to that record; selecting Room 101 returned the selection. The corporate PM tracker link was present. No room data was changed during this check.
- **Technician equipment — PASS for read-only behavior:** Search revealed the local Audit Boiler and Enseo fixture choices. Selecting Audit Boiler displayed its equipment/documentation details, but every equipment field was disabled and no edit, save, PDF upload, or documentation-verification action was available; `/api/assets` returned `can_manage=false`.
- **Chief Engineer equipment fields/save — DEFECTS REPRODUCED, FIXED, AND RETESTED:** All nine equipment fields were editable for the Chief Engineer. Saving the untouched Audit Boiler first exposed a real issue: the UI sent blank `serial_number` as `null`, and PostgreSQL rejected the PATCH with a not-null constraint error; the local row remained unchanged. The PATCH API now persists blank manufacturer/serial values as empty strings, matching equipment creation. The Equipment page also showed “Equipment saved.” before calling a refresh helper that immediately cleared it; success now appears only after the refreshed list succeeds, and verification confirmation follows the same rule. A validly typed install year of `2100` had `max=2200` in the browser but was rejected by the API (HTTP 400); the UI/API now share one current-year-plus-one parser, the input max uses that same limit, and save rejects invalid values before sending a PATCH. Automated regression coverage checks empty optional-value PATCH, no-write rejection beyond the next year, shared year boundaries, refresh-before-confirmation ordering, and UI validation; `asset-access` passes **52/52**. After rebuilding/restarting the actual local app, the Engineer saved the unchanged fixture through the UI; PATCH and refresh both returned 200, “Equipment saved.” remained visible after refresh, and API readback matched all original operational values. The invalid-year browser case then reported the explicit validation message with zero PATCH requests; the maximum valid year (`2027`) saved and read back, and a subsequent save restored the original null install year. Both successful save messages persisted after refresh.
- **Documentation dialog controls — PASS for safe validation only:** The Add Documentation dialog accepted only PDF, and `Upload & Read` was disabled without a file. “Confirm with Documentation & Lock Fields” was disabled when no documentation existed. No upload, document extraction, or verification action was attempted.
- **General Manager work-order cancel flow — PASS:** Entered unsaved issue text, opened the cancel confirmation, selected Keep Editing and verified the text remained, then confirmed cancel. The form closed back to the Engineering dashboard. Reopened the submit page and verified the existing three saved drafts were unchanged and the unsaved test issue was absent from the authenticated draft list.
- **General Manager create-form controls — PASS for exercised choices/validation:** Opened See more on Room / Location and individually selected all three available local rooms; selected the only room-scoped asset offered for Room 101. Individually selected all 12 categories and all four priorities, verifying each displayed value. Blank Create Work Order was blocked by required-field validity with no POST; Save Draft showed its explicit room/issue validation and also made no POST. Confirm Cancel returned to `/engineering`; authenticated readback showed the same three pre-existing subordinate drafts and no new draft.
- **Front Desk work-order cancel flow — PASS:** Entered unsaved issue text, confirmed Keep Editing preserved it, then confirmed cancel. Unlike the manager landing page, the submit-only user remained on `/work-orders` with the form reset. The authenticated draft list remained empty before and after; no test request or draft was created.
- **Room Operations post-fix browser commit — PASS:** As Maintenance Technician, pasted two CSV-style reports for the three active local rooms on fresh date `2026-10-05`; preview validated all three rows and showed Room 102 checkout at `11:00 AM`. Committed through the actual UI; it displayed “3 merged room-operation rows were saved and verified” with import ID `6408d035-a844-4196-bc52-e8c5772fd920`. The component's immediate read-back and a separate authenticated `/api/room-operations?date=2026-10-05` read agreed on all persisted fields, including PostgreSQL's canonical `11:00:00`. Inputs cleared and the page rendered three rooms. This closes the previously pending browser verification of the time-normalization fix. The snapshot is retained as disposable audit data.
- **Audit status:** The equipment PATCH nullability, success-message ordering, and install-year validation defects were fixed and retested in the rebuilt local app. The temporary room-area and install-year changes were restored; the newly created Room Operations snapshot is retained as documented disposable test data. These checks cover only the listed controls and roles; the exhaustive browser/API pass and the post-change full local regression remain incomplete. No hosted service, external provider, or deployment was used.

## Local continuation — pending work-order draft authorization (2026-10-06)

- **Finding — General Manager could modify or delete another submitter's pending draft:** The General Manager draft list exposed “Load to Submit” and “Delete” for Front Desk and Assistant Manager drafts. The API also allowed a General Manager to PATCH or DELETE those drafts and to submit a work order from another user's draft. This violated the user's rule that other users' pending items remain read-only and only the submitter or an Engineer/System Administrator reviewer can edit them. **Severity: Medium**; a manager could alter or remove a submitter's unsubmitted maintenance report and could submit it while preserving misleading creator attribution.
- **Reproduction:** Sign in locally as General Manager; open `+ Create Work Order`; inspect the Saved Drafts list. Before the fix, subordinate drafts offered Load/Delete. Authenticated PATCH, DELETE, and POST-with-source-draft requests were then tested against the local API. The pre-fix cross-user draft management capability was also exercised in the prior local audit, including a UI deletion.
- **Fix:** General Managers with dashboard access now see other users' drafts as read-only. Only the submitter or a role with `review_tickets` (Engineer/System Administrator) receives edit/delete controls. Draft PATCH/DELETE and work-order submission from a foreign draft enforce the same server-side boundary; the UI guards the read-only action as well.
- **Verification:** The focused draft-authorization suite passes **4/4**. In the rebuilt local app, General Manager's foreign draft row rendered “Read-only” and API responses marked `can_edit=false` / `can_delete=false`. Direct PATCH, DELETE, and source-draft submission each returned 403; authenticated API readback and direct PostgreSQL query confirmed the draft issue and revision remained unchanged. As Chief Engineer, reviewed and edited the Assistant Manager's disposable draft through the actual UI; API readback showed the temporary test text at revision 5, then the original issue restored at revision 6. Direct PostgreSQL readback confirmed the final original issue and revision 6. No production or hosted service was contacted.
- **Audit status:** This closes the cross-user work-order draft permission defect only. The requested seven-role end-to-end checklist, System Administrator coverage, and final full local regression remain incomplete. Provider settings were explicitly blank in the local app process; no external integration route was opened or invoked.

## Local continuation — 13-role create-mode checks and final gates (2026-10-05)

All requests in this continuation targeted the loopback application and disposable Supabase stack. The app was built with the safe-integration flag enabled, live PM writes disabled, provider credentials blank, and Supabase endpoints set to `127.0.0.1`. No deployment, push, hosted-service request, or attachment deletion occurred.

- **Role-specific create-form data APIs — PASS:** Called the exact `GET /api/rooms?mode=create` and `GET /api/assets?mode=create` routes used by the work-order form, under each of the 13 authenticated disposable role accounts. Engineer, Chief Engineer, Engineering Manager, Maintenance Technician, Technician, Regional Maintenance, General Manager, Front Desk, Front Desk Manager, Housekeeping, Lead Housekeeper, and System Administrator each received 200 with the three local locations and four local equipment entries. Senior Management, which lacks `submit`, received 403 from both APIs. This supplements—not replaces—the separate management-mode API checks.
- **Front Desk Manager browser form — PASS for exercised controls:** Reused the one existing browser page. `/api/session` returned `front_desk_manager`, its `/engineering` landing and launcher set matched current behavior, and `+ Create Work Order` opened the actual embedded form. The shared-account first-name field, location, and issue were required; the two attachment inputs accepted images. The saved foreign drafts were rendered read-only. Attempting an empty submit activated browser validation and emitted no work-order POST. This did not test a successful Front Desk Manager submission.
- **Previously collected role and security evidence retained:** The 13-account authenticated direct-API matrix covered 17 routes per role; unauthorized routes failed closed. Capability-derived engineering launcher comparisons had no recorded mismatches. Direct local PostgREST work-order reads returned no other-property rows. A real local revision race produced one 200 and one 409; the original work-order issue was restored and verified. Attachment upload, list, signed read, cross-role/unauthorized checks, invalid signatures/types, and the 10 MB limit were exercised locally. Attachments remain permanent; no delete endpoint was found or invoked.
- **Final automated verification after the current source state — PASS:** `npm run build` (Next.js 16.3.5, all 27 routes generated); `npm test -- --test-concurrency=2` (**643/643**, zero failures or skips; email parser **6/6**); `npm run typecheck`; `npm run lint` (zero errors, three warnings: two existing `<img>` optimization warnings and one unused test variable); `npm run test:database` (**51/51** PostgreSQL migration/behavior checks in isolated PGlite); and `npm run check:release-schema` against the disposable loopback PostgREST endpoint (`passed: true`, `missing: []`). The release check is read-only. PGlite does not establish hosted RLS behavior or reproduce broad concurrent-session behavior.
- **Browser teardown observation:** After the app process was intentionally stopped for the final build/regression run, the still-open test page's periodic `/api/work-orders` polls logged `ERR_CONNECTION_REFUSED`. This was the expected effect of stopping the loopback server, not a request made during the form-validation interaction; local browser storage was cleared and the page navigated to `about:blank` afterward.
- **Disposable cleanup — PASS:** The app and loopback gateway were stopped. The exact four named audit containers were verified to have no mounts, then removed with their audit-only Docker network; this removed the disposable Auth users, database rows, and Storage objects. Ports 3200 and 55555 have no listeners. The browser's local/session storage was cleared, the single test page is `about:blank`, the staged audit password was removed from the clipboard, and the temporary test-output log created during this continuation was deleted. The unrelated container was not touched.
- **Changes in this continuation:** No application source or test code was changed; this audit report is the only file updated for this continuation. No new application defect was established by the added create-mode and Front Desk Manager checks.

### Remaining unverified scope and readiness

This evidence still does **not** prove the requested exhaustive browser coverage: every launcher destination, button, form combination, modal action, state transition, and successful workflow has not been exercised for every applicable role with a database read-back. The Front Desk Manager submit was validation-only; not every create-capable role received a successful browser-created record in this continuation. The 17-route matrix does not cover every API/resource/table or every CRUD permutation. Current attachment checks prove the listed local cases, not every possible file parser/storage failure. External integrations were deliberately disabled and remain untested. Hosted Supabase schema/RLS is unverified and was outside scope; the disposable local schema gate is not evidence about the hosted project.

The earlier audit report also records an accidental Microsoft/Google mailbox-provider request in a prior audit attempt, followed by a safe-mode fix. That incident is retained as a disclosure; it is not evidence of a request during this continuation. Some seeded audit fixture timestamps are later than this continuation's date, so those timestamps are not relied upon to establish when an action occurred.

**Final status: NOT READY.** The automated build and listed regression gates passed, but the user-requested exhaustive role-by-role browser/API/database audit is not complete, hosted RLS is unverified, and external integrations were intentionally not contacted. No deployment authorization is implied.
