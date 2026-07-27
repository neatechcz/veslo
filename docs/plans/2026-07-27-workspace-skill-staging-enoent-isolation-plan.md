# Workspace skill staging ENOENT and global-skill isolation plan

## Status

Implementation in progress, corrected against the live `veslo-main` runtime on
2026-07-27. Focused orchestrator changes are now present in the working tree;
manual dev-runtime validation remains outstanding.

Target repository: `C:\Users\jajse\Desktop\projekty\veslo-main`

Out of scope: sibling Veslo checkouts, OpenCode upstream changes, unrelated
transcript/lifecycle issues, Tauri Pilot, installed-build validation, and E2E
automation. Final validation will use focused tests plus a manual dev-runtime
run.

## Decision

Treat every staged skill generation as an immutable, leased launch input.
Only a server-authorized workspace source may enter that generation. A
generation remains on disk until the OpenCode child that received its concrete
path has exited or the owner is positively known to be dead.

This fixes the current ENOENT class without widening the active skill surface
or turning global discovery back on.

## Problem

Installed Veslo can fail workspace activation with an error equivalent to:

```text
ENOENT: no such file or directory, copyfile ...\skill-staging\generations\...\veslo-docx\...\shared-customXmlSchemaProperties.xsd
```

The canonical `veslo-docx` source asset exists in the repository and the
package builder recursively includes its files. The failure therefore suggests
a stale, partial, or concurrently removed runtime copy rather than a missing
canonical XSD asset.

The literal incident path is still a hypothesis, not a fully reproduced causal
chain. The normal pooled path already rejects a lexical source outside its
workspace. Runtime diagnostics must distinguish a legacy manifest, legacy
sidecar, workspace placement under that tree, migration, or another launch
route rather than assuming one cause.

The current orchestrator accepts a manifest entry when its `SKILL.md` exists
and its path appears to be inside the workspace. It does not verify that the
physical path belongs to an allowed workspace skill root, and it does not
reject a path under `skill-staging/generations`. It then recursively copies
that directory. A missing nested file can consequently surface as a raw
`copyfile` `ENOENT` and become a generic `502 engine spawn failed`.

## Skill source contract

### Workspace-local automatic skills

The active runtime manifest is produced by the Veslo server from the selected
registered workspace. Its server-authorized workspace source roots are:

- `<workspace>/.opencode/skills`
- `<workspace>/.claude/skills`
- `<workspace>/.agents/skills`
- `<workspace>/.agent/skills`

The `.claude/skills` root is intentionally supported as a workspace
compatibility source. A skill physically stored in the selected workspace is
therefore a workspace-local input, even if another tool created it.

The workspace boundary is explicit. The server does not walk into a parent
repository or the user's home directory merely because the workspace is
nested there.

This reflects current live behavior. Older import-only planning that described
`.agents/skills` and `.agent/skills` as inactive is historical and must not
be used as the implementation contract for this work.

### Global skills

The server knows about global discovery roots for management and explicit
import flows, including:

- `~/.config/opencode/skills` and configured `XDG_CONFIG_HOME/opencode/skills`
- `~/.claude/skills`
- `~/.agents/skills`
- `~/.agent/skills`

These global roots are not active engine roots. Active runtime resolution uses
`includeGlobal: false`, and the engine receives a Veslo-owned staged view
derived from the workspace manifest.

`%LOCALAPPDATA%/.claude` is not one of the default global roots. More
importantly, even a discovered global Claude/OpenCode root must not become
engine-visible merely because it exists. It can only enter the runtime after
an explicit Veslo import/materialization flow projects it into a workspace
root.

The only deliberate exception is a `.claude/skills` directory inside the
selected workspace, which is treated as workspace-local under the compatibility
contract above.

### Engine configuration boundary

Workspace OpenCode configuration is mirrored into the per-engine config
directory with raw `skills` paths removed. The orchestrator then injects only
the generated Veslo staging path into `OPENCODE_CONFIG_CONTENT`. The launch
profile also disables native external-skill and project-config discovery. The
implementation and tests must preserve all three protections; sanitizing
`opencode.json(c)` alone is not sufficient.

## Confirmed codebase mismatches

1. **Manifest source validation is too broad.** The orchestrator validates
   workspace containment but not membership in the four authorized source
   roots. Physical symlinks are not resolved before validation either.

