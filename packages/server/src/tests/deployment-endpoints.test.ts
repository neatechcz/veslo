import { expect, test } from "bun:test";

import {
  DEFAULT_VESLO_DEPLOYMENT_DOMAIN,
  deploymentServiceUrl,
  normalizeVesloDeploymentDomain,
  resolveVesloDeploymentEndpoints,
} from "../deployment-endpoints.js";

test("server deployment endpoints derive backend URLs from one domain", () => {
  expect(DEFAULT_VESLO_DEPLOYMENT_DOMAIN).toBe("veslo.work");
  expect(resolveVesloDeploymentEndpoints("staging.veslo.work")).toEqual({
    deploymentDomain: "staging.veslo.work",
    apiBaseUrl: "https://api.staging.veslo.work",
    aiBaseUrl: "https://ai.staging.veslo.work",
    appBaseUrl: "https://app.staging.veslo.work",
    adminBaseUrl: "https://admin.staging.veslo.work",
    workersBaseUrl: "https://workers.staging.veslo.work",
    workersDomainSuffix: "workers.staging.veslo.work",
  });
});

test("server deployment endpoint normalization strips service host prefixes", () => {
  expect(normalizeVesloDeploymentDomain("https://api.staging.veslo.work/v1/me")).toBe("staging.veslo.work");
  expect(normalizeVesloDeploymentDomain("admin.veslo.work")).toBe("veslo.work");
});

test("server deploymentServiceUrl derives individual service origins", () => {
  expect(deploymentServiceUrl("api", "staging.veslo.work")).toBe("https://api.staging.veslo.work");
  expect(deploymentServiceUrl("ai", "https://api.staging.veslo.work")).toBe("https://ai.staging.veslo.work");
});
