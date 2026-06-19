import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import test from "node:test"

const ownedServerWorkflowUrl = new URL("../../../.github/workflows/deploy-owned-server.yml", import.meta.url)
const deployDenWorkflowUrl = new URL("../../../.github/workflows/deploy-den.yml", import.meta.url)
const deployAiGatewayWorkflowUrl = new URL("../../../.github/workflows/deploy-ai-gateway.yml", import.meta.url)

test("owned-server deployment workflow replaces Render production deploy workflows", () => {
  assert.equal(existsSync(ownedServerWorkflowUrl), true, "Deploy Owned Server workflow must exist")
  assert.equal(existsSync(deployDenWorkflowUrl), false, "Render Deploy Den workflow must be retired")
  assert.equal(existsSync(deployAiGatewayWorkflowUrl), false, "Render Deploy AI Gateway workflow must be retired")
})

test("owned-server deployment workflow deploys the Compose stack on the owned-server runner", () => {
  const workflowSource = readFileSync(ownedServerWorkflowUrl, "utf8")

  for (const requiredText of [
    "name: Deploy Owned Server",
    "workflow_dispatch",
    "install_backup_timer",
    "run_backup_now",
    "runs-on:",
    "self-hosted",
    "linux",
    "x64",
    "veslo-owned-server",
    "OWNED_SERVER_APP_DIR",
    "OWNED_SERVER_ENV_FILE",
    "GITHUB_TOKEN",
    "http.https://github.com/.extraheader",
    "x-access-token",
    "AUTHORIZATION: basic",
    "git_auth fetch --prune origin",
    "packaging/owned-server/compose.yml",
    "docker compose",
    "build worker-runtime-image worker-manager backup den ai-gateway web",
    "pnpm --filter @neatech/den db:migrate",
    "pnpm --filter @neatech/ai-gateway db:migrate",
    "https://api.veslo.work/health",
    "https://ai.veslo.work/health",
    "https://app.veslo.work",
    "compose exec -T worker-manager",
    "http://127.0.0.1:8790/health",
    "Install owned-server backup scheduler",
    "compose up -d backup",
    "Run owned-server backup now",
    "compose run --rm --no-deps backup",
    "sha256sum -c den.sql.zst.sha256",
    "sha256sum -c ai-gateway.sql.zst.sha256",
  ]) {
    assert.match(workflowSource, new RegExp(requiredText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  }
})

test("owned-server deployment workflow has no Render deploy integration", () => {
  const workflowSource = readFileSync(ownedServerWorkflowUrl, "utf8")

  for (const forbiddenText of [
    "RENDER_API_KEY",
    "RENDER_OWNER_ID",
    "RENDER_DEN_CONTROL_PLANE_SERVICE_ID",
    "api.render.com",
    "/services/",
    "autoDeploy",
    "ssh -i",
    "OWNED_SERVER_SSH_KEY",
    "OWNED_SERVER_KNOWN_HOSTS",
  ]) {
    assert.equal(
      workflowSource.includes(forbiddenText),
      false,
      `owned-server deployment workflow must not include ${forbiddenText}`,
    )
  }
})
