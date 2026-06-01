# VSLO-160 Agent Right Menu Files Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the session right menu show only files the agent explicitly opened or modified, split visually into Modified and Opened groups, while keeping skills as readable skill items.

**Architecture:** Keep Veslo server latest-run artifact provenance as the canonical source. Tighten server classification so only explicit reads become opened file artifacts and write/edit/apply-patch activity becomes modified file artifacts; then teach the app artifact model and panel to render file artifacts in two groups. Keep the legacy client fallback conservative so server failures do not bring noisy search/list/glob paths back.

**Tech Stack:** Bun/TypeScript server, SolidJS app, lucide-solid icons, Node test runner for app unit tests, Bun test for server tests, WebdriverIO desktop E2E against the Tauri runtime.

---

## Preconditions

- Work in `/Users/vaclavsoukup/AI agent projects/Veslo`.
- Do not start `packages/web`, raw Vite, `pnpm -w dev:ui`, or `pnpm --filter @neatech/veslo-ui dev`.
- Before desktop E2E, run the Veslo desktop test-runtime preflight from `docs/dev/testing-playbook.md`.
- If `packages/server/src` changes, rebuild the server binary before relying on orchestrator-backed flows.

## Task 1: Add Failing Server Provenance Tests

**Files:**
- Modify: `packages/server/src/session-artifacts.test.ts`

**Step 1: Replace the broad discovery expectation**

Update the existing discovery test so search/list/glob paths are not expected as file artifacts. Add explicit tests for the new behavior:

```ts
test("derives opened file artifacts only from explicit read activity", () => {
  const artifacts = deriveLatestRunArtifacts(
    session(
      userMessage("msg_1", "Inspect the relevant files."),
      assistantMessage(
        "msg_2",
        toolPart("read", { path: "src/opened.ts" }),
        toolPart("search", { files: ["src/search-result.ts"] }),
        toolPart("list", { files: ["src/list-result.ts"] }),
        toolPart("glob", { files: ["src/glob-result.ts"] }),
      ),
    ),
  );

  expect(files(artifacts).map((artifact) => [artifact.kind, artifact.path])).toEqual([
    ["file_discovered", "src/opened.ts"],
  ]);
});

test("does not derive file artifacts from search list or glob exploration", () => {
  const artifacts = deriveLatestRunArtifacts(
    session(
      userMessage("msg_1", "Find likely files."),
      assistantMessage(
        "msg_2",
        toolPart("search", { files: ["src/search-result.ts"] }),
        toolPart("list", { files: ["src/list-result.ts"] }),
        toolPart("glob", { files: ["src/glob-result.ts"] }),
      ),
    ),
  );

  expect(files(artifacts)).toEqual([]);
});

test("modified file artifacts win over opened duplicates", () => {
  const artifacts = deriveLatestRunArtifacts(
    session(
      userMessage("msg_1", "Open and update the same file."),
      assistantMessage(
        "msg_2",
        toolPart("read", { path: "src/app.ts" }),
        toolPart("edit", { path: "src/app.ts" }),
      ),
    ),
  );

  expect(files(artifacts).map((artifact) => [artifact.kind, artifact.path])).toEqual([
    ["file_output", "src/app.ts"],
  ]);
});
```

Keep the existing technical-file filtering test and ensure it still covers `SKILL.md`, `AGENTS.md`, `.opencode`, prompts, temp/cache/build-style paths, and skill implementation paths.

**Step 2: Run the server test and confirm failure**

Run:

```bash
pnpm --filter veslo-server exec bun test src/session-artifacts.test.ts
```

Expected: FAIL because search/list/glob still emit file artifacts and the existing broad discovery test still reflects the old behavior.

**Step 3: Commit the failing tests**

```bash
git add packages/server/src/session-artifacts.test.ts
git commit -m "test(server): capture right menu file provenance rules"
```

## Task 2: Tighten Server File Artifact Classification

