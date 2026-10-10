# CMPRI Engineering v1.0

This is an integrated SOURCE CHECKPOINT of the Residence Inn Champaign engineering application, not a completed or fully tested release. It includes the earlier Astra-reviewed work and subsequent testing/repairs. Package version remains 1.0.0 and browser title is CMPRI - Engineering. A separately rebuilt Android wrapper exists, but its runtime is untested and this source has not been deployed. Read TEST-CONTINUATION-2026-09-15.md, REQUIREMENTS-V1.0.md and RELEASE-READINESS.md for current status; TEST-REPORT-ASTRA.md records the earlier checkpoint.

## Core application

Duplicate checks run in the shared submission API for single, batch, related and
import creation. The migration
`supabase/migrations/20261006150000_cmpri_work_order_duplicate_guard.sql` adds a
database-level exact-match guard for pending and active work orders; the application
also checks likely duplicates with normalized wording and issue synonyms. Reporter
comments and other non-issue context from a submission are appended to its Notes
without replacing notes entered separately. Migrations are not automatically
applied: validate existing data and required migrations in an isolated database
before release.

The front-desk submission update requires the database migration
`supabase/cmpri_v1_0_submitter_attribution.sql`. Apply and validate it in an
isolated test database before deploying this source. The page and API require
the submitting employee's **first name** for single, batch and related tickets.
The migration has not been executed against the real schema/RLS in this session.

The source includes the engineering dashboard, work-order creation and detail pages, client-side duplicate warnings, room/location and asset management, documentation/manual routing and maintenance AI, technician pages, Room Ranker and Corporate PM adapters, user management, and purchasing/email operations. These are not claims of complete integration: server-enforced duplicate concurrency, required attribution/drafts, access-control coverage, real sheet/mailbox integration and other acceptance items remain incomplete as detailed in REQUIREMENTS-V1.0.md.

## Daily room status and availability

Daily room-operation imports must include every active guest room and its reported room status. Image extraction is preflighted before saving; incomplete room lists or missing statuses are rejected rather than silently creating a partial snapshot. Current-day status badges appear in the room selector and on accessible work-order lists and details. `Vacant Ready` / `VR` is labeled **Available**; other reported conditions retain their status label. Availability is based on today's hotel-local report only.

## v1.0 purchasing and email operations

CMPRI can ingest operational messages through read-only Microsoft 365/Outlook or Gmail adapters into the same purchasing and activity records. These adapters were tested with fixtures, not the real work mailbox.

- iBuyEfficient / HD Supply orders and purchase status
- Split shipments, individual tracking numbers, ship-from locations, ETA, delivered and received state
- Manual receiving / installed-used / complete controls when an email does not provide the final physical status
- Supplier missing-item / short-shipment follow-up and vendor response tracking
- Warranty, failed-part, RMA, replacement shipment, tracking, ship-from and ETA history
- Enseo tickets, including room/end-point identifiers such as `103A` and `103B`, linked to existing work orders when appropriate
- Monday-only (UTC) GSS score report import and historical score trend storage; guest-comment automation is intentionally not enabled in v1.0
- Hourly Vercel cron scan plus a manual **Scan Email Now** control

Purchase/shipment state is deliberately separate from the work-order status. Receiving every known shipment still means Partially Received until Engineering confirms the whole order: unknown split shipments and unfulfilled quantities cannot be ruled out from tracking numbers alone.

## Duplicate work orders

`Duplicate` is not a normal work-order status in v1.0. When CMPRI finds a likely active ticket for the same location and substantially similar issue, it stops creation of the second ticket and directs the user to update the existing record. Legacy duplicate records may still be treated as inactive for historical compatibility.

## Database migration

`supabase/migrations/20260930180000_cmpri_prod_baseline.sql` is a schema-only dump of live production (`supabase db dump --linked`) and is the only migration recorded in production's history. `supabase db diff --linked` against it is empty. Add new changes as new timestamped files in `supabase/migrations`. Earlier migrations are kept for reference and tests in `supabase/migrations_archive/`; they are already reflected in the baseline and should not be re-applied.

Before deploying draft approval, apply `supabase/migrations/20261009120000_cmpri_work_order_draft_idempotency.sql`. It checks for existing duplicate draft provenance without rewriting records, then enforces at most one work order per source draft and hotel. Repeated approvals return the existing work order.

The secondary-profile-roles migration adds `profiles.secondary_roles` while leaving `profiles.role` as the primary authorization role. When `maint.cmpri@hawkeyehotels.com` exists, it assigns that account the `engineer` secondary role and `system_admin` primary role. The account-specific backfill is skipped when the user is absent so schema-only shadow databases can replay the migration. Apply the migration before deploying the matching account/session display changes.

Before enabling the new email/purchasing screens in production, apply:

```text
supabase/cmpri_v1_0_integrations.sql
```

