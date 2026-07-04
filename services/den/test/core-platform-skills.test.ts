import assert from "node:assert/strict"
import test from "node:test"

import {
  CORE_PLATFORM_SKILL_DEFINITIONS,
  buildCorePlatformSkillPackages,
} from "../src/skills/core-platform-skills.js"
import { validateSkillRegistryPackageArchive } from "../src/skills/packages.js"
import { REQUIRED_MANAGED_COMMANDS } from "../../../packages/document-runtime/src/runtime.mjs"

const EXPECTED_SKILLS = ["veslo-docx", "veslo-pdf", "veslo-pptx", "veslo-xlsx", "skill-creator"]
const DOCUMENT_RUNTIME_SKILLS = new Set(["veslo-docx", "veslo-pdf", "veslo-pptx", "veslo-xlsx"])
const HOST_INSTALL_COMMAND_RE =
  /\b(?:npm\s+install\s+-g|pip\s+install|brew\s+install(?:\s+--cask)?|choco\s+install|winget\s+install|(?:sudo\s+)?apt(?:-get)?\s+install)\b/i
const DIRECT_RUNTIME_COMMAND_LINE_RE =
  /^\s*(?:[$>]\s*)?(?:NODE_PATH=|\b(?:python|node|pandoc|weasyprint|soffice|pdftoppm|pdftotext|pdfimages|qpdf|pdftk)\b)(?=\s)/i
const DIRECT_RUNTIME_INLINE_COMMAND_RE =
  /`(?!veslo-document-runtime exec --)(?:NODE_PATH=|(?:python|node|pandoc|weasyprint|soffice|pdftoppm|pdftotext|pdfimages|qpdf|pdftk)\b\s+)[^`]*`/i
const MANAGED_RUNTIME_COMMAND_RE = /veslo-document-runtime\s+exec\s+--\s+([a-zA-Z0-9_.-]+)/g
const OPTIONAL_DOCUMENT_RUNTIME_COMMANDS = new Set(["pdftk"])
const DOCTOR_COVERED_MANAGED_COMMANDS = new Set([
  ...REQUIRED_MANAGED_COMMANDS.map((check) => check.command),
  "python",
  "node",
])

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

    if (DOCUMENT_RUNTIME_SKILLS.has(skill.name)) {
      assertDocumentRuntimeInstructions(skill.name, archive)
    }

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

function assertDocumentRuntimeInstructions(
  skillName: string,
  archive: ReturnType<typeof validateSkillRegistryPackageArchive>,
) {
  const skillMd = textFile(archive, "SKILL.md")
  assert.match(skillMd, /veslo-document-runtime exec --/, `${skillName}: missing managed runtime exec instruction`)
  assert.match(skillMd, /veslo-document-runtime doctor --json/, `${skillName}: missing managed runtime repair guidance`)
  assertDocumentRuntimeDoctorCoversSkillCommands(skillName, archive)

  for (const file of archive.files) {
    if (file.text === undefined) continue

    for (const [index, line] of file.text.split(/\r?\n/).entries()) {
      const location = `${skillName}:${file.path}:${index + 1}`
      if (HOST_INSTALL_COMMAND_RE.test(line) && !isInstallProhibitionLine(line)) {
        assert.fail(`${location} must not instruct host package installation: ${line}`)
      }

      if (!file.path.toLowerCase().endsWith(".md")) continue
      if (DIRECT_RUNTIME_COMMAND_LINE_RE.test(line) && !line.includes("veslo-document-runtime exec --")) {
        assert.fail(`${location} must run document tooling through veslo-document-runtime: ${line}`)
      }
      if (DIRECT_RUNTIME_INLINE_COMMAND_RE.test(line)) {
        assert.fail(`${location} must not include direct host runtime command examples: ${line}`)
      }
    }
  }
}

function assertDocumentRuntimeDoctorCoversSkillCommands(
  skillName: string,
  archive: ReturnType<typeof validateSkillRegistryPackageArchive>,
) {
  for (const file of archive.files) {
    if (file.text === undefined || !file.path.toLowerCase().endsWith(".md")) continue

    for (const [index, line] of file.text.split(/\r?\n/).entries()) {
      const location = `${skillName}:${file.path}:${index + 1}`
      for (const match of line.matchAll(MANAGED_RUNTIME_COMMAND_RE)) {
        const command = match[1]
        if (OPTIONAL_DOCUMENT_RUNTIME_COMMANDS.has(command)) continue
        assert.ok(
          DOCTOR_COVERED_MANAGED_COMMANDS.has(command),
          `${location} uses managed command '${command}' but veslo-document-runtime doctor does not require it`,
        )
      }
    }
  }
}

function isInstallProhibitionLine(line: string) {
  return /\bdo not\b/i.test(line)
}

function textFile(archive: ReturnType<typeof validateSkillRegistryPackageArchive>, path: string) {
  const file = archive.files.find((entry) => entry.path === path)
  assert.ok(file, `missing ${path}`)
  assert.equal(typeof file.text, "string", `${path} should be stored as text`)
  return file.text
}
