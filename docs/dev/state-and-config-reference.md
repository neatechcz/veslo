# State and Config Reference

This document describes the main persistence and config surfaces used by Veslo.

## Scope Categories

- App-global UI preferences: browser storage keys in the Solid app.
- Workspace-scoped config: `.opencode/veslo.json`.
- OpenCode config: `opencode.json` or `opencode.jsonc`.
- Server connection state: browser storage keys managed by `veslo-server.ts`.
- Den auth state: browser storage keys managed by `den-auth.ts`.

## App-Global Browser Preferences

Primary keys are defined in `packages/app/src/app/constants.ts` or persisted directly from `app.tsx`.

Common keys:

- `veslo.defaultModel`
- `veslo.showThinking`
- `veslo.modelVariant`
- `veslo.language`
- `veslo.hideTitlebar`
- `veslo.autoCompactContext`
- `veslo.themePref`
- `veslo.updateAutoCheck`
- `veslo.updateAutoDownload`
- `veslo.updateLastCheckedAt`
- `veslo.baseUrl`
- `veslo.clientDirectory`
- `veslo.projectDir`
- `veslo.engineSource`
- `veslo.engineCustomBinPath`
- `veslo.engineRuntime`
- `veslo.onboardingComplete`

Session/sidebar convenience state also lives in local storage, for example:

- last selected session per workspace
- active pending draft key
- session directory override map
- subagent decoration preferences
- left sidebar width
- dashboard nav collapsed state
- project grouping and collapse state

Treat these as UI state, not product contract, unless a feature depends on them explicitly.

Session archive records are loaded through the Veslo server archive API. When a cloud account is available, archive requests use that account id as the owner key. In local desktop mode without cloud auth, loopback Veslo server archive requests use the local desktop owner key `local:desktop`; remote archive requests still require a cloud account id.

Pending draft content itself is additionally mirrored into the desktop pending-draft store so unpublished drafts survive restart with their current text and attachment chips.

During workspace switches, the sidebar may already have task rows for the target workspace while the global session store still reflects the previous workspace or is startup-empty. The sidebar must keep those existing target rows until scoped sessions for the target workspace load, so a transient empty store does not hide a remote worker's project list.

## Workspace Activation State

Workspace activation state is runtime-only state managed by `packages/app/src/app/context/workspace.ts`.

- `workspaceConnectionStateById[workspaceId].status === "connected"`
  Means the workspace activation flow succeeded for the app surface.
- In Tauri local-to-local browsing mode, the active workspace can be `connected` even while the live OpenCode client is intentionally detached.
- In that browsing mode the app loads sidebar/session history from SQLite first, and only re-attaches the engine when the user performs an action that requires it, such as sending a message.
- The sidebar connection dot treats this state as runtime-available when the Veslo server is also connected, so browsing a different local workspace does not appear as a false runtime failure.

## Den Auth State

Managed by `packages/app/src/app/lib/den-auth.ts`.

Primary keys:

- `veslo.den.auth`
- `veslo.den.keepSignedIn`
- `veslo.den.apiBaseOverride`
- `veslo.den.desktopAuthPending`

Meaning:

- `veslo.den.auth`
  Persisted authenticated Den session state.
- `veslo.den.keepSignedIn`
  Controls whether auth prefers local storage across launches or narrower session lifetime.
- `veslo.den.apiBaseOverride`
  Developer override for the browser sign-in endpoint.
- `veslo.den.desktopAuthPending`
  Temporary desktop auth handoff state during browser sign-in.

In Tauri startup flows, the desktop auth snapshot is allowed to repair stale browser auth state. A snapshot is explicitly signed out only when it carries no auth and disables `keepSignedIn`; a signed-in snapshot may still disable `keepSignedIn` to request session-only auth. If the snapshot explicitly represents a signed-out state, or if the snapshot user identity conflicts with the browser-stored user identity, the snapshot wins before the rest of app bootstrap continues. Matching or identity-ambiguous browser auth stays in place and re-syncs the desktop snapshot instead, while still honoring the snapshot's `keepSignedIn` preference.

## Veslo Server Connection State

Managed by `packages/app/src/app/lib/veslo-server.ts`.

