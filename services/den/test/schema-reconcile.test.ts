import assert from "node:assert/strict"
import test from "node:test"
import { extractMetadataRows, shouldWidenVarcharColumn } from "../src/db/schema-reconcile.js"

test("schema-reconcile - widens legacy varchar token columns", () => {
  assert.equal(
    shouldWidenVarcharColumn({
      dataType: "varchar",
      maxLength: 128,
    }, 512),
    true,
  )
})

test("schema-reconcile - does not widen already-compatible varchar columns", () => {
  assert.equal(
    shouldWidenVarcharColumn({
      dataType: "varchar",
      maxLength: 512,
    }, 512),
    false,
  )
})

test("schema-reconcile - skips non-varchar columns", () => {
  assert.equal(
    shouldWidenVarcharColumn({
      dataType: "text",
      maxLength: null,
    }, 512),
    false,
  )
})

test("schema-reconcile - treats mysql2 empty row tuples as zero rows", () => {
  assert.deepEqual(extractMetadataRows([[], [{ name: "COLUMN_NAME" }]]), [])
})

test("schema-reconcile - extracts rows from mysql2 row tuples", () => {
  assert.deepEqual(extractMetadataRows([[{ COLUMN_NAME: "failure_reason" }], [{ name: "COLUMN_NAME" }]]), [
    { COLUMN_NAME: "failure_reason" },
  ])
})
