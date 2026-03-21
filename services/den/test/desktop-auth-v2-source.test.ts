import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const currentFile = fileURLToPath(import.meta.url)
const serviceRoot = path.resolve(path.dirname(currentFile), "..")
const source = readFileSync(path.join(serviceRoot, "src", "http", "desktop-auth-v2.ts"), "utf8")

test("desktop auth v2 authorize supports JSON transport for browser deep-link handoff", () => {
  assert.equal(
    source.includes('req.header("x-veslo-desktop-auth-transport")'),
    true,
    "authorize route must read the browser transport preference",
  )

  assert.equal(
    source.includes("res.status(200).json({ redirectUrl })"),
    true,
    "authorize route must be able to return the deep link in JSON instead of only redirecting",
  )
})
