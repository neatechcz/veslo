import type {
  SkillInstance,
  SkillInventoryItem,
  SkillInventoryScope,
  SkillInventoryStatus,
  WorkspaceSkillRegistryInstallation,
} from "../types";

export type SkillInventoryApprovalFilter = "approved" | "unapproved";

export type SkillInventoryFilters = {
  query?: string | null;
  workspaceId?: string | null;
  scopes?: readonly SkillInventoryScope[];
  statuses?: readonly SkillInventoryStatus[];
  approval?: SkillInventoryApprovalFilter | null;
  includeDeleted?: boolean;
};

export type SkillInventorySelectionId = `item:${string}` | `instance:${string}`;

type MetadataCarrier = {
  approved?: unknown;
  deleted?: unknown;
  deletedAt?: unknown;
  lifecycle?: unknown;
  removedAt?: unknown;
  registryInstallation?: Partial<WorkspaceSkillRegistryInstallation> | null;
  registryInstallations?: readonly Partial<WorkspaceSkillRegistryInstallation>[];
};

type TextMatch = {
  item: boolean;
  global: boolean;
  hub: boolean;
  workspaceInstanceIds: Set<string>;
};

const normalizeText = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  return String(value).toLowerCase().trim().replace(/\s+/g, " ");
};

const queryTokens = (query: string | null | undefined): string[] =>
  normalizeText(query)
    .split(" ")
    .map((token) => token.trim())
    .filter(Boolean);

const textMatches = (tokens: readonly string[], values: readonly unknown[]): boolean => {
  if (tokens.length === 0) return true;
  const haystack = normalizeText(values.filter((value) => value !== null && value !== undefined).join(" "));
  return tokens.every((token) => haystack.includes(token));
};

const asMetadataCarrier = (value: unknown): MetadataCarrier => {
  if (!value || typeof value !== "object") return {};
  return value as MetadataCarrier;
};

const isDeleted = (value: unknown): boolean => {
  const metadata = asMetadataCarrier(value);
  if (metadata.deleted === true) return true;
  if (metadata.lifecycle === "removed") return true;
  if (typeof metadata.deletedAt === "string" && metadata.deletedAt.trim()) return true;
  if (typeof metadata.removedAt === "string" && metadata.removedAt.trim()) return true;
  const registryInstallation = metadata.registryInstallation;
  if (!registryInstallation || typeof registryInstallation !== "object") return false;
  const registryDeletedAt = (registryInstallation as { deletedAt?: unknown }).deletedAt;
  return typeof registryDeletedAt === "string" && registryDeletedAt.trim().length > 0;
};

const approvalValues = (value: unknown): boolean[] => {
  const metadata = asMetadataCarrier(value);
  const approvals: boolean[] = [];

  if (typeof metadata.approved === "boolean") approvals.push(metadata.approved);
  if (typeof metadata.registryInstallation?.approved === "boolean") {
    approvals.push(metadata.registryInstallation.approved);
  }
  for (const installation of metadata.registryInstallations ?? []) {
    if (typeof installation.approved === "boolean") approvals.push(installation.approved);
  }

  return approvals;
};

const matchesApproval = (value: unknown, approval: SkillInventoryApprovalFilter | null | undefined): boolean => {
  if (!approval) return true;
  const approvals = approvalValues(value);
  if (approvals.length === 0) return false;
  return approval === "approved" ? approvals.some(Boolean) : approvals.some((approved) => !approved);
};

const itemTextValues = (item: SkillInventoryItem): unknown[] => [item.name, item.description, item.trigger, item.status];

const instanceTextValues = (instance: SkillInstance): unknown[] => [
  instance.id,
  instance.name,
  instance.description,
  instance.trigger,
  instance.path,
  instance.scope,
  instance.workspaceId,
  instance.workspaceLabel,
  instance.source,
];

const hubTextValues = (item: SkillInventoryItem): unknown[] => [
  item.hubItem?.name,
  item.hubItem?.description,
  item.hubItem?.trigger,
  item.hubItem?.source.owner,
  item.hubItem?.source.repo,
  item.hubItem?.source.ref,
  item.hubItem?.source.path,
];

const buildTextMatch = (item: SkillInventoryItem, tokens: readonly string[]): TextMatch => {
  const workspaceInstanceIds = new Set<string>();
  if (tokens.length === 0) {
    for (const instance of item.workspaceInstances) workspaceInstanceIds.add(instance.id);
    return {
      item: true,
      global: Boolean(item.globalInstance),
      hub: Boolean(item.hubItem),
      workspaceInstanceIds,
    };
  }

  const itemMatches = textMatches(tokens, itemTextValues(item));
  const globalMatches = item.globalInstance ? textMatches(tokens, instanceTextValues(item.globalInstance)) : false;
  const hubMatches = item.hubItem ? textMatches(tokens, hubTextValues(item)) : false;
  for (const instance of item.workspaceInstances) {
    if (textMatches(tokens, instanceTextValues(instance))) workspaceInstanceIds.add(instance.id);
  }

  return {
    item: itemMatches,
    global: itemMatches || globalMatches,
    hub: itemMatches || hubMatches,
    workspaceInstanceIds: itemMatches ? new Set(item.workspaceInstances.map((instance) => instance.id)) : workspaceInstanceIds,
  };
};

