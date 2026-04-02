import type { VesloSessionArtifactItem } from "../../lib/veslo-server";
import type { ArtifactItem } from "../../types";

export type ArtifactFamilyId = "files" | "skills" | "mcp" | "soul";

export type ArtifactFamilyItem = {
  id: string;
  family: ArtifactFamilyId;
  kind: string;
  status: string;
  title: string;
  subtitle?: string;
  path?: string;
  sourceName?: string;
  timestamp: number;
};

export type ArtifactFamily = {
  family: ArtifactFamilyId;
  label: "Files" | "Skills" | "MCP" | "Soul";
  items: ArtifactFamilyItem[];
};

type BuildArtifactFamiliesInput = {
  artifacts: VesloSessionArtifactItem[];
  workspaceRoot?: string;
};

type ResolveArtifactFamiliesInput = {
  serverArtifacts?: VesloSessionArtifactItem[] | null;
  legacyArtifacts?: ArtifactItem[] | null;
  workingFiles?: string[] | null;
  preferServerArtifacts?: boolean;
  workspaceRoot?: string;
};

const FAMILY_ORDER: ArtifactFamilyId[] = ["files", "skills", "mcp", "soul"];
const FAMILY_LABELS: Record<ArtifactFamilyId, ArtifactFamily["label"]> = {
  files: "Files",
  skills: "Skills",
  mcp: "MCP",
  soul: "Soul",
};

const FILE_STATUS_RANK: Record<string, number> = {
  exported: 4,
  created: 3,
  updated: 2,
  scanned: 1,
};

const SOUL_KIND_RANK: Record<string, number> = {
  soul_memory_used: 2,
  heartbeat_used: 1,
};

function normalizePath(value: string): string {
  return value.trim().replace(/[\\/]+/g, "/");
}

function basename(value: string): string {
  const normalized = normalizePath(value);
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("//") || /^[A-Za-z]:\//.test(path);
}

function normalizeComparablePath(value: string): string {
  return normalizePath(value).replace(/\/+$/, "");
}

function isPathWithinWorkspace(path: string, workspaceRoot: string): boolean {
  const candidate = normalizeComparablePath(path).toLowerCase();
  const root = normalizeComparablePath(workspaceRoot).toLowerCase();
  if (!candidate || !root) return false;
  if (candidate === root) return true;
  return candidate.startsWith(`${root}/`);
}

function isTechnicalArtifactPath(path: string | undefined, workspaceRoot?: string): boolean {
  const normalized = normalizePath(path ?? "");
  const normalizedLower = normalized.toLowerCase();
  if (!normalized) return false;

  const resolvedWorkspaceRoot = normalizeComparablePath(workspaceRoot ?? "");
  if (isAbsolutePath(normalized) && resolvedWorkspaceRoot && !isPathWithinWorkspace(normalized, resolvedWorkspaceRoot)) {
    return true;
  }

  const baseName = basename(normalized).toLowerCase();
  if (baseName === "agents.md" || baseName === "claude.md") return true;
  if (baseName === "opencode.json" || baseName === "opencode.jsonc") return true;
  if (normalizedLower === ".opencode" || normalizedLower.startsWith(".opencode/")) return true;
  if (normalizedLower.includes("/.opencode/")) return true;
  if (normalizedLower.startsWith("prompts/") || normalizedLower.includes("/prompts/")) return true;
  if (/^\.?[/\\]?[^/\\]*skills[/\\].+[/\\]skill\.md$/i.test(normalized)) return true;
  if (normalizedLower.includes("/.codex/skills/")) return true;
  if (normalizedLower.includes("/.claude/skills/")) return true;
  if (normalizedLower.includes("/.agents/skills/")) return true;
  return false;
}

