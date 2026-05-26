import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import test from "node:test"

const opsWorkflowUrl = new URL("../../../.github/workflows/ops-den-platform-admin.yml", import.meta.url)

test("platform-admin ops workflow runs through owned-server Compose", () => {
  assert.equal(existsSync(opsWorkflowUrl), true, "Ops DEN Platform Admin workflow must exist")

  const workflowSource = readFileSync(opsWorkflowUrl, "utf8")

  for (const requiredText of [
    "name: Ops DEN Platform Admin",
    "workflow_dispatch",
    "runs-on:",
    "self-hosted",
    "linux",
    "x64",
    "veslo-owned-server",
    "OWNED_SERVER_APP_DIR",
    "OWNED_SERVER_ENV_FILE",
    "docker compose",
    "compose exec -T",
    "den sh -lc",
    "cd /app/services/den",
    "TARGET_EMAIL",
    "APPLY_GRANT",
    "platform_admin",
  ]) {
    assert.match(workflowSource, new RegExp(requiredText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  }
})

test("platform-admin ops workflow does not use old hosted-runner database access", () => {
  const workflowSource = readFileSync(opsWorkflowUrl, "utf8")

  for (const forbiddenText of [
    "ubuntu-latest",
    "actions/checkout",
    "actions/setup-node",
    "pnpm/action-setup",
    "pnpm install",
    "DEN_DATABASE_URL",
    "DATABASE_URL: ${{ secrets.",
  ]) {
    assert.equal(
      workflowSource.includes(forbiddenText),
      false,
      `Ops DEN Platform Admin workflow must not include ${forbiddenText}`,
    )
  }
})