**Files:**
- Modify: `packages/server/src/session-artifacts.ts`
- Test: `packages/server/src/session-artifacts.test.ts`

**Step 1: Restrict opened file artifacts to read**

In `packages/server/src/session-artifacts.ts`, replace broad discovery tool handling with read-only opened handling:

```ts
const FILE_OUTPUT_TOOLS = new Set(["write", "edit", "apply_patch"]);
const FILE_OPEN_TOOLS = new Set(["read"]);
```

Then update classification:

```ts
if (FILE_OPEN_TOOLS.has(input.toolName)) {
  for (const path of resolveFileOpenedPaths(input.part, state)) {
    const normalizedPath = normalizeArtifactPath(path);
    if (!normalizedPath || shouldDropGenericFileArtifact(normalizedPath) || isSemanticSoulPath(normalizedPath)) continue;
    items.push(
      createArtifact({
        ...input,
        family: "files",
        kind: "file_discovered",
        status: "scanned",
        title: basename(normalizedPath),
        subtitle: normalizedPath,
        path: normalizedPath,
      }),
    );
  }
}
```

Rename `resolveFileDiscoveredPaths` to `resolveFileOpenedPaths` and make it only collect direct read targets plus read attachments if needed:

```ts
function resolveFileOpenedPaths(part: SessionArtifactPart, state: ToolStateLike): string[] {
  return uniqueStrings([
    ...collectDirectPaths(part, state),
    ...collectAttachmentPaths(state),
  ]);
}
```

Do not collect `files`, `paths`, search output, list output, or glob output for opened artifacts.

**Step 2: Preserve modified-file behavior**

Leave `resolveFileOutputPaths` in place for `write`, `edit`, and `apply_patch`. Confirm `collectDirectPaths` still reads all path spellings used by tool state:

```ts
readString(state.input, "path"),
readString(state.input, "file"),
readString(state.input, "filePath"),
readString(state.input, "target"),
```

**Step 3: Run the server test**

Run:

```bash
pnpm --filter veslo-server exec bun test src/session-artifacts.test.ts
```

Expected: PASS.

**Step 4: Rebuild the server binary**

Run:

```bash
pnpm --filter veslo-server build:bin
```

Expected: PASS and `packages/server/dist/bin/veslo-server` is refreshed.

**Step 5: Commit**

```bash
git add packages/server/src/session-artifacts.ts packages/server/src/session-artifacts.test.ts packages/server/dist/bin/veslo-server
git commit -m "fix(server): limit session file artifacts to opened and modified files"
```

If the binary is ignored or unchanged, stage only the source and tests.

## Task 3: Add App Artifact Model Grouping Tests

**Files:**
- Modify: `packages/app/src/app/components/session/artifact-family-model.test.ts`
- Modify: `packages/app/src/app/components/session/artifact-family-model.ts`

**Step 1: Add expectations for file interactions**

Add tests that make the app model explicitly distinguish modified and opened rows:

```ts
const fileRows = (family: Record<string, unknown>) =>
  familyItems(family).map((item) => {
    const record = item as Record<string, unknown>;
    return {
      kind: String(record.kind ?? ""),
      path: String(record.path ?? ""),
      fileInteraction: String(record.fileInteraction ?? ""),
    };
  });

test("file artifacts carry modified and opened interactions for right menu grouping", () => {
  const families = buildArtifactFamilies({
    artifacts: [
      artifact({
        id: "opened",
        family: "files",
        kind: "file_discovered",
        status: "scanned",
        title: "opened.ts",
        path: "src/opened.ts",
        timestamp: 10,
      }),
      artifact({
        id: "modified",
        family: "files",
        kind: "file_output",
        status: "updated",
        title: "modified.ts",
        path: "src/modified.ts",
        timestamp: 20,
      }),
    ],
  });

  assert.deepEqual(fileRows(families[0] as Record<string, unknown>), [
    { kind: "file_output", path: "src/modified.ts", fileInteraction: "modified" },
    { kind: "file_discovered", path: "src/opened.ts", fileInteraction: "opened" },
  ]);
});

test("modified file artifacts replace opened duplicates in the app family model", () => {
  const families = buildArtifactFamilies({
    artifacts: [
      artifact({
        id: "opened",
        family: "files",
        kind: "file_discovered",
        status: "scanned",
        title: "app.ts",
        path: "src/app.ts",
        timestamp: 10,
      }),
      artifact({
        id: "modified",
        family: "files",
        kind: "file_output",
        status: "updated",
        title: "app.ts",
        path: "src/app.ts",
        timestamp: 20,
      }),
    ],
  });

  assert.deepEqual(fileRows(families[0] as Record<string, unknown>), [
    { kind: "file_output", path: "src/app.ts", fileInteraction: "modified" },
  ]);
});
```

