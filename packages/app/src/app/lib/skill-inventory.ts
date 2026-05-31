import type {
  HubSkillCard,
  SkillInstance,
  SkillInventoryItem,
  SkillInventoryScope,
  SkillInventoryWorkspace,
} from "../types";

export type SkillInventorySkillInput = {
  name: string;
  path: string;
  scope?: SkillInventoryScope;
  description?: string;
  trigger?: string;
  source?: SkillInstance["source"];
  lifecycle?: SkillInstance["lifecycle"];
  removedAt?: SkillInstance["removedAt"];
  removedBy?: SkillInstance["removedBy"];
  removeReason?: SkillInstance["removeReason"];
  registry?: SkillInstance["registry"];
  restoreTarget?: SkillInstance["restoreTarget"];
  readable?: boolean;
  writable?: boolean;
};

export type SkillInventoryWorkspaceInput = Omit<SkillInventoryWorkspace, "kind"> & {
  kind?: SkillInventoryWorkspace["kind"];
};

export type BuildSkillInventoryInput = {
  globalSkills: SkillInventorySkillInput[];
  workspaceSkillsByWorkspaceId: Record<
    string,
    {
      workspace: SkillInventoryWorkspaceInput;
      skills: SkillInventorySkillInput[];
    }
  >;
  hubSkills: HubSkillCard[];
};

export type SkillMutationTarget = {
  name: string;
  path: string;
  scope: SkillInventoryScope;
  workspaceId?: string;
};

type SkillInventoryGroup = {
  name: string;
  globalInstance?: SkillInstance;
  workspaceInstances: SkillInstance[];
  hubItem?: HubSkillCard;
};

const SKILL_SOURCES = new Set<SkillInstance["source"]>([
  "opencode",
  "claude",
  "agents",
  "hub",
  "unknown",
]);

const SKILL_SCOPES = new Set<SkillInventoryScope>(["workspace", "user-global", "organization"]);

const normalizeText = (value: string | undefined): string | undefined => {
  const normalized = value?.trim().replace(/\s+/g, " ");
  return normalized || undefined;
};

const normalizePath = (value: string | undefined): string | undefined => {
  const normalized = value?.trim();
  return normalized || undefined;
};

const compareStrings = (left: string, right: string) => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const inferSourceFromPath = (path: string): SkillInstance["source"] => {
  const normalized = path.replace(/\\/g, "/");
  if (normalized.includes("/.opencode/skills/")) return "opencode";
  if (normalized.includes("/.claude/skills/")) return "claude";
  if (normalized.endsWith("/AGENTS.md") || normalized === "AGENTS.md") return "agents";
  return "unknown";
};

const isManagedMaterializedSkillPath = (path: string): boolean =>
  path.replace(/\\/g, "/").includes("/.opencode/skills/veslo-managed/");

const normalizeSource = (source: SkillInventorySkillInput["source"], path: string): SkillInstance["source"] => {
  if (source && SKILL_SOURCES.has(source)) return source;
  return inferSourceFromPath(path);
};

const normalizeScope = (
  scope: SkillInventorySkillInput["scope"],
  fallback: SkillInventoryScope,
): SkillInventoryScope => {
  if (scope && SKILL_SCOPES.has(scope)) return scope;
  return fallback;
};

export const skillMutationTargetFromInstance = (instance: SkillInstance): SkillMutationTarget => ({
  name: instance.name,
  path: instance.path,
  scope: instance.scope,
  ...(instance.workspaceId ? { workspaceId: instance.workspaceId } : {}),
});

const instanceId = (scope: SkillInventoryScope, workspaceId: string | undefined, name: string, path: string) =>
  `${scope}:${scope === "workspace" ? workspaceId || "workspace" : "global"}:${name}:${path}`;

const normalizeSkillInstance = (
  skill: SkillInventorySkillInput,
  options: {
    scope: SkillInventoryScope;
    workspaceId?: string;
    workspaceLabel?: string;
  },
): SkillInstance | null => {
  const name = normalizeText(skill.name);
  const path = normalizePath(skill.path);
  if (!name || !path) return null;

  const description = normalizeText(skill.description);
  const trigger = normalizeText(skill.trigger);
  const scope = normalizeScope(skill.scope, options.scope);
  const lifecycle = skill.lifecycle === "removed" ? "removed" : "active";
  const defaultWritable = !isManagedMaterializedSkillPath(path);

  return {
    id: instanceId(scope, scope === "workspace" ? options.workspaceId : undefined, name, path),
    name,
    scope,
    workspaceId: scope === "workspace" ? options.workspaceId : undefined,
    workspaceLabel: scope === "workspace" ? options.workspaceLabel : undefined,
    path,
    description,
    trigger,
    source: normalizeSource(skill.source, path),
    lifecycle,
    removedAt: skill.removedAt,
    removedBy: skill.removedBy,
    removeReason: skill.removeReason,
    registry: skill.registry,
    restoreTarget: skill.restoreTarget,
    readable: skill.readable ?? true,
    writable: lifecycle === "removed" ? false : skill.writable ?? defaultWritable,
  };
};

