# One post-release seven-role verification

Application, migrations and dependencies are exactly release
`009a25000addefed5733415cf0a7c3656c59eb5c`; `verify-release.py` checks their
SHA-256 manifest before execution. This branch changes only the verification
harness and disables Vercel Git deployments. Never merge this override into main.

One standard Ubuntu GitHub Actions job is authorized, at most 20 minutes and
USD 0.25 additional charge. The push guard accepts only the transition from
`b2b087aee87b15037bdcd7b5a017faa713854e67`, attempt 1. No automatic reruns,
artifacts, caches or additional jobs. Further metered runs need new approval.

The pinned local Supabase stack uses real Auth/Postgres/RLS/Storage and repository
migrations. Public signup is disabled; the repaired email/password provider stays
enabled. Exactly seven synthetic accounts: General Manager, Assistant Manager
(stored assistant_manager), Front Desk Manager, Maintenance Technician, Chief
Engineer, Lead Housekeeper, Front Desk. No production secrets, records, accounts,
grants, deployment or hosted backend. Node/browser guards block external calls.
No destructive cleanup; the ephemeral runner owns all test data.

Coverage:
- 28 real browser submissions, four equipment inference cases per role, with
  persisted room/issue/Notes; Spanish notes preserved verbatim, not translated.
- Own draft API and Create-form isolation for seven roles; explicit Chief review
  access remains separate, other roles cannot edit someone else's draft.
- English/Spanish Cancel with selected photos, Keep Editing then Confirm Cancel,
  verifying unchanged database/order/Storage inventories.
- LH/FD own Pending Verification uploads: select wrong+right PNG, red X removes
  wrong file, only retained photo is uploaded. Real Storage bytes/SHA-256, path
  association, engineering signed readback, and exact bucket inventory are checked.
  Own Pending GET, other Pending POST and direct Storage access remain denied.
- Exact ID/status RLS visibility expectations (managers see active rows only).
- Pending approval → Open → technician claim/start/complete → Chief close through
  real Auth/API, plus negative approval boundaries and database persistence.
- Real notification eligibility/event generation, persisted read/clear and
  recipient isolation; quiet hours/resume/dedup and encrypted delivery to a
  controlled loopback HTTPS sink. No staff/device alerts.

Only sanitized allowlisted JSON is printed. Local keys, tokens, screenshots,
raw logs and uploaded bytes never become GitHub artifacts. The private bucket
is created locally as a fixture because repository SQL does not provision it;
this verifies application Storage integration, not production bucket policy parity.
Physical phone push, browser push enrollment, manual refresh, detail-page lifecycle
buttons and content translation remain gaps. Consult the run, not local syntax
checks, for actual real-backend results.

## Diagnostic follow-up after run 38204465454

One newly approved run adds HTTP status/content-type/route and structured Next
exception diagnostics, bounded sanitized server exceptions and browser errors.
It stops on Auth/session/draft API, browser login or draft prerequisite failure,
before the seven-role matrix. The GM preflight draft is reused by the matrix.
No raw HTML, request headers/bodies, credential files or raw server logs are
published. Local redaction tests use synthetic sensitive strings.

## Navigation-specific follow-up after run 38206410484

One additional approved attempt records path-only request completion, RSC flags,
pending requests, the allowlisted session landing/role, safe DOM redirect state,
and server page/compilation status. Direct /engineering navigation is diagnostic
only: failure of client-side login remains a failure even if the direct load works.
The full matrix starts only after client navigation, direct navigation and Create
form readiness all pass. No application code changes or navigation bypass.

Actual phone push is deferred until after go-live. The loopback encrypted receiver
remains a controlled module/persistence test only. Spanish-to-English submitted
content is a launch requirement and is NOT implemented or passed by this harness.
Spanish UI Cancel and verbatim notes preservation do not establish translation.
