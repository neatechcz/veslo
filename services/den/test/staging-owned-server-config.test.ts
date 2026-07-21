import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import test from "node:test"

const repoRootUrl = new URL("../../..", import.meta.url)

function read(path: string): string {
  return readFileSync(new URL(path, repoRootUrl), "utf8")
}

function parseEnvTemplate(contents: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const line of contents.split("\n")) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue
    const separatorIndex = line.indexOf("=")
    values.set(line.slice(0, separatorIndex), line.slice(separatorIndex + 1))
  }
  return values
}

function readWorkflowEmailActivationValidationBlock(workflow: string) {
  const deployStep = workflow.match(
    /- name: Deploy Compose stack[\s\S]*?(?=\n\s+- name: Verify public)/,
  )?.[0]
  assert.ok(deployStep)

  const script = deployStep
    .split("\n")
    .slice(2)
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n")
  const functionsStart = script.indexOf("require_nonempty_effective_env_value()")
  const callsStart = script.indexOf("compose_environment=\"")
  const composeFunctionStart = script.indexOf("\ncompose() {", callsStart)
  assert.ok(functionsStart >= 0 && callsStart > functionsStart && composeFunctionStart > callsStart)
  return script.slice(functionsStart, composeFunctionStart).trimEnd()
}

function runWorkflowEmailActivationValidation(workflow: string, envContents: string) {
  const validationBlock = readWorkflowEmailActivationValidationBlock(workflow)

  const tempDirectory = mkdtempSync(join(tmpdir(), "veslo-email-activation-env-"))
  const envPath = join(tempDirectory, "deployment.env")
  const composePath = join(tempDirectory, "compose.yml")
  const dockerStubPath = join(tempDirectory, "docker")
  const sudoStubPath = join(tempDirectory, "sudo")
  writeFileSync(envPath, envContents, "utf8")
  writeFileSync(composePath, "services:\n  validation-probe:\n    image: scratch\n", "utf8")
  writeFileSync(dockerStubPath, [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "args=(\"$@\")",
    "for ((index = 0; index < ${#args[@]}; index++)); do",
    "  if [ \"${args[$index]}\" = \"-f\" ]; then",
    "    args[$((index + 1))]=\"$VESLO_TEST_COMPOSE_FILE\"",
    "  fi",
    "done",
    "exec \"$VESLO_TEST_REAL_DOCKER\" \"${args[@]}\"",
    "",
  ].join("\n"), "utf8")
  writeFileSync(sudoStubPath, [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "if [ \"${1:-}\" = \"-n\" ]; then shift; fi",
    "exec \"$@\"",
    "",
  ].join("\n"), "utf8")
  chmodSync(dockerStubPath, 0o755)
  chmodSync(sudoStubPath, 0o755)
  try {
    const realDocker = spawnSync("bash", ["-c", "command -v docker"], { encoding: "utf8" }).stdout.trim()
    assert.ok(realDocker, "Docker executable must be available for effective Compose validation")
    const validationEnv = {
      ...process.env,
      PATH: `${tempDirectory}:${process.env.PATH ?? ""}`,
      OWNED_SERVER_ENV_FILE: envPath,
      STAGING_SERVER_ENV_FILE: envPath,
      STAGING_COMPOSE_PROJECT: "veslo-email-activation-validation",
      VESLO_TEST_COMPOSE_FILE: composePath,
      VESLO_TEST_REAL_DOCKER: realDocker,
    }
    delete validationEnv.LETTR_API_KEY
    delete validationEnv.AUTH_EMAIL_ADDRESS
    delete validationEnv.DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED
    delete validationEnv.VESLO_TEST_UNSET_LETTR
    delete validationEnv.VESLO_TEST_UNSET_ADDRESS

    return spawnSync("bash", ["-c", `set -euo pipefail\n${validationBlock}`], {
      cwd: fileURLToPath(repoRootUrl),
      encoding: "utf8",
      env: validationEnv,
    })
  } finally {
    rmSync(tempDirectory, { force: true, recursive: true })
  }
}

