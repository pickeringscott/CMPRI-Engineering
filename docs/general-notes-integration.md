# General Notes integration and automatic cross-device saves

Notes is a separate notebook in CMPRI's existing desktop/mobile modal workspace. It follows the [public application overview](https://github.com/pickeringscott/CMPRI-Engineering-Overview/blob/main/README.md): native account/property boundaries, modal navigation, and shared palette tokens. It does not replace Staff Notes or work-order history.

## Approved interaction

- The approved rounded dock and compact pen/text bubbles are retained. Its five icons are keyboard, pen, eraser, undo and redo; the duplicate Writing settings control is removed, and selecting the keyboard or pen icon opens its matching bubble. Pen settings have one pen style, stroke preview, width, and native palette swatches. Text settings have checklist, bullets and sizes 8–24 by two; each checkbox toggles directly in the note. Outside taps and Escape dismiss settings without resetting selections.
- Text and original pressure-sensitive vector ink share a page. Ink stays above the transparent native text field in both modes; switching to text no longer hides it. The native editable text field placeholder shares the cursor's exact font, line height and padding.
- Text mode stays selected during Gboard/native keyboard handwriting input. Choose the pen icon explicitly for original ink. Finger swipes scroll the writing area and finger taps return to text. Real Android keyboard UI and S Pen hardware still require device testing.
- Headerless lists have no indent. Lists beneath a preceding plain-text header indent four spaces. Return preserves that indentation; one Backspace removes the complete marker and its indent.
- A single compact title/picker box replaces the separate title label and field. It shows muted **Note Title** until a title is entered; its arrow opens saved notes. Header/picker spacing and the gaps around Trash/+ are tightened. The unruled writing page uses an 8px outer inset matching the app scrollbar, without a desktop width cap. Bottom helper and preview-only copy are removed.
- **No Save or Download buttons.** Trash is immediately after the always-visible saved-note picker. It is disabled only for an empty draft or during loading/deletion. Any current note with content or an entry in the saved-note list can open confirmation immediately, including before the first server acknowledgement. Deletion uses an in-modal confirmation and requires server acknowledgement.
- A stable UUID is allocated once per new note; repeated autosaves update that note. Starting another note and reopening previous notes cannot reuse its identity.

## Autosave and title rules

Every edit is immediately protected in an account/property-scoped local outbox. Completed strokes are queued; individual pointer movements do not issue database calls. Text, title, style and consecutive stroke changes are coalesced into one server save after **one second idle**, with a **five-second maximum wait** during continuous committed input. Native keyboard composition and active ink strokes finish before syncing. Edits that arrive during a request remain queued behind its acknowledged revision. Unchanged documents do not write or increment revisions, on either client or database.

Switching notes flushes queued work without losing the local draft. Modal close commits native input, finalizes titles, protects the draft locally and allows up to 1.2 seconds for a keepalive sync before completing. Hiding/leaving the page also initiates a best-effort flush; abrupt browser termination cannot guarantee a final network request, so the durable local outbox retries when Notes returns. No periodic read polling is used. Focus/open/reconnect revalidate metadata, and an owner-filtered Supabase Realtime subscription refreshes other-device updates. Own acknowledged changes do not trigger extra list reads. Private note APIs bypass the generic device response cache and do not invalidate work orders, rooms or other tools.

An explicit title is preserved. Untitled handwritten/mixed notes default to **Untitled**. For text-only notes with no explicit title, the first nonempty text line becomes the title during editing and on each autosave, with closing also finalizing the latest input (list markers are stripped and titles are bounded to 120 characters). Empty new pages do not create database records. Blank titles may temporarily appear as Untitled while editing; no handwriting recognition is required to name an ink note.

Status distinguishes local protection, **Syncing…**, **Synced**, and failure/conflict. Synced is shown only after a successful read/acknowledgement. Offline drafts remain local and retry with bounded exponential backoff or on reconnect. An offline edit cannot appear on another device until it reaches the server. Physical Gboard's panel availability is not established by synthetic IME tests.

## Desktop resizing and session revalidation

The Notes session guard distinguishes real access denial from transient failures. A failed focus/network recheck (or a temporary missing SDK snapshot) keeps the already verified editor mounted, with a brief connection warning. An explicit sign-out, account change, or HTTP 401/403 still hides the notebook. Rechecks are coalesced and throttled; resizing changes only layout and does not recreate the note or its iframe.

The shared request cache also tracks its creator document. If a modal iframe created that cache, closing/reloading it aborts that owner’s outstanding reads, releases its listeners/channel, and restores the host’s original native fetch. Surviving windows can create a fresh cache; a reloaded iframe cannot inherit unresolved promises from a discarded document. Sign-out still clears persistent cached records, including after the old owner has closed, and incremental releases tolerate a still-live parent using the previous cache interface.

The browser regression resizes a same-origin Notes iframe through desktop/mobile widths while session rechecks and note writes return 503. It verifies that the document identity, visible unsynced text and local outbox survive, then reloads and confirms draft recovery and successful sync. Dedicated session/cache-owner tests cover actual denial, account changes, late responses, sibling-window recovery, legacy interfaces and sign-out so preserving a draft does not bypass authorization.

## Shared storage and privacy

