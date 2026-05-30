import { and, desc, eq, isNull, sql } from "drizzle-orm"
import { randomUUID } from "node:crypto"

import {
  decodeSkillRegistryPackageArchive,
  sha256Hex,
  type SkillRegistryPackageArchive,
} from "./packages.js"
import {
  buildSkillSearchDocument,
  queryMatchesSkillSearchText,
} from "./search-indexer.js"
import {
  evaluateSkillRegistryRetentionPolicy,
  skillApprovalOwnerKey,
  skillReleaseChannelKey,
  skillScopeOwnerKey,
  skillVersionFilePathSha256,
  validateManagedSkillInstallationApproval,
  type SkillRegistryRetentionRole,
} from "./policy.js"
import {
  SkillApprovalTable,
  SkillBlobTable,
  SkillInstallationTable,
  SkillReviewRequestTable,
  SkillSearchDocumentTable,
  SkillTable,
  SkillVersionFileTable,
  SkillVersionTable,
  WorkspaceSkillSetEntryTable,
  WorkspaceSkillSetTable,
  SkillMaterializationTable,
  SkillAuditEventTable,
  type SkillApprovalScope,
  type SkillInstallationUpdatePolicy,
  type SkillScope,
  type SkillVersionStatus,
} from "./schema.js"
import {
  SkillRegistryStoreError,
  type RegistryReviewResponse,
  type RegistrySkillEvent,
  type RegistrySkillInstallation,
  type RegistrySkillSummary,
  type RegistrySkillVisibility,
  type RegistrySkillVersionSummary,
  type SkillRegistryRouteContext,
  type SkillRegistryStore,
} from "./store.js"

type DenDb = typeof import("../db/index.js").db
type CreateSkillInput = Parameters<SkillRegistryStore["createSkill"]>[1]
type CreateVersionInput = Parameters<SkillRegistryStore["createVersion"]>[1]
type CreateInstallationInput = Parameters<SkillRegistryStore["createInstallation"]>[1]
type UpdateInstallationInput = Parameters<SkillRegistryStore["updateInstallation"]>[2]
type RestoreInstallationInput = Parameters<SkillRegistryStore["restoreInstallation"]>[2]
type PatchWorkspaceSkillSetInput = Parameters<SkillRegistryStore["replaceWorkspaceSkillSet"]>[1]
type CreateReviewRequestInput = Parameters<SkillRegistryStore["createReviewRequest"]>[1]
type ResolveReviewInput = Parameters<SkillRegistryStore["approveReviewRequest"]>[1]

type SkillRow = typeof SkillTable.$inferSelect
type VersionRow = typeof SkillVersionTable.$inferSelect
type InstallationRow = typeof SkillInstallationTable.$inferSelect
type ApprovalRow = typeof SkillApprovalTable.$inferSelect
type ReviewRequestRow = typeof SkillReviewRequestTable.$inferSelect
type WorkspaceSkillSetRow = typeof WorkspaceSkillSetTable.$inferSelect
type EventRow = typeof SkillAuditEventTable.$inferSelect

const MANIFEST_LOCALE = "__manifest__"
const RETENTION_DAYS = 30

export function createDbSkillRegistryStore(database: DenDb): SkillRegistryStore {
  return new DbSkillRegistryStore(database)
}

export class DbSkillRegistryStore implements SkillRegistryStore {
  constructor(private readonly database: DenDb) {}

  async listSkills(context: SkillRegistryRouteContext, filters: Record<string, unknown> = {}) {
    const ownerScope = optionalFilterString(filters.ownerScope)
    const workspaceId = optionalFilterString(filters.workspaceId)
    const orgId = optionalFilterString(filters.orgId)
    const reviewStatus = optionalFilterString(filters.reviewStatus)
    const tag = optionalFilterString(filters.tag)
    const limit = optionalPositiveInteger(filters.limit)
    const rows = await this.database.select().from(SkillTable)
    const visibleRows: SkillRow[] = []
    for (const skill of rows) {
      if (skill.deleted_at !== null) continue
      if (!await this.isSkillVisibleToContext(skill, context)) continue
      if (ownerScope && skill.scope !== ownerScope) continue
      if (workspaceId && skill.workspace_id !== workspaceId) continue
      if (orgId && skill.org_id !== orgId) continue
      visibleRows.push(skill)
    }
    visibleRows.sort((left, right) => left.name.localeCompare(right.name))
    const skills = (await Promise.all(visibleRows.map((skill) => this.toSkillSummary(skill, context))))
      .filter((skill) => !reviewStatus || skill.reviewStatus === reviewStatus)
      .filter((skill) => !tag || skill.tags?.includes(tag))

    return {
      skills: limit ? skills.slice(0, limit) : skills,
      nextCursor: null,
    }
  }

  async createSkill(context: SkillRegistryRouteContext, input: CreateSkillInput) {
    const now = new Date()
    const owner = resolveSkillOwner(context, input)
    const name = normalizeName(input.name)
    const existing = await this.database
      .select({ id: SkillTable.id })
      .from(SkillTable)
      .where(
        and(
          eq(SkillTable.scope, input.scope),
          eq(SkillTable.scope_owner_key, owner.scopeOwnerKey),
          eq(SkillTable.name, name),
        ),
      )
      .limit(1)
    if (existing.length > 0) {
      throw new SkillRegistryStoreError(409, "skill_already_exists")
    }

    const id = newId("skill")
    await this.database.insert(SkillTable).values({
      id,
      scope: input.scope,
      scope_owner_key: owner.scopeOwnerKey,
      org_id: owner.orgId,
      owner_user_id: owner.ownerUserId,
      workspace_id: owner.workspaceId,
      name,
      display_name: input.displayName?.trim() || null,
      description: input.description?.trim() || null,
      latest_version_id: null,
      created_by_user_id: context.userId,
      deleted_at: null,
      deleted_by_user_id: null,
      purge_after: null,
      restored_at: null,
      restored_by_user_id: null,
      created_at: now,
      updated_at: now,
    })

    return this.toSkillSummary(await this.requireSkill(id), context)
  }

  async getSkill(context: SkillRegistryRouteContext, skillId: string) {
    const skill = await this.findSkill(skillId)
    if (!skill || skill.deleted_at !== null || !await this.isSkillVisibleToContext(skill, context)) {
      return null
    }
    return this.toSkillSummary(skill, context)
  }

