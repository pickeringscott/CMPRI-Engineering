# Corporate Room Ranker delivery

CMPRI sends the current ticket-based Room Ranker to the existing corporate workbook after relevant committed changes. No timer, cron, polling, browser refresh, or page visit starts a sync.

Production workbook: `1VSuwfAG0yM780fc9-Ds0JlzT0wQIdJmTWnCGlnjgfGA`, tab `Room Ranker`, sheet ID `0`. All 112 active CMPRI guest rooms matched the corporate room rows during the November 16, 2026 audit.

| Column | Exact corporate header | Source and ownership |
| --- | --- | --- |
| A | Rooms | Match by the active CMPRI guest-room number. Never rewrite or reorder corporate rows. |
| B | Room Inspected by | Corporate inspection field. Current ticket ranker has no inspector source; preserve the existing value. |
| C | Specific Room Check 1 | Corporate inspection field. No equivalent current CMPRI source; preserve the existing value. |
| D | Specific Room Check 2 | Corporate inspection field. No equivalent current CMPRI source; preserve the existing value. |
| E | Specific Room Check 3 | Corporate inspection field. No equivalent current CMPRI source; preserve the existing value. |
| F | Room Ranker | Current shared `rankTicketRooms` calculation, including accumulated-ticket thresholds and original priorities beneath automatic escalation. Output is A, B, or C. |
| G | Notes/Actions needed in Room (existing trailing space retained) | Active work-order issue text only, one issue per line. No work-order numbers, priorities, statuses, or wrapper labels. Replace old corporate notes completely; clear the cell when no active issues remain. Completed, Closed, and Will Not Do tickets are excluded. |

Inspector and checks 1–3 are deliberately not fabricated from unrelated technician names or PM entries. The retired ranker supported direct inspection-cell edits; current CMPRI no longer exposes that editor.

## Event path

1. Insert/update/delete of a relevant guest-room work order, or changes to guest-room inventory, mark a durable hotel revision.
2. Multiple changes in one database transaction coalesce into one revision and one `pg_net` webhook. Rollback removes both.
3. The webhook authenticates with a dedicated production-only secret and POSTs `/api/integrations/room-ranker/sync`. GET and PATCH remain retired. The old editable `/api/room-ranker` and old per-ticket queue stay retired.
4. A service-only database claim allows one writer for the hotel. Duplicate, already-delivered, or busy events do not read Google Sheets.
5. The worker loads current committed data, validates all seven headers and every room mapping, then compares current corporate F/G cells with the desired output. It batches only changed values using RAW input. Identical output produces no write.
6. Read-back verifies the saved values before acknowledging the revision. If a newer revision arrived during delivery, completion wakes another worker immediately from that change event.

The write does not change A:E, headings, tables, dropdown definitions, conditional formatting, summary formulas, dimensions, or sheet layout. Column G is entirely owned by the active issue descriptions, as requested on November 16, 2026. Missing/duplicate rooms, shifted headers, formulas in output cells, unsupported rank validation, or oversized notes stop the write rather than truncate data or invent mappings.

## Configuration and recovery

Production requires the existing Google Sheets service-account credentials and exact `CMPRI_ROOM_RANKER_SPREADSHEET_ID` / `CMPRI_ROOM_RANKER_SHEET_NAME`, plus `CMPRI_CORPORATE_RANKER_ENABLED=true` and `CMPRI_CORPORATE_RANKER_WEBHOOK_SECRET`. Store the same webhook secret in Supabase Vault as `cmpri_corporate_ranker_dispatch`. These new settings authorize only corporate-ranker delivery; they do not enable Corporate PM or change the global integration safe-mode setting. Do not enable delivery in ordinary previews.

An initial reconciliation or explicit operator retry can call the service-only RPC `cmpri_corporate_ranker_request(p_hotel)`. It always reads current CMPRI data, not old snapshots. Never replay the historical `cmpri_room_ranker_sync_queue`.

`cmpri_corporate_ranker_state` records desired/delivered revisions, last success, and last error. Provider/webhook failures leave intent pending. The next relevant event or explicit operator retry attempts it again; there is no timer-based retry. A crashed worker's five-minute lease can be reclaimed on the next event. The lease is a concurrency safeguard, not scheduled work. The HTTP worker has a 60-second platform limit and bounded Google request timeouts.

## Verification

Tests cover the seven-column contract, current grade thresholds, preservation of inspection fields and replacement of legacy descriptions, unchanged-output skips, missing/duplicate mappings, issue-only output, formula/validation protection, webhook authorization, transaction rollback/coalescing, concurrent delivery claims, new revisions during delivery, failure retention, and absence of ranker cron jobs.
