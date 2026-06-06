import assert from "node:assert/strict"
import test from "node:test"
import {
  OrgRole,
  OrganizationDomainTable,
  OrganizationInviteTable,
  OrganizationInviteStatus,
  OrganizationMembershipStatus,
  OrgMembershipTable,
  OrgTable,
} from "../src/db/schema.js"

test("admin gateway org schema exposes organization admin roles, membership status, domains, invites, and seat limits", () => {
  assert.deepEqual(OrgRole, ["member", "organization_admin"])
  assert.deepEqual(OrganizationMembershipStatus, ["active", "disabled", "removed"])
  assert.deepEqual(OrganizationInviteStatus, ["pending", "accepted", "expired", "revoked"])
  assert.ok(OrgTable.seat_limit)
  assert.ok(OrgMembershipTable.status)
  assert.ok(OrganizationDomainTable.domain)
  assert.ok(OrganizationDomainTable.self_signup_enabled)
  assert.ok(OrganizationInviteTable.email)
  assert.ok(OrganizationInviteTable.token_hash)
})
