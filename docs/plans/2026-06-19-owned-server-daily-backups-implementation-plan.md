# Owned Server Daily Backups Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a reliable daily full-backup flow for the owned-server Den and AI Gateway MySQL databases.

**Architecture:** Add a repo-managed Bash backup runner that creates verified `zstd`-compressed backup sets under `/srv/veslo/backups`, retains the newest two successful sets, and sends Lettr failure alerts to all configured admins. Install it with `systemd` service/timer examples and document the production runbook.

**Tech Stack:** Bash, Docker Compose, MySQL `mysqldump`, `zstd`, `sha256sum`, `flock`, `systemd`, Node.js `node:test` for script and docs tests, Lettr HTTPS email API.

---

## Pre-Implementation Notes

- Work from the repo root.
- Preserve unrelated dirty worktree changes. Stage only files touched by each task.
- Do not start the desktop app or UI dev server; this is owned-server packaging work.
- The implementation should not depend on Den or AI Gateway being healthy to send backup failure alerts.
- Runtime host prerequisites after implementation: `bash`, `docker compose`, `zstd`, `curl`, `node`, `sha256sum`, `flock`.

## Task 1: Add Lettr Failure Alert Helper

**Files:**
- Create: `packaging/owned-server/backup/send-lettr-alert.mjs`
- Create: `packaging/owned-server/backup/send-lettr-alert.test.mjs`

**Step 1: Write the failing tests**

Create `packaging/owned-server/backup/send-lettr-alert.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

async function importHelper() {
  return import(`./send-lettr-alert.mjs?case=${Date.now()}-${Math.random()}`);
}

test("parseRecipients deduplicates comma and whitespace separated recipients", async () => {
  const { parseRecipients } = await importHelper();
  assert.deepEqual(parseRecipients("Admin@Example.test, ops@example.test admin@example.test"), [
    "admin@example.test",
    "ops@example.test",
  ]);
});

test("buildLettrPayload uses backup recipients before AI Gateway fallback", async () => {
  const { buildLettrPayload } = await importHelper();
  assert.deepEqual(
    buildLettrPayload({
      lettrApiKey: "secret",
      from: "auth@example.test",
      fromName: "Veslo Ops",
      backupRecipients: "backup@example.test",
      aiGatewayRecipients: "gateway@example.test",
      subject: "Backup failed",
      text: "Plain text",
      html: "<p>HTML</p>",
    }),
    {
      apiKey: "secret",
      body: {
        from: "auth@example.test",
        from_name: "Veslo Ops",
        to: ["backup@example.test"],
        subject: "Backup failed",
        text: "Plain text",
        html: "<p>HTML</p>",
      },
    },
  );
});

test("buildLettrPayload rejects missing recipients", async () => {
  const { buildLettrPayload } = await importHelper();
  assert.throws(
    () =>
      buildLettrPayload({
        lettrApiKey: "secret",
        from: "auth@example.test",
        fromName: "Veslo Ops",
        backupRecipients: "",
        aiGatewayRecipients: "",
        subject: "Backup failed",
        text: "Plain text",
        html: "<p>HTML</p>",
      }),
    /BACKUP_ALERT_EMAIL_RECIPIENTS/,
  );
});
```

**Step 2: Run the tests and verify they fail**

Run:

```bash
node --test packaging/owned-server/backup/send-lettr-alert.test.mjs
```

Expected: FAIL because `send-lettr-alert.mjs` does not exist.

**Step 3: Implement the helper**

Create `packaging/owned-server/backup/send-lettr-alert.mjs`:

```js
#!/usr/bin/env node

const LETTR_ENDPOINT = "https://app.lettr.com/api/emails";

export function parseRecipients(value) {
  if (!value) return [];
  return Array.from(
    new Set(
      String(value)
        .split(/[,\s]+/)
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}

export function buildLettrPayload(input) {
  const apiKey = String(input.lettrApiKey ?? "").trim();
  if (!apiKey) throw new Error("LETTR_API_KEY is required to send backup failure alerts");

  const from = String(input.from ?? "").trim();
  if (!from) throw new Error("AUTH_EMAIL_ADDRESS is required to send backup failure alerts");

  const recipients = parseRecipients(input.backupRecipients).length
    ? parseRecipients(input.backupRecipients)
    : parseRecipients(input.aiGatewayRecipients);

  if (!recipients.length) {
    throw new Error("BACKUP_ALERT_EMAIL_RECIPIENTS must contain at least one admin email");
  }

  return {
    apiKey,
    body: {
      from,
      from_name: String(input.fromName ?? "Veslo").trim() || "Veslo",
      to: recipients,
      subject: String(input.subject ?? "Veslo backup failed"),
      html: String(input.html ?? input.text ?? ""),
      text: String(input.text ?? ""),
    },
  };
}

export async function sendLettrAlert(input, fetchImpl = globalThis.fetch) {
  const { apiKey, body } = buildLettrPayload(input);
  const response = await fetchImpl(LETTR_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Failed to send backup failure alert: ${response.status} ${response.statusText}`);
  }
}

