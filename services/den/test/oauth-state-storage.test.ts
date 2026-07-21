import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { betterAuthAccountOptions } from "../src/auth/oauth-state-config.js"

test("invitation OAuth state is explicitly stored in Better Auth encrypted cookies", async () => {
  assert.deepEqual(betterAuthAccountOptions, {
    storeStateStrategy: "cookie",
  })

  const source = await readFile(new URL("../src/auth.ts", import.meta.url), "utf8")
  assert.match(source, /account:\s*betterAuthAccountOptions/)
  assert.doesNotMatch(source, /storeStateStrategy:\s*["']database["']/)
  assert.doesNotMatch(source, /skipStateCookieCheck|storeAccountCookie/)
})
