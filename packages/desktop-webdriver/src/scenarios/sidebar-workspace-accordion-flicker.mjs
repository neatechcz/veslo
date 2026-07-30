import { startUiStabilityProbe, stopUiStabilityProbe } from "../scenario-kit/flicker.mjs";
import { waitForSessionSidebarReady } from "../scenario-kit/waits.mjs";
import { setWorkspaceConversationListExpanded } from "../scenario-kit/workspace.mjs";

export async function executeSidebarWorkspaceAccordionFlickerScenario(context, input) {
  const { browser, step, snapshot, expectNoVisibleRuntimeError } = context;
  await step("session-sidebar.ready", () => waitForSessionSidebarReady(browser));
  await snapshot("session-sidebar-ready");
  await step("stability-probe.start", () => startUiStabilityProbe(browser));
  let stability;
  try {
    await step("workspace.initial.expand", () => setWorkspaceConversationListExpanded(browser, input.initialWorkspace, true));
    await step("workspace.second.expand", () => setWorkspaceConversationListExpanded(browser, input.secondWorkspace, true));
    await step("stability-probe.observe", () => browser.pause(input.observeMs));
  } finally {
    stability = await step("stability-probe.stop", () => stopUiStabilityProbe(browser));
  }
  await snapshot("workspace-second-expanded");
  await expectNoVisibleRuntimeError();
  return {
    workspaces: [input.initialWorkspace, input.secondWorkspace],
    observeMs: input.observeMs,
    stability,
  };
}