2. **Staging generations are mutable shared state.** Generation creation,
   `current.json` publication, and cleanup have no cross-process lock. The
   same-process engine pool has single-flight protection, but two orchestrator
   processes can still touch the same config directory.

3. **Retention is unsafe even for one process.** Cleanup keeps a recent count
   and the latest pointer, but a launched engine receives a concrete generation
   path. `current.json` is not read by the launch path and cannot prove which
   generations live OpenCode children still use.

4. **Legacy config migration copies an entire runtime directory.** The
   subsequent config mirror and managed-dependency setup rebuild all current
   runtime inputs, while an unrestricted copy can preserve stale staging and
   unknown artifacts.

5. **The current focused tests do not cover the failure contract.** They prove
   ordinary staging and single-process serialization, but not physical-root
   admission, cross-process ownership, live-generation leases, failed
   recursive copies, or no-copy legacy migration.

6. **The exact incident path needs runtime confirmation.** Under the normal
   pooled path, a config-directory path outside the registered workspace
   should be rejected by the current containment check. If the reported path
   is literal, the installed runtime may involve a legacy manifest, a legacy
   sidecar, a workspace located inside that tree, migration, or another
   launch path. The fix must log the resolved `skillWorkspace`, `configDir`,
   `sourcePath`, orchestrator version, and PID to distinguish these cases.

## Implementation

### Phase 1: harden manifest admission

- Add a staging admission helper with the same canonical skill-name grammar as
  the server (kebab-case, 1-64 characters). Do not introduce a weaker ad-hoc
  separator or dot check. Keep the grammar covered by a shared contract test
  so server and orchestrator cannot drift.
- Resolve the selected workspace, every existing authorized root, the manifest
  entrypoint, and its containing skill directory with physical paths before
  admission. A missing path, inaccessible path, or physical escape is an
  invalid entry.
- Admit an entry only when its physical `SKILL.md` and containing skill
  directory are descendants of the physical path of one of the four
  server-authorized workspace roots. A root that does not exist authorizes
  nothing.
- Require the expected manifest schema, a valid source classification, the
  canonical `SKILL.md` entrypoint, and the existing revision match before
  `cp()` begins.
- Classify rejected entries without copying them:
  `outside_authorized_root`, `symlink_escape`, `invalid_name`,
  `missing_source`, `invalid_manifest`, or `revision_mismatch`. Surface
  the classification only through redacted diagnostics and the existing
  suppression model.

Result: a stale entry pointing at `skill-staging/generations` or any global
root cannot be copied into a new engine view.

### Phase 2: make staging process-safe

Allocate a new `engineOwnerId` and a distinct staging-operation token before
staging begins. The engine pool must preserve that owner id through spawn so a
generation can be bound before its OpenCode child receives the generation path.

For every staging root:

1. Atomically create a lock directory and write owner metadata containing a
   random fencing token, orchestrator-process instance id, PID, process start
   identity, staging-operation id, and heartbeat timestamp.
2. Create a private generation named with the operation id, not PID alone.
   Persist a generation record with state `preparing`, then `ready`, and the
   intended `engineOwnerId`.
3. Copy selected skills, validate the copied tree and staging manifest, then
   atomically mark the generation `ready`. `current.json`, if retained for
   diagnostics, may point only to a ready generation and is never a liveness
   or cleanup authority.
4. Spawn OpenCode using that immutable generation path. On successful child
   creation, record its PID and bind the lease to the same `engineOwnerId`.
   On spawn failure, release and remove only that operation's unconsumed
   generation.
5. Release the lease from the existing child-exit/intentional-stop path. A
   later cleanup may remove only generations in `released` state, or orphaned
   generations whose owner process and child have both been positively proved
   dead after a grace period.

The lock holder may mutate the lock, pointer, or its own generation only when
its fencing token still matches. Never steal a lock merely because its age
exceeds a timeout. Stale recovery first proves the recorded process instance
is gone; if that cannot be established, return a bounded retryable lock-busy
result and leave the owner untouched. This prevents a paused but living Windows
process from losing its lock.