**Step 2: Run the focused app model test and confirm failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/artifact-family-model.test.ts
```

Expected: FAIL because `fileInteraction` and duplicate replacement do not exist yet.

**Step 3: Implement model interaction metadata**

In `artifact-family-model.ts`, extend the item type:

```ts
export type ArtifactFileInteraction = "modified" | "opened";

export type ArtifactFamilyItem = {
  id: string;
  family: ArtifactFamilyId;
  kind: string;
  status: string;
  title: string;
  subtitle?: string;
  path?: string;
  sourceName?: string;
  fileInteraction?: ArtifactFileInteraction;
  timestamp: number;
};
```

Add a helper:

```ts
function fileInteractionForKind(kind: string): ArtifactFileInteraction | undefined {
  if (kind === "file_output") return "modified";
  if (kind === "file_discovered") return "opened";
  return undefined;
}
```

In `toFamilyItem`, set `fileInteraction` for file artifacts.

**Step 4: Deduplicate file rows in the app model**

Before sorting family items, deduplicate file family items by normalized path/title so modified rows win:

```ts
function dedupeFamilyItems(family: ArtifactFamilyId, items: ArtifactFamilyItem[]): ArtifactFamilyItem[] {
  if (family !== "files") return items;
  const byKey = new Map<string, ArtifactFamilyItem>();
  for (const item of items) {
    const key = (item.path ?? item.title).trim().toLowerCase();
    if (!key) continue;
    const current = byKey.get(key);
    if (!current || shouldReplaceFamilyFileItem(current, item)) {
      byKey.set(key, item);
    }
  }
  return Array.from(byKey.values());
}

function shouldReplaceFamilyFileItem(current: ArtifactFamilyItem, next: ArtifactFamilyItem): boolean {
  if (current.fileInteraction !== next.fileInteraction) {
    return next.fileInteraction === "modified";
  }
  return next.timestamp >= current.timestamp;
}
```

Use `dedupeFamilyItems` inside `buildArtifactFamilies` before `sortFamilyItems`.

**Step 5: Run focused test**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/artifact-family-model.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add packages/app/src/app/components/session/artifact-family-model.ts packages/app/src/app/components/session/artifact-family-model.test.ts
git commit -m "feat(app): classify right menu files as modified or opened"
```

## Task 4: Make Legacy Client Fallback Conservative

**Files:**
- Create: `packages/app/src/app/utils/tools.test.ts`
- Modify: `packages/app/src/app/utils/tools.ts`
- Modify: `packages/app/src/app/types.ts`
- Test: `packages/app/src/app/utils/tools.test.ts`

**Step 1: Add fallback tests**

