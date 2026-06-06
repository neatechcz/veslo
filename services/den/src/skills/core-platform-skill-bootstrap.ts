import {
  buildCorePlatformSkillPackages,
  type CorePlatformSkillPackage,
} from "./core-platform-skills.js"
import {
  SkillRegistryStoreError,
  type RegistrySkillRolloutPolicy,
  type RegistrySkillSummary,
  type RegistrySkillVersionSummary,
  type SkillRegistryRouteContext,
  type SkillRegistryStore,
} from "./store.js"

export const CORE_PLATFORM_CONTEXT = {
  userId: "system:veslo-core-skills",
  isPlatformAdmin: true,
} satisfies SkillRegistryRouteContext

export type EnsureCorePlatformSkillsOptions = {
  packages?: readonly CorePlatformSkillPackage[]
}

export async function ensureCorePlatformSkills(
  store: SkillRegistryStore,
  options: EnsureCorePlatformSkillsOptions = {},
) {
  const packages = options.packages ?? await buildCorePlatformSkillPackages()

  for (const packageDefinition of packages) {
    const skill = await ensureSkill(store, packageDefinition)
    const version = await ensureApprovedVersion(store, skill, packageDefinition)
    await ensureRolloutPolicy(store, packageDefinition, skill, version)
  }
}

async function ensureSkill(store: SkillRegistryStore, packageDefinition: CorePlatformSkillPackage) {
  const existing = await store.listSkills(CORE_PLATFORM_CONTEXT, { ownerScope: "system" })
  const skill = existing.skills.find((entry) => entry.slug === packageDefinition.name)
  if (skill) return skill

  return store.createSkill(CORE_PLATFORM_CONTEXT, {
    scope: packageDefinition.scope,
    name: packageDefinition.name,
    displayName: packageDefinition.displayName,
    description: packageDefinition.description,
  })
}

async function ensureApprovedVersion(
  store: SkillRegistryStore,
  skill: RegistrySkillSummary,
  packageDefinition: CorePlatformSkillPackage,
) {
  const existing = await store.listVersions(CORE_PLATFORM_CONTEXT, skill.id)
  const matchingVersion = existing.versions.find((version) => version.packageSha256 === packageDefinition.packageSha256)
  if (matchingVersion) {
    await approveSystemVersionIfNeeded(store, skill.id, matchingVersion.id)
    return matchingVersion
  }

  const version = await store.createVersion(CORE_PLATFORM_CONTEXT, {
    skillId: skill.id,
    archive: packageDefinition.package,
  })
  await approveSystemVersionIfNeeded(store, skill.id, version.id)
  return version
}

async function approveSystemVersionIfNeeded(store: SkillRegistryStore, skillId: string, versionId: string) {
  const approve = async (requestId: string) => {
    await store.approveReviewRequest(CORE_PLATFORM_CONTEXT, {
      requestId,
      reviewerNote: "Approved by Veslo core platform skill bootstrap.",
    })
  }

  try {
    const review = await store.createReviewRequest(CORE_PLATFORM_CONTEXT, {
      skillId,
      versionId,
      scope: "system",
      reason: "Seed Veslo core platform skill version.",
    })
    await approve(review.requestId)
  } catch (error) {
    if (error instanceof SkillRegistryStoreError && error.code === "version_already_approved") {
      return
    }
    if (error instanceof SkillRegistryStoreError && error.code === "review_request_already_pending") {
      const pending = await store.findPendingReviewRequest(CORE_PLATFORM_CONTEXT, {
        skillId,
        versionId,
        scope: "system",
      })
      if (!pending) throw error
      await approve(pending.requestId)
      return
    }
    throw error
  }
}

async function ensureRolloutPolicy(
  store: SkillRegistryStore,
  packageDefinition: CorePlatformSkillPackage,
  skill: RegistrySkillSummary,
  version: RegistrySkillVersionSummary,
) {
  const { policies } = await store.listRolloutPolicies(CORE_PLATFORM_CONTEXT, {
    skillId: skill.id,
    catalogScope: packageDefinition.rollout.catalogScope,
  })
  const policy = policies.find((entry) =>
    entry.target === packageDefinition.rollout.target &&
    entry.audience === packageDefinition.rollout.audience
  )

  if (!policy) {
    await store.createRolloutPolicy(CORE_PLATFORM_CONTEXT, {
      skillId: skill.id,
      versionId: version.id,
      target: packageDefinition.rollout.target,
      audience: packageDefinition.rollout.audience,
      catalogScope: packageDefinition.rollout.catalogScope,
      updatePolicy: packageDefinition.rollout.updatePolicy,
      removalPolicy: packageDefinition.rollout.removalPolicy,
      releaseChannel: null,
    })
    return
  }

  if (isCurrentRolloutPolicy(policy, packageDefinition, version)) {
    return
  }

  await store.updateRolloutPolicy(CORE_PLATFORM_CONTEXT, policy.id, {
    versionId: version.id,
    target: packageDefinition.rollout.target,
    audience: packageDefinition.rollout.audience,
    enabled: true,
    updatePolicy: packageDefinition.rollout.updatePolicy,
    releaseChannel: null,
    removalPolicy: packageDefinition.rollout.removalPolicy,
  })
}

function isCurrentRolloutPolicy(
  policy: RegistrySkillRolloutPolicy,
  packageDefinition: CorePlatformSkillPackage,
  version: RegistrySkillVersionSummary,
) {
  return policy.versionId === version.id &&
    policy.catalogScope === packageDefinition.rollout.catalogScope &&
    policy.target === packageDefinition.rollout.target &&
    policy.audience === packageDefinition.rollout.audience &&
    policy.enabled === true &&
    policy.updatePolicy === packageDefinition.rollout.updatePolicy &&
    policy.releaseChannel == null &&
    policy.removalPolicy === packageDefinition.rollout.removalPolicy
}
