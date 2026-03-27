# Reconnect + Resume Auto-Heal Design

Date: 2026-03-27  
Repo: /Users/vaclavsoukup/AI agent projects/Veslo

## Summary

Implement a resilient reconnect flow so ongoing runs survive brief disconnects and machine sleep.

Approved UX behavior:

- Auto-heal reconnect in background.
- Show `Reconnecting…` once per outage episode.
- Show `Reconnected` once when recovered.
- Show reconnect/recovered messages only if any session is running (including non-selected sessions).
- Keep retrying forever.
- Do not restart/trigger work for idle sessions.
- After recovery, continue work by syncing missed state for sessions that were running during outage.

## Problem

Current reconnect behavior relies mostly on stream end/error and does not explicitly model outage episodes tied to running sessions. This creates risk that users lose confidence that work continues after brief network loss/sleep, especially when background/non-selected sessions are running.

## Goals

- Preserve in-flight work continuity after transient disconnections.
- Provide minimal but clear user feedback (`Reconnecting…` / `Reconnected`).
- Avoid noisy/repeated notifications.
- Never auto-start a new run during reconnect logic.
- Keep behavior predictable and local-first.

## Non-goals

- No auto-replay of user prompts.
- No creation of new sessions/tasks during reconnect.
- No reconnect banners for idle-only states.

## Chosen Approach

Primary: session-layer outage tracker with running-session awareness.

Why this option:

- Matches user intent precisely.
- Keeps reconnect UX tied to actual task execution state.
- Avoids false-positive reconnect noise when nothing is running.

## Design

### 1) Outage episode state

Add reconnect episode state in session/workspace runtime state:

- `outageActive: boolean`
- `outageHadRunningSessions: boolean`
- `shownReconnectingForEpisode: boolean`
- `shownReconnectedForEpisode: boolean`
- `runningSessionIdsAtOutageStart: Set<string>`

Episode lifecycle:

1. SSE degradation detected (stream end/error/unhealthy transition).
2. Compute running sessions from canonical `sessionStatusById` across all known sessions.
3. If none running, no user-facing reconnect UI.
4. If any running, mark outage episode active and show one-time `Reconnecting…`.
5. Retry forever with existing exponential policy.
6. On successful recovery, run catch-up for sessions in `runningSessionIdsAtOutageStart`, then show one-time `Reconnected` and clear episode.

### 2) Recovery and catch-up semantics

Catch-up applies only to sessions that were running at outage start.

Per running session:

- Refresh session status from server.
- Refresh latest messages/parts to recover output produced while disconnected.
- Refresh todos/permissions if needed.

Rules:

- If session is now idle/completed, reflect that state and stop.
- If session fetch fails, fail soft and continue reconnect process for other sessions.
- Never call `session.prompt()` from reconnect logic.

### 3) Notification behavior

- `Reconnecting…` shown once per outage episode.
- No repeated reconnecting messages during retries.
- `Reconnected` shown once after successful recovery.
- Notifications only if any session was running (selected or non-selected).

### 4) i18n

Add/verify locale keys in English and Czech:

- reconnecting message (`Reconnecting…`)
- reconnected message (`Reconnected`)

Czech must include translated `Reconnected` as requested.

### 5) Engine/runtime rebind resilience

Keep session-layer logic primary. Add a lightweight non-invasive runtime rebind check path to avoid stale local binding edge cases (for example after sleep/runtime port churn), without changing user-visible behavior.

### 6) Observability

Add structured diagnostics for:

- outage start/end
- running-session count at outage start
- reconnect attempt progression
- catch-up completion/failure per session

Keep logs concise and suitable for debugging reconnect incidents.

## Error Handling

- Retry forever for transient failures.
- Do not spam user with repeated banners.
- Do not surface blocking error for idle-only outages.
- If catch-up partially fails, continue with remaining sessions and maintain recovered connection state.

## Testing Strategy

### Unit tests

- Outage with no running sessions -> no reconnect/reconnected banner.
- Outage with selected running session -> one reconnecting + one reconnected.
- Outage with non-selected running session -> same one-time messaging.
- Infinite retry does not duplicate reconnecting message.
- Catch-up executes only for sessions running at outage start.
- Reconnect logic never triggers `session.prompt()`.

### Integration tests

- Simulate stream interruption mid-run and verify resumed state + user messaging.
- Simulate sleep-like visibility/network interruption and verify same behavior.

### Localization checks

- English and Czech keys present and wired to reconnect notifications.

## Documentation Updates

Document final behavior in user/dev docs:

- When reconnect messages appear.
- Why idle sessions do not show reconnect messaging.
- Guarantee that reconnect logic does not start new work.

## Acceptance Criteria

- During active run outage: one `Reconnecting…`, auto-heal, one `Reconnected`, run state continues.
- No repeated reconnecting message spam.
- Idle-only outage: no reconnect banner and no run restart.
- Non-selected running sessions still trigger reconnect UX.
- Czech translation for reconnected message is present.
