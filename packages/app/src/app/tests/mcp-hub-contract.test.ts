import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const extensionsSource = readFileSync(new URL("../context/extensions.ts", import.meta.url), "utf8");
const mcpSource = readFileSync(new URL("../pages/mcp.tsx", import.meta.url), "utf8");
const workflowSource = readFileSync(new URL("../context/mcp-connection-workflow.ts", import.meta.url), "utf8");
const mcpRefreshSource = readFileSync(new URL("../lib/mcp-server-refresh.ts", import.meta.url), "utf8");
const authModalSource = readFileSync(new URL("../components/mcp-auth-modal.tsx", import.meta.url), "utf8");
const constantsSource = readFileSync(new URL("../constants.ts", import.meta.url), "utf8");
const enLocaleSource = readFileSync(new URL("../../i18n/locales/en.ts", import.meta.url), "utf8");
const csLocaleSource = readFileSync(new URL("../../i18n/locales/cs.ts", import.meta.url), "utf8");
const zhLocaleSource = readFileSync(new URL("../../i18n/locales/zh.ts", import.meta.url), "utf8");

const microsoftSharePointCatalogItem = {
  id: "microsoft-sharepoint",
  name: "Microsoft SharePoint",
  description: "Search and read SharePoint content.",
  type: "remote",
  url: "https://api.veslo.work/v1/orgs/org_123/integrations/microsoft/microsoft-sharepoint/mcp",
  oauth: false,
  headers: {
    "X-Veslo-Connector-Token": "runtime-token",
  },
  authorization: {
    type: "veslo-server-oauth",
    provider: "microsoft",
    connectorId: "microsoft-sharepoint",
    scopes: ["Sites.Read.All", "Files.Read.All"],
    startPath: "/v1/orgs/org_123/integrations/microsoft/microsoft-sharepoint/oauth/start",
    runtimeTokenPath: "/v1/orgs/org_123/integrations/microsoft/microsoft-sharepoint/runtime-token",
    statusPath: "/v1/orgs/org_123/integrations/microsoft/connections",
    disconnectPath: "/v1/orgs/org_123/integrations/microsoft/microsoft-sharepoint/connection",
  },
  source: { scope: "platform" },
  provider: { id: "microsoft", group: "Microsoft" },
} as const;

