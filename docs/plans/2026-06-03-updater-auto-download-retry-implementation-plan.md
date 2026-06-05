# Updater Auto-Download Retry Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add bounded automatic retry for failed desktop update downloads while keeping update installation manual.

**Architecture:** Keep the Tauri updater plugin as the authority for checking, downloading, signature validation, and installation. Add retry policy helpers to the Solid updater context, wire the app state machine to schedule clean re-download attempts with fresh update handles, and update Settings/sidebar UI to expose retry progress and manual recovery.

**Tech Stack:** SolidJS, Tauri updater plugin, TypeScript, node:test with `tsx/esm`, existing source-contract tests, Veslo desktop updater docs.

---

### Task 1: Add Retry Policy Model

**Files:**
- Modify: `packages/app/src/app/context/updater.ts`
- Test: `packages/app/src/app/context/updater.test.ts`

**Step 1: Write the failing tests**

Add tests for retry constants and scheduling:

```ts
import {
  UPDATE_AUTO_DOWNLOAD_RETRY_DELAYS_MS,
  UPDATE_AUTO_DOWNLOAD_MAX_RETRIES,
  resolveNextUpdateDownloadRetry,
} from "./updater.js";

test("auto-download retry policy uses three bounded backoff attempts", () => {
  assert.deepEqual(UPDATE_AUTO_DOWNLOAD_RETRY_DELAYS_MS, [
    30_000,
    2 * 60_000,
    10 * 60_000,
  ]);
  assert.equal(UPDATE_AUTO_DOWNLOAD_MAX_RETRIES, 3);
});

test("auto-download retry policy schedules the next clean retry", () => {
  const now = 1_800_000_000_000;

  assert.deepEqual(resolveNextUpdateDownloadRetry({ completedRetries: 0, now }), {
    kind: "scheduled",
    retryAttempt: 1,
    maxRetries: 3,
    nextRetryAt: now + 30_000,
  });

  assert.deepEqual(resolveNextUpdateDownloadRetry({ completedRetries: 1, now }), {
    kind: "scheduled",
    retryAttempt: 2,
    maxRetries: 3,
    nextRetryAt: now + 2 * 60_000,
  });

  assert.deepEqual(resolveNextUpdateDownloadRetry({ completedRetries: 2, now }), {
    kind: "scheduled",
    retryAttempt: 3,
    maxRetries: 3,
    nextRetryAt: now + 10 * 60_000,
  });
});

test("auto-download retry policy exhausts after the third retry fails", () => {
  assert.deepEqual(resolveNextUpdateDownloadRetry({ completedRetries: 3, now: 1000 }), {
    kind: "exhausted",
    retryAttempt: 3,
    maxRetries: 3,
  });
});
```

**Step 2: Run the focused test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/context/updater.test.ts
```

Expected: FAIL because the retry constants and helper do not exist.

**Step 3: Implement the retry policy**

Add the retry constants, metadata type, and helper:

```ts
export const UPDATE_AUTO_DOWNLOAD_RETRY_DELAYS_MS = [
  30_000,
  2 * 60_000,
  10 * 60_000,
] as const;

export const UPDATE_AUTO_DOWNLOAD_MAX_RETRIES = UPDATE_AUTO_DOWNLOAD_RETRY_DELAYS_MS.length;

export type UpdateDownloadRetryInfo =
  | { kind: "active"; retryAttempt: number; maxRetries: number }
  | { kind: "scheduled"; retryAttempt: number; maxRetries: number; nextRetryAt: number; message?: string }
  | { kind: "exhausted"; retryAttempt: number; maxRetries: number; message?: string };

