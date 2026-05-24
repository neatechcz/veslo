# Temporary Sessions as Chats Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Present existing temporary/private-folder sessions as chats in the project-grouped sidebar and session titlebar without changing backend session semantics.

**Architecture:** Keep the runtime model unchanged and classify chats from the existing private workspace path predicate. Add small sidebar model helpers for splitting private sessions from project groups and for resolving chat labels, then wire those helpers into the Solid sidebar and titlebar. The Recent view remains the existing unified activity list.

**Tech Stack:** SolidJS, TypeScript, node:test with tsx/esm, Tauri desktop runtime for final manual verification.

---

### Task 1: Add Sidebar Chat Model Helpers

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list-model.ts`
- Test: `packages/app/src/app/components/session/workspace-session-list-model.test.ts`

**Step 1: Write the failing tests**

Append focused model tests near the existing private workspace group tests:

```ts
test("splitProjectGroupsForSidebar separates private chat group from project groups", () => {
  const privateRoot = "/Users/test/.veslo/private-workspaces";
  const isPrivateWorkspacePath = (folder: string | null | undefined) =>
    typeof folder === "string" && folder.startsWith(privateRoot);

  const groups = buildProjectGroups(
    [
      {
        workspace: {
          id: "chat-a",
          name: "Private workspace",
          path: `${privateRoot}/chat-a`,
          preset: "starter",
          workspaceType: "local" as const,
        },
        sessions: [
          {
            id: "chat-session",
            title: "Plan weekend",
            directory: `${privateRoot}/chat-a`,
            time: { created: 100, updated: 200 },
          },
        ],
        status: "ready",
      },
      {
        workspace: {
          id: "project-a",
          name: "Project A",
          path: "/Users/test/projects/project-a",
          preset: "starter",
          workspaceType: "local" as const,
        },
        sessions: [
          {
            id: "project-session",
            title: "Implement feature",
            directory: "/Users/test/projects/project-a",
            time: { created: 90, updated: 190 },
          },
        ],
        status: "ready",
      },
    ],
    isPrivateWorkspacePath,
  );

  const split = splitProjectGroupsForSidebar(groups);

  assert.equal(split.chatGroup?.key, PRIVATE_PROJECT_GROUP_KEY);
  assert.deepEqual(split.projectGroups.map((group) => group.key), ["/Users/test/projects/project-a"]);
});

test("sessionChatLabel prefers title, then slug, then Chat fallback", () => {
  assert.equal(sessionChatLabel({ id: "one", title: "  Research trip  " }, "Chat"), "Research trip");
  assert.equal(sessionChatLabel({ id: "two", title: "", slug: "draft-chat" }, "Chat"), "draft-chat");
  assert.equal(sessionChatLabel({ id: "three", title: "", slug: "" }, "Chat"), "Chat");
});
```

Update the import list to include the new helpers:

```ts
import {
  PRIVATE_PROJECT_GROUP_KEY,
  buildProjectGroups,
  sessionChatLabel,
  splitProjectGroupsForSidebar,
} from "./workspace-session-list-model.js";
```

**Step 2: Run the model test and verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/workspace-session-list-model.test.ts
```

Expected: FAIL because `splitProjectGroupsForSidebar` and `sessionChatLabel` are not exported yet.

**Step 3: Implement the minimal model helpers**

Add the helpers below the `ProjectSessionGroup` type:

```ts
export type SidebarProjectGroupSplit = {
  projectGroups: ProjectSessionGroup[];
  chatGroup: ProjectSessionGroup | null;
};

export const isPrivateChatProjectGroup = (group: ProjectSessionGroup) =>
  group.key === PRIVATE_PROJECT_GROUP_KEY || group.isPrivateProject;

export const splitProjectGroupsForSidebar = (
  groups: ProjectSessionGroup[],
): SidebarProjectGroupSplit => {
  const projectGroups: ProjectSessionGroup[] = [];
  let chatGroup: ProjectSessionGroup | null = null;

  for (const group of groups) {
    if (isPrivateChatProjectGroup(group)) {
      chatGroup = chatGroup
        ? {
            ...chatGroup,
            sessions: [...chatGroup.sessions, ...group.sessions],
            activityAt: Math.max(chatGroup.activityAt, group.activityAt),
            status: chatGroup.status === "error" ? chatGroup.status : group.status,
            error: chatGroup.error ?? group.error,
          }
        : group;
      continue;
    }
    projectGroups.push(group);
  }

  return { projectGroups, chatGroup };
};

export const sessionChatLabel = (
  session: Pick<WorkspaceSessionGroup["sessions"][number], "title" | "slug">,
  fallback: string,
) => session.title?.trim() || session.slug?.trim() || fallback;
```