async function main() {
  const subject = process.env.BACKUP_ALERT_SUBJECT ?? "Veslo backup failed";
  const text = await new Promise((resolve, reject) => {
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      body += chunk;
    });
    process.stdin.on("error", reject);
    process.stdin.on("end", () => resolve(body));
  });

  await sendLettrAlert({
    lettrApiKey: process.env.LETTR_API_KEY,
    from: process.env.AUTH_EMAIL_ADDRESS,
    fromName: process.env.AUTH_EMAIL_FROM_NAME,
    backupRecipients: process.env.BACKUP_ALERT_EMAIL_RECIPIENTS,
    aiGatewayRecipients: process.env.AI_GATEWAY_ALERT_EMAIL_RECIPIENTS,
    subject,
    text,
    html: `<pre>${escapeHtml(text)}</pre>`,
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
```

Make it executable:

```bash
chmod +x packaging/owned-server/backup/send-lettr-alert.mjs
```

**Step 4: Run the tests and verify they pass**

Run:

```bash
node --test packaging/owned-server/backup/send-lettr-alert.test.mjs
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packaging/owned-server/backup/send-lettr-alert.mjs packaging/owned-server/backup/send-lettr-alert.test.mjs
git commit -m "Add owned-server backup alert helper"
```

## Task 2: Add Backup Runner Tests

**Files:**
- Create: `packaging/owned-server/backup/backup-owned-server-databases.test.mjs`
- Create later: `packaging/owned-server/backup/backup-owned-server-databases.sh`

**Step 1: Write failing success-path and retention tests**

Create `packaging/owned-server/backup/backup-owned-server-databases.test.mjs`.

Use Node `node:test` with temporary directories and fake commands:

```js
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(new URL("../../..", import.meta.url).pathname);
const runner = path.join(repoRoot, "packaging/owned-server/backup/backup-owned-server-databases.sh");

async function makeTempDir(name) {
  return await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(path.join(tmpdir(), name)));
}

async function writeExecutable(filePath, content) {
  await writeFile(filePath, content, "utf8");
  await chmod(filePath, 0o755);
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

test("runner creates a complete compressed backup set for both databases", async () => {
  const root = await makeTempDir("veslo-backup-root-");
  const bin = await makeTempDir("veslo-backup-bin-");
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
if [[ "$service" == "den-db" ]]; then
  printf '%s\\n' '-- MySQL dump 10.13  Distrib 8.4' 'CREATE TABLE den_probe (id int);'
elif [[ "$service" == "ai-gateway-db" ]]; then
  printf '%s\\n' '-- MySQL dump 10.13  Distrib 8.4' 'CREATE TABLE gateway_probe (id int);'
else
  echo "missing service" >&2
  exit 7
fi
`,
  );

  await writeExecutable(
    path.join(bin, "zstd"),
    `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  -3) shift; [[ "$1" == "-c" ]]; shift; cat ;;
  -t) exit 0 ;;
  -dc) shift; cat "$1" ;;
  *) cat ;;
esac
`,
  );

  await writeExecutable(
    path.join(bin, "node"),
    `#!/usr/bin/env bash
echo "$BACKUP_ALERT_SUBJECT" >> "${alertLog}"
cat >> "${alertLog}"
`,
  );

  const result = await runScript({
    BACKUP_ROOT: root,
    BACKUP_TIMESTAMP: "20260619T020000Z",
    ENV_FILE: envFile,
    COMPOSE_FILE: "packaging/owned-server/compose.yml",
    DOCKER_COMPOSE: path.join(bin, "fake-compose"),
    ZSTD_BIN: path.join(bin, "zstd"),
    NODE_BIN: path.join(bin, "node"),
  });

  assert.equal(result.code, 0, result.stderr);
  const entries = await readdir(root);
  assert.ok(entries.includes("20260619T020000Z"));
  assert.ok(!(await readdir(root)).includes(".in-progress"));

  const setDir = path.join(root, "20260619T020000Z");
  assert.equal((await stat(path.join(setDir, "den.sql.zst"))).size > 0, true);
  assert.equal((await stat(path.join(setDir, "ai-gateway.sql.zst"))).size > 0, true);
  assert.match(await readFile(path.join(setDir, "manifest.json"), "utf8"), /"status": "success"/);
});
```

