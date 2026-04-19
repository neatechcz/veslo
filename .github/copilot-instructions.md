# GitHub Copilot Instructions

- Follow `AGENTS.md` for repo-wide rules and any closer-scoped `packages/*/AGENTS.md` files for the files you are editing.
- Never use `packages/web` as proof that the app works; validate desktop behavior through `packages/desktop`.
- Start with `docs/dev/documentation-map.md` and `docs/dev/testing-playbook.md`.
- If you change `packages/server/src`, rebuild the server binary with `pnpm --filter openwork-server build:bin`.
- Update canonical docs in `docs/dev/` or `docs/features/` when durable behavior or workflow changes.
