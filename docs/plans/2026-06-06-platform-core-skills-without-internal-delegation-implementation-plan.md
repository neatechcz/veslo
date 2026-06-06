# Platform Core Skills Without Internal Delegation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace Veslo's special internal delegated document/skill workflows with normal platform-wide managed skills that sync after sign-in.

**Architecture:** Remove the local internal delegation provisioning path from both server and desktop workspace bootstrap. Seed the former core workflow packages into the Den skill registry as system/platform skills with locked user-global rollout policies, then rely on the existing registry materialization flow to write them into `veslo-managed` skill roots after sign-in. Existing workspaces get a conservative cleanup pass that removes only Veslo-managed legacy delegation artifacts.

**Tech Stack:** TypeScript/Bun server and Den tests, Rust Tauri workspace provisioning, Veslo skill registry/materialization, WebdriverIO desktop E2E, Markdown skill packages.

---

## Constraints

- Do not keep a bundled offline fallback for DOCX/PDF/PPTX/XLSX/skill-creator core workflows.
- Do not keep `delegate`, hidden `veslo-internal-*` agents, child sessions, or forced routing transforms.
- Do not delete user-authored files unless they are positively identified as Veslo-managed legacy delegation artifacts.
- If `packages/server/src` changes, rebuild the server binary before relying on orchestrator-backed flows.
- For desktop behavior, validate with the real Tauri runtime and `packages/e2e` after the focused unit/server tests pass.

## Task 1: Replace Server Provisioning Expectations

**Files:**
- Modify: `packages/server/src/internal-system.test.ts`

**Step 1: Write failing tests for no internal delegation provisioning**

Replace the current "writes internal packs, hidden agents, managed routing block, and manifest" expectations with a test shaped like:

```ts
test("does not provision internal delegation runtime", async () => {
  const workspaceRoot = await createWorkspaceRoot("no-internal-delegation");

  try {
    await mkdir(join(workspaceRoot, ".opencode", "agents"), { recursive: true });
    await writeFile(
      join(workspaceRoot, ".opencode", "agents", "veslo.md"),
      "---\ndescription: Veslo default agent\nmode: primary\n---\n\nYou are Veslo.\n",
      "utf8",
    );

    const result = await provisionWorkspaceInternalSystem(workspaceRoot);
    expect(result.status).toBe("updated");

    await expect(access(join(workspaceRoot, ".opencode", "veslo", "internal"))).rejects.toThrow();
    await expect(access(join(workspaceRoot, ".opencode", "plugins", "veslo-delegate.js"))).rejects.toThrow();
    await expect(access(join(workspaceRoot, ".opencode", "agents", "veslo-internal-docx.md"))).rejects.toThrow();

    const vesloAgent = await readFile(join(workspaceRoot, ".opencode", "agents", "veslo.md"), "utf8");
    expect(vesloAgent).not.toContain("VESLO_INTERNAL_ROUTING_START");
    expect(vesloAgent).not.toContain("delegate");
    expect(vesloAgent).toContain("VESLO_AGENT_INSTRUCTIONS_START");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
```

**Step 2: Write failing tests for managed legacy cleanup**

Add a test that pre-creates:

- `.opencode/veslo/internal/manifest.json`
- `.opencode/veslo/internal/docx/SKILL.md`
- `.opencode/agents/veslo-internal-docx.md`
- `.opencode/plugins/veslo-delegate.js`
- a `VESLO_INTERNAL_ROUTING_START` block inside `.opencode/agents/veslo.md`

Expected after provisioning:

- the managed internal directory is gone
- managed internal agent files are gone
- the delegate plugin is gone
- the routing block is gone
- unrelated user content in `veslo.md` remains

**Step 3: Write failing test for ambiguous user-owned preservation**

Create files with similar names but no managed manifest, for example:

- `.opencode/agents/veslo-internal-custom.md`
- `.opencode/plugins/veslo-delegate.js` with content that does not contain the managed header

Expected: provisioning leaves them in place and does not rewrite them.

**Step 4: Run server test and verify failure**

Run:

```bash
pnpm --filter veslo-server test internal-system.test.ts
```

Expected: FAIL because provisioning still writes internal packs, agents, plugin, and routing instructions.

**Step 5: Commit after implementation passes**

Do not commit yet. Commit in Task 2 after the implementation makes these tests pass.

## Task 2: Simplify Server Internal System Provisioning

