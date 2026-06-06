# Veslo Automations Managed Skill Design

Date: 2026-06-05

## Goal

Create a platform-wide managed automation capability for Veslo agents. The feature must let an agent create persistent scheduled actions through an official Veslo API, including recurring automations and temporary one-shot automations such as "in 30 minutes" or "tomorrow at 09:00".

The user-facing skill must be user-global, managed, and locked. Users can rely on it, but cannot delete or edit it through normal skill management flows.

This design intentionally covers the product/API shape only. Implementation code and scaffolding are out of scope until an implementation plan is written.

## Existing Context

Veslo already has related pieces, but they are not yet one product-level automation system:

- The Automations/Scheduled UI is primarily a management and launch surface over OpenCode scheduled jobs.
- The OpenCode scheduler plugin can create durable recurring host jobs through system schedulers such as launchd or systemd.
- Agent Lab has a persistent JSON-backed automation store with interval, daily, and weekly schedule kinds, plus create/list/delete/run APIs.
- Managed user-global skills already have rollout and locked-removal infrastructure.

The new capability should reuse this existing logic where it is sound, but the public product contract should be "Veslo Automations", not "Agent Lab" or raw OpenCode scheduler jobs.

## Chosen Approach

Use a first-class Veslo Automations layer in the Veslo server, plus a managed locked user-global skill that wraps the API.

Rejected alternatives:

- Only teach the skill to call the OpenCode scheduler plugin. This would be too narrow because one-shot automations, session fallback, status history, and product-level observability would remain ad hoc.
- Only extend the existing UI to generate prompts. This would not give agents a reliable API or durable run semantics.
- Build a fully separate scheduler service. This adds avoidable operational surface when Veslo server can own the local-first persistent runner.

The recommended shape is:

- Veslo server owns the API, persistence, runner, status, and recovery semantics.
- The managed skill is the instruction and UX layer agents use to decide when and how to call the API.
- Existing Agent Lab persistence and scheduler helpers can be migrated or adapted internally, but should not remain the public API contract.
- Existing OpenCode scheduler jobs can remain visible for compatibility or migration, especially for recurring OS-backed jobs, but they are not the only execution mechanism.

## Architecture

Add an official Veslo Automations API under the workspace server surface:

- `GET /workspace/:id/automations`
- `POST /workspace/:id/automations`
- `GET /workspace/:id/automations/:automationId`
- `PATCH /workspace/:id/automations/:automationId`
- `POST /workspace/:id/automations/:automationId/run`
- `DELETE /workspace/:id/automations/:automationId`
- `GET /workspace/:id/automations/:automationId/runs`

The Veslo server starts an automation runner during workspace/server startup. The runner loads durable automation state, computes upcoming executions, arms in-memory timers, and records all execution attempts back to persistent storage. The timer layer is only a cache over durable state; losing it must not lose the automation.

The managed skill should be distributed through the existing managed skill rollout system as a user-global locked skill, tentatively named `veslo-automations`. It is not bundled as a mutable user skill.

## Data Model

Automation:

```json
{
  "id": "automation_...",
  "workspaceId": "workspace_...",
  "name": "Daily bug scan",
  "enabled": true,
  "status": "active",
  "schedule": {
    "kind": "cron",
    "expression": "0 9 * * 1-5",
    "timezone": "Europe/Prague"
  },
  "prompt": "Scan the workspace for new bugs and summarize findings.",
  "target": {
    "preferredSessionId": "ses_...",
    "fallbackTitle": "Automation: Daily bug scan",
    "agent": "veslo",
    "model": null,
    "variant": null
  },
  "createdAt": "2026-06-05T10:00:00.000Z",
  "updatedAt": "2026-06-05T10:00:00.000Z",
  "nextRunAt": "2026-06-08T07:00:00.000Z",
  "completedAt": null,
  "lastRunId": null
}
```

Supported schedule kinds:

- `oneShot`: a single `runAt` timestamp, with optional timezone for display and parsing provenance.
- `cron`: a cron expression and optional timezone.
- `interval`: a repeat every `seconds`.
- `daily`: hour/minute/timezone.
- `weekly`: weekday/hour/minute/timezone.

Automation run:

```json
{
  "id": "run_...",
  "automationId": "automation_...",
  "scheduledFor": "2026-06-08T07:00:00.000Z",
  "startedAt": null,
  "finishedAt": null,
  "status": "queued",
  "sessionId": null,
  "createdSession": false,
  "error": null
}
```

Automation states:

- `active`
- `paused`
- `completed`
- `failed`
- `cancelled`

Run states:

- `queued`
- `running`
- `success`
- `failed`
- `skipped`

Successful one-shot automations become `completed` and remain in history. They must not disappear after execution.

