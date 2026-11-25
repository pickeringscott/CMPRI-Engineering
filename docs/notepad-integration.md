# Notepad integration

## Approved design

The sole design reference is `docs/previews/Notepad.html`, copied unchanged from the approved attachment.

SHA-256: `7a575540d6f8593285f1c6a3ea4db04c25be24c9b3a2568eb573b4c8a4650b6b`.

The production editor in `public/notepad/` extracts that HTML's Familiar Sidebar, CSS, formatting engine, drawing engine, and attachment controls. The authenticated React host supplies real CMPRI users, notes, palette values, persistence, files, and GIPHY. Preview account switching, sample records, device toggles, and the standalone preview window controls are removed from the production editor; the surrounding CMPRI window provides its existing controls.

The requested header is present: an editable title at the top, title font reflected in the sidebar, palette-colored borderless priority selection, and a borderless trash button. The creator and creation date/time appear together, in that order, right-aligned directly beneath Shared with… and the trash button. Priority occupies the next compact row, followed immediately by the formatting toolbar. Routine Saving/Saved text is removed; autosave, acknowledgements, safe-close flushing, and actionable error recovery remain active. The title wraps and grows as its text, font, window width, or sidebar width changes, without clipping the full title. The existing paperclip expands into the same equal GIF and media/file choices, with the approved telescope transitions.

The latest urgent marker uses Scott's supplied glossy 3D button image, unchanged at `public/notepad/urgent-button.jpg` (SHA-256 `899788a84928515be47b5e8407ae04d87a5a7dd4be96c510b936138d870c9a15`). A circular CSS viewport hides the surrounding checkerboard while retaining the original bevel and highlights. One 2.4-second clock synchronizes both images and the text caret, including after sidebar rerenders, focus, and typing. Browsers supporting manual caret animation retain their native caret; other browsers use a separate overlay that never enters saved note content. Reduced-motion preferences keep the images and caret steady.

## Latest editing and dialog behavior

- Scrollbars appear only when text, replies, attachments, sidebar notes, or actual ink overflow their container. The blank remainder of the drawing canvas no longer reserves a full scrolling page. Drawing layers and 800×1100 ink coordinates are preserved.
- Clicking below the last existing writing line places the caret at that line's end, including a deliberately empty final line. Clicking does not insert content or mark the note edited; Enter retains the existing paragraph, list, and checklist behavior.
- Sidebar pointer releases open a note once without depending on a synthesized click. Reordering remains a separate gesture. Save acknowledgements and remote updates are deferred while a note closes, then applied before the selected note renders, so autosave cannot interrupt the transition.
- Font Color opens a horizontal row of eight colored dots in the established palette order. Accessible color names, keyboard selection, existing text selection, and outside-click dismissal are retained without visible color-name labels.
- Pen and eraser modes use matching cursors only over the drawing surface. The pen popover has no heading or close button; clicking outside dismisses it. Slightly larger ink swatches center their selected checkmark, using black on orange, yellow, and white. A shorter stroke-width track grows in thickness with the selected width, while its handle stays a thin vertical bar.
- Who’s it for? has selectable pills in Roles and Departments and Individual Names, defaulting to Just me. There is one recipient list. Scott Pickering’s System Admin identity is omitted from individual sharing; Scott P’s Chief Engineer identity remains available. The complete directory remains available for existing attribution and role access.
- The creator can add or remove recipients through Shared with…. Non-creators cannot change sharing. New individual recipients are checked again by the server.
- The sharing dialog telescopes from, and back into, the button that opened it. Create Note closes toward New Note before the new editor expands from its center. Accepted creation/sharing changes finish before the host acknowledges a window close; account changes cancel stale dialog callbacks.
- New Note silently reopens an owned untouched draft without checking its age or title. The optional persisted `untouchedDraft` field becomes false after a user edit and cannot be restored by clearing the note. Older blank, nonlegacy revision-1 notes can be reused once and acquire this durable state; legacy notes and explicitly edited notes are excluded. Existing records do not contain a full edit history, so edits made and cleared before their very first pre-update save cannot be distinguished retrospectively.
- Delete confirmation opens centered, has no title bar, and can be dragged by its non-button surface. Its heading, note-specific message, and pill-shaped buttons are centered. Confirmation remains bound to the originating note and account.

