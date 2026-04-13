# MCP Extensions Simplification And Org Catalog Design

## Goal

Simplify the existing Extensions screen so it only presents MCP-based apps, keep `Control Chrome` as the only built-in system entry, and define an org-scoped MCP catalog distribution flow that mirrors the approved Skills catalog pattern.

## Current State

- The Extensions screen currently merges MCP and OpenCode plugins into one surface.
- The screen renders a segmentation row for `All`, `Apps`, `Plugins`, and a top-level refresh action.
- The built-in quick-connect list includes `Notion`, `Linear`, `Sentry`, `Stripe`, `Context7`, and `Control Chrome`.
- The MCP detail view still exposes `Technical details`.
- The MCP screen still exposes an `Advanced settings` block with config-file actions and a manual add action.
- Plugin management exists as a first-class UI concept, with suggested plugins, plugin installation, plugin removal, and plugin-scoped copy.
- Skills catalog distribution already has an approved target pattern in [`docs/plans/2026-04-12-org-scoped-extension-catalog-distribution-design.md`](./2026-04-12-org-scoped-extension-catalog-distribution-design.md).

## Approved Product Behavior

1. The existing Extensions screen remains the screen being edited. This is not a redesign task.
2. The screen removes the MCP/plugin segmentation row entirely.
3. The screen removes all plugin-specific UI and stops presenting plugins as a user-facing concept.
4. The built-in MCP list keeps only `Control Chrome`.
5. The built-in hardcoded entries `Notion`, `Linear`, `Sentry`, `Stripe`, and `Context7` are removed from the app-provided list.
6. The MCP detail panel removes `Technical details`.
7. The Extensions screen removes the MCP `Advanced settings` section only.
8. The `Add MCP server` action remains available.
9. `Control Chrome` is automatically added to workspace MCP config when missing.
10. Existing workspaces receive `Control Chrome` on their next open if no known Chrome MCP alias is already present.
11. Org-scoped MCP catalog distribution must follow the same server-mediated auth and transport model as Skills.
12. MCP catalog distribution gets its own dedicated endpoints rather than sharing a generic multi-type extensions endpoint.

## Scope

In scope:

- Simplify the current Extensions/MCP UI by removing plugin affordances and extra MCP controls
- Keep only `Control Chrome` as the built-in system MCP entry
- Auto-seed `chrome-devtools` into workspace MCP config when absent
- Define org-scoped MCP catalog fetch and install routes that mirror Skills
- Define error handling, migration behavior, and test expectations

Out of scope:

- Redesigning the Extensions screen layout from scratch
- Removing MCP manual-add capability
- Removing plugin backend/server surfaces in the same task
- Unifying all extension types behind one shared `/hub/extensions` route
- Defining catalog storage implementation details inside Den beyond the contract
- Implementing CLA or other future extension types in this task

## Constraints

1. Server-consumption first: the app talks to Veslo server surfaces, not directly to Den.
2. Existing Extensions screen composition should be preserved wherever possible; only unwanted UI is removed.
3. `Control Chrome` must remain available even when org catalog is empty or unavailable.
4. Auto-seeding Chrome must not overwrite user-owned MCP config.
5. Org-scoped catalog visibility requires authenticated Den user context and active organization context.
6. Catalog install behavior for MCP must remain type-specific and cannot be collapsed into Skills install semantics.

## Options Considered

### Option 1: Dedicated MCP catalog route with the same security and transport pattern as Skills (chosen)

Use type-specific MCP catalog routes and install routes that mirror Skills naming and layering.

Pros:

- Matches the already-approved Skills pattern closely
- Keeps MCP installation semantics explicit
- Avoids over-generalizing endpoint behavior too early
- Leaves future extension types free to define their own install actions

Cons:

- Adds another route family beside Skills

### Option 2: Unified extensions catalog route

Use a generic route such as `/hub/extensions?type=mcp`.

Pros:

- Fewer endpoint families

Cons:

- Mixes different installation semantics behind one surface
- Not aligned with the approved direction for Skills
- Adds abstraction without a current product need

### Option 3: No org catalog for MCP, only built-in entries plus manual add

Keep only built-in app entries and manual add, without Den-backed MCP distribution.

Pros:

- Lowest implementation cost

Cons:

- Does not satisfy the requirement to distribute MCP the same way as Skills
- Leaves MCP availability outside org-scoped control

## Recommended Approach

Use Option 1.

