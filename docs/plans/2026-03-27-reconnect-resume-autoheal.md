# Reconnect + Resume Auto-Heal Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Auto-heal transient SSE disconnects (including sleep/wake), continue in-flight runs, and show one-time reconnect status toasts only when any session was running.

**Architecture:** Keep reconnect orchestration in `createSessionStore` (session-layer source of truth), add explicit outage-episode tracking for one-time toast semantics, and run bounded catch-up sync for sessions that were running when the outage started. Surface reconnect toast intents to `SessionView` through `app.tsx`, with locale strings in English and Czech.

**Tech Stack:** SolidJS signals/stores, OpenCode SDK client (`session.get/messages/todo`, `permission.list`, `question.list`), Node built-in test runner (`node:test`), i18n locale maps.

---

### Task 1: Add reconnect episode model tests first

**Files:**
- Create: `packages/app/src/app/context/session-reconnect.test.ts`
- Create: `packages/app/src/app/context/session-reconnect.ts`
- Test: `packages/app/src/app/context/session-reconnect.test.ts`

**Step 1: Write the failing test**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  beginOutageEpisode,
  clearOutageEpisode,
  isRunningStatus,
  shouldShowReconnected,
} from "./session-reconnect";

test("beginOutageEpisode captures running sessions including non-selected", () => {
  const state = beginOutageEpisode({ a: "running", b: "retry", c: "idle" });
  assert.equal(state.active, true);
  assert.deepEqual(state.runningSessionIds.sort(), ["a", "b"]);
  assert.equal(state.hadRunningSessions, true);
  assert.equal(state.shownReconnecting, false);
  assert.equal(state.shownReconnected, false);
});

test("idle-only outage does not mark running sessions", () => {
  const state = beginOutageEpisode({ a: "idle", b: "idle" });
  assert.equal(state.hadRunningSessions, false);
  assert.deepEqual(state.runningSessionIds, []);
});

test("isRunningStatus treats retry as running", () => {
  assert.equal(isRunningStatus("running"), true);
  assert.equal(isRunningStatus("retry"), true);
  assert.equal(isRunningStatus("idle"), false);
});

test("shouldShowReconnected is true once per outage", () => {
  const state = beginOutageEpisode({ a: "running" });
  assert.equal(shouldShowReconnected(state), true);
  assert.equal(shouldShowReconnected({ ...state, shownReconnected: true }), false);
});

