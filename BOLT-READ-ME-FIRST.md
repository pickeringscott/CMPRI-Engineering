# BOLT.NEW — CMPRI V1.0 FINAL HANDOFF — READ THIS FIRST

## A direct correction from ChatGPT

**I failed Scott on this handoff.**

I did not do a sufficiently deep search of his prior CMPRI conversations, project records, files, requirement ledgers, historical prototypes, and implementation notes before I packaged the earlier Bolt handoff. I also made the earlier package confusing by marking an incomplete rewrite as authoritative while placing a broader integrated candidate beside it as reference material. That created a real risk that Bolt could start from the wrong source or miss requirements Scott had already spent days defining.

I also introduced a stricter authentication/session layer that can accept a valid Supabase email/password and then reject the user in `/api/session` if CMPRI authorization data or server configuration are inconsistent. If Scott cannot sign in, **do not assume his password is wrong**. Verify the real environment, membership, permissions, RLS, and my auth logic first.

**Do not trust my earlier handoff documents as a complete statement of what Scott wants. This file is the corrected deep-search handoff.**

The current source tree included in this package under `CURRENT-SOURCE/` is the source Bolt should inspect and continue from. Do not substitute an older CMPRI archive, Astra checkpoint, integrated candidate, handoff reference copy, R7/R14/R15 prototype, old Google Apps Script version, or APK contents as the current web-app source.

---

# 1. HARD RULES — THESE ARE NOT OPTIONAL

- **NO PATCHES.** No patch stacks, temporary shims, compatibility hacks, or “make it pass” workarounds.
- If a file/module is structurally wrong, rewrite it cleanly and integrate it correctly.
- **NO GUESSING.** Verify schema, permissions, roles, environment variables, external sheet/mailbox fields, data shapes, and API behavior.
- Do not repeatedly send Scott through the same troubleshooting steps.
- Do not call the project complete because lint, TypeScript, mocks, or compilation pass.
- Build the integrated system correctly, then test the actual workflows.
- Keep the public release at **V1.0**. Package version is intended to remain `1.0.0` for this first production release.
- Browser tab title must be exactly **`CMPRI - Engineering`**.
- CMPRI is the property acronym and should be used for property identifiers.
- Do not deploy output built with fake/placeholder Supabase values.
- Do not reset, delete, or rewrite production data without Scott’s explicit approval.
- When a production reset is eventually approved, remove pre-go-live/test work orders while preserving permanent rooms, assets, documents, roles, identities, history, and audit records.
- Scott should not be made to perform routine QA that Bolt can perform itself in its test environment.
- Do not claim release-ready until authenticated browser workflows, real database/RLS behavior, external integrations, and Android behavior have been checked.

---

# 2. PROPERTY / PROJECT IDENTITY

- Organization: **Hawkeye Hotels**
- Property code: **CMPRI**
- Property: **Residence Inn Champaign**
- Current hotel UUID used by source: `c81ad01a-7a9f-4880-ac1c-5e849f30bad6`
- Time zone: **America/Chicago**
- Stack: **Next.js 16 + Supabase + Vercel**
- Android client: APK wrapper around the production web app
- Vercel scope/project belongs under Hawkeye Hotels
- Exact title: **CMPRI - Engineering**
- Current release target: **V1.0**

---

# 3. SIGN-IN / SESSION — INVESTIGATE FIRST

My rewrite can produce this failure mode:

1. Supabase accepts the email/password.
2. Browser receives a valid auth session.
3. `/api/session` performs stricter CMPRI authorization.
4. Missing/mismatched profile, hotel membership, role permissions, RLS, service config, or application logic causes rejection.
5. Client signs the user back out.
6. To Scott it looks like “I cannot sign in.”

Before changing UI/password behavior verify:

- `NEXT_PUBLIC_SUPABASE_URL`
- correct public/publishable Supabase key
- `SUPABASE_SERVICE_ROLE_KEY` on server only
- active `profiles` row
- active CMPRI `hotel_members` row
- exact role value/normalization
- required `role_permissions` rows
- production/test RLS behavior
- property isolation
- deactivation/revocation behavior

Do **not** “fix” sign-in by weakening authorization globally.