  async createVersion(context: SkillRegistryRouteContext, input: CreateVersionInput) {
    const skill = await this.requireVisibleSkill(context, input.skillId)
    const decoded = decodePackageArchive(input.archive)
    const versions = await this.database
      .select()
      .from(SkillVersionTable)
      .where(eq(SkillVersionTable.skill_id, skill.id))
    const versionNumber = versions.reduce((max, version) => Math.max(max, version.version_number), 0) + 1
    const now = new Date()
    const versionId = newId("version")
    const status: SkillVersionStatus = skill.scope === "org" || skill.scope === "system" ? "draft" : "approved"
    const manifestSha256 = sha256Hex(JSON.stringify({
      schemaVersion: decoded.schemaVersion,
      entrypoint: decoded.entrypoint,
      files: decoded.files.map(({ contentBase64: _contentBase64, bytes: _bytes, ...file }) => file),
      metadata: decoded.metadata,
    }))

    await this.database.insert(SkillVersionTable).values({
      id: versionId,
      org_id: skill.org_id,
      skill_id: skill.id,
      version_number: versionNumber,
      status,
      manifest_sha256: manifestSha256,
      package_sha256: decoded.packageSha256,
      package_size_bytes: decoded.files.reduce((sum, file) => sum + file.sizeBytes, 0),
      file_count: decoded.files.length,
      created_by_user_id: context.userId,
      submitted_for_review_at: null,
      approved_at: status === "approved" ? now : null,
      rejected_at: null,
      archived_at: null,
      created_at: now,
    })

    for (const file of decoded.files) {
      const blob = await this.ensureBlob(file, now)
      await this.database.insert(SkillVersionFileTable).values({
        id: newId("file"),
        org_id: skill.org_id,
        version_id: versionId,
        blob_id: blob.id,
        path: file.path,
        path_sha256: skillVersionFilePathSha256(file.path),
        sha256: file.sha256,
        size_bytes: file.sizeBytes,
        media_type: file.mediaType,
        executable: file.executable === true,
        text_content: file.text ?? null,
        created_at: now,
      })
    }

    const searchDocument = buildSkillSearchDocument({
      name: decoded.metadata.name,
      description: decoded.metadata.description,
      trigger: decoded.metadata.trigger,
      tags: decoded.metadata.tags,
      files: decoded.files.map((file) => ({
        path: file.path,
        text: file.text,
        sizeBytes: file.sizeBytes,
        mediaType: file.mediaType,
      })),
    })

    await this.database.insert(SkillSearchDocumentTable).values({
      id: newId("search_doc"),
      org_id: skill.org_id,
      skill_id: skill.id,
      version_id: versionId,
      source_language: decoded.metadata.language ?? "en",
      locale: MANIFEST_LOCALE,
      title: searchDocument.title,
      body: searchDocument.body,
      translated_title: null,
      translated_body: null,
      search_text: searchDocument.searchText,
      created_at: now,
      updated_at: now,
    })

    const skillUpdate: Partial<typeof SkillTable.$inferInsert> = { updated_at: now }
    if (status === "approved") {
      skillUpdate.latest_version_id = versionId
      skillUpdate.description = skill.description ?? decoded.metadata.description ?? null
    }
    await this.database.update(SkillTable).set(skillUpdate).where(eq(SkillTable.id, skill.id))

    await this.recordEvent(context, "skill.version.created", {
      orgId: skill.org_id,
      skillId: skill.id,
      versionId,
      payload: { versionNumber, packageSha256: decoded.packageSha256 },
    })

    return toVersionSummary(await this.requireVersion(versionId))
  }

  async listVersions(context: SkillRegistryRouteContext, skillId: string) {
    const skill = await this.requireVisibleSkill(context, skillId)
    const versions = await this.database
      .select()
      .from(SkillVersionTable)
      .where(eq(SkillVersionTable.skill_id, skillId))
      .orderBy(desc(SkillVersionTable.version_number))
    return {
      versions: versions.filter((version) => canReadVersion(context, skill, version)).map(toVersionSummary),
      nextCursor: null,
    }
  }

  async getPackage(context: SkillRegistryRouteContext, versionId: string) {
    const version = await this.findVersion(versionId)
    if (!version) return null
    const skill = await this.requireVisibleSkill(context, version.skill_id)
    if (!canReadVersion(context, skill, version)) {
      return null
    }
    const metadata = await this.readVersionMetadata(version, skill)
    const files = await this.readVersionArchiveFiles(versionId)

    return {
      versionId: version.id,
      skillId: version.skill_id,
      package: {
        schemaVersion: 1 as const,
        entrypoint: "SKILL.md" as const,
        files,
        packageSha256: version.package_sha256,
        metadata,
      },
    }
  }

  async createInstallation(context: SkillRegistryRouteContext, input: CreateInstallationInput) {
    const skill = await this.requireVisibleSkill(context, input.skillId)
    const version = await this.requireVersion(input.versionId)
    if (version.skill_id !== skill.id) {
      throw new SkillRegistryStoreError(400, "version_skill_mismatch")
    }
    if ((skill.scope === "org" || skill.scope === "system") && version.status !== "approved") {
      throw new SkillRegistryStoreError(409, "version_not_approved")
    }

    const now = new Date()
    const owner = resolveInstallationOwner(context, input)
    const approval = await this.findApprovalForInstallation(
      input.scope,
      owner.orgId,
      skill.id,
      version.id,
      input.releaseChannel,
    )
    const installationId = newId("installation")
    const installationForPolicy = {
      scope: input.scope,
      status: "active" as const,
      orgId: owner.orgId,
      skillId: skill.id,
      approvalId: approval?.id ?? null,
      approvedVersionId: approval?.version_id ?? null,
    }

    if (input.scope === "org" || input.scope === "system") {
      const policyResult = validateManagedSkillInstallationApproval({
        installation: installationForPolicy,
        version: {
          id: version.id,
          orgId: version.org_id,
          skillId: version.skill_id,
          status: version.status,
        },
        approval: approval
          ? {
              id: approval.id,
              scope: approval.scope,
              orgId: approval.org_id,
              skillId: approval.skill_id,
              versionId: approval.version_id,
              revokedAt: approval.revoked_at,
            }
          : null,
      })
      if (!policyResult.ok) {
        throw new SkillRegistryStoreError(409, policyResult.code)
      }
    }

    await this.database.insert(SkillInstallationTable).values({
      id: installationId,
      scope: input.scope,
      org_id: owner.orgId,
      owner_user_id: owner.ownerUserId,
      workspace_id: owner.workspaceId,
      skill_id: skill.id,
      desired_version_id: version.id,
      approved_version_id: approval?.version_id ?? null,
      approval_id: approval?.id ?? null,
      update_policy: input.updatePolicy ?? "pinned",
      release_channel: input.releaseChannel?.trim() || null,
      status: "active",
      installed_by_user_id: context.userId,
      deleted_at: null,
      deleted_by_user_id: null,
      purge_after: null,
      restored_at: null,
      restored_by_user_id: null,
      created_at: now,
      updated_at: now,
    })

    await this.recordEvent(context, "skill.installation.changed", {
      orgId: owner.orgId,
      skillId: skill.id,
      versionId: version.id,
      installationId,
      workspaceId: owner.workspaceId,
      payload: { status: "active", updatePolicy: input.updatePolicy ?? "pinned" },
    })

    return this.toInstallationResponse(await this.requireInstallation(installationId))
  }

