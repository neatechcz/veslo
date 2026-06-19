import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

async function readRepoFile(relativePath) {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

function assertIncludesAll(content, expectedValues, context) {
  for (const value of expectedValues) {
    assert.ok(content.includes(value), `${context} should document ${value}`);
  }
}

function extractSection(content, heading) {
  const marker = `## ${heading}\n`;
  const start = content.indexOf(marker);
  assert.notEqual(start, -1, `Expected section "## ${heading}" to exist`);

  const bodyStart = start + marker.length;
  const nextSection = content.indexOf("\n## ", bodyStart);
  return content.slice(bodyStart, nextSection === -1 ? undefined : nextSection);
}

test("owned-server env templates document backup alert recipients", async () => {
  const envExample = await readRepoFile("packaging/owned-server/env.example");
  const envStagingExample = await readRepoFile("packaging/owned-server/env.staging.example");

  assert.match(envExample, /^BACKUP_ALERT_EMAIL_RECIPIENTS=$/m);
  assert.match(envStagingExample, /^BACKUP_ALERT_EMAIL_RECIPIENTS=$/m);
});

test("backup runbook documents automated daily backup operations", async () => {
  const runbook = await readRepoFile("packaging/owned-server/backup/README.md");

  assertIncludesAll(
    runbook,
    [
      "backup-owned-server-databases.sh",
      "zstd",
      "/srv/veslo/backups",
      "BACKUP_ALERT_EMAIL_RECIPIENTS",
      "systemctl status veslo-owned-server-backup.timer",
      "journalctl -u veslo-owned-server-backup.service",
      "zstd -t",
      "sha256sum -c",
      "newest two successful backup sets",
      "controlled failure",
    ],
    "backup runbook",
  );
});

test("state and config reference covers owned-server backup configuration", async () => {
  const stateReference = await readRepoFile("docs/dev/state-and-config-reference.md");
  const backupSection = extractSection(stateReference, "Owned-Server Backup Config");

  assertIncludesAll(
    backupSection,
    [
      "BACKUP_ALERT_EMAIL_RECIPIENTS",
      "LETTR_API_KEY",
      "AUTH_EMAIL_ADDRESS",
      "AUTH_EMAIL_FROM_NAME",
      "/srv/veslo/backups",
      "zstd",
      "veslo-owned-server-backup.timer",
    ],
    "owned-server backup config reference",
  );
});
