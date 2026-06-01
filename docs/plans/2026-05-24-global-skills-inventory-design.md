# Global Skills Inventory Design

## Goal

Move the Skills page from an active-workspace management surface to an app-wide
skills inventory.

The page should show:

- skills available from the existing Hub/marketplace preparation
- skills installed for all workspaces
- skills installed only in specific workspaces
- workspace-specific overrides of globally installed skills

The first implementation phase must not remove or change the existing Settings
overview. Settings cleanup is a later task.

## Product Rules

1. The Skills page is not scoped to the currently active workspace.
2. The Skills page always describes all known skills across the app.
3. A global skill must not be repeated under every workspace.
4. Workspace rows matter only when a skill exists only in that workspace or when
   that workspace has an override of a global skill.
5. Hub behavior should keep using the current prepared marketplace/catalog flow.
   This task must not introduce a new marketplace backend.
6. Scope-changing actions should be designed now, but organization-level
   promotion remains future work until the Den/admin backend exists.
7. Existing Settings behavior stays in place for now.

## Current State

The app has two partial surfaces:

- Settings has a read-only overview that loops through known workspaces and
  shows local skills and MCP config where it can read them.
- Skills has workspace-oriented management: installed skills for the active
  workspace, Hub skills, install/import/edit/share flows, and skill creator
  actions.

The important mismatch is that Skills still treats one workspace as the primary
context, while the desired product behavior is a global settings-style view
owned by the Skills menu.

## Recommended Approach

Use the existing Skills page and replace its mental model with a global
inventory. Keep the existing Hub section, but normalize installed skills before
rendering them.

This is not a full new marketplace system. It is a UI and inventory-model
migration that prepares future backend actions.

## Information Architecture

The Skills page should have three top-level views or sections:

1. Installed
   The default view. Skills are grouped by skill name and show where they are
   installed.

2. By workspace
   A diagnostic view focused only on workspace-specific skills and overrides.
   Global skills are not repeated under each workspace.

3. Hub
   The existing available skills catalog. It continues using the current
   org-scoped Hub path and placeholder behavior.

Recommended filters:

- All
- All workspaces
- Workspace-only
- Overrides
- Hub

Recommended summary metrics:

- Hub available
- Installed
- All-workspace skills
- Workspace-specific installs
- Overrides

## Installed Skills Rendering

Skills should be grouped by name.

Examples:

- `skill-creator`
  - available for all workspaces

- `client-reporting`
  - available only in workspace `Neatech`

- `sales-reference`
  - available only in 3 workspaces

- `research`
  - available for all workspaces
  - overridden in workspace `Veslo`

The page must distinguish these states:

- global only
- workspace only
- global plus workspace override
- hub only
- installed plus hub listing

## UI Inventory Model

Frontend rendering should use a normalized model instead of raw skill arrays.

```ts
type SkillInventoryItem = {
  name: string;
  description?: string;
  trigger?: string;
  globalInstance?: SkillInstance;
  workspaceInstances: SkillInstance[];
  hubItem?: HubSkillCard;
  status:
    | "global"
    | "workspace-only"
    | "mixed"
    | "hub-only";
};

type SkillInstance = {
  id: string;
  name: string;
  scope: "workspace" | "user-global";
  workspaceId?: string;
  workspaceLabel?: string;
  path: string;
  description?: string;
  trigger?: string;
  source: "opencode" | "claude" | "agents" | "hub" | "unknown";
  readable: boolean;
  writable: boolean;
};
```

The key rule is that `workspaceInstances` contains only real workspace-local
installations. It must not contain inherited global skills.

## Data Collection

The first implementation can use existing local capabilities but must split
global and workspace discovery explicitly.

Required reads:

- list global user skills
- list workspace-local skills for each known local workspace, excluding global
  skills
- list Hub skills through the existing Hub flow

The current local skill listing includes global roots. That behavior is useful
for runtime-style "what can this workspace use?" views, but it is wrong for the
global inventory because it makes global skills look like they belong to every
workspace.

The inventory collector therefore needs an explicit mode:

- workspace-only discovery
- global-only discovery
- runtime-effective discovery, if still needed elsewhere

Remote workspaces should remain honest in phase 1. If a remote workspace cannot
be read without activating or connecting to its server, show an unavailable
state instead of inventing inventory.

## Actions

Actions must always target a specific skill instance, not just a skill name.

Safe phase-1 actions:

- install Hub skill into a selected workspace
- install Hub skill into all workspaces if a safe global write path exists
- edit a specific workspace skill instance
- edit a specific global skill instance
- delete a specific workspace skill instance
- delete a specific global skill instance
- move workspace skill to all-workspaces scope
- copy all-workspaces skill into a selected workspace

Actions that should be designed but not enabled yet:

- promote skill to organization catalog
- promote skill to system-wide approved catalog
- bulk apply to all organization workspaces

When installing from Hub, the target can no longer be implicit. The UI must ask
for the target:

- all workspaces
- one selected workspace

If the chosen target is not writable, the action should be disabled with a clear
reason.

## Move Semantics

Workspace to all workspaces:

