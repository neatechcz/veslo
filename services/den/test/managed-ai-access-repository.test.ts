import assert from "node:assert/strict"
import test from "node:test"

import { MySqlAiAccessRepository } from "../src/managed-ai/access/mysql-repository.js"

type WriteCall = {
  kind: "insert" | "update"
  values: Record<string, unknown>
}

function createWritableAiAccessDb(initialRow: Record<string, unknown> | null = null) {
  let row = initialRow
  const calls: WriteCall[] = []

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
            row = values
          },
        }
      },
      update() {
        return {
          set(values: Record<string, unknown>) {
            calls.push({ kind: "update", values })
            row = { ...(row ?? {}), ...values }
            return {
              async where() {},
            }
          },
        }
      },
    },
  }
}

test("DEN access updates preserve historical per-user model columns without writing them", async () => {
  const writable = createWritableAiAccessDb({
    id: "ai_access_legacy",
    user_id: "user_legacy",
    enabled: 1,
    provider: "openai",
    credential_id: null,
    default_model: "legacy-user-model",
    allowed_models_json: JSON.stringify(["legacy-user-model"]),
    assignment_origin: "admin_assigned",
    created_at: new Date("2026-07-12T08:00:00.000Z"),
    updated_at: new Date("2026-07-12T08:00:00.000Z"),
  })
  const repository = new MySqlAiAccessRepository(writable.db)

  const updated = await repository.upsertUserAiAccess({
    userId: "user_legacy",
    enabled: true,
    provider: "codex_oauth",
    credentialId: "cred_codex_1",
    assignmentOrigin: "admin_assigned",
  })

  assert.equal(updated.defaultModel, "legacy-user-model")
  assert.deepEqual(updated.allowedModels, ["legacy-user-model"])
  assert.equal(Object.hasOwn(writable.calls[0]?.values ?? {}, "default_model"), false)
  assert.equal(Object.hasOwn(writable.calls[0]?.values ?? {}, "allowed_models_json"), false)
})

test("DEN access inserts write neutral values for retained model columns", async () => {
  const writable = createWritableAiAccessDb()
  const repository = new MySqlAiAccessRepository(writable.db)

  const created = await repository.upsertUserAiAccess({
    userId: "user_new",
    enabled: true,
    provider: "codex_oauth",
    credentialId: "cred_codex_1",
    assignmentOrigin: "auto_assigned",
  })

  assert.equal(created.defaultModel, null)
  assert.deepEqual(created.allowedModels, [])
  assert.equal(writable.calls[0]?.values.default_model, null)
  assert.equal(writable.calls[0]?.values.allowed_models_json, "[]")
})
