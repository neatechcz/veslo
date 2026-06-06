import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
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

const bootstrapSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8")

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

test("admin gateway organization bootstrap DDL matches the schema foundation", () => {
  assert.match(bootstrapSource, /\\?`seat_limit\\?` int unsigned/)
  assert.match(bootstrapSource, /\\?`role\\?` enum\('member','organization_admin'\) NOT NULL/)
  assert.match(bootstrapSource, /\\?`status\\?` enum\('active','disabled','removed'\) NOT NULL DEFAULT 'active'/)
  assert.match(bootstrapSource, /CREATE TABLE IF NOT EXISTS \\?`organization_domain\\?`/)
  assert.match(bootstrapSource, /\\?`domain\\?` varchar\(255\) NOT NULL/)
  assert.match(bootstrapSource, /\\?`self_signup_enabled\\?` boolean NOT NULL DEFAULT false/)
  assert.match(bootstrapSource, /CREATE TABLE IF NOT EXISTS \\?`organization_invite\\?`/)
  assert.match(bootstrapSource, /\\?`email\\?` varchar\(255\) NOT NULL/)
  assert.match(bootstrapSource, /\\?`token_hash\\?` varchar\(255\) NOT NULL/)
  assert.match(bootstrapSource, /ensureIndex\("org_membership", "org_membership_org_status", \["org_id", "status"\]\)/)
  assert.match(bootstrapSource, /ensureIndex\("org_membership", "org_membership_user_status", \["user_id", "status"\]\)/)
  assert.match(bootstrapSource, /ensureIndex\("organization_domain", "organization_domain_org_id", \["org_id"\]\)/)
  assert.match(bootstrapSource, /ensureIndex\("organization_invite", "organization_invite_org_status", \["org_id", "status"\]\)/)
  assert.match(bootstrapSource, /ensureIndex\("organization_invite", "organization_invite_email_status", \["email", "status"\]\)/)
})

test("admin gateway organization bootstrap reconciles old org table shapes before status indexes", () => {
  assert.match(bootstrapSource, /ensureColumn\("org", "seat_limit", "int unsigned"\)/)
  assert.match(
    bootstrapSource,
    /ensureColumn\("org_membership", "status", "enum\('active','disabled','removed'\) NOT NULL DEFAULT 'active'"\)/,
  )
  assert.match(bootstrapSource, /MODIFY COLUMN \$\{quoteIdentifier\("role"\)\} enum\('owner','member','organization_admin'\) NOT NULL/)
  assert.match(bootstrapSource, /UPDATE \\?`org_membership\\?`\s+SET \\?`role\\?` = 'organization_admin'\s+WHERE \\?`role\\?` = 'owner'/)
  assert.match(bootstrapSource, /MODIFY COLUMN \$\{quoteIdentifier\("role"\)\} enum\('member','organization_admin'\) NOT NULL/)

  const statusColumnOffset = bootstrapSource.indexOf(
    `ensureColumn("org_membership", "status", "enum('active','disabled','removed') NOT NULL DEFAULT 'active'")`,
  )
  const statusIndexOffset = bootstrapSource.indexOf(
    `ensureIndex("org_membership", "org_membership_org_status", ["org_id", "status"])`,
  )
  assert.ok(statusColumnOffset >= 0)
  assert.ok(statusIndexOffset >= 0)
  assert.ok(statusColumnOffset < statusIndexOffset)
})