1. Read the exact workspace instance.
2. Write it to the user-global skills directory.
3. Confirm the global copy exists and parses.
4. Ask whether to remove the workspace-local copy, or perform a move only when
   the product has explicitly chosen that behavior.
5. Refresh inventory.

All workspaces to workspace:

1. Read the exact global instance.
2. Write a workspace-local copy into the chosen workspace.
3. Mark it as an override in inventory.
4. Do not delete the global instance.
5. Refresh inventory.

The safer initial behavior is "copy to target" plus an explicit remove action,
not destructive move, unless the final product copy says otherwise.

## Conflicts And Overrides

Same-name skills are normal and must be visible.

Conflict states:

- global skill exists and workspace skill with the same name exists
- two workspace-specific skills have the same name in different workspaces
- Hub item has same name as an installed skill
- path exists but `SKILL.md` cannot be parsed

The UI should call the first case an override. It should not silently hide the
workspace instance.

Runtime precedence should be explained in the detail panel only when known. If
the actual runtime precedence is uncertain for a source combination, show the
facts without claiming which file wins.

## Settings

Do not remove or rewrite Settings in this phase.

The existing Settings overview can stay as-is while the Skills page gains the
new global inventory. Later, once the Skills page is verified, a separate task
can remove the duplicated Settings surface or replace it with links to Skills
and Extensions.

## MCP And Plugin Parity

The same pattern should later apply to MCP and other extension types:

- Hub/catalog availability
- installed globally for the user/runtime
- installed only in specific workspaces
- workspace overrides
- future organization distribution

MCP differs from Skills because installation mutates config rather than writing
`SKILL.md` files. Plugins and CLI tools may differ again. The shared concept is
the inventory shape and scope vocabulary, not identical install mechanics.

Recommended shared scope vocabulary:

- `workspace`
- `user-global`
- `organization`
- `system-approved`

For this Skills phase, only `workspace`, `user-global`, and Hub catalog
availability need to work.

## Security And Safety

1. Never delete or edit by skill name alone.
2. Always include instance path and scope in mutation requests.
3. Keep path writes constrained to known skills roots.
4. Do not mutate organization or system-wide catalogs without Den/admin policy.
5. Do not treat remote host global scope as the same thing as the local user's
   global scope unless the backend explicitly says so.
6. Preserve audit/reload behavior for any mutation that affects runtime skills.

## Error Handling

Required states:

- local workspace unreadable
- remote workspace inventory unavailable
- global skills directory missing
- invalid or unparsable `SKILL.md`
- duplicate names with multiple instances
- Hub unavailable or unauthenticated
- write target unavailable
- reload required after mutation

Errors should degrade the affected workspace or instance only. A single broken
workspace should not hide the rest of the global inventory.

## Testing Strategy

Preferred test coverage:

1. Inventory grouping tests
   - global skills are not repeated under each workspace
   - workspace-only skills appear with their workspace
   - same-name global plus workspace skill renders as an override
   - Hub-only skills stay separate from installed skills

2. Local discovery tests
   - workspace-only discovery excludes global roots
   - global-only discovery includes user-global roots
   - invalid skills do not crash the inventory

3. Action safety tests
   - edit/delete targets an instance id/path/scope, not just a name
   - Hub install requires target selection
   - copy/move refreshes inventory and marks reload required

4. UI contract tests
   - Skills page no longer depends on active workspace for its primary list
   - Settings overview remains present in this phase
   - global skill does not appear under every workspace in By workspace view

5. Desktop E2E, when actions are implemented
   - create one global skill and one workspace skill
   - verify Skills page shows correct grouping in the real Tauri runtime
   - copy workspace skill to all workspaces
   - reload and verify inventory state persists

## Risks And Open Questions

1. Global scope meaning
   Local user-global skill roots are clear. Remote server global roots are host
   global, not necessarily the signed-in user's global scope. The UI must label
   this carefully or avoid remote global writes until the backend defines it.

2. Runtime precedence
   The inventory can show global plus workspace overrides, but the exact runtime
   precedence should be verified against OpenCode behavior before the UI claims
   which one wins.

3. Destructive move behavior
   Moving from workspace to all workspaces can either copy then optionally
   delete, or perform a destructive move. Copy-first is safer for phase 1.

4. Existing Tauri command shape
   Current local skill listing is runtime-effective and includes global roots.
   It needs a mode or a new command so the inventory can avoid false workspace
   ownership.

5. Hub install target
   Existing install behavior assumes the active workspace. The global Skills
   page must introduce explicit target selection.

6. Settings duplication
   Keeping Settings unchanged means there will be duplicate read-only
   information for a while. That is intentional for this phase and should be
   cleaned up later.

## Acceptance Criteria

1. Skills page presents an app-wide inventory, not active-workspace-only data.
2. Hub/available skills keep using the existing prepared marketplace flow.
3. Installed skills are grouped by name.
4. Global skills are shown once as all-workspaces skills.
5. Workspace-specific skills show only under their owning workspaces.
6. Workspace overrides of global skills are visible.
7. Mutation designs target specific skill instances.
8. Organization promotion is represented only as future-ready design.
9. Settings is not removed or changed in this phase.