export function resolveNextUpdateDownloadRetry(input: { completedRetries: number; now?: number }) {
  const completedRetries = Math.max(0, Math.floor(input.completedRetries));
  if (completedRetries >= UPDATE_AUTO_DOWNLOAD_MAX_RETRIES) {
    return {
      kind: "exhausted" as const,
      retryAttempt: UPDATE_AUTO_DOWNLOAD_MAX_RETRIES,
      maxRetries: UPDATE_AUTO_DOWNLOAD_MAX_RETRIES,
    };
  }

  const retryAttempt = completedRetries + 1;
  const delay = UPDATE_AUTO_DOWNLOAD_RETRY_DELAYS_MS[completedRetries] ?? 0;
  return {
    kind: "scheduled" as const,
    retryAttempt,
    maxRetries: UPDATE_AUTO_DOWNLOAD_MAX_RETRIES,
    nextRetryAt: (input.now ?? Date.now()) + delay,
  };
}
```

**Step 4: Run the focused test to verify it passes**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/context/updater.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/context/updater.ts packages/app/src/app/context/updater.test.ts
git commit -m "test(app): model updater download retry policy"
```

### Task 2: Add Retry-Aware Update Status Helpers

**Files:**
- Modify: `packages/app/src/app/context/updater.ts`
- Test: `packages/app/src/app/context/updater.test.ts`

**Step 1: Write the failing tests**

Add tests that turn automatic download failures into either a scheduled retry or a final error:

```ts
import { resolveAutoDownloadFailureStatus } from "./updater.js";

test("auto-download failure schedules a retry while attempts remain", () => {
  const status = resolveAutoDownloadFailureStatus({
    lastCheckedAt: 100,
    version: "2026.6.1",
    notes: "Release notes",
    completedRetries: 0,
    now: 1_000,
    message: "network error",
  });

  assert.deepEqual(status, {
    state: "downloading",
    lastCheckedAt: 100,
    version: "2026.6.1",
    totalBytes: null,
    downloadedBytes: 0,
    notes: "Release notes",
    retry: {
      kind: "scheduled",
      retryAttempt: 1,
      maxRetries: 3,
      nextRetryAt: 31_000,
      message: "network error",
    },
  });
});

test("auto-download failure becomes visible error after retries are exhausted", () => {
  const status = resolveAutoDownloadFailureStatus({
    lastCheckedAt: 100,
    version: "2026.6.1",
    completedRetries: 3,
    now: 1_000,
    message: "signature mismatch",
  });

  assert.deepEqual(status, {
    state: "error",
    lastCheckedAt: 100,
    message: "signature mismatch",
    version: "2026.6.1",
    retry: {
      kind: "exhausted",
      retryAttempt: 3,
      maxRetries: 3,
      message: "signature mismatch",
    },
  });
});
```

**Step 2: Run the focused test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/context/updater.test.ts
```

Expected: FAIL because `resolveAutoDownloadFailureStatus` and retry fields are not implemented.

**Step 3: Extend status types and helper**

Update `UpdateStatus`:

```ts
  | {
      state: "downloading";
      lastCheckedAt: number;
      version: string;
      totalBytes: number | null;
      downloadedBytes: number;
      notes?: string;
      retry?: Extract<UpdateDownloadRetryInfo, { kind: "active" | "scheduled" }>;
    }
  | {
      state: "error";
      lastCheckedAt: number | null;
      message: string;
      version?: string;
      retry?: Extract<UpdateDownloadRetryInfo, { kind: "exhausted" }>;
    };
```

Add helper:

```ts
export function resolveAutoDownloadFailureStatus(input: {
  lastCheckedAt: number;
  version: string;
  notes?: string;
  completedRetries: number;
  now?: number;
  message: string;
}): UpdateStatus {
  const retry = resolveNextUpdateDownloadRetry({
    completedRetries: input.completedRetries,
    now: input.now,
  });

  if (retry.kind === "scheduled") {
    return {
      state: "downloading",
      lastCheckedAt: input.lastCheckedAt,
      version: input.version,
      totalBytes: null,
      downloadedBytes: 0,
      notes: input.notes,
      retry: { ...retry, message: input.message },
    };
  }

  return {
    state: "error",
    lastCheckedAt: input.lastCheckedAt,
    message: input.message,
    version: input.version,
    retry: { ...retry, message: input.message },
  };
}
```

**Step 4: Run the focused test to verify it passes**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/context/updater.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/context/updater.ts packages/app/src/app/context/updater.test.ts
git commit -m "feat(app): add updater download retry status model"
```

