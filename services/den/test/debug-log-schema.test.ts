import assert from "node:assert/strict"
import test from "node:test"

import { DebugLogEventTable } from "../src/db/schema.js"

test("debug log sequence number uses bigint storage", () => {
  assert.equal(DebugLogEventTable.sequence_no.getSQLType(), "bigint")
})
