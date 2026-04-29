import { normalizeRelative as normalizePathLike, splitPathSegments as splitWorkspaceSegments } from "../utils/workspace-path";

function splitPathSegments(input: string): string[] {
  return splitWorkspaceSegments(String(input ?? ""));
}

function normalizeLeafName(input: string): string {
  const segments = splitPathSegments(input);
  const leaf = segments[segments.length - 1] ?? "";
  if (!leaf) {
    throw new Error("filename is required");
  }
  return leaf;
}

function assertWorkspaceSessionRelation(workspaceRoot: string, sessionDirectory: string): string[] {
  const rootSegments = splitPathSegments(workspaceRoot);
  const sessionSegments = splitPathSegments(sessionDirectory);

  if (!rootSegments.length) {
    throw new Error("workspaceRoot is required");
  }
  if (!sessionSegments.length) {
    throw new Error("sessionDirectory is required");
  }
  if (sessionSegments.length < rootSegments.length) {
    throw new Error(`Session directory ${sessionDirectory} is outside workspace root ${workspaceRoot}.`);
  }

  for (let index = 0; index < rootSegments.length; index += 1) {
    if (sessionSegments[index] !== rootSegments[index]) {
      throw new Error(`Session directory ${sessionDirectory} is outside workspace root ${workspaceRoot}.`);
    }
  }

  return sessionSegments.slice(rootSegments.length);
}

export function splitFilenameForCollision(filename: string): { stem: string; ext: string } {
  const leaf = normalizeLeafName(filename);
  const lastDot = leaf.lastIndexOf(".");

  if (lastDot <= 0 || lastDot === leaf.length - 1) {
    return { stem: leaf, ext: "" };
  }

  return {
    stem: leaf.slice(0, lastDot),
    ext: leaf.slice(lastDot),
  };
}

export function toWorkspaceRelativeFromSessionDir(input: {
  workspaceRoot: string;
  sessionDirectory: string;
  filename: string;
}): string {
  const sessionRelativeSegments = assertWorkspaceSessionRelation(input.workspaceRoot, input.sessionDirectory);
  const leaf = normalizeLeafName(input.filename);
  return [...sessionRelativeSegments, leaf].join("/");
}

export function pickCollisionSafeName(input: {
  directoryRel: string;
  filename: string;
  existingPaths: Set<string>;
}): string {
  const directoryRel = normalizePathLike(input.directoryRel);
  const { stem, ext } = splitFilenameForCollision(input.filename);
  const normalizedExisting = new Set(Array.from(input.existingPaths, (entry) => normalizePathLike(entry)));

  for (let index = 0; index < 10_000; index += 1) {
    const suffix = index === 0 ? "" : ` (${index})`;
    const name = `${stem}${suffix}${ext}`;
    const candidate = directoryRel ? `${directoryRel}/${name}` : name;
    if (!normalizedExisting.has(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Unable to find a collision-safe name for ${input.filename}.`);
}
