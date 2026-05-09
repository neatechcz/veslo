import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

test("den index mounts debug log ingest with the db-backed service", () => {
  const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8")

  assert.match(indexSource, /createDbDebugLogStore\(db\)/)
  assert.match(indexSource, /createDebugLogService/)
  assert.match(indexSource, /createDebugLogsIngestRouter/)
  assert.match(indexSource, /app\.use\("\/v1\/internal",\s*debugLogsIngestRouter\)/)
})
