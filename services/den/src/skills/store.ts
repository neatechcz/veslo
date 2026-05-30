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
  hasRolloutTargetConflict,
  rolloutPolicyOwnerKey,
  skillApprovalOwnerKey,
  skillReleaseChannelKey,
  skillScopeOwnerKey,
  skillVersionFilePathSha256,
  validateManagedSkillInstallationApproval,
  validateRolloutPolicyApproval,
  type SkillRegistryRetentionRole,
} from "./policy.js"
import type {
  SkillApprovalScope,
  SkillInstallationStatus,
  SkillInstallationUpdatePolicy,
  SkillRolloutAudience,
  SkillRolloutCatalogScope,
  SkillRolloutRemovalPolicy,
  SkillRolloutTarget,
  SkillReviewRequestStatus,
  SkillScope,
  SkillVersionStatus,
} from "./schema.js"

export type SkillRegistryRouteContext = {
  userId: string
  orgId?: string | null
  orgRole?: "owner" | "member" | null
  isPlatformAdmin?: boolean
}

export type RegistrySkillVisibility = "personal" | "workspace" | "organization" | "platform"
export type RegistrySkillReviewStatus = "draft" | "pending_review" | "approved" | "rejected"
export type RegistrySkillInstallationSource = "personal" | "workspace" | "organization"

export type RegistrySkillVersionSummary = {
  id: string
  version: string
  packageSha256: string
  createdAt: string
}

export type RegistrySkillSummary = {
  id: string
  slug: string
  name: string
  description?: string
  tags?: string[]
  visibility: RegistrySkillVisibility
  reviewStatus: RegistrySkillReviewStatus
  createdAt: string
  updatedAt: string
  latestVersion?: RegistrySkillVersionSummary
}

export type RegistrySkillInstallation = {
  installationId: string
  skillId: string
  versionId: string
  enabled: boolean
  source: RegistrySkillInstallationSource
  installedAt: string
  updatedAt?: string
}

export type RegistrySkillRolloutCatalogScope = SkillRolloutCatalogScope
export type RegistrySkillRolloutTarget = SkillRolloutTarget
export type RegistrySkillRolloutAudience = SkillRolloutAudience
export type RegistrySkillRolloutRemovalPolicy = SkillRolloutRemovalPolicy

export type RegistrySkillRolloutPolicy = {
  id: string
  skillId: string
  versionId: string | null
  target: RegistrySkillRolloutTarget
  audience: RegistrySkillRolloutAudience
  catalogScope: RegistrySkillRolloutCatalogScope
  orgId?: string | null
  userId?: string | null
  workspaceId?: string | null
  enabled: boolean
  updatePolicy: SkillInstallationUpdatePolicy
  releaseChannel?: string | null
  removalPolicy: RegistrySkillRolloutRemovalPolicy
  createdAt: string
  updatedAt?: string
}

export type RegistrySkillRolloutPolicyResponse = {
  policy: RegistrySkillRolloutPolicy
}

export type RegistrySkillRolloutPoliciesResponse = {
  policies: RegistrySkillRolloutPolicy[]
  nextCursor?: string | null
}

export type RegistryReviewResponse = {
  requestId: string
  skillId: string
  status: "pending_review" | "approved" | "rejected"
  createdAt: string
  updatedAt?: string
}

export type RegistrySkillEvent = {
  id: string
  orgId: string | null
  skillId: string | null
  versionId: string | null
  installationId: string | null
  workspaceId: string | null
  actorUserId: string
  action: string
  payload: unknown
  createdAt: string
}

type StoredSkill = {
  id: string
  scope: SkillScope
  scopeOwnerKey: string
  orgId: string | null
  ownerUserId: string | null
  workspaceId: string | null
  name: string
  displayName: string | null
  description: string | null
  latestVersionId: string | null
  createdByUserId: string
  deletedAt: string | null
  deletedByUserId: string | null
  purgeAfter: string | null
  restoredAt: string | null
  restoredByUserId: string | null
  createdAt: string
  updatedAt: string
}

type StoredVersion = {
  id: string
  orgId: string | null
  skillId: string
  versionNumber: number
  status: SkillVersionStatus
  manifestSha256: string
  packageSha256: string
  packageSizeBytes: number
  fileCount: number
  createdByUserId: string
  submittedForReviewAt: string | null
  approvedAt: string | null
  rejectedAt: string | null
  archivedAt: string | null
  createdAt: string
  metadata: SkillRegistryPackageArchive["metadata"]
  entrypoint: "SKILL.md"
}

type StoredBlob = {
  id: string
  sha256: string
  sizeBytes: number
  mediaType: string
  storageKey: string
  contentBase64: string
  createdAt: string
}

type StoredVersionFile = {
  id: string
  orgId: string | null
  versionId: string
  blobId: string
  path: string
  pathSha256: string
  sha256: string
  sizeBytes: number
  mediaType: string
  executable: boolean
  text: string | null
  createdAt: string
}

type StoredInstallation = {
  id: string
  scope: SkillScope
  orgId: string | null
  ownerUserId: string | null
  workspaceId: string | null
  skillId: string
  desiredVersionId: string | null
  approvedVersionId: string | null
  approvalId: string | null
  updatePolicy: SkillInstallationUpdatePolicy
  releaseChannel: string | null
  status: SkillInstallationStatus
  installedByUserId: string
  deletedAt: string | null
  deletedByUserId: string | null
  purgeAfter: string | null
  restoredAt: string | null
  restoredByUserId: string | null
  createdAt: string
  updatedAt: string
}

type StoredRolloutPolicy = {
  id: string
  orgId: string | null
  skillId: string
  desiredVersionId: string | null
  releaseChannel: string | null
  updatePolicy: SkillInstallationUpdatePolicy
  catalogScope: SkillRolloutCatalogScope
  ownerOrgId: string | null
  target: SkillRolloutTarget
  audience: SkillRolloutAudience
  userId: string | null
  workspaceId: string | null
  enabled: boolean
  removalPolicy: SkillRolloutRemovalPolicy
  createdByUserId: string
  deletedAt: string | null
  deletedByUserId: string | null
  purgeAfter: string | null
  restoredAt: string | null
  restoredByUserId: string | null
  createdAt: string
  updatedAt: string
}

type StoredWorkspaceSkillSet = {
  id: string
  orgId: string
  workspaceId: string
  name: string
  revision: number
  releaseChannel: string | null
  createdByUserId: string
  createdAt: string
  updatedAt: string
}

type StoredWorkspaceSkillSetEntry = {
  id: string
  orgId: string
  skillSetId: string
  installationId: string
  skillId: string
  desiredVersionId: string | null
  releaseChannel: string | null
  position: number
  createdAt: string
}

type StoredMaterialization = {
  id: string
  orgId: string | null
  workspaceId: string | null
  ownerUserId: string | null
  skillSetId: string | null
  installationId: string
  skillId: string
  desiredVersionId: string | null
  actualVersionId: string | null
  targetScope: SkillScope
  targetPath: string
  status: "pending" | "materialized" | "failed" | "stale"
  packageSha256: string | null
  lastError: string | null
  materializedAt: string | null
  createdAt: string
  updatedAt: string
}

type StoredReviewRequest = {
  id: string
  orgId: string | null
  scope: SkillApprovalScope
  skillId: string
  versionId: string
  status: SkillReviewRequestStatus
  requestedByUserId: string
  reason: string | null
  reviewerNote: string | null
  resolvedByUserId: string | null
  resolvedAt: string | null
  releaseChannel: string | null
  createdAt: string
  updatedAt: string
}

type StoredApproval = {
  id: string
  orgId: string | null
  scope: SkillApprovalScope
  approvalOwnerKey: string
  skillId: string
  versionId: string
  reviewRequestId: string | null
  releaseChannel: string | null
  releaseChannelKey: string
  approvedByUserId: string
  approvedAt: string
  revokedByUserId: string | null
  revokedAt: string | null
}

export type StoredAuditEvent = {
  id: string
  orgId: string | null
  skillId: string | null
  versionId: string | null
  installationId: string | null
  workspaceId: string | null
  actorUserId: string
  action: string
  payload: unknown
  createdAt: string
}

type CreateSkillInput = {
  scope: SkillScope
  orgId?: string | null
  workspaceId?: string | null
  name: string
  displayName?: string | null
  description?: string | null
}

type CreateVersionInput = {
  skillId: string
  archive: unknown
}

type CreateInstallationInput = {
  scope: SkillScope
  orgId?: string | null
  ownerUserId?: string | null
  workspaceId?: string | null
  skillId: string
  versionId: string
  updatePolicy?: SkillInstallationUpdatePolicy
  releaseChannel?: string | null
}