## Notepad window and entry points

Daily Work has a dedicated green **Notepad** button. It opens a separate Notepad window with the established move/resize and close-flush behavior, styled in shades of forest green. Saved dashboard placements remain available. The embedded Notepad tab has been removed from Ask CMPRI. Dashboard/notification launches, legacy Ask note-tab requests, and Ask note-result links open the standalone window. Closing Ask does not close Notepad.

`/notepad` is the canonical page; `/notes` and `/staff-notes` open that same component, preserving bookmarked URLs and notification targets. Legacy staff reply anchors resolve to their containing note. Ask's native note tools read and write the same authorized Notepad records, preserving fields omitted from a requested edit.

## Records and access

- New notes start as Just me. Sharing supports All Roles, canonical roles, Engineering, and active individual accounts. Inactive accounts and the six specified test email addresses cannot be selected for tagging.
- The creator controls sharing and deletion. Current recipients can edit shared content, complete tasks, and reply. Authorization is verified on every server read, write, and attachment lookup.
- Completion and reply authors/times are set by the server. Removing an item removes its entire linked reply tree.
- The new tables store documents, per-user sidebar order, and private upload associations. Direct client table access is closed; authenticated server routes perform membership checks.
- Each save carries the version actually displayed in the editor. Conflicts preserve the local draft and require an explicit reload rather than silently replacing someone else's work. Per-account/property outboxes protect unsaved changes and retry the same mutation identity after a lost acknowledgement.
- Refreshes use existing CMPRI resource signals and visibility/focus events. Focused editing and the native file picker defer incoming document replacements.

## Existing Notes and Staff Notes

Original records remain in their original tables. Unconverted personal notes appear privately for their creator; unconverted Staff Notes retain their property's shared audience. The first edit creates a Notepad overlay, preserving identity, creator, creation time, text, formatting, drawings, files, and legacy reply threads. Tombstones prevent deleted migrated notes from reappearing through the original records.

Device-only Notes and old unsaved Notes outboxes transfer to the new outbox without erasing the original browser storage. A transfer marker is written only after the replacement draft is durably protected. Stale older drafts become visible conflicts, not automatic overwrites. Legacy version checks and write guards prevent older clients from silently updating records hidden by an overlay.

## Deployment

Apply `supabase/migrations/20261123135141_notepad_shared_documents.sql` in environments that do not yet have the shared Notepad tables, atomic save function, legacy-write protection, private-upload associations, and resource signals. After Scott authorized the storage fix, this migration was applied to the shared CMPRI database on 2026-11-23. Existing personal notes, staff-note records, and legacy upload records retained matching checksums.

The release schema check requires `supabase/migrations/20261125050000_notepad_edit_history.sql` before enabling Edit History. Existing notes start recording history with the first saved change after migration. A creator’s deletion clears that note’s recorded history.

GIPHY uses the existing `requestGiphy` transport and existing deployment configuration. Files use the existing private `staff-note-files` bucket and native browser picker. Signed access URLs are transient and are not persisted inside note documents. Live GIPHY credentials and actual S Pen hardware remain deployment/device verification items.

## Verification

`npm run test:notepad` runs the approved runtime in jsdom, attachment interactions, outbox recovery and conflicts, authenticated route checks, and real SQL tests in PGlite. Ask, route, workspace, and original-file tests cover the integration with the rest of CMPRI. Latest browser checks exercised the extracted production editor at desktop width and a 390px container: creator/time placement, full title wrapping, the horizontal dot palette and selected-text coloring, blank-area clicks and intentional empty lines, drawing cursor boundaries, and pen swatches/stroke controls. Earlier checks covered title-font changes and the first paperclip expansion afterward. Live GIPHY and hardware-specific pen behavior are not simulated by these browser fixtures.

Use the repository's existing lint, typecheck, production-build, and HTTP-smoke checks as release gates. `TZ=UTC npm test` matches the CI runner's timezone; the unchanged weather observed-layer tests assume UTC and fail with a six-hour offset under America/Chicago.
