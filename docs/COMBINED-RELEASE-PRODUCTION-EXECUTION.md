# Production execution — November 6, 2026

Scott approved production setup and deployment once verification passes. Application deployment has not occurred. Vercel production remains `dpl_7bhQkdqS4paEffjiZCHBqV5G7CK7`, commit `eb3707d18958f1e0198e62645cf5f18ef3910161`, rechecked after schema application.

## Applied and verified

Supabase project: `uavotsoanubpowvyqaii`. Connector-generated migration versions differ from local filenames; do not reapply these files based solely on timestamp differences.

| Local migration timestamp | Name | Production version |
| --- | --- | --- |
| 20261106064638 | event_driven_resources | 20261106133302 |
| 20261106074238 | email_push | 20261106133316 |
| 20261106084745 | modal_resource_events | 20261106133511 |
| 20261106102309 | pool_manager_reopening | 20261106133521 |
| 20261106112024 | work_order_media_types | 20261106133526 |
| 20261106112635 | retire_legacy_room_ranker | 20261106141345 |

Initial modal migration failed transactionally because assets and maintenance_documents are compatibility views. Corrected its trigger to their shared underlying cmpri_assets_and_pdfs table, retaining reference invalidation for both record kinds. The revised PostgreSQL test fixture uses the real table/view structure: all four modal resource tests pass. The corrected migration succeeded; catalog confirms its trigger exists.

The final trigger-drop confirmation initially expired without executing. After checking history and the live trigger, one fresh tool confirmation succeeded. Catalog confirms the legacy producer trigger is absent. Historical queue records were not deleted. All six migration names/versions are recorded remotely; resource signals are published to Realtime. Email queue/state RLS is enabled.

## Remaining gates and exact actions

- **Email push:** identify the active provider and provision its push configuration securely. Both provider credential entries exist in Vercel, but sensitive values and the selected provider are unavailable to this workspace. All five new push configuration keys are absent. An authorized operator must supply/configure the chosen provider settings through secure environment/provider administration. Then enroll through the authenticated operate_integrations endpoint and verify a real callback through durable processing. Setup is authorized; missing configuration/access is the blocker, not another generic deployment approval. Any newly billable resource still needs its applicable cost approval.
- **Notification webhook:** install the delivery-queue INSERT webhook targeting the canonical dispatch endpoint, authenticated with the existing CRON_SECRET. That secret is only available inside the deployed runtime; sensitive Vercel values cannot be read back, and Supabase Vault has no stored secrets. An authorized operator must securely configure the existing bearer secret or provide authorized secret-management access. Do not blindly rotate it or expose it in source/chat. Then verify delivery on an authorized device.
- **Signed-in verification:** an authorized CMPRI session/test account for relevant roles is unavailable. Supply access securely and verify actual candidate behavior and permission boundaries. Synthetic role/UI and local database tests do not establish live signed-in correctness.
- **Deployment:** do not promote the cron cutover while email push remains disabled/unconfigured, because it would remove the existing import schedule. Complete the preceding gates and verify candidate deployment before final live promotion.

No email watch enrollment, webhook creation, notification test send, secret rotation, or application deployment is claimed. No action remains denied by automatic approval review; the expired migration confirmation was resolved successfully.

## Evidence and diff

Prior full build, typecheck and regression evidence remains in COMBINED-RELEASE-IN-PROGRESS.md. The only implementation change in this execution was the modal trigger/table correction and corresponding test fixture; targeted tests passed 4/4. Final code/test/config diff against the verified production baseline is **2,975 lines added / 2,117 removed**, excluding docs, standalone previews, generated/lock files and binary assets. This is a built candidate total, not a claim that external release gates passed.

## Follow-up access precision

- Production environment metadata rechecked: CMPRI_EMAIL_PROVIDER and both Gmail/Microsoft credential sets exist as Sensitive variables. The provider value cannot be determined from metadata. An existing authorized Engineer/Chief or System Administrator session can GET /api/engineering/operations on the current live site and read email_diagnostics.provider without exposing credentials. This is the first unblock action; do not guess the provider from stored credential names.
- Missing common setting: CMPRI_EMAIL_PUSH_ENABLED=true (enable only with the selected provider configured). Gmail additionally needs CMPRI_GMAIL_PUSH_TOPIC=projects/<project>/topics/<topic>, CMPRI_GMAIL_PUSH_SUBSCRIPTION=projects/<project>/subscriptions/<subscription>, and CMPRI_GMAIL_PUSH_SERVICE_ACCOUNT=<authenticated push service-account email>. Microsoft instead needs CMPRI_MS_PUSH_CLIENT_STATE, a securely generated secret of at least 32 characters. Existing mailbox/tenant/OAuth entries are present, but validity is unverified; only the selected provider needs enrollment.
- CRON_SECRET exists in production and preview as Sensitive. It can be consumed by the deployed runtime, but the available configuration API cannot retrieve it or directly bind it to a Supabase webhook. Vault has no existing secret to reference. The authorized operator must use their retained secret/secret manager to configure the webhook securely. No secret retrieval, rotation or disclosure was attempted.
- No candidate deployment exists for fix/event-driven-combined-release; therefore there is no candidate URL to hand over. Candidate source is a462eff before this documentation update. The current canonical URL still serves the previous baseline. Signed-in UI/API verification needs a candidate runtime with the applied schema and existing credentials. The production smoke script only accepts the canonical production domains; do not point it at an arbitrary preview or bypass its guard.
- Required role coverage: Chief Engineer/Engineer, Technician, GM (manager), AGM (assistant_manager), Front Desk Manager, Front Desk, Housekeeping, Senior Management, and System Administrator; also an inactive-account rejection case. Read-only fixture inventory found five test-marked accounts covering only AGM, Front Desk, Front Desk Manager and GM; these are account records, not available authenticated sessions, and test marking alone is not permission to impersonate them. No sessions were minted.
- Canonical email callback is https://cmpri-engineering.com/api/integrations/email/push. Full provider callback verification cannot precede making that receiver reachable. A separate candidate URL can verify UI/API but cannot by itself verify this hardcoded canonical callback. A controlled callback-first deployment/routing stage preserving the existing email scan is needed before the final cron cutover; no such deployment was made under the instruction to wait for verification.
