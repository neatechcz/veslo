import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL("../../.github/workflows/deploy-owned-server.yml", import.meta.url),
  "utf8",
);
const workflowLines = workflow.split("\n").map((line) => line.trim());

test("Codex rollout inputs are explicit and default to a no-op deployment", () => {
  assert.match(
    workflow,
    /      codex_model_migration:\n        description: .+\n        required: false\n        type: string\n        default: ""/,
  );
  assert.match(
    workflow,
    /      probe_codex_credentials:\n        description: .+\n        required: true\n        type: boolean\n        default: false/,
  );
  assert.match(workflow, /      CODEX_MODEL_MIGRATION: \$\{\{ inputs\.codex_model_migration \}\}/);
  assert.match(workflow, /      PROBE_CODEX_CREDENTIALS: \$\{\{ inputs\.probe_codex_credentials \}\}/);
});

test("Codex rollout validation requires a verified backup and one shared model", () => {
  assert.match(
    workflow,
    /for key in OWNED_SERVER_APP_DIR OWNED_SERVER_ENV_FILE DEPLOY_BRANCH REPO_URL GITHUB_TOKEN; do/,
  );
  assert.match(
    workflow,
    /if \[ -n "\$CODEX_MODEL_MIGRATION" \] && \[ "\$RUN_BACKUP_NOW" != "true" \]; then/,
  );
  assert.match(
    workflow,
    /if \[ "\$PROBE_CODEX_CREDENTIALS" = "true" \] && \[ -z "\$CODEX_MODEL_MIGRATION" \]; then/,
  );
});

test("Codex rollout runs strictly after the backup has been verified", () => {
  const backupStepIndex = workflow.indexOf("- name: Run owned-server backup now");
  const backupVerificationIndex = workflow.indexOf("sha256sum -c ai-gateway.sql.zst.sha256");
  const rolloutStepIndex = workflow.indexOf("- name: Migrate and probe Codex credentials");

  assert.notEqual(backupStepIndex, -1);
  assert.ok(backupVerificationIndex > backupStepIndex);
  assert.ok(rolloutStepIndex > backupVerificationIndex);
  assert.match(
    workflow.slice(rolloutStepIndex),
    /if: env\.CODEX_MODEL_MIGRATION != ''[\s\S]*set -euo pipefail/,
  );
});

test("Codex rollout proves migration idempotence before an optional sequential probe", () => {
  const dryRun =
    'compose exec -T ai-gateway pnpm --filter @neatech/ai-gateway ops:codex-model-migration -- --model "$CODEX_MODEL_MIGRATION"';
  const apply = `${dryRun} --apply`;
  const probe =
    'compose exec -T ai-gateway pnpm --filter @neatech/ai-gateway ops:codex-credential-probe -- --model "$CODEX_MODEL_MIGRATION"';

  assert.equal(workflowLines.filter((line) => line === dryRun).length, 2);
  assert.equal(workflowLines.filter((line) => line === apply).length, 1);
  assert.equal(workflowLines.filter((line) => line === probe).length, 1);

  const firstDryRunIndex = workflowLines.indexOf(dryRun);
  const applyIndex = workflowLines.indexOf(apply);
  const secondDryRunIndex = workflowLines.indexOf(dryRun, firstDryRunIndex + 1);
  const probeIndex = workflowLines.indexOf(probe);

  assert.ok(firstDryRunIndex < applyIndex);
  assert.ok(applyIndex < secondDryRunIndex);
  assert.ok(secondDryRunIndex < probeIndex);
  assert.match(
    workflow,
    /post_apply_summary="\$\([\s\S]*ops:codex-model-migration -- --model "\$CODEX_MODEL_MIGRATION"[\s\S]*\)"[\s\S]*grep -F '"changedCount":0'/,
  );
  assert.match(
    workflow,
    /if \[ "\$PROBE_CODEX_CREDENTIALS" = "true" \]; then[\s\S]*ops:codex-credential-probe/,
  );
});

test("owned-server workflow contains no literal credentials, database URLs, or secrets", () => {
  assert.doesNotMatch(workflow, /\b(?:mysql|mariadb|postgres(?:ql)?):\/\/\S+/i);
  assert.doesNotMatch(workflow, /\bsk-[A-Za-z0-9_-]{12,}\b/);
  assert.doesNotMatch(workflow, /\bcred_[0-9a-f-]{8,}\b/i);

  for (const line of workflow.split("\n")) {
    const sensitiveEnv = line.match(
      /^\s*[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|DATABASE_URL)[A-Z0-9_]*:\s*(.+)\s*$/,
    );
    if (sensitiveEnv) {
      assert.match(sensitiveEnv[1], /^\$\{\{[^}]+\}\}$/);
    }
  }
});
