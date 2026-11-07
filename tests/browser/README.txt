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
desktop_header_motion.py checks rendered neighbor interpolation during real
mouse dragging and stable pickup/insertion of expanded and collapsed title tabs.
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

daily_ops_files.py checks the compact Daily Ops picker at desktop/mobile widths:
click/drop staging without requests, red removal controls, explicit Submit,
scan extraction, retained review/confirmation, failed-save retry and unchanged
General Manager upload restrictions.

modal_palette_cleanup.py verifies the approved Steel Blue create modal, Dusty
Indigo work-order detail, and Eucalyptus Hours Tracker at phone and desktop
widths. It also checks Room Ranker floor expansion, four summary filters,
redundant heading/close suppression, searchable dropdowns, and the unchanged
unsaved-hours close guard. All APIs are intercepted with local fixtures; this
test produces JSON results without a visual preview. It runs at the end of
npm run test:approved-ui, or can be run directly with the same localhost setup.

work_order_list_layout.py tests the deployable Work Order List with mock API data:
CN and membership badges, two-line ticket details, report checkout times and the
11 a.m. default, sorting/search/filtering, title-bar Bonvoy help with its red ?
badge, keyboard/touch dismissal, row selection, real desktop window resizing,
and six-digit filter counts at phone widths. Run npm run test:work-order-list-ui
against the local app using the same synthetic environment configuration above.
It makes no production reads or work-order writes.
