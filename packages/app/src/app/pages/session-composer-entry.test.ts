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
const appViewPropsSource = readFileSync(new URL("../app-view-props.ts", import.meta.url), "utf8");
const composerTargetControllerSource = readFileSync(
  new URL("../context/composer-target-controller.ts", import.meta.url),
  "utf8",
);
const sessionSource = readFileSync(new URL("./session.tsx", import.meta.url), "utf8");
const typesSource = readFileSync(new URL("../types.ts", import.meta.url), "utf8");
const csSource = readFileSync(new URL("../../i18n/locales/cs.ts", import.meta.url), "utf8");
const enSource = readFileSync(new URL("../../i18n/locales/en.ts", import.meta.url), "utf8");
const zhSource = readFileSync(new URL("../../i18n/locales/zh.ts", import.meta.url), "utf8");
const pickerSource = readOptionalSource("../components/session/composer-target-picker.tsx");
const composerTargetOptionsSource = composerTargetControllerSource.slice(
  composerTargetControllerSource.indexOf("const composerTargetOptions = createMemo"),
  composerTargetControllerSource.indexOf("const activeWorkspaceComposerTargetId = createMemo"),
);
const switchComposerTargetSource = composerTargetControllerSource.slice(
  composerTargetControllerSource.indexOf("const switchComposerTargetNow = async"),
  composerTargetControllerSource.indexOf("let composerTargetSwitchQueue: Promise<void> = Promise.resolve();"),
);
const switchComposerTargetQueueSource = composerTargetControllerSource.slice(
  composerTargetControllerSource.indexOf("let composerTargetSwitchQueue: Promise<void> = Promise.resolve();"),
  composerTargetControllerSource.indexOf("const composerTargetOptions = createMemo"),
);

const assertComposerDraftSeededBeforeActivation = (source: string, draftName: string) => {
  const seedIndex = source.indexOf(
    `deps.composerDraftCommands.writeDraft(resolveMovedComposerStorageKey(target.id), ${draftName})`,
  );
  const activationIndex = source.indexOf("deps.setActivePendingDraftKey(target.id)");
  assert.ok(seedIndex >= 0, `${draftName} should be seeded into the target storage key`);
  assert.ok(activationIndex >= 0, "target key should be activated");
  assert.ok(seedIndex < activationIndex, `${draftName} should be seeded before activating the target key`);
};

