# Fix 63: Lifecycle Error Boundary, Directory Retirement, and Runtime Binding Identity

Date: 2026-07-28

## Scope

Implemented the repository-owned findings of
`docs/plans/2026-07-28-adjacent-runtime-lifecycle-cache-findings-plan.md`:
findings D, E, I, and K.

The plan's remaining findings are deliberately not part of this fix. A, B, C, G,
H, and J were already implemented by work that landed while the plan was being
written, and were closed by re-validation rather than by new code. F is a state
naming and contract decision, not a repair. L and M belong to Den and AI Gateway
owners and cannot be validated from this checkout.

Desktop E2E and manual installed-runtime verification remain user-owned and are
not claimed by this fix.

## Root cause

**Lifecycle error mapping (K).** Three byte-identical copies of
`lifecycleRequestApiError()` existed in the server composition root, the
conversation routes, and the run lifecycle controller. Each placed the
orchestrator request path and the complete upstream body into `ApiError.details`,
and the shared `formatError()` copies `details` straight into the client
response. The server binds its configured host and optionally a `--bridge-host`
address served with the same auth, so it is not guaranteed loopback-only. This
made internal topology leave the process on every lifecycle failure. The
composition-root copy had no caller after route extraction.

**Directory skill view lifecycle (D).** The lifecycle instance map and the
orchestrator's directory-to-workspace binding were only ever written. There was
no removal operation, so a workspace that was repointed at a new path left its
previous instance registered. That stale entry kept answering active-run checks
with a workspace id that no longer lived at that path, and a directory path
reused later inherited the retired instance's epoch.

**App runtime skill bindings (E).** Bindings were keyed by workspace id alone,
were never evicted, and carried no identity beyond the two revisions. A binding
could therefore outlive the workspace it was resolved for, survive a path
change, and be inherited by a reused id. Publication was also unguarded, so a
slow preparation could overwrite the result of a newer one that had already
finished.

**Outer resolution acceptance (I).** The conversation service removes a `null`
or rejected outer `conversationWorkspaceByDirectory` promise only when that exact
promise is still the map value. The identity comparison was correct, but the
supersession case it exists for had no test.

## Implemented behavior

- One shared `lifecycle-error-mapping` module replaces all three copies; the
  unreferenced composition-root copy is removed.
- A lifecycle failure response carries only `upstreamStatus`. The diagnostic
  trace retains the request path and a structural upstream-body summary (kind,
  length, and at most a small set of field names), never body content.
- An upstream body that cannot be inspected yields a null summary rather than
  failing the error path.
- The lifecycle status and code classification is carried over unchanged.
  Refining a lifecycle code still waits for the `/runs/:runId` evidence; the
  shared module states that constraint at its definition.
- `DirectorySkillViewLifecycle.unregister()` removes an instance, cancels any
  scheduled completion retry, and advances a generation tombstone. It retains
  the operation queue long enough to fence a late publish from resurrecting a
  reused key.
- Binding a workspace to a directory instance retires any previous instance
  bound to that same workspace id only after that instance is idle and disposed,
  then emits an `orchestrator:directory-skill-view:retired` trace. Retirement
  also serializes behind a first publish that has not yet created an entry.
  The orchestrator has no workspace-delete endpoint, so rebinding is the only
  removal signal this owner receives today.
- A runtime skill binding records the workspace path it was resolved for. A read
  that supplies a different path is answered as absent so the caller re-resolves
  rather than sending a stale view to the runtime.
- Each preparation takes a monotonic per-workspace epoch and publishes only
  while that epoch is current, so a late arrival cannot overwrite a newer
  result.
- Forgetting a workspace evicts its binding but advances its epoch tombstone.
  This matters most for scratch workspaces, where a late preparation for an old
  path must never publish over a newly reused workspace id.
- The live registration cache is invalidated by a client or base-URL change.
  It does not yet carry an explicit engine-generation identity for the unlikely
  same-URL restart case; that is a separate residual observation, not a claim
  closed by this fix.

## Review round follow-ups

Three independent reviews of this change produced further repairs, all included
here.

**Credential redaction left the secret behind.** A review reported that the
shared trace sanitizers used `$1=[redacted]` against a regex with no capture
group. That claim is wrong — the group exists — but checking it surfaced a real
leak in the same expression. The value pattern consumed a single token, so
`authorization: Bearer <secret>` redacted only `Bearer` and left the secret in
the trace. The scheme prefix is now consumed with the value in the app trace
sanitizer, the orchestrator, the run lifecycle controller, and the conversation
routes.

