# General Notes: first integration PR

This change starts the Samsung Notes-style notebook inside CMPRI. It follows the [public application overview](https://github.com/pickeringscott/CMPRI-Engineering-Overview/blob/main/README.md): tools remain in the existing desktop/mobile modal workspace, account/property boundaries are preserved, and approved palette tokens supply the styling.

## Included

- A separate **Notes** launcher beside **Staff Notes**, opening `/notes` through the existing desktop window/mobile modal system. Staff Notes, ticket history, permissions, and notifications retain their existing behavior.
- Required typed titles; separate notes can be saved, searched, reopened, edited, deleted, or downloaded with an unsaved draft.
- Native text input, including keyboard/IME composition. Text stays selected through pen contact so Gboard handwriting-to-text can enter recognized text. Select the pen icon explicitly to draw original ink.
- A single pen style, pressure-sensitive vector strokes, the existing CMPRI accent colors, width control, eraser, and ink undo/redo. Existing ink retains its recorded color when themes change.
- Finger scrolling and tap-to-keyboard while in ink mode. The typed title always remains editable.
- Four-space-indented bullets/checklists below headings. Return continues the list; one Backspace removes its entire marker/indent. Check state and text sizes 8–24 in steps of two are saved.
- Inline bottom controls only. The prototype's floating settings box and duplicate palette have been removed. The native application uses `modalThemeStyle`, `ModalTheme`, `followSitePalette`, and generated shared palette tokens rather than a second theme.

## Deliberate first-stage boundary

Saved notes are **device-local**, partitioned by authenticated hotel and user. `/api/session` verifies the account before loading and again before save/delete. Supabase auth changes clear the visible notebook. No hosted table, bucket, migration, API mutation, guest record, work order, or production data is created by this PR. Invalid saved data and stale revisions produce an error instead of being silently overwritten. A single note's stale revision is checked against local storage before a save; this is not a database transaction or a cross-device concurrency guarantee.

The standalone review file's unscoped local-storage key is not automatically imported into an authenticated account. The downloadable backup preserves that review data.

The notebook is retained in local browser storage across sign-out so the same account can reopen it. Account/property scoping prevents accidental display through another account's UI; local storage is not encrypted and is not a server authorization boundary. Browser data removal deletes it. Export a backup first.

**Do not treat this as the completed shared Notes feature.** Cross-device access and production `@note-title` work-order references require the next stage: a reviewed owner/property access model, shared persistent ink/text storage, authenticated APIs and RLS, stable note-ID references, and a nested read popup. Do not post device-local note references to real work orders. The standalone demonstration showed that intended interaction; this PR does not alter staff/role/ticket mention parsing or notifications.

A web browser/PWA cannot observe the S Pen entering/leaving its holder. Actual holder integration remains a native Android host task. Gboard's physical handwriting UI and the real S Pen must be tested on the user's device; browser composition and synthetic pen events do not establish those results.

## Validation

- `npm run test:general-notes` covers account/property keys, saved ink, list editing, invalid data, and stale revision recovery.
- Run typecheck, lint, approved palette/header/modal and work-order mention regression tests, then the production build.
- Browser acceptance covers desktop/mobile editor, native input composition, separate saved notes and reopening, ink/undo/redo, finger gestures, no settings popup, and session isolation using local fixtures. No real staff accounts or production data are used.

### Checks completed for this PR

Passed: full `npm run lint`, `npm run typecheck`, `npm test`, and the production `npm run build` using CI placeholder credentials; 58 focused notes/palette/header/modal/work-order-mention regressions; and the integrated production-build desktop/mobile browser acceptance test.

To repeat the browser check with Playwright Python installed:

```sh
NEXT_PUBLIC_SUPABASE_URL=https://ci-placeholder.supabase.co NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=ci-build-placeholder npm run build
npm start -- --port 3000
# In a second terminal:
python tests/browser/general_notes.py
```

The browser script accepts only a localhost server. It fixtures `/api/session` and all API responses, uses synthetic accounts, and makes no production mutations. It proves DOM focus, editable text, IME composition, and simulated touch/pen input; it cannot prove that Android opens Gboard's handwriting panel.
