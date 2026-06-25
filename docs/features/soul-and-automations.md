# Soul and Automations

This document describes the shipped Soul and automation behavior relevant to coding work.

## Automations UI

The Automations UI lives in `packages/app/src/app/pages/scheduled.tsx`.

Current responsibilities:

- list Veslo server-managed automations across every app workspace that can be
  mapped to a Veslo server workspace
- show Veslo server readiness and per-workspace mapping or fetch diagnostics
- create, fully edit, cancel/delete, and manually run automations
- allow management of automations that belong to inactive workspaces
- offer templates

The page is a management and launch surface. It is not the scheduler implementation itself.

Like Soul and Skills, Automations uses app-side aggregation instead of asking the
server for an implicit active workspace view. The app resolves its workspace list
to server workspace IDs, fetches automations and recent run history for each
mapped workspace, and keeps partial results visible when one workspace cannot be
mapped or fetched. Every create, update, delete/cancel, and manual-run mutation
must send the owning server workspace ID explicitly, so inactive workspaces remain
editable without activating them first. New automations default to the active
workspace when that workspace is mapped and ready, otherwise to the first ready
workspace in the aggregated list.
Remote Veslo workspaces that belong to a different connected server are outside
the current server aggregation scope and are skipped instead of shown as mapping
errors.

## Veslo Automations

Veslo automations are persistent workspace definitions managed by Veslo server.
They can be one-shot or recurring. Each automation stores its prompt, schedule,
target session hints, enabled state, lifecycle status, next scheduled run time,
and completed run history.

Supported public behavior:

- One-shot automations run once and then remain visible as completed history.
- Recurring automations compute and persist the next future run after a
  successful scheduled occurrence.
- Paused, disabled, failed, completed, and cancelled automations do not continue
  scheduling until reactivated where applicable.
- Manual run executes immediately through the workspace OpenCode upstream and
  records a run entry without erasing prior history. Target agent, model, and
  variant hints are forwarded when present.
- Deleting an automation cancels the active definition but preserves its run
  history for completed/history views.

Automation reads are available to viewer-level clients. Creating, updating,
cancelling, and manual runs require collaborator access and honor the server
approval mode before mutating the automation store or sending a prompt to
OpenCode. The legacy Agent Lab compatibility routes follow the same approval
requirements for create, delete, and manual run operations.

Agent-facing automation tools are provisioned as Veslo-managed OpenCode plugins.
They read the running Veslo server state from the desktop-provided environment
and call the server automation routes. Agents must not create separate OS jobs or
write scheduler files directly for Veslo automations.
The Automations UI must treat local Veslo server readiness as the unlock for new
automations. It must not prompt users to install external scheduler plugins to
unlock server-managed automations, and it must not render raw job lists.

The server also materializes a platform-managed, locked user-global
`veslo-automations` skill under the `veslo-managed` skill root. The skill directs
agents to use `veslo_create_automation`, `veslo_list_automations`,
`veslo_run_automation`, `veslo_update_automation`, and
`veslo_delete_automation` for persistent one-shot and recurring automations.
Inventory/materialization metadata reports this skill as platform sourced and
locked so normal user removal controls stay disabled.

## Soul

The Soul UI lives in `packages/app/src/app/pages/soul.tsx`.

Current Soul behavior includes:

- source overview with Organization first, User second, and workspace sources in one table
- workspace source rows exclude private workspaces
- explicit Open actions for organization, user, and workspace Soul documents
- modal source detail for organization, user, and workspace Soul documents
- modal close through the close button or Escape
- textarea editing for sources the current account can edit
- server-synced version history, version preview, and restore
- workspace heartbeat status and on/off toggle
- actionable materialization diagnostics when the server reports a runtime conflict or write/config problem

Soul documents stay keyed by `scope + ownerId` internally. API read models also
include a derived `owner` object with the same `kind/id/label/root` shape used
by other Veslo resources, so organization, user, and workspace Soul sources can
share inventory, audit, and multi-workspace ownership logic without migrating
the stored Soul document format.

Soul updates may change the cached source document while an agent run is active,
but runtime materialization must not write `.opencode` Soul files or instructions
for an active workspace. In that case the local server returns a pending
materialization result. The UI passes the current busy workspace ids with Soul
mutations and replays the workspace materialization sync after the workspace is
idle.

## Soul Setup Expectations

Soul setup relies on a combination of:

- memory/config presence
- instructions being available
- heartbeat command existing
- heartbeat job existing
- heartbeat log existing
- at least one successful heartbeat as proof

The source editor treats runtime materialization as automatic. Remote Veslo
workspace provisioning also materializes Soul runtime files when Den identity
context is available and must preserve already materialized files when a later
provision call lacks Den context. If materialization reports a conflict or
status that needs action, the UI should show actionable diagnostics rather than
exposing a manual sync choice.

## Heartbeat Triggering

Workspace Soul heartbeat can be toggled from the selected workspace source. There is no organization heartbeat endpoint; organization-level heartbeat suggestions, if surfaced, must be review-oriented rather than auto-applied by the UI.

If heartbeat runtime semantics change, keep this doc aligned with the actual page behavior and any scheduler dependency changes.

## Relationship Between Soul and Scheduler

Soul is not just a static status page. It depends on scheduler-backed recurring work or equivalent command-driven behavior.

When debugging Soul issues, check both:

- Soul page behavior
- scheduled jobs and command existence

## Source of Truth

- Soul page: `packages/app/src/app/pages/soul.tsx`
- scheduled jobs page: `packages/app/src/app/pages/scheduled.tsx`
- Soul setup command template: `packages/app/src/app/data/commands/give-me-a-soul.md`
