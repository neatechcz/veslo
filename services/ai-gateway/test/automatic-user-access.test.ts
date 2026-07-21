import assert from "node:assert/strict";
import test from "node:test";

import {
  AutomaticUserAiAccessInfrastructureError,
  createAutomaticUserAiAccessService,
} from "../src/access/automatic-user-access.js";
import type {
  AiAccessRepository,
  UpsertUserAiAccessPolicyInput,
  UserAiAccessPolicyRecord,
} from "../src/access/repository.js";
import type { PlatformModelPolicyRecord } from "../src/model-policy/repository.js";

const NOW = new Date("2026-07-21T00:00:00.000Z");

function policy(overrides: Partial<PlatformModelPolicyRecord> = {}): PlatformModelPolicyRecord {
  return {
    id: "platform",
    enabledModels: [
      { provider: "codex_oauth", model: "gpt-5.6" },
      { provider: "codex_oauth", model: "gpt-5.5" },
    ],
    activeModel: { provider: "codex_oauth", model: "gpt-5.6" },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function record(overrides: Partial<UserAiAccessPolicyRecord> = {}): UserAiAccessPolicyRecord {
  return {
    id: "ai_access_user_1",
    userId: "user_1",
    enabled: true,
    provider: "codex_oauth",
    credentialId: "cred_existing",
    defaultModel: "gpt-5.6",
    allowedModels: ["gpt-5.6", "gpt-5.5"],
    assignmentOrigin: "auto_assigned",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function harness(input: {
  existing?: UserAiAccessPolicyRecord | null;
  platformPolicy?: PlatformModelPolicyRecord | null;
  platformPolicies?: Array<PlatformModelPolicyRecord | null>;
  capability?: { status: "supported"; credentialId: string }
    | { status: "unsupported" }
    | { status: "transient"; reason: string };
} = {}) {
  let stored = Object.hasOwn(input, "existing") ? input.existing ?? null : null;
  let modelReads = 0;
  let capabilityReads = 0;
  const capabilityModels: Array<{ provider: string; model: string }> = [];
  const writes: UpsertUserAiAccessPolicyInput[] = [];
  const aiAccess: AiAccessRepository = {
    async getUserAiAccess() {
      return stored;
    },
    async upsertUserAiAccess(next) {
      writes.push(next);
      stored = record({
        userId: next.userId,
        enabled: next.enabled,
        provider: next.provider,
        credentialId: next.credentialId,
        defaultModel: next.defaultModel ?? null,
        allowedModels: next.allowedModels ?? [],
        assignmentOrigin: next.assignmentOrigin,
      });
      return stored;
    },
  };
  const service = createAutomaticUserAiAccessService({
    aiAccess,
    modelPolicy: {
      async getPolicy() {
        modelReads += 1;
        if (input.platformPolicies) {
          return input.platformPolicies[Math.min(modelReads - 1, input.platformPolicies.length - 1)] ?? null;
        }
        return Object.hasOwn(input, "platformPolicy") ? input.platformPolicy ?? null : policy();
      },
      async replacePolicy() {
        throw new Error("not used");
      },
    },
    modelCapabilities: {
      async checkHealthyCredentialForModel(model) {
        capabilityReads += 1;
        capabilityModels.push(model);
        return input.capability ?? { status: "supported", credentialId: "cred_healthy" };
      },
    },
  });
  return {
    service,
    writes,
    get modelReads() { return modelReads; },
    get capabilityReads() { return capabilityReads; },
    capabilityModels,
  };
}

test("missing access defaults to enabled and persists infrastructure-derived routing", async () => {
  const context = harness();

  const access = await context.service.getOrCreateUserAiAccess("user_1");

  assert.equal(access.enabled, true);
  assert.equal(access.provider, "codex_oauth");
  assert.equal(access.credentialId, "cred_healthy");
  assert.equal(access.assignmentOrigin, "auto_assigned");
  assert.deepEqual(context.writes, [{
    userId: "user_1",
    enabled: true,
    provider: "codex_oauth",
    credentialId: "cred_healthy",
    defaultModel: "gpt-5.6",
    allowedModels: ["gpt-5.6"],
    assignmentOrigin: "auto_assigned",
  }]);
});

test("explicit disabled access is returned without model or credential work", async () => {
  const disabled = record({ enabled: false, provider: null, credentialId: null });
  const context = harness({ existing: disabled });

  assert.equal(await context.service.getOrCreateUserAiAccess("user_1"), disabled);
  assert.equal(context.modelReads, 0);
  assert.equal(context.capabilityReads, 0);
  assert.deepEqual(context.writes, []);
});

test("existing enabled access follows the current active model instead of persisted routing", async () => {
  const context = harness({
    existing: record({
      defaultModel: "gpt-5.5",
      allowedModels: ["gpt-5.5"],
      credentialId: "cred_old",
    }),
    platformPolicies: [
      policy({
        activeModel: { provider: "codex_oauth", model: "gpt-5.5" },
        enabledModels: [{ provider: "codex_oauth", model: "gpt-5.5" }],
      }),
      policy({
        activeModel: { provider: "codex_oauth", model: "gpt-5.6" },
        enabledModels: [
          { provider: "codex_oauth", model: "gpt-5.6" },
          { provider: "codex_oauth", model: "gpt-5.6-mini" },
        ],
      }),
    ],
  });

  const beforeSwitch = await context.service.getOrCreateUserAiAccess("user_1");
  const afterSwitch = await context.service.getOrCreateUserAiAccess("user_1");

  assert.equal(beforeSwitch.defaultModel, "gpt-5.5");
  assert.equal(afterSwitch.defaultModel, "gpt-5.6");
  assert.deepEqual(afterSwitch.allowedModels, ["gpt-5.6"]);
  assert.equal(afterSwitch.credentialId, "cred_healthy");
  assert.equal(context.modelReads, 2);
  assert.equal(context.capabilityReads, 2);
  assert.deepEqual(context.writes, []);
});

test("existing enabled access follows a current provider switch and compatible credential", async () => {
  const context = harness({
    existing: record({ provider: "openai", credentialId: null, defaultModel: "gpt-5", allowedModels: ["gpt-5"] }),
    platformPolicy: policy({
      activeModel: { provider: "openai_compatible", model: "company-model" },
      enabledModels: [{ provider: "openai_compatible", model: "company-model" }],
    }),
  });

  const access = await context.service.getOrCreateUserAiAccess("user_1");

  assert.equal(access.provider, "openai_compatible");
  assert.equal(access.defaultModel, "company-model");
  assert.equal(access.credentialId, "cred_healthy");
  assert.deepEqual(context.capabilityModels, [{ provider: "openai_compatible", model: "company-model" }]);
  assert.deepEqual(context.writes, []);
});

test("concurrent enabled reads share one current policy and capability snapshot", async () => {
  const context = harness({ existing: record() });

  const [left, right] = await Promise.all([
    context.service.getOrCreateUserAiAccess("user_1"),
    context.service.getOrCreateUserAiAccess("user_1"),
  ]);

  assert.deepEqual(left, right);
  assert.equal(context.modelReads, 1);
  assert.equal(context.capabilityReads, 1);
  assert.deepEqual(context.writes, []);
});

test("missing healthy credential keeps access enabled with infrastructure unavailable", async () => {
  const context = harness({ capability: { status: "unsupported" } });

  const access = await context.service.getOrCreateUserAiAccess("user_1");

  assert.equal(access.enabled, true);
  assert.equal(access.provider, "codex_oauth");
  assert.equal(access.credentialId, null);
});

test("transient credential evidence keeps default access enabled for later repair", async () => {
  const context = harness({ capability: { status: "transient", reason: "probe_timeout" } });

  const access = await context.service.getOrCreateUserAiAccess("user_1");

  assert.equal(access.enabled, true);
  assert.equal(access.credentialId, null);
});

test("admin re-enable derives the current provider, credential, and global model roster", async () => {
  const context = harness({ existing: record({ enabled: false, provider: null, credentialId: null }) });

  assert.deepEqual(await context.service.buildEnabledUpdate("user_1", "admin_assigned"), {
    userId: "user_1",
    enabled: true,
    provider: "codex_oauth",
    credentialId: "cred_healthy",
    defaultModel: "gpt-5.6",
    allowedModels: ["gpt-5.6"],
    assignmentOrigin: "admin_assigned",
  });
});

test("providers with pooled lease selection do not pin a user credential", async () => {
  const context = harness({
    platformPolicy: policy({
      activeModel: { provider: "openai", model: "gpt-5" },
      enabledModels: [{ provider: "openai", model: "gpt-5" }],
    }),
  });

  const access = await context.service.getOrCreateUserAiAccess("user_1");

  assert.equal(access.provider, "openai");
  assert.equal(access.credentialId, null);
  assert.equal(context.capabilityReads, 0);
});

test("missing platform policy is an infrastructure error rather than access denial", async () => {
  const context = harness({ platformPolicy: null });

  await assert.rejects(
    context.service.getOrCreateUserAiAccess("user_1"),
    (error: unknown) => error instanceof AutomaticUserAiAccessInfrastructureError
      && error.code === "gateway_platform_model_policy_unavailable",
  );
  assert.deepEqual(context.writes, []);
});

test("concurrent first access shares one initialization write", async () => {
  const context = harness();

  const [left, right] = await Promise.all([
    context.service.getOrCreateUserAiAccess("user_1"),
    context.service.getOrCreateUserAiAccess("user_1"),
  ]);

  assert.equal(left.id, right.id);
  assert.equal(context.writes.length, 1);
});