**Step 4: Run the model test and verify it passes**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/workspace-session-list-model.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/components/session/workspace-session-list-model.ts packages/app/src/app/components/session/workspace-session-list-model.test.ts
git commit -m "feat: classify private sessions as chats"
```

### Task 2: Update Titlebar Context For Private Chats

**Files:**
- Modify: `packages/app/src/app/pages/session-titlebar-context.ts`
- Modify: `packages/app/src/app/pages/session.tsx`
- Test: `packages/app/src/app/pages/session-titlebar-context.test.ts`

**Step 1: Write the failing titlebar tests**

Add tests after the existing private new-session test:

```ts
test("selected private chat shows chat title instead of private directory", () => {
  const context = resolveSessionTitlebarContext({
    selectedSessionId: "ses_chat",
    selectedSessionTitle: "Plan weekend",
    messageCount: 2,
    workspaceType: "local",
    activeWorkspaceRoot: "/Users/example/.veslo/private-workspaces/chat-a",
    localWorkspaceLabel: "Local workspace",
    remoteWorkspaceLabel: "Remote workspace",
    newSessionLabel: "Chat",
    chatFallbackLabel: "Chat",
    isPrivateWorkspacePath: true,
  });

  assert.deepEqual(context, {
    stateLabel: "Plan weekend",
    locationLabel: null,
    locationTitle: null,
    locationUsePathStyle: false,
  });
});

test("selected private chat falls back to Chat label", () => {
  const context = resolveSessionTitlebarContext({
    selectedSessionId: "ses_chat",
    selectedSessionTitle: "",
    messageCount: 1,
    workspaceType: "local",
    activeWorkspaceRoot: "/Users/example/.veslo/private-workspaces/chat-a",
    localWorkspaceLabel: "Local workspace",
    remoteWorkspaceLabel: "Remote workspace",
    newSessionLabel: "Chat",
    chatFallbackLabel: "Chat",
    isPrivateWorkspacePath: true,
  });

  assert.equal(context?.stateLabel, "Chat");
  assert.equal(context?.locationLabel, null);
});
```

Update existing calls in this test file to pass `chatFallbackLabel: "Chat"`.

**Step 2: Run the titlebar test and verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/session-titlebar-context.test.ts
```

Expected: FAIL because `selectedSessionTitle` and `chatFallbackLabel` are not part of the model yet.

**Step 3: Implement titlebar model changes**

Extend `SessionTitlebarContextInput`:

```ts
  selectedSessionTitle?: string | null;
  chatFallbackLabel: string;
```

Update `resolveSessionTitlebarContext` so private roots hide location for both new drafts and selected sessions:

```ts
  const isPrivateWorkspace = !isRemoteWorkspace && input.isPrivateWorkspacePath === true;
  const privateChatLabel =
    input.selectedSessionTitle?.trim() ||
    input.chatFallbackLabel.trim() ||
    input.newSessionLabel.trim() ||
    null;
  const stateLabel = isPrivateWorkspace
    ? (isNewSession ? input.newSessionLabel.trim() || privateChatLabel : privateChatLabel)
    : isNewSession
    ? input.newSessionLabel.trim() || null
    : null;
  const hideLocalLocation = !isRemoteWorkspace && (!rootPath || isPrivateWorkspace);
```

Keep the existing project-session behavior unchanged when `isPrivateWorkspacePath` is false.

**Step 4: Wire selected chat title in the session page**

In `packages/app/src/app/pages/session.tsx`, move or add a helper before `sessionTitlebarContextModel`:

```ts
  const selectedSessionSidebarItem = createMemo(() => {
    const id = props.selectedSessionId?.trim() ?? "";
    if (!id) return null;
    for (const group of props.workspaceSessionGroups) {
      const match = group.sessions.find((session) => session.id === id);
      if (match) return match;
    }
    return null;
  });
```

Pass the title and new copy into `resolveSessionTitlebarContext`:

```ts
      selectedSessionTitle: selectedSessionSidebarItem()?.title ?? null,
      newSessionLabel: tr("session.new_session_label"),
      chatFallbackLabel: tr("session.new_session_label"),
```