  async updateInstallation(context: SkillRegistryRouteContext, installationId: string, input: UpdateInstallationInput) {
    const installation = await this.findInstallation(installationId)
    if (!installation) {
      return null
    }
    enforceInstallationManagementAccess(context, installation)
    if (installation.status === "deleted") {
      throw new SkillRegistryStoreError(409, "installation_deleted")
    }
    if (input.versionId === null) {
      throw new SkillRegistryStoreError(400, "version_id_required")
    }

    const now = new Date()
    const set: Partial<typeof SkillInstallationTable.$inferInsert> = { updated_at: now }
    const skill = await this.requireVisibleSkill(context, installation.skill_id)
    const nextReleaseChannel = input.releaseChannel !== undefined ? input.releaseChannel?.trim() || null : installation.release_channel
    const targetVersion = input.versionId !== undefined
      ? input.versionId
        ? await this.requireVersion(input.versionId)
        : null
      : installation.desired_version_id
        ? await this.requireVersion(installation.desired_version_id)
        : null
    const nextStatus = input.enabled !== undefined ? input.enabled ? "active" : "disabled" : installation.status
    const approval = await this.validateInstallationVersionSelection(
      {
        ...installation,
        status: nextStatus,
        release_channel: nextReleaseChannel,
      },
      skill,
      targetVersion,
    )

    if (input.enabled !== undefined) set.status = input.enabled ? "active" : "disabled"
    if (input.versionId !== undefined) {
      set.desired_version_id = targetVersion?.id ?? null
    }
    if (input.updatePolicy) set.update_policy = input.updatePolicy
    if (input.releaseChannel !== undefined) set.release_channel = nextReleaseChannel
    if (input.versionId !== undefined || input.releaseChannel !== undefined) {
      set.approved_version_id = approval?.version_id ?? null
      set.approval_id = approval?.id ?? null
    }

    await this.database.update(SkillInstallationTable).set(set).where(eq(SkillInstallationTable.id, installationId))
    const updated = await this.requireInstallation(installationId)
    await this.recordEvent(context, "skill.installation.changed", {
      orgId: updated.org_id,
      skillId: updated.skill_id,
      versionId: updated.desired_version_id,
      installationId,
      workspaceId: updated.workspace_id,
      payload: { status: updated.status, updatePolicy: updated.update_policy },
    })
    return this.toInstallationResponse(updated)
  }

  async deleteInstallation(context: SkillRegistryRouteContext, installationId: string) {
    const installation = await this.findInstallation(installationId)
    if (!installation) {
      return null
    }
    enforceInstallationManagementAccess(context, installation)

    const now = new Date()
    await this.database
      .update(SkillInstallationTable)
      .set({
        status: "deleted",
        deleted_at: now,
        deleted_by_user_id: context.userId,
        purge_after: new Date(now.getTime() + RETENTION_DAYS * 86_400_000),
        updated_at: now,
      })
      .where(eq(SkillInstallationTable.id, installationId))
    const deleted = await this.requireInstallation(installationId)
    await this.recordEvent(context, "skill.deleted", {
      orgId: deleted.org_id,
      skillId: deleted.skill_id,
      versionId: deleted.desired_version_id,
      installationId,
      workspaceId: deleted.workspace_id,
      payload: { deletedAt: toIso(now) },
    })
    return this.toInstallationResponse(deleted)
  }

  async restoreInstallation(context: SkillRegistryRouteContext, installationId: string, input: RestoreInstallationInput) {
    const installation = await this.findInstallation(installationId)
    if (!installation) {
      return null
    }
    enforceInstallationManagementAccess(context, installation)

    const policy = evaluateSkillRegistryRetentionPolicy({
      roles: rolesForContext(context),
      deletedAt: installation.deleted_at,
      purgeAfter: installation.purge_after,
      now: new Date(),
    })
    if (!policy.canRestore) {
      throw new SkillRegistryStoreError(409, "restore_not_allowed")
    }

    const now = new Date()
    const skill = await this.requireVisibleSkill(context, installation.skill_id)
    const nextInstallation = {
      ...installation,
      status: "active" as const,
      org_id: input.orgId !== undefined ? input.orgId : installation.org_id,
      owner_user_id: input.ownerUserId !== undefined ? input.ownerUserId : installation.owner_user_id,
      workspace_id: input.workspaceId !== undefined ? input.workspaceId : installation.workspace_id,
    }
    enforceInstallationManagementAccess(context, nextInstallation)
    const targetVersion = input.versionId !== undefined
      ? input.versionId
        ? await this.requireVersion(input.versionId)
        : null
      : installation.desired_version_id
        ? await this.requireVersion(installation.desired_version_id)
        : null
    const approval = await this.validateInstallationVersionSelection(nextInstallation, skill, targetVersion)

    const set: Partial<typeof SkillInstallationTable.$inferInsert> = {
      status: "active",
      deleted_at: null,
      deleted_by_user_id: null,
      purge_after: null,
      restored_at: now,
      restored_by_user_id: context.userId,
      updated_at: now,
    }
    if (input.orgId !== undefined) set.org_id = input.orgId
    if (input.ownerUserId !== undefined) set.owner_user_id = input.ownerUserId
    if (input.workspaceId !== undefined) set.workspace_id = input.workspaceId
    if (input.versionId !== undefined) set.desired_version_id = targetVersion?.id ?? installation.desired_version_id
    set.approved_version_id = approval?.version_id ?? null
    set.approval_id = approval?.id ?? null
    await this.database.update(SkillInstallationTable).set(set).where(eq(SkillInstallationTable.id, installationId))
    const restored = await this.requireInstallation(installationId)
    await this.recordEvent(context, "skill.restored", {
      orgId: restored.org_id,
      skillId: restored.skill_id,
      versionId: restored.desired_version_id,
      installationId,
      workspaceId: restored.workspace_id,
      payload: { restoredAt: toIso(now) },
    })
    return this.toInstallationResponse(restored)
  }

  async getWorkspaceSkillSet(context: SkillRegistryRouteContext, workspaceId: string) {
    if (!context.orgId) {
      throw new SkillRegistryStoreError(403, "organization_required")
    }
    const set = await this.findLatestWorkspaceSet(context, workspaceId)
    if (!set) {
      return { workspaceId, skills: [] }
    }

    const entries = await this.database
      .select()
      .from(WorkspaceSkillSetEntryTable)
      .where(eq(WorkspaceSkillSetEntryTable.skill_set_id, set.id))
    const skills: RegistrySkillInstallation[] = []
    for (const entry of entries.sort((left, right) => left.position - right.position)) {
      const installation = await this.findInstallation(entry.installation_id)
      if (installation?.status === "active") {
        skills.push(await this.toInstallationResponse(installation, entry.desired_version_id))
      }
    }
    return { workspaceId, skills }
  }

