# Session Artifact Provenance Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement phase 1 of the approved session artifact provenance redesign so the Session sidebar shows run-scoped artifact families from server-owned provenance instead of noisy regex-derived file paths.

**Architecture:** Add a pure server-side reducer that derives latest-run artifacts from OpenCode session history and expose them through a Veslo server API. Then add a pure app-side family model plus a new family-based `ArtifactsPanel` UI that prefers server provenance, aggregates Soul memory + heartbeat into one `Soul` family, and falls back to legacy client heuristics only for older runs without provenance.

**Tech Stack:** Bun server, TypeScript, SolidJS, Lucide icons, Veslo server REST APIs, OpenCode session/messages APIs, Node test runner (`node --test --import=tsx/esm`), Bun test, pnpm, Docker dev stack, Tauri desktop, Chrome MCP

---

## Prerequisites

- Use `@superpowers:test-driven-development` during implementation.
- Run implementation in a dedicated worktree before touching feature code.
- Do not run a web-only app flow. Use the Tauri desktop app (`packages/desktop`) for any manual verification.
- Because this plan changes `packages/server/src`, always rebuild the compiled server binary with `pnpm --filter veslo-server build:bin` before claiming desktop verification is complete.
- Keep the existing `Skills` sidebar section untouched except for any wiring needed to keep it separate from artifacts.

### Task 1: Create worktree and capture baseline

**Files:**
- Modify: none (environment preparation)

**Step 1: Sync repository and submodules**

Run:

```bash
git fetch --all --prune
git submodule update --init --recursive
```

Expected: completes without errors.

**Step 2: Create and enter a dedicated worktree**

Run:

```bash
git worktree add .worktrees/codex/session-artifact-provenance -b codex/session-artifact-provenance
cd .worktrees/codex/session-artifact-provenance
```

Expected: new worktree exists and branch `codex/session-artifact-provenance` is checked out.

**Step 3: Capture baseline typecheck and tests**

Run:

```bash
pnpm --filter veslo-server test
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: current branch is green before feature edits.

### Task 2: Add failing server tests for latest-run artifact provenance

**Files:**
- Create: `packages/server/src/session-artifacts.test.ts`
- Test: `packages/server/src/session-artifacts.test.ts`

**Step 1: Add a reducer-focused test fixture shape**

Create a test-only message/part fixture format that can express:

- latest user prompt boundary
- read/search/list/glob tool activity
- write/edit/apply-patch activity
- explicit skill tool usage
- MCP-backed tool usage
- Soul memory and heartbeat evidence

Keep the fixture minimal so the reducer can be unit tested without booting the full server.

**Step 2: Add failing tests for artifact classification**

Cover these cases:

- `file_discovered` from read/search/list activity
- `file_output` from write/edit/apply-patch activity
- `skill_used` from explicit `skill` tool usage
- `mcp_used` from a concrete MCP-backed tool call such as Chrome DevTools
- `soul_memory_used` and `heartbeat_used` staying separate internally
- `Soul` family eligibility when both memory and heartbeat appear in one run

**Step 3: Add negative tests for noisy technical paths**

Assert these do **not** become `Files` artifacts unless they are the explicit user-facing target:

- `SKILL.md`
- internal markdown prompts
- `AGENTS.md`
- `.opencode` technical plumbing files

**Step 4: Add latest-run boundary tests**

Assert the reducer only uses artifacts from the most recent run boundary, not from older session history.

**Step 5: Run targeted tests to confirm failure**

Run:

```bash
pnpm --filter veslo-server exec bun test src/session-artifacts.test.ts
```

Expected: FAIL because the reducer module does not exist yet.

**Step 6: Commit failing tests**

```bash
git add packages/server/src/session-artifacts.test.ts
git commit -m "test: add session artifact provenance specs"
```

### Task 3: Implement the pure server artifact reducer and shared server types

**Files:**
- Create: `packages/server/src/session-artifacts.ts`
- Modify: `packages/server/src/types.ts`
- Test: `packages/server/src/session-artifacts.test.ts`

**Step 1: Define internal provenance and public artifact types**

Add server-side types for:

```ts
type SessionArtifactFamily = "files" | "skills" | "mcp" | "soul";
type SessionArtifactKind =
  | "file_output"
  | "file_discovered"
  | "skill_used"
  | "mcp_used"
  | "soul_memory_used"
  | "heartbeat_used";