test("clearOutageEpisode resets all flags", () => {
  const cleared = clearOutageEpisode();
  assert.equal(cleared.active, false);
  assert.equal(cleared.hadRunningSessions, false);
  assert.deepEqual(cleared.runningSessionIds, []);
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @neatech/veslo-ui test:unit -- src/app/context/session-reconnect.test.ts`
Expected: FAIL because helper module does not exist yet.

**Step 3: Write minimal implementation**

Create pure helpers in `session-reconnect.ts`:

```ts
export const isRunningStatus = (status: string | null | undefined) =>
  status === "running" || status === "retry";
```

Also add `beginOutageEpisode`, `shouldShowReconnected`, `clearOutageEpisode`.

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @neatech/veslo-ui test:unit -- src/app/context/session-reconnect.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/context/session-reconnect.ts packages/app/src/app/context/session-reconnect.test.ts
git commit -m "test: add reconnect episode state model"
```

### Task 2: Add failing store tests for one-time reconnect notice behavior

**Files:**
- Create: `packages/app/src/app/context/session-reconnect-store.test.ts`
- Modify: `packages/app/src/app/context/session.ts`
- Test: `packages/app/src/app/context/session-reconnect-store.test.ts`

**Step 1: Write the failing test**

```ts
test("emits reconnecting/reconnected once when outage starts with running sessions", async () => {
  // Mock event.subscribe stream: connected -> stream end/error -> reconnect -> connected.
  // Seed session statuses with running + idle sessions.
  // Assert notice callback receives ["reconnecting", "reconnected"] exactly once.
});

test("emits no reconnect notices when outage starts idle-only", async () => {
  // Same interruption, but all statuses idle.
  // Assert callback is never called.
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @neatech/veslo-ui test:unit -- src/app/context/session-reconnect-store.test.ts`
Expected: FAIL before outage-gating exists.

**Step 3: Write minimal implementation in store reconnect loop**

- Extend `createSessionStore` options:

```ts
onReconnectNotice?: (notice: "reconnecting" | "reconnected") => void;
```

- Track outage episode state per SSE lifecycle.
- When disconnect is detected, snapshot running session IDs from full `store.sessionStatus`.
- Emit `onReconnectNotice("reconnecting")` only once per outage and only if snapshot contains at least one running session.
- Ensure abort-path disconnects are not silently dropped when reconnect should proceed.

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @neatech/veslo-ui test:unit -- src/app/context/session-reconnect-store.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/context/session.ts packages/app/src/app/context/session-reconnect-store.test.ts
git commit -m "feat: gate reconnect notices by running sessions"
```

### Task 3: Add failing test for reconnect catch-up scope

**Files:**
- Modify: `packages/app/src/app/context/session-reconnect-store.test.ts`
- Modify: `packages/app/src/app/context/session.ts`
- Test: `packages/app/src/app/context/session-reconnect-store.test.ts`

**Step 1: Write the failing test**

```ts
test("reconnect catch-up refreshes status/messages/todos only for sessions running at outage start", async () => {
  // Outage starts with A running, B idle.
  // After reconnect, assert calls to session.get/messages/todo for A only.
  // Assert permission.list + question.list refresh once.
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @neatech/veslo-ui test:unit -- src/app/context/session-reconnect-store.test.ts`
Expected: FAIL because current reconnect resync only refreshes status.

**Step 3: Write minimal implementation**

On successful reconnection:
- For each `runningSessionIdsAtOutageStart`, fetch:
  - `session.get`
  - `session.messages` (using existing per-session message-limit fallback)
  - `session.todo`
- Fail soft per session and continue.
- Refresh pending permissions/questions once after per-session catch-up.
- Never call `session.prompt()`.
- Emit `onReconnectNotice("reconnected")` once only for running-session outages.
- Clear outage episode state.

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @neatech/veslo-ui test:unit -- src/app/context/session-reconnect-store.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/context/session.ts packages/app/src/app/context/session-reconnect-store.test.ts
git commit -m "feat: catch up running sessions after reconnect"
```

### Task 4: Add failing UI/i18n test and wire reconnect toasts

**Files:**
- Modify: `packages/app/src/app/app.tsx`
- Modify: `packages/app/src/app/pages/session.tsx`
- Modify: `packages/app/src/app/pages/session-scroll-behavior.test.ts` (or new focused test)
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/cs.ts`

**Step 1: Write the failing test**

```ts
test("SessionView maps reconnect notice to localized toast keys", () => {
  // Assert source contains mapping:
  // reconnecting -> tr("session.reconnecting_toast")
  // reconnected -> tr("session.reconnected_toast")
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @neatech/veslo-ui test:unit -- src/app/pages/session-scroll-behavior.test.ts`
Expected: FAIL until new prop/effect/keys exist.

**Step 3: Write minimal implementation**

- In `app.tsx`:
  - add signal for reconnect notice (`"reconnecting" | "reconnected" | null`)
  - pass `onReconnectNotice` into `createSessionStore`
  - pass notice prop and clear callback to `SessionView`
- In `session.tsx`:
  - add props for reconnect notice and clear callback
  - add effect: map notices to toasts and clear consumed notice
- In locales:
  - `en.ts`: add `session.reconnecting_toast = "Reconnecting..."`, `session.reconnected_toast = "Reconnected"`
  - `cs.ts`: add `session.reconnecting_toast = "Znovu se připojuji..."`, `session.reconnected_toast = "Znovu připojeno"`

**Step 4: Run tests to verify pass**

Run: `pnpm --filter @neatech/veslo-ui test:unit -- src/app/pages/session-scroll-behavior.test.ts`
Expected: PASS.

Run: `pnpm --filter @neatech/veslo-ui test:i18n`
Expected: PASS (en/cs parity maintained).

**Step 5: Commit**

```bash
git add packages/app/src/app/app.tsx packages/app/src/app/pages/session.tsx packages/app/src/app/pages/session-scroll-behavior.test.ts packages/app/src/i18n/locales/en.ts packages/app/src/i18n/locales/cs.ts
git commit -m "feat: show one-time reconnect toasts with czech translation"
```

### Task 5: Document final behavior

**Files:**
- Modify: `PRODUCT.md` (session UX behavior)
- Modify: `ARCHITECTURE.md` (runtime reconnect behavior)

**Step 1: Write documentation updates**

- Describe when reconnect toasts appear:
  - only for outages with at least one running session
  - exactly one `Reconnecting...` and one `Reconnected` per outage
- Describe idle-session behavior:
  - no reconnect toasts
  - no auto-start/retry of idle sessions
- Describe catch-up scope:
  - only sessions running at outage start are refreshed on reconnect

**Step 2: Run docs sanity check**

Run: `rg -n "reconnect|Reconnected|running session|idle" PRODUCT.md ARCHITECTURE.md`
Expected: matches include the newly added sections.

**Step 3: Commit**

```bash
git add PRODUCT.md ARCHITECTURE.md
git commit -m "docs: describe reconnect auto-heal behavior"
```

### Task 6: Final verification before completion

**Files:**
- Modify: none
- Test: targeted and full guards

**Step 1: Run targeted tests**

```bash
pnpm --filter @neatech/veslo-ui test:unit -- src/app/context/session-reconnect.test.ts
pnpm --filter @neatech/veslo-ui test:unit -- src/app/context/session-reconnect-store.test.ts
pnpm --filter @neatech/veslo-ui test:unit -- src/app/pages/session-scroll-behavior.test.ts
pnpm --filter @neatech/veslo-ui test:i18n
```

Expected: all pass.

**Step 2: Run broad unit suite (if runtime allows)**

```bash
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: PASS. If failures are unrelated, capture and report them explicitly.

**Step 3: Final commit (if batching preferred over per-task commits)**

```bash
git add packages/app/src/app/context/session-reconnect.ts packages/app/src/app/context/session-reconnect.test.ts packages/app/src/app/context/session-reconnect-store.test.ts packages/app/src/app/context/session.ts packages/app/src/app/app.tsx packages/app/src/app/pages/session.tsx packages/app/src/app/pages/session-scroll-behavior.test.ts packages/app/src/i18n/locales/en.ts packages/app/src/i18n/locales/cs.ts PRODUCT.md ARCHITECTURE.md
git commit -m "feat: auto-heal reconnect for running sessions with one-time notices"
```
