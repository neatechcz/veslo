# Google Workspace Server OAuth Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the production Google Workspace connector path where Veslo
owns Google OAuth, stores encrypted Google grants server-side, and keeps Gmail,
Calendar, and Drive as separate connectors.

**Architecture:** Den/API handles Google OAuth start/callback/status/disconnect
and encrypted token storage. Den publishes platform connector metadata that
points local runtimes to Veslo-owned connector endpoints instead of Google's
raw MCP OAuth endpoints. The Veslo desktop app keeps the three separate Google
cards and starts server OAuth when a connector needs authorization.

**Tech Stack:** Express/TypeScript Den service, MySQL/Drizzle schema, Bun
TypeScript Veslo server, SolidJS desktop app, WebdriverIO desktop E2E.

---

## Context For Implementer

The approved production design is in
`docs/plans/2026-06-19-google-workspace-server-oauth-design.md`.

The earlier local-token MVP plan is superseded. Do not keep adding behavior
that writes Google OAuth client secrets, env placeholders, or user token
material into local OpenCode config.

Production OAuth client already exists:

- Project: `veslo-seo`
- Client name: `Veslo Google Workspace MCP Production`
- Redirect URI: `https://api.veslo.work/v1/integrations/google/oauth/callback`

## Invariants

- Gmail, Calendar, and Drive remain separate connectors.
- Veslo users do not configure Google Cloud or Google CLI.
- Den/API owns Google OAuth exchange and refresh.
- Google refresh tokens are encrypted at rest on the server.
- Catalog payloads do not contain Google OAuth client secrets.
- Workspace MCP config does not contain Google OAuth client secrets.
- Runtime state keeps catalog availability, server authorization, local install,
  and tool readiness separate.

## Task 1: Supersede Local-Token Docs

**Files:**

- Add: `docs/plans/2026-06-19-google-workspace-server-oauth-design.md`
- Add: `docs/plans/2026-06-19-google-workspace-server-oauth-implementation-plan.md`
- Modify: `docs/plans/2026-06-18-google-workspace-mcp-connectors-design.md`

Document the production server OAuth design and mark the local-token design as
superseded.

## Task 2: Pivot Den MCP Catalog To Veslo Connector Endpoints

**Files:**

- Modify: `services/den/src/http/org-mcp-catalog.ts`
- Modify: `services/den/test/org-mcp-catalog.test.ts`

Test first:

- The catalog still returns `google-gmail`, `google-calendar`, and
  `google-drive`.
- Each entry is platform-scoped and grouped under Google.
- Each entry points at a Veslo API MCP endpoint.
- Each entry uses `oauth: false` for OpenCode MCP OAuth.
- No entry contains `clientSecret`, `clientId`, `VESLO_GOOGLE_MCP_CLIENT_ID`,
  or `VESLO_GOOGLE_MCP_CLIENT_SECRET`.
- Each entry exposes non-secret metadata for server OAuth connection setup.

Implementation:

- Replace direct Google MCP URLs with Veslo connector endpoints.
- Keep connector scopes in metadata so the app can show what will be requested.
- Keep user-facing descriptions tied to the individual service.

## Task 3: Preserve Non-Secret Remote MCP Headers

**Files:**

- Modify: `packages/server/src/types.ts`
- Modify: `packages/server/src/den-catalog.ts`
- Modify: `packages/server/src/mcp.ts`
- Modify: `packages/server/src/tests/den-catalog.test.ts`
- Modify: `packages/server/src/tests/server.hub-mcp.test.ts`
- Modify: `packages/app/src/app/lib/veslo-server.ts`
- Modify: `packages/app/src/app/tests/lib/veslo-server.test.ts`

Test first:

- Server accepts catalog entries with `headers`.
- Server rejects malformed header values.
- Installing a hub MCP preserves `headers` into OpenCode config.
- Existing OAuth object support remains for non-Google catalog entries.

Implementation:

