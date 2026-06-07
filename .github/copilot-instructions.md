# GitHub Copilot Instructions

- Follow `AGENTS.md` for repo-wide rules and any closer-scoped `packages/*/AGENTS.md` files for the files you are editing.
- Never use `packages/web` as proof that the app works; validate desktop behavior through `packages/desktop`.
- Start with `docs/dev/documentation-map.md` and `docs/dev/testing-playbook.md`.
- For OpenCode workspace runtime, Veslo server conversation/run boundary, and sandbox/no-sandbox execution changes, read `docs/dev/opencode-workspace-runtime-architecture.md`.
- If you change `packages/server/src`, rebuild the server binary with `pnpm --filter veslo-server build:bin`.
- Update canonical docs in `docs/dev/` or `docs/features/` when durable behavior or workflow changes.