The migration creates server-managed operational tables for email events, purchases, split shipments, Enseo tickets, warranty/RMA cases, supplier follow-ups, and GSS reports. Row-level security is enabled; these records are accessed through authenticated CMPRI server routes using the Supabase service role.

The pool-log requirements migration, `supabase/migrations_archive/20260930060000_cmpri_pool_log_requirements.sql`, adds the closure-reason column and requires a reason for recorded closures. Chlorine and cyanuric-acid readings are not used.

The pool-log daily-samples migration, `supabase/migrations_archive/20260930070000_cmpri_pool_log_daily_samples.sql`, supersedes it and is self-contained (safe to run even if the earlier pool migrations were skipped, and safe to rerun). One water sample is taken per AM/PM test; its reading is recorded for both shallow and deep, and each sample needs pH, bromine, and a shallow or deep location ("middle of pool" is kept only on historical rows). Water temperature, flow rate, main-drain visibility, and filter backwash are recorded once per day and are required. The AM sample is saved when taken; any engineer can later add the PM sample to the same day's log without overwriting AM, and only System Administrators can change saved values. Pool closure is recorded automatically for pH outside 7.2–7.8, bromine at or below 2 or at or above 7.5 ppm, main drain not visible, or water above 104°F. Apply it in Supabase before deploying the pool-log changes, then run `npm run check:release-schema`. Until it is applied, pool-log saves report that the database is missing this update.

For prebuilt Vercel deployments, run `npm run prepare:vercel-output` after
`vercel build --prod`. Packaging excludes local environment files from traced
function manifests while retaining required runtime files.
Daily Room Operations cards and KPI modals share the same compact presentation:
the CN emblem matches the room-number line height, the guest name sits below in
muted text, with LOS on a muted detail line. Type, code, and current arrival date
remain imported and stored in the database but are not displayed. Checkout today is green, tomorrow is
yellow, overdue is red, and later checkouts show only a muted date and time.
Out-of-order rooms use a compact red "Out of Order" pill.

Daily Room Operations image extraction also requires Sharp's Linux x64 optional
packages (`@img/sharp-linux-x64` and `@img/sharp-libvips-linux-x64`) at the exact
versions listed in Sharp's `optionalDependencies`. A Windows prebuilt release
must install those packages in its isolated packaging directory with
`npm install --no-save --package-lock=false --force --ignore-scripts`
and both package names with their matching versions. Packaging adds them only
to the Room Operations extraction functions and fails if they are missing or
incompatible. It also replaces Sharp's absolute Windows module-link mapping with
explicit portable file mappings in those functions; Windows binaries and module
links cannot run on Vercel.

## Required deployment environment variables

Use `.env.example` as the non-secret checklist. Existing CMPRI Supabase, OpenAI, Room Ranker, and Corporate PM integrations remain in use. The email integration requires provider credentials and CRON_SECRET for scheduled scans. Microsoft 365 is preferred when both providers are configured unless CMPRI_EMAIL_PROVIDER explicitly selects Gmail. Mail.Read mailbox-scoped permission or Gmail gmail.readonly permission must be configured externally. No mailbox writing or sending is implemented.

Browser/phone notifications use the existing CMPRI website and a web service
worker, not a separate native application. Apply
`supabase/migrations/20261006140000_cmpri_web_push_and_engineering_views.sql` before deploying. Set
`WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY`, and
`WEB_PUSH_VAPID_SUBJECT` using keys generated by `npx web-push
generate-vapid-keys`; keep the private key server-only. Each subscription is
associated with the signed-in Chief Engineer or Maintenance Technician, and
their saved weekday schedule is evaluated in its selected time zone. The
scheduled notification scan runs once per minute and uses the existing
`CRON_SECRET`. Push requires HTTPS (localhost is allowed for
development); iPhone/iPad Safari requires CMPRI to be added to the Home Screen
before web push is available.

Local development uses `NEXT_PUBLIC_APP_URL=http://127.0.0.1:3100`. Google
sign-in requests the current browser origin as its callback, including its port.
Supabase Authentication URL Configuration must allow `http://127.0.0.1:3100/`
and `http://localhost:3100/`; otherwise Supabase can fall back to its production
Site URL. Keep the production Site URL unchanged.

The Gmail integration is designed to use a read-only Gmail OAuth scope for mailbox ingestion. It does not autonomously send warranty claims, supplier messages, or other outgoing mail.

## Room Ranker

Room Ranker is readable by Front Desk Managers, Assistant General Managers,
Maintenance Technicians, and General Managers (including matching secondary
roles), plus Scott's mapped `maint.cmpri@hawkeyehotels.com` account. Only that
account can edit or manually synchronize Room Ranker; server cron synchronization
is unchanged. Both the authenticated identity and profile email must match for
account-specific access. Other engineer or system-admin accounts are not granted
access solely by their role. Dashboard launchers, work-order context, API routes,
and MCP read/write tools use the shared policy.