**Files:**
- Modify: `packages/server/src/internal-system.ts`
- Modify: `packages/server/src/internal-system.test.ts`

**Step 1: Remove server-side internal delegation creation**

In `packages/server/src/internal-system.ts`:

- remove `INTERNAL_PACKS`, `INTERNAL_AGENT_FILES`, and `DELEGATE_PLUGIN_FILE` usage for runtime provisioning
- remove or stop calling `provisionCentralPacks`
- remove or stop calling `copyInternalPacks`
- remove or stop calling `writeInternalAgents`
- remove or stop calling `writeDelegatePlugin`
- remove the `delegatePluginSource()` runtime output
- keep `ensureWorkspaceInstructions()`
- keep non-delegation agent instructions

**Step 2: Add managed legacy cleanup helpers**

Add narrow cleanup helpers:

```ts
const LEGACY_INTERNAL_AGENT_FILES = [
  "veslo-internal-docx.md",
  "veslo-internal-pdf.md",
  "veslo-internal-pptx.md",
  "veslo-internal-xlsx.md",
  "veslo-internal-skill-creator.md",
  "veslo-internal-research.md",
] as const;

function removeManagedBlock(existing: string, startMarker: string, endMarker: string): string {
  const start = existing.indexOf(startMarker);
  if (start < 0) return existing;
  const end = existing.indexOf(endMarker, start);
  if (end < 0) return existing;
  const before = existing.slice(0, start).replace(/\n+$/g, "");
  const after = existing.slice(end + endMarker.length).replace(/^\n+/g, "");
  return [before, after].filter(Boolean).join("\n\n") + "\n";
}
```

Implement cleanup rules:

- remove `.opencode/veslo/internal` only when `manifest.json` parses and has `source` equal to the known managed source or includes legacy internal agents/plugins
- remove legacy internal agent files only when the file content contains `mode: subagent`, `hidden: true`, and `Veslo internal`
- remove `.opencode/plugins/veslo-delegate.js` only when the file contains `Veslo Delegate Plugin` and `Managed by Veslo internal system`
- remove the routing block by marker regardless of version

**Step 3: Rewrite managed agent instructions without delegate language**

Keep `VESLO_AGENT_INSTRUCTIONS_START` for response/output/soul guidance, but change the tools section from delegate-specific language to standard skills language:

```md
### Veslo Tools & Features
- **Skills** - reusable workflows distributed through user, workspace, organization, and platform skill roots.
- **Scheduler** - recurring tasks (daily, weekly, interval). Mention when a task could be automated.
- **Workspace** - user may have multiple workspaces; respect workspace boundaries.
```

Do not mention `delegate`, hidden subagents, or internal agents.

**Step 4: Update idempotency expectations**

Adjust tests so the second provisioning run returns `unchanged` and no removed artifact reappears.

**Step 5: Run focused server tests**

Run:

```bash
pnpm --filter veslo-server test internal-system.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add packages/server/src/internal-system.ts packages/server/src/internal-system.test.ts
git commit -m "fix: remove server internal delegation provisioning"
```

## Task 3: Remove Desktop Provisioning Of Internal Delegation

**Files:**
- Modify: `packages/desktop/src-tauri/src/workspace/internal_provision.rs`
- Modify: `packages/desktop/src-tauri/Cargo.toml`
- Modify: `packages/desktop/src-tauri/Cargo.lock` if dependency resolution changes

**Step 1: Write failing Rust tests**

Update the existing `internal_provision` tests to assert:

- `provision_internal_workspace_assets()` does not create `.opencode/veslo/internal`
- it does not create `.opencode/plugins/veslo-delegate.js`
- it does not create `veslo-internal-*.md`
- it removes managed legacy artifacts when the manifest/header proves ownership
- it preserves ambiguous user-owned files
- `veslo.md` keeps user content and no longer contains `VESLO_INTERNAL_ROUTING_START` or `delegate`

**Step 2: Run Rust test and verify failure**

Run:

```bash
cd packages/desktop
cargo test internal_provision --manifest-path src-tauri/Cargo.toml
```

Expected: FAIL because Rust provisioning still writes the old internal runtime.

**Step 3: Simplify Rust provisioning**

In `internal_provision.rs`:

