import assert from "node:assert/strict"
import test from "node:test"
import { completeSignupAfterUserCreate, decideSignupAccess } from "../src/auth/signup-gate.js"

test("enabled organization domain auto-activates when a seat is available", () => {
  assert.deepEqual(
    decideSignupAccess({
      matchingDomain: { organizationId: "org_1", selfSignupEnabled: true },
      activeSeats: 3,
      seatLimit: 10,
      hasValidInvite: false,
    }),
    { ok: true, mode: "domain", organizationId: "org_1" },
  )
})

test("enabled organization domain blocks when seat limit is reached", () => {
  assert.deepEqual(
    decideSignupAccess({
      matchingDomain: { organizationId: "org_1", selfSignupEnabled: true },
      activeSeats: 10,
      seatLimit: 10,
      hasValidInvite: false,
    }),
    { ok: false, error: "seat_limit_reached" },
  )
})

test("missing enabled domain requires invite", () => {
  assert.deepEqual(
    decideSignupAccess({
      matchingDomain: null,
      activeSeats: 0,
      seatLimit: null,
      hasValidInvite: false,
    }),
    { ok: false, error: "domain_not_allowed" },
  )
})

test("post-create domain signup activates membership and skips default org fallback", async () => {
  const activated: unknown[] = []
  const result = await completeSignupAfterUserCreate({
    user: { id: "user_1", email: "user@neatech.cz" },
    inviteToken: null,
    createMembershipId: () => "membership_1",
    resolveEnabledOrganizationDomainForEmail: async () => ({
      id: "domain_1",
      orgId: "org_1",
      domain: "neatech.cz",
      enabled: true,
      selfSignupEnabled: true,
      organization: { id: "org_1", seatLimit: 10 },
    }),
    createOrActivateOrganizationMembership: async (input) => {
      activated.push(input)
      return {
        id: input.membershipId,
        orgId: input.orgId,
        userId: input.userId,
        role: input.role,
        status: "active",
        createdAt: new Date("2026-06-06T08:00:00.000Z"),
      }
    },
    acceptOrganizationInvite: async () => {
      throw new Error("invite should not be accepted for domain signup")
    },
  })

  assert.deepEqual(result, { activatedOrganizationMembership: true })
  assert.deepEqual(activated, [{
    membershipId: "membership_1",
    orgId: "org_1",
    userId: "user_1",
    role: "member",
  }])
})
