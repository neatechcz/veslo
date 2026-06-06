import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const soulSource = readFileSync(new URL("./soul.tsx", import.meta.url), "utf8");
const soulControllerSource = readFileSync(new URL("./soul-controller.ts", import.meta.url), "utf8");
const dashboardSource = readFileSync(new URL("./dashboard.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const vesloServerSource = readFileSync(new URL("../lib/veslo-server.ts", import.meta.url), "utf8");
const enSource = readFileSync(new URL("../../i18n/locales/en.ts", import.meta.url), "utf8");
const csSource = readFileSync(new URL("../../i18n/locales/cs.ts", import.meta.url), "utf8");
const zhSource = readFileSync(new URL("../../i18n/locales/zh.ts", import.meta.url), "utf8");

test("SoulView consumes overview source summaries instead of legacy prompt setup state", () => {
  assert.match(soulSource, /VesloSoulOverviewResponse/);
  assert.match(soulSource, /VesloSoulSummary/);
  assert.match(soulSource, /soulOverview:\s*VesloSoulOverviewResponse\s*\|\s*null;/);
  assert.match(soulSource, /soulOverviewError:\s*string\s*\|\s*null;/);
  assert.match(soulSource, /soulOverviewBusy:\s*boolean;/);
  assert.doesNotMatch(soulSource, /runSoulPrompt/);
  assert.doesNotMatch(soulSource, /give-me-a-soul\.md/);
  assert.doesNotMatch(soulSource, /\.opencode\/soul\.md/);
  assert.doesNotMatch(soulSource, /cadenceOptions|focusInput|boundariesInput|update_focus_prompt/);
});

test("Dashboard passes Soul overview state and busy flag to SoulView", () => {
  assert.match(dashboardSource, /soulOverviewBusy:\s*boolean;/);
  assert.match(dashboardSource, /soulClient:\s*VesloServerClient\s*\|\s*null;/);
  assert.match(dashboardSource, /soulServerConnected:\s*boolean;/);
  assert.match(dashboardSource, /soulAuthContext:\s*VesloSoulAuthContext;/);
  assert.match(appSource, /const \[soulOverviewBusy,\s*setSoulOverviewBusy\] = createSignal\(false\)/);
  assert.match(appSource, /soulOverviewBusy:\s*soulOverviewBusy\(\)/);
  assert.match(appSource, /soulClient:\s*vesloServerClient\(\)/);
  assert.match(appSource, /soulServerConnected:\s*vesloServerStatus\(\)\s*===\s*"connected"/);
  assert.match(appSource, /soulAuthContext:\s*skillRegistryMaterializationAuthContext\(\)/);
  assert.match(dashboardSource, /<SoulView[\s\S]*soulOverview=\{props\.soulOverview\}/);
  assert.match(dashboardSource, /<SoulView[\s\S]*soulOverviewError=\{props\.soulOverviewError\}/);
  assert.match(dashboardSource, /<SoulView[\s\S]*soulOverviewBusy=\{props\.soulOverviewBusy\}/);
  assert.match(dashboardSource, /<SoulView[\s\S]*client=\{props\.soulClient\}/);
  assert.match(dashboardSource, /<SoulView[\s\S]*serverConnected=\{props\.soulServerConnected\}/);
  assert.match(dashboardSource, /<SoulView[\s\S]*authContext=\{props\.soulAuthContext\}/);
  assert.match(dashboardSource, /<SoulView[\s\S]*refresh=\{props\.refreshSoulData\}/);
  assert.doesNotMatch(dashboardSource, /<SoulView[\s\S]{0,500}runSoulPrompt=\{props\.runSoulPrompt\}/);
});

test("Soul source overview order is organization, user, then workspace table", () => {
  const orgIndex = soulSource.indexOf('"soul-organization-source"');
  const userIndex = soulSource.indexOf('"soul-user-source"');
  const workspaceIndex = soulSource.indexOf('"soul-workspace-sources-table"');

  assert.ok(orgIndex >= 0, "organization source panel should have a stable test id");
  assert.ok(userIndex >= 0, "user source panel should have a stable test id");
  assert.ok(workspaceIndex >= 0, "workspace sources table should have a stable test id");
  assert.ok(orgIndex < userIndex, "organization source should render before user source");
  assert.ok(userIndex < workspaceIndex, "user source should render before workspace sources");
});

test("SoulView opens source editing and history in a modal from every source row", () => {
  assert.match(soulSource, /const \[openSourceKey,\s*setOpenSourceKey\] = createSignal<string \| null>\(null\)/);
  assert.match(soulSource, /"soul-organization-source-open"/);
  assert.match(soulSource, /"soul-user-source-open"/);
  assert.match(soulSource, /data-testid=\{`\$\{source\.testId\}-open`\}/);
  assert.match(soulSource, /data-testid="soul-source-modal"/);
  assert.match(soulSource, /role="dialog"/);
  assert.match(soulSource, /aria-modal="true"/);
  assert.match(soulSource, /data-testid="soul-source-modal-close"/);
  assert.match(soulSource, /event\.key === "Escape"/);
  assert.match(soulSource, /closeSoulModal/);

  const modalIndex = soulSource.indexOf('data-testid="soul-source-modal"');
  const detailIndex = soulSource.indexOf('data-testid="soul-source-detail"');
  const historyIndex = soulSource.indexOf('data-testid="soul-version-history"');
  assert.ok(modalIndex >= 0, "Soul editor modal should have a stable test id");
  assert.ok(detailIndex > modalIndex, "Soul source detail should live inside the modal");
  assert.ok(historyIndex > modalIndex, "Soul version history should live inside the modal");

  assert.match(soulSource, /sources:\s*modalSourceOptions/);
  assert.doesNotMatch(soulSource, /sources:\s*sourceOptions/);
});

test("Soul source modal uses an opaque centered panel shell", () => {
  const overlayIndex = soulSource.indexOf('<div class="fixed inset-0 z-50');
  const modalIndex = soulSource.indexOf('data-testid="soul-source-modal"');
  const detailIndex = soulSource.indexOf('data-testid="soul-source-detail"');

  assert.ok(overlayIndex >= 0, "Soul modal overlay should have a stable fixed shell");
  assert.ok(modalIndex > overlayIndex, "Soul modal panel should render inside the overlay");
  assert.ok(detailIndex > modalIndex, "Soul editor content should render inside the modal panel");

  const overlayShell = soulSource.slice(overlayIndex, modalIndex);
  const modalShell = soulSource.slice(modalIndex, detailIndex);

  assert.match(overlayShell, /items-center/);
  assert.match(overlayShell, /justify-center/);
  assert.match(overlayShell, /backdrop-blur-sm/);
  assert.match(modalShell, /bg-dls-surface/);
  assert.match(modalShell, /shadow-2xl/);
  assert.doesNotMatch(modalShell, /bg-dls-bg/);
});

test("SoulView hides private workspace Soul rows from the workspace source table", () => {
  assert.match(soulSource, /workspaces:\s*WorkspaceInfo\[\];/);
  assert.match(soulSource, /isPrivateWorkspacePath:\s*\(folder:\s*string \| null \| undefined\) => boolean;/);
  assert.match(soulSource, /const workspaceById = createMemo\(\(\) => new Map/);
  assert.match(soulSource, /workspace\?\.workspaceType === "local"/);
  assert.match(soulSource, /props\.isPrivateWorkspacePath\(workspace\.path\)/);
  assert.match(dashboardSource, /<SoulView[\s\S]*workspaces=\{props\.workspaces\}/);
  assert.match(dashboardSource, /<SoulView[\s\S]*isPrivateWorkspacePath=\{props\.isPrivateWorkspacePath\}/);
});

test("Soul overview locale keys exist in all app locales", () => {
  const requiredKeys = [
    "soul.source_title",
    "soul.source_subtitle",
    "soul.organization_source",
    "soul.user_source",
    "soul.workspace_sources",
    "soul.status",
    "soul.heartbeat",
    "soul.updated",
    "soul.current_version",
    "soul.editable",
    "soul.read_only",
    "soul.empty_workspaces",
    "soul.not_available",
    "soul.loading_overview",
    "soul.actions",
    "soul.change_summary",
    "soul.change_summary_placeholder",
    "soul.default_change_summary",
    "soul.detail_empty",
    "soul.detail_error",
    "soul.detail_loading",
    "soul.detail_title",
    "soul.editor_content",
    "soul.history_empty",
    "soul.history_error",
    "soul.history_loading",
    "soul.history_title",
    "soul.materialization_action",
    "soul.materialization_conflicts",
    "soul.materialization_status",
    "soul.open_source",
    "soul.preview_error",
    "soul.preview_loading",
    "soul.preview_title",
    "soul.restore",
    "soul.restore_change_summary",
    "soul.restore_change_summary_placeholder",
    "soul.restore_default_summary",
    "soul.restore_selected",
    "soul.restoring",
    "soul.save",
    "soul.save_blocked_read_only",
    "soul.save_changes",
    "soul.saving",
    "soul.selected",
    "soul.source_current_marker",
    "soul.source_details",
    "soul.source_unavailable",
    "soul.toggle_heartbeat",
    "soul.turn_heartbeat_off",
    "soul.turn_heartbeat_on",
    "soul.updated_by",
    "soul.version_created",
    "soul.version_current",
    "soul.version_preview",
    "soul.version_source",
    "soul.workspace_heartbeat_description",
  ];

  for (const localeSource of [enSource, csSource, zhSource]) {
    for (const key of requiredKeys) {
      assert.match(localeSource, new RegExp(`"${key.replaceAll(".", "\\.")}":`), `${key} should be localized`);
    }
  }
});

test("SoulView loads selected source detail and version history through existing client methods", () => {
  assert.match(soulSource, /client:\s*VesloServerClient\s*\|\s*null;/);
  assert.match(soulSource, /serverConnected:\s*boolean;/);
  assert.match(soulSource, /authContext:\s*VesloSoulAuthContext;/);
  assert.match(soulControllerSource, /getOrganizationSoul\(input\.authContext\(\)\)/);
  assert.match(soulControllerSource, /getUserSoul\(input\.authContext\(\)\)/);
  assert.match(soulControllerSource, /getWorkspaceSoul\(source\.workspaceId,\s*input\.authContext\(\)\)/);
  assert.match(soulControllerSource, /listSoulVersions\(source\.scope,\s*soulVersionListOptions\(source,\s*input\.authContext\(\)\)\)/);
  assert.match(soulControllerSource, /getSoulVersion\(source\.scope,\s*versionId,\s*soulVersionGetOptions\(source,\s*input\.authContext\(\)\)\)/);
});

test("SoulView save flow sends current baseVersionId and respects organization summary editability", () => {
  assert.match(soulControllerSource, /const selectedCanEdit = createMemo/);
  assert.match(
    soulControllerSource,
    /source\.scope === "organization"[\s\S]{0,180}source\.summary\?\.canEdit/,
    "organization editability should come from the selected overview summary",
  );
  assert.match(soulControllerSource, /const saveDisabled = createMemo/);
  assert.match(soulControllerSource, /!input\.client\(\)\s*\|\|\s*!input\.serverConnected\(\)/);
  assert.match(soulControllerSource, /detailLoading\(\)\s*\|\|\s*selectedSavePending\(\)/);
  assert.match(soulControllerSource, /content\(\) === initialContent\(\)/);
  assert.match(soulControllerSource, /baseVersionId:\s*currentBaseVersionId\(\)/);
  assert.match(soulControllerSource, /updateOrganizationSoul\(mutationInput\)/);
  assert.match(soulControllerSource, /updateUserSoul\(mutationInput\)/);
  assert.match(soulControllerSource, /updateWorkspaceSoul\(source\.workspaceId,\s*mutationInput\)/);
  assert.match(soulControllerSource, /savePendingBySource/);
  assert.match(soulControllerSource, /requestId\s*=\s*\+\+saveRequestSeq/);
});

test("SoulView exposes version preview and restore without inventing endpoints", () => {
  assert.match(soulSource, /data-testid="soul-version-history"/);
  assert.match(soulSource, /selectedVersionId/);
  assert.match(soulSource, /selectedVersionPreview/);
  assert.match(soulControllerSource, /restoreOrganizationSoulVersion\(versionId,\s*restoreInput\)/);
  assert.match(soulControllerSource, /restoreUserSoulVersion\(versionId,\s*restoreInput\)/);
  assert.match(soulControllerSource, /restoreWorkspaceSoulVersion\(source\.workspaceId,\s*versionId,\s*restoreInput\)/);
  assert.match(soulControllerSource, /changeSummary:\s*restoreChangeSummaryValue\(\)/);
  assert.match(soulControllerSource, /restorePendingBySource/);
  assert.match(soulControllerSource, /requestId\s*=\s*\+\+restoreRequestSeq/);
  assert.doesNotMatch(vesloServerSource, /restoreSoulVersion:\s*\(/, "client should keep scope-specific restore methods");
});

test("SoulView exposes heartbeat toggle only for workspace Soul sources", () => {
  assert.match(soulControllerSource, /source\.scope !== "workspace"/);
  assert.match(soulControllerSource, /setWorkspaceSoulHeartbeat\(source\.workspaceId,\s*nextEnabled,\s*input\.authContext\(\)\)/);
  assert.match(soulSource, /heartbeatPendingSourceKey/);
  assert.match(soulSource, /data-testid="soul-workspace-heartbeat-toggle"/);
  assert.doesNotMatch(soulSource, /setOrganizationSoulHeartbeat|setUserSoulHeartbeat/);
  assert.doesNotMatch(vesloServerSource, /setOrganizationSoulHeartbeat|setUserSoulHeartbeat/);
});

test("SoulView keeps runtime materialization automatic and shows diagnostics only", () => {
  assert.match(soulControllerSource, /materialization/);
  assert.match(soulSource, /requiresAction/);
  assert.match(soulSource, /conflicts/);
  assert.doesNotMatch(soulSource, /manual sync|manualSync|sync toggle|syncSoul|runtime sync/i);
  assert.doesNotMatch(enSource, /manual sync|sync now|runtime sync/i);
  assert.doesNotMatch(csSource, /ruční synchronizaci|synchronizovat teď/i);
  assert.doesNotMatch(zhSource, /手动同步|立即同步/i);
});

test("Soul materialization diagnostics avoid runtime terminology in user-facing copy", () => {
  assert.doesNotMatch(enSource, /"soul\.materialization_status":\s*"Runtime status"/);
  assert.doesNotMatch(csSource, /"soul\.materialization_status":\s*"Stav runtime"/);
  assert.doesNotMatch(zhSource, /"soul\.materialization_status":\s*"运行状态"/);
});

test("Soul user source copy reflects that the editor is available now", () => {
  assert.doesNotMatch(enSource, /Editor controls will arrive in a later task/);
  assert.doesNotMatch(csSource, /Editační ovládání přijde v dalším úkolu/);
  assert.doesNotMatch(zhSource, /编辑控件会在后续任务中提供/);
});