- remove `include_dir` usage for `internal/veslo-internal-packs`
- remove central pack provisioning and symlink/copy logic
- remove internal agent document generation
- remove delegate plugin generation
- keep agent instruction upsert without delegation language
- add cleanup helpers that mirror the TypeScript ownership rules
- keep `ProvisionResult::version()` as a provisioning/migration version, not an internal pack version

If `include_dir` is no longer used anywhere else, remove it from `packages/desktop/src-tauri/Cargo.toml` and update `Cargo.lock`.

**Step 4: Keep workspace creation callers stable**

`packages/desktop/src-tauri/src/workspace/files.rs` currently calls:

```rust
provision_central_packs(dir)
provision_internal_workspace_assets(&root, central_packs_dir.as_deref())
ProvisionResult::version()
```

Either:

- keep compatibility function names as no-op cleanup/provision wrappers, or
- rename them and update all callers in the same task.

Prefer compatibility wrappers for a smaller diff.

**Step 5: Run Rust tests**

Run:

```bash
cd packages/desktop
cargo test internal_provision --manifest-path src-tauri/Cargo.toml
```

Expected: PASS.

**Step 6: Commit**

```bash
git add packages/desktop/src-tauri/src/workspace/internal_provision.rs packages/desktop/src-tauri/Cargo.toml packages/desktop/src-tauri/Cargo.lock
git commit -m "fix: remove desktop internal delegation provisioning"
```

## Task 4: Add Den Core Platform Skill Packages

**Files:**
- Create: `services/den/src/skills/core-platform-skills.ts`
- Create: `services/den/test/core-platform-skills.test.ts`

**Step 1: Write failing package tests**

Tests should assert the exported core platform skill definitions include:

- `veslo-docx`
- `veslo-pdf`
- `veslo-pptx`
- `veslo-xlsx`
- `skill-creator`

Each package must:

- validate through `buildSkillRegistryPackageArchive()` / package decode helpers
- contain `SKILL.md`
- use `scope: "system"` at publish time
- target `user-global`
- use `removalPolicy: "locked"`
- not contain `veslo_internal_pack`
- not mention `delegate`, `subagent`, or `.opencode/veslo/internal`

Run:

```bash
pnpm --filter @neatech/den exec tsx --test test/core-platform-skills.test.ts
```

Expected: FAIL because the definitions do not exist.

**Step 2: Implement package definitions**

Create definitions shaped like:

```ts
export type CorePlatformSkillDefinition = {
  name: string;
  displayName: string;
  description: string;
  removalPolicy: "locked";
  rolloutTarget: "user-global";
  rolloutAudience: "all-platform-users";
  files: Array<{ path: string; text: string; mediaType?: string }>;
};

export const CORE_PLATFORM_SKILLS: CorePlatformSkillDefinition[] = [
  {
    name: "veslo-docx",
    displayName: "Veslo DOCX",
    description: "Author, edit, inspect, and validate Word DOCX documents.",
    removalPolicy: "locked",
    rolloutTarget: "user-global",
    rolloutAudience: "all-platform-users",
    files: [
      {
        path: "SKILL.md",
        text: `---
name: veslo-docx
description: Use for Word DOCX authoring, editing, conversion, formatting, and validation.
---

# Veslo DOCX

Use this skill when the user asks to create, edit, inspect, convert, validate, or format a Word DOCX document.

Work in the current session. Use normal file tools and deterministic document libraries where available. Validate generated DOCX files as real OOXML zip archives before reporting completion.
`,
      },
    ],
  },
];
```

Migrate useful `scripts/`, `references/`, and `assets/` from the old internal packs into package files. Rewrite the top-level `SKILL.md` files so they describe normal skill usage in the current session.

**Step 3: Run package tests**

Run:

```bash
pnpm --filter @neatech/den exec tsx --test test/core-platform-skills.test.ts
```

Expected: PASS.

**Step 4: Commit**

```bash
git add services/den/src/skills/core-platform-skills.ts services/den/test/core-platform-skills.test.ts
git commit -m "feat: define core platform skill packages"
```

## Task 5: Bootstrap Core Platform Skills In Den Registry

**Files:**
- Modify: `services/den/src/index.ts`
- Create: `services/den/src/skills/core-platform-skill-bootstrap.ts`
- Create: `services/den/test/core-platform-skill-bootstrap.test.ts`
- Modify: `services/den/test/skill-registry-routes.test.ts` if route-level platform rollout assertions need coverage reuse

**Step 1: Write failing bootstrap tests**

Use the in-memory store or DB store fixture to assert:

- bootstrap creates each core skill with system/platform scope
- bootstrap creates one approved package version per skill
- bootstrap creates a locked `all-platform-users` rollout policy targeting `user-global`
- bootstrap is idempotent and does not create duplicate skills, versions, or rollout policies
- updating the package content creates a new version and points the rollout at the new version

**Step 2: Run bootstrap tests and verify failure**

Run:

```bash
pnpm --filter @neatech/den exec tsx --test test/core-platform-skill-bootstrap.test.ts
```

Expected: FAIL because the bootstrap does not exist.

**Step 3: Implement idempotent bootstrap**

Create `ensureCorePlatformSkills(store)` that uses a platform-admin system context:

```ts
const CORE_PLATFORM_CONTEXT = {
  userId: "system:veslo-core-skills",
  isPlatformAdmin: true,
} satisfies SkillRegistryRouteContext;
```

For each definition:

1. list or find existing system skill by name
2. create the skill when missing
3. create a new version when the latest package hash differs
4. create or approve the system review request as needed by existing store rules
5. create or update the rollout policy with:
   - `catalogScope: "platform"`
   - `target: "user-global"`
   - `audience: "all-platform-users"`
   - `removalPolicy: "locked"`
   - `updatePolicy: "pinned"`

Call it during Den startup after the DB-backed skill registry store is created.

**Step 4: Run Den tests**

Run:

```bash
pnpm --filter @neatech/den exec tsx --test test/core-platform-skills.test.ts test/core-platform-skill-bootstrap.test.ts test/skill-registry-routes.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/den/src/index.ts services/den/src/skills/core-platform-skill-bootstrap.ts services/den/src/skills/core-platform-skills.ts services/den/test/core-platform-skill-bootstrap.test.ts services/den/test/core-platform-skills.test.ts services/den/test/skill-registry-routes.test.ts
git commit -m "feat: bootstrap core platform skills"
```

## Task 6: Verify Local Materialization Uses Registry Only

**Files:**
- Modify: `packages/server/src/server.skill-materialization.test.ts`
- Modify: `packages/e2e/helpers/skill-registry-fixture.ts`
- Create: `packages/e2e/specs/core-platform-skills.e2e.ts`

**Step 1: Extend server materialization tests**

In `packages/server/src/server.skill-materialization.test.ts`, add a registry fixture response with `skill-rollout-policies?target=user-global&enabled=true` returning a platform locked rollout for `veslo-docx` and a package download for that version.

Expected:

- `POST /skills/materialization/sync-global` materializes `veslo-docx` under the personal-global `veslo-managed` root
- there is no `.opencode/veslo/internal` fallback
- no internal agent or delegate plugin is required

**Step 2: Extend E2E registry fixture**

In `packages/e2e/helpers/skill-registry-fixture.ts`:

- allow `source: "platform"` in fixture types if needed
- add a locked platform rollout fixture for at least `veslo-docx`
- return it from `/v1/skill-rollout-policies?target=user-global&enabled=true`
- return its package from `/v1/skill-versions/:versionId/package`

**Step 3: Add desktop E2E**

Create `packages/e2e/specs/core-platform-skills.e2e.ts` that:

1. starts the real desktop runtime with the skill registry fixture
2. completes or seeds signed-in state using existing helpers
3. triggers global skill materialization
4. verifies the managed skill file exists under user-global `veslo-managed`
5. verifies the workspace does not contain `.opencode/veslo/internal`
6. verifies the workspace does not contain `.opencode/plugins/veslo-delegate.js`

Do not start `packages/web` or a raw Vite UI server.

**Step 4: Run focused server test**

Run:

```bash
pnpm --filter veslo-server test server.skill-materialization.test.ts
```

Expected: PASS.

**Step 5: Run desktop E2E preflight and focused E2E**

Follow `docs/dev/testing-playbook.md` preflight before launching. Then run:

```bash
pnpm --filter @neatech/veslo-e2e test -- --spec packages/e2e/specs/core-platform-skills.e2e.ts
```

Expected: PASS in the real Tauri runtime.

**Step 6: Commit**

```bash
git add packages/server/src/server.skill-materialization.test.ts packages/e2e/helpers/skill-registry-fixture.ts packages/e2e/specs/core-platform-skills.e2e.ts
git commit -m "test: verify core platform skill materialization"
```

## Task 7: Remove Obsolete Internal Pack Source And Tests