const normalizeHubSkill = (skill: HubSkillCard): HubSkillCard | null => {
  const name = normalizeText(skill.name);
  if (!name) return null;
  const description = normalizeText(skill.description);
  const trigger = normalizeText(skill.trigger);

  return {
    ...skill,
    name,
    description,
    trigger,
  };
};

const firstDefined = (...values: Array<string | undefined>) => values.find((value) => value !== undefined);

const statusForGroup = (group: SkillInventoryGroup): SkillInventoryItem["status"] => {
  if (group.globalInstance && group.workspaceInstances.length > 0) return "mixed";
  if (group.globalInstance) return "global";
  if (group.workspaceInstances.length > 0) return "workspace-only";
  return "hub-only";
};

const getGroup = (groupsByName: Map<string, SkillInventoryGroup>, name: string): SkillInventoryGroup => {
  const existing = groupsByName.get(name);
  if (existing) return existing;
  const next = { name, workspaceInstances: [] };
  groupsByName.set(name, next);
  return next;
};

export function buildSkillInventory(input: BuildSkillInventoryInput): SkillInventoryItem[] {
  const groupsByName = new Map<string, SkillInventoryGroup>();

  const globalInstances = input.globalSkills
    .map((skill) => normalizeSkillInstance(skill, { scope: "user-global" }))
    .filter((instance): instance is SkillInstance => Boolean(instance))
    .sort((left, right) => compareStrings(left.name, right.name) || compareStrings(left.path, right.path));

  for (const instance of globalInstances) {
    const group = getGroup(groupsByName, instance.name);
    group.globalInstance ??= instance;
  }

  const workspaceEntries = Object.entries(input.workspaceSkillsByWorkspaceId)
    .map(([fallbackWorkspaceId, entry]) => {
      const workspaceId = normalizeText(entry.workspace.id) ?? fallbackWorkspaceId;
      const workspaceLabel = normalizeText(entry.workspace.label) ?? workspaceId;
      return {
        workspaceId,
        workspaceLabel,
        skills: entry.skills,
      };
    })
    .sort(
      (left, right) =>
        compareStrings(left.workspaceLabel, right.workspaceLabel) ||
        compareStrings(left.workspaceId, right.workspaceId),
    );

  for (const entry of workspaceEntries) {
    for (const skill of entry.skills) {
      const instance = normalizeSkillInstance(skill, {
        scope: "workspace",
        workspaceId: entry.workspaceId,
        workspaceLabel: entry.workspaceLabel,
      });
      if (!instance) continue;
      getGroup(groupsByName, instance.name).workspaceInstances.push(instance);
    }
  }

  const hubSkills = input.hubSkills
    .map(normalizeHubSkill)
    .filter((skill): skill is HubSkillCard => Boolean(skill))
    .sort((left, right) => compareStrings(left.name, right.name) || compareStrings(left.source.path, right.source.path));

  for (const skill of hubSkills) {
    const group = getGroup(groupsByName, skill.name);
    group.hubItem ??= skill;
  }

  return Array.from(groupsByName.values())
    .map((group): SkillInventoryItem => {
      const workspaceInstances = [...group.workspaceInstances].sort(
        (left, right) =>
          compareStrings(left.workspaceLabel ?? "", right.workspaceLabel ?? "") ||
          compareStrings(left.workspaceId ?? "", right.workspaceId ?? "") ||
          compareStrings(left.path, right.path),
      );

      return {
        name: group.name,
        description: firstDefined(
          group.globalInstance?.description,
          workspaceInstances[0]?.description,
          group.hubItem?.description,
        ),
        trigger: firstDefined(group.globalInstance?.trigger, workspaceInstances[0]?.trigger, group.hubItem?.trigger),
        globalInstance: group.globalInstance,
        workspaceInstances,
        hubItem: group.hubItem,
        status: statusForGroup({ ...group, workspaceInstances }),
      };
    })
    .sort((left, right) => compareStrings(left.name, right.name));
}
