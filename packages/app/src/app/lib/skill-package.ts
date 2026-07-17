import type { SkillPackageFile, SkillPackageManifest } from "../types.js";

export type BuildSkillPackageManifestInput = {
  metadata: SkillPackageManifest["metadata"];
  files: SkillPackageFile[];
};

type SkillPackageArchiveFile = SkillPackageFile & {
  contentBase64: string;
};

export type SkillPackageArchive = Omit<SkillPackageManifest, "files"> & {
  files: SkillPackageArchiveFile[];
};

export type BuildSkillPackageArchiveInput = {
  metadata: SkillPackageManifest["metadata"];
  files: Array<{
    path: string;
    sizeBytes: number;
    mediaType: string;
    executable?: boolean;
    text?: string;
  }>;
};

const ENTRYPOINT = "SKILL.md";
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[a-zA-Z]:[\\/]/;
const WINDOWS_RESERVED_BASENAME_PATTERN = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

const comparePackagePaths = (left: SkillPackageFile, right: SkillPackageFile) => {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  return 0;
};

const requireTrimmedString = (value: string, field: string): string => {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Skill package ${field} is required`);
  }
  return normalized;
};

const optionalTrimmedString = (value: string | undefined): string | undefined => {
  const normalized = value?.trim();
  return normalized || undefined;
};

function normalizeSkillPackagePath(path: string): string {
  const trimmed = requireTrimmedString(path, "file path");
  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith("\\") ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("\\\\") ||
    WINDOWS_ABSOLUTE_PATH_PATTERN.test(trimmed)
  ) {
    throw new Error(`Skill package file path must be relative: ${path}`);
  }

  const segments = trimmed
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment && segment !== ".");

  if (segments.some((segment) => segment === "..")) {
    throw new Error(`Skill package file path cannot contain '..': ${path}`);
  }
  if (segments.length === 0) {
    throw new Error(`Skill package file path must name a file: ${path}`);
  }
  const colonSegment = segments.find((segment) => segment.includes(":"));
  if (colonSegment) {
    throw new Error(`Skill package file path cannot contain ':': ${path}`);
  }
  const reservedSegment = segments.find((segment) => WINDOWS_RESERVED_BASENAME_PATTERN.test(segment));
  if (reservedSegment) {
    throw new Error(`Skill package file path cannot use reserved Windows name '${reservedSegment}': ${path}`);
  }
  const trailingWindowsSpaceOrDotSegment = segments.find((segment) => /[ .]$/.test(segment));
  if (trailingWindowsSpaceOrDotSegment) {
    throw new Error(`Skill package file path segment cannot end with a space or '.': ${path}`);
  }

  return segments.join("/");
}

const normalizeFile = (file: SkillPackageFile): SkillPackageFile => {
  const path = normalizeSkillPackagePath(file.path);
  const sha256 = requireTrimmedString(file.sha256, `${path} sha256`).toLowerCase();
  if (!SHA256_PATTERN.test(sha256)) {
    throw new Error(`Skill package file sha256 must be a 64-character hex digest: ${path}`);
  }
  if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0) {
    throw new Error(`Skill package file sizeBytes must be a non-negative integer: ${path}`);
  }

  const normalized: SkillPackageFile = {
    path,
    sha256,
    sizeBytes: file.sizeBytes,
    mediaType: requireTrimmedString(file.mediaType, `${path} mediaType`),
  };
  if (file.executable !== undefined) normalized.executable = Boolean(file.executable);
  if (file.text !== undefined) normalized.text = file.text;
  return normalized;
};

export function normalizeSkillPackageFiles(files: SkillPackageFile[]): SkillPackageFile[] {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("Skill package files are required");
  }

  const seenPaths = new Set<string>();
  return files
    .map(normalizeFile)
    .map((file) => {
      if (seenPaths.has(file.path)) {
        throw new Error(`Skill package file paths must be unique after normalization; duplicate: ${file.path}`);
      }
      seenPaths.add(file.path);
      return file;
    })
    .sort(comparePackagePaths);
}

const requireEntrypoint = (files: SkillPackageFile[]) => {
  if (!files.some((file) => file.path === ENTRYPOINT)) {
    throw new Error(`Skill package requires ${ENTRYPOINT}`);
  }
};

const normalizeMetadata = (metadata: SkillPackageManifest["metadata"]): SkillPackageManifest["metadata"] => {
  const normalized: SkillPackageManifest["metadata"] = {
    name: requireTrimmedString(metadata.name, "metadata.name"),
  };
  const description = optionalTrimmedString(metadata.description);
  const trigger = optionalTrimmedString(metadata.trigger);
  const tags = metadata.tags?.map((tag) => tag.trim()).filter(Boolean);
  const language = optionalTrimmedString(metadata.language);

  if (description) normalized.description = description;
  if (trigger) normalized.trigger = trigger;
  if (tags?.length) normalized.tags = tags;
  if (language) normalized.language = language;
  return normalized;
};

const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(",")}}`;
};

const bytesToHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const sha256BytesHex = async (bytes: Uint8Array): Promise<string> => {
  const cryptoApi: Partial<Crypto> = globalThis.crypto;
  if (!cryptoApi.subtle) {
    throw new Error("Web Crypto SHA-256 support is required to build skill package manifests");
  }
  const digestInput = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await cryptoApi.subtle.digest("SHA-256", digestInput);
  return bytesToHex(new Uint8Array(digest));
};

const sha256Hex = async (value: string): Promise<string> => {
  return sha256BytesHex(new TextEncoder().encode(value));
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  const bufferCtor = (globalThis as unknown as {
    Buffer?: { from(input: Uint8Array): { toString(encoding: "base64"): string } };
  }).Buffer;
  if (bufferCtor) {
    return bufferCtor.from(bytes).toString("base64");
  }
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
};

async function computeSkillPackageSha256(
  manifest: Omit<SkillPackageManifest, "packageSha256">,
): Promise<string> {
  return sha256Hex(
    stableStringify({
      schemaVersion: manifest.schemaVersion,
      entrypoint: manifest.entrypoint,
      files: manifest.files,
      metadata: manifest.metadata,
    }),
  );
}

export async function validateSkillPackageManifest(manifest: SkillPackageManifest): Promise<SkillPackageManifest> {
  if (manifest.schemaVersion !== 1) {
    throw new Error("Skill package manifest schemaVersion must be 1");
  }
  if (manifest.entrypoint !== ENTRYPOINT) {
    throw new Error(`Skill package manifest entrypoint must be ${ENTRYPOINT}`);
  }
  const files = normalizeSkillPackageFiles(manifest.files);
  requireEntrypoint(files);
  const metadata = normalizeMetadata(manifest.metadata);
  const packageSha256 = requireTrimmedString(manifest.packageSha256, "packageSha256").toLowerCase();
  if (!SHA256_PATTERN.test(packageSha256)) {
    throw new Error("Skill package packageSha256 must be a 64-character hex digest");
  }

  const normalizedManifest = {
    schemaVersion: 1,
    entrypoint: ENTRYPOINT,
    files,
    metadata,
  } satisfies Omit<SkillPackageManifest, "packageSha256">;
  const expectedPackageSha256 = await computeSkillPackageSha256(normalizedManifest);
  if (packageSha256 !== expectedPackageSha256) {
    throw new Error("Skill package packageSha256 does not match canonical package content");
  }

  return { ...normalizedManifest, packageSha256 };
}

export async function buildSkillPackageManifest(
  input: BuildSkillPackageManifestInput,
): Promise<SkillPackageManifest> {
  const files = normalizeSkillPackageFiles(input.files);
  requireEntrypoint(files);
  const manifestWithoutHash = {
    schemaVersion: 1,
    entrypoint: ENTRYPOINT,
    files,
    metadata: normalizeMetadata(input.metadata),
  } satisfies Omit<SkillPackageManifest, "packageSha256">;

  return {
    ...manifestWithoutHash,
    packageSha256: await computeSkillPackageSha256(manifestWithoutHash),
  };
}

export async function buildSkillPackageArchive(input: BuildSkillPackageArchiveInput): Promise<SkillPackageArchive> {
  const encoder = new TextEncoder();
  const filesWithContent: SkillPackageArchiveFile[] = [];
  for (const file of input.files) {
    const path = normalizeSkillPackagePath(file.path);
    if (file.text === undefined) {
      throw new Error(`Skill package archive file text is required: ${path}`);
    }
    const bytes = encoder.encode(file.text);
    filesWithContent.push({
      path,
      sha256: await sha256BytesHex(bytes),
      sizeBytes: bytes.byteLength,
      mediaType: file.mediaType,
      ...(file.executable !== undefined ? { executable: file.executable } : {}),
      text: file.text,
      contentBase64: bytesToBase64(bytes),
    });
  }

  const manifest = await buildSkillPackageManifest({
    metadata: input.metadata,
    files: filesWithContent,
  });
  const contentByPath = new Map(filesWithContent.map((file) => [file.path, file.contentBase64]));

  return {
    ...manifest,
    files: manifest.files.map((file) => {
      const contentBase64 = contentByPath.get(file.path);
      if (contentBase64 === undefined) {
        throw new Error(`Skill package archive is missing content for file: ${file.path}`);
      }
      return {
        ...file,
        contentBase64,
      };
    }),
  };
}