If `sessionTitleById` later in the file duplicates this lookup, update it to use the same helper when possible.

**Step 5: Run the titlebar test and verify it passes**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/session-titlebar-context.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add packages/app/src/app/pages/session-titlebar-context.ts packages/app/src/app/pages/session-titlebar-context.test.ts packages/app/src/app/pages/session.tsx
git commit -m "feat: show chat titles in session titlebar"
```

### Task 3: Add Chat Copy And Update Copy Tests

**Files:**
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/cs.ts`
- Modify: `packages/app/src/i18n/locales/zh.ts`
- Modify: `packages/app/src/app/components/session/workspace-session-list-localization.test.ts`
- Modify: `packages/app/src/app/components/session/workspace-session-list-controls-tooltips.test.ts`
- Modify: `packages/app/src/app/components/session/workspace-session-list-layout.test.ts`

**Step 1: Write failing localization/source tests**

Extend `workspace-session-list-localization.test.ts`:

```ts
assert.match(source, /"sidebar\.chat":/);
assert.match(source, /"sidebar\.chats":/);
assert.match(source, /"sidebar\.new_chat":/);
assert.match(source, /"session\.chat_label":/);
```

Update tooltip/layout tests to expect `sidebar.new_chat` or `sidebar.chat` instead of `sidebar.new_session` for the primary private-session button.

**Step 2: Run the focused tests and verify they fail**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/components/session/workspace-session-list-localization.test.ts \
  src/app/components/session/workspace-session-list-controls-tooltips.test.ts \
  src/app/components/session/workspace-session-list-layout.test.ts
```

Expected: FAIL because the keys and source references are not updated yet.

**Step 3: Add locale keys**

Add keys to all three locale files:

```ts
"sidebar.chat": "Chat",
"sidebar.chats": "Chats",
"sidebar.new_chat": "Chat",
"session.chat_label": "Chat",
```

Use Czech copy:

```ts
"sidebar.chat": "Chat",
"sidebar.chats": "Chaty",
"sidebar.new_chat": "Chat",
"session.chat_label": "Chat",
```

Use Chinese copy consistent with existing locale style, for example:

```ts
"sidebar.chat": "聊天",
"sidebar.chats": "聊天",
"sidebar.new_chat": "聊天",
"session.chat_label": "聊天",
```

**Step 4: Update sidebar source references**

In `workspace-session-list.tsx`, change the primary private-session button tooltip and screen-reader label from `sidebar.new_session` to `sidebar.new_chat`. Change the visible compact/expanded label helper to return `sidebar.chat` instead of `sidebar.new`/`sidebar.new_session`.

In `session.tsx`, update the `resolveSessionTitlebarContext` call from `session.new_session_label` to `session.chat_label` for both `newSessionLabel` and `chatFallbackLabel`.

**Step 5: Run the focused tests and verify they pass**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/components/session/workspace-session-list-localization.test.ts \
  src/app/components/session/workspace-session-list-controls-tooltips.test.ts \
  src/app/components/session/workspace-session-list-layout.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add packages/app/src/i18n/locales/en.ts packages/app/src/i18n/locales/cs.ts packages/app/src/i18n/locales/zh.ts packages/app/src/app/components/session/workspace-session-list-localization.test.ts packages/app/src/app/components/session/workspace-session-list-controls-tooltips.test.ts packages/app/src/app/components/session/workspace-session-list-layout.test.ts packages/app/src/app/components/session/workspace-session-list.tsx
git commit -m "feat: rename private session action to chat"
```

### Task 4: Render Bottom-Anchored Chat Section In By-Project Mode

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list.tsx`
- Modify: `packages/app/src/app/components/session/workspace-session-list-prefetch.test.ts`
- Modify: `packages/app/src/app/components/session/workspace-session-list-layout.test.ts`
- Test: `packages/app/src/app/components/session/workspace-session-list-model.test.ts`

**Step 1: Write failing source tests for the chat section**

Add source-level assertions to `workspace-session-list-layout.test.ts`:

```ts
test("by-project sidebar renders private chats as a bottom section", () => {
  assert.match(source, /splitProjectGroupsForSidebar/);
  assert.match(source, /data-sidebar-chat-section="true"/);
  assert.match(source, /tr\("sidebar\.chats"\)/);
  assert.match(source, /tr\("sidebar\.new_chat"\)/);
});
```

Update `workspace-session-list-prefetch.test.ts` so the loaded-interest rows still come from all by-project rows, not only the normal project list:

```ts
assert.match(
  source,
  /const currentRows = sidebarMode\(\) === "by-project" \? visibleProjectRows\(\) : recentRowsVisible\(\);/,
);
assert.match(source, /allProjectModeGroups/);
```

**Step 2: Run the focused sidebar tests and verify they fail**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/components/session/workspace-session-list-layout.test.ts \
  src/app/components/session/workspace-session-list-prefetch.test.ts
```

