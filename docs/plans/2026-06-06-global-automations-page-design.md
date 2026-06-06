# Global Automations Page Design

## Goal

Make the Automations page an app-wide management surface, consistent with Skills
and Soul. The page must show automations from all workspaces known to the Veslo
app and allow full editing even when the automation belongs to a workspace that
is not currently active.

## Decision

Use app-side aggregation over the existing workspace-scoped Veslo server API.
Do not add a new global automations overview endpoint for this change.

This matches the existing product model for app-wide surfaces:

- the app owns the list of configured workspaces
- the app maps configured workspaces to server workspace ids
- the app fans out server reads per workspace
- mutations remain workspace-scoped and include the selected workspace id
- unavailable workspaces stay visible with diagnostics instead of disappearing

## Current State

The current Automations page is active-workspace scoped. `App` keeps one
automation list and one run-history map for `vesloServerWorkspaceId()`.
`ScheduledTasksView` receives only bare automation objects and calls create,
delete, and run handlers without workspace context.

That is too narrow for app-wide automation management. Users can see and manage
only the active workspace, which is inconsistent with Skills and Soul.

## Target UX

The Automations page should show a single app-wide page with workspace context
for every automation.

The page should include:

- workspace grouping or a workspace column on each automation row/card
- filters for lifecycle status and workspace
- refresh for the full aggregated view
- create automation for a chosen workspace
- full edit for an existing automation
- run now for an existing automation
- cancel/delete for an existing automation
- clear unavailable/partial-load state per workspace

For inactive workspaces, users should still be able to edit automations as long
as the running Veslo server can resolve that workspace id and the user's token
has collaborator access. The active workspace should not be used as an implicit
mutation target for existing automations.

## Data Model In App

Introduce an app-level aggregated automation view model instead of passing raw
workspace-local automations directly into the page.

Suggested shape:

```ts
type AutomationWorkspaceSummary = {
  appWorkspaceId: string;
  serverWorkspaceId: string | null;
  name: string;
  path?: string | null;
  workspaceType: "local" | "remote";
  status: "ready" | "unavailable" | "error";
  error?: string | null;
};

type AutomationListItem = {
  workspace: AutomationWorkspaceSummary;
  automation: VesloAutomation;
  runs: VesloAutomationRun[];
};
```

Keep per-workspace load state so one broken workspace does not block the whole
page. A failed workspace read should produce a workspace-level diagnostic and
allow other workspaces to render.

## Data Flow

1. Resolve workspace mappings using the same app-side principle as Soul:
   compare app workspaces against `/workspaces` from the connected Veslo server.
2. For each mapped workspace id, call `GET /workspace/:id/automations`.
3. For every automation, call `GET /workspace/:id/automations/:automationId/runs`
   or lazily load runs if the UI needs to reduce request volume.
4. Store aggregated items keyed by `(serverWorkspaceId, automationId)`.
5. Render all loaded automations together, grouped or filterable by workspace.

When the workspace list, Veslo server connection, auth revision, or workspace
mapping changes, refresh the aggregate. Do not require switching the active
workspace.

## Mutations

All mutations stay workspace-scoped:

- create: `POST /workspace/:workspaceId/automations`
- edit: `PATCH /workspace/:workspaceId/automations/:automationId`
- run: `POST /workspace/:workspaceId/automations/:automationId/run`
- cancel/delete: `DELETE /workspace/:workspaceId/automations/:automationId`

The UI must always use the workspace id stored with the selected automation.
For create, the modal must require a target workspace selection. A sensible
default is the active workspace when it is mapped and ready; otherwise use the
first ready workspace.

Full edit means the edit modal can update:

- name
- prompt
- schedule
- target hints such as fallback title, preferred session, agent, model, variant
- enabled/status transitions such as pause, resume, cancel, and reactivate when
  the schedule rules allow it

If the server rejects a reactivation or invalid schedule, show the server
message in the edit modal without losing local form state.

## UI Structure

Reuse the existing Automations page rather than creating a separate route.

Use the app's current visual language, matching the approved Pencil frame
`Global Automations App Visual Design CZ`:

- IBM Plex Sans / IBM Plex Mono typography, not an external admin-dashboard
  style
- Radix gray surfaces (`gray-1`/`gray-2`), subtle `gray-4` borders, and the
  existing `Button` component hierarchy
- the current light Veslo app/sidebar/navigation structure rather than a dark
  enterprise sidebar
- rounded cards/list rows consistent with the current Automations page, not a
  dense hard-edged data table

- header with app-wide status and last refresh time
- compact summary counts by status
- workspace filter, status filter, and search
- list of automation cards with visible workspace name/path
- create button that opens a workspace-aware create modal
- edit action on every automation card

Cards should be dense enough for repeated management work. Avoid requiring
users to switch workspaces to inspect or edit a specific automation.

## Error Handling

The global page can be partially ready:

- server disconnected: show the existing server unavailable state
- workspace unmapped: show workspace diagnostic and no automation rows for it
- workspace read failed: show workspace diagnostic and keep other workspaces
- mutation failed: show inline action/modal error for that automation
- run-history read failed: show the automation without run history and a small
  warning on the card/detail

Errors should identify the workspace involved. A failure in one workspace must
not clear automations from other workspaces.

## Tests

Prefer E2E coverage for the app-wide behavior.

Required test coverage:

- App/unit-level test that Automations aggregation uses all mapped workspaces,
  not only the active workspace.
- App/unit-level test that edit/run/delete handlers include the automation's
  workspace id.
- UI/source test that `ScheduledTasksView` receives workspace-aware automation
  items and exposes edit controls.
- Server/client test only if the client wrapper changes; no new global endpoint
  should be introduced.
- Desktop E2E that creates or seeds automations in two workspaces, opens the
  Automations page, verifies both are visible, switches active workspace, and
  edits an automation from the inactive workspace.

## Non-Goals

- No raw scheduler job UI.
- No new global server overview endpoint for this iteration.
- No direct file edits to `.opencode/veslo/automations.json` from the app.
- No hidden active-workspace mutation fallback for existing automations.
