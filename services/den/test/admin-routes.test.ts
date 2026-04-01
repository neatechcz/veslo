import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"

import { createAdminRouter } from "../src/http/admin.js"

function buildSession() {
  return {
    user: {
      id: "user_admin_1",
      email: "vaclav.soukup@neatec.cz",
      emailVerified: false,
      name: "Václav Soukup",
    },
    platformAdmin: true,
    activeOrgId: "org_1",
    organizations: [
      {
        id: "org_1",
        name: "Personal",
        slug: "personal",
        ownerUserId: "user_admin_1",
        role: "owner" as const,
      },
    ],
  }
}

test("admin router exposes disable/enable/delete user actions", async () => {
  const app = express()
  app.use(express.json())
  app.use(
    createAdminRouter({
      async getSessionSnapshot() {
        return buildSession()
      },
      async disableUser() {
        return {
          id: "user_123",
          name: "Blocked User",
          email: "blocked@example.com",
          emailVerified: true,
          platformAdmin: false,
          disabled: true,
          memberships: [],
        }
      },
      async enableUser() {
        return {
          id: "user_123",
          name: "Blocked User",
          email: "blocked@example.com",
          emailVerified: true,
          platformAdmin: false,
          disabled: false,
          memberships: [],
        }
      },
      async deleteUser(_req, res) {
        res.status(204).end()
        return { ok: true }
      },
    }),
  )

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const disableResponse = await fetch(`http://127.0.0.1:${port}/users/user_123/disable`, {
      method: "POST",
    })
    assert.equal(disableResponse.status, 200)
    assert.deepEqual(await disableResponse.json(), {
      user: {
        id: "user_123",
        name: "Blocked User",
        email: "blocked@example.com",
        emailVerified: true,
        platformAdmin: false,
        disabled: true,
        memberships: [],
      },
    })

    const enableResponse = await fetch(`http://127.0.0.1:${port}/users/user_123/enable`, {
      method: "POST",
    })
    assert.equal(enableResponse.status, 200)
    assert.deepEqual(await enableResponse.json(), {
      user: {
        id: "user_123",
        name: "Blocked User",
        email: "blocked@example.com",
        emailVerified: true,
        platformAdmin: false,
        disabled: false,
        memberships: [],
      },
    })

    const deleteResponse = await fetch(`http://127.0.0.1:${port}/users/user_123`, {
      method: "DELETE",
    })
    assert.equal(deleteResponse.status, 204)
    assert.equal(await deleteResponse.text(), "")
  } finally {
    server.close()
    await once(server, "close")
  }
})
