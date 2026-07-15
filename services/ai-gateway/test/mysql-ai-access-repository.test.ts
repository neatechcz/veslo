import assert from "node:assert/strict"
import test from "node:test"

import {
  AiAccessProviderMismatchError,
  MySqlAiAccessRepository,
} from "../src/access/mysql-repository.js"
import type { AiGatewayDb } from "../src/db/index.js"
import { platformModelPolicyTable, userAiAccessPolicyTable } from "../src/db/schema.js"
import { CODEX_DEFAULT_MODEL } from "../src/providers/codex-model-catalog.js"

function createAiAccessDb(row: Record<string, unknown>) {
  return {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                async limit() {
                  return [row]
                },
              }
            },
          }
        },
      }
    },
  }
}

function createAiAccessCountDb(count: number | string) {
  let whereCalls = 0

  return {
    get whereCalls() {
      return whereCalls
    },
    db: {
      select() {
        return {
          from() {
            return {
              async where() {
                whereCalls += 1
                return [{ count }]
              },
            }
          },
        }
      },
    },
  }
}

function createWritableAiAccessDb(options: { activeProvider?: string | null } = {}) {
  let row: Record<string, unknown> | null = null
  const activeProvider = options.activeProvider ?? "codex_oauth"
  const calls: Array<{ kind: "insert" | "update"; values: Record<string, unknown> }> = []
  const lockedTables: string[] = []
  let transactionCount = 0

  return {
    calls,
    lockedTables,
    get transactionCount() {
      return transactionCount
    },
    db: {
      select() {
        return {
          from(table: unknown) {
            return {
              where() {
                return {
                  limit() {
                    const result = Promise.resolve(row ? [row] : []) as Promise<Record<string, unknown>[]> & {
                      for(mode: string): Promise<Record<string, unknown>[]>;
                    }
                    result.for = async () => {
                      if (table === platformModelPolicyTable) {
                        lockedTables.push("platform_model_policy:update")
                        return activeProvider
                          ? [{ activeProvider }]
                          : []
                      }
                      if (table === userAiAccessPolicyTable) {
                        lockedTables.push("user_ai_access_policy:update")
                        return row ? [row] : []
                      }
                      throw new Error("unexpected select table")
                    }
                    return result
                  },
                }
              },
            }
          },
        }
      },
      insert() {
        return {
          values(values: Record<string, unknown>) {
            calls.push({ kind: "insert", values })
            row = {
              id: values.id,
              user_id: values.user_id,
              enabled: values.enabled,
              provider: values.provider,
              credential_id: values.credential_id,
              default_model: values.default_model,
              allowed_models_json: values.allowed_models_json,
              assignment_origin: values.assignment_origin,
              created_at: values.created_at,
              updated_at: values.updated_at,
            }
          },
        }
      },
      update() {
        return {
          set(values: Record<string, unknown>) {
            calls.push({ kind: "update", values })
            row = {
              ...(row ?? {}),
              enabled: values.enabled,
              provider: values.provider,
              credential_id: values.credential_id,
              default_model: values.default_model,
              allowed_models_json: values.allowed_models_json,
              assignment_origin: values.assignment_origin,
              updated_at: values.updated_at,
            }
            return {
              where() {
                return Promise.resolve()
              },
            }
          },
        }
      },
      async transaction(callback: (tx: unknown) => Promise<unknown>) {
        transactionCount += 1
        return callback(this)
      },
    },
  }
}

test("reads codex_oauth ai access model fields from mysql rows", async () => {
  const repository = new MySqlAiAccessRepository(
    createAiAccessDb({
      id: "ai_access_user_codex",
      user_id: "user_codex",
      enabled: 1,
      provider: "codex_oauth",
      credential_id: "cred_codex_1",
      default_model: "gpt-5.4",
      allowed_models_json: JSON.stringify(["gpt-5.4"]),
      created_at: new Date("2026-04-14T10:00:00.000Z"),
      updated_at: new Date("2026-04-14T10:05:00.000Z"),
    }) as AiGatewayDb,
  )

  const policy = await repository.getUserAiAccess("user_codex")

  assert.equal(policy?.provider, "codex_oauth")
  assert.equal(policy?.credentialId, "cred_codex_1")
  assert.equal(policy?.assignmentOrigin, "admin_assigned")
  assert.equal(policy?.defaultModel, "gpt-5.4")
  assert.deepEqual(policy?.allowedModels, ["gpt-5.4"])
})

test("counts enabled ai access policies incompatible with a target provider", async () => {
  const counting = createAiAccessCountDb("2")
  const repository = new MySqlAiAccessRepository(counting.db as AiGatewayDb)

  const count = await repository.countEnabledPoliciesIncompatibleWithProvider("codex_oauth")

  assert.equal(count, 2)
  assert.equal(counting.whereCalls, 1)
})

test("fills runtime model fields and clears them on later disabled user access updates", async () => {
  const writable = createWritableAiAccessDb()
  const repository = new MySqlAiAccessRepository(writable.db as AiGatewayDb)

  const created = await repository.upsertUserAiAccess({
    userId: "user_codex",
    enabled: true,
    provider: "codex_oauth",
    credentialId: "cred_codex_1",
    assignmentOrigin: "admin_assigned",
  })

  assert.equal(created.credentialId, "cred_codex_1")
  assert.equal(writable.transactionCount, 1)
  assert.deepEqual(writable.lockedTables.slice(0, 2), [
    "platform_model_policy:update",
    "user_ai_access_policy:update",
  ])
  assert.deepEqual(writable.calls[0], {
    kind: "insert",
    values: {
      id: created.id,
      user_id: "user_codex",
      enabled: 1,
      provider: "codex_oauth",
      credential_id: "cred_codex_1",
      default_model: CODEX_DEFAULT_MODEL,
      allowed_models_json: JSON.stringify([CODEX_DEFAULT_MODEL]),
      assignment_origin: "admin_assigned",
      created_at: created.createdAt,
      updated_at: created.updatedAt,
    },
  })

  const updated = await repository.upsertUserAiAccess({
    userId: "user_codex",
    enabled: false,
    provider: null,
    credentialId: null,
    assignmentOrigin: "admin_assigned",
  })

  assert.equal(updated.credentialId, null)
  assert.equal(writable.transactionCount, 2)
  assert.deepEqual(writable.lockedTables.slice(2, 4), [
    "platform_model_policy:update",
    "user_ai_access_policy:update",
  ])
  assert.deepEqual(writable.calls[1], {
    kind: "update",
    values: {
      enabled: 0,
      provider: null,
      credential_id: null,
      default_model: null,
      allowed_models_json: JSON.stringify([]),
      assignment_origin: "admin_assigned",
      updated_at: updated.updatedAt,
    },
  })
})

test("rejects enabled writes that do not match the locked active provider", async () => {
  const writable = createWritableAiAccessDb({ activeProvider: "openai_compatible" })
  const repository = new MySqlAiAccessRepository(writable.db as AiGatewayDb)

  await assert.rejects(
    repository.upsertUserAiAccess({
      userId: "user_codex",
      enabled: true,
      provider: "codex_oauth",
      credentialId: "cred_codex_1",
      assignmentOrigin: "admin_assigned",
    }),
    (error: unknown) => error instanceof AiAccessProviderMismatchError
      && error.message === "ai_access_provider_mismatch"
      && (error as { status?: number }).status === 409,
  )

  assert.equal(writable.transactionCount, 1)
  assert.deepEqual(writable.lockedTables, ["platform_model_policy:update"])
  assert.deepEqual(writable.calls, [])
})