Required sign-in behavior:

- Centered sign-in page.
- Checkbox text exactly **Remember on this device**.
- Remembered sessions persist appropriately on that device.
- Engineering/admin → **Engineering Dashboard**.
- Front Desk and other submit-only roles → **Create Work Order**.
- Profile page only when explicitly opened.
- Deactivated/terminated employees lose access without deleting identity/history.

---

# 4. ROLE MODEL / HIERARCHY

## Chief Engineer
- Scott’s role.
- Full technical/control access.
- Edit assets/equipment.
- Manage allowed technician/subordinate accounts.
- Edit technical ticket fields.
- Close tickets.
- Reopen Closed tickets.
- Manage room/configuration functions as designed.

## Maintenance Technician
- Full technical ticket editing.
- Can close tickets.
- No Chief-only hierarchy escalation.

## Regional Maintenance
- Technical access.
- Keep distinct from local technician.

## General Manager
- Submit/review/approve.
- Dashboard visibility.
- Manage defined subordinate roles only.
- Cannot manage/delete equal or superior roles.

## Assistant GM
- Submit-only unless Scott explicitly expands it later.
- Mobile ticket/photo submission can be useful.
- Does not need full engineering controls.

## Front Desk
- Shared account allowed.
- **Every ticket requires employee FIRST NAME.** This supersedes older initials ideas.
- Submit-only.
- Cannot edit Asset/Equipment, Category, or Priority.
- May see system guesses, but they are locked.
- Primary workflow is PC; normal Front Desk does not require photo upload.

## Lead Housekeeper
- Submit-only.
- Can submit tickets and photos.

## Sales Manager
- Submit-only.

## Senior Management
- View-only oversight.
- KPI / PM completion visibility.
- Must never gain mutation rights because of an accidental permission row.

## Account lifecycle
- Termination = deactivate/revoke, **not delete**.
- Preserve identity, notes, assignments, AI/audit history.
- **Equal cannot manage/delete equal.**
- Self/superior protection applies.
- No silent role escalation.

Known initial roster references:
- Scott — Chief Engineer
- Isaiah — Maintenance Technician
- Doug — Regional Maintenance
- Deon — General Manager

Additional sign-ins/roles are expected for Front Desk, Lead Housekeeper, Assistant GM, Sales Manager, and Senior Management as appropriate.

---

# 5. WORK-ORDER CREATION

Required fields:
- Room / Location
- Issue

Optional:
- Notes

System inferred and locked for submit-only users:
- Asset / Equipment
- Category
- Priority

Front Desk:
- Require **first name**.
- Store entered employee first name separately from the authenticated shared account identity.

Creation workflow:
- Save Draft
- Submit
- Cancel
- Supervisors/Chief Engineer can view/delete allowed subordinate drafts.
- Front Desk can save or submit.

Do not show the distracting right-side work-order list while creating a ticket.

English/Spanish:
- Ticket creation should support English/Spanish.
- User should be able to review/edit the description before Submit.

---

# 6. DUPLICATE PREVENTION

`Duplicate` is **not** a normal work-order status.

Before creation, flag/reject likely duplicates using:
- same Room/Location
- same/similar Asset/Equipment when known
- similar Issue text

Use one consistent rule set across single, batch, related, and import creation paths where practical.

Concurrency protection belongs at the service/database boundary too; a race should not trivially create two identical active tickets.

Closed / Will Not Do records should not permanently block a genuinely new issue.

---

# 7. WORK-ORDER STATUS / LIFECYCLE

Expected meaningful states:
- Pending Verification where submit-only review requires it
- Open
- In Progress
- Completed
- Closed
- Will Not Do

Do not expose Duplicate as a normal status.

Rules:
- **In Progress requires a technician.**
- Technical roles can edit according to role policy.
- Chief Engineer can reopen **Closed → In Progress**, restoring prior technician assignment when available.
- Chief Engineer can reopen **Closed → Completed** for note additions/review.
- Review-only management must not silently edit technical fields.
- Use revision/optimistic concurrency protection so stale saves cannot overwrite newer changes.
- Protect creator/submission attribution.

Known status color expectation:
- Open = green
- In Progress = yellow
- Completed = blue
- Closed = red