**Files:**
- Delete: `internal/veslo-internal-packs/`
- Modify: `packages/server/src/session-artifacts.test.ts` if it references `.opencode/veslo/internal`
- Modify: `docs/agents-doc/agents.md` if it documents internal subagents as current behavior
- Modify: `ARCHITECTURE.md`
- Modify: `docs/features/session-runtime.md` only if it claims document/skill-creator work appears as internal subagents

**Step 1: Search for remaining current-behavior references**

Run:

```bash
rg -n "veslo-internal|veslo-delegate|VESLO_INTERNAL_ROUTING|\\.opencode/veslo/internal|internal subagent|delegate tool" . -g '!docs/plans/**' -g '!packages/desktop/src-tauri/target/**'
```

Expected before cleanup: matches in source, tests, and docs.

**Step 2: Delete obsolete internal pack source**

Delete `internal/veslo-internal-packs/` only after Tasks 4 and 5 have moved the required package content into Den platform skill definitions.

**Step 3: Update tests that only filtered technical artifacts**

If `packages/server/src/session-artifacts.test.ts` only references `.opencode/veslo/internal` as an example of technical files, replace it with another current technical skill path such as `.opencode/skills/veslo-managed/example/SKILL.md`.

**Step 4: Update durable docs**

Update canonical docs to describe current behavior:

- platform-managed skills are the source for core DOCX/PDF/PPTX/XLSX/skill-creator workflows
- these skills sync after sign-in
- old internal subagents/delegate are no longer part of runtime behavior

Do not update only `docs/plans/`; use `ARCHITECTURE.md`, `docs/features/skill-registry-and-distribution.md`, and `docs/features/extensions-and-integrations.md` where relevant.

**Step 5: Run reference search again**

Run:

```bash
rg -n "veslo-internal|veslo-delegate|VESLO_INTERNAL_ROUTING|\\.opencode/veslo/internal|internal subagent|delegate tool" . -g '!docs/plans/**' -g '!packages/desktop/src-tauri/target/**'
```

Expected: no current-behavior references remain. Historical plan docs may still contain the terms and are excluded.

**Step 6: Commit**

```bash
git add internal packages/server/src/session-artifacts.test.ts ARCHITECTURE.md docs/agents-doc/agents.md docs/features/skill-registry-and-distribution.md docs/features/extensions-and-integrations.md docs/features/session-runtime.md
git commit -m "docs: remove internal delegation runtime references"
```

## Task 8: Full Verification

**Files:**
- No planned source edits unless verification exposes a bug.

**Step 1: Run server tests**

```bash
pnpm --filter veslo-server test internal-system.test.ts server.skill-materialization.test.ts skill-materializer.test.ts
```

Expected: PASS.

**Step 2: Rebuild server binary**

Run the repo-required server binary rebuild. If the documented filter name is stale, use the package's actual filter name:

```bash
pnpm --filter openwork-server build:bin || pnpm --filter veslo-server build:bin
```

Expected: the valid package filter completes successfully.

**Step 3: Run Den tests**

```bash
pnpm --filter @neatech/den exec tsx --test test/core-platform-skills.test.ts test/core-platform-skill-bootstrap.test.ts test/skill-registry-routes.test.ts test/skill-registry-search.test.ts
```

Expected: PASS.

**Step 4: Run Rust desktop provisioning tests**

```bash
cd packages/desktop
cargo test internal_provision --manifest-path src-tauri/Cargo.toml
```

Expected: PASS.

**Step 5: Run real desktop E2E**

Follow `docs/dev/testing-playbook.md` preflight. Then run:

```bash
pnpm --filter @neatech/veslo-e2e test -- --spec packages/e2e/specs/core-platform-skills.e2e.ts
```

Expected: PASS in the real Tauri runtime.

**Step 6: Final source search**

```bash
rg -n "delegate\\(|veslo-delegate|veslo-internal|VESLO_ROUTER_FORCE_DELEGATE|VESLO_INTERNAL_ROUTING" packages services internal docs -g '!docs/plans/**' -g '!packages/desktop/src-tauri/target/**'
```

Expected: no current runtime source references remain. If matches remain in unrelated historical comments, either remove or clearly mark them as historical.

**Step 7: Final commit if verification fixes were needed**

If verification required fixes:

```bash
git add <changed-files>
git commit -m "fix: complete platform core skills migration"
```

Otherwise no extra commit is needed.
