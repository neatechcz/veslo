import { and, asc, eq } from "drizzle-orm"
import { db } from "../db/index.js"
import { SoulDocumentTable, SoulVersionTable } from "../db/schema.js"
import {
  SoulStoreError,
  assertNonEmpty,
  assertSoulUpdateInput,
  emptySoulDocument,
  nextSoulVersionId,
  paginateVersions,
  type SoulDocument,
  type SoulListVersionsInput,
  type SoulRestoreInput,
  type SoulScope,
  type SoulStore,
  type SoulUpdateInput,
  type SoulVersion,
} from "./store.js"

type DenDatabase = typeof db
type SoulDocumentRow = typeof SoulDocumentTable.$inferSelect
type SoulVersionRow = typeof SoulVersionTable.$inferSelect

export function createDbSoulStore(database: DenDatabase = db): SoulStore {
  return new DbSoulStore(database)
}

class DbSoulStore implements SoulStore {
  constructor(private readonly database: DenDatabase) {}

  async getDocument(scope: SoulScope, ownerId: string): Promise<SoulDocument> {
    const row = await this.ensureDocumentRow(scope, ownerId)
    const versions = await this.listDocumentVersions(row.id)
    return toSoulDocument(row, versions)
  }

  async updateDocument(input: SoulUpdateInput): Promise<SoulDocument> {
    assertSoulUpdateInput(input)
    const current = await this.getDocument(input.scope, input.ownerId)
    if (current.currentVersionId !== input.baseVersionId) {
      throw new SoulStoreError("soul_conflict", "Soul baseVersionId is stale")
    }

    const versionId = nextSoulVersionId()
    await this.database.insert(SoulVersionTable).values({
      id: versionId,
      document_id: current.id,
      scope: input.scope,
      owner_id: input.ownerId,
      content: input.content,
      change_summary: input.changeSummary,
      created_by: input.actorUserId,
      source: input.source ?? "manual",
      base_version_id: input.baseVersionId,
      restore_source_version_id: null,
      created_at: new Date(),
    })
    await this.database
      .update(SoulDocumentTable)
      .set({
        current_version_id: versionId,
        heartbeat_enabled: input.heartbeatEnabled ?? current.heartbeatEnabled,
      })
      .where(eq(SoulDocumentTable.id, current.id))

    return this.getDocument(input.scope, input.ownerId)
  }

  async listVersions(input: SoulListVersionsInput) {
    const document = await this.getDocument(input.scope, input.ownerId)
    return paginateVersions(document.versions, input.cursor, input.limit)
  }

  async getVersion(scope: SoulScope, ownerId: string, versionId: string): Promise<SoulVersion | null> {
    const rows = await this.database
      .select()
      .from(SoulVersionTable)
      .where(and(
        eq(SoulVersionTable.scope, scope),
        eq(SoulVersionTable.owner_id, ownerId),
        eq(SoulVersionTable.id, versionId),
      ))
      .limit(1)

    return rows[0] ? toSoulVersion(rows[0]) : null
  }

  async restoreVersion(input: SoulRestoreInput): Promise<SoulDocument> {
    assertNonEmpty(input.changeSummary, "changeSummary")
    assertNonEmpty(input.actorUserId, "actorUserId")
    const current = await this.getDocument(input.scope, input.ownerId)
    const source = current.versions.find((version) => version.id === input.versionId)
    if (!source) {
      throw new SoulStoreError("soul_not_found", "Soul version was not found")
    }

    const versionId = nextSoulVersionId()
    await this.database.insert(SoulVersionTable).values({
      id: versionId,
      document_id: current.id,
      scope: input.scope,
      owner_id: input.ownerId,
      content: source.content,
      change_summary: input.changeSummary,
      created_by: input.actorUserId,
      source: "restore",
      base_version_id: current.currentVersionId,
      restore_source_version_id: source.id,
      created_at: new Date(),
    })
    await this.database
      .update(SoulDocumentTable)
      .set({ current_version_id: versionId })
      .where(eq(SoulDocumentTable.id, current.id))

    return this.getDocument(input.scope, input.ownerId)
  }

  private async ensureDocumentRow(scope: SoulScope, ownerId: string): Promise<SoulDocumentRow> {
    const existing = await this.findDocumentRow(scope, ownerId)
    if (existing) return existing

    const created = emptySoulDocument(scope, ownerId)
    await this.database.insert(SoulDocumentTable).values({
      id: created.id,
      scope,
      owner_id: ownerId,
      current_version_id: null,
      heartbeat_enabled: created.heartbeatEnabled,
      created_at: new Date(),
      updated_at: new Date(),
    }).onDuplicateKeyUpdate({
      set: { owner_id: ownerId },
    })

    const row = await this.findDocumentRow(scope, ownerId)
    if (!row) {
      throw new SoulStoreError("invalid_request", "Failed to create Soul document")
    }
    return row
  }

  private async findDocumentRow(scope: SoulScope, ownerId: string): Promise<SoulDocumentRow | null> {
    const rows = await this.database
      .select()
      .from(SoulDocumentTable)
      .where(and(eq(SoulDocumentTable.scope, scope), eq(SoulDocumentTable.owner_id, ownerId)))
      .limit(1)

    return rows[0] ?? null
  }

  private async listDocumentVersions(documentId: string): Promise<SoulVersion[]> {
    const rows = await this.database
      .select()
      .from(SoulVersionTable)
      .where(eq(SoulVersionTable.document_id, documentId))
      .orderBy(asc(SoulVersionTable.created_at))

    return rows.map((row) => toSoulVersion(row))
  }
}

function toSoulDocument(row: SoulDocumentRow, versions: SoulVersion[]): SoulDocument {
  return {
    id: row.id,
    scope: row.scope,
    ownerId: row.owner_id,
    currentVersionId: row.current_version_id,
    heartbeatEnabled: row.heartbeat_enabled,
    versions,
  }
}

function toSoulVersion(row: SoulVersionRow): SoulVersion {
  return {
    id: row.id,
    content: row.content,
    changeSummary: row.change_summary,
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
    source: row.source,
    baseVersionId: row.base_version_id,
    restoreSourceVersionId: row.restore_source_version_id,
  }
}
