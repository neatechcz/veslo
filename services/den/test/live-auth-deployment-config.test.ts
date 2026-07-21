import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { fileURLToPath } from "node:url"

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = path.resolve(serviceRoot, "../..")
const validator = path.join(serviceRoot, "scripts", "validate-live-auth-env.sh")

function runValidator(label: "production" | "staging", contents: string) {
  const directory = mkdtempSync(path.join(tmpdir(), "veslo-live-auth-env-"))
  const envPath = path.join(directory, `${label}.env`)
  writeFileSync(envPath, contents, { mode: 0o600 })
  const result = spawnSync("bash", [validator, label, envPath], {
    encoding: "utf8",
  })
  rmSync(directory, { recursive: true, force: true })
  return result
}

test("live and staging deployment validation accepts only enabled configured verification", () => {
  for (const label of ["production", "staging"] as const) {
    const result = runValidator(label, [
      "DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED=true",
      "LETTR_API_KEY=lettr-test-key",
      "AUTH_EMAIL_ADDRESS=auth@example.test",
      "",
    ].join("\n"))

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, new RegExp(`${label} auth email verification configuration is valid`))
  }
})

test("live and staging deployment validation fails closed without exposing configured secrets", () => {
  const invalidCases = [
    "DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED=false\nLETTR_API_KEY=lettr-super-secret\nAUTH_EMAIL_ADDRESS=auth@example.test\n",
    "LETTR_API_KEY=lettr-super-secret\nAUTH_EMAIL_ADDRESS=auth@example.test\n",
    "DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED=true\nAUTH_EMAIL_ADDRESS=auth@example.test\n",
    "DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED=true\nLETTR_API_KEY=lettr-super-secret\n",
    "DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED=true\nLETTR_API_KEY=\"   \"\nAUTH_EMAIL_ADDRESS=auth@example.test\n",
  ]

  for (const label of ["production", "staging"] as const) {
    for (const contents of invalidCases) {
      const result = runValidator(label, contents)
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, new RegExp(`${label} auth email verification configuration is invalid`))
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /lettr-super-secret/)
    }
  }
})

test("live and staging workflows run the dedicated auth verification gate", () => {
  const productionWorkflow = readFileSync(path.join(repoRoot, ".github/workflows/deploy-owned-server.yml"), "utf8")
  const stagingWorkflow = readFileSync(path.join(repoRoot, ".github/workflows/deploy-staging-server.yml"), "utf8")

  assert.match(
    productionWorkflow,
    /validate-live-auth-env\.sh production "\$OWNED_SERVER_ENV_FILE"/,
  )
  assert.match(
    stagingWorkflow,
    /validate-live-auth-env\.sh staging "\$STAGING_SERVER_ENV_FILE"/,
  )
})
