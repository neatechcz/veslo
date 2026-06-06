import assert from "node:assert/strict"
import test from "node:test"

import {
  ensureCorePlatformSkills,
  CORE_PLATFORM_CONTEXT,
} from "../src/skills/core-platform-skill-bootstrap.js"
import {
  buildCorePlatformSkillPackages,
  type CorePlatformSkillPackage,
} from "../src/skills/core-platform-skills.js"
import { buildSkillRegistryPackageArchive } from "../src/skills/packages.js"
import { InMemorySkillRegistryStore } from "../src/skills/store.js"

test("bootstrap creates approved system skills and locked platform rollout policies", async () => {
  const store = new InMemorySkillRegistryStore()
  const packages = await buildCorePlatformSkillPackages()

  await ensureCorePlatformSkills(store, { packages })

  const snapshot = store.snapshot()
  assert.equal(snapshot.skills.length, packages.length)
  assert.equal(snapshot.versions.length, packages.length)
  assert.equal(snapshot.reviewRequests.length, packages.length)
  assert.equal(snapshot.approvals.length, packages.length)
  assert.equal(snapshot.rolloutPolicies.length, packages.length)

  for (const packageDefinition of packages) {
    const skill = snapshot.skills.find((entry) => entry.name === packageDefinition.name)
    assert.ok(skill, `missing skill ${packageDefinition.name}`)
    assert.equal(skill.scope, "system")
    assert.equal(skill.orgId, null)
    assert.equal(skill.ownerUserId, null)
    assert.equal(skill.workspaceId, null)

    const version = snapshot.versions.find((entry) => entry.skillId === skill.id)
    assert.ok(version, `missing version ${packageDefinition.name}`)
    assert.equal(version.status, "approved")
    assert.equal(version.packageSha256, packageDefinition.packageSha256)
    assert.equal(skill.latestVersionId, version.id)

    const review = snapshot.reviewRequests.find((entry) => entry.versionId === version.id)
    assert.ok(review, `missing review ${packageDefinition.name}`)
    assert.equal(review.scope, "system")
    assert.equal(review.status, "approved")

    const approval = snapshot.approvals.find((entry) => entry.versionId === version.id)
    assert.ok(approval, `missing approval ${packageDefinition.name}`)
    assert.equal(approval.scope, "system")
    assert.equal(approval.orgId, null)

    const policy = snapshot.rolloutPolicies.find((entry) => entry.skillId === skill.id)
    assert.ok(policy, `missing rollout policy ${packageDefinition.name}`)
    assert.equal(policy.catalogScope, "platform")
    assert.equal(policy.target, "user-global")
    assert.equal(policy.audience, "all-platform-users")
    assert.equal(policy.removalPolicy, "locked")
    assert.equal(policy.updatePolicy, "pinned")
    assert.equal(policy.desiredVersionId, version.id)
    assert.equal(policy.ownerOrgId, null)
    assert.equal(policy.userId, null)
    assert.equal(policy.workspaceId, null)
    assert.equal(policy.enabled, true)
  }

  const listed = await store.listSkills({ userId: "user_1" }, { ownerScope: "system" })
  assert.deepEqual(
    listed.skills.map((skill) => skill.slug).sort(),
    packages.map((entry) => entry.name).sort(),
  )
  assert.ok(listed.skills.every((skill) => skill.visibility === "platform"))
  assert.ok(listed.skills.every((skill) => skill.reviewStatus === "approved"))
  assert.ok(listed.skills.every((skill) => skill.latestVersion))
})

test("bootstrap is idempotent for unchanged package hashes", async () => {
  const store = new InMemorySkillRegistryStore()
  const packages = await buildCorePlatformSkillPackages()

  await ensureCorePlatformSkills(store, { packages })
  const first = idsByCollection(store.snapshot())

  await ensureCorePlatformSkills(store, { packages })
  const second = idsByCollection(store.snapshot())

  assert.deepEqual(second, first)
})

