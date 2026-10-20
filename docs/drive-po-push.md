# Drive PO push intake

Only folder `18V2KjCHw2o0uQCVFzu2GGxJ9PghGS7AD` and the existing CMPRI hotel
are supported. New file notifications lead to verified missing-line recovery,
never order creation, acceptance changes, mappings, stock or receipt changes.

Operator page: `/engineering/drive-po`. Check access, then explicitly activate.
The server refreshes the existing work Gmail OAuth grant without adding scopes.
It verifies the Drive account is `maint.cmpri@hawkeyehotels.com` and that the exact
folder is accessible. A permission failure must be resolved through separately
approved Google access; this release never expands a grant or creates credentials.

Callback: `POST /api/integrations/drive-po/notify`.
Google `files.watch` reports folder `children` changes. Registered channel ID,
HMAC token derived from the existing CRON_SECRET, resource ID/URI, expiration and
message number are checked. Notifications are durably queued before acknowledgement.
Initial authenticated sync confirms channel operation separately from deployment.
Duplicate and overlapping notifications are safe.

The five-minute maintenance route renews the 23-hour watch when less than six
hours remain and retries durable pending notifications. It does not list the folder
when the event queue is empty. This is watch lifecycle/retry scheduling, not
scheduled discovery. Push delivery is not guaranteed to be instantaneous or perfect.

Files are read only after fully paginating and verifying direct folder membership.
Version, size and membership are rechecked after downloading; the complete folder
snapshot is rechecked before imports. PDF originals remain unmodified. Incomplete
tables and conflicting versions are held. Existing lines are compared again under
database locks before missing lines and immutable Drive provenance are appended.

The service-only state/cache/queue tables have RLS and no anon/authenticated grants.
Only integration operators can view status or activate. No webhook tokens are stored
in the database or returned to the operator page. Unexpected or uncertain watch
creation is not blindly retried; its pending state remains inspectable until a
verified Google sync or expiration. Existing channels expire naturally after renewal.

Last run, held documents and errors are available on the operator page. A pending
event survives worker failure and is retried. Changes are atomic per PO; unrelated
PO exceptions do not overwrite or discard successful imports.

Verification: `node --import ./tests/helpers/resolve-ts.mjs tests/drive-po-push.test.mjs`,
`npm run test:po`, TypeScript, ESLint and production build with traced PDF runtime checks.
No fabricated orders or files are required for production verification.
