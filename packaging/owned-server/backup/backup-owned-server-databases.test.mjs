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

async function writeFakeCommands(bin, alertLog) {
  await mkdir(bin, { recursive: true });

  await writeExecutable(
    path.join(bin, "fake-compose"),
    `#!/usr/bin/env bash
set -euo pipefail

service=""
for arg in "$@"; do
  case "$arg" in
    den-db|ai-gateway-db) service="$arg" ;;
  esac
done

case "$service" in
  den-db)
    printf '%s\\n' '-- MySQL dump 10.13  Distrib 8.4' 'CREATE TABLE den_probe (id int);'
    ;;
  ai-gateway-db)
    printf '%s\\n' '-- MySQL dump 10.13  Distrib 8.4' 'CREATE TABLE gateway_probe (id int);'
    ;;
  *)
    echo "missing service" >&2
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

function runScript(env) {
  return new Promise((resolve) => {
    const child = spawn("bash", [runner], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function createHarness(t) {
  const root = await makeTempDir(t, "veslo-backup-root-");
  const bin = await makeTempDir(t, "veslo-backup-bin-");
  const envFile = path.join(root, "production.env");
  const alertLog = path.join(root, "alerts.log");

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
  await writeFakeCommands(bin, alertLog);

  return {
    alertLog,
    bin,
    env: {
      BACKUP_ROOT: root,
      COMPOSE_FILE: "packaging/owned-server/compose.yml",
      DOCKER_COMPOSE: path.join(bin, "fake-compose"),
      ENV_FILE: envFile,
      NODE_BIN: path.join(bin, "node"),
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      ZSTD_BIN: path.join(bin, "zstd"),
    },
    root,
  };
}

test("runner creates a complete compressed backup set for both databases", async (t) => {
  const { alertLog, env, root } = await createHarness(t);

  const result = await runScript({
    ...env,
    BACKUP_TIMESTAMP: "20260619T020000Z",
  });

  assert.equal(result.code, 0, result.stderr);

  const entries = await readdir(root);
  assert.ok(entries.includes("20260619T020000Z"));
  assert.ok(!entries.includes(".in-progress"));

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
