# App Map

This document maps the main Veslo code surfaces so future coding agents can find the right source of truth quickly.

## Top-Level Runtime Surfaces

- `packages/app`
  SolidJS application shell, state, routes, session UI, settings UI, and integration surfaces.
- `packages/desktop`
  Tauri shell, native commands, local engine/runtime wiring, updater integration, and host-side filesystem helpers.
- `packages/server`
  Veslo server API, workspace config mutation, audit trail, import/export, and capability discovery.
- `packages/orchestrator`
  CLI host that runs OpenCode, Veslo server, and optionally OpenCode Router together.
- `packages/e2e`
  WebdriverIO tests for the real Tauri desktop runtime.

## App Entry Points

- `packages/app/src/app/app.tsx`
  Main app composition, top-level signals, persistence wiring, workspace activation, share-link handling, feedback submission, and cross-surface coordination.
- `packages/app/src/app/pages/onboarding.tsx`
  First-run onboarding UI and browser sign-in handoff UI.
- `packages/app/src/app/pages/dashboard.tsx`
  Dashboard shell and dashboard-tab composition.
- `packages/app/src/app/pages/session.tsx`
  Session view, share modal entry points, composer-adjacent behavior, and runtime surface composition.

## Dashboard Tabs

These live under `packages/app/src/app/pages/` and are composed by `dashboard.tsx`.

- `settings.tsx`
  App settings, archived sessions, provider/model controls, advanced tools, and developer diagnostics.
- `config.tsx`
  Workspace-scoped config, reload, auto-reload, live access details, and diagnostics bundle.
- `skills.tsx`
  Installed skills inventory, location filters, bulk selection, detail drawer, hub skills, sharing a single skill, and skill editing flows.
- `plugins.tsx`
  `opencode.json` plugin management and suggested plugin flows.
- `mcp.tsx`
  MCP server list, connection/auth state, quick connect, and reload banner behavior.
- `extensions.tsx`
  Higher-level shell around MCP and connected apps.
- `scheduled.tsx`
  Scheduled jobs, templates, scheduler status, and run-now entry points.
- `soul.tsx`
  Soul health, heartbeat status, setup audit, and heartbeat trigger flow.
- `identities.tsx`
  Messaging channels and OpenCode Router identities management for workspace-scoped messaging.

## Cross-Cutting Context and Stores

- `packages/app/src/app/context/workspace.ts`
  Workspace lifecycle, onboarding completion, workspace switching, activation, and remote/local policy branching.
- `packages/app/src/app/context/extensions.ts`
  Skills, plugins, and MCP loading/mutation wiring.
- `packages/app/src/app/context/updater.ts`
  Desktop updater state and preferences.
- `packages/app/src/app/stores/config-store.ts`
  Workspace config import/export and migration repair helpers.
- `packages/app/src/app/stores/engine-store.ts`
  Engine startup, runtime selection, and local host behavior.

## Session Runtime Internals

- `packages/app/src/app/components/session/composer.tsx`
  Prompt vs shell mode, slash command parsing, mentions, attachments, and command chip behavior.
- `packages/app/src/app/components/session/message-list.tsx`
  Message rendering, reasoning visibility, timeline grouping, and technical detail rendering.
- `packages/app/src/app/components/session/artifact-family-model.ts`
  Run-scoped artifact family derivation and filtering rules.
- `packages/app/src/app/lib/opencode-session.ts`
  Session helper wrappers such as summarize, shell execution, and slash command listing.

## Config and Persistence Helpers

- `packages/app/src/app/lib/veslo-server.ts`
  Veslo server settings persistence, workspace URL helpers, invite links, bundle links, skill registry search/materialization client wrappers, and API client types.
- `packages/app/src/app/lib/den-auth.ts`
  Den auth state, browser sign-in handoff, keep-signed-in behavior, and Den endpoint override.
- `packages/app/src/app/constants.ts`
  Preference keys for model, language, titlebar, thinking, and compaction.
- `packages/app/src/app/theme.ts`
  Theme preference read/write and DOM application.

## Desktop and Native Source of Truth

- `packages/desktop/src-tauri/src/commands/`
  Tauri command entry points used by the Solid app.
- `packages/desktop/src-tauri/src/commands/workspace.rs`
  Workspace mutation, `authorizedRoots`, and local worker provisioning.
- `packages/desktop/src-tauri/src/workspace/`
  Workspace file management, watcher behavior, and internal provisioning.

## Server and CLI Source of Truth

- `packages/server/src/server.ts`
  API routes, auth gates, import/export, config mutation, audit, and capability reporting.
- `packages/server/src/config.ts`
  Server config loading and normalization, including `authorizedRoots`.
- `packages/orchestrator/src/`
  Sidecar orchestration, sandbox logic, hot reload, and CLI commands.

## When Looking For Something

- Onboarding or auth issue: start at `onboarding.tsx`, `workspace.ts`, and `den-auth.ts`.
- Settings or persistence issue: start at `settings.tsx`, `constants.ts`, `theme.ts`, and `app.tsx`.
- Skills/plugins/MCP issue: start at `extensions.ts`, then the corresponding page component.
- Sharing/import/export issue: start at `session.tsx` or `dashboard.tsx`, then `veslo-server.ts`, `shared-bundles.ts`, and `config-store.ts`.
- Runtime contract issue: start at `packages/server/src/server.ts` and `packages/server/README.md`.
