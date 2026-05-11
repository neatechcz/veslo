# Auto-Download Desktop Updates Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Veslo download newly detected desktop updates by default while preserving a Settings opt-out and the manual download flow for users who disable it.

**Architecture:** Keep the existing Tauri updater, release feed, updater signatures, and install/relaunch flow unchanged. Move the default/preference logic into small testable helpers in the updater context, wire those helpers into app startup/reset behavior, then adjust Settings and left-menu copy so the normal path is progress followed by `Update`.

**Tech Stack:** SolidJS, Tauri updater plugin, TypeScript, Node test runner with `tsx/esm`, Veslo desktop runtime.

---

### Task 1: Add Testable Auto-Download Defaults

**Files:**
- Modify: `packages/app/src/app/context/updater.ts`
- Test: `packages/app/src/app/context/updater.test.ts`

**Step 1: Write the failing tests**

Add tests that define the new default and preference resolution behavior:

```ts
import { createRoot } from "solid-js";

import {
  DEFAULT_UPDATE_AUTO_DOWNLOAD,
  resolveUpdateAutoDownloadPreference,
  createUpdaterState,
} from "./updater.js";

test("auto-download defaults to enabled", () => {
  assert.equal(DEFAULT_UPDATE_AUTO_DOWNLOAD, true);

  createRoot((dispose) => {
    const updater = createUpdaterState();
    assert.equal(updater.updateAutoDownload(), true);
    dispose();
  });
});

test("stored auto-download preference overrides the default", () => {
  assert.equal(resolveUpdateAutoDownloadPreference(null), true);
  assert.equal(resolveUpdateAutoDownloadPreference(""), true);
  assert.equal(resolveUpdateAutoDownloadPreference("1"), true);
  assert.equal(resolveUpdateAutoDownloadPreference("0"), false);
  assert.equal(resolveUpdateAutoDownloadPreference("unexpected"), true);
});
```

Keep the existing `shouldAutoCheckForUpdatesAt` tests.

**Step 2: Run the focused test and verify it fails**

Run from repo root:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/context/updater.test.ts
```

Expected: FAIL because `DEFAULT_UPDATE_AUTO_DOWNLOAD` and `resolveUpdateAutoDownloadPreference` do not exist, and `createUpdaterState()` still defaults auto-download to false.

**Step 3: Implement the minimal updater helper changes**

In `packages/app/src/app/context/updater.ts`, add:

```ts
export const DEFAULT_UPDATE_AUTO_DOWNLOAD = true;

export function resolveUpdateAutoDownloadPreference(stored: string | null) {
  if (stored === "0") return false;
  if (stored === "1") return true;
  return DEFAULT_UPDATE_AUTO_DOWNLOAD;
}
```

Then change the signal default:

```ts
const [updateAutoDownload, setUpdateAutoDownload] = createSignal(DEFAULT_UPDATE_AUTO_DOWNLOAD);
```

**Step 4: Run the focused test and verify it passes**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/context/updater.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/context/updater.ts packages/app/src/app/context/updater.test.ts
git commit -m "feat(app): default update downloads on"
```

---

### Task 2: Wire Defaults Into Startup And Reset

**Files:**
- Modify: `packages/app/src/app/app.tsx`
- Test: `packages/app/src/app/context/updater.test.ts`

**Step 1: Write the failing startup preference tests**

Add a pure helper test so `app.tsx` does not duplicate preference rules:

```ts
import { resolveUpdateStartupPreferences } from "./updater.js";

test("startup update preferences default to auto-check and auto-download enabled", () => {
  assert.deepEqual(
    resolveUpdateStartupPreferences({
      storedAutoCheck: null,
      storedAutoDownload: null,
    }),
    { autoCheck: true, autoDownload: true },
  );
});

test("startup update preferences preserve explicit auto-download opt-out", () => {
  assert.deepEqual(
    resolveUpdateStartupPreferences({
      storedAutoCheck: "0",
      storedAutoDownload: "0",
    }),
    { autoCheck: false, autoDownload: false },
  );
});

test("startup update preferences let enabled auto-download imply auto-check", () => {
  assert.deepEqual(
    resolveUpdateStartupPreferences({
      storedAutoCheck: "0",
      storedAutoDownload: null,
    }),
    { autoCheck: true, autoDownload: true },
  );
  assert.deepEqual(
    resolveUpdateStartupPreferences({
      storedAutoCheck: "0",
      storedAutoDownload: "1",
    }),
    { autoCheck: true, autoDownload: true },
  );
});
```

