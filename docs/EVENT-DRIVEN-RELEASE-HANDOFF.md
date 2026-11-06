# Event-driven resource changes — release held

This is a local candidate for the combined release, not a deployment. Scott is still specifying UI and other additions. Do not push, deploy, apply the migration, or finalize the combined release from this handoff alone.

## Baseline

Verified on November 6, 2026 using the Vercel deployment lookup for cmpri-engineering.com:
- Production deployment: dpl_7bhQkdqS4paEffjiZCHBqV5G7CK7, READY.
- Production Git revision: eb3707d18958f1e0198e62645cf5f18ef3910161.
- Local branch: fix/event-driven-combined-release, based on that exact revision.
- The initially mounted checkout was 1ed4900 and was not used as the editing baseline.
- Earlier six-item proposals were recovered from the owner's room history; Personal Context and direct access to the earlier task were unavailable. No recovered older source was substituted for current production.

## Six-item implementation

1. Pool: one shared browser store for header/notice/modal instances; initial read and database invalidation, no five-second polling. GET calls the read-only snapshot, not reconciliation. Real pool mutations and the hours/deadline worker remain responsible for state transitions.
2. Notifications: prospective work-order creation/history/view triggers materialize the existing recipient-specific inbox transactionally. No historical backfill. Dashboard GET reads the stored inbox without scanning work-order history, writing scan cursors, counting work orders, or dispatching push. Dispatch drains existing delivery intent rather than rescanning history for every subscriber. Its authenticated POST supports the database webhook described below.
3. Work orders: bounded 100-row pages with property/access predicates, server filters, search, stable ordering, and counts. The list includes Previous/Next controls and retains access to older rows. Approvals have their own paging and total. Room enrichment no longer invokes reconciliation on reads.
4. Technician: remove both Refresh controls and the 30-second refresh. Load account initially, then refresh assignments/rooms and inbox separately on resource changes. The bell remains visible with an empty inbox; other profile/submission pages also receive a personal inbox bell.
5. Mentions: retain the existing transactional save/mention logic; replace the five-second inbox timer with the same recipient-scoped inbox signal.
6. Scheduled jobs: reviewed individually; preserve actual deadlines, external limitations, and recovery as detailed below. No blanket deletion of crons.

The signal table contains only hotel, recipient, topic and revision. Browser roles get SELECT under active-member/own-recipient RLS. Existing business tables remain unexposed. One Realtime channel is shared per browser document; subscribers coalesce bursts, reload after reconnect/visibility/online events, and clean up listeners/channels. Pool instances share requests as well as state.

## Scheduled job decisions and release wiring

| Job | Primary work / reason retained | Recovery |
| --- | --- | --- |
| Notification dispatch, every minute | Pending delivery only; also handles explicit future phone tests and notification schedule windows. For immediate delivery, configure a Supabase Database Webhook on INSERT into cmpri_web_push_deliveries to POST /api/notifications/dispatch with the existing CRON_SECRET bearer credential. Never put that credential in SQL, this file, or client code. | Existing delivery claims prevent duplicate sending; failed/stale sending intent is retried. Minute schedule stays as recovery, not notification discovery. |
| Room reconciliation, every minute | Actual checkout deadlines. Imports already run reconciliation; reads now do not. | Existing persisted deadline/transition reconciliation is idempotent; next scheduled invocation catches missed deadlines. |
| Pool reconciliation, every minute | Actual 7 AM / 10 PM America/Chicago boundaries, including DST. Test/manual changes already reconcile transactionally. | Existing revision/transition checks prevent duplicate notices; the next scheduled invocation catches a missed boundary. |
| Drive maintenance, every five minutes | Existing Drive notification endpoint is event-driven. Maintenance renews expiring watches and processes saved events; it does not discover files without an event. | Durable event queue retries retained. |
| Email scan, hourly | Current provider adapter supports Gmail/Microsoft 365 fetch but has no provisioned mailbox push receiver or verified watch/subscription. Removing this schedule would stop imports. | Existing message-ID deduplication and processed markers remain. Provider-specific authenticated push enrollment/renewal is still required before this can become event-triggered. |
| Room Ranker sync, hourly | Work-order create/update routes already invoke synchronization for that order. The schedule drains only unprocessed entries whose next_attempt_at is due. | Existing durable queue/backoff retained. |

## Release gates and remaining limits

- Apply the new migration in the eventual combined release; verify its triggers, RLS, and inclusion of cmpri_resource_signals in supabase_realtime. The read-only schema gate now checks for the signal table. It does not itself prove publication/trigger setup.
- Configure and verify the notification-delivery webhook before describing phone delivery as fully event-driven. That external configuration was not changed during the release hold. Until wired, pending phone delivery still uses the minute recovery job.
- Email push conversion remains blocked on the actual provider's supported subscription and authenticated receiver configuration. Its existing hourly import is preserved.
- No signed-in cross-device, real phone push, or production Realtime validation was performed. Verify these against staging/approved release, including Front Desk and Technician pool closures, empty bells, role changes, multiple windows, reconnect, read/clear and unmount.
- Build validation uses synthetic public Supabase configuration only; no credentials or production rows were used. A successful local build does not verify deployment credentials.
- Merge upcoming UI/title-bar/bell styling work onto this candidate and rerun integration checks before release. No final UI approval is implied by these functional changes.

## Validation

Completed local validation:
- Full npm test command passed: main suite 1,286 passed / 2 skipped, followed by phone-test, database, 26 portable PO command, and release suites passing.
- Final targeted event/pagination suite: 11 passed, including three new event/SQL/browser-channel tests and canonical work-order search.
- Final integration selection: 51 passed; final embedded-inbox cleanup/mention selection: 8 passed.
- Type checking and ESLint passed.
- Production build and all PDF runtime trace/extraction checks passed with synthetic public Supabase configuration.
The full regression command preceded the final search-enum hardening; the affected route and database/channel tests passed again afterward. The new event tests are now included in npm test. Local run logs are /tmp/cmpri-event-regressions.log, /tmp/cmpri-event-build.log, /tmp/cmpri-db-regressions.log and /tmp/cmpri-event-db.log. Focused tests exercise transactional notification rollback, recipient eligibility, own-user/active-hotel RLS, denied browser writes, bounded historical pages, event coalescing, reconnect, old-channel isolation and subscription cleanup.
