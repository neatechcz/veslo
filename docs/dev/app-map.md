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
  `tauri-pilot` scenarios and helpers for the real Tauri desktop runtime. WebdriverIO is not part of the current E2E surface.

## App Entry Points

- `packages/app/src/app/app.tsx`
  Main app composition root, top-level signal ownership, dependency injection, modal mounting, and route shell composition. New business workflows should live in a context/page module below and be wired here.
- `packages/app/src/app/app-view-props.ts`
  Page prop adapters for onboarding, dashboard, and session views. Use this when a page prop is assembled from app-level stores but the page itself should not know the full app shell.
- `packages/app/src/app/pages/onboarding.tsx`
  First-run onboarding UI and browser sign-in handoff UI.
- `packages/app/src/app/pages/dashboard.tsx`
  Dashboard shell and dashboard-tab composition.
- `packages/app/src/app/pages/dashboard-update-pill-model.ts`
  Pure update prompt view model used by dashboard/session navigation surfaces.
- `packages/app/src/app/pages/session.tsx`
  Public `SessionView` page entry point, controller composition, dependency wiring, and top-level
  runtime surface integration.

## App Shell Modularization Status

The `app.tsx` modularization plan in
`docs/plans/2026-07-01-app-tsx-parallel-modularization-implementation-plan.md` is complete as of
Fix 18 (`docs/fixes/2026-07-02-fix-18-app-tsx-modularization-complete.md`). `app.tsx` should stay a
composition root. Put new business behavior into the owning context/page/lib module and wire it
through the shell only when the behavior needs app-level dependencies.

Fix 19 (`docs/fixes/2026-07-02-fix-19-app-tsx-architecture-hardening.md`) hardened the shell
itself: init-cycle dependencies bind through `lib/late-bound.ts` (never new ad-hoc mutable refs;
pre-bind access is reported to bootstrap diagnostics), session id joins go through
`lib/session-identity.ts`, and navigation-aware destructive workflows belong in `controllers/`
(see `controllers/session-folder-move-controller.ts`).

## Dashboard Tabs

These live under `packages/app/src/app/pages/` and are composed by `dashboard.tsx`.

- `settings.tsx`
  App settings, archived sessions, provider/model controls, advanced tools, and developer diagnostics.
- `config.tsx`
  Workspace-scoped config, reload, auto-reload, live access details, and diagnostics bundle.
- `skills.tsx`
  Installed skills inventory, location filters, bulk selection, detail drawer, hub skills, sharing a single skill, and skill editing flows.
- `plugins.tsx`
  Plugins dashboard tab for `opencode.json` plugin management and suggested
  plugin flows. Pluginy is the Czech localization label for Plugins.
- `mcp.tsx`
  MCP server list, connection/auth state, quick connect, and reload banner
  behavior used by Napojení.
- `extensions.tsx`
  Napojení/Connections dashboard shell around MCP servers and connected apps.
- `scheduled.tsx`
  Scheduled jobs, templates, scheduler status, and run-now entry points.
- `scheduled-automation-store.ts`
  Scheduled automation loading, mutation, run-now orchestration, templates, and scheduler status.
- `soul.tsx`
  Soul source overview, source detail, version history, materialization diagnostics, and workspace heartbeat toggle.
- `soul-data-store.ts`
  Soul overview and workspace-source mapping refresh behavior for the dashboard tab.
- `identities.tsx`
  Messaging channels and OpenCode Router identities management for workspace-scoped messaging.

## Cross-Cutting Context and Stores

- `packages/app/src/app/context/workspace.ts`
  Workspace lifecycle, onboarding completion, workspace switching, activation, and remote/local policy branching.
- `packages/app/src/app/context/extensions.ts`
  Skills, plugins, and MCP loading/mutation wiring.
- `packages/app/src/app/context/app-shell-environment.ts`
  App-level DOM/runtime effects such as overlay class state, locale application, and browser-only
  shell side effects.
- `packages/app/src/app/context/app-route-sync.ts`
  Dashboard/session route and hash synchronization that is shared by the app shell.
- `packages/app/src/app/context/feedback-workflow.ts`
  Feedback modal state, runtime metadata collection, submission flow, and post-submit cleanup.
- `packages/app/src/app/context/veslo-server-connection.ts`
  Veslo server settings, connection status, current client selection, invite/share link helpers,
  and server polling owned outside the app shell.
- `packages/app/src/app/context/workspace-runtime-debug-probe.ts`
  Runtime diagnostics probing and workspace busy/debug state refresh behavior.
- `packages/app/src/app/context/den-desktop-auth-workflow.ts`
  Desktop Den browser sign-in handoff, callback polling, keep-signed-in behavior, and auth status
  wiring.
- `packages/app/src/app/context/managed-ai-access-store.ts`
  Managed-AI access profile loading, local proof cache handling, and read-only access state.
