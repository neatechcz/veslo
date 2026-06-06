import assert from "node:assert/strict"
import test from "node:test"
import {
  canActivateSeat,
  normalizeEmailDomain,
  normalizeInviteEmail,
} from "../src/org-admin/policy.js"

test("normalizes email domains for organization domain matching", () => {
  assert.equal(normalizeEmailDomain(" User@Neatech.CZ "), "neatech.cz")
  assert.equal(normalizeEmailDomain("invalid"), null)
})

test("normalizes invite emails", () => {
  assert.equal(normalizeInviteEmail(" User@Neatech.CZ "), "user@neatech.cz")
  assert.equal(normalizeInviteEmail("invalid"), null)
})

test("seat activation requires available capacity when a limit exists", () => {
  assert.equal(canActivateSeat({ activeSeats: 9, seatLimit: 10 }), true)
  assert.equal(canActivateSeat({ activeSeats: 10, seatLimit: 10 }), false)
  assert.equal(canActivateSeat({ activeSeats: 999, seatLimit: null }), true)
})
