---
title: Server-Owned Submit Missing Live Binding Recovery KISS Plan
status: proposed
done: false
date: 2026-07-28
issue: unlinked
scope: existing local conversation server-owned submit only
depends_on:
  - docs/dev/opencode-workspace-runtime-architecture.md
  - docs/dev/conversation-workflow-contract.md
  - docs/plans/2026-07-27-kiss-optional-skills-nonblocking-runtime-remediation-plan.md
---

# Server-Owned Submit Missing Live Binding Recovery KISS Plan

## Decision

Repair one reproduced ordering defect in the existing local conversation
server-owned submit path.

When the write registration proves that the current local OpenCode binding is
missing before any conversation-submit HTTP request, the app will:

1. prepare only the local engine/runtime once for the already snapshotted
   target workspace;
2. discard the failed preflight workspace-resolution cache entry;
3. repeat the complete server-owned submit attempt once with the original
   request and `clientMessageId`.

This is neither an idle-only feature nor a general retry policy. A missing live
binding can result from a cold engine, crash, activation race, or other local
runtime transition. It is deliberately distinct from the existing replay after
a transport error, where the server may already have accepted the request.

The plan is proposed and incomplete. E2E and a desktop runtime launch are
explicitly out of scope for this narrow implementation phase.

## Reproduced business problem

The application can have a connected Veslo server client but no current
OpenCode base URL for a local workspace. The write resolver then correctly
refuses to reuse a stale server workspace registration and exits before a
conversation-submit HTTP request occurs.

For an existing server-owned conversation, the current branch immediately
turns that pre-HTTP state into a generic unavailable message. Unlike the
first-message creation branch and the compatibility run bridge, it performs no
engine reachability preparation before its write registration.

The safety fence is correct; the missing bounded recovery is not.

## Confirmed branch matrix

| Path                                        | Current local runtime ordering                            | Phase-one action                |
| ------------------------------------------- | --------------------------------------------------------- | ------------------------------- |
| Existing local server-owned submit          | Live write registration happens before engine preparation | Repair                          |
| First server-owned message/session creation | Engine-only reachability preparation happens first        | Preserve                        |
| Compatibility conversation-run bridge       | Full send preparation happens first                       | Preserve                        |
| Remote Veslo workspace submit               | Does not require a local OpenCode binding                 | Preserve; never recover locally |
| Passive reads and browsing                  | May use a non-live read registration                      | Preserve; never start runtime   |
| Abort/cancel                                | Must not create a runtime merely to cancel                | Preserve                        |

There is a possible post-preparation race in the first-message and compatibility
paths too. It is not part of this phase. Do not widen the first repair to all
write return contracts until the existing-session path is verified in use.

## Critical cache rule

The send preflight holds a workspace-resolution promise by workspace and
directory. Today it stores that promise before awaiting it. Therefore a
pre-HTTP missing-binding result can remain in the same preflight as either a
resolved `null` or a rejected promise.

Without correcting this, a retry after successful engine recovery merely reads
the original failure: it does not perform a new engine-info lookup or a fresh
workspace registration.

Required rule:

```text
successful scoped workspace resolution -> may remain cached for this preflight
null resolution                     -> remove from preflight cache on settle
rejected resolution                 -> remove from preflight cache on settle
```

Removal must be identity-safe: a completed older promise must not delete a
newer flight installed for the same key. The lower registration cache's
non-cacheable behavior is not sufficient; this rule applies to the outer send
preflight cache.

## Required invariants

1. A local write never reuses a stale OpenCode URL or a read-only registration
   as a live write registration.
2. Only the exact pre-HTTP condition `local_live_binding_unavailable` can
   enter the new recovery branch.
3. Missing target, unavailable server client, ordinary workspace-registration
   failure, malformed request, Managed AI preflight failure, and a structured
   server result remain terminal under their current contracts.
4. The recovery invokes engine/runtime reachability only. It must not invoke
   the full send preparation or duplicate Managed AI configuration/bootstrap;
   server-owned submit retains its existing Managed AI freshness and
   authorization ownership after fresh registration.
5. The original snapped workspace, directory, conversation identity,
   `clientMessageId`, and send trace correlation are retained for the retry.
6. Switching UI conversation after Send does not cancel or suppress the
   backend recovery and submit. UI-current guards protect only visible error,
   composer, provisional, and busy presentation effects.
7. Reads, browsing, abort, remote workspaces, and Skills control flow remain
   non-starting for this change.
8. Exactly one pre-HTTP recovery is allowed per submitted intent. No loop is
   introduced.

## Minimal design

### MLBR01 — Add one safe preflight code

Extend the existing internal server-submit preflight error with an optional
safe code. Do not replace the existing `null` contracts across all conversation
write callers.

The exact local path in which a local Tauri workspace requires a live OpenCode
registration but engine info has no usable base URL throws:

