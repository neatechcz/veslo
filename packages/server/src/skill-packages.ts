import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";

import { parseFrontmatter } from "./frontmatter.js";
import {
  buildSkillPackageManifest,
  normalizeSkillPackagePath,
  validateSkillPackageManifest,
} from "./skill-package-model.js";
import type { SkillPackageFile, SkillPackageManifest } from "./skill-package-model.js";
import { extractTriggerFromBody, SKILL_ENTRYPOINT } from "./skills.js";

export const MAX_SKILL_PACKAGE_FILE_COUNT = 256;
export const MAX_SKILL_PACKAGE_FILE_SIZE_BYTES = 10 * 1024 * 1024;
export const MAX_SKILL_PACKAGE_TOTAL_SIZE_BYTES = 25 * 1024 * 1024;

export type SkillPackageArchiveFile = SkillPackageFile & {
  contentBase64: string;
};

export type SkillPackageArchive = Omit<SkillPackageManifest, "files"> & {
  files: SkillPackageArchiveFile[];
};

export type UnpackSkillPackageInput = {
  archive: SkillPackageArchive;
  targetDir: string;
};

type PendingPackageFile = SkillPackageFile & {
  contentBase64: string;
};

type ValidatedArchiveFile = SkillPackageArchiveFile & {
  bytes: Buffer;
};

type SkillPackageFileSystem = {
  mkdir: (path: string, options?: { recursive?: boolean }) => Promise<unknown>;
  writeFile: (path: string, data: Buffer) => Promise<void>;
  chmod: (path: string, mode: number) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  rm: (path: string, options?: { recursive?: boolean; force?: boolean }) => Promise<void>;
};

const IGNORED_SYSTEM_FILE_NAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const DEFAULT_FILE_SYSTEM: SkillPackageFileSystem = {
  mkdir: async (path, options) => {
    await mkdir(path, options);
  },
  writeFile: async (path, data) => {
    await writeFile(path, data);
  },
  chmod: async (path, mode) => {
    await chmod(path, mode);
  },
  rename: async (from, to) => {
    await rename(from, to);
  },
  rm: async (path, options) => {
    await rm(path, options);
  },
};

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

const comparePaths = (left: string, right: string) => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const optionalTrimmedString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

const optionalStringList = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const entries = value.map((entry) => optionalTrimmedString(entry)).filter((entry): entry is string => Boolean(entry));
  return entries.length ? entries : undefined;
};

const mediaTypeForPath = (path: string): string => {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".sh")) return "text/x-shellscript";
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "text/javascript";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "text/typescript";
  if (lower.endsWith(".css")) return "text/css";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "application/yaml";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
};

const shouldEmbedText = (mediaType: string): boolean =>
  mediaType.startsWith("text/") ||
  mediaType === "application/json" ||
  mediaType === "application/yaml" ||
  mediaType === "image/svg+xml";

const decodeUtf8 = (bytes: Buffer): string | undefined => {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    return undefined;
  }
};

const enforcePackageLimits = (files: Pick<SkillPackageFile, "path" | "sizeBytes">[]) => {
  if (files.length > MAX_SKILL_PACKAGE_FILE_COUNT) {
    throw new Error(`Skill package has too many files: ${files.length} > ${MAX_SKILL_PACKAGE_FILE_COUNT}`);
  }

  let totalSizeBytes = 0;
  for (const file of files) {
    if (file.sizeBytes > MAX_SKILL_PACKAGE_FILE_SIZE_BYTES) {
      throw new Error(
        `Skill package file is too large: ${file.path} (${file.sizeBytes} > ${MAX_SKILL_PACKAGE_FILE_SIZE_BYTES})`,
      );
    }
    totalSizeBytes += file.sizeBytes;
    if (totalSizeBytes > MAX_SKILL_PACKAGE_TOTAL_SIZE_BYTES) {
      throw new Error(
        `Skill package is too large: ${totalSizeBytes} > ${MAX_SKILL_PACKAGE_TOTAL_SIZE_BYTES}`,
      );
    }
  }
};

const maxBase64LengthForDecodedSize = (sizeBytes: number): number => {
  if (sizeBytes === 0) return 0;
  return Math.ceil(sizeBytes / 3) * 4;
};

const normalizeExactPackagePath = (path: string): string => {
  const normalized = normalizeSkillPackagePath(path);
  if (normalized !== path) {
    throw new Error(`Skill package contains invalid package path: ${path}`);
  }
  return normalized;
};

