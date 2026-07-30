import { selectors } from "./selectors.mjs";

export async function captureUiState(browser, label) {
  return browser.execute((testIds, snapshotLabel) => {
    const text = (selector) => document.querySelector(selector)?.textContent?.trim() ?? null;
    const visible = (selector) => {
      const element = document.querySelector(selector);
      return Boolean(element && element.getClientRects().length);
    };
    return {
      label: snapshotLabel,
      at: new Date().toISOString(),
      appRootVisible: visible(testIds.appRoot),
      sessionShellVisible: visible(testIds.sessionCenterPane),
      workspaceCount: document.querySelectorAll("[data-project-key]").length,
      leftSidebarVisible: visible(testIds.leftSidebar),
      composer: {
        visible: visible(testIds.composerInput),
        textLength: text(testIds.composerInput)?.length ?? 0,
        target: text(testIds.composerTargetHeading),
      },
      runActive: visible(testIds.runIndicator),
      operationalError: text(testIds.operationalError),
      rendererRecoveryVisible: visible(testIds.rendererRecovery),
      runtimeReadiness: text(testIds.runtimeReadiness),
      serverStatus: text(testIds.serverStatus),
    };
  }, selectors, label);
}
