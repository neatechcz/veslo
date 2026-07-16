import assert from "node:assert/strict";
import test from "node:test";

import { readContextSource, readWorkspaceFacadeSource } from "./workspace-source";

const facadeSource = readWorkspaceFacadeSource();
const runtimeSource = readContextSource("workspace-runtime-controller.ts");

test("bootstrap schedules local engine warmup after the workspace shell can render", () => {
  const lazyBootIndex = facadeSource.indexOf("if (isTauriRuntime() && options.populateSidebarFromDb)");
  assert.ok(lazyBootIndex >= 0, "lazy boot branch should exist");

  const markCompleteIndex = facadeSource.indexOf("markOnboardingComplete();", lazyBootIndex);
  const setStepIndex = facadeSource.indexOf("options.setOnboardingStep(resolveWelcomeOnboardingStep());", lazyBootIndex);
  const warmupIndex = facadeSource.indexOf("warmActiveLocalWorkspaceEngineInBackground({", lazyBootIndex);
  const sidebarIndex = facadeSource.indexOf("populateSidebarFromDbInBackground({", lazyBootIndex);

  assert.ok(markCompleteIndex >= 0, "lazy boot should mark onboarding complete");
  assert.ok(setStepIndex > markCompleteIndex, "lazy boot should publish the renderable shell after onboarding completion");
  assert.ok(warmupIndex > setStepIndex, "engine warmup should be scheduled after the shell is publishable");
  assert.ok(sidebarIndex > warmupIndex, "sidebar DB hydration should stay behind boot shell publication");
});

