import { createHash } from "node:crypto";

export type SkillPackageFile = {
  path: string;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
  executable?: boolean;
  text?: string;
};

export type SkillPackageManifest = {
  schemaVersion: 1;
  entrypoint: "SKILL.md";
  files: SkillPackageFile[];
  packageSha256: string;
  metadata: {
    name: string;
    description?: string;
    trigger?: string;
    tags?: string[];
    language?: string;
  };
};

export type BuildSkillPackageManifestInput = {
  metadata: SkillPackageManifest["metadata"];
  files: SkillPackageFile[];
};

const ENTRYPOINT = "SKILL.md";
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[a-zA-Z]:[\\/]/;

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

export function normalizeSkillPackagePath(path: string): string {
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

export function computeSkillPackageSha256(manifest: Omit<SkillPackageManifest, "packageSha256">): string {
  const canonicalPayload = stableStringify({
    schemaVersion: manifest.schemaVersion,
    entrypoint: manifest.entrypoint,
    files: manifest.files,
    metadata: manifest.metadata,
  });
  return createHash("sha256").update(canonicalPayload).digest("hex");
}

export function validateSkillPackageManifest(manifest: SkillPackageManifest): SkillPackageManifest {
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
  const expectedPackageSha256 = computeSkillPackageSha256(normalizedManifest);
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
    packageSha256: computeSkillPackageSha256(manifestWithoutHash),
  };
}
