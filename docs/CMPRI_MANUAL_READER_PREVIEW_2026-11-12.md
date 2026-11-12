# Manual reader preview — 2026-11-12

This implementation follows the read-only audit in PR #36. It starts from main `12c7a9e481dd83511a9b1becc0c02bdb92031d10`, using a separate preview branch. It is not approved for production merge or promotion. No AI provider, catalog generation, production migration, or live data modification is part of this work.

## Reader changes

- Read bounded diagnostic-code tables, retain subcodes, and distinguish the automatic unit response from technician actions. Keep cause text and conditional qualifiers with table remedies.
- Resolve explicit named procedures only against a unique, complete numbered procedure in the same original. The existing Enseo guide now retains both the 30-second and 7-minute waits.
- Preserve explicit connected chart steps and their checkboxes, retaining question/answer conditions, common prerequisites, model qualifiers, and the complete original chart. Unresolved layouts remain source references.
- Flag unreadable mappings and image/text coverage gaps, show per-document coverage and physical/printed page labels, and replace matching passages with saved reviewed or recognized text.
- Index intact originals in internal batches. Resume byte-derived native pages through the existing cache, within bounded page/text limits. No PDF is rewritten, split, or reformatted.
- Filter conservatively using real technician notes and root cause. Exclude automatic checklist summaries so the guide does not filter itself after a visit. Combine exact duplicate checks within one source while retaining all page citations and keeping different manuals separate.
- Renew private source URLs when opened, rechecking authorization, current association, and original SHA-256. Keep source pages and diagram controls available.
- Keep live preview API/Supabase writes disabled. Restore browser-only checklist interactions using verified role permissions and the same state transitions as the saved checklist; identify these local marks clearly.

The Front Desk Quick Guides, their content, PDFs, and navigation have no changes. They remain the user's front desk instructions for associates without maintenance training.

## Comparison with PR #20

