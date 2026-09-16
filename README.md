# CMPRI Engineering v1.0

This is an integrated SOURCE CHECKPOINT of the Residence Inn Champaign engineering application, not a completed or fully tested release. It includes the earlier Astra-reviewed work and subsequent testing/repairs. Package version remains 1.0.0 and browser title is CMPRI - Engineering. A separately rebuilt Android wrapper exists, but its runtime is untested and this source has not been deployed. Read TEST-CONTINUATION-2026-09-15.md, REQUIREMENTS-V1.0.md and RELEASE-READINESS.md for current status; TEST-REPORT-ASTRA.md records the earlier checkpoint.

## Core application

Duplicate checks now run in the shared submission API for single, batch and
related creation. The proposed exact-match database guard is in
`supabase/cmpri_v1_0_exact_duplicate_guard.sql`; it is unexecuted and does not
complete the fuzzy/concurrent duplicate requirement. Validate all required migrations
and existing data in an isolated database before release.

The front-desk submission update requires the database migration
`supabase/cmpri_v1_0_submitter_attribution.sql`. Apply and validate it in an
isolated test database before deploying this source. The page and API require
the submitting employee's **first name** for single, batch and related tickets.
The migration has not been executed against the real schema/RLS in this session.

The source includes the engineering dashboard, work-order creation and detail pages, client-side duplicate warnings, room/location and asset management, documentation/manual routing and maintenance AI, technician pages, Room Ranker and Corporate PM adapters, user management, and purchasing/email operations. These are not claims of complete integration: server-enforced duplicate concurrency, required attribution/drafts, access-control coverage, real sheet/mailbox integration and other acceptance items remain incomplete as detailed in REQUIREMENTS-V1.0.md.

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

Before enabling the new email/purchasing screens in production, apply:

```text
supabase/cmpri_v1_0_integrations.sql
```

The migration creates server-managed operational tables for email events, purchases, split shipments, Enseo tickets, warranty/RMA cases, supplier follow-ups, and GSS reports. Row-level security is enabled; these records are accessed through authenticated CMPRI server routes using the Supabase service role.

## Required deployment environment variables

Use `.env.example` as the non-secret checklist. Existing CMPRI Supabase, OpenAI, Room Ranker, and Corporate PM variables remain in use. The email integration requires provider credentials and CRON_SECRET for scheduled scans. Microsoft 365 is preferred when both providers are configured unless CMPRI_EMAIL_PROVIDER explicitly selects Gmail. Mail.Read mailbox-scoped permission or Gmail gmail.readonly permission must be configured externally. No mailbox writing or sending is implemented.

The Gmail integration is designed to use a read-only Gmail OAuth scope for mailbox ingestion. It does not autonomously send warranty claims, supplier messages, or other outgoing mail.

## Room Ranker

Configure:

```text
CMPRI_ROOM_RANKER_API_URL=<deployed Apps Script URL>
CMPRI_ROOM_RANKER_API_KEY=<private Apps Script key>
```

The key is server-only and must not use a `NEXT_PUBLIC_` prefix.

## Corporate PM

Configure:

```text
CMPRI_CORPORATE_PM_API_URL=<deployed Apps Script URL>
CMPRI_CORPORATE_PM_API_KEY=<matching private key>
```

CMPRI reads the corporate PM schedule/checklist through the protected server route and preserves the corporate spreadsheet as the governing source.

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
