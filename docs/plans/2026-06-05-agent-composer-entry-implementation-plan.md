# Agent Composer Entry Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the empty new-session quickstart prompt area with a centered composer entry surface that shows and can switch the target project/workspace while protecting pending drafts.

**Architecture:** Keep pending draft ownership in `app.tsx`, where Tauri draft storage and workspace activation already live. Add a small pure conflict model for deterministic tests, then pass target options and switch actions into `SessionView`; the session page owns presentation, picker state, and the conflict modal. Reuse the existing pending draft storage rather than adding a new persistence layer.

**Tech Stack:** SolidJS, TypeScript, Tauri pending draft commands, lucide-solid icons, Node test runner with `tsx/esm`, WebdriverIO desktop E2E.

---

Use @test-driven-development for implementation and @verification-before-completion before final completion. When editing `packages/app/src/**/*.tsx`, follow `.opencode/skills/solidjs-patterns/SKILL.md`. The worktree may have unrelated dirty files; stage and commit only the files named in each task.

### Task 1: Pending Draft Conflict Model

**Files:**
- Create: `packages/app/src/app/lib/composer-target-draft-conflict.ts`
- Test: `packages/app/src/app/lib/composer-target-draft-conflict.test.ts`

**Step 1: Write the failing test**

Create `composer-target-draft-conflict.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  composerDraftHasMeaningfulContent,
  draftPreviewText,
  resolveComposerTargetConflict,
} from "./composer-target-draft-conflict.js";
import type { ComposerDraft } from "../types.js";

const draft = (text: string): ComposerDraft => ({
  mode: "prompt",
  parts: text ? [{ type: "text", text }] : [],
  attachments: [],
  text,
  resolvedText: text,
});

test("composerDraftHasMeaningfulContent ignores whitespace-only text", () => {
  assert.equal(composerDraftHasMeaningfulContent(draft("   ")), false);
  assert.equal(composerDraftHasMeaningfulContent(draft("Ship it")), true);
  assert.equal(
    composerDraftHasMeaningfulContent({ ...draft(""), attachments: [{ id: "a", name: "x.txt", mimeType: "text/plain", size: 1, kind: "inline", dataUrl: "data:text/plain;base64,eA==" }] }),
    true,
  );
});

test("resolveComposerTargetConflict only prompts when both sides have different content", () => {
  assert.equal(resolveComposerTargetConflict({ current: draft(""), destination: draft("old") }).kind, "load-destination");
  assert.equal(resolveComposerTargetConflict({ current: draft("new"), destination: null }).kind, "use-current");
  assert.equal(resolveComposerTargetConflict({ current: draft("same"), destination: draft("same") }).kind, "load-destination");
  assert.equal(resolveComposerTargetConflict({ current: draft("new"), destination: draft("old") }).kind, "conflict");
});

test("draftPreviewText returns compact text for modal previews", () => {
  assert.equal(draftPreviewText(draft("one\\n\\n two")), "one two");
  assert.equal(draftPreviewText({ ...draft(""), attachments: [{ id: "a", name: "brief.pdf", mimeType: "application/pdf", size: 1, kind: "inline", dataUrl: "data:application/pdf;base64,eA==" }] }), "brief.pdf");
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/lib/composer-target-draft-conflict.test.ts
```

Expected: FAIL because `composer-target-draft-conflict.ts` does not exist.

**Step 3: Write minimal implementation**

Create `composer-target-draft-conflict.ts`:

