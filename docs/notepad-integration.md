# Notepad integration

## Approved design

The sole design reference is `docs/previews/Notepad.html`, copied unchanged from the approved attachment.

SHA-256: `7a575540d6f8593285f1c6a3ea4db04c25be24c9b3a2568eb573b4c8a4650b6b`.

The production editor in `public/notepad/` extracts that HTML's Familiar Sidebar, CSS, formatting engine, drawing engine, and attachment controls. The authenticated React host supplies real CMPRI users, notes, palette values, persistence, files, and GIPHY. Preview account switching, sample records, device toggles, and the standalone preview window controls are removed from the production editor; the surrounding CMPRI window provides its existing controls.

The requested header is present: an editable title at the top, title font reflected in the sidebar, a single compact Priority/creator/time line, palette-colored borderless priority selection, and a borderless trash button. The title now wraps and grows as its text, font, window width, or sidebar width changes, without clipping the full title. The existing paperclip expands into the same equal GIF and media/file choices, with the approved telescope transitions.

The latest urgent marker uses Scott's supplied glossy 3D button image, unchanged at `public/notepad/urgent-button.jpg` (SHA-256 `899788a84928515be47b5e8407ae04d87a5a7dd4be96c510b936138d870c9a15`). A circular CSS viewport hides the surrounding checkerboard while retaining the original bevel and highlights. It blinks in both the sidebar and open note; reduced-motion preferences show the same image steadily.

## Notepad window and entry points

Daily Work has a dedicated green **Notepad** button. It opens a separate Notepad window with the established move/resize and close-flush behavior, styled in shades of forest green. Saved dashboard placements remain available. Dashboard and notification launches no longer redirect into Ask CMPRI. Ask's existing Notepad tab remains another way to reach the same records.

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

Apply `supabase/migrations/20261123135141_notepad_shared_documents.sql` before activating this application version in an environment that does not yet have it. It adds the Notepad tables, atomic save function, legacy-write protection, private-upload associations, and resource signals. The release schema check includes the new requirements. After Scott authorized fixing the missing-storage error, this exact migration was applied to the shared CMPRI database on 2026-11-23. Existing personal notes, staff-note records, and legacy upload records retained matching before/after checksums; migration history matches the repository version. No further database changes are required for the green window, wrapping title, or urgent-image update.

GIPHY uses the existing `requestGiphy` transport and existing deployment configuration. Files use the existing private `staff-note-files` bucket and native browser picker. Signed access URLs are transient and are not persisted inside note documents. Live GIPHY credentials and actual S Pen hardware remain deployment/device verification items.

## Verification

`npm run test:notepad` runs the approved runtime in jsdom, attachment interactions, outbox recovery and conflicts, authenticated route checks, and real SQL tests in PGlite. Ask, route, workspace, and original-file tests cover the integration with the rest of CMPRI. Browser checks exercised the extracted production editor at desktop width and a 390px container, including the title-font change and the first paperclip expansion afterward.

Use the repository's existing lint, typecheck, production-build, and HTTP-smoke checks as release gates. `TZ=UTC npm test` matches the CI runner's timezone; the unchanged weather observed-layer tests assume UTC and fail with a six-hour offset under America/Chicago.
