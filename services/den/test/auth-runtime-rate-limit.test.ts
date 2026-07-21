import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { dirname, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const denDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")

type AuthRuntimeSnapshot = {
  nodeEnv: string
  authRequireEmailVerification: boolean
  configuredRateLimit: { enabled: boolean } | null
  rateLimit: {
    enabled: boolean
    window: number
    max: number
    storage: string
  }
}

const inspectAuthRuntimeScript = String.raw`
try {
  const { env } = await import("./src/env.ts")
  const { auth } = await import("./src/auth.ts")
  const context = await auth.$context
  const snapshot = {
    nodeEnv: env.nodeEnv,
    authRequireEmailVerification: env.authRequireEmailVerification,
    configuredRateLimit: auth.options.rateLimit ?? null,
    rateLimit: {
      enabled: context.rateLimit.enabled,
      window: context.rateLimit.window,
      max: context.rateLimit.max,
      storage: context.rateLimit.storage,
    },
  }
  process.stdout.write(JSON.stringify(snapshot), () => process.exit(0))
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write("INIT_ERROR:" + message + "\n")
  process.exitCode = 1
}
`

for (const scenario of [
  { nodeEnv: "production", expectedNodeEnv: "production", expectedEnabled: true },
  { nodeEnv: " PrOdUcTiOn ", expectedNodeEnv: "production", expectedEnabled: true },
  { nodeEnv: "development", expectedNodeEnv: "development", expectedEnabled: false },
  { nodeEnv: "test", expectedNodeEnv: "test", expectedEnabled: false },
] as const) {
  test(`Better Auth rate limiting follows normalized NODE_ENV=${JSON.stringify(scenario.nodeEnv)}`, () => {
    const result = runAuthRuntimeChild(scenario.nodeEnv)
    assert.equal(result.status, 0, result.stderr)
    const snapshot = JSON.parse(result.stdout) as AuthRuntimeSnapshot

    assert.equal(snapshot.nodeEnv, scenario.expectedNodeEnv)
    assert.equal(snapshot.authRequireEmailVerification, scenario.expectedNodeEnv === "production")
    assert.deepEqual(snapshot.rateLimit, {
      enabled: scenario.expectedEnabled,
      window: 10,
      max: 100,
      storage: "memory",
    })
    assert.deepEqual(snapshot.configuredRateLimit, { enabled: scenario.expectedEnabled })
  })
}

test("malformed NODE_ENV is rejected before Better Auth initialization", () => {
  const result = runAuthRuntimeChild("productionx")

  assert.equal(result.status, 1)
  assert.match(result.stderr, /INIT_ERROR:NODE_ENV must be one of 'development', 'test', or 'production'\./)
  assert.doesNotMatch(result.stderr, /BETTER_AUTH_SECRET appears low-entropy/)
  assert.equal(result.stdout, "")
})

function runAuthRuntimeChild(nodeEnv: string) {
  const childEnv: NodeJS.ProcessEnv = {
    NODE_ENV: nodeEnv,
    DATABASE_URL: "mysql://den:den@127.0.0.1:1/den",
    BETTER_AUTH_SECRET: "runtime_rate_limit_test_secret_at_least_32_chars",
    BETTER_AUTH_URL: "https://api.veslo.test",
    CORS_ORIGINS: "https://app.veslo.test",
    LETTR_API_KEY: "runtime-rate-limit-test-key",
    AUTH_EMAIL_ADDRESS: "runtime-rate-limit@veslo.test",
    PROVISIONER_MODE: "stub",
    NO_COLOR: "1",
  }
  for (const key of ["PATH", "TMPDIR"] as const) {
    if (process.env[key]) childEnv[key] = process.env[key]
  }

  return spawnSync(
    process.execPath,
    ["--import=tsx", "--input-type=module", "--eval", inspectAuthRuntimeScript],
    {
      cwd: denDir,
      encoding: "utf8",
      env: childEnv,
      timeout: 20_000,
    },
  )
}
