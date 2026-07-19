import { createHash } from "node:crypto"
import { TextDecoder } from "node:util"

export type SkillRegistryPackageFile = {
  path: string
  sha256: string
  sizeBytes: number
  mediaType: string
  executable?: boolean
  text?: string
}

export type SkillRegistryPackageManifest = {
  schemaVersion: 1
  entrypoint: "SKILL.md"
  files: SkillRegistryPackageFile[]
  packageSha256: string
  metadata: {
    name: string
    description?: string
    trigger?: string
    tags?: string[]
    language?: string
  }
}

export type SkillRegistryPackageArchiveFile = SkillRegistryPackageFile & {
  contentBase64: string
}

export type SkillRegistryPackageArchive = Omit<SkillRegistryPackageManifest, "files"> & {
  files: SkillRegistryPackageArchiveFile[]
}

export type SkillRegistryPendingPackageFile = {
  path: string
  bytes: Buffer
  mediaType: string
  executable?: boolean
}

export const MAX_SKILL_REGISTRY_PACKAGE_FILE_COUNT = 256
export const MAX_SKILL_REGISTRY_PACKAGE_FILE_SIZE_BYTES = 10 * 1024 * 1024
export const MAX_SKILL_REGISTRY_PACKAGE_TOTAL_SIZE_BYTES = 25 * 1024 * 1024

const ENTRYPOINT = "SKILL.md"
const SHA256_PATTERN = /^[a-f0-9]{64}$/i
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[a-zA-Z]:[\\/]/
const WINDOWS_RESERVED_BASENAME_PATTERN = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true })

type DecodedArchiveFile = SkillRegistryPackageArchiveFile & {
  bytes: Buffer
}

export type DecodedSkillRegistryPackageArchive = Omit<SkillRegistryPackageArchive, "files"> & {
  files: DecodedArchiveFile[]
}

export function sha256Hex(value: Buffer | string): string {
  return createHash("sha256")
    .update(typeof value === "string" ? value : new Uint8Array(value))
    .digest("hex")
}

// Package hashes must not depend on the process locale. The local materializer
// uses this binary ordering too, so a package created by Den has the same
// canonical manifest everywhere it is consumed.
export function compareSkillRegistryPackagePaths(
  left: Pick<SkillRegistryPackageFile, "path">,
  right: Pick<SkillRegistryPackageFile, "path">,
): number {
  if (left.path < right.path) return -1
  if (left.path > right.path) return 1
  return 0
}

function requireTrimmedString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`)
  }
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error(`${field} is required`)
  }
  return trimmed
}

function optionalTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed || undefined
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value == null) {
    return undefined
  }
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`)
  }
  const entries = value
    .map((entry) => optionalTrimmedString(entry))
    .filter((entry): entry is string => Boolean(entry))
  return entries.length > 0 ? entries : undefined
}

export function normalizeSkillRegistryPackagePath(path: string): string {
  const trimmed = requireTrimmedString(path, "package file path")
  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith("\\") ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("\\\\") ||
    WINDOWS_ABSOLUTE_PATH_PATTERN.test(trimmed)
  ) {
    throw new Error(`package file path must be relative: ${path}`)
  }

  const segments = trimmed
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment && segment !== ".")

  if (segments.length === 0) {
    throw new Error(`package file path must name a file: ${path}`)
  }
  if (segments.some((segment) => segment === "..")) {
    throw new Error(`package file path cannot contain '..': ${path}`)
  }
  const colonSegment = segments.find((segment) => segment.includes(":"))
  if (colonSegment) {
    throw new Error(`package file path cannot contain ':': ${path}`)
  }
  const reservedSegment = segments.find((segment) => WINDOWS_RESERVED_BASENAME_PATTERN.test(segment))
  if (reservedSegment) {
    throw new Error(`package file path cannot use reserved Windows name '${reservedSegment}': ${path}`)
  }
  const trailingWindowsSpaceOrDotSegment = segments.find((segment) => /[ .]$/.test(segment))
  if (trailingWindowsSpaceOrDotSegment) {
    throw new Error(`package file path segment cannot end with a space or '.': ${path}`)
  }

  return segments.join("/")
}

export function normalizeSkillRegistryPackageMetadata(metadata: unknown): SkillRegistryPackageManifest["metadata"] {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw new Error("package metadata must be an object")
  }

  const record = metadata as Record<string, unknown>
  const normalized: SkillRegistryPackageManifest["metadata"] = {
    name: requireTrimmedString(record.name, "package metadata.name"),
  }
  const description = optionalTrimmedString(record.description)
  const trigger = optionalTrimmedString(record.trigger)
  const tags = optionalStringArray(record.tags, "package metadata.tags")
  const language = optionalTrimmedString(record.language)

  if (description) normalized.description = description
  if (trigger) normalized.trigger = trigger
  if (tags) normalized.tags = tags
  if (language) normalized.language = language
  return normalized
}

