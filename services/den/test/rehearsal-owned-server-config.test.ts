import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import test from "node:test"

const repoRootUrl = new URL("../../..", import.meta.url)
const repoRoot = fileURLToPath(repoRootUrl)
const baseComposePath = "packaging/owned-server/compose.yml"
const rehearsalOverridePath = "packaging/owned-server/rehearsal/compose.override.yml"

Object.assign(process.env, {
  DATABASE_URL: "mysql://root:root@localhost:3306/veslo_test",
  BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
})

function read(path: string) {
  return readFileSync(new URL(path, repoRootUrl), "utf8")
}

function renderCompose(envFile: string, includeRehearsalOverride: boolean) {
  const args = [
    "compose",
    "-p",
    "veslo-owned-server-rehearsal-config-test",
    "-f",
    baseComposePath,
  ]
  if (includeRehearsalOverride) args.push("-f", rehearsalOverridePath)
  args.push("--env-file", envFile, "config", "--format", "json")

  const environment = { ...process.env }
  for (const key of [
    "NODE_ENV",
    "LETTR_API_KEY",
    "AUTH_EMAIL_ADDRESS",
    "DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED",
  ]) {
    delete environment[key]
  }
  const result = spawnSync("docker", args, { cwd: repoRoot, encoding: "utf8", env: environment })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return JSON.parse(result.stdout) as {
    services: { den: { environment: Record<string, string> } }
  }
}

test("rehearsal uses an explicit Compose override without weakening the production base", () => {
  assert.equal(existsSync(new URL(rehearsalOverridePath, repoRootUrl)), true)
  const override = read(rehearsalOverridePath)
  assert.match(override, /den:[\s\S]*NODE_ENV:\s*development/)
  assert.doesNotMatch(read(baseComposePath), /NODE_ENV:\s*\$\{/)

  const runbook = read("packaging/owned-server/rehearsal/README.md")
  assert.match(runbook, /-f packaging\/owned-server\/compose\.yml -f packaging\/owned-server\/rehearsal\/compose\.override\.yml/)
  assert.match(runbook, /deliberately included/i)
})

test("effective Compose environments keep production fail-closed and make isolated rehearsal executable", {
  skip: spawnSync("docker", ["compose", "version"]).status === 0 ? false : "Docker Compose is unavailable",
}, async () => {
  const { parseEnv } = await import("../src/env.js")
  const production = renderCompose("packaging/owned-server/env.example", false).services.den.environment
  assert.equal(production.NODE_ENV, "production")
  assert.equal(production.DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED, "true")
  assert.equal(parseEnv(production).authRequireEmailVerification, true)

  const unsafeBaseRehearsal = renderCompose("packaging/owned-server/env.rehearsal.example", false)
    .services.den.environment
  assert.equal(unsafeBaseRehearsal.NODE_ENV, "production")
  assert.equal(unsafeBaseRehearsal.DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED, "false")
  assert.throws(
    () => parseEnv(unsafeBaseRehearsal),
    /LETTR_API_KEY and AUTH_EMAIL_ADDRESS are required/,
  )

  const rehearsal = renderCompose("packaging/owned-server/env.rehearsal.example", true).services.den.environment
  assert.equal(rehearsal.NODE_ENV, "development")
  assert.equal(rehearsal.DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED, "false")
  assert.equal(rehearsal.LETTR_API_KEY, "")
  assert.equal(rehearsal.AUTH_EMAIL_ADDRESS, "")
  assert.equal(parseEnv(rehearsal).authRequireEmailVerification, false)
})