test("background engine warmup is local-only, completion-stale-safe, and deduped by workspace id/root", () => {
  assert.match(
    facadeSource,
    /const scheduledEngineWarmupKeys = new Set<string>\(\);/,
    "workspace store should keep a narrow warmup dedupe set",
  );
  assert.match(
    facadeSource,
    /function warmActiveLocalWorkspaceEngineInBackground\([\s\S]*if \(!isTauriRuntime\(\) \|\| CLOUD_ONLY_MODE\) return;[\s\S]*const workspaceId = input\.workspaceId\.trim\(\);[\s\S]*const workspacePath = input\.workspacePath\.trim\(\);[\s\S]*if \(!workspaceId \|\| !workspacePath\) return;/s,
    "background warmup should only run for installed local Tauri workspaces with a concrete id/root",
  );
  assert.match(
    facadeSource,
    /const stillCurrent = \(\) => \{[\s\S]*active\.workspaceType !== "local"[\s\S]*active\.id !== workspaceId[\s\S]*normalizeWorkspaceScopePath\(active\.path, "local"\) ===[\s\S]*normalizeWorkspaceScopePath\(workspacePath, "local"\)[\s\S]*\};[\s\S]*const warmupScopePath = normalizeWorkspaceScopePath\(workspacePath, "local"\) \|\| workspacePath;/s,
    "background warmup should not drop the boot snapshot before scheduling the shared ensure path",
  );
  assert.match(
    facadeSource,
    /\.then\(\(ok\) => untrack\(\(\) => \{[\s\S]*if \(!ok\) scheduledEngineWarmupKeys\.delete\(warmupKey\);[\s\S]*if \(!stillCurrent\(\)\) return;[\s\S]*bootTrace\("ensureEngineForWorkspace background warmup done"/s,
    "background warmup completion logs should still ignore stale active-workspace completions",
  );
  assert.match(
    facadeSource,
    /const warmupScopePath = normalizeWorkspaceScopePath\(workspacePath, "local"\) \|\| workspacePath;[\s\S]*const warmupKey = `\$\{workspaceId\}::\$\{warmupScopePath\}`;[\s\S]*if \(scheduledEngineWarmupKeys\.has\(warmupKey\)\) return;[\s\S]*scheduledEngineWarmupKeys\.add\(warmupKey\);/s,
    "background warmup should dedupe repeated scheduling for the same workspace id/root",
  );
  assert.match(
    facadeSource,
    /\.then\(\(ok\) => untrack\(\(\) => \{[\s\S]*if \(!ok\) scheduledEngineWarmupKeys\.delete\(warmupKey\);/s,
    "failed background warmup results should allow a later warmup retry",
  );
  assert.match(
    facadeSource,
    /\.catch\(\(error\) => untrack\(\(\) => \{[\s\S]*scheduledEngineWarmupKeys\.delete\(warmupKey\);[\s\S]*engine warmup failed/s,
    "thrown background warmup failures should not poison the dedupe key",
  );
});

test("background engine warmup reuses the runtime ensure path without session-list side effects", () => {
  const warmupSource = facadeSource.slice(
    facadeSource.indexOf("function warmActiveLocalWorkspaceEngineInBackground"),
    facadeSource.indexOf("async function bootstrapConfiguredRemoteServer"),
  );
  assert.ok(warmupSource.includes("function warmActiveLocalWorkspaceEngineInBackground"));

  assert.match(
    warmupSource,
    /void ensureEngineForWorkspace\(workspaceId, \{[\s\S]*reason: "boot-warmup",[\s\S]*loadSessions: false,[\s\S]*\}\)/s,
    "boot warmup should reuse ensureEngineForWorkspace with loadSessions disabled",
  );
  assert.doesNotMatch(
    warmupSource,
    /engineStart\(|startHost\(|activateVesloHostWorkspace\(|orchestratorWorkspaceActivate\(/,
    "workspace bootstrap should not own a separate engine start path",
  );
});

test("runtime ensure preserves single-flight startup and can skip loadSessions for boot warmup", () => {
  assert.match(
    runtimeSource,
    /export type EnsureEngineForWorkspaceOptions = \{[\s\S]*reason\?: string;[\s\S]*loadSessions\?: boolean;[\s\S]*forceFreshRuntime\?: boolean;[\s\S]*\};/,
    "runtime ensure should expose only the options boot warmup and send recovery need",
  );
  assert.match(
    runtimeSource,
    /const shouldLoadSessions = options\.loadSessions !== false;[\s\S]*const isBootWarmup = ensureReason === "boot-warmup";[\s\S]*const isRuntimeRecovery = ensureReason\.includes\("runtime-recovery"\);[\s\S]*const forceFreshRuntime = options\.forceFreshRuntime === true \|\| isRuntimeRecovery;[\s\S]*const singleFlightKey = forceFreshRuntime[\s\S]*return await ensureEngineForWorkspaceSingleFlight\(singleFlightKey, async \(\) => \{/s,
    "runtime recovery should use a fresh single-flight while boot warmup stays shared",
  );
  assert.match(
    runtimeSource,
    /recordSendWorkflowTrace\("workspace-runtime", "ensure-engine:start", \{[\s\S]*reason: ensureReason,[\s\S]*loadSessions: shouldLoadSessions,/s,
    "runtime traces should expose whether the ensure call is a warmup or first-send recovery",
  );
  assert.match(
    runtimeSource,
    /const isBootWarmup = ensureReason === "boot-warmup";[\s\S]*const isRuntimeRecovery = ensureReason\.includes\("runtime-recovery"\);[\s\S]*const skillSyncMaxAttempts = isBootWarmup \|\| isRuntimeRecovery \? 6 : 1;[\s\S]*const skillSyncReason = isBootWarmup[\s\S]*\? "boot-warmup"[\s\S]*: isRuntimeRecovery[\s\S]*\? "runtime-recovery"[\s\S]*: "browse-attach";[\s\S]*reason: skillSyncReason,[\s\S]*"ensure-engine:skills-ready"[\s\S]*attempt,[\s\S]*maxAttempts: skillSyncMaxAttempts,/s,
    "boot warmup and first-send runtime recovery should wait briefly for skill materialization readiness instead of failing the shared ensure immediately",
  );
  assert.match(
    runtimeSource,
    /if \(shouldLoadSessions\) \{[\s\S]*withTimeoutOrThrow\(deps\.loadSessions\(workspace\.path\)[\s\S]*\} else \{[\s\S]*"ensure-engine:load-sessions:skipped"[\s\S]*reason: ensureReason,/s,
    "boot warmup should start and route the engine without mutating the session list",
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
