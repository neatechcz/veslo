import assert from "node:assert/strict";
import test from "node:test";

import { createPlatformModelCapabilityVerifier } from "../src/model-policy/capability-verifier.js";

function adminCredential(id: string, provider: string) {
  return {
    id, name: id, provider, type: provider === "codex_oauth" ? "oauth" : "api_key",
    state: "healthy", scope: "platform", activeLeases: 0, alertCount: 0,
    lastRefreshAt: "2026-07-12T10:00:00.000Z", lastFailureAt: null,
    cachedTokens: 0, totalTokens: 0, nextRotationAt: null, linkedAlertIds: [],
  };
}

const healthyCodexStatus = {
  available: true,
  source: "codex_exec_no_rate_limits" as const,
  label: "available",
  limits: { fiveHour: null, weekly: null },
};

test("capability verifier isolates a transient credential failure and finds a later supported credential", async () => {
  const verifier = createPlatformModelCapabilityVerifier({
    credentials: {
      async listAdminCredentials() {
        return [adminCredential("cred_transient", "codex_oauth"), adminCredential("cred_supported", "codex_oauth")];
      },
    } as never,
    secrets: {} as never,
    codexStatusProvider: {
      async getStatus(input) {
        if (input.credentialId === "cred_transient") throw new Error("temporary probe failure");
        return healthyCodexStatus;
      },
    },
    openAiCompatibleTransport: {} as never,
    concurrency: 2,
    overallTimeoutMs: 100,
  } as never);

  assert.deepEqual(
    await verifier.checkHealthyCredentialForModel({ provider: "codex_oauth", model: "gpt-5.5" }),
    { status: "supported", credentialId: "cred_supported" },
  );
});

test("capability verifier bounds concurrency and cancels slow discovery at the aggregate deadline", async () => {
  let active = 0;
  let maxActive = 0;
  let aborted = 0;
  const verifier = createPlatformModelCapabilityVerifier({
    credentials: {
      async listAdminCredentials() {
        return Array.from({ length: 8 }, (_, index) => adminCredential(`cred_${index}`, "openai_compatible"));
      },
      async getCredentialRecordById(id: string) {
        return {
          id, name: id, ownerUserId: "platform:openai_compatible", provider: "openai_compatible",
          credentialType: "api_key", state: "healthy", secretRef: `secret_${id}`,
          createdAt: new Date(), updatedAt: new Date(),
        };
      },
    } as never,
    secrets: {
      async get() {
        return { kind: "openai_compatible_api_key", apiKey: "test-key", baseUrl: "https://models.example.test/v1" };
      },
    } as never,
    codexStatusProvider: {} as never,
    openAiCompatibleTransport: {
      async chatCompletions() { throw new Error("unused"); },
      async listModels(input) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 250);
            input.signal?.addEventListener("abort", () => {
              aborted += 1;
              clearTimeout(timer);
              resolve();
            }, { once: true });
          });
          return { models: [] };
        } finally {
          active -= 1;
        }
      },
    },
    concurrency: 2,
    overallTimeoutMs: 35,
  } as never);

  const startedAt = Date.now();
  const result = await verifier.checkHealthyCredentialForModel({ provider: "openai_compatible", model: "target-model" });
  const elapsedMs = Date.now() - startedAt;

  assert.deepEqual(result, { status: "transient", reason: "capability_check_timeout" });
  assert.ok(elapsedMs < 150, `aggregate verification took ${elapsedMs}ms`);
  assert.ok(maxActive <= 2, `observed concurrency ${maxActive}`);
  assert.ok(aborted > 0, "outstanding discovery was not aborted");
});

test("capability verifier reuses and expires credential-model results", async () => {
  let nowMs = 1_000;
  let probes = 0;
  const verifier = createPlatformModelCapabilityVerifier({
    credentials: {
      async listAdminCredentials() { return [adminCredential("cred_cached", "codex_oauth")]; },
    } as never,
    secrets: {} as never,
    codexStatusProvider: {
      async getStatus() { probes += 1; return healthyCodexStatus; },
    },
    openAiCompatibleTransport: {} as never,
    cacheTtlMs: 50,
    now: () => nowMs,
  } as never);

  const model = { provider: "codex_oauth" as const, model: "gpt-5.5" };
  await verifier.checkHealthyCredentialForModel(model);
  await verifier.checkHealthyCredentialForModel(model);
  assert.equal(probes, 1);
  nowMs += 51;
  await verifier.checkHealthyCredentialForModel(model);
  assert.equal(probes, 2);
});
