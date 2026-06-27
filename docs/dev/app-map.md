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
  `tauri-pilot` scenarios and helpers for the real Tauri desktop runtime. Legacy WebdriverIO specs may still exist as historical conversion material, but must be ported to `tauri-pilot` before use.

## App Entry Points

- `packages/app/src/app/app.tsx`
  Main app composition, top-level signals, persistence wiring, workspace activation, share-link handling, feedback submission, and cross-surface coordination.
- `packages/app/src/app/pages/onboarding.tsx`
  First-run onboarding UI and browser sign-in handoff UI.
- `packages/app/src/app/pages/dashboard.tsx`
  Dashboard shell and dashboard-tab composition.
- `packages/app/src/app/pages/session.tsx`
  Public `SessionView` page entry point, controller composition, dependency wiring, and top-level
  runtime surface integration.

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

- `packages/app/src/app/context/session.ts`
  Public `createSessionStore` facade, Solid store creation, controller composition, and returned
  session-store API wiring. Do not put new transcript, prompt, selection, SSE, or workspace-cache
  business logic here unless the public facade itself changes.
- `packages/app/src/app/context/session-store-model.ts`
  Pure session/message/part ordering, command display aliases, placeholder messages, and synthetic
  error-turn modeling.
- `packages/app/src/app/context/session-transcript-controller.ts`
  Transcript message/part hydration, live and background transcript ingest, deletion tracking,
  freshness, and message pagination state.
- `packages/app/src/app/context/session-runtime-prompts.ts`
  Permission and question refresh, per-workspace prompt aggregation, reply routing, and stale
  runtime route release.
- `packages/app/src/app/context/session-selection-controller.ts`
  Session list loading, selected-session lifecycle, offline transcript fallback, directory
  filtering, rename, and load-earlier behavior.
- `packages/app/src/app/context/session-event-stream.ts`
  Active/background SSE fan-out, event application, coalescing, reconnect catch-up, unread assistant
  observation, and background workspace transcript persistence triggers.
- `packages/app/src/app/context/session-workspace-cache.ts`
  Workspace snapshot save/load/clear behavior, selected-session validation, transcript metadata
  restore, and snapshot eviction.
- `packages/app/src/app/components/session/composer.tsx`
  Prompt vs shell mode, slash command parsing, mentions, attachments, and command chip behavior.
- `packages/app/src/app/components/session/message-list.tsx`
  Message rendering, reasoning visibility, timeline grouping, and technical detail rendering.
- `packages/app/src/app/pages/session-conversation-flow.ts`
  Session send, queue, pending-session, retry, replacement, and active-run orchestration.
- `packages/app/src/app/pages/session-transcript-viewport.ts`
  Transcript windowing, bottom pinning, scroll intent, and latest-message viewport state.
- `packages/app/src/app/pages/session-search-command-controller.ts`
  Message search state, command palette state, command item derivation, and session keyboard command
  routing.
- `packages/app/src/app/pages/workspace-share-controller.ts`
  Shared session/dashboard workspace sharing, public-link publishing, export, and share-modal state.
- `packages/app/src/app/pages/session-left-sidebar.tsx`
  Session left-sidebar docked/overlay layout, workspace session list placement, dashboard nav, and
  status controls.
- `packages/app/src/app/pages/session-right-sidebar.tsx`
  Session right-sidebar docked/overlay layout, advanced nav, artifacts panel, and capabilities panel.
- `packages/app/src/app/pages/session-center.tsx`
  Session main column layout and slot ordering for banners, transcript, todo panel, composer, and
  conflict modal.
- `packages/app/src/app/components/session/artifact-family-model.ts`
  Run-scoped artifact family derivation and filtering rules.
- `packages/app/src/app/lib/opencode-session.ts`
  Session helper wrappers such as summarize, shell execution, and slash command listing.

## Config and Persistence Helpers

- `packages/app/src/app/lib/veslo-server.ts`
  Public Veslo server client barrel. Keep app imports pointed here for compatibility.
- `packages/app/src/app/lib/veslo-server/connection.ts`
  Veslo server settings persistence, workspace URL helpers, invite links, bundle links, and session archive client option resolution.
- `packages/app/src/app/lib/veslo-server/transport.ts`
  Shared Veslo server request transport, auth headers, Tauri fetch audit wrapping, binary/multipart helpers, and `VesloServerError`.
- `packages/app/src/app/lib/veslo-server/client.ts`
  `createVesloServerClient` composition shell. It wires domain facades and preserves legacy flat aliases.
- `packages/app/src/app/lib/veslo-server/types.ts`
  Public Veslo server DTOs, request inputs, and response types re-exported by the barrel.
- `packages/app/src/app/lib/veslo-server-domains/`
  Domain client facades for workspace, conversations, files, skills/registry/materialization, soul, MCP, commands, plugins, automations, messaging identities, and read-only extensions inventory.
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
- Session send, queue, retry, or pending-session issue: start at `session-conversation-flow.ts`,
  then the page wiring in `session.tsx`.
- Session store facade issue: start at `context/session.ts`, then follow the controller wiring to
  the owning module.
- Session transcript, deletion, hydration, or pagination issue: start at
  `context/session-transcript-controller.ts`.
- Session permission/question prompt issue: start at `context/session-runtime-prompts.ts`.
- Session SSE, reconnect, unread-event, background workspace, or busy-state issue: start at
  `context/session-event-stream.ts`, then `context/session-reconnect.ts` for outage notice rules.
- Session list, selected-session loading, offline fallback, or rename issue: start at
  `context/session-selection-controller.ts`.
- Workspace snapshot/cache issue: start at `context/session-workspace-cache.ts`.
- Session transcript scroll/windowing issue: start at `session-transcript-viewport.ts`, then
  `components/session/message-list.tsx`.
- Session search or command-palette issue: start at `session-search-command-controller.ts`, then
  the page wiring in `session.tsx`.
- Session sidebar or main-column layout issue: start at `session-left-sidebar.tsx`,
  `session-right-sidebar.tsx`, or `session-center.tsx`, then the page wiring in `session.tsx`.
- Sharing/import/export issue: start at `workspace-share-controller.ts`, then the page-specific
  wiring in `session.tsx` or `dashboard.tsx`, followed by `lib/veslo-server/connection.ts`,
  `lib/veslo-server-domains/workspace.ts`, `shared-bundles.ts`, and `config-store.ts`.
- Runtime contract issue: start at `packages/server/src/server.ts` and `packages/server/README.md`.