const packagePathForFile = (skillRoot: string, filePath: string): string => {
  const rawRelativePath = relative(skillRoot, filePath);
  if (!rawRelativePath || rawRelativePath.startsWith("..") || rawRelativePath.includes(`..${sep}`)) {
    throw new Error(`Skill package contains invalid package path: ${rawRelativePath || filePath}`);
  }
  if (sep !== "\\" && rawRelativePath.includes("\\")) {
    throw new Error(`Skill package contains invalid package path: ${rawRelativePath}`);
  }

  return normalizeExactPackagePath(rawRelativePath.split(sep).join("/"));
};

const resolvePackageChild = (baseDir: string, packagePath: string): string => {
  const normalized = normalizeExactPackagePath(packagePath);
  const childPath = resolve(baseDir, ...normalized.split("/"));
  const normalizedBase = baseDir.endsWith(sep) ? baseDir : `${baseDir}${sep}`;
  if (childPath !== baseDir && !childPath.startsWith(normalizedBase)) {
    throw new Error(`Skill package contains invalid package path: ${packagePath}`);
  }
  return childPath;
};

const collectPackageFilePaths = async (
  skillRoot: string,
  currentDir: string,
  files: string[] = [],
): Promise<string[]> => {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const sortedEntries = entries.sort((left, right) => comparePaths(left.name, right.name));

  for (const entry of sortedEntries) {
    if (IGNORED_SYSTEM_FILE_NAMES.has(entry.name)) continue;

    const entryPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await collectPackageFilePaths(skillRoot, entryPath, files);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Skill package can only include regular files: ${packagePathForFile(skillRoot, entryPath)}`);
    }
    files.push(entryPath);
    if (files.length > MAX_SKILL_PACKAGE_FILE_COUNT) {
      throw new Error(`Skill package has too many files: ${files.length} > ${MAX_SKILL_PACKAGE_FILE_COUNT}`);
    }
  }

  return files;
};

const metadataFromSkillMarkdown = (
  skillDir: string,
  skillMarkdown: string | undefined,
): SkillPackageManifest["metadata"] => {
  const fallbackName = basename(resolve(skillDir)) || "skill";
  if (!skillMarkdown) return { name: fallbackName };

  try {
    const { data, body } = parseFrontmatter(skillMarkdown);
    const name = optionalTrimmedString(data.name) ?? fallbackName;
    const description = optionalTrimmedString(data.description);
    const trigger =
      optionalTrimmedString(data.trigger) ??
      optionalTrimmedString(data.when) ??
      optionalTrimmedString(extractTriggerFromBody(body));
    const tags = optionalStringList(data.tags);
    const language = optionalTrimmedString(data.language);
    return {
      name,
      ...(description ? { description } : {}),
      ...(trigger ? { trigger } : {}),
      ...(tags ? { tags } : {}),
      ...(language ? { language } : {}),
    };
  } catch {
    return { name: fallbackName };
  }
};

const validateArchiveFiles = (archive: SkillPackageArchive): Omit<SkillPackageManifest, "files"> & {
  files: ValidatedArchiveFile[];
} => {
  for (const file of archive.files) {
    normalizeExactPackagePath(file.path);
  }

  const manifest = validateSkillPackageManifest(archive);
  enforcePackageLimits(manifest.files);

  const archiveFilesByPath = new Map<string, SkillPackageArchiveFile>();
  for (const file of archive.files) {
    const normalizedPath = normalizeExactPackagePath(file.path);
    archiveFilesByPath.set(normalizedPath, file);
  }

  const files = manifest.files.map((file): ValidatedArchiveFile => {
    const archiveFile = archiveFilesByPath.get(file.path);
    if (!archiveFile) {
      throw new Error(`Skill package archive is missing content for file: ${file.path}`);
    }
    if (typeof archiveFile.contentBase64 !== "string") {
      throw new Error(`Skill package archive has invalid base64 content: ${file.path}`);
    }
    const declaredSizeLimit = Math.min(
      file.sizeBytes,
      MAX_SKILL_PACKAGE_FILE_SIZE_BYTES,
      MAX_SKILL_PACKAGE_TOTAL_SIZE_BYTES,
    );
    const encodedLengthLimit = maxBase64LengthForDecodedSize(declaredSizeLimit);
    if (archiveFile.contentBase64.length > encodedLengthLimit) {
      throw new Error(`Skill package archive base64 content is too large: ${file.path}`);
    }
    if (!BASE64_PATTERN.test(archiveFile.contentBase64)) {
      throw new Error(`Skill package archive has invalid base64 content: ${file.path}`);
    }

    const bytes = Buffer.from(archiveFile.contentBase64, "base64");
    if (bytes.byteLength !== file.sizeBytes) {
      throw new Error(`Skill package file size does not match archive bytes: ${file.path}`);
    }
    if (sha256(bytes) !== file.sha256) {
      throw new Error(`Skill package file sha256 does not match archive bytes: ${file.path}`);
    }
    if (file.text !== undefined) {
      const decoded = decodeUtf8(bytes);
      if (decoded !== file.text) {
        throw new Error(`Skill package file text does not match archive bytes: ${file.path}`);
      }
    }

    return {
      ...file,
      contentBase64: archiveFile.contentBase64,
      bytes,
    };
  });

  return {
    schemaVersion: manifest.schemaVersion,
    entrypoint: manifest.entrypoint,
    metadata: manifest.metadata,
    packageSha256: manifest.packageSha256,
    files,
  };
};

export async function packSkillDirectory(skillDir: string): Promise<SkillPackageArchive> {
  const skillRoot = resolve(skillDir);
  const absoluteFilePaths = await collectPackageFilePaths(skillRoot, skillRoot);

  const pendingFiles: PendingPackageFile[] = [];
  for (const absoluteFilePath of absoluteFilePaths) {
    const packagePath = packagePathForFile(skillRoot, absoluteFilePath);
    const fileStat = await stat(absoluteFilePath);
    const limitProbe = [...pendingFiles, { path: packagePath, sizeBytes: fileStat.size }];
    enforcePackageLimits(limitProbe);

    const bytes = await readFile(absoluteFilePath);
    const mediaType = mediaTypeForPath(packagePath);
    const text = shouldEmbedText(mediaType) ? decodeUtf8(bytes) : undefined;
    pendingFiles.push({
      path: packagePath,
      sha256: sha256(bytes),
      sizeBytes: bytes.byteLength,
      mediaType,
      ...(fileStat.mode & 0o111 ? { executable: true } : {}),
      ...(text !== undefined ? { text } : {}),
      contentBase64: bytes.toString("base64"),
    });
    enforcePackageLimits(pendingFiles);
  }

  const skillMarkdown = pendingFiles.find((file) => file.path === SKILL_ENTRYPOINT)?.text;
  const manifest = await buildSkillPackageManifest({
    metadata: metadataFromSkillMarkdown(skillRoot, skillMarkdown),
    files: pendingFiles,
  });
  const contentByPath = new Map(pendingFiles.map((file) => [file.path, file.contentBase64]));

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

const unpackSkillPackageWithFileSystem = async (
  input: UnpackSkillPackageInput,
  fileSystemOverrides: Partial<SkillPackageFileSystem> = {},
): Promise<void> => {
  const fileSystem: SkillPackageFileSystem = { ...DEFAULT_FILE_SYSTEM, ...fileSystemOverrides };
  const validatedArchive = validateArchiveFiles(input.archive);
  const targetDir = resolve(input.targetDir);
  if (dirname(targetDir) === targetDir) {
    throw new Error("Skill package target directory cannot be a filesystem root");
  }

  const parentDir = dirname(targetDir);
  await fileSystem.mkdir(parentDir, { recursive: true });

  const targetBaseName = basename(targetDir);
  const tempDir = join(parentDir, `.${targetBaseName}.tmp-${randomUUID()}`);
  const backupDir = join(parentDir, `.${targetBaseName}.backup-${randomUUID()}`);
  let movedExistingTarget = false;
  let installedTarget = false;

  try {
    await fileSystem.mkdir(tempDir);
    for (const file of validatedArchive.files) {
      const destinationPath = resolvePackageChild(tempDir, file.path);
      await fileSystem.mkdir(dirname(destinationPath), { recursive: true });
      await fileSystem.writeFile(destinationPath, file.bytes);
      if (file.executable) {
        await fileSystem.chmod(destinationPath, 0o755);
      }
    }

    // Node cannot portably rename a directory over a non-empty directory.
    // We use a recoverable transaction instead: write a complete temp tree,
    // move the old target aside, then install the temp tree. Before install,
    // failures restore the backup; after install is visible, cleanup is best effort.
    try {
      await fileSystem.rename(targetDir, backupDir);
      movedExistingTarget = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    try {
      await fileSystem.rename(tempDir, targetDir);
      installedTarget = true;
    } catch (error) {
      if (movedExistingTarget) {
        await fileSystem.rename(backupDir, targetDir).catch(() => undefined);
      }
      throw error;
    }

    if (movedExistingTarget) {
      await fileSystem.rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
    }
  } catch (error) {
    if (!installedTarget) {
      await fileSystem.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      if (movedExistingTarget) {
        await fileSystem.rename(backupDir, targetDir).catch(() => undefined);
      }
    }
    throw error;
  }
};

export async function unpackSkillPackage(input: UnpackSkillPackageInput): Promise<void> {
  await unpackSkillPackageWithFileSystem(input);
}

export const __skillPackageTestHooks = {
  unpackSkillPackageWithFileSystem,
};
