import assert from "node:assert/strict"
import test from "node:test"

import { MySqlAiAccessRepository } from "../src/access/mysql-repository.js"
import type { AiGatewayDb } from "../src/db/index.js"

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

function createWritableAiAccessDb() {
  let row: Record<string, unknown> | null = null
  const calls: Array<{ kind: "insert" | "update"; values: Record<string, unknown> }> = []

  return {
    calls,
    db: {
      select() {
        return {
          from() {
            return {
              where() {
                return {
                  async limit() {
                    return row ? [row] : []
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
    },
  }
}

test("reads codex_oauth ai access policies from mysql rows", async () => {
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
  assert.equal(Object.hasOwn(policy ?? {}, "defaultModel"), false)
  assert.equal(Object.hasOwn(policy ?? {}, "allowedModels"), false)
})

test("inserts neutral compatibility model columns and preserves them on later user access updates", async () => {
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
  assert.deepEqual(writable.calls[0], {
    kind: "insert",
    values: {
      id: created.id,
      user_id: "user_codex",
      enabled: 1,
      provider: "codex_oauth",
      credential_id: "cred_codex_1",
      default_model: null,
      allowed_models_json: JSON.stringify([]),
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
  assert.deepEqual(writable.calls[1], {
    kind: "update",
    values: {
      enabled: 0,
      provider: null,
      credential_id: null,
      assignment_origin: "admin_assigned",
      updated_at: updated.updatedAt,
    },
  })
})
