import type { Part } from "@opencode-ai/sdk/v2/client";
import { getBasename as basename, normalizePath, workspaceArtifactPathToRelative } from "../../utils/workspace-path";

type MediaEvidenceKind = "analyzed" | "created";
type MediaEvidenceStatus = "available" | "missing" | "tooLarge" | "unsupported" | "redacted";

export type MediaEvidence = {
  id: string;
  kind: MediaEvidenceKind;
  title: string;
  mime: string;
  src?: string;
  path?: string;
  sourcePartId: string;
  status: MediaEvidenceStatus;
};

export type BuildMediaEvidenceInput = {
  parts: Part[];
  sourceId: string;
  workspaceRoot?: string;
  defaultKind?: MediaEvidenceKind;
};

const BITMAP_MIME_BY_EXTENSION: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

const BITMAP_MIME_TYPES = new Set(Object.values(BITMAP_MIME_BY_EXTENSION));

const WRITE_LIKE_TOOLS = new Set([
  "write",
  "edit",
  "apply_patch",
  "bash",
  "shell",
  "exec",
  "command",
  "run",
  "imagegen",
  "screenshot",
]);

const DISCOVERY_ONLY_TOOLS = new Set(["read", "grep", "glob", "search", "list", "list_files"]);
const FILE_MUTATING_TOOLS = new Set(["write", "edit", "apply_patch"]);
const OUTPUT_ORIENTED_TOOLS = new Set(["imagegen", "screenshot"]);
const SHELL_LIKE_TOOLS = new Set(["bash", "shell", "exec", "command", "run"]);
const CREATED_PATH_INPUT_KEYS = ["filePath", "path", "file", "outputPath"] as const;
const CREATED_OUTPUT_PATH_INPUT_KEYS = ["outputPath"] as const;

function getState(part: Part): Record<string, unknown> {
  const state = (part as any).state;
  return state && typeof state === "object" ? (state as Record<string, unknown>) : {};
}