```text
ConversationServerSubmitPreflightError
code = local_live_binding_unavailable
httpAttempted = false
```

All existing Managed AI preflight errors retain their current terminal behavior
and have no recoverable local-runtime code. The generic unavailable paths are
not reclassified in this phase.

The error and trace use only safe workspace identity or digest fields. They do
not emit a raw filesystem path, base URL, credential, or prompt content.

### MLBR02 — Make a preflight retry genuinely fresh

Change the preflight workspace-resolution memoization so unsuccessful
resolution does not survive its settlement. Both a `null` result and an error
remove exactly their own promise entry, allowing a later attempt with the same
preflight object to obtain fresh engine info and register the fresh binding.

Keep successful resolution memoization. It avoids duplicate list/register
traffic within one send and is not implicated in the missing-binding recovery.

### MLBR03 — Recover only existing local server-owned submit

In the existing-session server-owned submit workflow:

1. attempt the current server-owned submit;
2. catch only a preflight error whose code is
   `local_live_binding_unavailable` and whose HTTP-attempt marker is false;
3. record a recovery-start decision with the existing send correlation;
4. call the existing bounded engine-only reachability operation for the
   snapshotted target workspace;
5. when it succeeds, retry the whole server-owned submit once using the exact
   original request and same `clientMessageId`;
6. handle the second result with the normal existing-session submit logic.

The recovery itself never consults the currently displayed conversation to
decide whether it may run. After completion, existing UI guards decide whether
to show an error or mutate visible transient state. Backend completion remains
owned by the original send intent.

### MLBR04 — Keep transport replay separate

| Failure location                            | Server may have accepted request | Behavior                                                |
| ------------------------------------------- | -------------------------------- | ------------------------------------------------------- |
| Live binding absent during registration     | No                               | One engine-only recovery, then one fresh submit attempt |
| Transport exception after submit invocation | Unknown                          | Keep the current same-key transport replay              |
| Managed AI/config preflight error           | No                               | Terminal; no engine recovery                            |
| Structured server terminal result           | Yes                              | Existing result handling                                |

The two retry mechanisms need separate trace names and counters. Do not turn
them into a shared retry loop.

## Focused verification

### Conversation service

1. A missing local live binding produces the safe preflight code and proves no
   conversation-submit HTTP request was attempted.
2. With one shared preflight object, the first local resolution fails for a
   missing binding; after test runtime startup, the second resolution performs
   a new engine-info and registration sequence and succeeds.
3. A negative or rejected first resolution does not evict a newer cache flight
   for the same workspace/directory key.
4. A successful resolution remains memoized for the current preflight.
5. Read registration without a live binding remains usable for passive reads.

### Existing-session submit workflow

1. A first `local_live_binding_unavailable` error invokes engine-only
   reachability once, then submits successfully with the original
   `clientMessageId`; it never invokes the compatibility run path.
2. The engine-only recovery failure yields one terminal result, releases busy
   and provisional presentation state once, and performs no loop.
3. A Managed AI preflight error remains terminal and performs no engine-only
   recovery.
4. Missing target, remote-submit block, missing server client, and a generic
   unavailable result perform no engine-only recovery.
5. A UI conversation switch during recovery does not prevent the original
   backend retry; it only suppresses stale visible error/presentation updates.
6. Existing transport-error replay still occurs exactly once with the same
   idempotency key and has distinct trace events.

The current test that expects zero preparation calls for every existing-session
unavailable result must be split. Zero calls remain required for every reason
except the new exact local live-binding code.

### Logging acceptance

One affected trace must show this decision ladder without raw paths or URLs:

```text
existing server-owned submit
  -> local live binding unavailable, httpAttempted=false
  -> engine-only recovery start
  -> engine-only recovery result
  -> fresh workspace resolution
  -> submit terminal result
```

The terminal event includes the original trace/client-message correlation,
recovery attempt count, first safe failure code, and final safe outcome.

## Deferred follow-up

After this phase is verified, evaluate separately whether the same safe code
should repair the rare post-preparation race in first-message materialization
and the compatibility conversation-run bridge. That decision may require a
broader result contract; it is intentionally not implied by this plan.

## Non-goals

- Do not weaken live registration or revive a stale OpenCode URL.
- Do not change remote submit behavior or start local runtime for remote work.
- Do not start runtime for reads, browsing, transcript hydration, or abort.
- Do not run full `prepareSendRuntimeForSend` from this recovery path.
- Do not duplicate Managed AI configuration or authorization admission.
- Do not change server APIs, idempotency semantics, or the legacy fallback
  path.
- Do not add E2E fixtures or make manual desktop evidence a blocking gate.

## Completion gate

Mark complete only when the focused cache and existing-session workflow tests
above pass, app typecheck and the normal repository quality gate pass, and the
plan's trace fields are covered by automated assertions. A manual desktop
capture is useful corroborating evidence, but it is not a prerequisite for
this narrow implementation phase.
