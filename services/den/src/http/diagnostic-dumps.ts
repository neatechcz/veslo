import express from "express"
import { createHash, randomUUID } from "node:crypto"
import { createWriteStream } from "node:fs"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import {
  DESKTOP_DUMP_ORG_HEADERS,
  VESLO_DUMP_FILENAME_HEADER,
  VESLO_DUMP_KIND_HEADER,
  VESLO_DUMP_SHA256_HEADER,
  VESLO_DUMP_SOURCE_HEADER,
  VESLO_DUMP_UNCOMPRESSED_BYTES_HEADER,
  VESLO_DUMP_WORKSPACE_ID_HEADER,
} from "./diagnostic-dump-headers.js"
import type { ResolvedOrganizationContext } from "./org-auth.js"

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024

type DesktopDiagnosticDumpsAuthorize = (
  req: express.Request,
  res: express.Response,
  options: { orgId: string },
) => Promise<ResolvedOrganizationContext | null>

type DiagnosticDumpIdentity =
  | { authMode: "internal" }
  | {
      authMode: "desktop"
      userId: string
      orgId: string
      membershipId: string | null
      orgRole: string | null
      isPlatformAdmin: boolean
    }

class DiagnosticDumpTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`diagnostic_dump_too_large:${maxBytes}`)
  }
}

class HashAndLimitTransform extends Transform {
  private bytes = 0
  private readonly hash = createHash("sha256")

  constructor(private readonly maxBytes: number) {
    super()
  }

  override _transform(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void) {
    this.bytes += chunk.length
    if (this.bytes > this.maxBytes) {
      callback(new DiagnosticDumpTooLargeError(this.maxBytes))
      return
    }
    this.hash.update(chunk as unknown as Uint8Array)
    callback(null, chunk)
  }

  result() {
    return {
      bytes: this.bytes,
      sha256: this.hash.digest("hex"),
    }
  }
}

function readBearerToken(req: express.Request) {
  const header = req.header("authorization")?.trim() ?? ""
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return match?.[1]?.trim() || null
}

function readHeader(req: express.Request, name: string, fallback = "") {
  const value = req.header(name)?.trim() ?? ""
  return value || fallback
}

function sanitizeLabel(value: string, fallback: string, max = 64) {
  const sanitized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max)
  return sanitized || fallback
}

function datePath(date: Date) {
  return date.toISOString().slice(0, 10)
}

function parseContentLength(req: express.Request) {
  const value = req.header("content-length")?.trim()
  if (!value) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function readDesktopDumpOrgId(req: express.Request) {
  for (const header of DESKTOP_DUMP_ORG_HEADERS) {
    const value = readHeader(req, header)
    if (value) return value
  }
  return ""
}

function storageSegments(identity: DiagnosticDumpIdentity) {
  if (identity.authMode !== "desktop") {
    return []
  }

  return [
    "desktop",
    sanitizeLabel(identity.orgId, "org"),
    sanitizeLabel(identity.userId, "user"),
  ]
}

function metadataForIdentity(identity: DiagnosticDumpIdentity) {
  if (identity.authMode !== "desktop") {
    return { authMode: "internal" as const }
  }

  return {
    authMode: "desktop" as const,
    userId: identity.userId,
    orgId: identity.orgId,
    membershipId: identity.membershipId,
    orgRole: identity.orgRole,
    isPlatformAdmin: identity.isPlatformAdmin,
  }
}

async function handleDiagnosticDumpUpload(
  req: express.Request,
  res: express.Response,
  options: {
    rootDir: string
    maxBytes: number
    now: () => Date
    randomId: () => string
    identity: DiagnosticDumpIdentity
  },
) {
  const contentLength = parseContentLength(req)
  if (contentLength !== null && contentLength > options.maxBytes) {
    res.status(413).json({ error: "diagnostic_dump_too_large", maxBytes: options.maxBytes })
    return
  }

  const rootDir = path.resolve(options.rootDir)
  const createdAt = options.now()
  const dumpId = `ddump_${options.randomId()}`
  const source = sanitizeLabel(readHeader(req, VESLO_DUMP_SOURCE_HEADER, "unknown"), "unknown")
  const kind = sanitizeLabel(readHeader(req, VESLO_DUMP_KIND_HEADER, "diagnostic-dump"), "diagnostic-dump")
  const originalFilename = readHeader(req, VESLO_DUMP_FILENAME_HEADER, "")
  const contentType = readHeader(req, "content-type", "application/octet-stream")
  const contentEncoding = readHeader(req, "content-encoding", "")
  const reportedSha256 = readHeader(req, VESLO_DUMP_SHA256_HEADER, "")
  const reportedUncompressedBytes = readHeader(req, VESLO_DUMP_UNCOMPRESSED_BYTES_HEADER, "")
  const workspaceId = readHeader(req, VESLO_DUMP_WORKSPACE_ID_HEADER, "")
  const ext = contentEncoding.toLowerCase() === "gzip" || /\.gz$/i.test(originalFilename) ? ".gz" : ".bin"
  const dayDir = path.join(rootDir, ...storageSegments(options.identity), datePath(createdAt))
  const fileName = `${dumpId}-${kind}-${source}${ext}`
  const storagePath = path.join(dayDir, fileName)
  const tempPath = `${storagePath}.part`
  const metadataPath = `${storagePath}.metadata.json`

  await mkdir(dayDir, { recursive: true })

  const hashAndLimit = new HashAndLimitTransform(options.maxBytes)

  try {
    await pipeline(req, hashAndLimit, createWriteStream(tempPath, { flags: "wx" }))
    const { bytes, sha256 } = hashAndLimit.result()
    if (bytes === 0) {
      await rm(tempPath, { force: true })
      res.status(400).json({ error: "diagnostic_dump_empty" })
      return
    }

    await rename(tempPath, storagePath)

    const metadata = {
      id: dumpId,
      kind,
      source,
      originalFilename: originalFilename || null,
      contentType,
      contentEncoding: contentEncoding || null,
      bytes,
      sha256,
      reportedSha256: reportedSha256 || null,
      reportedUncompressedBytes: reportedUncompressedBytes || null,
      workspaceId: workspaceId || null,
      createdAt: createdAt.toISOString(),
      storagePath,
      metadataPath,
      ...metadataForIdentity(options.identity),
    }

    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8")
    res.status(202).json({ ok: true, dump: metadata })
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined)
    if (error instanceof DiagnosticDumpTooLargeError) {
      res.status(413).json({ error: "diagnostic_dump_too_large", maxBytes: options.maxBytes })
      return
    }
    res.status(500).json({ error: "diagnostic_dump_ingest_failed" })
  }
}

