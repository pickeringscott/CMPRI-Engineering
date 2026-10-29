The /api/events GET returns authorized opaque resource revisions, not business data.
The browser uses one own-user Realtime wakeup channel per document, then compares revisions.
No polling is used. Online/visibility/subscription recovery checks revision metadata, not
unchanged Daily Ops snapshots. Business reads retain the existing endpoint authorization.
