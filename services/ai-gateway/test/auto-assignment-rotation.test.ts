import assert from "node:assert/strict";
import test from "node:test";

import type { UserAiAccessPolicyRecord } from "../src/access/repository.js";
import { createAutoAssignedCodexCredentialRotationService } from "../src/access/auto-assignment-rotation.js";

function createAiAccess(overrides: Partial<UserAiAccessPolicyRecord> = {}): UserAiAccessPolicyRecord {
  return {
    id: "ai_access_1",
    userId: "user_1",
    enabled: true,
    provider: "codex_oauth",
    credentialId: "cred_old",
    assignmentOrigin: "auto_assigned",
    createdAt: new Date("2026-05-05T09:00:00.000Z"),
    updatedAt: new Date("2026-05-05T09:00:00.000Z"),
    ...overrides,
  };
}

function createAdminCredential(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id === "cred_new" ? "Replacement Codex" : "Old Codex",
    provider: "codex_oauth",
    type: "oauth",
    state: "healthy",
    scope: "platform",
    activeLeases: id === "cred_new" ? 0 : 3,
    alertCount: 0,
    lastRefreshAt: "2026-05-05T09:00:00.000Z",
    lastFailureAt: null,
    cachedTokens: 0,
    totalTokens: 0,
    nextRotationAt: null,
    linkedAlertIds: [],
    ...overrides,
  };
}

function createCredentialRecord(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    ownerUserId: "platform:codex_oauth",
    provider: "codex_oauth",
    credentialType: "oauth",
    state: "healthy",
    secretRef: `secret_${id}`,
    createdAt: new Date("2026-05-05T09:00:00.000Z"),
    updatedAt: new Date("2026-05-05T09:00:00.000Z"),
    lastFailureAt: null,
    ...overrides,
  };
}

const healthyStatus = {
  available: true,
  source: "codex_exec_no_rate_limits",
  label: "Codex OK, limits unknown",
  detail: null,
  checkedAt: "2026-05-05T09:00:00.000Z",
  limits: {
    fiveHour: null,
    weekly: null,
  },
} as const;

const exhaustedStatus = {
  available: true,
  source: "codex_exec_rate_limits",
  label: "Codex limits available",
  detail: null,
  checkedAt: "2026-05-05T09:00:00.000Z",
  limits: {
    fiveHour: {
      label: "5h",
      usedPercent: 100,
      windowMinutes: 300,
      resetAt: "2026-05-05T12:00:00.000Z",
    },
    weekly: null,
  },
} as const;

test("rotates auto-assigned Codex access away from an exhausted credential", async () => {
  const upserts: unknown[] = [];
  const auditCalls: unknown[] = [];
  const service = createAutoAssignedCodexCredentialRotationService({
    aiAccess: {
      async getUserAiAccess() {
        throw new Error("unused");
      },
      async upsertUserAiAccess(input) {
        upserts.push(input);
        return createAiAccess({
          credentialId: input.credentialId,
          updatedAt: new Date("2026-05-05T09:01:00.000Z"),
        });
      },
    },
    credentials: {
      async getCredentialRecordById(credentialId: string) {
        return credentialId === "cred_old" ? createCredentialRecord("cred_old") : null;
      },
      async listAdminCredentials() {
        return [
          createAdminCredential("cred_old"),
          createAdminCredential("cred_new"),
        ];
      },
    } as any,
    codexStatusProvider: {
      async getStatus(input) {
        return input.credentialId === "cred_old" ? exhaustedStatus : healthyStatus;
      },
    },
    audit: {
      async recordEvent(input) {
        auditCalls.push(input);
      },
    },
    now: () => new Date("2026-05-05T09:30:00.000Z"),
  });

  const repaired = await service.repairCodexAccess({
    aiAccess: createAiAccess(),
    activeModel: { provider: "codex_oauth", model: "gpt-5.5" },
    reason: "codex_proxy_request",
  });

  assert.equal(repaired.credentialId, "cred_new");
  assert.deepEqual(upserts, [
    {
      userId: "user_1",
      enabled: true,
      provider: "codex_oauth",
      credentialId: "cred_new",
      assignmentOrigin: "auto_assigned",
    },
  ]);
  assert.deepEqual(auditCalls, [
    {
      actorUserId: null,
      entityType: "user",
      entityId: "user_1",
      action: "user.ai_access.auto_rotate",
      result: "ok",
      summary: "Rotated Codex credential for user user_1 from cred_old to cred_new.",
    },
  ]);
});

