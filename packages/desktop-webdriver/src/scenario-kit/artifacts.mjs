// Backward-compatible facade. Keep artifact concerns split by responsibility.
export { writeScenarioArtifact, scenarioArtifactPath } from "./artifact-writer.mjs";
export { beginConsoleCapture, collectDevConsoleLogs } from "./console-capture.mjs";
export { sanitizeScenarioArtifactValue } from "./redaction.mjs";
