# CMPRI deployment preparation — 2026-11-07

Status: source prepared for deployment; production and the live database have not been changed.

## Included changes

- Manage Locations: neutral expanded panels, existing-option Area and Location Type dropdowns, Edit Location pill beside **Open PM Tracker**, and removal of Corporate from that label.
- Site-wide vertical scrollbar cursor correction and desktop resize handles positioned outside the scrollbar hit area.
- Earlier modal repairs across PM, PO, Staff Notes, GSS, Room Ranker, Hours Tracker, employment, asset/media dialogs and troubleshooting guides. Shared site palette tokens preserve the approved appearance and now propagate into embedded and nested dialogs.
- Thanksgiving desktop stability during header tab changes and window movement/closure. The original animated turkey, separate signed orange/pale pumpkins, greeting, nine leaf species and both leaf layers use the approved desktop/mobile positions in `src/lib/ui/thanksgiving-layouts.json`.
- Content-versioned local caching for Thanksgiving artwork, scripts and leaves. Animation runs locally, with no database requests for leaves. Root service-worker push behavior is preserved.
- App-level local JSON caching, concurrent-request sharing across windows, user/hotel/permission isolation, write/realtime/cross-tab invalidation, reconnect revision reconciliation and bounded fallback expiry. Suitable records use IndexedDB; sensitive categories remain network-only or memory-only. Tokens, signed links and private file bodies are excluded. Ticket detail reads continue reaching the server to preserve view recording.
- Mobile Create Work Order and Pool buttons share the same width across roles, including the separate Technician dashboard. Existing capability restrictions remain in effect.

Christmas remains a future theme in scope. This release does not create, enable or apply it. The previous database-fetch audit was not repeated.

## Deployment order

1. Preserve the currently deployed release identifier and normal database backup before the rollout.
2. Use the existing CMPRI Supabase project and normal migration workflow to apply `supabase/migrations/20261107194347_device_data_cache_signals.sql` once. Its prerequisites are `20261106133302_event_driven_resources.sql` and `20261106133511_modal_resource_events.sql`; apply any genuinely pending prerequisites in order. Do not replay previously applied migrations. The new migration extends the existing content-free signal stream and adds private profile/membership/permission invalidation triggers.
3. Use the existing CMPRI Vercel project and its existing production environment. No environment variable, cron schedule, auth-provider setting or integration-secret change is required by this release.
4. Install from the lockfile (`npm ci`) and build the release source (`npm run build`). The prebuild regenerates the shared palette and content-hashed Thanksgiving files from checked-in source. Include generated hashed files, `public/sw.js` and `public/backgrounds/thanksgiving-animated/cache-worker.js` in the same deployment.
5. Follow the existing project's deployment workflow. Do not upload the local `.next` verification build: it uses synthetic public authentication configuration for isolated tests. Production must rebuild with its own existing environment.
6. After deployment, run the existing authenticated, read-only release-schema/production-smoke checks using the established production credentials. Confirm the migration is present; `/api/resource-revisions` returns only the signed-in user's property-scoped version metadata. Check a permitted location edit and shared-window refresh through the normal application workflow.
7. Confirm mobile Create Work Order/Pool widths for at least a normal staff account and Technician, the approved desktop/mobile Thanksgiving composition, retained modal colors and push notifications. Verify returning clients receive the updated worker and changed assets while unchanged assets remain local.

## Validation and limits

The accompanying verification manifest records completed automated checks. Browser and database tests use synthetic users/data and isolated PostgreSQL-compatible PGlite; production credentials and live business records are not used. Production migration state and authenticated production smoke checks remain rollout gates, not completed actions in this preparation.

The device data cache is a performance aid, not an offline write queue. Authentication and server permissions remain authoritative. Browser storage can be evicted or denied by the device; the app falls back to normal network reads. The artwork cache has no application expiry and refreshes when content changes, subject to normal browser storage behavior.

## Rollback

Redeploy the previously retained application release if required. The new SQL migration adds content-free invalidation triggers and is compatible with the previous app, so leave it in place during an application rollback. Do not remove shared signal tables or prior migrations. If trigger rollback becomes necessary, prepare a separate reviewed migration targeting only the triggers/functions introduced by this release.

The app data store is `cmpri-device-data-v1`; sign-out clears it. The Thanksgiving service-worker caches are named `cmpri-thanksgiving-<content-version>`. Never clear unrelated service-worker caches as part of a rollback. Serve the previous complete worker/artwork bundle together to restore the previous visual release.