function toFamilyItem(item: VesloSessionArtifactItem, workspaceRoot?: string): ArtifactFamilyItem | null {
  if (item.family === "files" && isTechnicalArtifactPath(item.path, workspaceRoot)) {
    return null;
  }
  return {
    id: item.id,
    family: item.family,
    kind: item.kind,
    status: item.status,
    title: item.title,
    subtitle: item.subtitle,
    path: item.path,
    sourceName: item.sourceName,
    timestamp: item.timestamp,
  };
}

function sortFamilyItems(family: ArtifactFamilyId, items: ArtifactFamilyItem[]): ArtifactFamilyItem[] {
  return items.slice().sort((left, right) => {
    if (family === "files") {
      const leftRank = FILE_STATUS_RANK[left.status] ?? 0;
      const rightRank = FILE_STATUS_RANK[right.status] ?? 0;
      if (leftRank !== rightRank) return rightRank - leftRank;
    }
    if (family === "soul") {
      const leftRank = SOUL_KIND_RANK[left.kind] ?? 0;
      const rightRank = SOUL_KIND_RANK[right.kind] ?? 0;
      if (leftRank !== rightRank) return rightRank - leftRank;
    }
    if (left.timestamp !== right.timestamp) return right.timestamp - left.timestamp;
    return left.title.localeCompare(right.title);
  });
}

export function buildArtifactFamilies(input: BuildArtifactFamiliesInput): ArtifactFamily[] {
  const grouped = new Map<ArtifactFamilyId, ArtifactFamilyItem[]>();

  for (const artifact of input.artifacts ?? []) {
    const item = toFamilyItem(artifact, input.workspaceRoot);
    if (!item) continue;
    const list = grouped.get(item.family) ?? [];
    list.push(item);
    grouped.set(item.family, list);
  }

  return FAMILY_ORDER
    .map((family) => {
      const items = grouped.get(family) ?? [];
      if (!items.length) return null;
      return {
        family,
        label: FAMILY_LABELS[family],
        items: sortFamilyItems(family, items),
      } satisfies ArtifactFamily;
    })
    .filter((family): family is ArtifactFamily => Boolean(family));
}

function legacyArtifactPath(item: ArtifactItem): string {
  return normalizePath(item.path ?? item.name ?? "");
}

function buildLegacyFallbackArtifacts(input: ResolveArtifactFamiliesInput): VesloSessionArtifactItem[] {
  const results: VesloSessionArtifactItem[] = [];
  const seen = new Set<string>();

  const pushPath = (rawPath: string, timestamp: number) => {
    const path = normalizePath(rawPath);
    if (!path || isTechnicalArtifactPath(path, input.workspaceRoot)) return;
    const key = path.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    results.push({
      id: `legacy:${key}`,
      sessionId: "",
      workspaceId: "",
      runId: "legacy",
      family: "files",
      kind: "file_discovered",
      status: "scanned",
      title: basename(path),
      subtitle: path,
      path,
      timestamp,
    });
  };

  const legacyArtifacts = input.legacyArtifacts ?? [];
  for (let index = 0; index < legacyArtifacts.length; index += 1) {
    pushPath(legacyArtifactPath(legacyArtifacts[index]), legacyArtifacts.length - index);
  }

  const workingFiles = input.workingFiles ?? [];
  for (let index = 0; index < workingFiles.length; index += 1) {
    pushPath(workingFiles[index] ?? "", workingFiles.length - index);
  }

  return results;
}

export function resolveArtifactFamilies(input: ResolveArtifactFamiliesInput): ArtifactFamily[] {
  const serverArtifacts = input.serverArtifacts ?? [];
  if (input.preferServerArtifacts === true && input.serverArtifacts) {
    return buildArtifactFamilies({ artifacts: serverArtifacts, workspaceRoot: input.workspaceRoot });
  }
  if (serverArtifacts.length > 0) {
    return buildArtifactFamilies({ artifacts: serverArtifacts, workspaceRoot: input.workspaceRoot });
  }
  return buildArtifactFamilies({
    artifacts: buildLegacyFallbackArtifacts(input),
    workspaceRoot: input.workspaceRoot,
  });
}
