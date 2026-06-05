import type { Part } from "@opencode-ai/sdk/v2/client";
import { getBasename as basename, normalizePath } from "../../utils/workspace-path";

export type MediaEvidenceKind = "analyzed" | "created";
export type MediaEvidenceStatus = "available" | "missing" | "tooLarge" | "unsupported" | "redacted";

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
const CREATED_PATH_INPUT_KEYS = ["filePath", "path", "file", "outputPath"] as const;

function getState(part: Part): Record<string, unknown> {
  const state = (part as any).state;
  return state && typeof state === "object" ? (state as Record<string, unknown>) : {};
}

function getInput(part: Part): Record<string, unknown> {
  const input = getState(part).input;
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
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

function getBitmapExtension(value: string, options?: { treatUrlDelimiters?: boolean; decode?: boolean }): string {
  const withoutQuery = options?.treatUrlDelimiters ? (value.split(/[?#]/, 1)[0] ?? value) : value;
  const candidate = options?.decode ? safelyDecodeURIComponent(withoutQuery) : withoutQuery;
  const match = candidate.toLowerCase().match(/\.[a-z0-9]+$/);
  return match?.[0] ?? "";
}

function getBitmapMime(path: string, options?: { treatUrlDelimiters?: boolean; decode?: boolean }): string | null {
  return BITMAP_MIME_BY_EXTENSION[getBitmapExtension(path, options)] ?? null;
}

function hasExtension(value: string, extension: string, options?: { treatUrlDelimiters?: boolean; decode?: boolean }): boolean {
  return getBitmapExtension(value, options) === extension;
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
  return path.startsWith("/") || /^[A-Za-z]:\//.test(path);
}

function isWindowsAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:\//.test(path);
}

function normalizeComparablePath(path: string): string {
  return normalizePath(path).replace(/\/+$/, "").toLowerCase();
}

function isPathWithinRoot(path: string, root: string): boolean {
  const normalizedPath = normalizeComparablePath(path);
  const normalizedRoot = normalizeComparablePath(root);
  if (!normalizedPath || !normalizedRoot) return false;
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

  if (isAbsolutePath(normalizedPath)) {
    if (!isNonEmptyString(workspaceRoot)) return undefined;
    return toAbsoluteFileUrl(normalizedPath);
  }

  const normalizedRoot = normalizePath(workspaceRoot ?? "");
  if (!normalizedRoot) return undefined;
  return toAbsoluteFileUrl(`${normalizedRoot.replace(/\/+$/, "")}/${normalizedPath.replace(/^\/+/, "")}`);
}

function titleForPath(path: string): string {
  return basename(normalizePath(path)) || "Image";
}

function buildEvidenceId(sourceId: string, partId: string, sourceKey: string): string {
  return `${sourceId}:${partId}:${sourceKey}`;
}

function mimeFromDataUrl(value: string): string | null {
  const match = value.match(/^data:([^,;]+)[,;]/);
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
  if (/^data:/i.test(src)) return false;
  return hasExtension(src, ".svg", { treatUrlDelimiters: true, decode: true });
}

function hasSvgMetadataName(record: Record<string, unknown>): boolean {
  const filename = record.filename;
  const name = record.name;
  return (
    (isNonEmptyString(filename) && hasExtension(filename, ".svg", { decode: true })) ||
    (isNonEmptyString(name) && hasExtension(name, ".svg", { decode: true }))
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
  if (isNonEmptyString((part as any).filename) && hasExtension((part as any).filename, ".svg")) return null;

  return {
    id: buildEvidenceId(input.sourceId, part.id, `inline:${index}`),
    kind: input.defaultKind ?? "analyzed",
    title: isNonEmptyString((part as any).filename) ? (part as any).filename : "Image",
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

  const src = rawSrc === record.data && !rawSrc.startsWith("data:") ? `data:${mime};base64,${rawSrc}` : rawSrc;
  if (!hasAllowedImageSourceScheme(src)) return null;
  if (hasSvgSourceExtension(src)) return null;
  const title = isNonEmptyString(record.alt) ? record.alt : "Image";
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
      kind: input.defaultKind ?? "analyzed",
      title: normalized.title,
      mime: normalized.mime,
      src: normalized.src,
      sourcePartId: part.id,
      status: "available",
    });
  });
  return evidence;
}

function getCreatedBitmapPath(part: Part, workspaceRoot?: string): string | null {
  const input = getInput(part);
  for (const key of CREATED_PATH_INPUT_KEYS) {
    const value = input[key];
    if (isNonEmptyString(value) && hasParentPathSegment(normalizePath(value))) {
      continue;
    }
    if (
      isNonEmptyString(value) &&
      isAbsolutePath(normalizePath(value)) &&
      isNonEmptyString(workspaceRoot) &&
      !isPathWithinRoot(normalizePath(value), workspaceRoot)
    ) {
      continue;
    }
    if (isNonEmptyString(value) && getBitmapMime(value)) return value;
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
    path,
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
