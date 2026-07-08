import { readdir, readFile } from "node:fs/promises"
import { dirname, join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"

import {
  buildSkillRegistryPackageArchive,
  type SkillRegistryPackageArchive,
  type SkillRegistryPendingPackageFile,
} from "./packages.js"
import type {
  SkillInstallationUpdatePolicy,
  SkillRolloutAudience,
  SkillRolloutCatalogScope,
  SkillRolloutRemovalPolicy,
  SkillRolloutTarget,
  SkillScope,
} from "./schema.js"

const moduleDir = dirname(fileURLToPath(import.meta.url))
const DEFAULT_SOURCE_ROOT = join(moduleDir, "core-platform-skill-assets")

type CorePlatformSkillName =
  | "veslo-docx"
  | "veslo-pdf"
  | "veslo-pptx"
  | "veslo-xlsx"
  | "skill-creator"

export type CorePlatformSkillDefinition = {
  name: CorePlatformSkillName
  sourcePack: string
  displayName: string
  description: string
  tags: string[]
  scope: SkillScope
  rollout: {
    catalogScope: SkillRolloutCatalogScope
    target: SkillRolloutTarget
    audience: SkillRolloutAudience
    updatePolicy: SkillInstallationUpdatePolicy
    removalPolicy: SkillRolloutRemovalPolicy
  }
}

export type CorePlatformSkillPackage = CorePlatformSkillDefinition & {
  package: SkillRegistryPackageArchive
  packageSha256: string
}

export const CORE_PLATFORM_SKILL_DEFINITIONS: readonly CorePlatformSkillDefinition[] = [
  {
    name: "veslo-docx",
    sourcePack: "docx",
    displayName: "DOCX Documents",
    description:
      "Create, edit, analyze, convert, and validate Word DOCX documents using standard skill execution.",
    tags: ["documents", "docx", "office", "platform-core"],
    scope: "system",
    rollout: corePlatformRollout(),
  },
  {
    name: "veslo-pdf",
    sourcePack: "pdf",
    displayName: "PDF Documents",
    description:
      "Extract, create, merge, split, annotate, fill forms, and validate PDF documents using standard skill execution.",
    tags: ["documents", "pdf", "office", "platform-core"],
    scope: "system",
    rollout: corePlatformRollout(),
  },
  {
    name: "veslo-pptx",
    sourcePack: "pptx",
    displayName: "PowerPoint Presentations",
    description:
      "Create, edit, analyze, and visually validate PowerPoint PPTX presentations using standard skill execution.",
    tags: ["presentations", "pptx", "office", "platform-core"],
    scope: "system",
    rollout: corePlatformRollout(),
  },
  {
    name: "veslo-xlsx",
    sourcePack: "xlsx",
    displayName: "Excel Spreadsheets",
    description:
      "Create, edit, analyze, recalculate, and validate Excel XLSX workbooks using standard skill execution.",
    tags: ["spreadsheets", "xlsx", "office", "platform-core"],
    scope: "system",
    rollout: corePlatformRollout(),
  },
  {
    name: "skill-creator",
    sourcePack: "skill-creator",
    displayName: "Skill Creator",
    description:
      "Create and update Veslo skills for user, workspace, organization, and public registry-backed distribution.",
    tags: ["skills", "registry", "authoring", "platform-core"],
    scope: "system",
    rollout: corePlatformRollout(),
  },
] as const

export async function buildCorePlatformSkillPackages(
  options: { sourceRoot?: string } = {},
): Promise<CorePlatformSkillPackage[]> {
  const sourceRoot = options.sourceRoot ?? DEFAULT_SOURCE_ROOT
  const packages: CorePlatformSkillPackage[] = []

  for (const definition of CORE_PLATFORM_SKILL_DEFINITIONS) {
    const files = await readPackFiles(sourceRoot, definition)
    const archive = await buildSkillRegistryPackageArchive({
      metadata: {
        name: definition.name,
        description: definition.description,
        tags: definition.tags,
        language: "en",
      },
      files,
    })
    packages.push({
      ...definition,
      package: archive,
      packageSha256: archive.packageSha256,
    })
  }

  return packages
}

function corePlatformRollout(): CorePlatformSkillDefinition["rollout"] {
  return {
    catalogScope: "platform",
    target: "user-global",
    audience: "all-platform-users",
    updatePolicy: "pinned",
    removalPolicy: "locked",
  }
}

async function readPackFiles(sourceRoot: string, definition: CorePlatformSkillDefinition) {
  const packRoot = join(sourceRoot, definition.sourcePack)
  const paths = await collectFilePaths(packRoot)
  const files: SkillRegistryPendingPackageFile[] = []

  for (const absolutePath of paths) {
    const relativePath = toPackagePath(relative(packRoot, absolutePath))
    if (shouldSkipPackageFile(relativePath)) continue

    const bytes = await readFile(absolutePath)
    files.push({
      path: relativePath,
      bytes,
      mediaType: mediaTypeForPath(relativePath),
      executable: isExecutablePath(relativePath),
    })
  }

  return files
}

async function collectFilePaths(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const paths: string[] = []

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === "__pycache__" || entry.name === ".DS_Store") continue

    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      paths.push(...(await collectFilePaths(path)))
      continue
    }
    if (entry.isFile()) {
      paths.push(path)
    }
  }

  return paths
}

function toPackagePath(path: string) {
  return sep === "/" ? path : path.split(sep).join("/")
}

function shouldSkipPackageFile(path: string) {
  return path.endsWith(".pyc") || path === "scripts/test_quick_validate.py"
}

function mediaTypeForPath(path: string) {
  if (path.endsWith(".md")) return "text/markdown"
  if (path.endsWith(".py")) return "text/x-python"
  if (path.endsWith(".js")) return "text/javascript"
  if (path.endsWith(".css")) return "text/css"
  if (path.endsWith(".html")) return "text/html"
  if (path.endsWith(".json")) return "application/json"
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return "application/yaml"
  if (path.endsWith(".xml") || path.endsWith(".xsd")) return "text/xml"
  if (path.endsWith(".tgz") || path.endsWith(".tar.gz")) return "application/gzip"
  return "application/octet-stream"
}

function isExecutablePath(path: string) {
  return path.endsWith(".sh") || path.endsWith(".py")
}
