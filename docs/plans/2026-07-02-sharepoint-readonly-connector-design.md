# Microsoft SharePoint Read-Only Connector Design

Date: 2026-07-02

## Summary

Add Microsoft SharePoint as a read-only platform connector in Napojení. The connector should follow the existing platform MCP connector model used for Google Workspace: Den owns Microsoft OAuth and encrypted user grants, while the local Veslo runtime receives only a remote MCP entry plus short-lived Veslo connector token material.

The MVP is read-only. It lets agents search, list, inspect, and read SharePoint content that the signed-in Microsoft user can already access. It does not create, edit, delete, move, or permission SharePoint content.

## Goals

- Add `Microsoft SharePoint` as a platform connector in Napojení.
- Use delegated Microsoft user authorization so SharePoint access follows the user's existing permissions.
- Keep Microsoft client secrets, access tokens, and refresh tokens out of local OpenCode config.
- Expose SharePoint read-only capability through MCP so agents can use it as a normal connected app.
- Preserve the current separation between catalog visibility, local installation, server authorization, runtime connection, and reload-needed state.

## Non-Goals

- No write support in the MVP.
- No application-level tenant-wide Graph permissions in the MVP.
- No local SharePoint/OneDrive sync-folder dependency.
- No custom direct SharePoint UI outside the existing Napojeni/MCP pattern.
- No broad Microsoft 365 connector bundle in the first pass; SharePoint is a separate connector entry.

## Selected Approach

Implement SharePoint as a platform Microsoft 365 MCP connector.

This keeps the product model aligned with Veslo's existing integration direction:

- Napojení is the user-facing connected-app surface.
- MCP is the runtime capability boundary.
- Den owns cloud-backed OAuth and encrypted grants.
- Local Veslo server writes only secret-free runtime config into workspace OpenCode config.
- The Tauri desktop app and local Veslo server remain the runtime under test.

Rejected alternatives:

- Direct Microsoft Graph routes from the Veslo server would create a special-purpose integration path and bypass the MCP capability model.
- Reading a local synced SharePoint folder would be simpler but would inherit OS file-access issues, unstable local paths, weaker auditability, and no clean OAuth boundary.

## Architecture

The connector has four ownership layers.

### App

The app displays Microsoft SharePoint in Napojení. It uses the existing MCP catalog, install, auth, status, reload, and disconnect flows as much as possible.

The app must treat these states separately:

- catalog-visible: the platform connector is available from Den catalog metadata
- installed/configured: the active workspace contains the remote MCP entry
- server-authorized: the user completed Microsoft OAuth for the connector
- runtime-connected: the live runtime reports the MCP server as usable
- reload-needed: config changed but the runtime has not loaded it
- auth-expired/error: the server-side Microsoft grant is missing, revoked, or unusable

### Local Veslo Server

The local server installs the SharePoint MCP entry into workspace OpenCode config. It may refresh short-lived Veslo connector runtime tokens through Den and update the `X-Veslo-Connector-Token` header in the workspace config.

The refresh path must not start browser OAuth, create Microsoft grants, revoke Microsoft grants, or write Microsoft token material locally.

### Den

Den owns:

- Microsoft connector catalog metadata
- Microsoft OAuth start, callback, code exchange, refresh, and disconnect
- encrypted per-user grants scoped by organization, user, and connector
- short-lived runtime token issuance
- SharePoint MCP proxy endpoint

Den should copy the Google Workspace connector structure where practical, but use provider-specific modules and names for Microsoft.

### Microsoft Graph

The Den-hosted connector uses Microsoft Graph on behalf of the authorized user. It should request delegated read-only scopes and rely on the user's Microsoft permissions for effective SharePoint access.

## Connector Identity

Initial connector metadata:

- id: `microsoft-sharepoint`
- name: `Microsoft SharePoint`
- provider id: `microsoft`
- provider group: `Microsoft`
- authorization type: `veslo-server-oauth`
- config type: remote MCP
- source scope: platform

Expected Den paths should mirror the Google connector shape, for example:

- catalog item: `/v1/orgs/:orgId/mcp/catalog`
- OAuth start: `/v1/orgs/:orgId/integrations/microsoft/microsoft-sharepoint/oauth/start`
- OAuth callback: `/v1/integrations/microsoft/oauth/callback`
- runtime token: `/v1/orgs/:orgId/integrations/microsoft/microsoft-sharepoint/runtime-token`
- status: `/v1/orgs/:orgId/integrations/microsoft/connections`
- disconnect: `/v1/orgs/:orgId/integrations/microsoft/microsoft-sharepoint/connection`
- MCP endpoint: `/v1/orgs/:orgId/integrations/microsoft/microsoft-sharepoint/mcp`