## Run Semantics

When an automation fires, the runner creates a run record first, then executes the prompt through the target session behavior.

Session behavior:

- If `preferredSessionId` exists and is usable, the automation continues in that session.
- If the preferred session is missing, closed, or invalid, the runner creates a new session in the same workspace.
- The run record stores the final `sessionId` and whether a new session was created.

Restart behavior:

- On server startup, active automations are loaded from the persistent store and their `nextRunAt` values are recomputed or validated.
- Due one-shot automations should run after restart if they are within a grace window. The recommended grace window is 24 hours.
- One-shot automations older than the grace window should become `skipped` with a recorded reason rather than silently disappearing.
- Recurring automations should not replay an unbounded backlog after downtime. They should run the nearest relevant missed occurrence within policy, then compute the next future occurrence.

Duplicate prevention:

- Each due execution gets a stable run identity derived from automation ID and scheduled time, or an equivalent durable lock.
- Timer races and server restarts must not create duplicate run records for the same scheduled occurrence.

## Skill Behavior

The managed skill should trigger when the user asks for:

- reminders or delayed tasks
- "do this tomorrow / later / in 30 minutes"
- recurring checks, scans, monitors, reports, follow-ups, or daily/weekly work
- explicit cron-like scheduling

The skill must call the official Veslo Automations tool/API wrapper. It should not write scheduler files directly, shell out to cron, or directly call raw OpenCode scheduler plugin tools unless the official wrapper delegates internally.

Skill decision rules:

- If the user asks for one future execution, create `oneShot`.
- If the user asks for a repeated cadence, create `daily`, `weekly`, `interval`, or `cron`.
- If the time is ambiguous enough to create the wrong automation, ask one short clarification question.
- Default to the current workspace and current session when available.
- After creation, verify the automation by reading it back and report `nextRunAt`.

## UI Behavior

The existing Automations tab should be moved toward the Veslo Automations API as the source of truth.

The UI should show:

- active and paused recurring automations
- pending one-shot automations
- completed one-shot automations in history
- failed/skipped runs with readable reasons
- `nextRunAt`, last run status, and last error where available

Compatibility handling for current scheduler jobs can be a separate section or migration bridge. The UI should avoid implying that raw OpenCode scheduler jobs are the complete automation model once Veslo Automations exists.

## Reliability And Error Handling

The product state must live in the persistent store, not only in logs. Logs can help debugging, but API state must answer what exists, what will run next, and what happened last.

Error handling requirements:

- Invalid schedule payloads return structured validation errors.
- Failed runs record `error`, timestamps, and session creation outcome.
- Startup recovery records skipped or recovered due runs.
- Delete/cancel behavior should be explicit: cancelled automations stay understandable in history if they have run records; deletion can remove active definitions subject to product policy.
- Background runs are non-interactive. Any missing information that would require a user answer should fail clearly or use the saved prompt as written.

## Testing Strategy

Prefer E2E coverage for app-visible behavior, with lower-level tests around scheduler logic where E2E would be slow or brittle.

Server/API tests:

- CRUD automations.
- Validate all schedule kinds.
- Compute `nextRunAt`.
- Preserve completed one-shot history.
- Return run history.
- Migrate or read existing Agent Lab automation storage where applicable.

Runner tests with injected clock/timers:

- Rehydrate active automations on server startup.
- Fire a one-shot automation.
- Mark successful one-shot automation as `completed`.
- Recover a due one-shot automation after restart within the grace window.
- Skip stale due one-shot automation after the grace window.
- Avoid duplicate runs across timer and restart races.
- Advance recurring automations without replaying an unbounded backlog.

Session behavior tests:

- Use existing preferred session when present.
- Create a new session in the same workspace when the preferred session is missing.
- Store the final `sessionId` and `createdSession` in the run record.

Managed skill tests:

- The skill materializes as user-global managed and locked.
- The user cannot delete or modify it through normal skill management flows.
- The skill content directs agents to use the official Veslo Automations API/tool wrapper.

Desktop E2E tests:

- In the real Tauri runtime, create a short one-shot automation from the Automations surface or API-backed flow.
- Confirm it runs and remains visible as completed.
- Restart the desktop/server runtime and confirm pending automations rehydrate correctly.

Server changes must be followed by rebuilding the server binary before relying on orchestrator-backed desktop behavior.

## Open Implementation Notes

The implementation plan should decide:

- Whether to migrate the existing Agent Lab JSON file in place or introduce a new file with compatibility reading.
- Whether recurring cron jobs delegate to the existing OpenCode scheduler adapter or are all driven by the Veslo server runner.
- The exact grace-window default and whether it should be configurable.
- The exact API auth/permission gate names.
- How much legacy scheduler UI remains visible during migration.
