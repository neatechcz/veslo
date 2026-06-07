import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readOptionalSource = (path: string) => {
  try {
    return readFileSync(new URL(path, import.meta.url), "utf8");
  } catch {
    return "";
  }
};

const appSource = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const sessionSource = readFileSync(new URL("./session.tsx", import.meta.url), "utf8");
const typesSource = readFileSync(new URL("../types.ts", import.meta.url), "utf8");
const csSource = readFileSync(new URL("../../i18n/locales/cs.ts", import.meta.url), "utf8");
const enSource = readFileSync(new URL("../../i18n/locales/en.ts", import.meta.url), "utf8");
const zhSource = readFileSync(new URL("../../i18n/locales/zh.ts", import.meta.url), "utf8");
const pickerSource = readOptionalSource("../components/session/composer-target-picker.tsx");
const conflictSource = readOptionalSource("../components/session/composer-target-conflict-modal.tsx");
const composerTargetOptionsSource = appSource.slice(
  appSource.indexOf("const composerTargetOptions = createMemo"),
  appSource.indexOf("const activeWorkspaceComposerTargetId = createMemo"),
);
const switchComposerTargetSource = appSource.slice(
  appSource.indexOf("const switchComposerTargetNow = async"),
  appSource.indexOf("let composerTargetSwitchQueue: Promise<void> = Promise.resolve();"),
);
const switchComposerTargetQueueSource = appSource.slice(
  appSource.indexOf("let composerTargetSwitchQueue: Promise<void> = Promise.resolve();"),
  appSource.indexOf("const currentComposerStorageKey = createMemo"),
);

const sourceBetween = (source: string, start: string, end: string) => {
  const startIndex = source.indexOf(start);
  if (startIndex === -1) return "";
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (endIndex === -1) return "";
  return source.slice(startIndex, endIndex);
};

const assertComposerDraftSeededBeforeActivation = (source: string, draftName: string) => {
  const seedIndex = source.indexOf(`setSessionComposerDraft(current, { storageKey: target.id }, ${draftName})`);
  const activationIndex = source.indexOf("setActivePendingDraftKey(target.id)");
  assert.ok(seedIndex >= 0, `${draftName} should be seeded into the target storage key`);
  assert.ok(activationIndex >= 0, "target key should be activated");
  assert.ok(seedIndex < activationIndex, `${draftName} should be seeded before activating the target key`);
};