type SessionArtifactStatus = "scanned" | "updated" | "created" | "exported" | "used" | "active";
```

Also add response-safe types such as:

```ts
type SessionArtifactItem = {
  id: string;
  family: SessionArtifactFamily;
  kind: SessionArtifactKind;
  status: SessionArtifactStatus;
  title: string;
  subtitle?: string;
  path?: string;
  sourceName?: string;
  timestamp: number;
};
```

**Step 2: Implement latest-run boundary extraction**

Implement a pure helper that isolates the most recent run using the latest user-message boundary (or equivalent prompt boundary) from the message stream provided to the reducer.

**Step 3: Implement artifact classification rules**

Implement pure reducers that:

- classify file discovery separately from file output
- convert explicit skill usage to `skill_used`
- convert known MCP-backed tool usage to `mcp_used`
- classify Soul memory and heartbeat evidence separately
- drop noisy technical file paths

**Step 4: Implement Soul family aggregation helper**

Add a pure helper that preserves separate internal Soul events but can later be rendered as one `Soul` family.

**Step 5: Run targeted tests**

Run:

```bash
pnpm --filter veslo-server exec bun test src/session-artifacts.test.ts
```

Expected: PASS.

**Step 6: Commit reducer implementation**

```bash
git add packages/server/src/session-artifacts.ts packages/server/src/session-artifacts.test.ts packages/server/src/types.ts
git commit -m "feat(server): add session artifact provenance reducer"
```

### Task 4: Expose latest-run artifact provenance through Veslo server

**Files:**
- Modify: `packages/server/src/server.ts`
- Modify: `packages/server/src/types.ts`
- Test: `packages/server/src/session-artifacts.test.ts`
- Test: `packages/server/src/server.normalizeWorkspaceRelativePath.test.ts` (only if a small path helper case must be extended)

**Step 1: Add a latest-run artifact endpoint**

Add a client route:

```text
GET /workspace/:id/sessions/:sessionId/artifacts/latest-run
```

This route should:

- resolve the workspace
- fetch upstream OpenCode session messages for `sessionId`
- derive latest-run artifacts using `session-artifacts.ts`
- return a family-ready response shape

**Step 2: Keep the existing outbox artifact routes unchanged**

Do not overload:

- `GET /workspace/:id/artifacts`
- `GET /workspace/:id/artifacts/:artifactId`

Those remain workspace outbox APIs. The new route is specifically for session-run provenance.

**Step 3: Normalize server response shape**

Return a shape similar to:

```ts
{
  sessionId: string;
  runScope: "latest";
  items: SessionArtifactItem[];
}
```

Keep it small and deterministic.

**Step 4: Run server tests**

Run:

```bash
pnpm --filter veslo-server test
```

Expected: PASS.

**Step 5: Commit server route**

```bash
git add packages/server/src/server.ts packages/server/src/types.ts
git commit -m "feat(server): expose latest-run session artifacts"
```

### Task 5: Add failing app tests for artifact family modeling

**Files:**
- Create: `packages/app/src/app/components/session/artifact-family-model.test.ts`
- Test: `packages/app/src/app/components/session/artifact-family-model.test.ts`

**Step 1: Add tests for family grouping**

Assert that server items group into:

- `Files`
- `Skills`
- `MCP`
- `Soul`

with stable ordering.

**Step 2: Add tests for Soul UI aggregation**

Assert:

- `soul_memory_used` + `heartbeat_used` become a single `Soul` family
- the resulting summary prefers the stronger heartbeat detail when both exist

**Step 3: Add tests for file badge mapping**

Assert:

- `file_discovered` -> `Scanned`
- `file_output` -> `Updated`, `Created`, or `Exported`

**Step 4: Add tests for fallback precedence**

Assert that when server artifacts exist, legacy `deriveArtifacts()` data is ignored for the sidebar, and fallback is only used when server data is missing.

**Step 5: Run targeted tests to confirm failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/artifact-family-model.test.ts
```

Expected: FAIL because the family model helper does not exist yet.

**Step 6: Commit failing tests**

