import assert from "node:assert/strict";

import {
  CLOUD_ONLY_MODE,
  filterRemoteWorkspaces,
  resolveVesloCloudEnvironment,
} from "../src/app/lib/cloud-policy.impl.js";

assert.equal(CLOUD_ONLY_MODE, true, "cloud-only mode must be enabled");

const filtered = filterRemoteWorkspaces([
  { id: "l1", workspaceType: "local" },
  { id: "r1", workspaceType: "remote" },
  { id: "r2", workspaceType: "REMOTE" },
]);
assert.deepEqual(filtered.map((entry) => entry.id), ["r1", "r2"]);

const testEnv = resolveVesloCloudEnvironment({
  VITE_VESLO_ENV: "test",
  VITE_VESLO_URL_TEST: "https://test.veslo.example",
  VITE_VESLO_LOGIN_URL_TEST: "https://auth.test.veslo.example",
  VITE_VESLO_TOKEN_TEST: "test-token",
});
assert.equal(testEnv.name, "test");
assert.equal(testEnv.vesloUrl, "https://test.veslo.example");
assert.equal(testEnv.loginUrl, "https://auth.test.veslo.example");
assert.equal(testEnv.token, "test-token");

const devEnv = resolveVesloCloudEnvironment({
  VITE_VESLO_ENV: "development",
  VITE_VESLO_URL_DEV: "https://dev.veslo.example",
});
assert.equal(devEnv.name, "development");
assert.equal(devEnv.vesloUrl, "https://dev.veslo.example");

const fallbackEnv = resolveVesloCloudEnvironment({});
assert.equal(fallbackEnv.name, "production");

console.log(JSON.stringify({ ok: true, checks: 11 }));
