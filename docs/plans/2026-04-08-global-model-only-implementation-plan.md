# Global Model Only Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove per-session model persistence and make every Veslo run use the single globally configured app model, with no automatic fallback.

**Architecture:** Keep one model source of truth in app state and workspace config: `defaultModel()`. Remove session model overrides, resolved session model caches, and message-history model hydration from runtime routing. Add a startup migration that deletes legacy `veslo.sessionModels.*` keys, update UI copy so session surfaces describe global behavior, and update project docs to state the invariant explicitly.

**Tech Stack:** SolidJS app (`createSignal`, `createMemo`, `createEffect`, JSX), Node test runner (`node --test --import=tsx/esm`), localized string catalogs, Tauri desktop runtime, WebdriverIO e2e.

---

Execution notes:

- Apply `@using-git-worktrees` before the first code change.
- Apply `@test-driven-development` for each behavior change.
- Apply `@verification-before-completion` before claiming done.
- Follow `AGENTS.md` new feature workflow: sync remotes/submodules, use a worktree, start Docker dev stack, run desktop e2e, and capture screenshots.
- Do not preserve compatibility code for session model routing. This is a hard cut.

Pre-flight commands:

```bash
git fetch --all --prune
git submodule update --init --recursive
git worktree add ../Veslo-global-model-only -b codex/global-model-only
cd ../Veslo-global-model-only
```

### Task 1: Lock The Legacy Session-Model Migration Contract

**Files:**
- Modify: `packages/app/src/app/lib/model-persistence.ts`
- Modify: `packages/app/src/app/lib/model-persistence.test.ts`
- Modify: `packages/app/src/app/constants.ts`
- Test: `packages/app/src/app/lib/model-persistence.test.ts`

**Step 1: Write the failing test**

Extend `model-persistence.test.ts` with migration-focused assertions:

```ts
import { collectLegacySessionModelStorageKeys } from "./model-persistence.js";

test("collects only legacy per-session model storage keys", () => {
  const keys = collectLegacySessionModelStorageKeys([
    "veslo.sessionModels.workspace-a",
    "veslo.sessionModels.workspace-b",
    "veslo.defaultModel",
    "veslo.language",
  ]);

  assert.deepEqual(keys, [
    "veslo.sessionModels.workspace-a",
    "veslo.sessionModels.workspace-b",
  ]);
});

test("returns an empty list when no legacy per-session model keys exist", () => {
  assert.deepEqual(
    collectLegacySessionModelStorageKeys(["veslo.defaultModel", "veslo.language"]),
    [],
  );
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/lib/model-persistence.test.ts
```

Expected: FAIL because `collectLegacySessionModelStorageKeys` does not exist yet.

**Step 3: Write minimal implementation**

In `model-persistence.ts`, replace the session override helpers with a migration helper:

```ts
export const collectLegacySessionModelStorageKeys = (keys: string[]) =>
  keys.filter((key) => key.startsWith(`${SESSION_MODEL_PREF_KEY}.`));
```

Then delete:

- `parseSessionModelOverrides(...)`
- `serializeSessionModelOverrides(...)`

Keep `parseDefaultModelFromConfig(...)`, `formatConfigWithDefaultModel(...)`, and `resolveWorkspaceDefaultModel(...)`.

**Step 4: Run test to verify it passes**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/lib/model-persistence.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/lib/model-persistence.ts packages/app/src/app/lib/model-persistence.test.ts packages/app/src/app/constants.ts
git commit -m "refactor(app): add legacy session model cleanup helper"
```

### Task 2: Remove Session Model Routing From App Runtime

**Files:**
- Modify: `packages/app/src/app/app.tsx`
- Create: `packages/app/src/app/global-model-only-runtime.test.ts`
- Test: `packages/app/src/app/global-model-only-runtime.test.ts`

**Step 1: Write the failing test**

Create `global-model-only-runtime.test.ts` as a source-contract test for the runtime model path:

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");

test("selected session model resolves directly from the global default", () => {
  assert.match(
    source,
    /const selectedSessionModel = createMemo<ModelRef>\(\(\) => \{\s*return defaultModel\(\);\s*\}\);/s,
  );
});

test("applyModelSelection no longer writes per-session model state", () => {
  assert.doesNotMatch(source, /setSessionModelOverrideById\(/);
  assert.doesNotMatch(source, /setPendingSessionModel\(/);
});

test("startup migrates and removes legacy session-model keys", () => {
  assert.match(source, /collectLegacySessionModelStorageKeys\(/);
  assert.match(source, /window\.localStorage\.removeItem\(key\)/);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/global-model-only-runtime.test.ts
```

