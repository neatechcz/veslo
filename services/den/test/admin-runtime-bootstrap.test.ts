import assert from "node:assert/strict"
import test from "node:test"

import * as adminRuntime from "../src/http/admin-runtime.js"

test("bootstrap platform admin allowlist recognizes michal.sara@neatech.cz", () => {
  assert.equal(typeof adminRuntime.isBootstrapPlatformAdminEmail, "function")
  assert.equal(adminRuntime.isBootstrapPlatformAdminEmail("michal.sara@neatech.cz"), true)
  assert.equal(adminRuntime.isBootstrapPlatformAdminEmail("MICHAL.SARA@NEATECH.CZ"), true)
  assert.equal(adminRuntime.isBootstrapPlatformAdminEmail("someone@example.com"), false)
})
