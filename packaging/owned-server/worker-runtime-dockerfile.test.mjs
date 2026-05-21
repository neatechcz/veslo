import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dockerfile = readFileSync(path.join(__dirname, "Dockerfile"), "utf8")

test("owned-server worker runtime is built from repo sources", () => {
  assert.doesNotMatch(dockerfile, /npm install -g veslo-orchestrator@/)
  assert.match(dockerfile, /npm install -g bun@/)
  assert.match(dockerfile, /pnpm --filter veslo-server build/)
  assert.match(dockerfile, /pnpm --filter veslo-orchestrator build/)
  assert.match(dockerfile, /--allow-external/)
  assert.match(dockerfile, /--veslo-server-bin \/app\/packages\/server\/dist\/cli\.js/)
})
