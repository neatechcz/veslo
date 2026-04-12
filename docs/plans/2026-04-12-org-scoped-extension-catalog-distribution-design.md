# Org-Scoped Extension Catalog Distribution Design

## Goal

Define a single secure distribution pattern for extension catalogs in Veslo, starting with Skills and then reusing the same architecture for MCP and other extension types.

The immediate implementation target is Skills catalog loading and Skills page behavior. The broader design contract is intentionally extension-wide.

## Approved Product Behavior

1. The app must load catalog availability from Veslo server surfaces, not by calling Den directly from UI.
2. Catalog access requires authenticated user context and active organization context.
3. Catalog data is org-scoped by default.
4. Skills Hub list is intentionally empty for now (mock backend), but the pipeline must already be production-safe.
5. Skills page keeps only installed/hub counts and a persistent `Create skill in chat` CTA.
6. Skills page removes profile/mode/skill-creator status cards.
7. Skills installation section shows an organization placeholder message while catalog is empty.
8. Skill Creator is preinstalled by default and no longer presented as optional install info.
9. Starter seed skills are only:
   - `skill-creator`
   - `plugin-creator`
   - `agent-creator`

## Scope

In scope:

- `services/den`: new org-scoped Skills catalog endpoint (mock response)
- `packages/server`: `/hub/skills` changes from GitHub Hub to Den-backed org-scoped catalog fetch
- `packages/app`: pass Den auth context to Veslo server for hub fetch and update Skills UI behavior
- `packages/desktop`: adjust workspace bootstrap default seeded skills
- i18n copy updates for Skills page states
- tests and docs for new flow

Out of scope:

- real Den catalog storage/business logic (response remains empty)
- public catalog exposure
- direct UI installation from external repositories
- MCP/Plugins/Commands/Agents catalog implementation in this task (only design contract is defined)

## Constraints

1. Server-consumption first: UI talks to Veslo server surface.
2. Local-first runtime remains intact.
3. Cloud-backed org auth is required for catalog visibility.
4. No unauthenticated catalog read path.
5. No bypass route that leaks extension inventory outside org auth.

## Options Considered

### Option 1: UI-only local mock

App/server return empty list locally without Den integration.

Pros:
- Fastest implementation.

Cons:
- Does not establish org-scoped cloud contract.
- Not reusable for real distribution.

### Option 2: Veslo server mediated org-scoped Den catalog (chosen)

App calls Veslo server; Veslo server calls Den org-scoped endpoint.

Pros:
- Matches architecture principles.
- Centralized auth/scoping and future auditing.
- Reusable for MCP and other extension catalogs.

Cons:
- Slightly more integration work across app/server/den.

### Option 3: App calls Den directly

App fetches Den endpoint directly from UI.

Pros:
- Fewer hops.

Cons:
- Breaks server-consumption-first model.
- Duplicates auth/routing logic in UI.
- Harder to keep runtime modes consistent.

## Recommended Approach

Use Option 2 as the canonical pattern for catalog distribution.

### Canonical Data Flow

1. `packages/app` calls `GET /hub/skills` on Veslo server.
2. App includes Den context in headers:
   - `X-Veslo-Den-Token`
   - `X-Veslo-Den-Org-Id`
3. `packages/server` validates request auth and required Den context headers.
4. `packages/server` performs server-to-server call to Den:
   - `GET /v1/orgs/:orgId/skills/catalog`
   - `Authorization: Bearer <den-token>`
5. Den validates user session token and org membership/role.
6. Den returns `{ items: [] }` (mock catalog for now).
7. Veslo server maps response to existing hub schema and returns to app.

## API Contract

### Den (new)

Endpoint:

- `GET /v1/orgs/:orgId/skills/catalog`

Auth and access:

- Requires authenticated session token (`Authorization: Bearer ...`)
- Requires org access (`requireOrganizationAccess` for `orgId`)

Response (mock):

```json
{
  "items": []
}
```

Error behavior:

- `401` unauthorized when no/invalid session
- `403` organization forbidden
- `400` invalid organization id shape (if applicable)

### Veslo server (`packages/server`)

Endpoint remains:

- `GET /hub/skills`

Required inbound headers from app:

- `X-Veslo-Den-Token`
- `X-Veslo-Den-Org-Id`

Behavior:

- Reject missing Den token (`401`)
- Reject missing org id (`400`)
- Fetch Den org catalog and map to hub response shape

Response shape to app:

```json
{
  "items": []
}
```

Config:

- Add server env for Den API base URL (for example `VESLO_DEN_API_BASE`)
- No hardcoded per-request endpoint in app

## App Integration Contract (`packages/app`)

1. `extensionsStore.refreshHubSkills()` remains the only UI caller for hub catalog.
2. It reads Den auth context from existing auth state (`readDenAuth()`).
3. It passes Den token + org id to Veslo server client call for `listHubSkills`.
4. It never calls Den catalog endpoint directly.

## Skills Page UX Contract

### Remove

- Worker profile block and profile-specific metadata
- Skill Creator status card
- Mode status card (local/server)

### Keep

- Persistent `Create skill in chat` CTA
- Installed skills count
- Hub available count

### Install section

- No installable entries while catalog is empty
- Placeholder copy in all locales:
  - EN: `Skills for your organization will be available here.`
  - CS: `Tady budou dostupné skilly pro vaši organizaci.`
  - ZH (fallback/explicit): localized equivalent

### Capability setup

- Remove install prompt/card for Skill Creator

## Workspace Bootstrap Default Skills

Update starter seeding so the final default set is:

- `skill-creator`
- `plugin-creator`
- `agent-creator`

Do not seed:

- `workspace-guide`
- `get-started`
- `command-creator`

## Security Model

1. No public catalog endpoint for unauthenticated users.
2. Org scoping is enforced by Den access checks, not by client trust.
3. Veslo app does not expose Den catalog URL surface directly in UX flow.
4. Catalog retrieval is centrally controlled in Veslo server for future policy/audit/rate-limit controls.

## Testing Strategy

### Den tests

- Unauthorized request to org catalog returns `401`
- Authenticated but non-member request returns `403`
- Authenticated org member request returns `200` with empty `items`

### Veslo server tests

- `/hub/skills` fails without Den token header
- `/hub/skills` fails without org id header
- `/hub/skills` returns mapped empty list when Den returns empty list

### App tests

- Skills page does not render profile/mode/skill-creator stat blocks
- Persistent `Create skill in chat` CTA is rendered
- Install section renders org placeholder when hub list is empty
- No hardcoded English fallback strings in Skills page source

### Bootstrap tests

- New workspace includes only approved default creator skills
- Excluded skills are not seeded

## Future Extension Parity (MCP and Others)

This design is the reference pattern for catalog distribution across extension types.

Planned parity principle:

1. App calls Veslo server only.
2. Veslo server calls Den org-scoped catalog API.
3. Den enforces org access.
4. UI renders org-scoped availability and installability states.

Future endpoints can be added either as type-specific routes (for example `/mcp/catalog`) or as a unified extensions catalog route with `type` filtering. The security and transport pattern must remain identical to Skills.

## Acceptance Criteria

1. Skills Hub fetch path is App -> Veslo server -> Den only.
2. Den catalog endpoint is org-scoped and auth-protected.
3. Skills UI shows only approved cards/sections and persistent create CTA.
4. Hub install area shows org placeholder and no installable entries while catalog is empty.
5. Default seeded skills exactly match approved list (`skill-creator`, `plugin-creator`, `agent-creator`).
6. Design can be referenced as the baseline for MCP and other extension distribution.