  async replaceWorkspaceSkillSet(context: SkillRegistryRouteContext, input: PatchWorkspaceSkillSetInput) {
    const previous = await this.findLatestWorkspaceSet({ ...context, orgId: input.orgId }, input.workspaceId)
    const now = new Date()
    const preparedEntries: Array<{
      entry: PatchWorkspaceSkillSetInput["skills"][number]
      index: number
      installation: InstallationRow
      desiredVersionId: string | null
    }> = []
    for (const [index, entry] of input.skills.entries()) {
      const installation = await this.requireInstallation(entry.installationId)
      if (installation.org_id !== input.orgId || installation.workspace_id !== input.workspaceId) {
        throw new SkillRegistryStoreError(400, "workspace_installation_mismatch")
      }
      if (installation.status !== "active") {
        throw new SkillRegistryStoreError(400, "workspace_installation_inactive")
      }
      const skill = await this.requireVisibleSkill(context, installation.skill_id)
      if (preparedEntries.some((prepared) => prepared.installation.skill_id === installation.skill_id)) {
        throw new SkillRegistryStoreError(400, "workspace_skill_duplicate")
      }
      const desiredVersionId = entry.desiredVersionId ?? await this.resolveInstallationDesiredVersion(installation)
      const targetVersion = desiredVersionId ? await this.requireVersion(desiredVersionId) : null
      await this.validateInstallationVersionSelection(installation, skill, targetVersion)
      preparedEntries.push({ entry, index, installation, desiredVersionId })
    }

    const skillSetId = newId("skillset")
    await this.database.insert(WorkspaceSkillSetTable).values({
      id: skillSetId,
      org_id: input.orgId,
      workspace_id: input.workspaceId,
      name: "default",
      revision: previous ? previous.revision + 1 : 1,
      release_channel: input.releaseChannel?.trim() || null,
      created_by_user_id: context.userId,
      deleted_at: null,
      deleted_by_user_id: null,
      purge_after: null,
      restored_at: null,
      restored_by_user_id: null,
      created_at: now,
      updated_at: now,
    })

    for (const { entry, index, installation, desiredVersionId } of preparedEntries) {
      await this.database.insert(WorkspaceSkillSetEntryTable).values({
        id: newId("skillset_entry"),
        org_id: input.orgId,
        skill_set_id: skillSetId,
        installation_id: installation.id,
        skill_id: installation.skill_id,
        desired_version_id: desiredVersionId,
        release_channel: entry.releaseChannel?.trim() || installation.release_channel,
        position: index,
        created_at: now,
      })
      await this.upsertMaterialization(installation, skillSetId, desiredVersionId)
    }

    await this.recordEvent(context, "workspace.skill_set.changed", {
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      payload: { revision: previous ? previous.revision + 1 : 1 },
    })
    return this.getWorkspaceSkillSet({ ...context, orgId: input.orgId }, input.workspaceId)
  }

  async createReviewRequest(context: SkillRegistryRouteContext, input: CreateReviewRequestInput) {
    const skill = await this.requireVisibleSkill(context, input.skillId)
    const version = await this.requireVersion(input.versionId)
    if (version.skill_id !== skill.id) {
      throw new SkillRegistryStoreError(400, "version_skill_mismatch")
    }
    const orgId = input.scope === "org" ? input.orgId ?? skill.org_id ?? context.orgId ?? null : null
    if (input.scope === "org" && !orgId) throw new SkillRegistryStoreError(400, "org_id_required")
    validateReviewRequestTarget(context, skill, version, input.scope, orgId)
    await this.enforceNoPendingReviewRequest(version.id, input.scope, orgId)
    const now = new Date()
    const requestId = newId("review")
    await this.database.insert(SkillReviewRequestTable).values({
      id: requestId,
      org_id: orgId,
      scope: input.scope,
      skill_id: skill.id,
      version_id: version.id,
      status: "pending",
      requested_by_user_id: context.userId,
      reason: input.reason?.trim() || null,
      release_channel: input.releaseChannel?.trim() || null,
      reviewer_note: null,
      resolved_by_user_id: null,
      resolved_at: null,
      created_at: now,
      updated_at: now,
    })
    await this.database
      .update(SkillVersionTable)
      .set({ status: "pending_review", submitted_for_review_at: now })
      .where(eq(SkillVersionTable.id, version.id))
    return toReviewResponse(await this.requireReviewRequest(requestId))
  }

  async approveReviewRequest(context: SkillRegistryRouteContext, input: ResolveReviewInput) {
    const request = await this.findReviewRequest(input.requestId)
    if (!request) return null
    enforceReviewResolutionAccess(context, request)
    enforcePendingReviewRequest(request)
    const version = await this.requireVersion(request.version_id)
    const skill = await this.requireSkill(request.skill_id)
    const now = new Date()
    const releaseChannel = input.releaseChannel?.trim() || request.release_channel
    const approvalId = newId("approval")

    await this.database.insert(SkillApprovalTable).values({
      id: approvalId,
      org_id: request.scope === "org" ? request.org_id : null,
      scope: request.scope,
      approval_owner_key: request.scope === "org"
        ? skillApprovalOwnerKey({ scope: "org", orgId: request.org_id ?? "" })
        : skillApprovalOwnerKey({ scope: "system" }),
      skill_id: request.skill_id,
      version_id: request.version_id,
      review_request_id: request.id,
      release_channel: releaseChannel,
      release_channel_key: skillReleaseChannelKey(releaseChannel),
      approved_by_user_id: context.userId,
      approved_at: now,
      revoked_by_user_id: null,
      revoked_at: null,
    })
    await this.database
      .update(SkillReviewRequestTable)
      .set({
        status: "approved",
        reviewer_note: input.reviewerNote?.trim() || null,
        resolved_by_user_id: context.userId,
        resolved_at: now,
        updated_at: now,
      })
      .where(eq(SkillReviewRequestTable.id, request.id))
    await this.database
      .update(SkillVersionTable)
      .set({ status: "approved", approved_at: now })
      .where(eq(SkillVersionTable.id, version.id))
    await this.database
      .update(SkillTable)
      .set({ latest_version_id: version.id, updated_at: now })
      .where(eq(SkillTable.id, skill.id))

    await this.rolloutApprovedVersion(context, await this.requireApproval(approvalId))
    await this.recordEvent(context, "skill.version.approved", {
      orgId: request.scope === "system" ? null : skill.org_id,
      skillId: skill.id,
      versionId: version.id,
      payload: { approvalId, releaseChannel },
    })
    return toReviewResponse(await this.requireReviewRequest(request.id))
  }

  async rejectReviewRequest(context: SkillRegistryRouteContext, input: ResolveReviewInput) {
    const request = await this.findReviewRequest(input.requestId)
    if (!request) return null
    enforceReviewResolutionAccess(context, request)
    enforcePendingReviewRequest(request)
    const version = await this.requireVersion(request.version_id)
    if (version.status === "approved") {
      throw new SkillRegistryStoreError(409, "version_already_approved")
    }
    const now = new Date()
    await this.database
      .update(SkillReviewRequestTable)
      .set({
        status: "rejected",
        reviewer_note: input.reviewerNote?.trim() || null,
        resolved_by_user_id: context.userId,
        resolved_at: now,
        updated_at: now,
      })
      .where(eq(SkillReviewRequestTable.id, request.id))
    await this.database
      .update(SkillVersionTable)
      .set({ status: "rejected", rejected_at: now })
      .where(eq(SkillVersionTable.id, request.version_id))
    return toReviewResponse(await this.requireReviewRequest(request.id))
  }

