---
applyTo: "packages/desktop/**/*,packages/e2e/**/*"
---

- Follow `packages/desktop/AGENTS.md`.
- Validate desktop behavior in the real Tauri runtime, not in a browser-only dev server.
- Reuse an existing WebDriver session at `http://127.0.0.1:4445/status` when available instead of always launching a new app instance.
