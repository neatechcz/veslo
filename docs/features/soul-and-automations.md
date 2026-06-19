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

## Soul

The Soul UI lives in `packages/app/src/app/pages/soul.tsx`.

Current Soul behavior includes:

- soul health status
- heartbeat recency
- setup audit checklist
- steering hints such as loose ends and next action
- run heartbeat now flow

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
