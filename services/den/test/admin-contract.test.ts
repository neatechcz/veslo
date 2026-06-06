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
      { id: "org_alpha", name: "Alpha", slug: "alpha", ownerUserId: "usr_admin", role: "organization_admin" },
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
      { id: "org_alpha", name: "Alpha", slug: "alpha", ownerUserId: "usr_admin", role: "organization_admin" },
    ],
    capabilities: [
      "organization",
      "users",
      "credentials",
      "sessions",
      "usage",
      "alerts",
      "audit",
      "debugLogs",
      "managedAiUserAccess",
    ],
    allowedPages: [
      "organization",
      "users",
      "credentials",
      "sessions",
      "usage",
      "alerts",
      "audit",
      "debug-logs",
    ],
  })
})

test("serializeAdminSessionSnapshot limits organization admin capabilities to organization and users", () => {
  const snapshot = serializeAdminSessionSnapshot({
    user: {
      id: "usr_org_admin",
      email: "admin@example.com",
      emailVerified: true,
      name: "Org Admin",
    },
    platformAdmin: false,
    activeOrgId: "org_alpha",
    organizations: [
      { id: "org_alpha", name: "Alpha", slug: "alpha", ownerUserId: "usr_org_admin", role: "organization_admin" },
    ],
  })

  assert.deepEqual(snapshot, {
    user: {
      id: "usr_org_admin",
      email: "admin@example.com",
      emailVerified: true,
      name: "Org Admin",
    },
    platformAdmin: false,
    activeOrgId: "org_alpha",
    organizations: [
      { id: "org_alpha", name: "Alpha", slug: "alpha", ownerUserId: "usr_org_admin", role: "organization_admin" },
    ],
    capabilities: ["organization", "users"],
    allowedPages: ["organization", "users"],
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
