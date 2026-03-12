import assert from "node:assert/strict"
import test from "node:test"
import { shouldWidenVarcharColumn } from "../src/db/schema-reconcile.js"

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