```ts
import type { ComposerDraft } from "../types";

export type ComposerTargetConflictDecision =
  | { kind: "none" }
  | { kind: "use-current" }
  | { kind: "load-destination" }
  | { kind: "conflict"; currentPreview: string; destinationPreview: string };

export function composerDraftHasMeaningfulContent(draft: ComposerDraft | null | undefined): boolean {
  if (!draft) return false;
  if (draft.text.trim() || (draft.resolvedText ?? "").trim()) return true;
  if (draft.attachments.length > 0) return true;
  return draft.parts.some((part) => part.type !== "text" || part.text.trim().length > 0);
}

export function draftPreviewText(draft: ComposerDraft | null | undefined): string {
  if (!draft) return "";
  const text = (draft.text || draft.resolvedText || "")
    .replace(/\s+/g, " ")
    .trim();
  if (text) return text;
  const firstAttachment = draft.attachments[0]?.name?.trim();
  if (firstAttachment) return firstAttachment;
  const firstNonTextPart = draft.parts.find((part) => part.type !== "text");
  return firstNonTextPart ? "Příloha nebo odkaz" : "";
}

export function resolveComposerTargetConflict(input: {
  current: ComposerDraft;
  destination: ComposerDraft | null;
}): ComposerTargetConflictDecision {
  const currentHasContent = composerDraftHasMeaningfulContent(input.current);
  const destinationHasContent = composerDraftHasMeaningfulContent(input.destination);
  if (!currentHasContent && !destinationHasContent) return { kind: "none" };
  if (currentHasContent && !destinationHasContent) return { kind: "use-current" };
  if (!currentHasContent && destinationHasContent) return { kind: "load-destination" };
  const currentPreview = draftPreviewText(input.current);
  const destinationPreview = draftPreviewText(input.destination);
  if (currentPreview === destinationPreview) return { kind: "load-destination" };
  return { kind: "conflict", currentPreview, destinationPreview };
}
```

**Step 4: Run test to verify it passes**

Run the same focused command. Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/lib/composer-target-draft-conflict.ts \
  packages/app/src/app/lib/composer-target-draft-conflict.test.ts
git commit -m "test(app): cover composer target draft conflicts"
```

### Task 2: Target Types And App State Contract

**Files:**
- Modify: `packages/app/src/app/types.ts`
- Modify: `packages/app/src/app/app.tsx`
- Test: `packages/app/src/app/pages/session-composer-entry.test.ts`

**Step 1: Write the failing source-contract test**

Create `session-composer-entry.test.ts`:

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const sessionSource = readFileSync(new URL("./session.tsx", import.meta.url), "utf8");
const typesSource = readFileSync(new URL("../types.ts", import.meta.url), "utf8");

test("session view receives composer target picker state from app", () => {
  assert.match(typesSource, /export type ComposerTargetOption = \{/);
  assert.match(typesSource, /export type ComposerTargetSwitchResult =/);
  assert.match(appSource, /composerTargetOptions: composerTargetOptions\(\)/);
  assert.match(appSource, /activeComposerTargetId: activeComposerTargetId\(\)/);
  assert.match(appSource, /switchComposerTarget/);
  assert.match(sessionSource, /composerTargetOptions: ComposerTargetOption\[\];/);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/session-composer-entry.test.ts
```

Expected: FAIL because the types and props do not exist.

**Step 3: Add the app/session contract**

In `types.ts`, add:

```ts
export type ComposerTargetKind = "chat" | "workspace" | "choose-workspace";

export type ComposerTargetOption = {
  id: string;
  kind: ComposerTargetKind;
  label: string;
  description: string;
  workspaceId?: string;
  directory?: string | null;
  draftStatus?: "draft" | null;
};

export type ComposerTargetConflict = {
  targetId: string;
  targetLabel: string;
  currentPreview: string;
  destinationPreview: string;
};

export type ComposerTargetSwitchResolution = "use-current" | "load-existing";

export type ComposerTargetSwitchResult =
  | { status: "switched" }
  | { status: "cancelled" }
  | { status: "blocked"; message: string }
  | { status: "conflict"; conflict: ComposerTargetConflict };
```

In `SessionViewProps`, add corresponding props:

```ts
composerTargetOptions: ComposerTargetOption[];
activeComposerTargetId: string | null;
switchComposerTarget: (
  targetId: string,
  resolution?: ComposerTargetSwitchResolution,
) => Promise<ComposerTargetSwitchResult>;
```