Expected: FAIL because `app.tsx` still contains session-model state and per-session persistence.

**Step 3: Write minimal implementation**

In `app.tsx`:

- remove `sessionModelOverrideById`
- remove `sessionModelById`
- remove `pendingSessionModel`
- remove `sessionModelOverridesReady`
- remove `sessionModelOverridesKey(...)`
- remove effects that read/write `veslo.sessionModels.*`
- add one startup migration that deletes legacy keys via `collectLegacySessionModelStorageKeys(...)`
- make `selectedSessionModel()` return `defaultModel()`
- make `applyModelSelection(...)` always update `defaultModel()` only
- make new session creation stop carrying any pending model state

The target shape is:

```ts
const selectedSessionModel = createMemo<ModelRef>(() => {
  return defaultModel();
});

function applyModelSelection(next: ModelRef) {
  setDefaultModelExplicit(true);
  setDefaultModel(next);
  setModelPickerOpen(false);
}
```

**Step 4: Run test to verify it passes**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/global-model-only-runtime.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/app.tsx packages/app/src/app/global-model-only-runtime.test.ts
git commit -m "refactor(app): make runtime model global only"
```

### Task 3: Remove Session Message Hydration As A Model Source

**Files:**
- Modify: `packages/app/src/app/context/session.ts`
- Modify: `packages/app/src/app/utils/messages.ts`
- Modify: `packages/app/src/app/global-model-only-runtime.test.ts`
- Test: `packages/app/src/app/global-model-only-runtime.test.ts`

**Step 1: Write the failing test**

Extend `global-model-only-runtime.test.ts`:

```ts
const sessionSource = readFileSync(new URL("./context/session.ts", import.meta.url), "utf8");
const messageUtilsSource = readFileSync(new URL("./utils/messages.ts", import.meta.url), "utf8");

test("session hydration does not restore a model from message history", () => {
  assert.doesNotMatch(sessionSource, /lastUserModelFromMessages/);
  assert.doesNotMatch(sessionSource, /setSessionModelState/);
});

