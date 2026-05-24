# Unread Session Indicator Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Bold session titles in the left menu when an assistant response arrives in a session the user is not actively reading.

**Architecture:** Keep unread state as local app-shell UI state. Let the session event store report assistant responses by session id, let the app shell decide unread/clear behavior from selected session and app focus, then pass a session-id map into the shared workspace session list for bold rendering.

**Tech Stack:** SolidJS signals/effects, TypeScript, OpenCode SDK event stream, Tailwind utility classes, node:test app tests, WebdriverIO desktop sanity checks in the real Tauri runtime.

---

## Required Skills And Docs

- Use `@solidjs-patterns` before editing SolidJS state or TSX.
- Use `@test-driven-development` for implementation tasks.
- Use `@systematic-debugging` if a test or runtime flow fails unexpectedly.
- Use `@verification-before-completion` before claiming completion.
- Follow `docs/dev/testing-playbook.md`; never use raw Vite, `packages/web`, or `pnpm -w dev:ui` as proof.
- Preserve `docs/plans/2026-05-24-unread-session-indicator-design.md`.

## Task 1: Add The Pure Unread Decision Model

**Files:**
- Create: `packages/app/src/app/components/session/session-unread-model.ts`
- Create: `packages/app/src/app/components/session/session-unread-model.test.ts`

**Step 1: Write the failing test**

Create `packages/app/src/app/components/session/session-unread-model.test.ts`.

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  clearUnreadSession,
  markUnreadAfterAssistantResponse,
  pruneUnreadSessions,
  type UnreadSessionMap,
} from "./session-unread-model.js";

const keys = (value: UnreadSessionMap) => Object.keys(value).sort();

test("marks a different session unread even while the app is focused", () => {
  const next = markUnreadAfterAssistantResponse({}, {
    responseSessionId: "session-b",
    selectedSessionId: "session-a",
    appFocused: true,
  });
  assert.deepEqual(keys(next), ["session-b"]);
});

test("marks the selected session unread while the app is blurred", () => {
  const next = markUnreadAfterAssistantResponse({}, {
    responseSessionId: "session-a",
    selectedSessionId: "session-a",
    appFocused: false,
  });
  assert.deepEqual(keys(next), ["session-a"]);
});

test("does not mark the selected session unread while the app is focused", () => {
  const current = { "session-z": true } satisfies UnreadSessionMap;
  const next = markUnreadAfterAssistantResponse(current, {
    responseSessionId: "session-a",
    selectedSessionId: "session-a",
    appFocused: true,
  });
  assert.equal(next, current);
});

test("clears only the opened or focused selected session", () => {
  const current = { "session-a": true, "session-b": true } satisfies UnreadSessionMap;
  assert.deepEqual(keys(clearUnreadSession(current, "session-a")), ["session-b"]);
  assert.equal(clearUnreadSession(current, "missing"), current);
});

test("prunes unread ids that no longer exist", () => {
  const current = { "session-a": true, "session-b": true, "session-c": true } satisfies UnreadSessionMap;
  assert.deepEqual(keys(pruneUnreadSessions(current, new Set(["session-b", "session-c"]))), [
    "session-b",
    "session-c",
  ]);
});
```

**Step 2: Run the focused test and verify it fails**

Run from the repo root:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/session-unread-model.test.ts
```

Expected: FAIL because `session-unread-model.ts` does not exist.

**Step 3: Implement the minimal model**

Create `packages/app/src/app/components/session/session-unread-model.ts`.

