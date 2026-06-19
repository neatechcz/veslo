# Google Workspace Server OAuth Connectors Design

**Date:** 2026-06-19
**Status:** Approved
**Supersedes:** `docs/plans/2026-06-18-google-workspace-mcp-connectors-design.md`

## Goal

Ship production-ready Google Workspace connectors for Gmail, Calendar, and
Drive where Veslo owns the Google OAuth application, end users authorize with
Google, and Veslo stores the resulting Google grants server-side.

Users must not create Google Cloud projects, configure Google CLI, paste OAuth
client secrets, or run local Google OAuth setup. Their flow is: choose a
connector in Veslo, authorize Google in the browser, then use the connector.

## Current Google Cloud State

The production OAuth client exists in the `veslo-seo` Google Cloud project:

- Client name: `Veslo Google Workspace MCP Production`
- Client type: Web application
- Redirect URI: `https://api.veslo.work/v1/integrations/google/oauth/callback`

The callback route is not implemented yet. Until Veslo serves that route and
the OAuth consent screen is complete, external users cannot complete Google
authorization.

## Decision

Keep three separate product connectors:

- Google Gmail
- Google Calendar
- Google Drive

Each connector has its own catalog entry, connection state, Google scope set,
disconnect action, runtime readiness state, and admin policy surface. The UI
may group them under "Google Workspace", but the underlying connectors remain
independent.

Use Veslo server-owned OAuth for the production path:

1. Den/API starts Google OAuth for one connector and one Veslo user.
2. Google redirects to Veslo's production callback.
3. Den/API exchanges the authorization code using Veslo's Google client secret.
4. Den/API stores encrypted Google refresh-token material.
5. Den/API exposes connector status, disconnect, and refresh operations.
6. Local runtimes install Veslo connector endpoints, not raw Google OAuth
   client credentials.

OpenCode must not receive Veslo's Google client secret, Google refresh tokens,
or user Google token material in its static MCP config.

## Connector Runtime Boundary

The runtime-facing MCP config should point at Veslo-owned connector endpoints.
The endpoint may internally proxy to Google's hosted MCP servers or implement
Google API tools directly. That is an implementation detail behind Den/API.

The local OpenCode config should contain only:

- connector id
- remote Veslo MCP URL
- enabled flag
- non-secret runtime metadata
- optionally a short-lived or scoped Veslo connector authorization mechanism

The catalog must not contain:

- Google OAuth client secret
- Google refresh token
- Google access token
- per-user Google account data

## OAuth And Token Storage

Required server behavior:

- `GET /v1/orgs/:orgId/integrations/google/:connectorId/oauth/start`
  creates a signed, expiring OAuth state and returns the Google authorization
  URL.
- `GET /v1/integrations/google/oauth/callback` validates state, exchanges the
  code, stores encrypted token material, and redirects back to the app.
- `GET /v1/orgs/:orgId/integrations/google/connections` returns per-connector
  connection status for the current user.
- `DELETE /v1/orgs/:orgId/integrations/google/:connectorId/connection`
  revokes or disconnects the stored grant.

Token storage requirements:

- Store refresh-token material encrypted at rest.
- Store access tokens only if needed, and treat them as replaceable cache.
- Keep the Google client secret in production secret storage only.
- Keep OAuth state signed and short-lived.
- Scope each connection to Veslo user, organization, and connector id.
- Support independent revocation for Gmail, Calendar, and Drive.

## Google Scopes

Use least-privilege scopes per connector.

Gmail:

- `https://www.googleapis.com/auth/gmail.readonly`
- `https://www.googleapis.com/auth/gmail.compose`

Calendar:

- `https://www.googleapis.com/auth/calendar.calendarlist.readonly`
- `https://www.googleapis.com/auth/calendar.events.freebusy`
- `https://www.googleapis.com/auth/calendar.events.readonly`

Drive:

- `https://www.googleapis.com/auth/drive.readonly`
- `https://www.googleapis.com/auth/drive.file`

These scopes are sensitive or restricted under Google's verification policies.
The production launch therefore needs the OAuth consent screen, privacy policy,
terms, domain verification, test users while unpublished, and Google OAuth app
verification before users outside the Veslo organization can reliably connect.

## State Model

The product state must distinguish:

- catalog available
- installed in the local runtime
- Google grant connected on Veslo server
- local runtime configured for the Veslo connector endpoint
- runtime connected and tool-ready
- needs server OAuth
- needs local runtime reload
- disconnected or revoked
- blocked by Google Workspace admin
- blocked by Veslo admin policy

Configured, authorized, and runtime-ready are separate states.

## Rollout

1. Implement Den/API OAuth, encrypted storage, status, and disconnect.
2. Change Google catalog entries to Veslo-owned connector endpoints.
3. Preserve Gmail, Calendar, and Drive as independent cards.
4. Add the production callback route to `api.veslo.work`.
5. Add legal pages on `veslo.work` and configure OAuth consent screen.
6. Test with internal Google test users while the app is unpublished.
7. Submit Google OAuth verification for public external users.
8. Keep the feature behind a release channel until verification and runtime
   behavior are stable.

## References

- https://developers.google.com/workspace/guides/configure-mcp-servers
- https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification
- https://developers.google.com/workspace/workspace-api-user-data-developer-policy
- https://support.google.com/cloud/answer/13464325
- https://opencode.ai/docs/mcp-servers/
