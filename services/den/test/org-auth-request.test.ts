import assert from "node:assert/strict"
import test from "node:test"

function setupEnv() {
  process.env.DATABASE_URL ??= "mysql://root:root@localhost:3306/veslo_test"
  process.env.BETTER_AUTH_SECRET ??= "0123456789abcdef0123456789abcdef"
  process.env.BETTER_AUTH_URL ??= "http://localhost:8788"
}

function request(headers: Record<string, string | undefined>, query: Record<string, unknown> = {}) {
  const normalizedHeaders = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  )
  return {
    header: (name: string) => normalizedHeaders.get(name.toLowerCase()),
    query,
  }
}

test("readRequestedOrganizationId accepts registry org header while preserving legacy header precedence", async () => {
  setupEnv()
  const { readRequestedOrganizationId } = await import("../src/http/org-auth.js")

  assert.equal(
    readRequestedOrganizationId(request({ "x-veslo-den-org-id": " org_registry " }) as never),
    "org_registry",
  )
  assert.equal(
    readRequestedOrganizationId(request({
      "x-veslo-org-id": "org_legacy",
      "x-veslo-den-org-id": "org_registry",
    }) as never),
    "org_legacy",
  )
})
