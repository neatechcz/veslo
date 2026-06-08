# Pending Session Instance Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Isolate first-send pending session UI state so simultaneously created chats and project sessions never temporarily render each other's submitted messages, run indicators, failures, or sidebar rows.

**Architecture:** Add a UI-only pending session instance id for each first-send flow and scope pending submitted messages, run UI state, queue state, and sidebar placeholders by that id until the server returns the real session. Remap only the matching pending instance to the real session id and workspace group after conversation creation. Keep Veslo server conversation binding unchanged.

**Tech Stack:** SolidJS signals/memos, Veslo app session page, app-shell sidebar state, Node test runner with `tsx/esm`, Tauri-pilot desktop E2E.

---

## Preconditions

- Use `@test-driven-development` before implementation.
- Use `@systematic-debugging` if any test or runtime behavior is surprising.
- Use `@verification-before-completion` before claiming the fix is complete.
- Do not start `packages/web`, raw Vite, or `pnpm -w dev:ui` as a runtime.
- For desktop E2E, follow `docs/dev/testing-playbook.md` preflight before launching Tauri.
- After code changes, run `graphify update .` if the CLI is available.

## Existing Files To Read First

- `docs/plans/2026-06-08-pending-session-instance-design.md`
- `docs/dev/opencode-workspace-runtime-architecture.md`
- `docs/dev/testing-playbook.md`
- `packages/app/src/app/pages/session.tsx`
- `packages/app/src/app/app.tsx`
- `packages/app/src/app/components/session/pending-submit-model.ts`
- `packages/app/src/app/components/session/session-queue-model.ts`
- `packages/app/src/app/components/session/workspace-session-list.tsx`
- `packages/app/src/app/types.ts`

## Task 1: Add Pending Session Instance Model

**Files:**
- Create: `packages/app/src/app/components/session/pending-session-instance-model.ts`
- Create: `packages/app/src/app/components/session/pending-session-instance-model.test.ts`
- Read: `packages/app/src/app/components/session/pending-submit-model.ts`

**Step 1: Write the failing tests**

Create `packages/app/src/app/components/session/pending-session-instance-model.test.ts` with tests for independent pending instances:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import type { ComposerDraft } from "../../types";
import {
  createPendingSessionInstance,
  createPendingSessionInstanceId,
  materializePendingSessionInstance,
  pendingSessionKeyForInstance,
  removePendingSubmittedDraftForKey,
  selectPendingSubmittedDraft,
  setPendingSubmittedDraftForKey,
} from "./pending-session-instance-model.js";
import { createPendingSubmittedDraft } from "./pending-submit-model.js";

const draft = (text: string): ComposerDraft => ({
  mode: "prompt",
  parts: [{ type: "text", text }],
  attachments: [],
  text,
  resolvedText: text,
});

test("pending session ids are distinct and renderable as pending session keys", () => {
  const first = createPendingSessionInstanceId(() => "one");
  const second = createPendingSessionInstanceId(() => "two");

  assert.equal(first, "pending-session:one");
  assert.equal(second, "pending-session:two");
  assert.notEqual(first, second);
  assert.equal(pendingSessionKeyForInstance(first), first);
});

test("two pending sessions in the same workspace keep separate submitted drafts", () => {
  const first = createPendingSessionInstance({
    id: "pending-session:first",
    workspaceId: "workspace-a",
    workspaceRoot: "/tmp/project",
    title: "first",
    createdAt: 100,
  });
  const second = createPendingSessionInstance({
    id: "pending-session:second",
    workspaceId: "workspace-a",
    workspaceRoot: "/tmp/project",
    title: "second",
    createdAt: 101,
  });

  let submitted = {};
  submitted = setPendingSubmittedDraftForKey(
    submitted,
    first.sessionKey,
    createPendingSubmittedDraft({
      id: "optimistic:first",
      sessionKey: first.sessionKey,
      sessionId: null,
      createdAt: 100,
      draft: draft("first message"),
    }),
  );
  submitted = setPendingSubmittedDraftForKey(
    submitted,
    second.sessionKey,
    createPendingSubmittedDraft({
      id: "optimistic:second",
      sessionKey: second.sessionKey,
      sessionId: null,
      createdAt: 101,
      draft: draft("second message"),
    }),
  );

  assert.equal(selectPendingSubmittedDraft(submitted, first.sessionKey)?.draft.text, "first message");
  assert.equal(selectPendingSubmittedDraft(submitted, second.sessionKey)?.draft.text, "second message");
});