```ts
export type UnreadSessionMap = Record<string, true>;

const normalizeSessionId = (value: string | null | undefined) => (value ?? "").trim();

export function markUnreadAfterAssistantResponse(
  current: UnreadSessionMap,
  input: {
    responseSessionId: string | null | undefined;
    selectedSessionId: string | null | undefined;
    appFocused: boolean;
  },
): UnreadSessionMap {
  const responseSessionId = normalizeSessionId(input.responseSessionId);
  if (!responseSessionId) return current;

  const selectedSessionId = normalizeSessionId(input.selectedSessionId);
  const activelyReading = input.appFocused && selectedSessionId === responseSessionId;
  if (activelyReading) return current;
  if (current[responseSessionId]) return current;
  return { ...current, [responseSessionId]: true };
}

export function clearUnreadSession(
  current: UnreadSessionMap,
  sessionId: string | null | undefined,
): UnreadSessionMap {
  const id = normalizeSessionId(sessionId);
  if (!id || !current[id]) return current;
  const next = { ...current };
  delete next[id];
  return next;
}

export function pruneUnreadSessions(
  current: UnreadSessionMap,
  liveSessionIds: ReadonlySet<string>,
): UnreadSessionMap {
  let changed = false;
  const next: UnreadSessionMap = {};
  for (const id of Object.keys(current)) {
    if (!liveSessionIds.has(id)) {
      changed = true;
      continue;
    }
    next[id] = true;
  }
  return changed ? next : current;
}
```

**Step 4: Run the focused test and verify it passes**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/session-unread-model.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/components/session/session-unread-model.ts packages/app/src/app/components/session/session-unread-model.test.ts
git commit -m "test(app): add unread session model"
```

## Task 2: Report Assistant Responses From The Session Event Store

**Files:**
- Modify: `packages/app/src/app/context/session.ts`
- Test: `packages/app/src/app/context/session-unread-events.test.ts`

**Step 1: Write the failing test**

Create `packages/app/src/app/context/session-unread-events.test.ts`.

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { createRoot, createSignal } from "solid-js";

import { createSessionStore } from "./session.js";

type QueuedEvent = { type: string; properties?: unknown };

function createEventStream() {
  const queue: QueuedEvent[] = [];
  let wake: (() => void) | null = null;
  let closed = false;

  return {
    push(event: QueuedEvent) {
      queue.push(event);
      wake?.();
      wake = null;
    },
    close() {
      closed = true;
      wake?.();
    },
    async *stream() {
      while (!closed) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

const sessionInfo = (id: string) => ({
  id,
  title: id,
  time: { created: 1, updated: 1 },
  directory: "/tmp",
});

test("session store reports assistant message updates for unread decisions", async () => {
  const events = createEventStream();
  const observed: string[] = [];

  await new Promise<void>((resolve, reject) => {
    createRoot((dispose) => {
      const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>("session-a");
      const store = createSessionStore({
        client: () => ({
          event: {
            subscribe: async () => ({ stream: events.stream() }),
          },
        }) as any,
        activeWorkspaceRoot: () => "/tmp",
        selectedSessionId,
        setSelectedSessionId,
        developerMode: () => false,
        setError: () => {},
        setSseConnected: () => {},
        onAssistantResponseObserved: (sessionId) => observed.push(sessionId),
      });

      store.setSessions([sessionInfo("session-a") as any, sessionInfo("session-b") as any]);

      events.push({
        type: "message.updated",
        properties: {
          info: {
            id: "assistant-message",
            sessionID: "session-b",
            role: "assistant",
            time: { created: 2 },
          },
        },
      });

      setTimeout(() => {
        try {
          assert.deepEqual(observed, ["session-b"]);
          events.close();
          dispose();
          resolve();
        } catch (error) {
          events.close();
          dispose();
          reject(error);
        }
      }, 90);
    });
  });
});

test("session store does not report user message updates as unread responses", async () => {
  const events = createEventStream();
  const observed: string[] = [];

  await new Promise<void>((resolve, reject) => {
    createRoot((dispose) => {
      const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>("session-a");
      const store = createSessionStore({
        client: () => ({
          event: {
            subscribe: async () => ({ stream: events.stream() }),
          },
        }) as any,
        activeWorkspaceRoot: () => "/tmp",
        selectedSessionId,
        setSelectedSessionId,
        developerMode: () => false,
        setError: () => {},
        setSseConnected: () => {},
        onAssistantResponseObserved: (sessionId) => observed.push(sessionId),
      });

      store.setSessions([sessionInfo("session-a") as any, sessionInfo("session-b") as any]);

      events.push({
        type: "message.updated",
        properties: {
          info: {
            id: "user-message",
            sessionID: "session-b",
            role: "user",
            time: { created: 2 },
          },
        },
      });

      setTimeout(() => {
        try {
          assert.deepEqual(observed, []);
          events.close();
          dispose();
          resolve();
        } catch (error) {
          events.close();
          dispose();
          reject(error);
        }
      }, 90);
    });
  });
});
```

**Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/context/session-unread-events.test.ts
```

Expected: FAIL because `onAssistantResponseObserved` is not accepted/called.

**Step 3: Add the callback option and event trigger**

In `packages/app/src/app/context/session.ts`, add the option:

```ts
onAssistantResponseObserved?: (sessionId: string) => void;
```

In the `message.updated` event branch, after `isKnownSessionId(info.sessionID)` passes and after the message is upserted, call the callback only for assistant messages:

```ts
if ((info as { role?: string }).role === "assistant") {
  options.onAssistantResponseObserved?.(info.sessionID);
}
```

Keep this in the `message.updated` branch first. Do not add a `message.part.updated` trigger unless verification shows assistant `message.updated` is too late or missing; part events are more likely to create duplicate or user-message false positives.

**Step 4: Run the focused test and verify it passes**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/context/session-unread-events.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/context/session.ts packages/app/src/app/context/session-unread-events.test.ts
git commit -m "feat(app): report assistant session responses"
```

## Task 3: Track Focus-Aware Unread State In The App Shell

**Files:**
- Modify: `packages/app/src/app/app.tsx`
- Test: `packages/app/src/app/app-unread-session-indicator.test.ts`

**Step 1: Write the failing source contract test**

Create `packages/app/src/app/app-unread-session-indicator.test.ts`.

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");

test("app shell keeps a focus-aware unread session map", () => {
  assert.match(source, /const \[appFocused,\s*setAppFocused\] = createSignal\(true\)/);
  assert.match(source, /window\.addEventListener\("focus",\s*updateAppFocused\)/);
  assert.match(source, /window\.addEventListener\("blur",\s*updateAppFocused\)/);
  assert.match(source, /const \[unreadSessionIds,\s*setUnreadSessionIds\] = createSignal<UnreadSessionMap>\(\{\}\)/);
});

