# AGENTS.md

Veslo is a local-first, cloud-backed control surface for agentic work. Treat the Tauri desktop app as the authoritative runtime under test, and treat cloud as data/sync infrastructure rather than the default execution environment.

## Start Here

- `docs/dev/documentation-map.md`
- `docs/dev/app-map.md`
- `docs/dev/testing-playbook.md`
- `docs/dev/development-startup.md`
- `docs/dev/state-and-config-reference.md`
- `VISION.md`, `PRINCIPLES.md`, `PRODUCT.md`, `ARCHITECTURE.md`, `INFRASTRUCTURE.md`

## Always-On Rules

- In the first task update, confirm:
  1. `Target repo: <path>`
  2. `Out of scope repos: <list>`
  3. `Planned output: <what will be changed/tested>`
- In final answers, do not include references to specific code, files, or line numbers unless the user explicitly asks for them.
- Never use `packages/web` as the runtime for development, debugging, or verification. Use `packages/desktop`.
- For development startup requests ("spust", "start app", "run in dev mode"), follow `docs/dev/development-startup.md`. Default to the fresh rebuild startup flow unless the user explicitly asks to skip rebuild.
- Veslo desktop is single-tenant during development and testing. Before starting any desktop runtime or desktop/E2E test, follow the preflight in `docs/dev/testing-playbook.md`: detect running Veslo dev/test processes from this repo, terminate internally started dev/test instances, verify no relevant process remains, then launch the intended runtime. Reuse or attach to an existing WebDriver/app instance only when the user explicitly asks for a debug attach flow.
- When the task says "test the app" or depends on desktop behavior, validate the real Tauri runtime. Use `docs/dev/testing-playbook.md`; for internal desktop E2E, follow the `packages/desktop` plus `packages/e2e` WebdriverIO flow.
- Prefer OpenCode and server surfaces over Tauri-only filesystem behavior. Any capability that mutates `.opencode/` should stay expressible via the Veslo server API when possible.
- If you change `packages/server/src`, rebuild the server binary with `pnpm --filter openwork-server build:bin` before relying on orchestrator-backed flows.
- When verified changes affect durable behavior, configuration, runtime flow, or developer workflow, update the canonical docs in `docs/dev/` or `docs/features/`. Use `docs/plans/` only as history.
- Keep the repo portable and do not commit secrets.

## Scoped Instructions

- `packages/app/AGENTS.md` for shared SolidJS app-shell and UI rules
- `packages/desktop/AGENTS.md` for Tauri runtime and desktop E2E rules
- `packages/server/AGENTS.md` for server and orchestrator integration rules
- `CLAUDE.md` and `packages/*/CLAUDE.md` import the same guidance for Claude Code
- `.github/copilot-instructions.md` and `.github/instructions/*.instructions.md` provide the GitHub Copilot equivalents

## Task-Specific References

- Feature verification and Docker-backed flow checks: `docs/dev/testing-playbook.md` and `packaging/docker/README.md`
- Development startup and run procedure: `docs/dev/development-startup.md`
- Release workflow: `RELEASE.md`
- Public behavior and runtime semantics: `docs/features/`
- Product intent and architecture: `VISION.md`, `PRINCIPLES.md`, `PRODUCT.md`, `ARCHITECTURE.md`, `INFRASTRUCTURE.md`