**Den fails closed on a missing audit table.** Den reads and writes
`ai_gateway_audit_event` but does not own its schema: the AI Gateway migrations
create it, and Den accepts an optional separate `MANAGED_AI_DATABASE_URL`. The
migration does exist, contrary to one review, but nothing verified that it had
been applied to the database Den is pointed at. Both the audit and alert
repositories now convert a missing-table driver error into
`managed_ai_audit_schema_unavailable`, naming the table and its owning
migrations. Unrelated database errors pass through unchanged.

**Batched traces flush on renderer teardown.** Native trace batching keeps the
newest entries in memory, which is where a crash loses them. The batch is now
flushed on `pagehide` and on the transition to a hidden document.

**Failure snapshots expire and clear on success.** Persisted send-failure
snapshots had no lifetime and no success path, so a resolved error stayed at the
top of the debug tail across restarts. A terminal `submitted` result now clears
its workspace snapshot, and snapshots older than 24 hours are dropped on load.
An unparsable timestamp is dropped rather than becoming permanent.

**Test-only Rust helper is scoped.** `append_send_workflow_trace_line` is used
only by tests and is now `#[cfg(test)]`, clearing the dead-code warning without
removing something the tests rely on.

One review finding was not acted on: the live registration cache still has no
explicit engine-generation identity for a same-URL restart. Each engine spawn
takes a fresh free port, so the same-URL case has no reproducing evidence. It
stays recorded as a residual observation rather than being masked as solved.

## Live-run evidence

A real desktop run produced NDJSON traces for all three sources: 1022 UI, 391
server, 108 orchestrator events across two workspaces.

**The revision handshake is exercised and agrees.** All six
`orchestrator:runtime-skill-resolution` events show `requestedRevision` equal to
the serving revision, on both the activation and proxy-admission paths. One
workspace resolved to the canonical `empty-direct-skill-view/v1` and that empty
binding was honored rather than silently substituted. A revision change for one
workspace produced a new `engineOwnerId`, which is the revision-aware engine
replacement behaving as intended under real traffic.

**No failure path was exercised.** The run contains no lifecycle error, no
skill-view conflict, and no transport replay; all 16 run-status requests
settled. K1's remaining verification is therefore still outstanding — this run
proves the healthy path, not the redaction of a lifecycle failure response.

**The traces surfaced a diagnostic regression, now fixed.** Private trace keys
are matched by substring, and the matched value was replaced regardless of its
type. Boolean presence flags such as `hasGatewayToken`, `hasLocalClientToken`,
and `currentApiKeyPresent` were therefore flattened to `[redacted]` — 161
occurrences in this single run. Those flags carry no secret, only whether one
exists, and they are exactly the signal a causality audit needs. Redaction now
preserves booleans and nulls under a private key and still redacts everything
that can hold a credential.

## Attribution gaps closed by the live run

The live traces could not answer two questions they should have. Both are now
answerable from the log alone.

**Why a serving view was invalidated.** The event carried only a workspace id,
so a burst of 43 invalidations in one second across six workspaces could only be
attributed by correlating timestamps against a different process's trace by
hand. `invalidateActiveRuntimeSkillView()` now takes a reason and records it,
along with the generation it produced and whether a cached view actually existed.
The reason is typed, so a new call site must choose one rather than silently
inheriting a default. Every existing call site is tagged: activate, provision,
config patch, import, enabled-state, materialization, removal, restore, and
user-global skills.

**What the discarded work cost.** Candidate preparation and skill resolution
walk every skill tree, and roughly six of seven candidates are never promoted.
Neither event reported a duration, so the price of that discarded work could not
be read from the log. Both now record `durationMs`, and preparation records the
generation it was validating against, which pairs it with the invalidation that
superseded it.

**Which send a proxy event belongs to.** Orchestrator proxy events, including
`proxy-engine-not-running`, recorded `traceId: null`, because the app's OpenCode
client never sent the correlation header the orchestrator already reads. The
client now attaches the active send trace id on both of its fetch paths, and an
explicit header from the caller still wins. The id is only set for the duration
of a send, so background traffic does not inherit a stale one.

## What the instrumentation then showed

A second live run exercised the new fields and settled three open questions.

