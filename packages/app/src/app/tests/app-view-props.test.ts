import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  resolveBusyHint,
  resolveDashboardViewAccess,
  resolveHeaderConnectedVersion,
  resolveHeaderStatus,
  resolveLocalHostLabel,
  shouldShowSessionReloadBanner,
} from "../app-view-props.js";

const appSource = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const viewPropsSource = readFileSync(
  new URL("../app-view-props.ts", import.meta.url),
  "utf8",
);
const dashboardSource = readFileSync(
  new URL("../pages/dashboard.tsx", import.meta.url),
  "utf8",
);

function extractBraceBody(source: string, openIndex: number): string {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openIndex + 1, index);
      }
    }
  }
  assert.fail("expected a balanced brace body");
}

function extractCreateAppViewPropsInputKeys(): string[] {
  const start = appSource.indexOf("const appViewProps = createAppViewProps({");
  assert.notEqual(start, -1, "app.tsx should create app view props");
  const open = appSource.indexOf("{", start);
  return extractIdentifierList(
    extractBraceBody(appSource, open),
    "createAppViewProps input",
  );
}

function extractCreateAppViewPropsDestructuredKeys(): string[] {
  const functionStart = viewPropsSource.indexOf(
    "export function createAppViewProps",
  );
  assert.notEqual(
    functionStart,
    -1,
    "app-view-props should export createAppViewProps",
  );
  const destructureStart = viewPropsSource.indexOf("const {", functionStart);
  assert.notEqual(
    destructureStart,
    -1,
    "createAppViewProps should destructure deps",
  );
  const open = viewPropsSource.indexOf("{", destructureStart);
  return extractIdentifierList(
    extractBraceBody(viewPropsSource, open),
    "createAppViewProps destructuring",
  );
}

function extractIdentifierList(source: string, label: string): string[] {
  const parsed = source
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter((line) => line.length > 0)
    .map((line) => ({ line, match: line.match(/^([A-Za-z_$][\w$]*)[,]?$/) }));
  const unparsed = parsed
    .filter((entry) => !entry.match)
    .map((entry) => entry.line);

  assert.deepEqual(
    unparsed,
    [],
    `${label} should stay a one-identifier-per-line dependency list`,
  );
  return parsed
    .map((entry) => entry.match?.[1])
    .filter((name): name is string => Boolean(name));
}

test("app view prop helpers preserve header and busy labels", () => {
  assert.equal(
    resolveHeaderConnectedVersion({
      connectedVersion: "opencode 1.2.3",
      developerMode: false,
      appVersion: "2026.7.1",
      vesloServerDiagnosticsVersion: "2026.7.1",
    }),
    "opencode 1.2.3",
  );
  assert.equal(
    resolveHeaderConnectedVersion({
      connectedVersion: "opencode 1.2.3",
      developerMode: true,
      appVersion: "2026.7.1",
      vesloServerDiagnosticsVersion: null,
    }),
    "Veslo v2026.7.1",
  );
  assert.equal(
    resolveHeaderStatus({
      clientConnected: true,
      headerConnectedVersion: "Veslo v2026.7.1",
      sseConnected: true,
      connectedLabel: "Connected",
      disconnectedLabel: "Disconnected",
      liveLabel: "Live",
    }),
    "Connected · Veslo v2026.7.1 · Live",
  );
  assert.equal(
    resolveBusyHint({
      busy: true,
      busyLabel: "workspace.loading",
      busySeconds: 4,
      translateBusyLabel: (key) => `t:${key}`,
    }),
    "t:workspace.loading · 4s",
  );
  assert.equal(
    resolveLocalHostLabel({
      engine: { hostname: "127.0.0.1", port: 4096 },
      baseUrl: "http://ignored.local",
    }),
    "127.0.0.1:4096",
  );
  assert.equal(
    resolveLocalHostLabel({
      engine: null,
      baseUrl: "http://localhost:4888",
    }),
    "localhost:4888",
  );
});

