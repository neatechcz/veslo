import assert from "node:assert/strict"
import test from "node:test"

import { createAdminRouter, serializeAdminSessionSnapshot, serializeAdminUser } from "../src/http/admin.js"

test("admin route module exports a router factory", () => {
  assert.equal(typeof createAdminRouter, "function")
})

test("serializeAdminSessionSnapshot exposes platform admin identity and org context", () => {
  const snapshot = serializeAdminSessionSnapshot({
    user: {
      id: "usr_admin",
      email: "vaclav@neotech.cz",
      emailVerified: true,
      name: "Vaclav Soukup",
    },
    platformAdmin: true,
    activeOrgId: "org_alpha",
    organizations: [
      { id: "org_alpha", name: "Alpha", slug: "alpha", ownerUserId: "usr_admin", role: "owner" },
    ],
  })

  assert.deepEqual(snapshot, {
    user: {
      id: "usr_admin",
      email: "vaclav@neotech.cz",
      emailVerified: true,
      name: "Vaclav Soukup",
    },
    platformAdmin: true,
    activeOrgId: "org_alpha",
    organizations: [
      { id: "org_alpha", name: "Alpha", slug: "alpha", ownerUserId: "usr_admin", role: "owner" },
    ],
  })
})

test("serializeAdminUser exposes memberships and platform admin state", () => {
  const user = serializeAdminUser({
    id: "usr_member",
    name: "Member User",
    email: "member@example.com",
    emailVerified: false,
    platformAdmin: false,
    memberships: [
      {
        membershipId: "mem_1",
        orgId: "org_alpha",
        orgName: "Alpha",
        orgSlug: "alpha",
        role: "member",
      },
    ],
  })

  assert.deepEqual(user, {
    id: "usr_member",
    name: "Member User",
    email: "member@example.com",
    emailVerified: false,
    platformAdmin: false,
    disabled: false,
    memberships: [
      {
        membershipId: "mem_1",
        orgId: "org_alpha",
        orgName: "Alpha",
        orgSlug: "alpha",
        role: "member",
      },
    ],
  })
})
