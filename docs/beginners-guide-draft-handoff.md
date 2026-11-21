# Beginner’s Guide draft handoff

The Beginner’s Guide is prepared for preview in the draft pull request. The worktree starts from `main`.

## Implementation

- `src/app/engineering/page.tsx` mounts the guide from the verified signed-in session. The existing Front Desk re-export uses that dashboard. `src/app/technician/page.tsx` mounts it for the Technician dashboard. Embedded frames skip the launcher.
- `src/components/beginners-guide/BeginnerGuide.tsx` controls first open, Skip and Close, Back and Next, and the named progress slider. The lower-left launcher reopens the guide. Close and Skip shrink and fade toward that launcher.
- Front Desk auto-opens at the first dashboard visit in each browser session until November 24, 2026 at 11 p.m. Central. The normal first-open rule applies after the cutoff. Explicit sign-out clears the session marker.
- `GuideFlowchart.tsx` uses the approved README SVG with separate room for the guidance and a connector to the highlighted step. `GuideWalkthrough.tsx` shows a sample modal next to its action instructions and advances the isolated sample through optional hotspots. The guide does not dispatch native modal actions or submit sample records.
- `approved-role-access.csv` is Scott’s approved sheet. `guide-lessons.json` contains its 222 ordered assignments for ten roles from the standalone preview. Hours Tracker appears for every row. Feedback covers submission, and English / Spanish follows Manage Profile. The guide loads lesson data on first open and loads synthetic screenshots as needed from `public/beginners-guide/captures/`.

## Review before release

- The local production preview build passed with the repository’s CI placeholder Supabase settings. TypeScript, route generation, and the post-build PDF, manual reader, and OCR checks passed. The build output is in `.next/`. A standalone Chromium check confirmed the approved flowchart can be imported as SVG. The signed-in dashboard flow still needs browser and integration testing.
- Verify the modal, chart and footer layering, first-open and repeat-session behavior, focus and touch handling, and resize behavior in the actual dashboard on phone and desktop. Exercise sign-out and sign-in in the same tab and desktop resize or rotation during a guide.
- First-open persistence uses browser-local storage keyed by the signed-in user. Decide whether the requirement needs a server preference that follows the same account across devices.
- The CSV assigns guide lessons. The existing CMPRI APIs and session permissions remain unchanged. For example, the General Manager’s private Candidate Questionnaire lesson is a synthetic queue, and newly listed roles can see a shared profile or asset example. Verify corresponding live access changes separately before describing those permissions as deployed.
- The packaged demo assets are static data copied from the approved standalone review. When updating a lesson, keep the CSV, role-specific guidance, and screenshot target coordinates aligned. Add an explicit assignment for any new supported role.