**The discarded work is cheap.** Candidate preparation measured 4–6 ms and
resolution 1–11 ms, totalling 15 ms across three preparations that were all
discarded. The concern that extending the fingerprint to walk nested skill files
had made a mostly-wasted path expensive does not hold at this workspace scale.
The 85% discard rate is not, on this evidence, worth redesigning the
candidate/serving split over.

**The invalidation burst deletes nothing.** Every invalidation in the run
reported `hadCachedView: false`. The churn is not dropping warm views; it is
repeatedly invalidating an already-cold cache. That reframes it from a
correctness concern to a cheap redundancy.

**The typed reason found call sites the first pass missed.** Four of eleven
invalidations still reported `unspecified`, which located three untagged callers
that a grep over the route modules had not: candidate preparation, the source
watcher, and the orchestrator reporting `skill_view_changed`. All three are now
tagged, and they are the most diagnostically interesting of the set. This is the
argument for the union type over a free-form string.

**Send correlation now spans all three processes.** One send resolved to 235
correlated events — 175 UI, 39 server, 21 orchestrator — where the orchestrator
side was previously zero.

The remaining `traceId: null` entries turned out to be correct rather than a
gap: every uncorrelated `proxy-engine-not-running` and `proxy-engine-starting`
event was a `GET` that declined to start an engine. Those are background reads,
not sends, so they have no send to belong to. The originally cited symptom was
therefore partly a misread of the trace; the correlation that was genuinely
missing is on the send path, and that is the part now covered.

## Open investigation: renderer main-thread stalls

The same run showed 55 seconds of cumulative main-thread stall across 17 events
in roughly 100 seconds of wall clock, the worst single stall being 14.4 seconds.
This is the dominant performance signal in the trace and is not addressed by
this fix; what follows is the narrowing done so far.

Ruled out by the existing payload fields:

- **Not a suspended window.** Every stall reported `documentVisibility:
  "visible"`, and 13 of 17 also had focus. The renderer was blocked while the
  user was looking at it.
- **Not render volume.** Stalls occurred with 0–2 messages, 1–4 parts, and 1–3
  rendered messages. An 11.2-second stall happened with two messages.
- **Not streaming.** Eleven of the 17 stalls occurred while the session was
  `idle`; only four were `running`.
- **Not the trace pipeline.** The whole UI trace for the run is 366 KB across
  777 events, averaging 471 bytes with no entry above 4 KB, and the native
  bridge call is fire-and-forget. Sanitization cost is not a plausible cause at
  that size.
- **Not slow backends.** The 20-second transcript projection and the
  20-second runtime authorization prime both bracket the stalls: the server
  settled its side of the projection in 15 ms, and the same auth prime took
  620 ms earlier in the same run. Both are victims of the starved loop, not
  causes.

What the trace could not answer is what ran during the stall, because a blocked
renderer emits nothing — there is a 14.5-second hole in the UI trace with no
events at all.

The lag detector now also observes `longtask` entries, which the platform
buffers and delivers once the loop frees up. Each stall report carries the
count, total, maximum, and three longest tasks seen since the previous tick.

### What the long-task data established

The captured run answered the shape question decisively. Every stall is **one
contiguous synchronous task**, never a flood: 13 tasks of 0.9–10.9 seconds,
all reported as `name: "self"`, meaning same-frame script. Between roughly 58 s
and 118 s of the session the tasks run back to back and occupy about 72% of the
wall clock — the renderer is not intermittently busy, it is saturated.

Eliminated with evidence from the same run:

- **Render volume** — stalls occur with 0–2 messages and 1–3 rendered.
- **DOM mutations** — the observer's largest batch is 66 records.
- **SSE volume** — only 12 stream/delivery events fall inside the 44-second
  blocked window.
- **Trace pipeline** — 777 events averaging 471 bytes, none above 4 KB, and the
  native bridge call is fire-and-forget.
- **Config size** — the managed config compared at each sync is 1.8 KB.
- **Regex backtracking** — the path-redaction pattern has nested quantifiers, so
  it was tested directly against adversarial inputs and does not backtrack.
- **`localStorage`** — every write on these paths is a small preference value.
- **Slow backends** — the 18.8-second workspace list, the 20-second transcript
  projection, and the 20-second authorization prime are all wall-clock
  measurements spanning the stalls. The server settled its side of the
  projection in 15 ms, and the same prime took 620 ms earlier in the run.

Statistically, the event most often immediately preceding a long task is the
settle of a single-flight helper: managed-AI config sync in seven of nine cases
and conversation workspace registration in six. That is a boundary, not a cause;
the work happens in a continuation the trace does not cover.

