# Work-order collaboration notifications

This prospective change applies only to work-order notes, status changes and the
wording/deduplication of ticket-creation alerts.

- New notes and status changes notify the current Chief Engineer notification
  audience, the assigned technician and the original submitter. Each active
  person receives one alert per event even when they occupy multiple roles.
- Chief Engineers remain included when they make the change themselves. Shared
  Front Desk submissions notify the submitting account; entered names do not
  represent separate device accounts.
- Notes supplied in the initial ticket INSERT produce no separate note alert.
  Creation keeps its existing recipient list and single `new-order` key, with
  wording that distinguishes approval needed from creation as an open ticket.
- Assignment, claim, viewed, explicit-mention, Staff Notes, pool, room-operations
  and other notification policies remain unchanged. Existing phone schedules,
  subscriptions and delivery leases remain in effect.

The database records the inbox rows and captured device delivery intent in the
same transaction as the ticket change. The update does not replay old notes,
change old inbox rows or enroll new devices for historical events. System and
change-history entries do not become note alerts.

The migration verifies the existing notification function before replacing only
the creation/status branches and adding the note trigger. If a submitter's new
event is queued immediately before the application update, the existing delivery
queue retains it for recovery after the scoped phone eligibility update deploys.

Validation includes real PostgreSQL trigger execution, note/status recipients,
role overlap, initial notes, creation-history suppression, inactive/cross-hotel
recipients, preservation of assignment/viewed rules, transactional rollback and
browser-role denial. Live verification uses metadata and read-only checks; no
test work orders, notes or phone messages are sent to real users.