Create `packages/app/src/app/utils/tools.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { deriveArtifacts } from "./tools.js";

const toolMessage = (...parts: Array<Record<string, unknown>>) => [
  {
    info: { id: "msg_1", role: "assistant" },
    parts: parts.map((part) => ({ type: "tool", ...part })),
  },
] as any;

test("deriveArtifacts ignores search list and glob paths in legacy fallback", () => {
  const artifacts = deriveArtifacts(
    toolMessage(
      { tool: "search", state: { input: { pattern: "needle" }, files: ["src/search-result.ts"], output: "src/search-result.ts" } },
      { tool: "list", state: { input: { path: "src" }, files: ["src/list-result.ts"] } },
      { tool: "glob", state: { input: { pattern: "**/*.ts" }, files: ["src/glob-result.ts"] } },
    ),
  );

  assert.deepEqual(artifacts, []);
});

test("deriveArtifacts keeps explicit opened and modified paths in legacy fallback", () => {
  const artifacts = deriveArtifacts(
    toolMessage(
      { tool: "read", state: { input: { filePath: "src/opened.ts" } } },
      { tool: "edit", state: { input: { filePath: "src/modified.ts" } } },
    ),
  );

  assert.deepEqual(
    artifacts.map((artifact: any) => [artifact.path, artifact.fileInteraction]),
    [
      ["src/opened.ts", "opened"],
      ["src/modified.ts", "modified"],
    ],
  );
});
```

**Step 2: Run the new fallback test and confirm failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/utils/tools.test.ts
```

Expected: FAIL because broad search/list/glob paths are still scanned and `ArtifactItem` has no `fileInteraction`.

**Step 3: Extend the legacy artifact item type**

In `packages/app/src/app/types.ts`, add optional file interaction:

```ts
export type ArtifactItem = {
  id: string;
  name: string;
  path?: string;
  kind: "file" | "text";
  fileInteraction?: "modified" | "opened";
  size?: string;
  messageId?: string;
};
```

**Step 4: Restrict legacy extraction**

In `packages/app/src/app/utils/tools.ts`, add explicit tool groups:

```ts
const LEGACY_OPEN_TOOLS = new Set(["read"]);
const LEGACY_MODIFIED_TOOLS = new Set(["write", "edit", "apply_patch"]);
```

Change `deriveArtifacts` so it only collects paths for those tools:

```ts
const fileInteraction = LEGACY_MODIFIED_TOOLS.has(toolName)
  ? "modified"
  : LEGACY_OPEN_TOOLS.has(toolName)
    ? "opened"
    : null;
if (!fileInteraction) return;
```

Collect direct path inputs only:

```ts
const input = typeof state.input === "object" && state.input ? state.input as Record<string, unknown> : {};
const explicit = [
  state.path,
  state.file,
  input.path,
  input.file,
  input.filePath,
  input.target,
  ...(toolName === "apply_patch" && typeof state.output === "string" ? extractApplyPatchPaths(state.output) : []),
];
```

Do not scan arbitrary tool output for file paths except apply-patch summaries. Do not consume `state.files` for search/list/glob.

When creating the `ArtifactItem`, set `fileInteraction`.

**Step 5: Feed legacy interaction into artifact families**

In `buildLegacyFallbackArtifacts`, map `ArtifactItem.fileInteraction` into server-like artifacts:

```ts
const interaction = item.fileInteraction === "modified" ? "modified" : "opened";
results.push({
  ...
  family: "files",
  kind: interaction === "modified" ? "file_output" : "file_discovered",
  status: interaction === "modified" ? "updated" : "scanned",
  ...
});
```

**Step 6: Run fallback and family tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/utils/tools.test.ts src/app/components/session/artifact-family-model.test.ts
```

Expected: PASS.

**Step 7: Commit**

```bash
git add packages/app/src/app/utils/tools.ts packages/app/src/app/utils/tools.test.ts packages/app/src/app/types.ts packages/app/src/app/components/session/artifact-family-model.ts
git commit -m "fix(app): keep legacy artifact fallback conservative"
```

## Task 5: Render Modified And Opened File Groups