test("extensions store wires hub mcp auth and actions", () => {
  const refreshHubMcpSource = extensionsSource.match(/async function refreshHubMcp[\s\S]*?async function refreshHubSkills/)?.[0] ?? "";
  const noAuthBranchSource = refreshHubMcpSource.match(/if \(!denToken \|\| !denOrgId\)\s*\{[\s\S]*?return;/)?.[0] ?? "";

  assert.match(extensionsSource, /readDenAuth\(\)/);
  assert.match(extensionsSource, /vesloClient\.mcp\.listHub/);
  assert.match(extensionsSource, /installHubMcp/);
  assert.match(extensionsSource, /hubMcpCards/);
  assert.match(refreshHubMcpSource, /translate\("mcp\.org_catalog_placeholder"\)/);
  assert.doesNotMatch(refreshHubMcpSource, /translate\("skills\.org_catalog_placeholder"\)/);
  assert.equal(noAuthBranchSource.length > 0, true);
  assert.doesNotMatch(noAuthBranchSource, /hubMcpLoaded = true/);
});

test("extensions store uses the mcp domain facade for hub mcp server requests", () => {
  assert.match(extensionsSource, /vesloClient\.mcp\.listHub/);
  assert.match(extensionsSource, /vesloClient\.mcp\.installHub/);
  assert.doesNotMatch(extensionsSource, /\(vesloClient as any\)\.(?:listHubMcp|installHubMcp)/);
});

test("App and MCP workflow use the mcp domain facade for workspace mcp server requests", () => {
  assert.match(mcpRefreshSource, /client\.mcp\.list\(workspaceId\)/);
  assert.match(workflowSource, /vesloClient\.mcp\.(?:add|remove|refreshRuntimeToken|logoutAuth)/);
  assert.doesNotMatch(mcpRefreshSource, /client\.listMcp\(/);
  assert.doesNotMatch(workflowSource, /vesloClient\.(?:addMcp|removeMcp|refreshMcpRuntimeToken|logoutMcpAuth)\(/);
});

test("extensions store retries hub mcp after Veslo server auth context becomes ready", () => {
  const autoRefreshSource =
    extensionsSource.match(/createEffect\(\(\) => \{[\s\S]*?refreshHubMcp\(\)\.catch[\s\S]*?\}\);/)?.[0] ?? "";

  assert.match(extensionsSource, /import \{ createEffect, createSignal \} from "solid-js";/);
  assert.match(autoRefreshSource, /options\.vesloServerStatus\(\) === "connected"/);
  assert.match(autoRefreshSource, /vesloCapabilities\?\.hub\?\.mcp\?\.read/);
  assert.match(autoRefreshSource, /readDenAuth\(\)/);
  assert.match(autoRefreshSource, /!root \|\| !canUseVesloServer \|\| !denToken \|\| !denOrgId/);
  assert.match(autoRefreshSource, /refreshHubMcp\(\)\.catch/);
});

test("mcp page renders hub mcp catalog entries after built-in quick connect", () => {
  assert.match(mcpSource, /props\.hubMcpCards/);
  assert.match(mcpSource, /props\.refreshHubMcp/);
  assert.match(mcpSource, /props\.installHubMcp/);
  assert.match(mcpSource, /props\.quickConnect/);
  assert.match(mcpSource, /data-testid="mcp-page"/);
});

test("mcp page displays Microsoft SharePoint from catalog name and provider metadata", () => {
  const pageConversionSource =
    mcpSource.match(/const orgCatalogQuickConnect[\s\S]*?\}\)\),\s*\);/)?.[0] ?? "";
  const providerLabelSource =
    mcpSource.match(/const hubProviderLabel = \(entry: McpDirectoryInfo\) => \{[\s\S]*?\};/)?.[0] ?? "";

  assert.equal(microsoftSharePointCatalogItem.name, "Microsoft SharePoint");
  assert.equal(microsoftSharePointCatalogItem.provider.id, "microsoft");
  assert.equal(microsoftSharePointCatalogItem.provider.group, "Microsoft");
  assert.match(pageConversionSource, /name:\s*entry\.name,/);
  assert.match(pageConversionSource, /provider:\s*entry\.provider,/);
  assert.match(providerLabelSource, /entry\.provider\?\.group\?\.trim\(\) \|\| entry\.provider\?\.id\?\.trim\(\)/);
  assert.match(mcpSource, /\{entry\.name\}<\/h4>/);
  assert.doesNotMatch(providerLabelSource, /Google|google/);
});

test("hub mcp cards preserve provider metadata and install by catalog identity", () => {
  const pageConversionSource =
    mcpSource.match(/const orgCatalogQuickConnect[\s\S]*?\}\)\),\s*\);/)?.[0] ?? "";
  const installClickSource = mcpSource.match(/props\.installHubMcp[\s\S]*?props\.refreshMcpServers\(\);/)?.[0] ?? "";
  const hubCatalogButtonSource =
    mcpSource.match(/data-testid="mcp-install-hub-button"[\s\S]*?props\.installHubMcp[\s\S]*?props\.refreshMcpServers\(\);/)?.[0] ?? "";
  const hubCatalogCardSource =
    mcpSource.match(/data-testid="mcp-available-app-card"[\s\S]*?data-testid="mcp-install-hub-button"/)?.[0] ?? "";
  const directoryHelperSource =
    workflowSource.match(/function directoryInfoFromHubMcpCard[\s\S]*?function findHubMcpForInstalledEntry/)?.[0] ?? "";

  assert.match(constantsSource, /provider\?:\s*\{[\s\S]*id:\s*string;[\s\S]*group\?:\s*string;[\s\S]*\};/);
  assert.match(constantsSource, /source\?:\s*HubMcpItem\["source"\];/);
  assert.match(pageConversionSource, /provider:\s*entry\.provider,/);
  assert.match(pageConversionSource, /source:\s*entry\.source,/);
  assert.match(pageConversionSource, /headers:\s*entry\.headers,/);
  assert.match(pageConversionSource, /authorization:\s*entry\.authorization,/);
  assert.match(directoryHelperSource, /provider:\s*entry\.provider,/);
  assert.match(directoryHelperSource, /source:\s*entry\.source,/);
  assert.match(directoryHelperSource, /headers:\s*entry\.headers/);
  assert.match(directoryHelperSource, /authorization:\s*entry\.authorization/);
  assert.match(hubCatalogButtonSource, /data-mcp-name=\{entry\.name\}/);
  assert.match(installClickSource, /props\.installHubMcp\(entry\.id \|\| entry\.name\)/);
  assert.equal(/<button[\s\S]*data-testid="mcp-available-app-card"/.test(hubCatalogCardSource), false);
});

