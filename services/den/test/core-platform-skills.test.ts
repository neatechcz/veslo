import assert from "node:assert/strict"
import test from "node:test"

import {
  CORE_PLATFORM_SKILL_DEFINITIONS,
  buildCorePlatformSkillPackages,
} from "../src/skills/core-platform-skills.js"
import { validateSkillRegistryPackageArchive } from "../src/skills/packages.js"

const EXPECTED_SKILLS = ["veslo-docx", "veslo-pdf", "veslo-pptx", "veslo-xlsx", "skill-creator"]

test("core platform skill definitions describe locked platform-wide user-global rollout", () => {
  assert.deepEqual(CORE_PLATFORM_SKILL_DEFINITIONS.map((skill) => skill.name), EXPECTED_SKILLS)

  for (const skill of CORE_PLATFORM_SKILL_DEFINITIONS) {
    assert.equal(skill.scope, "system")
    assert.equal(skill.rollout.catalogScope, "platform")
    assert.equal(skill.rollout.target, "user-global")
    assert.equal(skill.rollout.audience, "all-platform-users")
    assert.equal(skill.rollout.updatePolicy, "pinned")
    assert.equal(skill.rollout.removalPolicy, "locked")
    assert.ok(skill.displayName)
    assert.ok(skill.description)
  }
})

test("core platform skill packages are valid registry archives without legacy runtime markers", async () => {
  const packages = await buildCorePlatformSkillPackages()
  assert.deepEqual(packages.map((skill) => skill.name), EXPECTED_SKILLS)

  for (const skill of packages) {
    const archive = validateSkillRegistryPackageArchive(skill.package)
    assert.equal(archive.metadata.name, skill.name)
    assert.equal(archive.metadata.description, skill.description)
    assert.equal(archive.packageSha256, skill.packageSha256)
    assert.ok(archive.files.some((file) => file.path === "SKILL.md"))
    assert.ok(archive.files.every((file) => !file.path.startsWith("/") && !file.path.includes("..")))

    const skillMd = textFile(archive, "SKILL.md")
    assert.match(skillMd, new RegExp(`name:\\s*${skill.name}`))
    assert.doesNotMatch(skillMd, /veslo_internal_pack/)
    assert.doesNotMatch(skillMd, /veslo_internal_snapshot/)
    assert.doesNotMatch(skillMd, /\.opencode\/veslo\/internal/)
    assert.doesNotMatch(skillMd, /skills\/public/)
    assert.doesNotMatch(skillMd, /veslo-internal-/)
    assert.doesNotMatch(skillMd, /veslo-delegate/)
    assert.doesNotMatch(skillMd, /mode:\s*subagent/i)
    assert.doesNotMatch(skillMd, /hidden:\s*true/i)
    assert.doesNotMatch(skillMd, /\bchild[- ]session\b/i)

    for (const file of archive.files) {
      if (file.text === undefined) continue
      assert.doesNotMatch(file.text, /veslo_internal_pack/, `${skill.name}:${file.path}`)
      assert.doesNotMatch(file.text, /veslo_internal_snapshot/, `${skill.name}:${file.path}`)
      assert.doesNotMatch(file.text, /\.opencode\/veslo\/internal/, `${skill.name}:${file.path}`)
      assert.doesNotMatch(file.text, /skills\/public/, `${skill.name}:${file.path}`)
      assert.doesNotMatch(file.text, /veslo-internal-/, `${skill.name}:${file.path}`)
      assert.doesNotMatch(file.text, /veslo-delegate/, `${skill.name}:${file.path}`)
      assert.doesNotMatch(file.text, /mode:\s*subagent/i, `${skill.name}:${file.path}`)
      assert.doesNotMatch(file.text, /hidden:\s*true/i, `${skill.name}:${file.path}`)
    }
  }
})

function textFile(archive: ReturnType<typeof validateSkillRegistryPackageArchive>, path: string) {
  const file = archive.files.find((entry) => entry.path === path)
  assert.ok(file, `missing ${path}`)
  assert.equal(typeof file.text, "string", `${path} should be stored as text`)
  return file.text
}
