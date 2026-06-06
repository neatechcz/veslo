# Soul and Automations

This document describes the shipped Soul and scheduled-job behavior relevant to coding work.

## Scheduled Jobs

The scheduled-jobs UI lives in `packages/app/src/app/pages/scheduled.tsx`.

Current responsibilities:

- list scheduled jobs
- show source and scheduler readiness
- delete jobs
- offer templates
- trigger run-now style entry points back into session flows

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

The server also materializes a platform-managed, locked user-global
`veslo-automations` skill under the `veslo-managed` skill root. The skill directs
agents to use `veslo_create_automation`, `veslo_list_automations`,
`veslo_run_automation`, `veslo_update_automation`, and
`veslo_delete_automation` for persistent one-shot and recurring automations.
Inventory/materialization metadata reports this skill as platform sourced and
locked so normal user removal controls stay disabled.

Legacy Agent Lab scheduler routes remain compatibility aliases. Older Agent Lab
automation files are migrated into the canonical Veslo automation store on
server read when the canonical store does not already exist. The legacy list
shows only schedule kinds older Agent Lab clients understand.

## Soul

The Soul UI lives in `packages/app/src/app/pages/soul.tsx`.

Current Soul behavior includes:

- soul health status
- heartbeat recency
- setup audit checklist
- steering hints such as loose ends and next action
- run heartbeat now flow

## Soul Setup Expectations

Soul setup relies on a combination of:

- memory/config presence
- instructions being available
- heartbeat command existing
- heartbeat job existing
- heartbeat log existing
- at least one successful heartbeat as proof

This is surfaced as a setup audit rather than a hidden implementation detail.

## Heartbeat Triggering

The UI can trigger a Soul heartbeat through a workspace prompt flow. The page also polls for updated heartbeat status after trigger attempts.

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
