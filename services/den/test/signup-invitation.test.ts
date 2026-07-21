import assert from "node:assert/strict"
import test from "node:test"

import { buildOrganizationInvitationUrl } from "../src/auth/signup-invitation.js"

test("organization invitation URL keeps the canonical inviteToken in the app-root fragment", () => {
  const url = new URL(buildOrganizationInvitationUrl(
    "https://app.staging.veslo.work/settings?preserve=no#fragment",
    "raw token+/with?reserved&characters=1",
  ))

  assert.equal(url.origin, "https://app.staging.veslo.work")
  assert.equal(url.pathname, "/")
  assert.equal(url.search, "")
  assert.equal(url.searchParams.get("inviteToken"), null)

  const fragment = new URLSearchParams(url.hash.slice(1))
  assert.deepEqual([...fragment.keys()], ["inviteToken"])
  assert.equal(fragment.get("inviteToken"), "raw token+/with?reserved&characters=1")
  assert.equal(fragment.get("invitationToken"), null)
  assert.equal(fragment.get("token"), null)
  assert.equal(url.hash, "#inviteToken=raw+token%2B%2Fwith%3Freserved%26characters%3D1")
})

test("organization invitation URL rejects an empty token", () => {
  assert.throws(
    () => buildOrganizationInvitationUrl("https://app.veslo.work", "   "),
    /invitation token/i,
  )
})
