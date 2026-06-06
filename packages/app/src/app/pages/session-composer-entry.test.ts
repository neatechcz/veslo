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
  assert.match(appSource, /kind: "chat"/);
  assert.match(appSource, /kind: "workspace"/);
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
  assert.match(pickerSource, /data-testid="composer-target-draft-badge"/);
  assert.match(pickerSource, /session\.target_draft_badge/);
  assert.match(conflictSource, /data-testid="composer-target-conflict-modal"/);
  assert.match(conflictSource, /data-testid="composer-target-conflict-close"/);
  assert.match(conflictSource, /data-testid="composer-target-use-current"/);
  assert.match(conflictSource, /data-testid="composer-target-load-existing"/);
  assert.match(conflictSource, /session\.target_conflict_escape_hint/);
});

test("session empty state renders target picker above centered composer", () => {
  assert.match(sessionSource, /data-testid="composer-entry-target-heading"/);
  assert.match(sessionSource, /<ComposerTargetPicker/);
  assert.match(sessionSource, /entryPlacement="center"/);
  assert.doesNotMatch(sessionSource, /handleBrowserAutomationQuickstart/);
  assert.doesNotMatch(sessionSource, /handleSoulQuickstart/);
});

test("composer target copy is localized in primary locales", () => {
  for (const source of [csSource, enSource, zhSource]) {
    assert.match(source, /"session\.target_chat_label":/);
    assert.match(source, /"session\.target_draft_badge":/);
    assert.match(source, /"session\.target_conflict_title":/);
    assert.match(source, /"session\.target_conflict_escape_hint":/);
  }
});