### Why the trace cannot finish this

A blocked renderer emits nothing, so the blocked windows are holes. Long-task
timing gives duration but no script attribution for same-frame work. Every
input the app handles at those moments has been measured and is small, which
rules out data volume as the explanation and points at something the trace
cannot see.

### The profile named it, and disproved the first answer

A DevTools capture showed every long task to be a `RunMicrotasks` drain, with
500 continuations entering through `lib/veslo-server/request-broker.ts`. The
obvious reading was that the broker's per-caller `structuredClone` turned a
coalesced fan-out into O(callers x payload) of synchronous work, and that is
what an earlier revision of this document claimed.

Instrumenting the broker disproved it. Across a captured run the clone cost was
**20 ms against 10,319 ms of stalled time — 0.2%**. One stall of 3.9 seconds
carried 128 clones costing 2 ms. Cloning is not the cost, and the attempt to
make isolation opt-in was reverted for a second reason: an existing test
specifies per-caller isolation by mutating one coalesced result and asserting
the other is unaffected.

What the broker delta did establish is that coalesced caller count tracks stall
duration: 124 coalesced callers with a 3.9 s stall, 65 with 1.4 s, 50 with
1.7 s, 7 with 0.24 s. The fan-out was real; the cost was in what those callers
did after resuming, not in the broker.

### The actual cause

Sampled CPU profile self time, aggregated per function, is unambiguous:

```text
3830 ms  normalizeDirectoryQueryPath      utils/paths.ts
1520 ms  browserPlatformFlags             utils/paths.ts
 602 ms  formatSessionTimestampTooltip    workspace-session-list-model.ts
 383 ms  encodeKeyPart                    ui-conversation-scope.ts
 176 ms  normalizeDirectoryPathForPlatform utils/paths.ts
```

Path normalization alone accounts for more main-thread time than everything
else in the profile combined. The call chains place it in the sidebar session
list, reached several times per row per render:

- `archiveKeyForRow` -> `sidebarSessionOpenTargetForRow` -> `rootForWorkspace`
- `buildFlatSessionRow` -> `rowKeyForSession`
- `isPrivateProjectRoot` -> `isPrivateWorkspacePath` -> `isPrivateWorkspacePathForRoot`
- `archiveKeyFor` -> `buildArchivedSidebarSessionKey`

Each of those ends in `normalizeDirectoryPath`, which runs six regular
expressions and a platform lookup. Multiplied by rows and by every re-render the
sidebar performs, it saturates the main thread — which is why the stalls scale
with row and caller counts rather than with message counts, and why they occur
while the session is idle.

`normalizeDirectoryQueryPath` and `normalizeDirectoryPathForPlatform` are now
memoized. Both are pure and deterministic over a small key space — workspace
roots and session directories — so a bounded cache collapses the repeated work
to one computation per distinct path. The platform flag is part of the
platform-dependent key so a cached value can never be served for the wrong
platform, and the cache is cleared wholesale rather than evicted per entry
because these keys are stable for a session.

Four hot paths were fixed, all of them the same shape: expensive work repeated
per sidebar row per render over a small set of distinct inputs.

- `normalizeDirectoryPath` memoizes on its raw input, so a repeat skips the
  platform lookup and both normalization steps. Memoizing only the inner helper
  was not enough: the platform flag is resolved by the caller, which is where
  `browserPlatformFlags` was spending 1.5 s.
- `normalizeDirectoryQueryPath` and `normalizeDirectoryPathForPlatform` memoize
  their own results, the latter keyed by platform so a cached value can never be
  served for the wrong one.
- `formatSessionTimestampTooltip` builds one `Intl.DateTimeFormat` per locale
  instead of one per call. Almost all of its 602 ms was constructor cost.
- `encodeKeyPart` memoizes its encoding. Each conversation key encodes six or
  seven parts drawn from a small stable set of ids and roots.

A micro-benchmark on realistic path inputs puts the normalization change at
roughly 31x (155 ms to 5 ms over 200k calls).

### Measured result

A follow-up capture with the same workload:

```text
                     before     after
stalls                   22         7
total stalled time    46.6 s     3.6 s
worst single stall    13.7 s    0.79 s
max coalesced callers   124        18
```

All four hot functions left the profile entirely. The new top entry is `fetch`
at 674 ms — actual network — followed by framework and DOM work in the low
hundreds of milliseconds. No application function costs seconds any more.

