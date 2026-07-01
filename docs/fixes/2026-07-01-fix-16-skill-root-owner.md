# Fix 16: Skill Root Owner

## Problem

Skill filesystem root ownership was split across listing, materialization,
mutation, delete, restore, and user-global store code.

The concrete bug class was:

```text
write-side root != read-side root
```

Personal-global managed skills could be materialized under:

```text
XDG_CONFIG_HOME/opencode/skills/veslo-managed
```

while global skill listing could still read only the HOME fallback root:

```text
HOME/.config/opencode/skills
```

That made core platform skills such as `veslo-docx` exist on disk but disappear
from server/app skill inventory in XDG-based environments.

## Fix

- Added `packages/server/src/skill-roots.ts` as the narrow server-side owner for
  skill root path contracts.
- Moved the shared skill entrypoint, workspace skill root, user-global root
  chain, managed root derivation, path-inside predicate, and
  `veslo-managed` relative-path predicate behind that owner.
- Made `personalGlobalManagedSkillsRoot()` derive its default from
  `userGlobalSkillRoots()[0]`, so materialization and listing share the same
  source of truth.
- Retargeted server callers in:
  - `packages/server/src/skills.ts`
  - `packages/server/src/skill-materializer.ts`
  - `packages/server/src/skill-packages.ts`
  - `packages/server/src/skill-removal-journal.ts`
  - `packages/server/src/user-skill-store.ts`
  - `packages/server/src/skill-hub.ts`
  - `packages/server/src/routes/skill-materialization.ts`
  - `packages/server/src/routes/skill-removals.ts`
  - `packages/server/src/server.ts`
- Preserved `projectSkillsDir(workspaceRoot)` in `workspace-files.ts` as the
  low-level workspace file helper; the new owner builds skill-specific roots on
  top of it.
- Kept registry, package validation semantics, app UI state, and OpenCode
  runtime behavior out of scope.

## Coverage

- Added `packages/server/src/tests/skill-roots.test.ts`.
- Covered XDG-first user-global roots, HOME fallback de-duping, USERPROFILE
  fallback, workspace chain mutation roots, managed root derivation, and
  `veslo-managed` read-only path classification.
- Follow-up hardening added coverage for whitespace env fallback behavior,
  explicit managed root override trimming, listing/mutation root equivalence,
  workspace root chain output, sibling-prefix path escapes, and negative
  `veslo-managed-*` predicate cases.
- Kept the behavioral regression tests for:
  - XDG materialized `veslo-docx` discovery through `listSkills(... includeGlobal)`.
  - MS Word wording resolving to `veslo-docx`.
- Updated core platform inventory E2E assertions to accept the compatible UI
  scope shapes currently emitted by the app.

## Plan

The implementation plan is closed in:

```text
docs/plans/2026-07-01-skill-root-owner-implementation-plan.md
```

The plan frontmatter is marked:

```yaml
status: implemented
done: true
```

## Verification

```powershell
pnpm --filter veslo-server exec bun test src/tests/skill-roots.test.ts src/tests/skills.test.ts src/tests/skill-materializer.test.ts src/tests/skill-resolver.test.ts
pnpm --filter veslo-server exec bun test src/tests/server.skill-materialization.test.ts src/tests/server.skill-materialization-routes.test.ts src/tests/server.workspace-skills-routes.test.ts src/tests/skill-removal-journal.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/extensions-skill-inventory.test.ts src/app/tests/context/workspace-skill-materialization-sync.test.ts src/app/tests/lib/veslo-server.test.ts src/app/tests/lib/skill-inventory.test.ts
pnpm --filter veslo-server typecheck
git diff --check
```

Result:

- server focused root/skills/materializer/resolver suite passed: `27 pass`,
  `0 fail`
- server materialization/removal route and journal suite passed: `43 pass`,
  `0 fail`
- app focused skill/materialization suite passed: `119 pass`, `0 fail`
- server typecheck passed
- `git diff --check` passed with only Windows LF-to-CRLF warnings

Additional robustness pass:

- `pnpm --filter veslo-server exec bun test src/tests/skill-roots.test.ts`
  passed: `7 pass`, `0 fail`, `29 expect() calls`
- explicit PowerShell-expanded all-server-skill run
  `pnpm --filter veslo-server exec bun test @files` passed: `182 pass`,
  `0 fail`, `697 expect() calls`
- app focused skill/materialization suite passed again: `119 pass`, `0 fail`
- `pnpm --filter veslo-server typecheck` passed

Pilot E2E was attempted twice:

- first run timed out waiting for `[data-testid="skills-page"]`
- second run hit the command timeout

Direct post-run filesystem verification confirmed the core platform skills were
materialized under the XDG OpenCode root with `personal-global`, `platform`, and
`locked` marker metadata, and no legacy internal routing artifacts were found in
the materialized files.

## Status

The server-side root contract fix is complete. The remaining follow-up is an
audit of desktop/Rust-side skill root discovery and environment propagation so
the desktop runtime can be checked against the same root contract without
expanding this server-only fix.
