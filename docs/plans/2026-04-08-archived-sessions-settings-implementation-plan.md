# Archived Sessions Settings Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a cloud-synced archived sessions registry on the hosted Veslo Render server, show archived sessions in Settings across all workspaces, and let users unarchive sessions back into their original workspace/project bucket.

**Architecture:** Treat archive state as Veslo-managed per-user UI metadata stored on the hosted server, not as an OpenCode session mutation. The server owns archive CRUD and sorting; the app bootstraps that registry, filters sidebar rows from it, migrates legacy local archive IDs once, and renders a new settings section with availability detection and unarchive actions.

**Tech Stack:** Veslo server (`bun`, TypeScript, filesystem-backed JSON persistence), SolidJS app (`createSignal`, `createMemo`, JSX), Node test runner (`node --test --import=tsx/esm`), Bun test runner (`bun test`), Tauri desktop runtime, WebdriverIO e2e.

---

Execution notes:

- Apply `@using-git-worktrees` before the first code change.
- Apply `@test-driven-development` for each behavior change.
- Apply `@verification-before-completion` before claiming done.
- Follow `AGENTS.md` new feature workflow: sync remotes/submodules, use a worktree, start Docker dev stack, run desktop e2e, and capture screenshots.
- Treat the hosted Render deployment as the archive source of truth. Do not reintroduce `localStorage` as the owner of archive state.

Pre-flight commands:

```bash
git fetch --all --prune
git submodule update --init --recursive
git worktree add ../Veslo-archived-sessions-settings -b codex/archived-sessions-settings
cd ../Veslo-archived-sessions-settings
```

### Task 1: Lock The Archive Owner Identity Contract

**Files:**
- Modify: `packages/server/src/server.ts`
- Create: `packages/server/src/session-archives.test.ts`
- Test: `packages/server/src/session-archives.test.ts`

**Step 1: Write the failing test**

Create `session-archives.test.ts` with an explicit owner-key contract test that rejects archive requests without a stable per-user owner key and accepts a request-scoped account ID:

```ts
import { describe, expect, test } from "bun:test";
import { resolveArchiveOwnerKey } from "./server.js";

describe("resolveArchiveOwnerKey", () => {
  test("prefers a stable cloud account id over token hash", () => {
    expect(
      resolveArchiveOwnerKey({
        actor: { type: "remote", scope: "collaborator", clientId: "desktop-a", tokenHash: "tok_1" } as any,
        accountIdHeader: "usr_123",
      }),
    ).toBe("usr_123");
  });

  test("rejects archive ownership when no account id is present", () => {
    expect(() =>
      resolveArchiveOwnerKey({
        actor: { type: "remote", scope: "collaborator", clientId: "desktop-a", tokenHash: "tok_1" } as any,
        accountIdHeader: "",
      }),
    ).toThrow(/account id/i);
  });
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
cd packages/server
bun test src/session-archives.test.ts
```

Expected: FAIL because `resolveArchiveOwnerKey` does not exist yet.

**Step 3: Write minimal implementation**

In `server.ts`, add a small exported helper used only by archive routes:

```ts
export function resolveArchiveOwnerKey(input: {
  actor: Actor | null | undefined;
  accountIdHeader: string | null | undefined;
}): string {
  const accountId = (input.accountIdHeader ?? "").trim();
  if (accountId) return accountId;
  throw new ApiError(400, "account_id_required", "A stable cloud account id is required for session archive sync.");
}
```

Use a dedicated header name for the hosted contract, for example `x-veslo-account-id`.

**Step 4: Run test to verify it passes**

Run:

```bash
cd packages/server
bun test src/session-archives.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/server/src/server.ts packages/server/src/session-archives.test.ts
git commit -m "feat(server): require stable account identity for session archives"
```

### Task 2: Add Server Archive Registry Storage

**Files:**
- Create: `packages/server/src/session-archives.ts`
- Modify: `packages/server/src/types.ts`
- Modify: `packages/server/src/session-archives.test.ts`
- Test: `packages/server/src/session-archives.test.ts`

**Step 1: Write the failing test**

Extend `session-archives.test.ts` with persistence and ordering assertions:

