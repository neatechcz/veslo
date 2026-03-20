import { fetchWithTimeout } from "./http";
import type { VesloWorkspaceExport } from "./veslo-server";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SharedSkillItem = {
  name: string;
  description?: string;
  content: string;
  trigger?: string;
};

export type SharedSkillBundleV1 = {
  schemaVersion: 1;
  type: "skill";
  name: string;
  description?: string;
  trigger?: string;
  content: string;
};

export type SharedSkillsSetBundleV1 = {
  schemaVersion: 1;
  type: "skills-set";
  name: string;
  description?: string;
  skills: SharedSkillItem[];
};

export type SharedWorkspaceProfileBundleV1 = {
  schemaVersion: 1;
  type: "workspace-profile";
  name: string;
  description?: string;
  workspace: VesloWorkspaceExport;
};

export type SharedBundleV1 =
  | SharedSkillBundleV1
  | SharedSkillsSetBundleV1
  | SharedWorkspaceProfileBundleV1;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function readSkillItem(value: unknown): SharedSkillItem | null {
  const record = readRecord(value);
  if (!record) return null;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const content = typeof record.content === "string" ? record.content : "";
  if (!name || !content) return null;
  return {
    name,
    description: typeof record.description === "string" ? record.description : undefined,
    trigger: typeof record.trigger === "string" ? record.trigger : undefined,
    content,
  };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export function parseSharedBundle(value: unknown): SharedBundleV1 {
  const record = readRecord(value);
  if (!record) {
    throw new Error("Invalid shared bundle payload.");
  }

  const schemaVersion = typeof record.schemaVersion === "number" ? record.schemaVersion : null;
  const type = typeof record.type === "string" ? record.type.trim() : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";

  if (schemaVersion !== 1) {
    throw new Error("Unsupported bundle schema version.");
  }

  if (type === "skill") {
    const content = typeof record.content === "string" ? record.content : "";
    if (!name || !content) {
      throw new Error("Invalid skill bundle payload.");
    }
    return {
      schemaVersion: 1,
      type: "skill",
      name,
      description: typeof record.description === "string" ? record.description : undefined,
      trigger: typeof record.trigger === "string" ? record.trigger : undefined,
      content,
    };
  }

  if (type === "skills-set") {
    const skills = Array.isArray(record.skills)
      ? record.skills.map(readSkillItem).filter((item): item is SharedSkillItem => Boolean(item))
      : [];
    if (!skills.length) {
      throw new Error("Skills set bundle has no importable skills.");
    }
    return {
      schemaVersion: 1,
      type: "skills-set",
      name: name || "Shared skills",
      description: typeof record.description === "string" ? record.description : undefined,
      skills,
    };
  }

  if (type === "workspace-profile") {
    const workspace = readRecord(record.workspace);
    if (!workspace) {
      throw new Error("Workspace profile bundle is missing workspace payload.");
    }
    return {
      schemaVersion: 1,
      type: "workspace-profile",
      name: name || "Shared workspace profile",
      description: typeof record.description === "string" ? record.description : undefined,
      workspace: workspace as VesloWorkspaceExport,
    };
  }

  throw new Error(`Unsupported bundle type: ${type || "unknown"}`);
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

export async function fetchSharedBundle(bundleUrl: string): Promise<SharedBundleV1> {
  let targetUrl: URL;
  try {
    targetUrl = new URL(bundleUrl);
  } catch {
    throw new Error("Invalid shared bundle URL.");
  }

  if (targetUrl.protocol !== "https:" && targetUrl.protocol !== "http:") {
    throw new Error("Shared bundle URL must use http(s).");
  }

  if (!targetUrl.searchParams.has("format")) {
    targetUrl.searchParams.set("format", "json");
  }

  const response = await fetchWithTimeout(
    globalThis.fetch,
    targetUrl.toString(),
    { method: "GET", headers: { Accept: "application/json" } },
    15_000,
  );
  if (!response.ok) {
    const details = (await response.text()).trim();
    const suffix = details ? `: ${details}` : "";
    throw new Error(`Failed to fetch bundle (${response.status})${suffix}`);
  }
  return parseSharedBundle(await response.json());
}

// ---------------------------------------------------------------------------
// Import payload
// ---------------------------------------------------------------------------

export function buildImportPayloadFromBundle(bundle: SharedBundleV1): {
  payload: Record<string, unknown>;
  importedSkillsCount: number;
} {
  if (bundle.type === "skill") {
    return {
      payload: {
        mode: { skills: "merge" },
        skills: [
          {
            name: bundle.name,
            description: bundle.description,
            trigger: bundle.trigger,
            content: bundle.content,
          },
        ],
      },
      importedSkillsCount: 1,
    };
  }

  if (bundle.type === "skills-set") {
    return {
      payload: {
        mode: { skills: "merge" },
        skills: bundle.skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          trigger: skill.trigger,
          content: skill.content,
        })),
      },
      importedSkillsCount: bundle.skills.length,
    };
  }

  const workspace = bundle.workspace;
  const payload: Record<string, unknown> = {
    mode: {
      opencode: "merge",
      veslo: "merge",
      skills: "merge",
      commands: "merge",
    },
  };
  if (workspace.opencode && typeof workspace.opencode === "object") payload.opencode = workspace.opencode;
  if (workspace.veslo && typeof workspace.veslo === "object") payload.veslo = workspace.veslo;
  if (Array.isArray(workspace.skills) && workspace.skills.length) payload.skills = workspace.skills;
  if (Array.isArray(workspace.commands) && workspace.commands.length) payload.commands = workspace.commands;

  const importedSkillsCount = Array.isArray(workspace.skills) ? workspace.skills.length : 0;
  return { payload, importedSkillsCount };
}
