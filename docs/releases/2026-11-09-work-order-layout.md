# Work-order and location layout release

Built on production commit `9dbfca685de4392c7a1a667921a05fec030ef089` to retain the current inventory, PO receiving, pool chemicals, OCR and uploaded-document troubleshooting workflows.

- Remove redundant outer borders from work-order metadata; retain editable field outlines.
- Keep notes history together and move the compact note/media composer to the bottom.
- Remove the separate Closure Details panel; existing stored closure data remains intact.
- Start Suggested Troubleshooting and Labor & Parts collapsed, including when a local parts draft is restored. Preserve the draft and exit guard.
- Keep matching gold accordion titles beside visible collapsed/expanded triangles. Enlarge the individual-part status selector without changing its choices or stock rules.
- Group incoming guest badges at the right edge in their existing order. Preserve current-guest identity and badges.
- Remove the floating personal inbox overlay from ticket detail routes while preserving the dashboard/profile inbox and notification eligibility.
- Stack each location's red work-order count above the PM indicator, using the shared PM palette and existing loaded records.

No database migration, notification-recipient policy, cache policy, or seasonal animation changes are included in this layout release. Those remaining changes are separate from this reviewed patch.

Validation: production build and PDF runtime checks; lint/typecheck; full automated suite; desktop/mobile browser checks for layout, keyboard toggling, draft recovery, parts workflow/retries, stock deductions, parts-status pills, and overflow. Browser test writes use synthetic fixtures only.
