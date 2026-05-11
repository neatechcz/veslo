# Settings and Preferences

This document describes the shipped Settings behavior and the main preference scopes.

## Settings Tabs

The Settings UI lives in `packages/app/src/app/pages/settings.tsx`.

Current visible tabs:

- `general`
- `archived`
- `model` when developer mode is enabled
- `advanced` when developer mode is enabled
- `debug` when developer mode is enabled

Developer mode restores the full support and diagnostics surface inside Settings, including the model/provider controls and the advanced connection/runtime controls.
The developer mode toggle itself remains reachable from the always-visible `general` tab so the extra tabs can be enabled without already being inside the advanced subsection.

## Scope Model

There are three different scopes in practice:

- app-global browser preferences
- workspace-scoped config in `.opencode/veslo.json`
- runtime diagnostics and host controls that are only meaningful in the current desktop session

## General Preferences

Examples:

- theme mode
- language
- update check and default-on auto-download behavior

These are app-level preferences, mostly stored in browser storage.
Desktop update downloads are enabled by default; Settings can opt out to keep the manual download action.
When a desktop update has already been detected, the dashboard/session left menu also surfaces the update prompt with progress, a manual download action for opt-out users, and an install action once ready. Settings remains the detailed configuration and diagnostic surface for update checks.

## Archived Sessions

Archived session management is surfaced through Settings rather than a permanent sidebar mode.

The archived list is derived from the app's archive model and can show whether an archived session is still available on the current device.
Local desktop archive state can exist without cloud sign-in when a local Veslo server connection is available. Cloud or other remote archive state remains scoped to the signed-in account.

## Model and Thinking Controls

The app exposes:

- default model selection
- thinking visibility (`showThinking`)
- model variant / reasoning effort
- auto-compaction preference

The built-in thinking default is Max (`xhigh`). Existing app-global thinking values from before the Max-default migration are overwritten to Max once, then future user changes remain controlled by the same app-global preference.

Important product rule:

- Veslo uses one global runtime model for future runs across sessions

Do not document or implement model selection as a per-session durable routing contract unless the product rule changes.

## Advanced and Developer Controls

Current advanced and debug areas include:

- Den endpoint override
- keep signed in
- reconnect or restart actions
- migration recovery
- updater details
- titlebar visibility
- runtime debug report
- sandbox probe
- config reveal/reset
- cache repair
- Docker cleanup
- service restarts and logs
- audit log

These are primarily debugging and support surfaces. If behavior changes, update this doc and `docs/dev/state-and-config-reference.md` when persistence or scope changes too.

## Workspace Config Entry Point

Settings includes a debug path to reveal `.opencode/veslo.json`. That file is the durable home for workspace-scoped Veslo config, not a general app preference store.

## Source of Truth

- settings UI: `packages/app/src/app/pages/settings.tsx`
- preference keys: `packages/app/src/app/constants.ts`
- theme persistence: `packages/app/src/app/theme.ts`
- updater state: `packages/app/src/app/context/updater.ts`
- Den auth persistence: `packages/app/src/app/lib/den-auth.ts`
