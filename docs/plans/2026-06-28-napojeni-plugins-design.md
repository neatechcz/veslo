# Napojení And Pluginy Dashboard Design

## Goal

Rename the user-facing Extensions area to Napojení and make it clearly describe
MCP servers as connections to external applications, while restoring OpenCode
plugin management as a separate dashboard tab named Pluginy.

## Current State

The codebase still contains the OpenCode plugin management stack:

- server routes for listing, adding, and removing workspace plugins
- app client methods under the Veslo server plugin domain
- app state and mutation logic for plugin config, scope, status, and reload
- the existing plugin management view with suggested plugins, manual add, and
  remove controls

The current dashboard hides that view. The Extensions screen is MCP-only, and
legacy plugin navigation currently resolves to the MCP/Extensions destination.

## Approved Product Behavior

1. The dashboard label `Extensions` becomes `Napojení`.
2. The Napojení page remains the MCP page.
3. The Napojení page explains that MCP servers connect Veslo to external apps
   and services.
4. A separate dashboard tab named `Pluginy` is added.
5. The Pluginy tab uses the existing OpenCode plugin management view.
6. `/dashboard/mcp` remains compatible and opens Napojení.
7. `/dashboard/plugins` opens Pluginy and is no longer treated as an alias for
   MCP/Napojení.
8. MCP reload messaging and plugin reload messaging remain separate.

## Out Of Scope

- Rewriting the plugin backend or server API
- Building a plugin marketplace or catalog in this slice
- Changing OpenCode plugin loading semantics
- Merging MCP servers and plugins into one shared extension registry
- Removing existing MCP quick-connect or hub behavior

## Architecture

This change should use the existing dashboard tab identity for `plugins` instead
of introducing a new route concept. The visible navigation should show Napojení
for the MCP tab and Pluginy for the plugins tab.

Napojení remains a thin shell around the MCP view. Its copy should make the
runtime model explicit: MCP servers are the integration mechanism for external
applications and services.

Pluginy should render the existing plugin view directly. The app already passes
plugin state and actions from the top-level app store into dashboard props, so
the implementation should reconnect those props to a dedicated dashboard match
instead of rebuilding plugin logic.

## Data Flow

Napojení continues to use the existing MCP flow:

- app context reads configured MCP entries
- runtime status is loaded separately
- hub and quick-connect actions mutate MCP config
- MCP config changes can require runtime reload

Pluginy uses the existing plugin flow:

- app context reads plugin entries from the active workspace OpenCode config or
  Veslo server plugin routes
- adding a plugin writes the OpenCode `plugin` list
- removing a plugin updates the same list
- plugin changes mark the runtime for reload because OpenCode plugins are loaded
  at engine startup

## Error Handling

Napojení should keep current MCP auth, connection, and reload error behavior.
The new explanatory copy must not hide existing status messages.

Pluginy should keep the current plugin status messages for unavailable server
access, missing project folders, read-only access, duplicate plugin specs, and
failed config writes.

For remote workspaces, Pluginy should keep using Veslo server capabilities to
decide whether plugin writes are allowed.

## Testing

Use focused source and unit tests first, then verify the desktop runtime.

App tests should cover:

- `resolveDashboardRouteTab("plugins")` returns `plugins`
- selecting Pluginy opens the plugin tab, not the MCP tab
- Napojení user-facing labels replace Extensions labels where applicable
- the Pluginy dashboard path renders or wires the existing plugin view
- old compatibility for `/dashboard/mcp` remains intact

Existing plugin server/client route tests should stay valid. Only add new route
tests if the implementation changes the app contract.

For final verification, run the real Tauri desktop app through the documented
desktop/E2E flow and smoke-check:

- Napojení opens the MCP page and shows explanatory MCP copy
- Pluginy opens the plugin management UI
- the plugin input is available
- the two pages do not collapse into one another through navigation

## Acceptance Criteria

1. Users see `Napojení`, not `Extensions`, for MCP/external-app integrations.
2. Napojení copy explicitly explains MCP servers and external app connections.
3. Users see a separate `Pluginy` dashboard tab.
4. Pluginy exposes the existing add/remove plugin functionality.
5. `/dashboard/plugins` opens Pluginy.
6. `/dashboard/mcp` opens Napojeni.
7. Plugin changes still trigger the existing plugin reload requirement.
8. MCP changes still trigger the existing MCP reload requirement.