This test should stay in `updater.test.ts`; it protects the startup contract outside the large app component.

**Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/context/updater.test.ts
```

Expected: FAIL because `resolveUpdateStartupPreferences` does not exist.

**Step 3: Implement the startup preference helper**

In `packages/app/src/app/context/updater.ts`, add:

```ts
export function resolveUpdateStartupPreferences(input: {
  storedAutoCheck: string | null;
  storedAutoDownload: string | null;
}) {
  const autoDownload = resolveUpdateAutoDownloadPreference(input.storedAutoDownload);
  const autoCheck = autoDownload || input.storedAutoCheck !== "0";
  return { autoCheck, autoDownload };
}
```

**Step 4: Update app startup preference hydration**

In `packages/app/src/app/app.tsx`, update the updater import:

```ts
import {
  DEFAULT_UPDATE_AUTO_DOWNLOAD,
  resolveUpdateStartupPreferences,
  shouldAutoCheckForUpdatesAt,
} from "./context/updater";
```

Replace the current `storedUpdateAutoCheck` and `storedUpdateAutoDownload` blocks with:

```ts
const storedUpdateAutoCheck = window.localStorage.getItem(
  "veslo.updateAutoCheck"
);
const storedUpdateAutoDownload = window.localStorage.getItem(
  "veslo.updateAutoDownload"
);
const startupUpdatePreferences = resolveUpdateStartupPreferences({
  storedAutoCheck: storedUpdateAutoCheck,
  storedAutoDownload: storedUpdateAutoDownload,
});
setUpdateAutoCheck(startupUpdatePreferences.autoCheck);
setUpdateAutoDownload(startupUpdatePreferences.autoDownload);
```

This preserves an explicit stored `0`, preserves an explicit stored `1`, and treats no stored value as enabled.

**Step 5: Update reset defaults**

In the reset flow, change:

```ts
setUpdateAutoDownload(false);
```

to:

```ts
setUpdateAutoDownload(DEFAULT_UPDATE_AUTO_DOWNLOAD);
```

Keep `setUpdateAutoCheck(true);` as-is.

**Step 6: Run focused unit tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/context/updater.test.ts
```

Expected: PASS.

**Step 7: Commit**

```bash
git add packages/app/src/app/app.tsx packages/app/src/app/context/updater.ts packages/app/src/app/context/updater.test.ts
git commit -m "feat(app): hydrate update download preference"
```

---

### Task 3: Adjust Left-Menu Update Actions

**Files:**
- Modify: `packages/app/src/app/pages/dashboard.tsx`
- Modify: `packages/app/src/app/pages/session.tsx`
- Modify: `packages/app/src/app/app.tsx`
- Test: `packages/app/src/app/pages/sidebar-update-prompt-actions.test.ts`

**Step 1: Write source-level tests for auto-download-aware actions**

Extend `sidebar-update-prompt-actions.test.ts` with assertions that dashboard/session only show the manual `Download` action when auto-download is disabled.

Example assertions:

```ts
test("left-menu manual download action is only exposed when auto-download is disabled", () => {
  assert.match(dashboardSource, /updateStatus\?\.state === "available" && !props\.updateAutoDownload/);
  assert.match(sessionSource, /updateStatus\?\.state === "available" && !props\.updateAutoDownload/);
  assert.match(sessionSource, /updateAutoDownload: boolean;/);
  assert.match(dashboardSource, /updateAutoDownload={props\.updateAutoDownload}/);
});
```

