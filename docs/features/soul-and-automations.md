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

- source overview with Organization first, User second, and workspace sources in one table
- selectable source detail for organization, user, and workspace Soul documents
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