Reference: [PR #20](https://github.com/pickeringscott/CMPRI-Engineering/pull/20), head `5d640de1187cd88b79f49c31c6a0fbb47593b244` (merged before the current baseline). Main already contains later changes, so differences between main and #20 are not all introduced by this implementation.

| Area | Relationship to #20 |
| --- | --- |
| Attached document authority | Preserved: user-selected originals, source citations, no provider or shared-catalog fallback. |
| Ordinary issue language | Preserved; qualified source conditions no longer gain an overly broad alias. |
| Chief/technician review states | Previous check/uncheck/review cycles restored in browser-only preview marks. Live record writes remain disabled. |
| Combined visit note and recovery | Existing visit lifecycle retained. Automatic summaries do not count as new technician findings. |
| Figure controls, pinch/pan, color/photo preservation | Existing viewer retained. The shared native-color renderer also handles full vector pages; source colors and photographs retain their protection. |
| Flowchart steps | Explicit connected branches retain their conditional checkboxes and prerequisite steps, with the full original chart available. |
| Reader UI | Same work-order guide location and checklist structure, with added coverage, fault/subcode cards, printed labels, renewed source controls, and read-only notice. It is not pixel-identical to #20. |

## Validation

Primary acceptance replays authorized Supabase data through the real production reader: 26 assets, 21 existing work orders, and 12 unchanged original PDFs. Source bytes are SHA-256 checked. The replay blocks outbound networking and live writes; no fictional assets or tickets are substituted. The records and PDFs stay outside the repository.

Checks cover the actual Friedrich and GE code tables, Navien main codes/subcodes, Enseo procedure waits, Symmons conditions and causes, damaged text coverage, conditional chart steps and unresolved-chart fallback, repeated source checks, and read-only transport. The Navien service PDF is exercised directly without changing the user's reference-only attachment selection.

Mobile (390 px) and desktop (1440 px) browser checks use actual existing GE, Friedrich, and shower work orders, actual asset/location records, the production reader's replay results, and original source page rendering. They check rendering, source/code panels, blocked live writes, and horizontal overflow. The browser uses a local read-only API transport; it does not prove live sign-in or a persisted review lifecycle. No snapshots or screenshots are published in this public repository.

Verification includes TypeScript, focused lint, reader/review/diagram/UI regression suites (268 passed, one skipped, zero failures), the Next build and packaged PDF/OCR runtime checks, and local API rejection of mutation/dispatch requests. Existing regression fixtures are secondary checks, not manual acceptance data.

The separate existing preview-redirect suite passes its six assertions, then fails on asynchronous Next.js `AsyncLocalStorage` activity after completion in this runtime. The same failure reproduces on the unchanged main baseline. The redirect configuration has no changes in this branch.

## Follow-up code and preview review

The next review found three additional problems and fixed them on the same preview branch:

1. Import metadata and encoded asset-change entries could influence source search as if they were technician findings. In the inspected HVAC work orders this put auxiliary-control or compressor-reference pages ahead of issue matches. The reader now separates issue and history ranking, prioritizes issue-matching diagnostic/troubleshooting pages, and excludes known import metadata and change/system events. Real technician findings remain available; source notes are never edited. The existing Friedrich cooling work order's references identify the original cooling chart at PDF page 41. Continuous presentation follows the original page order, as requested below.
2. An open source iframe could continue displaying the previous manual while a changed source URL loaded. Source controls now scope results to the document/account, cancel abandoned requests, hide old frames immediately, recheck the account before opening a signed result, and clear embedded sources on sign-out. They also close abandoned blank windows, avoid a source request when a popup is blocked, renew on reopen, and recover from a failed open.
3. A chart's extracted text appeared before its original image, losing the visible connections between branches. Explicit chart pages now show the original diagram first and keep extracted text in a separate, collapsed section. The PDF link remains available if the preview cannot render. This is a reader presentation change; the original PDF is unchanged.

The three browser work orders were reread from Supabase; their inspected fields matched the acceptance snapshot. The 26-asset/21-work-order/12-PDF replay passed again. The new source-control command passed ten checks using two actually registered manuals and the actual account snapshot, with no external requests or writes. The existing targeted suite again passed 268 checks with one skip and no failures; TypeScript, focused lint, and the packaged Next/PDF/OCR build passed.

Browser checks at 390 and 1440 px passed for the actual GE, Friedrich, and shower work orders. These now include source iframe opens, renewal after close/reopen, recovery after a failed open, standalone PDF opening, and the Friedrich chart selection. The chart check waits for the actual original page image to render and verifies that its flattened transcription is collapsed. The browser served recorded originals through its local read-only transport, with no page errors, external network calls, or mutations. The standalone source-control check also covers account changes and delayed response races. These tests still do not establish live authentication or database persistence.

These fixes do not change PR #20's review transitions, combined visit notes, diagram viewer controls, or the Front Desk Quick Guides.

## Native colors and guide spacing

Full source-page images now use the guide's computed native surface and text colors. The PDF renderer identifies vector-only pages by checking for image, shading, and pattern operators. That proof allows the full-page renderer to retain antialiased text while replacing neutral paper/ink with the active palette. Existing conservative checks still apply when that proof is unavailable; saturated source colors and photographic content are protected. Theme changes regenerate the memory-only display image. Original PDFs and authenticated source bytes are unchanged.

Spacing is tightened throughout the troubleshooting guide, including notices, coverage, source text, code cards, tables, and checklist rows. The CSS is scoped to the troubleshooting accordion; application-wide typography, other screens, and Front Desk Quick Guides have no spacing changes. Control dimensions are retained.

Acceptance uses the actual Friedrich chart on PDF page 41 and verifies that its display corner matches the computed native surface rather than white. The existing color/photo regression checks, mobile/desktop real-work-order checks, and actual-manual collection replay cover this change.

## Continuous steps and source pages

The page dropdown is removed. All matching source pages appear together in their selected-manual and original PDF page order, retaining each page's own document identity, physical/printed page label, original link, and source text. Page images load automatically near the viewport and release their display URLs when far away; revisiting them needs no page-selection action. Reserved page space prevents image loading from collapsing the sequence. Charts keep their extracted text collapsed; ordinary source text remains readable without opening another control. The fixed-height nested source scroller is removed.

Opening the guide or populating a new issue/manual context positions the first checklist step below the sticky ticket header. With no checklist steps, it starts at the source sequence. Ordinary mark/review refreshes and theme changes do not reset the reader's position. Editing an input outside the guide does not trigger a scroll jump.

Actual-work-order browser checks cover the absence of a dropdown, source order, first-step visibility after loading/reopening, native chart colors, and automatic loading of the following Friedrich chart page. These remain read-only record replays; live signed-in access and persistence are not claimed.

## Remaining work before production approval

- The stored Saflok PDF is zero bytes. A working original must be supplied; reader code cannot recover missing bytes.
- Parts/reference-only manuals remain references. The reader does not invent a service procedure or change the user's manual selection.
- Local recognition/review is still needed for flagged source pages, including the image-only sign and damaged native text. This preview does not enqueue or save that work.
- The existing OCR/review storage and worker still have a 600-page limit. Extending those workflows requires separate schema/worker work; the native reader's larger ceiling is not an OCR capacity claim.
- Layouts that cannot be bounded, ambiguous named procedures, incomplete actions, and partial charts remain source references. This includes incomplete native bullet text in some Navien rows.
- Verify authenticated source signing and the save/review/combined-note lifecycle against an isolated data environment before any production decision. There were no live reviewed-page, OCR-job, or checklist ledger examples in the inspected snapshot, and this preview intentionally cannot create them.

## Restored checkbox behavior

The read-only preview had disabled the prior checkbox interactions. These are restored through a browser-only ledger, using the exact transition function shared with the live checklist and permissions calculated by the existing server policy. Chief checks cycle blank → pending red → approved green → blank. Technician completion, clearing, ownership, and Chief review retain their previous semantics. Local marks survive a reload and are scoped to the real work order and current source context. Starting a new local checklist retains the preceding browser snapshot. Preview marks never enter live task ledgers or combined visit notes; the production note/save paths are unchanged.

The blanket chart-reference flag also suppressed conditional checkboxes. Explicit connected chart checks and common prerequisites are restored with their original conditions and source citations. Ordinary descriptions such as the existing “cooling issue” report can select the corresponding source chart without generating instructions or choosing branch outcomes. The actual Friedrich record now exposes 43 conditional checks, starting with its source prerequisite to check error codes. GE retains its nine source checks.

The real-record browser checks exercise the Chief cycle, browser reload persistence, clearing, first-step position, continuous pages, native colors, and automatic next-page loading, with no mutation requests or external calls. Existing unit regressions cover the other role/ownership/review and saved-note paths. Live signed-in, cross-browser review and database persistence remain unverified here.
