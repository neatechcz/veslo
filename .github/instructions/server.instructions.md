---
applyTo: "packages/server/**/*,packages/orchestrator/**/*,packages/openwork/**/*,packages/opencode-router/**/*"
---

- Follow `packages/server/AGENTS.md`.
- Changes in `packages/server/src` require `pnpm --filter openwork-server build:bin`.
- Keep `.opencode`-mutating behavior expressible through server surfaces when possible.
