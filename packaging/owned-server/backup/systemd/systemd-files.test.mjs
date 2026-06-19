import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function readExampleFile(name) {
  return readFile(new URL(name, import.meta.url), "utf8");
}

function lines(content) {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

function assertHasLine(content, expected) {
  assert.ok(lines(content).includes(expected), `Expected to find line: ${expected}`);
}

function getLine(content, prefix) {
  const line = lines(content).find((entry) => entry.startsWith(prefix));
  assert.ok(line, `Expected to find line starting with: ${prefix}`);
  return line;
}

function parseEnv(content) {
  const entries = new Map();

  for (const line of lines(content)) {
    const separator = line.indexOf("=");
    assert.notEqual(separator, -1, `Expected env assignment: ${line}`);
    entries.set(line.slice(0, separator), line.slice(separator + 1));
  }

  return entries;
}

test("service runs the owned-server database backup script from VESLO_APP_DIR", async () => {
  const service = await readExampleFile("veslo-owned-server-backup.service");

  assertHasLine(service, "Type=oneshot");
  assertHasLine(service, "EnvironmentFile=-/etc/default/veslo-owned-server-backup");

  const execStart = getLine(service, "ExecStart=");
  assert.match(execStart, /VESLO_APP_DIR:-\/srv\/veslo\/app/);
  assert.match(execStart, /cd "\$\$app_dir"/);
  assert.match(execStart, /backup-owned-server-databases\.sh/);
});

test("timer schedules the backup service daily with persistent catch-up", async () => {
  const timer = await readExampleFile("veslo-owned-server-backup.timer");

  assertHasLine(timer, "OnCalendar=*-*-* 02:15:00 UTC");
  assertHasLine(timer, "RandomizedDelaySec=15m");
  assertHasLine(timer, "Persistent=true");
  assertHasLine(timer, "Unit=veslo-owned-server-backup.service");
  assertHasLine(timer, "WantedBy=timers.target");
});

test("environment example documents owned-server backup defaults", async () => {
  const envExample = await readExampleFile("veslo-owned-server-backup.env.example");
  const env = parseEnv(envExample);

  assert.equal(env.get("VESLO_APP_DIR"), "/srv/veslo/app");
  assert.equal(env.get("BACKUP_ROOT"), "/srv/veslo/backups");
  assert.equal(env.get("ENV_FILE"), "/srv/veslo/env/production.env");
  assert.equal(env.get("COMPOSE_FILE"), "packaging/owned-server/compose.yml");
  assert.equal(env.get("DOCKER_COMPOSE"), "docker compose");
  assert.equal(env.has("BACKUP_ALERT_EMAIL_RECIPIENTS"), false);
});
