import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_VESLO_DEPLOYMENT_DOMAIN,
  deploymentServiceUrl,
  normalizeVesloDeploymentDomain,
  resolveVesloDeploymentEndpoints,
} from "../../lib/deployment-endpoints.js";

test("deployment endpoints derive hosted service origins from one domain", () => {
  assert.equal(DEFAULT_VESLO_DEPLOYMENT_DOMAIN, "veslo.work");

  assert.deepEqual(resolveVesloDeploymentEndpoints("staging.veslo.work"), {
    deploymentDomain: "staging.veslo.work",
    apiBaseUrl: "https://api.staging.veslo.work",
    aiBaseUrl: "https://ai.staging.veslo.work",
    appBaseUrl: "https://app.staging.veslo.work",
    adminBaseUrl: "https://admin.staging.veslo.work",
    workersBaseUrl: "https://workers.staging.veslo.work",
    workersDomainSuffix: "workers.staging.veslo.work",
  });
});

test("deployment domain normalization accepts a service URL and keeps only the deployment root", () => {
  assert.equal(
    normalizeVesloDeploymentDomain(" https://app.staging.veslo.work/settings/integrations/google "),
    "staging.veslo.work",
  );
  assert.equal(normalizeVesloDeploymentDomain("ai.veslo.work"), "veslo.work");
  assert.equal(normalizeVesloDeploymentDomain(""), "veslo.work");
});

test("deploymentServiceUrl derives each backend URL from the normalized deployment domain", () => {
  assert.equal(deploymentServiceUrl("api", "https://app.staging.veslo.work"), "https://api.staging.veslo.work");
  assert.equal(deploymentServiceUrl("ai", "staging.veslo.work"), "https://ai.staging.veslo.work");
  assert.equal(deploymentServiceUrl("app", undefined), "https://app.veslo.work");
});