The app should keep a dedicated, simplified Extensions screen for MCP only, while MCP catalog distribution follows the exact same layered transport model as Skills:

1. App talks only to Veslo server.
2. Veslo server talks to Den.
3. Den enforces org-scoped access.
4. App installs catalog MCP entries through a dedicated MCP install route.

## Extensions Screen Contract

### Remove

- The `All / Apps / Plugins` segmentation row
- The plugin count badge and plugin summary text
- The plugin section title and plugin cards
- Suggested plugins UI
- Plugin add/remove controls
- Plugin-specific copy and labels
- MCP detail `Technical details`
- MCP `Advanced settings` block

### Keep

- The existing Extensions screen as the place where users manage MCP-based apps
- The existing connected-app status behavior
- The existing installed/connected MCP list
- The `Add MCP server` action
- Manual MCP add for both catalog and non-catalog cases
- Existing MCP auth/connect/disconnect/remove flows

### Built-in entries

The app-provided built-in MCP list is reduced to:

- `Control Chrome`

Removed from the built-in hardcoded app list:

- `Notion`
- `Linear`
- `Sentry`
- `Stripe`
- `Context7`

These services may later reappear only through org-scoped MCP catalog distribution, not as hardcoded app bundle entries.

## Control Chrome Auto-Seed Contract

`Control Chrome` remains a system MCP provided by the application, but it is also persisted into workspace MCP config.

### Required behavior

1. Use stable workspace config key `chrome-devtools`.
2. On workspace create and workspace open/activation, check whether a Chrome MCP alias already exists.
3. Treat both `chrome-devtools` and `control-chrome` as satisfying the requirement.
4. If neither alias exists, append a Chrome MCP config entry to `opencode.jsonc` or `opencode.json`.
5. If the config file does not exist yet, create the minimal file and write the MCP entry.
6. After a successful seed, refresh MCP state so the screen immediately reflects the entry.

### Seeded config shape

```json
{
  "mcp": {
    "chrome-devtools": {
      "type": "local",
      "command": ["npx", "-y", "chrome-devtools-mcp@latest", "--isolated"]
    }
  }
}
```

### Protection rules

- Never overwrite an existing user-defined Chrome MCP config
- Never create duplicate Chrome entries
- Never block workspace open if seeding fails
- If the workspace is read-only or cannot be written, skip seeding and show a non-blocking UI status

### Remote workspace rule

For remote workspaces, auto-seeding can run only when Veslo server has MCP write capability. Otherwise the screen still loads, but the workspace config remains unchanged.

## MCP Catalog Distribution Contract

This feature must reuse the Skills catalog transport model, but with MCP-specific routes and install semantics.

### Canonical data flow

1. `packages/app` calls `GET /hub/mcp` on Veslo server.
2. App includes Den context headers:
   - `X-Veslo-Den-Token`
   - `X-Veslo-Den-Org-Id`
3. `packages/server` validates that the request contains the required Den context.
4. `packages/server` calls Den:
   - `GET /v1/orgs/:orgId/mcp/catalog`
   - `Authorization: Bearer <den-token>`
5. Den validates session and org access.
6. Den returns org-scoped MCP catalog items.
7. Veslo server maps the response into app-facing MCP hub items.
8. App renders those entries on the existing Extensions screen alongside built-in `Control Chrome`.

### Endpoint pattern

The MCP route family mirrors Skills naming:

- Catalog fetch: `GET /hub/mcp`
- Catalog install: `POST /workspace/:id/mcp/hub/:name`

App client mirrors Skills client naming:

- `listHubMcp()`
- `installHubMcp(workspaceId, name)`

This is intentional and should remain parallel to:

- `GET /hub/skills`
- `POST /workspace/:id/skills/hub/:name`
- `listHubSkills()`
- `installHubSkill(...)`

## API Contract

### Den (new)

Endpoint:

- `GET /v1/orgs/:orgId/mcp/catalog`

Auth and access:

- Requires authenticated session token via `Authorization: Bearer ...`
- Requires organization access for `orgId`

Response shape:

```json
{
  "items": [
    {
      "id": "notion",
      "name": "Notion",
      "description": "Pages, databases, and project docs in sync.",
      "config": {
        "type": "remote",
        "url": "https://mcp.notion.com/mcp",
        "oauth": true
      }
    }
  ]
}
```

Rules:

- `id` is stable and unique within the catalog
- `config.type` is `remote` or `local`
- `remote` items require `url`
- `local` items require `command`
- `oauth` declares whether follow-up auth is expected

