import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const testDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(testDir, "../../..")

test("AI Gateway package installs Codex CLI for the worker transport", async () => {
  const packageJson = JSON.parse(await readFile(path.resolve(testDir, "../package.json"), "utf8")) as {
    dependencies?: Record<string, string>
  }

  assert.equal(typeof packageJson.dependencies?.["@openai/codex"], "string")
})

test("AI Gateway Codex CLI satisfies the GPT-5.6 Sol runtime requirement", async () => {
  const packageJson = JSON.parse(await readFile(path.resolve(testDir, "../package.json"), "utf8")) as {
    dependencies?: Record<string, string>
  }

  assert.equal(compareSemver(packageJson.dependencies?.["@openai/codex"] ?? "0.0.0", "0.144.1") >= 0, true)
})

test("owned-server compose wires Codex worker state into AI Gateway", async () => {
  const compose = await readFile(path.resolve(repoRoot, "packaging/owned-server/compose.yml"), "utf8")

  assert.match(compose, /ai-gateway-codex-data:\/var\/lib\/veslo-ai-gateway\/codex/)
  assert.match(compose, /AI_GATEWAY_CODEX_COMMAND:\s*\$\{AI_GATEWAY_CODEX_COMMAND:-codex\}/)
  assert.match(compose, /AI_GATEWAY_CODEX_HOME:\s*\$\{AI_GATEWAY_CODEX_HOME:-\/var\/lib\/veslo-ai-gateway\/codex\}/)
  assert.match(compose, /AI_GATEWAY_CODEX_AUTH_JSON:\s*\$\{AI_GATEWAY_CODEX_AUTH_JSON:-\}/)
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