---

# 8. TECHNICIAN NOTES / AUDIT HISTORY

Scott specified this workflow:

- Existing note history appears above the editor.
- Technician types in the editor.
- **Submit** stages/moves the note into history as pending.
- **Edit** returns the staged note to the editor.
- Final **Save** applies timestamp + authenticated user attribution.
- Failed saves must not silently lose staged notes.
- Preserve database-authoritative provenance.
- History survives account deactivation.

---

# 9. WORK-ORDER DETAIL / TROUBLESHOOTING

Engineering-editable fields include:
- Asset/Equipment
- Category
- Priority
- Issue
- Notes / action/root-cause fields
- Status per role

Display behavior:
- Notes/history above troubleshooting.
- Load documentation for the selected asset/model/documentation key.
- Reload relevant knowledge when asset changes.
- Show verified equipment documentation title + PDF.
- Show applicable error-code table.
- Show issue-specific troubleshooting.
- Friedrich Vert-I-Pak codes Scott has referenced include examples such as **3, 5, 15**.
- Do not claim a manual/document is verified unless verification actually occurred.
- Do not invent manual-backed codes/steps.
- Generic guidance may supplement verified source material, clearly labeled as generic.
- Avoid repetitive boilerplate lockout warnings; useful safety guidance should be concise.
- Recognize Actions Taken and avoid repeatedly suggesting steps already tried.

---

# 10. SEARCHABLE SELECTS / KEYBOARD-FIRST UI

Scott is a heavy keyboard user. Important dropdowns should be searchable.

Required behavior:
- Typed text is visible.
- Tab accepts the best highlighted match.
- Shift+Tab does not corrupt the current value.
- Dropdown opens **downward**.
- `409` must find **Room 409**, not jump to a 4th-floor group header.
- `pool` should surface Pool Area / Pool Room / Pool Pump Room as applicable.
- Group headings larger than item text.
- Item font about 1–2 pt smaller than heading.
- Compact spacing.
- Required fields visibly marked.

Preferred Room/Location ordering:
- Office/public areas first
- other operating areas next
- guest rooms later
- electrical closets later
- roofs near bottom
- hallways grouped by floor

Create page tab order preference:
Room → Issue → Asset → Category → Priority → Notes

Fuzzy matching should handle maintenance typos and concepts such as heating/cooling.

---

# 11. ENGINEERING DASHBOARD

Core KPIs:
- Open Work Orders
- In Progress
- Urgent/High
- Overdue

Behavior:
- Clicking a KPI shows the matching list with a clear larger section title.
- Remove useless text such as “click a ticket.”
- Ticket list is its own scrollable pane with roughly **4–5 tickets visible**.
- Surrounding dashboard remains stationary.
- Back to Dashboard control must not send users to sign-in.
- Visible build/version badge.
- Header room-move indicator: **Moves: X**.
- Room detail shows Room Ranker grade/flags.
- PM status visible in context when opened from relevant room/KPI.
- Keep layout compact/mobile-friendly; Scott explicitly rejected unnecessarily wide layouts.

A previous preferred dashboard used a dense/dark engineering-control-room style with clear cards and ticket list. Preserve the compact information density rather than expanding whitespace.

---

# 12. AI BOUNDARY

The dashboard AI refresh/provider integration has been retired.
- No paid/provider AI calls in normal application runtime.
- Local deterministic inference/fuzzy matching is allowed.
- PDF/manual parsing must not call a provider.
- Preserve historical AI provenance records; do not delete audit data as part of feature removal.
- Old administrative scripts that call an AI provider must not become accidental runtime behavior.

---

# 13. ROOM RANKER — CORPORATE SHEET IS SOURCE OF TRUTH

Room Ranker remains source of truth for:
- A/B/C room grade
- room issues/flags

Rules:
- CMPRI reads from it.
- CMPRI writes permitted changes back to it.
- Do not replace it with a private local database as the authoritative rank source.
- Closing / Will Not Do should remove only the relevant CMPRI ticket tag/keyword linkage.
- Do not destroy unrelated corporate notes or sheet content.
- Room ranking is not the same concept as work-order priority.
- Room detail should show Room Ranker grade and flags.