test("session reload banner visibility keeps the skill and active-run policy explicit", () => {
  assert.equal(
    shouldShowSessionReloadBanner({
      reloadRequired: false,
      reloadTrigger: { type: "config" },
      activeReloadBlockingSessionCount: 1,
    }),
    false,
  );
  assert.equal(
    shouldShowSessionReloadBanner({
      reloadRequired: true,
      reloadTrigger: { type: "config" },
      activeReloadBlockingSessionCount: 0,
    }),
    false,
  );
  assert.equal(
    shouldShowSessionReloadBanner({
      reloadRequired: true,
      reloadTrigger: { type: "config" },
      activeReloadBlockingSessionCount: 1,
    }),
    true,
  );
  assert.equal(
    shouldShowSessionReloadBanner({
      reloadRequired: true,
      reloadTrigger: { type: "skill" },
      activeReloadBlockingSessionCount: 0,
    }),
    true,
  );
});

test("app traces reload banner transitions without session identifiers or trigger paths", () => {
  const marker =
    'recordSendWorkflowTrace("app", "session-reload-banner:state", state';
  const markerIndex = appSource.indexOf(marker);
  assert.notEqual(
    markerIndex,
    -1,
    "app should trace reload banner state transitions",
  );
  const stateStart = appSource.lastIndexOf("const state = {", markerIndex);
  assert.notEqual(
    stateStart,
    -1,
    "reload banner trace should build a state payload",
  );
  const traceBlock = appSource.slice(stateStart, markerIndex + marker.length);

  assert.match(traceBlock, /visible: showSessionReloadBanner\(\)/);
  assert.match(traceBlock, /activeCount/);
  assert.doesNotMatch(traceBlock, /trigger\.name|trigger\.path|session\.id/);
});

test("dashboard view access preserves remote and local skill/plugin permissions", () => {
  assert.deepEqual(
    resolveDashboardViewAccess({
      workspaceType: "local",
      vesloServerStatus: "connected",
      vesloServerCanWriteSkills: false,
      vesloServerCanWritePlugins: false,
      tauriRuntime: true,
    }),
    {
      canUseDesktopTools: true,
      canInstallSkillCreator: true,
      canEditPlugins: true,
      canUseGlobalPluginScope: true,
      skillsAccessHint: null,
      pluginsAccessHint: null,
    },
  );

  assert.deepEqual(
    resolveDashboardViewAccess({
      workspaceType: "remote",
      vesloServerStatus: "limited",
      vesloServerCanWriteSkills: false,
      vesloServerCanWritePlugins: false,
      tauriRuntime: true,
    }),
    {
      canUseDesktopTools: false,
      canInstallSkillCreator: false,
      canEditPlugins: false,
      canUseGlobalPluginScope: false,
      skillsAccessHint:
        "Veslo server needs a host token to install/update skills. Add it in Advanced and reconnect.",
      pluginsAccessHint: "Veslo server needs a token to edit plugins.",
    },
  );

  assert.deepEqual(
    resolveDashboardViewAccess({
      workspaceType: "remote",
      vesloServerStatus: "connected",
      vesloServerCanWriteSkills: true,
      vesloServerCanWritePlugins: true,
      tauriRuntime: false,
    }),
    {
      canUseDesktopTools: false,
      canInstallSkillCreator: true,
      canEditPlugins: true,
      canUseGlobalPluginScope: false,
      skillsAccessHint: null,
      pluginsAccessHint: null,
    },
  );
});

test("app view prop adapter dependency list stays symmetric", () => {
  const inputKeys = extractCreateAppViewPropsInputKeys();
  const destructuredKeys = extractCreateAppViewPropsDestructuredKeys();

  assert.ok(
    inputKeys.length > 0,
    "app.tsx should pass dependencies into createAppViewProps",
  );
  assert.ok(
    destructuredKeys.length > 0,
    "createAppViewProps should destructure dependencies",
  );
  assert.deepEqual(
    inputKeys.filter((key) => !destructuredKeys.includes(key)),
    [],
    "app.tsx should not pass unused dependencies into createAppViewProps",
  );
  assert.deepEqual(
    destructuredKeys.filter((key) => !inputKeys.includes(key)),
    [],
    "createAppViewProps should not destructure dependencies that app.tsx does not pass",
  );
});

