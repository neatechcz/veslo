import assert from "node:assert/strict"
import test from "node:test"

import { buildOrganizationInvitationUrl } from "../src/auth/signup-invitation.js"

test("organization invitation URL uses the public app root and canonical inviteToken parameter", () => {
  const url = new URL(buildOrganizationInvitationUrl(
    "https://app.staging.veslo.work/settings?preserve=no#fragment",
    "raw token+/with?reserved&characters=1",
  ))

  assert.equal(url.origin, "https://app.staging.veslo.work")
  assert.equal(url.pathname, "/")
  assert.equal(url.hash, "")
  assert.deepEqual([...url.searchParams.keys()], ["inviteToken"])
  assert.equal(url.searchParams.get("inviteToken"), "raw token+/with?reserved&characters=1")
  assert.equal(url.searchParams.get("invitationToken"), null)
  assert.equal(url.searchParams.get("token"), null)
})

test("organization invitation URL rejects an empty token", () => {
  assert.throws(
    () => buildOrganizationInvitationUrl("https://app.veslo.work", "   "),
    /invitation token/i,
  )
})