test("materializing one pending session remaps only its submitted draft", () => {
  let submitted = {};
  submitted = setPendingSubmittedDraftForKey(
    submitted,
    "pending-session:first",
    createPendingSubmittedDraft({
      id: "optimistic:first",
      sessionKey: "pending-session:first",
      sessionId: null,
      createdAt: 100,
      draft: draft("first message"),
    }),
  );
  submitted = setPendingSubmittedDraftForKey(
    submitted,
    "pending-session:second",
    createPendingSubmittedDraft({
      id: "optimistic:second",
      sessionKey: "pending-session:second",
      sessionId: null,
      createdAt: 101,
      draft: draft("second message"),
    }),
  );

  const remapped = materializePendingSessionInstance(submitted, {
    pendingSessionKey: "pending-session:first",
    realSessionKey: "session-real-first",
    realSessionId: "session-real-first",
  });

  assert.equal(selectPendingSubmittedDraft(remapped, "session-real-first")?.draft.text, "first message");
  assert.equal(selectPendingSubmittedDraft(remapped, "session-real-first")?.sessionId, "session-real-first");
  assert.equal(selectPendingSubmittedDraft(remapped, "pending-session:first"), null);
  assert.equal(selectPendingSubmittedDraft(remapped, "pending-session:second")?.draft.text, "second message");
});

test("removing a pending submitted draft removes only the matching key and id", () => {
  const pending = createPendingSubmittedDraft({
    id: "optimistic:first",
    sessionKey: "pending-session:first",
    sessionId: null,
    createdAt: 100,
    draft: draft("first message"),
  });
  const unchanged = removePendingSubmittedDraftForKey(
    { "pending-session:first": pending },
    "pending-session:first",
    "other-id",
  );
  const removed = removePendingSubmittedDraftForKey(
    { "pending-session:first": pending },
    "pending-session:first",
    "optimistic:first",
  );

  assert.equal(selectPendingSubmittedDraft(unchanged, "pending-session:first")?.id, "optimistic:first");
  assert.equal(selectPendingSubmittedDraft(removed, "pending-session:first"), null);
});
```

**Step 2: Run the new test and verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/pending-session-instance-model.test.ts
```

Expected: FAIL because `pending-session-instance-model.ts` does not exist.

**Step 3: Add the model**

Create `packages/app/src/app/components/session/pending-session-instance-model.ts`:

```ts
import type { PendingSubmittedDraft } from "./pending-submit-model";
import { remapPendingSubmittedSession } from "./pending-submit-model";

export const PENDING_SESSION_INSTANCE_PREFIX = "pending-session:";

export type PendingSessionInstanceId = `${typeof PENDING_SESSION_INSTANCE_PREFIX}${string}`;

export type PendingSessionInstance = {
  id: PendingSessionInstanceId;
  sessionKey: string;
  workspaceId: string;
  workspaceRoot: string;
  title: string;
  createdAt: number;
  realSessionId?: string | null;
};

export type PendingSubmittedDraftBySessionKey = Record<string, PendingSubmittedDraft>;

export const isPendingSessionInstanceId = (value: string | null | undefined): value is PendingSessionInstanceId =>
  (value ?? "").trim().startsWith(PENDING_SESSION_INSTANCE_PREFIX);

export const createPendingSessionInstanceId = (
  uuid: () => string = () =>
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`,
): PendingSessionInstanceId => `${PENDING_SESSION_INSTANCE_PREFIX}${uuid().replace(/[^a-zA-Z0-9_-]/g, "")}`;

export function pendingSessionKeyForInstance(id: PendingSessionInstanceId): string {
  return id;
}

export function createPendingSessionInstance(input: {
  id: PendingSessionInstanceId;
  workspaceId: string;
  workspaceRoot: string;
  title: string;
  createdAt: number;
}): PendingSessionInstance {
  return {
    id: input.id,
    sessionKey: pendingSessionKeyForInstance(input.id),
    workspaceId: input.workspaceId.trim(),
    workspaceRoot: input.workspaceRoot.trim(),
    title: input.title.trim(),
    createdAt: input.createdAt,
    realSessionId: null,
  };
}

export function selectPendingSubmittedDraft(
  current: PendingSubmittedDraftBySessionKey,
  sessionKey: string | null | undefined,
): PendingSubmittedDraft | null {
  const key = (sessionKey ?? "").trim();
  return key ? current[key] ?? null : null;
}

