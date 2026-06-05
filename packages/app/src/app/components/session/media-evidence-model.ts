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

function getBitmapExtension(path: string): string {
  const withoutQuery = path.split(/[?#]/, 1)[0] ?? path;
  const match = withoutQuery.toLowerCase().match(/\.[a-z0-9]+$/);
  return match?.[0] ?? "";
}

function getBitmapMime(path: string): string | null {
  return BITMAP_MIME_BY_EXTENSION[getBitmapExtension(path)] ?? null;
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

function toAbsoluteFileUrl(path: string): string {
  const prefix = isWindowsAbsolutePath(path) ? "file:///" : "file://";
  return encodeURI(`${prefix}${path}`);
}

function toFileUrl(path: string, workspaceRoot?: string): string | undefined {
  const normalizedPath = normalizePath(path);
  if (!normalizedPath) return undefined;

  if (isAbsolutePath(normalizedPath)) {
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
  return match?.[1] ?? null;
}

function inferStructuredMimeFromSource(src: string): string | null {
  return mimeFromDataUrl(src) ?? getBitmapMime(src);
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
  if (!isNonEmptyString(mime) || !isBitmapMime(mime)) return null;
  if (!isNonEmptyString(url) || url.startsWith("file://")) return null;

  return {
    id: buildEvidenceId(input.sourceId, part.id, `inline:${index}`),
    kind: input.defaultKind ?? "analyzed",
    title: isNonEmptyString((part as any).filename) ? (part as any).filename : "Image",
    mime,
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
    return { src: image, mime, title: "Image" };
  }

  if (!image || typeof image !== "object") return null;
  const record = image as Record<string, unknown>;
  const rawSrc = [record.url, record.src, record.data].find(isNonEmptyString);
  if (!rawSrc) return null;

  const mime = isNonEmptyString(record.mediaType) ? record.mediaType : inferStructuredMimeFromSource(rawSrc);
  if (!mime) return null;
  if (!isBitmapMime(mime)) return null;

  const src = rawSrc === record.data && !rawSrc.startsWith("data:") ? `data:${mime};base64,${rawSrc}` : rawSrc;
  const title = isNonEmptyString(record.alt) ? record.alt : "Image";
  return { src, mime, title };
}

function buildStructuredImageEvidence(part: Part, input: BuildMediaEvidenceInput): MediaEvidence[] {
  const images = getState(part).images;
  if (!Array.isArray(images)) return [];

  const evidence: MediaEvidence[] = [];
  images.forEach((image, index) => {
    const normalized = normalizeStructuredImage(image);
    if (!normalized) return;
    evidence.push({
      id: buildEvidenceId(input.sourceId, part.id, `structured:${index}`),
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

function getCreatedBitmapPath(part: Part): string | null {
  const input = getInput(part);
  for (const key of CREATED_PATH_INPUT_KEYS) {
    const value = input[key];
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

  const path = getCreatedBitmapPath(part);
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

    evidence.push(...buildStructuredImageEvidence(part, input));
    const createdEvidence = buildCreatedPathEvidence(part, input, partIndex);
    if (createdEvidence) evidence.push(createdEvidence);
  });

  return evidence;
}
