export const SHAREPOINT_MCP_ID = "microsoft-sharepoint";

const SHAREPOINT_MCP_PROMPT_STORAGE_PREFIX = "veslo.mcp.sharepoint.prompt.v1";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type HubMcpLike = {
  id?: string;
  name?: string;
};

type McpServerLike = {
  name?: string;
  config?: {
    type?: string;
    headers?: Record<string, string>;
  };
};

export function sharePointMcpPromptStorageKey(orgId: string) {
  return `${SHAREPOINT_MCP_PROMPT_STORAGE_PREFIX}.${orgId.trim()}`;
}

export function markSharePointMcpPromptDismissed(storage: StorageLike | null | undefined, orgId: string) {
  const normalizedOrgId = orgId.trim();
  if (!storage || !normalizedOrgId) return;
  storage.setItem(sharePointMcpPromptStorageKey(normalizedOrgId), "dismissed");
}

export function markSharePointMcpPromptAccepted(storage: StorageLike | null | undefined, orgId: string) {
  const normalizedOrgId = orgId.trim();
  if (!storage || !normalizedOrgId) return;
  storage.setItem(sharePointMcpPromptStorageKey(normalizedOrgId), "accepted");
}

export function isSharePointMcpInstalled(mcpServers: readonly McpServerLike[]) {
  return mcpServers.some((entry) => {
    if (entry.name === SHAREPOINT_MCP_ID) return true;
    const headers = entry.config?.headers ?? {};
    return headers["X-Veslo-Connector"] === SHAREPOINT_MCP_ID;
  });
}

export function hasSharePointHubMcp(hubMcpCards: readonly HubMcpLike[]) {
  return hubMcpCards.some((entry) => entry.id === SHAREPOINT_MCP_ID || entry.name === SHAREPOINT_MCP_ID);
}

export function shouldPromptSharePointMcpInstall(input: {
  denOrgId: string | null | undefined;
  hubMcpCards: readonly HubMcpLike[];
  mcpServers: readonly McpServerLike[];
  storage: StorageLike | null | undefined;
}) {
  const orgId = input.denOrgId?.trim() ?? "";
  if (!orgId) return false;
  if (!hasSharePointHubMcp(input.hubMcpCards)) return false;
  if (isSharePointMcpInstalled(input.mcpServers)) return false;

  const promptState = input.storage?.getItem(sharePointMcpPromptStorageKey(orgId))?.trim() ?? "";
  return promptState !== "dismissed" && promptState !== "accepted";
}