export function setPendingSubmittedDraftForKey(
  current: PendingSubmittedDraftBySessionKey,
  sessionKey: string,
  draft: PendingSubmittedDraft,
): PendingSubmittedDraftBySessionKey {
  const key = sessionKey.trim();
  if (!key) return current;
  return { ...current, [key]: { ...draft, sessionKey: key } };
}

export function removePendingSubmittedDraftForKey(
  current: PendingSubmittedDraftBySessionKey,
  sessionKey: string,
  submittedDraftId: string,
): PendingSubmittedDraftBySessionKey {
  const key = sessionKey.trim();
  const id = submittedDraftId.trim();
  if (!key || !id || current[key]?.id !== id) return current;
  const { [key]: _removed, ...rest } = current;
  return rest;
}

export function materializePendingSessionInstance(
  current: PendingSubmittedDraftBySessionKey,
  input: {
    pendingSessionKey: string;
    realSessionKey: string;
    realSessionId: string;
  },
): PendingSubmittedDraftBySessionKey {
  const pendingKey = input.pendingSessionKey.trim();
  const realKey = input.realSessionKey.trim();
  const realSessionId = input.realSessionId.trim();
  if (!pendingKey || !realKey || !realSessionId || pendingKey === realKey) return current;

  const pending = current[pendingKey];
  if (!pending) return current;

  const { [pendingKey]: _removed, ...rest } = current;
  return {
    ...rest,
    [realKey]: {
      ...remapPendingSubmittedSession(pending, realSessionId),
      sessionKey: realKey,
    },
  };
}
```

**Step 4: Run the model test and unit suite**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/pending-session-instance-model.test.ts
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/components/session/pending-session-instance-model.ts packages/app/src/app/components/session/pending-session-instance-model.test.ts
git commit -m "test: add pending session instance model"
```

## Task 2: Scope Optimistic Submitted Messages By Pending Session Instance

**Files:**
- Modify: `packages/app/src/app/pages/session.tsx`
- Modify: `packages/app/src/app/pages/session-message-queue.test.ts`
- Test: `packages/app/src/app/components/session/pending-session-instance-model.test.ts`

**Step 1: Write failing source-structure tests**

Extend `packages/app/src/app/pages/session-message-queue.test.ts` or create
`packages/app/src/app/pages/session-pending-instance.test.ts` with source checks:

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./session.tsx", import.meta.url), "utf8");

test("session view stores optimistic submitted drafts by session key", () => {
  assert.match(source, /pendingSubmittedDraftBySessionKey/);
  assert.doesNotMatch(source, /const \[optimisticSubmittedDraft, setOptimisticSubmittedDraft\] = createSignal<PendingSubmittedDraft \| null>/);
});