type UpdateInstallationInput = {
  enabled?: boolean
  versionId?: string | null
  updatePolicy?: SkillInstallationUpdatePolicy
  releaseChannel?: string | null
}

export type CreateRolloutPolicyInput = {
  skillId: string
  versionId?: string | null
  target: SkillRolloutTarget
  audience: SkillRolloutAudience
  catalogScope: SkillRolloutCatalogScope
  orgId?: string | null
  userId?: string | null
  workspaceId?: string | null
  updatePolicy?: SkillInstallationUpdatePolicy
  releaseChannel?: string | null
  removalPolicy?: SkillRolloutRemovalPolicy
}

export type UpdateRolloutPolicyInput = {
  versionId?: string | null
  target?: SkillRolloutTarget
  audience?: SkillRolloutAudience
  orgId?: string | null
  userId?: string | null
  workspaceId?: string | null
  enabled?: boolean
  updatePolicy?: SkillInstallationUpdatePolicy
  releaseChannel?: string | null
  removalPolicy?: SkillRolloutRemovalPolicy
}

type RestoreInstallationInput = {
  orgId?: string | null
  ownerUserId?: string | null
  workspaceId?: string | null
  versionId?: string | null
}

type PatchWorkspaceSkillSetInput = {
  orgId: string
  workspaceId: string
  releaseChannel?: string | null
  skills: Array<{
    installationId: string
    desiredVersionId?: string | null
    releaseChannel?: string | null
  }>
}

type CreateReviewRequestInput = {
  skillId: string
  versionId: string
  scope: SkillApprovalScope
  orgId?: string | null
  reason?: string | null
  releaseChannel?: string | null
}

type ResolveReviewInput = {
  requestId: string
  reviewerNote?: string | null
  releaseChannel?: string | null
}

export type SkillRegistryStoreSnapshot = {
  skills: StoredSkill[]
  versions: StoredVersion[]
  blobs: StoredBlob[]
  versionFiles: StoredVersionFile[]
  installations: StoredInstallation[]
  rolloutPolicies: StoredRolloutPolicy[]
  workspaceSkillSets: StoredWorkspaceSkillSet[]
  workspaceSkillSetEntries: StoredWorkspaceSkillSetEntry[]
  materializations: StoredMaterialization[]
  reviewRequests: StoredReviewRequest[]
  approvals: StoredApproval[]
  events: StoredAuditEvent[]
}

export interface SkillRegistryStore {
  listSkills(context: SkillRegistryRouteContext, filters?: Record<string, unknown>): Promise<{ skills: RegistrySkillSummary[]; nextCursor?: string | null }>
  createSkill(context: SkillRegistryRouteContext, input: CreateSkillInput): Promise<RegistrySkillSummary>
  getSkill(context: SkillRegistryRouteContext, skillId: string): Promise<RegistrySkillSummary | null>
  createVersion(context: SkillRegistryRouteContext, input: CreateVersionInput): Promise<RegistrySkillVersionSummary>
  listVersions(context: SkillRegistryRouteContext, skillId: string): Promise<{ versions: RegistrySkillVersionSummary[]; nextCursor?: string | null }>
  getPackage(context: SkillRegistryRouteContext, versionId: string): Promise<{ versionId: string; skillId: string; package: SkillRegistryPackageArchive } | null>
  createInstallation(context: SkillRegistryRouteContext, input: CreateInstallationInput): Promise<RegistrySkillInstallation>
  updateInstallation(context: SkillRegistryRouteContext, installationId: string, input: UpdateInstallationInput): Promise<RegistrySkillInstallation | null>
  deleteInstallation(context: SkillRegistryRouteContext, installationId: string): Promise<RegistrySkillInstallation | null>
  restoreInstallation(context: SkillRegistryRouteContext, installationId: string, input: RestoreInstallationInput): Promise<RegistrySkillInstallation | null>
  listRolloutPolicies(context: SkillRegistryRouteContext, filters?: Record<string, unknown>): Promise<RegistrySkillRolloutPoliciesResponse>
  createRolloutPolicy(context: SkillRegistryRouteContext, input: CreateRolloutPolicyInput): Promise<RegistrySkillRolloutPolicy>
  updateRolloutPolicy(context: SkillRegistryRouteContext, policyId: string, input: UpdateRolloutPolicyInput): Promise<RegistrySkillRolloutPolicy | null>
  deleteRolloutPolicy(context: SkillRegistryRouteContext, policyId: string): Promise<RegistrySkillRolloutPolicy | null>
  getWorkspaceSkillSet(context: SkillRegistryRouteContext, workspaceId: string): Promise<{ workspaceId: string; skills: RegistrySkillInstallation[] }>
  replaceWorkspaceSkillSet(context: SkillRegistryRouteContext, input: PatchWorkspaceSkillSetInput): Promise<{ workspaceId: string; skills: RegistrySkillInstallation[] }>
  createReviewRequest(context: SkillRegistryRouteContext, input: CreateReviewRequestInput): Promise<RegistryReviewResponse>
  approveReviewRequest(context: SkillRegistryRouteContext, input: ResolveReviewInput): Promise<RegistryReviewResponse | null>
  rejectReviewRequest(context: SkillRegistryRouteContext, input: ResolveReviewInput): Promise<RegistryReviewResponse | null>
  searchSkills(context: SkillRegistryRouteContext, filters: Record<string, unknown> & { query?: string | null }): Promise<{ query: string; skills: RegistrySkillSummary[]; nextCursor?: string | null }>
  listEvents(context: SkillRegistryRouteContext, filters?: Record<string, unknown>): Promise<{ events: RegistrySkillEvent[]; nextCursor?: string | null }>
}

export class SkillRegistryStoreError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message = code,
  ) {
    super(message)
    this.name = "SkillRegistryStoreError"
  }
}