test("does not rotate to a Codex credential that cannot serve the active model", async () => {
  const upserts: unknown[] = [];
  const service = createAutoAssignedCodexCredentialRotationService({
    aiAccess: {
      async getUserAiAccess() {
        throw new Error("unused");
      },
      async upsertUserAiAccess(input) {
        upserts.push(input);
        return createAiAccess({ credentialId: input.credentialId });
      },
    },
    credentials: {
      async getCredentialRecordById(credentialId: string) {
        return credentialId === "cred_old" ? createCredentialRecord("cred_old") : null;
      },
      async listAdminCredentials() {
        return [createAdminCredential("cred_old"), createAdminCredential("cred_new")];
      },
    } as any,
    codexStatusProvider: {
      async getStatus(input) {
        return input.credentialId === "cred_old"
          ? { ...healthyStatus, unsupportedModels: ["gpt-5.5"] }
          : { ...healthyStatus, unsupportedModels: ["gpt-5.5"] };
      },
    },
    now: () => new Date("2026-05-05T09:30:00.000Z"),
  });

  const original = createAiAccess();
  await assert.rejects(
    service.repairCodexAccess({
      aiAccess: original,
      activeModel: { provider: "codex_oauth", model: "gpt-5.5" },
      reason: "codex_proxy_request",
    }),
    { message: "assigned_credential_model_incompatible" },
  );
  assert.deepEqual(upserts, []);
});

test("fails closed when active-model compatibility cannot be verified", async () => {
  const service = createAutoAssignedCodexCredentialRotationService({
    aiAccess: {
      async getUserAiAccess() { throw new Error("unused"); },
      async upsertUserAiAccess() { throw new Error("must not write"); },
    },
    credentials: {
      async getCredentialRecordById() { return createCredentialRecord("cred_old"); },
    } as any,
    codexStatusProvider: {
      async getStatus() { throw new Error("probe unavailable"); },
    },
  });

  await assert.rejects(
    service.repairCodexAccess({
      aiAccess: createAiAccess(),
      activeModel: { provider: "codex_oauth", model: "gpt-5.5" },
    }),
    { message: "assigned_credential_unavailable" },
  );
});

test("preserves exhausted compatible assignment for the capacity error path", async () => {
  const upserts: unknown[] = [];
  const service = createAutoAssignedCodexCredentialRotationService({
    aiAccess: {
      async getUserAiAccess() { throw new Error("unused"); },
      async upsertUserAiAccess(input) { upserts.push(input); return createAiAccess(); },
    },
    credentials: {
      async getCredentialRecordById() { return createCredentialRecord("cred_old"); },
      async listAdminCredentials() { return [createAdminCredential("cred_old")]; },
    } as any,
    codexStatusProvider: { async getStatus() { return exhaustedStatus; } },
    now: () => new Date("2026-05-05T09:30:00.000Z"),
  });
  const original = createAiAccess({ assignmentOrigin: "admin_assigned" });
  const repaired = await service.repairCodexAccess({
    aiAccess: original,
    activeModel: { provider: "codex_oauth", model: "gpt-5.5" },
  });
  assert.equal(repaired, original);
  assert.equal(repaired.assignmentOrigin, "admin_assigned");
  assert.deepEqual(upserts, []);
});

test("reports capacity when a replacement supports the model but is exhausted", async () => {
  const service = createAutoAssignedCodexCredentialRotationService({
    aiAccess: {
      async getUserAiAccess() { throw new Error("unused"); },
      async upsertUserAiAccess() { throw new Error("must not write"); },
    },
    credentials: {
      async getCredentialRecordById() { return createCredentialRecord("cred_old"); },
      async listAdminCredentials() { return [createAdminCredential("cred_old"), createAdminCredential("cred_new")]; },
    } as any,
    codexStatusProvider: {
      async getStatus(input) {
        return input.credentialId === "cred_old"
          ? { ...healthyStatus, unsupportedModels: ["gpt-5.5"] }
          : exhaustedStatus;
      },
    },
    now: () => new Date("2026-05-05T09:30:00.000Z"),
  });
  await assert.rejects(
    service.repairCodexAccess({
      aiAccess: createAiAccess(),
      activeModel: { provider: "codex_oauth", model: "gpt-5.5" },
    }),
    { message: "no_eligible_codex_credentials:all_codex_credentials_exhausted" },
  );
});