**Files:**
- Modify: `packages/app/src/app/components/session/artifacts-panel.test.ts`
- Modify: `packages/app/src/app/components/session/artifacts-panel.tsx`
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/cs.ts`
- Modify: `packages/app/src/i18n/locales/zh.ts`
- Test: `packages/app/src/app/components/session/artifacts-panel.test.ts`

**Step 1: Add source-level UI guard tests**

Extend `artifacts-panel.test.ts` with checks for file groups and i18n:

```ts
test("artifacts panel renders file artifacts in modified and opened groups", () => {
  assert.match(source, /data-testid="session-artifact-files-modified"/);
  assert.match(source, /data-testid="session-artifact-files-opened"/);
  assert.match(source, /session\.artifact_files_modified/);
  assert.match(source, /session\.artifact_files_opened/);
});

test("file artifact rows use interaction labels instead of scanned status copy", () => {
  assert.match(source, /fileStatusLabel/);
  assert.match(source, /item\.fileInteraction === "modified"/);
  assert.match(source, /item\.fileInteraction === "opened"/);
});
```

**Step 2: Run the focused panel test and confirm failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/artifacts-panel.test.ts
```

Expected: FAIL because the panel does not render Modified/Opened groups yet.

**Step 3: Add localized labels**

Add keys:

```ts
"session.artifact_files_modified": "Modified",
"session.artifact_files_opened": "Opened",
```

Czech:

```ts
"session.artifact_files_modified": "Upravené",
"session.artifact_files_opened": "Otevřené",
```

Chinese can use:

```ts
"session.artifact_files_modified": "已修改",
"session.artifact_files_opened": "已打开",
```

**Step 4: Refactor file rendering in `ArtifactsPanel`**

Add row/group helpers:

```tsx
const fileStatusLabel = (item: ArtifactFamilyItem) => {
  if (item.fileInteraction === "modified") return tr("session.artifact_files_modified");
  if (item.fileInteraction === "opened") return tr("session.artifact_files_opened");
  return statusLabel(item.status);
};

const fileGroups = (family: ArtifactFamily) => [
  {
    id: "modified",
    label: tr("session.artifact_files_modified"),
    items: family.items.filter((item) => item.fileInteraction === "modified"),
    icon: FilePenLine,
  },
  {
    id: "opened",
    label: tr("session.artifact_files_opened"),
    items: family.items.filter((item) => item.fileInteraction === "opened"),
    icon: FileText,
  },
].filter((group) => group.items.length > 0);
```

Use Lucide icons from `lucide-solid`. If `FilePenLine` is unavailable in this version, use `FileEdit` or another existing Lucide file-edit icon after checking the package exports. Keep opened rows visually quieter than modified rows through the icon and status chip label, not through heavy color blocks.

For `family.family === "files"`, render:

```tsx
<For each={fileGroups(family)}>
  {(group) => (
    <div data-testid={`session-artifact-files-${group.id}`} class="space-y-1">
      <div class="flex items-center justify-between px-1 pt-1">
        <div class="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-9">
          <group.icon size={12} class="text-gray-9" />
          <span>{group.label}</span>
        </div>
        <span class="rounded bg-gray-3 px-1.5 text-[10px] font-medium text-gray-9">{group.items.length}</span>
      </div>
      <For each={group.items}>{(item) => renderArtifactRow(item)}</For>
    </div>
  )}
</For>
```

Extract the existing row JSX into a local `renderArtifactRow(item)` helper so non-file families keep the current layout and actions.