```ts
import { createSessionArchiveStore } from "./session-archives.js";

test("archive store upserts and sorts records by archivedAt descending", async () => {
  const store = createSessionArchiveStore({ rootDir: tempDir });

  await store.put("usr_123", { sessionId: "sess_old", archivedAt: 100, titleSnapshot: "Old" } as any);
  await store.put("usr_123", { sessionId: "sess_new", archivedAt: 200, titleSnapshot: "New" } as any);

  const items = await store.list("usr_123");
  expect(items.map((item) => item.sessionId)).toEqual(["sess_new", "sess_old"]);
});

test("archive store delete is idempotent", async () => {
  const store = createSessionArchiveStore({ rootDir: tempDir });
  await store.delete("usr_123", "missing");
  expect(await store.list("usr_123")).toEqual([]);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
cd packages/server
bun test src/session-archives.test.ts
```

Expected: FAIL because the archive store module and types do not exist yet.

**Step 3: Write minimal implementation**

Create `session-archives.ts` as a filesystem-backed store under the Veslo server data dir:

```ts
export interface SessionArchiveRecord {
  sessionId: string;
  archivedAt: number;
  titleSnapshot: string;
  workspaceIdAtArchive?: string;
  workspaceLabelSnapshot?: string;
  resolvedDirectoryAtArchive?: string;
  projectRootAtArchive?: string;
  projectLabelSnapshot?: string;
  parentSessionId?: string | null;
  createdAtSnapshot?: number | null;
  updatedAtSnapshot?: number | null;
  workspaceIdentity?: string;
}

export function createSessionArchiveStore(input: { rootDir?: string }) {
  return {
    async list(ownerKey: string): Promise<SessionArchiveRecord[]> { /* read + sort desc */ },
    async put(ownerKey: string, record: SessionArchiveRecord): Promise<SessionArchiveRecord[]> { /* upsert */ },
    async delete(ownerKey: string, sessionId: string): Promise<SessionArchiveRecord[]> { /* remove */ },
  };
}
```

Store one JSON file per owner key, for example `.veslo/veslo-server/session-archives/<owner>.json`.

**Step 4: Run test to verify it passes**

Run:

```bash
cd packages/server
bun test src/session-archives.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/server/src/session-archives.ts packages/server/src/types.ts packages/server/src/session-archives.test.ts
git commit -m "feat(server): persist session archive records"
```

### Task 3: Expose Hosted Archive CRUD Routes

**Files:**
- Modify: `packages/server/src/server.ts`
- Modify: `packages/server/src/session-archives.test.ts`
- Test: `packages/server/src/session-archives.test.ts`

**Step 1: Write the failing test**

Add source-contract assertions for the new routes:

```ts
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./server.ts", import.meta.url), "utf8");

test("server exposes global session archive routes", () => {
  expect(source).toMatch(/"GET",\s*"\/session-archives"/);
  expect(source).toMatch(/"PUT",\s*"\/session-archives\/:sessionId"/);
  expect(source).toMatch(/"DELETE",\s*"\/session-archives\/:sessionId"/);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
cd packages/server
bun test src/session-archives.test.ts
```

Expected: FAIL because the routes are not registered yet.

**Step 3: Write minimal implementation**

In `server.ts`, wire the archive store into three global client routes:

```ts
addRoute(routes, "GET", "/session-archives", "client", async (ctx) => {
  const ownerKey = resolveArchiveOwnerKey({
    actor: ctx.actor,
    accountIdHeader: ctx.request.headers.get("x-veslo-account-id"),
  });
  return jsonResponse({ items: await sessionArchives.list(ownerKey) });
});

addRoute(routes, "PUT", "/session-archives/:sessionId", "client", async (ctx) => {
  const ownerKey = resolveArchiveOwnerKey({ actor: ctx.actor, accountIdHeader: ctx.request.headers.get("x-veslo-account-id") });
  const body = await readJsonBody(ctx.request);
  return jsonResponse({ items: await sessionArchives.put(ownerKey, { sessionId: ctx.params.sessionId, ...body } as any) });
});

addRoute(routes, "DELETE", "/session-archives/:sessionId", "client", async (ctx) => {
  const ownerKey = resolveArchiveOwnerKey({ actor: ctx.actor, accountIdHeader: ctx.request.headers.get("x-veslo-account-id") });
  return jsonResponse({ items: await sessionArchives.delete(ownerKey, ctx.params.sessionId) });
});
```

Require collaborator-or-higher client scope for writes.

