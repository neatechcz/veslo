# Skill Import Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a Skills import flow that discovers Codex, Claude Code, OpenCode, and legacy agent skills as candidates, lets users choose specific candidates by source agent, and imports them into Veslo-owned user or workspace storage automatically.

**Architecture:** The local Veslo server owns candidate scanning, validation, copying, and import results. The app owns filtering, selection, preview, and status display. Foreign roots remain import candidates only; installed inventory continues to come from Veslo-local runtime/user-store sources.

**Tech Stack:** TypeScript, Bun tests, SolidJS, Veslo server route modules, Veslo app domain clients, existing skill metadata parser and user-skill store.

---

### Task 1: Server Candidate Scanner

**Files:**
- Create: `packages/server/src/skill-import-candidates.ts`
- Test: `packages/server/src/tests/skill-import-candidates.test.ts`

**Step 1: Write the failing tests**

```ts
test("discovers codex user and workspace candidates with automatic targets", async () => {
  const items = await listSkillImportCandidates({
    workspaces: [{ id: "ws_1", name: "Workspace", path: workspaceRoot, workspaceType: "local" }],
    homeDir,
    xdgConfigHome: join(homeDir, ".config"),
    dataDir,
  });

  expect(items.map(({ sourceAgent, target }) => ({ sourceAgent, target }))).toContainEqual({
    sourceAgent: "codex",
    target: { scope: "user-global" },
  });
  expect(items.map(({ sourceAgent, target }) => ({ sourceAgent, target }))).toContainEqual({
    sourceAgent: "codex",
    target: { scope: "workspace", workspaceId: "ws_1" },
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter veslo-server test -- packages/server/src/tests/skill-import-candidates.test.ts`
Expected: FAIL because `skill-import-candidates.ts` does not exist.

**Step 3: Implement scanner**

Add exported functions:

```ts
export async function listSkillImportCandidates(input: SkillImportCandidateInput): Promise<SkillImportCandidate[]> {
  // Build known user roots and workspace roots.
  // Scan direct and one-level nested folders for SKILL.md.
  // Parse metadata with parseSkillMarkdownMetadata.
  // Resolve target from source location: user roots -> user-global, workspace roots -> workspace.
  // Mark conflicts against user store and workspace roots.
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm --filter veslo-server test -- packages/server/src/tests/skill-import-candidates.test.ts`
Expected: PASS.

### Task 2: Server Import Operation

**Files:**
- Modify: `packages/server/src/skill-import-candidates.ts`
- Test: `packages/server/src/tests/skill-import-candidates.test.ts`

**Step 1: Write failing import tests**

```ts
test("imports user-level candidates into the Veslo user skill store", async () => {
  const candidates = await listSkillImportCandidates(input);
  const result = await importSkillCandidates({
    ...input,
    candidateIds: [candidates.find((item) => item.target.scope === "user-global")!.id],
    actor: { type: "local" },
  });

  expect(result.results[0]).toMatchObject({ ok: true, target: { scope: "user-global" } });
  expect(await readUserGlobalSkill("codex-helper", dataDir)).toMatchObject({
    item: { name: "codex-helper" },
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter veslo-server test -- packages/server/src/tests/skill-import-candidates.test.ts`
Expected: FAIL because import operation is missing.

**Step 3: Implement import**

Add `importSkillCandidates()` that re-scans current candidates, rejects invalid/conflict candidates, writes user-level imports via `upsertUserGlobalSkill()`, writes workspace imports by copying the full source directory into `.opencode/skills/<name>`, and returns per-candidate results.

**Step 4: Run tests**

Run: `pnpm --filter veslo-server test -- packages/server/src/tests/skill-import-candidates.test.ts`
Expected: PASS.

### Task 3: Server Routes

**Files:**
- Create: `packages/server/src/routes/skill-imports.ts`
- Modify: `packages/server/src/server.ts`
- Test: `packages/server/src/tests/server.skill-imports-routes.test.ts`

**Step 1: Write route contract tests**

```ts
expect(matchRoute(routes, "GET", "/skills/import-candidates")?.auth).toBe("client");
expect(matchRoute(routes, "POST", "/skills/import-candidates/import")?.auth).toBe("client");
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter veslo-server test -- packages/server/src/tests/server.skill-imports-routes.test.ts`
Expected: FAIL because routes are not registered.

