import assert from "node:assert/strict"
import test from "node:test"

import { rotateOrganizationInviteToken } from "../src/org-admin/invite-token-rotation.js"
import { hashOrganizationInviteToken } from "../src/org-admin/invite-token.js"

test("concurrent invite resends commit, audit, email, and return only one fresh token", async () => {
  const originalTokenHash = hashOrganizationInviteToken("original-token")
  let storedTokenHash = originalTokenHash
  let tokenSequence = 0
  const audits: string[] = []
  const emails: string[] = []
  const returnedTokens: string[] = []

  const rotate = () => rotateOrganizationInviteToken({
    expectedTokenHash: originalTokenHash,
    createInviteToken: () => `fresh-token-${++tokenSequence}`,
    compareAndSwap: async ({ expectedTokenHash, nextTokenHash }) => {
      await Promise.resolve()
      if (storedTokenHash !== expectedTokenHash) {
        return false
      }
      storedTokenHash = nextTokenHash
      return true
    },
    onCommitted: async ({ inviteToken }) => {
      audits.push(inviteToken)
      emails.push(inviteToken)
      returnedTokens.push(inviteToken)
      return { inviteToken }
    },
  })

  const results = await Promise.all([rotate(), rotate()])
  const winners = results.filter((result) => result.ok)
  const losers = results.filter((result) => !result.ok)

  assert.equal(winners.length, 1)
  assert.equal(losers.length, 1)
  assert.equal(audits.length, 1)
  assert.deepEqual(emails, audits)
  assert.deepEqual(returnedTokens, audits)
  assert.equal(storedTokenHash, hashOrganizationInviteToken(audits[0]!))
  assert.equal(JSON.stringify({ storedTokenHash }).includes(audits[0]!), false)
})
