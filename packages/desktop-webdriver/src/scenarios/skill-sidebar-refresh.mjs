import { access } from "node:fs/promises";
import { join } from "node:path";

import { fail } from "../attach-smoke.mjs";
import {
  clearOwnedScenarioDraftIfPresent,
  sendComposerMessage,
} from "../scenario-kit/composer.mjs";
import { selectors } from "../scenario-kit/selectors.mjs";
import { selectWorkspaceForNewConversation } from "../scenario-kit/workspace.mjs";
import {
  confirmImplicitSkillCommand,
  visibleAssistantMessages,
  waitForOwnedColdRuntimeAdmission,
  waitForVisibleAssistantOutput,
  waitForSubmittedRunToSettle,
  waitForWorkspaceVisible,
} from "../scenario-kit/waits.mjs";
import { summarizeLatestSubmitRoute } from "../scenario-kit/transcript-trace-summary.mjs";

const SIDEBAR_SETTLE_TIMEOUT_MS = 3_000;

function testSkillPath(workspacePath, skillName) {
  return join(workspacePath, ".opencode", "skills", skillName, "SKILL.md");
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureSkillsExpanded(browser) {
  const panel = await browser.$(selectors.sessionCapabilitiesPanel);
  await panel.waitForDisplayed({ timeout: 15_000 });
  const section = await browser.$(selectors.sessionCapabilitiesSkills);
  await section.waitForDisplayed({ timeout: 15_000 });
  const toggle = await section.$("button");
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
}

async function sidebarHasWorkspaceSkill(browser, skillName) {
  await ensureSkillsExpanded(browser);
  return browser.execute((panelSelector, contentSelector, expectedName) => {
    const panel = Array.from(document.querySelectorAll(panelSelector)).find((element) => {
      const style = window.getComputedStyle(element);
      return element.getClientRects().length > 0 && style.display !== "none" && style.visibility !== "hidden";
    });
    const content = panel?.querySelector(contentSelector);
    if (!content) return false;
    return Array.from(content.querySelectorAll("span[title]")).some(
      (element) => element.getAttribute("title") === expectedName,
    );
  }, selectors.sessionCapabilitiesPanel, selectors.sessionCapabilitiesSkillsContent, skillName);
}

async function waitForSidebarSkill(browser, skillName) {
  try {
    await browser.waitUntil(
      () => sidebarHasWorkspaceSkill(browser, skillName),
      {
        timeout: SIDEBAR_SETTLE_TIMEOUT_MS,
        interval: 150,
        timeoutMsg: `Sidebar did not show workspace skill ${skillName}.`,
      },
    );
    return true;
  } catch {
    return false;
  }
}

export function createWorkspaceSkillPrompt(skillName) {
  return [
    `Create exactly one workspace-local skill named ${skillName}.`,
    `Write it to .opencode/skills/${skillName}/SKILL.md.`,
    "Use YAML frontmatter with the exact name and a non-empty description.",
    "Do not modify any other project files.",
  ].join(" ");
}

export async function executeSkillSidebarRefreshScenario(context, input) {
  const {
    browser,
    step,
    snapshot,
    expectNoVisibleRuntimeError,
    sendWorkflowTrace,
    transcriptTraceSummary,
  } = context;
  const skillPath = testSkillPath(input.workspacePath, input.skillName);
  if (await fileExists(skillPath)) {
    fail(`Refusing to overwrite existing test skill: ${skillPath}`);
  }

  // An owned desktop launch includes real sidecar and session hydration. Do
  // not confuse cold UI boot with a missing workspace regression.
  await step("workspace.wait-for-cold-session-shell", () =>
    waitForWorkspaceVisible(browser, input.workspaceLabel, Math.min(input.timeoutMs, 90_000)));
  await step("runtime.wait-for-cold-admission", () =>
    waitForOwnedColdRuntimeAdmission(browser));

  await step("workspace.select-first-conversation", () =>
    selectWorkspaceForNewConversation(browser, input.workspaceLabel));
  await step("workspace.clear-owned-leftover-draft", () =>
    clearOwnedScenarioDraftIfPresent(browser, input.workspaceLabel));
  await snapshot("skill-sidebar.first-conversation-ready");

  const firstAssistantBaseline = await visibleAssistantMessages(browser);
  const firstTraceBaseline = (await sendWorkflowTrace()).at(-1)?.id ?? 0;
  await step("workspace.create-skill-prompt", () =>
    sendComposerMessage(browser, createWorkspaceSkillPrompt(input.skillName), input.workspaceLabel));
  await step("workspace.confirm-skill-creation", () =>
    // Server-owned submissions can proceed without the renderer-side implicit
    // confirmation. Confirm when present, but do not manufacture a failure
    // when the real server path has already admitted the write.
    confirmImplicitSkillCommand(browser, 2_000, { required: false }));
  await step("workspace.create-skill-settle", () =>
    waitForSubmittedRunToSettle(browser, input.workspaceLabel, input.timeoutMs));
  const firstVisibleAssistantOutput = await step("workspace.create-skill-visible-output", () =>
    waitForVisibleAssistantOutput(browser, firstAssistantBaseline, input.timeoutMs));
  await expectNoVisibleRuntimeError();
  const firstSubmitRoute = summarizeLatestSubmitRoute(await sendWorkflowTrace(), firstTraceBaseline);
  if (!firstSubmitRoute?.createsConversation || firstSubmitRoute.targetsExistingConversation) {
    fail(`The first message did not materialize a new conversation: ${JSON.stringify(firstSubmitRoute)}`);
  }
  const traceAfterCreation = await step("transcript.trace-after-creation", transcriptTraceSummary);
  const createdOnDisk = await step("workspace.verify-skill-created", () => fileExists(skillPath));
  if (!createdOnDisk) {
    fail(`The first conversation completed but did not create ${skillPath}.`);
  }

  const visibleInCreatingConversation = await step("sidebar.observe-creating-conversation", () =>
    waitForSidebarSkill(browser, input.skillName));
  await snapshot("skill-sidebar.after-creation");

  await step("workspace.select-second-conversation", () =>
    selectWorkspaceForNewConversation(browser, input.workspaceLabel));
  const visibleBeforeSecondMessage = await step("sidebar.observe-second-conversation-before-message", () =>
    waitForSidebarSkill(browser, input.skillName));
  await snapshot("skill-sidebar.second-conversation-ready");

  const secondAssistantBaseline = await visibleAssistantMessages(browser);
  const secondTraceBaseline = (await sendWorkflowTrace()).at(-1)?.id ?? 0;
  await step("workspace.second-conversation-verify-prompt", () =>
    sendComposerMessage(browser, "Reply with exactly: workspace skill sidebar verification.", input.workspaceLabel));
  await step("workspace.second-conversation-verify-settle", () =>
    waitForSubmittedRunToSettle(browser, input.workspaceLabel, input.timeoutMs));
  const secondVisibleAssistantOutput = await step("workspace.second-conversation-visible-output", () =>
    waitForVisibleAssistantOutput(browser, secondAssistantBaseline, input.timeoutMs));
  await expectNoVisibleRuntimeError();
  const secondSubmitRoute = summarizeLatestSubmitRoute(await sendWorkflowTrace(), secondTraceBaseline);
  if (!secondSubmitRoute?.createsConversation || secondSubmitRoute.targetsExistingConversation) {
    fail(`The second message reused the first conversation: ${JSON.stringify(secondSubmitRoute)}`);
  }
  const traceAfterVerification = await step("transcript.trace-after-verification", transcriptTraceSummary);
  const visibleAfterSecondMessage = await step("sidebar.observe-second-conversation-after-message", () =>
    waitForSidebarSkill(browser, input.skillName));
  await snapshot("skill-sidebar.after-second-message");

  const result = {
    workspace: input.workspaceLabel,
    skillName: input.skillName,
    createdOnDisk,
    visibleInCreatingConversation,
    visibleBeforeSecondMessage,
    visibleAfterSecondMessage,
    firstSubmitRoute,
    firstVisibleAssistantOutput,
    secondSubmitRoute,
    secondVisibleAssistantOutput,
    traceAfterCreation,
    traceAfterVerification,
  };
  if (!visibleInCreatingConversation || !visibleBeforeSecondMessage || !visibleAfterSecondMessage) {
    fail(`Workspace skill sidebar projection failed: ${JSON.stringify(result)}`);
  }
  return result;
}