Error behavior:

- `401` unauthorized when token is missing or invalid
- `403` forbidden when the user lacks org access
- `400` invalid organization id shape if needed by Den validation

### Veslo server (`packages/server`)

Endpoints:

- `GET /hub/mcp`
- `POST /workspace/:id/mcp/hub/:name`

Required inbound headers from app for catalog fetch:

- `X-Veslo-Den-Token`
- `X-Veslo-Den-Org-Id`

Behavior:

- Reject missing Den token with `401`
- Reject missing org id with `400`
- Fetch Den org-scoped catalog and map it to the MCP hub schema used by app
- Install route writes catalog-provided MCP config into workspace config and then triggers runtime MCP activation

### App integration contract (`packages/app`)

1. The app never calls Den MCP catalog endpoints directly.
2. The Extensions screen uses Veslo server as the only MCP catalog caller.
3. Catalog-provided MCP installs go through `installHubMcp(...)`, not the ad hoc manual-add flow.
4. Manual add remains available for non-catalog MCP servers.

## Install Semantics

Installing an MCP from the org catalog means:

1. Resolve the selected catalog item by name/id through Veslo server.
2. Write the item config into workspace `opencode.json[c]`.
3. Refresh configured MCP entries.
4. Activate the MCP for the current runtime session when possible.
5. If the item requires OAuth, continue into the existing MCP auth flow after installation.

This differs from Skills installation, which writes files into `.opencode/skills`. The routing is mirrored, but the install side effect remains MCP-specific.

`Control Chrome` is excluded from org catalog install and is handled as a built-in system entry plus auto-seeded workspace config.

## Error Handling

### Catalog fetch

- If Den token is missing: show auth-required failure for MCP catalog, not a generic unknown error
- If org id is missing: show org-context failure
- If Den returns `403`: show org access failure
- If Den catalog fetch fails: keep the Extensions screen usable with built-in `Control Chrome` and any already-configured MCP entries

### Auto-seed

- If Chrome auto-seed fails, do not block workspace load
- Surface a non-blocking MCP status message
- Allow manual `Add MCP server` to continue working

### Catalog install

- If workspace config write fails, stop before auth/connect continuation
- If config write succeeds but runtime activation fails, keep the MCP entry persisted and show it as added but not connected

## Testing Strategy

### Den tests

- Unauthorized request to org MCP catalog returns `401`
- Authenticated non-member request returns `403`
- Authenticated org member request returns `200`
- Empty catalog returns `{ "items": [] }`

### Veslo server tests

- `/hub/mcp` fails without Den token header
- `/hub/mcp` fails without org id header
- `/hub/mcp` maps Den response into app-facing MCP catalog shape
- `POST /workspace/:id/mcp/hub/:name` writes MCP config using catalog data
- Catalog fetch failure does not remove built-in `Control Chrome` availability

### App tests

- Extensions screen no longer renders plugin segmentation UI
- Extensions screen no longer renders plugin install/remove UI
- Built-in app list contains only `Control Chrome`
- MCP detail no longer renders `Technical details`
- MCP area no longer renders `Advanced settings`
- `Add MCP server` remains available
- Empty org catalog still produces a valid Extensions screen with `Control Chrome`

### Workspace migration tests

- New workspace gains `chrome-devtools` when missing
- Existing workspace gains `chrome-devtools` on next open when missing
- Existing `chrome-devtools` entry is not overwritten
- Existing `control-chrome` alias prevents duplicate insertion
- Read-only workspace skips seed without blocking open

## Acceptance Criteria

1. The existing Extensions screen remains in place, but plugin-facing UI is removed.
2. The screen no longer shows plugin segmentation or plugin management controls.
3. `Control Chrome` is the only built-in hardcoded app entry.
4. `Notion`, `Linear`, `Sentry`, `Stripe`, and `Context7` are no longer shipped as built-in entries.
5. The MCP detail view no longer exposes `Technical details`.
6. The MCP `Advanced settings` block is removed from the Extensions screen.
7. `Add MCP server` remains available.
8. `Control Chrome` is automatically seeded into workspace MCP config when missing.
9. Existing workspace Chrome config or known aliases are never overwritten.
10. MCP catalog distribution follows App -> Veslo server -> Den only.
11. MCP catalog uses dedicated MCP routes rather than a generic extensions route.
12. The install route mirrors Skills naming via `POST /workspace/:id/mcp/hub/:name`.
