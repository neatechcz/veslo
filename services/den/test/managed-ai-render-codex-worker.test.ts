import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const testDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(testDir, "../../..")

test("DEN package installs Codex CLI for the managed AI worker transport", async () => {
  const packageJson = JSON.parse(await readFile(path.resolve(testDir, "../package.json"), "utf8")) as {
    dependencies?: Record<string, string>
  }

  assert.equal(typeof packageJson.dependencies?.["@openai/codex"], "string")
})

test("DEN Codex CLI satisfies the GPT-5.6 Sol runtime requirement", async () => {
  const packageJson = JSON.parse(await readFile(path.resolve(testDir, "../package.json"), "utf8")) as {
    dependencies?: Record<string, string>
  }

  assert.equal(compareSemver(packageJson.dependencies?.["@openai/codex"] ?? "0.0.0", "0.144.1") >= 0, true)
})

test("owned-server compose wires Codex worker state into DEN", async () => {
  const compose = await readFile(path.resolve(repoRoot, "packaging/owned-server/compose.yml"), "utf8")

  assert.match(compose, /den-codex-data:\/var\/lib\/veslo-den\/codex/)
  assert.match(compose, /MANAGED_AI_CODEX_COMMAND:\s*\$\{MANAGED_AI_CODEX_COMMAND:-codex\}/)
  assert.match(compose, /MANAGED_AI_CODEX_HOME:\s*\$\{MANAGED_AI_CODEX_HOME:-\/var\/lib\/veslo-den\/codex\}/)
  assert.match(compose, /MANAGED_AI_CODEX_AUTH_JSON:\s*\$\{MANAGED_AI_CODEX_AUTH_JSON:-\}/)
})

function compareSemver(left: string, right: string): number {
  const leftParts = readSemverParts(left)
  const rightParts = readSemverParts(right)
  for (let index = 0; index < 3; index += 1) {
    const delta = leftParts[index]! - rightParts[index]!
    if (delta !== 0) return delta
  }
  return 0
}

function readSemverParts(value: string): [number, number, number] {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!match) return [0, 0, 0]
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}
