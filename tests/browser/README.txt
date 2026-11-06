Approved UI verification (synthetic accounts and data only)

Install Python Playwright and Chromium, with Chromium at /usr/bin/chromium.
Start the app on localhost port 3116 using synthetic NEXT_PUBLIC_SUPABASE_URL,
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY and NEXT_PUBLIC_GIPHY_API_KEY values.
Run npm run test:approved-ui. Override CMPRI_UI_BASE only with localhost or
127.0.0.1. CMPRI_UI_OUTPUT defaults to work/cmpri-ui; it holds screenshots and
machine-readable results, not production records.

Role capabilities are generated from the current allows() policy, matching
active property membership and explicit representative grants. A live account's
secondary roles, membership and individual grants may restrict its controls.
All API requests are intercepted. Authentication, role capabilities, account
layout storage, note uploads/posts, guest data and provider results use local
fixtures. Other external requests are blocked. These tests do not sign into
production, post real notes, alter business data or deploy.

header_gestures.py uses trusted mouse events and Chromium's native touch input.
It also opens a fresh browser context at the opposite device size to test
account-backed layout retrieval without relying on browser-local storage.
header_role_access.py checks nine representative role configurations on both
widths, including Front Desk movement and distinct profile-action persistence.
approved_surfaces.py covers all-role Staff Notes, file/GIF posts, phone capture
chooser and desktop camera (synthetic device), plus mobile Detail guest names.
attachment_playback.py verifies paused video hover and playback invoked within
the trusted click/tap gesture. palette_reference.py measures the approved HTML
against rendered modal body/title colors and the 28-CSS-pixel titlebar.

These browser fixtures complement API, RLS and database tests in npm test.
They do not certify live provider responses or physical phone camera UI.