  async searchSkills(context: SkillRegistryRouteContext, filters: Record<string, unknown> & { query?: string | null }) {
    const query = filters.query?.trim() ?? ""
    const language = optionalFilterString(filters.language)
    const listed = await this.listSkills(context, filters)
    if (!query) {
      return { query, skills: listed.skills, nextCursor: null }
    }
    const searchDocuments = await this.database.select().from(SkillSearchDocumentTable)
    const skills = listed.skills.filter((skill) => {
      const documents = skill.latestVersion
        ? searchDocuments.filter((document) => document.skill_id === skill.id && document.version_id === skill.latestVersion?.id)
        : []
      return queryMatchesSkillSearchText(query, [
        skill.name,
        skill.description,
        ...(skill.tags ?? []),
        ...documents.flatMap((document) => [
        document.title,
        document.body,
        document.translated_title,
        document.translated_body,
        document.search_text,
      ])], { language })
    })
    return { query, skills, nextCursor: null }
  }

  async listEvents(context: SkillRegistryRouteContext, filters: Record<string, unknown> = {}) {
    const orgId = optionalFilterString(filters.orgId) ?? context.orgId ?? null
    const workspaceId = optionalFilterString(filters.workspaceId)
    const cursor = parseEventCursor(optionalFilterString(filters.cursor))
    const limit = optionalPositiveInteger(filters.limit)
    const rows = await this.database.select().from(SkillAuditEventTable)
    const events = rows
      .filter((event) => isEventVisibleToContext(event, context))
      .filter((event) => !orgId || event.org_id === orgId || isGlobalRegistryEvent(event))
      .filter((event) => !workspaceId || event.workspace_id === workspaceId)
      .filter((event) => isAfterEventCursor(toIso(event.created_at), event.id, cursor))
      .sort((left, right) => toIso(left.created_at).localeCompare(toIso(right.created_at)) || left.id.localeCompare(right.id))
    const limited = limit ? events.slice(0, limit) : events
    return {
      events: limited.map(toEventResponse),
      nextCursor: eventCursorFor(limited.at(-1) ?? null),
    }
  }

  private async ensureBlob(
    file: SkillRegistryPackageArchive["files"][number] & { bytes: Buffer },
    now: Date,
  ) {
    const existing = await this.database
      .select()
      .from(SkillBlobTable)
      .where(eq(SkillBlobTable.sha256, file.sha256))
      .limit(1)
    if (existing[0]) {
      return existing[0]
    }

    const id = newId("blob")
    await this.database.insert(SkillBlobTable).values({
      id,
      sha256: file.sha256,
      size_bytes: file.sizeBytes,
      media_type: file.mediaType,
      storage_key: `skill-blobs/${file.sha256}`,
      content_base64: file.contentBase64,
      created_at: now,
    }).onDuplicateKeyUpdate({
      set: {
        sha256: sql`${SkillBlobTable.sha256}`,
      },
    })
    const row = await this.database.select().from(SkillBlobTable).where(eq(SkillBlobTable.sha256, file.sha256)).limit(1)
    if (!row[0]) {
      throw new SkillRegistryStoreError(500, "skill_blob_missing")
    }
    return row[0]
  }

  private async readVersionArchiveFiles(versionId: string): Promise<SkillRegistryPackageArchive["files"]> {
    const rows = await this.database
      .select()
      .from(SkillVersionFileTable)
      .where(eq(SkillVersionFileTable.version_id, versionId))
    const files: SkillRegistryPackageArchive["files"] = []
    for (const file of rows.sort((left, right) => left.path.localeCompare(right.path))) {
      const blob = await this.database
        .select()
        .from(SkillBlobTable)
        .where(eq(SkillBlobTable.id, file.blob_id))
        .limit(1)
      if (!blob[0]) {
        throw new SkillRegistryStoreError(500, "skill_blob_missing")
      }
      files.push({
        path: file.path,
        sha256: file.sha256,
        sizeBytes: file.size_bytes,
        mediaType: file.media_type,
        ...(file.executable ? { executable: true } : {}),
        ...(file.text_content !== null ? { text: file.text_content } : {}),
        contentBase64: blob[0].content_base64,
      })
    }
    return files
  }

  private async readVersionMetadata(version: VersionRow, skill: SkillRow): Promise<SkillRegistryPackageArchive["metadata"]> {
    const rows = await this.database
      .select()
      .from(SkillSearchDocumentTable)
      .where(and(eq(SkillSearchDocumentTable.version_id, version.id), eq(SkillSearchDocumentTable.locale, MANIFEST_LOCALE)))
      .limit(1)
    const parsed = rows[0] ? parseManifestMetadata(rows[0].search_text) : null
    return parsed ?? {
      name: skill.display_name ?? skill.name,
      ...(skill.description ? { description: skill.description } : {}),
    }
  }

  private async resolveInstallationDesiredVersion(installation: InstallationRow) {
    if (installation.update_policy !== "release_channel" && installation.update_policy !== "latest_approved") {
      return installation.desired_version_id
    }
    const approval = await this.findApprovalForInstallation(
      installation.scope,
      installation.org_id,
      installation.skill_id,
      installation.desired_version_id,
      installation.release_channel,
    )
    return approval?.version_id ?? installation.desired_version_id
  }

  private async findApprovalForInstallation(
    scope: SkillScope,
    orgId: string | null,
    skillId: string,
    versionId: string | null,
    releaseChannel: string | null | undefined,
  ) {
    const rows = await this.database
      .select()
      .from(SkillApprovalTable)
      .where(and(
        eq(SkillApprovalTable.skill_id, skillId),
        ...(releaseChannel == null ? [] : [eq(SkillApprovalTable.release_channel_key, skillReleaseChannelKey(releaseChannel))]),
        isNull(SkillApprovalTable.revoked_at),
      ))
    const candidates = rows.filter((approval) => {
      if (versionId && approval.version_id !== versionId) return false
      return approval.release_channel_key === skillReleaseChannelKey(releaseChannel) || releaseChannel == null
    })
    if (scope === "system") {
      return candidates.find((approval) => approval.scope === "system" && approval.org_id === null) ?? null
    }
    return candidates.find((approval) => approval.scope === "org" && approval.org_id === orgId)
      ?? candidates.find((approval) => approval.scope === "system" && approval.org_id === null)
      ?? null
  }

  private async rolloutApprovedVersion(context: SkillRegistryRouteContext, approval: ApprovalRow) {
    const rows = await this.database
      .select()
      .from(SkillInstallationTable)
      .where(eq(SkillInstallationTable.skill_id, approval.skill_id))
    for (const installation of rows) {
      if (installation.status !== "active") continue
      if (installation.update_policy !== "latest_approved" && installation.update_policy !== "release_channel") continue
      if (
        installation.update_policy === "release_channel" &&
        skillReleaseChannelKey(installation.release_channel) !== approval.release_channel_key
      ) continue
      if (approval.scope === "org" && installation.org_id !== approval.org_id) continue

      await this.database
        .update(SkillInstallationTable)
        .set({
          desired_version_id: approval.version_id,
          approved_version_id: approval.version_id,
          approval_id: approval.id,
          updated_at: new Date(),
        })
        .where(eq(SkillInstallationTable.id, installation.id))
      await this.database
        .update(WorkspaceSkillSetEntryTable)
        .set({ desired_version_id: approval.version_id })
        .where(eq(WorkspaceSkillSetEntryTable.installation_id, installation.id))
      await this.upsertMaterialization(
        { ...installation, desired_version_id: approval.version_id, approved_version_id: approval.version_id, approval_id: approval.id },
        (await this.findLatestWorkspaceSet(context, installation.workspace_id ?? ""))?.id ?? null,
        approval.version_id,
      )
      await this.recordEvent(context, "skill.installation.changed", {
        orgId: installation.org_id,
        skillId: installation.skill_id,
        versionId: approval.version_id,
        installationId: installation.id,
        workspaceId: installation.workspace_id,
        payload: { rollout: true },
      })
      if (installation.workspace_id) {
        await this.recordEvent(context, "workspace.skill_set.changed", {
          orgId: installation.org_id,
          workspaceId: installation.workspace_id,
          payload: { rollout: true, versionId: approval.version_id },
        })
      }
    }
  }