Verify real sheet field/layout before writing.

---

# 14. CORPORATE PM — CORPORATE SHEET IS SOURCE OF TRUTH

Required:
- Read PM schedule/checklist.
- Frequencies include daily, monthly, quarterly, and other schedules.
- Write completion logs back.
- Preserve corporate formulas/structure.
- Do not overwrite formula cells or unrelated content.
- Corporate PDFs are reference documents.
- Relevant PDF/checklist should be accessible by room/area.
- Management should see PM completion percentage/status.
- Room/location detail should show relevant PM status.

Do not confuse local preflight validation with proof that the live Google sheet/script is atomically safe.

---

# 15. DAILY ROOM OPERATIONS / GUEST STATUS / ROOM MOVES

Scott commonly supplies **photos/screenshots** of daily hotel reports, not just CSV/text.

Concepts to support:
- departures
- arrivals
- room status
- guest name/data where supplied
- room type / guest code where supplied
- blocked/reserved status
- room moves
- checkout / arrival times/dates

Date highlighting requirement:
- today = green
- tomorrow = yellow
- future = blue
- overdue = red

Header:
- **Moves: X**
- ability to inspect move details

Keep existing text/CSV import support, but the intended photo/screenshot import must also exist. Do not claim photo import is done if only text is parsed.

Shared room operations data should be server-backed/shared across devices, not trapped in one browser’s localStorage.

---

# 16. SAFETYCULTURE / HISTORICAL ISSUE IMPORT

- Import latest relevant SafetyCulture work orders when source data is available.
- Include spreadsheet-based issues that never made it into SafetyCulture.
- Deduplicate against active CMPRI tickets.
- Preserve import provenance/source.
- Do not blindly create redundant work orders.

---

# 17. IBUY EFFICIENT / HD SUPPLY / SUPPLIERS

Scott expanded this beyond HD Supply. Do not assume one supplier.

## iBuyEfficient
- Main purchasing workflow.
- Scott wants supplier/catalog intelligence from relevant iBuyEfficient emails.

## HD Supply
- Often accessed via punch-out through iBuyEfficient.
- Contract/business price can differ from public retail price.
- Do not substitute consumer pricing as Hawkeye contract pricing.

Track where available:
- PO/order
- supplier
- quantities
- split shipments
- ship-from/origin
- tracking
- shipped
- in transit
- delivered
- physically received
- backordered
- missing item/vendor follow-up
- returns / credits / refunds
- warranty / RMA / failed-part replacement when applicable

Rules:
- Delivered does not automatically mean full PO received.
- Split shipments remain distinct.
- Partially received must not become fully received.
- Purchasing status is separate from work-order status.
- Scott asked to track supplier follow-up emails where he reports a missing shipment/item.
- Mailbox integration should remain read-only unless explicitly authorized to send/mutate.

---

# 18. ENSEO

Ticket/email linkage:
- Match by room.
- Preserve sublocations such as **103A / 103B** for STBs.
- Do not attach Enseo activity to an unrelated same-room ticket just to force a match.
- Do not create redundant work orders.

Asset assignment:
- TVs/STBs are assigned to specific room sublocations (Living Room / Bedroom etc.).
- Physical moves update both device and STB assignment records as applicable.

Specific requested Room 134 workflow:
- Move working TV **Living Room → Bedroom**.
- Remove broken Bedroom TV and move it to **Scott’s office**.
- Include the relevant STB move.
- Update inventory/location assignments to match reality.

Do not execute blind production changes merely because this requirement exists; verify actual device records and use an atomic move workflow.

---

# 19. GSS

- Weekly CMPRI-only GSS workflow.
- Expected Monday report parsing.
- CMPRI data only.
- Do not automatically create work orders from every guest comment.
- Guest-comment automation remains off unless Scott explicitly requests it.

---

# 20. ASSETS / EQUIPMENT

New asset naming standard applies to **new entries only**:

`<asset type> – <location>`

Examples:
- `VTAC – Room 229`
- `Office Chair – Back Office`

Do **not** mass-convert legacy asset names.