- `packages/app/src/app/context/managed-ai-runtime-config.ts`
  Managed-AI runtime config sync, provider/model routing repair, and OpenCode config patching.
- `packages/app/src/app/context/conversation-service.ts`
  Conversation read/write adapter used by app/session workflows instead of calling server APIs
  inline from `app.tsx`.
- `packages/app/src/app/context/app-deep-link-workflow.ts`
  Shared bundle import, remote-connect deep-link handling, and queued deep-link processing.
- `packages/app/src/app/context/skill-registry-orchestrator.ts`
  Skill registry refresh orchestration after extension, workspace, auth, and server state changes.
- `packages/app/src/app/context/mcp-connection-workflow.ts`
  MCP and Notion connection flow state, auth start/polling, reload banners, and quick-connect
  mutations.
- `packages/app/src/app/context/app-send-trace.ts`
  App-level send trace id creation, preflight trace context, timed step wrapper, and external trace fan-in from Veslo server conversation runs.
- `packages/app/src/app/context/app-startup-hydration.ts`
  Startup storage hydration, web/desktop deep-link startup wiring, updater preference restoration, and route startup signal ordering.
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
- `packages/app/src/app/pages/session-attachment-staging.ts`
  Session attachment staging, DOCX/screenshot/imported-file materialization, and staged prompt part
  conversion.
- `packages/app/src/app/pages/session-send-workflow.ts`
  Prompt, shell, command, retry, pending-draft, managed-AI preflight, queue, trace, and
  conversation-run send orchestration.
- `packages/app/src/app/pages/session-creation-workflow.ts`
  New-session creation, directory/workspace targeting, optimistic handoff, and route opening.
- `packages/app/src/app/pages/session-mutation-workflow.ts`
  Retry/replace/undo/redo/rename/delete/list-agents/list-commands/export session mutations.
- `packages/app/src/app/context/session-archive-store.ts`
  Session archive/unarchive state, migration, and archive-aware session visibility.
- `packages/app/src/app/context/session-sidebar-decorations.ts`
  Subagent sidebar role decoration persistence, deterministic classification, and visible
  decoration projection.
- `packages/app/src/app/context/session-route-sync.ts`
  Session route resume/open behavior and selected-session synchronization from route state.
- `packages/app/src/app/context/session-capabilities-store.ts`
  Per-session capabilities loading, admin AI access status, and capability fallback state.
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
  API route registration, auth gates, owner composition, audit, and capability reporting.
- `packages/server/src/ai-gateway-runtime-owner.ts`
  Local AI Gateway runtime state: runtime authorization, active run/session resolution, proxy abort
  tracking, and provider hit watchdogs.
- `packages/server/src/soul-controller.ts`
  Server-side Soul owner for Den context, edit permissions, read payloads, pending user edits, and
  workspace materialization orchestration.
- `packages/server/src/workspace-config-owner.ts`
  Workspace config owner for `.opencode/veslo.json`, conversation directory authorization,
  OpenCode reload helpers, and workspace import/export logic.
- `packages/server/src/config.ts`
  Server config loading and normalization, including `authorizedRoots`.
- `packages/orchestrator/src/`
  Sidecar orchestration, sandbox logic, hot reload, and CLI commands.

## When Looking For Something

- Onboarding or auth issue: start at `onboarding.tsx`, `workspace.ts`, and `den-auth.ts`.
- Settings or persistence issue: start at `settings.tsx`, `constants.ts`, `theme.ts`, and `context/app-startup-hydration.ts`; use `app.tsx` only for final shell wiring.
- Dashboard/session update prompt issue: start at `dashboard-update-pill-model.ts`, then the
  consuming page or sidebar surface.
- Skills/Plugins/Napojení/MCP issue: start at `extensions.ts`, then the
  corresponding page component.
- Workspace config, reload, import/export, or conversation-directory authorization issue: start at
  `config.tsx`, `config-store.ts`, and `packages/server/src/workspace-config-owner.ts`.
- Soul source, permission, pending edit, or materialization issue: start at `soul.tsx`,
  `soul-data-store.ts`, and `packages/server/src/soul-controller.ts`.
- Local managed-AI proxy runtime state issue: start at
  `packages/server/src/ai-gateway-runtime-owner.ts`, then the proxy transport wiring in
  `packages/server/src/server.ts`.
- Session send, queue, retry, or pending-session issue: start at `session-send-workflow.ts`,
  `session-creation-workflow.ts`, or `session-mutation-workflow.ts`, then the page wiring in `session.tsx`.
- Send trace, preflight trace id, or native send diagnostics issue: start at `context/app-send-trace.ts`,
  then follow the injected dependency into the send, creation, mutation, attachment, and conversation-service modules.
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
- General runtime contract issue: start at `packages/server/src/server.ts`,
  `packages/server/README.md`, and then the owning server module for the affected domain.
