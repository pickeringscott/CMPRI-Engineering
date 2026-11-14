# General Notes integration and automatic cross-device saves

Notes is a separate notebook in CMPRI's existing desktop/mobile modal workspace. It follows the [public application overview](https://github.com/pickeringscott/CMPRI-Engineering-Overview/blob/main/README.md): native account/property boundaries, modal navigation, and shared palette tokens. It does not replace Staff Notes or work-order history.

## Approved interaction

- The approved rounded six-icon dock and compact pen/text bubbles are retained. Pen settings have one pen style, stroke preview, width, and native palette swatches. Text settings have checklist, bullets, check state, and sizes 8–24 by two. Outside taps and Escape dismiss settings without resetting selections.
- Text and original pressure-sensitive vector ink share a page. Ink stays above the transparent native text field in both modes; switching to text no longer hides it. The native textarea placeholder shares the cursor's exact font, line height and padding.
- Text mode stays selected during Gboard/native keyboard handwriting input. Choose the pen icon explicitly for original ink. Finger swipes scroll the writing area and finger taps return to text. Real Android keyboard UI and S Pen hardware still require device testing.
- Headerless lists have no indent. Lists beneath a preceding plain-text header indent four spaces. Return preserves that indentation; one Backspace removes the complete marker and its indent.
- **No Save or Download buttons.** Trash is immediately after the always-visible saved-note picker. It is disabled for a newly created note, including after autosave, and enabled only when a saved note is loaded. Deletion requires confirmation and server acknowledgement.
- A stable UUID is allocated once per new note; repeated autosaves update that note. Starting another note and reopening previous notes cannot reuse its identity.

## Autosave and title rules

Every edit is immediately protected in an account/property-scoped local outbox. Completed strokes are queued; individual pointer movements do not issue database calls. Text, title, style and consecutive stroke changes are coalesced into one server save after **one second idle**, with a **five-second maximum wait** during continuous committed input. Native keyboard composition and active ink strokes finish before syncing. Edits that arrive during a request remain queued behind its acknowledged revision. Unchanged documents do not write or increment revisions, on either client or database.

Switching notes flushes queued work without losing the local draft. Modal close finalizes titles and drains queued saves before completing. Hiding/leaving the page also initiates a best-effort flush; abrupt browser termination cannot guarantee a final network request, so the durable local outbox retries when Notes returns. No periodic read polling is used. Focus/open/reconnect revalidate metadata, and an owner-filtered Supabase Realtime subscription refreshes other-device updates. Own acknowledged changes do not trigger extra list reads. Private note APIs bypass the generic device response cache and do not invalidate work orders, rooms or other tools.

An explicit title is preserved. Untitled handwritten/mixed notes default to **Untitled**. For text-only notes with no explicit title, the first nonempty text line becomes the title on leaving/closing the note (list markers are stripped and titles are bounded to 120 characters). Empty new pages do not create database records. Blank titles may temporarily appear as Untitled while editing; no handwriting recognition is required to name an ink note.

Status distinguishes local protection, **Syncing…**, **Synced**, and failure/conflict. Synced is shown only after a successful read/acknowledgement. Offline drafts remain local and retry with bounded exponential backoff or on reconnect. An offline edit cannot appear on another device until it reaches the server. Physical Gboard's panel availability is not established by synthetic IME tests.

## Shared storage and privacy

`/api/notes` authenticates through the existing CMPRI principal. Hotel and owner IDs come from that principal; request bodies cannot assign them. GET lists only small title/revision summaries; full original ink/text is fetched for the opened note and cached until its revision changes. PUT uses an expected revision and stable mutation UUID, so retries are idempotent and stale devices cannot overwrite newer work. A conflict keeps the local draft and offers **Keep both versions**, creating an explicitly separate copy instead of silently rebasing.

The migration creates `cmpri_general_notes`, its private owner/property RLS read policy, and a service-only SECURITY INVOKER mutation function with a fixed empty search path. Ordinary authenticated clients cannot write the table or call the service function. Both the route and function check active account/property access. A per-owner lock bounds the notebook to 500 active notes. JSON documents and actual request streams are size-limited. Deletions leave revisioned tombstones so stale devices cannot resurrect records and filtered realtime events retain owner identity. Original recorded ink colors are preserved independently of later palette changes.

The local cache/outbox remains partitioned by account/property and is not encrypted. It is a recovery mechanism, not an authorization boundary. Existing account-scoped notes from the first PR stage can be queued for sync; the standalone prototype's unscoped storage is not automatically assigned to any account.

## Release boundary

Apply and verify `20261114065316_general_notes_autosync.sql` through the normal reviewed release process **before deploying this source**. `npm run check:release-schema` checks the new table columns. The migration has **not** been applied to production in this session, and no production notes or work orders were created. The PR remains unmerged and undeployed.

Stable `@note-title` references and a nested note popup in real work orders remain a separate integration step. Existing staff/role/ticket mention parsing, permissions, notifications and work-order history are unchanged. A web browser/PWA cannot observe physical S Pen holder insertion/removal; native Android integration is still required for holder events.

## Verification

- `npm run test:general-notes`: list/title semantics, local protection, batching/no-op suppression, keyboard composition, independent device handoff, in-flight edits, offline recovery, lost acknowledgements, conflicts and separate copies; authenticated API validation; actual PostgreSQL revision/idempotency/tombstone checks, RLS isolation, inactive-member and direct-write denials.
- Full lint, typecheck, `npm test`, and production build with CI placeholder credentials.
- `npm run test:general-notes-ui`: actual note API handlers → isolated PostgreSQL → production browser UI. Independent desktop/phone contexts verify shared saves, batching, multiple notes, original ink, native palette/approved controls, placeholder metrics, headerless lists, Trash placement, finger gestures and native input composition. Authentication and unrelated APIs are fixtures; the Notes database path is real and isolated.

To repeat browser acceptance with Playwright Python installed:

```sh
NEXT_PUBLIC_SUPABASE_URL=https://ci-placeholder.supabase.co NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=ci-build-placeholder npm run build
npm start -- --port 3000
# Second terminal:
npm run test:general-notes-ui
```

The test accepts only a localhost app. Its isolated API/database process is started and stopped by the runner. No hosted credentials, real staff accounts or production writes are used. Actual hosted Realtime delivery and physical Gboard/S Pen behavior remain release/device acceptance checks.