Adjust the exact regex if the implementation uses a local `state` variable, but keep the test focused on the contract: auto-download enabled must not expose the manual `Download` action.

**Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/sidebar-update-prompt-actions.test.ts
```

Expected: FAIL because dashboard/session currently return the `Download` action for every `available` state.

**Step 3: Pass updateAutoDownload into the session view**

In `packages/app/src/app/pages/session.tsx`, add to the props type:

```ts
updateAutoDownload: boolean;
```

In `packages/app/src/app/app.tsx`, pass the current signal wherever the session page is created:

```tsx
updateAutoDownload={updateAutoDownload()}
```

Dashboard already receives `updateAutoDownload`.

**Step 4: Gate the manual Download action in dashboard**

In `packages/app/src/app/pages/dashboard.tsx`, update `updatePillActionLabel`:

```ts
const updatePillActionLabel = createMemo(() => {
  const state = props.updateStatus?.state;
  if (state === "available" && !props.updateAutoDownload) return t("settings.sidebar_download_update", currentLocale());
  if (state === "ready") return t("settings.sidebar_install_update", currentLocale());
  return null;
});
```

Update `handleUpdatePillClick`:

```ts
if (state === "available") {
  if (!props.updateAutoDownload) {
    props.downloadUpdate();
  }
  return;
}
```

Keep the ready/install behavior unchanged.

**Step 5: Gate the manual Download action in session**

Apply the same `updatePillActionLabel` and available-click behavior in `packages/app/src/app/pages/session.tsx`.

**Step 6: Run the focused sidebar test**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/sidebar-update-prompt-actions.test.ts
```

Expected: PASS.

**Step 7: Commit**

```bash
git add packages/app/src/app/pages/dashboard.tsx packages/app/src/app/pages/session.tsx packages/app/src/app/app.tsx packages/app/src/app/pages/sidebar-update-prompt-actions.test.ts
git commit -m "feat(app): hide manual update download by default"
```

---

### Task 4: Update Settings Copy And Localized Preparing State

**Files:**
- Modify: `packages/app/src/app/pages/settings.tsx`
- Modify: `packages/app/src/app/pages/dashboard.tsx`
- Modify: `packages/app/src/app/pages/session.tsx`
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/cs.ts`
- Modify: `packages/app/src/i18n/locales/zh.ts`
- Test: `packages/app/src/app/pages/sidebar-update-prompt-actions.test.ts`

**Step 1: Write failing localization/source assertions**

Add assertions:

```ts
test("left-menu preparing update copy is localized", () => {
  for (const source of [enLocale, csLocale, zhLocale]) {
    assert.match(source, /"settings\.sidebar_update_preparing"/);
  }
  assert.match(dashboardSource, /settings\.sidebar_update_preparing/);
  assert.match(sessionSource, /settings\.sidebar_update_preparing/);
});
```

**Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/sidebar-update-prompt-actions.test.ts
```

Expected: FAIL because the new key is not present.

**Step 3: Add localized copy**

Add:

```ts
"settings.sidebar_update_preparing": "Preparing update",
```

For Czech:

```ts
"settings.sidebar_update_preparing": "Pripravuji update",
```

For Chinese:

```ts
"settings.sidebar_update_preparing": "正在准备更新",
```

Keep ASCII if the Czech locale file is already ASCII-only; otherwise match the existing file style.

Update the auto-update hint to clarify the default behavior:

```ts
"settings.auto_update_hint": "Downloads new versions automatically after they are detected. Turn off to download manually.",
```

Use equivalent Czech and Chinese copy in their locale files.

**Step 4: Use preparing copy when auto-download is enabled**

In dashboard/session `updatePillLabel`, before the fallback available label:

```ts
if (state === "available" && props.updateAutoDownload) {
  return t("settings.sidebar_update_preparing", currentLocale());
}
```

In `updatePillTitle`, use the same preparing label for `available` with auto-download enabled.

**Step 5: Hide Settings manual action when auto-download is enabled**

