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

test("Deploy AI Gateway workflow syncs Codex worker auth secret into Render env", async () => {
  const workflow = await readFile(path.resolve(repoRoot, ".github/workflows/deploy-ai-gateway.yml"), "utf8")

  assert.match(workflow, /AI_GATEWAY_CODEX_HOME/)
  assert.match(workflow, /AI_GATEWAY_CODEX_AUTH_JSON/)
  assert.match(workflow, /secrets\.MANAGED_AI_CODEX_AUTH_JSON/)
})
