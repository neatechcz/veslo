import assert from "node:assert/strict"
import test from "node:test"
import {
  canDeleteWorker,
  canRevealWorkerHostToken,
  hasRequiredOrgRole,
  pickActiveOrganization,
  wouldLeaveOrganizationWithoutOwner,
  type OrganizationAccessSummary,
} from "../src/http/access.js"

const organizations: OrganizationAccessSummary[] = [
  {
    id: "org-alpha",
    name: "Alpha",
    slug: "alpha",
    ownerUserId: "user-owner",
    membershipId: "membership-alpha",
    role: "owner",
  },
  {
    id: "org-beta",
    name: "Beta",
    slug: "beta",
    ownerUserId: "user-beta-owner",
    membershipId: "membership-beta",
    role: "member",
  },
]

test("pickActiveOrganization resolves the requested membership org", () => {
  const result = pickActiveOrganization(organizations, "org-beta")
  assert.equal(result.ok, true)
  if (!result.ok) {
    return
  }

  assert.equal(result.organization.id, "org-beta")
  assert.equal(result.organization.role, "member")
})

test("pickActiveOrganization falls back to the only org membership", () => {
  const result = pickActiveOrganization([organizations[0]], null)
  assert.equal(result.ok, true)
  if (!result.ok) {
    return
  }

  assert.equal(result.organization.id, "org-alpha")
})

test("pickActiveOrganization rejects ambiguous multi-org requests without explicit org context", () => {
  const result = pickActiveOrganization(organizations, null)
  assert.deepEqual(result, {
    ok: false,
    error: "org_context_required",
    status: 400,
  })
})

test("pickActiveOrganization rejects organizations the user does not belong to", () => {
  const result = pickActiveOrganization(organizations, "org-gamma")
  assert.deepEqual(result, {
    ok: false,
    error: "organization_forbidden",
    status: 403,
  })
})

test("hasRequiredOrgRole enforces owner-only operations", () => {
  assert.equal(hasRequiredOrgRole("owner", "owner"), true)
  assert.equal(hasRequiredOrgRole("owner", "member"), true)
  assert.equal(hasRequiredOrgRole("member", "member"), true)
  assert.equal(hasRequiredOrgRole("member", "owner"), false)
})

test("canDeleteWorker allows creator, owner, and platform admin", () => {
  assert.equal(canDeleteWorker({
    actorUserId: "user-member",
    actorRole: "member",
    createdByUserId: "user-member",
    isPlatformAdmin: false,
  }), true)

  assert.equal(canDeleteWorker({
    actorUserId: "user-owner",
    actorRole: "owner",
    createdByUserId: "someone-else",
    isPlatformAdmin: false,
  }), true)

  assert.equal(canDeleteWorker({
    actorUserId: "user-admin",
    actorRole: null,
    createdByUserId: "someone-else",
    isPlatformAdmin: true,
  }), true)

  assert.equal(canDeleteWorker({
    actorUserId: "user-member",
    actorRole: "member",
    createdByUserId: "someone-else",
    isPlatformAdmin: false,
  }), false)
})

test("canRevealWorkerHostToken follows privileged access rules", () => {
  assert.equal(canRevealWorkerHostToken({
    actorUserId: "user-member",
    actorRole: "member",
    createdByUserId: "user-member",
    isPlatformAdmin: false,
  }), true)

  assert.equal(canRevealWorkerHostToken({
    actorUserId: "user-owner",
    actorRole: "owner",
    createdByUserId: "someone-else",
    isPlatformAdmin: false,
  }), true)

  assert.equal(canRevealWorkerHostToken({
    actorUserId: "user-admin",
    actorRole: null,
    createdByUserId: "someone-else",
    isPlatformAdmin: true,
  }), true)

  assert.equal(canRevealWorkerHostToken({
    actorUserId: "user-member",
    actorRole: "member",
    createdByUserId: "someone-else",
    isPlatformAdmin: false,
  }), false)
})

test("wouldLeaveOrganizationWithoutOwner protects the final owner", () => {
  assert.equal(wouldLeaveOrganizationWithoutOwner({
    ownerCount: 1,
    targetRole: "owner",
    nextRole: null,
  }), true)

  assert.equal(wouldLeaveOrganizationWithoutOwner({
    ownerCount: 1,
    targetRole: "owner",
    nextRole: "member",
  }), true)

  assert.equal(wouldLeaveOrganizationWithoutOwner({
    ownerCount: 2,
    targetRole: "owner",
    nextRole: "member",
  }), false)

  assert.equal(wouldLeaveOrganizationWithoutOwner({
    ownerCount: 1,
    targetRole: "member",
    nextRole: null,
  }), false)
})