`/api/notes` authenticates through the existing CMPRI principal. Hotel and owner IDs come from that principal; request bodies cannot assign them. GET lists title/revision summaries plus plain note text for local title/body search after a 500ms debounce. This avoids database calls on each search. Original ink is fetched only for an opened note and cached until its revision changes. PUT uses an expected revision and stable mutation UUID, so retries are idempotent and stale devices cannot overwrite newer work. A conflict keeps the local draft and offers **Keep both versions**, creating an explicitly separate copy instead of silently rebasing.

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

The saved-note title picker uses a compact anchored popup with 28px result rows and a 32px title row, including search on mobile. A direct mobile Notes shortcut remains visible independently of collapsed/reordered Operations controls. Cache-generated stale-session responses carry `X-CMPRI-Session-Changed`; Notes retries them once rather than treating them as server authorization denial, and recognizes the exact legacy cache sentinel when an older parent bundle lacks that header. Genuine server 401/403 responses continue to gate access. Browser acceptance drags the actual dashboard Notes window resize handles and verifies document identity, unsynced draft recovery, and the mobile launcher.

## Inline checks, references and mobile closing

Desktop pointer devices use 30px toolbar controls with 18px icons and 232px bubbles; touch devices retain the larger controls. The selected note font size applies to all textarea text, including bullets and checklist markers, overriding the global modal typography. Checklist markers have measured, accessible checkbox buttons that toggle directly at their actual text positions, including after wrapping and textarea scrolling. The separate check/uncheck toolbar action is removed. The native editable text field and IME remain intact.

Notes reuse the existing Staff Notes directory and insertion/range helpers for people, roles, Front Desk names and locations, plus the permission-filtered work-order reference resolver. Selected target identities are saved in optional JSON document mention ranges and rebased when editing text. No database schema change is needed for this optional document field. `/api/notes/targets` returns the authenticated property's directory without loading the Staff Notes feed or exposing recipient lists. These personal notes send no mention notifications. Existing HTTP(S) link parsing supplies clickable website URLs; stored markup is never executed. Work-order links only appear after the existing resolver confirms access.

Mobile closing finishes the active ink stroke, blurs the native editor to commit composition, and protects the final draft. A keepalive sync gets up to 1.2 seconds before the modal closes with the durable local outbox preserved; stalled networking cannot trap the user in the editor. If local protection fails and the note has not synced, the editor stays open with the existing failure message. Browser acceptance covers interrupted composition plus a deliberately unanswered save, close/reopen recovery, successive mention completion, persisted selected identities, URL opening, desktop/touch geometry and direct checkbox mouse/keyboard interaction.

## Selected text size and palette colors

Select any body text, then choose size (8–24 by two) and/or a color in the text bubble. Its color swatches use exactly the same CMPRI accent palette and tokens as the pen. Formatting affects only that selection and preserves its other attributes; with a collapsed caret it sets the style for subsequent typing. Choosing Text restores the theme foreground. Chosen accent colors are saved as resolved RGB values, preserving original colors like ink.

The browser-native editable field renders mixed sizes and colors at their actual positions. Saved notes keep plain `text` for existing search, title and mention behavior, plus optional validated `textStyles` ranges; no supplied HTML is stored or rendered. Old notes without ranges keep their existing default font size. Ranges split/merge for selection changes and rebase around edits. Text/format keyboard undo and redo restore both formatting and mention identity. Checkbox and URL hit areas measure actual rich text ranges, so wrapping and mixed sizes remain aligned with the caret. Plain-text paste and native IME block/line-break normalization preserve the saved text representation.

Formatting is protected in the existing outbox and optimistic cross-device save, with no new database schema or per-format database request. API/storage validation rejects unsafe colors, unsupported sizes, overlapping/out-of-bounds ranges and unknown style fields. Browser acceptance verifies separate sizes/colors in one note, preservation when changing only size, subsequent typing style, undo/redo, save/reopen and an independent mobile context receiving the same formatting alongside all earlier notes regressions.

List marker presentation follows the first visible character of its item: selecting only a label's words to change size/color also updates its checkbox or bullet dot. Empty items fall back to the marker's formatting. Checkbox SVG dimensions are explicit pixels derived from that text size, so the visible outline/check scales with the type rather than relying on inherited SVG em sizing. Browser checks compare actual checkbox SVG and bullet glyph widths at 8px versus 24px, persist label-only formatting to another device, and exercise both desktop and mobile deletion, cancellation and reload without resurrecting tombstoned notes.

Nested ink/point, mention and text-style fields are canonicalized before no-op comparison. JSONB key ordering therefore cannot enqueue a false edit while closing/reloading an unchanged note after another device deleted it. Existing conflicting local copies may be explicitly discarded with Delete only after the server confirms that the note is already gone; a competing live version remains protected. Unit regressions exercise reordered JSONB responses, no extra write on close, deleted-note conflict cleanup, and refusal to erase a competing live edit.

Trash is a standard native action button without the formatting tools' pointer-down focus suppression. Its enabled state is derived from the current text/title/ink or library entry, rather than a separate loaded/read-cache flag. Same-note refreshes retain an open delete confirmation; selecting another note resets it. Browser regressions hover/click on desktop and use real touch taps on mobile before a first save is acknowledged, cancel the confirmation, update the automatic first-line title, preserve a manually entered title, and perform the confirmed deletion. Additional touch tests exercise Trash hit testing, cancellation and deletion inside the actual mobile dashboard iframe.
