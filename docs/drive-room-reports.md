# Daily Room Ops: fetch reports from Drive

The split Upload Room Ops control uses the existing attachment folder
`18V2KjCHw2o0uQCVFzu2GGxJ9PghGS7AD` and the existing
`maint.cmpri@hawkeyehotels.com` OAuth grant. No new Google permissions, watches,
cron jobs, database tables, or purchase-order intake behavior are introduced.

- **Drive** expands the form and explicitly fetches newer CSV reports. No fetch
  occurs on mount, on a timer, on focus, or during ordinary room-data refreshes.
- **File** expands the form and opens the existing report file picker. The
  report-format selector and filename lists are removed; the import preview and
  explicit confirmation remain.
- The Report Date label is centered; its date value, limits, and behavior remain.

Discovery fully paginates the configured folder, recognizes the existing three
CMPRI report filenames, and compares their filename `YYYY-MM-DD_HH-MM-SS`
timestamps independently against the accepted bundle's report of the same type.
Upload/modified times do not establish freshness. Only today's reports are
eligible, preserving the existing import date rule. Unrelated attachments and
purchase orders are ignored. Conflicting copies at the same newest timestamp
require correction instead of arbitrary selection. Byte count, version, filename,
file identity, and folder membership are verified before returning a download.
Raw CSV responses bypass the device data cache.

Fetched files use the unchanged guest-reports validation and confirmation API.
In-House Guest List Details is required first; Housekeeping Departures and
Housekeeping Arrivals are optional, and can be added after today's guest list is
accepted. The five-minute timing allowance, required columns, active room
validation, stale-preview protection, idempotency, and atomic commit remain.
Fetching or failed validation does not advance accepted timestamps.

The acquisition endpoint requires the existing `edit_tickets` capability and
CMPRI hotel scope. Integration safe mode is honored. No Drive credentials are
returned to the browser.

Verification: `tests/drive-room-reports.test.mjs`,
`tests/drive-room-reports-api.test.mjs`, existing guest-report and room-operation
regressions, and `python tests/browser/drive_room_reports.py` against a local
server. The browser test uses synthetic transport and confirms that only Drive
clicks initiate fetching, File opens the picker, both paths use the existing
preview, and writes require confirmation.

The connected account can exercise this same flow through the existing
`room_operations.import` action: preview with `{source:"drive",validate_only:true}`;
confirm an explicitly requested save with `{source:"drive",validate_only:false,
previousId,source_digest}` from the preview. This uses the same authenticated
handlers as the UI, and rejects changed source bytes before saving.
