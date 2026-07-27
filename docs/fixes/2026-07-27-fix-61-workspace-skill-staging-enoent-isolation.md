# Fix 61: Workspace Skill Staging ENOENT Isolation

Date: 2026-07-27

## Scope

Implemented the orchestrator-side hardening for the installed-app failure
where workspace activation could fail with a recursive `copyfile ENOENT` inside
an OpenCode skill-staging generation.

Source plan:

```text
docs/plans/2026-07-27-workspace-skill-staging-enoent-isolation-plan.md
```

E2E, Tauri Pilot, installed-build verification, and the final manual live run
remain separate validation work. They were intentionally not added to this
fix.

## Root cause addressed

The runtime accepted an effective-manifest entry when its path was lexically
inside the workspace and its `SKILL.md` existed. It did not prove physical
membership in an authorized workspace skill root, and staging generations had
no cross-process ownership or liveness contract. A stale, partial, or
concurrently removed recursive source copy could therefore surface as a raw
ENOENT and become a generic engine-spawn failure.

The exact production incident chain is still not claimed as fully reproduced;
this fix closes the unsafe admission and generation-lifetime classes that can
produce it.

## Skill source contract

Active workspace skills are restricted to:

- `<workspace>/.opencode/skills`
- `<workspace>/.claude/skills`
- `<workspace>/.agents/skills`
- `<workspace>/.agent/skills`

The workspace `.claude/skills` root is intentional compatibility behavior. A
skill stored inside the selected workspace is workspace-local regardless of
which tool created it.

Global roots are management/discovery/import sources only. The engine runtime
uses the server's workspace-only effective manifest and does not automatically
consume global OpenCode, Claude, or agent roots. `%LOCALAPPDATA%/.claude` is
not a default global engine source.

OpenCode configuration continues to remove inherited `skills.paths`, inject
only the Veslo-owned staged view, and disable native external/project skill
discovery. These protections are deliberately kept together.

## Implementation

- Manifest admission now validates the canonical kebab-case skill-name grammar,
  supported source classification, canonical `SKILL.md` entrypoint, physical
  workspace containment, authorized source-root membership, and realpath
  symlink/junction boundaries.
- Invalid, missing, global, staging, and physically escaping entries are
  suppressed with classified reasons before recursive copy.
- Staging operations use an atomic filesystem lock in addition to the existing
  in-process single-flight queue. A live owner is never displaced only because
  its lock is old.
- Each generation has `preparing`, `ready`, `leased`, or `released` metadata,
  an operation id, process identity, and engine-owner identity.
- Pooled and shared engine spawn paths carry the same owner id into
  `startOpencode`. The concrete child PID claims the generation before the
  engine is published; child exit releases it. Cleanup is lease-based and has
  conservative orphan recovery.
- Source disappearance during recursive staging is classified as
  `skill_view_changed` and returned through the orchestrator as a retryable
  HTTP 409 rather than a generic 502.
- Legacy workspace config migration is detection-only. The old runtime tree
  remains untouched; the new config directory is rebuilt by the current config
  mirror and managed-dependency setup instead of copying unknown runtime state.

## Documentation

The canonical OpenCode workspace-runtime architecture document now records the
four active workspace roots, global-skill isolation, generation leases, fenced
staging, and detection-only migration behavior.

## Validation

Focused orchestrator validation:

```powershell
pnpm --filter veslo-orchestrator exec bun test src/tests/engine-skill-staging.test.ts src/tests/workspace-runtime-migration.test.ts src/tests/engine-pool.test.ts src/tests/shared-opencode-engine.test.ts
pnpm --filter veslo-orchestrator typecheck
git diff --check
```

Results:

- `68` focused tests passed,
- `190` focused assertions passed,
- orchestrator typecheck passed,
- repository `pnpm check` passed,
- architecture audits passed,
- no E2E or installed-runtime claim is made by this fix.

## Remaining validation

Run the planned manual development scenario with the `veslo-docx` skill and
inspect the diagnostic stream for an authorized source root, a bound generation
and engine owner, no global-root source, and no `copyfile ENOENT`.
