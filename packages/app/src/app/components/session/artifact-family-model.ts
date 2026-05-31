import type { VesloSessionArtifactItem } from "../../lib/veslo-server";
import type { ArtifactItem } from "../../types";
import {
  getBasename as basename,
  normalizePath,
  normalizeForComparison as normalizeComparablePath,
} from "../../utils/workspace-path";

export type ArtifactFamilyId = "files" | "skills" | "mcp" | "soul";

export type ArtifactFileInteraction = "modified" | "opened";

export type ArtifactFamilyItem = {
  id: string;
  family: ArtifactFamilyId;
  kind: string;
  status: string;
  title: string;
  subtitle?: string;
  path?: string;
  sourceName?: string;
  fileInteraction?: ArtifactFileInteraction;
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

const FILE_INTERACTION_RANK: Record<ArtifactFileInteraction, number> = {
  modified: 2,
  opened: 1,
};

const SOUL_KIND_RANK: Record<string, number> = {
  soul_memory_used: 2,
  heartbeat_used: 1,
};

const GENERATED_OR_INTERNAL_PATH_SEGMENTS = new Set([
  ".cache",
  ".git",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  "coverage",
  "node_modules",
]);
const ROOT_GENERATED_PATH_SEGMENTS = new Set(["build", "cache", "coverage", "dist", "out", "target", "temp", "tmp"]);

function isGeneratedOrInternalPathSegment(segment: string, index: number, segments: string[]): boolean {
  if (GENERATED_OR_INTERNAL_PATH_SEGMENTS.has(segment)) return true;
  if (!ROOT_GENERATED_PATH_SEGMENTS.has(segment)) return false;
  if (index === 0) return true;
  return !segments.slice(0, index).includes("src");
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("//") || /^[A-Za-z]:\//.test(path);
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
  const segments = normalizedLower.split("/").filter(Boolean);
  if (baseName === "agents.md" || baseName === "claude.md") return true;
  if (baseName === "opencode.json" || baseName === "opencode.jsonc") return true;
  if (baseName === ".ds_store" || baseName.endsWith(".tsbuildinfo")) return true;
  if (segments.some((segment, index) => isGeneratedOrInternalPathSegment(segment, index, segments))) return true;
  if (normalizedLower === ".opencode" || normalizedLower.startsWith(".opencode/")) return true;
  if (normalizedLower.includes("/.opencode/")) return true;
  if (normalizedLower.startsWith("prompts/") || normalizedLower.includes("/prompts/")) return true;
  if (/^\.?[/\\]?[^/\\]*skills[/\\].+[/\\]skill\.md$/i.test(normalized)) return true;
  if (normalizedLower.includes("/.codex/skills/")) return true;
  if (normalizedLower.includes("/.claude/skills/")) return true;
  if (normalizedLower.includes("/.agents/skills/")) return true;
  return false;
}

export function isUserRelevantArtifactPath(path: string | undefined, workspaceRoot?: string): boolean {
  const normalized = normalizePath(path ?? "");
  return Boolean(normalized) && !isTechnicalArtifactPath(normalized, workspaceRoot);
}

function extractSkillNameFromPath(path: string): string | null {
  const normalized = normalizePath(path);
  const segments = normalized.split("/").filter(Boolean);
  const last = segments[segments.length - 1]?.toLowerCase();
  if (last !== "skill.md") return null;
  return segments[segments.length - 2] ?? null;
}

function normalizeSkillName(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  const withoutPrefix = value.replace(/^load skill\s+/i, "").trim();
  const pathSkillName = extractSkillNameFromPath(withoutPrefix);
  const candidate = pathSkillName ?? withoutPrefix;
  const normalized = normalizePath(candidate).replace(/^@[^/]+\//, "");
  const segments = normalized.split("/").filter(Boolean);
  const leaf = segments[segments.length - 1] ?? normalized;
  const cleaned = leaf.replace(/[-_]+/g, " ").replace(/\.md$/i, "").trim();
  if (!cleaned || cleaned.toLowerCase() === "skill") return null;
  return cleaned
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function fileInteractionForKind(kind: string): ArtifactFileInteraction | undefined {
  if (kind === "file_output") return "modified";
  if (kind === "file_discovered") return "opened";
  return undefined;
}

function toFamilyItem(item: VesloSessionArtifactItem, workspaceRoot?: string): ArtifactFamilyItem | null {
  if (item.family === "files" && isTechnicalArtifactPath(item.path, workspaceRoot)) {
    return null;
  }
  if (item.family === "files") {
    return {
      id: item.id,
      family: item.family,
      kind: item.kind,
      status: item.status,
      title: item.title,
      subtitle: item.subtitle,
      path: item.path,
      sourceName: item.sourceName,
      fileInteraction: fileInteractionForKind(item.kind),
      timestamp: item.timestamp,
    };
  }
  if (item.family === "skills") {
    const title =
      normalizeSkillName(item.sourceName) ??
      normalizeSkillName(item.title) ??
      normalizeSkillName(item.path) ??
      "Skill";
    return {
      id: item.id,
      family: item.family,
      kind: item.kind,
      status: item.status,
      title,
      subtitle: item.subtitle,
      sourceName: normalizeSkillName(item.sourceName) ?? title,
      timestamp: item.timestamp,
    };
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

function fileInteractionRank(item: ArtifactFamilyItem): number {
  return item.fileInteraction ? FILE_INTERACTION_RANK[item.fileInteraction] : 0;
}

function fileFamilyDedupeKey(item: ArtifactFamilyItem): string {
  const path = normalizeComparablePath(item.path ?? "").toLowerCase();
  if (path) return path;
  return normalizeComparablePath(item.title).toLowerCase();
}

function shouldReplaceFileFamilyItem(current: ArtifactFamilyItem, candidate: ArtifactFamilyItem): boolean {
  const currentRank = fileInteractionRank(current);
  const candidateRank = fileInteractionRank(candidate);
  if (currentRank !== candidateRank) return candidateRank > currentRank;
  return candidate.timestamp >= current.timestamp;
}

function dedupeFileFamilyItems(items: ArtifactFamilyItem[]): ArtifactFamilyItem[] {
  const byFile = new Map<string, ArtifactFamilyItem>();

  for (const item of items) {
    const key = fileFamilyDedupeKey(item);
    const current = byFile.get(key);
    if (!current || shouldReplaceFileFamilyItem(current, item)) {
      byFile.set(key, item);
    }
  }

  return Array.from(byFile.values());
}

function sortFamilyItems(family: ArtifactFamilyId, items: ArtifactFamilyItem[]): ArtifactFamilyItem[] {
  return items.slice().sort((left, right) => {
    if (family === "files") {
      const leftInteractionRank = fileInteractionRank(left);
      const rightInteractionRank = fileInteractionRank(right);
      if (leftInteractionRank !== rightInteractionRank) return rightInteractionRank - leftInteractionRank;

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
      const familyItems = family === "files" ? dedupeFileFamilyItems(items) : items;
      return {
        family,
        label: FAMILY_LABELS[family],
        items: sortFamilyItems(family, familyItems),
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