test("message helpers do not expose last-user-model lookup for routing", () => {
  assert.doesNotMatch(messageUtilsSource, /export function lastUserModelFromMessages/);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/global-model-only-runtime.test.ts
```

Expected: FAIL because session hydration still backfills model state from message history.

**Step 3: Write minimal implementation**

In `context/session.ts`:

- remove `SessionModelState`
- remove `sessionModelState`, `setSessionModelState`, and `lastUserModelFromMessages` from the store API
- delete the model-restoration branches in:
  - `loadSession(...)` after `session.messages(...)`
  - `message.updated` event handling

In `utils/messages.ts`:

- delete `lastUserModelFromMessages(...)`
- keep `modelFromUserMessage(...)` only if still needed for historical display; otherwise remove it too

The session loader should only update messages/todos/session state, never runtime model choice.

**Step 4: Run test to verify it passes**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/global-model-only-runtime.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/context/session.ts packages/app/src/app/utils/messages.ts packages/app/src/app/global-model-only-runtime.test.ts
git commit -m "refactor(app): drop session model hydration from messages"
```

### Task 4: Update Model Picker Semantics And Copy To Global-Only Language

**Files:**
- Modify: `packages/app/src/app/components/model-picker-modal.tsx`
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/cs.ts`
- Modify: `packages/app/src/i18n/locales/zh.ts`
- Modify: `packages/app/src/app/lib/model-picker-options.test.ts`
- Test: `packages/app/src/app/lib/model-picker-options.test.ts`

**Step 1: Write the failing test**

Extend `model-picker-options.test.ts` or add a small source-contract test section:

```ts
test("session entry points describe the picker as global model selection", () => {
  assert.match(modelPickerModalSource, /settings\.default_model/);
  assert.doesNotMatch(modelPickerModalSource, /settings\.model_description_session/);
});

test("english session model description no longer says next message", () => {
  const enSource = readFileSync(new URL("../../i18n/locales/en.ts", import.meta.url), "utf8");
  assert.doesNotMatch(enSource, /This selection applies to your next message/);
  assert.match(enSource, /all sessions/i);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/lib/model-picker-options.test.ts
```

Expected: FAIL because session UI copy still describes per-session behavior.

**Step 3: Write minimal implementation**

Update copy so every user-facing model selector describes one global model.

Recommended end state:

- `settings.default_model` -> `Global model`
- `settings.model_description_default` -> mentions the choice is used for all sessions
- `settings.session_model` -> same label as global model, or stop branching on `target`
- `settings.model_description_session` -> same global wording, or stop using the key

In `model-picker-modal.tsx`, make both entry points render the same global semantics:

```tsx
<h3>{translate("settings.default_model")}</h3>
<p>{translate("settings.model_description_default")}</p>
```

Keep the pinned unavailable-model behavior from `model-picker-options.ts`.

**Step 4: Run test to verify it passes**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/lib/model-picker-options.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/components/model-picker-modal.tsx packages/app/src/i18n/locales/en.ts packages/app/src/i18n/locales/cs.ts packages/app/src/i18n/locales/zh.ts packages/app/src/app/lib/model-picker-options.test.ts
git commit -m "feat(app): present model selection as global only"
```

### Task 5: Update Project Docs To State The Global Model Invariant

**Files:**
- Modify: `PRODUCT.md`
- Modify: `ARCHITECTURE.md`

**Step 1: Add the documentation updates**

Document these points explicitly in both files:

- Veslo uses one global runtime model.
- Existing sessions automatically use the currently configured global model.
- Per-session model persistence does not exist.
- Veslo never auto-falls back to another model when the configured model is unavailable.

Suggested wording:

```md
Veslo uses one globally configured runtime model for all session execution. Session history may record which model produced past messages, but that metadata is informational only and is never reused for future model routing.
```

**Step 2: Verify the docs contain the new invariant**

Run:

```bash
rg -n "global runtime model|all session execution|never auto-falls back|per-session model persistence does not exist" PRODUCT.md ARCHITECTURE.md
```

Expected: matches in both files.

**Step 3: Commit**

```bash
git add PRODUCT.md ARCHITECTURE.md
git commit -m "docs: document global-only model behavior"
```

### Task 6: Run Required Feature Verification In The Real Desktop Runtime

**Files:**
- Create: `packages/e2e/specs/global-model-only.spec.ts`
- Modify: `evidence/` (add screenshots from the verified flow)
- Test: `packages/e2e/specs/global-model-only.spec.ts`

**Step 1: Write the failing desktop e2e spec**

Create a WebdriverIO spec that verifies:

1. set global model A
2. open or create session X and send a message
3. switch global model B
4. reopen session X
5. verify the UI shows model B as current
6. send again
7. verify the second send uses model B, not the previous session model

Keep the spec focused on visible app behavior plus whatever session metadata the UI already exposes.

**Step 2: Start required dev services**

Run from repo root:

```bash
packaging/docker/dev-up.sh
```

Expected: local Veslo dev stack starts successfully.

**Step 3: Build the desktop app with WebDriver support**

Run:

```bash
cd packages/desktop
pnpm tauri build --debug --no-bundle -- --features e2e
```

Expected: debug desktop binary builds successfully.

**Step 4: Run the desktop e2e spec**

Run:

```bash
cd packages/e2e
pnpm test --spec ./specs/global-model-only.spec.ts
```

Expected: PASS.

**Step 5: Capture screenshots**

Store screenshots for the verified flow under:

```bash
evidence/2026-04-08-global-model-only/
```

Capture at minimum:

- global model set in UI
- existing session reopened under new global model
- successful send after model switch

**Step 6: Final verification**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- src/app/lib/model-persistence.test.ts src/app/global-model-only-runtime.test.ts src/app/lib/model-picker-options.test.ts
pnpm --filter @neatech/veslo-ui typecheck
```

Expected:

- targeted unit tests PASS
- typecheck PASS, or if blocked by unrelated existing failures, capture exact output and separate them from this change before merge

**Step 7: Commit**

```bash
git add packages/e2e/specs/global-model-only.spec.ts evidence/2026-04-08-global-model-only
git commit -m "test(e2e): verify global-only model routing"
```
