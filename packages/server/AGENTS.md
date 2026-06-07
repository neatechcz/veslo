# AGENTS.md

This package owns Veslo server surfaces consumed by the desktop app and orchestrator-backed flows.

## Rules

- Keep server-consumption first: capabilities that mutate `.opencode/` should remain expressible via server APIs, not only via Tauri-only filesystem paths.
- Before changing OpenCode proxying, workspace routes, conversation/session behavior, orchestrator integration, or run lifecycle, read `docs/dev/opencode-workspace-runtime-architecture.md`. Veslo server owns the app-facing conversation/run boundary; clients must not choose OpenCode session ids or directories directly.
- If you change `packages/server/src`, rebuild the binary with `pnpm --filter veslo-server build:bin`.
- If app behavior depends on a server change, verify against the rebuilt binary, not just the TypeScript sources.
- Use `docs/dev/veslo-server-app-contract.md`, `docs/dev/state-and-config-reference.md`, and `docs/dev/opencode-workspace-runtime-architecture.md` when changing API shape, auth state, persistence, config precedence, OpenCode routing, or workspace execution behavior.
