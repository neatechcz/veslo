import type { McpServerEntry, McpStatusMap, SkillInstance, SkillInventoryItem } from "../types";

export type SessionCapabilityScope = "workspace" | "global";

export type SessionSkillCapabilityRow = {
  id: string;
  name: string;
  scope: SessionCapabilityScope;
  description?: string;
  trigger?: string;
  path: string;
};

export type SessionMcpCapabilityRow = {
  id: string;
  name: string;
  scope: SessionCapabilityScope;
  type: "remote" | "local";
  detail?: string;
  status: string;
};

export function normalizeSessionCapabilityDirectory(value: string | null | undefined) {
  return String(value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
}

function rowFromSkillInstance(instance: SkillInstance): SessionSkillCapabilityRow {
  return {
    id: instance.id,
    name: instance.name,
    scope: instance.scope === "user-global" ? "global" : "workspace",
    description: instance.description,
    trigger: instance.trigger,
    path: instance.path,
  };
}

export function buildSessionSkillRows(items: SkillInventoryItem[]): SessionSkillCapabilityRow[] {
  return items.flatMap((item) => {
    if (item.workspaceInstances.length > 0) return item.workspaceInstances.map(rowFromSkillInstance);
    if (item.globalInstance) return [rowFromSkillInstance(item.globalInstance)];
    return [];
  });
}

export function buildSessionMcpRows(entries: McpServerEntry[], statuses: McpStatusMap): SessionMcpCapabilityRow[] {
  return entries.map((entry) => ({
    id: entry.name,
    name: entry.name,
    scope: entry.source === "config.global" ? "global" : "workspace",
    type: entry.config.type,
    detail: entry.config.type === "remote" ? entry.config.url : entry.config.command?.join(" "),
    status:
      entry.config.enabled === false || entry.disabledByTools
        ? "disabled"
        : statuses[entry.name]?.status ?? "disconnected",
  }));
}
