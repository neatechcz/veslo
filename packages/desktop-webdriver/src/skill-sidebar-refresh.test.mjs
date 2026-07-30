import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parseSkillSidebarRefreshArguments } from "./skill-sidebar-refresh.mjs";
import { summarizeLatestSubmitRoute } from "./scenario-kit/transcript-trace-summary.mjs";
import { createWorkspaceSkillPrompt } from "./scenarios/skill-sidebar-refresh.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const entrySource = readFileSync(resolve(directory, "./skill-sidebar-refresh.mjs"), "utf8");
const scenarioSource = readFileSync(resolve(directory, "./scenarios/skill-sidebar-refresh.mjs"), "utf8");
const workspaceSource = readFileSync(resolve(directory, "./scenario-kit/workspace.mjs"), "utf8");
const composerSource = readFileSync(resolve(directory, "./scenario-kit/composer.mjs"), "utf8");

test("skill sidebar refresh scenario requires an explicit disposable workspace and unique skill name", () => {
  const parsed = parseSkillSidebarRefreshArguments([
    "runtime-info.json",
    "--workspace", "Workspace A",
    "--workspace-path", "C:/tmp/workspace-a",
    "--skill-name", "webdriver-sidebar-check",
  ]);
  assert.equal(parsed.workspaceLabel, "Workspace A");
  assert.equal(parsed.workspacePath, resolve("C:/tmp/workspace-a"));
  assert.equal(parsed.skillName, "webdriver-sidebar-check");
  assert.throws(
    () => parseSkillSidebarRefreshArguments(["runtime-info.json", "--workspace", "A"]),
    /workspace-path/,
  );
  assert.throws(
    () => parseSkillSidebarRefreshArguments([
      "runtime-info.json", "--workspace", "A", "--workspace-path", "relative", "--skill-name", "valid-name",
    ]),
    /absolute/,
  );
  assert.throws(
    () => parseSkillSidebarRefreshArguments([
      "runtime-info.json", "--workspace", "A", "--workspace-path", "C:/tmp/a", "--skill-name", "not valid",
    ]),
    /kebab-case/,
  );
});

test("skill sidebar refresh scenario drives creation and a distinct same-workspace conversation through visible UI", () => {
  const prompt = createWorkspaceSkillPrompt("webdriver-sidebar-check");
  assert.match(prompt, /\.opencode\/skills\/webdriver-sidebar-check\/SKILL\.md/);
  assert.match(scenarioSource, /sendComposerMessage\(browser, createWorkspaceSkillPrompt/);
  assert.match(scenarioSource, /confirmImplicitSkillCommand/);
  assert.match(scenarioSource, /workspace\.confirm-skill-creation/);
  assert.match(scenarioSource, /workspace\.clear-owned-leftover-draft/);
  assert.match(scenarioSource, /runtime\.wait-for-cold-admission/);
  assert.match(scenarioSource, /waitForOwnedColdRuntimeAdmission/);
  assert.match(scenarioSource, /clearOwnedScenarioDraftIfPresent/);
  assert.match(composerSource, /document\.execCommand\("delete"\)/);
  assert.match(composerSource, /startsWith\("Create exactly one workspace-local skill named "\)/);
  assert.match(scenarioSource, /selectWorkspaceForNewConversation\(browser, input\.workspaceLabel\)/);
  assert.match(scenarioSource, /firstSubmitRoute\?\.createsConversation/);
  assert.match(scenarioSource, /secondSubmitRoute\?\.createsConversation/);
  assert.match(scenarioSource, /secondSubmitRoute\.targetsExistingConversation/);
  assert.match(scenarioSource, /waitForVisibleAssistantOutput/);
  assert.match(scenarioSource, /sessionCapabilitiesPanel/);
  assert.match(scenarioSource, /workspace\.verify-skill-created/);
  assert.match(scenarioSource, /sidebar\.observe-creating-conversation/);
  assert.match(scenarioSource, /sidebar\.observe-second-conversation-before-message/);
  assert.match(scenarioSource, /sidebar\.observe-second-conversation-after-message/);
  assert.match(scenarioSource, /sessionCapabilitiesSkillsContent/);
  assert.match(workspaceSource, /projectNewSession/);
  assert.match(workspaceSource, /composerSessionQueueKey/);
  assert.match(entrySource, /mutations: true/);
  assert.match(
    scenarioSource,
    /!visibleInCreatingConversation \|\| !visibleBeforeSecondMessage \|\| !visibleAfterSecondMessage/,
    "the second conversation must project the workspace skill before a second send",
  );
  assert.doesNotMatch(scenarioSource, /fetch\([^)]*conversation/i);
});

test("submit route evidence rejects a latest send that reused an existing conversation", () => {
  const summary = summarizeLatestSubmitRoute([
    { id: 10, event: "sendPromptImmediate:start", traceId: "send-first" },
    { id: 11, event: "sendPrompt:create-session-needed", traceId: "send-first" },
    { id: 20, event: "sendPromptImmediate:start", traceId: "send-second" },
    { id: 21, event: "sendPrompt:server-submit-existing:start", traceId: "send-second" },
  ], 15);
  assert.deepEqual(summary, {
    traceId: "send-second",
    createsConversation: false,
    targetsExistingConversation: true,
  });
});
