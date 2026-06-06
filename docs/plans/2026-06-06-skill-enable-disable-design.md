# Skill Enable And Disable Design

## Context

Veslo's Skills page currently shows installed local, user-global, workspace, and
some registry-managed skill locations. The server and registry model already
knows about personal, workspace, organization, and platform skill ownership, but
the app inventory does not model platform as a first-class skill scope. It also
does not expose a per-skill enabled state for local runtime skills.

The requested behavior is a switch on every skill in the list. Turning a skill
off must prevent it from being passed to the agent. The agent or another API
client must also be able to ask for the list of disabled skills.

Read-only organization and platform skills need special handling. They should
appear in inventory so users can opt them in or out for their own use, but users
must not be able to inspect their full content or perform write actions against
the source package unless they have a separate admin/governance capability.

## Goals

- Show all available skills in the Skills inventory, including platform skills.
- Add an enable/disable switch to every skill location in card and table views.
- Keep disabled skills visible in inventory so users can re-enable them.
- Exclude disabled skills from agent-facing skill lists and skill resolution.
- Provide a server API that returns every skill disabled for the current
  user/workspace context.
- Let users personally enable or disable read-only organization and platform
  skills without changing the global organization or platform rollout.
- Preserve read-only boundaries: metadata can be shown, but full skill content,
  filesystem reveal, edit, copy, move, delete, publish, and admin rollout
  mutation must remain unavailable for read-only skills.

## Non-Goals

- Do not add a platform-admin rollout management UI.
- Do not treat the user-facing switch as an organization-wide or platform-wide
  enable/disable control.
- Do not remove or move skill directories as a way to disable skills.
- Do not expose full `SKILL.md` content for read-only organization or platform
  skills.

## Recommended Approach

Use a per-instance personal runtime override as the main abstraction.

Each inventory row represents one concrete skill location or registry-backed
availability record. The row has an `enabled` state. If the user turns the row
off, Veslo records that this skill should not be passed to the user's agents in
the relevant context. This applies equally to local skills and read-only
organization/platform skills.

For registry-backed organization and platform skills, the switch must not patch
the rollout policy for everyone. It records a user/workspace-scoped override
that wins before runtime discovery presents skills to the agent. Registry
administrator actions such as disabling a rollout policy remain separate.

## Inventory Model

Extend the app inventory model so `SkillInventoryScope` includes:

- `workspace`
- `user-global`
- `organization`
- `platform`

Each `SkillInstance` should include:

- `enabled: boolean`
- `enabledSource`, or equivalent metadata, to distinguish default enabled state
  from a personal override
- `readable: boolean`
- `writable: boolean`
- registry identity when available: `skillId`, `installationId`, `policyId`,
  `versionId`, `source`, and `removalPolicy`

Platform skills must be represented explicitly. If the local filesystem scan
only finds a materialized managed skill, the app/server should enrich the row
from materialization or registry metadata so the UI can show "Platform" instead
of collapsing the skill into a generic global/workspace row.

Read-only organization/platform rows may include safe metadata such as name,
scope, source, owner, version, enabled state, and short description when that
metadata comes from registry or materialization state. They must not expose full
skill body content.

## Server API

Add server-backed surfaces for the enabled state. Exact route names can follow
existing server style, but the contract should include:

- Read disabled skills for the effective context.
  Returns disabled user/workspace/organization/platform skills with scope,
  name, path if safe, registry identity, and reason/source of disablement.

- Set a skill enabled state.
  Accepts a concrete target similar to existing skill mutation targets:
  `name`, `scope`, optional `workspaceId`, optional safe `path`, optional
  registry metadata, and `enabled: boolean`.

- Inventory list.
  Returns all skills, including disabled rows.

- Agent-facing list and resolve.
  Returns only enabled skills. Disabled rows must not be candidates.

The personal override store should be server-owned so desktop, remote clients,
and agents see the same state. It should live under Veslo-controlled local data
or workspace-scoped config, not inside skill packages.

If OpenCode `permission.skill` deny rules are the runtime integration point, the
server should maintain or generate those rules from the override store. This
keeps disabled skills unavailable to the agent instead of merely hidden in the
Veslo UI.

## UI Behavior

Add a switch to each skill card and each skill table row. The default state is
enabled unless a server override or registry state marks it disabled.

Disabled skills:

- remain visible in inventory
- show a "Disabled" badge or equivalent state
- can be re-enabled from the same switch
- are excluded from the agent-facing list and skill resolve
- appear as disabled in session capability surfaces, where feasible, so the
  state is explainable

Read-only organization and platform skills:

- show metadata and the enabled switch
- do not show edit, reveal, copy, move, delete, publish, or full-content actions
- may open a metadata-only detail drawer
- cannot expose the full `SKILL.md` body

Bulk actions should add:

- Enable selected
- Disable selected

These bulk actions are valid for mixed read-only/writable selections. Existing
copy, move, remove, restore, and publish actions should remain limited to
compatible writable or registry-actionable selections.

## Runtime Semantics

Before a skill is passed to an agent, Veslo must evaluate:

1. registry/materialization availability
2. personal/workspace enabled overrides
3. existing lifecycle state such as removed or locked
4. runtime permission filtering

A disabled skill must not appear in:

- `GET /workspace/:id/skills` when used as an agent/runtime list
- skill resolution candidates
- any prompt/tool surface that enumerates available skills for the agent

The inventory endpoint or inventory mode must still include disabled rows.

## Error Handling

- If saving an enabled override fails, leave the switch in the previous state
  and show a toast/error.
- If a read-only skill lacks enough identity to persist an override, disable the
  switch and explain that the skill cannot be toggled until registry metadata is
  available.
- If a skill is locked by policy, the user-facing personal toggle can still opt
  out only if product policy permits personal opt-out. Organization/platform
  rollout mutation remains blocked for normal users either way.
- If runtime reload is required, emit the normal `skills` reload event and
  integrate with existing pending reload behavior.

## Testing

Prefer E2E coverage through the real Tauri runtime for the main user behavior:

- all skill scopes, including platform, appear in the Skills inventory
- toggling a skill off keeps it visible as disabled
- disabled skills do not appear in agent-facing list/resolve
- read-only organization/platform skills can only be toggled and cannot be
  edited, revealed, copied, moved, deleted, published, or opened as full content
- bulk enable/disable works for mixed selections
- enabled state persists after app/runtime reload

Add focused server and app tests for:

- override store read/write
- disabled-skills API response shape
- `listSkills` and `resolveSkill` filtering
- app inventory mapping for `platform` scope and labels
- read-only action gating
- session capabilities showing disabled skills as disabled, if that surface is
  updated in the implementation slice

## Documentation Updates

When implemented, promote the durable behavior into:

- `docs/features/skill-registry-and-distribution.md`
- `docs/dev/state-and-config-reference.md`
- `docs/dev/veslo-server-app-contract.md`

The promoted docs should clearly separate personal enable/disable overrides from
administrator rollout policy changes.