test("session view receives composer target picker state from app", () => {
  assert.match(typesSource, /export type ComposerTargetOption = \{/);
  assert.match(typesSource, /export type ComposerTargetSwitchResult =/);
  assert.match(
    appViewPropsSource,
    /get composerTargetOptions\(\) \{\s*return composerTargetController\.composerTargetOptions\(\);\s*\}/s,
  );
  assert.match(
    appViewPropsSource,
    /get activeComposerTargetId\(\) \{\s*return composerTargetController\.activeComposerTargetId\(\);\s*\}/s,
  );
  assert.match(
    appViewPropsSource,
    /get switchComposerTarget\(\) \{\s*return composerTargetController\.switchComposerTarget;\s*\}/s,
  );
  assert.match(sessionSource, /composerTargetOptions: ComposerTargetOption\[\];/);
});

test("app builds target options from workspaces and pending drafts", () => {
  assert.match(composerTargetControllerSource, /const \[pendingDraftSummaries, setPendingDraftSummaries\]/);
  assert.match(composerTargetControllerSource, /deps\.pendingSessionDraftsList\(\)/);
  assert.match(composerTargetControllerSource, /draftStatus: .*\? "draft" : null/s);
  assert.match(composerTargetControllerSource, /kind: "workspace"/);
});

test("composer target picker puts chat-only private target first", () => {
  assert.ok(composerTargetOptionsSource, "composer target option builder should be present");
  assert.match(composerTargetOptionsSource, /const chatId = resolvePendingDraftKey\(\{ kind: "new-private" \}\);/);
  assert.match(
    composerTargetOptionsSource,
    /const options: ComposerTargetOption\[\] = \[\{\s*id: chatId,\s*kind: "chat",\s*label: deps\.labels\.chat\(\),\s*description: "",\s*draftStatus: hasDraft\(chatId\) \? "draft" : null,\s*\}\];/s,
  );
  assert.match(composerTargetOptionsSource, /deps\.workspace\.isPrivateWorkspacePath\(directory\)/);
});

test("app defaults composer target display to the active workspace when no pending draft is selected", () => {
  assert.match(composerTargetControllerSource, /const activeWorkspaceComposerTargetId = createMemo\(\(\) => \{/);
  assert.match(composerTargetControllerSource, /return resolvePendingDraftKey\(\{ kind: "directory", workspaceId, directory \}\);/);
  assert.match(
    composerTargetControllerSource,
    /const activeComposerTargetId = createMemo\(\(\) =>\s*deps\.activePendingDraftKey\(\) \?\? activeWorkspaceComposerTargetId\(\),\s*\);/s,
  );
});

test("switchComposerTarget keeps the current global draft without conflict resolution", () => {
  assert.doesNotMatch(composerTargetControllerSource, /resolveComposerTargetConflict\(\{/);
  assert.doesNotMatch(composerTargetControllerSource, /status: "conflict"/);
  assert.doesNotMatch(composerTargetControllerSource, /resolution === "use-current"/);
  assert.doesNotMatch(composerTargetControllerSource, /resolution === "load-existing"/);
  assert.match(composerTargetControllerSource, /deps\.setActivePendingDraftKey\(target\.id\)/);
  assert.match(
    composerTargetControllerSource,
    /if \(target\.id === deps\.activePendingDraftKey\(\)\) return \{ status: "switched" \};/,
  );
});

test("switchComposerTarget seeds the target draft before activating the target key", () => {
  assert.ok(switchComposerTargetSource, "composer target switching source should be present");
  assertComposerDraftSeededBeforeActivation(switchComposerTargetSource, "currentDraft");
  assert.doesNotMatch(switchComposerTargetSource, /destinationDraft/);
  assert.doesNotMatch(switchComposerTargetSource, /createEmptyComposerDraft/);
});

test("switchComposerTarget moves current pending drafts instead of cloning them", () => {
  assert.ok(switchComposerTargetSource, "composer target switching source should be present");
  assert.match(
    switchComposerTargetSource,
    /const previousPendingDraftKey = deps\.currentComposerStorageKey\(\);[\s\S]*const previousPendingDraftMeta = deps\.activePendingDraftMeta\(\);/,
    "target switches should snapshot the original composer storage before writing the destination",
  );

  const seedIndex = switchComposerTargetSource.indexOf(
    "deps.composerDraftCommands.writeDraft(resolveMovedComposerStorageKey(target.id), currentDraft)",
  );
  const activationIndex = switchComposerTargetSource.indexOf("deps.setActivePendingDraftKey(target.id)");
  const cleanupIndex = switchComposerTargetSource.indexOf("await consumeMovedPendingDraft({");

  assert.ok(seedIndex >= 0, "current draft should be seeded into the destination key");
  assert.ok(activationIndex >= 0, "destination key should be activated");
  assert.ok(cleanupIndex >= 0, "original pending draft should be consumed after the move");
  assert.ok(seedIndex < activationIndex, "destination draft must be seeded before activation");
  assert.ok(activationIndex < cleanupIndex, "stale source writes must be invalidated before source cleanup");
  assert.match(
    switchComposerTargetSource,
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
    /const queuedSwitch = composerTargetSwitchQueue[\s\S]*\.then\(\(\) => untrack\(\(\) => switchComposerTargetNow\(targetId\)\)\);/,
    "each target switch should run after the previous switch settles",
  );
  assert.match(
    switchComposerTargetQueueSource,
    /composerTargetSwitchQueue = queuedSwitch\.then\(\(\) => undefined, \(\) => undefined\);/,
    "the queue should keep accepting switches after a failed operation",
  );
});

test("switchComposerTarget does not load destination draft content", () => {
  assert.doesNotMatch(composerTargetControllerSource, /loadPendingDraftComposer/);
  assert.doesNotMatch(composerTargetControllerSource, /pendingSessionDraftsGet/);
  assert.doesNotMatch(switchComposerTargetSource, /destinationDraft/);
});

test("switchComposerTarget routes picked workspaces through safe switching", () => {
  assert.match(composerTargetControllerSource, /selectComposerWorkspaceTargetFromPicker/);
  assert.match(composerTargetControllerSource, /target = pickedTarget;/);
  assert.match(switchComposerTargetSource, /const summary = await putPendingDraftForTarget\(target, currentDraft, summaries\);/);
  assert.doesNotMatch(
    composerTargetControllerSource,
    /if \(target\.kind === "choose-workspace"\) \{\s*const result = await openDirectorySessionFromPicker\(\);/s,
  );
});

test("target picker exposes stable test hooks without a draft conflict modal", () => {
  assert.match(pickerSource, /data-testid="composer-target-picker"/);
  assert.match(pickerSource, /data-testid="composer-target-option"/);
  assert.match(pickerSource, /data-composer-target-kind=\{option\.kind\}/);
  assert.match(pickerSource, /data-composer-target-directory=/);
  assert.match(pickerSource, /data-testid="composer-target-draft-badge"/);
  assert.match(pickerSource, /session\.target_draft_badge/);
  assert.doesNotMatch(sessionSource, /ComposerTargetConflictModal/);
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

test("a newly opened pending draft clears prior entry dismissal for its stable queue key", () => {
  assert.match(
    sessionSource,
    /on\(\s*\(\) => props\.activePendingDraftKey,\s*\(pendingDraftKey, previousPendingDraftKey\) => \{[\s\S]*nextKey \|\| nextKey === previousKey[\s\S]*const sessionKey = pendingSessionQueueKey\(\);[\s\S]*const \{ \[sessionKey\]: _dismissed, \.\.\.next \} = current;[\s\S]*return next;/s,
    "a fresh pending-draft activation must not inherit entry dismissal from the prior send in the same workspace",
  );
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
    /<div class="w-full text-left">\s*\{sessionModelSelector\(\)\}\s*<Composer\s+entryPlacement="center"/s,
    "the centered entry heading can be centered, but the composer editor must inherit left-aligned text",
  );
});

test("composer target copy is localized in primary locales", () => {
  assert.match(csSource, /"session\.target_chat_label": "\[Pouze chat\]"/);
  for (const source of [csSource, enSource, zhSource]) {
    assert.match(source, /"session\.target_chat_label":/);
    assert.match(source, /"session\.target_draft_badge":/);
    assert.doesNotMatch(source, /"session\.target_conflict_title":/);
  }
});
