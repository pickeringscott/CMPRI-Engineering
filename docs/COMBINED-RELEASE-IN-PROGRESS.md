# Combined release: built locally, deployment held

Verified pre-change production baseline: `eb3707d18958f1e0198e62645cf5f18ef3910161` (deployment `dpl_7bhQkdqS4paEffjiZCHBqV5G7CK7`). Working branch: `fix/event-driven-combined-release`.

## Implemented

- Approved header v23 (`libfile_5fe759010030819199b4075979acc3ad`): exact source recovered, Coral Glow mapping, approved bell, collapsible/reorderable groups, role-filtered Engineering and Technician controls. Front Desk profile shortcut removed; underlying account access retained. Menu listeners and timers cleaned up on interaction completion/unmount.
- Approved Work Order v7 (`libfile_05791251a19481919abc007e74992698`): list/detail/create integration, compact mobile metadata, tight mobile Save/Cancel, shared media controls, combined history/note frame, original attachment filenames and uploader attribution, hover/full-media behavior, compact tiles, sorting, guest badges and overlap. No automatic real submission from fixture previews.
- Loyalty: Arrivals LOYALTY TIER recognition, stay-bound retention, room moves, missing-field retention, checkout clearing and incoming takeover. Daily Ops and Work Order badges; one-shot guest business-boundary refreshes through visibility-gated subscriptions, not periodic polling.
- Notes: all recognized active profiles retain ticket read/property gates and can append notes in supported statuses; no broad administrative grants.
- Event-driven resources: notifications/mentions, Technician refresh removal, shared Pool state and mounted-modal fetch lifecycle. Initial loading and reconnect/visibility catch-up retained. Scheduled business transitions and delivery retries retained.
- Pool: pill opens shared modal; GM/AGM have Chief pool-specific reopen/clear/log create/edit parity, validation and audit history. Other role restrictions retained.
- Flyover: exact committed AVIF and verified group matching. Thanksgiving: exact existing desktop design restored; animation performs no server polling.
- Legacy workbook Ranker: UI/context, provider implementation, cron and MCP actions retired. Old APIs return 410; old page redirects to current Ranker. Current ticket Ranker preserved. Migration removes queue producer only; historical data retained.
- Email push: Gmail/Microsoft authenticated callbacks, durable queue, leases, pagination/checkpoints, targeted-message reads and existing operational PO/shipping persistence. Failed imports keep pending events. Gmail acknowledgements cannot overtake processed history. Microsoft deliveries without reliable event IDs cannot suppress later updates. Manual scan is blocked when push ingestion owns the mailbox. Maintenance continues queued processing if renewal fails. Existing reviewed PO import/physical receipt boundaries remain intact.

## Verification

- `npm test`: PASS, including the 1,299-test main block, database migrations/reconciliation, phone notification checks, purchasing suite and release checks. Full log: `/tmp/cmpri-full-regression3.log`.
- Newly added `npm run test:combined-release`: 16 passed (email signature/body checks, processing failures/pagination/concurrency, actual PostgreSQL service-only/RLS/lease/dedup checks, loyalty, legacy retirement). Added to the default test chain.
- Additional attachment/video/email regression run: 67 passed, including valid WebM, mislabeled/truncated rejection, original metadata and failure paths. Suites overlap; counts must not be summed.
- TypeScript passes. ESLint: zero errors, 12 warnings (direct media images and existing unused/dependency warnings). Diff whitespace check passes.
- Optimized production build and PDF runtime postbuild checks pass using synthetic Supabase build configuration. Logs: `/tmp/cmpri-release-final-build.log`, `/tmp/cmpri-final-typecheck.log`.
- Real application components with synthetic authentication and read-only fixtures: 52 role/device/screen cases, no page errors or horizontal overflow. Nine-role note inputs and submit affordances verified without submitting. Evidence: `/workspace/cmpri-release-ui-check/results.json`, screenshots in the same folder. This is not live signed-in verification.
- Header interaction harness: 390px and 1440px launch/collapse/expand/unmount passed.

## Exact remaining external blockers

1. No signed-in CMPRI test credentials/session, Supabase service credential, or local `.env.local`/`.env.test` is available. Only the Vercel token name is present. Thus live role authorization, cross-device Realtime and production signed URLs/camera behavior have not been claimed verified.
2. Email push provider configuration/enrollment is unverified. Previously inspected Vercel metadata did not contain `CMPRI_EMAIL_PUSH_ENABLED`, Gmail Pub/Sub topic/subscription/service-account configuration or Microsoft push client state. Do not enable the new cron cutover until provider configuration, enrollment and actual authenticated callback delivery are verified. Watch outcomes marked pending and expired history require explicit operator recovery/verification; do not blindly reset cursors.
3. Notification delivery webhook configuration remains a release operation: database INSERT delivery intent must invoke the authenticated dispatch endpoint; its minute schedule is recovery. No webhook credential is stored in source.
4. Six local migrations are unapplied: `20261106064638_event_driven_resources.sql`, `20261106074238_email_push.sql`, `20261106084745_modal_resource_events.sql`, `20261106102309_pool_manager_reopening.sql`, `20261106112024_work_order_media_types.sql`, `20261106112635_retire_legacy_room_ranker.sql`. No production migration application is authorized yet.

No deployment, remote push, production data change, provider enrollment or production migration was performed. Staff Notes welcome post/tutorial/video is deferred and is not a blocker. Scott's final deployment go is still required.

## Built candidate line totals

One final-tree diff against the verified baseline, including previously untracked release files through an isolated temporary Git index; no intermediate commits or preview iterations summed:

| Category | Added | Removed |
| --- | ---: | ---: |
| Application, database and executable public HTML | 2,370 | 1,906 |
| Tests | 599 | 203 |
| Configuration | 5 | 8 |
| **Code including tests/configuration** | **2,974** | **2,117** |

Documentation, standalone preview-only files, generated/lock files and five binary assets are excluded. The deployed Thanksgiving HTML is counted as executable code; its four PNG assets and Flyover AVIF are excluded. These counts describe the built candidate, not a claim that external deployment gates are complete.