Add a second test that pre-creates three successful timestamp directories, runs a fourth backup, and asserts only the newest two successful directories remain.

**Step 2: Run the tests and verify they fail**

Run:

```bash
node --test packaging/owned-server/backup/backup-owned-server-databases.test.mjs
```

Expected: FAIL because `backup-owned-server-databases.sh` does not exist.

**Step 3: Commit the failing tests if that is the team norm**

If committing red tests is acceptable:

```bash
git add packaging/owned-server/backup/backup-owned-server-databases.test.mjs
git commit -m "Test owned-server backup runner behavior"
```

If not, keep the test file unstaged until Task 3 makes it pass.

## Task 3: Implement Backup Runner

**Files:**
- Create: `packaging/owned-server/backup/backup-owned-server-databases.sh`
- Modify if needed: `packaging/owned-server/backup/backup-owned-server-databases.test.mjs`

**Step 1: Implement the minimal runner**

Create `packaging/owned-server/backup/backup-owned-server-databases.sh` with these behaviors:

```bash
#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
backup_root="${BACKUP_ROOT:-/srv/veslo/backups}"
env_file="${ENV_FILE:-/srv/veslo/env/production.env}"
compose_file="${COMPOSE_FILE:-packaging/owned-server/compose.yml}"
docker_compose="${DOCKER_COMPOSE:-docker compose}"
zstd_bin="${ZSTD_BIN:-zstd}"
node_bin="${NODE_BIN:-node}"
timestamp="${BACKUP_TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
lock_file="${BACKUP_LOCK_FILE:-${backup_root}/.backup.lock}"
staging_dir="${backup_root}/.in-progress/${timestamp}"
failed_dir="${backup_root}/.failed/${timestamp}"
final_dir="${backup_root}/${timestamp}"
log_file="${staging_dir}/run.log"

step="startup"

main() {
  mkdir -p "$backup_root" "${backup_root}/.in-progress" "${backup_root}/.failed"
  exec 9>"$lock_file"
  flock -n 9 || fail "another backup run is already active"

  require_tool "$zstd_bin"
  require_tool "$node_bin"
  require_tool sha256sum
  [[ -f "$env_file" ]] || fail "env file not found: $env_file"
  [[ ! -e "$final_dir" ]] || fail "backup set already exists: $final_dir"

  mkdir -p "$staging_dir"
  touch "$log_file"
  run_backup "den-db" "den" "den"
  run_backup "ai-gateway-db" "veslo_ai_gateway" "ai-gateway"
  write_manifest
  promote_backup_set
  retain_successful_sets
  echo "Backup set written: $final_dir"
}
```

Fill in helper functions in the same file:

- `require_tool`: checks `command -v` for bare commands and executable path for path commands.
- `run_backup service database label`: calls the existing `backup-mysql.sh` to a raw `.sql`, compresses it with `zstd -3 -c`, removes raw SQL after compressed verification, writes `.sha256`.
- `verify_dump label`: runs `zstd -t` and `zstd -dc file | head`/`grep` for `MySQL dump` or SQL DDL markers.
- `write_manifest`: writes JSON with timestamp, status, files, byte sizes, and checksum values.
- `promote_backup_set`: `mv "$staging_dir" "$final_dir"` after all files exist.
- `retain_successful_sets`: list timestamp directories under `backup_root`, sort descending, keep two, remove older directories only after promotion.
- `fail message`: move staging to failed when present, send alert, then exit non-zero.
- `send_failure_alert`: source the env file, build a concise body, and call `send-lettr-alert.mjs` through `node`.

Use the existing helper for each dump:

```bash
COMPOSE_FILE="$compose_file" ENV_FILE="$env_file" DOCKER_COMPOSE="$docker_compose" \
  "${repo_root}/packaging/owned-server/backup/backup-mysql.sh" "$service" "$database" "$raw_path"
```

Make it executable:

```bash
chmod +x packaging/owned-server/backup/backup-owned-server-databases.sh
```

**Step 2: Run shell syntax checks**

Run:

```bash
bash -n packaging/owned-server/backup/backup-owned-server-databases.sh
bash -n packaging/owned-server/backup/backup-mysql.sh
bash -n packaging/owned-server/backup/restore-mysql.sh
```

Expected: all commands exit 0.

**Step 3: Run the backup runner tests**

Run:

```bash
node --test packaging/owned-server/backup/backup-owned-server-databases.test.mjs
```

Expected: PASS.

**Step 4: Add failure-path tests**

