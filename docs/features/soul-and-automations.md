# Soul and Automations

This document describes the shipped Soul and automation behavior relevant to coding work.

## Automations UI

The Automations UI lives in `packages/app/src/app/pages/scheduled.tsx`.

Current responsibilities:

- list Veslo server-managed automations
- show Veslo server readiness
- create, delete, and manually run automations
- offer templates

The page is a management and launch surface. It is not the scheduler implementation itself.

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
cancelling, and manual runs require collaborator access.

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

## Soul Setup Expectations

Soul setup relies on a combination of:

- memory/config presence
- instructions being available
- heartbeat command existing
- heartbeat job existing
- heartbeat log existing
- at least one successful heartbeat as proof

The source editor treats runtime materialization as automatic. If materialization reports a conflict or status that needs action, the UI should show actionable diagnostics rather than exposing a manual sync choice.

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