function getInput(part: Part): Record<string, unknown> {
  const input = getState(part).input;
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function getObjectField(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function getToolName(part: Part): string {
  return typeof (part as any).tool === "string" ? String((part as any).tool).toLowerCase() : "";
}

function safelyDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function decodeCommonPercentTokens(value: string): string {
  return value
    .replace(/%25/gi, "%")
    .replace(/%2e/gi, ".")
    .replace(/%2f/gi, "/")
    .replace(/%5c/gi, "\\")
    .replace(/%23/gi, "#")
    .replace(/%26/gi, "&")
    .replace(/%3d/gi, "=")
    .replace(/%3f/gi, "?")
    .replace(/%3b/gi, ";")
    .replace(/%[0-9a-f]{2}/gi, (token) => {
      const charCode = Number.parseInt(token.slice(1), 16);
      return charCode >= 0x20 && charCode <= 0x7e ? String.fromCharCode(charCode) : token;
    });
}

function safelyDecodeURIComponentDeep(value: string): string {
  let current = value;
  for (let index = 0; index < 3; index += 1) {
    const next = decodeCommonPercentTokens(safelyDecodeURIComponent(current));
    if (next === current) return current;
    current = next;
  }
  return current;
}

function getBitmapExtension(value: string, options?: { treatUrlDelimiters?: boolean; decode?: boolean }): string {
  const decoded = options?.decode ? safelyDecodeURIComponentDeep(value) : value;
  const candidate = options?.treatUrlDelimiters ? (decoded.split(/[?#;]/, 1)[0] ?? decoded) : decoded;
  const match = candidate.toLowerCase().match(/\.[a-z0-9]+$/);
  return match?.[0] ?? "";
}

function getBitmapMime(path: string, options?: { treatUrlDelimiters?: boolean; decode?: boolean }): string | null {
  return BITMAP_MIME_BY_EXTENSION[getBitmapExtension(path, options)] ?? null;
}

function hasSvgFamilyExtension(value: string, options?: { decode?: boolean }): boolean {
  if (/^data:/i.test(value)) return false;
  const candidate = options?.decode ? safelyDecodeURIComponentDeep(value) : value;
  return candidate
    .split(/[?#&=;]/)
    .map((part) => part.split(/[\\/]/).pop() ?? "")
    .some((segment) => /\.(?:svg|svgz)(?:$|[^a-z0-9])/i.test(segment));
}

function normalizeMime(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function isBitmapMime(value: string): boolean {
  return BITMAP_MIME_TYPES.has(normalizeMime(value));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || isWindowsAbsolutePath(path);
}

function isWindowsAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path);
}

function isUrlLikePath(path: string): boolean {
  const trimmed = path.trim();
  if (isWindowsAbsolutePath(trimmed)) return false;
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed);
}

function normalizeComparablePath(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") return "/";
  return normalized.replace(/\/+$/, "");
}

function isPathWithinRoot(path: string, root: string): boolean {
  let normalizedPath = normalizeComparablePath(path);
  let normalizedRoot = normalizeComparablePath(root);
  if (!normalizedPath || !normalizedRoot) return false;
  if (normalizedRoot === "/") return normalizedPath.startsWith("/");
  if (isWindowsAbsolutePath(normalizedPath) || isWindowsAbsolutePath(normalizedRoot)) {
    normalizedPath = normalizedPath.toLowerCase();
    normalizedRoot = normalizedRoot.toLowerCase();
  }
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function hasParentPathSegment(path: string): boolean {
  return path.split("/").some((segment) => segment === "..");
}

function encodeFilePath(path: string): string {
  return path
    .split("/")
    .map((segment, index) => (index === 0 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join("/");
}

function toAbsoluteFileUrl(path: string): string {
  const prefix = isWindowsAbsolutePath(path) ? "file:///" : "file://";
  return `${prefix}${encodeFilePath(path)}`;
}

function toFileUrl(path: string, workspaceRoot?: string): string | undefined {
  const normalizedPath = normalizePath(path);
  if (!normalizedPath) return undefined;
  const normalizedRoot = normalizePath(workspaceRoot ?? "");
  if (normalizedRoot && hasParentPathSegment(normalizedRoot)) return undefined;
  const artifactRelative = workspaceArtifactPathToRelative(normalizedPath, normalizedRoot);
  const pathForUrl = artifactRelative ?? normalizedPath;

  if (isAbsolutePath(pathForUrl)) {
    if (!isNonEmptyString(workspaceRoot)) return undefined;
    return toAbsoluteFileUrl(pathForUrl);
  }

  if (!normalizedRoot) return undefined;
  if (!isAbsolutePath(normalizedRoot)) return undefined;
  return toAbsoluteFileUrl(`${normalizedRoot.replace(/\/+$/, "")}/${pathForUrl.replace(/^\/+/, "")}`);
}

function titleForPath(path: string): string {
  return basename(normalizePath(path)) || "Image";
}

function buildEvidenceId(sourceId: string, partId: string, sourceKey: string): string {
  return `${sourceId}:${partId}:${sourceKey}`;
}

function mimeFromDataUrl(value: string): string | null {
  const match = value.match(/^data:([^,;]+)[,;]/i);
  return match ? normalizeMime(match[1] ?? "") : null;
}

function hasAllowedImageSourceScheme(src: string): boolean {
  if (/^data:/i.test(src)) {
    const mime = mimeFromDataUrl(src);
    return Boolean(mime && isBitmapMime(mime));
  }
  return /^(?:https?:\/\/|blob:)/i.test(src);
}

function inferStructuredMimeFromSource(src: string): string | null {
  return mimeFromDataUrl(src) ?? getBitmapMime(src, { treatUrlDelimiters: true, decode: true });
}

function hasSvgSourceExtension(src: string): boolean {
  return hasSvgFamilyExtension(src, { decode: true });
}

function hasSvgMetadataName(record: Record<string, unknown>): boolean {
  const filename = record.filename;
  const name = record.name;
  return (
    (isNonEmptyString(filename) && hasSvgFamilyExtension(filename, { decode: true })) ||
    (isNonEmptyString(name) && hasSvgFamilyExtension(name, { decode: true }))
  );
}

function isCompletedOrStatusOmittedForHistoricalParts(part: Part): boolean {
  const statusValue = getState(part).status;
  if (!isNonEmptyString(statusValue)) return true;
  const status = statusValue.trim().toLowerCase();
  return status === "completed" || status === "done" || status === "success" || status === "succeeded";
}

function buildInlineFileEvidence(
  part: Part,
  input: BuildMediaEvidenceInput,
  index: number,
): MediaEvidence | null {
  const mime = (part as any).mime;
  const url = (part as any).url;
  const normalizedMime = isNonEmptyString(mime) ? normalizeMime(mime) : "";
  if (!normalizedMime || !isBitmapMime(normalizedMime)) return null;
  if (!isNonEmptyString(url) || !hasAllowedImageSourceScheme(url)) return null;
  if (hasSvgSourceExtension(url)) return null;
  if (isNonEmptyString((part as any).filename) && hasSvgFamilyExtension((part as any).filename, { decode: true })) return null;
  if (isNonEmptyString((part as any).name) && hasSvgFamilyExtension((part as any).name, { decode: true })) return null;

  return {
    id: buildEvidenceId(input.sourceId, part.id, `inline:${index}`),
    kind: "analyzed",
    title: isNonEmptyString((part as any).filename)
      ? (part as any).filename
      : isNonEmptyString((part as any).name)
        ? (part as any).name
        : "Image",
    mime: normalizedMime,
    src: url,
    sourcePartId: part.id,
    status: "available",
  };
}

function normalizeStructuredImage(image: unknown): { src: string; mime: string; title: string } | null {
  if (isNonEmptyString(image)) {
    const mime = inferStructuredMimeFromSource(image);
    if (!mime) return null;
    if (!isBitmapMime(mime)) return null;
    if (!hasAllowedImageSourceScheme(image)) return null;
    if (hasSvgSourceExtension(image)) return null;
    return { src: image, mime, title: "Image" };
  }

  if (!image || typeof image !== "object") return null;
  const record = image as Record<string, unknown>;
  const rawSrc = [record.url, record.src, record.data].find(isNonEmptyString);
  if (!rawSrc) return null;
  if (hasSvgMetadataName(record)) return null;

  const rawMime = isNonEmptyString(record.mediaType) ? record.mediaType : inferStructuredMimeFromSource(rawSrc);
  const mime = rawMime ? normalizeMime(rawMime) : "";
  if (!mime) return null;
  if (!isBitmapMime(mime)) return null;

  const src = rawSrc === record.data && !/^data:/i.test(rawSrc) ? `data:${mime};base64,${rawSrc}` : rawSrc;
  if (!hasAllowedImageSourceScheme(src)) return null;
  if (hasSvgSourceExtension(src)) return null;
  const title = isNonEmptyString(record.alt)
    ? record.alt
    : isNonEmptyString(record.filename)
      ? record.filename
      : isNonEmptyString(record.name)
        ? record.name
        : "Image";
  return { src, mime, title };
}

function buildStructuredImageEvidence(part: Part, input: BuildMediaEvidenceInput, partIndex: number): MediaEvidence[] {
  if (!isCompletedOrStatusOmittedForHistoricalParts(part)) return [];

  const images = getState(part).images;
  if (!Array.isArray(images)) return [];

  const evidence: MediaEvidence[] = [];
  images.forEach((image, index) => {
    const normalized = normalizeStructuredImage(image);
    if (!normalized) return;
    evidence.push({
      id: buildEvidenceId(input.sourceId, part.id, `structured:${partIndex}:${index}`),
      kind: "analyzed",
      title: normalized.title,
      mime: normalized.mime,
      src: normalized.src,
      sourcePartId: part.id,
      status: "available",
    });
  });
  return evidence;
}

function createdPathKeysForTool(toolName: string): readonly string[] {
  if (SHELL_LIKE_TOOLS.has(toolName)) return CREATED_OUTPUT_PATH_INPUT_KEYS;
  if (FILE_MUTATING_TOOLS.has(toolName) || OUTPUT_ORIENTED_TOOLS.has(toolName)) return CREATED_PATH_INPUT_KEYS;
  return [];
}

function createdPathSourcesForPart(part: Part): Record<string, unknown>[] {
  const state = getState(part);
  return [getInput(part), getObjectField(state, "output"), getObjectField(state, "result")];
}

function getCreatedBitmapPath(part: Part, workspaceRoot?: string): string | null {
  for (const source of createdPathSourcesForPart(part)) {
    for (const key of createdPathKeysForTool(getToolName(part))) {
      const value = source[key];
      if (isNonEmptyString(value) && isUrlLikePath(value)) {
        continue;
      }
      const normalizedValue = isNonEmptyString(value) ? normalizePath(value) : "";
      const artifactRelative = workspaceArtifactPathToRelative(normalizedValue, workspaceRoot);
      const candidatePath = artifactRelative ?? normalizedValue;
      if (isNonEmptyString(value) && hasParentPathSegment(candidatePath)) {
        continue;
      }
      if (
        isNonEmptyString(value) &&
        isAbsolutePath(candidatePath) &&
        isNonEmptyString(workspaceRoot) &&
        !isPathWithinRoot(candidatePath, workspaceRoot)
      ) {
        continue;
      }
      if (isNonEmptyString(value) && hasSvgFamilyExtension(value, { decode: true })) {
        continue;
      }
      if (isNonEmptyString(value) && getBitmapMime(candidatePath)) return candidatePath;
    }
  }
  return null;
}

function buildCreatedPathEvidence(
  part: Part,
  input: BuildMediaEvidenceInput,
  index: number,
): MediaEvidence | null {
  const toolName = getToolName(part);
  if (DISCOVERY_ONLY_TOOLS.has(toolName) || !WRITE_LIKE_TOOLS.has(toolName)) return null;
  if (!isCompletedOrStatusOmittedForHistoricalParts(part)) return null;

  const path = getCreatedBitmapPath(part, input.workspaceRoot);
  if (!path) return null;

  const src = toFileUrl(path, input.workspaceRoot);
  return {
    id: buildEvidenceId(input.sourceId, part.id, `created:${index}`),
    kind: "created",
    title: titleForPath(path),
    mime: getBitmapMime(path) ?? "image/png",
    path: src ? path : undefined,
    src,
    sourcePartId: part.id,
    status: src ? "available" : "missing",
  };
}

export function buildMediaEvidenceForParts(input: BuildMediaEvidenceInput): MediaEvidence[] {
  const evidence: MediaEvidence[] = [];

  input.parts.forEach((part, partIndex) => {
    if (part.type === "file") {
      const inlineEvidence = buildInlineFileEvidence(part, input, partIndex);
      if (inlineEvidence) evidence.push(inlineEvidence);
      return;
    }

    if (part.type !== "tool") return;

    evidence.push(...buildStructuredImageEvidence(part, input, partIndex));
    const createdEvidence = buildCreatedPathEvidence(part, input, partIndex);
    if (createdEvidence) evidence.push(createdEvidence);
  });

  return evidence;
}