test("app shell marks unread from assistant responses and clears the selected session", () => {
  assert.match(source, /onAssistantResponseObserved:\s*\(sessionId\) => \{/);
  assert.match(source, /markUnreadAfterAssistantResponse\([\s\S]*responseSessionId:\s*sessionId[\s\S]*selectedSessionId:\s*selectedSessionId\(\)[\s\S]*appFocused:\s*appFocused\(\)/);
  assert.match(source, /clearUnreadSession\(current,\s*selectedSessionId\(\)\)/);
  assert.match(source, /if \(!appFocused\(\)\) return;[\s\S]*clearUnreadSession\(current,\s*selectedSessionId\(\)\)/);
});

test("app shell passes unread state to both sidebar surfaces", () => {
  const matches = source.match(/unreadSessionIds=\{unreadSessionIds\(\)\}/g) ?? [];
  assert.ok(matches.length >= 2, "session and dashboard sidebar props should both receive unreadSessionIds");
});
```

**Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/app-unread-session-indicator.test.ts
```

Expected: FAIL because no unread state or focus signal exists.

**Step 3: Implement app focus and unread state**

In `packages/app/src/app/app.tsx`, import the model:

```ts
import {
  clearUnreadSession,
  markUnreadAfterAssistantResponse,
  pruneUnreadSessions,
  type UnreadSessionMap,
} from "./components/session/session-unread-model";
```

Near existing document visibility state, add app focus state:

```ts
const [appFocused, setAppFocused] = createSignal(true);
```

Add a browser-only effect:

```ts
createEffect(() => {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  const updateAppFocused = () => {
    setAppFocused(document.visibilityState !== "hidden" && document.hasFocus());
  };

  updateAppFocused();
  window.addEventListener("focus", updateAppFocused);
  window.addEventListener("blur", updateAppFocused);
  document.addEventListener("visibilitychange", updateAppFocused);
  onCleanup(() => {
    window.removeEventListener("focus", updateAppFocused);
    window.removeEventListener("blur", updateAppFocused);
    document.removeEventListener("visibilitychange", updateAppFocused);
  });
});
```

Near session selection state, add:

```ts
const [unreadSessionIds, setUnreadSessionIds] = createSignal<UnreadSessionMap>({});
```

Pass the event callback into `createSessionStore`:

```ts
onAssistantResponseObserved: (sessionId) => {
  setUnreadSessionIds((current) =>
    markUnreadAfterAssistantResponse(current, {
      responseSessionId: sessionId,
      selectedSessionId: selectedSessionId(),
      appFocused: appFocused(),
    }),
  );
},
```

Clear on session open/selection:

```ts
createEffect(() => {
  const id = selectedSessionId();
  if (!id) return;
  setUnreadSessionIds((current) => clearUnreadSession(current, id));
});
```

Clear on focus return for the already selected session:

```ts
createEffect(() => {
  if (!appFocused()) return;
  const id = selectedSessionId();
  if (!id) return;
  setUnreadSessionIds((current) => clearUnreadSession(current, id));
});
```

Prune opportunistically from currently known sidebar ids:

```ts
createEffect(() => {
  const liveIds = new Set(sidebarWorkspaceGroups().flatMap((group) => group.sessions.map((session) => session.id)));
  setUnreadSessionIds((current) => pruneUnreadSessions(current, liveIds));
});
```

Only add the prune effect after `sidebarWorkspaceGroups` is declared. If placement would create awkward ordering, skip pruning; hidden/deleted ids do not render.

Pass `unreadSessionIds={unreadSessionIds()}` to both `Session` and `Dashboard` component prop objects.

**Step 4: Run the focused test and verify it passes**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/app-unread-session-indicator.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/app.tsx packages/app/src/app/app-unread-session-indicator.test.ts
git commit -m "feat(app): track unread sessions"
```

## Task 4: Render Bold Unread Session Titles In The Shared Sidebar

**Files:**
- Modify: `packages/app/src/app/pages/session.tsx`
- Modify: `packages/app/src/app/pages/dashboard.tsx`
- Modify: `packages/app/src/app/components/session/workspace-session-list.tsx`
- Test: `packages/app/src/app/components/session/workspace-session-list-unread.test.ts`
- Test: `packages/app/src/app/pages/sidebar-directory-session-wiring.test.ts`

**Step 1: Write the failing sidebar render test**

Create `packages/app/src/app/components/session/workspace-session-list-unread.test.ts`.

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./workspace-session-list.tsx", import.meta.url), "utf8");

test("workspace session list accepts unread session ids", () => {
  assert.match(source, /unreadSessionIds\?:\s*Record<string,\s*(boolean|true)>/);
  assert.match(source, /const isSessionUnread = \(sessionId: string\) => Boolean\(props\.unreadSessionIds\?\.\[sessionId\]\)/);
});

test("recent and by-project session titles become bold when unread", () => {
  const classMatches = source.match(/class=\{`text-\[13px\] text-gray-12 truncate \$\{isUnread\(\) \? "font-bold" : ""\}`\}/g) ?? [];
  assert.ok(classMatches.length >= 2, "both Recent and By Project title spans should use unread bold styling");
});
```

Also extend `packages/app/src/app/pages/sidebar-directory-session-wiring.test.ts` with assertions that Session and Dashboard props include `unreadSessionIds` and pass it into `WorkspaceSessionList`.

**Step 2: Run the focused tests and verify they fail**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/workspace-session-list-unread.test.ts src/app/pages/sidebar-directory-session-wiring.test.ts
```

Expected: FAIL because unread props and bold classes are absent.

**Step 3: Add props through the page surfaces**

In `packages/app/src/app/pages/session.tsx`, add to `SessionViewProps`:

```ts
unreadSessionIds: Record<string, true>;
```

Pass into the left-menu list:

```tsx
unreadSessionIds={props.unreadSessionIds}
```

In `packages/app/src/app/pages/dashboard.tsx`, add the same prop to `DashboardViewProps` and pass it to `WorkspaceSessionList`.

Do not add unread state to `WorkspaceSessionGroup` or `SidebarSessionItem`; unread is UI state, not session data.

**Step 4: Render bold titles in `WorkspaceSessionList`**

In `packages/app/src/app/components/session/workspace-session-list.tsx`, add the prop:

```ts
unreadSessionIds?: Record<string, true>;
```

Add a helper near `isRowSelected`:

```ts
const isSessionUnread = (sessionId: string) => Boolean(props.unreadSessionIds?.[sessionId]);
```

In both row render blocks, add:

```ts
const isUnread = () => isSessionUnread(session().id);
```

For the recent row title span and the by-project row title span, change the class to:

```tsx
class={`text-[13px] text-gray-12 truncate ${isUnread() ? "font-bold" : ""}`}
```

Keep the existing running dot and selected-row styling unchanged.

**Step 5: Run the focused tests and verify they pass**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/workspace-session-list-unread.test.ts src/app/pages/sidebar-directory-session-wiring.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add packages/app/src/app/pages/session.tsx packages/app/src/app/pages/dashboard.tsx packages/app/src/app/components/session/workspace-session-list.tsx packages/app/src/app/components/session/workspace-session-list-unread.test.ts packages/app/src/app/pages/sidebar-directory-session-wiring.test.ts
git commit -m "feat(app): bold unread session rows"
```

## Task 5: Update Durable Session Documentation

**Files:**
- Modify: `docs/features/session-runtime.md`

**Step 1: Update the feature doc**

Add a short section near the sidebar/menu behavior or message runtime sections:

```md
## Unread Session Indication

The left session menu marks a session title in bold when an assistant response arrives while the user is not actively reading that session. Active reading means the session is selected and the app window has focus.

Opening the session clears its unread indication. If the app regains focus while that session is already selected, the unread indication is also cleared. The indicator is local UI state for the current app run and is not persisted or synced.
```

**Step 2: Run a docs sanity check**

Run:

```bash
git diff -- docs/features/session-runtime.md
```

Expected: the new section documents behavior, not implementation details.

**Step 3: Commit**

```bash
git add docs/features/session-runtime.md
git commit -m "docs: document unread session indication"
```

## Task 6: Verify The App Surface

**Files:**
- Verify only; no planned edits.

**Step 1: Run focused app tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/components/session/session-unread-model.test.ts \
  src/app/context/session-unread-events.test.ts \
  src/app/app-unread-session-indicator.test.ts \
  src/app/components/session/workspace-session-list-unread.test.ts \
  src/app/pages/sidebar-directory-session-wiring.test.ts
```

Expected: PASS.

**Step 2: Run the standard app checks**

Run:

```bash
pnpm typecheck
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: PASS.

**Step 3: Desktop sanity check**

This feature depends on the real Tauri app surface but does not have a reliable existing deterministic way to force an assistant response into a background session without invoking a real model. Do not add a brittle model-dependent E2E test unless the harness gains a deterministic assistant event fixture.

Run the desktop preflight from `docs/dev/testing-playbook.md` before any desktop runtime launch:

```bash
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite.js|bun --watch src/cli\\.ts|/target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
```

If the matches are internally started dev/test runtimes from this repo, stop them and verify the post-check is empty:

```bash
pkill -f "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite.js|bun --watch src/cli\\.ts|/target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite.js|bun --watch src/cli\\.ts|/target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
```

Then run:

```bash
cd packages/desktop
pnpm tauri build --debug --no-bundle -- --features e2e

cd ../e2e
pnpm test --spec ./specs/session.spec.ts
```

Expected: PASS. Record if desktop E2E is skipped and why.

**Step 4: Final review**

Run:

```bash
git status --short
git log --oneline -6
```

Expected: only intended committed changes, no unrelated dirty files.