### Rows kept their identity

What remained was rendering rather than repeated computation: inside the worst
surviving frame, `cleanNode` led at 60.8 ms, ahead of `setAttribute`,
`mergeProps`, `insertBefore`, and `cloneNode`. In Solid, `cleanNode` dominating
means reactive nodes are being disposed and rebuilt.

The cause is that `buildHierarchicalRows` emits every row through a spread, so
each recomputation produced fresh objects. `<For>` reconciles on referential
identity, so unchanged rows were torn down and recreated along with their DOM.
Caching earlier in the pipeline would not have helped, because the emit step
allocates regardless.

Emitted rows are now compared against the previous emission for the same key and
the earlier object is reused when nothing changed. `workspace` and `session` are
compared by reference, since upstream stores already replace them on change;
every other field is a primitive.

The contract was written as tests first: unchanged sessions keep their row
object, only a changed session is rebuilt, a removed session does not resurrect,
and reuse is scoped to the workspace that produced it. Two of the four failed
before the change and pass after it.

### The fan-out had its own defect

The 500-way fan-out was not the transport's doing. `refreshAndPoll` on the
server queue projection controller started a fetch on every invocation:
its polling loop was guarded by a timer, but the immediate refresh path had no
guard at all. Reactive effects on the session page fire it in bursts, so a burst
became a burst of concurrent fetches. The broker coalesced them into one
request, which hid the duplicate network call but not the per-caller
continuation work — and that work is what had to be paid, all in one microtask
drain.

`refresh` is now single-flight per scope: a caller arriving while a refresh is
in flight for the same scope joins it. Different conversations remain
independent, and the entry is released on settle so a later refresh is genuinely
new.

## Validation

```powershell
bun test packages/server/src/tests/lifecycle-error-mapping.test.ts
bun test packages/orchestrator/src/tests/directory-skill-view-lifecycle.test.ts
pnpm --filter @neatech/veslo-ui exec tsx --test src/app/tests/context/workspace-skill-materialization-sync.test.ts src/app/tests/context/conversation-service.test.ts
bun test packages/orchestrator/src/tests/
bun test packages/server/src/tests/
pnpm --filter veslo-server exec tsc --noEmit
pnpm --filter veslo-orchestrator exec tsc --noEmit
pnpm --filter @neatech/veslo-ui exec tsc --noEmit
pnpm --filter veslo-server build:bin
pnpm --filter veslo-orchestrator build:bin
```

Results from this implementation pass:

- New focused coverage: 5 lifecycle error mapping tests, 4 directory lifecycle
  retirement tests, 3 runtime binding identity tests, and 1 supersession race
  test. All passed.
- Orchestrator suite `318/318` passed.
- Server suite `1030` passed, `13` skipped, `2` failed. Both failures are
  pre-existing in the stale active run integration file and were confirmed
  against a stash of this change; one additional materialization test is flaky
  under full-suite load and passes in isolation.
- App unit suite `72` failures with this change against `75` without it,
  measured by stashing only the source files touched here. This change
  introduces no regressions; the three-test difference is the new coverage
  added by it. The larger pre-existing failure count belongs to in-flight send
  path work outside this fix.
- Server, orchestrator, app, and Den TypeScript validation passed.
- Desktop Rust: `307/307` tests passed with no dead-code warnings remaining,
  including new coverage that presence flags survive redaction while credential
  values do not.
- Both sidecar binaries rebuilt successfully.

After the review round, re-measured across the whole change set:

- Orchestrator `321/321`, Den boundary `4/4`, app trace sanitizer `5/5`.
- Server `1029` passed, `13` skipped, `3` failed — the same pre-existing stale
  active run failures plus the load-dependent materialization flake.
- App unit suite `2914` passed and `72` failed, unchanged from before these
  follow-ups while the suite grew by five tests. No regressions.

After closing the attribution gaps:

- Server `1032` passed, `13` skipped, `3` failed — the same pre-existing set.
- App `2916` passed and `72` failed, again unchanged while the suite grew by two.
- Server and app typechecks passed; the server binary was rebuilt.

## Remaining verification

Observe a real lifecycle failure in the running desktop app and confirm the
  response body carries no upstream body and no orchestrator request path, and
  that the sanitized trace still holds the upstream status, path, and structural
  body summary without body content. This is the one behavior in this fix that changes what leaves the
process, and unit coverage cannot substitute for seeing it on the wire. This
manual evidence is intentionally not claimed here.
