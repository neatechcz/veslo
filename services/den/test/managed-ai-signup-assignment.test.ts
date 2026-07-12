import assert from "node:assert/strict"
import test from "node:test"

import { createManagedAiSignupAssignmentService, DEFAULT_CODEX_AUTO_ASSIGN_MODEL } from "../src/managed-ai/signup-assignment.js"

test("signup assignment default model is gpt-5.6-sol", () => {
  assert.equal(DEFAULT_CODEX_AUTO_ASSIGN_MODEL, "gpt-5.6-sol")
})

function createCredential(
  id: string,
  overrides: Partial<{ provider: string; state: "healthy" | "draining" | "revoked" | "unhealthy" | "degraded"; activeLeases: number; name: string } > = {},
) {
  return {
    id,
    name: overrides.name ?? `Credential ${id}`,
    provider: overrides.provider ?? "codex_oauth",
    type: "oauth" as const,
    state: overrides.state ?? "healthy",
    scope: "platform",
    activeLeases: overrides.activeLeases ?? 0,
    alertCount: 0,
    lastRefreshAt: "2026-04-27T12:00:00.000Z",
    lastFailureAt: null,
    totalTokens: 0,
    nextRotationAt: null,
    linkedAlertIds: [],
  }
}

test("new user gets the least-loaded healthy eligible Codex credential", async () => {
  const upserts: unknown[] = []
  const statusChecks: string[] = []
  const service = createManagedAiSignupAssignmentService({
    aiAccess: {
      async getUserAiAccess() {
        return null
      },
      async upsertUserAiAccess(input) {
        upserts.push(input)
        return {
          id: "ai_access_1",
          userId: input.userId,
          enabled: input.enabled,
          provider: input.provider,
          credentialId: input.credentialId,
          defaultModel: input.defaultModel,
          allowedModels: input.allowedModels,
          createdAt: new Date("2026-04-27T12:00:00.000Z"),
          updatedAt: new Date("2026-04-27T12:00:00.000Z"),
        }
      },
    } as any,
    credentials: {
      async listAdminCredentials() {
        return [
          createCredential("cred_openai_1", { provider: "openai_compatible" }),
          createCredential("cred_codex_unhealthy", { state: "revoked" }),
          createCredential("cred_codex_3", { activeLeases: 2 }),
          createCredential("cred_codex_2", { activeLeases: 1 }),
          createCredential("cred_codex_1", { activeLeases: 4 }),
        ]
      },
    } as any,
    codexStatusProvider: {
      async getStatus(input) {
        statusChecks.push(input.credentialId)
        return {
          available: true,
          source: "codex_exec_rate_limits",
          label: "Codex limits available",
          detail: null,
          checkedAt: "2026-04-27T12:00:00.000Z",
        }
      },
    },
  })

  const assigned = await service.maybeAssignDefaultCodexAccessForNewUser("user_1")

  assert.equal(assigned, true)
  assert.deepEqual(statusChecks, ["cred_codex_3", "cred_codex_2", "cred_codex_1"])
  assert.deepEqual(upserts, [
    {
      userId: "user_1",
      enabled: true,
      provider: "codex_oauth",
      credentialId: "cred_codex_2",
      defaultModel: "gpt-5.6-sol",
      allowedModels: ["gpt-5.6-sol"],
      assignmentOrigin: "auto_assigned",
    },
  ])
})

test("existing ai access is preserved", async () => {
  let statusChecks = 0
  const upserts: unknown[] = []
  const service = createManagedAiSignupAssignmentService({
    aiAccess: {
      async getUserAiAccess() {
        return {
          id: "ai_access_existing",
          userId: "user_1",
          enabled: true,
          provider: "codex_oauth",
          credentialId: "cred_codex_1",
          defaultModel: DEFAULT_CODEX_AUTO_ASSIGN_MODEL,
          allowedModels: [DEFAULT_CODEX_AUTO_ASSIGN_MODEL],
          createdAt: new Date("2026-04-27T12:00:00.000Z"),
          updatedAt: new Date("2026-04-27T12:00:00.000Z"),
        }
      },
      async upsertUserAiAccess(input) {
        upserts.push(input)
        throw new Error("should_not_write")
      },
    } as any,
    credentials: {
      async listAdminCredentials() {
        return [
          createCredential("cred_codex_1"),
        ]
      },
    } as any,
    codexStatusProvider: {
      async getStatus() {
        statusChecks += 1
        return {
          available: true,
          source: "codex_exec_rate_limits",
          label: "Codex limits available",
          detail: null,
          checkedAt: "2026-04-27T12:00:00.000Z",
        }
      },
    },
  })

  const assigned = await service.maybeAssignDefaultCodexAccessForNewUser("user_1")

  assert.equal(assigned, false)
  assert.equal(statusChecks, 0)
  assert.deepEqual(upserts, [])
})

test("assignment skips when no eligible codex credential exists", async () => {
  const upserts: unknown[] = []
  const service = createManagedAiSignupAssignmentService({
    aiAccess: {
      async getUserAiAccess() {
        return null
      },
      async upsertUserAiAccess(input) {
        upserts.push(input)
        throw new Error("should_not_write")
      },
    } as any,
    credentials: {
      async listAdminCredentials() {
        return [
          createCredential("cred_codex_1", { state: "draining" }),
        ]
      },
    } as any,
    codexStatusProvider: {
      async getStatus() {
        return {
          available: false,
          source: "unavailable",
          label: "Codex limits unavailable",
          detail: null,
          checkedAt: "2026-04-27T12:00:00.000Z",
        }
      },
    },
  })

  const assigned = await service.maybeAssignDefaultCodexAccessForNewUser("user_1")

  assert.equal(assigned, false)
  assert.deepEqual(upserts, [])
})

test("assignment failures are logged but do not throw", async () => {
  const logs: Array<{ message: string; error: unknown }> = []
  const service = createManagedAiSignupAssignmentService({
    aiAccess: {
      async getUserAiAccess() {
        throw new Error("db_unavailable")
      },
      async upsertUserAiAccess() {
        throw new Error("should_not_write")
      },
    } as any,
    credentials: {
      async listAdminCredentials() {
        return []
      },
    } as any,
    codexStatusProvider: {
      async getStatus() {
        throw new Error("should_not_run")
      },
    },
    logger(message, error) {
      logs.push({ message, error })
    },
  })

  const assigned = await service.maybeAssignDefaultCodexAccessForNewUser("user_1")

  assert.equal(assigned, false)
  assert.equal(logs.length, 1)
  assert.equal(logs[0]?.message, "managed ai signup assignment failed")
  assert.match(String(logs[0]?.error), /db_unavailable/)
})
