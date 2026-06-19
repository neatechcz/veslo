# Google Workspace MCP Connectors Design

**Date:** 2026-06-18
**Status:** Superseded by `docs/plans/2026-06-19-google-workspace-server-oauth-design.md`

## Goal

Add platform-distributed Google connectors that let Veslo users connect Gmail,
Google Calendar, and Google Drive through Google-managed remote MCP servers,
while keeping Google OAuth tokens local to the user's device for the first
version.

This was the original local-token MVP design. The production server OAuth
direction supersedes it: Veslo now owns the server callback, server-side grant
storage, and runtime connector boundary.

## Context

Google now documents Google Workspace MCP servers for products such as Gmail,
Calendar, and Drive. These are remote MCP endpoints hosted by Google. Veslo does
not need to host Google's MCP servers for the MVP; it needs to package,
install, and authorize those remote MCP connections in a way that fits Veslo's
local-first runtime model.

Veslo should own the public Google OAuth application and Google Cloud setup for
normal users. End users should not create Google Cloud projects, configure
OAuth clients, or run Google Cloud CLI. Their flow should be limited to
choosing a connector in Veslo and approving Google OAuth consent in the browser.

## Decision

Ship three independent platform connectors:

- Google Gmail
- Google Calendar
- Google Drive

Each connector has its own catalog entry, remote MCP endpoint, OAuth scopes,
install/remove lifecycle, runtime status, and authorization action. The UI may
group them under a Google section and may later offer a "connect all" shortcut,
but the underlying connectors remain separate.

Use Google-managed remote MCP servers for the MVP. Veslo Cloud/Den distributes
connector metadata and Veslo-owned OAuth application configuration, but does not
store user Google refresh tokens. The local OpenCode/Veslo runtime owns the
actual MCP OAuth flow and local token storage.

## Alternatives Considered

### 1. Google-Managed Remote MCPs With Local Tokens

Veslo installs remote MCP config entries that point to Google's hosted MCP
endpoints. Users authorize each connector locally through browser OAuth. Tokens
stay on the device.

This is the selected approach because it has the smallest security and
compliance surface, uses Google's MCP endpoints directly, and fits the current
Veslo local-first runtime model.

### 2. Veslo-Hosted Google MCP Wrapper With Local Tokens

Veslo could host its own MCP server that wraps Gmail, Calendar, and Drive APIs,
while still keeping user tokens local or device-scoped.

This gives Veslo more control over tool naming, policy, and stability if Google
MCP behavior changes. It also creates more implementation and maintenance work,
and it moves Veslo closer to handling Google data directly. Keep this as a
future fallback if the Google-managed MCP surface is not stable enough.

### 3. Veslo Cloud Token Broker

Veslo Cloud could store encrypted Google refresh tokens and expose Google tools
across devices and hosted runtimes.

This would improve cross-device UX, but it substantially increases security,
OAuth verification, audit, revocation, and compliance responsibility. It is out
of scope for the MVP.

## Connector Model

Each connector catalog record should include:

- stable id, for example `google-gmail`, `google-calendar`, or `google-drive`
- display name and description
- remote MCP URL
- OAuth mode and scope list
- supported install targets
- product category and provider metadata
- feature flag or release channel
- optional admin policy metadata

Runtime state should be tracked separately from catalog metadata:

- available
- installed
- needs authorization
- connected on this device
- needs reload
- needs reauthorization
- blocked by Google Workspace admin
- unavailable
- error

The state model must not collapse configured, authorized, and runtime-ready into
one boolean. A connector can be visible in the platform catalog, installed into
local config, authorized locally, and still not runtime-ready until the engine
reloads or the MCP status check succeeds.

## Install And Authorization Flow

1. User opens Extensions.
2. Veslo shows a Google section with separate Gmail, Calendar, and Drive cards.
3. User installs one connector.
4. Veslo writes the remote MCP config into the selected local runtime scope.
5. If the running engine needs to reread startup config, Veslo shows the reload
   state.
6. User clicks Connect.
7. Veslo starts the MCP OAuth flow through the local runtime.
8. The browser opens Google OAuth consent for only that connector's scopes.
9. After authorization, the local runtime stores the token material locally.
10. Veslo refreshes MCP status and shows "Connected on this device" when the
    runtime reports success.

If the same user signs in on another device, Veslo may show the connector as
available or installed by policy, but it must still show that local
authorization is required on that device.

## Scope And Admin Policy

Connectors should be independently installable so users and workspace admins can
grant only the services they need. Gmail, Calendar, and Drive should not be
forced into a single broad Google Workspace grant.

The first version should support normal Veslo-owned Google OAuth configuration.
Later enterprise modes can allow bring-your-own Google Cloud project or
organization-owned OAuth app configuration, but that is not required for the
MVP.

Workspace admins should be able to control whether a connector is available in a
workspace. That policy controls runtime availability; it does not replace the
user's local Google OAuth consent.

## Error Handling

The UI should distinguish:

- Google Workspace admin blocks the OAuth app.
- The user denied consent.
- The connector was installed but the engine has not reloaded.
- The local token was revoked or expired.
- The Google MCP endpoint is unavailable.
- The runtime cannot reach the remote MCP endpoint.
- The local MCP auth flow reports unsupported or missing OAuth configuration.

User copy should be explicit that the MVP is device-local. Prefer wording such
as "Connected on this Mac" or "Authorize on this device" instead of a generic
"Connected" label.

## Testing

Primary verification should use the real Veslo desktop runtime path.

Test coverage should confirm:

- The catalog returns three separate Google connector entries.
- Installing each connector writes only that connector's remote MCP config.
- Installing or removing one Google connector does not affect the other two.
- Reload-required state appears when config changes need runtime reload.
- OAuth handoff opens the browser and returns to a connected local state.
- A second device or clean local auth store shows that local authorization is
  required instead of reusing another device's grant.
- Workspace policy can make a connector unavailable without deleting unrelated
  connector config.

Use lower-level server and app tests only to support the main desktop/runtime
path, for example catalog validation, config writing, status mapping, and
independent connector removal.

## Rollout

Keep the connectors behind a feature flag or release channel while Google
Workspace MCP APIs remain preview-sensitive. Suggested rollout:

1. Internal development OAuth app users.
2. One controlled Google Workspace tenant.
3. Public Google OAuth verification.
4. Broader Veslo beta enablement.

The MVP should not claim cross-device Google authorization. Cross-device use
requires a later Veslo Cloud token broker or organization-managed remote runtime
design.

## References

- https://developers.google.com/workspace/guides/configure-mcp-servers
- https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server
- https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server
- https://developers.google.com/workspace/drive/api/guides/configure-mcp-server
- https://opencode.ai/docs/mcp-servers/
