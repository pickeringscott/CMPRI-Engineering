# Staff Notes repair and verification — November 6, 2026

## Scope

This release repairs Staff Notes people/role/name/location mentions, existing work-order references, hashtags, shared Front Desk authorship, and the existing button's new-note flag. It does not certify the entire historical 254-entry ledger or introduce unrelated layout or permission changes. The repository README is a separate review draft and is excluded from this release.

## Confirmed defect and repairs

The original public mention directory discarded account identity while withholding recipient arrays. First-name and full-name aliases could consequently appear to the completion code as different targets, so an individual name failed to complete even when role completion worked. The rendered baseline produced zero person suggestions for `@Sc` and a working role suggestion for `@Ch` in the synthetic Scott/Chief Engineer case.

The patch makes the following changes:

1. Retains public target IDs and explicit types independently of private recipient lists. Individual accounts, roles, captured Front Desk names, locations, and tickets cannot silently become one another.
2. Deduplicates first/full-name aliases by account ID. Ambiguous first names require choosing the intended full target. The supported role targets remain available, including administrator and senior-management labels.
3. Adds an accessible `@` suggestion list, keyboard selection, touch selection, and draft-edit handling while preserving the approved feed, composer, media controls, and modal layout.
4. Stores selected target IDs/types and text spans with each note. Draft edits shift valid spans or invalidate an edited target; posting, replies, reopening, and later account renames retain the intended saved identity.
5. Captures a real shared Front Desk author's name before posting. A property-scoped registry makes these names mentionable without creating accounts or modifying the shared profile. Historical named Front Desk authors seed display targets without rewriting original notes.
6. Resolves captured Front Desk names as display-only mentions. They do not invent individual account notifications. A display name matching an actual person's name remains a distinct selectable type.
7. Adds active property room/location targets to the `@` directory. Selected numeric room mentions do not accidentally become work-order references. Plain `room 204` is not an additional trigger.
8. Reuses established work-order reference forms and the existing exact-reference API. Resolved references bind to actual authorized ticket IDs, display actual work-order numbers, and open the existing ticket modal. Ambiguous legacy numbers do not link an arbitrary ticket.
9. Revalidates targets on the server against active property members, captured names, locations, and the existing ticket read policy. Foreign-property targets, inactive sessions, and anonymous writes remain denied. Mentioning a target grants no access.
10. Preserves native emoji text, replies, and original hashtag text; hashtags render blue. No new hashtag analytics, filtering interface, trending, or notifications are introduced. Existing stored hashtag metadata is preserved.
11. Preserves failed-send drafts and request identity. Successful retries save once, retain selected targets, and do not duplicate durable delivery intents or provider sends.
12. Moves the visual new-note indicator onto the existing Staff Notes button and removes the separate floating Staff Notes link. The marker does not change button dimensions. Screenshot inspection caught and corrected an existing header rule that otherwise hid its pseudo-element.
13. Keeps management flags until notes are actually viewed/cleared. Hidden or minimized note frames do not acknowledge notes merely because their iframe document exists.
14. Gives shared Front Desk the property-local third-calendar-day 6 a.m. expiry. Viewing alone does not clear this flag. Different expiration windows keep newer notes flagged after older ones expire; daylight-saving changes use Chicago calendar dates.
15. Uses existing resource events and Realtime subscriptions, adding captured-name insert updates. Front Desk expiry uses a local deadline timer without a server poll. Existing personal notification schedules, audio eligibility, and durable push dispatch remain separate.
16. Adds a backward-compatible database migration: captured names with property isolation/RLS, note target metadata, author-name identity, restricted service-only capture/posting functions, and Realtime publication of captured names. Posting reuses the existing atomic media/notification transaction.
17. Extends release-schema checks and isolated API/PostgreSQL/browser regression coverage. Tests use synthetic identities, data, and provider transport; they do not post production notes or notify real staff.

## Desktop and mobile verification

The browser tests use the real rendered application at 1440-pixel desktop and 390-pixel touch viewports. Staff Notes requests run the actual source API handlers against isolated PostgreSQL, with the existing push dispatcher connected to a mocked provider.

| Target / feature | Trigger and suggestions | Select and edit draft | Post and appearance | Reply | Reload identity/text | Recipient/link boundary |
| --- | --- | --- | --- | --- | --- | --- |
| Role mention | Pass, both | Pass, both | Pass, both | Pass, both | Pass, both | Existing role recipient resolution passes |
| Individual account name | Pass, both | Pass, both, including changing the selected person | Pass, both | Pass, both | Pass, both, including later profile rename | Correct account inbox/delivery intent and mocked provider acceptance; no other same-name account substituted |
| Captured Front Desk name | Pass, both | Pass, both | Pass, both | Pass, both | Pass, both | Display-only identity; no invented account recipient |
| Room/location | Pass, both | Pass, both | Pass, both | Pass, both | Pass, both | Exact room ID retained; foreign location rejected; no invented person recipient |
| Work-order reference | Pass, both, using established number syntax | Pass, both | Pass, both, actual number shown | Pass, both | Pass, both | Correct ticket modal opens; cross-property target rejected |
| Hashtag | Pass, both; no mention picker for hashtag text | Pass, both | Pass, both; computed blue color verified | Pass, both | Pass, both | Text-only hashtag behavior; no new notification recipient |