Expected: FAIL because the section does not exist yet.

**Step 3: Split render groups in the component**

Import the new helpers:

```ts
  sessionChatLabel,
  splitProjectGroupsForSidebar,
```

Replace direct by-project rendering memo usage with split memos:

```ts
  const allProjectModeGroups = createMemo(() => renderProjectGroups());
  const projectSidebarSplit = createMemo(() => splitProjectGroupsForSidebar(allProjectModeGroups()));
  const normalProjectGroups = createMemo(() => projectSidebarSplit().projectGroups);
  const chatProjectGroup = createMemo(() => projectSidebarSplit().chatGroup);
```

Update calculations that must include chat rows:

```ts
  const projectRowsLoaded = createMemo<FlatSessionRow[]>(() => {
    const expandedParentIds = expandedParentSessionIds();
    return allProjectModeGroups().flatMap((group) => {
      const projectHierarchy = buildRowHierarchyLookup(group.sessions);
      return group.sessions.filter((row) =>
        rowVisibleByExpansion(row, projectHierarchy, expandedParentIds),
      );
    });
  });
```

Use `allProjectModeGroups()` in `visibleProjectRows`, `ensureExpandedSessionChildrenVisible`, and loaded prefetch interest. Use `normalProjectGroups()` only for the normal project list `For`.

Update `hasVisibleRows`:

```ts
  const hasVisibleRows = createMemo(() =>
    sidebarMode() === "by-project"
      ? normalProjectGroups().length > 0 || Boolean(chatProjectGroup())
      : recentRowsTreeVisible().length > 0,
  );
```

**Step 4: Render the bottom chat section**

Keep the existing scroll container for normal rows. After it, add:

```tsx
      <Show when={sidebarMode() === "by-project" && chatProjectGroup()}>
        {(chatGroup) => (
          <div
            data-sidebar-chat-section="true"
            class="mt-2 shrink-0 border-t border-gray-6/70 pt-2"
          >
            <div class="mb-1 flex items-center justify-between gap-2 px-1.5">
              <span class="truncate text-[12px] font-semibold text-gray-10">
                {tr("sidebar.chats")}
              </span>
              <button
                type="button"
                class="inline-flex h-7 items-center gap-1 rounded-full border border-gray-6 bg-gray-1 px-2 text-[11px] font-medium text-gray-11 shadow-sm transition-colors hover:bg-gray-2 disabled:cursor-not-allowed disabled:opacity-60"
                onClick={() => props.onQuickNewSession?.()}
                disabled={!props.onQuickNewSession || props.newTaskDisabled}
                aria-label={tr("sidebar.new_chat")}
                title={tr("sidebar.new_chat")}
              >
                <Plus size={12} />
                <span>{tr("sidebar.chat")}</span>
              </button>
            </div>
            <div class="max-h-[min(40vh,18rem)] overflow-y-auto pr-1">
              {/* Render chatGroup().sessions with the same session row behavior as project rows. */}
            </div>
          </div>
        )}
      </Show>
```

Extract a small local row renderer if needed to avoid duplicating archive, selected, active, expansion, and timestamp behavior between project rows and chat rows. The chat row label should call:

```ts
sessionChatLabel(row.session, tr("session.chat_label"))
```

Do not render project workspace controls or workspace menu in the chat section.

**Step 5: Run focused sidebar tests and verify they pass**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/components/session/workspace-session-list-layout.test.ts \
  src/app/components/session/workspace-session-list-prefetch.test.ts \
  src/app/components/session/workspace-session-list-model.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add packages/app/src/app/components/session/workspace-session-list.tsx packages/app/src/app/components/session/workspace-session-list-layout.test.ts packages/app/src/app/components/session/workspace-session-list-prefetch.test.ts packages/app/src/app/components/session/workspace-session-list-model.test.ts
