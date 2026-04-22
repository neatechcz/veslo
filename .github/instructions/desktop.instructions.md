---
applyTo: "packages/desktop/**/*,packages/e2e/**/*"
---

- Follow `packages/desktop/AGENTS.md`.
- Validate desktop behavior in the real Tauri runtime, not in a browser-only dev server.
- Treat desktop testing as single-tenant: before launching WebdriverIO or a Tauri dev runtime, stop any internally started Veslo dev/test instance from this repo and verify no relevant desktop runtime remains.
- Reuse an existing WebDriver session only when the user explicitly asks for a debug attach flow.