The exact route shape can be adjusted during implementation if it better fits existing router composition, but it should remain provider/connector scoped.

## OAuth And Permissions

MVP authorization should use delegated Microsoft OAuth. The connector should not ask for application permissions or tenant-wide admin consent unless Microsoft requires it for a specific future deployment mode.

The first implementation should use the smallest practical read-only Microsoft Graph scopes for:

- reading the signed-in user's profile/identity as needed by OAuth status
- reading SharePoint sites and files the user can access
- searching or listing SharePoint content if supported by the chosen Graph API path

The implementation plan must verify the exact scope set against current Microsoft Graph documentation before coding, because Microsoft permissions are versioned and product-specific.

## MCP Tool Surface

The MVP tool surface should be intentionally small:

- search SharePoint content
- list accessible sites
- list document libraries for a site
- list folder or drive children
- read file metadata
- fetch readable file content when Graph supports it

The connector should return explicit, typed errors for:

- missing server authorization
- expired or revoked Microsoft auth
- insufficient SharePoint permission
- site/library/file not found
- unsupported file type
- oversized content
- Microsoft Graph throttling or transient upstream failure

Write operations should not be present in the MCP manifest or accepted by the server.

## Data Model

The server-side connection store should follow the Google Workspace pattern:

- id
- organization id
- user id
- connector id
- connection state
- scopes
- encrypted grant payload
- access token expiry
- connected timestamp
- revoked timestamp
- created/updated timestamps

Provider-specific naming is preferred over over-generalizing too early. A later refactor can introduce a shared OAuth connector store once both Google and Microsoft prove the same shape is stable.

## Security Rules

- Never write Microsoft access tokens, refresh tokens, or client secrets to OpenCode config.
- Never expose Microsoft token material through app-facing catalog payloads.
- Treat runtime connector tokens as renewable local config material, not as Microsoft authorization state.
- Keep OAuth state signed and time-limited.
- Enforce organization and user ownership on every OAuth, status, runtime-token, disconnect, and MCP proxy route.
- Sanitize upstream Graph errors before returning them to the app or agent.
- Do not broaden SharePoint permissions silently when a Graph call fails.

## User Experience

Napojení should show Microsoft SharePoint as a platform connector. It should use the same install/connect/status/reload mental model as other MCP connectors.

Important behavior:

- Installing the connector writes secret-free remote MCP config.
- Connecting starts Microsoft OAuth.
- Runtime token refresh only renews the Veslo connector token.
- Disconnect revokes or marks the server-side Microsoft grant disconnected.
- Permission failures should say that the user does not have access to the requested SharePoint content, instead of flattening the issue into a generic MCP offline state.

## Documentation

Durable behavior changes should update:

- `docs/features/extensions-and-integrations.md`
- `docs/dev/state-and-config-reference.md`

Implementation-specific route or test changes should update additional developer docs only if they introduce new durable workflow rules.

## Testing Strategy

Primary verification should use the real Tauri desktop runtime for user-visible behavior, with mocked Den/Microsoft endpoints for repeatability.

Focused coverage:

- Den unit tests for Microsoft OAuth URL generation, code exchange, token refresh, revoke/disconnect, signed state, runtime tokens, and encrypted grant storage.
- Den catalog tests proving SharePoint appears as a platform connector with secret-free config.
- Local server tests proving catalog install writes the expected remote MCP entry and includes only allowed headers.
- Runtime-token refresh tests proving expired connector tokens are refreshed once without starting OAuth.
- App tests for Napojeni card/status behavior and localized labels.
- Tauri Pilot E2E for install/connect/status/reload flow with mocked Den/Microsoft endpoints.

Manual or separate integration smoke can validate against a real Microsoft tenant after the mocked flow is stable.

## Open Questions For Implementation

- Exact Microsoft Graph delegated scope set for read-only SharePoint operations.
- Whether the first MCP endpoint should proxy an existing Microsoft-compatible MCP upstream or implement the MCP tools directly over Graph.
- File content limits and conversion behavior for Office document formats.
- Whether disconnect should remove the workspace MCP entry or leave it installed but disconnected; the implementation should follow the existing Napojeni pattern.