test("leaves a missing assigned credential for the existing unavailable-binding path", async () => {
  const service = createAutoAssignedCodexCredentialRotationService({
    aiAccess: {
      async getUserAiAccess() { throw new Error("unused"); },
      async upsertUserAiAccess() { throw new Error("must not write"); },
    },
    credentials: {
      async getCredentialRecordById() { return null; },
      async listAdminCredentials() { return []; },
    } as any,
    codexStatusProvider: { async getStatus() { throw new Error("must not probe"); } },
  });
  const original = createAiAccess({ assignmentOrigin: "admin_assigned" });
  const repaired = await service.repairCodexAccess({
    aiAccess: original,
    activeModel: { provider: "codex_oauth", model: "gpt-5.5" },
  });
  assert.equal(repaired, original);
  assert.equal(repaired.assignmentOrigin, "admin_assigned");
});

test("rotates admin-assigned Codex access away from an exhausted credential", async () => {
  const upserts: unknown[] = [];
  const service = createAutoAssignedCodexCredentialRotationService({
    aiAccess: {
      async getUserAiAccess() {
        throw new Error("unused");
      },
      async upsertUserAiAccess(input) {
        upserts.push(input);
        return createAiAccess({
          credentialId: input.credentialId,
          assignmentOrigin: input.assignmentOrigin,
          updatedAt: new Date("2026-05-05T09:01:00.000Z"),
        });
      },
    },
    credentials: {
      async getCredentialRecordById(credentialId: string) {
        return credentialId === "cred_old" ? createCredentialRecord("cred_old") : null;
      },
      async listAdminCredentials() {
        return [
          createAdminCredential("cred_old"),
          createAdminCredential("cred_new"),
        ];
      },
    } as any,
    codexStatusProvider: {
      async getStatus(input) {
        return input.credentialId === "cred_old" ? exhaustedStatus : healthyStatus;
      },
    },
    now: () => new Date("2026-05-05T09:30:00.000Z"),
  });

  const repaired = await service.repairCodexAccess({
    aiAccess: createAiAccess({ assignmentOrigin: "admin_assigned" }),
    reason: "codex_proxy_request",
  });

  assert.equal(repaired.credentialId, "cred_new");
  assert.equal(repaired.assignmentOrigin, "admin_assigned");
  assert.deepEqual(upserts, [
    {
      userId: "user_1",
      enabled: true,
      provider: "codex_oauth",
      credentialId: "cred_new",
      assignmentOrigin: "admin_assigned",
    },
  ]);
});

test("rotation writes no model fields and preserves assignment origin", async () => {
  const upserts: unknown[] = [];
  const service = createAutoAssignedCodexCredentialRotationService({
    aiAccess: {
      async getUserAiAccess() {
        throw new Error("unused");
      },
      async upsertUserAiAccess(input) {
        upserts.push(input);
        return createAiAccess({
          credentialId: input.credentialId,
          assignmentOrigin: input.assignmentOrigin,
          updatedAt: new Date("2026-05-05T09:01:00.000Z"),
        });
      },
    },
    credentials: {
      async getCredentialRecordById(credentialId: string) {
        return credentialId === "cred_old" ? createCredentialRecord("cred_old") : null;
      },
      async listAdminCredentials() {
        return [
          createAdminCredential("cred_old"),
          createAdminCredential("cred_new"),
        ];
      },
    } as any,
    codexStatusProvider: {
      async getStatus(input) {
        return input.credentialId === "cred_old" ? exhaustedStatus : healthyStatus;
      },
    },
    now: () => new Date("2026-05-05T09:30:00.000Z"),
  });

  const repaired = await service.repairCodexAccess({
    aiAccess: createAiAccess({ assignmentOrigin: "admin_assigned" }),
    activeModel: { provider: "codex_oauth", model: "gpt-5.5" },
    reason: "codex_proxy_request",
  });

  assert.equal(repaired.credentialId, "cred_new");
  assert.equal(repaired.assignmentOrigin, "admin_assigned");
  assert.deepEqual(upserts, [
    {
      userId: "user_1",
      enabled: true,
      provider: "codex_oauth",
      credentialId: "cred_new",
      assignmentOrigin: "admin_assigned",
    },
  ]);
});

test("does not rotate admin-assigned non-Codex access", async () => {
  const service = createAutoAssignedCodexCredentialRotationService({
    aiAccess: {
      async getUserAiAccess() {
        throw new Error("unused");
      },
      async upsertUserAiAccess() {
        throw new Error("should_not_write");
      },
    },
    credentials: {
      async getCredentialRecordById() {
        throw new Error("should_not_read");
      },
    } as any,
    codexStatusProvider: {
      async getStatus() {
        throw new Error("should_not_probe");
      },
    },
    now: () => new Date("2026-05-05T09:30:00.000Z"),
  });

  const aiAccess = createAiAccess({
    provider: "openai_compatible",
    assignmentOrigin: "admin_assigned",
  });
  const repaired = await service.repairCodexAccess({ aiAccess });

  assert.equal(repaired, aiAccess);
});
