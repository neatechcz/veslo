# GlitchTip Release Integration Design

## Goal

Ensure GitHub-built Veslo desktop releases send frontend and native desktop errors to the Neatech GlitchTip `veslo` project on macOS and Windows.

## Decision

Use a public, release-owned GlitchTip DSN embedded at build time. The DSN is not secret, is not user-editable, and must not be exposed through any Veslo UI or runtime configuration surface.

## Architecture

GitHub release workflows provide one public `VESLO_GLITCHTIP_DSN` repository/environment variable to both build layers:

- `VITE_VESLO_GLITCHTIP_DSN` enables browser/Solid monitoring in the Vite build.
- `VESLO_GLITCHTIP_DSN` is available at Rust compile time so packaged native monitoring can fall back to an embedded DSN after install.

The native desktop shell keeps runtime environment override support for development and smoke checks, but released apps do not depend on install-time environment variables.

## Behavior

- Production GitHub release builds fail early if `VESLO_GLITCHTIP_DSN` is missing or malformed.
- Frontend monitoring uses `production` unless the workflow explicitly passes another environment.
- Native monitoring reads runtime env first, then compile-time embedded env.
- Local development remains opt-in unless a developer sets the existing env vars manually.
- Users cannot change the DSN from Veslo.

## Testing

Add focused tests that verify:

- Native Rust monitoring has a compile-time DSN fallback.
- Release review reports GlitchTip release env checks.
- GitHub release workflow passes the DSN to macOS and Windows build steps.
- Existing frontend monitoring behavior remains unchanged.

## Docs

Update release/config documentation to state that the GlitchTip DSN is public, build-owned, required for GitHub desktop releases, and not user-configurable.
