import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildSchedule, localDateTimeInputPartsFromInstant } from "./scheduled-automation-schedule";

const __dirname = dirname(fileURLToPath(import.meta.url));
const scheduledSource = () => readFileSync(join(__dirname, "scheduled.tsx"), "utf8");
const scheduleHelperSource = () => readFileSync(join(__dirname, "scheduled-automation-schedule.ts"), "utf8");
const workspaceMapSource = () => readFileSync(join(__dirname, "../lib/automation-workspace-map.ts"), "utf8");
const appSource = () => readFileSync(join(__dirname, "../app.tsx"), "utf8");
const dashboardSource = () => readFileSync(join(__dirname, "dashboard.tsx"), "utf8");

test("ScheduledTasksView keeps server automations on API handlers instead of prompt/session routing", () => {
  const source = scheduledSource();

  assert.match(source, /automationItems:\s*WorkspaceAutomationItem\[\]/);
  assert.match(source, /createAutomation:\s*\(/);
  assert.match(source, /runAutomation:\s*\(/);
  assert.match(source, /deleteAutomation:\s*\(/);
  assert.doesNotMatch(source, /ScheduledJob/);
  assert.doesNotMatch(source, /legacyScheduledJobs/);
  assert.doesNotMatch(source, /deleteLegacyJob/);
  assert.doesNotMatch(source, /schedulerInstalled/);

  const primaryCreate = source.match(/const handleCreateAutomation[\s\S]*?};/);
  assert.ok(primaryCreate);
  assert.match(primaryCreate[0], /props\.createAutomation/);
  assert.doesNotMatch(primaryCreate[0], /props\.setPrompt|props\.createSessionAndOpen/);

  const primaryRun = source.match(/const runAutomationNow[\s\S]*?};/);
  assert.ok(primaryRun);
  assert.match(primaryRun[0], /props\.runAutomation/);
  assert.doesNotMatch(primaryRun[0], /props\.setPrompt|props\.createSessionAndOpen/);
});

test("ScheduledTasksView uses workspace-aware automation items", () => {
  const source = scheduledSource();

  assert.match(source, /WorkspaceAutomationItem/);
  assert.match(source, /AutomationWorkspaceSummary/);
  assert.match(source, /automationItems:\s*WorkspaceAutomationItem\[\]/);
  assert.doesNotMatch(source, /automations:\s*VesloAutomation\[\]/);
});

test("ScheduledTasksView mutation handlers include workspace context", () => {
  const source = scheduledSource();

  assert.match(source, /createAutomation:\s*\(workspaceId:\s*string,/);
  assert.match(source, /updateAutomation:\s*\(workspaceId:\s*string,\s*automationId:\s*string,/);
  assert.match(source, /deleteAutomation:\s*\(workspaceId:\s*string,\s*automationId:\s*string/);
  assert.match(source, /runAutomation:\s*\(workspaceId:\s*string,\s*automationId:\s*string/);
  assert.match(source, /props\.updateAutomation/);
});

test("ScheduledTasksView provides app-style workspace filtering and cards", () => {
  const source = scheduledSource();

  assert.match(source, /workspaceFilter/);
  assert.match(source, /searchQuery/);
  assert.match(source, /scheduled\.all_workspaces/);
  assert.match(source, /item\.workspace\.name/);
  assert.match(source, /rounded-2xl border border-gray-4 bg-gray-1/);
  assert.doesNotMatch(source, /<table|<thead|<tbody/);
});

test("ScheduledTasksView keeps automation templates inside the create modal", () => {
  const source = scheduledSource();

  assert.match(source, /scheduled\.templates_label/);
  assert.match(source, /applyAutomationTemplate/);
  assert.doesNotMatch(source, /openCreateModalFromTemplate/);

  const emptyState = source.match(/fallback=\{\s*<div class="space-y-4">[\s\S]*?<\/div>\s*\}/)?.[0] ?? "";
  assert.ok(emptyState, "empty automations fallback should remain explicit");
  assert.doesNotMatch(emptyState, /AutomationTemplateCard/);

  const createModal = source.match(/<Show when=\{createModalOpen\(\)\}>[\s\S]*?<Show when=\{editTarget\(\)\}>/)?.[0] ?? "";
  assert.ok(createModal, "create modal source should be present");
  assert.match(createModal, /AutomationTemplateCard/);
  assert.match(createModal, /scheduled\.no_ready_workspaces_title/);
});

test("ScheduledTasksView can open create automation without the session new-task guard", () => {
  const source = scheduledSource();

  assert.match(source, /const createModalDisabled = createMemo\(\(\) => !props\.sourceReady \|\| props\.busy\)/);
  assert.doesNotMatch(source, /props\.newTaskDisabled \|\| !props\.sourceReady/);
  assert.match(source, /disabled=\{createModalDisabled\(\)\}/);
});

test("App recovers the local Veslo server before refreshing automations", () => {
  const source = appSource();
  const dashboard = dashboardSource();
  const recovery = source.match(/const ensureScheduledJobsSourceReady[\s\S]*?};/);
  const clientRecovery = source.match(/const ensureScheduledJobsClient[\s\S]*?};/);
  const refresh = source.match(/const refreshScheduledJobs[\s\S]*?const reloadScheduledJobsSource/)?.[0] ?? "";

  assert.ok(recovery, "scheduled automations source recovery helper should be present");
  assert.match(recovery[0], /scheduledJobsSourceReady\(\)/);
  assert.match(recovery[0], /scheduledJobsSource\(\) !== "local"/);
  assert.match(recovery[0], /ensureLocalVesloServerRunning\(\{ ignoreStartupPreference: true \}\)/);
  assert.ok(clientRecovery, "scheduled automations client recovery helper should be present");
  assert.match(clientRecovery[0], /ensureLocalVesloServerRunning\(\{ ignoreStartupPreference: true \}\)/);
  assert.match(clientRecovery[0], /await vesloServerInfo\(\)/);
  assert.match(clientRecovery[0], /createVesloServerClient\(\{ baseUrl, token: clientToken, hostToken \}\)/);
  assert.match(refresh, /await ensureScheduledJobsClient\(\)\.catch/);
  assert.ok(
    refresh.indexOf("await ensureScheduledJobsClient().catch") < refresh.indexOf("const serverStatus = vesloServerStatus()"),
    "automations refresh should recover a concrete Veslo server client before checking server status",
  );
  assert.match(refresh, /resolveAutomationWorkspaceMap\(client\)/);
  assert.match(source, /reloadScheduledAutomationsSource:\s*reloadScheduledJobsSource/);
  assert.match(dashboard, /reloadWorkspaceEngine=\{props\.reloadScheduledAutomationsSource\}/);
});

test("ScheduledTasksView defaults new automations to the active ready workspace when available", () => {
  const source = scheduledSource();
  const app = appSource();

  assert.match(source, /defaultAutomationWorkspaceId:\s*string\s*\|\s*null/);
  assert.match(source, /props\.defaultAutomationWorkspaceId/);
  assert.match(source, /readyWorkspaces\(\)\.find\(\(workspace\) => workspace\.serverWorkspaceId === props\.defaultAutomationWorkspaceId\)/);
  assert.match(source, /readyWorkspaces\(\)\[0\]\?\.serverWorkspaceId/);
  assert.match(app, /activeAutomationWorkspace/);
  assert.match(app, /activeWorkspaceId = workspaceStore\.activeWorkspaceId\(\)\.trim\(\)/);
  assert.match(app, /workspace\.appWorkspaceId === activeWorkspaceId/);
  assert.match(app, /defaultAutomationWorkspaceId:\s*activeAutomationWorkspace\(\)\?\.serverWorkspaceId \?\? null/);
  assert.ok(
    app.indexOf("const workspaceStore = createWorkspaceStore") < app.indexOf("const activeAutomationWorkspace = createMemo"),
    "activeAutomationWorkspace must be declared after workspaceStore is initialized",
  );
});

test("ScheduledTasksView exposes stable hooks for desktop automation management E2E", () => {
  const source = scheduledSource();

  assert.match(source, /data-testid="scheduled-automations-page"/);
  assert.match(source, /data-testid="scheduled-automations-refresh"/);
  assert.match(source, /data-testid="scheduled-automation-card"/);
  assert.match(source, /data-automation-id=\{automation\(\)\.id\}/);
  assert.match(source, /data-automation-workspace-id=\{workspace\(\)\.serverWorkspaceId/);
  assert.match(source, /data-testid="scheduled-automation-edit"/);
  assert.match(source, /data-testid="scheduled-automation-edit-modal"/);
  assert.match(source, /data-testid="scheduled-automation-edit-name"/);
  assert.match(source, /data-testid="scheduled-automation-edit-save"/);
});

test("App refreshes automations for all mapped workspaces", () => {
  const source = appSource();

  assert.match(source, /resolveAutomationWorkspaceMap/);
  assert.match(source, /setAutomationItems/);
  assert.match(source, /Promise\.all\([\s\S]*listAutomations/);
  assert.doesNotMatch(source, /const automationClient = resolveVesloAutomations\(\);[\s\S]*listAutomations\(automationClient\.workspaceId\)/);
});

test("App only treats remote automation workspace ids as ready when the connected server lists them", () => {
  const source = appSource();
  const mapSource = workspaceMapSource();

  assert.match(source, /buildAutomationWorkspaceSummaries/);
  assert.match(source, /connectedServerBaseUrl:\s*client\.baseUrl/);
  assert.match(mapSource, /const listedServerWorkspaceIds = new Set\(input\.serverWorkspaces\.map\(\(item\) => item\.id\)\)/);
  assert.match(mapSource, /listedServerWorkspaceIds\.has\(storedServerWorkspaceId\)/);
  assert.match(mapSource, /findServerWorkspaceByDirectory\(input\.serverWorkspaces, workspace\.directory \?\? workspace\.path \?\? ""\)/);
  assert.match(mapSource, /remoteWorkspaceBelongsToDifferentServer\(workspace, input\.connectedServerBaseUrl\)/);
  assert.doesNotMatch(source, /serverWorkspaceId =\s*\n\s*workspace\.vesloWorkspaceId\?\.trim\(\)/);
});

test("ScheduledTasksView builds server-compatible weekly schedules without raw scheduler UI", () => {
  const source = scheduledSource();
  const helperSource = scheduleHelperSource();

  assert.match(helperSource, /id:\s*"su"[\s\S]*?weekday:\s*7/);
  assert.doesNotMatch(helperSource, /id:\s*"su"[\s\S]*?weekday:\s*0/);
  assert.match(source, /scheduled\.label_fallback_title/);
  assert.doesNotMatch(source, /scheduled\.label_projects|scheduled\.placeholder_folder/);
  assert.doesNotMatch(source, /LegacyJobCard|legacyDelete|legacy_scheduler|legacy_jobs|delete_desc_local/);
  assert.doesNotMatch(source, /raw scheduler|local scheduler|opencode-scheduler/i);
});

test("ScheduledTasksView uses server readiness fallback instead of Scheduler fallback", () => {
  const source = scheduledSource();
  const gate = source.match(/<Show when=\{serverUnavailable\(\)\}>[\s\S]*?<\/Show>/);
  assert.ok(gate, "server readiness fallback is missing");
  assert.match(gate[0], /scheduled\.server_unavailable_title/);
  assert.match(gate[0], /scheduled\.server_unavailable_hint/);
  assert.doesNotMatch(gate[0], /scheduled\.install_scheduler|scheduler|opencode-scheduler/i);
});

test("buildSchedule preserves local timezone for recurring wall-clock schedules", () => {
  const baseOptions = {
    timeValue: "09:00",
    days: ["mo", "tu", "we", "th", "fr", "sa", "su"],
    intervalHours: 6,
    runAtDate: "2026-06-07",
    runAtTime: "09:00",
    quickMinutes: 0,
  };

  assert.deepEqual(buildSchedule("daily", baseOptions, "Europe/Prague"), {
    kind: "daily",
    hour: 9,
    minute: 0,
    timezone: "Europe/Prague",
  });

  assert.deepEqual(buildSchedule("daily", { ...baseOptions, days: ["su"] }, "Europe/Prague"), {
    kind: "weekly",
    weekday: 7,
    hour: 9,
    minute: 0,
    timezone: "Europe/Prague",
  });

  assert.deepEqual(buildSchedule("daily", { ...baseOptions, days: ["mo", "we", "fr"] }, "Europe/Prague"), {
    kind: "cron",
    expression: "0 9 * * 1,3,5",
    timezone: "Europe/Prague",
  });

  assert.deepEqual(buildSchedule("interval", baseOptions, "Europe/Prague"), {
    kind: "interval",
    seconds: 21600,
  });

  const oneShot = buildSchedule("oneShot", baseOptions, "Europe/Prague");
  assert.equal(oneShot?.kind, "oneShot");
  assert.equal("timezone" in (oneShot ?? {}), false);
});

test("one-shot edit form roundtrips a local wall-clock instant without UTC shifting", () => {
  const originalRunAt = new Date(2026, 5, 7, 22, 52, 0, 0).toISOString();
  const parts = localDateTimeInputPartsFromInstant(originalRunAt);

  const oneShot = buildSchedule("oneShot", {
    timeValue: "09:00",
    days: ["mo"],
    intervalHours: 6,
    runAtDate: parts.date,
    runAtTime: parts.time,
    quickMinutes: 0,
  });

  assert.deepEqual(oneShot, { kind: "oneShot", runAt: originalRunAt });
});