Extend `backup-owned-server-databases.test.mjs` with tests for:

- missing `zstd` exits non-zero and invokes the alert helper
- failing second database dump leaves no successful set and creates `.failed/<timestamp>`
- retention does not delete old successful sets when the new run fails
- overlapping lock failure exits non-zero

Use the same fake command approach from Task 2.

**Step 5: Run the expanded tests**

Run:

```bash
node --test packaging/owned-server/backup/backup-owned-server-databases.test.mjs
```

Expected: PASS.

**Step 6: Commit**

```bash
git add packaging/owned-server/backup/backup-owned-server-databases.sh packaging/owned-server/backup/backup-owned-server-databases.test.mjs
git commit -m "Add owned-server daily backup runner"
```

## Task 4: Add Systemd Unit and Timer Examples

**Files:**
- Create: `packaging/owned-server/backup/systemd/veslo-owned-server-backup.service`
- Create: `packaging/owned-server/backup/systemd/veslo-owned-server-backup.timer`
- Create: `packaging/owned-server/backup/systemd/veslo-owned-server-backup.env.example`
- Create: `packaging/owned-server/backup/systemd/systemd-files.test.mjs`

**Step 1: Write systemd file tests**

Create `packaging/owned-server/backup/systemd/systemd-files.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("backup service runs the repo backup runner", () => {
  const service = readFileSync(path.join(__dirname, "veslo-owned-server-backup.service"), "utf8");
  assert.match(service, /Type=oneshot/);
  assert.match(service, /EnvironmentFile=\/etc\/default\/veslo-owned-server-backup/);
  assert.match(service, /backup-owned-server-databases\.sh/);
});

test("backup timer is persistent and daily", () => {
  const timer = readFileSync(path.join(__dirname, "veslo-owned-server-backup.timer"), "utf8");
  assert.match(timer, /OnCalendar=/);
  assert.match(timer, /Persistent=true/);
  assert.match(timer, /WantedBy=timers\.target/);
});
```

**Step 2: Run the tests and verify they fail**

Run:

```bash
node --test packaging/owned-server/backup/systemd/systemd-files.test.mjs
```

Expected: FAIL because the systemd files do not exist.

**Step 3: Add the service example**

Create `packaging/owned-server/backup/systemd/veslo-owned-server-backup.service`:

```ini
[Unit]
Description=Veslo owned-server database backup
Wants=network-online.target docker.service
After=network-online.target docker.service

[Service]
Type=oneshot
EnvironmentFile=/etc/default/veslo-owned-server-backup
ExecStart=/bin/bash -lc 'cd "$VESLO_APP_DIR" && exec packaging/owned-server/backup/backup-owned-server-databases.sh'
```

**Step 4: Add the timer example**

Create `packaging/owned-server/backup/systemd/veslo-owned-server-backup.timer`:

```ini
[Unit]
Description=Run Veslo owned-server database backup daily

[Timer]
OnCalendar=*-*-* 02:00:00 UTC
Persistent=true
RandomizedDelaySec=10m
Unit=veslo-owned-server-backup.service

[Install]
WantedBy=timers.target
```

**Step 5: Add the env example**

Create `packaging/owned-server/backup/systemd/veslo-owned-server-backup.env.example`:

```bash
VESLO_APP_DIR=/srv/veslo/app
BACKUP_ROOT=/srv/veslo/backups
ENV_FILE=/srv/veslo/env/production.env
COMPOSE_FILE=packaging/owned-server/compose.yml
DOCKER_COMPOSE=docker compose
BACKUP_ALERT_EMAIL_RECIPIENTS=admin1@example.com,admin2@example.com
```

**Step 6: Run tests**

Run:

```bash
node --test packaging/owned-server/backup/systemd/systemd-files.test.mjs
```

Expected: PASS.

**Step 7: Commit**

```bash
git add packaging/owned-server/backup/systemd
git commit -m "Add owned-server backup systemd timer examples"
```

## Task 5: Update Env and Runbooks

**Files:**
- Modify: `packaging/owned-server/env.example`
- Modify: `packaging/owned-server/env.staging.example`
- Modify: `packaging/owned-server/backup/README.md`
- Modify: `packaging/owned-server/README.md`
- Modify: `docs/dev/state-and-config-reference.md`
- Create: `packaging/owned-server/backup/backup-docs.test.mjs`

**Step 1: Write docs/source tests**