function normalizeFile(file: unknown, index: number): SkillRegistryPackageArchiveFile {
  if (typeof file !== "object" || file === null || Array.isArray(file)) {
    throw new Error(`package file ${index} must be an object`)
  }
  const record = file as Record<string, unknown>
  const path = normalizeSkillRegistryPackagePath(requireTrimmedString(record.path, `package file ${index}.path`))
  const sha256 = requireTrimmedString(record.sha256, `${path} sha256`).toLowerCase()
  if (!SHA256_PATTERN.test(sha256)) {
    throw new Error(`package file sha256 must be a 64-character hex digest: ${path}`)
  }
  if (!Number.isSafeInteger(record.sizeBytes) || (record.sizeBytes as number) < 0) {
    throw new Error(`package file sizeBytes must be a non-negative integer: ${path}`)
  }
  const mediaType = requireTrimmedString(record.mediaType, `${path} mediaType`)
  const contentBase64 = typeof record.contentBase64 === "string" ? record.contentBase64 : null
  if (contentBase64 === null) {
    throw new Error(`package file contentBase64 must be a string: ${path}`)
  }

  const normalized: SkillRegistryPackageArchiveFile = {
    path,
    sha256,
    sizeBytes: record.sizeBytes as number,
    mediaType,
    contentBase64,
  }
  if (record.executable !== undefined) normalized.executable = Boolean(record.executable)
  if (record.text !== undefined) {
    if (typeof record.text !== "string") {
      throw new Error(`package file text must be a string: ${path}`)
    }
    normalized.text = record.text
  }
  return normalized
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(",")}}`
}

export function computeSkillRegistryPackageSha256(manifest: Omit<SkillRegistryPackageManifest, "packageSha256">): string {
  return sha256Hex(stableStringify(manifest))
}

function enforcePackageLimits(files: Pick<SkillRegistryPackageFile, "path" | "sizeBytes">[]) {
  if (files.length > MAX_SKILL_REGISTRY_PACKAGE_FILE_COUNT) {
    throw new Error(`package has too many files: ${files.length} > ${MAX_SKILL_REGISTRY_PACKAGE_FILE_COUNT}`)
  }

  let totalSizeBytes = 0
  for (const file of files) {
    if (file.sizeBytes > MAX_SKILL_REGISTRY_PACKAGE_FILE_SIZE_BYTES) {
      throw new Error(
        `package file is too large: ${file.path} (${file.sizeBytes} > ${MAX_SKILL_REGISTRY_PACKAGE_FILE_SIZE_BYTES})`,
      )
    }
    totalSizeBytes += file.sizeBytes
    if (totalSizeBytes > MAX_SKILL_REGISTRY_PACKAGE_TOTAL_SIZE_BYTES) {
      throw new Error(`package is too large: ${totalSizeBytes} > ${MAX_SKILL_REGISTRY_PACKAGE_TOTAL_SIZE_BYTES}`)
    }
  }
}

function decodeUtf8(bytes: Buffer, path: string): string {
  try {
    return UTF8_DECODER.decode(new Uint8Array(bytes))
  } catch {
    throw new Error(`package file text does not match archive bytes: ${path}`)
  }
}

function decodeArchiveFile(file: SkillRegistryPackageArchiveFile): DecodedArchiveFile {
  const maxBase64Length = file.sizeBytes === 0 ? 0 : Math.ceil(file.sizeBytes / 3) * 4
  if (file.contentBase64.length > maxBase64Length) {
    throw new Error(`package file base64 content is too large: ${file.path}`)
  }
  if (!BASE64_PATTERN.test(file.contentBase64)) {
    throw new Error(`package file contentBase64 is invalid: ${file.path}`)
  }

  const bytes = Buffer.from(file.contentBase64, "base64")
  if (bytes.byteLength !== file.sizeBytes) {
    throw new Error(`package file size does not match archive bytes: ${file.path}`)
  }
  if (sha256Hex(bytes) !== file.sha256) {
    throw new Error(`package file sha256 does not match archive bytes: ${file.path}`)
  }
  if (file.text !== undefined && decodeUtf8(bytes, file.path) !== file.text) {
    throw new Error(`package file text does not match archive bytes: ${file.path}`)
  }

  return { ...file, bytes }
}

export function validateSkillRegistryPackageArchive(value: unknown): SkillRegistryPackageArchive {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("package archive must be an object")
  }
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 1) {
    throw new Error("package schemaVersion must be 1")
  }
  if (record.entrypoint !== ENTRYPOINT) {
    throw new Error(`package entrypoint must be ${ENTRYPOINT}`)
  }
  if (!Array.isArray(record.files)) {
    throw new Error("package files must be an array")
  }

  const seenPaths = new Set<string>()
  const files = record.files
    .map(normalizeFile)
    .map((file) => {
      if (seenPaths.has(file.path)) {
        throw new Error(`package file paths must be unique: ${file.path}`)
      }
      seenPaths.add(file.path)
      return file
    })
    .sort(compareSkillRegistryPackagePaths)

  if (!files.some((file) => file.path === ENTRYPOINT)) {
    throw new Error(`package requires ${ENTRYPOINT}`)
  }
  enforcePackageLimits(files)

  const manifestWithoutHash = {
    schemaVersion: 1,
    entrypoint: ENTRYPOINT,
    files: files.map(({ contentBase64: _contentBase64, ...file }) => file),
    metadata: normalizeSkillRegistryPackageMetadata(record.metadata),
  } satisfies Omit<SkillRegistryPackageManifest, "packageSha256">
  const packageSha256 = requireTrimmedString(record.packageSha256, "package packageSha256").toLowerCase()
  if (!SHA256_PATTERN.test(packageSha256)) {
    throw new Error("package packageSha256 must be a 64-character hex digest")
  }
  if (packageSha256 !== computeSkillRegistryPackageSha256(manifestWithoutHash)) {
    throw new Error("package packageSha256 does not match canonical package content")
  }

  const normalized = {
    ...manifestWithoutHash,
    packageSha256,
    files: files.map((file) => {
      const manifestFile = manifestWithoutHash.files.find((entry) => entry.path === file.path)
      if (!manifestFile) {
        throw new Error(`package file is missing from manifest: ${file.path}`)
      }
      return {
        ...manifestFile,
        contentBase64: file.contentBase64,
      }
    }),
  }

  for (const file of normalized.files) {
    decodeArchiveFile(file)
  }
  return normalized
}

export function decodeSkillRegistryPackageArchive(value: unknown): DecodedSkillRegistryPackageArchive {
  const archive = validateSkillRegistryPackageArchive(value)
  return {
    ...archive,
    files: archive.files.map(decodeArchiveFile),
  }
}

function textForFile(bytes: Buffer, mediaType: string): string | undefined {
  if (
    !mediaType.startsWith("text/") &&
    mediaType !== "application/json" &&
    mediaType !== "application/yaml" &&
    mediaType !== "image/svg+xml"
  ) {
    return undefined
  }

  try {
    return UTF8_DECODER.decode(new Uint8Array(bytes))
  } catch {
    return undefined
  }
}

export async function buildSkillRegistryPackageArchive(input: {
  metadata: SkillRegistryPackageManifest["metadata"]
  files: SkillRegistryPendingPackageFile[]
}): Promise<SkillRegistryPackageArchive> {
  const pendingFiles = input.files.map((file) => {
    const path = normalizeSkillRegistryPackagePath(file.path)
    const text = textForFile(file.bytes, file.mediaType)
    return {
      path,
      sha256: sha256Hex(file.bytes),
      sizeBytes: file.bytes.byteLength,
      mediaType: requireTrimmedString(file.mediaType, `${path} mediaType`),
      ...(file.executable ? { executable: true } : {}),
      ...(text !== undefined ? { text } : {}),
      contentBase64: file.bytes.toString("base64"),
    } satisfies SkillRegistryPackageArchiveFile
  })
  const manifestWithoutHash = {
    schemaVersion: 1,
    entrypoint: ENTRYPOINT,
    files: pendingFiles
      .map(({ contentBase64: _contentBase64, ...file }) => file)
      .sort(compareSkillRegistryPackagePaths),
    metadata: normalizeSkillRegistryPackageMetadata(input.metadata),
  } satisfies Omit<SkillRegistryPackageManifest, "packageSha256">
  const contentByPath = new Map(pendingFiles.map((file) => [file.path, file.contentBase64]))

  return validateSkillRegistryPackageArchive({
    ...manifestWithoutHash,
    packageSha256: computeSkillRegistryPackageSha256(manifestWithoutHash),
    files: manifestWithoutHash.files.map((file) => ({
      ...file,
      contentBase64: contentByPath.get(file.path) ?? "",
    })),
  })
}