  private async upsertMaterialization(installation: InstallationRow, skillSetId: string | null, desiredVersionId: string | null) {
    const existing = await this.database
      .select()
      .from(SkillMaterializationTable)
      .where(eq(SkillMaterializationTable.installation_id, installation.id))
      .limit(1)
    const version = desiredVersionId ? await this.findVersion(desiredVersionId) : null
    const now = new Date()
    if (existing[0]) {
      await this.database
        .update(SkillMaterializationTable)
        .set({
          skill_set_id: skillSetId,
          desired_version_id: desiredVersionId,
          package_sha256: version?.package_sha256 ?? null,
          updated_at: now,
        })
        .where(eq(SkillMaterializationTable.id, existing[0].id))
      return
    }

    await this.database.insert(SkillMaterializationTable).values({
      id: newId("materialization"),
      org_id: installation.org_id,
      workspace_id: installation.workspace_id,
      owner_user_id: installation.owner_user_id,
      skill_set_id: skillSetId,
      installation_id: installation.id,
      skill_id: installation.skill_id,
      desired_version_id: desiredVersionId,
      actual_version_id: null,
      target_scope: installation.scope,
      target_path: materializationTargetPath(installation),
      status: "pending",
      package_sha256: version?.package_sha256 ?? null,
      last_error: null,
      materialized_at: null,
      created_at: now,
      updated_at: now,
    })
  }

  private async validateInstallationVersionSelection(
    installation: Pick<InstallationRow, "scope" | "status" | "org_id" | "skill_id" | "release_channel">,
    skill: SkillRow,
    version: VersionRow | null,
  ) {
    if (!version) {
      return null
    }
    if (version.skill_id !== installation.skill_id || version.skill_id !== skill.id) {
      throw new SkillRegistryStoreError(400, "version_skill_mismatch")
    }

    const approval = await this.findApprovalForInstallation(
      installation.scope,
      installation.org_id,
      skill.id,
      version.id,
      installation.release_channel,
    )
    if (installation.scope === "org" || installation.scope === "system") {
      const policyResult = validateManagedSkillInstallationApproval({
        installation: {
          scope: installation.scope,
          status: installation.status,
          orgId: installation.org_id,
          skillId: installation.skill_id,
          approvalId: approval?.id ?? null,
          approvedVersionId: approval?.version_id ?? null,
        },
        version: {
          id: version.id,
          orgId: version.org_id,
          skillId: version.skill_id,
          status: version.status,
        },
        approval: approval
          ? {
              id: approval.id,
              scope: approval.scope,
              orgId: approval.org_id,
              skillId: approval.skill_id,
              versionId: approval.version_id,
              revokedAt: approval.revoked_at,
            }
          : null,
      })
      if (!policyResult.ok) {
        throw new SkillRegistryStoreError(409, policyResult.code)
      }
    }

    if ((skill.scope === "org" || skill.scope === "system") && version.status !== "approved") {
      throw new SkillRegistryStoreError(409, "version_not_approved")
    }
    return approval
  }

  private async toSkillSummary(skill: SkillRow, context: SkillRegistryRouteContext): Promise<RegistrySkillSummary> {
    const latestVersion = skill.latest_version_id ? await this.findVersion(skill.latest_version_id) : null
    const visibleLatestVersion = isManagedSkillScope(skill.scope) && latestVersion?.status !== "approved" ? null : latestVersion
    const statusVersion = await this.findLatestStatusVersionForSkill(skill.id) ?? latestVersion
    const metadata = visibleLatestVersion ? await this.readVersionMetadata(visibleLatestVersion, skill) : null
    const summary: RegistrySkillSummary = {
      id: skill.id,
      slug: skill.name,
      name: skill.display_name ?? metadata?.name ?? skill.name,
      visibility: await this.visibilityForContext(skill, context),
      reviewStatus: reviewStatusForVersion(statusVersion),
      createdAt: toIso(skill.created_at),
      updatedAt: toIso(skill.updated_at),
    }
    const description = skill.description ?? metadata?.description
    if (description) summary.description = description
    if (metadata?.tags?.length) summary.tags = metadata.tags
    if (visibleLatestVersion) summary.latestVersion = toVersionSummary(visibleLatestVersion)
    return summary
  }

  private async findLatestStatusVersionForSkill(skillId: string) {
    const versions = await this.database
      .select()
      .from(SkillVersionTable)
      .where(eq(SkillVersionTable.skill_id, skillId))
      .orderBy(desc(SkillVersionTable.version_number))
      .limit(1)
    return versions[0] ?? null
  }

  private async toInstallationResponse(
    installation: InstallationRow,
    desiredVersionOverride?: string | null,
  ): Promise<RegistrySkillInstallation> {
    const versionId = desiredVersionOverride ?? await this.resolveInstallationDesiredVersion(installation)
    if (!versionId) {
      throw new SkillRegistryStoreError(409, "installation_version_unresolved")
    }
    return {
      installationId: installation.id,
      skillId: installation.skill_id,
      versionId,
      enabled: installation.status === "active",
      source: installationSourceForScope(installation.scope),
      installedAt: toIso(installation.created_at),
      updatedAt: toIso(installation.updated_at),
    }
  }

  private async enforceNoPendingReviewRequest(versionId: string, scope: SkillApprovalScope, orgId: string | null) {
    const existing = await this.database
      .select({ id: SkillReviewRequestTable.id })
      .from(SkillReviewRequestTable)
      .where(and(
        eq(SkillReviewRequestTable.version_id, versionId),
        eq(SkillReviewRequestTable.scope, scope),
        eq(SkillReviewRequestTable.status, "pending"),
        ...(orgId === null ? [isNull(SkillReviewRequestTable.org_id)] : [eq(SkillReviewRequestTable.org_id, orgId)]),
      ))
      .limit(1)
    if (existing[0]) {
      throw new SkillRegistryStoreError(409, "review_request_already_pending")
    }
  }

