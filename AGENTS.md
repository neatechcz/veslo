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
- Never use `packages/web` or UI-only web servers as the runtime for development, debugging, or verification. Do not start `pnpm -w dev:ui`, `pnpm --filter @neatech/veslo-ui dev`, or raw Vite as the app runtime. Use `packages/desktop`.
- When creating tests, always prefer E2E tests. Add lower-level tests only when an E2E test cannot cover the behavior reliably or when they provide useful support around a primary E2E path.
- For development startup requests ("spust", "start app", "run in dev mode"), follow `docs/dev/development-startup.md`. Default to the fresh rebuild startup flow unless the user explicitly asks to skip rebuild.
- Veslo desktop is single-tenant during development and testing. Before starting any desktop runtime or desktop/E2E test, follow the preflight in `docs/dev/testing-playbook.md`: detect running Veslo dev/test processes from this repo, terminate internally started dev/test instances, verify no relevant process remains, then launch the intended runtime. Reuse or attach to an existing `tauri-pilot` app/socket only when the user explicitly asks for a debug attach flow.
- If a required desktop/E2E test is blocked because a Veslo dev/test process from this repo is already running and the task rules do not allow terminating or reusing it, do not end the thread. Schedule an automation to wake the thread in 10 minutes, retry the preflight and the blocked test, and keep scheduling 10-minute retries until the real Tauri-runtime test completes or the user explicitly cancels or changes scope.
- When the task says "test the app" or depends on desktop behavior, validate the real Tauri runtime. Use `docs/dev/testing-playbook.md`; for internal desktop E2E, follow the `packages/desktop` plus `packages/e2e` `tauri-pilot` flow. Legacy WebdriverIO specs must be converted to `tauri-pilot` before they are used for validation.
- Prefer OpenCode and server surfaces over Tauri-only filesystem behavior. Any capability that mutates `.opencode/` should stay expressible via the Veslo server API when possible.
- If you change `packages/server/src`, rebuild the server binary with `pnpm --filter veslo-server build:bin` before relying on orchestrator-backed flows.
- When verified changes affect durable behavior, configuration, runtime flow, or developer workflow, update the canonical docs in `docs/dev/` or `docs/features/`. Use `docs/plans/` only as history.
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
- Development startup and run procedure: `docs/dev/development-startup.md`
- Release workflow: `RELEASE.md` and `docs/dev/release-skill.md`
- Public behavior and runtime semantics: `docs/features/`
- Product intent and architecture: `VISION.md`, `PRINCIPLES.md`, `PRODUCT.md`, `ARCHITECTURE.md`, `INFRASTRUCTURE.md`

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the project Graphify skill if the runtime exposes it. Otherwise run the equivalent `graphify` CLI command directly from the repo root.

Rules:
- For codebase questions, first run `graphify query "<question>"` when `graphify` is available and graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If `graphify` is not installed or not in PATH, do not fail the task. Continue with the normal repo-reading workflow and mention the missing CLI only when it affects the answer.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- The initial Veslo graph is code-only; `.graphifyignore` excludes docs, screenshots, decks, and media until semantic extraction is intentionally enabled through subagents or an LLM backend.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` when the CLI is available to keep the graph current (AST-only, no API cost).