Known property equipment/location concepts include:
- Friedrich Vert-I-Pak guest HVAC
- GE/Zoneline type HVAC where present
- Verdant thermostats
- UniMac/other commercial washers and dryers
- guest laundry
- BOH laundry
- lobby/study/breakfast/public areas
- pool/pool pump room
- housekeeping areas
- electrical closets
- roofs
- elevators
- fire/pump/boiler/PBX spaces
- Enseo TV system
- guest-room appliances/fixtures

Asset records should support manufacturer, model, serial, location, documentation linkage, and vendor/service context where available.

---

# 21. PARTS / ORDER IDEAS / VENDORS

Scott wants more than a generic parts text field.

Requirements/ideas:
- Parts list can derive suggested items from work-order language.
- Example: “needs garbage disposal” should suggest/add a garbage disposal to the ticket/order-ideas list.
- Simple **Order Ideas** list for items from work orders and manual entries.
- Vendor list with technical contact numbers.
- Vendor proposals linked to assets/vendors where appropriate.
- Asset ↔ compatible inventory/part relationships.
- Inventory/order usage can link back to work orders.
- Preferred supplier may be HD Supply for many items, but do not make it the only supplier.
- Do not guess exact catalog/SKU compatibility when it has not been verified.

The package includes historical SQL reference material with vendor/inventory/PM-operation ideas. Treat it as design evidence, not automatically as production-ready SQL.

---

# 22. POOL — LATEST RULE OVERRIDES OLDER CONFLICTING FILES

This is one area where historical files contain contradictory older instructions. Use the **latest Scott instruction below**.

- Indoor bromine pool.
- **One physical AM water sample and one physical PM water sample.**
- Each physical sample contains **pH + bromine**.
- Under the site-specific inspector direction Scott reported, the **same measured result is intentionally recorded in BOTH the Shallow and Deep cells on the paper/inspection record**.
- Official inspection volume: **17,909 gallons**.
- Chemical dosing basis used by Scott: **20,000 gallons**.
- Required flow: **48 GPM**.
- Observed flow: **80 GPM on 2026-06-23**.
- Test kit: **Taylor K-2005 Complete DPD Pool Test Kit**.
- Source-of-truth report layout is the IDPH paper/PDF form, not user-created spreadsheet copies.
- Printable daily inspector report required.
- Preserve VGB/drain/suction cover documentation requirements.
- Monthly checks should come from authoritative requirements, not invented memory.
- Do not invent chemical dosing from remembered approximations.
- Separate ticket exists/was desired for pool-room humidity/climate-control issue.

**Superseded rule to ignore:** older project records that say one sample is recorded only in one selected Shallow/Deep location. Scott later corrected that for CMPRI: the one physical sample per period is recorded in both paper-form cells.

---

# 23. ROOM DETAIL / PM / RANKING

When a room/location is opened from engineering context, show useful combined context:
- active work orders
- Room Ranker A/B/C grade
- Room Ranker flags/issues
- PM status / due/completion summary
- room operations context where relevant
- related assets/equipment

Avoid conflating room rank with ticket priority.

---

# 24. UI / BRAND / MOBILE

- Mobile-friendly.
- Android APK required.
- Target user has used a Samsung Galaxy S23 Ultra for testing; compact touch layout matters.
- “Remember on this device,” not “computer.”
- Center sign-in.
- Build badge visible.
- Exact approved **CMPRI Hawk “H with a feather” logo** should be used once the real asset is located.
- **Do not invent a replacement logo and call it approved.** My deep search still did not recover the exact approved logo asset.
- Keep desktop Front Desk flow keyboard-efficient.
- Keep overall engineering UI compact rather than wide/empty.

---

# 25. EMAIL / WARRANTY SCOPE PRIORITY

Scott initially considered warranty/failed-part email automation a later phase, but later integrated email work included warranty/RMA/failed-part replacement tracking concepts.

Bolt should preserve those capabilities if present, but prioritize core V1 work-order/auth/data integrity over speculative email automation. Do not remove working email parsing blindly; do not let it block core V1 sign-in/work-order functionality.

---

# 26. RELEASE / TESTING EXPECTATIONS

Bolt already has a test environment. Use it deeply.

