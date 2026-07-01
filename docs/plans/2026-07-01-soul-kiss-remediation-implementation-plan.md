---
title: Soul KISS Remediation Implementation Plan
date: 2026-07-01
status: implemented
done: true
---

# Soul KISS Remediation Implementation Plan

## Goal

Fix the concrete Soul business-logic failures found in the July 1 audit without
turning Soul into a broad refactor.

The immediate bug classes are:

```text
status contract != materialization contract
app workspace id != server workspace id for active-run protection
pending edit cache != pending edit lifecycle
```

The fix should make the shipped behavior match the documented Soul contract:

- successful Soul materialization must make workspace Soul status read as enabled
- active workspace runs must never receive `.opencode` Soul writes
- offline user pending edits must not survive forever as stale UI state after a
  later successful Den sync

## KISS Boundary

This plan fixes only the causal contracts above.

Do not fold in:

- a new Soul page redesign
- a scheduler or heartbeat rewrite
- a broad `server.ts` route extraction
- Den API schema changes
- manual Soul sync UI
- OpenCode runtime restart behavior
- unrelated skill materialization work

Accept small helper extraction only when it removes duplicated constants or makes
the id-mapping contract testable.

## Existing State

### Runtime Materialization

`packages/server/src/soul-materializer.ts` writes the current managed runtime
shape:

```text
.opencode/soul-company.md
.opencode/soul-user.md
.opencode/soul-workspace.md
.opencode/veslo/soul-manifest.json
opencode.jsonc instructions[]
```

It correctly returns `pending` without writing runtime files when
`workspaceActive === true`.

### Status Reporting

`packages/server/src/server.ts` still reports setup status through legacy
helpers:

```text
resolveSoulMemoryPath() -> .opencode/soul.md
configIncludesSoulInstruction() -> checks .opencode/soul.md
memoryPath -> .opencode/soul.md
```

This makes `/workspace/:id/soul/status` return `enabled: false` after a current
materialization that wrote the new three-file runtime layout.

### App Active-Run Protection

`packages/app/src/app/pages/soul.tsx` derives busy workspace ids from
`busySessionByWorkspaceId`, whose keys are app workspace ids.

Soul mutations and replay then pass those ids through `activeWorkspaceIds` or
`syncWorkspaceSoulMaterialization()`.

The server, however, evaluates active workspaces against server workspace ids.
For remote Veslo workspaces, the app id is a stable local hash and the server id
is stored separately as `vesloWorkspaceId`, so the active-run protection can miss
the active workspace and write `.opencode` files during a running agent session.

### Pending User Edits

`PATCH /soul/user` writes `soul-cache/pending/*.json` when Den is unavailable.
There is currently no delete, flush, or successful-sync cleanup path for these
pending edit files.

As a result, an old offline pending edit can disappear while Den is online and
then reappear as `summary.status = "pending"` during a later Den outage.

## Target Shape

### 1. One Soul Runtime File Contract

Export and share the existing runtime file contract from the materializer
instead of creating a second constant. The current source already exists as
`SOUL_INSTRUCTIONS` in `packages/server/src/soul-materializer.ts`; either export
that value directly or move it unchanged into a tiny `soul-runtime-files.ts`
module used by the materializer.

```ts
export const SOUL_INSTRUCTIONS = [
  ".opencode/soul-company.md",
  ".opencode/soul-user.md",
  ".opencode/soul-workspace.md",
] as const;
```

Use this contract for:

- materializer writes
- materializer instruction updates
- approval paths in `server.ts`
- status instruction detection
- status memory/reporting fields

Avoid reintroducing `.opencode/soul.md` as the main runtime path. If backward
compatibility with old workspaces is required, treat `.opencode/soul.md` only as
a legacy fallback signal, not as the primary contract.

### 2. Server Workspace IDs Before Soul Mutations

Soul UI code must pass server workspace ids to Soul routes.

Use the same mapping rules already used by `createSoulDataStore`:

