import assert from "node:assert/strict"
import test from "node:test"

import { isMySqlDeadlockError, isMySqlDuplicateKeyError } from "../src/db/mysql-errors.js"

test("recognizes direct MySQL duplicate-key errors", () => {
  assert.equal(isMySqlDuplicateKeyError({ code: "ER_DUP_ENTRY" }), true)
  assert.equal(isMySqlDuplicateKeyError({ errno: 1062 }), true)
  assert.equal(isMySqlDuplicateKeyError({
    sqlState: "23000",
    message: "Duplicate entry 'example.test' for key 'organization_domain_domain'",
  }), true)
})

test("recognizes duplicate-key errors nested by the database driver", () => {
  assert.equal(isMySqlDuplicateKeyError({
    message: "Failed query",
    cause: {
      message: "Wrapped driver error",
      cause: { code: "ER_DUP_ENTRY" },
    },
  }), true)
})

test("rejects unrelated and malformed errors", () => {
  assert.equal(isMySqlDuplicateKeyError(new Error("database unavailable")), false)
  assert.equal(isMySqlDuplicateKeyError({ sqlState: "23000", message: "constraint failed" }), false)
  assert.equal(isMySqlDuplicateKeyError({ code: "ER_LOCK_DEADLOCK", errno: 1213 }), false)
  assert.equal(isMySqlDuplicateKeyError(null), false)
  assert.equal(isMySqlDuplicateKeyError("ER_DUP_ENTRY"), false)
})

test("recognizes only direct MySQL deadlock errors", () => {
  assert.equal(isMySqlDeadlockError({ code: "ER_LOCK_DEADLOCK" }), true)
  assert.equal(isMySqlDeadlockError({ errno: 1213 }), true)
  assert.equal(isMySqlDeadlockError({ code: "ER_LOCK_DEADLOCK", errno: 1213 }), true)
})

test("recognizes MySQL deadlocks nested by the database driver", () => {
  assert.equal(isMySqlDeadlockError({
    message: "Failed query",
    cause: {
      message: "Wrapped driver error",
      cause: { code: "ER_LOCK_DEADLOCK", errno: 1213 },
    },
  }), true)
})

test("does not conflate duplicate keys or generic SQLSTATE errors with deadlocks", () => {
  assert.equal(isMySqlDeadlockError({ code: "ER_DUP_ENTRY", errno: 1062 }), false)
  assert.equal(isMySqlDeadlockError({ sqlState: "40001", message: "transaction rollback" }), false)
  assert.equal(isMySqlDeadlockError({ sqlState: "23000", message: "constraint failed" }), false)
  assert.equal(isMySqlDeadlockError(new Error("Deadlock found when trying to get lock")), false)
  assert.equal(isMySqlDeadlockError(null), false)
  assert.equal(isMySqlDeadlockError("ER_LOCK_DEADLOCK"), false)
})