Primary keys:

- `veslo.server.urlOverride`
- `veslo.server.port`
- `veslo.server.token`

These control which Veslo server URL the app connects to and which bearer token it sends.

Invite-link and bundle-link parsing also lives in `veslo-server.ts`. Incoming query parameters can override the stored connection state for a launch flow.

## Managed-AI Routing and Accounting

Managed-AI identity and assignment are DEN-backed: the signed-in DEN user determines provider/model access and any assigned Codex credential. The managed-AI inference base URL is configured separately from that identity. Desktop and orchestrator development defaults use the standalone AI Gateway at `https://veslo-ai-gateway-dev.onrender.com`; `VESLO_MANAGED_AI_BASE_URL` overrides it, with `VESLO_AI_GATEWAY_BASE_URL` retained as the legacy fallback.

Usage events are attributed by request id, DEN user id, org id, session id, and credential record. Token accounting persists input, output, cached tokens, and total tokens so admin views can group usage by user, org, session, or credential without recomputing totals.

Codex limit exhaustion is modeled as temporary ineligibility. If no automatically selectable Codex credential is eligible, the surfaced reason is `all_codex_credentials_exhausted`; this does not by itself mark a credential unhealthy. Permanent upstream auth failures, such as invalid or revoked auth, are credential health failures.

When DEN assigns a specific Codex credential, that assignment is binding for the session request. Exhausted or unavailable assigned credentials fail explicitly; only automatic selection may rotate among other eligible credentials.

## Workspace-Scoped Config

Workspace config lives in:

- `<workspace>/.opencode/veslo.json`

The app-level type is `WorkspaceVesloConfig` in `packages/app/src/app/types.ts`.

Current structure:

- `version`
- `workspace.name`
- `workspace.createdAt`
- `workspace.preset`
- `authorizedRoots`
- `reload.auto`
- `reload.resume`

Meaning:

- `authorizedRoots`
  Roots the workspace may access through Veslo-managed local flows.
- `reload.auto`
  Whether queued reloads should apply automatically when the workspace is idle.
- `reload.resume`
  Whether Veslo should try to restore session continuity after an automatic reload.

## OpenCode Config

OpenCode config lives in one of:

- `<workspace>/opencode.json`
- `<workspace>/opencode.jsonc`
- some flows also inspect `.opencode/opencode.json`

Use this surface for:

- plugins
- MCP server config
- agent overrides
- command-related OpenCode settings

Veslo pages that mutate plugins or MCP are usually editing this config, not `.opencode/veslo.json`.

## Import and Export

Workspace config export/import is handled by `packages/app/src/app/stores/config-store.ts` and Tauri commands.

Current local archive format:

- export file extension: `.veslo-workspace`
- export/import is only supported for local workers
- import expects a target folder and then activates the imported local workspace

## Notion and Other Integration Status

Some lightweight status values are persisted in browser storage for UI continuity, for example:

- `veslo.notionStatus`
- `veslo.notionStatusDetail`
- `veslo.notionSkillInstalled`

Treat them as UI hints. The integration itself still depends on the real config/runtime state.

## Pending Draft Persistence

Desktop pending drafts are stored outside browser local storage in the Tauri app data directory.

Current behavior:

- pending draft metadata and attachment copies live in the desktop pending-draft store
- browser local storage keeps the active pending draft key so the app can restore the same unpublished draft on restart
- `New session` is globally singleton while unpublished: reopening it returns to the existing private pending draft
- project pending drafts are keyed by workspace plus normalized directory
- pending drafts remain out of the sidebar until a real session is created by sending them

## Precedence Rules

Use this general precedence order when debugging config:

1. Explicit invite or bundle link in the current URL
2. Explicit browser-stored override for the current app surface
3. Workspace-scoped config in `.opencode/veslo.json`
4. OpenCode config in `opencode.json` or `opencode.jsonc`
5. Environment defaults and built-in fallbacks

## Change Guidelines

- If a new persistent setting is user-facing, document its key and scope here.
- If a new workspace-level setting changes runtime behavior, document it here and in the matching feature doc.
- Do not document ephemeral signals or transient component state unless future agents must preserve it for correctness.
