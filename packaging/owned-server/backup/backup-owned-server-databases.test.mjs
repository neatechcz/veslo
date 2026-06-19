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

function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function mode(stats) {
  return stats.mode & 0o777;
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
    if [[ "\${FAIL_ZSTD_COMPRESS:-0}" == "1" ]]; then
      echo "simulated zstd compression failure" >&2
      exit 43
    fi
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
  if [[ "\${EMPTY_AI_GATEWAY_CHECKSUM:-0}" == "1" && "$file" == *ai-gateway.sql.zst ]]; then
    continue
  fi
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
case "\${1:-}" in
  -e|--eval)
    if [[ "\${FAKE_NODE_NO_FETCH:-0}" == "1" ]]; then
      echo "simulated node without fetch" >&2
      exit 42
    fi
    exit 0
    ;;
esac
{
  printf '%s\\n' "\${BACKUP_ALERT_SUBJECT:-missing subject}"
  cat
} >> "${alertLog}"
`,
  );

  await writeExecutable(
    path.join(bin, "mkdir"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${FAIL_FAILED_MKDIR_SECOND:-0}" == "1" ]]; then
  for arg in "$@"; do
    case "$arg" in
      */.failed)
        marker="\${FAILED_MKDIR_MARKER:?missing FAILED_MKDIR_MARKER}"
        if [[ -e "$marker" ]]; then
          echo "simulated failed artifact mkdir failure" >&2
          exit 76
        fi
        : > "$marker"
        ;;
    esac
  done
fi
exec /bin/mkdir "$@"
`,
  );

  await writeExecutable(
    path.join(bin, "rm"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${FAIL_RAW_SQL_RM_ONCE:-0}" == "1" ]]; then
  for arg in "$@"; do
    case "$arg" in
      *.sql)
        marker="\${RAW_SQL_RM_FAIL_MARKER:?missing RAW_SQL_RM_FAIL_MARKER}"
        if [[ ! -e "$marker" ]]; then
          : > "$marker"
          echo "simulated raw SQL cleanup failure" >&2
          exit 74
        fi
        ;;
    esac
  done
fi
if [[ "\${FAIL_FAILED_DIR_RM:-0}" == "1" ]]; then
  for arg in "$@"; do
    case "$arg" in
      */.failed/*)
        echo "simulated failed artifact directory cleanup failure" >&2
        exit 72
        ;;
    esac
  done
fi
if [[ "\${FAIL_RETENTION_RM:-0}" == "1" ]]; then
  for arg in "$@"; do
    case "$arg" in
      *20260614T020000Z) exit 73 ;;
    esac
  done
fi
exec /bin/rm "$@"
`,
  );
}

async function writeNodeAlertCapture(bin, captureLog) {
  const captureModule = path.join(bin, "capture-alert-env.mjs");
  await writeFile(
    captureModule,
    `
import { appendFileSync } from "node:fs";

let body = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  body += chunk;
}

appendFileSync(
  ${JSON.stringify(captureLog)},
  JSON.stringify({
    argv: process.argv.slice(2),
    env: {
      LETTR_API_KEY: process.env.LETTR_API_KEY,
      AUTH_EMAIL_ADDRESS: process.env.AUTH_EMAIL_ADDRESS,
      AUTH_EMAIL_FROM_NAME: process.env.AUTH_EMAIL_FROM_NAME,
      BACKUP_ALERT_EMAIL_RECIPIENTS: process.env.BACKUP_ALERT_EMAIL_RECIPIENTS,
      AI_GATEWAY_ALERT_EMAIL_RECIPIENTS: process.env.AI_GATEWAY_ALERT_EMAIL_RECIPIENTS,
    },
    body,
  }) + "\\n",
  "utf8",
);
`,
    "utf8",
  );

  const wrapper = path.join(bin, "capture-node");
  await writeExecutable(
    wrapper,
    `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  -e|--eval)
    exec ${shellSingleQuote(process.execPath)} "$@"
    ;;
esac
exec ${shellSingleQuote(process.execPath)} ${shellSingleQuote(captureModule)} "$@"
`,
  );

  return wrapper;
}

function runScript(env, { timeoutMs = 5000, umask = null } = {}) {
  return new Promise((resolve) => {
    let timedOut = false;
    const args = umask
      ? ["-c", `umask ${umask}; exec bash "$1"`, "veslo-backup-test", runner]
      : [runner];
    const child = spawn("bash", args, {
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
      FAILED_MKDIR_MARKER: path.join(root, "failed-mkdir-marker"),
      NODE_BIN: path.join(bin, "node"),
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      RAW_SQL_RM_FAIL_MARKER: path.join(root, "raw-rm-fail-marker"),
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

test("runner hardens backup directories and files even when launched with permissive umask", async (t) => {
  const { env, root } = await createHarness(t);
  const timestamp = "20260619T021000Z";

  const result = await runScript(
    {
      ...env,
      BACKUP_TIMESTAMP: timestamp,
    },
    { umask: "000" },
  );

  assert.equal(result.code, 0, result.stderr);

  const setDir = path.join(root, timestamp);
  assert.equal(mode(await stat(root)), 0o700);
  assert.equal(mode(await stat(path.join(root, ".in-progress"))), 0o700);
  assert.equal(mode(await stat(path.join(root, ".failed"))), 0o700);
  assert.equal(mode(await stat(setDir)), 0o700);

  for (const fileName of [
    "ai-gateway.sql.zst",
    "ai-gateway.sql.zst.sha256",
    "den.sql.zst",
    "den.sql.zst.sha256",
    "manifest.json",
  ]) {
    assert.equal(mode(await stat(path.join(setDir, fileName))), 0o600, `${fileName} permissions`);
  }
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

test("missing node fails before dumps and logs that the alert runtime is unavailable", async (t) => {
  const { composeLog, env, root } = await createHarness(t);
  const timestamp = "20260619T030500Z";

  const result = await runScript({
    ...env,
    BACKUP_TIMESTAMP: timestamp,
    NODE_BIN: path.join(root, "missing-node"),
  });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Node|NODE_BIN|fetch/i);
  assert.match(result.stderr, /alert/i);
  await assert.rejects(stat(path.join(root, timestamp)), { code: "ENOENT" });
  await assert.rejects(stat(path.join(root, ".in-progress", timestamp)), { code: "ENOENT" });
  await assert.rejects(readFile(composeLog, "utf8"), { code: "ENOENT" });
});

test("node without fetch fails before dumps and reports Node 18 requirement", async (t) => {
  const { composeLog, env, root } = await createHarness(t);
  const timestamp = "20260619T030600Z";

  const result = await runScript({
    ...env,
    BACKUP_TIMESTAMP: timestamp,
    FAKE_NODE_NO_FETCH: "1",
  });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /fetch/i);
  assert.match(result.stderr, /Node 18/i);
  await assert.rejects(stat(path.join(root, timestamp)), { code: "ENOENT" });
  await assert.rejects(stat(path.join(root, ".in-progress", timestamp)), { code: "ENOENT" });
  await assert.rejects(readFile(composeLog, "utf8"), { code: "ENOENT" });
});

test("failure alert env parser preserves unquoted spaces and passes alert keys", async (t) => {
  const { bin, env, root } = await createHarness(t);
  const envFile = path.join(root, "compose-valid.env");
  const captureLog = path.join(root, "alert-env.jsonl");
  const captureNode = await writeNodeAlertCapture(bin, captureLog);

  await writeFile(
    envFile,
    [
      "LETTR_API_KEY=lettr_test_key",
      "AUTH_EMAIL_ADDRESS='auth@example.test'",
      "AUTH_EMAIL_FROM_NAME=Veslo Ops",
      'BACKUP_ALERT_EMAIL_RECIPIENTS="admin@example.test ops@example.test"',
      "AI_GATEWAY_ALERT_EMAIL_RECIPIENTS='fallback@example.test'",
      "",
    ].join("\n"),
    "utf8",
  );

  const result = await runScript({
    ...env,
    BACKUP_TIMESTAMP: "20260619T031000Z",
    ENV_FILE: envFile,
    NODE_BIN: captureNode,
    ZSTD_BIN: path.join(root, "missing-zstd"),
  });

  assert.notEqual(result.code, 0);

  const [alert] = (await readFile(captureLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(alert.env.LETTR_API_KEY, "lettr_test_key");
  assert.equal(alert.env.AUTH_EMAIL_ADDRESS, "auth@example.test");
  assert.equal(alert.env.AUTH_EMAIL_FROM_NAME, "Veslo Ops");
  assert.equal(alert.env.BACKUP_ALERT_EMAIL_RECIPIENTS, "admin@example.test ops@example.test");
  assert.equal(alert.env.AI_GATEWAY_ALERT_EMAIL_RECIPIENTS, "fallback@example.test");
  assert.match(alert.body, /Timestamp: 20260619T031000Z/);
});

test("failure alert env parser preserves AI Gateway fallback when backup recipients are blank", async (t) => {
  const { bin, env, root } = await createHarness(t);
  const envFile = path.join(root, "fallback-recipients.env");
  const captureLog = path.join(root, "fallback-alert-env.jsonl");
  const captureNode = await writeNodeAlertCapture(bin, captureLog);

  await writeFile(
    envFile,
    [
      "LETTR_API_KEY=lettr_test_key",
      "AUTH_EMAIL_ADDRESS=auth@example.test",
      "AUTH_EMAIL_FROM_NAME=Veslo Ops",
      "BACKUP_ALERT_EMAIL_RECIPIENTS=",
      "AI_GATEWAY_ALERT_EMAIL_RECIPIENTS=fallback@example.test",
      "",
    ].join("\n"),
    "utf8",
  );

  const result = await runScript({
    ...env,
    BACKUP_TIMESTAMP: "20260619T032000Z",
    ENV_FILE: envFile,
    NODE_BIN: captureNode,
    ZSTD_BIN: path.join(root, "missing-zstd"),
  });

  assert.notEqual(result.code, 0);

  const [alert] = (await readFile(captureLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(alert.env.BACKUP_ALERT_EMAIL_RECIPIENTS, "");
  assert.equal(alert.env.AI_GATEWAY_ALERT_EMAIL_RECIPIENTS, "fallback@example.test");
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

test("failed artifact directories are private when launched with permissive umask", async (t) => {
  const { env, root } = await createHarness(t);
  const timestamp = "20260619T040500Z";

  const result = await runScript(
    {
      ...env,
      BACKUP_TIMESTAMP: timestamp,
      FAIL_AI_GATEWAY_DUMP: "1",
    },
    { umask: "000" },
  );

  assert.notEqual(result.code, 0);

  const failedDir = path.join(root, ".failed", timestamp);
  assert.equal(mode(await stat(path.join(root, ".failed"))), 0o700);
  assert.equal(mode(await stat(failedDir)), 0o700);
  for (const fileName of await readdir(failedDir)) {
    const fileStat = await stat(path.join(failedDir, fileName));
    if (fileStat.isFile()) {
      assert.equal(mode(fileStat), 0o600, `${fileName} permissions`);
    }
  }
});

test("compression failure preserves failed artifacts without raw SQL dumps", async (t) => {
  const { alertLog, env, root } = await createHarness(t);
  const timestamp = "20260619T041000Z";

  const result = await runScript({
    ...env,
    BACKUP_TIMESTAMP: timestamp,
    FAIL_ZSTD_COMPRESS: "1",
  });

  assert.notEqual(result.code, 0);
  await assert.rejects(stat(path.join(root, timestamp)), { code: "ENOENT" });
  await assert.rejects(stat(path.join(root, ".in-progress", timestamp)), { code: "ENOENT" });

  const failedDir = path.join(root, ".failed", timestamp);
  const failedEntries = await readdir(failedDir);
  assert.equal(
    failedEntries.filter((entry) => entry.endsWith(".sql")).length,
    0,
    `failed artifacts should not preserve raw SQL files: ${failedEntries.join(", ")}`,
  );

  const alert = await readFile(alertLog, "utf8");
  assert.match(alert, /Veslo backup failed/);
  assert.match(alert, /Timestamp: 20260619T041000Z/);
  assert.match(alert, /compression/);
});

test("raw SQL cleanup failure after compression alerts and preserves sanitized failed artifacts", async (t) => {
  const { alertLog, env, root } = await createHarness(t);
  const timestamp = "20260619T041500Z";

  const result = await runScript({
    ...env,
    BACKUP_TIMESTAMP: timestamp,
    FAIL_RAW_SQL_RM_ONCE: "1",
  });

  assert.notEqual(result.code, 0);
  await assert.rejects(stat(path.join(root, timestamp)), { code: "ENOENT" });
  await assert.rejects(stat(path.join(root, ".in-progress", timestamp)), { code: "ENOENT" });

  const failedDir = path.join(root, ".failed", timestamp);
  const failedEntries = await readdir(failedDir);
  assert.ok(failedEntries.includes("den.sql.zst"));
  assert.equal(
    failedEntries.filter((entry) => entry.endsWith(".sql")).length,
    0,
    `failed artifacts should not preserve raw SQL files: ${failedEntries.join(", ")}`,
  );

  const alert = await readFile(alertLog, "utf8");
  assert.match(alert, /raw SQL cleanup/i);
  assert.match(alert, /Timestamp: 20260619T041500Z/);
  assert.match(alert, /\.failed\/20260619T041500Z/);
});

test("failed artifact cleanup rm failure is logged without blocking failure alert", async (t) => {
  const { alertLog, env, root } = await createHarness(t);
  const timestamp = "20260619T042000Z";
  await mkdir(path.join(root, ".failed", timestamp), { recursive: true });

  const result = await runScript({
    ...env,
    BACKUP_TIMESTAMP: timestamp,
    FAIL_AI_GATEWAY_DUMP: "1",
    FAIL_FAILED_DIR_RM: "1",
  });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /failed artifact/i);

  const alert = await readFile(alertLog, "utf8");
  assert.match(alert, /Veslo backup failed/);
  assert.match(alert, /Timestamp: 20260619T042000Z/);
  assert.match(alert, /ai-gateway/);
});

test("failed artifact mkdir failure is logged without blocking failure alert", async (t) => {
  const { alertLog, env, root } = await createHarness(t);
  const timestamp = "20260619T042500Z";

  const result = await runScript({
    ...env,
    BACKUP_TIMESTAMP: timestamp,
    FAIL_AI_GATEWAY_DUMP: "1",
    FAIL_FAILED_MKDIR_SECOND: "1",
  });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /failed artifact/i);

  const alert = await readFile(alertLog, "utf8");
  assert.match(alert, /Veslo backup failed/);
  assert.match(alert, /Timestamp: 20260619T042500Z/);
  assert.match(alert, /ai-gateway/);
});

test("missing checksum metadata fails before promotion and alerts", async (t) => {
  const { alertLog, env, root } = await createHarness(t);
  const timestamp = "20260619T045000Z";

  const result = await runScript({
    ...env,
    BACKUP_TIMESTAMP: timestamp,
    EMPTY_AI_GATEWAY_CHECKSUM: "1",
  });

  assert.notEqual(result.code, 0);
  assert.doesNotMatch(result.stdout, /Backup set written/);
  await assert.rejects(stat(path.join(root, timestamp)), { code: "ENOENT" });
  assert.ok(await stat(path.join(root, ".failed", timestamp)));

  const alert = await readFile(alertLog, "utf8");
  assert.match(alert, /manifest|checksum/i);
  assert.match(alert, /Timestamp: 20260619T045000Z/);
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

test("retention delete failure exits non-zero after promotion and alerts", async (t) => {
  const { alertLog, env, root } = await createHarness(t);

  for (const timestamp of [
    "20260614T020000Z",
    "20260615T020000Z",
    "20260616T020000Z",
    "20260617T020000Z",
  ]) {
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
    BACKUP_TIMESTAMP: "20260619T055000Z",
    FAIL_RETENTION_RM: "1",
  });

  assert.notEqual(result.code, 0);
  assert.doesNotMatch(result.stdout, /Backup set written/);
  assert.ok(await stat(path.join(root, "20260619T055000Z")));
  assert.ok(await stat(path.join(root, "20260614T020000Z")));

  const alert = await readFile(alertLog, "utf8");
  assert.match(alert, /retention/i);
  assert.match(alert, /Timestamp: 20260619T055000Z/);
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