**Step 4: Run test to verify it passes**

Run:

```bash
cd packages/server
bun test src/session-archives.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/server/src/server.ts packages/server/src/session-archives.test.ts
git commit -m "feat(server): add session archive routes"
```

### Task 4: Add App Client Methods And Archive Model Helpers

**Files:**
- Modify: `packages/app/src/app/lib/veslo-server.ts`
- Create: `packages/app/src/app/lib/session-archive-model.ts`
- Create: `packages/app/src/app/lib/session-archive-model.test.ts`
- Modify: `packages/app/src/app/lib/veslo-server.test.ts`
- Test: `packages/app/src/app/lib/session-archive-model.test.ts`

**Step 1: Write the failing test**

Create `session-archive-model.test.ts` covering availability and snapshot building:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { buildSessionArchiveSnapshot, matchArchiveAvailability } from "./session-archive-model.js";

test("buildSessionArchiveSnapshot uses the resolved session directory", () => {
  const snapshot = buildSessionArchiveSnapshot({
    session: { id: "sess_1", title: "Draft", directory: "/tmp/original" } as any,
    resolvedDirectory: "/repo/final",
    workspace: { id: "ws_1", displayName: "Repo", path: "/repo", workspaceType: "local" } as any,
    projectRoot: "/repo/final",
    projectLabel: "final",
  });

  assert.equal(snapshot.resolvedDirectoryAtArchive, "/repo/final");
  assert.equal(snapshot.projectRootAtArchive, "/repo/final");
});