Cleanup runs under the same lock and is lease-based, not count-based. It may
compact released generations, but must never delete an active generation just
because it belongs to another process or because it is older than the current
pointer. Orphan recovery must retain generation metadata long enough to avoid
PID-reuse mistakes.

### Phase 3: stop migrating staging state

Replace the whole-tree legacy config migration with detection-only migration:

- when a legacy workspace config directory exists, record its legacy identity
  and the fact that it was intentionally not imported;
- create the new per-workspace config directory fresh;
- let the existing config mirror rebuild sanitized `opencode.json(c)`, project
  runtime directories, and `AGENTS.md` from the current workspace;
- let the managed-dependency setup recreate tools, package metadata, and
  managed dependencies;
- never copy `skill-staging`, `generations`, `current.json`, lock
  directories, node modules, tools, or any unrecognized subtree;
- leave the legacy directory untouched. Its removal is a separately authorized
  maintenance task, never part of activation.

The current config directory is a generated runtime cache, not a durable
user-config source. This avoids an exclusion list that can miss a newly added
runtime artifact.

### Phase 4: observability and failure behavior

- On a source disappearing or changing during copy, remove the private
  generation, release only the matching lock token, and return a documented
  retryable `409 skill_view_changed` result. It contains workspace identity and
  observed revision, never absolute source paths.
- The server invalidates and rebuilds the active skill view before retrying;
  the retried launch must carry a new effective revision. Do not retry the
  same manifest revision in a loop.
- Emit sanitized diagnostics for process instance, staging-operation id,
  engine owner id, manifest revision, source-root kind, rejection reason,
  generation state, and lock state. Development diagnostics may include an
  explicitly classified path; production-safe logs must not expose raw local
  paths.
- Preserve the existing revision handshake and fail closed if no valid
  effective manifest is available.

### Phase 5: durable documentation

After implementation, update the canonical OpenCode workspace-runtime and
state/config references with the four-root active contract, launch closure,
generation lease lifecycle, no-copy migration behavior, and the retry result.
Mark conflicting import-only planning as historical rather than silently
leaving two active-looking contracts.

## Verification

### Implemented in the current working tree

- workspace-root admission now covers the four server-authorized roots and
  rejects physical escapes, global/staging paths, invalid names, and invalid
  manifest entries before recursive copy;
- staging uses an atomic cross-process lock, immutable generation records, and
  an engine-owner lease carried through pooled/shared child spawn;
- legacy config migration is detection-only and leaves the old runtime tree
  untouched;
- source disappearance during recursive copy is classified as
  `skill_view_changed` and mapped to a retryable 409;
- focused staging, migration, engine-pool, shared-engine, and orchestrator
  typecheck lanes pass.

The implementation is not complete until the remaining focused failure/owner
cases and the manual dev-runtime run below are checked.

Focused tests should prove:

- all four workspace roots are admitted and a global root is never an active
  engine input;
- entries under staging, AppData/global paths, and physical symlink/junction
  escapes are suppressed before `cp()`;
- server and orchestrator accept and reject the same skill-name grammar;
- a deliberately injected mid-copy `ENOENT` leaves no ready generation or
  published pointer and produces the typed retryable result;
- two independent orchestrator processes sharing one staging root cannot
  overlap a fenced mutation or steal a live lock; dead-owner recovery works;
- cleanup retains a generation leased to a live child, including another
  process's child, and removes it only after release or proven orphan recovery;
- legacy migration copies no runtime tree, preserves the old directory, and
  the fresh target is completely rebuilt by current config/dependency setup;
- the canonical `veslo-docx` package still contains the XSD asset.

Final acceptance is a manual dev-runtime run with the previously failing
`veslo-docx` skill: activate the workspace, start an agent run, and inspect
the diagnostic stream. It must show an authorized workspace source root, a
bound generation and engine owner, no global-root source, no `copyfile ENOENT`,
and a healthy OpenCode engine. Installed-build verification can be a separate
release-confidence task after this contract is proven in development.

## Non-goals

- Do not remove workspace `.claude/skills` support without a separate product
  decision.
- Do not make raw global skills automatically available to the engine.
- Do not solve this by copying all global roots into every workspace.
- Do not use `current.json` as a substitute for engine-generation ownership.
- Do not delete legacy config directories during activation.
- Do not treat the unrelated release diagnostic-capture diff as part of this
  fix.