### Task 3: Wire Retry Into System State

**Files:**
- Modify: `packages/app/src/app/system-state.ts`
- Test: `packages/app/src/app/system-state-updater-retry.test.ts`

**Step 1: Write the failing source-contract test**

Create a focused source test:

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./system-state.ts", import.meta.url), "utf8");

test("system state schedules automatic updater download retries", () => {
  assert.match(source, /resolveAutoDownloadFailureStatus/);
  assert.match(source, /type\s+DownloadUpdateOptions/);
  assert.match(source, /automatic\?:\s*boolean/);
  assert.match(source, /retryAttempt\?:\s*number/);
  assert.match(source, /refreshBeforeDownload\?:\s*boolean/);
});

test("scheduled updater retries refresh the update handle before downloading", () => {
  assert.match(source, /async function refreshPendingUpdateForDownload/);
  assert.match(source, /requireUpdate\?:\s*boolean/);
  assert.match(source, /await check\(\{ timeout: 8_000 \}\)/);
  assert.match(source, /throw new Error\("Update is no longer available\."\)/);
  assert.match(source, /refreshBeforeDownload[\s\S]*refreshPendingUpdateForDownload/);
});

test("manual updater downloads do not enter the automatic retry loop", () => {
  assert.match(source, /if \(optionsDownload\?\.automatic\)/);
  assert.match(source, /resolveAutoDownloadFailureStatus\(\{/);
  assert.match(source, /else[\s\S]*setUpdateStatus\(\{ state: "error"/);
});

test("system state exposes a manual retry entry point", () => {
  assert.match(source, /async function retryUpdateDownload\(\)/);
  assert.match(source, /downloadUpdate\(\{[\s\S]*refreshBeforeDownload: true[\s\S]*\}\)/);
  assert.match(source, /retryUpdateDownload,/);
});
```

**Step 2: Run the focused test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/system-state-updater-retry.test.ts
```

Expected: FAIL because the retry wiring does not exist.

**Step 3: Implement minimal system-state changes**

Import the helper and retry constant:

```ts
import {
  UPDATE_AUTO_DOWNLOAD_MAX_RETRIES,
  createUpdaterState,
  resolveAutoDownloadFailureStatus,
} from "./context/updater";
```

Add options:

```ts
type DownloadUpdateOptions = {
  automatic?: boolean;
  retryAttempt?: number;
  refreshBeforeDownload?: boolean;
};
```

Add a quiet refresh helper near `checkForUpdates`. It must be usable in two modes: manual retry can quietly become idle when no update is available, while automatic retry should treat a missing update as a failed retry attempt.

```ts
async function refreshPendingUpdateForDownload(optionsRefresh?: { requireUpdate?: boolean }) {
  const update = (await check({ timeout: 8_000 })) as unknown as UpdateHandle | null;
  const checkedAt = Date.now();
  if (!update) {
    if (optionsRefresh?.requireUpdate) {
      throw new Error("Update is no longer available.");
    }
    setPendingUpdate(null);
    setUpdateStatus({ state: "idle", lastCheckedAt: checkedAt });
    return null;
  }

  const notes = typeof update.body === "string" ? update.body : undefined;
  const pending = { update, version: update.version, notes };
  setPendingUpdate(pending);
  return { pending, checkedAt, date: update.date };
}
```

Change `downloadUpdate` signature and setup. Keep the refresh inside the same `try` block as the actual download so failed quiet checks and missing-update checks can use the same retry policy.

```ts
async function downloadUpdate(optionsDownload?: DownloadUpdateOptions) {
  let pending = pendingUpdate();
  const state = updateStatus();
  let lastCheckedAt = state.state === "available" || state.state === "downloading"
    ? state.lastCheckedAt
    : Date.now();

  try {
    if (optionsDownload?.refreshBeforeDownload) {
      const refreshed = await refreshPendingUpdateForDownload({
        requireUpdate: Boolean(optionsDownload.automatic),
      });
      if (!refreshed) return;
      pending = refreshed.pending;
      lastCheckedAt = refreshed.checkedAt;
    }

    if (!pending) return;
    // existing guard, progress setup, download call, and ready state follow
  } catch (e) {
    // use the same automatic-vs-manual retry/error handling as the download catch
  }
}
```

When setting active downloading state, add retry metadata for automatic retries:

```ts
retry:
  optionsDownload?.automatic && (optionsDownload.retryAttempt ?? 0) > 0
    ? {
        kind: "active",
        retryAttempt: optionsDownload.retryAttempt ?? 0,
        maxRetries: UPDATE_AUTO_DOWNLOAD_MAX_RETRIES,
      }
    : undefined,
```

In the download catch block:

```ts
const failedPending = pending ?? pendingUpdate();
if (!failedPending) {
  setUpdateStatus({ state: "error", lastCheckedAt, message });
  return;
}

if (optionsDownload?.automatic) {
  setUpdateStatus(
    resolveAutoDownloadFailureStatus({
      lastCheckedAt,
      version: failedPending.version,
      notes: failedPending.notes,
      completedRetries: optionsDownload.retryAttempt ?? 0,
      message,
    }),
  );
  return;
}

setUpdateStatus({ state: "error", lastCheckedAt, message, version: failedPending.version });
```

Add a manual retry entry point:

```ts
async function retryUpdateDownload() {
  return downloadUpdate({ refreshBeforeDownload: true });
}
```

Return `retryUpdateDownload` from `createSystemState`.

**Step 4: Run focused tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/context/updater.test.ts src/app/system-state-updater-retry.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/context/updater.ts packages/app/src/app/system-state.ts packages/app/src/app/context/updater.test.ts packages/app/src/app/system-state-updater-retry.test.ts
git commit -m "feat(app): retry failed automatic updater downloads"
```

### Task 4: Schedule Retry Timers In App Shell

**Files:**
- Modify: `packages/app/src/app/app.tsx`
- Test: `packages/app/src/app/app-updater-retry-scheduling.test.ts`

**Step 1: Write the failing source-contract test**

Create a focused test:

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");

test("app starts initial automatic updater download with automatic mode", () => {
  assert.match(source, /downloadUpdate\(\{ automatic: true \}\)/);
});

test("app schedules retry timers for failed updater downloads", () => {
  assert.match(source, /state\.state !== "downloading"/);
  assert.match(source, /state\.retry\?\.kind !== "scheduled"/);
  assert.match(source, /window\.setTimeout/);
  assert.match(source, /state\.retry\.nextRetryAt - Date\.now\(\)/);
  assert.match(source, /downloadUpdate\(\{[\s\S]*automatic: true[\s\S]*retryAttempt: state\.retry\.retryAttempt[\s\S]*refreshBeforeDownload: true[\s\S]*\}\)/);
  assert.match(source, /onCleanup\(\(\) => window\.clearTimeout/);
});
```

**Step 2: Run the focused test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/app-updater-retry-scheduling.test.ts
```

Expected: FAIL because app timer wiring is missing.

**Step 3: Wire automatic download and scheduled retry timers**

Update the existing auto-download effect:

```ts
downloadUpdate({ automatic: true }).catch(e => reportError(e, "updates.download"));
```

Add a separate effect after it:

```ts
createEffect(() => {
  if (!isTauriRuntime()) return;
  if (!updateAutoDownload()) return;

  const state = updateStatus();
  if (state.state !== "downloading") return;
  if (state.retry?.kind !== "scheduled") return;

  const delayMs = Math.max(0, state.retry.nextRetryAt - Date.now());
  const timeout = window.setTimeout(() => {
    downloadUpdate({
      automatic: true,
      retryAttempt: state.retry!.retryAttempt,
      refreshBeforeDownload: true,
    }).catch(e => reportError(e, "updates.download.retry"));
  }, delayMs);

  onCleanup(() => window.clearTimeout(timeout));
});
```

When destructuring and passing system state through app props, include `retryUpdateDownload`.

**Step 4: Run focused tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/app-updater-retry-scheduling.test.ts src/app/system-state-updater-retry.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/app.tsx packages/app/src/app/app-updater-retry-scheduling.test.ts packages/app/src/app/system-state-updater-retry.test.ts
git commit -m "feat(app): schedule updater download retries"
```

### Task 5: Update Settings And Sidebar UI

**Files:**
- Modify: `packages/app/src/app/pages/settings.tsx`
- Modify: `packages/app/src/app/pages/dashboard.tsx`
- Modify: `packages/app/src/app/pages/session.tsx`
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/cs.ts`
- Modify: `packages/app/src/i18n/locales/zh.ts`
- Test: `packages/app/src/app/pages/settings-tabs-layout.test.ts`
- Test: `packages/app/src/app/pages/sidebar-update-prompt-actions.test.ts`

**Step 1: Write failing UI/source tests**

Extend `settings-tabs-layout.test.ts`:

```ts
test("settings exposes updater download retry states", () => {
  assert.match(source, /settings\.update_retrying_download/);
  assert.match(source, /settings\.update_retrying_in/);
  assert.match(source, /settings\.update_download_failed/);
  assert.match(source, /props\.retryUpdateDownload\(\)/);
});
```

Extend `sidebar-update-prompt-actions.test.ts`:

```ts
test("left-menu update prompts expose exhausted download retry", () => {
  assert.match(dashboardSource, /state === "error"[\s\S]*retry\?\.kind === "exhausted"/);
  assert.match(sessionSource, /state === "error"[\s\S]*retry\?\.kind === "exhausted"/);
  assert.match(dashboardSource, /props\.retryUpdateDownload\(\)/);
  assert.match(sessionSource, /props\.retryUpdateDownload\(\)/);
});

test("updater retry copy is localized", () => {
  for (const source of [enLocale, csLocale, zhLocale]) {
    assert.match(source, /"settings\.update_retrying_download"/);
    assert.match(source, /"settings\.update_retrying_in"/);
    assert.match(source, /"settings\.update_download_failed"/);
    assert.match(source, /"settings\.retry_update_download"/);
  }
});
```

**Step 2: Run focused tests to verify they fail**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/settings-tabs-layout.test.ts src/app/pages/sidebar-update-prompt-actions.test.ts
```

Expected: FAIL because UI and localization are not updated.

**Step 3: Update Settings UI**

Add `retryUpdateDownload: () => void` to `SettingsViewProps`.

Add helpers:

```ts
const updateRetry = () => props.updateStatus?.retry ?? null;
const updateRetryDelayLabel = () => {
  const retry = updateRetry();
  if (retry?.kind !== "scheduled") return null;
  return formatRelativeTime(retry.nextRetryAt);
};
```

Update labels:

```ts
if (updateState() === "downloading" && updateRetry()?.kind === "scheduled") {
  const delay = updateRetryDelayLabel();
  return delay
    ? translate("settings.update_retrying_in").replace("{time}", delay)
    : translate("settings.update_retrying_download");
}
if (updateState() === "downloading" && updateRetry()?.kind === "active") {
  return translate("settings.update_retrying_download");
}
if (updateState() === "error" && updateRetry()?.kind === "exhausted") {
  return translate("settings.update_download_failed");
}
```

Update action selection:

```ts
if (updateState() === "error" && updateRetry()?.kind === "exhausted") {
  return translate("settings.retry_update_download");
}
```

Update action handler:

```ts
if (updateState() === "error" && updateRetry()?.kind === "exhausted") {
  props.retryUpdateDownload();
  return;
}
```

**Step 4: Update dashboard and session sidebars**

Add `retryUpdateDownload: () => void` to the relevant props.

Change `showUpdatePill` so exhausted download errors are visible:

```ts
return (
  state === "available" ||
  state === "downloading" ||
  state === "ready" ||
  (state === "error" && props.updateStatus?.retry?.kind === "exhausted")
);
```

Update label/action logic:

```ts
if (state === "downloading" && props.updateStatus?.retry?.kind === "scheduled") {
  return t("settings.update_retrying_download", currentLocale());
}
if (state === "downloading" && props.updateStatus?.retry?.kind === "active") {
  return t("settings.update_retrying_download", currentLocale());
}
if (state === "error" && props.updateStatus?.retry?.kind === "exhausted") {
  return t("settings.update_download_failed", currentLocale());
}
```

```ts
if (state === "error" && props.updateStatus?.retry?.kind === "exhausted") {
  return t("settings.retry_update_download", currentLocale());
}
```

Button click for exhausted errors:

```ts
if (props.updateStatus?.state === "error" && props.updateStatus.retry?.kind === "exhausted") {
  props.retryUpdateDownload();
  return;
}
```

**Step 5: Add localized copy**

Add keys to all locales:

```ts
"settings.update_retrying_download": "Retrying download...",
"settings.update_retrying_in": "Retrying in {time}",
"settings.update_download_failed": "Update download failed",
"settings.retry_update_download": "Retry",
```

Use natural translations for Czech and Chinese.

**Step 6: Run focused tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/settings-tabs-layout.test.ts src/app/pages/sidebar-update-prompt-actions.test.ts
```

Expected: PASS.

**Step 7: Commit**

```bash
git add packages/app/src/app/pages/settings.tsx packages/app/src/app/pages/dashboard.tsx packages/app/src/app/pages/session.tsx packages/app/src/i18n/locales/en.ts packages/app/src/i18n/locales/cs.ts packages/app/src/i18n/locales/zh.ts packages/app/src/app/pages/settings-tabs-layout.test.ts packages/app/src/app/pages/sidebar-update-prompt-actions.test.ts
git commit -m "feat(app): show updater download retry states"
```

### Task 6: Update Documentation

**Files:**
- Modify: `docs/desktop-updater.md`
- Modify: `docs/dev/state-and-config-reference.md`

**Step 1: Write the docs update**

In `docs/desktop-updater.md`, update the download section to say:

```md
Auto-download failures are retried by the app state machine. Veslo retries clean full downloads after 30 seconds, 2 minutes, and 10 minutes. Each retry performs a fresh quiet update check and uses a fresh Tauri update handle. Veslo does not resume partial updater files; the Tauri updater plugin remains responsible for download integrity and signature validation.
```

In `docs/dev/state-and-config-reference.md`, update the `veslo.updateAutoDownload` note:

```md
When enabled, failed automatic update downloads are retried with bounded backoff. The retry state is runtime-only; only the preference and last successful check time are stored.
```

**Step 2: Run a docs/source check**

Run:

```bash
rg -n "retry|partial|resume|updateAutoDownload" docs/desktop-updater.md docs/dev/state-and-config-reference.md
```

Expected: output includes the new retry wording and clearly states that partial resume is not supported.

**Step 3: Commit**

```bash
git add docs/desktop-updater.md docs/dev/state-and-config-reference.md
git commit -m "docs: document updater download retry behavior"
```

### Task 7: Final Verification

**Files:**
- No file changes expected.

**Step 1: Run focused updater tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/context/updater.test.ts src/app/system-state-updater-retry.test.ts src/app/app-updater-retry-scheduling.test.ts src/app/pages/settings-tabs-layout.test.ts src/app/pages/sidebar-update-prompt-actions.test.ts
```

Expected: PASS.

**Step 2: Run app unit tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: PASS.

**Step 3: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

**Step 4: Record updater runtime limitation**

Do not claim a full real updater install was proven unless a two-release desktop updater validation was actually performed. If no two-release validation is run, final verification must say that retry state/model/UI were verified and real install/relaunch remains covered by the existing manual updater flow.

**Step 5: Commit any final fixes**

If verification requires small fixes:

```bash
git add <changed files>
git commit -m "fix(app): finalize updater download retry"
```

If no fixes are needed, do not create an empty commit.
