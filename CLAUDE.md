# CLAUDE.md

## Application Runtime Rule

**NEVER run the web application (Next.js / `packages/web`).** Always run the Tauri native desktop application (`packages/desktop`) instead. This applies to all contexts: development, testing, debugging, and E2E verification. If you need to launch the app, use the Tauri dev command, not `next dev` or any web-only server.