test("matchArchiveAvailability marks unmatched local archives unavailable on this device", () => {
  const result = matchArchiveAvailability(
    { workspaceIdentity: "local::/repo/final", resolvedDirectoryAtArchive: "/repo/final" } as any,
    [{ id: "ws_2", path: "/other", workspaceType: "local" } as any],
  );

  assert.equal(result.availableOnThisDevice, false);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
cd packages/app
node --test --import=tsx/esm src/app/lib/session-archive-model.test.ts
```

Expected: FAIL because the archive model helper does not exist yet.

**Step 3: Write minimal implementation**

Create `session-archive-model.ts` and extend `veslo-server.ts` with new client calls:

```ts
export function buildSessionArchiveSnapshot(input: { /* session + resolved workspace context */ }) {
  return {
    sessionId: input.session.id,
    archivedAt: Date.now(),
    titleSnapshot: input.session.title ?? "",
    resolvedDirectoryAtArchive: input.resolvedDirectory,
    projectRootAtArchive: input.projectRoot,
    workspaceIdentity: /* local or remote identity string */,
  };
}

export function matchArchiveAvailability(record: SessionArchiveRecord, workspaces: WorkspaceInfo[]) {
  return { availableOnThisDevice: /* boolean */, matchedWorkspaceId: /* string | null */ };
}
```

And in `veslo-server.ts`:

```ts
listSessionArchives: () => requestJson<{ items: VesloSessionArchiveRecord[] }>(baseUrl, "/session-archives", { token, hostToken }),
putSessionArchive: (sessionId: string, body: VesloSessionArchiveWriteInput) =>
  requestJson<{ items: VesloSessionArchiveRecord[] }>(baseUrl, `/session-archives/${encodeURIComponent(sessionId)}`, { token, hostToken, method: "PUT", body }),
deleteSessionArchive: (sessionId: string) =>
  requestJson<{ items: VesloSessionArchiveRecord[] }>(baseUrl, `/session-archives/${encodeURIComponent(sessionId)}`, { token, hostToken, method: "DELETE" }),
```

Thread `x-veslo-account-id` from authenticated Den state for hosted archive calls.

**Step 4: Run test to verify it passes**

Run:

```bash
cd packages/app
node --test --import=tsx/esm src/app/lib/session-archive-model.test.ts src/app/lib/veslo-server.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/lib/veslo-server.ts packages/app/src/app/lib/veslo-server.test.ts packages/app/src/app/lib/session-archive-model.ts packages/app/src/app/lib/session-archive-model.test.ts
git commit -m "feat(app): add cloud session archive client and model helpers"
```

### Task 5: Replace Sidebar Archive Ownership With Cloud State

**Files:**
- Modify: `packages/app/src/app/app.tsx`
- Modify: `packages/app/src/app/components/session/workspace-session-list.tsx`
- Modify: `packages/app/src/app/components/session/workspace-session-list-prefs.ts`
- Modify: `packages/app/src/app/components/session/workspace-session-list-prefs.test.ts`
- Modify: `packages/app/src/app/components/session/workspace-session-list-interactions.test.ts`
- Modify: `packages/app/src/app/components/session/workspace-session-list-recent-layout.test.ts`
- Test: `packages/app/src/app/components/session/workspace-session-list-interactions.test.ts`

**Step 1: Write the failing test**

Update sidebar tests so archive behavior depends on cloud handlers, not local archive ID persistence:

```ts
test("archive action no longer persists archived session ids in local prefs", () => {
  assert.doesNotMatch(source, /readArchivedSessionIds/);
  assert.doesNotMatch(source, /writeArchivedSessionIds/);
});

test("archive action calls the provided archive callback after confirmation", () => {
  assert.match(source, /props\.onArchiveSession\?/);
  assert.match(source, /props\.onUnarchiveSession\?/);
});
```

In `workspace-session-list-prefs.test.ts`, delete or rewrite the archived-ID expectations so only `show archived` remains local.

**Step 2: Run test to verify it fails**

Run:

```bash
cd packages/app
node --test --import=tsx/esm \
  src/app/components/session/workspace-session-list-prefs.test.ts \
  src/app/components/session/workspace-session-list-interactions.test.ts \
  src/app/components/session/workspace-session-list-recent-layout.test.ts
```

Expected: FAIL because the sidebar still owns archived IDs through local storage.

**Step 3: Write minimal implementation**

In `app.tsx`, add a cloud-backed archive map and archive/unarchive handlers:

```ts
const [sessionArchivesById, setSessionArchivesById] = createSignal<Record<string, VesloSessionArchiveRecord>>({});

const archiveSession = async (row: FlatSessionRow) => {
  const snapshot = buildSessionArchiveSnapshot({ /* row + resolved directory */ });
  const result = await vesloClient()?.putSessionArchive(row.session.id, snapshot);
  setSessionArchivesById(indexBySessionId(result?.items ?? []));
};

const unarchiveSession = async (sessionId: string) => {
  const result = await vesloClient()?.deleteSessionArchive(sessionId);
  setSessionArchivesById(indexBySessionId(result?.items ?? []));
};
```

Pass the archive map and handlers into `workspace-session-list.tsx`. Keep `show archived` local, but remove `readArchivedSessionIds` and `writeArchivedSessionIds` from prefs and UI logic.

**Step 4: Run test to verify it passes**

Run:

```bash
cd packages/app
node --test --import=tsx/esm \
  src/app/components/session/workspace-session-list-prefs.test.ts \
  src/app/components/session/workspace-session-list-interactions.test.ts \
  src/app/components/session/workspace-session-list-recent-layout.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/app.tsx packages/app/src/app/components/session/workspace-session-list.tsx packages/app/src/app/components/session/workspace-session-list-prefs.ts packages/app/src/app/components/session/workspace-session-list-prefs.test.ts packages/app/src/app/components/session/workspace-session-list-interactions.test.ts packages/app/src/app/components/session/workspace-session-list-recent-layout.test.ts
git commit -m "feat(sidebar): back session archive state with cloud registry"
```

### Task 6: Add Archived Sessions To Settings

**Files:**
- Modify: `packages/app/src/app/pages/settings.tsx`
- Modify: `packages/app/src/app/types.ts`
- Create: `packages/app/src/app/pages/settings-archived-sessions.test.ts`
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/cs.ts`
- Modify: `packages/app/src/i18n/locales/zh.ts`
- Test: `packages/app/src/app/pages/settings-archived-sessions.test.ts`

**Step 1: Write the failing test**

Create `settings-archived-sessions.test.ts` as a source-contract test:

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./settings.tsx", import.meta.url), "utf8");

test("settings renders a dedicated archived sessions section", () => {
  assert.match(source, /settings\.archived_sessions_label/);
  assert.match(source, /props\.sessionArchives/);
});

test("settings keeps unarchive available for unavailable devices", () => {
  assert.match(source, /settings\.archived_sessions_unavailable_on_device/);
  assert.match(source, /props\.onUnarchiveSession/);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
cd packages/app
node --test --import=tsx/esm src/app/pages/settings-archived-sessions.test.ts
```

Expected: FAIL because settings has no archived sessions section yet.

**Step 3: Write minimal implementation**

Extend settings props and render the new section:

```tsx
<div class="bg-gray-2/30 border border-gray-7/60 rounded-2xl p-5 space-y-4">
  <div>
    <div class="text-sm font-medium text-gray-12">{translate("settings.archived_sessions_label")}</div>
    <div class="text-xs text-gray-9">{translate("settings.archived_sessions_description")}</div>
  </div>

  <For each={props.sessionArchives}>
    {(archive) => (
      <div class="rounded-xl border border-gray-6/60 bg-gray-1/40 px-3 py-3">
        <div class="text-sm font-medium text-gray-12">{archive.title}</div>
        <Show when={!archive.availableOnThisDevice}>
          <div class="text-xs text-amber-11">{translate("settings.archived_sessions_unavailable_on_device")}</div>
        </Show>
        <Button variant="outline" onClick={() => void props.onUnarchiveSession(archive.sessionId)}>
          {translate("settings.archived_sessions_unarchive")}
        </Button>
      </div>
    )}
  </For>
</div>
```

Sort the incoming list by `archivedAt desc` before rendering.

**Step 4: Run test to verify it passes**

Run:

```bash
cd packages/app
node --test --import=tsx/esm src/app/pages/settings-archived-sessions.test.ts src/app/pages/settings-technical-details.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/pages/settings.tsx packages/app/src/app/pages/settings-archived-sessions.test.ts packages/app/src/app/types.ts packages/app/src/i18n/locales/en.ts packages/app/src/i18n/locales/cs.ts packages/app/src/i18n/locales/zh.ts
git commit -m "feat(settings): add archived sessions section"
```

### Task 7: Migrate Legacy Local Archive IDs Once

**Files:**
- Modify: `packages/app/src/app/app.tsx`
- Modify: `packages/app/src/app/lib/session-archive-model.ts`
- Modify: `packages/app/src/app/lib/session-archive-model.test.ts`
- Test: `packages/app/src/app/lib/session-archive-model.test.ts`

**Step 1: Write the failing test**

Add a migration test:

```ts
test("buildLegacyArchiveMigration preserves stored order with synthetic archivedAt timestamps", () => {
  const result = buildLegacyArchiveMigration(["sess_a", "sess_b", "sess_c"], 5000);
  assert.deepEqual(result.map((item) => item.sessionId), ["sess_a", "sess_b", "sess_c"]);
  assert.ok(result[0]!.archivedAt > result[1]!.archivedAt);
  assert.ok(result[1]!.archivedAt > result[2]!.archivedAt);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
cd packages/app
node --test --import=tsx/esm src/app/lib/session-archive-model.test.ts
```

Expected: FAIL because the migration helper does not exist yet.

**Step 3: Write minimal implementation**

Add a one-shot migration helper and bootstrap call in `app.tsx`:

```ts
export function buildLegacyArchiveMigration(sessionIds: string[], now = Date.now()) {
  return sessionIds.map((sessionId, index) => ({
    sessionId,
    archivedAt: now - index,
  }));
}
```

In app bootstrap:

```ts
const legacyArchivedIds = readArchivedSessionIds(window.localStorage);
if (cloudItems.length === 0 && legacyArchivedIds.length > 0) {
  for (const item of buildLegacyArchiveMigration(legacyArchivedIds)) {
    await vesloClient()?.putSessionArchive(item.sessionId, item);
  }
  writeArchivedSessionIds([], window.localStorage);
}
```

Keep the local key only for migration and for the separate `show archived` toggle.

**Step 4: Run test to verify it passes**

Run:

```bash
cd packages/app
node --test --import=tsx/esm src/app/lib/session-archive-model.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/app.tsx packages/app/src/app/lib/session-archive-model.ts packages/app/src/app/lib/session-archive-model.test.ts
git commit -m "feat(app): migrate legacy archived session ids to cloud"
```

### Task 8: Desktop E2E, Docker Flow, And Screenshots

**Files:**
- Create: `packages/e2e/specs/settings-archived-sessions.spec.ts`
- Create: `packages/app/pr/screenshots/settings-archived-sessions.png`
- Test: `packages/e2e/specs/settings-archived-sessions.spec.ts`

**Step 1: Write the failing test**

Create a new WebdriverIO spec that covers:

```ts
describe("settings archived sessions", () => {
  it("shows archived sessions across workspaces and allows unarchive with unavailable-device status", async () => {
    // archive a session from sidebar
    // open Settings
    // assert archived session row appears first by archivedAt
    // assert unavailable-device label is visible when workspace is missing locally
    // click Unarchive
    // assert session disappears from archived list and returns to normal sidebar bucket when available
  });
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
./packaging/docker/dev-up.sh
cd packages/desktop
pnpm tauri build --debug --no-bundle -- --features e2e
cd ../e2e
pnpm test --spec ./specs/settings-archived-sessions.spec.ts
```

Expected: FAIL because the feature is not fully wired yet.

**Step 3: Write minimal implementation**

Finish any missing wiring discovered by the e2e run, then capture a screenshot after the flow passes:

```bash
mkdir -p packages/app/pr/screenshots
# Save the verified screenshot as:
# packages/app/pr/screenshots/settings-archived-sessions.png
```

Also run the Docker + Chrome MCP walkthrough required by `AGENTS.md` against the real desktop runtime.

**Step 4: Run test to verify it passes**

Run:

```bash
./packaging/docker/dev-up.sh
cd packages/desktop
pnpm tauri build --debug --no-bundle -- --features e2e
cd ../e2e
pnpm test --spec ./specs/settings-archived-sessions.spec.ts
```

Expected: PASS. Keep the screenshot in the repo for PR/review context.

**Step 5: Commit**

```bash
git add packages/e2e/specs/settings-archived-sessions.spec.ts packages/app/pr/screenshots/settings-archived-sessions.png
git commit -m "test(e2e): cover archived sessions settings flow"
```

### Task 9: Final Verification Gate

**Files:**
- Test: `packages/server/src/session-archives.test.ts`
- Test: `packages/app/src/app/lib/session-archive-model.test.ts`
- Test: `packages/app/src/app/components/session/workspace-session-list-interactions.test.ts`
- Test: `packages/app/src/app/pages/settings-archived-sessions.test.ts`
- Test: `packages/e2e/specs/settings-archived-sessions.spec.ts`

**Step 1: Run focused server tests**

Run:

```bash
cd packages/server
bun test src/session-archives.test.ts
```

Expected: PASS.

**Step 2: Run focused app tests**

Run:

```bash
cd packages/app
node --test --import=tsx/esm \
  src/app/lib/session-archive-model.test.ts \
  src/app/components/session/workspace-session-list-prefs.test.ts \
  src/app/components/session/workspace-session-list-interactions.test.ts \
  src/app/components/session/workspace-session-list-recent-layout.test.ts \
  src/app/pages/settings-archived-sessions.test.ts
```

Expected: PASS.

**Step 3: Run broader static checks**

Run:

```bash
pnpm --filter veslo-server typecheck
pnpm --filter @neatech/veslo-ui typecheck
cd packages/app
pnpm test:unit
```

Expected: PASS. If a pre-existing failure appears, capture the exact failing command and test names before proceeding.

**Step 4: Run the required desktop runtime verification**

Run:

```bash
./packaging/docker/dev-up.sh
cd packages/desktop
pnpm tauri build --debug --no-bundle -- --features e2e
cd ../e2e
pnpm test --spec ./specs/settings-archived-sessions.spec.ts
```

Expected: PASS against the real Tauri desktop runtime. Reuse an already-running WebDriver app instance when `http://127.0.0.1:4445/status` is healthy.

**Step 5: Commit verification-only changes if any**

```bash
git status --short
git add <only files changed during verification>
git commit -m "test: verify archived sessions settings flow"
```

If verification produces no file changes, skip this commit.

## Acceptance Gate

1. Archive state is stored on the hosted Veslo server, not in local archive IDs.
2. Settings shows archived sessions across all workspaces sorted by `archivedAt desc`.
3. Unarchive is available even when the workspace is unavailable on the current device.
4. Unarchiving returns the session to its original workspace/project bucket when that bucket is available locally.
5. Sessions moved via `Choose folder` archive against their resolved directory, not stale engine metadata.
6. Legacy local archive IDs migrate once into the cloud registry and stop acting as source of truth.
7. Server, app, and desktop e2e verification all pass.
