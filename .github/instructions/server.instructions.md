---
applyTo: "packages/server/**/*,packages/orchestrator/**/*,packages/openwork/**/*,packages/opencode-router/**/*"
---

- Follow `packages/server/AGENTS.md`.
- For OpenCode proxying, conversation/run routes, orchestrator integration, and sandbox/no-sandbox execution, read `docs/dev/opencode-workspace-runtime-architecture.md`.
- Changes in `packages/server/src` require `pnpm --filter veslo-server build:bin`.
- Keep `.opencode`-mutating behavior expressible through server surfaces when possible.