Create `packaging/owned-server/backup/backup-docs.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../../..");

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

test("owned-server env documents backup alert recipients", () => {
  assert.match(read("packaging/owned-server/env.example"), /BACKUP_ALERT_EMAIL_RECIPIENTS=/);
});

test("backup runbook documents daily systemd backups and zstd", () => {
  const runbook = read("packaging/owned-server/backup/README.md");
  assert.match(runbook, /backup-owned-server-databases\.sh/);
  assert.match(runbook, /zstd/);
  assert.match(runbook, /\/srv\/veslo\/backups/);
  assert.match(runbook, /systemctl/);
});

test("state and config reference covers backup alert config", () => {
  assert.match(read("docs/dev/state-and-config-reference.md"), /BACKUP_ALERT_EMAIL_RECIPIENTS/);
});
```

**Step 2: Run the docs tests and verify they fail**

Run:

```bash
node --test packaging/owned-server/backup/backup-docs.test.mjs
```

Expected: FAIL because docs and env files are not updated.

**Step 3: Update env examples**

Add to the Lettr/email area in `packaging/owned-server/env.example`:

```bash
BACKUP_ALERT_EMAIL_RECIPIENTS=
```

Add the same empty key to `packaging/owned-server/env.staging.example`.

**Step 4: Update backup runbook**

In `packaging/owned-server/backup/README.md`, document:

- installing `zstd`
- populating `BACKUP_ALERT_EMAIL_RECIPIENTS` with all current admins
- copying the systemd env, service, and timer examples
- running the first manual backup
- checking timer status with `systemctl status veslo-owned-server-backup.timer`
- checking logs with `journalctl -u veslo-owned-server-backup.service`
- verifying files with `zstd -t` and `sha256sum -c`
- triggering a controlled failure to verify one failure email
- retention policy: newest two successful backup sets

**Step 5: Update owned-server overview and config reference**

In `packaging/owned-server/README.md`, replace the note that automation is a later backup phase with a pointer to the automated daily backup runbook.

In `docs/dev/state-and-config-reference.md`, add a short owned-server backup config note covering:

- `BACKUP_ALERT_EMAIL_RECIPIENTS`
- Lettr env reuse
- `/srv/veslo/backups`
- `zstd` requirement
- `systemd` timer ownership

**Step 6: Run docs tests**

Run:

```bash
node --test packaging/owned-server/backup/backup-docs.test.mjs
```

Expected: PASS.

**Step 7: Commit**

```bash
git add packaging/owned-server/env.example packaging/owned-server/env.staging.example packaging/owned-server/backup/README.md packaging/owned-server/README.md docs/dev/state-and-config-reference.md packaging/owned-server/backup/backup-docs.test.mjs
git commit -m "Document owned-server daily backup operations"
```

## Task 6: Final Verification

**Files:**
- All files touched in Tasks 1-5.

**Step 1: Run all owned-server backup tests**

Run:

```bash
node --test \
  packaging/owned-server/backup/send-lettr-alert.test.mjs \
  packaging/owned-server/backup/backup-owned-server-databases.test.mjs \
  packaging/owned-server/backup/systemd/systemd-files.test.mjs \
  packaging/owned-server/backup/backup-docs.test.mjs
```

Expected: PASS.

**Step 2: Run existing owned-server packaging test**

Run:

```bash
node --test packaging/owned-server/worker-runtime-dockerfile.test.mjs
```

Expected: PASS.

**Step 3: Run shell syntax checks**

Run:

```bash
bash -n packaging/owned-server/backup/backup-owned-server-databases.sh
bash -n packaging/owned-server/backup/backup-mysql.sh
bash -n packaging/owned-server/backup/restore-mysql.sh
```

Expected: all exit 0.

**Step 4: Run whitespace check**

Run:

```bash
git diff --check
```

Expected: no output.

**Step 5: Inspect final git status**

Run:

```bash
git status --short
```

Expected: only intentional implementation files are modified, plus any unrelated pre-existing worktree changes that were not touched.

**Step 6: Final implementation commit if needed**

If any final polish changes remain after earlier task commits:

```bash
git add <intentional files>
git commit -m "Verify owned-server backup automation"
```

## Production Rollout Checklist

Do this after the code lands on the owned server:

1. Install `zstd` on the server.
2. Copy/update `/etc/default/veslo-owned-server-backup` and set all current admin emails in `BACKUP_ALERT_EMAIL_RECIPIENTS`.
3. Install the service and timer from the repo examples.
4. Run a manual backup once.
5. Confirm two `.sql.zst` files, two checksum files, and `manifest.json` exist in the new set.
6. Run `zstd -t` on both compressed dumps.
7. Run `sha256sum -c` on both checksum files.
8. Trigger a controlled failure and confirm exactly one email reaches all admin recipients.
9. Enable the timer.
10. Rehearse restore against staging before relying on the backups for production restore.