In `sessionProps()` in `app.tsx`, pass placeholder values so the test can pass before behavior exists:

```ts
composerTargetOptions: composerTargetOptions(),
activeComposerTargetId: activeComposerTargetId(),
switchComposerTarget,
```

Add temporary `createMemo`/function stubs near the pending draft state:

```ts
const composerTargetOptions = createMemo<ComposerTargetOption[]>(() => []);
const activeComposerTargetId = createMemo(() => activePendingDraftKey());
const switchComposerTarget = async (): Promise<ComposerTargetSwitchResult> => ({ status: "cancelled" });
```

**Step 4: Run test to verify it passes**

Run the focused source test. Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/types.ts packages/app/src/app/app.tsx \
  packages/app/src/app/pages/session.tsx packages/app/src/app/pages/session-composer-entry.test.ts
git commit -m "test(app): wire composer target contract"
```

### Task 3: Build Target Options From Workspaces And Pending Drafts

**Files:**
- Modify: `packages/app/src/app/app.tsx`
- Test: `packages/app/src/app/pages/session-composer-entry.test.ts`

**Step 1: Extend the failing source-contract test**

Add:

```ts
test("app builds target options from workspaces and pending drafts", () => {
  assert.match(appSource, /const \[pendingDraftSummaries, setPendingDraftSummaries\]/);
  assert.match(appSource, /pendingSessionDraftsList\(\)/);
  assert.match(appSource, /draftStatus: .*\\? \"draft\" : null/s);
  assert.match(appSource, /kind: "chat"/);
  assert.match(appSource, /kind: "workspace"/);
});
```

**Step 2: Run test to verify it fails**

Run the focused source test. Expected: FAIL until app state is implemented.

**Step 3: Implement pending draft summaries and target options**

In `app.tsx`:

- import `type ComposerTargetOption`
- add `pendingDraftSummaries` signal
- add `refreshPendingDraftSummaries`
- call it after pending draft create/load/delete/consume paths

Use existing `resolvePendingDraftKey` for target ids:

```ts
const [pendingDraftSummaries, setPendingDraftSummaries] = createSignal<PendingSessionDraftSummary[]>([]);

const refreshPendingDraftSummaries = async () => {
  if (!isTauriRuntime()) {
    setPendingDraftSummaries([]);
    return;
  }
  const summaries = (await pendingSessionDraftsList()).filter((draft) => !isConsumedPendingDraftId(draft.id));
  setPendingDraftSummaries(summaries);
};
```

Build options:

```ts
const composerTargetOptions = createMemo<ComposerTargetOption[]>(() => {
  const summaries = pendingDraftSummaries();
  const hasDraft = (key: string) =>
    summaries.some((draft) => {
      try {
        return resolvePendingDraftKey({
          kind: draft.kind,
          workspaceId: draft.workspaceId,
          directory: draft.directory ?? null,
          privateWorkspaceId: draft.privateWorkspaceId ?? null,
        }) === key;
      } catch {
        return false;
      }
    });

  const chatId = resolvePendingDraftKey({ kind: "new-private" });
  const options: ComposerTargetOption[] = [{
    id: chatId,
    kind: "chat",
    label: t("session.target_chat_label", currentLocale()),
    description: t("session.target_chat_description", currentLocale()),
    draftStatus: hasDraft(chatId) ? "draft" : null,
  }];

  for (const workspace of workspaceStore.workspaces()) {
    const directory = normalizeDirectoryPath(workspace.directory?.trim() || workspace.path?.trim() || "");
    if (!workspace.id || !directory) continue;
    const id = resolvePendingDraftKey({ kind: "directory", workspaceId: workspace.id, directory });
    options.push({
      id,
      kind: "workspace",
      workspaceId: workspace.id,
      directory,
      label: workspaceLabel(workspace),
      description: directory,
      draftStatus: hasDraft(id) ? "draft" : null,
    });
  }

  options.push({
    id: "__choose-workspace__",
    kind: "choose-workspace",
    label: t("session.target_choose_workspace_label", currentLocale()),
    description: t("session.target_choose_workspace_description", currentLocale()),
  });

  return options;
});
```

**Step 4: Run test to verify it passes**

Run the focused source test. Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/app.tsx packages/app/src/app/pages/session-composer-entry.test.ts
git commit -m "feat(app): derive composer target options"
```

### Task 4: Implement Safe Target Switching

**Files:**
- Modify: `packages/app/src/app/app.tsx`
- Test: `packages/app/src/app/pages/session-composer-entry.test.ts`

**Step 1: Add failing assertions for switching**

Add:

```ts
test("switchComposerTarget returns conflict before mutating active draft", () => {
  assert.match(appSource, /resolveComposerTargetConflict\(\{/);
  assert.match(appSource, /status: "conflict"/);
  assert.match(appSource, /resolution === "use-current"/);
  assert.match(appSource, /resolution === "load-existing"/);
  assert.match(appSource, /setActivePendingDraftKey\(target\.id\)/);
});
```

**Step 2: Run test to verify it fails**

Run the focused source test. Expected: FAIL until switching logic exists.

**Step 3: Replace the stub with real logic**

In `app.tsx`, implement helpers:

- `findComposerTargetOption(targetId)`
- `findPendingDraftSummaryForTarget(target)`
- `loadPendingDraftComposer(summary)`
- `putPendingDraftForTarget(target, draft)`
- `activateTargetWorkspace(target)`

Switch algorithm:

```ts
const switchComposerTarget = async (
  targetId: string,
  resolution?: ComposerTargetSwitchResolution,
): Promise<ComposerTargetSwitchResult> => {
  const target = composerTargetOptions().find((option) => option.id === targetId) ?? null;
  if (!target) return { status: "blocked", message: t("session.target_not_available", currentLocale()) };
  if (target.kind === "choose-workspace") {
    const result = await openDirectorySessionFromPicker();
    return result === "opened" ? { status: "switched" } : { status: "cancelled" };
  }
  if (target.id === activeComposerTargetId()) return { status: "switched" };

  const currentDraft = composerDraft();
  const destinationSummary = findPendingDraftSummaryForTarget(target);
  const destinationDraft = destinationSummary ? await loadPendingDraftComposer(destinationSummary) : null;
  const decision = resolveComposerTargetConflict({ current: currentDraft, destination: destinationDraft });

  if (decision.kind === "conflict" && !resolution) {
    return {
      status: "conflict",
      conflict: {
        targetId,
        targetLabel: target.label,
        currentPreview: decision.currentPreview,
        destinationPreview: decision.destinationPreview,
      },
    };
  }

  await activateTargetWorkspace(target);

  if (resolution === "use-current" || decision.kind === "use-current") {
    const summary = await putPendingDraftForTarget(target, currentDraft);
    setActivePendingDraftKey(target.id);
    setActivePendingDraftMeta(summary);
    setComposerDraftBySessionId((current) => setSessionComposerDraft(current, { storageKey: target.id }, currentDraft));
    await refreshPendingDraftSummaries();
    setView("session");
    return { status: "switched" };
  }

  if (destinationSummary && destinationDraft) {
    setActivePendingDraftKey(target.id);
    setActivePendingDraftMeta(destinationSummary);
    setComposerDraftBySessionId((current) => setSessionComposerDraft(current, { storageKey: target.id }, destinationDraft));
    setView("session");
    return { status: "switched" };
  }

  const emptyDraft = createEmptyComposerDraft();
  const summary = await putPendingDraftForTarget(target, emptyDraft);
  setActivePendingDraftKey(target.id);
  setActivePendingDraftMeta(summary);
  setComposerDraftBySessionId((current) => setSessionComposerDraft(current, { storageKey: target.id }, emptyDraft));
  await refreshPendingDraftSummaries();
  setView("session");
  return { status: "switched" };
};
```

Keep existing `openNewSessionWithDirectory` and `openDirectoryPendingDraft` behavior intact; this new switcher is for the empty composer entry picker.

**Step 4: Run test to verify it passes**

Run the focused source test. Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/app.tsx packages/app/src/app/pages/session-composer-entry.test.ts
git commit -m "feat(app): switch composer targets safely"
```

### Task 5: Target Picker And Conflict Modal Components

**Files:**
- Create: `packages/app/src/app/components/session/composer-target-picker.tsx`
- Create: `packages/app/src/app/components/session/composer-target-conflict-modal.tsx`
- Test: `packages/app/src/app/pages/session-composer-entry.test.ts`

**Step 1: Add failing component contract assertions**

Add:

```ts
const pickerSource = readFileSync(new URL("../components/session/composer-target-picker.tsx", import.meta.url), "utf8");
const conflictSource = readFileSync(new URL("../components/session/composer-target-conflict-modal.tsx", import.meta.url), "utf8");

test("target picker and conflict modal expose stable test hooks", () => {
  assert.match(pickerSource, /data-testid="composer-target-picker"/);
  assert.match(pickerSource, /data-testid="composer-target-option"/);
  assert.match(pickerSource, /session\.target_draft_badge/);
  assert.match(conflictSource, /data-testid="composer-target-conflict-modal"/);
  assert.match(conflictSource, /data-testid="composer-target-use-current"/);
  assert.match(conflictSource, /data-testid="composer-target-load-existing"/);
  assert.match(conflictSource, /session\.target_conflict_escape_hint/);
});
```

**Step 2: Run test to verify it fails**

Run the focused source test. Expected: FAIL because the files do not exist.

**Step 3: Create components**

`composer-target-picker.tsx` should:

- render a button pill with active option label/description;
- open a menu below the pill;
- show options with icon, label, description, and draft badge;
- call `onSelect(option.id)`;
- close on outside click and Escape.

`composer-target-conflict-modal.tsx` should:

- use `ModalShell` or the existing modal primitives;
- render `Esc zavře` and an `X` close button in the top-right;
- render current and destination previews side by side;
- place `Použít aktuální text` under the current preview;
- place `Načíst původní draft` under the destination preview;
- call `onResolve("use-current")`, `onResolve("load-existing")`, or `onCancel()`.

**Step 4: Run test to verify it passes**

Run the focused source test. Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/components/session/composer-target-picker.tsx \
  packages/app/src/app/components/session/composer-target-conflict-modal.tsx \
  packages/app/src/app/pages/session-composer-entry.test.ts
git commit -m "feat(app): add composer target picker components"
```

### Task 6: Center Empty Composer Entry In Session View

**Files:**
- Modify: `packages/app/src/app/pages/session.tsx`
- Modify: `packages/app/src/app/components/session/composer.tsx`
- Test: `packages/app/src/app/pages/session-inline-loading.test.ts`
- Test: `packages/app/src/app/pages/session-composer-entry.test.ts`

**Step 1: Update failing tests**

In `session-inline-loading.test.ts`, replace the quickstart test with composer-entry expectations:

```ts
test("optimistic first submit replaces the centered composer entry immediately", () => {
  assert.match(
    sessionSource,
    /const showComposerEntryState = createMemo\(\(\) =>\s*effectiveRenderedMessages\(\)\.length === 0 &&\s*!showWorkspaceSetupEmptyState\(\) &&\s*!showSessionLoadingState\(\),\s*\);/s,
  );
  assert.match(sessionSource, /<Show when=\{showComposerEntryState\(\)\}>/);
  assert.doesNotMatch(sessionSource, /showQuickstartEmptyState/);
});
```

In `session-composer-entry.test.ts`, add:

```ts
test("session empty state renders target picker above centered composer", () => {
  assert.match(sessionSource, /data-testid="composer-entry-target-heading"/);
  assert.match(sessionSource, /<ComposerTargetPicker/);
  assert.match(sessionSource, /entryPlacement="center"/);
  assert.doesNotMatch(sessionSource, /handleBrowserAutomationQuickstart/);
  assert.doesNotMatch(sessionSource, /handleSoulQuickstart/);
});
```

**Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/session-inline-loading.test.ts src/app/pages/session-composer-entry.test.ts
```

Expected: FAIL until the old quickstart state is removed and centered entry exists.

**Step 3: Implement session layout**

In `composer.tsx`, add:

```ts
entryPlacement?: "footer" | "center";
```

Use it to switch the root shell classes:

```tsx
const rootClass = createMemo(() =>
  props.entryPlacement === "center"
    ? "relative z-20 bg-transparent px-0 pt-0 pb-0"
    : `sticky bottom-0 z-20 bg-gradient-to-t from-gray-1 via-gray-1 to-transparent px-8 ${props.compactTopSpacing ? "pt-0" : "pt-12"} pb-3`,
);
```

In `session.tsx`:

- remove quickstart imports, handlers, cards, and `showQuickstartEmptyState`;
- add `showComposerEntryState`;
- render a centered stack inside the scroll content with target heading and `ComposerTargetPicker`;
- render `<Composer entryPlacement="center" ... />` in that stack;
- keep the existing sticky footer composer only when `!showComposerEntryState()`;
- keep workspace setup and session loading states unchanged.

**Step 4: Run tests to verify they pass**

Run the same focused tests. Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/pages/session.tsx packages/app/src/app/components/session/composer.tsx \
  packages/app/src/app/pages/session-inline-loading.test.ts packages/app/src/app/pages/session-composer-entry.test.ts
git commit -m "feat(app): center composer entry for new sessions"
```

### Task 7: Localized Copy And Documentation

**Files:**
- Modify: `packages/app/src/i18n/locales/cs.ts`
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/zh.ts`
- Modify: `docs/features/session-runtime.md`
- Test: `packages/app/src/app/pages/session-composer-entry.test.ts`

**Step 1: Add failing localization assertions**

Add:

```ts
const csSource = readFileSync(new URL("../../i18n/locales/cs.ts", import.meta.url), "utf8");
const enSource = readFileSync(new URL("../../i18n/locales/en.ts", import.meta.url), "utf8");
const zhSource = readFileSync(new URL("../../i18n/locales/zh.ts", import.meta.url), "utf8");

test("composer target copy is localized in primary locales", () => {
  for (const source of [csSource, enSource, zhSource]) {
    assert.match(source, /"session\.target_chat_label":/);
    assert.match(source, /"session\.target_draft_badge":/);
    assert.match(source, /"session\.target_conflict_title":/);
    assert.match(source, /"session\.target_conflict_escape_hint":/);
  }
});
```

**Step 2: Run test to verify it fails**

Run the focused source test. Expected: FAIL until strings exist.

**Step 3: Add copy and docs**

Add Czech strings matching the approved design:

```ts
"session.target_chat_label": "Chat",
"session.target_chat_description": "Soukromý prostor bez projektu",
"session.target_choose_workspace_label": "Slash workspace",
"session.target_choose_workspace_description": "Vybrat jiný workspace…",
"session.target_draft_badge": "Rozepsáno",
"session.target_heading_chat": "Vkládáš do chatu",
"session.target_heading_workspace": "Vkládáš do projektu {name}",
"session.target_conflict_title": "Ve {name} už je rozepsaná zpráva",
"session.target_conflict_description": "Vyberte, co se má stát před přepnutím cíle komunikace.",
"session.target_conflict_current": "Aktuální text",
"session.target_conflict_existing": "Rozepsáno ve {name}",
"session.target_conflict_use_current": "Použít aktuální text",
"session.target_conflict_load_existing": "Načíst původní draft",
"session.target_conflict_escape_hint": "Esc zavře",
"session.target_not_available": "Cíl komunikace není dostupný.",
```

Add equivalent English and Chinese entries. Remove old `session.quickstart_*` keys only if no remaining references exist after Task 6.

Update `docs/features/session-runtime.md` under Pending Drafts / Composer:

- empty pending sessions show a centered composer entry;
- target picker can switch between chat and workspace pending drafts;
- draft conflicts require explicit resolution.

**Step 4: Run tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/session-composer-entry.test.ts
pnpm --filter @neatech/veslo-ui test:i18n
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/i18n/locales/cs.ts packages/app/src/i18n/locales/en.ts \
  packages/app/src/i18n/locales/zh.ts docs/features/session-runtime.md \
  packages/app/src/app/pages/session-composer-entry.test.ts
git commit -m "docs(app): document composer target entry"
```

### Task 8: Desktop E2E Coverage

**Files:**
- Modify: `packages/e2e/specs/composer.spec.ts`

**Step 1: Add failing E2E tests**

Extend `composer.spec.ts` with tests that use stable selectors:

```ts
it("shows the centered composer target entry on a new session route", async () => {
  await navigateToHash("/session");
  await waitForHashRoute("#/session", 5000);
  await expect($('[data-testid="composer-entry-target-heading"]')).toBeDisplayed();
  await expect($('[data-testid="composer-target-picker"]')).toBeDisplayed();
});

it("opens the target picker and exposes draft-aware options", async () => {
  await $('[data-testid="composer-target-picker"]').click();
  await expect($$('[data-testid="composer-target-option"]')[0]).toBeDisplayed();
});
```

Add a conflict-path E2E that:

1. reads the active workspace with `workspace_bootstrap`;
2. writes a pending directory draft through `pending_session_drafts_put`;
3. types current composer text;
4. opens the picker and selects the matching workspace option;
5. expects `[data-testid="composer-target-conflict-modal"]`;
6. clicks `[data-testid="composer-target-load-existing"]` and verifies the composer text changed.

Use the existing `tauriInvoke` pattern from `session.spec.ts`; keep helpers local to `composer.spec.ts` unless they are reused.

**Step 2: Run source/unit checks first**

Run:

```bash
pnpm typecheck
pnpm --filter @neatech/veslo-ui test:unit
pnpm --filter @neatech/veslo-ui test:i18n
```

Expected: PASS before the expensive desktop run.

**Step 3: Run desktop E2E preflight**

Run from repo root:

```bash
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|@tauri-apps/cli/tauri\\.js dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite\\.js|bun --watch src/cli\\.ts|(^|/)target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
pkill -f "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|@tauri-apps/cli/tauri\\.js dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite\\.js|bun --watch src/cli\\.ts|(^|/)target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|@tauri-apps/cli/tauri\\.js dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite\\.js|bun --watch src/cli\\.ts|(^|/)target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
```

If a process is not clearly an internally started dev/test process from this repo, stop and ask the user before killing it.

**Step 4: Build and run focused desktop E2E**

Run:

```bash
cd packages/desktop
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.dev.conf.json -- --features e2e

cd ../e2e
pnpm test --spec ./specs/composer.spec.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/e2e/specs/composer.spec.ts
git commit -m "test(e2e): cover composer target entry"
```

### Task 9: Final Verification And Cleanup

**Files:**
- Review all files changed in Tasks 1-8.

**Step 1: Run final checks**

Run from repo root:

```bash
pnpm typecheck
pnpm --filter @neatech/veslo-ui test:unit
pnpm --filter @neatech/veslo-ui test:i18n
```

Run the focused desktop E2E again if any app/session code changed after Task 8.

**Step 2: Inspect git status**

Run:

```bash
git status --short
```

Expected: only unrelated pre-existing files remain dirty.

**Step 3: Summarize verification**

Record:

- exact commands run;
- pass/fail result;
- any skipped desktop test reason;
- any unrelated dirty files left untouched.