test("Microsoft SharePoint catalog metadata stays provider-generic through app normalization", () => {
  const refreshHubMcpSource = extensionsSource.match(/async function refreshHubMcp[\s\S]*?createEffect/)?.[0] ?? "";
  const pageConversionSource =
    mcpSource.match(/const orgCatalogQuickConnect[\s\S]*?\}\)\),\s*\);/)?.[0] ?? "";
  const directoryHelperSource =
    workflowSource.match(/function directoryInfoFromHubMcpCard[\s\S]*?function findHubMcpForInstalledEntry/)?.[0] ?? "";
  const serverOAuthSource =
    workflowSource.match(/async function startServerManagedMcpOAuth[\s\S]*?async function activateInstalledMcp/)?.[0] ?? "";
  const hubActivationSource =
    workflowSource.match(/async function installHubMcpAndActivate[\s\S]*?async function logoutMcpAuth/)?.[0] ?? "";

  assert.equal(microsoftSharePointCatalogItem.id, "microsoft-sharepoint");
  assert.equal(microsoftSharePointCatalogItem.name, "Microsoft SharePoint");
  assert.equal(microsoftSharePointCatalogItem.source?.scope, "platform");
  assert.equal(microsoftSharePointCatalogItem.provider?.id, "microsoft");
  assert.equal(microsoftSharePointCatalogItem.provider?.group, "Microsoft");

  assert.match(refreshHubMcpSource, /provider:\s*entry\.provider,/);
  assert.match(refreshHubMcpSource, /source:\s*entry\.source,/);
  assert.match(refreshHubMcpSource, /authorization:\s*entry\.authorization,/);
  assert.match(refreshHubMcpSource, /headers:\s*entry\.config\.headers,/);
  assert.match(pageConversionSource, /id:\s*entry\.id,/);
  assert.match(pageConversionSource, /name:\s*entry\.name,/);
  assert.match(pageConversionSource, /provider:\s*entry\.provider,/);
  assert.match(pageConversionSource, /authorization:\s*entry\.authorization,/);
  assert.match(directoryHelperSource, /id:\s*entry\.id,/);
  assert.match(directoryHelperSource, /name:\s*entry\.name,/);
  assert.match(directoryHelperSource, /provider:\s*entry\.provider,/);
  assert.match(directoryHelperSource, /authorization:\s*entry\.authorization/);
  assert.match(serverOAuthSource, /const startPath = entry\.authorization\.startPath\.trim\(\)/);
  assert.match(serverOAuthSource, /\$\{denApiBase\}\$\{startPath\}/);
  assert.doesNotMatch(serverOAuthSource, /google|Google/);
  assert.doesNotMatch(hubActivationSource, /google|Google/);
});