```bash
git add packages/app/src/app/components/session/artifact-family-model.test.ts
git commit -m "test: add session artifact family model specs"
```

### Task 6: Implement artifact family model and the new family-based panel UI

**Files:**
- Create: `packages/app/src/app/components/session/artifact-family-model.ts`
- Modify: `packages/app/src/app/components/session/artifacts-panel.tsx`
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/cs.ts`
- Test: `packages/app/src/app/components/session/artifact-family-model.test.ts`

**Step 1: Implement a pure family-model helper**

Add a pure app helper that:

- groups server items into families
- aggregates Soul memory + heartbeat into one `Soul` family
- maps server statuses to renderable labels
- produces icon-friendly render data

**Step 2: Replace the file-path-only `ArtifactsPanel` contract**

Change `ArtifactsPanelProps` from:

```ts
files: string[];
```

to a family-oriented contract such as:

```ts
families: ArtifactFamilyView[];
legacyFiles?: string[];
```

The legacy file list may remain temporarily only for fallback rendering.

**Step 3: Implement family-based rendering**

Render:

- family title and count
- per-item icon
- badge (`Scanned`, `Updated`, `Used`, etc.)
- subtitle/path where relevant

Rules:

- `Soul` renders as one family
- file-backed items may keep `Reveal` or `Open`
- non-file capability items render informationally without fake file actions

**Step 4: Localize new badge and family labels**

Add i18n keys for:

- `Files`
- `Skills`
- `MCP`
- `Soul`
- `Scanned`
- `Updated`
- `Created`
- `Exported`
- `Used`

**Step 5: Run targeted tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/artifact-family-model.test.ts
```

Expected: PASS.

**Step 6: Commit UI model and panel**

```bash
git add packages/app/src/app/components/session/artifact-family-model.ts packages/app/src/app/components/session/artifact-family-model.test.ts packages/app/src/app/components/session/artifacts-panel.tsx packages/app/src/i18n/locales/en.ts packages/app/src/i18n/locales/cs.ts
git commit -m "feat(app): add family-based session artifacts panel"
```

### Task 7: Wire server provenance into Session and keep legacy fallback for older runs

**Files:**
- Modify: `packages/app/src/app/lib/veslo-server.ts`
- Modify: `packages/app/src/app/app.tsx`
- Modify: `packages/app/src/app/pages/session.tsx`
- Modify: `packages/app/src/app/utils/tools.ts`
- Test: `packages/app/src/app/components/session/artifact-family-model.test.ts`
- Test: `packages/app/src/app/utils/session-status.test.ts` (only if shared session helpers need small coverage additions)

**Step 1: Add client types and API method**

In `packages/app/src/app/lib/veslo-server.ts`, add types and client method for:

```ts
listSessionLatestRunArtifacts(workspaceId: string, sessionId: string)
```

**Step 2: Fetch latest-run artifacts in app state**

In `packages/app/src/app/app.tsx`, add state and refresh logic for the selected session’s latest-run artifacts.

Keep the fetch scoped to the active workspace/session.

**Step 3: Keep `deriveArtifacts()` as a fallback only**

Do not delete the legacy helper yet. Instead:

- prefer server artifacts when available
- use legacy `deriveArtifacts()` only when the server route returns no provenance or when the workspace/server path does not support it

**Step 4: Update `SessionView` props and wiring**

Pass family data into `packages/app/src/app/pages/session.tsx` and then into the new `ArtifactsPanel`.

Do not change the separate `workingFiles` behavior used elsewhere in the context sidebar unless required by compile errors.

**Step 5: Run app tests and typecheck**

Run:

```bash
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: PASS.

**Step 6: Commit wiring and fallback**

```bash
git add packages/app/src/app/lib/veslo-server.ts packages/app/src/app/app.tsx packages/app/src/app/pages/session.tsx packages/app/src/app/utils/tools.ts
git commit -m "feat(app): wire server-backed session artifacts"
```

### Task 8: Update product and architecture docs for the new system contract

**Files:**
- Modify: `PRODUCT.md`
- Modify: `ARCHITECTURE.md`
- Modify: `docs/plans/2026-03-28-session-artifact-provenance-design.md`

**Step 1: Update `PRODUCT.md` artifact definition**

Adjust the artifacts section so it matches the approved product semantics:

- run-scoped artifacts
- user-relevant outputs and used capabilities
- files may include scanned files, not only created/modified outputs

**Step 2: Update `ARCHITECTURE.md`**

Document that session artifact provenance is Veslo-server-owned for new runs and that the app renders artifact families from server truth.

**Step 3: Backfill any implementation notes into the design doc**

If endpoint names or migration details changed during implementation, update the approved design doc so it stays accurate.

**Step 4: Run docs sanity checks**

Run:

```bash
git diff -- PRODUCT.md ARCHITECTURE.md docs/plans/2026-03-28-session-artifact-provenance-design.md
```

Expected: the docs describe the same system contract that the code now implements.

**Step 5: Commit docs updates**

```bash
git add PRODUCT.md ARCHITECTURE.md docs/plans/2026-03-28-session-artifact-provenance-design.md
git commit -m "docs: describe run-scoped session artifact provenance"
```

### Task 9: Rebuild the server binary and run full code verification

**Files:**
- Modify: none (verification only)

**Step 1: Rebuild the compiled server binary**

Run:

```bash
pnpm --filter veslo-server build:bin
```

Expected: PASS and `dist/bin/veslo-server` is refreshed.

**Step 2: Run server verification**

Run:

```bash
pnpm --filter veslo-server test
pnpm --filter veslo-server typecheck
```

Expected: PASS.

**Step 3: Run app verification**

Run:

```bash
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: PASS.

**Step 4: Commit verification-only fixes if needed**

If verification forces small follow-up fixes, commit them immediately with a focused message such as:

```bash
git commit -am "fix: align session artifact provenance verification"
```

Only use this if real fixes were required.

### Task 10: Run the required desktop end-to-end gate, capture screenshots, and verify real flows

**Files:**
- Create: `packages/app/pr/screenshots/session-artifact-provenance/01-files-scanned.png`
- Create: `packages/app/pr/screenshots/session-artifact-provenance/02-skill-used.png`
- Create: `packages/app/pr/screenshots/session-artifact-provenance/03-mcp-used.png`
- Create: `packages/app/pr/screenshots/session-artifact-provenance/04-soul-family.png`
- Modify: `packages/app/pr/session-artifact-provenance.md` (optional short verification note for PR context)

**Step 1: Start the Docker dev stack from repo root**

Run:

```bash
packaging/docker/dev-up.sh
```

Expected: printed Veslo server URL, printed web URL, and printed compose teardown command.

**Step 2: Launch the Tauri desktop app**

Run:

```bash
pnpm dev
```

Expected: Tauri desktop app launches. Do not switch to a web-only verification flow.

**Step 3: Use Chrome MCP to verify the feature**

Follow `.opencode/skills/openwork-docker-chrome-mcp/SKILL.md` and verify these real user flows:

- a run that scans/reads workspace files without editing shows `Files` with `Scanned`
- a run that uses a real skill shows `Skills` with the skill identity and does not show `SKILL.md`
- a run that uses Control Chrome shows `MCP` with the Chrome MCP identity
- a run that touches Soul memory and/or heartbeat evidence shows a single `Soul` family

**Step 4: Capture screenshots into the repo**

Save the screenshots to:

- `packages/app/pr/screenshots/session-artifact-provenance/01-files-scanned.png`
- `packages/app/pr/screenshots/session-artifact-provenance/02-skill-used.png`
- `packages/app/pr/screenshots/session-artifact-provenance/03-mcp-used.png`
- `packages/app/pr/screenshots/session-artifact-provenance/04-soul-family.png`

**Step 5: Add a short PR note if useful**

If the repo is using PR notes for verification context, add:

- `packages/app/pr/session-artifact-provenance.md`

Summarize what each screenshot demonstrates and list the exact verification commands that were run.

**Step 6: Commit screenshots and verification note**

```bash
git add packages/app/pr/screenshots/session-artifact-provenance packages/app/pr/session-artifact-provenance.md
git commit -m "docs: add session artifact provenance verification evidence"
```

Plan complete and saved to `docs/plans/2026-03-28-session-artifact-provenance-implementation-plan.md`. Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

**Which approach?**
