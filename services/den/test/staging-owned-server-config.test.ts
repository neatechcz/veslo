import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import test from "node:test"

const repoRootUrl = new URL("../../..", import.meta.url)

function read(path: string): string {
  return readFileSync(new URL(path, repoRootUrl), "utf8")
}

test("owned-server has separate durable staging and local rehearsal env templates", () => {
  const stagingEnv = read("packaging/owned-server/env.staging.example")
  const rehearsalEnv = read("packaging/owned-server/env.rehearsal.example")

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
    "AI_GATEWAY_OPENAI_REDIRECT_BASE=https://ai.staging.veslo.work/auth/openai",
    "AI_GATEWAY_DEN_API_BASE=https://api.staging.veslo.work",
    "DEN_API_BASE=https://api.staging.veslo.work",
    "DEN_AUTH_ORIGIN=https://api.staging.veslo.work",
    "NEXT_PUBLIC_VESLO_AUTH_CALLBACK_URL=https://app.staging.veslo.work",
  ]) {
    assert.match(stagingEnv, new RegExp(requiredText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  }

  for (const forbiddenText of [
    "BETTER_AUTH_URL=http://den:8788",
    "NEXT_PUBLIC_VESLO_AUTH_CALLBACK_URL=http://localhost:3005",
    "PROVISIONER_MODE=stub",
    "workers.veslo.work",
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