test("mcp page exposes sign-in for installed server-managed hub connectors", () => {
  const hubLookupSource =
    mcpSource.match(/const hubMcpCardForInstalledEntry = \(entry: McpServerEntry\) =>[\s\S]*?const supportsOauth/)?.[0] ?? "";
  const supportsOauthSource =
    mcpSource.match(/const supportsOauth = \(entry: McpServerEntry\) =>[\s\S]*?const resolveStatus/)?.[0] ?? "";

  assert.equal(hubLookupSource.length > 0, true);
  assert.match(hubLookupSource, /const candidateId = candidate\.id\?\.trim\(\) \?\? ""/);
  assert.match(hubLookupSource, /candidateId === entry\.name/);
  assert.match(hubLookupSource, /quickConnectEntryKey\(\{ id: candidate\.id, name: candidate\.name \}\) === entry\.name/);
  assert.match(supportsOauthSource, /hubMcpCardForInstalledEntry\(entry\)\?\.authorization\?\.type === "veslo-server-oauth"/);
  assert.match(mcpSource, /supportsOauth\(entry\) && status\(\) !== "connected"/);
  assert.equal(microsoftSharePointCatalogItem.oauth, false);
  assert.equal(microsoftSharePointCatalogItem.authorization.type, "veslo-server-oauth");
});

test("hub mcp cards label shared provider context without merging card installs", () => {
  assert.match(mcpSource, /hubProviderLabel/);
  assert.match(mcpSource, /entry\.provider\?\.group/);
  assert.match(mcpSource, /entry\.provider\?\.id/);
  assert.match(mcpSource, /mcp\.hub_provider_label/);
});

test("mcp auth modal explains local token ownership in localized copy", () => {
  assert.match(authModalSource, /mcp\.auth\.local_token_notice/);

  assert.match(enLocaleSource, /"mcp\.auth\.local_token_notice":\s*"[^"]*browser[^"]*Veslo config[^"]*MCP OAuth client config[^"]*local MCP\/OpenCode runtime[^"]*not stored in Veslo cloud/);
  assert.doesNotMatch(enLocaleSource, /"mcp\.auth\.local_token_notice":\s*"[^"]*Google/);
  assert.match(csLocaleSource, /"mcp\.auth\.local_token_notice":\s*"[^"]*prohlížeči[^"]*konfiguraci Veslo[^"]*MCP OAuth klienta[^"]*lokální MCP\/OpenCode runtime[^"]*neukládají do cloudu Veslo/);
  assert.doesNotMatch(csLocaleSource, /"mcp\.auth\.local_token_notice":\s*"[^"]*Google/);
  assert.match(zhLocaleSource, /"mcp\.auth\.local_token_notice":\s*"[^"]*浏览器[^"]*Veslo 配置[^"]*MCP OAuth 客户端配置[^"]*本地 MCP\/OpenCode 运行时[^"]*不会存储在 Veslo 云/);
  assert.doesNotMatch(zhLocaleSource, /"mcp\.auth\.local_token_notice":\s*"[^"]*Google/);
});

test("mcp auth modal copy stays provider-neutral for Microsoft SharePoint", () => {
  assert.equal(microsoftSharePointCatalogItem.authorization.provider, "microsoft");
  assert.equal(microsoftSharePointCatalogItem.name, "Microsoft SharePoint");
  assert.match(authModalSource, /const serverName = \(\) => props\.entry\?\.name \?\? translate\("mcp\.server_fallback"\)/);
  assert.match(authModalSource, /translate\("mcp\.auth\.connect_server", \{ server: serverName\(\) \}\)/);
  assert.match(enLocaleSource, /"mcp\.auth\.connect_server":\s*"Connect \{server\}"/);
  assert.match(enLocaleSource, /"mcp\.auth\.step1_description":\s*"[^"]*\{server\}[^"]*"/);
  assert.doesNotMatch(authModalSource, /Google|google/);
  assert.doesNotMatch(enLocaleSource, /"mcp\.auth\.[^"]+":\s*"[^"]*Google/);
});

test("mcp auth modal uses catalog id as the runtime server key when present", () => {
  assert.match(
    authModalSource,
    /const resolveServerKey = \(entry: McpDirectoryInfo\) =>[\s\S]*validateMcpServerName\(entry\.id\?\.trim\(\) \|\| entry\.name\)/,
  );
  assert.match(authModalSource, /const resolveSlug = \(entry: McpDirectoryInfo\)/);
  assert.doesNotMatch(authModalSource, /resolveSlug\(entry\.name\)/);
  assert.doesNotMatch(authModalSource, /validateMcpServerName\(entry\.name\)/);
});
