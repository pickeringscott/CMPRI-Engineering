# Isolated seven-role test setup

This test branch carries the pending equipment/troubleshooting batch over main
`622602989159ee491a4cd25778368515da61d1fc`. It is not a production release.
Its first commit disables Vercel Git deployments through
`vercel.json` → `git.deploymentEnabled: false`. Keep this override on the sandbox
branch; do not merge it into production as part of the app fix.

The two prior runs have finished. One additional run is now explicitly approved:
one standard Ubuntu job, at most 20 minutes and USD 0.25 additional charge
including tax. It can execute only on the first push from
`bd262beee179454a99fb598c8ef5819ac1956ea3` and attempt 1. Further pushes and
reruns skip; any further metered run needs separate authorization.

Sandbox email/password login is configured on with
`auth.email.enable_signup = true`; CLI 2.81.3 maps that setting to the email
provider switch. Public registration remains off with
`auth.enable_signup = false`. Only the seeded synthetic accounts are used.
A fail-fast preflight checks the local email provider, a synthetic password login,
and the app session endpoint before the browser matrix. The repaired provider
configuration and preflight have been syntax/config checked but have not run
against an active stack. No successful login or browser pass is claimed.

This workflow does not upload artifacts or caches, provision a hosted database,
use production secrets, create OAuth access, deploy, or call paid AI services.

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

Chief Engineer now persists as `chief_engineer`, while capability checks continue
to use the existing engineer family. Account creation and explicit role edits
preserve that identity after their existing authorization checks. Display and
notification predicates recognize it. Generic `engineer` values remain generic
and do not gain Chief Engineer notifications.

Migration `20261011230319_cmpri_chief_engineer_role_identity.sql` adds this one
stored value to the primary/secondary profile constraints while retaining their
old allowed values. It does not update any account, policy, or grant. It is for
sandbox testing and production review only: no production application is
authorized. Existing generic accounts cannot be reclassified without a verified
assignment and separate production authorization.

The technical-role lifecycle check uses actual local Auth and app APIs to claim,
start, complete and close a ticket, then verifies persistence and seven-role
notification API eligibility. It does not exercise detail-page browser controls.
Both Technician and Chief Engineer controlled encrypted push deliveries are
checked. Real verified-manual storage/guide refresh and browser push enrollment
remain coverage gaps. No deployment or complete production verification is claimed.

## Execution and evidence

Use a fresh ephemeral checkout, Node 24, Python 3.12 with Playwright 1.56.0 and its
Chromium, Docker, OpenSSL, and Supabase CLI 2.81.3. After `npm ci`, run
`bash tests/sandbox/run.sh` only when compute use is authorized. The script refuses
an existing `.sandbox` directory or `.env.local`. Disposable local credentials,
private logs, screenshots and results stay in ignored `.sandbox/`. Only an
explicit allowlist of sanitized JSON results is printed to GitHub's job summary.
Never upload the entire directory or its key/session files. The runner destroys
the stack with its ephemeral VM; no persistent hosted resource is created.

Before the authorized run, this setup was syntax/config checked but not run on GitHub; consult the Actions run for the actual outcome. The original
cloud executor could not extract the Supabase Postgres image (`no space left on
device` using Docker VFS). Passing prior mock-based checks did not establish a
real Auth/Postgres/connected-session E2E pass.
