import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dockerfile = readFileSync(path.join(__dirname, "Dockerfile"), "utf8")
const compose = readFileSync(path.join(__dirname, "compose.yml"), "utf8")

test("owned-server worker runtime is built from repo sources", () => {
  assert.doesNotMatch(dockerfile, /npm install -g veslo-orchestrator@/)
  assert.match(dockerfile, /npm install -g bun@/)
  assert.match(dockerfile, /pnpm --filter veslo-server build/)
  assert.match(dockerfile, /pnpm --filter veslo-orchestrator build/)
  assert.match(dockerfile, /--allow-external/)
  assert.match(dockerfile, /--veslo-server-bin \/app\/packages\/server\/dist\/cli\.js/)
})

test("owned-server backup image has database and compression tools", () => {
  assert.match(dockerfile, /FROM base AS backup/)
  assert.match(dockerfile, /COPY packaging \.\/packaging/)
  assert.match(dockerfile, /default-mysql-client zstd/)
  assert.match(dockerfile, /backup-owned-server-databases-loop\.sh/)
})

test("owned-server Compose includes the backup scheduler service", () => {
  assert.match(compose, /^\s+backup:\n/m)
  assert.match(compose, /target: backup/)
  assert.match(compose, /\/srv\/veslo\/backups:\/srv\/veslo\/backups/)
  assert.match(compose, /MYSQL_DUMP_MODE: direct/)
  assert.match(compose, /BACKUP_DAILY_UTC_TIME/)
  assert.match(compose, /BACKUP_RANDOM_DELAY_SECONDS/)
})
