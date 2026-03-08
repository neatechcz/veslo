import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CLOUD_ONLY_MODE,
  filterRemoteWorkspaces,
  mergeVesloServerSettingsWithEnv,
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

const prodLongSuffixEnv = resolveVesloCloudEnvironment({
  VITE_VESLO_ENV: "production",
  VITE_VESLO_URL_PRODUCTION: "https://prod-long.veslo.example",
  VITE_VESLO_TOKEN_PRODUCTION: "prod-long-token",
});
assert.equal(prodLongSuffixEnv.name, "production");
assert.equal(prodLongSuffixEnv.vesloUrl, "https://prod-long.veslo.example");
assert.equal(prodLongSuffixEnv.token, "prod-long-token");

const fallbackEnv = resolveVesloCloudEnvironment({});
assert.equal(fallbackEnv.name, "production");

const cloudMerged = mergeVesloServerSettingsWithEnv(
  {
    urlOverride: "https://stale.example",
    token: "stale-token",
    portOverride: 8787,
  },
  {
    VITE_VESLO_ENV: "development",
    VITE_VESLO_URL_DEV: "https://dev.veslo.example",
    VITE_VESLO_TOKEN_DEV: "dev-token",
    VITE_VESLO_PORT: "9999",
  },
  { cloudOnlyMode: true },
);
assert.equal(cloudMerged.next.urlOverride, "https://dev.veslo.example");
assert.equal(cloudMerged.next.token, "dev-token");
assert.equal(cloudMerged.next.portOverride, 9999);
assert.equal(cloudMerged.changed, true);

const nonCloudMerged = mergeVesloServerSettingsWithEnv(
  {
    urlOverride: "https://persist.example",
    token: "persist-token",
    portOverride: 8787,
  },
  {
    VITE_VESLO_ENV: "production",
    VITE_VESLO_URL_PROD: "https://prod.veslo.example",
    VITE_VESLO_TOKEN_PROD: "prod-token",
    VITE_VESLO_PORT: "8888",
  },
  { cloudOnlyMode: false },
);
assert.equal(nonCloudMerged.next.urlOverride, "https://persist.example");
assert.equal(nonCloudMerged.next.token, "persist-token");
assert.equal(nonCloudMerged.next.portOverride, 8787);
assert.equal(nonCloudMerged.changed, false);

const vesloServerSource = readFileSync(
  new URL("../src/app/lib/veslo-server.ts", import.meta.url),
  "utf8",
);
assert.equal(
  vesloServerSource.includes("mergeVesloServerSettingsWithEnv"),
  true,
  "veslo-server.ts must merge env settings through cloud policy helper",
);

const entrySource = readFileSync(new URL("../src/app/entry.tsx", import.meta.url), "utf8");
assert.equal(
  entrySource.includes("resolveVesloCloudEnvironment"),
  true,
  "entry.tsx must use environment resolver",
);

const workspaceSource = readFileSync(
  new URL("../src/app/context/workspace.ts", import.meta.url),
  "utf8",
);
assert.equal(
  workspaceSource.includes("filterRemoteWorkspaces(ws.workspaces)"),
  true,
  "workspace bootstrap must filter local workers",
);
assert.equal(workspaceSource.includes("cloud_only_local_disabled"), true, "workspace store must expose cloud-only local action guard code");

console.log(JSON.stringify({ ok: true, checks: 27 }));
