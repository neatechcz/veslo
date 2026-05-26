import type {
  SkillApprovalScope,
  SkillInstallationStatus,
  SkillScope,
  SkillVersionStatus,
} from "./schema.js"

export type SkillRegistryPolicyResult<TCode extends string = string> =
  | { ok: true }
  | { ok: false; code: TCode }

export type ManagedSkillInstallationApprovalCode =
  | "missing_approval"
  | "version_not_approved"
  | "approval_id_mismatch"
  | "approval_scope_mismatch"
  | "approval_version_mismatch"
  | "approval_org_mismatch"
  | "version_org_mismatch"
  | "skill_mismatch"
  | "approval_revoked"

export type ManagedSkillInstallationRef = {
  scope: SkillScope
  status?: SkillInstallationStatus
  orgId?: string | null
  skillId: string
  approvalId?: string | null
  approvedVersionId?: string | null
}

export type ManagedSkillVersionRef = {
  id: string
  orgId?: string | null
  skillId?: string | null
  status: SkillVersionStatus
}

export type ManagedSkillApprovalRef = {
  id: string
  scope: SkillApprovalScope
  orgId?: string | null
  skillId: string
  versionId: string
  revokedAt?: Date | string | null
}

export function validateManagedSkillInstallationApproval(input: {
  installation: ManagedSkillInstallationRef
  version: ManagedSkillVersionRef
  approval?: ManagedSkillApprovalRef | null
}): SkillRegistryPolicyResult<ManagedSkillInstallationApprovalCode> {
  const { installation, version, approval } = input
  const status = installation.status ?? "active"

  if (status !== "active" || (installation.scope !== "org" && installation.scope !== "system")) {
    return { ok: true }
  }

  if (!installation.approvalId || !installation.approvedVersionId || !approval) {
    return { ok: false, code: "missing_approval" }
  }

  if (version.status !== "approved") {
    return { ok: false, code: "version_not_approved" }
  }

  if (approval.id !== installation.approvalId) {
    return { ok: false, code: "approval_id_mismatch" }
  }

  if (approval.scope !== installation.scope) {
    return { ok: false, code: "approval_scope_mismatch" }
  }

  if (approval.versionId !== installation.approvedVersionId || approval.versionId !== version.id) {
    return { ok: false, code: "approval_version_mismatch" }
  }

  if (approval.skillId !== installation.skillId || (version.skillId != null && version.skillId !== installation.skillId)) {
    return { ok: false, code: "skill_mismatch" }
  }

  if (approval.revokedAt != null) {
    return { ok: false, code: "approval_revoked" }
  }

  if (installation.scope === "org") {
    if (!installation.orgId || approval.orgId !== installation.orgId) {
      return { ok: false, code: "approval_org_mismatch" }
    }
    if (version.orgId != null && version.orgId !== installation.orgId) {
      return { ok: false, code: "version_org_mismatch" }
    }
  }

  if (installation.scope === "system") {
    if (installation.orgId != null || approval.orgId != null) {
      return { ok: false, code: "approval_org_mismatch" }
    }
    if (version.orgId != null) {
      return { ok: false, code: "version_org_mismatch" }
    }
  }

  return { ok: true }
}

export type SkillRegistryTenantIsolationRef = {
  entity: string
  orgId?: string | null
  systemScope?: boolean
}

export type SkillRegistryTenantIsolationResult =
  | { ok: true }
  | { ok: false; code: "missing_org" | "missing_system_scope" | "org_mismatch"; entity: string }

export function validateSkillRegistryTenantIsolation(input: {
  orgId: string | null
  refs: readonly SkillRegistryTenantIsolationRef[]
}): SkillRegistryTenantIsolationResult {
  for (const ref of input.refs) {
    if (input.orgId === null) {
      if (ref.orgId != null) {
        return { ok: false, code: "org_mismatch", entity: ref.entity }
      }
      if (ref.systemScope !== true) {
        return { ok: false, code: "missing_system_scope", entity: ref.entity }
      }
      continue
    }

    if (ref.orgId == null) {
      if (ref.systemScope === true) {
        continue
      }
      return { ok: false, code: "missing_org", entity: ref.entity }
    }

    if (ref.orgId !== input.orgId) {
      return { ok: false, code: "org_mismatch", entity: ref.entity }
    }
  }

  return { ok: true }
}

export type SkillRegistryRetentionRole = "member" | "owner" | "platform_admin"

export type SkillRegistryRetentionPolicyDecision = {
  canHardPurge: boolean
  canRestore: boolean
}

export function evaluateSkillRegistryRetentionPolicy(input: {
  roles: readonly SkillRegistryRetentionRole[]
  deletedAt?: Date | string | number | null
  purgeAfter?: Date | string | number | null
  now: Date | string | number
}): SkillRegistryRetentionPolicyDecision {
  const deletedAtTime = toTimestamp(input.deletedAt)
  if (deletedAtTime === null) {
    return { canHardPurge: false, canRestore: false }
  }

  const purgeAfterTime = toTimestamp(input.purgeAfter)
  const nowTime = toTimestamp(input.now)
  const purgeDue = purgeAfterTime !== null && nowTime !== null && purgeAfterTime <= nowTime
  const hasAdminRole = input.roles.includes("owner") || input.roles.includes("platform_admin")

  return {
    canHardPurge: hasAdminRole && purgeDue,
    canRestore: !purgeDue,
  }
}

function toTimestamp(value: Date | string | number | null | undefined): number | null {
  if (value == null) {
    return null
  }

  const time = value instanceof Date ? value.getTime() : new Date(value).getTime()
  return Number.isFinite(time) ? time : null
}