- Extend hub MCP item types to support `headers?: Record<string, string>`.
- Validate `headers` as a string-to-string object.
- Preserve `headers` when installing remote MCP entries.

## Task 4: Add Den Google OAuth Routes

**Files:**

- Add: `services/den/src/google-workspace/connectors.ts`
- Add: `services/den/src/google-workspace/oauth.ts`
- Add: `services/den/src/google-workspace/state.ts`
- Add: `services/den/src/http/google-workspace.ts`
- Add: `services/den/test/google-workspace-oauth.test.ts`
- Modify: `services/den/src/env.ts`
- Modify: `services/den/src/index.ts`

Test first:

- Authenticated org member can start OAuth for one connector and receives a
  Google authorization URL with connector-specific scopes.
- Start rejects unknown connector ids.
- Callback validates signed state and exchanges code through the configured
  OAuth client.
- Callback never returns token material in the response.
- Status reports connected/disconnected per connector.
- Disconnect removes or revokes only the selected connector.

Implementation:

- Add envs for Google OAuth client id, client secret, redirect URI, state
  secret, and success/failure redirect base.
- Add signed state containing org id, user id, connector id, nonce, issued at,
  expiry, and return URL.
- Add a Google OAuth client for authorization URL, code exchange, refresh, and
  revoke.
- Mount the router under `/v1`.

## Task 5: Add Encrypted Google Grant Storage

**Files:**

- Add: `services/den/src/google-workspace/store.ts`
- Modify: `services/den/src/db/schema.ts`
- Modify: `services/den/src/index.ts`
- Add: `services/den/drizzle/0015_google_workspace_connections.sql`
- Modify: `services/den/test/schema-reconcile.test.ts` if required

Test first:

- Storing a grant persists only encrypted token payload fields.
- Upserting Gmail does not overwrite Calendar or Drive.
- Disconnect marks or removes only the selected connector.
- Stored grant rows are scoped to org, user, and connector id.

Implementation:

- Reuse the existing AES-GCM secret crypto helper if practical.
- Store encrypted refresh-token material in a Google Workspace-specific table.
- Add indexes for org/user connector lookup.
- Keep access-token material optional and replaceable.

## Task 6: Desktop/App Server OAuth UX

**Files:**

- Modify: `packages/app/src/app/pages/mcp.tsx`
- Modify: `packages/app/src/app/components/mcp-auth-modal.tsx`
- Modify: locale files under `packages/app/src/i18n/locales`
- Add or modify app tests for the new copy and state model

Test first:

- Google cards still render as three separate connectors.
- Google connector CTA starts Veslo server OAuth rather than local OpenCode
  OAuth.
- Copy no longer says Google tokens stay local.
- Connected/disconnected status can be shown independently per connector.

Implementation:

- Add client methods for Google OAuth start/status/disconnect if not routed
  through the existing hub MCP install flow.
- Keep local install and server authorization as separate states.

## Task 7: Verification

Run focused tests after each slice:

```bash
pnpm --filter @neatech/den test -- org-mcp-catalog.test.ts google-workspace-oauth.test.ts
pnpm --filter veslo-server test -- src/tests/den-catalog.test.ts src/tests/server.hub-mcp.test.ts
pnpm --filter @neatech/veslo-ui test:unit -- src/app/tests/lib/veslo-server.test.ts
```

Run the server binary rebuild before relying on orchestrator-backed flows:

```bash
pnpm --filter veslo-server build:bin
```

Use the real desktop E2E path for the final user-visible check when the OAuth
UI is wired:

```bash
pnpm --filter @neatech/veslo-e2e test -- --spec ./specs/google-mcp-connectors.spec.ts
```

## Known External Launch Work

These are not solved by code alone:

- Publish privacy policy and terms on `veslo.work`.
- Configure OAuth consent screen with production app domain and contact info.
- Add and verify authorized domain ownership.
- Keep external users as Google test users until app verification is approved.
- Submit Google verification for requested Gmail/Drive restricted scopes.