const matchesScope = (scope: SkillInventoryScope, scopes: readonly SkillInventoryScope[] | undefined): boolean =>
  !scopes || scopes.length === 0 || scopes.includes(scope);

const matchesStatus = (status: SkillInventoryStatus, statuses: readonly SkillInventoryStatus[] | undefined): boolean =>
  !statuses || statuses.length === 0 || statuses.includes(status);

const visibleStatusForItem = (
  globalInstance: SkillInstance | undefined,
  workspaceInstances: readonly SkillInstance[],
  hubItem: SkillInventoryItem["hubItem"],
): SkillInventoryStatus => {
  if (globalInstance && workspaceInstances.length > 0) return "mixed";
  if (globalInstance) return "global";
  if (workspaceInstances.length > 0) return "workspace-only";
  if (hubItem) return "hub-only";
  return "hub-only";
};

const visibleGlobalInstance = (
  item: SkillInventoryItem,
  filters: SkillInventoryFilters,
  textMatch: TextMatch,
): SkillInstance | undefined => {
  const instance = item.globalInstance;
  if (!instance) return undefined;
  if (filters.workspaceId) return undefined;
  if (!matchesScope(instance.scope, filters.scopes)) return undefined;
  if (!filters.includeDeleted && (isDeleted(item) || isDeleted(instance))) return undefined;
  if (!textMatch.global) return undefined;
  if (filters.approval && !matchesApproval(instance, filters.approval) && !matchesApproval(item, filters.approval)) {
    return undefined;
  }
  return instance;
};

const visibleWorkspaceInstances = (
  item: SkillInventoryItem,
  filters: SkillInventoryFilters,
  textMatch: TextMatch,
): SkillInstance[] =>
  item.workspaceInstances.filter((instance) => {
    if (filters.workspaceId && instance.workspaceId !== filters.workspaceId) return false;
    if (!matchesScope(instance.scope, filters.scopes)) return false;
    if (!filters.includeDeleted && (isDeleted(item) || isDeleted(instance))) return false;
    if (!textMatch.workspaceInstanceIds.has(instance.id)) return false;
    if (filters.approval && !matchesApproval(instance, filters.approval) && !matchesApproval(item, filters.approval)) {
      return false;
    }
    return true;
  });

const visibleHubItem = (
  item: SkillInventoryItem,
  filters: SkillInventoryFilters,
  textMatch: TextMatch,
): SkillInventoryItem["hubItem"] => {
  if (!item.hubItem) return undefined;
  if (filters.workspaceId) return undefined;
  if (filters.scopes && filters.scopes.length > 0) return undefined;
  if (!filters.includeDeleted && isDeleted(item)) return undefined;
  if (!textMatch.hub) return undefined;
  if (filters.approval && !matchesApproval(item, filters.approval)) return undefined;
  return item.hubItem;
};

export function filterSkillInventoryItems(
  items: readonly SkillInventoryItem[],
  filters: SkillInventoryFilters = {},
): SkillInventoryItem[] {
  const tokens = queryTokens(filters.query);

  return items.flatMap((item) => {
    if (!filters.includeDeleted && isDeleted(item)) return [];

    const textMatch = buildTextMatch(item, tokens);
    const globalInstance = visibleGlobalInstance(item, filters, textMatch);
    const workspaceInstances = visibleWorkspaceInstances(item, filters, textMatch);
    const hubItem = visibleHubItem(item, filters, textMatch);
    const status = visibleStatusForItem(globalInstance, workspaceInstances, hubItem);

    if (!globalInstance && workspaceInstances.length === 0 && !hubItem) return [];
    if (!matchesStatus(status, filters.statuses)) return [];

    return [
      {
        ...item,
        globalInstance,
        workspaceInstances,
        hubItem,
        status,
      },
    ];
  });
}

export const skillInventoryItemId = (item: Pick<SkillInventoryItem, "name">): SkillInventorySelectionId =>
  `item:${encodeURIComponent(item.name)}`;

export const skillInventoryInstanceId = (instance: Pick<SkillInstance, "id">): SkillInventorySelectionId =>
  `instance:${instance.id}`;

export function selectAllSkillInventoryIdsForCurrentFilter(
  items: readonly SkillInventoryItem[],
  filters: SkillInventoryFilters = {},
): SkillInventorySelectionId[] {
  const ids: SkillInventorySelectionId[] = [];
  for (const item of filterSkillInventoryItems(items, filters)) {
    if (item.globalInstance) ids.push(skillInventoryInstanceId(item.globalInstance));
    for (const instance of item.workspaceInstances) ids.push(skillInventoryInstanceId(instance));
    if (!item.globalInstance && item.workspaceInstances.length === 0 && item.hubItem) {
      ids.push(skillInventoryItemId(item));
    }
  }
  return ids;
}