Additional checked behavior:

- Bare `@` exposes the supported people, role, captured-name, and room categories.
- Shared Front Desk capture, posting attribution, reopening, and Change name work; the actual profile remains unchanged. Generic/empty/oversized names are rejected, and non-shared accounts cannot use the capture endpoint.
- Failed saves retain the edited draft; retries preserve targets and save once.
- The real durable notification SQL and existing dispatcher produce the intended individual account delivery; exact retries do not send twice to the mocked provider.
- Native emoji sequences survive edits, database storage, replies, and reloads.
- Foreign/inactive/anonymous target and session checks fail closed. Hours, profile, and private-feedback sentinel data remain unchanged.
- Management flag retention/clearing passes for General Manager, AGM, Front Desk Manager, Chief Engineer, Technician, and System Administrator at both widths.
- Shared Front Desk retains its flag while viewing notes, then clears exactly at Friday 6 a.m. for a Tuesday 2 p.m. post. Both widths verify no extra GET at the expiry boundary and no reappearance after reload.
- The flag's rendered CSS and screenshots are checked, in addition to the unread attribute.

The dedicated browser run has 29 passing cases: 12 target/width cases, 12 management flag/width cases, 2 Front Desk expiry/width cases, 2 shared Front Desk posting/width cases, and 1 draft/retry/identity/access case.

## Test infrastructure and files

Application changes are concentrated in:

- `src/components/StaffNotes.tsx`, `StaffNotesUnread.tsx`, and `desktop/ApprovedDashboardMenus.tsx`.
- `src/app/api/staff-notes/route.ts` and the new `names/route.ts`.
- `src/lib/staff-notes.ts`, new target/flag/client-summary helpers, and the property-scoped server directory helper.
- `src/app/staff-notes-design.css` and one Staff Notes migration.
- `scripts/check-release-schema.mjs` and the new isolated browser runner.

Verification extends existing Staff Notes and schema-gate tests and adds target identity tests, an actual-handler local test backend, a PostgreSQL adapter, migration fixtures, and desktop/touch browser tests. The approved-interface suite includes the new Staff Notes suite. Anonymous HTTP smoke covers the new capture endpoint.

## Limits

- Desktop and touch browser verification runs Chromium on the available test host. It does not establish physical Windows Chrome app behavior or Android device rendering beyond the exercised Chromium input model.
- Emoji character preservation is verified; Windows/Android-specific artwork is supplied by the user's operating system and is not certified by these tests.
- Individual account notification resolution, durable SQL intents, dispatcher execution, mocked provider acceptance, and retry deduplication are verified. Real provider delivery and physical device notification display are not claimed.
- Synthetic tests do not replace production schema/deployment verification. No production test posts or alerts are sent to other staff.
- Supabase advisors contain pre-existing findings. Release verification must compare before/after results and identify any new findings rather than claiming the whole database has none.

## Release gates and production database verification

- Full `npm test`: passed. The main run had 1,340 passing tests, zero failures, and two optional source-PDF tests skipped because their files were unavailable. The remaining employment, parser, phone-notification, PostgreSQL, purchasing, and release suites also passed. Purchasing ran all 26 portable commands; migration verification ran 85 checks.
- Final focused Staff Notes run after tightening author shortcuts: 24/24 passed. The migration/target run including the author-name index passed 10/10.
- TypeScript: passed, including the final production build.
- Full ESLint: no errors. There are 18 pre-existing warnings in unchanged files; the changed application/test files pass the focused lint with no warnings.
- Production build: passed, including traced native PDF runtime extraction for all nine checked routes.
- HTTP smoke: 83/83 passed, including unauthenticated guards on name capture.
- Full `test:approved-ui`: passed against the local production build. This covers desktop/touch header behavior, all nine role menus, bell count/DPI cases, shared Staff Notes/media surfaces across all roles, attachments, approved palette/title-bar comparison, Daily Ops file staging, and the final 29-case Staff Notes run. Author-click shortcuts are also exercised for real-account and captured-name identities.
- Screenshots: inspected desktop/mobile mention pickers, posted notes/replies, and the actual Staff Notes button flag. Assertions additionally check the flag's rendered pseudo-element rather than only its state attribute.

Production migration `20261106225339` was applied successfully through the Supabase migration service. The repository filename matches that recorded production version. Read-only catalog verification confirmed both note columns, the author-name index, the property-member SELECT policy, RLS, Realtime publication, and the two restricted functions. Anonymous users cannot read names; authenticated clients cannot insert names or execute the service-only functions. Both functions are SECURITY INVOKER with an explicit empty search path. The existing note count remained unchanged, and no test names, notes, or alerts were created in production.

The before/after security-advisor comparison returned no new findings. Existing advisor groups and counts remain unchanged; this is not a claim that unrelated pre-existing findings have been remediated. Advisor documentation: https://supabase.com/docs/guides/database/database-linter .

Production application deployment and its live commit/status/error scan are reported separately after the push; this source report does not claim to have tested a physical device or sent a production mention.