test("app delegates view prop construction to the app view prop adapter", () => {
  assert.match(appSource, /createAppViewProps\(\{/);
  assert.doesNotMatch(appSource, /const onboardingProps = \(\) =>/);
  assert.doesNotMatch(appSource, /const dashboardProps = \(\) =>/);
  assert.doesNotMatch(appSource, /const sessionProps = \(\) =>/);
  assert.doesNotMatch(appSource, /const searchWorkspaceFiles = async/);

  assert.match(viewPropsSource, /Omit<DashboardViewProps, "onOpenFeedback">/);
  assert.match(viewPropsSource, /Omit<SessionViewProps, "onOpenFeedback">/);
  assert.match(viewPropsSource, /OnboardingViewProps/);
  assert.match(viewPropsSource, /satisfies OnboardingViewProps/);
  assert.match(viewPropsSource, /satisfies DashboardViewAdapterProps/);
  assert.match(viewPropsSource, /satisfies SessionViewAdapterProps/);
  assert.match(
    viewPropsSource,
    /const sessionProps = \{[\s\S]*get messages\(\)[\s\S]*get composerDraft\(\)/s,
    "SessionView props should be a stable object with independent reactive getters",
  );
  assert.doesNotMatch(
    viewPropsSource,
    /const sessionProps = \(\) =>/,
    "a function spread would couple every SessionView prop through one Solid memo",
  );
  assert.match(
    appSource,
    /<SessionView[\s\S]*\.\.\.appViewProps\.sessionProps/s,
    "App should spread the stable adapter object rather than call a prop factory",
  );
  const unsafeTypeToken = "a" + "ny";
  assert.doesNotMatch(
    viewPropsSource,
    new RegExp(
      String.raw`AppViewPropsScope\s*=\s*Record<string,\s*${unsafeTypeToken}>`,
    ),
  );
  assert.doesNotMatch(
    viewPropsSource,
    new RegExp(String.raw`\b${unsafeTypeToken}\b`),
  );
  assert.doesNotMatch(
    viewPropsSource,
    /autoCompactContext|toggleAutoCompactContext/,
  );
});

test("session view props carry unavailable history state and retry action", () => {
  assert.match(
    viewPropsSource,
    /get historyUnavailable\(\) \{\s*return selectedSessionHistoryUnavailable\(\);\s*\}/,
  );
  assert.match(
    viewPropsSource,
    /get historyUnavailableRetrying\(\) \{\s*return selectedSessionHistoryRetrying\(\);\s*\}/,
  );
  assert.match(viewPropsSource, /get retryUnavailableHistory\(\) \{/);
  assert.match(appSource, /selectedSessionHistoryUnavailable,/);
  assert.match(appSource, /selectedSessionHistoryRetrying,/);
  assert.match(appSource, /retryUnavailableHistory,/);
});

test("document runtime stays in the runtime workflow and is not exposed through settings", () => {
  assert.match(
    appSource,
    /createSignal<DocumentRuntimeStatusPayload \| null>\(null\)/,
  );
  assert.match(appSource, /DOCUMENT_RUNTIME_STATUS_POLL_MS = 30_000/);
  assert.match(appSource, /DOCUMENT_RUNTIME_INSTALL_POLL_MS = 2_000/);
  assert.match(appSource, /result\.package\.installing/);
  assert.match(appSource, /client\.getDocumentRuntimeStatus\(\)/);
  assert.match(appSource, /client\.repairDocumentRuntime\(\)/);
  assert.match(
    appSource,
    /documentRuntimeRepairBusy\(\) \|\| anyActiveRuns\(\)/,
  );
  assert.doesNotMatch(viewPropsSource, /documentRuntimeStatus/);
  assert.doesNotMatch(viewPropsSource, /documentRuntimeRepairBusy/);
  assert.doesNotMatch(viewPropsSource, /repairDocumentRuntime/);
  assert.doesNotMatch(dashboardSource, /documentRuntimeStatus/);
  assert.doesNotMatch(dashboardSource, /documentRuntimeRepairBusy/);
  assert.doesNotMatch(dashboardSource, /repairDocumentRuntime/);
});