git commit -m "feat: show private sessions in chat section"
```

### Task 5: Preserve Recent Mode And Row Behavior

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list-model.test.ts`
- Modify: `packages/app/src/app/components/session/workspace-session-list-recent-layout.test.ts`
- Modify: `packages/app/src/app/components/session/workspace-session-list-interactions.test.ts`

**Step 1: Add failing regression tests**

Add or update tests to assert:

```ts
test("buildRecentRows keeps private chat sessions mixed with project sessions by activity", () => {
  const privateRoot = "/Users/test/.veslo/private-workspaces";
  const isPrivateWorkspacePath = (folder: string | null | undefined) =>
    typeof folder === "string" && folder.startsWith(privateRoot);

  const rows = buildRecentRows(
    [
      {
        workspace: {
          id: "chat-a",
          name: "Private workspace",
          path: `${privateRoot}/chat-a`,
          preset: "starter",
          workspaceType: "local" as const,
        },
        sessions: [{ id: "chat", title: "Chat", directory: `${privateRoot}/chat-a`, time: { created: 10, updated: 30 } }],
        status: "ready",
      },
      {
        workspace: {
          id: "project-a",
          name: "Project A",
          path: "/Users/test/project-a",
          preset: "starter",
          workspaceType: "local" as const,
        },
        sessions: [{ id: "project", title: "Project", directory: "/Users/test/project-a", time: { created: 20, updated: 20 } }],
        status: "ready",
      },
    ],
    isPrivateWorkspacePath,
  );

  assert.deepEqual(rows.map((row) => row.session.id), ["chat", "project"]);
});
```

In source tests, assert the recent branch still iterates `recentRowsVisible()` and does not use `chatProjectGroup()`.

**Step 2: Run focused tests and verify they fail if any regression exists**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/components/session/workspace-session-list-model.test.ts \
  src/app/components/session/workspace-session-list-recent-layout.test.ts \
  src/app/components/session/workspace-session-list-interactions.test.ts
```

Expected: PASS if Task 4 preserved recent mode; otherwise fix the regression before continuing.

**Step 3: Commit if tests required source changes**

```bash
git add packages/app/src/app/components/session/workspace-session-list-model.test.ts packages/app/src/app/components/session/workspace-session-list-recent-layout.test.ts packages/app/src/app/components/session/workspace-session-list-interactions.test.ts
git commit -m "test: preserve recent sidebar chat ordering"
```

Skip this commit if no files changed.

### Task 6: App Verification

**Files:**
- No source changes expected.

**Step 1: Run app typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

**Step 2: Run app unit tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: PASS.

**Step 3: Run localization parity**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:i18n
```

Expected: PASS.

**Step 4: Perform desktop runtime preflight**

Run from repo root:

```bash
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite.js|bun --watch src/cli\\.ts|/target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
```

If matches are internally started Veslo dev/test runtimes from this repo, stop them:

```bash
pkill -f "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite.js|bun --watch src/cli\\.ts|/target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
```

Then verify no matching process remains:

```bash
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite.js|bun --watch src/cli\\.ts|/target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
```

Expected: no output after cleanup. If a user-launched production app is detected, stop and report it instead of killing it.

**Step 5: Run real desktop manual verification**

Run:

```bash
pnpm dev
```

Manual checks:

- In project-grouped sidebar mode, click the primary Chat action.
- Send one message so the private session receives a generated title.
- Confirm the titlebar shows the discussion title or "Chat", not the temporary directory.
- Confirm the bottom sidebar section is labeled "Chaty" in Czech locale and contains the chat row.
- Confirm "+ Chat" in the bottom section opens the same private-session flow.
- Switch to Recent mode and confirm the chat appears mixed with other sessions by activity.

**Step 6: Commit verification-only docs if needed**

No commit is required if verification changes no files.

### Task 7: Completion Review

**Files:**
- No source changes expected unless review finds an issue.

**Step 1: Inspect the final diff**

Run:

```bash
git status --short
git diff --stat HEAD~5..HEAD
```

Expected: only the planned app, locale, and test files changed after the design/implementation-plan docs.

**Step 2: Record verification evidence**

In the final implementation response, report:

- focused tests run and pass/fail status
- `pnpm typecheck`
- `pnpm --filter @neatech/veslo-ui test:unit`
- `pnpm --filter @neatech/veslo-ui test:i18n`
- desktop runtime manual verification status and any gaps

**Step 3: Do not merge until the user chooses the integration path**

After implementation and verification, use the repository's normal branch finishing flow. Do not create a PR or merge without explicit user direction.
