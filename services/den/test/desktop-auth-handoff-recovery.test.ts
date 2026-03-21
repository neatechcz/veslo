import assert from "node:assert/strict"
import test from "node:test"

async function loadRecoveryHelper() {
  process.env.DATABASE_URL ??= "mysql://debug:debug@127.0.0.1:3306/debug"
  process.env.BETTER_AUTH_SECRET ??= "debug-secret-debug-secret-debug-1234"
  process.env.BETTER_AUTH_URL ??= "https://den-control-plane-veslo.onrender.com"
  return import("../src/http/desktop-auth-handoff-recovery.js")
}

test("desktop auth handoff recovery repairs the missing session_id column and retries once", async () => {
  const { withDesktopAuthHandoffSessionIdRecovery } = await loadRecoveryHelper()
  const calls: string[] = []

  await withDesktopAuthHandoffSessionIdRecovery({
    run: async () => {
      calls.push("run")
      if (calls.length === 1) {
        throw Object.assign(new Error("Unknown column 'session_id' in 'field list'"), {
          code: "ER_BAD_FIELD_ERROR",
        })
      }
    },
    repairSessionIdColumn: async () => {
      calls.push("repair")
    },
  })

  assert.deepEqual(calls, ["run", "repair", "run"])
})

test("desktop auth handoff recovery does not retry unrelated errors", async () => {
  const { withDesktopAuthHandoffSessionIdRecovery } = await loadRecoveryHelper()
  const calls: string[] = []
  const failure = Object.assign(new Error("connection lost"), { code: "PROTOCOL_CONNECTION_LOST" })

  await assert.rejects(
    () =>
      withDesktopAuthHandoffSessionIdRecovery({
        run: async () => {
          calls.push("run")
          throw failure
        },
        repairSessionIdColumn: async () => {
          calls.push("repair")
        },
      }),
    failure,
  )

  assert.deepEqual(calls, ["run"])
})