In `packages/app/src/app/pages/settings.tsx`, update `generalUpdateActionLabel`:

```ts
if (updateState() === "available" && !props.updateAutoDownload) return translate("settings.download_update");
```

Keep the ready install action unchanged.

**Step 6: Run localization and focused source tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/sidebar-update-prompt-actions.test.ts
pnpm --filter @neatech/veslo-ui test:i18n
```

Expected: PASS.

**Step 7: Commit**

```bash
git add packages/app/src/app/pages/settings.tsx packages/app/src/app/pages/dashboard.tsx packages/app/src/app/pages/session.tsx packages/app/src/i18n/locales/en.ts packages/app/src/i18n/locales/cs.ts packages/app/src/i18n/locales/zh.ts packages/app/src/app/pages/sidebar-update-prompt-actions.test.ts
git commit -m "feat(app): clarify automatic update downloads"
```

---

### Task 5: Update Canonical Docs

**Files:**
- Modify: `docs/desktop-updater.md`
- Modify: `docs/features/settings-and-preferences.md`
- Modify: `docs/dev/state-and-config-reference.md`

**Step 1: Update updater behavior docs**

In `docs/desktop-updater.md`, change the automatic download section to say:

```md
Downloads start automatically by default after an update is detected. Users can opt out through Settings, which keeps the update in the available state until they choose Download manually.
```

Also update the local storage key description so `veslo.updateAutoDownload` is documented as default-on.

**Step 2: Update Settings behavior docs**

In `docs/features/settings-and-preferences.md`, update General Preferences:

```md
- update check and default-on auto-download behavior
```

Add one sentence:

```md
Desktop update downloads are enabled by default; Settings can opt out to keep the manual download action.
```

**Step 3: Update state reference**

In `docs/dev/state-and-config-reference.md`, add below the key list:

```md
`veslo.updateAutoDownload` is default-on when absent. A stored `0` is an explicit opt-out and keeps the manual download flow.
```

**Step 4: Review the docs diff**

Run:

```bash
git diff -- docs/desktop-updater.md docs/features/settings-and-preferences.md docs/dev/state-and-config-reference.md
```

Expected: Only updater preference semantics changed.

**Step 5: Commit**

```bash
git add docs/desktop-updater.md docs/features/settings-and-preferences.md docs/dev/state-and-config-reference.md
git commit -m "docs: update desktop auto-download behavior"
```

---

### Task 6: Run Verification

**Files:**
- No source edits expected.

**Step 1: Run focused tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/context/updater.test.ts src/app/pages/sidebar-update-prompt-actions.test.ts
pnpm --filter @neatech/veslo-ui test:i18n
```

Expected: PASS.

**Step 2: Run app typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

**Step 3: Run desktop runtime preflight**

Run from repo root:

```bash
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite.js|bun --watch src/cli\\.ts|/target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
```

If matches are internally started dev/test processes from this repo, stop them:

```bash
pkill -f "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite.js|bun --watch src/cli\\.ts|/target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
```

Verify clear:

```bash
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite.js|bun --watch src/cli\\.ts|/target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
```

Expected: no relevant process remains. If a process looks user-launched or unrelated, stop and report it instead of killing it.

**Step 4: Launch the real desktop runtime**

Run:

```bash
pnpm dev
```

Expected: Veslo launches through `packages/desktop`, not through `packages/web` or raw Vite as the runtime under test.

**Step 5: Manually verify updater UI in desktop**

In the desktop app:

- Open Settings.
- Confirm auto-update/download is on by default for a clean profile or after reset.
- Toggle it off and confirm a detected available update would expose manual `Download`.
- Toggle it on and confirm the normal available state does not expose manual `Download`.
- If an update is actually available from the public feed, confirm it enters downloading/ready and the final action is `Update`.

Expected: install still blocks when active runs exist.

**Step 6: Final status**

Run:

```bash
git status --short
```

Expected: only intended implementation/doc changes are present. Pre-existing unrelated changes should remain untouched and be called out in the final summary.
