import { randomUUID } from "node:crypto"

export type SoulScope = "organization" | "user"
export type SoulVersionSource = "manual" | "api" | "heartbeat" | "restore" | "system"

export type SoulVersion = {
  id: string
  content: string
  changeSummary: string
  createdAt: string
  createdBy: string
  source: SoulVersionSource
  baseVersionId: string | null
  restoreSourceVersionId: string | null
}

export type SoulDocument = {
  id: string
  scope: SoulScope
  ownerId: string
  currentVersionId: string | null
  heartbeatEnabled: boolean
  versions: SoulVersion[]
}

export type SoulRouteContext = {
  userId: string
  orgId?: string | null
  orgRole?: "owner" | "organization_admin" | "member" | null
  isPlatformAdmin?: boolean
}

export type SoulVersionsResponse = {
  versions: SoulVersion[]
  nextCursor: string | null
}

export type SoulUpdateInput = {
  scope: SoulScope
  ownerId: string
  content: string
  changeSummary: string
  baseVersionId: string | null
  heartbeatEnabled?: boolean
  actorUserId: string
  source?: Exclude<SoulVersionSource, "restore">
}

export type SoulRestoreInput = {
  scope: SoulScope
  ownerId: string
  versionId: string
  changeSummary: string
  actorUserId: string
}

export type SoulListVersionsInput = {
  scope: SoulScope
  ownerId: string
  cursor?: string | null
  limit?: number | null
}

export interface SoulStore {
  getDocument(scope: SoulScope, ownerId: string): Promise<SoulDocument>
  updateDocument(input: SoulUpdateInput): Promise<SoulDocument>
  listVersions(input: SoulListVersionsInput): Promise<SoulVersionsResponse>
  getVersion(scope: SoulScope, ownerId: string, versionId: string): Promise<SoulVersion | null>
  restoreVersion(input: SoulRestoreInput): Promise<SoulDocument>
}

export class SoulStoreError extends Error {
  constructor(
    readonly code: "invalid_request" | "soul_conflict" | "soul_not_found",
    message: string,
    readonly status = code === "soul_conflict" ? 409 : code === "soul_not_found" ? 404 : 400,
  ) {
    super(message)
    this.name = "SoulStoreError"
  }
}

export class InMemorySoulStore implements SoulStore {
  private readonly documents = new Map<string, SoulDocument>()

  async getDocument(scope: SoulScope, ownerId: string): Promise<SoulDocument> {
    const key = documentKey(scope, ownerId)
    const current = this.documents.get(key)
    if (current) return cloneDocument(current)

    const created = emptySoulDocument(scope, ownerId)
    this.documents.set(key, created)
    return cloneDocument(created)
  }

  async updateDocument(input: SoulUpdateInput): Promise<SoulDocument> {
    assertSoulUpdateInput(input)
    const current = await this.getDocument(input.scope, input.ownerId)
    if (current.currentVersionId !== input.baseVersionId) {
      throw new SoulStoreError("soul_conflict", "Soul baseVersionId is stale")
    }

    const version: SoulVersion = {
      id: nextSoulVersionId(),
      content: input.content,
      changeSummary: input.changeSummary,
      createdAt: new Date().toISOString(),
      createdBy: input.actorUserId,
      source: input.source ?? "manual",
      baseVersionId: input.baseVersionId,
      restoreSourceVersionId: null,
    }
    const document: SoulDocument = {
      ...current,
      currentVersionId: version.id,
      heartbeatEnabled: input.heartbeatEnabled ?? current.heartbeatEnabled,
      versions: [...current.versions, version],
    }
    this.documents.set(documentKey(input.scope, input.ownerId), document)
    return cloneDocument(document)
  }

  async listVersions(input: SoulListVersionsInput): Promise<SoulVersionsResponse> {
    const document = await this.getDocument(input.scope, input.ownerId)
    return paginateVersions(document.versions, input.cursor, input.limit)
  }

  async getVersion(scope: SoulScope, ownerId: string, versionId: string): Promise<SoulVersion | null> {
    const document = await this.getDocument(scope, ownerId)
    return cloneVersion(document.versions.find((version) => version.id === versionId) ?? null)
  }

  async restoreVersion(input: SoulRestoreInput): Promise<SoulDocument> {
    assertNonEmpty(input.changeSummary, "changeSummary")
    assertNonEmpty(input.actorUserId, "actorUserId")
    const current = await this.getDocument(input.scope, input.ownerId)
    const source = current.versions.find((version) => version.id === input.versionId)
    if (!source) {
      throw new SoulStoreError("soul_not_found", "Soul version was not found")
    }

    const version: SoulVersion = {
      id: nextSoulVersionId(),
      content: source.content,
      changeSummary: input.changeSummary,
      createdAt: new Date().toISOString(),
      createdBy: input.actorUserId,
      source: "restore",
      baseVersionId: current.currentVersionId,
      restoreSourceVersionId: source.id,
    }
    const document: SoulDocument = {
      ...current,
      currentVersionId: version.id,
      versions: [...current.versions, version],
    }
    this.documents.set(documentKey(input.scope, input.ownerId), document)
    return cloneDocument(document)
  }
}

export function emptySoulDocument(scope: SoulScope, ownerId: string): SoulDocument {
  return {
    id: `soul_${scope}_${randomUUID()}`,
    scope,
    ownerId,
    currentVersionId: null,
    heartbeatEnabled: false,
    versions: [],
  }
}

export function nextSoulVersionId() {
  return `soul_v_${randomUUID()}`
}

export function paginateVersions(
  versions: SoulVersion[],
  cursor: string | null | undefined,
  limit: number | null | undefined,
): SoulVersionsResponse {
  const offset = parseCursor(cursor)
  const orderedVersions = [...versions].reverse()
  const boundedLimit = typeof limit === "number" && Number.isFinite(limit)
    ? Math.max(1, Math.min(Math.trunc(limit), 100))
    : orderedVersions.length
  const page = orderedVersions.slice(offset, offset + boundedLimit)
  const nextOffset = offset + page.length
  return {
    versions: page.map((version) => ({ ...version })),
    nextCursor: nextOffset < orderedVersions.length ? String(nextOffset) : null,
  }
}

export function assertSoulUpdateInput(input: SoulUpdateInput) {
  assertNonEmpty(input.ownerId, "ownerId")
  assertNonEmpty(input.content, "content")
  assertNonEmpty(input.changeSummary, "changeSummary")
  assertNonEmpty(input.actorUserId, "actorUserId")
}

export function assertNonEmpty(value: string, field: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new SoulStoreError("invalid_request", `${field} is required`)
  }
}

function documentKey(scope: SoulScope, ownerId: string) {
  return `${scope}:${ownerId}`
}

function parseCursor(cursor: string | null | undefined) {
  if (!cursor) return 0
  const parsed = Number(cursor)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0
}

function cloneDocument(document: SoulDocument): SoulDocument {
  return {
    ...document,
    versions: document.versions.map((version) => ({ ...version })),
  }
}

function cloneVersion(version: SoulVersion | null): SoulVersion | null {
  return version ? { ...version } : null
}