**Step 5: Run panel and i18n tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/artifacts-panel.test.ts
pnpm --filter @neatech/veslo-ui test:i18n
```

Expected: PASS.

**Step 6: Commit**

```bash
git add packages/app/src/app/components/session/artifacts-panel.tsx packages/app/src/app/components/session/artifacts-panel.test.ts packages/app/src/i18n/locales/en.ts packages/app/src/i18n/locales/cs.ts packages/app/src/i18n/locales/zh.ts
git commit -m "feat(app): group right menu files by modified and opened"
```

## Task 6: Add Desktop E2E Coverage

**Files:**
- Create: `packages/e2e/specs/session-artifacts.spec.ts`
- Modify: `packages/e2e/wdio.conf.ts`

**Step 1: Add the spec to WebdriverIO config**

Add to `defaultSpecs` near the other session specs:

```ts
'./specs/session-artifacts.spec.ts',
```

**Step 2: Create a seeded session spec**

Base the DB seeding helpers on `packages/e2e/specs/session-progress-grouping.spec.ts`. The seeded latest run should include:

- a user message that starts the run
- a `read` tool for `src/opened-only.ts`
- a `search` or `glob` tool mentioning `src/search-noise.ts`
- a `read` tool for `src/changed.ts`
- an `edit` tool for `src/changed.ts`
- a `skill` tool with title/sourceName `brainstorming`
- a `read` tool for `.opencode/skills/brainstorming/SKILL.md`
- final assistant text

Expected right menu body:

- contains `Modified`
- contains `Opened`
- contains `changed.ts`
- contains `opened-only.ts`
- contains `brainstorming`
- does not contain `search-noise.ts`
- does not contain `SKILL.md`

Use `data-testid="session-artifact-files-modified"` and `data-testid="session-artifact-files-opened"` for direct assertions.

**Step 3: Force the right menu visible**

Reuse the docked-sidebar local storage pattern from `session-capabilities.spec.ts`:

```ts
const SIDEBAR_DOCKED_VISIBILITY_KEY = "veslo.global.sidebar.docked.v1";

await browser.execute((key: string) => {
  window.localStorage.setItem(key, JSON.stringify({ left: true, right: true }));
}, SIDEBAR_DOCKED_VISIBILITY_KEY);
```

Then navigate to the seeded session and wait for the right menu artifacts panel.

**Step 4: Run desktop preflight**

From repo root:

```bash
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite.js|bun --watch src/cli\\.ts|/target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
pkill -f "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite.js|bun --watch src/cli\\.ts|/target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite.js|bun --watch src/cli\\.ts|/target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
```

If the first command shows a process that looks user-owned rather than internally started, stop and report instead of killing it.

**Step 5: Build and run the targeted desktop spec**

Run:

```bash
cd packages/desktop
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.dev.conf.json -- --features e2e

cd ../e2e
pnpm test --spec ./specs/session-artifacts.spec.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add packages/e2e/specs/session-artifacts.spec.ts packages/e2e/wdio.conf.ts
git commit -m "test(e2e): cover right menu file artifact grouping"
```

## Task 7: Update Durable Docs And Run Final Verification

**Files:**
- Modify: `docs/features/session-runtime.md`
- Test: all changed surfaces

**Step 1: Update durable behavior docs**

In the Artifacts section of `docs/features/session-runtime.md`, update the behavior to say:

- Files show only explicitly opened and modified files from the latest run.
- Modified files appear before opened files.
- Search/list/glob-only exploration does not create file rows.
- Skill usage is shown by skill name, not by `SKILL.md` path.

**Step 2: Run app and server verification**

Run from repo root:

```bash
pnpm typecheck
pnpm --filter veslo-server exec bun test src/session-artifacts.test.ts
pnpm --filter veslo-server build:bin
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/utils/tools.test.ts src/app/components/session/artifact-family-model.test.ts src/app/components/session/artifacts-panel.test.ts
pnpm --filter @neatech/veslo-ui test:i18n
```

Expected: PASS.

**Step 3: Run desktop E2E target**

Run the preflight from Task 6, then:

```bash
cd packages/desktop
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.dev.conf.json -- --features e2e

cd ../e2e
pnpm test --spec ./specs/session-artifacts.spec.ts
```

Expected: PASS.

**Step 4: Commit docs and any verification-aligned adjustments**

```bash
git add docs/features/session-runtime.md
git commit -m "docs: document right menu file artifact grouping"
```

If final verification required small code/test fixes, include them in a focused fix commit before the docs commit.

**Step 5: Final status**

Report:

- tests run and pass/fail status
- whether the server binary was rebuilt
- whether desktop E2E was run against Tauri
- any verification gaps

Do not include code/file references in the user-facing final answer unless explicitly requested.