test("first sends create a unique pending session instance key", () => {
  assert.match(source, /createPendingSessionInstanceId\(/);
  assert.match(source, /pending-session/);
  assert.match(source, /pendingSessionKeyBeforeHandoff/);
});

test("pending session queue keys are treated as not-yet-real sessions", () => {
  assert.match(source, /isPendingSessionInstanceId\(sessionKey\)/);
});
```

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/session-pending-instance.test.ts
```

Expected: FAIL against the current single optimistic draft signal.

**Step 2: Replace the single optimistic draft signal**

In `packages/app/src/app/pages/session.tsx`, import the new model:

```ts
import {
  createPendingSessionInstanceId,
  isPendingSessionInstanceId,
  materializePendingSessionInstance,
  removePendingSubmittedDraftForKey,
  selectPendingSubmittedDraft,
  setPendingSubmittedDraftForKey,
  type PendingSubmittedDraftBySessionKey,
} from "../components/session/pending-session-instance-model";
```

Replace:

```ts
const [optimisticSubmittedDraft, setOptimisticSubmittedDraft] = createSignal<PendingSubmittedDraft | null>(null);
```

with:

```ts
const [pendingSubmittedDraftBySessionKey, setPendingSubmittedDraftBySessionKey] =
  createSignal<PendingSubmittedDraftBySessionKey>({});

const optimisticSubmittedDraft = createMemo(() =>
  selectPendingSubmittedDraft(pendingSubmittedDraftBySessionKey(), currentSessionQueueKey()),
);
```

Keep the existing `optimisticSubmittedDraft()` call sites working through the
memo, but update every setter call to mutate the keyed map.

**Step 3: Treat pending session ids as pending queue keys**

Update `sessionIdForQueueKey`:

```ts
const sessionIdForQueueKey = (sessionKey: string) =>
  sessionKey.startsWith("pending:") ||
  sessionKey.startsWith("pending-draft:") ||
  sessionKey.startsWith("pending-workspace:") ||
  isPendingSessionInstanceId(sessionKey)
    ? null
    : sessionKey;
```

**Step 4: Generate a unique key for each first-send handoff**

In `sendPromptImmediate`, split the base queue key from the actual send key:

```ts
const baseSessionKey = expectedSessionKey ?? currentSessionQueueKey();
const needsPendingSessionInstance = !targetSessionId && !sessionIdForQueueKey(baseSessionKey);
const pendingInstanceKey = needsPendingSessionInstance ? createPendingSessionInstanceId() : null;
const sessionKey = pendingInstanceKey ?? baseSessionKey;
const pendingSessionKeyBeforeHandoff = pendingInstanceKey;
```

Use `sessionKey` for the optimistic submitted draft, queue remap, and pending
handoff state. Do not use `pending-workspace:<workspaceId>` as the identity for
the submitted draft.

**Step 5: Update keyed set/clear/fail logic**

Replace `setOptimisticSubmittedDraft` mutations in `sendPromptImmediate`:

```ts
const clearMatchingPendingSubmit = () => {
  setPendingSubmittedDraftBySessionKey((current) =>
    removePendingSubmittedDraftForKey(current, sessionKey, pendingSubmitId),
  );
};
```

For failure:

```ts
const markMatchingPendingSubmitFailed = (errorMessage: string) => {
  let materializedSessionIdToRestore: string | null = null;
  setPendingSubmittedDraftBySessionKey((current) => {
    const existing = selectPendingSubmittedDraft(current, sessionKey);
    if (!existing || existing.id !== pendingSubmitId) return current;
    materializedSessionIdToRestore = existing.sessionId;
    return setPendingSubmittedDraftForKey(
      current,
      pendingSessionKeyBeforeHandoff ?? sessionKey,
      {
        ...markPendingSubmittedFailed(existing, errorMessage),
        sessionKey: pendingSessionKeyBeforeHandoff ?? sessionKey,
        sessionId: pendingSessionKeyBeforeHandoff ? null : existing.sessionId,
      },
    );
  });
  if (pendingSessionKeyBeforeHandoff) {
    restoreMaterializedQueueToPending(pendingSessionKeyBeforeHandoff, materializedSessionIdToRestore);
  }
};
```

When creating the draft:

```ts
setPendingSubmittedDraftBySessionKey((current) =>
  setPendingSubmittedDraftForKey(
    current,
    sessionKey,
    createPendingSubmittedDraft({
      id: pendingSubmitId,
      sessionKey,
      createdAt: Date.now(),
      sessionId: targetSessionId ?? props.selectedSessionId,
      draft,
    }),
  ),
);
```

**Step 6: Update queue remap to remap pending submitted drafts by key**

In `remapPendingQueueToSession`, replace the old single draft remap with:

```ts
setPendingSubmittedDraftBySessionKey((current) =>
  materializePendingSessionInstance(current, {
    pendingSessionKey: pendingKey,
    realSessionKey: sessionKey,
    realSessionId: sessionId,
  }),
);
```

If `restoreMaterializedQueueToPending` moves a real session back to a pending
key, add the inverse map move using the same helpers so failed creation remains
editable in the pending context.

**Step 7: Run focused tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/session-pending-instance.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/pending-session-instance-model.test.ts
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: PASS.

**Step 8: Commit**

```bash
git add packages/app/src/app/pages/session.tsx packages/app/src/app/pages/session-pending-instance.test.ts
git commit -m "fix: scope pending submitted messages by session instance"
```

## Task 3: Scope Run UI State By Session Key

**Files:**
- Modify: `packages/app/src/app/pages/session.tsx`
- Test: `packages/app/src/app/pages/session-pending-instance.test.ts`

**Step 1: Add failing source checks**

Extend `packages/app/src/app/pages/session-pending-instance.test.ts`:

```ts
test("session view scopes run indicator state by session key", () => {
  assert.match(source, /runStateBySessionKey/);
  assert.match(source, /activeRunState/);
  assert.doesNotMatch(source, /const \[runStartedAt, setRunStartedAt\] = createSignal<number \| null>\(null\)/);
});
```

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/session-pending-instance.test.ts
```

Expected: FAIL while run UI state is still global.

**Step 2: Introduce keyed run state**

In `packages/app/src/app/pages/session.tsx`, replace the individual run state
signals with a keyed map:

```ts
type SessionRunUiState = {
  startedAt: number | null;
  hasBegun: boolean;
  tick: number;
  lastProgressAt: number | null;
  baseline: { assistantId: string | null; partCount: number };
};

const createEmptyRunUiState = (): SessionRunUiState => ({
  startedAt: null,
  hasBegun: false,
  tick: Date.now(),
  lastProgressAt: null,
  baseline: { assistantId: null, partCount: 0 },
});

const [runStateBySessionKey, setRunStateBySessionKey] =
  createSignal<Record<string, SessionRunUiState>>({});

const activeRunState = createMemo(() =>
  runStateBySessionKey()[currentSessionQueueKey()] ?? createEmptyRunUiState(),
);

const updateRunStateForSessionKey = (
  sessionKey: string,
  updater: (state: SessionRunUiState) => SessionRunUiState,
) => {
  setRunStateBySessionKey((current) => {
    const existing = current[sessionKey] ?? createEmptyRunUiState();
    return { ...current, [sessionKey]: updater(existing) };
  });
};
```

Update helpers:

```ts
const resetRunState = (sessionKey = currentSessionQueueKey()) => {
  updateRunStateForSessionKey(sessionKey, () => createEmptyRunUiState());
};

const startRun = (sessionKey = currentSessionQueueKey()) => {
  const now = Date.now();
  const snapshot = lastAssistantSnapshot();
  updateRunStateForSessionKey(sessionKey, (state) =>
    state.startedAt
      ? state
      : {
          startedAt: now,
          hasBegun: false,
          tick: now,
          lastProgressAt: now,
          baseline: { assistantId: snapshot.id, partCount: snapshot.partCount },
        },
  );
};
```

Replace reads:

- `runStartedAt()` -> `activeRunState().startedAt`
- `runHasBegun()` -> `activeRunState().hasBegun`
- `runBaseline()` -> `activeRunState().baseline`
- `runTick()` -> `activeRunState().tick`
- `runLastProgressAt()` -> `activeRunState().lastProgressAt`

When setting `hasBegun`, `lastProgressAt`, or `tick`, update only the current
session key.

**Step 3: Use the send session key when starting or resetting**

In `sendPromptImmediate`, call:

```ts
startRun(sessionKey);
```

On failure or rejection, call:

```ts
resetRunState(sessionKey);
```

Do not reset a different pending session's run state when the user switches
while another send is still materializing.

**Step 4: Run focused tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/session-pending-instance.test.ts
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/pages/session.tsx packages/app/src/app/pages/session-pending-instance.test.ts
git commit -m "fix: scope session run indicators by session key"
```

## Task 4: Add Sidebar Pending Placeholder And Materialization Remap

**Files:**
- Modify: `packages/app/src/app/types.ts`
- Modify: `packages/app/src/app/pages/session.tsx`
- Modify: `packages/app/src/app/app.tsx`
- Modify: `packages/app/src/app/pages/session-pending-instance.test.ts`
- Test: `packages/app/src/app/app-send-prompt-session-creation.test.ts`

**Step 1: Add failing source checks**

Extend `packages/app/src/app/pages/session-pending-instance.test.ts`:

```ts
const appSource = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const typesSource = readFileSync(new URL("../types.ts", import.meta.url), "utf8");

test("app wires pending session instance metadata through sendPrompt", () => {
  assert.match(source, /pendingSessionInstance\?/);
  assert.match(appSource, /pendingSessionInstance\?/);
  assert.match(appSource, /registerPendingSidebarSession/);
  assert.match(appSource, /materializePendingSidebarSession/);
});

test("sidebar session items can carry pending session metadata", () => {
  assert.match(typesSource, /pendingSessionInstanceId\?: string \| null/);
});
```

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/session-pending-instance.test.ts
```

Expected: FAIL.

**Step 2: Extend sidebar item type**

In `packages/app/src/app/types.ts`, add optional metadata to
`SidebarSessionItem`:

```ts
pendingSessionInstanceId?: string | null;
pending?: boolean;
```

**Step 3: Extend send options through SessionView and App**

In `packages/app/src/app/pages/session.tsx`, update `SessionViewProps`:

```ts
sendPromptAsync: (
  draft: ComposerDraft,
  options?: {
    targetSessionId?: string | null;
    pendingSessionInstance?: {
      id: string;
      workspaceId: string;
      workspaceRoot: string;
      title: string;
      createdAt: number;
    } | null;
  },
) => Promise<boolean>;
```

In `sendPromptImmediate`, when creating `pendingInstanceKey`, also build:

```ts
const pendingSessionInstance = pendingInstanceKey
  ? {
      id: pendingInstanceKey,
      workspaceId: props.activeWorkspaceId,
      workspaceRoot: props.activeWorkspaceRoot,
      title: (draft.resolvedText ?? draft.text).trim(),
      createdAt: Date.now(),
    }
  : null;
```

Pass it to app:

```ts
props.sendPromptAsync(draft, targetSessionId
  ? { targetSessionId }
  : { pendingSessionInstance });
```

**Step 4: Add app-level sidebar helpers**

In `packages/app/src/app/app.tsx`, extend `sendPrompt` options:

```ts
options: {
  targetSessionId?: string | null;
  pendingSessionInstance?: {
    id: string;
    workspaceId: string;
    workspaceRoot: string;
    title: string;
    createdAt: number;
  } | null;
} = {},
```

Add helpers near `setSidebarSessionsByWorkspaceId` usage:

```ts
const registerPendingSidebarSession = (pending: NonNullable<Parameters<typeof sendPrompt>[1]["pendingSessionInstance"]>) => {
  const workspaceId = pending.workspaceId.trim();
  const id = pending.id.trim();
  if (!workspaceId || !id) return;
  const title = pending.title.trim() || t("session.new_chat", currentLocale());
  const item: SidebarSessionItem = {
    id,
    title,
    time: { created: pending.createdAt, updated: pending.createdAt },
    directory: pending.workspaceRoot || null,
    pendingSessionInstanceId: id,
    pending: true,
  };
  setSidebarSessionsByWorkspaceId((prev) => {
    const existing = prev[workspaceId] ?? [];
    if (existing.some((row) => row.id === id || row.pendingSessionInstanceId === id)) return prev;
    return { ...prev, [workspaceId]: [item, ...existing] };
  });
  setSidebarSessionStatusByWorkspaceId((prev) => ({ ...prev, [workspaceId]: "ready" }));
};

const materializePendingSidebarSession = (
  pendingId: string | null | undefined,
  workspaceId: string,
  session: SidebarSessionItem,
) => {
  const id = pendingId?.trim() ?? "";
  const wsId = workspaceId.trim();
  if (!id || !wsId) return false;
  let replaced = false;
  setSidebarSessionsByWorkspaceId((prev) => {
    const existing = prev[wsId] ?? [];
    const materialized: SidebarSessionItem = {
      ...session,
      pendingSessionInstanceId: id,
      pending: false,
    };
    const withoutDuplicates = existing.filter(
      (row) => row.id !== materialized.id && row.pendingSessionInstanceId !== id,
    );
    replaced = existing.length !== withoutDuplicates.length;
    return { ...prev, [wsId]: [materialized, ...withoutDuplicates] };
  });
  return replaced;
};
```

Use a local type alias instead of `Parameters<typeof sendPrompt>` if TypeScript
cannot reference the function cleanly before declaration.

**Step 5: Register placeholder before create and materialize after create**

In `sendPrompt`, before `createSessionAndOpen` for first sends:

```ts
if (pendingDraftSendState && options.pendingSessionInstance) {
  registerPendingSidebarSession(options.pendingSessionInstance);
}
```

Pass the pending instance into `createSessionAndOpen`:

```ts
sessionID = (await createSessionAndOpen(initialSessionTitle, {
  blockAppDuringCreate: blockAppDuringPromptSend,
  managedAiRuntimeAlreadyPrepared: true,
  pendingSessionInstance: options.pendingSessionInstance ?? null,
})) ?? selectedSessionId();
```

Extend `createSessionAndOpen` options:

```ts
pendingSessionInstance?: {
  id: string;
  workspaceId: string;
  workspaceRoot: string;
  title: string;
  createdAt: number;
} | null;
```

When the server returns `session`, choose the sidebar workspace id from the
pending instance first, then the returned session/workspace context, then the
active workspace only as a fallback:

```ts
const wsId =
  options.pendingSessionInstance?.workspaceId?.trim() ||
  session.workspaceId?.trim?.() ||
  workspaceStore.activeWorkspaceId().trim();
```

When inserting `newItem`, call `materializePendingSidebarSession`. If it returns
false, fall back to the existing insertion path.

**Step 6: Make pending sidebar rows selectable without loading a transcript**

In `packages/app/src/app/pages/session.tsx`, update `openSessionFromList`:

```ts
if (isPendingSessionInstanceId(sessionId)) {
  props.setPendingSessionLoad(null);
  props.setSessionBrowseScope({
    sessionId,
    workspaceId,
    workspaceRoot,
    directory: workspaceRoot,
  });
  props.setView("session", sessionId);
  return;
}
```

This allows clicking a pending placeholder row to render the local pending
message without calling OpenCode or transcript APIs.

**Step 7: Run focused tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/session-pending-instance.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/app-send-prompt-session-creation.test.ts
pnpm --filter @neatech/veslo-ui test:unit
pnpm typecheck
```

Expected: PASS.

**Step 8: Commit**

```bash
git add packages/app/src/app/types.ts packages/app/src/app/pages/session.tsx packages/app/src/app/app.tsx packages/app/src/app/pages/session-pending-instance.test.ts
git commit -m "fix: materialize pending sessions in the correct sidebar group"
```

## Task 5: Add Tauri-Pilot E2E Scenario For Three Pending-Session Variants

**Files:**
- Create: `packages/e2e/pilot-scenarios/pending-session-instance-isolation.toml`
- Modify: `packages/e2e/helpers/pilot-runner.ts`
- Test: `packages/e2e/helpers/pilot-runner.test.ts`

**Step 1: Add failing pilot-runner fixture detection test**

If the new scenario needs the same managed AI gateway fixture as
`message-send-registry-degraded.toml`, extend
`packages/e2e/helpers/pilot-runner.test.ts`:

```ts
test("pending session instance scenario enables managed AI fixture", () => {
  assert.equal(
    scenarioSelectionNeedsManagedAiGatewayFixture([
      "/repo/packages/e2e/pilot-scenarios/pending-session-instance-isolation.toml",
    ]),
    true,
  );
});
```

Run:

```bash
pnpm --filter @neatech/veslo-e2e exec node --test --import=tsx/esm helpers/pilot-runner.test.ts
```

Expected: FAIL until fixture detection includes the new scenario.

**Step 2: Include the new scenario in fixture detection**

In `packages/e2e/helpers/pilot-runner.ts`, update
`scenarioSelectionNeedsManagedAiGatewayFixture`:

```ts
scenario.replaceAll("\\", "/").endsWith("/pilot-scenarios/pending-session-instance-isolation.toml")
```

Run the pilot runner test again. Expected: PASS.

**Step 3: Create the E2E scenario**

Create `packages/e2e/pilot-scenarios/pending-session-instance-isolation.toml`.
Use the helper style from `sidebar-session-retention.toml`:

- wait for `#root`,
- wait for the local Veslo server,
- use Tauri `workspace_bootstrap` to find the initial local workspace,
- create a second local workspace for the chat-plus-project variant when
  needed,
- interact through the rendered composer and sidebar, not raw server-only
  conversation calls,
- use unique message text per variant:
  - `pending isolation chat A <timestamp>`,
  - `pending isolation chat B <timestamp>`,
  - `pending isolation chat project <timestamp>`,
  - `pending isolation same project A <timestamp>`,
  - `pending isolation same project B <timestamp>`.

The scenario should implement these functions in its eval script:

```js
const waitUntil = async (predicate, options = {}) => { /* same helper style as sidebar-session-retention.toml */ };
const waitForComposer = async () => waitUntil(() =>
  document.querySelector('div[contenteditable="true"][role="textbox"][aria-multiline="true"], [role="textbox"]')
);
const findComposerSendButton = (textbox) => { /* copy from sidebar-session-retention.toml */ };
const setComposerText = async (text) => { /* set contenteditable text and dispatch input */ };
const sendComposerText = async (text) => { /* set text, click send, assert text appears */ };
const visibleBodyText = () => document.body.innerText.replace(/\s+/g, " ").trim();
const assertTextVisible = async (text) => waitUntil(() => visibleBodyText().includes(text));
const assertTextNotVisible = async (text) => waitUntil(() => !visibleBodyText().includes(text));
const clickSidebarRowByText = async (text) => { /* find button containing text and click */ };
```

Variant checks:

1. **Two clean chats**
   - open a new clean chat,
   - send message A,
   - immediately open another clean chat,
   - send message B,
   - click each sidebar row,
   - assert A view contains A and not B,
   - assert B view contains B and not A.

2. **Chat plus project session**
   - open a clean chat,
   - send chat message,
   - switch composer target or workspace to the project target,
   - open a new project session,
   - send project message,
   - assert the chat row and project row are in distinct sidebar sections or
     workspace groups,
   - assert each view contains only its own message.

3. **Two sessions in one project**
   - activate the same project workspace,
   - open a new project session,
   - send message A,
   - open another new project session in the same workspace,
   - send message B,
   - click each row,
   - assert each view contains only its own message.

The assertions must run both during the pending phase when possible and after
the server returns real session rows.

**Step 4: Run the scenario selector test**

Run:

```bash
pnpm --filter @neatech/veslo-e2e exec node --test --import=tsx/esm helpers/pilot-runner.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/e2e/pilot-scenarios/pending-session-instance-isolation.toml packages/e2e/helpers/pilot-runner.ts packages/e2e/helpers/pilot-runner.test.ts
git commit -m "test: cover pending session isolation in desktop e2e"
```

## Task 6: Update Durable Docs

**Files:**
- Modify: `docs/features/session-runtime.md`
- Modify: `docs/dev/opencode-workspace-runtime-architecture.md`

**Step 1: Add doc notes**

In `docs/features/session-runtime.md`, add a concise note under the session
creation or first-message section:

```md
First-send UI state is scoped by a local pending session instance until the
server returns the real conversation/session id. This lets multiple new chats
or project sessions materialize concurrently without sharing optimistic
messages, run indicators, failures, or sidebar rows.
```

In `docs/dev/opencode-workspace-runtime-architecture.md`, add a short app
ownership note under "First Message Flow":

```md
The app may create a UI-only pending session instance id for local rendering
and sidebar placement before the Veslo conversation exists. This id is not an
OpenCode session id and must be replaced or remapped when the server returns
the real conversation binding.
```

**Step 2: Run docs-relevant checks**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

**Step 3: Commit**

```bash
git add docs/features/session-runtime.md docs/dev/opencode-workspace-runtime-architecture.md
git commit -m "docs: describe pending session instance UI state"
```

## Task 7: Full Verification

**Files:**
- Read: `docs/dev/testing-playbook.md`
- Possibly modified by graphify: `graphify-out/*`

**Step 1: Run app verification**

Run:

```bash
pnpm typecheck
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: PASS.

**Step 2: Run desktop runtime preflight**

Run from repo root:

```bash
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|@tauri-apps/cli/tauri\\.js dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite\\.js|bun --watch src/cli\\.ts|(^|/)target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
```

If the matches are internally started dev/test processes from this repo, stop
them:

```bash
pkill -f "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|@tauri-apps/cli/tauri\\.js dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite\\.js|bun --watch src/cli\\.ts|(^|/)target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|@tauri-apps/cli/tauri\\.js dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite\\.js|bun --watch src/cli\\.ts|(^|/)target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
```

Expected: no relevant process remains. If a user-launched production/bundled app
is found, stop and report it.

**Step 3: Build desktop E2E binary**

Run:

```bash
cd packages/desktop
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json -- --features e2e
```

Expected: PASS.

**Step 4: Run focused Tauri-pilot scenario**

Run:

```bash
cd packages/e2e
pnpm test -- --scenario pending-session-instance-isolation
```

Expected: PASS. The scenario must verify:

- two clean chats are isolated,
- chat plus project session is isolated,
- two sessions in one project are isolated,
- sidebar rows are distinct and in the correct locations,
- each selected session shows only its own submitted message and the normal
  response indicator.

**Step 5: Run existing multi-workspace routing E2E**

Run:

```bash
cd packages/e2e
pnpm test -- --scenario multi-workspace-sessions
```

Expected: PASS.

**Step 6: Update graphify**

Run from repo root:

```bash
graphify update .
```

Expected: command succeeds. Dirty `graphify-out/` files are expected.

**Step 7: Final status check**

Run:

```bash
git status --short
git log --oneline -8
```

Expected:

- only intended implementation/docs/graph files are dirty, or everything is
  committed except expected graphify updates,
- recent commits match the task sequence.

**Step 8: Final commit if needed**

If verification or graphify produces intended changes that were not committed:

```bash
git add <intended-files>
git commit -m "chore: update graph after pending session fix"
```

## Completion Criteria

- The existing immediate-send rendering is unchanged.
- Simultaneous first sends never share optimistic submitted messages.
- Run indicators, failed pending messages, and queued drafts are scoped to the
  pending session instance or real session.
- Sidebar placeholder rows appear in the correct chat/project section and remap
  to the real session without duplicates.
- Tauri-pilot passes for:
  - two clean chats,
  - chat plus project session,
  - two sessions in the same project.
- `pnpm typecheck`, focused unit tests, app unit suite, and focused desktop E2E
  all pass.
