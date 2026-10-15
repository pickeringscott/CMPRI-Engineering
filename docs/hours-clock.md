# Personal Hours clock actions (staged; disabled by default)

Manual entry remains available through the existing tracker. These new actions operate on that same signed-in owner's document; they do not write Paycom.

- `hours_tracker.clock_in` through `perform_cmpri_write`: input `{ "request_id": "a-unique-event-id-at-least-16-chars" }`.
- `hours_tracker.clock_out`: input `{ "request_id": "another-unique-event-id", "shift_id": "shiftId-from-clock-in" }`. Include `confirm_overnight: true` only after explicit confirmation for a next-day finish.
- Both dispatch to `POST /api/hours-tracker/clock`; the dispatcher fixes `action` to `clock_in` or `clock_out`. Caller-supplied owner, timestamp, date, rate and arbitrary fields are rejected.

The server records current time rounded down to a minute in America/Chicago. Clock-in stores only an open shift, without completed attendance or default hours. Clock-out creates attendance on the shift's start date and applies existing break/weekly overtime rules. Existing manual/imported attendance cannot be overwritten. Existing leave and period rates are preserved. A new period has zero rate/deduction placeholders until the user configures it; estimates must not be represented as verified pay.

Retries must reuse the identical request ID and inputs. Receipts persist in the owner's document. Replays return the original receipt; incompatible reuse fails. Revision comparison prevents clock/manual races from overwriting changes. Manual period saves preserve clock state and reject attendance edits on the open date. Stale revisions require reload/retry, not an automatic overwrite.

Safe limits: one open shift and one attendance interval per day; no guessed hours. Normal clock-out is current-time only, 1 minute through 24 hours, with explicit next-day confirmation. For a DST transition or forgotten timer, the SAME clock_out action accepts a strict reconciliation object after the user confirms:

- `{"resolution":"finish","confirmed":true,"reason":"...","end_at":"2026-11-01T02:30:00-06:00","elapsed_minutes":180}`. The stored start remains fixed. End must have an explicit UTC offset (or Z), be in the past, and match Chicago if given as a local offset time. Confirmed duration must exactly match both instants. A valid 1-minute-to-24-hour interval is stored with timestamp evidence so DST worked totals use actual elapsed time, not ambiguous wall-clock subtraction.
- `{"resolution":"discard","confirmed":true,"reason":"..."}` closes only the open timer and records an audit receipt, with no attendance created or deleted. This unblocks manual entry and future shifts. Truly longer-than-24-hour work cannot be guessed/truncated into one day; ask for explicit per-day manual entries after confirmed discard.

Rejected reconciliation leaves the open shift untouched. Idempotency and owner/revision protections also apply to both choices. Editing a reconciled day's displayed time in the manual UI removes timestamp evidence and returns calculation to explicit manual wall times; unchanged entries keep their DST evidence.

Activation is deliberately OFF. `CMPRI_HOURS_CLOCK_ENABLED=true` AND the exact authenticated UUID in comma-separated `CMPRI_HOURS_CLOCK_OWNER_IDS` are both required. Normal tracker role, active profile/membership, identity matching and existing MCP write authorization still apply. No OAuth scope, credential or persistent grant is created by these source changes. Generic MCP tracker reads and whole-period writes remain blocked; only narrow event receipts are returned.

Before a connected session can use this, obtain explicit activation approval for the exact owners, review the reconciliation confirmations, deploy the reviewed source and set the owner gate in the intended environment, then refresh/verify the connector's tool schema. None of those deployment/activation steps is performed by the local implementation. External connector catalogs maintained outside this repository may also need their action enums refreshed; repository MCP source alone does not prove live exposure.

Validation uses synthetic principals and isolated PostgreSQL only. No discussion text creates attendance. Browser verification remains subject to the existing denial.
