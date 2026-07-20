# AGENTS.md

Veslo is a local-first, cloud-backed control surface for agentic work. Treat the Tauri desktop app as the authoritative runtime under test, and treat cloud as data/sync infrastructure rather than the default execution environment.

## Start Here

- `docs/dev/documentation-map.md`
- `docs/dev/app-map.md`
- `docs/dev/testing-playbook.md`
- `docs/dev/engineering-quality-gates.md`
- `docs/dev/development-startup.md`
- `docs/dev/state-and-config-reference.md`
- `docs/dev/opencode-workspace-runtime-architecture.md`
- `VISION.md`, `PRINCIPLES.md`, `PRODUCT.md`, `ARCHITECTURE.md`, `INFRASTRUCTURE.md`

## Always-On Rules

- In the first task update, confirm:
  1. `Target repo: <path>`
  2. `Out of scope repos: <list>`
  3. `Planned output: <what will be changed/tested>`
- In final answers, do not include references to specific code, files, or line numbers unless the user explicitly asks for them.
- Never use `packages/web` or UI-only web servers as the runtime for development, debugging, or verification. Do not start `pnpm -w dev:ui`, `pnpm --filter @neatech/veslo-ui dev`, or raw Vite as the app runtime. Use `packages/desktop`.
- When creating tests, always prefer E2E tests. Add lower-level tests only when an E2E test cannot cover the behavior reliably or when they provide useful support around a primary E2E path.
- For development startup requests ("spust", "start app", "run in dev mode"), follow `docs/dev/development-startup.md`. Default to the fresh rebuild startup flow unless the user explicitly asks to skip rebuild.
- Veslo desktop is single-tenant during development and testing. Before starting any desktop runtime or desktop/E2E test, follow the preflight in `docs/dev/testing-playbook.md`: detect running Veslo dev/test processes from this repo, terminate internally started dev/test instances, verify no relevant process remains, then launch the intended runtime. Reuse or attach to an existing `tauri-pilot` app/socket only when the user explicitly asks for a debug attach flow.
- If a required desktop/E2E test is blocked because a Veslo dev/test process from this repo is already running and the task rules do not allow terminating or reusing it, do not end the thread. Schedule an automation to wake the thread in 10 minutes, retry the preflight and the blocked test, and keep scheduling 10-minute retries until the real Tauri-runtime test completes or the user explicitly cancels or changes scope.
- When the task says "test the app" or depends on desktop behavior, validate the real Tauri runtime. Use `docs/dev/testing-playbook.md`; for internal desktop E2E, follow the `packages/desktop` plus `packages/e2e` `tauri-pilot` flow. WebdriverIO is not part of the Veslo E2E surface; add or run a Tauri Pilot scenario for desktop validation.
- Prefer OpenCode and server surfaces over Tauri-only filesystem behavior. Any capability that mutates `.opencode/` should stay expressible via the Veslo server API when possible.
- If you change `packages/server/src`, rebuild the server binary with `pnpm --filter veslo-server build:bin` before relying on orchestrator-backed flows.
- When verified changes affect durable behavior, configuration, runtime flow, or developer workflow, update the canonical docs in `docs/dev/` or `docs/features/`. Use `docs/plans/` only as history.
- For a normal source-code handoff, finish with `pnpm check`. This does not replace a focused real-desktop recovery check or release verification when the changed surface requires one; use `docs/dev/engineering-quality-gates.md` to select those lanes.
- For release requests, load the repo-local `veslo-release` skill before mutating release state. Use `.opencode/skills/veslo-release` for Codex/OpenAI-compatible surfaces and `.claude/skills/veslo-release` for Claude Code; `RELEASE.md` remains the canonical CLI checklist.
- Keep the repo portable and do not commit secrets.

## Scoped Instructions

- `packages/app/AGENTS.md` for shared SolidJS app-shell and UI rules
- `packages/desktop/AGENTS.md` for Tauri runtime and desktop E2E rules
- `packages/server/AGENTS.md` for server and orchestrator integration rules
- `CLAUDE.md` and `packages/*/CLAUDE.md` import the same guidance for Claude Code
- `.github/copilot-instructions.md` and `.github/instructions/*.instructions.md` provide the GitHub Copilot equivalents

## Task-Specific References

- Feature verification and Docker-backed flow checks: `docs/dev/testing-playbook.md` and `packaging/docker/README.md`
- Routine quality, desktop-recovery, and release-diagnostics gates: `docs/dev/engineering-quality-gates.md`
- Development startup and run procedure: `docs/dev/development-startup.md`
- OpenCode workspace runtime, Veslo server conversation/run boundary, and sandbox/no-sandbox execution: `docs/dev/opencode-workspace-runtime-architecture.md`
- Veslo production/application log locations and safe read commands: `docs/dev/veslo-application-logs.md`
- Release workflow: `RELEASE.md` and `docs/dev/release-skill.md`
- Public behavior and runtime semantics: `docs/features/`
- Product intent and architecture: `VISION.md`, `PRINCIPLES.md`, `PRODUCT.md`, `ARCHITECTURE.md`, `INFRASTRUCTURE.md`
