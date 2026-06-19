import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const runner = path.join(repoRoot, "packaging/owned-server/backup/backup-owned-server-databases.sh");

async function makeTempDir(t, name) {
  const dir = await mkdtemp(path.join(tmpdir(), name));
  t.after(async () => {
    await rm(dir, { force: true, recursive: true });
  });
  return dir;
}

async function writeExecutable(filePath, content) {
  await writeFile(filePath, content, "utf8");
  await chmod(filePath, 0o755);
}

async function writeSuccessManifest(dir, timestamp) {
  await writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify({ status: "success", timestamp }, null, 2),
    "utf8",
  );
}

async function writeFakeCommands(bin, alertLog, composeLog) {
  await mkdir(bin, { recursive: true });

  await writeExecutable(
    path.join(bin, "fake-compose"),
    `#!/usr/bin/env bash
set -euo pipefail

service=""
database=""
for arg in "$@"; do
  case "$arg" in
    den-db|ai-gateway-db) service="$arg" ;;
    den|veslo_ai_gateway) database="$arg" ;;
  esac
done

printf '%s\\n' "$*" >> "${composeLog}"

case "$service:$database" in
  den-db:den)
    printf '%s\\n' '-- MySQL dump 10.13  Distrib 8.4' 'CREATE TABLE den_probe (id int);'
    ;;
  ai-gateway-db:veslo_ai_gateway)
    if [[ "\${FAIL_AI_GATEWAY_DUMP:-0}" == "1" ]]; then
      echo "simulated ai-gateway dump failure" >&2
      exit 42
    fi
    printf '%s\\n' '-- MySQL dump 10.13  Distrib 8.4' 'CREATE TABLE gateway_probe (id int);'
    ;;
  *)
    echo "unexpected service/database pair: $service/$database" >&2
    exit 7
    ;;
esac
`,
  );

  await writeExecutable(
    path.join(bin, "zstd"),
    `#!/usr/bin/env bash
set -euo pipefail

output=""
mode="compress"
inputs=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    -c|-3|-q|-f|--quiet)
      shift
      ;;
    -t|--test)
      mode="test"
      shift
      ;;
    -d|-dc)
      mode="decompress"
      shift
      ;;
    -o)
      output="$2"
      shift 2
      ;;
    --output=*)
      output="\${1#--output=}"
      shift
      ;;
    *)
      inputs+=("$1")
      shift
      ;;
  esac
done

case "$mode" in
  test)
    exit 0
    ;;
  decompress)
    if [[ \${#inputs[@]} -eq 0 ]]; then
      cat
    else
      cat "\${inputs[@]}"
    fi
    ;;
  compress)
    if [[ -n "$output" ]]; then
      if [[ \${#inputs[@]} -eq 0 ]]; then
        cat > "$output"
      else
        cat "\${inputs[@]}" > "$output"
      fi
    elif [[ \${#inputs[@]} -eq 0 ]]; then
      cat
    else
      cat "\${inputs[@]}"
    fi
    ;;
esac
`,
  );

  await writeExecutable(
    path.join(bin, "sha256sum"),
    `#!/usr/bin/env bash
set -euo pipefail
for file in "$@"; do
  printf '%064d  %s\\n' 0 "$file"
done
`,
  );

  await writeExecutable(
    path.join(bin, "flock"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${FAIL_FLOCK:-0}" == "1" ]]; then
  exit 75
fi
exit 0
`,
  );

  await writeExecutable(
    path.join(bin, "node"),
    `#!/usr/bin/env bash
set -euo pipefail
{
  printf '%s\\n' "\${BACKUP_ALERT_SUBJECT:-missing subject}"
  cat
} >> "${alertLog}"
`,
  );
}

function runScript(env, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    let timedOut = false;
    const child = spawn("bash", [runner], {
      cwd: repoRoot,
      env: {
        HOME: tmpdir(),
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        TMPDIR: tmpdir(),
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      timedOut = true;
      stderr += `Timed out after ${timeoutMs}ms\n`;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 250).unref?.();
    }, timeoutMs);
    timeout.unref?.();
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ code: null, error, signal: null, stderr, stdout, timedOut });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

async function createHarness(t) {
  const root = await makeTempDir(t, "veslo-backup-root-");
  const bin = await makeTempDir(t, "veslo-backup-bin-");
  const envFile = path.join(root, "production.env");
  const alertLog = path.join(root, "alerts.log");
  const composeLog = path.join(root, "compose.log");

  await writeFile(
    envFile,
    [
      "LETTR_API_KEY=test_key",
      "AUTH_EMAIL_ADDRESS=auth@example.test",
      "AUTH_EMAIL_FROM_NAME=Veslo Ops",
      "BACKUP_ALERT_EMAIL_RECIPIENTS=admin@example.test",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFakeCommands(bin, alertLog, composeLog);

  return {
    alertLog,
    bin,
    composeLog,
    env: {
      BACKUP_ROOT: root,
      COMPOSE_FILE: "packaging/owned-server/compose.yml",
      DOCKER_COMPOSE: path.join(bin, "fake-compose"),
      ENV_FILE: envFile,
      NODE_BIN: path.join(bin, "node"),
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      ZSTD_BIN: path.join(bin, "zstd"),
    },
    root,
  };
}

test("runner creates a complete compressed backup set for both databases", async (t) => {
  const { alertLog, composeLog, env, root } = await createHarness(t);

  const result = await runScript({
    ...env,
    BACKUP_TIMESTAMP: "20260619T020000Z",
  });

  assert.equal(result.code, 0, result.stderr);

  const entries = await readdir(root);
  assert.ok(entries.includes("20260619T020000Z"));
  await assert.rejects(stat(path.join(root, ".in-progress", "20260619T020000Z")), { code: "ENOENT" });

  const setDir = path.join(root, "20260619T020000Z");
  const expectedFiles = [
    "ai-gateway.sql.zst",
    "ai-gateway.sql.zst.sha256",
    "den.sql.zst",
    "den.sql.zst.sha256",
    "manifest.json",
  ];
  assert.deepEqual((await readdir(setDir)).sort(), expectedFiles);
  assert.equal((await stat(path.join(setDir, "den.sql.zst"))).size > 0, true);
  assert.equal((await stat(path.join(setDir, "ai-gateway.sql.zst"))).size > 0, true);
  assert.match(await readFile(path.join(setDir, "den.sql.zst"), "utf8"), /CREATE TABLE den_probe/);
  assert.match(await readFile(path.join(setDir, "ai-gateway.sql.zst"), "utf8"), /CREATE TABLE gateway_probe/);

  const denChecksum = await readFile(path.join(setDir, "den.sql.zst.sha256"), "utf8");
  const aiGatewayChecksum = await readFile(path.join(setDir, "ai-gateway.sql.zst.sha256"), "utf8");
  assert.match(denChecksum, /^[a-f0-9]{64}\s+.*den\.sql\.zst/m);
  assert.match(aiGatewayChecksum, /^[a-f0-9]{64}\s+.*ai-gateway\.sql\.zst/m);

  const manifest = JSON.parse(await readFile(path.join(setDir, "manifest.json"), "utf8"));
  assert.equal(manifest.status, "success");
  assert.equal(manifest.timestamp, "20260619T020000Z");
  assert.ok(JSON.stringify(manifest).includes("den.sql.zst"));
  assert.ok(JSON.stringify(manifest).includes("ai-gateway.sql.zst"));

  const composeCalls = await readFile(composeLog, "utf8");
  assert.match(composeCalls, /\bexec -T den-db\b[\s\S]*\bden\b/);
  assert.match(composeCalls, /\bexec -T ai-gateway-db\b[\s\S]*\bveslo_ai_gateway\b/);

  await assert.rejects(readFile(alertLog, "utf8"), { code: "ENOENT" });
});

test("retention keeps only the newest two successful timestamp backup sets after a successful new run", async (t) => {
  const { alertLog, env, root } = await createHarness(t);

  for (const timestamp of ["20260616T020000Z", "20260617T020000Z", "20260618T020000Z"]) {
    const setDir = path.join(root, timestamp);
    await mkdir(setDir, { recursive: true });
    await writeFile(path.join(setDir, "den.sql.zst"), `den backup ${timestamp}\n`, "utf8");
    await writeFile(path.join(setDir, "den.sql.zst.sha256"), `den checksum ${timestamp}\n`, "utf8");
    await writeFile(path.join(setDir, "ai-gateway.sql.zst"), `gateway backup ${timestamp}\n`, "utf8");
    await writeFile(path.join(setDir, "ai-gateway.sql.zst.sha256"), `gateway checksum ${timestamp}\n`, "utf8");
    await writeSuccessManifest(setDir, timestamp);
  }

  const result = await runScript({
    ...env,
    BACKUP_TIMESTAMP: "20260619T020000Z",
  });

  assert.equal(result.code, 0, result.stderr);

  const successfulSets = (await readdir(root))
    .filter((entry) => /^\d{8}T\d{6}Z$/.test(entry))
    .sort();
  assert.deepEqual(successfulSets, ["20260618T020000Z", "20260619T020000Z"]);

  const manifest = JSON.parse(await readFile(path.join(root, "20260619T020000Z", "manifest.json"), "utf8"));
  assert.equal(manifest.status, "success");
  await assert.rejects(readFile(alertLog, "utf8"), { code: "ENOENT" });
});

test("missing zstd exits non-zero and invokes the failure alert helper", async (t) => {
  const { alertLog, env, root } = await createHarness(t);

  const result = await runScript({
    ...env,
    BACKUP_TIMESTAMP: "20260619T030000Z",
    ZSTD_BIN: path.join(root, "missing-zstd"),
  });

  assert.notEqual(result.code, 0);
  await assert.rejects(stat(path.join(root, "20260619T030000Z")), { code: "ENOENT" });

  const alert = await readFile(alertLog, "utf8");
  assert.match(alert, /Veslo backup failed/);
  assert.match(alert, /Host:/);
  assert.match(alert, /Timestamp: 20260619T030000Z/);
  assert.match(alert, /zstd/);
});

test("failing second database dump leaves no successful set and moves staging to failed artifacts", async (t) => {
  const { alertLog, env, root } = await createHarness(t);
  const timestamp = "20260619T040000Z";

  const result = await runScript({
    ...env,
    BACKUP_TIMESTAMP: timestamp,
    FAIL_AI_GATEWAY_DUMP: "1",
  });

  assert.notEqual(result.code, 0);
  await assert.rejects(stat(path.join(root, timestamp)), { code: "ENOENT" });
  await assert.rejects(stat(path.join(root, ".in-progress", timestamp)), { code: "ENOENT" });

  const failedDir = path.join(root, ".failed", timestamp);
  const failedEntries = await readdir(failedDir);
  assert.ok(failedEntries.includes("den.sql.zst"));
  assert.ok(failedEntries.includes("den.sql.zst.sha256"));

  const alert = await readFile(alertLog, "utf8");
  assert.match(alert, /Veslo backup failed/);
  assert.match(alert, /Timestamp: 20260619T040000Z/);
  assert.match(alert, /Failed artifacts:/);
  assert.match(alert, /\.failed\/20260619T040000Z/);
  assert.match(alert, /ai-gateway/);
});

test("retention does not delete old successful sets when the new run fails", async (t) => {
  const { env, root } = await createHarness(t);

  for (const timestamp of ["20260616T020000Z", "20260617T020000Z", "20260618T020000Z"]) {
    const setDir = path.join(root, timestamp);
    await mkdir(setDir, { recursive: true });
    await writeFile(path.join(setDir, "den.sql.zst"), `den backup ${timestamp}\n`, "utf8");
    await writeFile(path.join(setDir, "den.sql.zst.sha256"), `den checksum ${timestamp}\n`, "utf8");
    await writeFile(path.join(setDir, "ai-gateway.sql.zst"), `gateway backup ${timestamp}\n`, "utf8");
    await writeFile(path.join(setDir, "ai-gateway.sql.zst.sha256"), `gateway checksum ${timestamp}\n`, "utf8");
    await writeSuccessManifest(setDir, timestamp);
  }

  const result = await runScript({
    ...env,
    BACKUP_TIMESTAMP: "20260619T050000Z",
    FAIL_AI_GATEWAY_DUMP: "1",
  });

  assert.notEqual(result.code, 0);

  const successfulSets = (await readdir(root))
    .filter((entry) => /^\d{8}T\d{6}Z$/.test(entry))
    .sort();
  assert.deepEqual(successfulSets, ["20260616T020000Z", "20260617T020000Z", "20260618T020000Z"]);
  await assert.rejects(stat(path.join(root, "20260619T050000Z")), { code: "ENOENT" });
  assert.ok(await stat(path.join(root, ".failed", "20260619T050000Z")));
});

test("overlapping lock failure exits non-zero without running dumps", async (t) => {
  const { alertLog, composeLog, env, root } = await createHarness(t);

  const result = await runScript({
    ...env,
    BACKUP_LOCK_FILE: path.join(root, "custom-backup.lock"),
    BACKUP_TIMESTAMP: "20260619T060000Z",
    FAIL_FLOCK: "1",
  });

  assert.notEqual(result.code, 0);
  await assert.rejects(stat(path.join(root, "20260619T060000Z")), { code: "ENOENT" });
  await assert.rejects(readFile(composeLog, "utf8"), { code: "ENOENT" });

  const alert = await readFile(alertLog, "utf8");
  assert.match(alert, /Veslo backup failed/);
  assert.match(alert, /Timestamp: 20260619T060000Z/);
  assert.match(alert, /lock/i);
});
