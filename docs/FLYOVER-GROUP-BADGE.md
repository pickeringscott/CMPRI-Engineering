# Flyover group badge — combined release

Authorized November 6, 2026; no independent deployment.

Verified source: origin/main commit dcf7767 (Flyover Studio Image), exact path `.bridge/FFS_Logo6.avif`. The only main-branch change since application baseline eb3707d is this asset. Public runtime copy `public/FFS_Logo6.avif` is byte-identical, SHA-256 `0cfbf929713c34e1ba7542f19caf90ad4eb31fa47e8d65386c15bf4a33444882`; intrinsic dimensions 906x644, alpha preserved.

Read-only inspection of the latest hotel-scoped `cmpri_room_operation_imports.source_rows` returned the group/company label `FLYOVER STUDIOS` (also `CN RAILWAYS`). No guest names were retrieved. Mapping normalizes whitespace/case and accepts exactly Flyover Studios or Flyover Film Studios; unrelated substrings/abbreviations do not match.

Shared GuestGroupBadge component retains the existing Big Ten mapping and adds Flyover. Daily Ops current/incoming placements use the existing group/company fields. Work Order List receives only current/incoming badge identifiers from its already loaded effective room snapshot, without exposing raw company/name data to additional roles. Current badges sit beside room identification, outside the work-order-number text; after checkout, a known incoming badge appears beside Reserved. Existing projection controls guest transitions; this change does not modify arrival/checkout times, occupancy, guest membership, permissions or data. Existing CN artwork/rendering is retained.

Daily Ops uses existing 27px badge height; list uses existing CN-relative 1.15em height, width auto and object-contain. No crop/stretch or replacement design.

Validation: 45 focused tests pass across room-group-badges, room-operations and work-order-dashboard suites. Tests cover exact group matching, negative matches, checkout/reserved/arrival transition, byte identity/dimensions, rendered alt text and safe API metadata. TypeScript, scoped ESLint and git diff --check pass. Logs: /tmp/cmpri-flyover-tests.log, /tmp/cmpri-flyover-types.log, /tmp/cmpri-flyover-lint.log.

No production data mutations, migration application, branch push or deployment. Existing unfinished email-push changes remain separate and uncommitted; the combined release is still open. Work Order visual preview remains Library libfile_05791251a19481919abc007e74992698; no additional badge preview was requested or created.
