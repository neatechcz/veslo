import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  resolveBusyHint,
  resolveDashboardViewAccess,
  resolveHeaderConnectedVersion,
  resolveHeaderStatus,
  resolveLocalHostLabel,
} from "../app-view-props.js";

const appSource = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const viewPropsSource = readFileSync(new URL("../app-view-props.ts", import.meta.url), "utf8");

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
      skillsAccessHint: "Veslo server needs a host token to install/update skills. Add it in Advanced and reconnect.",
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

test("app delegates view prop construction to the app view prop adapter", () => {
  assert.match(appSource, /createAppViewProps\(\{/);
  assert.doesNotMatch(appSource, /const onboardingProps = \(\) =>/);
  assert.doesNotMatch(appSource, /const dashboardProps = \(\) =>/);
  assert.doesNotMatch(appSource, /const sessionProps = \(\) =>/);
  assert.doesNotMatch(appSource, /const searchWorkspaceFiles = async/);

  assert.match(viewPropsSource, /Omit<DashboardViewProps, "onOpenFeedback">/);
  assert.match(viewPropsSource, /Omit<SessionViewProps, "onOpenFeedback">/);
  assert.match(viewPropsSource, /OnboardingViewProps/);
});
