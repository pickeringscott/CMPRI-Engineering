# Modal event audit — implemented locally, release held

Audited real application code on combined-release branch after 7a87d86. No production writes or deployment.

## Changes
- Removed Detail's 30-second maintenance-reference poll, Room Ranking's 15-second poll, Daily Ops' every-minute network refresh, and pending phone-test status polling.
- Detail now refreshes ticket, attachments and external/history activity on order signals; room context on room signals; manuals, asset PDFs and reference lists on reference signals. Background ticket reads recheck editor fingerprint, dirty state and save state before applying. Unsaved text and revision are retained with a conflict message; latest history/media can still refresh. Lifecycle guards/abort and request generations suppress stale responses.
- Create subscribes once for initial and subsequent room/equipment/duplicate-candidate loads, preserving form fields. Cleanup stops listeners and prevents late reference loads applying after close.
- Work Order List, notifications/mentions and Pool already used shared resource subscriptions. Modal iframes now reuse their same-origin parent's channel when available. Independent top-level tabs retain independent channels. Hidden/inert/CSS-hidden modal layers suppress event reads and catch up on reveal. Removing a frame or pagehide releases delegated subscriptions; final subscriber removes auth/realtime/event listeners.
- New migration 20261106084745_modal_resource_events.sql adds content-free reference, room, history, operational purchase/shipment/Enseo/warranty/followup, completed photo storage, and recipient-private diagnostic test signals. Staging photo objects and unrelated buckets/paths are excluded. APIs remain the permission boundary; no business data is added to browser signal payloads.
- Daily Ops uses the existing hotel-time boundary calculator for guest checkout/arrival, 3/4pm housekeeping transitions and midnight. This intentional one-shot business transition read remains. Draft autosave, request timeout, animation, and transient UI feedback timers remain. No setInterval remains in src/app or src/components.

## Validation
- Full npm test passed: main suite 1,302 tests, 1,300 passed and 2 pre-existing skipped; subsequent phone/database/PO/release commands passed, including all 26 portable PO commands and Pool DST/role/transaction tests.
- After final initial-load/diagnostic catch-up adjustments, 34 focused tests passed; TypeScript and scoped ESLint passed without warnings.
- New tests exercise actual ticket loader during typing/save/close; host/iframe channel sharing, hidden/reveal/removal cleanup; PostgreSQL tenant/recipient isolation, all new signal sources, photo staging exclusion, and private function denial.
- Production build and PDF runtime extraction/trace checks passed with synthetic public Supabase configuration and telemetry disabled. No real credentials or guest data were used. Final layout-effect guard received focused rerun and type/lint verification.
- Two old test harnesses gained lifecycle/visibility mocks; recovery/signature tests were updated for the explicit background path. Work Order reference renderer's relative module resolver was corrected to support the previously added Flyover badge helper.

## Limits and release requirements
- Both resource migrations remain unapplied to production. Realtime publication, actual Storage trigger privileges, end-to-end live role sessions and notifications must be verified during the separately authorized combined release. Local PostgreSQL tests do not establish live enablement.
- External spreadsheet Room Ranker (/api/room-ranker) has no verified inbound change event. Its ticket context catches up on room/reconnect/reveal events; changes made only in the external spreadsheet cannot be claimed instant. CMPRI's ticket-based Room Ranking (/api/ticket-room-ranker) is fully covered by orders/locations signals.
- Full exact approved header v23 implementation and email-push completion are separate open work; the preview is not production code. Existing email-push edits were excluded from this audit commit. No deployment, migration apply, push, or release finalization.

Logs: /tmp/cmpri-modal-test-final.log, /tmp/cmpri-modal-focused-final.log, /tmp/cmpri-modal-guard-final.log, /tmp/cmpri-modal-build-final.log.
