import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const currentFile = fileURLToPath(import.meta.url)
const serviceRoot = path.resolve(path.dirname(currentFile), "..")
const source = readFileSync(path.join(serviceRoot, "src", "index.ts"), "utf8")

test("desktop auth bootstrapping widens handoff columns needed for auth code inserts", () => {
  assert.equal(
    source.includes('ensureVarcharColumnMinimumLength("desktop_auth_handoff", "code", 255, false)'),
    true,
    "desktop auth handoff code column must be widened at boot when legacy schema is too short",
  )

  assert.equal(
    source.includes('ensureVarcharColumnMinimumLength("desktop_auth_handoff", "session_id", 64, true)'),
    true,
    "desktop auth handoff session_id column must be widened at boot for desktop transaction ids",
  )
})