- local workspace: match server `/workspaces` item by normalized path
- remote Veslo workspace: use `vesloWorkspaceId`, parsed mounted URL id, or
  directory fallback
- non-Veslo remote workspace: skip

Keep the KISS shape narrow:

- extract the pure mapping logic from `soul-data-store.ts`, or
- have the data store expose the current app-id to server-id map for the view

The preferred implementation is a reusable helper under:

```text
packages/app/src/app/lib/soul-workspace-map.ts
```

It should be pure enough to unit test with app workspaces and server workspace
items. Do not add a second independent `/workspaces` cache inside `SoulView`;
that would recreate the split-brain id problem this plan is trying to remove.

`SoulView` should track pending materialization entries with both identities:

```ts
{
  appWorkspaceId: string;
  serverWorkspaceId: string;
}
```

Busy checks use `appWorkspaceId`; server calls use `serverWorkspaceId`.

When a replay is attempted while the workspace is still busy, the request should
send `{ activeRun: true }` or avoid calling sync until idle. Do not rely on id
equality.

### 3. Pending User Edit Lifecycle

Add explicit lifecycle handling for `soul-cache/pending/*.json`.

Minimum KISS behavior:

- when `GET /soul/user` successfully reads Den user Soul, remove pending edits
  for that user if the returned Den document is authoritative
- when `PATCH /soul/user` successfully writes Den user Soul, remove pending
  edits for that user
- when `POST /soul/user/versions/:versionId/restore` successfully writes Den,
  remove pending edits for that user

Do not implement a complex offline merge queue in this pass. If the product
wants replay later, add it deliberately with conflict handling. For now, stale
pending state should not outlive a successful Den read/write sync.

This is an explicit behavior decision for this KISS fix: offline user pending
edits are a local "could not sync" indicator, not a durable replay queue. A
successful Den read/write/restore for the same user is authoritative and clears
older pending indicators.

Add one helper in `soul-cache.ts`:

```ts
export async function clearPendingSoulEdits(input: {
  dataDir?: string;
  scope: SoulScope;
  ownerId: string;
}): Promise<number>
```

Only remove validated pending files for the requested scope and owner.

## Implementation Steps

### Step 1: Fix Status Contract

1. Export/share the existing `SOUL_INSTRUCTIONS` list from
   `soul-materializer.ts` or move it unchanged into a tiny
   `soul-runtime-files.ts` module.
2. Replace the hardcoded `.opencode/soul.md` checks in `server.ts` status
   helpers.
3. Make `configIncludesSoulInstruction()` return true when all or any current
   Soul runtime instruction is configured. Prefer "any current instruction" for
   resilience, but test the intended behavior.
4. Return a status payload that names current runtime files instead of only
   `memoryPath: ".opencode/soul.md"`. Keep the existing field if the API type
   requires it, but set it to the primary current file or add a `memoryPaths`
   field if the type already allows extension.
5. Replace `soulMaterializationApprovalPaths()` hardcoded Soul runtime paths with
   the shared instruction list so approval, status, and materialization cannot
   drift again.
6. Add a server test proving:
   - `PATCH /workspace/:id/soul` materializes current files
   - `GET /workspace/:id/soul/status` returns `enabled: true`
   - `instructionsEnabled: true`

### Step 2: Fix App/Server Workspace ID Mapping

1. Extract or centralize the Soul workspace mapper used by status refresh.
2. Reuse that mapping in both `createSoulDataStore` and `SoulView`, or expose
   the data-store-owned map to `SoulView`. Do not let `SoulView` fetch and cache
   `/workspaces` independently.
3. Add tests for:
   - local path match maps `app-local` -> `ws-local`
   - remote Veslo explicit id maps `app-hash` -> `veslo-remote`
   - mounted URL fallback maps to the parsed server id
   - non-Veslo remote workspaces are skipped
4. Wire `SoulView` to use mapped server workspace ids for:
   - mutation `activeWorkspaceIds`
   - queued pending materialization ids
   - replay sync route ids
