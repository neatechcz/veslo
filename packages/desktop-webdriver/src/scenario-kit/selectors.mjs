export const selectors = {
  appRoot: "#root",
  composerInput: '[data-testid="session-composer-input"]',
  composerStorageKey: "data-composer-storage-key",
  composerSessionQueueKey: "data-composer-session-queue-key",
  composerSend: '[data-testid="session-composer-send-button"]',
  composerTargetHeading: '[data-testid="composer-entry-target-heading"]',
  leftSidebar: '[data-testid="session-left-sidebar"]',
  operationalError: '[data-testid="session-operational-error"]',
  rendererRecovery: '[data-testid="renderer-error-recovery"]',
  implicitSkillConfirmRun: '[data-testid="implicit-skill-confirm-run"]',
  runIndicator: '[data-testid="session-run-indicator"]',
  runtimeReadiness: '[data-testid="sidebar-runtime-readiness-status"]',
  serverStatus: '[data-testid="sidebar-veslo-server-status"]',
  sessionCapabilitiesPanel: '[data-testid="session-capabilities-panel"]',
  sessionCapabilitiesSkills: '[data-testid="session-capabilities-skills"]',
  sessionCapabilitiesSkillsContent: '#session-capabilities-skills-content',
  sessionCenterPane: '[data-testid="session-center-pane"]',
  assistantMessage: '[data-message-role="assistant"]',
  // A terminal run failure is rendered inside the transcript as an assistant
  // message, so counting visible assistant rows alone would incorrectly treat
  // it as a successful response.
  assistantMessageError: '[data-message-role="assistant"] [role="alert"]',
  projectHeading: 'button[data-project-collapse-toggle] span.truncate, button span.truncate',
  projectNewSession: '[data-testid="sidebar-project-new-session"]',
};