Minimum real acceptance before calling V1 ready:
- sign in with intended real/test CMPRI accounts
- role-based landing
- Remember on this device behavior
- Front Desk first-name requirement
- submit-only locked technical fields
- work-order create/edit/close/reopen
- Will Not Do
- draft save/restore/delete/supervisor policy
- duplicate prevention including concurrent/near-duplicate cases where feasible
- technician note history/provenance
- asset/documentation matching
- manual verification labels
- searchable dropdown keyboard behavior and downward geometry
- property isolation
- account deactivation
- real Supabase schema/migrations/RLS/role_permissions
- Room Ranker read/write behavior against real test sheet
- Corporate PM read/write behavior against real test sheet
- email provider parsing against safe real/test mailbox context
- room-operations shared data and photo/screenshot flow
- mobile layout
- Android APK/WebView/back/login persistence/camera/photos when APK is rebuilt

Do not treat placeholder-value builds as deployment artifacts.

---

# 27. PRODUCTION RESET / GO-LIVE

Pre-go-live test data is temporary.

When Scott explicitly approves production reset/go-live:
- remove test work orders and temporary testing records
- preserve permanent room/location configuration
- preserve assets/equipment
- preserve manuals/documents
- preserve user roles/identities
- preserve audit history that must legally/operationally remain
- do not reset corporate source-of-truth sheets

Do not perform this reset merely because tests pass.

---

# 28. KNOWN PRECEDENCE / SUPERSEDED RULES

Use these newer rules when historical files disagree:

1. **Front Desk requires FIRST NAME**, not initials.
2. **Duplicate is not a normal status.** Prevent duplicates instead.
3. **Pool latest rule:** one AM sample + one PM sample; each includes pH+bromine; same physical result is intentionally recorded in both Shallow and Deep paper-form cells per Scott’s inspector direction.
4. **New asset naming applies only to new assets.** Do not rename legacy records.
5. **Dashboard AI refresh is retired.** No manual or automatic paid/provider calls in normal runtime.
6. **Room Ranker and corporate PM sheets remain source of truth.** Do not replace them with local copies.
7. **No patches.** Clean rewrites/integration only.

---

# 29. WHAT IS IN THIS ZIP

- `00-READ-ME-FIRST.md` — this corrected master handoff and requirement set.
- `CURRENT-SOURCE/` — current CMPRI V1.0 web source tree to inspect/continue.
- `ANDROID/CMPRI-Engineering-v1.0.apk` — existing APK artifact.
- `ANDROID/CMPRI-Android-v1.0-Rebuild-Kit.zip` — Android rebuild material.
- `ANDROID/CMPRI-Android-Signing.zip` — signing recovery material. Treat as private.
- `REFERENCE/REQUIREMENTS-V1.0.md` — earlier acceptance ledger; useful, but historical contradictions are superseded by this file.
- `REFERENCE/RELEASE-READINESS.md` — earlier readiness record.
- `REFERENCE/TEST-CONTINUATION-2026-09-15.md` — historical test/audit evidence; not proof of current source correctness.
- `REFERENCE/CMPRI-v1.0-CONTINUATION-REPORT.md` — historical continuation report.
- `REFERENCE/CMPRI-v1.0-ANDROID-REPORT.md` — Android artifact history.
- `REFERENCE/003_engineering_operations.sql` — older operations/vendor/inventory design evidence only.
- `REFERENCE/CMPRI_Location_Asset_Structure.xlsx` — historical/reference property location/asset/work-order data.
- `REFERENCE/CMPRI_First_Draft_Work_Orders.xlsx` — historical/reference issue/work-order data.

**Precedence:** this `00-READ-ME-FIRST.md` is the handoff requirement authority when historical reference files disagree. Live corporate sheets/database are still the authoritative operational data sources where Scott defined them as such.

---

# 30. FINAL NOTE TO BOLT

Scott has already spent too much time correcting AI mistakes. Do not make him reconstruct this project again. Verify what exists, identify what is genuinely broken, rewrite the broken implementation cleanly, and keep going until the test environment demonstrates the integrated workflows actually behave as required.

The earlier ChatGPT handoff was incomplete and confusing. **That was my failure, not Scott’s.**

<!-- Vercel deployment retry 2026-10-12: fresh revision after transient Git-provider rate limit. -->