test("bootstrap creates and approves a new version when a package hash changes", async () => {
  const store = new InMemorySkillRegistryStore()
  const packages = await buildCorePlatformSkillPackages()

  await ensureCorePlatformSkills(store, { packages })
  const firstSnapshot = store.snapshot()
  const changedPackage = await appendToSkillEntrypoint(packages[0], "\nBootstrap update path coverage.\n")
  const updatedPackages = [changedPackage, ...packages.slice(1)]

  await ensureCorePlatformSkills(store, { packages: updatedPackages })
  const secondSnapshot = store.snapshot()

  assert.equal(secondSnapshot.skills.length, packages.length)
  assert.equal(secondSnapshot.rolloutPolicies.length, packages.length)
  assert.equal(secondSnapshot.versions.length, packages.length + 1)

  const skill = secondSnapshot.skills.find((entry) => entry.name === changedPackage.name)
  assert.ok(skill)
  const versions = secondSnapshot.versions
    .filter((entry) => entry.skillId === skill.id)
    .sort((left, right) => left.versionNumber - right.versionNumber)
  assert.equal(versions.length, 2)
  assert.equal(versions[0].packageSha256, packages[0].packageSha256)
  assert.equal(versions[1].packageSha256, changedPackage.packageSha256)
  assert.equal(versions[1].status, "approved")
  assert.equal(skill.latestVersionId, versions[1].id)

  const firstPolicy = firstSnapshot.rolloutPolicies.find((entry) => entry.skillId === skill.id)
  const secondPolicy = secondSnapshot.rolloutPolicies.find((entry) => entry.skillId === skill.id)
  assert.ok(firstPolicy)
  assert.ok(secondPolicy)
  assert.equal(secondPolicy.id, firstPolicy.id)
  assert.equal(secondPolicy.desiredVersionId, versions[1].id)
  assert.equal(secondPolicy.removalPolicy, "locked")
  assert.equal(secondPolicy.updatePolicy, "pinned")

  for (const unchangedPackage of packages.slice(1)) {
    const unchangedSkill = secondSnapshot.skills.find((entry) => entry.name === unchangedPackage.name)
    assert.ok(unchangedSkill)
    assert.equal(secondSnapshot.versions.filter((entry) => entry.skillId === unchangedSkill.id).length, 1)
  }
})

test("bootstrap recovers an existing pending system review request", async () => {
  const store = new InMemorySkillRegistryStore()
  const packages = await buildCorePlatformSkillPackages()
  const packageDefinition = packages[0]

  const skill = await store.createSkill(CORE_PLATFORM_CONTEXT, {
    scope: packageDefinition.scope,
    name: packageDefinition.name,
    displayName: packageDefinition.displayName,
    description: packageDefinition.description,
  })
  const version = await store.createVersion(CORE_PLATFORM_CONTEXT, {
    skillId: skill.id,
    archive: packageDefinition.package,
  })
  const pending = await store.createReviewRequest(CORE_PLATFORM_CONTEXT, {
    skillId: skill.id,
    versionId: version.id,
    scope: "system",
  })

  await ensureCorePlatformSkills(store, { packages })

  const snapshot = store.snapshot()
  const recovered = snapshot.reviewRequests.find((entry) => entry.id === pending.requestId)
  assert.ok(recovered)
  assert.equal(recovered.status, "approved")
  assert.equal(snapshot.approvals.filter((entry) => entry.versionId === version.id).length, 1)
})

function idsByCollection(snapshot: ReturnType<InMemorySkillRegistryStore["snapshot"]>) {
  return {
    skills: snapshot.skills.map((entry) => entry.id).sort(),
    versions: snapshot.versions.map((entry) => entry.id).sort(),
    reviewRequests: snapshot.reviewRequests.map((entry) => entry.id).sort(),
    approvals: snapshot.approvals.map((entry) => entry.id).sort(),
    rolloutPolicies: snapshot.rolloutPolicies.map((entry) => entry.id).sort(),
  }
}

async function appendToSkillEntrypoint(
  packageDefinition: CorePlatformSkillPackage,
  suffix: string,
): Promise<CorePlatformSkillPackage> {
  const archive = await buildSkillRegistryPackageArchive({
    metadata: packageDefinition.package.metadata,
    files: packageDefinition.package.files.map((file) => {
      const bytes = file.path === "SKILL.md"
        ? Buffer.from(`${file.text ?? Buffer.from(file.contentBase64, "base64").toString("utf8")}${suffix}`, "utf8")
        : Buffer.from(file.contentBase64, "base64")
      return {
        path: file.path,
        bytes,
        mediaType: file.mediaType,
        executable: file.executable,
      }
    }),
  })

  return {
    ...packageDefinition,
    package: archive,
    packageSha256: archive.packageSha256,
  }
}
