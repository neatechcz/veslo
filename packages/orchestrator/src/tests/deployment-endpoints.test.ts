import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_VESLO_DEPLOYMENT_DOMAIN,
  deploymentServiceUrl,
  normalizeVesloDeploymentDomain,
} from "../deployment-endpoints.js";

test("orchestrator derives managed AI URL from the deployment domain", () => {
  assert.equal(DEFAULT_VESLO_DEPLOYMENT_DOMAIN, "veslo.work");
  assert.equal(deploymentServiceUrl("ai", "staging.veslo.work"), "https://ai.staging.veslo.work");
  assert.equal(
    deploymentServiceUrl("ai", "https://app.staging.veslo.work"),
    "https://ai.staging.veslo.work",
  );
});

test("orchestrator deployment domain normalization strips backend service prefixes", () => {
  assert.equal(normalizeVesloDeploymentDomain("https://ai.veslo.work/admin"), "veslo.work");
  assert.equal(normalizeVesloDeploymentDomain("api.staging.veslo.work"), "staging.veslo.work");
});