  private async recordEvent(
    context: SkillRegistryRouteContext,
    action: string,
    input: {
      orgId?: string | null
      skillId?: string | null
      versionId?: string | null
      installationId?: string | null
      workspaceId?: string | null
      payload?: unknown
    },
  ) {
    await this.database.insert(SkillAuditEventTable).values({
      id: newId("event"),
      org_id: input.orgId ?? null,
      skill_id: input.skillId ?? null,
      version_id: input.versionId ?? null,
      installation_id: input.installationId ?? null,
      workspace_id: input.workspaceId ?? null,
      actor_user_id: context.userId,
      action,
      payload: input.payload ?? {},
      created_at: new Date(),
    })
  }

  private async findSkill(skillId: string) {
    const rows = await this.database.select().from(SkillTable).where(eq(SkillTable.id, skillId)).limit(1)
    return rows[0] ?? null
  }

  private async requireSkill(skillId: string) {
    const skill = await this.findSkill(skillId)
    if (!skill) throw new SkillRegistryStoreError(404, "skill_not_found")
    return skill
  }

  private async requireVisibleSkill(context: SkillRegistryRouteContext, skillId: string) {
    const skill = await this.requireSkill(skillId)
    if (skill.deleted_at !== null || !await this.isSkillVisibleToContext(skill, context)) {
      throw new SkillRegistryStoreError(404, "skill_not_found")
    }
    return skill
  }

  private async isSkillVisibleToContext(skill: SkillRow, context: SkillRegistryRouteContext) {
    if (isSkillVisibleToContext(skill, context)) return true
    return Boolean(await this.findVisibleApproval(skill, context))
  }

  private async visibilityForContext(skill: SkillRow, context: SkillRegistryRouteContext): Promise<RegistrySkillVisibility> {
    const approval = await this.findVisibleApproval(skill, context)
    if (approval?.scope === "system") return "platform"
    if (approval?.scope === "org") return "organization"
    return visibilityForScope(skill.scope)
  }

  private async findVisibleApproval(skill: SkillRow, context: SkillRegistryRouteContext) {
    const approvals = await this.database
      .select()
      .from(SkillApprovalTable)
      .where(and(eq(SkillApprovalTable.skill_id, skill.id), isNull(SkillApprovalTable.revoked_at)))
    return approvals.find((approval) => approval.scope === "system" && approval.org_id === null)
      ?? approvals.find((approval) => approval.scope === "org" && context.orgId != null && approval.org_id === context.orgId)
      ?? null
  }

  private async findVersion(versionId: string) {
    const rows = await this.database.select().from(SkillVersionTable).where(eq(SkillVersionTable.id, versionId)).limit(1)
    return rows[0] ?? null
  }

  private async requireVersion(versionId: string) {
    const version = await this.findVersion(versionId)
    if (!version) throw new SkillRegistryStoreError(404, "version_not_found")
    return version
  }

  private async findInstallation(installationId: string) {
    const rows = await this.database.select().from(SkillInstallationTable).where(eq(SkillInstallationTable.id, installationId)).limit(1)
    return rows[0] ?? null
  }

  private async requireInstallation(installationId: string) {
    const installation = await this.findInstallation(installationId)
    if (!installation) throw new SkillRegistryStoreError(404, "installation_not_found")
    return installation
  }

  private async findReviewRequest(requestId: string) {
    const rows = await this.database.select().from(SkillReviewRequestTable).where(eq(SkillReviewRequestTable.id, requestId)).limit(1)
    return rows[0] ?? null
  }

  private async requireReviewRequest(requestId: string) {
    const request = await this.findReviewRequest(requestId)
    if (!request) throw new SkillRegistryStoreError(404, "review_request_not_found")
    return request
  }

  private async requireApproval(approvalId: string) {
    const rows = await this.database.select().from(SkillApprovalTable).where(eq(SkillApprovalTable.id, approvalId)).limit(1)
    if (!rows[0]) throw new SkillRegistryStoreError(404, "approval_not_found")
    return rows[0]
  }

  private async findLatestWorkspaceSet(context: SkillRegistryRouteContext, workspaceId: string): Promise<WorkspaceSkillSetRow | null> {
    const rows = await this.database
      .select()
      .from(WorkspaceSkillSetTable)
      .where(eq(WorkspaceSkillSetTable.workspace_id, workspaceId))
      .orderBy(desc(WorkspaceSkillSetTable.revision))
    return rows.find((set) => context.orgId == null || set.org_id === context.orgId) ?? null
  }
}

function resolveSkillOwner(context: SkillRegistryRouteContext, input: CreateSkillInput) {
  switch (input.scope) {
    case "user":
      return {
        scopeOwnerKey: skillScopeOwnerKey({ scope: "user", userId: context.userId }),
        orgId: null,
        ownerUserId: context.userId,
        workspaceId: null,
      }
    case "org": {
      const orgId = input.orgId ?? context.orgId
      if (!orgId) throw new SkillRegistryStoreError(400, "org_id_required")
      return {
        scopeOwnerKey: skillScopeOwnerKey({ scope: "org", orgId }),
        orgId,
        ownerUserId: null,
        workspaceId: null,
      }
    }
    case "workspace": {
      const orgId = input.orgId ?? context.orgId
      if (!orgId) throw new SkillRegistryStoreError(400, "org_id_required")
      if (!input.workspaceId) throw new SkillRegistryStoreError(400, "workspace_id_required")
      return {
        scopeOwnerKey: skillScopeOwnerKey({ scope: "workspace", orgId, workspaceId: input.workspaceId }),
        orgId,
        ownerUserId: null,
        workspaceId: input.workspaceId,
      }
    }
    case "system":
      return {
        scopeOwnerKey: skillScopeOwnerKey({ scope: "system" }),
        orgId: null,
        ownerUserId: null,
        workspaceId: null,
      }
  }
}

function resolveInstallationOwner(context: SkillRegistryRouteContext, input: CreateInstallationInput) {
  switch (input.scope) {
    case "user": {
      const ownerUserId = input.ownerUserId ?? context.userId
      if (ownerUserId !== context.userId && !context.isPlatformAdmin) {
        throw new SkillRegistryStoreError(403, "forbidden")
      }
      return {
        orgId: null,
        ownerUserId,
        workspaceId: null,
      }
    }
    case "org": {
      const orgId = input.orgId ?? context.orgId
      if (!orgId) throw new SkillRegistryStoreError(400, "org_id_required")
      return { orgId, ownerUserId: null, workspaceId: null }
    }
    case "workspace": {
      const orgId = input.orgId ?? context.orgId
      if (!orgId) throw new SkillRegistryStoreError(400, "org_id_required")
      if (!input.workspaceId) throw new SkillRegistryStoreError(400, "workspace_id_required")
      return { orgId, ownerUserId: null, workspaceId: input.workspaceId }
    }
    case "system":
      return { orgId: null, ownerUserId: null, workspaceId: null }
  }
}

function normalizeName(name: string) {
  const normalized = name.trim()
  if (!normalized) throw new SkillRegistryStoreError(400, "skill_name_required")
  return normalized
}

function optionalFilterString(value: unknown) {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed || null
}

