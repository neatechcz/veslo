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

test("Deploy Den workflow syncs Codex worker auth secret into Render env", async () => {
  const workflow = await readFile(path.resolve(repoRoot, ".github/workflows/deploy-den.yml"), "utf8")

  assert.match(workflow, /MANAGED_AI_CODEX_HOME/)
  assert.match(workflow, /MANAGED_AI_CODEX_AUTH_JSON/)
  assert.match(workflow, /secrets\.MANAGED_AI_CODEX_AUTH_JSON/)
})