CMPRI accesses the
private Google Sheet directly using a Google Cloud service account; no Apps
Script endpoint or custom Room Ranker API key is used. Enable the Google Sheets
API in the service account's Google Cloud project and share the spreadsheet
with that service account's `client_email` as an Editor. Keep the sheet private
to its normal users and that service account. The CMPRI table displays Room,
Room Inspected by, Room Rank, and Notes / Actions Needed; the three specific-room
check columns remain in the integration data but are not displayed in that table.

The same viewer roles and Scott's mapped account have a Troubleshooting Guide
menu on their dashboards: Enseo TV, Dormakaba LED Visual Guide, and the bilingual
Guest Room guide. Guides render as HTML with a guide-only print view.

Work-order synchronization also requires the server-only outbox and trigger in
`supabase/cmpri_v1_0_room_ranker_sync.sql`. Apply this transactional, idempotent
SQL to the target database before enabling synchronization. It does not backfill
existing work orders or enable Preventive Maintenance spreadsheet sync.
`npm run check:release-schema` checks the outbox columns; a passing schema check
does not verify spreadsheet credentials or successful external writes.

```text
CMPRI_GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON=<full service-account JSON>
CMPRI_ROOM_RANKER_SPREADSHEET_ID=<spreadsheet id from its URL>
CMPRI_ROOM_RANKER_SHEET_NAME=<exact worksheet tab name>
```

Alternatively, the service-account fields may be supplied in separate
server-only variables:

```text
CMPRI_GOOGLE_SHEETS_CLIENT_EMAIL=<service-account client_email>
CMPRI_GOOGLE_SHEETS_PRIVATE_KEY=<service-account private_key>
```

Set these in Vercel's Production environment only. The JSON contains the
private key and must never be committed or exposed to browser code. CMPRI
exchanges a server-signed JWT for a short-lived Google access token and uses it
only from server routes. Saving edits retains row/room checks and verifies the
written values by reading them back.

## Corporate PM

The legacy Corporate PM adapter is retained for read-only compatibility. CMPRI
no longer writes directly to the corporate workbook; direct Corporate PM and
work-order PM write routes return a conflict response directing staff to the
personal live-workbook proposal and review flow. The existing personal-to-
corporate sync remains the only corporate propagation path.

```text
CMPRI_CORPORATE_PM_SPREADSHEET_ID=<spreadsheet id from its URL>
```

The legacy monthly tabs use the existing JAN–DEC names. Google credentials
and spreadsheet IDs stay in server-only environment variables; no Apps Script
URL or API key is used.

## Live-workbook Preventive Maintenance

The Engineering Preventive Maintenance workspace reads the personal live PM
workbook configured by `CMPRI_LIVE_PM_SPREADSHEET_ID`, using the shared
server-only Google Sheets service account. It reads the year tab for quarterly
room completion dates and the JAN–DEC tabs for daily dates, weekly slots,
monthly tasks, and linked checklist references. Technicians use CMPRI only and
do not receive direct spreadsheet rights.

Technician checkbox, room-date, and PDF form changes are stored as pending
proposals in `cmpri_pm_proposals`. A System Administrator must review and
explicitly confirm a proposal before CMPRI applies its verified changes to the
personal live workbook. Formula-backed cells and cells changed since proposal
submission are rejected, and successful writes are read back for verification.
PDF inspection data (measurements, notes, follow-up, repair dates, and repeatable
logs) is also held pending review. The corporate workbook is never written by
this workflow; the existing sync remains responsible for corporate updates.

Apply `supabase/migrations_archive/20260930010000_cmpri_pm_review.sql` only to the
intended development database after validating its schema and RLS. During local
preview, keep `CMPRI_LIVE_PM_WRITES_ENABLED=false`; set it to `true` only after
the dev review is complete. The explicit reviewer confirmation remains required
for every proposal even when the write gate is enabled.

## Local verification

```bash
npm ci
npm run build
npm start
```

The production build is Next.js 16 / React 19. No Google-hosted runtime font download is required.

## Latest verification and required revision migration

Read CONTINUATION-REPORT.md for the latest checks. Before deploying this source,
validate and apply `supabase/cmpri_v1_0_work_order_revision.sql` in an isolated
copy of the real schema. Every ticket save now requires the originally loaded
revision to avoid overwriting another person's changes. Deploying without the
migration will prevent saves. The revision trigger covers updates from all writers.

Bulk manuals can be prepared for human review without AI or database access:

```sh
node scripts/ingest-all-manuals.mjs SOURCE --output=manual-review.json
```

This replaces the previous bulk AI/database ingestion command. Existing review
files are never overwritten. Output contains source text and file hashes;
it does not mark troubleshooting verified or populate the equipment database.