test("session view receives composer target picker state from app", () => {
  assert.match(typesSource, /export type ComposerTargetOption = \{/);
  assert.match(typesSource, /export type ComposerTargetSwitchResult =/);
  assert.match(appSource, /composerTargetOptions: composerTargetOptions\(\)/);
  assert.match(appSource, /activeComposerTargetId: activeComposerTargetId\(\)/);
  assert.match(appSource, /switchComposerTarget/);
  assert.match(sessionSource, /composerTargetOptions: ComposerTargetOption\[\];/);
});

test("app builds target options from workspaces and pending drafts", () => {
  assert.match(appSource, /const \[pendingDraftSummaries, setPendingDraftSummaries\]/);
  assert.match(appSource, /pendingSessionDraftsList\(\)/);
  assert.match(appSource, /draftStatus: .*\? "draft" : null/s);
  assert.match(appSource, /kind: "workspace"/);
});

test("composer target picker puts chat-only private target first", () => {
  assert.ok(composerTargetOptionsSource, "composer target option builder should be present");
  assert.match(composerTargetOptionsSource, /const chatId = resolvePendingDraftKey\(\{ kind: "new-private" \}\);/);
  assert.match(
    composerTargetOptionsSource,
    /const options: ComposerTargetOption\[\] = \[\{\s*id: chatId,\s*kind: "chat",\s*label: t\("session\.target_chat_label", currentLocale\(\)\),\s*description: "",\s*draftStatus: hasDraft\(chatId\) \? "draft" : null,\s*\}\];/s,
  );
  assert.match(composerTargetOptionsSource, /workspaceStore\.isPrivateWorkspacePath\(directory\)/);
});

test("app defaults composer target display to the active workspace when no pending draft is selected", () => {
  assert.match(appSource, /const activeWorkspaceComposerTargetId = createMemo\(\(\) => \{/);
  assert.match(appSource, /return resolvePendingDraftKey\(\{ kind: "directory", workspaceId, directory \}\);/);
  assert.match(appSource, /const activeComposerTargetId = createMemo\(\(\) => activePendingDraftKey\(\) \?\? activeWorkspaceComposerTargetId\(\)\);/);
});

test("switchComposerTarget returns conflict before mutating active draft", () => {
  assert.match(appSource, /resolveComposerTargetConflict\(\{/);
  assert.match(appSource, /status: "conflict"/);
  assert.match(appSource, /resolution === "use-current"/);
  assert.match(appSource, /resolution === "load-existing"/);
  assert.match(appSource, /setActivePendingDraftKey\(target\.id\)/);
  assert.match(appSource, /if \(target\.id === activePendingDraftKey\(\)\) return \{ status: "switched" \};/);
});

test("switchComposerTarget seeds the target draft before activating the target key", () => {
  assert.ok(switchComposerTargetSource, "composer target switching source should be present");
  const useCurrentBranchSource = sourceBetween(
    switchComposerTargetSource,
    "if (shouldUseCurrent) {",
    "if (shouldLoadExisting && destinationSummary && destinationDraft) {",
  );
  const loadExistingBranchSource = sourceBetween(
    switchComposerTargetSource,
    "if (shouldLoadExisting && destinationSummary && destinationDraft) {",
    "const emptyDraft = createEmptyComposerDraft();",
  );
  const emptyBranchSource = sourceBetween(
    switchComposerTargetSource,
    "const emptyDraft = createEmptyComposerDraft();",
    "return { status: \"switched\" };\n  };",
  );

  assertComposerDraftSeededBeforeActivation(useCurrentBranchSource, "currentDraft");
  assertComposerDraftSeededBeforeActivation(loadExistingBranchSource, "destinationDraft");
  assertComposerDraftSeededBeforeActivation(emptyBranchSource, "emptyDraft");
});

test("switchComposerTarget moves current pending drafts instead of cloning them", () => {
  assert.ok(switchComposerTargetSource, "composer target switching source should be present");
  const useCurrentBranchSource = sourceBetween(
    switchComposerTargetSource,
    "if (shouldUseCurrent) {",
    "if (shouldLoadExisting && destinationSummary && destinationDraft) {",
  );

  assert.match(
    useCurrentBranchSource,
    /const previousPendingDraftKey = currentComposerStorageKey\(\);[\s\S]*const previousPendingDraftMeta = activePendingDraftMeta\(\);/,
    "target switches should snapshot the original composer storage before writing the destination",
  );

  const seedIndex = useCurrentBranchSource.indexOf("setSessionComposerDraft(current, { storageKey: target.id }, currentDraft)");
  const activationIndex = useCurrentBranchSource.indexOf("setActivePendingDraftKey(target.id)");
  const cleanupIndex = useCurrentBranchSource.indexOf("await consumeMovedPendingDraft({");

  assert.ok(seedIndex >= 0, "current draft should be seeded into the destination key");
  assert.ok(activationIndex >= 0, "destination key should be activated");
  assert.ok(cleanupIndex >= 0, "original pending draft should be consumed after the move");
  assert.ok(seedIndex < activationIndex, "destination draft must be seeded before activation");
  assert.ok(activationIndex < cleanupIndex, "stale source writes must be invalidated before source cleanup");
  assert.match(
    useCurrentBranchSource,
    /previousStorageKey: previousPendingDraftKey,[\s\S]*previousSummary: previousPendingDraftMeta,[\s\S]*nextStorageKey: target\.id,[\s\S]*nextSummary: summary,/s,
    "move cleanup should know both the previous and destination pending identities",
  );
});

test("switchComposerTarget serializes rapid target changes", () => {
  assert.ok(switchComposerTargetQueueSource, "composer target switch queue should be present");
  assert.match(
    switchComposerTargetQueueSource,
    /let composerTargetSwitchQueue: Promise<void> = Promise\.resolve\(\);/,
    "target switches should have a shared queue",
  );
  assert.match(
    switchComposerTargetQueueSource,
    /const queuedSwitch = composerTargetSwitchQueue[\s\S]*\.then\(\(\) => switchComposerTargetNow\(targetId, resolution\)\);/,
    "each target switch should run after the previous switch settles",
  );
  assert.match(
    switchComposerTargetQueueSource,
    /composerTargetSwitchQueue = queuedSwitch\.then\(\(\) => undefined, \(\) => undefined\);/,
    "the queue should keep accepting switches after a failed operation",
  );
});

test("switchComposerTarget blocks when an existing destination draft cannot be loaded", () => {
  assert.match(appSource, /if \(destinationSummary && !destinationDraft\) \{/);
});

test("switchComposerTarget routes picked workspaces through safe switching", () => {
  assert.match(appSource, /selectComposerWorkspaceTargetFromPicker/);
  assert.match(appSource, /targetId: target\.id/);
  assert.doesNotMatch(
    appSource,
    /if \(target\.kind === "choose-workspace"\) \{\s*const result = await openDirectorySessionFromPicker\(\);/s,
  );
});

test("target picker and conflict modal expose stable test hooks", () => {
  assert.match(pickerSource, /data-testid="composer-target-picker"/);
  assert.match(pickerSource, /data-testid="composer-target-option"/);
  assert.match(pickerSource, /data-composer-target-kind=\{option\.kind\}/);
  assert.match(pickerSource, /data-composer-target-directory=/);
  assert.match(pickerSource, /data-testid="composer-target-draft-badge"/);
  assert.match(pickerSource, /session\.target_draft_badge/);
  assert.match(conflictSource, /data-testid="composer-target-conflict-modal"/);
  assert.match(conflictSource, /data-testid="composer-target-conflict-close"/);
  assert.match(conflictSource, /data-testid="composer-target-use-current"/);
  assert.match(conflictSource, /data-testid="composer-target-load-existing"/);
  assert.match(conflictSource, /session\.target_conflict_escape_hint/);
});

test("target picker menu scrolls and hides workspace paths", () => {
  assert.match(pickerSource, /max-h-\[min\(24rem,calc\(100vh-10rem\)\)\] overflow-y-auto/);
  assert.match(pickerSource, /option\.kind !== "workspace" && option\.description\.trim\(\)/);
});

test("session empty state renders target picker above centered composer", () => {
  assert.match(sessionSource, /data-testid="composer-entry-target-heading"/);
  assert.match(sessionSource, /<ComposerTargetPicker/);
  assert.match(sessionSource, /entryPlacement="center"/);
  assert.doesNotMatch(sessionSource, /handleBrowserAutomationQuickstart/);
  assert.doesNotMatch(sessionSource, /handleSoulQuickstart/);
});

test("composer entry heading uses the same width cap as the centered composer", () => {
  assert.match(
    sessionSource,
    /data-testid="composer-entry-target-heading"\s+class="[^"]*w-full[^"]*max-w-\[960px\][^"]*"/s,
    "the target heading should span the same 960px center column as the composer",
  );
  assert.doesNotMatch(sessionSource, /data-testid="composer-entry-target-heading"\s+class="[^"]*max-w-\[18ch\]/s);
});

test("centered composer entry keeps composer text left aligned", () => {
  assert.match(
    sessionSource,
    /<div class="w-full text-left">\s*<Composer\s+entryPlacement="center"/s,
    "the centered entry heading can be centered, but the composer editor must inherit left-aligned text",
  );
});

test("composer target copy is localized in primary locales", () => {
  assert.match(csSource, /"session\.target_chat_label": "\[Pouze chat\]"/);
  for (const source of [csSource, enSource, zhSource]) {
    assert.match(source, /"session\.target_chat_label":/);
    assert.match(source, /"session\.target_draft_badge":/);
    assert.match(source, /"session\.target_conflict_title":/);
    assert.match(source, /"session\.target_conflict_escape_hint":/);
  }
});
