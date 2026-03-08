import assert from "node:assert/strict";
import {
  APP_RUNTIME_MODE,
  isLocalExecutionOnly,
  isRemoteUiEnabled,
} from "../src/app/lib/runtime-policy.impl.js";

assert.equal(APP_RUNTIME_MODE, "local_sync");
assert.equal(isLocalExecutionOnly(), true);
assert.equal(isRemoteUiEnabled(), false);

console.log(JSON.stringify({ ok: true, checks: 3 }));
