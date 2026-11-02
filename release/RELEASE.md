# Manage Locations release candidate

Status: prepared for review; not deployed. Local branch: release/manage-locations. Base: cb9e7a6578324d40326d6ab2cc2bfce934ded25f, verified as the production alias www.cmpri-engineering.com. Vercel deployment dpl_5EhqQA44opsW63kV9Rf32rYRMvEN; project prj_whEgKPb9wsTvK2fVJuADsRnoXg1N; team team_TethDuMGKLLxaQAOJAToTPgc (Hawkeye Hotels).

## Real application integration

The accepted 4176 components and styling are integrated into the Next.js app, not shipped as the isolated Node preview server. No preview adapters, fake auth, preview-state files, operational source snapshots, or local-only endpoints are in the release.

- /management/rooms retains its route and existing client access gate. It displays Manage Locations, compact fields/buttons, desktop list scrolling only when longer than the complete right content, and mobile outer scrolling. ResizeObserver tracks the complete right-panel height, including expanded history.
- The shared engineering launcher label is Manage Locations for every existing role/profile presentation that exposes it. Its manage_rooms capability condition is unchanged. The global modal iframe title is normalized for the same route; window-width changes target only Manage Locations.
- /api/rooms retains authentication, hotel scope, create-mode behavior, and technician ticket filtering. Management reads add paginated PM history/proposals and equipment associations. PM data requires existing view_pm permission; equipment reads retain the existing canReadEquipment role restriction. No role catalog, grants, membership, session or RLS policies changed.
- POST creates a new location. PATCH changes only name, area and location_type, never id, room_number, active, hotel_id, inspection, ticket or equipment relationships. Inputs use recorded type/area values, reject duplicates and reject Add carrying an existing ID. Existing database hotel/area/name uniqueness catches exact concurrent duplicates.
- Work orders open the existing /work-orders/{id} application route and its existing authorization. Completed room history uses an authenticated read-only route keyed by hotel_id + room + period_start. Form and log details use exact template/location or proposal IDs; unknown targets fail closed.
- Equipment forms are derived from LIVE hotel-scoped records and the existing source catalog. Reviewed identity anchors contain only original location IDs, names and types; they preserve accepted form relationships through future name/type edits and never add absent inventory. Source rows remain explicit evidence; shared property history is not presented as individual equipment completion.

## Evidence

The read-only production check still returned 166 active locations and 112 active guest rooms, with no existing duplicate normalized names or guest-room keys. Full accepted-snapshot parity confirmed 369 form/location associations, 42 explicit location-log rows and the same residual mapping counts. Inventory itself is fetched live and is not replaced by these reference files.

Targeted tests exercise real route-handler code with an isolated in-memory database, deny unauthorized reads/writes, preserve PM/equipment gates and technician filtering, distinguish POST/PATCH, check exact detail identity, and verify rename/type changes preserve relationships. Existing role/session, desktop-window and modal-host tests are reused. See packaged integration-tests.log, release-build.log and HTTP evidence for final counts.

## Data and migrations

No migration or data correction is required by this application change, and none was executed. Equipment associations are computed read-only; historical uncertainties remain untouched. No PM tickets or decisions are processed. Existing exact-name uniqueness is retained. Case-insensitive name and guest-room-number uniqueness currently rely on application preflight and are not fully race-proof across simultaneous requests with different spellings/areas; any stronger database constraints require a separate approved migration after a fresh duplicate preflight.

## Remaining limits and approval gates

- The local production build uses inert placeholder Supabase configuration, never production credentials. It is validation evidence, NOT a deployable prebuilt artifact: rebuild with the approved environment before any release.
- Authenticated production writes and real-database Add/Edit were intentionally not exercised. A protected staging environment with an isolated database is required to verify those end-to-end without changing production. No staging deployment or expanded access is authorized by this task.
- The 4176 visual preview remains available and unchanged. The real-app build/API tests establish integration, but a signed-in staging browser pass of navigation, roles, Add/Edit and nested record links remains a release gate.
- Equipment residuals remain: 15 locations lack supported specific form matches; 14 logs and 139 source rows remain unresolved. 144 logs are shared source history. Existing assets without confirmed current inventory IDs were not relocated.
- Application loading is live; no claim is made that today's snapshot counts stay fixed after authorized future changes.

## Deployment steps — do not execute without approval

1. Review the exact commit and patch in the accompanying manifest. Re-check production alias/source; if it moved from cb9e7a6, reconcile only this release diff and repeat affected checks.
2. Review any desired concurrent-duplicate hardening separately. Do not run an implicit migration or data backfill.
3. Obtain explicit approval for a protected staging deployment using isolated data and existing role access. Rebuild with approved staging configuration. Test authorized and denied roles, full inventory, Add vs Edit, relation preservation, both scroll layouts, and exact PM/work-order navigation.
4. After staging acceptance, obtain explicit PRODUCTION deployment approval. Do not push the production branch or create an auto-deploying remote branch as part of preparation.
5. Build the reviewed commit with the approved production environment and stage without alias assignment; verify read-only health and authorization before approved promotion. Project and team IDs above must match.
6. Following approved promotion, perform read-only checks of the alias, commit, 166/112 inventory baseline (accounting for authorized changes), existing records, and error logs. Any operational write test requires specific authorization.

## Rollback steps — separate explicit approval required

Restore the previous production deployment dpl_5EhqQA44opsW63kV9Rf32rYRMvEN by the approved Vercel rollback/promote procedure, then verify its alias and read-only health. This release has no required database migration to reverse. Never delete newly added locations or undo user edits as part of a code rollback; preserve IDs and relationships. Vercel rollback can disable subsequent automatic alias assignment, so review the project's promotion state before future releases.
