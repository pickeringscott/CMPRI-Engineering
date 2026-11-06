# Existing Thanksgiving desktop restoration

Source: a90d3fd1dc63e29e458652705068a70305a86e86, “Add approved desktop Thanksgiving animation; preserve static mobile.” Fetched this exact Git object. The component and background were absent from the current eb3707d-based combined-release branch.

Restored the original component, original HTML, and all four original PNG assets byte-for-byte. Hash inventory: /workspace/cmpri-thanksgiving-audit/source-identity.json. This is the existing turkey/greeting, desktop-spread gourds, six Illinois-native leaf shapes and accumulating ground leaves, not newly generated art. Prior room history identifies the desktop-spread revision as v9; the subsequent v10 change concerned mobile spacing. Current instruction explicitly limits this restoration to desktop.

Integration adds the original two lines to the shared Engineering dashboard. Front Desk re-exports that page. At widths below 768px the component returns null and requests no background assets; existing mobile appearance is unchanged. Separate page layouts were not expanded.

## Event/network audit
- React mount uses matchMedia and its change event; listener removed on cleanup.
- Local pause button and resize events control the visual state.
- requestAnimationFrame and CSS keyframes animate leaves/turkey locally. These are legitimate rendering work, not server polling. No interval, fetch, XHR, WebSocket, EventSource, Supabase or database logic exists in this design.
- Original HTML checks document.hidden and reduced-motion preference before advancing leaves. Paused/reduced-motion loops remain local; no server calls are introduced. Bounded population: 480 settled plus at most 48 active leaves.
- Runtime assets are same-origin static files. GitHub is the source repository, not a runtime API.

## Verification
- Original three focused tests pass: bounded/saturated pile with continued falling, pause/reload reset, reduced-motion changes and desktop-only integration.
- Browser tested actual component in isolated host at 1440x900, then 390x844, plus fresh mobile and reduced-motion contexts. Background requested one HTML file and four PNG files. No additional requests over 16 seconds of active animation; no API/database/XHR requests or console page errors. Pause stopped progress; resizing unmounted iframe; fresh mobile loaded no artwork; reduced motion stayed at 80 static leaves.
- Internal screenshot visually inspected against source. No replacement art generated.
- TypeScript, scoped ESLint, production build and PDF runtime checks passed. Build used synthetic public Supabase configuration, not production credentials.
- Evidence: /workspace/cmpri-thanksgiving-audit/verification.json and /tmp/cmpri-thanksgiving-build.log. Isolated verification measures this decoration, not unrelated dashboard network traffic.

No deployment, production database action, Git push, mobile artwork change or combined-release finalization. Earlier email-push work remains separate and uncommitted. Final release remains on hold until Scott's go.
