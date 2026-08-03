import assert from "node:assert/strict";
import test from "node:test";

import { readContextSource, readWorkspaceFacadeSource } from "./workspace-source";

const facadeSource = readWorkspaceFacadeSource();
const runtimeSource = readContextSource("workspace-runtime-controller.ts");

test("desktop bootstrap hydrates the sidebar without starting an engine", () => {
  const lazyBootIndex = facadeSource.indexOf("if (isTauriRuntime() && options.populateSidebarFromDb)");
  assert.ok(lazyBootIndex >= 0, "lazy boot branch should exist");

  const markCompleteIndex = facadeSource.indexOf("markOnboardingComplete();", lazyBootIndex);
  const setStepIndex = facadeSource.indexOf("options.setOnboardingStep(resolveWelcomeOnboardingStep());", lazyBootIndex);
  const sidebarIndex = facadeSource.indexOf("populateSidebarFromDbInBackground({", lazyBootIndex);

  assert.ok(markCompleteIndex >= 0, "lazy boot should mark onboarding complete");
  assert.ok(setStepIndex > markCompleteIndex, "lazy boot should publish the renderable shell after onboarding completion");
  assert.ok(sidebarIndex > setStepIndex, "sidebar DB hydration should stay behind boot shell publication");
  assert.doesNotMatch(
    facadeSource,
    /warmActiveLocalWorkspaceEngineInBackground|reason: "boot-warmup"/,
    "application startup must not spawn or prepare an OpenCode engine",
  );
});

test("runtime recovery remains isolated from the first requested engine start", () => {
  assert.match(
    runtimeSource,
    /export type EnsureEngineForWorkspaceOptions = \{[\s\S]*reason\?: string;[\s\S]*loadSessions\?: boolean;[\s\S]*forceFreshRuntime\?: boolean;[\s\S]*\};/,
  );
  assert.match(
    runtimeSource,
    /const isRuntimeRecovery = ensureReason\.includes\("runtime-recovery"\);[\s\S]*const forceFreshRuntime = options\.forceFreshRuntime === true \|\| isRuntimeRecovery;[\s\S]*const singleFlightKey = forceFreshRuntime[\s\S]*return await ensureEngineForWorkspaceSingleFlight\(singleFlightKey, async \(\) => \{/s,
    "a recovery may use a fresh flight while normal user-requested startup remains deduplicated",
  );
  assert.match(
    runtimeSource,
    /const skillSyncReason = isRuntimeRecovery \? "runtime-recovery" : "browse-attach";[\s\S]*syncWorkspaceSkillMaterializationBeforeRuntime\(workspace, \{[\s\S]*reason: skillSyncReason,/s,
    "the runtime owner passes recovery intent to skill materialization instead of owning a client-side retry loop",
  );
});

test("workspace API readiness probe is read-only, bounded and non-blocking", () => {
  const probeSourceStart = facadeSource.indexOf("probeWorkspaceApiReady: async");
  const probeSourceEnd = facadeSource.indexOf("createClient,", probeSourceStart);
  const probeSource = facadeSource.slice(probeSourceStart, probeSourceEnd);
  assert.ok(probeSourceStart >= 0 && probeSourceEnd > probeSourceStart, "workspace API probe source should be present");

  assert.match(
    runtimeSource,
    /probeWorkspaceApiReady\?: \(input: \{[\s\S]*workspaceId: string;[\s\S]*workspacePath: string;[\s\S]*reason: string;[\s\S]*\}\) => Promise<boolean>;/,
    "runtime controller should accept a narrow workspace API readiness probe",
  );
  assert.match(
    runtimeSource,
    /function startWorkspaceApiReadinessProbe\([\s\S]*OpenCode process health only proves the HTTP server is alive[\s\S]*void withTimeoutOrThrow\(deps\.probeWorkspaceApiReady\(\{[\s\S]*WORKSPACE_API_READINESS_PROBE_TIMEOUT_MS[\s\S]*ensure-engine:workspace-api-probe:error/s,
    "workspace API probe should run asynchronously with a bounded timeout and trace failures",
  );
  assert.match(
    runtimeSource,
    /deps\.updateWorkspaceConnectionState\(workspaceId, \{[\s\S]*status: "connected",[\s\S]*message: WORKSPACE_API_WAITING_MESSAGE,[\s\S]*\}\);/s,
    "probe should expose process-ready but workspace-API-waiting as connected diagnostic state",
  );
  assert.match(
    facadeSource,
    /probeWorkspaceApiReady: async \(\{ workspaceId, workspacePath, reason \}\) => \{[\s\S]*const entry = options\.routing\.entry\(workspaceId\);[\s\S]*client\.session\.list\(\{ directory, limit: 1 \}\)/s,
    "workspace store should implement the probe as a read-only bounded session list call",
  );
  assert.doesNotMatch(
    probeSource.replace(/\/\/[^\n\r]*/g, ""),
    /session\.create/,
    "workspace API readiness must not create sessions",
  );
});