function optionalPositiveInteger(value: unknown) {
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : typeof value === "number" ? value : Number.NaN
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function newId(prefix: string) {
  return `${prefix}_${randomUUID()}`
}

function toIso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function visibilityForScope(scope: SkillScope): RegistrySkillSummary["visibility"] {
  switch (scope) {
    case "user":
      return "personal"
    case "workspace":
      return "workspace"
    case "org":
      return "organization"
    case "system":
      return "platform"
  }
}

function reviewStatusForVersion(version: VersionRow | null): RegistrySkillSummary["reviewStatus"] {
  switch (version?.status) {
    case "pending_review":
      return "pending_review"
    case "approved":
      return "approved"
    case "rejected":
    case "archived":
      return "rejected"
    case "draft":
    case undefined:
      return "draft"
  }
}

function toVersionSummary(version: VersionRow): RegistrySkillVersionSummary {
  return {
    id: version.id,
    version: String(version.version_number),
    packageSha256: version.package_sha256,
    createdAt: toIso(version.created_at),
  }
}

function toReviewResponse(request: ReviewRequestRow): RegistryReviewResponse {
  return {
    requestId: request.id,
    skillId: request.skill_id,
    status: request.status === "pending" ? "pending_review" : request.status === "cancelled" ? "rejected" : request.status,
    createdAt: toIso(request.created_at),
    updatedAt: toIso(request.updated_at),
  }
}

function toEventResponse(event: EventRow): RegistrySkillEvent {
  return {
    id: event.id,
    orgId: event.org_id,
    skillId: event.skill_id,
    versionId: event.version_id,
    installationId: event.installation_id,
    workspaceId: event.workspace_id,
    actorUserId: event.actor_user_id,
    action: event.action,
    payload: event.payload,
    createdAt: toIso(event.created_at),
  }
}

function isSkillVisibleToContext(skill: SkillRow, context: SkillRegistryRouteContext) {
  if (context.isPlatformAdmin) return true
  switch (skill.scope) {
    case "system":
      return true
    case "user":
      return skill.owner_user_id === context.userId
    case "org":
    case "workspace":
      return Boolean(context.orgId && skill.org_id === context.orgId)
  }
}

function isEventVisibleToContext(event: EventRow, context: SkillRegistryRouteContext) {
  if (context.isPlatformAdmin) return true
  if (event.org_id) return Boolean(context.orgId && event.org_id === context.orgId)
  if (event.action === "skill.version.approved") return true
  return event.actor_user_id === context.userId
}

function isGlobalRegistryEvent(event: EventRow) {
  return event.org_id === null && event.action === "skill.version.approved"
}

function validateReviewRequestTarget(
  context: SkillRegistryRouteContext,
  skill: SkillRow,
  version: VersionRow,
  scope: SkillApprovalScope,
  orgId: string | null,
) {
  if (isManagedSkillScope(skill.scope) && version.status === "approved") {
    throw new SkillRegistryStoreError(409, "version_already_approved")
  }
  if (skill.scope === "system") {
    if (scope !== "system") {
      throw new SkillRegistryStoreError(400, "review_scope_mismatch")
    }
    if (!context.isPlatformAdmin) {
      throw new SkillRegistryStoreError(403, "forbidden")
    }
  }
  if (scope === "org" && skill.scope === "org" && skill.org_id !== orgId) {
    throw new SkillRegistryStoreError(403, "organization_forbidden")
  }
}

function enforceInstallationManagementAccess(
  context: SkillRegistryRouteContext,
  installation: Pick<InstallationRow, "scope" | "org_id" | "owner_user_id">,
) {
  if (canManageInstallation(context, installation)) return
  throw new SkillRegistryStoreError(403, "forbidden")
}

function canManageInstallation(
  context: SkillRegistryRouteContext,
  installation: Pick<InstallationRow, "scope" | "org_id" | "owner_user_id">,
) {
  if (context.isPlatformAdmin) return true
  switch (installation.scope) {
    case "system":
      return false
    case "user":
      return installation.owner_user_id === context.userId
    case "org":
    case "workspace":
      return Boolean(context.orgId && installation.org_id === context.orgId && context.orgRole === "owner")
  }
}

function canReadVersion(context: SkillRegistryRouteContext, skill: SkillRow, version: VersionRow) {
  if (!isManagedSkillScope(skill.scope) || version.status === "approved") return true
  if (context.isPlatformAdmin) return true
  if (skill.scope === "org") {
    return Boolean(context.orgId && context.orgId === skill.org_id && context.orgRole === "owner")
  }
  return false
}

function isManagedSkillScope(scope: SkillScope) {
  return scope === "org" || scope === "system"
}

type EventCursor = {
  createdAt: string
  id: string | null
}

function parseEventCursor(value: string | null): EventCursor | null {
  if (!value) return null
  const [createdAt, id] = value.split("|")
  return createdAt ? { createdAt, id: id || null } : null
}

function isAfterEventCursor(createdAt: string, id: string, cursor: EventCursor | null) {
  if (!cursor) return true
  if (createdAt > cursor.createdAt) return true
  if (createdAt < cursor.createdAt) return false
  return cursor.id != null && id > cursor.id
}

function eventCursorFor(event: EventRow | null) {
  return event ? `${toIso(event.created_at)}|${event.id}` : null
}

function installationSourceForScope(scope: SkillScope): RegistrySkillInstallation["source"] {
  switch (scope) {
    case "user":
      return "personal"
    case "workspace":
      return "workspace"
    case "org":
    case "system":
      return "organization"
  }
}

function rolesForContext(context: SkillRegistryRouteContext): SkillRegistryRetentionRole[] {
  const roles: SkillRegistryRetentionRole[] = ["member"]
  if (context.orgRole === "owner") roles.push("owner")
  if (context.isPlatformAdmin) roles.push("platform_admin")
  return roles
}

function materializationTargetPath(installation: InstallationRow) {
  if (installation.scope === "workspace") {
    return `workspace:${installation.workspace_id ?? "unknown"}`
  }
  if (installation.scope === "user") {
    return `user:${installation.owner_user_id ?? "unknown"}`
  }
  if (installation.scope === "org") {
    return `org:${installation.org_id ?? "unknown"}`
  }
  return "system"
}

function enforceReviewResolutionAccess(context: SkillRegistryRouteContext, request: ReviewRequestRow) {
  if (context.isPlatformAdmin) return
  if (request.scope === "system") {
    throw new SkillRegistryStoreError(403, "forbidden")
  }
  if (!request.org_id || context.orgId !== request.org_id || context.orgRole !== "owner") {
    throw new SkillRegistryStoreError(403, "insufficient_role")
  }
}

function enforcePendingReviewRequest(request: ReviewRequestRow) {
  if (request.status !== "pending") {
    throw new SkillRegistryStoreError(409, "review_request_already_resolved")
  }
}

function parseManifestMetadata(value: string): SkillRegistryPackageArchive["metadata"] | null {
  try {
    const parsed = JSON.parse(value) as { metadata?: SkillRegistryPackageArchive["metadata"] }
    if (parsed.metadata?.name) {
      return parsed.metadata
    }
  } catch {
    return null
  }
  return null
}

function decodePackageArchive(value: unknown) {
  try {
    return decodeSkillRegistryPackageArchive(value)
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid skill package"
    throw new SkillRegistryStoreError(400, "invalid_skill_package", message)
  }
}