export function createDiagnosticDumpsIngestRouter(options: {
  ingestToken: string | null
  rootDir: string
  maxBytes?: number
  now?: () => Date
  randomId?: () => string
}) {
  const router = express.Router()
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const now = options.now ?? (() => new Date())
  const randomId = options.randomId ?? randomUUID
  const rootDir = path.resolve(options.rootDir)

  router.post("/diagnostic-dumps", async (req, res) => {
    if (!options.ingestToken) {
      res.status(503).json({ error: "diagnostic_dump_ingest_not_configured" })
      return
    }

    const bearerToken = readBearerToken(req)
    if (!bearerToken) {
      res.status(401).json({ error: "diagnostic_dump_ingest_unauthorized" })
      return
    }
    if (bearerToken !== options.ingestToken) {
      res.status(403).json({ error: "diagnostic_dump_ingest_forbidden" })
      return
    }

    await handleDiagnosticDumpUpload(req, res, {
      rootDir,
      maxBytes,
      now,
      randomId,
      identity: { authMode: "internal" },
    })
  })

  return router
}

export function createDesktopDiagnosticDumpsRouter(options: {
  rootDir: string
  maxBytes?: number
  now?: () => Date
  randomId?: () => string
  authorize?: DesktopDiagnosticDumpsAuthorize
}) {
  const router = express.Router()
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const now = options.now ?? (() => new Date())
  const randomId = options.randomId ?? randomUUID
  const authorize = options.authorize
    ?? (async (req, res, input) => {
      const { requireOrganizationAccess } = await import("./org-auth.js")
      return requireOrganizationAccess(req, res, {
        minimumRole: "member",
        orgId: input.orgId,
        allowPlatformAdmin: true,
      })
    })

  router.post("/desktop-diagnostic-dumps", async (req, res) => {
    const orgId = readDesktopDumpOrgId(req)
    if (!orgId) {
      res.status(400).json({ error: "diagnostic_dump_missing_org" })
      return
    }

    const context = await authorize(req, res, { orgId })
    if (!context) {
      return
    }

    await handleDiagnosticDumpUpload(req, res, {
      rootDir: options.rootDir,
      maxBytes,
      now,
      randomId,
      identity: {
        authMode: "desktop",
        userId: context.session.user.id,
        orgId: context.organization.id,
        membershipId: context.membershipId,
        orgRole: context.orgRole,
        isPlatformAdmin: context.isPlatformAdmin,
      },
    })
  })

  return router
}