export class InMemorySkillRegistryStore implements SkillRegistryStore {
  private readonly skills = new Map<string, StoredSkill>()
  private readonly versions = new Map<string, StoredVersion>()
  private readonly blobs = new Map<string, StoredBlob>()
  private readonly versionFiles = new Map<string, StoredVersionFile>()
  private readonly installations = new Map<string, StoredInstallation>()
  private readonly rolloutPolicies = new Map<string, StoredRolloutPolicy>()
  private readonly workspaceSkillSets = new Map<string, StoredWorkspaceSkillSet>()
  private readonly workspaceSkillSetEntries = new Map<string, StoredWorkspaceSkillSetEntry>()
  private readonly materializations = new Map<string, StoredMaterialization>()
  private readonly reviewRequests = new Map<string, StoredReviewRequest>()
  private readonly approvals = new Map<string, StoredApproval>()
  private readonly events: StoredAuditEvent[] = []
  private readonly now: () => Date

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date())
  }

  snapshot(): SkillRegistryStoreSnapshot {
    return {
      skills: Array.from(this.skills.values()),
      versions: Array.from(this.versions.values()),
      blobs: Array.from(this.blobs.values()),
      versionFiles: Array.from(this.versionFiles.values()),
      installations: Array.from(this.installations.values()),
      rolloutPolicies: Array.from(this.rolloutPolicies.values()),
      workspaceSkillSets: Array.from(this.workspaceSkillSets.values()),
      workspaceSkillSetEntries: Array.from(this.workspaceSkillSetEntries.values()),
      materializations: Array.from(this.materializations.values()),
      reviewRequests: Array.from(this.reviewRequests.values()),
      approvals: Array.from(this.approvals.values()),
      events: [...this.events],
    }
  }

  async listSkills(context: SkillRegistryRouteContext, filters: Record<string, unknown> = {}) {
    const ownerScope = optionalFilterString(filters.ownerScope)
    const workspaceId = optionalFilterString(filters.workspaceId)
    const orgId = optionalFilterString(filters.orgId)
    const reviewStatus = optionalFilterString(filters.reviewStatus)
    const tag = optionalFilterString(filters.tag)
    const limit = optionalPositiveInteger(filters.limit)
    const skills = Array.from(this.skills.values())
      .filter((skill) => skill.deletedAt === null)
      .filter((skill) => this.isSkillVisibleToContext(skill, context))
      .filter((skill) => !ownerScope || skill.scope === ownerScope)
      .filter((skill) => !workspaceId || skill.workspaceId === workspaceId)
      .filter((skill) => !orgId || skill.orgId === orgId)
      .map((skill) => this.toSkillSummary(skill, context))
      .filter((skill) => !reviewStatus || skill.reviewStatus === reviewStatus)
      .filter((skill) => !tag || skill.tags?.includes(tag))
      .sort((left, right) => left.name.localeCompare(right.name))

    return { skills: limit ? skills.slice(0, limit) : skills, nextCursor: null }
  }

  async createSkill(context: SkillRegistryRouteContext, input: CreateSkillInput) {
    const now = this.isoNow()
    const owner = resolveSkillOwner(context, input)
    const skill: StoredSkill = {
      id: newId("skill"),
      scope: input.scope,
      scopeOwnerKey: owner.scopeOwnerKey,
      orgId: owner.orgId,
      ownerUserId: owner.ownerUserId,
      workspaceId: owner.workspaceId,
      name: normalizeName(input.name),
      displayName: input.displayName?.trim() || null,
      description: input.description?.trim() || null,
      latestVersionId: null,
      createdByUserId: context.userId,
      deletedAt: null,
      deletedByUserId: null,
      purgeAfter: null,
      restoredAt: null,
      restoredByUserId: null,
      createdAt: now,
      updatedAt: now,
    }

    if (
      Array.from(this.skills.values()).some(
        (entry) => entry.scope === skill.scope && entry.scopeOwnerKey === skill.scopeOwnerKey && entry.name === skill.name,
      )
    ) {
      throw new SkillRegistryStoreError(409, "skill_already_exists")
    }

    this.skills.set(skill.id, skill)
    return this.toSkillSummary(skill, context)
  }

  async getSkill(context: SkillRegistryRouteContext, skillId: string) {
    const skill = this.skills.get(skillId)
    if (!skill || skill.deletedAt !== null || !this.isSkillVisibleToContext(skill, context)) {
      return null
    }
    return this.toSkillSummary(skill, context)
  }

  async createVersion(context: SkillRegistryRouteContext, input: CreateVersionInput) {
    const skill = this.requireVisibleSkill(context, input.skillId)
    const decoded = decodePackageArchive(input.archive)
    const existingVersions = Array.from(this.versions.values()).filter((version) => version.skillId === skill.id)
    const versionNumber = existingVersions.length + 1
    const now = this.isoNow()
    const status: SkillVersionStatus = skill.scope === "org" || skill.scope === "system" ? "draft" : "approved"
    const version: StoredVersion = {
      id: newId("version"),
      orgId: skill.orgId,
      skillId: skill.id,
      versionNumber,
      status,
      manifestSha256: sha256Hex(JSON.stringify({
        schemaVersion: decoded.schemaVersion,
        entrypoint: decoded.entrypoint,
        files: decoded.files.map(({ contentBase64: _contentBase64, bytes: _bytes, ...file }) => file),
        metadata: decoded.metadata,
      })),
      packageSha256: decoded.packageSha256,
      packageSizeBytes: decoded.files.reduce((sum, file) => sum + file.sizeBytes, 0),
      fileCount: decoded.files.length,
      createdByUserId: context.userId,
      submittedForReviewAt: null,
      approvedAt: status === "approved" ? now : null,
      rejectedAt: null,
      archivedAt: null,
      createdAt: now,
      metadata: decoded.metadata,
      entrypoint: decoded.entrypoint,
    }
    this.versions.set(version.id, version)

    for (const file of decoded.files) {
      let blob = this.blobs.get(file.sha256)
      if (!blob) {
        blob = {
          id: newId("blob"),
          sha256: file.sha256,
          sizeBytes: file.sizeBytes,
          mediaType: file.mediaType,
          storageKey: `skill-blobs/${file.sha256}`,
          contentBase64: file.contentBase64,
          createdAt: now,
        }
        this.blobs.set(blob.sha256, blob)
      }

      const versionFile: StoredVersionFile = {
        id: newId("file"),
        orgId: skill.orgId,
        versionId: version.id,
        blobId: blob.id,
        path: file.path,
        pathSha256: skillVersionFilePathSha256(file.path),
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
        mediaType: file.mediaType,
        executable: file.executable === true,
        text: file.text ?? null,
        createdAt: now,
      }
      this.versionFiles.set(versionFile.id, versionFile)
    }

    if (status === "approved") {
      skill.latestVersionId = version.id
      skill.description = skill.description ?? decoded.metadata.description ?? null
    }
    skill.updatedAt = now
    this.recordEvent(context, "skill.version.created", {
      orgId: skill.orgId,
      skillId: skill.id,
      versionId: version.id,
      payload: { versionNumber, packageSha256: version.packageSha256 },
    })
    return toVersionSummary(version)
  }

  async listVersions(context: SkillRegistryRouteContext, skillId: string) {
    const skill = this.requireVisibleSkill(context, skillId)
    const versions = Array.from(this.versions.values())
      .filter((version) => version.skillId === skillId)
      .filter((version) => canReadVersion(context, skill, version))
      .sort((left, right) => right.versionNumber - left.versionNumber)
      .map(toVersionSummary)
    return { versions, nextCursor: null }
  }

  async getPackage(context: SkillRegistryRouteContext, versionId: string) {
    const version = this.versions.get(versionId)
    if (!version) return null
    const skill = this.requireVisibleSkill(context, version.skillId)
    if (!canReadVersion(context, skill, version)) {
      return null
    }

    const files = Array.from(this.versionFiles.values())
      .filter((file) => file.versionId === versionId)
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((file) => {
        const blob = Array.from(this.blobs.values()).find((entry) => entry.id === file.blobId)
        if (!blob) {
          throw new SkillRegistryStoreError(500, "skill_blob_missing")
        }
        return {
          path: file.path,
          sha256: file.sha256,
          sizeBytes: file.sizeBytes,
          mediaType: file.mediaType,
          ...(file.executable ? { executable: true } : {}),
          ...(file.text !== null ? { text: file.text } : {}),
          contentBase64: blob.contentBase64,
        }
      })

    return {
      versionId: version.id,
      skillId: version.skillId,
      package: {
        schemaVersion: 1 as const,
        entrypoint: version.entrypoint,
        files,
        packageSha256: version.packageSha256,
        metadata: version.metadata,
      },
    }
  }

  async createInstallation(context: SkillRegistryRouteContext, input: CreateInstallationInput) {
    const skill = this.requireVisibleSkill(context, input.skillId)
    const version = this.requireVersion(input.versionId)
    if (version.skillId !== skill.id) {
      throw new SkillRegistryStoreError(400, "version_skill_mismatch")
    }
    const now = this.isoNow()
    const owner = resolveInstallationOwner(context, input)
    const approval = this.findApprovalForInstallation(input.scope, owner.orgId, skill.id, version.id, input.releaseChannel)
    const installation: StoredInstallation = {
      id: newId("installation"),
      scope: input.scope,
      orgId: owner.orgId,
      ownerUserId: owner.ownerUserId,
      workspaceId: owner.workspaceId,
      skillId: skill.id,
      desiredVersionId: version.id,
      approvedVersionId: approval?.versionId ?? null,
      approvalId: approval?.id ?? null,
      updatePolicy: input.updatePolicy ?? "pinned",
      releaseChannel: input.releaseChannel?.trim() || null,
      status: "active",
      installedByUserId: context.userId,
      deletedAt: null,
      deletedByUserId: null,
      purgeAfter: null,
      restoredAt: null,
      restoredByUserId: null,
      createdAt: now,
      updatedAt: now,
    }

    if (input.scope === "org" || input.scope === "system") {
      const policyResult = validateManagedSkillInstallationApproval({
        installation: {
          scope: installation.scope,
          status: installation.status,
          orgId: installation.orgId,
          skillId: installation.skillId,
          approvalId: installation.approvalId,
          approvedVersionId: installation.approvedVersionId,
        },
        version: {
          id: version.id,
          orgId: version.orgId,
          skillId: version.skillId,
          status: version.status,
        },
        approval: approval
          ? {
              id: approval.id,
              scope: approval.scope,
              orgId: approval.orgId,
              skillId: approval.skillId,
              versionId: approval.versionId,
              revokedAt: approval.revokedAt,
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

    this.installations.set(installation.id, installation)
    this.recordEvent(context, "skill.installation.changed", {
      orgId: installation.orgId,
      skillId: skill.id,
      versionId: version.id,
      installationId: installation.id,
      workspaceId: installation.workspaceId,
      payload: { status: installation.status, updatePolicy: installation.updatePolicy },
    })
    return this.toInstallationResponse(installation)
  }

  async updateInstallation(context: SkillRegistryRouteContext, installationId: string, input: UpdateInstallationInput) {
    const installation = this.installations.get(installationId)
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

    const now = this.isoNow()
    const skill = this.requireVisibleSkill(context, installation.skillId)
    const nextReleaseChannel = input.releaseChannel !== undefined ? input.releaseChannel?.trim() || null : installation.releaseChannel
    const targetVersion = input.versionId !== undefined
      ? input.versionId
        ? this.requireVersion(input.versionId)
        : null
      : installation.desiredVersionId
        ? this.requireVersion(installation.desiredVersionId)
        : null
    const nextStatus = input.enabled !== undefined ? input.enabled ? "active" : "disabled" : installation.status
    const approval = this.validateInstallationVersionSelection(
      { ...installation, status: nextStatus, releaseChannel: nextReleaseChannel },
      skill,
      targetVersion,
    )

    if (input.enabled !== undefined) {
      installation.status = input.enabled ? "active" : "disabled"
    }
    if (input.versionId !== undefined) {
      installation.desiredVersionId = targetVersion?.id ?? null
    }
    if (input.updatePolicy) installation.updatePolicy = input.updatePolicy
    if (input.releaseChannel !== undefined) installation.releaseChannel = nextReleaseChannel
    if (input.versionId !== undefined || input.releaseChannel !== undefined) {
      installation.approvedVersionId = approval?.versionId ?? null
      installation.approvalId = approval?.id ?? null
    }
    installation.updatedAt = now
    this.recordEvent(context, "skill.installation.changed", {
      orgId: installation.orgId,
      skillId: installation.skillId,
      versionId: installation.desiredVersionId,
      installationId,
      workspaceId: installation.workspaceId,
      payload: { status: installation.status, updatePolicy: installation.updatePolicy },
    })
    return this.toInstallationResponse(installation)
  }

  async deleteInstallation(context: SkillRegistryRouteContext, installationId: string) {
    const installation = this.installations.get(installationId)
    if (!installation) {
      return null
    }
    enforceInstallationManagementAccess(context, installation)

    const now = this.isoNow()
    installation.status = "deleted"
    installation.deletedAt = now
    installation.deletedByUserId = context.userId
    installation.purgeAfter = new Date(this.now().getTime() + 30 * 86_400_000).toISOString()
    installation.updatedAt = now
    this.recordEvent(context, "skill.deleted", {
      orgId: installation.orgId,
      skillId: installation.skillId,
      versionId: installation.desiredVersionId,
      installationId,
      workspaceId: installation.workspaceId,
      payload: { deletedAt: now },
    })
    return this.toInstallationResponse(installation)
  }

  async restoreInstallation(context: SkillRegistryRouteContext, installationId: string, input: RestoreInstallationInput) {
    const installation = this.installations.get(installationId)
    if (!installation) {
      return null
    }
    enforceInstallationManagementAccess(context, installation)

    const policy = evaluateSkillRegistryRetentionPolicy({
      roles: rolesForContext(context),
      deletedAt: installation.deletedAt,
      purgeAfter: installation.purgeAfter,
      now: this.now(),
    })
    if (!policy.canRestore) {
      throw new SkillRegistryStoreError(409, "restore_not_allowed")
    }

    const now = this.isoNow()
    const skill = this.requireVisibleSkill(context, installation.skillId)
    const nextInstallation = {
      ...installation,
      status: "active" as const,
      orgId: input.orgId !== undefined ? input.orgId : installation.orgId,
      ownerUserId: input.ownerUserId !== undefined ? input.ownerUserId : installation.ownerUserId,
      workspaceId: input.workspaceId !== undefined ? input.workspaceId : installation.workspaceId,
    }
    enforceInstallationManagementAccess(context, nextInstallation)
    const targetVersion = input.versionId !== undefined
      ? input.versionId
        ? this.requireVersion(input.versionId)
        : null
      : installation.desiredVersionId
        ? this.requireVersion(installation.desiredVersionId)
        : null
    const approval = this.validateInstallationVersionSelection(nextInstallation, skill, targetVersion)

    if (input.orgId !== undefined) installation.orgId = input.orgId
    if (input.ownerUserId !== undefined) installation.ownerUserId = input.ownerUserId
    if (input.workspaceId !== undefined) installation.workspaceId = input.workspaceId
    if (input.versionId !== undefined) {
      installation.desiredVersionId = targetVersion?.id ?? installation.desiredVersionId
    }
    installation.approvedVersionId = approval?.versionId ?? null
    installation.approvalId = approval?.id ?? null
    installation.status = "active"
    installation.deletedAt = null
    installation.deletedByUserId = null
    installation.purgeAfter = null
    installation.restoredAt = now
    installation.restoredByUserId = context.userId
    installation.updatedAt = now

    this.recordEvent(context, "skill.restored", {
      orgId: installation.orgId,
      skillId: installation.skillId,
      versionId: installation.desiredVersionId,
      installationId,
      workspaceId: installation.workspaceId,
      payload: { restoredAt: now },
    })
    return this.toInstallationResponse(installation)
  }

  async listRolloutPolicies(context: SkillRegistryRouteContext, filters: Record<string, unknown> = {}) {
    const target = optionalFilterString(filters.target)
    const audience = optionalFilterString(filters.audience)
    const orgId = optionalFilterString(filters.orgId) ?? context.orgId ?? null
    const workspaceId = optionalFilterString(filters.workspaceId)
    const policies = Array.from(this.rolloutPolicies.values())
      .filter((policy) => policy.deletedAt === null)
      .filter((policy) => this.isRolloutPolicyVisibleToContext(policy, context))
      .filter((policy) => !target || policy.target === target)
      .filter((policy) => !audience || policy.audience === audience)
      .filter((policy) => !orgId || policy.orgId === orgId)
      .filter((policy) => !workspaceId || policy.workspaceId === workspaceId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .map((policy) => this.toRolloutPolicyResponse(policy))
    return { policies, nextCursor: null }
  }

  async createRolloutPolicy(context: SkillRegistryRouteContext, input: CreateRolloutPolicyInput) {
    const skill = this.requireVisibleSkill(context, input.skillId)
    const owner = resolveRolloutPolicyOwner(context, input.catalogScope, input.orgId)
    enforceRolloutPolicyManagementAccess(context, owner)
    const version = input.versionId ? this.requireVersion(input.versionId) : null
    validateRolloutPolicyVersion(skill, version)
    const now = this.isoNow()
    const policy: StoredRolloutPolicy = {
      id: newId("rollout"),
      orgId: input.catalogScope === "organization" ? owner.orgId : null,
      skillId: skill.id,
      desiredVersionId: version?.id ?? null,
      releaseChannel: input.releaseChannel?.trim() || null,
      updatePolicy: input.updatePolicy ?? "pinned",
      catalogScope: input.catalogScope,
      ownerOrgId: owner.orgId,
      target: input.target,
      audience: input.audience,
      userId: input.userId ?? null,
      workspaceId: input.workspaceId ?? null,
      enabled: true,
      removalPolicy: input.removalPolicy ?? "user_removable",
      createdByUserId: context.userId,
      deletedAt: null,
      deletedByUserId: null,
      purgeAfter: null,
      restoredAt: null,
      restoredByUserId: null,
      createdAt: now,
      updatedAt: now,
    }
    validateRolloutPolicyShape(policy)
    this.enforceRolloutPolicyApproval(policy, version)
    this.enforceNoRolloutTargetConflict(policy)
    this.rolloutPolicies.set(policy.id, policy)
    this.recordEvent(context, "skill.rollout_policy.changed", {
      orgId: policy.orgId,
      skillId: policy.skillId,
      versionId: policy.desiredVersionId,
      workspaceId: policy.workspaceId,
      payload: { policyId: policy.id, target: policy.target, audience: policy.audience, enabled: policy.enabled },
    })
    return this.toRolloutPolicyResponse(policy)
  }

  async updateRolloutPolicy(context: SkillRegistryRouteContext, policyId: string, input: UpdateRolloutPolicyInput) {
    const policy = this.rolloutPolicies.get(policyId)
    if (!policy || policy.deletedAt !== null) {
      return null
    }
    enforceRolloutPolicyManagementAccess(context, {
      catalogScope: policy.catalogScope,
      orgId: policy.ownerOrgId,
    })
    const skill = this.requireVisibleSkill(context, policy.skillId)
    const nextVersion = input.versionId !== undefined
      ? input.versionId
        ? this.requireVersion(input.versionId)
        : null
      : policy.desiredVersionId
        ? this.requireVersion(policy.desiredVersionId)
        : null
    validateRolloutPolicyVersion(skill, nextVersion)

    const nextPolicy: StoredRolloutPolicy = {
      ...policy,
      desiredVersionId: input.versionId !== undefined ? nextVersion?.id ?? null : policy.desiredVersionId,
      releaseChannel: input.releaseChannel !== undefined ? input.releaseChannel?.trim() || null : policy.releaseChannel,
      updatePolicy: input.updatePolicy ?? policy.updatePolicy,
      target: input.target ?? policy.target,
      audience: input.audience ?? policy.audience,
      userId: input.userId !== undefined ? input.userId : policy.userId,
      workspaceId: input.workspaceId !== undefined ? input.workspaceId : policy.workspaceId,
      enabled: input.enabled ?? policy.enabled,
      removalPolicy: input.removalPolicy ?? policy.removalPolicy,
      updatedAt: this.isoNow(),
    }
    if (input.orgId !== undefined) {
      const owner = resolveRolloutPolicyOwner(context, policy.catalogScope, input.orgId)
      enforceRolloutPolicyManagementAccess(context, owner)
      nextPolicy.orgId = policy.catalogScope === "organization" ? owner.orgId : null
      nextPolicy.ownerOrgId = owner.orgId
    }
    validateRolloutPolicyShape(nextPolicy)
    this.enforceRolloutPolicyApproval(nextPolicy, nextVersion)
    this.enforceNoRolloutTargetConflict(nextPolicy, policy.id)
    this.rolloutPolicies.set(policy.id, nextPolicy)
    this.recordEvent(context, "skill.rollout_policy.changed", {
      orgId: nextPolicy.orgId,
      skillId: nextPolicy.skillId,
      versionId: nextPolicy.desiredVersionId,
      workspaceId: nextPolicy.workspaceId,
      payload: { policyId: nextPolicy.id, target: nextPolicy.target, audience: nextPolicy.audience, enabled: nextPolicy.enabled },
    })
    return this.toRolloutPolicyResponse(nextPolicy)
  }

  async deleteRolloutPolicy(context: SkillRegistryRouteContext, policyId: string) {
    const policy = this.rolloutPolicies.get(policyId)
    if (!policy || policy.deletedAt !== null) {
      return null
    }
    enforceRolloutPolicyRemovalAccess(context, policy)
    const now = this.isoNow()
    policy.enabled = false
    policy.deletedAt = now
    policy.deletedByUserId = context.userId
    policy.purgeAfter = new Date(this.now().getTime() + 30 * 86_400_000).toISOString()
    policy.updatedAt = now
    this.recordEvent(context, "skill.rollout_policy.changed", {
      orgId: policy.orgId,
      skillId: policy.skillId,
      versionId: policy.desiredVersionId,
      workspaceId: policy.workspaceId,
      payload: { policyId: policy.id, deletedAt: now, enabled: policy.enabled },
    })
    return this.toRolloutPolicyResponse(policy)
  }

  async getWorkspaceSkillSet(context: SkillRegistryRouteContext, workspaceId: string) {
    if (!context.orgId) {
      throw new SkillRegistryStoreError(403, "organization_required")
    }
    const set = this.findLatestWorkspaceSet(context, workspaceId)
    if (!set) {
      return { workspaceId, skills: [] }
    }

    const skills = Array.from(this.workspaceSkillSetEntries.values())
      .filter((entry) => entry.skillSetId === set.id)
      .sort((left, right) => left.position - right.position)
      .map((entry) => ({ entry, installation: this.installations.get(entry.installationId) }))
      .filter((value): value is { entry: StoredWorkspaceSkillSetEntry; installation: StoredInstallation } => Boolean(value.installation))
      .filter(({ installation }) => installation.status === "active")
      .map(({ entry, installation }) => this.toInstallationResponse(installation, entry.desiredVersionId))
    return { workspaceId, skills }
  }

  async replaceWorkspaceSkillSet(context: SkillRegistryRouteContext, input: PatchWorkspaceSkillSetInput) {
    const previous = this.findLatestWorkspaceSet({ ...context, orgId: input.orgId }, input.workspaceId)
    const revision = previous ? previous.revision + 1 : 1
    const now = this.isoNow()
    const preparedEntries: Array<{
      entry: PatchWorkspaceSkillSetInput["skills"][number]
      index: number
      installation: StoredInstallation
      desiredVersionId: string | null
    }> = []
    for (const [index, entry] of input.skills.entries()) {
      const installation = this.installations.get(entry.installationId)
      if (!installation || installation.orgId !== input.orgId || installation.workspaceId !== input.workspaceId) {
        throw new SkillRegistryStoreError(400, "workspace_installation_mismatch")
      }
      if (installation.status !== "active") {
        throw new SkillRegistryStoreError(400, "workspace_installation_inactive")
      }
      const skill = this.requireVisibleSkill(context, installation.skillId)
      if (preparedEntries.some((prepared) => prepared.installation.skillId === installation.skillId)) {
        throw new SkillRegistryStoreError(400, "workspace_skill_duplicate")
      }
      const desiredVersionId = entry.desiredVersionId ?? this.resolveInstallationDesiredVersion(installation)
      const targetVersion = desiredVersionId ? this.requireVersion(desiredVersionId) : null
      this.validateInstallationVersionSelection(installation, skill, targetVersion)
      preparedEntries.push({ entry, index, installation, desiredVersionId })
    }
    const set: StoredWorkspaceSkillSet = {
      id: newId("skillset"),
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      name: "default",
      revision,
      releaseChannel: input.releaseChannel?.trim() || null,
      createdByUserId: context.userId,
      createdAt: now,
      updatedAt: now,
    }
    this.workspaceSkillSets.set(set.id, set)

    preparedEntries.forEach(({ entry, index, installation, desiredVersionId }) => {
      const setEntry: StoredWorkspaceSkillSetEntry = {
        id: newId("skillset_entry"),
        orgId: input.orgId,
        skillSetId: set.id,
        installationId: installation.id,
        skillId: installation.skillId,
        desiredVersionId,
        releaseChannel: entry.releaseChannel?.trim() || installation.releaseChannel,
        position: index,
        createdAt: now,
      }
      this.workspaceSkillSetEntries.set(setEntry.id, setEntry)
      this.upsertMaterialization(installation, set.id, desiredVersionId)
    })

    this.recordEvent(context, "workspace.skill_set.changed", {
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      payload: { revision },
    })
    return this.getWorkspaceSkillSet({ ...context, orgId: input.orgId }, input.workspaceId)
  }

  async createReviewRequest(context: SkillRegistryRouteContext, input: CreateReviewRequestInput) {
    const skill = this.requireVisibleSkill(context, input.skillId)
    const version = this.requireVersion(input.versionId)
    if (version.skillId !== skill.id) {
      throw new SkillRegistryStoreError(400, "version_skill_mismatch")
    }
    const orgId = input.scope === "org" ? input.orgId ?? skill.orgId ?? context.orgId ?? null : null
    if (input.scope === "org" && !orgId) throw new SkillRegistryStoreError(400, "org_id_required")
    validateReviewRequestTarget(context, skill, version, input.scope, orgId)
    this.enforceNoPendingReviewRequest(version.id, input.scope, orgId)
    const now = this.isoNow()
    version.status = "pending_review"
    version.submittedForReviewAt = now
    const request: StoredReviewRequest = {
      id: newId("review"),
      orgId,
      scope: input.scope,
      skillId: skill.id,
      versionId: version.id,
      status: "pending",
      requestedByUserId: context.userId,
      reason: input.reason?.trim() || null,
      reviewerNote: null,
      resolvedByUserId: null,
      resolvedAt: null,
      releaseChannel: input.releaseChannel?.trim() || null,
      createdAt: now,
      updatedAt: now,
    }
    this.reviewRequests.set(request.id, request)
    return toReviewResponse(request)
  }

  async approveReviewRequest(context: SkillRegistryRouteContext, input: ResolveReviewInput) {
    const request = this.reviewRequests.get(input.requestId)
    if (!request) return null
    enforceReviewResolutionAccess(context, request)
    enforcePendingReviewRequest(request)
    const version = this.requireVersion(request.versionId)
    const skill = this.requireSkill(request.skillId)
    const now = this.isoNow()
    request.status = "approved"
    request.reviewerNote = input.reviewerNote?.trim() || null
    request.resolvedByUserId = context.userId
    request.resolvedAt = now
    request.updatedAt = now
    const releaseChannel = input.releaseChannel?.trim() || request.releaseChannel
    const approval: StoredApproval = {
      id: newId("approval"),
      orgId: request.scope === "org" ? request.orgId : null,
      scope: request.scope,
      approvalOwnerKey: request.scope === "org"
        ? skillApprovalOwnerKey({ scope: "org", orgId: request.orgId ?? "" })
        : skillApprovalOwnerKey({ scope: "system" }),
      skillId: request.skillId,
      versionId: request.versionId,
      reviewRequestId: request.id,
      releaseChannel,
      releaseChannelKey: skillReleaseChannelKey(releaseChannel),
      approvedByUserId: context.userId,
      approvedAt: now,
      revokedByUserId: null,
      revokedAt: null,
    }
    this.approvals.set(approval.id, approval)

    version.status = "approved"
    version.approvedAt = now
    skill.latestVersionId = version.id
    skill.updatedAt = now
    this.rolloutApprovedVersion(context, approval)
    this.recordEvent(context, "skill.version.approved", {
      orgId: approval.scope === "system" ? null : skill.orgId,
      skillId: skill.id,
      versionId: version.id,
      payload: { approvalId: approval.id, releaseChannel },
    })
    return toReviewResponse(request)
  }

  async rejectReviewRequest(context: SkillRegistryRouteContext, input: ResolveReviewInput) {
    const request = this.reviewRequests.get(input.requestId)
    if (!request) return null
    enforceReviewResolutionAccess(context, request)
    enforcePendingReviewRequest(request)
    const version = this.requireVersion(request.versionId)
    if (version.status === "approved") {
      throw new SkillRegistryStoreError(409, "version_already_approved")
    }
    const now = this.isoNow()
    request.status = "rejected"
    request.reviewerNote = input.reviewerNote?.trim() || null
    request.resolvedByUserId = context.userId
    request.resolvedAt = now
    request.updatedAt = now
    version.status = "rejected"
    version.rejectedAt = now
    return toReviewResponse(request)
  }

  async searchSkills(context: SkillRegistryRouteContext, filters: Record<string, unknown> & { query?: string | null }) {
    const query = filters.query?.trim() ?? ""
    const language = optionalFilterString(filters.language)
    const listed = await this.listSkills(context, filters)
    const skills = query
      ? listed.skills.filter((skill) => {
          const version = skill.latestVersion ? this.versions.get(skill.latestVersion.id) : null
          const files = version
            ? Array.from(this.versionFiles.values()).filter((file) => file.versionId === version.id)
            : []
          const document = buildSkillSearchDocument({
            name: version?.metadata.name ?? skill.name,
            description: version?.metadata.description ?? skill.description,
            trigger: version?.metadata.trigger,
            tags: skill.tags,
            files,
          })
          return queryMatchesSkillSearchText(query, [
            skill.name,
            skill.description,
            ...(skill.tags ?? []),
            version?.metadata.name,
            version?.metadata.description,
            version?.metadata.trigger,
            document.searchText,
          ], { language })
        })
      : listed.skills
    return { query, skills, nextCursor: null }
  }

  async listEvents(context: SkillRegistryRouteContext, filters: Record<string, unknown> = {}) {
    const orgId = optionalFilterString(filters.orgId) ?? context.orgId ?? null
    const workspaceId = optionalFilterString(filters.workspaceId)
    const cursor = parseEventCursor(optionalFilterString(filters.cursor))
    const limit = optionalPositiveInteger(filters.limit)
    const events = this.events
      .filter((event) => isEventVisibleToContext(event, context))
      .filter((event) => !orgId || event.orgId === orgId || isGlobalRegistryEvent(event))
      .filter((event) => !workspaceId || event.workspaceId === workspaceId)
      .filter((event) => isAfterEventCursor(event.createdAt, event.id, cursor))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    const limited = limit ? events.slice(0, limit) : events
    return {
      events: limited.map(toEventResponse),
      nextCursor: eventCursorFor(limited.at(-1) ?? null),
    }
  }

  private rolloutApprovedVersion(context: SkillRegistryRouteContext, approval: StoredApproval) {
    for (const installation of this.installations.values()) {
      if (installation.skillId !== approval.skillId || installation.status !== "active") {
        continue
      }
      if (installation.updatePolicy !== "latest_approved" && installation.updatePolicy !== "release_channel") {
        continue
      }
      if (
        installation.updatePolicy === "release_channel" &&
        skillReleaseChannelKey(installation.releaseChannel) !== approval.releaseChannelKey
      ) {
        continue
      }
      if (approval.scope === "org" && installation.orgId !== approval.orgId) {
        continue
      }

      installation.desiredVersionId = approval.versionId
      installation.approvedVersionId = approval.versionId
      installation.approvalId = approval.id
      installation.updatedAt = this.isoNow()
      for (const entry of this.workspaceSkillSetEntries.values()) {
        if (entry.installationId === installation.id) {
          entry.desiredVersionId = approval.versionId
        }
      }
      this.upsertMaterialization(installation, this.findLatestWorkspaceSet(context, installation.workspaceId ?? "")?.id ?? null, approval.versionId)
      this.recordEvent(context, "skill.installation.changed", {
        orgId: installation.orgId,
        skillId: installation.skillId,
        versionId: approval.versionId,
        installationId: installation.id,
        workspaceId: installation.workspaceId,
        payload: { rollout: true },
      })
      if (installation.workspaceId) {
        this.recordEvent(context, "workspace.skill_set.changed", {
          orgId: installation.orgId,
          workspaceId: installation.workspaceId,
          payload: { rollout: true, versionId: approval.versionId },
        })
      }
    }
  }

  private resolveInstallationDesiredVersion(installation: StoredInstallation) {
    if (installation.updatePolicy !== "release_channel" && installation.updatePolicy !== "latest_approved") {
      return installation.desiredVersionId
    }
    const approval = this.findApprovalForInstallation(
      installation.scope,
      installation.orgId,
      installation.skillId,
      installation.desiredVersionId,
      installation.releaseChannel,
    )
    return approval?.versionId ?? installation.desiredVersionId
  }

  private upsertMaterialization(installation: StoredInstallation, skillSetId: string | null, desiredVersionId: string | null) {
    const existing = Array.from(this.materializations.values()).find((entry) => entry.installationId === installation.id)
    const version = desiredVersionId ? this.versions.get(desiredVersionId) : null
    const now = this.isoNow()
    const target: StoredMaterialization = existing ?? {
      id: newId("materialization"),
      orgId: installation.orgId,
      workspaceId: installation.workspaceId,
      ownerUserId: installation.ownerUserId,
      skillSetId,
      installationId: installation.id,
      skillId: installation.skillId,
      desiredVersionId,
      actualVersionId: null,
      targetScope: installation.scope,
      targetPath: materializationTargetPath(installation),
      status: "pending",
      packageSha256: version?.packageSha256 ?? null,
      lastError: null,
      materializedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    target.skillSetId = skillSetId
    target.desiredVersionId = desiredVersionId
    target.packageSha256 = version?.packageSha256 ?? null
    target.updatedAt = now
    this.materializations.set(target.id, target)
  }

  private findApprovalForInstallation(
    scope: SkillScope,
    orgId: string | null,
    skillId: string,
    versionId: string | null,
    releaseChannel: string | null | undefined,
  ) {
    const releaseChannelKey = skillReleaseChannelKey(releaseChannel)
    const candidates = Array.from(this.approvals.values()).filter((approval) => {
      if (approval.revokedAt !== null || approval.skillId !== skillId) return false
      if (versionId && approval.versionId !== versionId) return false
      return approval.releaseChannelKey === releaseChannelKey || releaseChannel == null
    })
    if (scope === "system") {
      return candidates.find((approval) => approval.scope === "system" && approval.orgId === null) ?? null
    }
    return candidates.find((approval) => approval.scope === "org" && approval.orgId === orgId)
      ?? candidates.find((approval) => approval.scope === "system" && approval.orgId === null)
      ?? null
  }

  private findLatestWorkspaceSet(context: SkillRegistryRouteContext, workspaceId: string) {
    return Array.from(this.workspaceSkillSets.values())
      .filter((set) => set.workspaceId === workspaceId)
      .filter((set) => context.orgId == null || set.orgId === context.orgId)
      .sort((left, right) => right.revision - left.revision)[0] ?? null
  }

  private validateInstallationVersionSelection(
    installation: Pick<StoredInstallation, "scope" | "status" | "orgId" | "skillId" | "approvedVersionId" | "approvalId" | "releaseChannel">,
    skill: StoredSkill,
    version: StoredVersion | null,
  ) {
    if (!version) {
      return null
    }
    if (version.skillId !== installation.skillId || version.skillId !== skill.id) {
      throw new SkillRegistryStoreError(400, "version_skill_mismatch")
    }

    const approval = this.findApprovalForInstallation(
      installation.scope,
      installation.orgId,
      skill.id,
      version.id,
      installation.releaseChannel,
    )
    if (installation.scope === "org" || installation.scope === "system") {
      const policyResult = validateManagedSkillInstallationApproval({
        installation: {
          scope: installation.scope,
          status: installation.status,
          orgId: installation.orgId,
          skillId: installation.skillId,
          approvalId: approval?.id ?? null,
          approvedVersionId: approval?.versionId ?? null,
        },
        version: {
          id: version.id,
          orgId: version.orgId,
          skillId: version.skillId,
          status: version.status,
        },
        approval: approval
          ? {
              id: approval.id,
              scope: approval.scope,
              orgId: approval.orgId,
              skillId: approval.skillId,
              versionId: approval.versionId,
              revokedAt: approval.revokedAt,
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

  private requireVisibleSkill(context: SkillRegistryRouteContext, skillId: string) {
    const skill = this.requireSkill(skillId)
    if (skill.deletedAt !== null || !this.isSkillVisibleToContext(skill, context)) {
      throw new SkillRegistryStoreError(404, "skill_not_found")
    }
    return skill
  }

  private requireSkill(skillId: string) {
    const skill = this.skills.get(skillId)
    if (!skill) {
      throw new SkillRegistryStoreError(404, "skill_not_found")
    }
    return skill
  }

  private requireVersion(versionId: string) {
    const version = this.versions.get(versionId)
    if (!version) {
      throw new SkillRegistryStoreError(404, "version_not_found")
    }
    return version
  }

  private toSkillSummary(skill: StoredSkill, context: SkillRegistryRouteContext): RegistrySkillSummary {
    const latestVersion = skill.latestVersionId ? this.versions.get(skill.latestVersionId) ?? null : null
    const visibleLatestVersion = isManagedSkillScope(skill.scope) && latestVersion?.status !== "approved" ? null : latestVersion
    const statusVersion = this.latestStatusVersionForSkill(skill) ?? latestVersion
    const tags = visibleLatestVersion?.metadata.tags
    const summary: RegistrySkillSummary = {
      id: skill.id,
      slug: skill.name,
      name: skill.displayName ?? visibleLatestVersion?.metadata.name ?? skill.name,
      visibility: this.visibilityForContext(skill, context),
      reviewStatus: reviewStatusForVersion(statusVersion),
      createdAt: skill.createdAt,
      updatedAt: skill.updatedAt,
    }
    const description = skill.description ?? visibleLatestVersion?.metadata.description
    if (description) summary.description = description
    if (tags?.length) summary.tags = tags
    if (visibleLatestVersion) summary.latestVersion = toVersionSummary(visibleLatestVersion)
    return summary
  }

  private isSkillVisibleToContext(skill: StoredSkill, context: SkillRegistryRouteContext) {
    if (isSkillVisibleToContext(skill, context)) return true
    return Boolean(this.findVisibleApproval(skill, context))
  }

  private visibilityForContext(skill: StoredSkill, context: SkillRegistryRouteContext): RegistrySkillVisibility {
    const approval = this.findVisibleApproval(skill, context)
    if (approval?.scope === "system") return "platform"
    if (approval?.scope === "org") return "organization"
    return visibilityForScope(skill.scope)
  }

  private findVisibleApproval(skill: StoredSkill, context: SkillRegistryRouteContext) {
    return Array.from(this.approvals.values()).find((approval) => {
      if (approval.revokedAt !== null || approval.skillId !== skill.id) return false
      if (approval.scope === "system" && approval.orgId === null) return true
      return approval.scope === "org" && context.orgId != null && approval.orgId === context.orgId
    }) ?? null
  }

  private latestStatusVersionForSkill(skill: StoredSkill) {
    return Array.from(this.versions.values())
      .filter((version) => version.skillId === skill.id)
      .sort((left, right) => right.versionNumber - left.versionNumber)[0] ?? null
  }

  private toInstallationResponse(installation: StoredInstallation, desiredVersionOverride?: string | null): RegistrySkillInstallation {
    const versionId = desiredVersionOverride ?? this.resolveInstallationDesiredVersion(installation)
    if (!versionId) {
      throw new SkillRegistryStoreError(409, "installation_version_unresolved")
    }
    return {
      installationId: installation.id,
      skillId: installation.skillId,
      versionId,
      enabled: installation.status === "active",
      source: installationSourceForScope(installation.scope),
      installedAt: installation.createdAt,
      updatedAt: installation.updatedAt,
    }
  }

  private toRolloutPolicyResponse(policy: StoredRolloutPolicy): RegistrySkillRolloutPolicy {
    return {
      id: policy.id,
      skillId: policy.skillId,
      versionId: policy.desiredVersionId,
      target: policy.target,
      audience: policy.audience,
      catalogScope: policy.catalogScope,
      orgId: policy.orgId,
      userId: policy.userId,
      workspaceId: policy.workspaceId,
      enabled: policy.enabled && policy.deletedAt === null,
      updatePolicy: policy.updatePolicy,
      releaseChannel: policy.releaseChannel,
      removalPolicy: policy.removalPolicy,
      createdAt: policy.createdAt,
      updatedAt: policy.updatedAt,
    }
  }

  private enforceNoRolloutTargetConflict(candidate: StoredRolloutPolicy, ignorePolicyId?: string) {
    const existing = Array.from(this.rolloutPolicies.values())
      .filter((policy) => policy.id !== ignorePolicyId)
      .map((policy) => ({
        skillId: policy.skillId,
        catalogScope: policy.catalogScope,
        ownerOrgId: policy.ownerOrgId,
        target: policy.target,
        audience: policy.audience,
        userId: policy.userId,
        workspaceId: policy.workspaceId,
        enabled: policy.enabled,
        deletedAt: policy.deletedAt,
      }))
    if (hasRolloutTargetConflict({
      skillId: candidate.skillId,
      catalogScope: candidate.catalogScope,
      ownerOrgId: candidate.ownerOrgId,
      target: candidate.target,
      audience: candidate.audience,
      userId: candidate.userId,
      workspaceId: candidate.workspaceId,
      enabled: candidate.enabled,
      deletedAt: candidate.deletedAt,
    }, existing)) {
      throw new SkillRegistryStoreError(409, "target_conflict")
    }
  }

  private enforceRolloutPolicyApproval(candidate: StoredRolloutPolicy, version: StoredVersion | null) {
    if (!version) return
    const result = validateRolloutPolicyApproval({
      catalogScope: candidate.catalogScope,
      ownerOrgId: candidate.ownerOrgId,
      skillId: candidate.skillId,
      versionId: version.id,
      approvals: Array.from(this.approvals.values()).map((approval) => ({
        scope: approval.scope,
        orgId: approval.orgId,
        skillId: approval.skillId,
        versionId: approval.versionId,
        revokedAt: approval.revokedAt,
      })),
    })
    if (!result.ok) {
      throw new SkillRegistryStoreError(409, result.code)
    }
  }

  private isRolloutPolicyVisibleToContext(policy: StoredRolloutPolicy, context: SkillRegistryRouteContext) {
    if (context.isPlatformAdmin) return true
    if (policy.catalogScope === "platform") return true
    return Boolean(context.orgId && policy.orgId === context.orgId)
  }

  private enforceNoPendingReviewRequest(versionId: string, scope: SkillApprovalScope, orgId: string | null) {
    const existing = Array.from(this.reviewRequests.values()).find((request) =>
      request.versionId === versionId &&
      request.scope === scope &&
      request.orgId === orgId &&
      request.status === "pending",
    )
    if (existing) {
      throw new SkillRegistryStoreError(409, "review_request_already_pending")
    }
  }

  private recordEvent(
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
    this.events.push({
      id: newId("event"),
      orgId: input.orgId ?? null,
      skillId: input.skillId ?? null,
      versionId: input.versionId ?? null,
      installationId: input.installationId ?? null,
      workspaceId: input.workspaceId ?? null,
      actorUserId: context.userId,
      action,
      payload: input.payload ?? {},
      createdAt: this.isoNow(),
    })
  }

  private isoNow() {
    return this.now().toISOString()
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

function resolveRolloutPolicyOwner(
  context: SkillRegistryRouteContext,
  catalogScope: SkillRolloutCatalogScope,
  inputOrgId?: string | null,
) {
  if (catalogScope === "platform") {
    if (inputOrgId) throw new SkillRegistryStoreError(400, "org_id_forbidden")
    rolloutPolicyOwnerKey({ catalogScope })
    return { catalogScope, orgId: null }
  }
  const orgId = inputOrgId ?? context.orgId
  if (!orgId) throw new SkillRegistryStoreError(400, "org_id_required")
  rolloutPolicyOwnerKey({ catalogScope, ownerOrgId: orgId })
  return { catalogScope, orgId }
}

function enforceRolloutPolicyManagementAccess(
  context: SkillRegistryRouteContext,
  policy: { catalogScope: SkillRolloutCatalogScope; orgId: string | null },
) {
  if (policy.catalogScope === "platform") {
    if (!context.isPlatformAdmin) throw new SkillRegistryStoreError(403, "forbidden")
    return
  }
  if (context.isPlatformAdmin) return
  if (!policy.orgId || context.orgId !== policy.orgId) {
    throw new SkillRegistryStoreError(403, "organization_forbidden")
  }
  if (context.orgRole !== "owner") {
    throw new SkillRegistryStoreError(403, "insufficient_role")
  }
}

function canManageRolloutPolicy(
  context: SkillRegistryRouteContext,
  policy: Pick<StoredRolloutPolicy, "catalogScope" | "ownerOrgId">,
) {
  if (context.isPlatformAdmin) return true
  if (policy.catalogScope === "platform") return false
  return Boolean(policy.ownerOrgId && context.orgId === policy.ownerOrgId && context.orgRole === "owner")
}

function enforceRolloutPolicyRemovalAccess(context: SkillRegistryRouteContext, policy: StoredRolloutPolicy) {
  if (canManageRolloutPolicy(context, policy)) return
  if (policy.removalPolicy !== "user_removable") {
    throw new SkillRegistryStoreError(409, "removal_not_allowed")
  }
  if (policy.audience === "user" && policy.userId === context.userId) {
    return
  }
  throw new SkillRegistryStoreError(403, "forbidden")
}

function validateRolloutPolicyVersion(skill: StoredSkill, version: StoredVersion | null) {
  if (!version) return
  if (version.skillId !== skill.id) {
    throw new SkillRegistryStoreError(400, "version_skill_mismatch")
  }
  if ((skill.scope === "org" || skill.scope === "system") && version.status !== "approved") {
    throw new SkillRegistryStoreError(409, "version_not_approved")
  }
}

function validateRolloutPolicyShape(policy: Pick<
  StoredRolloutPolicy,
  "catalogScope" | "ownerOrgId" | "target" | "audience" | "userId" | "workspaceId"
>) {
  if (policy.catalogScope === "organization" && !policy.ownerOrgId) {
    throw new SkillRegistryStoreError(400, "org_id_required")
  }
  if (policy.catalogScope === "platform" && policy.ownerOrgId) {
    throw new SkillRegistryStoreError(400, "org_id_forbidden")
  }
  if (policy.catalogScope === "organization" && policy.audience === "all-platform-users") {
    throw new SkillRegistryStoreError(400, "audience_scope_mismatch")
  }
  if (policy.catalogScope === "platform" && policy.audience === "all-org-users") {
    throw new SkillRegistryStoreError(400, "audience_scope_mismatch")
  }
  if (policy.target === "user-global" && policy.workspaceId) {
    throw new SkillRegistryStoreError(400, "workspace_id_forbidden")
  }
  if (policy.target === "workspace" && policy.audience !== "selected-workspaces") {
    throw new SkillRegistryStoreError(400, "audience_target_mismatch")
  }
  if (policy.target === "workspace" && !policy.workspaceId) {
    throw new SkillRegistryStoreError(400, "workspace_id_required")
  }
  switch (policy.audience) {
    case "user":
      if (!policy.userId) throw new SkillRegistryStoreError(400, "user_id_required")
      if (policy.workspaceId) throw new SkillRegistryStoreError(400, "workspace_id_forbidden")
      break
    case "selected-workspaces":
      if (policy.userId) throw new SkillRegistryStoreError(400, "user_id_forbidden")
      if (!policy.workspaceId) throw new SkillRegistryStoreError(400, "workspace_id_required")
      break
    case "all-org-users":
      if (policy.userId) throw new SkillRegistryStoreError(400, "user_id_forbidden")
      if (policy.workspaceId) throw new SkillRegistryStoreError(400, "workspace_id_forbidden")
      break
    case "all-platform-users":
      if (policy.userId) throw new SkillRegistryStoreError(400, "user_id_forbidden")
      if (policy.workspaceId) throw new SkillRegistryStoreError(400, "workspace_id_forbidden")
      break
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

function visibilityForScope(scope: SkillScope): RegistrySkillVisibility {
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

function installationSourceForScope(scope: SkillScope): RegistrySkillInstallationSource {
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

function reviewStatusForVersion(version: StoredVersion | null): RegistrySkillReviewStatus {
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

function toVersionSummary(version: StoredVersion): RegistrySkillVersionSummary {
  return {
    id: version.id,
    version: String(version.versionNumber),
    packageSha256: version.packageSha256,
    createdAt: version.createdAt,
  }
}

function toReviewResponse(request: StoredReviewRequest): RegistryReviewResponse {
  return {
    requestId: request.id,
    skillId: request.skillId,
    status: request.status === "pending" ? "pending_review" : request.status === "cancelled" ? "rejected" : request.status,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  }
}

function toEventResponse(event: StoredAuditEvent): RegistrySkillEvent {
  return {
    id: event.id,
    orgId: event.orgId,
    skillId: event.skillId,
    versionId: event.versionId,
    installationId: event.installationId,
    workspaceId: event.workspaceId,
    actorUserId: event.actorUserId,
    action: event.action,
    payload: event.payload,
    createdAt: event.createdAt,
  }
}

function isSkillVisibleToContext(skill: StoredSkill, context: SkillRegistryRouteContext) {
  if (context.isPlatformAdmin) return true
  switch (skill.scope) {
    case "system":
      return true
    case "user":
      return skill.ownerUserId === context.userId
    case "org":
      return Boolean(context.orgId && skill.orgId === context.orgId)
    case "workspace":
      return Boolean(context.orgId && skill.orgId === context.orgId)
  }
}

function isEventVisibleToContext(event: StoredAuditEvent, context: SkillRegistryRouteContext) {
  if (context.isPlatformAdmin) return true
  if (event.orgId) return Boolean(context.orgId && event.orgId === context.orgId)
  if (event.action === "skill.version.approved") return true
  return event.actorUserId === context.userId
}

function isGlobalRegistryEvent(event: StoredAuditEvent) {
  return event.orgId === null && event.action === "skill.version.approved"
}

function validateReviewRequestTarget(
  context: SkillRegistryRouteContext,
  skill: StoredSkill,
  version: StoredVersion,
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
  if (scope === "org" && skill.scope === "org" && skill.orgId !== orgId) {
    throw new SkillRegistryStoreError(403, "organization_forbidden")
  }
}

function enforceInstallationManagementAccess(context: SkillRegistryRouteContext, installation: Pick<StoredInstallation, "scope" | "orgId" | "ownerUserId">) {
  if (canManageInstallation(context, installation)) return
  throw new SkillRegistryStoreError(403, "forbidden")
}

function canManageInstallation(context: SkillRegistryRouteContext, installation: Pick<StoredInstallation, "scope" | "orgId" | "ownerUserId">) {
  if (context.isPlatformAdmin) return true
  switch (installation.scope) {
    case "system":
      return false
    case "user":
      return installation.ownerUserId === context.userId
    case "org":
    case "workspace":
      return Boolean(context.orgId && installation.orgId === context.orgId && context.orgRole === "owner")
  }
}

function canReadVersion(context: SkillRegistryRouteContext, skill: StoredSkill, version: StoredVersion) {
  if (!isManagedSkillScope(skill.scope) || version.status === "approved") return true
  if (context.isPlatformAdmin) return true
  if (skill.scope === "org") {
    return Boolean(context.orgId && context.orgId === skill.orgId && context.orgRole === "owner")
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

function eventCursorFor(event: StoredAuditEvent | null) {
  return event ? `${event.createdAt}|${event.id}` : null
}

function rolesForContext(context: SkillRegistryRouteContext): SkillRegistryRetentionRole[] {
  const roles: SkillRegistryRetentionRole[] = ["member"]
  if (context.orgRole === "owner") roles.push("owner")
  if (context.isPlatformAdmin) roles.push("platform_admin")
  return roles
}

function materializationTargetPath(installation: StoredInstallation) {
  if (installation.scope === "workspace") {
    return `workspace:${installation.workspaceId ?? "unknown"}`
  }
  if (installation.scope === "user") {
    return `user:${installation.ownerUserId ?? "unknown"}`
  }
  if (installation.scope === "org") {
    return `org:${installation.orgId ?? "unknown"}`
  }
  return "system"
}

function enforceReviewResolutionAccess(context: SkillRegistryRouteContext, request: StoredReviewRequest) {
  if (context.isPlatformAdmin) {
    return
  }
  if (request.scope === "system") {
    throw new SkillRegistryStoreError(403, "forbidden")
  }
  if (!request.orgId || context.orgId !== request.orgId || context.orgRole !== "owner") {
    throw new SkillRegistryStoreError(403, "insufficient_role")
  }
}

function enforcePendingReviewRequest(request: StoredReviewRequest) {
  if (request.status !== "pending") {
    throw new SkillRegistryStoreError(409, "review_request_already_resolved")
  }
}

function decodePackageArchive(value: unknown) {
  try {
    return decodeSkillRegistryPackageArchive(value)
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid skill package"
    throw new SkillRegistryStoreError(400, "invalid_skill_package", message)
  }
}
