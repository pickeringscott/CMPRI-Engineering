# Isolated seven-role test setup

This test branch carries the pending equipment/troubleshooting batch over main
`622602989159ee491a4cd25778368515da61d1fc`. It is not a production release.
Its first commit disables Vercel Git deployments through
`vercel.json` → `git.deploymentEnabled: false`. Keep this override on the sandbox
branch; do not merge it into production as part of the app fix.

The GitHub job has a literal `if: ${{ false }}` guard. Creating the branch may
produce a skipped workflow, but allocates no runner. The private repository's
included Actions balance and spending controls were not available through the
connected tools. Do not remove the guard or dispatch another workflow until the
parent verifies included capacity or an enforced zero-spend limit. This workflow
does not upload artifacts or caches, provision a hosted database, use secrets,
create OAuth access, deploy, or call paid AI services.

## Intended checks once execution is authorized

The pinned Supabase CLI starts an ephemeral local Auth/API/Postgres stack and
applies repository migrations locally. No `link`, `db push`, remote environment
file, or production credential is used. Seven synthetic accounts represent only
GM, AGM, FDM, Maintenance Technician, Chief Engineer, Lead Housekeeper and Front
Desk. Their roles and ordinary grants are fixtures, not changes to app policy.

Playwright signs in through the real password form. Twenty-eight submissions
cover lamp classification, exact washer numbering (1/2/12), pool classification,
and manufacturer selection for every account. The browser uses actual app routes
and local persistence; no fake sessions or app response stubs. SQL independently
checks the saved asset, category and retained guest comment. Authenticated RLS
reads and an unauthenticated boundary check follow. Results fail the process if
any login, submission or expected row is missing.

An ordinary synthetic work-order notification exercises the real dispatch module,
quiet hours, database persistence, retry deduplication and encrypted Web Push to
a controlled local HTTPS receiver. It sends nothing to staff. It does not cover
browser push enrollment, device delivery, or automatic notification creation from
a ticket. No checkout-time notification is added or tested.

The Chief Engineer title is probed against the migrated profile constraint. If
rejected, the canonical engineer alias can still exercise general technical
submission behavior, but `role-gaps.json` explicitly records the gap and the final
suite fails. This must not be reported as seven complete role passes. No schema
change is made to make the fixture pass.

Scoped regression checks cover equipment matching and completed-step filtering.
Real verified-manual storage/guide refresh and the full engineering ticket
lifecycle remain additional E2E coverage; this setup must not be called complete
production or seven-role workflow verification.

## Execution and evidence

Use a fresh ephemeral checkout, Node 24, Python 3.12 with Playwright 1.56.0 and its
Chromium, Docker, OpenSSL, and Supabase CLI 2.81.3. After `npm ci`, run
`bash tests/sandbox/run.sh` only when compute use is authorized. The script refuses
an existing `.sandbox` directory or `.env.local`. Disposable local credentials,
private logs, screenshots and results stay in ignored `.sandbox/`. Only an
explicit allowlist of sanitized JSON results is printed to GitHub's job summary.
Never upload the entire directory or its key/session files. The runner destroys
the stack with its ephemeral VM; no persistent hosted resource is created.

This setup has been syntax/config checked but not run on GitHub. The original
cloud executor could not extract the Supabase Postgres image (`no space left on
device` using Docker VFS). Passing prior mock-based checks did not establish a
real Auth/Postgres/connected-session E2E pass.