5. Keep busy checks against app workspace ids.
6. Add a focused app test that proves a busy remote Veslo workspace sends the
   server id in `activeWorkspaceIds` and does not replay sync as idle while the
   app id is busy.

### Step 3: Make Replay Safe

1. Change pending replay state from `Record<string, true>` to records containing
   app id plus server id.
2. If an entry is busy by app id, do not call sync.
3. If sync is called and the app still has a busy session due to a race, pass
   `activeRun: true`.
4. Ensure `syncWorkspaceSoulMaterialization()` continues to support
   `{ activeRun: true }`; it already serializes that body.
5. Add a regression test covering id mismatch:
   - busy map key: app id
   - pending materialization server id: server id
   - replay must not call sync until app id is idle

### Step 4: Clear Stale Pending User Edits

1. Add `clearPendingSoulEdits()` in `soul-cache.ts`.
2. Call it after successful Den user read/write/restore paths.
3. Keep offline patch behavior unchanged when Den is unavailable.
4. Add a server route test:
   - offline `PATCH /soul/user` creates pending edit
   - online `GET /soul/user` or successful online patch clears it
   - later offline `GET /soul/user` does not resurrect the old pending edit
5. Add a low-level cache test that clear only removes matching scope/owner files.

### Step 5: Verification

Run focused checks first:

```bash
bun test src/tests/soul-cache.test.ts src/tests/soul-materializer.test.ts src/tests/soul-routes.test.ts src/tests/server.soul-routes-registration.test.ts
node --test --import=tsx/esm src/app/tests/pages/soul-data-store.test.ts src/app/pages/soul-layout-contract.test.ts
```

If the app-side behavior lands in Solid controller/view tests, run those with
browser conditions so they are not silently skipped:

```bash
node --conditions=browser --test --import=tsx/esm src/app/tests/pages/soul-controller.test.ts
```

Then run typechecks:

```bash
pnpm --filter veslo-server typecheck
pnpm --filter @neatech/veslo-ui typecheck
```

If the app-side helper gets its own test file, include that file explicitly in
the focused app test command. If that helper is pure and does not need Solid
browser conditions, keep it in the normal `node --test --import=tsx/esm` group.

Finish with:

```bash
git diff --check
```

## Acceptance Criteria

- `/workspace/:id/soul/status` reports enabled/current Soul after the current
  three-file materializer runs.
- No Soul mutation or replay writes workspace `.opencode` Soul files while the
  corresponding app workspace has a busy session, including remote Veslo
  workspaces whose app id differs from server workspace id.
- Pending user edits created during Den outage are cleared after successful Den
  user sync and do not reappear on later offline reads.
- Offline user pending edits are explicitly treated as stale local indicators,
  not as a durable replay queue, until a separate replay/conflict feature is
  intentionally designed.
- Existing Soul materializer conflict protections stay intact.
- No manual sync UI is introduced.

## Test Gaps This Plan Closes

- Status endpoint was not tested against the current materializer output.
- App-side Soul replay was not tested with app/server workspace id mismatch.
- Pending user edits were tested only for persistence, not lifecycle cleanup.

## Progress Log

- 2026-07-01: Implemented shared Soul runtime file contract, current-file status
  reporting, pending user edit cleanup, and app/server workspace id mapping.
- 2026-07-01: Hardened active-run protection to fail closed when a busy app
  workspace cannot be mapped to a server workspace id; global Soul updates send
  `activeRun: true` and server-side materialization remains pending instead of
  writing `.opencode` Soul files.
- 2026-07-01: Verified with focused Soul server/app tests, controller browser
  test, server/app typechecks, and `git diff --check`.

## Rollback Strategy

The changes are narrow and reversible:

- status contract changes are confined to Soul runtime file constants and
  status helpers
- id mapping changes are confined to app Soul mapping/replay code
- pending edit cleanup is confined to `soul-cache.ts` and successful Den paths

If a regression appears, revert the affected slice independently rather than
rolling back the entire Soul feature.