test("owned-server has separate durable staging and local rehearsal env templates", () => {
  const stagingEnv = read("packaging/owned-server/env.staging.example")
  const rehearsalEnv = read("packaging/owned-server/env.rehearsal.example")
  const stagingValues = parseEnvTemplate(stagingEnv)

  for (const requiredText of [
    "Copy to /srv/veslo/env/staging.env",
    "BETTER_AUTH_URL=https://api.staging.veslo.work",
    "CORS_ORIGINS=https://app.staging.veslo.work,https://ai.staging.veslo.work,https://admin.staging.veslo.work",
    "DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED=true",
    "PROVISIONER_MODE=owned-server",
    "OWNED_WORKER_PUBLIC_DOMAIN_SUFFIX=workers.staging.veslo.work",
    "VESLO_DOCKER_NETWORK=veslo-staging-server-runtime",
    "WORKER_IMAGE=veslo-staging-worker-runtime:local",
    "BACKUP_HOST_ROOT=/srv/veslo/staging/backups",
    "VESLO_CADDYFILE=./Caddyfile.staging",
    "GOOGLE_WORKSPACE_OAUTH_REDIRECT_URI=https://api.staging.veslo.work/v1/integrations/google/oauth/callback",
    "GOOGLE_WORKSPACE_OAUTH_SUCCESS_REDIRECT_URL=https://app.staging.veslo.work/settings/integrations/google",
    "GOOGLE_WORKSPACE_CONNECTOR_BASE_URL=https://api.staging.veslo.work",
    "MICROSOFT_REDIRECT_URI=https://api.staging.veslo.work/v1/integrations/microsoft/oauth/callback",
    "MICROSOFT_CONNECTOR_BASE_URL=https://api.staging.veslo.work",
    "MANAGED_AI_SECRET_KEY=replace_with_staging_32_char_ai_gateway_secret",
    "MANAGED_AI_OPENAI_REDIRECT_BASE=",
    "AI_GATEWAY_OPENAI_REDIRECT_BASE=https://ai.staging.veslo.work/auth/openai",
    "AI_GATEWAY_DEN_API_BASE=https://api.staging.veslo.work",
    "DEN_API_BASE=https://api.staging.veslo.work",
    "DEN_AUTH_ORIGIN=https://api.staging.veslo.work",
    "NEXT_PUBLIC_VESLO_AUTH_CALLBACK_URL=https://app.staging.veslo.work",
  ]) {
    assert.match(stagingEnv, new RegExp(requiredText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  }
  assert.equal(stagingValues.get("MANAGED_AI_DATABASE_URL"), stagingValues.get("AI_GATEWAY_DATABASE_URL"))

  for (const forbiddenText of [
    "BETTER_AUTH_URL=http://den:8788",
    "NEXT_PUBLIC_VESLO_AUTH_CALLBACK_URL=http://localhost:3005",
    "PROVISIONER_MODE=stub",
    "workers.veslo.work",
    "MANAGED_AI_OPENAI_REDIRECT_BASE=https://ai.staging.veslo.work/auth/openai",
  ]) {
    assert.equal(stagingEnv.includes(forbiddenText), false, `durable staging env must not include ${forbiddenText}`)
  }

  for (const rehearsalText of [
    "Copy to /srv/veslo/env/rehearsal.env",
    "BETTER_AUTH_URL=http://den:8788",
    "NEXT_PUBLIC_VESLO_AUTH_CALLBACK_URL=http://localhost:3005",
    "PROVISIONER_MODE=stub",
  ]) {
    assert.match(rehearsalEnv, new RegExp(rehearsalText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  }
})

test("staging Caddyfile routes the full staging hostname set", () => {
  const caddyfilePath = "packaging/owned-server/Caddyfile.staging"
  assert.equal(existsSync(new URL(caddyfilePath, repoRootUrl)), true, "staging Caddyfile must exist")

  const caddyfile = read(caddyfilePath)
  for (const requiredText of [
    "api.staging.veslo.work",
    "reverse_proxy den:8788",
    "ai.staging.veslo.work",
    "reverse_proxy ai-gateway:4034",
    "admin.staging.veslo.work",
    "redir / /admin 308",
    "app.staging.veslo.work",
    "reverse_proxy web:3005",
    "*.workers.staging.veslo.work",
    "reverse_proxy worker-manager:8790",
  ]) {
    assert.match(caddyfile, new RegExp(requiredText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  }

  for (const forbiddenHost of ["api.veslo.work", "ai.veslo.work", "app.veslo.work", "*.workers.veslo.work"]) {
    assert.equal(caddyfile.includes(forbiddenHost), false, `staging Caddyfile must not route ${forbiddenHost}`)
  }
})

test("Compose lets staging override Caddyfile and backup host root without changing production defaults", () => {
  const compose = read("packaging/owned-server/compose.yml")

  for (const requiredText of [
    "${BACKUP_HOST_ROOT:-/srv/veslo/backups}:/srv/veslo/backups",
    "${VESLO_CADDYFILE:-./Caddyfile}:/etc/caddy/Caddyfile:ro",
  ]) {
    assert.match(compose, new RegExp(requiredText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  }
})

test("staging deploy workflow runs only on the staging self-hosted runner", () => {
  const workflow = read(".github/workflows/deploy-staging-server.yml")

  for (const requiredText of [
    "name: Deploy Staging Server",
    "workflow_dispatch",
    "runs-on:",
    "self-hosted",
    "linux",
    "x64",
    "veslo-staging-server",
    "STAGING_SERVER_APP_DIR",
    "STAGING_SERVER_ENV_FILE",
    "STAGING_COMPOSE_PROJECT",
    "STAGING_SERVER_CADDYFILE",
    "git_auth fetch --prune origin",
    "docker compose",
    "build worker-runtime-image worker-manager backup den ai-gateway web",
    "pnpm --filter @neatech/den db:migrate",
    "pnpm --filter @neatech/ai-gateway db:migrate",
    "https://api.staging.veslo.work/health",
    "https://ai.staging.veslo.work/health",
    "https://app.staging.veslo.work",
    "https://admin.staging.veslo.work/admin",
  ]) {
    assert.match(workflow, new RegExp(requiredText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  }

  for (const forbiddenText of [
    "veslo-owned-server",
    "https://api.veslo.work/health",
    "https://ai.veslo.work/health",
    "https://app.veslo.work",
    "OWNED_SERVER_ENV_FILE",
    "OWNED_SERVER_APP_DIR",
    "/home/neatech/veslo-owned-server-production",
    "/home/neatech/veslo-owned-server-dark-launch-inputs/env/production.env",
    "neatechcz/veslo-updates",
  ]) {
    assert.equal(
      workflow.includes(forbiddenText),
      false,
      `staging deploy workflow must not include ${forbiddenText}`,
    )
  }
})

test("owned-server deploy workflows wait for database health before migrations", () => {
  for (const workflowPath of [
    ".github/workflows/deploy-owned-server.yml",
    ".github/workflows/deploy-staging-server.yml",
  ]) {
    const workflow = read(workflowPath)
    assert.match(workflow, /wait_for_compose_health\(\)/)
    assert.match(workflow, /wait_for_compose_health den-db/)
    assert.match(workflow, /wait_for_compose_health ai-gateway-db/)
    assert.match(
      workflow,
      /wait_for_compose_health den-db[\s\S]+wait_for_compose_health ai-gateway-db[\s\S]+pnpm --filter @neatech\/den db:migrate/,
      `${workflowPath} must wait for both databases before Den migrations`,
    )
  }
})

test("production owned-server templates require configured email activation", () => {
  for (const envPath of [
    "packaging/owned-server/env.example",
    "packaging/owned-server/env.staging.example",
  ]) {
    const envTemplate = read(envPath)

    for (const requiredText of [
      "DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED=true",
      "LETTR_API_KEY=replace_with_lettr_api_key",
      "AUTH_EMAIL_ADDRESS=auth@veslo.work",
    ]) {
      assert.match(
        envTemplate,
        new RegExp(requiredText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `${envPath} must ship a fail-closed email activation value for ${requiredText.split("=")[0]}`,
      )
    }
  }

  const compose = read("packaging/owned-server/compose.yml")
  assert.match(compose, /LETTR_API_KEY:\s*\$\{LETTR_API_KEY:-\}/)
  assert.match(compose, /AUTH_EMAIL_ADDRESS:\s*\$\{AUTH_EMAIL_ADDRESS:-\}/)
  assert.match(
    compose,
    /DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED:\s*\$\{DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED:-true\}/,
  )

  const rehearsalEnv = read("packaging/owned-server/env.rehearsal.example")
  assert.match(rehearsalEnv, /isolated rehearsal may disable email verification/i)
  assert.match(rehearsalEnv, /DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED=false/)

  const localDocker = read("packaging/docker/docker-compose.dev.yml")
  assert.match(localDocker, /isolated local Docker development may disable email verification/i)
  assert.match(localDocker, /DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED: "false"/)
})

test("owned-server deploy workflows validate email activation before starting Den", () => {
  for (const [workflowPath, envFileVariable] of [
    [".github/workflows/deploy-owned-server.yml", "OWNED_SERVER_ENV_FILE"],
    [".github/workflows/deploy-staging-server.yml", "STAGING_SERVER_ENV_FILE"],
  ] as const) {
    const workflow = read(workflowPath)
    const deployStep = workflow.match(
      /- name: Deploy Compose stack[\s\S]*?(?=\n\s+- name: Verify public)/,
    )?.[0]

    assert.ok(deployStep, `${workflowPath} must contain its Compose deploy step`)
    assert.match(deployStep, /require_nonempty_effective_env_value\(\)/)
    assert.match(deployStep, /require_email_verification_enabled\(\)/)
    assert.match(deployStep, new RegExp(`--env-file "\\$${envFileVariable}" config --environment`))
    assert.match(deployStep, /require_nonempty_effective_env_value LETTR_API_KEY/)
    assert.match(deployStep, /require_nonempty_effective_env_value AUTH_EMAIL_ADDRESS/)
    assert.match(deployStep, /require_email_verification_enabled/)
    assert.match(deployStep, /Missing required email activation setting: \$key/)
    assert.match(deployStep, /DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED must be true/)
    assert.doesNotMatch(deployStep, /\$LETTR_API_KEY|\$AUTH_EMAIL_ADDRESS/)

    const validationIndex = deployStep.indexOf("config --environment")
    const composeStartIndex = deployStep.indexOf("compose up -d")
    assert.ok(
      validationIndex >= 0 && composeStartIndex > validationIndex,
      `${workflowPath} must reject unsafe email activation config before starting Compose services`,
    )
  }
})

test("owned-server email activation validation uses effective Compose env-file values", {
  skip: spawnSync("docker", ["compose", "version"]).status === 0 ? false : "Docker Compose is unavailable",
}, () => {
  for (const workflowPath of [
    ".github/workflows/deploy-owned-server.yml",
    ".github/workflows/deploy-staging-server.yml",
  ]) {
    const workflow = read(workflowPath)
    assert.match(
      readWorkflowEmailActivationValidationBlock(workflow),
      /compose_environment="\$\(sudo -n docker compose[\s\S]*config --environment \| awk/,
      `${workflowPath} harness must execute the unchanged workflow assignment and filter`,
    )
    const accepted = runWorkflowEmailActivationValidation(workflow, [
      "LETTR_API_KEY='not-a-real-secret'",
      "AUTH_EMAIL_ADDRESS=\"auth@veslo.work\"",
      "DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED=\"true\"",
      "",
    ].join("\n"))
    assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout)
    assert.doesNotMatch(`${accepted.stdout}\n${accepted.stderr}`, /not-a-real-secret|auth@veslo\.work/)

    for (const [unsafeEnv, expectedError] of [
      [
        "AUTH_EMAIL_ADDRESS=auth@veslo.work\nDESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED=true\n",
        "Missing required email activation setting: LETTR_API_KEY",
      ],
      [
        "LETTR_API_KEY=not-a-real-secret\nDESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED=true\n",
        "Missing required email activation setting: AUTH_EMAIL_ADDRESS",
      ],
      [
        "LETTR_API_KEY=not-a-real-secret\nAUTH_EMAIL_ADDRESS=auth@veslo.work\n",
        "DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED must be true",
      ],
      [
        "LETTR_API_KEY=\"\"\nAUTH_EMAIL_ADDRESS=auth@veslo.work\nDESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED=true\n",
        "Missing required email activation setting: LETTR_API_KEY",
      ],
      [
        "LETTR_API_KEY=not-a-real-secret\nAUTH_EMAIL_ADDRESS=''\nDESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED=true\n",
        "Missing required email activation setting: AUTH_EMAIL_ADDRESS",
      ],
      [
        "LETTR_API_KEY=   \nAUTH_EMAIL_ADDRESS=auth@veslo.work\nDESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED=true\n",
        "Missing required email activation setting: LETTR_API_KEY",
      ],
      [
        "LETTR_API_KEY=\"   \"\nAUTH_EMAIL_ADDRESS=auth@veslo.work\nDESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED=true\n",
        "Missing required email activation setting: LETTR_API_KEY",
      ],
      [
        "LETTR_API_KEY=${VESLO_TEST_UNSET_LETTR:-}\nAUTH_EMAIL_ADDRESS=auth@veslo.work\nDESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED=true\n",
        "Missing required email activation setting: LETTR_API_KEY",
      ],
      [
        "LETTR_API_KEY=not-a-real-secret\nAUTH_EMAIL_ADDRESS=${VESLO_TEST_UNSET_ADDRESS:-}\nDESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED=true\n",
        "Missing required email activation setting: AUTH_EMAIL_ADDRESS",
      ],
      [
        "LETTR_API_KEY=not-a-real-secret\nAUTH_EMAIL_ADDRESS=auth@veslo.work\nDESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED=false\n",
        "DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED must be true",
      ],
      [
        "LETTR_API_KEY=not-a-real-secret\nLETTR_API_KEY=\"\"\nAUTH_EMAIL_ADDRESS=auth@veslo.work\nDESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED=true\n",
        "Missing required email activation setting: LETTR_API_KEY",
      ],
      [
        "LETTR_API_KEY=not-a-real-secret\nAUTH_EMAIL_ADDRESS=auth@veslo.work\nDESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED=true\nDESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED=\"false\"\n",
        "DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED must be true",
      ],
    ] as const) {
      const rejected = runWorkflowEmailActivationValidation(workflow, unsafeEnv)
      assert.notEqual(rejected.status, 0)
      assert.match(rejected.stdout, new RegExp(expectedError))
      assert.doesNotMatch(`${rejected.stdout}\n${rejected.stderr}`, /not-a-real-secret|auth@veslo\.work/)
    }
  }
})