**Step 3: Register routes**

Expose:

- `GET /skills/import-candidates`
- `POST /skills/import-candidates/import`

Both require client auth. Import requires writable server config and collaborator scope. Routes call the scanner/import module and pass configured local workspaces.

**Step 4: Run route tests**

Run: `pnpm --filter veslo-server test -- packages/server/src/tests/server.skill-imports-routes.test.ts`
Expected: PASS.

### Task 4: App Client Types and Methods

**Files:**
- Modify: `packages/app/src/app/lib/veslo-server/types.ts`
- Modify: `packages/app/src/app/lib/veslo-server-domains/skills.ts`
- Test: `packages/app/src/app/tests/lib/veslo-server-skills-client.test.ts` or nearest existing domain-client test

**Step 1: Write failing client test**

Assert that `listSkillImportCandidates()` calls `GET /skills/import-candidates` and `importSkillCandidates()` calls `POST /skills/import-candidates/import` with selected ids.

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @neatech/veslo-ui test -- packages/app/src/app/tests/lib/veslo-server-skills-client.test.ts`
Expected: FAIL because client methods do not exist.

**Step 3: Add types and methods**

Add candidate/result response types and client methods to the Skills domain facade.

**Step 4: Run client test**

Run: `pnpm --filter @neatech/veslo-ui test -- packages/app/src/app/tests/lib/veslo-server-skills-client.test.ts`
Expected: PASS.

### Task 5: App Context Actions

**Files:**
- Modify: `packages/app/src/app/context/extensions.ts`
- Test: `packages/app/src/app/tests/context/extensions-skill-imports.test.ts`

**Step 1: Write failing context tests**

Verify that the context loads candidates through Veslo server, imports selected ids, refreshes inventory after success, and returns a clear server-required message when unavailable.

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @neatech/veslo-ui test -- packages/app/src/app/tests/context/extensions-skill-imports.test.ts`
Expected: FAIL because context methods do not exist.

**Step 3: Add context state and methods**

Expose:

- `skillImportCandidates`
- `skillImportStatus`
- `refreshSkillImportCandidates()`
- `importSkillCandidates(candidateIds: string[])`

**Step 4: Run context test**

Run: `pnpm --filter @neatech/veslo-ui test -- packages/app/src/app/tests/context/extensions-skill-imports.test.ts`
Expected: PASS.

### Task 6: Skills Page Import UI

**Files:**
- Modify: `packages/app/src/app/pages/skills.tsx`
- Modify: `packages/app/src/app/types.ts`
- Modify: locale files under `packages/app/src/i18n/locales/`
- Test: `packages/app/src/app/tests/pages/skills-layout-contract.test.ts`

**Step 1: Write failing UI contract tests**

Assert that the page contains an "Import from other agents" action, source-agent filter controls, candidate selection, read-only automatic target labels, and no scope picker.

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @neatech/veslo-ui test -- packages/app/src/app/tests/pages/skills-layout-contract.test.ts`
Expected: FAIL because import UI does not exist.

**Step 3: Implement UI**

Add an import modal or inline panel that loads candidates, filters by source agent/status/search, shows target labels, supports row selection, and submits selected ids.

**Step 4: Run UI test**

Run: `pnpm --filter @neatech/veslo-ui test -- packages/app/src/app/tests/pages/skills-layout-contract.test.ts`
Expected: PASS.

### Task 7: Verification and Docs

**Files:**
- Modify: `docs/features/extensions-and-integrations.md`
- Modify: `docs/dev/state-and-config-reference.md`

**Step 1: Update canonical docs**

Document that migration scans foreign-agent folders as import candidates, imports into Veslo-owned storage, and automatically resolves user/workspace target from source location.

**Step 2: Run focused verification**

Run:

```bash
pnpm --filter veslo-server test -- packages/server/src/tests/skill-import-candidates.test.ts packages/server/src/tests/server.skill-imports-routes.test.ts
pnpm --filter @neatech/veslo-ui test -- packages/app/src/app/tests/context/extensions-skill-imports.test.ts packages/app/src/app/tests/pages/skills-layout-contract.test.ts
pnpm typecheck
pnpm --filter veslo-server build:bin
graphify update .
```

Expected: all tests and typecheck pass; server binary rebuild succeeds; graph update completes.

**Step 3: Commit**

Commit the implementation separately from the design and plan commits.
