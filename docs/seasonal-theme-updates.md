# Shared seasonal theme updates

The public sign-in page and signed-in desktop share the active selection in
`src/lib/ui/site-seasonal-theme.ts`, the artwork renderer in
`src/components/desktop/SiteSeasonalBackground.tsx`, and the desktop colors in
`src/lib/ui/site-palette.json`. Sign-in surfaces use those palette variables in
`src/app/sign-in-theme.css`; they do not have a separate seasonal color set.

Thanksgiving is active. Christmas remains in scope for a later release and is
not enabled by this change.

## Christmas release scope

- Add the approved Christmas artwork renderer and asset cache to the shared
  background registry, then change the single active theme selection.
- Update the shared desktop palette and seasonal desktop chrome together.
- Keep home-page tab buttons connected to their destination modal's native colors
  through `modalLauncherStyle`; seasonal chrome must not override those colors.
- Include the public sign-in page: normal Google sign-in, Remember me, expanded
  password access, validation/error messages, OAuth return and dashboard loading.
- Verify sign-in and desktop at desktop and mobile widths, short viewports,
  reduced motion, keyboard focus, and readable text over the animated background.
- Retain the existing sign-in and access-control behavior and test role-specific
  destinations after Google/password authentication.
- Version and deploy cached seasonal assets with the theme change so returning
  devices receive the new files while unchanged assets remain local.
