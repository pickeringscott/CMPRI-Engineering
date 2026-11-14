# Preview / production parity — November 14, 2026

The Notes production release is squash commit `5d3417f` (PR #47). Its owner-private Notes migration is applied to the shared CMPRI database. Transactional production checks passed creation, retry, no-op saves, updates, stale revision rejection, deletion, owner isolation and service-only RPC permissions. The production domain serves the new deployment, and anonymous Notes API access requires authentication. Temporary test users, profiles, memberships, notes and sessions were removed and independently counted at zero.

## Differences corrected

- `VERCEL_ENV=preview` previously enabled the manual-reader review guard for the entire app. It blocked Notes saves/deletes and every other API mutation, disabled persisted troubleshooting/PM/winter actions, and prevented side-effecting integration reads. Read-only review now requires the explicit `CMPRI_MANUAL_PREVIEW_READ_ONLY=1` flag. Both route and database/storage guards remain available when that flag is set.
- Eighteen application configuration entries were production-only or had separate preview overrides. Their existing production Vercel entries now also target Preview: GIPHY, purchasing flags, Gmail identity/provider selection, push configuration, notification webhook authentication, native/legacy PM spreadsheet access, the service-role client and application URL. Secret values were not retrieved, printed or copied into files. Both environments now reference the same Vercel entry IDs for those settings.
- Five earlier preview overrides remain scoped to `archive/preview-config-before-20261114` for rollback. That archive is intentionally outside current preview parity. Existing shared Supabase public configuration, integration API credentials and integration safe mode remain shared. Unused legacy connection variables were not distributed to additional environments.
- The old missing-Notes-schema observation is retained as history, with a dated release correction in the Notes integration document.

Normal previews retain their own host, Vercel environment label, browser storage and deployment protection. Scheduled Vercel Cron execution remains a production hosting function. These platform differences do not disable authenticated application actions in Preview. Preview uses the live property database, as it did before; permitted writes affect real records.

## Validation and limits

Six new regressions exercise normal preview/production route parity, explicit read-only denial for mutations and side-effecting reads, and the second database/storage write guard. They run in `npm test`. Existing session, routing, permission, Notes and database regression suites remain in place. Local lint, type checks, the complete test command and the production build passed before publication.

The workspace network policy currently denies direct browser/HTTP connections to the production, preview and Supabase hosts. Production deployment availability was checked through the Vercel connector and database behavior through the Supabase connector. Signed-in live browser acceptance, hosted Realtime delivery and external-provider behavior remain unverified until that access is enabled. The local browser acceptance script is not a substitute for those live checks. No test messages, notifications, work orders or external integration jobs were initiated.
